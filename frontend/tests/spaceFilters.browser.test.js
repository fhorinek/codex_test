const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require('@playwright/test');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('people and tag filters follow the space across tabs and reloads', { timeout: 60000 }, async () => {
  const root = path.resolve(__dirname, '../..');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'space-filters-'));
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const server = spawn(path.join(root, 'backend/.venv/bin/python'), [path.join(root, 'backend/tests/tabs_fixture_server.py'), tmp, String(port)], { cwd: root });
  let log = ''; server.stdout.on('data', data => log += data); server.stderr.on('data', data => log += data);
  let browser;
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 80; i++) { try { if ((await fetch(base)).ok) break; } catch {} await delay(100); }
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    assert.equal((await context.request.post(base + '/api/login', { data: { username: 'admin', password: 'admin' } })).status(), 200);
    let listing = await (await context.request.get(base + '/api/tab-spaces?ref=demo')).json();
    const added = await context.request.post(base + `/api/tab-spaces/${listing.id}/tabs/add`, { data: { name: 'release', revision: listing.revision } });
    assert.equal(added.status(), 200, await added.text()); listing = await added.json();
    const main = listing.tabs.find(tab => tab.name === 'main'), release = listing.tabs.find(tab => tab.name === 'release');
    const contents = await (await context.request.get(base + `/api/tab-spaces/${listing.id}/contents`)).json();
    const write = await context.request.post(base + `/api/tab-spaces/${listing.id}/documents`, { data: { changes: [main, release].map(tab => ({ id: tab.id, expected: contents.documents.find(doc => doc.id === tab.id).text, text: `% Anna_${tab.name}\n@anna #urgent !todo\n% Bob_${tab.name}\n@bob #normal !todo\n` })) } });
    assert.equal(write.status(), 200, await write.text());
    const page = await context.newPage(); await page.goto(base);
    await page.getByRole('button', { name: 'Switch space' }).click();
    await page.locator('.space-item').filter({ has: page.locator('.space-label', { hasText: /^demo$/ }) }).getByRole('button', { name: 'Connect', exact: true }).click();
    const person = value => page.locator(`#person-list [data-value="@${value}"]`);
    const tag = value => page.locator(`#tag-list [data-value="#${value}"]`);
    const toggle = async locator => {
      const selected = await locator.evaluate(el => el.classList.contains('active'));
      await locator.click();
      await page.waitForFunction(({ value, selected }) => {
        const current = document.querySelector(`#person-list [data-value="${value}"], #tag-list [data-value="${value}"]`);
        return current && current.classList.contains('active') !== selected;
      }, { value: await locator.getAttribute('data-value'), selected });
    };
    const active = async (people, tags) => {
      assert.deepEqual(await page.locator('#person-list .active').evaluateAll(els => els.map(el => el.dataset.value).sort()), people);
      assert.deepEqual(await page.locator('#tag-list .active').evaluateAll(els => els.map(el => el.dataset.value).sort()), tags);
    };
    const switchTab = async name => {
      await page.getByRole('tab', { name, exact: true }).click();
      await page.waitForFunction(name => document.querySelector('.task-node')?.textContent.includes(`Anna_${name}`), name);
    };
    const dimmed = async name => {
      assert.deepEqual(await page.locator('.task-node.dimmed').evaluateAll(els => els.map(el => el.textContent.includes('Anna_') ? 'anna' : 'bob')), [name]);
    };
    await switchTab('main'); await toggle(person('anna')); await active(['@anna'], []); await dimmed('bob');
    // Legacy tab preferences must no longer replace space-wide filters.
    await page.evaluate(id => localStorage.setItem('tab-view:' + id, JSON.stringify({ selectedPeople: ['@bob'], selectedTags: ['#normal'] })), release.id);
    await switchTab('release'); await active(['@anna'], []); await dimmed('bob');
    await toggle(person('anna')); await toggle(person('bob')); await toggle(tag('normal'));
    await switchTab('main'); await active(['@bob'], ['#normal']); await dimmed('anna');
    await switchTab('release'); await active(['@bob'], ['#normal']); await dimmed('anna');
    await page.reload(); await page.waitForFunction(() => document.querySelector('#person-list [data-value="@bob"]')?.classList.contains('active'));
    await active(['@bob'], ['#normal']); await dimmed('anna');
    await page.getByRole('button', { name: 'Clear Highlights', exact: true }).click();
    await switchTab('main'); await active([], []); assert.equal(await page.locator('.task-node.dimmed').count(), 0);
    await switchTab('release'); await active([], []); assert.equal(await page.locator('.task-node.dimmed').count(), 0);
  } catch (error) { await fs.writeFile('/tmp/space-filters-test.log', log); throw error; }
  finally {
    await browser?.close(); server.kill('SIGTERM');
    await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.on('exit', resolve); });
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
