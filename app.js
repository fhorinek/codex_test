const editor = document.getElementById("task-editor");
const highlightLayer = document.getElementById("highlight-layer");
const suggestions = document.getElementById("suggestions");
const graphNodes = document.getElementById("graph-nodes");
const graphLines = document.getElementById("graph-lines");
const searchInput = document.getElementById("search-input");
const searchName = document.getElementById("search-name");
const searchDescription = document.getElementById("search-description");
const searchTag = document.getElementById("search-tag");
const searchPerson = document.getElementById("search-person");
const tagList = document.getElementById("tag-list");
const personList = document.getElementById("person-list");
const clearFilters = document.getElementById("clear-filters");
const graphCanvas = document.getElementById("graph-canvas");

const state = {
  tasks: [],
  allTasks: [],
  tags: new Set(),
  people: new Set(),
  selectedTags: new Set(),
  selectedPeople: new Set(),
  collapsed: new Set(),
  selectedTaskId: null,
  searchQuery: "",
  transform: { x: 40, y: 40, scale: 1 },
};

const sample = `* Launch sprint board\n#productivity #planning\n@maya @luis\n**Goal:** Turn raw task scripts into a visual map. [Refinement]\n\n    * Define parsing rules\n    #parser\n    @maya\n    Draft the parser for tags, people, and markdown descriptions.\n\n* Refinement\n#ux\n@luis\nCollect feedback and iterate on the experience.\n`;

editor.value = sample;

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function parseTasks(text) {
  const lines = text.split("\n");
  const tasks = [];
  const stack = [];
  let currentTask = null;
  const tags = new Set();
  const people = new Set();

  lines.forEach((line, index) => {
    const raw = line;
    const trimmed = raw.trim();
    const taskMatch = raw.match(/^(\s*)\*\s+(.*)$/);
    if (taskMatch) {
      const indent = taskMatch[1].length;
      const depth = Math.floor(indent / 4);
      const name = taskMatch[2].trim();
      const task = {
        id: `${index}-${name}`,
        name,
        depth,
        parent: null,
        tags: [],
        people: [],
        description: [],
        references: [],
        children: [],
        lineIndex: index,
      };
      if (depth === 0) {
        tasks.push(task);
        stack.length = 0;
        stack.push(task);
      } else {
        const parent = stack[depth - 1];
        if (parent) {
          parent.children.push(task);
          task.parent = parent;
        }
        stack[depth] = task;
      }
      currentTask = task;
      return;
    }

    if (!currentTask || trimmed === "") {
      return;
    }

    if (trimmed.startsWith("#")) {
      const found = trimmed.split(/\s+/).filter(Boolean);
      found.forEach((tag) => {
        if (tag.startsWith("#")) {
          currentTask.tags.push(tag);
          tags.add(tag);
        }
      });
      return;
    }

    if (trimmed.startsWith("@")) {
      const found = trimmed.split(/\s+/).filter(Boolean);
      found.forEach((person) => {
        if (person.startsWith("@")) {
          currentTask.people.push(person);
          people.add(person);
        }
      });
      return;
    }

    currentTask.description.push(trimmed);
    const matches = trimmed.matchAll(/\[([^\]]+)\]/g);
    for (const match of matches) {
      currentTask.references.push(match[1]);
    }
  });

  const allTasks = [];
  const collect = (items) => {
    items.forEach((task) => {
      allTasks.push(task);
      if (task.children.length) {
        collect(task.children);
      }
    });
  };
  collect(tasks);

  return { tasks, tags, people, lines, allTasks };
}

function highlightText(lines) {
  const highlighted = lines
    .map((line) => {
      const taskMatch = line.match(/^(\s*)\*\s+(.*)$/);
      if (taskMatch) {
        const indent = taskMatch[1];
        const name = taskMatch[2];
        const className = indent.length >= 4 ? "highlight-subtask" : "highlight-task";
        return `${escapeHtml(indent)}<span class="${className}">* ${escapeHtml(name)}</span>`;
      }
      if (line.trim().startsWith("#")) {
        return `<span class="highlight-tags">${escapeHtml(line)}</span>`;
      }
      if (line.trim().startsWith("@")) {
        return `<span class="highlight-people">${escapeHtml(line)}</span>`;
      }
      if (line.trim() !== "") {
        return `<span class="highlight-description">${escapeHtml(line)}</span>`;
      }
      return "";
    })
    .join("\n");
  highlightLayer.innerHTML = highlighted;
}

