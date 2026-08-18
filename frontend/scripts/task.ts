// @ts-check
/**
 * Module: Task parsing and task model helper utilities.
 */

import type { JiraTitleParseResult, ParsedTaskDocument, RenderMarkdownOptions } from "./types";
import {
  JIRA_MARKER_GLOBAL_RE,
  JIRA_MARKER_RE,
  findStoryPoints,
  iterPersonTokenMatches,
  iterReferenceMatches,
  iterStateTokenMatches,
  iterTagTokenMatches,
  normalizeConfiguredColorValue,
} from "./taskTokens.js";

// Defines the InlineMarkdownOptions type structure for this module.
type InlineMarkdownOptions = { disableLinks?: boolean };
// Defines the MarkdownListType type structure for this module.
type MarkdownListType = "ol" | "ul";
// Defines the MarkdownListStackItem type structure for this module.
type MarkdownListStackItem = { type: MarkdownListType; liOpen: boolean };
// Defines the MarkdownListItemRenderArgs type structure for this module.
type MarkdownListItemRenderArgs = {
  type: MarkdownListType;
  level: number | string;
  content: string;
  startNumber: number;
};
// Defines the ParsedConfigEntry type structure for this module.
type ParsedConfigEntry = {
  key: string;
  name: string;
  color: string;
  email?: string;
  jiraState?: string;
};
// Defines the ParsedConfigShape type structure for this module.
type ParsedConfigShape = {
  boardName: string;
  states: ParsedConfigEntry[];
  people: ParsedConfigEntry[];
  tags: ParsedConfigEntry[];
};
// Defines the ParsedTaskRecord type structure for this module.
type ParsedTaskRecord = {
  id: string;
  name: string;
  jiraKey: string | null;
  jiraToken?: string | null;
  archived: boolean;
  archivedByParent: boolean;
  depth: number;
  indent: number;
  parent: ParsedTaskRecord | null;
  tags: string[];
  people: string[];
  state: string | null;
  storyPoints: number | null;
  storyPointsSubtasksTotal: number;
  storyPointsTotal: number;
  description: string[];
  descriptionLineIndexes: number[];
  references: string[];
  incomingReferenceCount: number;
  incomingReferences: ParsedTaskRecord[];
  children: ParsedTaskRecord[];
  lineIndex: number;
  _childSeq?: number;
};

/**
 * @param {string} value
 * @returns {string}
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * @param {string} value
 * @returns {string}
 */
export function colorFromString(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return hslToHex(hue, 60, 52);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
/**
 * @param {number} hue
 * @param {number} saturation
 * @param {number} lightness
 * @returns {string}
 */
function hslToHex(hue: number, saturation: number, lightness: number): string {
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
  const toHex = (channel: number): string => Math.round((channel + m) * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * @param {string} title
 * @returns {JiraTitleParseResult}
 */
export function parseJiraTitle(title: string): JiraTitleParseResult {
  const raw = typeof title === "string" ? title : "";
  const trimmed = raw.replace(/^%\s*/, "");
  const match = trimmed.match(JIRA_MARKER_RE);
  if (!match) {
    return { key: null, token: null, title: trimmed.trim() };
  }
  const value = (match[1] ?? "").trim().toUpperCase();
  const cleaned = trimmed
    .replace(JIRA_MARKER_GLOBAL_RE, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return {
    key: /-\d+$/.test(value) ? value : null,
    token: value || null,
    title: cleaned,
  };
}

/**
 * @param {string} text
 * @returns {string}
 */
export function applyInlineown(text: string): string {
  return applyInlineMarkdownWithOptions(text);
}

/**
 * @param {string} text
 * @param {InlineMarkdownOptions} [options]
 * @returns {string}
 */
export function applyInlineMarkdownWithOptions(text: string, options: InlineMarkdownOptions = {}) {
  let value = text;
  const { disableLinks = false } = options;
  const placeholders: string[] = [];
  const addPlaceholder = (content: string): string => {
    const index = placeholders.push(content) - 1;
    return `@@INLINE_${index}@@`;
  };
  const buildLink = (label: string, href: string): string => (
    disableLinks
      ? `<span class="inline-link">${label}</span>`
      : `<a href="${href}" target="_blank" rel="noopener">${label}</a>`
  );
  const buildUrlLink = (href: string): string => (
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
    /\[([A-Z][A-Z0-9]+(?:-\d+)?)\]/g,
    "<span class=\"pill inline-pill jira-pill\" data-type=\"jira\" data-value=\"$1\">$1</span>"
  );
  value = value.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match: string, alt: string, src: string) =>
    addPlaceholder(`<img alt="${alt}" src="${src}" />`)
  );
  value = value.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match: string, label: string, href: string) =>
    addPlaceholder(buildLink(label, href))
  );
  value = value.replace(/(https?:\/\/[^\s<]+)/g, (_match: string, href: string) =>
    addPlaceholder(buildUrlLink(href))
  );
  value = value.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  value = value.replace(/__([^_]+)__/g, "<u>$1</u>");
  value = value.replace(/==([^=]+)==/g, "<mark>$1</mark>");
  value = value.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  value = value.replace(/\{([^}]+)\}/g, "<span class=\"references\" data-ref=\"$1\">$1</span>");
  value = value.replace(/@@INLINE_(\d+)@@/g, (_match: string, rawIndex: string) => {
    const index = Number.parseInt(rawIndex, 10);
    if (!Number.isFinite(index) || !placeholders[index]) {
      return "";
    }
    return placeholders[index];
  });
  return value;
}

