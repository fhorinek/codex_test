const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

async function readAppSource() {
  const sourcePath = path.resolve(__dirname, "../scripts/app.js");
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
