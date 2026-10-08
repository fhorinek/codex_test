const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require('@playwright/test');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('small backend edits preserve two connected editor selections', { timeout: 60000 }, async () => {
  const root = path.resolve(__dirname, '../..');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'jira-cursor-'));
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const server = spawn(path.join(root, 'backend/.venv/bin/python'), [path.join(root, 'backend/tests/tabs_fixture_server.py'), tmp, String(port)], { cwd: root });
  let log = ''; server.stdout.on('data', data => log += data); server.stderr.on('data', data => log += data);
  let browser;
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 80; i++) { try { if ((await fetch(base)).ok) break; } catch {} await delay(100); }
    browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    assert.equal((await context.request.post(base + '/api/login', { data: { username: 'admin', password: 'admin' } })).status(), 200);
    const listing = await (await context.request.get(base + '/api/tab-spaces?ref=demo')).json();
    const main = listing.tabs.find(tab => tab.name === 'main');
    const content = async () => (await (await context.request.get(base + `/api/tab-spaces/${listing.id}/contents`)).json()).documents.find(doc => doc.id === main.id).text;
    const write = async text => {
      const response = await context.request.post(base + `/api/tab-spaces/${listing.id}/documents`, { data: { changes: [{ id: main.id, expected: await content(), text }] } });
      assert.equal(response.status(), 200, await response.text());
    };
    const before = '% First 🦄\n!todo\n% Middle\nunchanged cursor α🦄 here\n% Last\n!todo\nlast caret here';
    await write(before);
    const peer = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: await context.storageState() });
    const pages = [await context.newPage(), await peer.newPage()];
    for (const page of pages) {
      await page.goto(base);
      await page.getByRole('button', { name: 'Switch space' }).click();
      await page.locator('.space-item').filter({ has: page.locator('.space-label', { hasText: /^demo$/ }) }).getByRole('button', { name: 'Connect', exact: true }).click();
      await page.getByRole('tab', { name: 'main', exact: true }).waitFor();
      await page.waitForFunction(text => document.querySelector('.editor-wrapper .cm-content')?.textContent.includes('unchanged cursor'), before);
      await page.evaluate(async () => {
        const { EditorView } = await import('@codemirror/view');
        window.cursorView = EditorView.findFromDOM(document.querySelector('.editor-wrapper .cm-editor'));
      });
    }
    const anchor = before.indexOf('cursor'), head = anchor + 'cursor α🦄'.length;
    const caret = before.indexOf('caret');
    await pages[0].evaluate(({anchor, head}) => window.cursorView.dispatch({ selection: { anchor, head } }), {anchor, head});
    await pages[1].evaluate(anchor => window.cursorView.dispatch({ selection: { anchor } }), caret);
    const after = before.replace('% First 🦄', '% [DEMO-1] First 🦄').replaceAll('!todo', '!inprogress');
    await write(after);
    for (const page of pages) await page.waitForFunction(text => window.cursorView.state.doc.toString() === text, after);
    const selection = page => page.evaluate(() => { const range = window.cursorView.state.selection.main; return { anchor: range.anchor, head: range.head }; });
    const shift = after.indexOf('cursor') - anchor;
    assert.deepEqual(await selection(pages[0]), { anchor: anchor + shift, head: head + shift });
    assert.deepEqual(await selection(pages[1]), { anchor: after.indexOf('caret'), head: after.indexOf('caret') });
    await write(after);
    assert.deepEqual(await selection(pages[0]), { anchor: anchor + shift, head: head + shift });
  } catch (error) { await fs.writeFile('/tmp/jira-cursor-test.log', log); throw error; }
  finally {
    await browser?.close(); server.kill('SIGTERM');
    await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.on('exit', resolve); });
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
