import { parseTasks, renderMarkdown } from "./task.js";
import { createEditor } from "./editor.js";
import { createCanvas } from "./canvas.js";

const dom = {
  editor: document.getElementById("task-editor"),
  highlightLayer: document.getElementById("highlight-layer"),
  suggestions: document.getElementById("suggestions"),
  graphNodes: document.getElementById("graph-nodes"),
  graphLines: document.getElementById("graph-lines"),
  lineNumbers: document.getElementById("line-numbers"),
  searchInput: document.getElementById("search-input"),
  searchName: document.getElementById("search-name"),
  searchDescription: document.getElementById("search-description"),
  searchTag: document.getElementById("search-tag"),
  searchPerson: document.getElementById("search-person"),
  helpButton: document.getElementById("help-button"),
  helpModal: document.getElementById("help-modal"),
  helpClose: document.getElementById("help-close"),
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
  selectedTags: new Set(),
  selectedPeople: new Set(),
  collapsed: new Set(),
  selectedTaskId: null,
  selectedLine: null,
  searchQuery: "",
  transform: { x: 40, y: 40, scale: 1 },
  positions: new Map(),
  suggestionIndex: 0,
  suggestionItems: [],
};

const sample = `* Launch sprint board\n#productivity #planning\n@maya @luis\n**Goal:** Turn raw task scripts into a visual map. {Refinement}\n\n    * Define parsing rules\n    #parser\n    @maya\n    Draft the parser for tags, people, and markdown descriptions.\n\n* Refinement\n#ux\n@luis\nCollect feedback and iterate on the experience.\n`;

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
  onFiltersChange: buildTagPersonLists,
});

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
  Array.from(state.tags)
    .sort()
    .forEach((tag) => {
      dom.tagList.appendChild(
        canvasController.buildPill(tag, state.selectedTags.has(tag), () =>
          canvasController.toggleTag(tag)
        )
      );
    });
  Array.from(state.people)
    .sort()
    .forEach((person) => {
      dom.personList.appendChild(
        canvasController.buildPill(person, state.selectedPeople.has(person), () =>
          canvasController.togglePerson(person)
        )
      );
    });
}

function sync() {
  const { tasks, tags, people, lines, allTasks } = parseTasks(dom.editor.value);
  state.tasks = tasks;
  state.allTasks = allTasks;
  state.tags = tags;
  state.people = people;
  if (state.selectedLine === null) {
    state.selectedLine = 0;
  }
  editorController.highlightText(lines);
  buildTagPersonLists();
  canvasController.renderGraph();
  editorController.updateSuggestions();
}

function findTaskByName(name) {
  return state.allTasks.find((task) => task.name === name);
}

dom.searchInput.addEventListener("input", () => {
  state.searchQuery = dom.searchInput.value;
  canvasController.renderGraph();
});

[dom.searchName, dom.searchDescription, dom.searchTag, dom.searchPerson].forEach((checkbox) => {
  checkbox.addEventListener("change", () => canvasController.renderGraph());
});

dom.clearFilters.addEventListener("click", () => {
  state.selectedTags.clear();
  state.selectedPeople.clear();
  state.searchQuery = "";
  dom.searchInput.value = "";
  canvasController.renderGraph();
  buildTagPersonLists();
});

dom.helpButton.addEventListener("click", () => {
  dom.helpModal.classList.remove("hidden");
  dom.helpButton.setAttribute("aria-expanded", "true");
});

dom.helpClose.addEventListener("click", () => {
  dom.helpModal.classList.add("hidden");
  dom.helpButton.setAttribute("aria-expanded", "false");
});

dom.helpModal.addEventListener("click", (event) => {
  if (event.target === dom.helpModal) {
    dom.helpModal.classList.add("hidden");
    dom.helpButton.setAttribute("aria-expanded", "false");
  }
});

let resizing = false;

dom.divider.addEventListener("mousedown", () => {
  resizing = true;
  dom.divider.classList.add("dragging");
});

window.addEventListener("mousemove", (event) => {
  if (!resizing) {
    return;
  }
  const rect = document.body.getBoundingClientRect();
  const percentage = (event.clientX / rect.width) * 100;
  const clamped = Math.min(70, Math.max(25, percentage));
  document.documentElement.style.setProperty("--left-width", `${clamped}%`);
});

window.addEventListener("mouseup", () => {
  if (!resizing) {
    return;
  }
  resizing = false;
  dom.divider.classList.remove("dragging");
});

sync();
