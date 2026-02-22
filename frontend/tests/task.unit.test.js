const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

let taskModulePromise = null;

function loadTaskModule() {
  if (!taskModulePromise) {
    taskModulePromise = (async () => {
      const taskPath = path.resolve(__dirname, "../scripts/task.js");
      const source = await fs.readFile(taskPath, "utf8");
      const dataUrl = `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;
      return import(dataUrl);
    })();
  }
  return taskModulePromise;
}

// Verifies that marker-only lines still render as concrete elements:
// - "-" and "*" become empty <li> items inside a <ul>.
// - "1." becomes an empty <li> inside an <ol>.
// - "[ ]" and "[x]" become checkbox-line blocks.
// Also asserts no accidental "undefined" text leaks into output.
test("renderMarkdown renders marker-only list and checkbox lines", async () => {
  const { renderMarkdown } = await loadTaskModule();
  const html = renderMarkdown("-\n*\n1.\n[ ]\n[x]");

  assert.match(html, /<ul>\s*<li><\/li>\s*<li><\/li>\s*<\/ul>/);
  assert.match(html, /<ol>\s*<li><\/li>\s*<\/ol>/);
  assert.equal((html.match(/class="checkbox-line"/g) || []).length, 2);
  assert.doesNotMatch(html, /undefined/);
});

// Verifies ordered-list indentation handling:
// a second list line indented by 4 spaces is rendered as a nested <ol>.
test("renderMarkdown keeps nested ordered list structure", async () => {
  const { renderMarkdown } = await loadTaskModule();
  const html = renderMarkdown("1. Parent\n    1. Child");
  assert.match(html, /<ol><li>Parent<ol><li>Child<\/li><\/ol><\/li><\/ol>/);
});

// Verifies reference token markup format:
// "{Missing Task}" is rendered as a span.references with data-ref="Missing Task"
// so UI layers can bind follow/open behavior consistently.
test("renderMarkdown outputs followable reference span markup", async () => {
  const { renderMarkdown } = await loadTaskModule();
  const html = renderMarkdown("See {Missing Task}");
  assert.match(
    html,
    /<span class="references" data-ref="Missing Task">Missing Task<\/span>/
  );
});

// Verifies base inline markdown styling supported by the parser:
// "**text**" -> <strong>, "__text__" -> <u>, "*text*" -> <em>, "==text==" -> <mark>.
// This confirms all four emphasis styles are transformed in one pass.
test("applyInlineMarkdownWithOptions renders supported inline emphasis styles", async () => {
  const { applyInlineMarkdownWithOptions } = await loadTaskModule();
  const html = applyInlineMarkdownWithOptions(
    "**bold** __underline__ *italic* ==mark=="
  );

  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<u>underline<\/u>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<mark>mark<\/mark>/);
});

// Verifies nested emphasis combinations currently supported by transformation order:
// - italic containing bold
// - bold containing underline
// - italic containing underline
// - italic + underline + bold nesting
// - bold containing highlight/mark
test("applyInlineMarkdownWithOptions renders nested emphasis combinations", async () => {
  const { applyInlineMarkdownWithOptions } = await loadTaskModule();

  assert.match(
    applyInlineMarkdownWithOptions("* **boldItalic** *"),
    /<em>\s*<strong>boldItalic<\/strong>\s*<\/em>/
  );
  assert.match(
    applyInlineMarkdownWithOptions("**__boldUnderline__**"),
    /<strong><u>boldUnderline<\/u><\/strong>/
  );
  assert.match(
    applyInlineMarkdownWithOptions("*__italicUnderline__*"),
    /<em><u>italicUnderline<\/u><\/em>/
  );
  assert.match(
    applyInlineMarkdownWithOptions("*__**triple**__*"),
    /<em><u><strong>triple<\/strong><\/u><\/em>/
  );
  assert.match(
    applyInlineMarkdownWithOptions("**==markedBold==**"),
    /<strong><mark>markedBold<\/mark><\/strong>/
  );
});

// Verifies markdown-link syntax transforms into a clickable anchor and keeps label/href.
test("applyInlineMarkdownWithOptions renders markdown links", async () => {
  const { applyInlineMarkdownWithOptions } = await loadTaskModule();
  const html = applyInlineMarkdownWithOptions("[Docs](https://example.com/docs)");
  assert.match(
    html,
    /<a href="https:\/\/example\.com\/docs" target="_blank" rel="noopener">Docs<\/a>/
  );
});

// Verifies raw URL autolinking transforms plain URLs into clickable anchors.
test("applyInlineMarkdownWithOptions renders plain URL links", async () => {
  const { applyInlineMarkdownWithOptions } = await loadTaskModule();
  const html = applyInlineMarkdownWithOptions("Visit https://example.com");
  assert.match(
    html,
    /<a href="https:\/\/example\.com" target="_blank" rel="noopener">https:\/\/example\.com<\/a>/
  );
});

// Verifies markdown image syntax is preserved as <img> without URL autolink corruption.
test("applyInlineMarkdownWithOptions renders markdown images", async () => {
  const { applyInlineMarkdownWithOptions } = await loadTaskModule();
  const html = applyInlineMarkdownWithOptions("![alt text](https://img.example.com/a.png)");
  assert.match(html, /<img alt="alt text" src="https:\/\/img\.example\.com\/a\.png" \/>/);
  assert.doesNotMatch(html, /href=/);
});

// Verifies disableLinks mode converts markdown links and raw URLs to non-clickable inline spans.
test("applyInlineMarkdownWithOptions respects disableLinks option", async () => {
  const { applyInlineMarkdownWithOptions } = await loadTaskModule();
  const markdownLink = applyInlineMarkdownWithOptions(
    "[Docs](https://example.com/docs)",
    { disableLinks: true }
  );
  const plainUrl = applyInlineMarkdownWithOptions("https://example.com", { disableLinks: true });
  assert.match(markdownLink, /<span class="inline-link">Docs<\/span>/);
  assert.match(plainUrl, /<span class="inline-link">https:\/\/example\.com<\/span>/);
  assert.doesNotMatch(markdownLink, /<a /);
  assert.doesNotMatch(plainUrl, /<a /);
});

// Verifies table markdown is rendered as semantic table structure with header and body rows.
test("renderMarkdown renders table headers and rows", async () => {
  const { renderMarkdown } = await loadTaskModule();
  const html = renderMarkdown(
    "| Name | Status |\n| --- | --- |\n| API | Done |\n| UI | Todo |"
  );
  assert.match(html, /<table><thead><tr>/);
  assert.match(html, /<th>Name<\/th>/);
  assert.match(html, /<th>Status<\/th>/);
  assert.match(html, /<tbody>/);
  assert.match(html, /<td>API<\/td>/);
  assert.match(html, /<td>Done<\/td>/);
});

// Verifies checkbox rendering includes stable data-line mapping for interactive updates.
test("renderMarkdown maps checkbox lines using provided lineIndexes", async () => {
  const { renderMarkdown } = await loadTaskModule();
  const html = renderMarkdown("[ ] A\n[x] B", { lineIndexes: [12, 16] });
  assert.match(html, /class="checkbox-line" data-line="12"/);
  assert.match(html, /class="checkbox-line" data-line="16"/);
  assert.match(html, /input type="checkbox" data-line="12"/);
  assert.match(html, /input type="checkbox" data-line="16"/);
});

// Verifies parse-time reference normalization and incoming-reference counters:
// - both "{ Target }" and "{Target}" normalize to "Target" in source references.
// - incomingReferenceCount de-duplicates per source task for the target task.
// - incomingReferenceCountByName map is populated for the target title.
test("parseTasks trims references and computes incoming reference counters", async () => {
  const { parseTasks } = await loadTaskModule();
  const parsed = parseTasks("% Source\n{ Target }\n{Target}\n% Target\n");

  assert.equal(parsed.allTasks.length, 2);
  const sourceTask = parsed.allTasks.find((task) => task.name === "Source");
  const targetTask = parsed.allTasks.find((task) => task.name === "Target");

  assert.ok(sourceTask);
  assert.ok(targetTask);
  assert.deepEqual(sourceTask.references, ["Target", "Target"]);
  assert.equal(targetTask.incomingReferenceCount, 1);
  assert.equal(targetTask.incomingReferences.length, 1);
  assert.equal(targetTask.incomingReferences[0].name, "Source");
  assert.equal(parsed.incomingReferenceCountByName.get("Target"), 1);
});

// Verifies whitespace trimming inside reference braces:
// "{   Trim Me   }" must normalize to "Trim Me" in parsed references.
test("parseTasks trims whitespace-only padding inside reference braces", async () => {
  const { parseTasks } = await loadTaskModule();
  const parsed = parseTasks("% Any\n{   Trim Me   }\n");
  const task = parsed.allTasks[0];

  assert.ok(task);
  assert.deepEqual(task.references, ["Trim Me"]);
});

// Verifies "~n" story-point token parsing and recursive totals across subtasks.
test("parseTasks parses story points and computes recursive totals", async () => {
  const { parseTasks } = await loadTaskModule();
  const parsed = parseTasks(
    "% Parent\n~3\n    % Child A\n    ~2\n    % Child B\n        % Grandchild\n        ~1\n"
  );

  const parent = parsed.tasks[0];
  const childA = parent.children[0];
  const childB = parent.children[1];
  const grandchild = childB.children[0];

  assert.equal(parent.storyPoints, 3);
  assert.equal(childA.storyPoints, 2);
  assert.equal(childB.storyPoints, null);
  assert.equal(grandchild.storyPoints, 1);

  assert.equal(grandchild.storyPointsSubtasksTotal, 0);
  assert.equal(grandchild.storyPointsTotal, 1);
  assert.equal(childB.storyPointsSubtasksTotal, 1);
  assert.equal(childB.storyPointsTotal, 1);
  assert.equal(parent.storyPointsSubtasksTotal, 3);
  assert.equal(parent.storyPointsTotal, 6);
  assert.equal(parsed.totalStoryPoints, 6);
});
