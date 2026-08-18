// @ts-check

/**
 * Module: Task command parsing and command execution helpers.
 */

import { normalizeContent } from "./formatter.js";
import { parseJiraTitle } from "./task.js";

// Defines the TaskBlock type structure for this module.
type TaskBlock = { start: number; end: number; depth: number; indent: string };
// Defines the TaskBlockRange type structure for this module.
type TaskBlockRange = { start: number; end: number };
// Defines the ParsedTaskBody type structure for this module.
type ParsedTaskBody = {
  descriptionText: string;
  tags: string[];
  people: string[];
  state: string | null;
  storyPoints: number | null;
};
// Defines the TaskEditDraftTask type structure for this module.
type TaskEditDraftTask = {
  lineIndex?: number;
  name?: string;
  jiraKey?: string | null;
  jiraToken?: string | null;
  archived?: boolean;
};
// Defines the TaskEditDraft type structure for this module.
type TaskEditDraft = {
  range: { start: number; end: number };
  indent: string;
  jiraKey: string | null;
  title: string;
  bodyText: string;
};
// Defines the TaskCommandTask type structure for this module.
type TaskCommandTask = {
  id?: string | null;
  lineIndex?: number;
  parent?: TaskCommandTask | null;
};
// Defines the TaskCommandControllerOptions type structure for this module.
type TaskCommandControllerOptions = {
  /**
   * Handles the getEditorValue function logic.
   * Input: none.
   * Output: result produced by this function.
   */
  getEditorValue: () => string;
  /**
   * Handles the applyEditorValue function logic.
   * Input: value: string.
   * Output: result produced by this function.
   */
  applyEditorValue: (value: string) => void;
  /**
   * Handles the syncEditorState function logic.
   * Input: none.
   * Output: result produced by this function.
   */
  syncEditorState: () => void;
};
// Defines the SaveTaskEditParams type structure for this module.
type SaveTaskEditParams = {
  taskRange: { start: number; end: number } | null | undefined;
  rawTitle: string;
  bodyText: string;
  indent?: string;
  fallbackJiraKey?: string | null;
  creatingTask?: boolean;
};
// Defines the SaveTaskEditResult type structure for this module.
type SaveTaskEditResult =
  | { ok: true; title: string; lineIndex: number }
  | { ok: false; error: string };

/**
 * Handles the lineAt function logic.
 * Input: lines: string[], index: number.
 * Output: string.
 */
function lineAt(lines: string[], index: number): string {
  return lines[index] ?? "";
}

/**
 * Handles the buildTaskLineDepthMap function logic.
 * Input: lines: string[].
 * Output: Map<number, { depth: number; indent: string; indentLength: number }>.
 */
function buildTaskLineDepthMap(
  lines: string[]
): Map<number, { depth: number; indent: string; indentLength: number }> {
  const byLine = new Map<number, { depth: number; indent: string; indentLength: number }>();
  const stack: Array<{ depth: number; indentLength: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lineAt(lines, index);
    const match = line.match(/^(\s*)%/);
    if (!match) {
      continue;
    }
    const indent = match[1] || "";
    const indentLength = indent.length;
    let lastStackEntry = stack.length ? stack[stack.length - 1] : null;
    while (lastStackEntry && lastStackEntry.indentLength >= indentLength) {
      stack.pop();
      lastStackEntry = stack.length ? stack[stack.length - 1] : null;
    }
    const parentEntry = stack.length ? stack[stack.length - 1] : null;
    const depth = parentEntry ? parentEntry.depth + 1 : 0;
    byLine.set(index, { depth, indent, indentLength });
    stack.push({ depth, indentLength });
  }
  return byLine;
}

/**
 * Handles the escapeRegExp function logic.
 * Input: value: string.
 * Output: string.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Handles the parseTaskTitleFromLine function logic.
 * Input: line: string.
 * Output: string.
 */
export function parseTaskTitleFromLine(line: string): string {
  const raw = typeof line === "string" ? line : "";
  const match = raw.match(/^\s*%\.?\s*(.*)$/);
  if (!match) {
    return "";
  }
  const parsed = parseJiraTitle(match[1] ?? "");
  return parsed.title || "";
}

/**
 * Handles the renameTaskReferencesInLines function logic.
 * Input: lines: string[], oldTitle: string, newTitle: string.
 * Output: boolean.
 */
