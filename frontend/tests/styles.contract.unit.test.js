const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

async function readStylesSource() {
  const sourcePath = path.resolve(__dirname, "../styles/styles.css");
  return fs.readFile(sourcePath, "utf8");
}

// Verifies unresolved references have explicit error styling in both themes.
test("styles contain unresolved reference color contracts", async () => {
  const source = await readStylesSource();
  assert.match(source, /\.code-editor \.cm-reference-token-invalid/);
  assert.match(source, /html\[data-theme="dark"\] \.code-editor \.cm-reference-token-invalid/);
  assert.match(source, /\.task-node \.references\.unresolved/);
  assert.match(source, /html\[data-theme="dark"\] \.task-node \.references\.unresolved/);
});

// Verifies reference dropdown and modifier-navigation styles are present.
test("styles contain reference dropdown and modifier-nav contracts", async () => {
  const source = await readStylesSource();
  assert.match(source, /\.task-reference-dropdown/);
  assert.match(source, /\.task-reference-option/);
  assert.match(source, /\.code-editor\.modifier-nav-active \.cm-reference-token/);
  assert.match(source, /\.code-editor\.modifier-nav-active \.cm-tag-token/);
});

// Verifies floating spellcheck toggle styling exists in both light/dark themes.
test("styles contain floating spellcheck toggle hooks", async () => {
  const source = await readStylesSource();
  assert.match(source, /\.floating-toggle/);
  assert.match(source, /html\[data-theme="dark"\] \.floating-toggle/);
});
