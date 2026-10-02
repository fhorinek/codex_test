const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require('@playwright/test');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('space Jira migration, configuration dialog, closed definitions and live link visibility', { timeout: 90000 }, async () => {
  const root = path.resolve(__dirname, '../..');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'jira-space-browser-'));
  await fs.writeFile(path.join(tmp, 'jira.json'), JSON.stringify({ base_url: 'https://jira.example.com', email: 'test@example.com', token: 'LEGACY' }));
  const sock = net.createServer(); await new Promise(resolve => sock.listen(0, '127.0.0.1', resolve)); const port = sock.address().port; await new Promise(resolve => sock.close(resolve));
  const server = spawn(path.join(root, 'backend/.venv/bin/python'), [path.join(root, 'backend/tests/tabs_fixture_server.py'), tmp, String(port)], { cwd: root });
  let log = ''; server.stdout.on('data', data => log += data); server.stderr.on('data', data => log += data);
  let browser;
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 80; i++) { try { if ((await fetch(base)).ok) break; } catch {} await delay(100); }
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    assert.equal((await context.request.post(base + '/api/login', { data: { username: 'admin', password: 'admin' } })).status(), 200);
    await context.route('**/api/jira-projects?**', route => route.fulfill({ json: { projects: [{ key: 'DEMO', name: 'Demo' }] } }));
    await context.route('**/api/jira-issue-hierarchy?**', route => route.fulfill({ json: { project: 'DEMO', chain: ['Task'], levels: [] } }));
    const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
    async function connect(target) {
      await target.goto(base);
      await target.getByRole('button', { name: 'Switch space' }).click();
      const row = target.locator('.space-item').filter({ has: target.locator('.space-label', { hasText: /^demo$/ }) });
      await row.getByRole('button', { name: 'Connect', exact: true }).click();
      await target.getByRole('tab', { name: 'main', exact: true }).waitFor();
    }
    await connect(page);
    await page.getByRole('tab', { name: 'main', exact: true }).click({ button: 'middle' });
    await page.getByRole('tab', { name: 'main', exact: true }).waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await page.getByRole('menuitem', { name: 'main', exact: true }).click();
    await page.getByRole('tab', { name: 'main', exact: true }).waitFor();
    await page.getByRole('tab', { name: 'defs', exact: true }).click({ button: 'middle' });
    await page.getByRole('tab', { name: 'defs', exact: true }).waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('tab', { name: 'main', exact: true }).getAttribute('aria-selected'), 'true');
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await page.getByRole('menuitem', { name: 'defs', exact: true }).click();
    await page.locator('html[data-tab-mode="defs"]').waitFor();
    assert.equal(await page.locator('#graph-add-task').isVisible(), false);
    await page.getByRole('tab', { name: 'main', exact: true }).click();

    const listing = await (await context.request.get(base + '/api/tab-spaces?ref=demo')).json();
    assert.equal((await (await context.request.get(base + `/api/jira-status?space=${listing.id}`)).json()).configured, false);
    assert.equal(await page.getByRole('button', { name: 'from JIRA', exact: true }).isVisible(), false);
    await page.locator('#graph-nodes .task-node').first().dblclick();
    assert.equal(await page.getByRole('button', { name: 'Link Jira', exact: true }).isVisible(), false);
    await page.locator('#task-edit-cancel').click();
    await page.getByRole('button', { name: 'Switch space' }).click();
    await page.getByRole('tab', { name: 'Jira', exact: true }).click();
    const migration = page.getByRole('dialog', { name: 'Migrate Jira configuration' });
    await migration.waitFor();
    assert.equal(await migration.getByRole('checkbox').evaluateAll(inputs => inputs.filter(input => input.checked).length), 0);
    assert.equal(await migration.getByRole('button', { name: 'Save selection' }).isEnabled(), false);
    await migration.getByRole('checkbox', { name: 'demo', exact: true }).check();
    await migration.getByRole('button', { name: 'Save selection' }).click();
    await migration.waitFor({ state: 'detached' });
    await page.locator('#jira-config-token').fill('CURRENT');
    await page.locator('#jira-config-save').click();
    await page.locator('#jira-config-modal').waitFor({ state: 'hidden' });
    await page.locator('#spaces-modal-close').click();
    // Virtual tools stay after the task tabs; visibility is shared in defs.txt.
    const commands = [];
    const tableHeaders = ['field', 'space', 'space ts', 'sync', 'jira', 'jira ts'];
    const tableRows = [['title', 'Our title', '-', '->', 'Jira title', '-']];
    const widths = tableHeaders.map((value, index) => Math.max(value.length, ...tableRows.map(row => row[index].length)));
    const border = '+' + widths.map(width => '-'.repeat(width + 2)).join('+') + '+';
    const tableRow = row => '| ' + row.map((value, index) => value.padEnd(widths[index])).join(' | ') + ' |';
    const logFixture = [
      'Daemon started.', 'Synchronization complete.',
      '2026-10-02 12:00:00,000 WARNING jira-worker: Retry scheduled',
      '2026-10-02 12:00:00,001 INFO jira-worker: Payload: {',
      '  "message": "hello",', '  "nested": {"count": 2}', '}',
      border, tableRow(tableHeaders), border, ...tableRows.map(tableRow), border,
    ];
    await context.route('**/api/jira-daemon**', route => {
      if (route.request().method() === 'POST') commands.push(new URL(route.request().url()).pathname.split('/').pop());
      return route.fulfill({ json: { running: commands.at(-1) !== 'stop', logs: commands.includes('clear-log') ? [] : logFixture } });
    });
    await context.route('**/api/jira-cache?**', route => route.fulfill({ json: commands.includes('clear-cache') ? {} : { 'jira-cache.json': { caches: { issue: 'DEMO-42' } } } }));
    await page.getByRole('tab', { name: 'JIRA Daemon', exact: true }).click();
    await page.locator('.jira-panel-output').filter({ hasText: 'Daemon started.' }).waitFor();
    assert.equal(await page.locator('.editor-panel').isVisible(), false);
    assert.equal(await page.locator('#board-title').textContent(), 'JIRA Daemon');
    assert.equal(await page.locator('#board-connection').textContent(), 'System tab');
    assert.equal(await page.title(), 'JIRA Daemon');
    for (const id of ['graph-add-task', 'jira-import-task', 'undo-button', 'redo-button', 'load-button', 'format-button', 'history-button']) {
      assert.equal(await page.locator('#' + id).isVisible(), false, id + ' must be hidden in Jira tabs');
    }
    await page.locator('.jira-log-warning').filter({ hasText: 'Retry scheduled' }).waitFor();
    const payload = page.locator('.jira-log-json');
    assert.equal(await payload.getByText('"hello"', { exact: true }).isVisible(), false);
    await payload.locator(':scope > summary').click();
    await payload.getByText('"hello"', { exact: true }).waitFor();
    const differences = page.getByRole('table', { name: 'Synchronization differences' });
    await differences.waitFor();
    assert.equal(await differences.getByRole('cell', { name: 'Our title', exact: true }).isVisible(), true);
    assert.equal(await differences.getByRole('cell', { name: 'Jira title', exact: true }).isVisible(), true);
    const autostart = page.getByRole('checkbox', { name: 'Autostart', exact: true });
    assert.equal(await autostart.isChecked(), false);
    await autostart.check();
    let definitionContents = await (await context.request.get(base + `/api/tab-spaces/${listing.id}/contents`)).json();
    for (let attempt = 0; attempt < 30 && !definitionContents.documents.find(doc => doc.kind === 'defs').text.includes('autostart: true'); attempt++) {
      await delay(100); definitionContents = await (await context.request.get(base + `/api/tab-spaces/${listing.id}/contents`)).json();
    }
    assert.ok(definitionContents.documents.find(doc => doc.kind === 'defs').text.includes('autostart: true'));
    await autostart.uncheck();
    for (const name of ['Start', 'Stop', 'Restart', 'Sync now']) {
      await Promise.all([page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes('/api/jira-daemon/')), page.locator('.jira-panel').getByRole('button', { name, exact: true }).click()]);
    }
    assert.deepEqual(commands, ['start', 'stop', 'restart', 'sync']);
    await page.locator('.jira-panel').getByRole('button', { name: 'Clear log', exact: true }).click();
    await page.locator('.jira-panel-output').filter({ hasText: 'No daemon activity yet.' }).waitFor();
    await page.locator('.jira-panel').getByRole('button', { name: 'Show cache', exact: true }).click();
    const cacheViewer = page.locator('.jira-json-viewer');
    await cacheViewer.filter({ hasText: 'jira-cache.json' }).waitFor();
    assert.equal(await page.locator('#board-title').textContent(), 'JIRA Cache');
    assert.equal(await page.locator('#board-connection').textContent(), 'System tab');
    assert.equal(await page.title(), 'JIRA Cache');
    const cachedIssue = cacheViewer.getByText('\"DEMO-42\"', { exact: true });
    assert.equal(await cachedIssue.isVisible(), false);
    await page.getByRole('button', { name: 'Expand all', exact: true }).click();
    await cachedIssue.waitFor();
    await page.getByRole('button', { name: 'Collapse all', exact: true }).click();
    assert.equal(await cachedIssue.isVisible(), false);
    await delay(2200);
    assert.equal(await cachedIssue.isVisible(), false);
    await cacheViewer.locator('summary').filter({ hasText: 'jira-cache.json' }).click();
    await cacheViewer.locator('summary').filter({ hasText: /^caches/ }).click();
    await cachedIssue.waitFor();
    assert.equal(await page.getByRole('button', { name: 'Clear log', exact: true }).isVisible(), false);
    await page.getByRole('button', { name: 'Clear cache', exact: true }).click();
    await cacheViewer.filter({ hasText: 'No cached data yet.' }).waitFor();
    await page.getByRole('tab', { name: 'JIRA Cache', exact: true }).click({ button: 'middle' });
    await page.getByRole('tab', { name: 'JIRA Cache', exact: true }).waitFor({ state: 'detached' });
    await page.getByRole('tab', { name: 'JIRA Daemon', exact: true }).click();
    await page.getByRole('tab', { name: 'JIRA Daemon', exact: true }).click({ button: 'middle' });
    await page.getByRole('tab', { name: 'JIRA Daemon', exact: true }).waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await page.getByRole('group', { name: 'Jira tools', exact: true }).waitFor();
    await page.getByRole('menuitem', { name: 'JIRA Daemon', exact: true }).click();
    await page.getByRole('tab', { name: 'JIRA Daemon', exact: true }).waitFor();
    await page.getByRole('tab', { name: 'main', exact: true }).click();
    await page.locator('#graph-nodes .task-node').first().waitFor();

    // Both regular space editors and managers must have no Jira tool tabs or Open entries.
    for (const role of ['user', 'manager']) {
      const username = 'jira_' + role;
      assert.equal((await context.request.post(base + '/api/users', { data: { username, password: 'test-password', role, spaces: [listing.access] } })).status(), 200);
      const member = await browser.newContext();
      assert.equal((await member.request.post(base + '/api/login', { data: { username, password: 'test-password' } })).status(), 200);
      const memberPage = await member.newPage();
      await connect(memberPage);
      assert.equal(await memberPage.getByRole('tab', { name: /^JIRA / }).count(), 0);
      await memberPage.getByRole('button', { name: 'Open', exact: true }).click();
      assert.equal(await memberPage.getByRole('menuitem', { name: /^JIRA / }).count(), 0);
      assert.equal(await memberPage.getByRole('group', { name: 'Jira tools', exact: true }).count(), 0);
      for (const endpoint of ['jira-daemon', 'jira-cache']) {
        assert.equal((await member.request.get(base + `/api/${endpoint}?space=${listing.id}`)).status(), 403);
      }
      assert.equal((await member.request.post(base + `/api/jira-daemon/start?space=${listing.id}`)).status(), 403);
      await member.close();
    }

    for (const id of ['graph-add-task', 'undo-button', 'redo-button', 'load-button', 'format-button', 'history-button']) {
      assert.equal(await page.locator('#' + id).isVisible(), true, id + ' must return in task tabs');
    }

    // Exercise a real managed worker on a tab without Jira markers: no Jira network requests.
    assert.equal((await context.request.put(base + `/api/jira-config?space=${listing.id}`, { data: { autostart: true } })).status(), 200);
    let daemon;
    for (let attempt = 0; attempt < 80; attempt++) {
      daemon = await (await context.request.get(base + `/api/jira-daemon?space=${listing.id}`)).json();
      if (daemon.logs.some(line => line.includes('Synchronization complete'))) break;
      await delay(100);
    }
    assert.equal(daemon.running, true, daemon.logs.join('\n'));
    assert.ok(daemon.logs.some(line => line.includes('Synchronization complete')), daemon.logs.join('\n'));
    const cache = await (await context.request.get(base + `/api/jira-cache?space=${listing.id}`)).json();
    assert.equal(cache['jira-cache.json'].space_id, listing.id);
    assert.equal((await context.request.post(base + `/api/jira-daemon/stop?space=${listing.id}`)).status(), 200);
    await delay(2200);
    assert.equal((await (await context.request.get(base + `/api/jira-daemon?space=${listing.id}`)).json()).running, false);
    assert.equal((await context.request.post(base + `/api/jira-daemon/sync?space=${listing.id}`)).status(), 200);
    assert.equal((await (await context.request.get(base + `/api/jira-daemon?space=${listing.id}`)).json()).running, true);
    assert.equal((await context.request.post(base + `/api/jira-daemon/stop?space=${listing.id}`)).status(), 200);

    const previewRequests = [];
    await context.route('**/api/jira-issue-suggestions?**', route => route.fulfill({ json: { issues: [{ key: 'DEMO-12', name: 'Imported from Jira' }] } }));
    await context.route('**/api/jira-import-preview?**', route => {
      const params = new URL(route.request().url()).searchParams, key = params.get('key');
      previewRequests.push(key);
      if (key === 'DEMO-404') return route.fulfill({ status: 404, json: { detail: 'Jira issue is unavailable.' } });
      const children = params.get('include_subtasks') === 'true';
      const tasks = [{ key, title: 'Imported from Jira', state: 'doing', tags: ['urgent', 'task'], people: ['bob'], story_points: 2, description: 'Imported description', depth: 0 }];
      if (children) tasks.push({ key: 'DEMO-13', title: 'Imported child', state: 'doing', tags: [], people: [], description: 'Child description', depth: 1 });
      return route.fulfill({ json: { key, subtask_count: key === 'DEMO-99' ? 0 : 1, tasks,
        script: `% [${key}] Imported from Jira\n!doing #urgent #task @bob ~2\nImported description\n` + (children ? '    % [DEMO-13] Imported child\n    !doing\n    Child description\n' : ''),
        definitions: [{ kind: 'state', slug: 'doing', metadata: { name: 'In Progress', jiraState: 'In Progress' } }, { kind: 'person', slug: 'bob', metadata: { name: 'Bob', email: 'bob@example.com' } }] } });
    });
    const importButton = page.getByRole('button', { name: 'from JIRA', exact: true });
    const primary = page.getByRole('button', { name: 'Add task', exact: true });
    await primary.hover();
    assert.notEqual(await primary.evaluate(node => getComputedStyle(node).backgroundColor), await importButton.evaluate(node => getComputedStyle(node).backgroundColor));
    assert.equal(await primary.evaluate(node => getComputedStyle(node).borderTopLeftRadius), '10px');
    await importButton.hover();
    assert.equal(await primary.evaluate(node => getComputedStyle(node).backgroundColor), await importButton.evaluate(node => getComputedStyle(node).backgroundColor));
    assert.equal(await importButton.locator('i').count(), 0);
    assert.deepEqual(await importButton.evaluate(node => { const css = getComputedStyle(node); return [css.borderTopLeftRadius, css.borderTopRightRadius, css.borderBottomLeftRadius, css.borderBottomRightRadius]; }), ['0px', '0px', '0px', '0px']);
    await page.locator('.graph-canvas').click({ button: 'right', position: { x: 10, y: 10 } });
    await page.getByRole('menuitem', { name: 'Add task from JIRA', exact: true }).click();
    const importer = page.getByRole('dialog', { name: 'Add task from JIRA', exact: true });
    const importKey = importer.getByRole('combobox', { name: 'Jira issue key', exact: true });
    await importKey.fill('DEMO');
    assert.equal(await importer.getByRole('button', { name: 'Import task', exact: true }).isEnabled(), false);
    assert.equal(previewRequests.length, 0);
    await importKey.fill('DEMO-404');
    await importer.getByRole('status').filter({ hasText: 'unavailable' }).waitFor();
    assert.equal(await importer.getByRole('button', { name: 'Import task', exact: true }).isEnabled(), false);
    await importKey.fill('DEMO-');
    await importer.getByRole('option', { name: 'DEMO-12 Imported from Jira', exact: true }).click();
    await importer.locator('.task-node').filter({ hasText: 'Imported from Jira' }).waitFor();
    await importer.getByRole('checkbox', { name: 'Also import 1 subtasks', exact: true }).check();
    await importer.locator('.task-node').filter({ hasText: 'Imported child' }).waitFor();
    const cardAppearance = node => {
      const css = getComputedStyle(node);
      return { text: node.textContent, background: css.backgroundColor, border: css.borderColor, radius: css.borderRadius, width: css.width,
        foreground: css.color, state: node.querySelector('.state-pill')?.outerHTML.replace(/draggable="[^"]*"/g, ''),
        key: node.querySelector('.task-jira-corner')?.textContent, estimates: node.querySelector('.task-corner-meta')?.textContent };
    };
    const previewAppearance = await importer.locator('.task-node').evaluateAll((nodes, code) => {
      const snapshot = eval('(' + code + ')'); return nodes.map(snapshot);
    }, cardAppearance.toString());
    await importer.getByRole('button', { name: 'Import task', exact: true }).click();
    await importer.waitFor({ state: 'hidden' });
    await page.locator('#graph-nodes .task-node').filter({ hasText: 'Imported from Jira' }).waitFor();
    const graphAppearance = await page.locator('#graph-nodes .task-node').filter({ hasText: /Imported from Jira|Imported child/ }).evaluateAll((nodes, code) => {
      const snapshot = eval('(' + code + ')'); return nodes.map(snapshot);
    }, cardAppearance.toString());
    assert.deepEqual(graphAppearance, previewAppearance);

    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await page.locator('#graph-nodes .task-node').filter({ hasText: 'Imported from Jira' }).waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await page.locator('#graph-nodes .task-node').filter({ hasText: 'Imported from Jira' }).waitFor();
    await importButton.click(); await importKey.fill('DEMO-');
    await delay(400);
    assert.equal(await importer.getByRole('option').filter({ hasText: 'DEMO-12' }).count(), 0);
    await importKey.fill('DEMO-12');
    await importer.getByRole('status').filter({ hasText: 'already linked' }).waitFor();
    assert.equal(await importer.locator('.task-node').count(), 0);
    assert.equal(await importer.getByRole('button', { name: 'Import task', exact: true }).isEnabled(), false);
    await importKey.fill('DEMO-99');
    await importer.locator('.task-node').waitFor();
    assert.equal(await importer.getByRole('checkbox').count(), 0);
    await importer.getByRole('button', { name: 'Cancel', exact: true }).click();
    const imported = await (await context.request.get(base + `/api/tab-spaces/${listing.id}/contents`)).json();
    const importedSource = imported.documents.find(doc => doc.kind === 'task').text;
    assert.ok(importedSource.includes('    % [DEMO-13] Imported child'));
    assert.ok(importedSource.includes('jira: In Progress'));
    assert.ok(importedSource.includes('bob@example.com'));
    let tabs = await (await context.request.get(base + '/api/tab-spaces?ref=demo')).json();
    const defs = tabs.tabs.find(tab => tab.kind === 'defs');
    assert.equal((await context.request.post(base + `/api/tab-spaces/${listing.id}/tabs/close`, { data: { id: defs.id, revision: tabs.revision } })).status(), 200);
    assert.equal((await (await context.request.get(base + `/api/jira-config?space=${listing.id}`)).json()).token, 'CURRENT');
    await page.locator('#graph-nodes .task-node').first().dblclick();
    await page.getByRole('button', { name: 'Link Jira', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Link Jira', exact: true }).click();
    await page.getByRole('combobox', { name: 'Jira key', exact: true }).fill('DEMO-42');
    await page.getByRole('combobox', { name: 'Jira key', exact: true }).press('Enter');
    await page.getByRole('button', { name: 'Unlink Jira', exact: true }).waitFor();
    const peer = await context.newPage(); await peer.goto(base); await peer.getByRole('tab', { name: 'main', exact: true }).waitFor();
    await peer.locator('.task-node').first().dblclick();
    await peer.getByRole('button', { name: 'Link Jira', exact: true }).waitFor();
    assert.equal((await context.request.put(base + `/api/jira-config?space=${listing.id}`, { data: { base_url: '', email: '', token: '' } })).status(), 200);
    await peer.getByRole('button', { name: 'Link Jira', exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('button', { name: 'Unlink Jira', exact: true }).isVisible(), true);
    await page.getByRole('button', { name: 'Unlink Jira', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Link Jira', exact: true }).isVisible(), false);
    tabs = await (await context.request.get(base + '/api/tab-spaces?ref=demo')).json();
    assert.equal(tabs.tabs.find(tab => tab.kind === 'defs').filename, '.defs.txt');
    assert.deepEqual(errors, []);
  } catch (error) { await fs.writeFile('/tmp/jira-space-browser-server.log', log); if (browser?.contexts()[0]?.pages()[0]) await fs.writeFile('/tmp/jira-space-browser-dom.html', await browser.contexts()[0].pages()[0].content()); throw error; }
  finally { await browser?.close(); server.kill('SIGTERM'); await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.on('exit', resolve); }); await fs.rm(tmp, { recursive: true, force: true }); }
});
