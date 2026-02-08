import { parseTasks, renderMarkdown } from "./task.js";
import { createEditor } from "./editor.js";
import { createCanvas } from "./canvas.js";
import {
  buildKanban as buildKanbanView,
  updateTaskState as updateTaskStateInEditor,
  updateTaskToken as updateTaskTokenInEditor,
} from "./kanban.js";
import { formatTaskScript } from "./formatter.js";

const dom = {
  editor: document.getElementById("task-editor"),
  highlightLayer: document.getElementById("highlight-layer"),
  suggestions: document.getElementById("suggestions"),
  graphNodes: document.getElementById("graph-nodes"),
  graphLines: document.getElementById("graph-lines"),
  graphMinimap: document.getElementById("graph-minimap"),
  minimapSvg: document.getElementById("minimap-svg"),
  lineNumbers: document.getElementById("line-numbers"),
  searchInput: document.getElementById("search-input"),
  searchName: document.getElementById("search-name"),
  searchDescription: document.getElementById("search-description"),
  searchTag: document.getElementById("search-tag"),
  searchPerson: document.getElementById("search-person"),
  boardTitle: document.getElementById("board-title"),
  undoButton: document.getElementById("undo-button"),
  redoButton: document.getElementById("redo-button"),
  loadButton: document.getElementById("load-button"),
  saveButton: document.getElementById("save-button"),
  formatButton: document.getElementById("format-button"),
  themeButton: document.getElementById("theme-button"),
  fullscreenButton: document.getElementById("fullscreen-button"),
  fileInput: document.getElementById("file-input"),
  kanbanBoard: document.getElementById("kanban-board"),
  kanbanDivider: document.getElementById("kanban-divider"),
  graphPanel: document.querySelector(".graph-panel"),
  tagList: document.getElementById("tag-list"),
  personList: document.getElementById("person-list"),
  clearFilters: document.getElementById("clear-filters"),
  graphCanvas: document.getElementById("graph-canvas"),
  divider: document.getElementById("divider"),
};

const state = {
  tasks: [],
  allTasks: [],
  tags: new Set(),
  people: new Set(),
  states: new Set(),
  invalidStateTags: new Map(),
  config: null,
  tagMeta: new Map(),
  peopleMeta: new Map(),
  stateMeta: new Map(),
  selectedTags: new Set(),
  selectedPeople: new Set(),
  collapsed: new Set(),
  selectedTaskId: null,
  selectedLine: null,
  searchQuery: "",
  transform: { x: 40, y: 40, scale: 1 },
  animateTransform: false,
  positions: new Map(),
  suggestionIndex: 0,
  suggestionItems: [],
};

const sample = `Atlas board:\n    people:\n        maya:\n            name: Maya Rivera\n        luis:\n            name: Luis Ortega\n        sam:\n            name: Sam Patel\n        nina:\n            name: Nina Lopez\n        zara:\n            name: Zara Chen\n    tags:\n        planning\n        backend\n        ux\n        research\n\n% Kickoff sprint\n!todo @maya #planning #ux\n**Goal:** Align scope, risks, and owners. {Architecture}\n- Define success metrics\n- Draft roadmap milestones\n[ ] Share notes with stakeholders\n[ ] Lock sprint goals\n\n    % Collect requirements\n    !inprogress @sam #research\n    Interview 5 users and summarize themes.\n    [ ] Write interview guide\n    [x] Schedule sessions\n\n        % Summarize insights\n        !todo @nina #research #planning\n        Capture themes and map to product risks.\n\n    % Create UX flow\n    !todo @maya #ux\n    Map onboarding screens and happy path.\n    - Wireframe key screens\n    - Validate navigation\n\n% Architecture\n!inprogress @luis #backend\nDefine data contracts and core services.\n| Area | Owner | Status |\n| --- | --- | --- |\n| API | Luis | Draft |\n| Data | Maya | Review |\n\n    % Build service skeleton\n    !todo @luis #backend\n    [ ] Set up repo and CI\n    [ ] Define API endpoints\n\n    % Integrate auth\n    !todo @sam #backend\n    Connect OAuth provider and session storage.\n\n        % Validate permissions\n        !todo @zara #backend #research\n        Check scopes and error handling.\n\n% Release prep\n!todo @maya #planning\nFinalize checklist and release timeline.\n{Kickoff sprint}\n`;

