const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { chromium } = require('@playwright/test');

// Uses a disposable static server and browser profile; never touches real spaces or sessions.
test('timeline browser interactions and graph-panel integration', { timeout: 60000 }, async () => {
  const root = path.resolve(__dirname, '..');
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{}'); return; }
      const relative = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = path.join(root, relative.startsWith('/node_modules/') ? relative : '/dist' + relative);
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/json';
      const body = await fs.readFile(file); res.writeHead(200, { 'content-type': type }); res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync) || chromium.executablePath(), headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(base);
    await page.waitForSelector('.graph-view-switch');
    await page.locator('.graph-view-switch [data-view="timeline"]').click();
    await page.waitForSelector('.timeline-empty');
    assert.equal(await page.locator('.timeline-task-label').count(), 0);
    assert.equal(await page.locator('.timeline-row').count(), 0);
    await page.locator('.graph-view-switch [data-view="graph"]').click();
    assert.equal(await page.locator('.timeline-host').isVisible(), false);
    await page.locator('.graph-view-switch [data-view="timeline"]').click();
    await page.reload();
    await page.waitForSelector('.timeline-empty');
    assert.equal(await page.locator('.graph-view-switch [data-view="timeline"]').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(errors, []);
    const sourceBefore = await page.locator('#task-editor').inputValue();
    const kickoff = page.locator('.kanban-card').filter({ has: page.locator('.kanban-card-title', { hasText: 'Kickoff sprint' }) }).first();
    await kickoff.dragTo(page.locator('.timeline-viewport'), { targetPosition: { x: 180, y: 100 } });
    await page.waitForSelector('.timeline-bar');
    assert.equal(await page.locator('.timeline-row').count(), 1);
    const sourceAfter = await page.locator('#task-editor').inputValue();
    assert.notEqual(sourceAfter, sourceBefore);
    assert.match(sourceAfter, /% Kickoff sprint\n\d+\.\d+\.\d{4}/);
    await page.locator('#undo-button').click();
    assert.equal(await page.locator('#task-editor').inputValue(), sourceBefore);
    await page.locator('#redo-button').click();
    assert.equal(await page.locator('#task-editor').inputValue(), sourceAfter);
    await page.locator('.timeline-title').first().dblclick();
    assert.equal(await page.locator('#task-edit-modal').isVisible(), true);
    await page.locator('#task-edit-cancel').click();
    const deleteLabel = await page.locator('.timeline-title').first().boundingBox();
    await page.mouse.move(deleteLabel.x + 15, deleteLabel.y + 7); await page.mouse.down();
    await page.mouse.move(deleteLabel.x + 55, deleteLabel.y + 7, { steps: 3 });
    const trash = await page.locator('#task-trash').boundingBox();
    await page.mouse.move(trash.x + trash.width / 2, trash.y + trash.height / 2, { steps: 8 }); await page.mouse.up();
    assert.equal(await page.locator('#task-delete-modal').isVisible(), true);
    await page.locator('#task-delete-confirm').hover();
    assert.equal(await page.locator('.timeline-bar.delete-preview').count(), 1);
    assert.equal(await page.locator('.timeline-bar.delete-preview').evaluate(e => getComputedStyle(e).borderTopColor), 'rgb(255, 77, 79)');
    await page.locator('#task-delete-cancel').hover();
    assert.equal(await page.locator('.timeline-bar.delete-preview').count(), 0);
    await page.locator('#task-delete-cancel').click();
    assert.equal(await page.locator('#task-editor').inputValue(), sourceAfter);
    // Persistence uses the application's normal offline-draft lifecycle.
    await page.evaluate(() => window.dispatchEvent(new Event('beforeunload')));
    await page.reload();
    await page.waitForSelector('.timeline-row');
    assert.equal(await page.locator('#task-editor').inputValue(), sourceAfter);
    // Legend pills assign the same tokens shown in graph/kanban, without losing dates.
    await page.locator('#tag-list .pill').filter({ hasText: '#backend' }).dragTo(page.locator('.timeline-title').first());
    await page.locator('#person-list .pill').filter({ hasText: 'Luis Ortega' }).dragTo(page.locator('.timeline-title').first());
    const assigned = await page.locator('#task-editor').inputValue();
    const parentBody = assigned.split('% Kickoff sprint')[1].split('    %')[0];
    assert.match(parentBody, /#backend/); assert.match(parentBody, /@luis/);
    const timelineTask = page.locator('.timeline-row').first();
    assert.equal(await timelineTask.locator('.pill[data-value="@luis"]').textContent(), '👤 Luis Ortega');
    assert.equal(await timelineTask.locator('.pill[data-value="#backend"]').textContent(), '#backend');
    assert.ok(await timelineTask.locator('.state-pill').count());
    const dateBeforeState = await timelineTask.locator('.timeline-dates').textContent();
    const done = page.locator('.kanban-column[data-state-tag="!done"]').first();
    await done.scrollIntoViewIfNeeded();
    const fromTimeline = await timelineTask.locator('.timeline-title').boundingBox();
    const doneRect = await done.boundingBox();
    await page.mouse.move(fromTimeline.x + 10, fromTimeline.y + 5); await page.mouse.down();
    await page.mouse.move(doneRect.x + 30, doneRect.y + 30, { steps: 12 }); await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('.timeline-row .state-pill')?.dataset.value === '!done');
    assert.equal(await timelineTask.locator('.timeline-dates').textContent(), dateBeforeState);
    const border = await timelineTask.locator('.timeline-bar').evaluate(e => e.style.borderColor);
    assert.equal(border, await timelineTask.locator('.state-pill').evaluate(e => e.style.borderColor));
    const movedCard = done.locator('.kanban-card').filter({ has: page.locator('.kanban-card-title', { hasText: 'Kickoff sprint' }) }).first();
    await movedCard.dragTo(timelineTask.locator('.timeline-track'), { targetPosition: { x: 60, y: 30 } });
    assert.notEqual(await timelineTask.locator('.timeline-dates').textContent(), dateBeforeState);
    assert.equal(await timelineTask.locator('.state-pill').getAttribute('data-value'), '!done');
    // Task pills dropped onto empty space are removed, including within the same row.
    const dateBeforeRemoval = await timelineTask.locator('.timeline-dates').textContent();
    const backendPill = timelineTask.locator('.pill[data-value="#backend"]');
    await backendPill.dragTo(timelineTask.locator('.timeline-track'), { targetPosition: { x: 5, y: 30 } });
    assert.equal(await timelineTask.locator('.pill[data-value="#backend"]').count(), 0);
    assert.equal(await timelineTask.locator('.timeline-dates').textContent(), dateBeforeRemoval);
    await page.locator('#undo-button').click();
    assert.equal(await timelineTask.locator('.pill[data-value="#backend"]').count(), 1);
    await backendPill.dragTo(timelineTask.locator('.timeline-title'));
    assert.equal(await timelineTask.locator('.pill[data-value="#backend"]').count(), 1);
    // Another dated task is a valid assignment target: keep the source token.
    const requirements = page.locator('.kanban-card').filter({ has: page.locator('.kanban-card-title', { hasText: 'Collect requirements' }) }).first();
    await requirements.dragTo(page.locator('.timeline-viewport'), { targetPosition: { x: 180, y: 100 } });
    const childTarget = page.locator('.timeline-row').nth(1).locator('.timeline-title');
    await backendPill.dragTo(childTarget);
    assert.equal(await page.locator('.timeline-row').nth(1).locator('.pill[data-value="#backend"]').count(), 1);
    assert.equal(await timelineTask.locator('.pill[data-value="#backend"]').count(), 1);
    // Person removals use the same path and preserve other assignees.
    await timelineTask.locator('.timeline-track').evaluate(element => {
      const dt = new DataTransfer();
      dt.setData('application/json', JSON.stringify({ type: 'person', value: '@luis', source: 'task', taskId: element.closest('[data-row-task-id]').dataset.rowTaskId }));
      const rect = element.getBoundingClientRect();
      element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: rect.x + 5, clientY: rect.y + 30 }));
    });
    assert.equal(await timelineTask.locator('.pill[data-value="@luis"]').count(), 0);
    assert.equal(await timelineTask.locator('.pill[data-value="@maya"]').count(), 1);
    await page.screenshot({ path: '/tmp/timeline-app.png' });

    // Exercise the real controller with deterministic dates and observable edit callbacks.
    await page.goto(base + '/scripts/timeline.js');
    await page.setContent('<link rel="stylesheet" href="/styles/styles.css"><div id="task-trash" style="display:block;opacity:1;pointer-events:auto;position:absolute;left:20px;top:10px;width:100px;height:35px">Trash</div><div id="fixture" style="position:absolute;left:20px;right:20px;top:60px;height:650px"></div>');
    await page.evaluate(async () => {
      const { createTimeline } = await import('/scripts/timeline.js');
      const dates = await import('/scripts/taskDates.js');
      const { parseTasks } = await import('/scripts/task.js');
      const today = dates.todayDay();
      let source = `% Parent\n${dates.formatDay(today - 5)}-${dates.formatDay(today + 5)}\n#tag @person !todo\n    % Child\n    details @person\n        % Grandchild\n        -${dates.formatDay(today + 8)}\n% Other\n${dates.formatDay(today)}\n% Invalid\n31.2.2026\n% Undated\nnotes`;
      let editable = true;
      const state = { tasks: parseTasks(source).tasks, selectedTaskId: null };
      const history = [], redo = [];
      const host = document.getElementById('fixture'); host.className = 'timeline-host';
      window.fixture = { source: () => source, edits: 0, selections: 0, trash: null, commits: 0 };
      const controller = createTimeline({ host, state, getSource: () => source, canEdit: () => editable,
        onSelect: task => { state.selectedTaskId = task.id; window.fixture.selections++; controller.render(); },
        onEdit: () => window.fixture.edits++, matchesFilters: () => true, matchesSearch: () => false,
        onDates: (task, value, expected) => {
          if (source !== expected) return;
          history.push(source); source = dates.updateTaskDates(source, task.lineIndex, value); window.fixture.commits++;
          state.tasks = parseTasks(source).tasks; controller.render();
        } });
      window.addEventListener('taskdroptrash', e => window.fixture.trash = e.detail.taskId);
      Object.assign(window.fixture, {
        undo: () => { redo.push(source); source = history.pop(); state.tasks = parseTasks(source).tasks; controller.render(); },
        redo: () => { history.push(source); source = redo.pop(); state.tasks = parseTasks(source).tasks; controller.render(); },
        remote: () => { source += '\nremote change'; state.tasks = parseTasks(source).tasks; controller.render(); },
        readonly: () => { editable = false; controller.render(); },
        getDates: index => dates.findTaskDates(source, index),
      });
      controller.setActive(true);
    });
    const labels = page.locator('.timeline-title');
    assert.deepEqual(await labels.allTextContents(), ['Parent', 'Grandchild', 'Other']);
    assert.equal(await page.locator('.timeline-task-label').count(), 0);
    const track = await page.locator('.timeline-track').nth(1).boundingBox();
    const drag = async (from, to) => { await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 8 }); await page.mouse.up(); };
    await page.locator('.timeline-viewport').evaluate(async (element, pos) => {
      const { parseTasks } = await import('/scripts/task.js');
      const child = parseTasks(window.fixture.source()).allTasks.find(task => task.name === 'Child');
      const dataTransfer = new DataTransfer();
      dataTransfer.setData('application/json', JSON.stringify({ type: 'task', taskId: child.id }));
      element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, clientX: pos.x + pos.width / 2, clientY: pos.y + 30 }));
    }, track);
    assert.deepEqual(await labels.allTextContents(), ['Parent', 'Child', 'Grandchild', 'Other']);
    const scheduled = await page.evaluate(() => window.fixture.source());
    assert.match(scheduled, /% Child\n    \d+\.\d+\.\d{4}\n    details/);
    assert.equal(await page.evaluate(() => window.fixture.commits), 1);
    // Daily workload follows the shared scale and includes open-ended assignments.
    const personRow = page.locator('.timeline-workload-person[data-person="@person"]');
    assert.equal(await personRow.count(), 1);
    const overlap = personRow.locator('.timeline-workload-box[data-count="2"]').first();
    assert.ok(await overlap.count());
    const single = personRow.locator('.timeline-workload-box[data-count="1"]').first();
    assert.ok((await overlap.boundingBox()).height > (await single.boundingBox()).height);
    assert.equal((await overlap.boundingBox()).width, (await single.boundingBox()).width);
    const workloadLine = await personRow.locator('.timeline-today-line').boundingBox();
    const taskLine = await page.locator('.timeline-row .timeline-today-line').first().boundingBox();
    assert.ok(Math.abs(workloadLine.x - taskLine.x) < 1);
    // A wheel over workload zooms both sections, without editing the source.
    const workloadBefore = await personRow.locator('.timeline-workload-box').count();
    await personRow.hover(); await page.mouse.wheel(0, -150);
    await page.waitForFunction(count => document.querySelectorAll('.timeline-workload-box').length !== count, workloadBefore);
    assert.equal(await page.evaluate(() => window.fixture.source()), scheduled);

    await page.evaluate(() => window.fixture.undo());
    assert.doesNotMatch(await page.evaluate(() => window.fixture.source()), /% Child\n    \d/);
    await page.evaluate(() => window.fixture.redo());
    assert.equal(await page.evaluate(() => window.fixture.source()), scheduled);
    // A genuine pointer double click still edits after selection rerenders the row.
    await labels.nth(1).dblclick();
    assert.equal(await page.evaluate(() => window.fixture.edits), 1);
    const childBar = page.locator('.timeline-row').nth(1).locator('.timeline-bar');
    const handle = await childBar.locator('.timeline-handle.end').boundingBox();
    await drag({ x: handle.x + 3, y: handle.y + 20 }, { x: handle.x + 60, y: handle.y + 20 });
    assert.match(await page.evaluate(() => window.fixture.source()), /% Child\n    \d+\.\d+\.\d{4}-\d+\.\d+\.\d{4}/);
    // Move parent independently; descendants stay unchanged.
    const beforeMove = await page.evaluate(() => window.fixture.source());
    const parent = await page.locator('.timeline-bar').first().boundingBox();
    await drag({ x: parent.x + 25, y: parent.y + 20 }, { x: parent.x + 85, y: parent.y + 20 });
    const afterMove = await page.evaluate(() => window.fixture.source());
    assert.notEqual(afterMove, beforeMove);
    assert.equal(afterMove.slice(afterMove.indexOf('    % Child')), beforeMove.slice(beforeMove.indexOf('    % Child')));
    // Leaving the original row restores the bar and never changes dates on another row.
    const rowBefore = await childBar.boundingBox();
    await page.mouse.move(rowBefore.x + 30, rowBefore.y + 15); await page.mouse.down();
    await page.mouse.move(rowBefore.x + 90, rowBefore.y + 15, { steps: 3 });
    await page.mouse.move(rowBefore.x + 140, rowBefore.y + 90, { steps: 3 });
    const rowDuring = await childBar.boundingBox();
    assert.ok(Math.abs(rowBefore.x - rowDuring.x) < 1);
    assert.equal(await page.locator('.timeline-drag-ghost').count(), 1);
    await page.mouse.up();
    assert.equal(await page.evaluate(() => window.fixture.source()), afterMove);
    assert.equal(await page.locator('.timeline-drag-ghost').count(), 0);
    // Escape and remote updates cancel without applying the preview.
    let bar = await childBar.boundingBox();
    await page.mouse.move(bar.x + 30, bar.y + 20); await page.mouse.down(); await page.mouse.move(bar.x + 80, bar.y + 20);
    await page.keyboard.press('Escape'); await page.mouse.up();
    assert.equal(await page.evaluate(() => window.fixture.source()), afterMove);
    bar = await childBar.boundingBox();
    await page.mouse.move(bar.x + 30, bar.y + 20); await page.mouse.down(); await page.mouse.move(bar.x + 80, bar.y + 20);
    await page.evaluate(() => window.fixture.remote()); await page.mouse.up();
    assert.equal(await page.evaluate(() => window.fixture.source()), afterMove + '\nremote change');
    // Pan and zoom leave source unchanged and keep the Today line aligned with the ruler.
    const todayBefore = await page.locator('.timeline-today-line').first().evaluate(e => e.getBoundingClientRect().x);
    await page.locator('.timeline-viewport').focus();
    await page.keyboard.press('+');
    const rulerX = await page.locator('.timeline-today-label').evaluate(e => e.getBoundingClientRect().x);
    const lineX = await page.locator('.timeline-today-line').first().evaluate(e => e.getBoundingClientRect().x);
    assert.ok(Math.abs(rulerX - lineX) < 1); assert.ok(Number.isFinite(todayBefore));
    const unchanged = await page.evaluate(() => window.fixture.source());
    const bg = await page.locator('.timeline-track').last().boundingBox();
    await drag({ x: bg.x + 60, y: bg.y + 68 }, { x: bg.x + 120, y: bg.y + 68 });
    assert.notEqual(await page.locator('.timeline-today-line').first().evaluate(e => e.getBoundingClientRect().x), lineX);
    assert.equal(await page.evaluate(() => window.fixture.source()), unchanged);
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('application/json', JSON.stringify({ type: 'task', taskId: document.querySelectorAll('.timeline-bar')[3].dataset.taskId }));
      window.externalTransfer = dt;
    });
    const externalTrack = await page.locator('.timeline-track').last().boundingBox();
    await page.locator('.timeline-viewport').evaluate((element, pos) => {
      element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.externalTransfer, clientX: pos.x + pos.width / 3, clientY: pos.y + 20 }));
    }, externalTrack);
    assert.notEqual(await page.evaluate(() => window.fixture.source()), unchanged);
    const beforeOutside = await page.evaluate(() => window.fixture.source());
    bar = await childBar.boundingBox();
    await drag({ x: bar.x + 30, y: bar.y + 20 }, { x: 1195, y: 770 });
    assert.equal(await page.evaluate(() => window.fixture.source()), beforeOutside);
    // Trash uses the shared event, while ordinary outside drops cancel.
    bar = await childBar.boundingBox();
    await drag({ x: bar.x + 30, y: bar.y + 20 }, { x: 70, y: 25 });
    assert.ok(await page.evaluate(() => window.fixture.trash));
    await page.evaluate(() => window.fixture.readonly());
    const readOnlySource = await page.evaluate(() => window.fixture.source());
    bar = await childBar.boundingBox();
    await drag({ x: bar.x + 30, y: bar.y + 20 }, { x: bar.x + 90, y: bar.y + 20 });
    assert.equal(await page.evaluate(() => window.fixture.source()), readOnlySource);
    assert.equal(await page.locator('.timeline-handle').count(), 0);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: '/tmp/timeline-browser.png' });
  } finally {
    await browser?.close(); await new Promise(resolve => server.close(resolve));
  }
});