function updateSuggestions() {
  const cursor = editor.selectionStart;
  const before = editor.value.slice(0, cursor);
  const triggerMatch = before.match(/([#@\[])([^\s\]]*)$/);
  if (!triggerMatch) {
    suggestions.classList.add("hidden");
    suggestions.innerHTML = "";
    return;
  }
  const trigger = triggerMatch[1];
  const partial = triggerMatch[2].toLowerCase();
  let items = [];
  if (trigger === "#") {
    items = Array.from(state.tags);
  } else if (trigger === "@") {
    items = Array.from(state.people);
  } else {
    items = state.allTasks.map((task) => task.name);
  }
  const filtered = items.filter((item) => item.toLowerCase().includes(partial));
  if (!filtered.length) {
    suggestions.classList.add("hidden");
    suggestions.innerHTML = "";
    return;
  }
  suggestions.innerHTML = "";
  filtered.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = item;
    button.addEventListener("click", () => {
      const insert = trigger === "[" ? `${item}]` : item.slice(1);
      const start = cursor - partial.length;
      editor.setRangeText(insert, start, cursor, "end");
      editor.focus();
      suggestions.classList.add("hidden");
      sync();
    });
    suggestions.appendChild(button);
  });
  suggestions.classList.remove("hidden");
}

function buildPill(text, active, onClick) {
  const pill = document.createElement("button");
  pill.type = "button";
  pill.className = `pill ${active ? "active" : ""}`;
  pill.textContent = text;
  pill.addEventListener("click", onClick);
  return pill;
}

function buildTagPersonLists() {
  tagList.innerHTML = "";
  personList.innerHTML = "";
  Array.from(state.tags)
    .sort()
    .forEach((tag) => {
      tagList.appendChild(
        buildPill(tag, state.selectedTags.has(tag), () => toggleTag(tag))
      );
    });
  Array.from(state.people)
    .sort()
    .forEach((person) => {
      personList.appendChild(
        buildPill(person, state.selectedPeople.has(person), () => togglePerson(person))
      );
    });
}

function toggleTag(tag) {
  if (state.selectedTags.has(tag)) {
    state.selectedTags.delete(tag);
  } else {
    state.selectedTags.add(tag);
  }
  expandForFilters();
  renderGraph();
}

function togglePerson(person) {
  if (state.selectedPeople.has(person)) {
    state.selectedPeople.delete(person);
  } else {
    state.selectedPeople.add(person);
  }
  expandForFilters();
  renderGraph();
}

function expandForFilters() {
  if (!state.selectedTags.size && !state.selectedPeople.size) {
    return;
  }
  const ensureExpanded = (task, ancestors) => {
    const matches =
      task.tags.some((tag) => state.selectedTags.has(tag)) ||
      task.people.some((person) => state.selectedPeople.has(person));
    const childMatch = task.children.some((child) => ensureExpanded(child, [...ancestors, task]));
    if (matches || childMatch) {
      ancestors.forEach((ancestor) => state.collapsed.delete(ancestor.id));
      state.collapsed.delete(task.id);
    }
    return matches || childMatch;
  };
  state.tasks.forEach((task) => ensureExpanded(task, []));
}

function matchesSearch(task) {
  if (!state.searchQuery) {
    return false;
  }
  const query = state.searchQuery.toLowerCase();
  if (searchName.checked && task.name.toLowerCase().includes(query)) {
    return true;
  }
  if (
    searchDescription.checked &&
    task.description.join(" ").toLowerCase().includes(query)
  ) {
    return true;
  }
  if (searchTag.checked && task.tags.join(" ").toLowerCase().includes(query)) {
    return true;
  }
  if (searchPerson.checked && task.people.join(" ").toLowerCase().includes(query)) {
    return true;
  }
  return false;
}

function findTaskByName(name) {
  return state.allTasks.find((task) => task.name === name);
}

function gatherVisible(tasks, result = [], depth = 0) {
  tasks.forEach((task) => {
    result.push(task);
    if (!state.collapsed.has(task.id)) {
      gatherVisible(task.children, result, depth + 1);
    }
  });
  return result;
}

function renderGraph() {
  graphNodes.innerHTML = "";
  graphLines.innerHTML = "";
  graphLines.setAttribute("viewBox", "0 0 1200 800");

  const visibleTasks = gatherVisible(state.tasks);
  const positions = new Map();
  let y = 40;
  const spacingY = 140;

  visibleTasks.forEach((task) => {
    const x = 60 + task.depth * 260;
    positions.set(task.id, { x, y });
    y += spacingY;
  });

  graphLines.innerHTML = visibleTasks
    .map((task) => {
      const pos = positions.get(task.id);
      return task.children
        .filter((child) => positions.has(child.id))
        .map((child) => {
          const childPos = positions.get(child.id);
          return `<line x1="${pos.x + 110}" y1="${pos.y + 20}" x2="${childPos.x + 110}" y2="${childPos.y}" stroke="#b9c0ff" stroke-width="2" />`;
        })
        .join("");
    })
    .join("");

  visibleTasks.forEach((task) => {
    const pos = positions.get(task.id);
    const node = document.createElement("div");
    node.className = "task-node";
    node.style.left = `${pos.x}px`;
    node.style.top = `${pos.y}px`;

    if (state.selectedTaskId === task.id) {
      node.classList.add("selected");
    }

    const hasFilters = state.selectedTags.size || state.selectedPeople.size;
    if (hasFilters) {
      const matches =
        task.tags.some((tag) => state.selectedTags.has(tag)) ||
        task.people.some((person) => state.selectedPeople.has(person));
      if (!matches) {
        node.classList.add("dimmed");
      }
    }

    if (matchesSearch(task)) {
      node.classList.add("search-highlight");
    }

    const title = document.createElement("h4");
    title.textContent = task.name;

    const meta = document.createElement("div");
    meta.className = "meta";
    task.tags.forEach((tag) => {
      meta.appendChild(
        buildPill(tag, state.selectedTags.has(tag), (event) => {
          event.stopPropagation();
          toggleTag(tag);
        })
      );
    });
    task.people.forEach((person) => {
      meta.appendChild(
        buildPill(person, state.selectedPeople.has(person), (event) => {
          event.stopPropagation();
          togglePerson(person);
        })
      );
    });

    const desc = document.createElement("div");
    desc.className = "description";
    desc.textContent = task.description.join(" ");

    const references = document.createElement("div");
    task.references.forEach((ref) => {
      const refLink = document.createElement("span");
      refLink.className = "references";
      refLink.textContent = ref;
      refLink.addEventListener("click", (event) => {
        event.stopPropagation();
        const target = findTaskByName(ref);
        if (target) {
          selectTask(target);
        }
      });
      references.appendChild(refLink);
    });

    const toggle = document.createElement("div");
    toggle.className = "collapse-toggle";
    if (task.children.length) {
      const label = state.collapsed.has(task.id)
        ? `${task.children.length} Subtasks show`
        : `${task.children.length} Subtasks hide`;
      toggle.textContent = label;
      toggle.addEventListener("click", (event) => {
        event.stopPropagation();
        if (state.collapsed.has(task.id)) {
          state.collapsed.delete(task.id);
        } else {
          state.collapsed.add(task.id);
        }
        renderGraph();
      });
    }

    node.appendChild(title);
    node.appendChild(meta);
    if (task.description.length) {
      node.appendChild(desc);
    }
    if (task.references.length) {
      node.appendChild(references);
    }
    if (task.children.length) {
      node.appendChild(toggle);
    }

    node.addEventListener("click", () => selectTask(task));

    graphNodes.appendChild(node);
  });

  applyTransform();
}

function selectTask(task) {
  state.selectedTaskId = task.id;
  let current = task.parent;
  while (current) {
    state.collapsed.delete(current.id);
    current = current.parent;
  }
  const lines = editor.value.split("\n");
  const targetLine = task.lineIndex;
  const caretPosition = lines.slice(0, targetLine).reduce((sum, line) => sum + line.length + 1, 0);
  editor.focus();
  editor.setSelectionRange(caretPosition, caretPosition);
  focusOnTask(task);
  renderGraph();
}

function focusOnTask(task) {
  const node = Array.from(graphNodes.children).find((child) =>
    child.querySelector("h4")?.textContent === task.name
  );
  if (!node) {
    return;
  }
  const rect = node.getBoundingClientRect();
  const canvasRect = graphCanvas.getBoundingClientRect();
  state.transform.x += canvasRect.width / 2 - (rect.left + rect.width / 2);
  state.transform.y += canvasRect.height / 2 - (rect.top + rect.height / 2);
  applyTransform();
}

function applyTransform() {
  const { x, y, scale } = state.transform;
  graphNodes.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  graphLines.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
}

function sync() {
  const { tasks, tags, people, lines, allTasks } = parseTasks(editor.value);
  state.tasks = tasks;
  state.allTasks = allTasks;
  state.tags = tags;
  state.people = people;
  highlightText(lines);
  buildTagPersonLists();
  renderGraph();
  updateSuggestions();
}

editor.addEventListener("scroll", () => {
  highlightLayer.scrollTop = editor.scrollTop;
  highlightLayer.scrollLeft = editor.scrollLeft;
});

editor.addEventListener("input", () => {
  sync();
});

editor.addEventListener("click", () => {
  updateSuggestions();
  const line = editor.value.slice(0, editor.selectionStart).split("\n").length - 1;
  const task = state.allTasks.find((t) => t.lineIndex === line);
  if (task) {
    state.selectedTaskId = task.id;
    focusOnTask(task);
    renderGraph();
  }
});

editor.addEventListener("keydown", (event) => {
  if (event.key === "Tab") {
    event.preventDefault();
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const value = editor.value;
    const selected = value.slice(start, end) || "";
    if (event.ctrlKey) {
      const updated = selected
        .split("\n")
        .map((line) => (line.startsWith("    ") ? line.slice(4) : line))
        .join("\n");
      editor.setRangeText(updated, start, end, "end");
    } else {
      const updated = selected
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n");
      editor.setRangeText(updated, start, end, "end");
    }
    sync();
  }

  if (event.key === "Enter") {
    event.preventDefault();
    const start = editor.selectionStart;
    const value = editor.value;
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    const currentLine = value.slice(lineStart, start);
    const indent = currentLine.match(/^\s*/)[0];
    editor.setRangeText(`\n${indent}`, start, start, "end");
    sync();
  }
});

editor.addEventListener("keyup", updateSuggestions);

searchInput.addEventListener("input", () => {
  state.searchQuery = searchInput.value;
  renderGraph();
});

[searchName, searchDescription, searchTag, searchPerson].forEach((checkbox) => {
  checkbox.addEventListener("change", () => renderGraph());
});

clearFilters.addEventListener("click", () => {
  state.selectedTags.clear();
  state.selectedPeople.clear();
  state.searchQuery = "";
  searchInput.value = "";
  renderGraph();
  buildTagPersonLists();
});

let isPanning = false;
let lastPoint = { x: 0, y: 0 };

graphCanvas.addEventListener("mousedown", (event) => {
  if (event.target.closest(".task-node")) {
    return;
  }
  isPanning = true;
  lastPoint = { x: event.clientX, y: event.clientY };
});

graphCanvas.addEventListener("mousemove", (event) => {
  if (!isPanning) {
    return;
  }
  state.transform.x += event.clientX - lastPoint.x;
  state.transform.y += event.clientY - lastPoint.y;
  lastPoint = { x: event.clientX, y: event.clientY };
  applyTransform();
});

graphCanvas.addEventListener("mouseup", () => {
  isPanning = false;
});

graphCanvas.addEventListener("mouseleave", () => {
  isPanning = false;
});

graphCanvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  const delta = event.deltaY > 0 ? -0.1 : 0.1;
  state.transform.scale = Math.min(1.6, Math.max(0.5, state.transform.scale + delta));
  applyTransform();
});

sync();
