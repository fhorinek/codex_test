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

export function buildKanban({
  state,
  dom,
  selectTask,
  matchesSearchTask,
  filtersActive,
  matchesFilters,
  updateTaskState,
}) {
  if (!dom.kanbanBoard) {
    return;
  }
  dom.kanbanBoard.innerHTML = "";
  const stateOrder = state.config?.states?.map((stateItem) => `!${stateItem.key}`) || [];
  const extraStates = Array.from(state.states)
    .filter((stateTag) => !stateOrder.includes(stateTag))
    .sort((a, b) => a.localeCompare(b));
  const states = [...stateOrder, ...extraStates];
  const tasksByState = new Map();
  states.forEach((stateTag) => tasksByState.set(stateTag, []));
  state.allTasks.forEach((task) => {
    if (task.state && tasksByState.has(task.state)) {
      tasksByState.get(task.state).push(task);
    }
  });
  states.forEach((stateTag) => {
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
    (tasksByState.get(stateTag) || []).forEach((task) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "kanban-card";
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
      card.addEventListener("click", () => selectTask(task));
      card.draggable = true;
      card.addEventListener("dragstart", (event) => {
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
        card._dragGhost = ghost;
      });
      card.addEventListener("dragend", () => {
        card.classList.remove("dragging");
        if (card._dragGhost) {
          card._dragGhost.remove();
          card._dragGhost = null;
        }
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
    dom.kanbanBoard.appendChild(column);
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
    if (line.trim() === "" || /^\s*%/.test(line)) {
      break;
    }
    end += 1;
  }
  const stateMatch = /(^|\s)![^\s#@]+(?=\s|$)/;
  const stateReplace = /(^|\s)![^\s#@]+(?=\s|$)/g;
  if (start === end) {
    if (newState) {
      if (start < lines.length && lines[start].trim() === "") {
        const blankIndent = splitIndent(lines[start]).indent || indent;
        lines[start] = `${blankIndent}${newState}`;
      } else {
        lines.splice(start, 0, `${indent}${newState}`);
      }
    }
  } else {
    for (let i = start; i < end; i += 1) {
      const { indent: lineIndent, content } = splitIndent(lines[i]);
      if (!stateMatch.test(content)) {
        continue;
      }
      const cleaned = normalizeContent(content.replace(stateReplace, "$1"));
      lines[i] = cleaned ? `${lineIndent}${cleaned}` : "";
    }
    if (newState) {
      if (lines[start].trim() === "") {
        const blankIndent = splitIndent(lines[start]).indent || indent;
        lines[start] = `${blankIndent}${newState}`;
      } else {
        lines[start] = prependTokenToLine(lines[start], newState);
      }
    } else {
      const allEmpty = lines.slice(start, end).every((line) => line.trim() === "");
      if (allEmpty) {
        lines.splice(start, end - start);
      }
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
    if (line.trim() === "" || /^\s*%/.test(line)) {
      break;
    }
    end += 1;
  }
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
    if (start < end) {
      lines[start] = insertTokenRespectState(lines[start], token);
    } else if (start < lines.length && lines[start].trim() === "") {
      const blankIndent = splitIndent(lines[start]).indent || indent;
      lines[start] = `${blankIndent}${token}`;
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
      if (lines[i].trim() === "") {
        emptyIndexes.push(i);
      }
    }
    for (let i = emptyIndexes.length - 1; i >= 0; i -= 1) {
      lines.splice(emptyIndexes[i], 1);
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