export function renameTaskReferencesInLines(lines: string[], oldTitle: string, newTitle: string): boolean {
  if (!Array.isArray(lines)) {
    return false;
  }
  const from = typeof oldTitle === "string" ? oldTitle.trim() : "";
  const to = typeof newTitle === "string" ? newTitle.trim() : "";
  if (!from || !to || from === to) {
    return false;
  }
  const refPattern = new RegExp(`\\{\\s*${escapeRegExp(from)}\\s*\\}`, "g");
  let changed = false;
  lines.forEach((line: string, index: number) => {
    const updated = (line || "").replace(refPattern, `{${to}}`);
    if (updated !== line) {
      lines[index] = updated;
      changed = true;
    }
  });
  return changed;
}

/**
 * Handles the insertTokenIntoBody function logic.
 * Input: text: string, token: string.
 * Output: string.
 */
export function insertTokenIntoBody(text: string, token: string): string {
  const tokenMatch = new RegExp(`(^|\\s)${escapeRegExp(token)}(?=\\s|$)`);
  if (tokenMatch.test(text)) {
    return text;
  }
  const lines = text.replace(/\r/g, "").split("\n");
  let targetIndex = lines.findIndex((line) => line.trim() !== "");
  if (targetIndex === -1) {
    return `${token}\n`;
  }
  const trimmed = lineAt(lines, targetIndex).trim();
  const hasTokenLine = /(^|\s)([#@!][^\s#@]+)/.test(trimmed);
  if (!hasTokenLine) {
    lines.splice(targetIndex, 0, token);
    return lines.join("\n");
  }
  const stateMatch = trimmed.match(/(^|\s)(![^\s#@]+)/);
  if (stateMatch) {
    const stateToken = stateMatch[2];
    const rest = normalizeContent(trimmed.replace(/(^|\s)![^\s#@]+(?=\s|$)/g, "$1"));
    lines[targetIndex] = rest ? `${stateToken} ${token} ${rest}` : `${stateToken} ${token}`;
  } else {
    lines[targetIndex] = normalizeContent(`${token} ${trimmed}`);
  }
  return lines.join("\n");
}

/**
 * Handles the insertStateIntoBody function logic.
 * Input: text: string, stateToken: string.
 * Output: string.
 */
export function insertStateIntoBody(text: string, stateToken: string): string {
  if (!stateToken) {
    return text;
  }
  const lines = text.replace(/\r/g, "").split("\n");
  const stateReplace = /(^|\s)![^\s#@]+(?=\s|$)/g;
  const cleaned = lines.map((line) => normalizeContent(line.replace(stateReplace, "$1")));
  let targetIndex = cleaned.findIndex((line) => line.trim() !== "");
  if (targetIndex === -1) {
    return `${stateToken}\n`;
  }
  const trimmed = lineAt(cleaned, targetIndex).trim();
  const hasTokenLine = /(^|\s)([#@!][^\s#@]+)/.test(trimmed);
  if (!hasTokenLine) {
    cleaned.splice(targetIndex, 0, stateToken);
    return cleaned.join("\n");
  }
  cleaned[targetIndex] = trimmed ? `${stateToken} ${trimmed}` : stateToken;
  return cleaned.join("\n");
}

/**
 * Handles the updateCheckboxInBody function logic.
 * Input: text: string, lineIndex: number, checked: boolean.
 * Output: string.
 */
export function updateCheckboxInBody(text: string, lineIndex: number, checked: boolean): string {
  const lines = text.replace(/\r/g, "").split("\n");
  if (!Number.isFinite(lineIndex) || lineIndex < 0 || lineIndex >= lines.length) {
    return text;
  }
  const line = lineAt(lines, lineIndex);
  const updated = line.replace(/^(\s*)\[[ xX]\](\s+|$)/, `$1[${checked ? "x" : " "}]$2`);
  if (updated === line) {
    return text;
  }
  lines[lineIndex] = updated;
  return lines.join("\n");
}

/**
 * Handles the removeTokenFromBody function logic.
 * Input: text: string, token: string.
 * Output: string.
 */
export function removeTokenFromBody(text: string, token: string): string {
  const tokenReplace = new RegExp(`(^|\\s)${escapeRegExp(token)}(?=\\s|$)`, "g");
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => normalizeContent(line.replace(tokenReplace, "$1")));
  while (lines.length && lineAt(lines, 0).trim() === "") {
    lines.shift();
  }
  return lines.join("\n");
}

/**
 * Handles the removeStateFromBody function logic.
 * Input: text: string.
 * Output: string.
 */
export function removeStateFromBody(text: string): string {
  const stateReplace = /(^|\s)![^\s#@]+(?=\s|$)/g;
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => normalizeContent(line.replace(stateReplace, "$1")));
  while (lines.length && lineAt(lines, 0).trim() === "") {
    lines.shift();
  }
  return lines.join("\n");
}

/**
 * Handles the adjustIndent function logic.
 * Input: line: string, deltaSpaces: number.
 * Output: string.
 */
export function adjustIndent(line: string, deltaSpaces: number): string {
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

/**
 * Handles the findTaskBlock function logic.
 * Input: lines: string[], lineIndex: number.
 * Output: TaskBlock | null.
 */
export function findTaskBlock(lines: string[], lineIndex: number): TaskBlock | null {
  const depthByLine = buildTaskLineDepthMap(lines);
  const taskLine = depthByLine.get(lineIndex);
  if (!taskLine) {
    return null;
  }
  const indent = taskLine.indent;
  const depth = taskLine.depth;
  let end = lineIndex + 1;
  while (end < lines.length) {
    const lineTask = depthByLine.get(end);
    if (lineTask && lineTask.depth <= depth) {
      break;
    }
    end += 1;
  }
  return { start: lineIndex, end, depth, indent };
}

/**
 * Handles the getTaskBlockRange function logic.
 * Input: lines: string[], lineIndex: number.
 * Output: TaskBlockRange.
 */
export function getTaskBlockRange(lines: string[], lineIndex: number): TaskBlockRange {
  let start = lineIndex;
  let end = lineIndex + 1;
  while (end < lines.length) {
    if (/^\s*%/.test(lineAt(lines, end))) {
      break;
    }
    end += 1;
  }
  return { start, end };
}

/**
 * Handles the parseTaskBody function logic.
 * Input: text: string.
 * Output: ParsedTaskBody.
 */
export function parseTaskBody(text: string): ParsedTaskBody {
  const lines = text.replace(/\r/g, "").split("\n");
  const tags = new Set<string>();
  const people = new Set<string>();
  /** @type {string | null} */
  let stateToken = null;
  /** @type {number | null} */
  let storyPoints = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lineAt(lines, i);
    let match;
    const tagRegex = /(^|\s)(#[^\s#@]+)/g;
    while ((match = tagRegex.exec(line)) !== null) {
      const tag = match[2] ?? "";
      if (tag) {
        tags.add(tag);
      }
    }
    const personRegex = /(^|\s)(@[^\s#@]+)/g;
    while ((match = personRegex.exec(line)) !== null) {
      const person = match[2] ?? "";
      if (person) {
        people.add(person);
      }
    }
    if (!stateToken) {
      const stateMatch = line.match(/(^|\s)(![^\s#@]+)/);
      if (stateMatch) {
        stateToken = stateMatch[2] ?? null;
      }
    }
    if (storyPoints === null) {
      const storyMatch = line.match(/(^|\s)~(\d+(?:\.\d+)?)(?=\s|$)/);
      if (storyMatch) {
        const parsedPoints = Number.parseFloat(storyMatch[2] ?? "");
        if (Number.isFinite(parsedPoints)) {
          storyPoints = parsedPoints;
        }
      }
    }
  }
  return {
    descriptionText: lines.join("\n"),
    tags: Array.from(tags),
    people: Array.from(people),
    state: stateToken,
    storyPoints,
  };
}

/**
 * Handles the buildTaskEditDraft function logic.
 * Input: lines: string[], task: TaskEditDraftTask | null | undefined.
 * Output: TaskEditDraft | null.
 */
export function buildTaskEditDraft(lines: string[], task: TaskEditDraftTask | null | undefined): TaskEditDraft | null {
  if (!Array.isArray(lines) || !task || !Number.isInteger(task.lineIndex)) {
    return null;
  }
  const lineIndex = typeof task.lineIndex === "number" ? task.lineIndex : -1;
  const { start, end } = getTaskBlockRange(lines, lineIndex);
  const taskLine = lineAt(lines, lineIndex);
  const indent = taskLine.match(/^\s*/)?.[0] || "";
  const parsedTitle = parseJiraTitle(task.name || "");
  const jiraKey = task.jiraToken || task.jiraKey || parsedTitle.token || parsedTitle.key || null;
  const title = task.name || parsedTitle.title || "";
  const bodyLines = lines
    .slice(lineIndex + 1, end)
    .map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line.trimStart()));
  return {
    range: { start, end },
    indent,
    jiraKey,
    title,
    bodyText: bodyLines.join("\n"),
  };
}

/**
 * Handles the getTaskCreateRange function logic.
 * Input: lines: string[].
 * Output: TaskBlockRange.
 */
export function getTaskCreateRange(lines: string[]): TaskBlockRange {
  if (!Array.isArray(lines) || !lines.length) {
    return { start: 0, end: 0 };
  }
  const lastNonEmptyIndex = lines
    .map((line, index) => ({ line, index }))
    .filter((entry) => entry.line.trim() !== "")
    .map((entry) => entry.index)
    .pop();
  if (!Number.isFinite(lastNonEmptyIndex)) {
    return { start: 0, end: lines.length };
  }
  const insertIndex = Math.max(0, (typeof lastNonEmptyIndex === "number" ? lastNonEmptyIndex : -1) + 1);
  if (insertIndex < lines.length) {
    return { start: insertIndex, end: insertIndex + 1 };
  }
  return { start: insertIndex, end: insertIndex };
}

/**
 * Handles the buildTaskCreateDraft function logic.
 * Input: lines: string[].
 * Output: TaskEditDraft.
 */
export function buildTaskCreateDraft(lines: string[]): TaskEditDraft {
  return {
    range: getTaskCreateRange(lines),
    indent: "",
    jiraKey: null,
    title: "",
    bodyText: "",
  };
}

/**
 * Handles the normalizeBoardNameInput function logic.
 * Input: value: string.
 * Output: string.
 */
export function normalizeBoardNameInput(value: string): string {
  const raw = typeof value === "string" ? value : "";
  const trimmed = raw.trim().replace(/:+\s*$/, "").trim();
  return trimmed || "Task Script";
}

/**
 * Handles the applyBoardNameToText function logic.
 * Input: sourceText: string, nextBoardName: string.
 * Output: string.
 */
export function applyBoardNameToText(sourceText: string, nextBoardName: string): string {
  const normalizedBoardName = normalizeBoardNameInput(nextBoardName);
  const headerLine = `${normalizedBoardName}:`;
  const lines = String(sourceText || "").replace(/\r/g, "").split("\n");
  const firstTrimmed = (lines[0] || "").trim();
  const hasExplicitHeader =
    Boolean(firstTrimmed)
    && !firstTrimmed.startsWith("%")
    && firstTrimmed.endsWith(":");
  if (hasExplicitHeader) {
    lines[0] = headerLine;
  } else {
    lines.unshift(headerLine);
  }
  return lines.join("\n");
}

/**
 * Handles the createTaskCommandController function logic.
 * Input: options: TaskCommandControllerOptions.
 * Output: result produced by this function.
 */
export function createTaskCommandController(options: TaskCommandControllerOptions) {
  const { getEditorValue, applyEditorValue, syncEditorState } = options;

  /**
   * Handles the moveTaskAsSubtask function logic.
   * Input: sourceTask: TaskCommandTask | null | undefined, targetTask: TaskCommandTask | null | undefined.
   * Output: void.
   */
  function moveTaskAsSubtask(sourceTask: TaskCommandTask | null | undefined, targetTask: TaskCommandTask | null | undefined): void {
    if (!sourceTask || !targetTask || sourceTask.id === targetTask.id) {
      return;
    }
    let targetIsDescendantOfSource = false;
    let current = targetTask.parent;
    while (current) {
      if (current.id === sourceTask.id) {
        targetIsDescendantOfSource = true;
        break;
      }
      current = current.parent || null;
    }
    const lines = getEditorValue().split("\n");
    const sourceLineIndex = typeof sourceTask.lineIndex === "number" ? sourceTask.lineIndex : -1;
    const targetLineIndex = typeof targetTask.lineIndex === "number" ? targetTask.lineIndex : -1;
    const sourceBlock = findTaskBlock(lines, sourceLineIndex);
    const targetBlock = findTaskBlock(lines, targetLineIndex);
    if (!sourceBlock || !targetBlock) {
      return;
    }
    if (targetIsDescendantOfSource) {
      if (targetBlock.start <= sourceBlock.start || targetBlock.end > sourceBlock.end) {
        return;
      }
      const sourceLines = lines.slice(sourceBlock.start, sourceBlock.end);
      const relStart = targetBlock.start - sourceBlock.start;
      const relEnd = targetBlock.end - sourceBlock.start;
      const targetLines = sourceLines.slice(relStart, relEnd);
      const sourceWithoutTargetLines = [
        ...sourceLines.slice(0, relStart),
        ...sourceLines.slice(relEnd),
      ];
      if (!targetLines.length || !sourceWithoutTargetLines.length) {
        return;
      }
      // Switch relation: promote the target child to the source depth, then
      // demote the source block (without that child) under the promoted target.
      const promoteDelta = (sourceBlock.depth - targetBlock.depth) * 4;
      const promotedTargetLines = targetLines.map((line: string) => adjustIndent(line, promoteDelta));
      const demotedSourceLines = sourceWithoutTargetLines.map((line: string) => adjustIndent(line, 4));
      lines.splice(
        sourceBlock.start,
        sourceBlock.end - sourceBlock.start,
        ...promotedTargetLines,
        ...demotedSourceLines
      );
      applyEditorValue(lines.join("\n"));
      syncEditorState();
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
    const adjustedLines = blockLines.map((line: string) => adjustIndent(line, indentDelta));
    lines.splice(insertIndex, 0, ...adjustedLines);
    applyEditorValue(lines.join("\n"));
    syncEditorState();
  }

  /**
   * @param {TaskCommandTask | null | undefined} sourceTask
   * @param {TaskCommandTask | null | undefined} targetTask
   * @param {"before" | "after"} position
   * @param {{ allowRootReparent?: boolean }} [optionsArg]
   * @returns {boolean}
   */
  function reorderTask(
    sourceTask: TaskCommandTask | null | undefined,
    targetTask: TaskCommandTask | null | undefined,
    position: "before" | "after",
    optionsArg: { allowRootReparent?: boolean } = {}
  ): boolean {
    if (
      !sourceTask ||
      !targetTask ||
      sourceTask.id === targetTask.id ||
      (position !== "before" && position !== "after")
    ) {
      return false;
    }
    const allowRootReparent = Boolean(optionsArg.allowRootReparent);
    const sourceParentId = sourceTask.parent?.id || null;
    const targetParentId = targetTask.parent?.id || null;
    const allowDifferentParent =
      allowRootReparent &&
      sourceParentId !== null &&
      targetParentId === null;
    if (sourceParentId !== targetParentId && !allowDifferentParent) {
      return false;
    }
    const lines = getEditorValue().split("\n");
    const sourceLineIndex = typeof sourceTask.lineIndex === "number" ? sourceTask.lineIndex : -1;
    const targetLineIndex = typeof targetTask.lineIndex === "number" ? targetTask.lineIndex : -1;
    const sourceBlock = findTaskBlock(lines, sourceLineIndex);
    const targetBlock = findTaskBlock(lines, targetLineIndex);
    if (!sourceBlock || !targetBlock) {
      return false;
    }
    const targetDepth = targetBlock.depth;
    if (sourceBlock.depth !== targetDepth && !allowDifferentParent) {
      return false;
    }
    if (targetBlock.start >= sourceBlock.start && targetBlock.start < sourceBlock.end) {
      return false;
    }
    const insertAt = position === "before" ? targetBlock.start : targetBlock.end;
    const blockLines = lines.slice(sourceBlock.start, sourceBlock.end);
    if (!blockLines.length) {
      return false;
    }
    const indentDelta = (targetDepth - sourceBlock.depth) * 4;
    const adjustedBlockLines = indentDelta
      ? blockLines.map((line: string) => adjustIndent(line, indentDelta))
      : blockLines;
    lines.splice(sourceBlock.start, sourceBlock.end - sourceBlock.start);
    let nextInsertAt = insertAt;
    if (sourceBlock.start < nextInsertAt) {
      nextInsertAt -= adjustedBlockLines.length;
    }
    const originalStart = sourceBlock.start;
    if (nextInsertAt === originalStart && indentDelta === 0) {
      return false;
    }
    lines.splice(nextInsertAt, 0, ...adjustedBlockLines);
    applyEditorValue(lines.join("\n"));
    syncEditorState();
    return true;
  }

  /**
   * Handles the toggleCheckboxAtLine function logic.
   * Input: lineIndex: number, checked: boolean | null = null.
   * Output: void.
   */
  function toggleCheckboxAtLine(lineIndex: number, checked: boolean | null = null): void {
    const lines = getEditorValue().split("\n");
    const line = lineAt(lines, lineIndex);
    if (!line) {
      return;
    }
    const match = line.match(/^(\s*\[)([ xX])(\])/);
    if (!match) {
      return;
    }
    const nextValue =
      checked === null
          ? (match[2] ?? "").toLowerCase() === "x"
          ? " "
          : "x"
        : checked
          ? "x"
          : " ";
    lines[lineIndex] = line.replace(/^(\s*\[)([ xX])(\])/, `$1${nextValue}$3`);
    applyEditorValue(lines.join("\n"));
    syncEditorState();
  }

  /**
   * Handles the deleteTaskAtLine function logic.
   * Input: lineIndex: number.
   * Output: number | null.
   */
  function deleteTaskAtLine(lineIndex: number): number | null {
    const lines = getEditorValue().split("\n");
    const block = findTaskBlock(lines, lineIndex);
    if (!block) {
      return null;
    }
    lines.splice(block.start, block.end - block.start);
    applyEditorValue(lines.join("\n"));
    syncEditorState();
    return Math.max(0, block.start - 1);
  }

  /**
   * Handles the deleteTaskKeepSubtasksAtLine function logic.
   * Input: lineIndex: number.
   * Output: number | null.
   */
  function deleteTaskKeepSubtasksAtLine(lineIndex: number): number | null {
    const lines = getEditorValue().split("\n");
    const depthByLine = buildTaskLineDepthMap(lines);
    const block = findTaskBlock(lines, lineIndex);
    if (!block) {
      return null;
    }
    const blockLines = lines.slice(block.start, block.end);
    if (blockLines.length <= 1) {
      lines.splice(block.start, block.end - block.start);
      applyEditorValue(lines.join("\n"));
      syncEditorState();
      return Math.max(0, block.start - 1);
    }

    /** @type {string[]} */
    const childBlocks = [];
    let index = block.start + 1;
    while (index < block.end) {
      const lineTask = depthByLine.get(index);
      if (lineTask && lineTask.depth === block.depth + 1) {
        const childBlock = findTaskBlock(lines, index);
        if (childBlock) {
          const childLines = lines
            .slice(childBlock.start, childBlock.end)
            .map((childLine: string) => adjustIndent(childLine, -4));
          childBlocks.push(...childLines);
          index = childBlock.end;
          continue;
        }
      }
      index += 1;
    }

    if (!childBlocks.length) {
      lines.splice(block.start, block.end - block.start);
    } else {
      lines.splice(block.start, block.end - block.start, ...childBlocks);
    }
    applyEditorValue(lines.join("\n"));
    syncEditorState();
    return Math.max(0, block.start - 1);
  }

  /**
   * Handles the saveTaskEdit function logic.
   * Input: params: SaveTaskEditParams.
   * Output: SaveTaskEditResult.
   */
  function saveTaskEdit(params: SaveTaskEditParams): SaveTaskEditResult {
    const {
      taskRange,
      rawTitle,
      bodyText,
      indent = "",
      fallbackJiraKey = "",
      creatingTask = false,
    } = params || {};
    if (!taskRange || !Number.isInteger(taskRange.start) || !Number.isInteger(taskRange.end)) {
      return { ok: false, error: "Missing task range." };
    }
    const parsedTitle = parseJiraTitle(typeof rawTitle === "string" ? rawTitle : "");
    const jiraKey = parsedTitle.token || parsedTitle.key || fallbackJiraKey || "";
    const title = parsedTitle.title || "";
    if (!title) {
      return { ok: false, error: "Title is required." };
    }
    const lines = getEditorValue().split("\n");
    const currentTaskLine = creatingTask ? "" : lineAt(lines, taskRange.start);
    const taskMarker = !creatingTask && /^\s*%\./.test(currentTaskLine) ? "%." : "%";
    const bodyLines = String(bodyText || "")
      .replace(/\r/g, "")
      .split("\n")
      .map((line) => (line.trim() === "" ? "" : `${indent}${line}`));
    const jiraPrefix = jiraKey ? ` [${jiraKey}]` : "";
    const nextLines = [`${indent}${taskMarker}${jiraPrefix} ${title}`, ...bodyLines];
    const oldTitle = creatingTask ? "" : parseTaskTitleFromLine(lines[taskRange.start] || "");
    lines.splice(taskRange.start, taskRange.end - taskRange.start, ...nextLines);
    renameTaskReferencesInLines(lines, oldTitle, title);
    applyEditorValue(lines.join("\n"));
    syncEditorState();
    return { ok: true, title, lineIndex: taskRange.start };
  }

  return {
    deleteTaskAtLine,
    deleteTaskKeepSubtasksAtLine,
    moveTaskAsSubtask,
    reorderTask,
    saveTaskEdit,
    toggleCheckboxAtLine,
  };
}
