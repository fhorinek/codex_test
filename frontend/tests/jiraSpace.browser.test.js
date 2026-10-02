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
    const listing = await (await context.request.get(base + '/api/tab-spaces?ref=demo')).json();
    assert.equal((await (await context.request.get(base + `/api/jira-status?space=${listing.id}`)).json()).configured, false);
    await page.locator('.task-node').first().dblclick();
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
    await context.route('**/api/jira-daemon**', route => {
      if (route.request().method() === 'POST') commands.push(new URL(route.request().url()).pathname.split('/').pop());
      return route.fulfill({ json: { running: commands.at(-1) !== 'stop', logs: ['Daemon started.', 'Synchronization complete.'] } });
    });
    await context.route('**/api/jira-cache?**', route => route.fulfill({ json: { 'jira-cache.json': { caches: { issue: 'DEMO-42' } } } }));
    await page.getByRole('tab', { name: 'JIRA', exact: true }).click();
    await page.locator('.jira-panel-output').filter({ hasText: 'Daemon started.' }).waitFor();
    assert.equal(await page.locator('.editor-panel').isVisible(), false);
    for (const name of ['Start', 'Stop', 'Restart', 'Sync now']) await page.locator('.jira-panel').getByRole('button', { name, exact: true }).click();
    assert.deepEqual(commands, ['start', 'stop', 'restart', 'sync']);
    await page.locator('.jira-panel').getByRole('button', { name: 'Show cache', exact: true }).click();
    await page.locator('.jira-panel-output').filter({ hasText: 'DEMO-42' }).waitFor();
    await page.getByRole('button', { name: 'Close JIRA Cache', exact: true }).click();
    await page.getByRole('tab', { name: 'JIRA Cache', exact: true }).waitFor({ state: 'detached' });
    await page.getByRole('tab', { name: 'JIRA', exact: true }).click();
    await page.getByRole('button', { name: 'Close JIRA', exact: true }).click();
    await page.getByRole('tab', { name: 'JIRA', exact: true }).waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await page.getByRole('menuitem', { name: 'JIRA', exact: true }).click();
    await page.getByRole('tab', { name: 'JIRA', exact: true }).waitFor();
    await page.getByRole('tab', { name: 'main', exact: true }).click();
    await page.locator('.task-node').first().waitFor();

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

    let tabs = await (await context.request.get(base + '/api/tab-spaces?ref=demo')).json();
    const defs = tabs.tabs.find(tab => tab.kind === 'defs');
    assert.equal((await context.request.post(base + `/api/tab-spaces/${listing.id}/tabs/close`, { data: { id: defs.id, revision: tabs.revision } })).status(), 200);
    assert.equal((await (await context.request.get(base + `/api/jira-config?space=${listing.id}`)).json()).token, 'CURRENT');
    await page.locator('.task-node').first().dblclick();
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
