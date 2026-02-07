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
  boardTitle: document.getElementById("board-title"),
  helpButton: document.getElementById("help-button"),
  helpModal: document.getElementById("help-modal"),
  helpClose: document.getElementById("help-close"),
  kanbanBoard: document.getElementById("kanban-board"),
  kanbanDivider: document.getElementById("kanban-divider"),
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

const sample = `Launch board:\n    states:\n        todo\n        inprogress:\n            name: In progress\n            color: #9aa0b8\n        done:\n            name: Done\n            color: #2f54eb\n    people:\n        bob:\n            name: Bob Dilan\n            color: #ff00bb\n        jesica\n        fero\n\n* Launch sprint board\n#productivity #planning !todo\n@maya @luis\n**Goal:** Turn raw task scripts into a visual map. {Refinement}\n\n    * Define parsing rules\n    #parser !inprogress\n    @maya\n    Draft the parser for tags, people, and markdown descriptions.\n\n* Refinement\n#ux !done\n@luis\nCollect feedback and iterate on the experience.\n`;

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
  onFiltersChange: () => {
    buildTagPersonLists();
    buildKanban();
  },
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
}

function buildKanban() {
  if (!dom.kanbanBoard) {
    return;
  }
  dom.kanbanBoard.innerHTML = "";
  const stateOrder = state.config?.states?.map((state) => `!${state.key}`) || [];
  const extraStates = Array.from(state.states)
    .filter((stateTag) => !stateOrder.includes(stateTag))
    .sort((a, b) => a.localeCompare(b));
  const states = [...stateOrder, ...extraStates];
  const tasksByState = new Map();
  states.forEach((stateTag) => tasksByState.set(stateTag, []));
  const unassigned = [];
  state.allTasks.forEach((task) => {
    if (task.state && tasksByState.has(task.state)) {
      tasksByState.get(task.state).push(task);
    } else {
      unassigned.push(task);
    }
  });
  const orderedStates = [...states];
  if (unassigned.length) {
    orderedStates.push("!unassigned");
    tasksByState.set("!unassigned", unassigned);
  }
  orderedStates.forEach((stateTag) => {
    const column = document.createElement("div");
    column.className = "kanban-column";
    column.dataset.stateTag = stateTag;
    const title = document.createElement("h3");
    title.textContent =
      stateTag === "!unassigned"
        ? "Unassigned"
        : state.stateMeta?.get(stateTag)?.name ||
          stateTag.replace(/^!/, "").replace(/^\w/, (char) => char.toUpperCase());
    column.appendChild(title);
    const list = document.createElement("div");
    list.className = "kanban-list";
    (tasksByState.get(stateTag) || []).forEach((task) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "kanban-card";
      card.textContent = task.name;
      if (matchesSearchTask(task)) {
        card.classList.add("kanban-search");
      }
      if (filtersActive() && !matchesFilters(task)) {
        card.classList.add("kanban-hidden");
      }
      if (task.state) {
        const color = state.stateMeta?.get(task.state)?.color;
        if (color) {
          card.style.borderColor = color;
        }
      }
      card.addEventListener("click", () => selectTask(task));
      card.draggable = true;
      card.addEventListener("dragstart", (event) => {
        event.dataTransfer.setData("text/plain", task.id);
      });
      list.appendChild(card);
    });
    column.appendChild(list);
    column.addEventListener("dragover", (event) => {
      event.preventDefault();
    });
    column.addEventListener("drop", (event) => {
      event.preventDefault();
      const taskId = event.dataTransfer.getData("text/plain");
      const task = state.allTasks.find((item) => item.id === taskId);
      if (!task) {
        return;
      }
      const stateTag = column.dataset.stateTag;
      updateTaskState(task, stateTag === "!unassigned" ? null : stateTag);
    });
    dom.kanbanBoard.appendChild(column);
  });
}

