const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

async function readAppSource() {
  const sourcePath = path.resolve(__dirname, "../scripts/app.ts");
  return fs.readFile(sourcePath, "utf8");
}

async function readSyncEngineSource() {
  const sourcePath = path.resolve(__dirname, "../scripts/syncEngine.ts");
  return fs.readFile(sourcePath, "utf8");
}

// Verifies spellcheck toggle wiring exists for both editor surfaces
// and that one toggle action propagates to main + modal controllers.
test("app source contains shared spellcheck toggle wiring", async () => {
  const source = await readAppSource();
  assert.match(source, /spellcheckToggleMain/);
  assert.match(source, /spellcheckToggleModal/);
  assert.match(source, /function getSpellcheckToggleButtons/);
  assert.match(source, /function setScopedSpellcheckEnabled/);
  assert.match(source, /editorController\?\.setSpellcheckEnabled/);
  assert.match(source, /modalEditorController\?\.setSpellcheckEnabled/);
});

// Verifies task lookup supports trimmed + case-insensitive matching,
// which is required for reliable reference follow/jump behavior.
test("app source contains normalized task lookup for references", async () => {
  const source = await readAppSource();
  assert.match(source, /function findTaskByName/);
  assert.match(source, /name\.trim\(\)/);
  assert.match(source, /toLowerCase\(\)/);
});

// Regression guard for connect-to-space duplication:
// hydrateFromRemote must not run before websocket provider sync, otherwise
// local hydration can race with synced Yjs content and duplicate text.
test("syncEngine connectToSpace hydrates only after provider sync", async () => {
  const source = await readSyncEngineSource();
  const connectStart = source.indexOf("async function connectToSpace(");
  assert.notEqual(connectStart, -1, "connectToSpace function should exist");

  const nextFunctionStart = source.indexOf("\n\n  return {", connectStart);
  assert.notEqual(nextFunctionStart, -1, "expected connectToSpace function body end");

  const connectBlock = source.slice(connectStart, nextFunctionStart);
  const syncHandlerIndex = connectBlock.indexOf('provider.on("sync"');
  assert.ok(syncHandlerIndex > -1, 'connectToSpace should register a provider "sync" handler');

  const beforeSync = connectBlock.slice(0, syncHandlerIndex);
  assert.equal(
    beforeSync.includes("hydrateFromRemote(spaceId, ytext)"),
    false,
    "hydrateFromRemote must not run before provider sync handler registration"
  );

  const syncSection = connectBlock.slice(syncHandlerIndex);
  assert.match(
    syncSection,
    /if\s*\(synced\)\s*\{[\s\S]*?hydrateFromRemote\(spaceId,\s*ytext\);/,
    "hydrateFromRemote should run inside the synced branch of provider.on(\"sync\")"
  );
});
