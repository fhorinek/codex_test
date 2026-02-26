const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let canvasModulePromise = null;

function loadCanvasModule() {
  if (!canvasModulePromise) {
    canvasModulePromise = (async () => {
      const filePath = path.resolve(__dirname, "../scripts/canvas.ts");
      await fs.readFile(filePath, "utf8");
      return import(pathToFileURL(filePath).href);
    })();
  }
  return canvasModulePromise;
}

class FakeClassList {
  constructor(owner) {
    this.owner = owner;
  }

  _parts() {
    return this.owner.className ? this.owner.className.split(/\s+/).filter(Boolean) : [];
  }

  add(...names) {
    const set = new Set(this._parts());
    names.forEach((name) => set.add(name));
    this.owner.className = Array.from(set).join(" ");
  }

  remove(...names) {
    const removeSet = new Set(names);
    this.owner.className = this._parts().filter((name) => !removeSet.has(name)).join(" ");
  }

  contains(name) {
    return this._parts().includes(name);
  }
}

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = "";
    this.classList = new FakeClassList(this);
    this.textContent = "";
    this.title = "";
    this.hidden = false;
    this.draggable = false;
  }

  appendChild(child) {
    if (child) {
      child.parentNode = this;
      this.children.push(child);
    }
    return child;
  }

  append(...items) {
    items.forEach((item) => {
      if (item == null) {
        return;
      }
      if (typeof item === "string") {
        const textNode = new FakeElement("#text");
        textNode.textContent = item;
        this.appendChild(textNode);
        return;
      }
      this.appendChild(item);
    });
  }

  remove() {
    if (!this.parentNode) {
      return;
    }
    const idx = this.parentNode.children.indexOf(this);
    if (idx >= 0) {
      this.parentNode.children.splice(idx, 1);
    }
    this.parentNode = null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name);
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type).push(handler);
  }

  emit(type, event = {}) {
    const handlers = this.listeners.get(type) || [];
    handlers.forEach((handler) => handler(event));
  }

  cloneNode() {
    const clone = new FakeElement(this.tagName);
    clone.className = this.className;
    clone.textContent = this.textContent;
    clone.title = this.title;
    clone.style = { ...this.style };
    clone.dataset = { ...this.dataset };
    clone.draggable = this.draggable;
    return clone;
  }

  closest(selector) {
    if (selector.startsWith(".")) {
      const name = selector.slice(1);
      return this.classList.contains(name) ? this : null;
    }
    return null;
  }

  querySelector() {
    return null;
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 120, height: 24, right: 120, bottom: 24 };
  }
}

function installDomGlobals() {
  const documentListeners = new Map();
  const windowListeners = new Map();
  const document = {
    body: new FakeElement("body"),
    createElement: (tag) => new FakeElement(tag),
    addEventListener(type, handler) {
      if (!documentListeners.has(type)) {
        documentListeners.set(type, []);
      }
      documentListeners.get(type).push(handler);
    },
    execCommand() {
      return true;
    },
  };
  const window = {
    addEventListener(type, handler) {
      if (!windowListeners.has(type)) {
        windowListeners.set(type, []);
      }
      windowListeners.get(type).push(handler);
    },
  };
  const previous = {
    document: global.document,
    window: global.window,
    navigator: global.navigator,
    performance: global.performance,
  };
  global.document = document;
  global.window = window;
  global.navigator = { clipboard: { writeText: async () => {} } };
  global.performance = { now: () => 0 };
  return {
    document,
    window,
    restore() {
      global.document = previous.document;
      global.window = previous.window;
      global.navigator = previous.navigator;
      global.performance = previous.performance;
    },
  };
}

function buildCanvasDom() {
  return {
    graphNodes: new FakeElement("div"),
    graphLines: new FakeElement("svg"),
    graphCanvas: new FakeElement("div"),
    graphMinimap: new FakeElement("div"),
    minimapSvg: new FakeElement("svg"),
    searchName: { checked: true },
    searchDescription: { checked: true },
    searchTag: { checked: true },
    searchPerson: { checked: true },
  };
}