/**
 * @param {string} text
 * @param {RenderMarkdownOptions} [options]
 * @returns {string}
 */
export function renderMarkdown(text: string, options: RenderMarkdownOptions = {}) {
  const lines = escapeHtml(text).split("\n");
  const lineIndexes = Array.isArray(options.lineIndexes) ? options.lineIndexes : [];
  const disableLinks = Boolean(options.disableLinks);
  const rawBaseIndent = options.baseIndent;
  const baseIndent = typeof rawBaseIndent === "number" && Number.isFinite(rawBaseIndent)
    ? Math.max(0, Math.trunc(rawBaseIndent))
    : 0;
  let html = "";
  let inTable = false;
  const listStack: MarkdownListStackItem[] = [];

  const openList = (nextType: MarkdownListType, startNumber = 1): void => {
    if (nextType === "ol" && Number.isFinite(startNumber) && startNumber > 1) {
      html += `<ol start="${startNumber}">`;
    } else {
      html += `<${nextType}>`;
    }
    listStack.push({ type: nextType, liOpen: false });
  };

  const closeListItemAt = (index: number): void => {
    const item = listStack[index];
    if (!item || !item.liOpen) {
      return;
    }
    html += "</li>";
    item.liOpen = false;
  };

  const closeDeepestList = (): void => {
    const lastIndex = listStack.length - 1;
    if (lastIndex < 0) {
      return;
    }
    const lastItem = listStack[lastIndex];
    if (!lastItem) {
      return;
    }
    const { type } = lastItem;
    closeListItemAt(lastIndex);
    html += `</${type}>`;
    listStack.pop();
  };

  const closeAllLists = (): void => {
    while (listStack.length) {
      closeDeepestList();
    }
  };

  const renderListItem = ({ type, level, content, startNumber }: MarkdownListItemRenderArgs): void => {
    const numericLevel = typeof level === "number" ? level : Number.parseInt(level, 10);
    const safeLevel = Math.max(0, numericLevel || 0);
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
    const deepest = listStack[listStack.length - 1];
    if (deepest) {
      deepest.liOpen = true;
    }
  };

  const closeTable = (): void => {
    if (inTable) {
      html += "</tbody></table>";
      inTable = false;
    }
  };

  const toCells = (line: string): string[] =>
    line
      .split("|")
      .map((cell: string) => cell.trim())
      .filter((cell: string) => cell.length > 0);

  lines.forEach((line: string, index: number) => {
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
        const checked = (checkboxMatch[1] ?? "").toLowerCase() === "x";
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
        const orderedIndent = orderedListMatch?.[1] ?? "";
        const unorderedIndent = unorderedListMatch?.[1] ?? "";
        const indentLength = isOrdered
          ? orderedIndent.length
          : unorderedIndent.length;
        const relativeIndent = Math.max(0, indentLength - baseIndent);
        const level = Math.floor(relativeIndent / 4);
        const orderedContent = orderedListMatch?.[3] ?? "";
        const unorderedContent = unorderedListMatch?.[2] ?? "";
        const content = (isOrdered ? orderedContent : unorderedContent) || "";
        const startNumber = isOrdered
          ? Number.parseInt(orderedListMatch?.[2] ?? "1", 10)
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

/**
 * Handles the parseConfig function logic.
 * Input: lines: string[].
 * Output: result produced by this function.
 */
function parseConfig(lines: string[]): { config: ParsedConfigShape; startIndex: number } {
  const config: ParsedConfigShape = {
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
  let currentSection: "states" | "people" | "tags" | null = null;
  let currentEntry: ParsedConfigEntry | null = null;
  for (; index < lines.length; index += 1) {
    const raw = lines[index] || "";
    if (raw.trim() === "") {
      continue;
    }
    if (/^\s*%/.test(raw)) {
      break;
    }
    const indent = raw.match(/^\s*/)?.[0].length || 0;
    const trimmed = raw.trim();
    if (indent === 4 && trimmed.endsWith(":")) {
      const nextSection = trimmed.slice(0, -1).toLowerCase();
      currentSection = (
        nextSection === "states" || nextSection === "people" || nextSection === "tags"
      )
        ? nextSection
        : null;
      if (currentSection === "states" && !statesOverridden) {
        config.states = [];
        statesOverridden = true;
      }
      currentEntry = null;
      continue;
    }
    if (indent === 8 && currentSection) {
      const match = trimmed.match(/^([^\s:]+)\s*:\s*(.*)?$/);
      const key = (match?.[1] || trimmed).trim();
      const entry: ParsedConfigEntry = { key, name: key, color: "" };
      if (currentSection === "people") {
        entry.email = "";
      }
      if (currentSection === "states") {
        entry.jiraState = "";
      }
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
      const propMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
      if (propMatch) {
        const prop = (propMatch[1] || "").toLowerCase();
        const propKey = prop.replace(/[_-]/g, "");
        const value = (propMatch[2] || "").trim();
        if (propKey === "name") {
          currentEntry.name = value || currentEntry.name;
        } else if (propKey === "color") {
          currentEntry.color = normalizeConfiguredColorValue(value);
        } else if ((propKey === "email" || propKey === "mail") && currentSection === "people") {
          currentEntry.email = value;
        } else if (
          (propKey === "jirastate" || propKey === "jira")
          && currentSection === "states"
        ) {
          currentEntry.jiraState = value;
        }
      }
    }
  }
  return { config, startIndex: index };
}

/**
 * Handles the parseTasks function logic.
 * Input: text: string.
 * Output: ParsedTaskDocument.
 */
export function parseTasks(text: string): ParsedTaskDocument {
  const lines = text.split("\n");
  const { config, startIndex } = parseConfig(lines);
  const tasks: ParsedTaskRecord[] = [];
  const stack: Array<{ indent: number; task: ParsedTaskRecord }> = [];
  let rootCounter = 0;
  let currentTask: ParsedTaskRecord | null = null;
  const tags = new Set<string>();
  const people = new Set<string>();
  const states = new Set<string>();
  const invalidStateTags = new Map<number, string[]>();
  const tagMeta = new Map<string, any>();
  const peopleMeta = new Map<string, any>();
  const stateMeta = new Map<string, any>();
  config.tags.forEach((tag: ParsedConfigEntry) => {
    const value = `#${tag.key}`;
    tags.add(value);
    tagMeta.set(value, { ...tag, color: tag.color || colorFromString(tag.key) });
  });
  config.people.forEach((person: ParsedConfigEntry) => {
    const value = `@${person.key}`;
    people.add(value);
    peopleMeta.set(value, { ...person, color: person.color || colorFromString(person.key) });
  });
  config.states.forEach((state: ParsedConfigEntry) => {
    const value = `!${state.key}`;
    states.add(value);
    stateMeta.set(value, { ...state, color: state.color || colorFromString(state.key) });
  });

  lines.forEach((line: string, index: number) => {
    if (index < startIndex) {
      return;
    }
    const raw = line;
    const taskMatch = raw.match(/^(\s*)%(\.)?\s+(.*)$/);
    if (taskMatch) {
      const indent = (taskMatch[1] ?? "").length;
      const ownArchived = Boolean(taskMatch[2]);
      let lastStackEntry = stack.length ? stack[stack.length - 1] : null;
      while (lastStackEntry && lastStackEntry.indent >= indent) {
        stack.pop();
        lastStackEntry = stack.length ? stack[stack.length - 1] : null;
      }
      const parentEntry = stack.length ? stack[stack.length - 1] : null;
      const depth = parentEntry ? parentEntry.task.depth + 1 : 0;
      const parentArchived = Boolean(parentEntry?.task?.archived);
      const rawName = (taskMatch[3] ?? "").trim();
      const parsedTitle = parseJiraTitle(rawName);
      const name = parsedTitle.title || "";
      const baseName = name || rawName || "task";
      const encodedName = encodeURIComponent(baseName);
      const task: ParsedTaskRecord = {
        id: "",
        name,
        jiraKey: parsedTitle.key,
        jiraToken: parsedTitle.token,
        archived: ownArchived || parentArchived,
        archivedByParent: parentArchived,
        depth,
        indent,
        parent: null,
        tags: [],
        people: [],
        state: null,
        storyPoints: null,
        storyPointsSubtasksTotal: 0,
        storyPointsTotal: 0,
        description: [],
        descriptionLineIndexes: [],
        references: [],
        incomingReferenceCount: 0,
        incomingReferences: [],
        children: [],
        lineIndex: index,
      };
      if (!parentEntry) {
        rootCounter += 1;
        task.id = `root/${rootCounter}-${encodedName}`;
        tasks.push(task);
      } else {
        const parent = parentEntry.task;
        parent._childSeq = (parent._childSeq || 0) + 1;
        task.id = `${parent.id}/${parent._childSeq}-${encodedName}`;
        parent.children.push(task);
        task.parent = parent;
      }
      stack.push({ indent, task });
      currentTask = task;
      return;
    }

    const descriptionLine = raw.replace(/\s+$/g, "");
    if (!currentTask || descriptionLine.trim() === "") {
      return;
    }
    currentTask.description.push(descriptionLine);
    currentTask.descriptionLineIndexes.push(index);
    const tagMatches = iterTagTokenMatches(descriptionLine);
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
    const personMatches = iterPersonTokenMatches(descriptionLine);
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
    const matches = iterReferenceMatches(descriptionLine);
    for (const match of matches) {
      const reference = (match[1] || "").trim();
      if (reference) {
        currentTask.references.push(reference);
      }
    }
    const stateMatches = iterStateTokenMatches(descriptionLine);
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
    if (currentTask.storyPoints === null) {
      const parsedPoints = findStoryPoints(descriptionLine);
      if (parsedPoints !== null) {
        currentTask.storyPoints = parsedPoints;
      }
    }
  });

  const allTasks: ParsedTaskRecord[] = [];
  const collect = (items: ParsedTaskRecord[]): void => {
    items.forEach((task: ParsedTaskRecord) => {
      allTasks.push(task);
      if (task.children.length) {
        collect(task.children);
      }
    });
  };
  collect(tasks);

  const computeStoryPointsTotal = (task: ParsedTaskRecord): number => {
    const ownPoints = typeof task.storyPoints === "number" && Number.isFinite(task.storyPoints)
      ? task.storyPoints
      : 0;
    let subtaskPoints = 0;
    task.children.forEach((child: ParsedTaskRecord) => {
      subtaskPoints += computeStoryPointsTotal(child);
    });
    task.storyPointsSubtasksTotal = subtaskPoints;
    task.storyPointsTotal = ownPoints + subtaskPoints;
    return task.storyPointsTotal;
  };
  tasks.forEach((task: ParsedTaskRecord) => {
    computeStoryPointsTotal(task);
  });
  const totalStoryPoints = tasks.reduce(
    (sum, task) => sum + (Number.isFinite(task.storyPointsTotal) ? task.storyPointsTotal : 0),
    0
  );

  const incomingReferenceTasksByName = new Map<string, ParsedTaskRecord[]>();
  allTasks.forEach((task: ParsedTaskRecord) => {
    const uniqueReferences = new Set<string>(
      task.references
        .map((reference: string) => (typeof reference === "string" ? reference.trim() : ""))
        .filter((reference: string) => Boolean(reference))
    );
    uniqueReferences.forEach((key: string) => {
      const existing = incomingReferenceTasksByName.get(key);
      if (existing) {
        existing.push(task);
      } else {
        incomingReferenceTasksByName.set(key, [task]);
      }
    });
  });
  const incomingReferenceCountByName = new Map<string, number>();
  incomingReferenceTasksByName.forEach((references: ParsedTaskRecord[], name: string) => {
    incomingReferenceCountByName.set(name, references.length);
  });
  allTasks.forEach((task: ParsedTaskRecord) => {
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
    totalStoryPoints,
  };
}
