const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let formatterModulePromise = null;

function loadFormatterModule() {
  if (!formatterModulePromise) {
    formatterModulePromise = (async () => {
      const filePath = path.resolve(__dirname, "../scripts/formatter.ts");
      await fs.readFile(filePath, "utf8");
      return import(pathToFileURL(filePath).href);
    })();
  }
  return formatterModulePromise;
}

function normalizeBlock(text) {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\s+$/u, "").split("\n");
  while (lines.length && lines[0].trim() === "") {
    lines.shift();
  }
  while (lines.length && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }
  if (!lines.length) {
    return "";
  }
  let sharedIndent = null;
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    const indent = line.length - line.trimStart().length;
    sharedIndent = sharedIndent === null ? indent : Math.min(sharedIndent, indent);
  }
  if (sharedIndent && sharedIndent > 0) {
    return lines.map((line) => line.slice(sharedIndent)).join("\n");
  }
  return lines.join("\n");
}

async function assertAutoformatCase(inputText, outputText) {
  const { formatTaskScript } = await loadFormatterModule();
  const formatted = formatTaskScript(normalizeBlock(inputText));
  assert.equal(formatted, normalizeBlock(outputText));
}

const AUTOFORMAT_CASES = [
  {
    name: "creates token line and moves state/estimate from body",
    inputText: `
      % Task
      body !doing text
      notes ~2
    `,
    outputText: `
      % Task
      !doing ~2
      body text
      notes
    `,
  },
  {
    name: "reuses existing token line and appends state/estimate",
    inputText: `
      % Task
      #backend @maya
      body !todo text
      notes ~3
    `,
    outputText: `
      % Task
      #backend @maya !todo ~3
      body text
      notes
    `,
  },
  {
    name: "does not treat prose body line as token line",
    inputText: `
      % Task
      body #backend !todo text
      notes ~1
    `,
    outputText: `
      % Task
      !todo ~1
      body #backend text
      notes
    `,
  },
  {
    name: "canonicalizes only first state and estimate occurrences",
    inputText: `
      % Task
      !todo
      body !doing text ~1 more ~2
    `,
    outputText: `
      % Task
      !todo ~1
      body text more
    `,
  },
  {
    name: "formats multiple tasks independently",
    inputText: `
      % A
      body !todo

      % B
      #ui
      body ~4
    `,
    outputText: `
      % A
      !todo
      body

      % B
      #ui ~4
      body
    `,
  },
  {
    name: "removes blank line between token line and description without token moves",
    inputText: `
      % Task
      #backend @maya

      body text
    `,
    outputText: `
      % Task
      #backend @maya
      body text
    `,
  },
  {
    name: "fix body indentation when inserting a new token line",
    inputText: `
      % Parent
        body !doing text
        notes ~2
    `,
    outputText: `
      % Parent
      !doing ~2
      body text
      notes
    `,
  },
  {
    name: "fix body indentation",
    inputText: `
    % task title
!in-progress ~0
[x] box1
[x] box2
[ ] box3
    `,
    outputText: `
    % task title
    !in-progress ~0
    [x] box1
    [x] box2
    [ ] box3
    `,
  },
  {
    name: "drops extra empty lines in config while formatting tasks",
    inputText: `
      Board:
          people:
              maya:
                  name: Maya


          states:
              doing:
                  jira: In Progress

      % Task
      body !doing text
    `,
    outputText: `
      Board:
          people:
              maya:
                  name: Maya
          states:
              doing:
                  jira: In Progress

      % Task
      !doing
      body text
    `,
  },
];

for (const testCase of AUTOFORMAT_CASES) {
  test(`formatTaskScript ${testCase.name}`, async () => {
    await assertAutoformatCase(testCase.inputText, testCase.outputText);
  });
}

test("formatTaskScript normalizes malformed task indentation to 4-space depth", async () => {
  const { formatTaskScript } = await loadFormatterModule();
  const input = "      % Task\n      #backend\nbody !todo text";
  const output = "    % Task\n    #backend !todo\nbody text";
  assert.equal(formatTaskScript(input), output);
});