test("createCanvas returns helpers and buildPill creates interactive legend pills", async () => {
  const globals = installDomGlobals();
  try {
    const { createCanvas } = await loadCanvasModule();
    const dom = buildCanvasDom();
    const clicked = [];
    const state = {
      allTasks: [],
      transform: { x: 0, y: 0, scale: 1 },
      collapsed: new Set(),
      selectedTags: new Set(),
      selectedPeople: new Set(),
      positions: new Map(),
      searchQuery: "",
      tagMeta: new Map(),
      peopleMeta: new Map(),
    };

    const controller = createCanvas({
      state,
      dom,
      renderMarkdown: () => "",
      onSelectTask: () => {},
      onEditTask: () => {},
      findTaskByName: () => null,
      onUpdateTaskToken: () => {},
      onUpdateTaskState: () => {},
      onMakeSubtask: () => {},
      onToggleCheckbox: () => {},
      onFiltersChange: () => {},
    });

    assert.equal(typeof controller.renderGraph, "function");
    assert.equal(typeof controller.buildPill, "function");

    const pill = controller.buildPill(
      "#backend",
      true,
      () => clicked.push("click"),
      { name: "Backend", color: "#123456" }
    );

    assert.equal(pill.tagName, "BUTTON");
    assert.equal(pill.draggable, true);
    assert.equal(pill.textContent, "#Backend");
    assert.equal(pill.style.borderColor, "#123456");
    assert.match(pill.className, /\bpill\b/);
    assert.match(pill.className, /\bactive\b/);

    pill.emit("click", {});
    assert.deepEqual(clicked, ["click"]);

    const dragData = {};
    pill.emit("dragstart", {
      clientX: 10,
      clientY: 10,
      dataTransfer: {
        setDragImage() {},
        setData(type, value) {
          dragData[type] = value;
        },
      },
    });
    const payload = JSON.parse(dragData["application/json"]);
    assert.equal(payload.type, "tag");
    assert.equal(payload.value, "#backend");
    assert.equal(payload.source, "legend");
  } finally {
    globals.restore();
  }
});

test("createCanvas drop handler routes task token/state removals from drag payload", async () => {
  const globals = installDomGlobals();
  try {
    const { createCanvas } = await loadCanvasModule();
    const dom = buildCanvasDom();
    const tokenUpdates = [];
    const stateUpdates = [];
    const sharedTask = { id: "t1", name: "Task 1" };
    const state = {
      allTasks: [sharedTask],
      transform: { x: 0, y: 0, scale: 1 },
      collapsed: new Set(),
      selectedTags: new Set(),
      selectedPeople: new Set(),
      positions: new Map(),
      searchQuery: "",
      tagMeta: new Map(),
      peopleMeta: new Map(),
    };

    createCanvas({
      state,
      dom,
      renderMarkdown: () => "",
      onSelectTask: () => {},
      onEditTask: () => {},
      findTaskByName: () => null,
      onUpdateTaskToken: (...args) => tokenUpdates.push(args),
      onUpdateTaskState: (...args) => stateUpdates.push(args),
      onMakeSubtask: () => {},
      onToggleCheckbox: () => {},
      onFiltersChange: () => {},
    });

    const dropEventTag = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      dataTransfer: {
        getData(type) {
          if (type === "application/json") {
            return JSON.stringify({
              source: "task",
              type: "tag",
              taskId: "t1",
              value: "#backend",
            });
          }
          return "";
        },
      },
    };
    dom.graphCanvas.emit("drop", dropEventTag);

    const dropEventState = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      dataTransfer: {
        getData(type) {
          if (type === "application/json") {
            return JSON.stringify({
              source: "kanban",
              type: "task",
              taskId: "t1",
            });
          }
          return "";
        },
      },
    };
    dom.graphCanvas.emit("drop", dropEventState);

    assert.deepEqual(tokenUpdates, [[sharedTask, "#backend", "remove"]]);
    assert.deepEqual(stateUpdates, [[sharedTask, null]]);
  } finally {
    globals.restore();
  }
});
