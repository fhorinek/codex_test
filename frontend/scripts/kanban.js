import { splitIndent, normalizeContent, prependTokenToLine } from "./formatter.js";

function lightenColor(color, amount = 0.4) {
  const hex = color.replace("#", "");
  if (hex.length !== 6) {
    return color;
  }
  const num = parseInt(hex, 16);
  const r = (num >> 16) & 0xff;
  const g = (num >> 8) & 0xff;
  const b = num & 0xff;
  const mix = (channel) => Math.min(255, Math.round(channel + (255 - channel) * amount));
  const toHex = (channel) => channel.toString(16).padStart(2, "0");
  return `#${toHex(mix(r))}${toHex(mix(g))}${toHex(mix(b))}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function insertTokenRespectState(line, token) {
  const { indent, content } = splitIndent(line);
  const trimmed = content.trim();
  if (!trimmed) {
    return `${indent}${token}`;
  }
  const stateMatch = trimmed.match(/(^|\s)(![^\s#@]+)/);
  if (stateMatch) {
    const stateToken = stateMatch[2];
    const rest = normalizeContent(
      trimmed.replace(/(^|\s)![^\s#@]+(?=\s|$)/g, "$1")
    );
    const combined = rest ? `${stateToken} ${token} ${rest}` : `${stateToken} ${token}`;
    return `${indent}${normalizeContent(combined)}`;
  }
  return `${indent}${normalizeContent(`${token} ${trimmed}`)}`;
}

function findFirstNonEmptyLine(lines, start, end) {
  for (let i = start; i < end; i += 1) {
    if (lines[i].trim() !== "") {
      return i;
    }
  }
  return -1;
}

function lineHasTokens(line) {
  const { content } = splitIndent(line);
  return /(^|\s)([#@!][^\s#@]+)/.test(content);
}

function removeLeadingBlankLines(lines, start, end) {
  let currentEnd = end;
  while (start < currentEnd && lines[start].trim() === "") {
    lines.splice(start, 1);
    currentEnd -= 1;
  }
  return currentEnd;
}

const UNASSIGNED_GROUP = "__unassigned__";
let lastKanbanClickAt = 0;
let lastKanbanClickId = "";

function normalizeGroupBy(value) {
  return value === "person" || value === "tag" ? value : "none";
}

function uniqueTokens(tokens) {
  return Array.from(new Set(tokens));
}

function getGroupTokens(state, groupBy) {
  if (groupBy === "person") {
    const order = state.config?.people?.map((person) => `@${person.key}`) || [];
    const extras = Array.from(state.people)
      .filter((person) => !order.includes(person))
      .sort((a, b) => a.localeCompare(b));
    return [...order, ...extras];
  }
  if (groupBy === "tag") {
    const order = state.config?.tags?.map((tag) => `#${tag.key}`) || [];
    const extras = Array.from(state.tags)
      .filter((tag) => !order.includes(tag))
      .sort((a, b) => a.localeCompare(b));
    return [...order, ...extras];
  }
  return [];
}

function getGroupMeta(state, groupBy, token) {
  if (groupBy === "person") {
    return state.peopleMeta?.get(token);
  }
  if (groupBy === "tag") {
    return state.tagMeta?.get(token);
  }
  return null;
}

