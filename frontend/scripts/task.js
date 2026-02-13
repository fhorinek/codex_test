export function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function colorFromString(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return hslToHex(hue, 60, 52);
}

function hslToHex(hue, saturation, lightness) {
  const s = saturation / 100;
  const l = lightness / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const h = hue / 60;
  const x = c * (1 - Math.abs((h % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (h >= 0 && h < 1) {
    r = c;
    g = x;
  } else if (h < 2) {
    r = x;
    g = c;
  } else if (h < 3) {
    g = c;
    b = x;
  } else if (h < 4) {
    g = x;
    b = c;
  } else if (h < 5) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  const m = l - c / 2;
  const toHex = (channel) => Math.round((channel + m) * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

const JIRA_KEY_RE = /\[JIRA:([A-Z][A-Z0-9]+-\d+)\]/;
const JIRA_KEY_GLOBAL_RE = /\s*\[JIRA:[A-Z][A-Z0-9]+-\d+\]\s*/g;

export function parseJiraTitle(title) {
  const raw = typeof title === "string" ? title : "";
  const trimmed = raw.replace(/^%\s*/, "");
  const match = trimmed.match(JIRA_KEY_RE);
  if (!match) {
    return { key: null, title: trimmed.trim() };
  }
  const cleaned = trimmed
    .replace(JIRA_KEY_GLOBAL_RE, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return { key: match[1], title: cleaned };
}

export function applyInlineown(text) {
  return applyInlineMarkdownWithOptions(text);
}

export function applyInlineMarkdownWithOptions(text, options = {}) {
  let value = text;
  const { disableLinks = false } = options;
  const placeholders = [];
  const addPlaceholder = (content) => {
    const index = placeholders.push(content) - 1;
    return `@@INLINE_${index}@@`;
  };
  const buildLink = (label, href) => (
    disableLinks
      ? `<span class="inline-link">${label}</span>`
      : `<a href="${href}" target="_blank" rel="noopener">${label}</a>`
  );
  const buildUrlLink = (href) => (
    disableLinks
      ? `<span class="inline-link">${href}</span>`
      : `<a href="${href}" target="_blank" rel="noopener">${href}</a>`
  );
  value = value.replace(
    /(^|\s)(#[^\s#@]+)/g,
    "$1<span class=\"pill inline-pill\" data-type=\"tag\" data-value=\"$2\">$2</span>"
  );
  value = value.replace(
    /(^|\s)@([^\s#@]+)/g,
    "$1<span class=\"pill inline-pill\" data-type=\"person\" data-value=\"@$2\">👤 $2</span>"
  );
  value = value.replace(
    /\[JIRA:([A-Z][A-Z0-9]+-\d+)\]/g,
    "<span class=\"pill inline-pill jira-pill\" data-type=\"jira\" data-value=\"$1\">$1</span>"
  );
  value = value.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt, src) =>
    addPlaceholder(`<img alt="${alt}" src="${src}" />`)
  );
  value = value.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) =>
    addPlaceholder(buildLink(label, href))
  );
  value = value.replace(/(https?:\/\/[^\s<]+)/g, (_match, href) =>
    addPlaceholder(buildUrlLink(href))
  );
  value = value.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  value = value.replace(/__([^_]+)__/g, "<u>$1</u>");
  value = value.replace(/==([^=]+)==/g, "<mark>$1</mark>");
  value = value.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  value = value.replace(/\{([^}]+)\}/g, "<span class=\"references\" data-ref=\"$1\">$1</span>");
  value = value.replace(/@@INLINE_(\d+)@@/g, (_match, rawIndex) => {
    const index = Number.parseInt(rawIndex, 10);
    if (!Number.isFinite(index) || !placeholders[index]) {
      return "";
    }
    return placeholders[index];
  });
  return value;
}

export function renderMarkdown(text, options = {}) {
  const lines = escapeHtml(text).split("\n");
  const lineIndexes = Array.isArray(options.lineIndexes) ? options.lineIndexes : [];
  const disableLinks = Boolean(options.disableLinks);
  const baseIndent = Number.isFinite(options.baseIndent)
    ? Math.max(0, Number.parseInt(options.baseIndent, 10))
    : 0;
  let html = "";
  let inTable = false;
  const listStack = [];

  const openList = (nextType, startNumber = 1) => {
    if (nextType === "ol" && Number.isFinite(startNumber) && startNumber > 1) {
      html += `<ol start="${startNumber}">`;
    } else {
      html += `<${nextType}>`;
    }
    listStack.push({ type: nextType, liOpen: false });
  };

  const closeListItemAt = (index) => {
    const item = listStack[index];
    if (!item || !item.liOpen) {
      return;
    }
    html += "</li>";
    item.liOpen = false;
  };

  const closeDeepestList = () => {
    const lastIndex = listStack.length - 1;
    if (lastIndex < 0) {
      return;
    }
    const { type } = listStack[lastIndex];
    closeListItemAt(lastIndex);
    html += `</${type}>`;
    listStack.pop();
  };

  const closeAllLists = () => {
    while (listStack.length) {
      closeDeepestList();
    }
  };

  const renderListItem = ({ type, level, content, startNumber }) => {
    const safeLevel = Math.max(0, Number.parseInt(level, 10) || 0);
    const clampedLevel = Math.min(safeLevel, listStack.length);
    const targetDepth = clampedLevel + 1;

    while (listStack.length > targetDepth) {
      closeDeepestList();
    }

    if (listStack.length === targetDepth) {
      const current = listStack[listStack.length - 1];
      if (current && current.type !== type) {
        closeDeepestList();
        openList(type, startNumber);
      } else {
        closeListItemAt(listStack.length - 1);
      }
    } else if (listStack.length < targetDepth) {
      openList(type, startNumber);
    }

    if (!listStack.length) {
      openList(type, startNumber);
    }
    html += `<li>${applyInlineMarkdownWithOptions(content, { disableLinks })}`;
    listStack[listStack.length - 1].liOpen = true;
  };

  const closeTable = () => {
    if (inTable) {
      html += "</tbody></table>";
      inTable = false;
    }
  };

  const toCells = (line) =>
    line
      .split("|")
      .map((cell) => cell.trim())
      .filter((cell) => cell.length);

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    const nextLine = lines[index + 1]?.trim() || "";
    const isTableSeparator = /^\|?\s*[-:]+/.test(nextLine) && nextLine.includes("|");

    if (trimmed.includes("|") && isTableSeparator && !inTable) {
      closeAllLists();
      inTable = true;
      html += "<table><thead><tr>";
      toCells(line).forEach((cell) => {
        html += `<th>${applyInlineMarkdownWithOptions(cell, { disableLinks })}</th>`;
      });
      html += "</tr></thead><tbody>";
      return;
    }

    if (inTable) {
      if (!trimmed.includes("|") || trimmed === "") {
        closeTable();
      } else {
        // Skip the separator row inside table bodies.
        if (/^\|?\s*[-:]+/.test(trimmed)) {
          return;
        }
        const cells = toCells(line);
        if (cells.length) {
          html += "<tr>";
          cells.forEach((cell) => {
            html += `<td>${applyInlineMarkdownWithOptions(cell, { disableLinks })}</td>`;
          });
          html += "</tr>";
        }
        return;
      }
    }

    const checkboxMatch = trimmed.match(/^\[([ xX])\](?:\s+(.*))?$/);
    const unorderedListMatch = line.match(/^(\s*)[-*](?:\s+(.*))?$/);
    const orderedListMatch = line.match(/^(\s*)(\d+)\.(?:\s+(.*))?$/);

    if (checkboxMatch || unorderedListMatch || orderedListMatch) {
      closeTable();
      if (checkboxMatch) {
        closeAllLists();
        const checked = checkboxMatch[1].toLowerCase() === "x";
        const checkboxContent = checkboxMatch[2] || "";
        const lineIndex = Number.isFinite(lineIndexes[index])
          ? ` data-line="${lineIndexes[index]}"`
          : "";
        const renderedContent = checkboxContent
          ? ` ${applyInlineMarkdownWithOptions(checkboxContent, { disableLinks })}`
          : "";
        html += `<div class="checkbox-line" data-line="${lineIndexes[index] ?? ""}"><input type="checkbox"${lineIndex} ${checked ? "checked" : ""} />${renderedContent}</div>`;
      } else {
        const isOrdered = Boolean(orderedListMatch);
        const nextListType = isOrdered ? "ol" : "ul";
        const indentLength = isOrdered
          ? orderedListMatch[1].length
          : unorderedListMatch[1].length;
        const relativeIndent = Math.max(0, indentLength - baseIndent);
        const level = Math.floor(relativeIndent / 4);
        const content = (isOrdered ? orderedListMatch[3] : unorderedListMatch[2]) || "";
        const startNumber = isOrdered
          ? Number.parseInt(orderedListMatch[2], 10)
          : 1;
        renderListItem({
          type: nextListType,
          level,
          content,
          startNumber,
        });
      }
      return;
    }

    closeAllLists();
    closeTable();

    if (trimmed === "") {
      html += "<br />";
    } else {
      html += `<p>${applyInlineMarkdownWithOptions(trimmed, { disableLinks })}</p>`;
    }
  });

  closeAllLists();
  closeTable();
  return html;
}

function parseConfig(lines) {
  const config = {
    boardName: "Task Script",
    states: [
      { key: "todo", name: "TODO", color: "" },
      { key: "inprogress", name: "In progress", color: "" },
      { key: "done", name: "Done", color: "" },
    ],
    people: [],
    tags: [],
  };
  let index = 0;
  const headerLine = lines[index]?.trim();
  let statesOverridden = false;
  if (headerLine && !headerLine.startsWith("%") && headerLine.endsWith(":")) {
    config.boardName = headerLine.slice(0, -1).trim() || config.boardName;
    index += 1;
  }
  let currentSection = null;
  let currentEntry = null;
  for (; index < lines.length; index += 1) {
    const raw = lines[index];
    if (raw.trim() === "") {
      continue;
    }
    if (/^\s*%/.test(raw)) {
      break;
    }
    const indent = raw.match(/^\s*/)[0].length;
    const trimmed = raw.trim();
    if (indent === 4 && trimmed.endsWith(":")) {
      currentSection = trimmed.slice(0, -1).toLowerCase();
      if (currentSection === "states" && !statesOverridden) {
        config.states = [];
        statesOverridden = true;
      }
      currentEntry = null;
      continue;
    }
    if (indent === 8 && currentSection) {
      const match = trimmed.match(/^([^\s:]+)\s*:\s*(.*)?$/);
      const key = match ? match[1] : trimmed;
      const autoColor =
        currentSection === "tags" ||
          currentSection === "people" ||
          currentSection === "states"
          ? colorFromString(key)
          : "";
      const entry = { key, name: key, color: autoColor };
      if (match && match[2]) {
        entry.name = match[2].trim() || entry.name;
      }
      if (currentSection === "states") {
        config.states.push(entry);
      } else if (currentSection === "people") {
        config.people.push(entry);
      } else if (currentSection === "tags") {
        config.tags.push(entry);
      }
      currentEntry = entry;
      continue;
    }
    if (indent === 12 && currentEntry) {
      const propMatch = trimmed.match(/^([a-zA-Z]+)\s*:\s*(.*)$/);
      if (propMatch) {
        const prop = propMatch[1].toLowerCase();
        const value = propMatch[2].trim();
        if (prop === "name") {
          currentEntry.name = value || currentEntry.name;
        } else if (prop === "color") {
          currentEntry.color = value;
        }
      }
    }
  }
  return { config, startIndex: index };
}

export function parseTasks(text) {
  const lines = text.split("\n");
  const { config, startIndex } = parseConfig(lines);
  const tasks = [];
  const stack = [];
  let rootCounter = 0;
  let currentTask = null;
  const tags = new Set();
  const people = new Set();
  const states = new Set();
  const invalidStateTags = new Map();
  const tagMeta = new Map();
  const peopleMeta = new Map();
  const stateMeta = new Map();

  config.tags.forEach((tag) => {
    const value = `#${tag.key}`;
    tags.add(value);
    tagMeta.set(value, { ...tag, color: tag.color || colorFromString(tag.key) });
  });
  config.people.forEach((person) => {
    const value = `@${person.key}`;
    people.add(value);
    peopleMeta.set(value, { ...person, color: person.color || colorFromString(person.key) });
  });
  config.states.forEach((state) => {
    const value = `!${state.key}`;
    states.add(value);
    stateMeta.set(value, { ...state, color: state.color || colorFromString(state.key) });
  });

  lines.forEach((line, index) => {
    if (index < startIndex) {
      return;
    }
    const raw = line;
    const taskMatch = raw.match(/^(\s*)%\s+(.*)$/);
    if (taskMatch) {
      const indent = taskMatch[1].length;
      const depth = Math.floor(indent / 4);
      const rawName = taskMatch[2].trim();
      const parsedTitle = parseJiraTitle(rawName);
      const name = parsedTitle.title || "";
      const baseName = name || rawName || "task";
      const encodedName = encodeURIComponent(baseName);
      const task = {
        id: "",
        name,
        jiraKey: parsedTitle.key,
        depth,
        indent,
        parent: null,
        tags: [],
        people: [],
        state: null,
        description: [],
        descriptionLineIndexes: [],
        references: [],
        incomingReferenceCount: 0,
        incomingReferences: [],
        children: [],
        lineIndex: index,
      };
      if (depth === 0) {
        rootCounter += 1;
        task.id = `root/${rootCounter}-${encodedName}`;
        tasks.push(task);
        stack.length = 0;
        stack.push(task);
      } else {
        const parent = stack[depth - 1];
        if (parent) {
          parent._childSeq = (parent._childSeq || 0) + 1;
          task.id = `${parent.id}/${parent._childSeq}-${encodedName}`;
          parent.children.push(task);
          task.parent = parent;
        } else {
          rootCounter += 1;
          task.id = `root/${rootCounter}-${encodedName}`;
        }
        stack[depth] = task;
      }
      currentTask = task;
      return;
    }

    const descriptionLine = raw.replace(/\s+$/g, "");
    if (!currentTask || descriptionLine.trim() === "") {
      return;
    }
    currentTask.description.push(descriptionLine);
    currentTask.descriptionLineIndexes.push(index);
    const tagMatches = descriptionLine.matchAll(/(^|\s)(#[^\s#@]+)/g);
    for (const match of tagMatches) {
      const tag = match[2];
      if (tag && tag.length > 1) {
        currentTask.tags.push(tag);
        tags.add(tag);
        if (!tagMeta.has(tag)) {
          const key = tag.slice(1);
          tagMeta.set(tag, { key, name: key, color: colorFromString(key) });
        }
      }
    }
    const personMatches = descriptionLine.matchAll(/(^|\s)(@[^\s#@]+)/g);
    for (const match of personMatches) {
      const person = match[2];
      if (person && person.length > 1) {
        currentTask.people.push(person);
        people.add(person);
        if (!peopleMeta.has(person)) {
          const key = person.slice(1);
          peopleMeta.set(person, { key, name: key, color: colorFromString(key) });
        }
      }
    }
    const matches = descriptionLine.matchAll(/\{([^}]+)\}/g);
    for (const match of matches) {
      const reference = match[1].trim();
      if (reference) {
        currentTask.references.push(reference);
      }
    }
    const stateMatches = descriptionLine.matchAll(/(^|\s)(![^\s#@]+)/g);
    for (const match of stateMatches) {
      const stateTag = match[2];
      if (!stateTag || stateTag.length <= 1) {
        continue;
      }
      if (!currentTask.state) {
        currentTask.state = stateTag;
        states.add(stateTag);
        if (!stateMeta.has(stateTag)) {
          const key = stateTag.slice(1);
          stateMeta.set(stateTag, { key, name: key, color: colorFromString(key) });
        }
      } else {
        const lineInvalid = invalidStateTags.get(index) || [];
        lineInvalid.push(stateTag);
        invalidStateTags.set(index, lineInvalid);
      }
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

  const incomingReferenceTasksByName = new Map();
  allTasks.forEach((task) => {
    const uniqueReferences = new Set(
      task.references
        .map((reference) => (typeof reference === "string" ? reference.trim() : ""))
        .filter(Boolean)
    );
    uniqueReferences.forEach((key) => {
      const existing = incomingReferenceTasksByName.get(key);
      if (existing) {
        existing.push(task);
      } else {
        incomingReferenceTasksByName.set(key, [task]);
      }
    });
  });
  const incomingReferenceCountByName = new Map();
  incomingReferenceTasksByName.forEach((references, name) => {
    incomingReferenceCountByName.set(name, references.length);
  });
  allTasks.forEach((task) => {
    const key = typeof task.name === "string" ? task.name.trim() : "";
    task.incomingReferences = key ? [...(incomingReferenceTasksByName.get(key) || [])] : [];
    task.incomingReferenceCount = task.incomingReferences.length;
  });

  return {
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
    incomingReferenceCountByName,
  };
}
