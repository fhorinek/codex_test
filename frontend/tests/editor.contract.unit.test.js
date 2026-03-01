const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

async function readEditorSource() {
  const sourcePath = path.resolve(__dirname, "../scripts/editor.ts");
  return fs.readFile(sourcePath, "utf8");
}

// Verifies keyboard-modified navigation is wired in code view:
// ctrl/cmd + click path exists and routes both reference and token jumps.
test("editor source contains ctrl/cmd click navigation hooks", async () => {
  const source = await readEditorSource();
  assert.match(source, /addEventListener\("click",\s*\(event(?:\s*:\s*[^)]*)?\)\s*=>/);
  assert.match(source, /event\.ctrlKey\s*\|\|\s*event\.metaKey/);
  assert.match(source, /referenceTokenAtPosition/);
  assert.match(source, /findTaskLineByTitle/);
  assert.match(source, /findConfigLineForToken/);
  assert.match(source, /openReferenceTaskLine/);
});

// Verifies header-config autocomplete support is present:
// section keys (states/people/tags), entry suggestions, and property suggestions.
test("editor source contains header-config autocomplete implementation", async () => {
  const source = await readEditorSource();
  assert.match(source, /function buildHeaderConfigCompletions/);
  assert.match(source, /label:\s*"states:"/);
  assert.match(source, /label:\s*"people:"/);
  assert.match(source, /label:\s*"tags:"/);
  assert.match(source, /label:\s*"name:"/);
  assert.match(source, /label:\s*"color:"/);
  assert.match(source, /taskScriptCompletionSource/);
});

// Verifies Jira bracket autocomplete support is present:
// "[" trigger, Jira marker collector, and closing-bracket apply text.
test("editor source contains jira bracket autocomplete implementation", async () => {
  const source = await readEditorSource();
  assert.match(source, /function collectJiraMarkerValues/);
  assert.match(source, /trigger === "\["/);
  assert.match(source, /apply:\s*`\$\{value\}\]`/);
});

// Verifies modifier-key visual hinting support exists so tokens can be underlined on ctrl/cmd hold.
test("editor source contains modifier-nav activation logic", async () => {
  const source = await readEditorSource();
  assert.match(source, /modifier-nav-active/);
  assert.match(source, /setModifierNavActive/);
  assert.match(source, /syncModifierNavFromEvent/);
  assert.match(source, /addEventListener\("keydown",\s*syncModifierNavFromEvent\)/);
  assert.match(source, /addEventListener\("keyup",\s*syncModifierNavFromEvent\)/);
});