function updateTaskState(task, newState) {
  const lines = dom.editor.value.split("\n");
  const taskLine = lines[task.lineIndex] || "";
  const indentMatch = taskLine.match(/^(\s*)\*/) || ["", ""];
  const indent = indentMatch[1] || "";
  let start = task.lineIndex + 1;
  let end = start;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() === "" || /^\s*\*/.test(line)) {
      break;
    }
    end += 1;
  }
  const cleanState = (line) => line.replace(/(^|\s)![^\s#@]+/g, "$1").trimEnd();
  if (start === end) {
    if (newState) {
      lines.splice(start, 0, `${indent}${newState}`);
    }
  } else {
    for (let i = start; i < end; i += 1) {
      lines[i] = cleanState(lines[i]);
    }
    if (newState) {
      if (lines[start].trim() === "") {
        lines[start] = `${indent}${newState}`;
      } else {
        lines[start] = `${lines[start]} ${newState}`.replace(/\s{2,}/g, " ").trimEnd();
      }
    } else {
      const allEmpty = lines.slice(start, end).every((line) => line.trim() === "");
      if (allEmpty) {
        lines.splice(start, end - start);
      }
    }
  }
  dom.editor.value = lines.join("\n");
  sync();
}

function updateTaskToken(task, token, action) {
  const lines = dom.editor.value.split("\n");
  const taskLine = lines[task.lineIndex] || "";
  const indentMatch = taskLine.match(/^(\s*)\*/) || ["", ""];
  const indent = indentMatch[1] || "";
  let start = task.lineIndex + 1;
  let end = start;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() === "" || /^\s*\*/.test(line)) {
      break;
    }
    end += 1;
  }
  const tokenRegex = new RegExp(`(^|\\s)${escapeRegExp(token)}(?=\\s|$)`, "g");
  const hasToken = lines.slice(start, end).some((line) => tokenRegex.test(line));
  if (action === "add") {
    if (hasToken) {
      return;
    }
    if (start === end) {
      lines.splice(start, 0, `${indent}${token}`);
    } else {
      lines[start] = `${lines[start]} ${token}`.replace(/\s{2,}/g, " ").trimEnd();
    }
  } else if (action === "remove") {
    if (start === end) {
      return;
    }
    for (let i = start; i < end; i += 1) {
      lines[i] = lines[i].replace(tokenRegex, "$1").replace(/\s{2,}/g, " ").trimEnd();
    }
    const allEmpty = lines.slice(start, end).every((line) => line.trim() === "");
    if (allEmpty) {
      lines.splice(start, end - start);
    }
  }
  dom.editor.value = lines.join("\n");
  sync();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findTaskByName(name) {
  return state.allTasks.find((task) => task.name === name);
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

function matchesFilters(task) {
  if (!filtersActive()) {
    return true;
  }
  return (
    task.tags.some((tag) => state.selectedTags.has(tag)) ||
    task.people.some((person) => state.selectedPeople.has(person))
  );
}

dom.searchInput.addEventListener("input", () => {
  state.searchQuery = dom.searchInput.value;
  canvasController.renderGraph();
  buildKanban();
});

[dom.searchName, dom.searchDescription, dom.searchTag, dom.searchPerson].forEach((checkbox) => {
  checkbox.addEventListener("change", () => {
    canvasController.renderGraph();
    buildKanban();
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
let resizingKanban = false;

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
      const panelRect = dom.graphCanvas.getBoundingClientRect();
      const minHeight = 120;
      const maxHeight = Math.max(minHeight, panelRect.height - 200);
      const desired = event.clientY - panelRect.top;
      const clamped = Math.min(maxHeight, Math.max(minHeight, desired));
      document.documentElement.style.setProperty("--kanban-height", `${clamped}px`);
      return;
    }
    return;
  }
  const rect = document.body.getBoundingClientRect();
  const percentage = (event.clientX / rect.width) * 100;
  const clamped = Math.min(70, Math.max(25, percentage));
  document.documentElement.style.setProperty("--left-width", `${clamped}%`);
});

window.addEventListener("mouseup", () => {
  if (!resizing) {
    if (resizingKanban) {
      resizingKanban = false;
      dom.kanbanDivider.classList.remove("dragging");
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
});

sync();
