const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let kanbanModulePromise = null;

function loadKanbanModule() {
  if (!kanbanModulePromise) {
    kanbanModulePromise = (async () => {
      const filePath = path.resolve(__dirname, "../scripts/kanban.ts");
      await fs.readFile(filePath, "utf8");
      return import(pathToFileURL(filePath).href);
    })();
  }
  return kanbanModulePromise;
}

function createEditorDom(value) {
  return { editor: { value } };
}

test("updateTaskState inserts state line for task without body", async () => {
  const { updateTaskState } = await loadKanbanModule();
  const dom = createEditorDom("% Task");
  let syncCalls = 0;

  updateTaskState({
    task: { lineIndex: 0 },
    newState: "!todo",
    dom,
    sync: () => {
      syncCalls += 1;
    },
  });

  assert.equal(dom.editor.value, "% Task\n!todo\n");
  assert.equal(syncCalls, 1);
});

test("updateTaskState replaces existing state and preserves token order", async () => {
  const { updateTaskState } = await loadKanbanModule();
  const dom = createEditorDom("% Task\n!todo #backend @maya\ndesc");
  let syncCalls = 0;

  updateTaskState({
    task: { lineIndex: 0 },
    newState: "!done",
    dom,
    sync: () => {
      syncCalls += 1;
    },
  });

  assert.equal(dom.editor.value, "% Task\n!done #backend @maya\ndesc");
  assert.equal(syncCalls, 1);
});

test("updateTaskState removes state line and trims leading blank lines", async () => {
  const { updateTaskState } = await loadKanbanModule();
  const dom = createEditorDom("% Task\n!todo\n\ndesc");
  let appliedValue = null;
  let syncCalls = 0;

  updateTaskState({
    task: { lineIndex: 0 },
    newState: null,
    dom,
    applyEditorValue: (value) => {
      appliedValue = value;
    },
    sync: () => {
      syncCalls += 1;
    },
  });

  assert.equal(appliedValue, "% Task\ndesc");
  assert.equal(dom.editor.value, "% Task\n!todo\n\ndesc", "applyEditorValue branch should bypass direct DOM write");
  assert.equal(syncCalls, 1);
});

test("updateTaskToken inserts tag after state token", async () => {
  const { updateTaskToken } = await loadKanbanModule();
  const dom = createEditorDom("% Task\n!todo @maya\ndesc");
  let syncCalls = 0;

  updateTaskToken({
    task: { lineIndex: 0 },
    token: "#backend",
    action: "add",
    dom,
    sync: () => {
      syncCalls += 1;
    },
  });

  assert.equal(dom.editor.value, "% Task\n!todo #backend @maya\ndesc");
  assert.equal(syncCalls, 1);
});

test("updateTaskToken moves duplicate token to top token line when adding", async () => {
  const { updateTaskToken } = await loadKanbanModule();
  const dom = createEditorDom("% Task\nnotes #backend\n!todo");
  let syncCalls = 0;

  updateTaskToken({
    task: { lineIndex: 0 },
    token: "#backend",
    action: "add",
    dom,
    sync: () => {
      syncCalls += 1;
    },
  });

  assert.equal(dom.editor.value, "% Task\n#backend\nnotes\n!todo");
  assert.equal(syncCalls, 1);
});

test("updateTaskToken removes token line and trims blanks", async () => {
  const { updateTaskToken } = await loadKanbanModule();
  const dom = createEditorDom("% Task\n#backend\n\ndesc");
  let syncCalls = 0;

  updateTaskToken({
    task: { lineIndex: 0 },
    token: "#backend",
    action: "remove",
    dom,
    sync: () => {
      syncCalls += 1;
    },
  });

  assert.equal(dom.editor.value, "% Task\ndesc");
  assert.equal(syncCalls, 1);
});

test("updateTaskToken remove returns early when task has no body", async () => {
  const { updateTaskToken } = await loadKanbanModule();
  const dom = createEditorDom("% Task");
  let syncCalls = 0;

  updateTaskToken({
    task: { lineIndex: 0 },
    token: "#backend",
    action: "remove",
    dom,
    sync: () => {
      syncCalls += 1;
    },
  });

  assert.equal(dom.editor.value, "% Task");
  assert.equal(syncCalls, 0);
});

test("updateTaskToken adds estimate to end of token line and removes body estimate", async () => {
  const { updateTaskToken } = await loadKanbanModule();
  const dom = createEditorDom("% Task\n!todo #backend\nbody ~1 text");
  let syncCalls = 0;

  updateTaskToken({
    task: { lineIndex: 0 },
    token: "~2",
    action: "add",
    dom,
    sync: () => {
      syncCalls += 1;
    },
  });

  assert.equal(dom.editor.value, "% Task\n!todo #backend ~2\nbody text");
  assert.equal(syncCalls, 1);
});

test("updateTaskToken removes estimate from token line and description", async () => {
  const { updateTaskToken } = await loadKanbanModule();
  const dom = createEditorDom("% Task\n!todo ~2 #backend\nbody ~1 text");
  let syncCalls = 0;

  updateTaskToken({
    task: { lineIndex: 0 },
    token: "~2",
    action: "remove",
    dom,
    sync: () => {
      syncCalls += 1;
    },
  });

  assert.equal(dom.editor.value, "% Task\n!todo #backend\nbody text");
  assert.equal(syncCalls, 1);
});