dom.editor.value = sample;

const editorController = createEditor({
  state,
  dom,
  onSync: sync,
  onSelectTask: handleEditorSelection,
});

const canvasController = createCanvas({
  state,
  dom,
  renderMarkdown,
  onSelectTask: selectTask,
  findTaskByName,
  onUpdateTaskToken: updateTaskToken,
  onUpdateTaskState: updateTaskState,
  onMakeSubtask: moveTaskAsSubtask,
  onToggleCheckbox: toggleCheckboxAtLine,
  onFiltersChange: () => {
    buildTagPersonLists();
    buildKanban();
    updateClearFiltersVisibility();
  },
});

function applyEditorValue(nextValue) {
  const { editor } = dom;
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const scrollTop = editor.scrollTop;
  const scrollLeft = editor.scrollLeft;
  const currentValue = editor.value;
  if (currentValue === nextValue) {
    return;
  }
  // Apply a minimal text diff to preserve undo history and selection.
  let prefix = 0;
  const maxPrefix = Math.min(currentValue.length, nextValue.length);
  while (prefix < maxPrefix && currentValue[prefix] === nextValue[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  const maxSuffix = Math.min(
    currentValue.length - prefix,
    nextValue.length - prefix
  );
  while (
    suffix < maxSuffix &&
    currentValue[currentValue.length - 1 - suffix] ===
      nextValue[nextValue.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const oldReplaceStart = prefix;
  const oldReplaceEnd = currentValue.length - suffix;
  const newReplace = nextValue.slice(prefix, nextValue.length - suffix);
  editor.focus();
  editor.setSelectionRange(oldReplaceStart, oldReplaceEnd);
  let replaced = false;
  try {
    replaced = document.execCommand("insertText", false, newReplace);
  } catch {
    replaced = false;
  }
  if (!replaced) {
    editor.setRangeText(newReplace, oldReplaceStart, oldReplaceEnd, "end");
  }
  const delta = nextValue.length - currentValue.length;
  const adjustOffset = (pos) => {
    if (pos <= oldReplaceStart) {
      return pos;
    }
    if (pos >= oldReplaceEnd) {
      return pos + delta;
    }
    return oldReplaceStart + newReplace.length;
  };
  const clampedStart = Math.min(adjustOffset(start), editor.value.length);
  const clampedEnd = Math.min(adjustOffset(end), editor.value.length);
  editor.setSelectionRange(clampedStart, clampedEnd);
  editor.scrollTop = scrollTop;
  editor.scrollLeft = scrollLeft;
}

function handleEditorSelection(line) {
  const task = state.allTasks.find((item) => item.lineIndex === line);
  if (task) {
    state.selectedTaskId = task.id;
    state.selectedLine = task.lineIndex;
    canvasController.focusOnTask(task);
    canvasController.renderGraph();
  } else {
    editorController.updateSelectedLine();
  }
}

function selectTask(task) {
  state.selectedTaskId = task.id;
  state.selectedLine = task.lineIndex;
  let current = task.parent;
  while (current) {
    state.collapsed.delete(current.id);
    current = current.parent;
  }
  const lines = dom.editor.value.split("\n");
  const targetLine = task.lineIndex;
  const caretPosition = lines.slice(0, targetLine).reduce((sum, line) => sum + line.length + 1, 0);
  dom.editor.focus();
  dom.editor.setSelectionRange(caretPosition, caretPosition);
  editorController.updateSelectedLine();
  editorController.highlightText(dom.editor.value.split("\n"));
  canvasController.focusOnTask(task);
  canvasController.renderGraph();
}

function buildTagPersonLists() {
  dom.tagList.innerHTML = "";
  dom.personList.innerHTML = "";
  const tagOrder = state.config?.tags?.map((tag) => `#${tag.key}`) || [];
  const extraTags = Array.from(state.tags).filter((tag) => !tagOrder.includes(tag)).sort();
  const tags = [...tagOrder, ...extraTags];
  tags.forEach((tag) => {
    const meta = state.tagMeta?.get(tag);
    dom.tagList.appendChild(
      canvasController.buildPill(
        tag,
        state.selectedTags.has(tag),
        () => {
          canvasController.toggleTag(tag);
        },
        meta
      )
    );
  });
  const peopleOrder = state.config?.people?.map((person) => `@${person.key}`) || [];
  const extraPeople = Array.from(state.people)
    .filter((person) => !peopleOrder.includes(person))
    .sort();
  const people = [...peopleOrder, ...extraPeople];
  people.forEach((person) => {
    const meta = state.peopleMeta?.get(person);
    dom.personList.appendChild(
      canvasController.buildPill(
        person,
        state.selectedPeople.has(person),
        () => {
          canvasController.togglePerson(person);
        },
        meta
      )
    );
  });
}

function sync() {
  const {
    tasks,
    tags,
    people,
    states,
    invalidStateTags,
    lines,
    allTasks,
    config,
    tagMeta,
    peopleMeta,
    stateMeta,
  } = parseTasks(dom.editor.value);
  state.tasks = tasks;
  state.allTasks = allTasks;
  state.tags = tags;
  state.people = people;
  state.states = states;
  state.invalidStateTags = invalidStateTags;
  state.config = config;
  state.tagMeta = tagMeta;
  state.peopleMeta = peopleMeta;
  state.stateMeta = stateMeta;
  if (dom.boardTitle) {
    const title = config.boardName || "Task Script";
    dom.boardTitle.textContent = title;
    document.title = title;
  }
  if (state.selectedLine === null) {
    state.selectedLine = 0;
  }
  editorController.highlightText(lines);
  buildTagPersonLists();
  buildKanban();
  canvasController.renderGraph();
  editorController.updateSuggestions();
  updateClearFiltersVisibility();
}

function buildKanban() {
  buildKanbanView({
    state,
    dom,
    selectTask,
    matchesSearchTask,
    filtersActive,
    matchesFilters,
    updateTaskState,
  });
}

function updateTaskState(task, newState) {
  updateTaskStateInEditor({ task, newState, dom, sync, applyEditorValue });
}

function updateTaskToken(task, token, action) {
  updateTaskTokenInEditor({ task, token, action, dom, sync, applyEditorValue });
}

function moveTaskAsSubtask(sourceTask, targetTask) {
  if (!sourceTask || !targetTask || sourceTask.id === targetTask.id) {
    return;
  }
  let current = targetTask.parent;
  while (current) {
    if (current.id === sourceTask.id) {
      return;
    }
    current = current.parent;
  }
  const lines = dom.editor.value.split("\n");
  const sourceBlock = findTaskBlock(lines, sourceTask.lineIndex);
  const targetBlock = findTaskBlock(lines, targetTask.lineIndex);
  if (!sourceBlock || !targetBlock) {
    return;
  }
  // Move the entire source block and re-indent it under the target task.
  const indentDelta = (targetBlock.depth + 1 - sourceBlock.depth) * 4;
  const blockLines = lines.slice(sourceBlock.start, sourceBlock.end);
  lines.splice(sourceBlock.start, sourceBlock.end - sourceBlock.start);
  let insertIndex = targetBlock.end;
  if (sourceBlock.start < insertIndex) {
    insertIndex -= blockLines.length;
  }
  const adjustedLines = blockLines.map((line) => adjustIndent(line, indentDelta));
  lines.splice(insertIndex, 0, ...adjustedLines);
  applyEditorValue(lines.join("\n"));
  syncEditorState();
}

function findTaskByName(name) {
  return state.allTasks.find((task) => task.name === name);
}

function syncEditorState() {
  sync();
  editorController.updateSelectedLine();
}

function findTaskBlock(lines, lineIndex) {
  const taskLine = lines[lineIndex] || "";
  const match = taskLine.match(/^(\s*)%/);
  if (!match) {
    return null;
  }
  const indent = match[1] || "";
  const depth = Math.floor(indent.length / 4);
  let end = lineIndex + 1;
  while (end < lines.length) {
    const line = lines[end];
    const taskMatch = line.match(/^(\s*)%/);
    if (taskMatch) {
      const lineDepth = Math.floor(taskMatch[1].length / 4);
      if (lineDepth <= depth) {
        break;
      }
    }
    end += 1;
  }
  return { start: lineIndex, end, depth, indent };
}

function adjustIndent(line, deltaSpaces) {
  if (!deltaSpaces || !line.trim()) {
    return line;
  }
  if (deltaSpaces > 0) {
    return `${" ".repeat(deltaSpaces)}${line}`;
  }
  const leading = line.match(/^\s*/)?.[0] || "";
  const removeCount = Math.min(leading.length, Math.abs(deltaSpaces));
  return line.slice(removeCount);
}

function toggleCheckboxAtLine(lineIndex, checked = null) {
  const lines = dom.editor.value.split("\n");
  const line = lines[lineIndex];
  if (!line) {
    return;
  }
  const match = line.match(/^(\s*\[)([ xX])(\])/);
  if (!match) {
    return;
  }
  const nextValue =
    checked === null
      ? match[2].toLowerCase() === "x"
        ? " "
        : "x"
      : checked
        ? "x"
        : " ";
  lines[lineIndex] = line.replace(/^(\s*\[)([ xX])(\])/, `$1${nextValue}$3`);
  applyEditorValue(lines.join("\n"));
  syncEditorState();
}

function toSafeFilename(value) {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "tasks";
}

function matchesSearchTask(task) {
  if (!state.searchQuery) {
    return false;
  }
  const query = state.searchQuery.toLowerCase();
  if (dom.searchName.checked && task.name.toLowerCase().includes(query)) {
    return true;
  }
  if (dom.searchDescription.checked && task.description.join(" ").toLowerCase().includes(query)) {
    return true;
  }
  if (dom.searchTag.checked && task.tags.join(" ").toLowerCase().includes(query)) {
    return true;
  }
  if (dom.searchPerson.checked && task.people.join(" ").toLowerCase().includes(query)) {
    return true;
  }
  return false;
}

function filtersActive() {
  return state.selectedTags.size || state.selectedPeople.size;
}

function updateClearFiltersVisibility() {
  if (!dom.clearFilters) {
    return;
  }
  const hasFilters = filtersActive();
  const hasSearch = Boolean(state.searchQuery && state.searchQuery.trim());
  dom.clearFilters.hidden = !(hasFilters || hasSearch);
}

function matchesFilters(task) {
  if (!filtersActive()) {
    return true;
  }
  return (
    task.tags.some((tag) => state.selectedTags.has(tag)) ||
    task.people.some((person) => state.selectedPeople.has(person))
  );
}

if (dom.undoButton) {
  dom.undoButton.addEventListener("click", () => {
    dom.editor.focus();
    document.execCommand("undo");
    syncEditorState();
  });
}

if (dom.redoButton) {
  dom.redoButton.addEventListener("click", () => {
    dom.editor.focus();
    document.execCommand("redo");
    syncEditorState();
  });
}

if (dom.loadButton && dom.fileInput) {
  dom.loadButton.addEventListener("click", () => {
    dom.fileInput.click();
  });
  dom.fileInput.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    const text = await file.text();
    dom.editor.value = text;
    dom.fileInput.value = "";
    syncEditorState();
  });
}

if (dom.saveButton) {
  dom.saveButton.addEventListener("click", () => {
    const title = state.config?.boardName || dom.boardTitle?.textContent || "tasks";
    const filename = `${toSafeFilename(title)}.txt`;
    const blob = new Blob([dom.editor.value], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  });
}

if (dom.formatButton) {
  dom.formatButton.addEventListener("click", () => {
    const formatted = formatTaskScript(dom.editor.value);
    if (formatted === dom.editor.value) {
      return;
    }
    applyEditorValue(formatted);
    syncEditorState();
  });
}

function setTheme(theme) {
  const resolved = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = resolved;
  localStorage.setItem("theme", resolved);
  if (dom.themeButton) {
    dom.themeButton.textContent = resolved === "dark" ? "☀" : "☾";
  }
}

if (dom.themeButton) {
  const storedTheme = localStorage.getItem("theme");
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)")?.matches;
  setTheme(storedTheme || (prefersDark ? "dark" : "light"));
  dom.themeButton.addEventListener("click", () => {
    const current = document.documentElement.dataset.theme;
    setTheme(current === "dark" ? "light" : "dark");
  });
}

if (dom.fullscreenButton) {
  dom.fullscreenButton.addEventListener("click", async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    await document.documentElement.requestFullscreen();
  });
}

dom.searchInput.addEventListener("input", () => {
  state.searchQuery = dom.searchInput.value;
  canvasController.renderGraph();
  buildKanban();
  updateClearFiltersVisibility();
});

[dom.searchName, dom.searchDescription, dom.searchTag, dom.searchPerson].forEach((checkbox) => {
  checkbox.addEventListener("change", () => {
    canvasController.renderGraph();
    buildKanban();
    updateClearFiltersVisibility();
  });
});

dom.clearFilters.addEventListener("click", () => {
  state.selectedTags.clear();
  state.selectedPeople.clear();
  state.searchQuery = "";
  dom.searchInput.value = "";
  canvasController.renderGraph();
  buildTagPersonLists();
  buildKanban();
  updateClearFiltersVisibility();
});

let resizing = false;
let resizingKanban = false;
let pendingGraphRender = null;

function scheduleGraphRender() {
  if (pendingGraphRender) {
    return;
  }
  // Batch graph reflows to one per frame while dragging resizers.
  pendingGraphRender = requestAnimationFrame(() => {
    pendingGraphRender = null;
    canvasController.renderGraph();
  });
}

dom.divider.addEventListener("mousedown", () => {
  resizing = true;
  dom.divider.classList.add("dragging");
});

if (dom.kanbanDivider) {
  dom.kanbanDivider.addEventListener("mousedown", () => {
    resizingKanban = true;
    dom.kanbanDivider.classList.add("dragging");
  });
}

window.addEventListener("mousemove", (event) => {
  if (!resizing) {
    if (resizingKanban) {
      const panelRect = (dom.graphPanel || dom.graphCanvas).getBoundingClientRect();
      const dividerHeight = dom.kanbanDivider?.offsetHeight || 0;
      const minHeight = 120;
      const minGraphHeight = 200;
      const maxHeight = Math.max(minHeight, panelRect.height - minGraphHeight - dividerHeight);
      const desired = panelRect.bottom - event.clientY;
      const clamped = Math.min(maxHeight, Math.max(minHeight, desired));
      document.documentElement.style.setProperty("--kanban-height", `${clamped}px`);
      scheduleGraphRender();
      return;
    }
    return;
  }
  const rect = document.body.getBoundingClientRect();
  const percentage = (event.clientX / rect.width) * 100;
  const clamped = Math.min(70, Math.max(25, percentage));
  document.documentElement.style.setProperty("--left-width", `${clamped}%`);
  scheduleGraphRender();
});

window.addEventListener("mouseup", () => {
  if (!resizing) {
    if (resizingKanban) {
      resizingKanban = false;
      dom.kanbanDivider.classList.remove("dragging");
      scheduleGraphRender();
      return;
    }
    return;
  }
  resizing = false;
  dom.divider.classList.remove("dragging");
  if (resizingKanban) {
    resizingKanban = false;
    dom.kanbanDivider.classList.remove("dragging");
  }
  scheduleGraphRender();
});

window.addEventListener("resize", scheduleGraphRender);

sync();
