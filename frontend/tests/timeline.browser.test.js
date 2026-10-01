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
    assert.equal(await page.locator('#task-edit-save').textContent(), 'Save');
    assert.equal(await page.locator('#task-edit-save-subtask').isVisible(), false);
    await page.locator('#task-edit-cancel').click();
    await page.locator('.timeline-title').first().dispatchEvent('click');
    await page.locator('#graph-add-task').click();
    assert.equal(await page.locator('#task-edit-save').textContent(), 'Create');
    assert.equal(await page.locator('#task-edit-save-subtask').textContent(), 'Create as subtask of Kickoff sprint');
    await page.locator('#task-edit-title-input').fill('New child');
    await page.locator('#task-edit-save-subtask').click();
    const withChild = await page.locator('#task-editor').inputValue();
    assert.match(withChild, /\n    % New child\n/);
    await page.locator('#undo-button').click();
    assert.equal(await page.locator('#task-editor').inputValue(), sourceAfter);
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
    const workloadPanel = page.locator('.timeline-workload');
    assert.ok((await workloadPanel.boundingBox()).height <= 30);
    assert.equal(await workloadPanel.locator('.timeline-workload-name').first().isVisible(), false);
    const compactBars = await workloadPanel.locator('.timeline-workload-box').evaluateAll(bars => bars.map(bar => {
      const rect = bar.getBoundingClientRect(); return { x: rect.x, width: rect.width, height: rect.height };
    }));
    assert.ok(compactBars.every(bar => Math.abs(bar.height - compactBars[0].height) < 1));
    const compactRows = await workloadPanel.locator('.timeline-workload-person').evaluateAll(rows => rows.map(row => row.getBoundingClientRect().y));
    assert.ok(compactRows[1] > compactRows[0]);
    await workloadPanel.hover();
    await page.waitForFunction(() => document.querySelector('.timeline-workload').getBoundingClientRect().height > 50);
    assert.equal(await workloadPanel.locator('.timeline-workload-name').first().isVisible(), true);
    const expandedBars = await workloadPanel.locator('.timeline-workload-box').evaluateAll(bars => bars.map(bar => {
      const rect = bar.getBoundingClientRect(); return { x: rect.x, width: rect.width };
    }));
    assert.deepEqual(expandedBars, compactBars.map(({ x, width }) => ({ x, width })));
    await page.mouse.move(5, 5);
    await page.waitForFunction(() => document.querySelector('.timeline-workload').getBoundingClientRect().height <= 30);
    await workloadPanel.locator('.timeline-workload-name').first().waitFor({ state: 'hidden' });
    assert.equal(await workloadPanel.locator('.timeline-workload-name').first().isVisible(), false);
    const luisLegend = page.locator('#person-list .pill').filter({ hasText: 'Luis Ortega' });
    await luisLegend.click();
    const selectedWorkload = workloadPanel.locator('[data-person="@luis"]');
    assert.equal(await selectedWorkload.locator('.timeline-workload-name').isVisible(), true);
    assert.equal(await selectedWorkload.evaluate(el => getComputedStyle(el).height), '28px');
    assert.equal(await workloadPanel.locator('[data-person="@maya"] .timeline-workload-name').isVisible(), false);
    await luisLegend.click();
    await selectedWorkload.locator('.timeline-workload-name').waitFor({ state: 'hidden' });
    const mayaLegend = page.locator('#person-list .pill').filter({ hasText: 'Maya Rivera' });
    await mayaLegend.click();
    const workloadOrder = await workloadPanel.locator('.timeline-workload-person').evaluateAll(rows => rows.map(row => ({ person: row.dataset.person, top: parseFloat(row.style.getPropertyValue('--compact-person-top')) })));
    assert.equal(workloadOrder[0].person, '@maya');
    assert.equal(workloadOrder[0].top, 0);
    assert.equal(workloadOrder[1].top, 28);
    await mayaLegend.click();
    // Tag background can be set and cleared in the shared tag dialog.
    const tagEditorToken = page.locator('#code-editor .cm-tag-token').filter({ hasText: 'backend' }).first();
    await timelineTask.locator('.timeline-title').dblclick();
    await page.locator('#task-edit-code-editor .cm-tag-token').filter({ hasText: 'backend' }).first().dblclick();
    await page.locator('#slug-rename-background-picker').fill('#fff0ed');
    await page.locator('#slug-rename-save').click();
    assert.match(await page.locator('#task-editor').inputValue(), /background: fff0ed/);
    assert.equal(await page.locator('.task-preview-card').evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(255, 240, 237)');
    await page.locator('#task-edit-save').click();
    const savedTaskWithBackground = await page.locator('#task-editor').inputValue();
    assert.match(savedTaskWithBackground.split('% Kickoff sprint')[0], /background: fff0ed/);
    assert.equal(savedTaskWithBackground.match(/% Kickoff sprint/g).length, 1);
    assert.match(savedTaskWithBackground, /    % Collect requirements/);
    assert.equal(await timelineTask.locator('.timeline-bar').evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(255, 240, 237)');
    assert.equal(await timelineTask.locator('.timeline-title').evaluate(e => getComputedStyle(e).color), 'rgb(0, 0, 0)');
    assert.equal(await kickoff.evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(255, 240, 237)');
    await timelineTask.locator('.timeline-title').dblclick();
    assert.equal(await page.locator('.task-preview-card').evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(255, 240, 237)');
    await page.locator('#task-edit-cancel').click();
    await page.locator('.graph-view-switch [data-view="graph"]').click();
    const graphTask = page.locator('.task-node').filter({ hasText: 'Kickoff sprint' }).first();
    assert.equal(await graphTask.evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(255, 240, 237)');
    const inheritedTask = page.locator('.task-node').filter({ has: page.locator('h4', { hasText: 'Collect requirements' }) }).first();
    assert.match(await inheritedTask.evaluate(e => getComputedStyle(e).backgroundColor), /0\.8\)/);
    await page.locator('.graph-view-switch [data-view="timeline"]').click();
    await tagEditorToken.dblclick();
    assert.equal(await page.locator('#slug-rename-background-picker').inputValue(), '#fff0ed');
    await page.locator('#slug-rename-background-clear').click();
    await page.locator('#slug-rename-save').click();
    assert.equal(await timelineTask.locator('.timeline-bar').evaluate(e => e.style.backgroundColor), '');
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
    // Dividers retain the pointer across timeline/editor surfaces and stop on release.
    const divider = page.locator('#divider');
    const dividerStart = await divider.boundingBox();
    await page.mouse.move(dividerStart.x + dividerStart.width / 2, dividerStart.y + 100);
    await page.mouse.down();
    await page.mouse.move(dividerStart.x + 170, dividerStart.y + 220);
    assert.ok(Math.abs((await divider.boundingBox()).x - (dividerStart.x + 170)) < 15);
    await page.mouse.move(dividerStart.x - 90, dividerStart.y + 140);
    assert.ok(Math.abs((await divider.boundingBox()).x - (dividerStart.x - 90)) < 15);
    await page.mouse.up();
    const dividerReleased = (await divider.boundingBox()).x;
    await page.mouse.move(dividerStart.x + 50, dividerStart.y + 200);
    assert.equal((await divider.boundingBox()).x, dividerReleased);
    const kanbanDivider = page.locator('#kanban-divider');
    const kanbanStart = await kanbanDivider.boundingBox();
    await page.mouse.move(kanbanStart.x + 40, kanbanStart.y + kanbanStart.height / 2);
    await page.mouse.down();
    await page.mouse.move(kanbanStart.x + 250, kanbanStart.y - 80);
    assert.ok(Math.abs((await kanbanDivider.boundingBox()).y - (kanbanStart.y - 80)) < 15);
    await page.mouse.move(kanbanStart.x + 120, kanbanStart.y + 40);
    assert.ok(Math.abs((await kanbanDivider.boundingBox()).y - (kanbanStart.y + 40)) < 15);
    await page.mouse.up();
    const kanbanReleased = (await kanbanDivider.boundingBox()).y;
    await page.mouse.move(kanbanStart.x + 200, kanbanStart.y - 100);
    assert.equal((await kanbanDivider.boundingBox()).y, kanbanReleased);

    // Exercise the real controller with deterministic dates and observable edit callbacks.
    await page.goto(base + '/scripts/timeline.js');
    await page.setContent('<link rel="stylesheet" href="/styles/styles.css"><div id="task-trash" style="display:block;opacity:1;pointer-events:auto;position:absolute;left:20px;top:10px;width:100px;height:35px">Trash</div><div id="fixture" class="timeline-host" style="position:absolute;left:20px;right:20px;top:60px;height:650px"></div>');
    await page.evaluate(async () => {
      const { createTimeline } = await import('/scripts/timeline.js');
      const dates = await import('/scripts/taskDates.js');
      const { parseTasks } = await import('/scripts/task.js');
      const today = dates.todayDay();
      let source = `% Parent\n${dates.formatDay(today - 5)}-${dates.formatDay(today + 5)}\n#tag @person !todo\n    % Child\n    details @person\n        % Grandchild\n        -${dates.formatDay(today + 8)}\n% Other\n${dates.formatDay(today)}\n% Invalid\n31.2.2026\n% Undated\nnotes`;
      let editable = true;
      const state = { tasks: parseTasks(source).tasks, selectedTaskId: null, tagMeta: new Map([['#tag', { background: '#ff0000' }]]) };
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
        focus: name => controller.focusOnTask(parseTasks(source).allTasks.find(task => task.name === name)),
      });
      controller.setActive(true);
    });
    const labels = page.locator('.timeline-title');
    assert.deepEqual(await labels.allTextContents(), ['Parent', 'Grandchild', 'Other']);
    assert.deepEqual(await page.locator('.timeline-parent-name').allTextContents(), ['Child']);
    const parentHeading = await page.locator('.timeline-parent-name').boundingBox();
    const descendantBar = await page.locator('.timeline-row').nth(1).locator('.timeline-bar').boundingBox();
    assert.ok(parentHeading.y + parentHeading.height <= descendantBar.y);
    const parentLabel = await page.locator('.timeline-parent-label').boundingBox();
    assert.ok(Math.abs(parentLabel.x - descendantBar.x) < 1);
    const parentTrack = await page.locator('.timeline-parent-name').evaluate(el => el.parentElement.getBoundingClientRect().width);
    assert.ok(Math.abs(parentHeading.width - parentTrack) < 1);
    assert.match(await page.locator('.timeline-parent-name').evaluate(el => getComputedStyle(el).backgroundColor), /0\.8\)/);
    // Parent headings stay below the ruler until their children's band leaves view.
    await page.evaluate(() => {
      document.querySelector('.timeline-rows').style.paddingBottom = '650px';
      const heading = document.querySelector('.timeline-parent-name');
      const view = document.querySelector('.timeline-viewport');
      view.scrollTop = heading.getBoundingClientRect().top - view.getBoundingClientRect().top - 72 + 20;
    });
    const pinnedHeading = await page.locator('.timeline-parent-name').boundingBox();
    const pinnedRuler = await page.locator('.timeline-ruler').boundingBox();
    assert.ok(Math.abs(pinnedHeading.y - pinnedRuler.y - pinnedRuler.height) < 1);
    await page.evaluate(() => {
      const view = document.querySelector('.timeline-viewport');
      const row = document.querySelector('.timeline-parent-name').closest('.timeline-parent-group');
      view.scrollTop += row.getBoundingClientRect().bottom - view.getBoundingClientRect().top - 72 + 1;
    });
    const departedHeading = await page.locator('.timeline-parent-name').boundingBox();
    assert.ok(departedHeading.y + departedHeading.height <= pinnedRuler.y + pinnedRuler.height);
    await page.evaluate(() => {
      document.querySelector('.timeline-rows').style.paddingBottom = '';
      document.querySelector('.timeline-viewport').scrollTop = 0;
    });
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
    assert.equal(await page.locator('.timeline-parent-name').count(), 0);
    const scheduled = await page.evaluate(() => window.fixture.source());
    assert.match(scheduled, /% Child\n    \d+\.\d+\.\d{4}\n    details/);
    assert.equal(await page.evaluate(() => window.fixture.commits), 1);
    // Daily workload follows the shared scale and includes open-ended assignments.
    const personRow = page.locator('.timeline-workload-person[data-person="@person"]');
    assert.equal(await personRow.count(), 1);
    await page.locator('.timeline-workload').hover();
    await page.waitForFunction(() => Array.from(document.querySelectorAll('.timeline-workload-box')).every(bar => Math.abs(parseFloat(getComputedStyle(bar).height) - parseFloat(bar.style.getPropertyValue('--expanded-height'))) < .1));
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
    await page.locator('.timeline-workload').hover(); await page.mouse.wheel(0, -150);
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
    // Resizing at an edge keeps the view fixed until release, then reveals the bar.
    await page.evaluate(() => window.fixture.focus('Parent'));
    await page.waitForTimeout(250);
    const resizeBar = page.locator('.timeline-bar').filter({ has: page.locator('.timeline-title', { hasText: /^Parent$/ }) });
    const resizeHandle = await resizeBar.locator('.timeline-handle.end').boundingBox();
    const resizeView = await page.locator('.timeline-viewport').boundingBox();
    const viewPosition = () => page.evaluate(() => ({
      today: document.querySelector('.timeline-today-line').getBoundingClientRect().x,
      scroll: document.querySelector('.timeline-viewport').scrollTop,
    }));
    const beforeResize = await viewPosition();
    await page.mouse.move(resizeHandle.x + 3, resizeHandle.y + 20);
    await page.mouse.down();
    await page.mouse.move(resizeView.x + resizeView.width - 2, resizeHandle.y + 20);
    await page.waitForTimeout(150);
    assert.deepEqual(await viewPosition(), beforeResize);
    await page.mouse.up();
    await page.waitForFunction(() => {
      const bar = Array.from(document.querySelectorAll('.timeline-bar')).find(el => el.querySelector('.timeline-title').textContent === 'Parent').getBoundingClientRect();
      const view = document.querySelector('.timeline-viewport').getBoundingClientRect();
      return Math.abs(bar.left + bar.width / 2 - view.left - view.width / 2) < 2;
    });
    await page.waitForTimeout(250);
    assert.notDeepEqual(await viewPosition(), beforeResize);
    await page.evaluate(() => window.fixture.readonly());
    const readOnlySource = await page.evaluate(() => window.fixture.source());
    bar = await childBar.boundingBox();
    await drag({ x: bar.x + 30, y: bar.y + 20 }, { x: bar.x + 90, y: bar.y + 20 });
    assert.equal(await page.evaluate(() => window.fixture.source()), readOnlySource);
    assert.equal(await page.locator('.timeline-handle').count(), 0);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: '/tmp/timeline-browser.png' });
    // Isolate this layout fixture from the previous controller's resize callbacks.
    await page.goto(base + '/scripts/timeline.js');
    await page.setContent('<link rel="stylesheet" href="/styles/styles.css"><div id="fixture" class="timeline-host" style="position:absolute;left:20px;right:20px;top:60px;height:650px"></div>');
    await page.evaluate(async () => {
      const { createTimeline } = await import('/scripts/timeline.js');
      const { parseTasks } = await import('/scripts/task.js');
      const { todayDay, formatDay } = await import('/scripts/taskDates.js');
      const day = todayDay();
      const range = (a, b) => `${formatDay(day + a)}-${formatDay(day + b)}`;
      const source = `% Parent\n${range(0, 12)}\n    % Later\n    ${range(2, 6)}\n    % Early\n    ${range(0, 4)}\n    % After\n    ${range(7, 9)}\n    % Branch\n    ${range(0, 12)}\n        % Nested\n        ${range(0, 4)}`;
      const host = document.getElementById('fixture'); host.replaceChildren();
      const state = parseTasks(source);
      const controller = createTimeline({ host, state, getSource: () => source, canEdit: () => true,
        onDates: () => {}, onSelect: task => { state.selectedTaskId = task.id; controller.render(); controller.focusOnTask(task, true); }, onEdit: () => {}, matchesFilters: () => true, matchesSearch: () => false });
      window.focusTimelineTask = (name, onlyIfClipped = false) => controller.focusOnTask(state.allTasks.find(task => task.name === name), onlyIfClipped);
      controller.setActive(true);
    });
    const positions = await page.locator('.timeline-bar').evaluateAll(bars => Object.fromEntries(bars.map(bar => [bar.querySelector('.timeline-title').textContent, { y: bar.getBoundingClientRect().y }])));
    const { Early: early, Later: later, After: after, Branch: branch, Nested: nested } = positions;
    assert.equal(after.y, early.y);
    assert.equal(later.y, early.y + 72);
    assert.ok(branch.y > later.y);
    assert.ok(nested.y > branch.y);
    assert.equal(await page.locator('.timeline-row').count(), 4);
    const firstBar = page.locator('.timeline-bar').first();
    const initialBar = await firstBar.boundingBox();
    await page.locator('.timeline-ticks').dispatchEvent('wheel', { deltaY: -100, clientX: 600, clientY: 90 });
    assert.ok((await firstBar.boundingBox()).width > initialBar.width);
    const zoomed = await firstBar.boundingBox();
    await page.locator('.timeline-rows').dispatchEvent('wheel', { deltaY: 60, shiftKey: true, clientX: 600, clientY: 200 });
    assert.ok((await firstBar.boundingBox()).x < zoomed.x);
    assert.equal((await firstBar.boundingBox()).width, zoomed.width);
    await page.locator('.timeline-rows').dispatchEvent('wheel', { deltaY: -300, ctrlKey: true, clientX: 600, clientY: 160 });
    assert.ok((await firstBar.boundingBox()).height > initialBar.height);
    await page.locator('.timeline-viewport').evaluate(el => { el.scrollTop = 0; });
    await page.locator('.timeline-rows').dispatchEvent('wheel', { deltaY: 100, clientX: 600, clientY: 200 });
    assert.ok(await page.locator('.timeline-viewport').evaluate(el => el.scrollTop > 0));
    const scrollBeforeSelection = await page.locator('.timeline-viewport').evaluate(el => el.scrollTop);
    await page.locator('.timeline-title').filter({ hasText: /^Early$/ }).click();
    assert.equal(await page.locator('.timeline-viewport').evaluate(el => el.scrollTop), scrollBeforeSelection);
    assert.equal(await page.locator('.timeline-bar.selected .timeline-title').textContent(), 'Early');
    const tallHeight = await firstBar.evaluate(el => el.getBoundingClientRect().height);
    await page.locator('.timeline-rows').dispatchEvent('wheel', { deltaY: 100, ctrlKey: true, clientX: 600, clientY: 160 });
    assert.ok(await firstBar.evaluate((el, height) => el.getBoundingClientRect().height < height, tallHeight));
    for (const name of ['Parent', 'Nested']) {
      await page.evaluate(name => window.focusTimelineTask(name), name);
      await page.waitForFunction(name => {
        const bar = Array.from(document.querySelectorAll('.timeline-bar')).find(el => el.querySelector('.timeline-title').textContent === name);
        const viewport = document.querySelector('.timeline-viewport').getBoundingClientRect();
        const rect = bar.getBoundingClientRect();
        const verticalAligned = name === 'Parent'
          ? document.querySelector('.timeline-viewport').scrollTop === 0 && Math.abs(rect.y - (viewport.y + 72 + 7)) < 2
          : Math.abs(rect.y + rect.height / 2 - (viewport.y + 72 + (viewport.height - 72) / 2)) < 2;
        return Math.abs(rect.x + rect.width / 2 - (viewport.x + viewport.width / 2)) < 2 && verticalAligned;
      }, name);
    }
    const centeredScroll = await page.locator('.timeline-viewport').evaluate(el => el.scrollTop);
    await page.evaluate(() => window.focusTimelineTask('Nested', true));
    assert.equal(await page.locator('.timeline-viewport').evaluate(el => el.scrollTop), centeredScroll);
    const nestedBar = page.locator('.timeline-bar').filter({ has: page.locator('.timeline-title', { hasText: /^Nested$/ }) });
    const { viewBounds, clippedNested } = await page.evaluate(() => {
      const findNested = () => Array.from(document.querySelectorAll('.timeline-bar')).find(el => el.querySelector('.timeline-title').textContent === 'Nested');
      const before = findNested().getBoundingClientRect();
      const viewBounds = document.querySelector('.timeline-viewport').getBoundingClientRect().toJSON();
      document.querySelector('.timeline-rows').dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: before.x - viewBounds.x + before.width / 2, shiftKey: true }));
      return { viewBounds, clippedNested: findNested().getBoundingClientRect().toJSON() };
    });
    assert.ok(clippedNested.x < viewBounds.x);
    await page.mouse.click(viewBounds.x + 15, clippedNested.y + clippedNested.height / 2);
    await page.waitForFunction(() => {
      const bar = Array.from(document.querySelectorAll('.timeline-bar')).find(el => el.querySelector('.timeline-title').textContent === 'Nested');
      const rect = bar.getBoundingClientRect(), viewport = document.querySelector('.timeline-viewport').getBoundingClientRect();
      return Math.abs(rect.x + rect.width / 2 - (viewport.x + viewport.width / 2)) < 2;
    });
    const contrastResults = await page.evaluate(async () => {
      const { applyTaskBackground } = await import('/scripts/taskDescription.js');
      const element = document.createElement('div'); element.className = 'task-node';
      element.style.transition = 'none';
      element.innerHTML = '<h4>Title</h4><div class="description"><p>Body</p></div>';
      document.body.append(element);
      const results = [];
      for (const background of ['#000000', '#ffffff', 'rgba(0, 0, 0, .2)']) {
        applyTaskBackground(element, { tags: ['#test'] }, new Map([['#test', { background }]]));
        for (const theme of ['light', 'dark']) {
          document.documentElement.dataset.theme = theme;
          for (const viewClass of ['task-node', 'kanban-card', 'timeline-bar']) {
            element.className = `${viewClass} has-task-background selected`;
            element.style.borderColor = '#ff0000';
            results.push({ background, theme, title: getComputedStyle(element.querySelector('h4')).color, body: getComputedStyle(element.querySelector('p')).color,
              selection: getComputedStyle(element).boxShadow, stateBorder: getComputedStyle(element).borderTopColor });
          }
        }
      }
      applyTaskBackground(element, { tags: [] });
      const cleared = !element.classList.contains('has-task-background');
      element.remove();
      return { results, cleared };
    });
    for (const result of contrastResults.results) {
      const expected = result.background === '#000000' || (result.background.startsWith('rgba') && result.theme === 'dark') ? 'rgb(255, 255, 255)' : 'rgb(0, 0, 0)';
      assert.equal(result.title, expected); assert.equal(result.body, expected);
      assert.ok(result.selection.includes(expected));
      assert.ok(result.selection.includes('inset'));
      assert.equal(result.stateBorder, 'rgb(255, 0, 0)');
    }
    assert.equal(contrastResults.cleared, true);
    // Ancestor headings span dated branches and stack above deeper descendants.
    await page.goto(base + '/scripts/timeline.js');
    await page.setContent('<link rel="stylesheet" href="/styles/styles.css"><div id="fixture" class="timeline-host" style="position:absolute;left:20px;right:20px;top:60px;height:400px"></div>');
    await page.evaluate(async () => {
      const { createTimeline } = await import('/scripts/timeline.js');
      const { parseTasks } = await import('/scripts/task.js');
      const { formatDay, todayDay } = await import('/scripts/taskDates.js');
      const date = formatDay(todayDay());
      const source = `% Parent\n    % Dated branch\n    ${date}\n        % Subparent\n${Array.from({ length: 8 }, (_, i) => `            % Grandchild ${i}\n            ${date}`).join('\n')}\n    % Sibling\n    ${date}\n% Next root\n${date}`;
      const state = parseTasks(source);
      const controller = createTimeline({ host: document.getElementById('fixture'), state, getSource: () => source, canEdit: () => true,
        onSelect: () => {}, onEdit: () => {}, onDates: () => {}, matchesFilters: () => true, matchesSearch: () => false });
      controller.setActive(true);
      document.querySelector('.timeline-rows').style.paddingBottom = '400px';
      const sub = Array.from(document.querySelectorAll('.timeline-parent-name')).find(el => el.textContent === 'Subparent');
      const view = document.querySelector('.timeline-viewport');
      view.scrollTop = sub.getBoundingClientRect().top - view.getBoundingClientRect().top + 80;
    });
    assert.deepEqual(await page.locator('.timeline-parent-name').allTextContents(), ['Parent', 'Subparent']);
    const stackedRuler = await page.locator('.timeline-ruler').boundingBox();
    const parentPinned = await page.locator('.timeline-parent-name').nth(0).boundingBox();
    const subPinned = await page.locator('.timeline-parent-name').nth(1).boundingBox();
    assert.ok(Math.abs(parentPinned.y - stackedRuler.y - stackedRuler.height) < 1);
    assert.ok(Math.abs(subPinned.y - parentPinned.y - 22) < 1);
    await page.evaluate(() => {
      const view = document.querySelector('.timeline-viewport');
      const subGroup = document.querySelectorAll('.timeline-parent-group')[1];
      view.scrollTop += subGroup.getBoundingClientRect().bottom - view.getBoundingClientRect().top - 72;
    });
    const parentRemaining = await page.locator('.timeline-parent-name').nth(0).boundingBox();
    const subDeparted = await page.locator('.timeline-parent-name').nth(1).boundingBox();
    assert.ok(Math.abs(parentRemaining.y - stackedRuler.y - stackedRuler.height) < 1);
    assert.ok(subDeparted.y + subDeparted.height <= stackedRuler.y + stackedRuler.height);
  } finally {
    await browser?.close(); await new Promise(resolve => server.close(resolve));
  }
});