function getGroupLabel(groupBy, token, meta) {
  if (token === UNASSIGNED_GROUP) {
    return groupBy === "person" ? "Unassigned" : "No tag";
  }
  const fallback = token.replace(/^[@#]/, "");
  if (groupBy === "person") {
    return `👤 ${meta?.name || fallback}`;
  }
  if (groupBy === "tag") {
    return `#${meta?.name || fallback}`;
  }
  return fallback;
}

function getTaskGroupKeys(task, groupBy) {
  if (groupBy === "person") {
    const people = uniqueTokens(task.people || []);
    return people.length ? people : [UNASSIGNED_GROUP];
  }
  if (groupBy === "tag") {
    const tags = uniqueTokens(task.tags || []);
    return tags.length ? tags : [UNASSIGNED_GROUP];
  }
  return [UNASSIGNED_GROUP];
}

function renderKanbanCardContent({
  card,
  task,
  state,
  matchesSearchTask,
  filtersActive,
  matchesFilters,
}) {
  const wasDragging = card.classList.contains("dragging");
  card.className = "kanban-card";
  if (wasDragging) {
    card.classList.add("dragging");
  }
  card.dataset.taskId = task.id;
  card.setAttribute("aria-current", "false");
  if (state.selectedTaskId === task.id) {
    card.classList.add("selected");
    card.setAttribute("aria-current", "true");
  } else {
    card.removeAttribute("aria-current");
  }
  card.style.borderColor = "";
  card.innerHTML = "";

  const titleNode = document.createElement("div");
  titleNode.className = "kanban-card-title";
  titleNode.textContent = task.name;
  card.appendChild(titleNode);
  const metaWrap = document.createElement("div");
  metaWrap.className = "kanban-card-meta";
  let hasMeta = false;
  if (task.people.length) {
    const person = task.people[0];
    const meta = state.peopleMeta?.get(person);
    const pill = document.createElement("span");
    pill.className = "pill kanban-person";
    pill.textContent = `👤 ${meta?.name || person.replace("@", "")}`;
    if (meta?.color) {
      pill.style.borderColor = meta.color;
    }
    metaWrap.appendChild(pill);
    hasMeta = true;
  }
  if (task.tags.length) {
    const seenTags = new Set();
    task.tags.forEach((tag) => {
      if (seenTags.has(tag)) {
        return;
      }
      seenTags.add(tag);
      const meta = state.tagMeta?.get(tag);
      const pill = document.createElement("span");
      pill.className = "pill kanban-tag";
      pill.textContent = `#${meta?.name || tag.replace("#", "")}`;
      if (meta?.color) {
        pill.style.borderColor = meta.color;
      }
      metaWrap.appendChild(pill);
      hasMeta = true;
    });
  }
  if (hasMeta) {
    card.appendChild(metaWrap);
  }
  if (matchesSearchTask(task)) {
    card.classList.add("kanban-search");
  }
  if (filtersActive() && !matchesFilters(task)) {
    card.classList.add("kanban-hidden");
  }
  if (task.state) {
    const color = state.stateMeta?.get(task.state)?.color;
    if (color) {
      card.style.borderColor = lightenColor(color, 0.5);
    }
  }
}

function bindKanbanCard({ card, state, selectTask, onEditTask, getTaskById }) {
  if (card.dataset.bound) {
    return;
  }
  card.dataset.bound = "true";
  card.draggable = true;
  card.addEventListener("click", () => {
    const task = getTaskById(card.dataset.taskId);
    if (task) {
      selectTask(task);
      const now = performance.now();
      if (lastKanbanClickId === task.id && now - lastKanbanClickAt < 320) {
        if (onEditTask) {
          onEditTask(task);
        }
        lastKanbanClickAt = 0;
        lastKanbanClickId = "";
      } else {
        lastKanbanClickAt = now;
        lastKanbanClickId = task.id;
      }
    }
  });
  card.addEventListener("dblclick", () => {
    if (!onEditTask) {
      return;
    }
    const task = getTaskById(card.dataset.taskId);
    if (task) {
      onEditTask(task);
    }
  });
  card.addEventListener("dragstart", (event) => {
    const task = getTaskById(card.dataset.taskId);
    if (!task) {
      return;
    }
    const rect = card.getBoundingClientRect();
    const ghost = card.cloneNode(true);
    ghost.classList.add("drag-ghost");
    ghost.style.position = "absolute";
    ghost.style.top = "-9999px";
    ghost.style.left = "-9999px";
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    document.body.appendChild(ghost);
    event.dataTransfer.setDragImage(
      ghost,
      ghost.offsetWidth / 2,
      ghost.offsetHeight / 2
    );
    card.classList.add("dragging");
    event.dataTransfer.setData("text/plain", task.id);
    event.dataTransfer.setData(
      "application/json",
      JSON.stringify({
        type: "task",
        source: "kanban",
        taskId: task.id,
      })
    );
    window.dispatchEvent(new CustomEvent("taskdragstart"));
    card._dragGhost = ghost;
  });
  card.addEventListener("dragend", () => {
    card.classList.remove("dragging");
    if (card._dragGhost) {
      card._dragGhost.remove();
      card._dragGhost = null;
    }
    window.dispatchEvent(new CustomEvent("taskdragend"));
  });
}

function createKanbanColumn({
  state,
  stateTag,
  tasks,
  selectTask,
  onEditTask,
  matchesSearchTask,
  filtersActive,
  matchesFilters,
  updateTaskState,
  existingCards,
  getTaskById,
}) {
  const column = document.createElement("div");
  column.className = "kanban-column";
  column.dataset.stateTag = stateTag;
  const metaColor = state.stateMeta?.get(stateTag)?.color;
  if (metaColor) {
    column.style.borderColor = lightenColor(metaColor, 0.5);
  }
  const title = document.createElement("h3");
  title.textContent =
    state.stateMeta?.get(stateTag)?.name ||
    stateTag.replace(/^!/, "").replace(/^\w/, (char) => char.toUpperCase());
  column.appendChild(title);
  const list = document.createElement("div");
  list.className = "kanban-list";
  tasks.forEach((task) => {
    let card = existingCards?.get(task.id);
    if (!card) {
      card = document.createElement("button");
      card.type = "button";
    }
    renderKanbanCardContent({
      card,
      task,
      state,
      matchesSearchTask,
      filtersActive,
      matchesFilters,
    });
    bindKanbanCard({
      card,
      state,
      selectTask,
      onEditTask,
      getTaskById,
    });
    list.appendChild(card);
  });
  column.appendChild(list);
  column.addEventListener("dragover", (event) => {
    event.preventDefault();
    column.classList.add("drag-over");
  });
  column.addEventListener("dragleave", () => {
    column.classList.remove("drag-over");
  });
  column.addEventListener("drop", (event) => {
    event.preventDefault();
    column.classList.remove("drag-over");
    const taskId = event.dataTransfer.getData("text/plain");
    const task = state.allTasks.find((item) => item.id === taskId);
    if (!task) {
      return;
    }
    const nextState = column.dataset.stateTag;
    updateTaskState(task, nextState);
  });
  return column;
}

export function buildKanban({
  state,
  dom,
  selectTask,
  onEditTask,
  matchesSearchTask,
  filtersActive,
  matchesFilters,
  updateTaskState,
  groupBy = "none",
}) {
  if (!dom.kanbanBoard) {
    return;
  }
  const getTaskById = (taskId) =>
    state.allTasks.find((item) => item.id === taskId) || null;
  const normalizedGroupBy = normalizeGroupBy(groupBy);
  const reuseCards = normalizedGroupBy === "none";
  const existingCards = reuseCards ? new Map() : null;
  if (reuseCards) {
    dom.kanbanBoard
      .querySelectorAll(".kanban-card[data-task-id]")
      .forEach((card) => {
        existingCards.set(card.dataset.taskId, card);
      });
  }
  const content = dom.kanbanContent || dom.kanbanBoard;
  let groupFloat = null;
  if (content === dom.kanbanBoard) {
    groupFloat = dom.kanbanBoard.querySelector(".kanban-group-float");
    if (groupFloat) {
      groupFloat.remove();
    }
  }
  content.innerHTML = "";
  if (groupFloat) {
    content.appendChild(groupFloat);
  }
  dom.kanbanBoard.classList.toggle("kanban-grouped", normalizedGroupBy !== "none");
  const stateOrder = state.config?.states?.map((stateItem) => `!${stateItem.key}`) || [];
  const extraStates = Array.from(state.states)
    .filter((stateTag) => !stateOrder.includes(stateTag))
    .sort((a, b) => a.localeCompare(b));
  const states = [...stateOrder, ...extraStates];
  const stateSet = new Set(states);
  const filterEnabled = filtersActive();
  const shouldIncludeTask = (task) => !filterEnabled || matchesFilters(task);
  if (normalizedGroupBy === "none") {
    const tasksByState = new Map();
    states.forEach((stateTag) => tasksByState.set(stateTag, []));
    state.allTasks.forEach((task) => {
      if (task.state && tasksByState.has(task.state)) {
        if (!shouldIncludeTask(task)) {
          return;
        }
        tasksByState.get(task.state).push(task);
      }
    });
    states.forEach((stateTag) => {
      const column = createKanbanColumn({
        state,
        stateTag,
        tasks: tasksByState.get(stateTag) || [],
        selectTask,
        onEditTask,
        matchesSearchTask,
        filtersActive,
        matchesFilters,
        updateTaskState,
        existingCards,
        getTaskById,
      });
      content.appendChild(column);
    });
    return;
  }

  const groups = getGroupTokens(state, normalizedGroupBy).map((token) => {
    const meta = getGroupMeta(state, normalizedGroupBy, token);
    return {
      key: token,
      label: getGroupLabel(normalizedGroupBy, token, meta),
      color: meta?.color || "",
    };
  });

  const needsUnassigned = state.allTasks.some((task) => {
    if (!task.state || !stateSet.has(task.state)) {
      return false;
    }
    if (!shouldIncludeTask(task)) {
      return false;
    }
    if (normalizedGroupBy === "person") {
      return !task.people?.length;
    }
    if (normalizedGroupBy === "tag") {
      return !task.tags?.length;
    }
    return false;
  });
  if (needsUnassigned) {
    groups.push({
      key: UNASSIGNED_GROUP,
      label: getGroupLabel(normalizedGroupBy, UNASSIGNED_GROUP, null),
      color: "",
    });
  }

  const groupedTasks = new Map();
  groups.forEach((group) => {
    const byState = new Map();
    states.forEach((stateTag) => byState.set(stateTag, []));
    groupedTasks.set(group.key, byState);
  });

  state.allTasks.forEach((task) => {
    if (!task.state || !stateSet.has(task.state)) {
      return;
    }
    if (!shouldIncludeTask(task)) {
      return;
    }
    const groupKeys = getTaskGroupKeys(task, normalizedGroupBy);
    groupKeys.forEach((key) => {
      const groupBucket = groupedTasks.get(key);
      if (!groupBucket) {
        return;
      }
      groupBucket.get(task.state).push(task);
    });
  });

  const visibleGroups = groups.filter((group) => {
    const groupBucket = groupedTasks.get(group.key);
    if (!groupBucket) {
      return false;
    }
    for (const tasks of groupBucket.values()) {
      if (tasks.length) {
        return true;
      }
    }
    return false;
  });

  visibleGroups.forEach((group) => {
    const lane = document.createElement("div");
    lane.className = "kanban-lane";
    lane.dataset.groupKey = group.key;
    const header = document.createElement("div");
    header.className = "kanban-lane-header";
    const dot = document.createElement("span");
    dot.className = "kanban-lane-dot";
    if (group.color) {
      dot.style.background = group.color;
    } else {
      dot.classList.add("empty");
    }
    const title = document.createElement("span");
    title.textContent = group.label;
    header.appendChild(dot);
    header.appendChild(title);
    lane.appendChild(header);
    const columns = document.createElement("div");
    columns.className = "kanban-lane-columns";
    states.forEach((stateTag) => {
      const column = createKanbanColumn({
        state,
        stateTag,
        tasks: groupedTasks.get(group.key)?.get(stateTag) || [],
        selectTask,
        onEditTask,
        matchesSearchTask,
        filtersActive,
        matchesFilters,
        updateTaskState,
        existingCards: null,
        getTaskById,
      });
      columns.appendChild(column);
    });
    lane.appendChild(columns);
    content.appendChild(lane);
  });
}

export function updateTaskState({ task, newState, dom, sync, applyEditorValue }) {
  const lines = dom.editor.value.split("\n");
  const taskLine = lines[task.lineIndex] || "";
  const indentMatch = taskLine.match(/^(\s*)%/) || ["", ""];
  const indent = indentMatch[1] || "";
  let start = task.lineIndex + 1;
  let end = start;
  while (end < lines.length) {
    const line = lines[end];
    if (/^\s*%/.test(line)) {
      break;
    }
    end += 1;
  }
  const originalSlice = lines.slice(start, end);
  const stateMatch = /(^|\s)![^\s#@]+(?=\s|$)/;
  const stateReplace = /(^|\s)![^\s#@]+(?=\s|$)/g;
  if (start === end) {
    if (newState) {
      lines.splice(start, 0, `${indent}${newState}`, "");
    }
  } else {
    for (let i = start; i < end; i += 1) {
      if (lines[i].trim() === "") {
        continue;
      }
      const { indent: lineIndent, content } = splitIndent(lines[i]);
      if (stateMatch.test(content)) {
        const cleaned = normalizeContent(content.replace(stateReplace, "$1"));
        lines[i] = cleaned ? `${lineIndent}${cleaned}` : "";
      }
    }
    const emptyIndexes = [];
    for (let i = start; i < end; i += 1) {
      if (lines[i].trim() === "" && originalSlice[i - start].trim() !== "") {
        emptyIndexes.push(i);
      }
    }
    for (let i = emptyIndexes.length - 1; i >= 0; i -= 1) {
      lines.splice(emptyIndexes[i], 1);
      end -= 1;
    }
    if (newState) {
      const firstNonEmpty = findFirstNonEmptyLine(lines, start, end);
      if (firstNonEmpty === -1) {
        lines.splice(start, 0, `${indent}${newState}`, "");
      } else if (lineHasTokens(lines[firstNonEmpty])) {
        lines[firstNonEmpty] = prependTokenToLine(lines[firstNonEmpty], newState);
      } else if (lines[start].trim() === "") {
        lines[start] = `${indent}${newState}`;
      } else {
        lines.splice(start, 0, `${indent}${newState}`);
      }
    } else {
      end = removeLeadingBlankLines(lines, start, end);
    }
  }
  const nextValue = lines.join("\n");
  if (applyEditorValue) {
    applyEditorValue(nextValue);
  } else {
    dom.editor.value = nextValue;
  }
  sync();
}

export function updateTaskToken({ task, token, action, dom, sync, applyEditorValue }) {
  const lines = dom.editor.value.split("\n");
  const taskLine = lines[task.lineIndex] || "";
  const indentMatch = taskLine.match(/^(\s*)%/) || ["", ""];
  const indent = indentMatch[1] || "";
  let start = task.lineIndex + 1;
  let end = start;
  while (end < lines.length) {
    const line = lines[end];
    if (/^\s*%/.test(line)) {
      break;
    }
    end += 1;
  }
  const originalSlice = lines.slice(start, end);
  const tokenMatch = new RegExp(`(^|\\s)${escapeRegExp(token)}(?=\\s|$)`);
  const tokenReplace = new RegExp(`(^|\\s)${escapeRegExp(token)}(?=\\s|$)`, "g");
  const hasToken = lines
    .slice(start, end)
    .some((line) => tokenMatch.test(splitIndent(line).content));
  if (action === "add") {
    const stripToken = (line) => {
      const { indent: lineIndent, content } = splitIndent(line);
      if (!tokenMatch.test(content)) {
        return line;
      }
      const cleaned = normalizeContent(content.replace(tokenReplace, "$1"));
      return cleaned ? `${lineIndent}${cleaned}` : "";
    };
    if (hasToken) {
      for (let i = start; i < end; i += 1) {
        lines[i] = stripToken(lines[i]);
      }
    }
    const firstNonEmpty = findFirstNonEmptyLine(lines, start, end);
    if (firstNonEmpty === -1) {
      lines.splice(start, 0, `${indent}${token}`, "");
    } else if (lineHasTokens(lines[firstNonEmpty])) {
      lines[firstNonEmpty] = insertTokenRespectState(lines[firstNonEmpty], token);
    } else if (lines[start].trim() === "") {
      lines[start] = `${indent}${token}`;
    } else {
      lines.splice(start, 0, `${indent}${token}`);
    }
  } else if (action === "remove") {
    if (start === end) {
      return;
    }
    for (let i = start; i < end; i += 1) {
      const { indent: lineIndent, content } = splitIndent(lines[i]);
      if (!tokenMatch.test(content)) {
        continue;
      }
      const cleaned = normalizeContent(content.replace(tokenReplace, "$1"));
      lines[i] = cleaned ? `${lineIndent}${cleaned}` : "";
    }
    const emptyIndexes = [];
    for (let i = start; i < end; i += 1) {
      if (lines[i].trim() === "" && originalSlice[i - start].trim() !== "") {
        emptyIndexes.push(i);
      }
    }
    for (let i = emptyIndexes.length - 1; i >= 0; i -= 1) {
      lines.splice(emptyIndexes[i], 1);
    }
    removeLeadingBlankLines(lines, start, end);
  }
  const nextValue = lines.join("\n");
  if (applyEditorValue) {
    applyEditorValue(nextValue);
  } else {
    dom.editor.value = nextValue;
  }
  sync();
}
