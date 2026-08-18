// @ts-check
/**
 * Module: Task script formatting and normalization utilities.
 */

import {
  findEstimateToken,
  findStateToken,
  hasEstimateToken,
  hasStateToken,
  isTokenOnlyLine,
  removeStateAndEstimateTokens,
} from "./taskTokens.js";

// Defines the SplitLine type structure for this module.
type SplitLine = { indent: string; content: string };

/**
 * Handles the splitIndent function logic.
 * Input: line: string.
 * Output: SplitLine.
 */
export function splitIndent(line: string): SplitLine {
  const match = line.match(/^(\s*)/);
  const indent = match?.[1] ?? "";
  return { indent, content: line.slice(indent.length) };
}

/**
 * Handles the normalizeContent function logic.
 * Input: content: string.
 * Output: string.
 */
export function normalizeContent(content: string): string {
  return content.replace(/\s{2,}/g, " ").trim();
}

/**
 * Handles the sharedPrefix function logic.
 * Input: a: string, b: string.
 * Output: string.
 */
function sharedPrefix(a: string, b: string): string {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) {
    i += 1;
  }
  return a.slice(0, i);
}

/**
 * Handles the normalizeIndentToTaskDepth function logic.
 * Input: indent: string.
 * Output: string.
 */
function normalizeIndentToTaskDepth(indent: string): string {
  if (!/^[ ]*$/.test(indent)) {
    return indent;
  }
  const depth = Math.floor(indent.length / 4);
  return " ".repeat(depth * 4);
}

/**
 * Handles the getLine function logic.
 * Input: lines: string[], index: number.
 * Output: string.
 */
function getLine(lines: string[], index: number): string {
  return lines[index] ?? "";
}

/**
 * Handles the prependTokenToLine function logic.
 * Input: line: string, token: string.
 * Output: string.
 */
export function prependTokenToLine(line: string, token: string): string {
  const { indent, content } = splitIndent(line);
  const trimmed = content.trimStart();
  if (!trimmed) {
    return `${indent}${token}`;
  }
  return `${indent}${token} ${trimmed}`;
}

/**
 * Handles the compactBlankLines function logic.
 * Input: lines: string[].
 * Output: string[].
 */
function compactBlankLines(lines: string[]): string[] {
  const firstTaskIndex = lines.findIndex((line) => /^\s*%\s+/.test(line));
  const compact: string[] = [];
  let blankCount = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = getLine(lines, i);
    if (line.trim() === "") {
      if (firstTaskIndex < 0 || i < firstTaskIndex) {
        continue;
      }
      blankCount += 1;
      if (compact.length === 0 || blankCount > 1) {
        continue;
      }
      compact.push("");
      continue;
    }
    blankCount = 0;
    compact.push(line);
  }
  return compact;
}

/**
 * Handles the ensureConfigTaskSeparator function logic.
 * Input: lines: string[].
 * Output: string[].
 */
function ensureConfigTaskSeparator(lines: string[]): string[] {
  const firstTaskIndex = lines.findIndex((line) => /^\s*%\s+/.test(line));
  if (firstTaskIndex <= 0) {
    return lines;
  }
  let hasConfigContent = false;
  for (let i = 0; i < firstTaskIndex; i += 1) {
    if (getLine(lines, i).trim() !== "") {
      hasConfigContent = true;
      break;
    }
  }
  if (!hasConfigContent) {
    return lines;
  }
  if (getLine(lines, firstTaskIndex - 1).trim() === "") {
    return lines;
  }
  const nextLines = [...lines];
  nextLines.splice(firstTaskIndex, 0, "");
  return nextLines;
}

/**
 * Handles the formatTaskScript function logic.
 * Input: text: string.
 * Output: string.
 */
export function formatTaskScript(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n");
  let lines = normalized.split("\n").map((line) => line.replace(/[ \t]+$/g, ""));
  const compact = compactBlankLines(lines);
  while (compact.length && getLine(compact, compact.length - 1).trim() === "") {
    compact.pop();
  }
  lines = ensureConfigTaskSeparator(compact);

  const removeStateEstimateTokens = (line: string): string => {
    const { indent, content } = splitIndent(line);
    if (!hasStateToken(content) && !hasEstimateToken(content)) {
      return line;
    }
    const cleaned = normalizeContent(
      removeStateAndEstimateTokens(content)
    );
    return cleaned ? `${indent}${cleaned}` : "";
  };

  for (let i = 0; i < lines.length; i += 1) {
    const taskMatch = getLine(lines, i).match(/^(\s*)%\.?\s+/);
    if (!taskMatch) {
      continue;
    }
    const indent = taskMatch[1] || "";
    const taskIndent = normalizeIndentToTaskDepth(indent);
    let start = i + 1;
    // Canonical form keeps the token line directly adjacent to description.
    // If the first body line is token-only and the next line is a blank followed
    // by more task content, remove that blank even when no tokens are moved.
    if (
      start + 2 < lines.length &&
      isTokenOnlyLine(getLine(lines, start)) &&
      getLine(lines, start + 1).trim() === "" &&
      getLine(lines, start + 2).trim() !== "" &&
      !/^\s*%/.test(getLine(lines, start + 2))
    ) {
      lines.splice(start + 1, 1);
    }
    let end = start;
    while (end < lines.length) {
      const line = getLine(lines, end);
      if (line.trim() === "" || /^\s*%/.test(line)) {
        break;
      }
      end += 1;
    }
    if (start === end) {
      continue;
    }
    let stateToken = null;
    let estimateToken = null;
    for (let j = start; j < end; j += 1) {
      if (!stateToken) {
        stateToken = findStateToken(getLine(lines, j));
      }
      if (!estimateToken) {
        estimateToken = findEstimateToken(getLine(lines, j));
      }
      if (stateToken && estimateToken) {
        break;
      }
    }
    if (!stateToken && !estimateToken) {
      continue;
    }
    for (let j = start; j < end; j += 1) {
      lines[j] = removeStateEstimateTokens(getLine(lines, j));
    }
    // Lines that become empty after stripping state/estimate were created by
    // normalization, not authored as task separators. Drop them so the token
    // line stays adjacent to the description.
    for (let j = start; j < end; ) {
      if (getLine(lines, j).trim() !== "") {
        j += 1;
        continue;
      }
      lines.splice(j, 1);
      end -= 1;
    }
    let tokenLineIndex = -1;
    for (let j = start; j < end; j += 1) {
      if (getLine(lines, j).trim() === "") {
        continue;
      }
      if (isTokenOnlyLine(getLine(lines, j))) {
        tokenLineIndex = j;
      }
      break;
    }
    const desiredTokens = [stateToken, estimateToken].filter(Boolean).join(" ");
    if (!desiredTokens) {
      continue;
    }
    if (tokenLineIndex >= 0) {
      const { indent: lineIndent, content } = splitIndent(getLine(lines, tokenLineIndex));
      const cleaned = normalizeContent(content);
      const finalContent = cleaned
        ? normalizeContent(`${cleaned} ${desiredTokens}`)
        : desiredTokens;
      lines[tokenLineIndex] = `${lineIndent}${finalContent}`;
      if (taskIndent !== indent) {
        // Snap malformed task/token indentation to 4-space depth increments.
        const { content: taskContent } = splitIndent(getLine(lines, i));
        lines[i] = `${taskIndent}${taskContent}`;
        const { content: tokenContent } = splitIndent(getLine(lines, tokenLineIndex));
        lines[tokenLineIndex] = `${taskIndent}${tokenContent}`;
      }
    } else {
      let sharedBodyIndent = null;
      for (let j = start; j < end; j += 1) {
        if (getLine(lines, j).trim() === "") {
          continue;
        }
        const lineIndent = splitIndent(getLine(lines, j)).indent;
        sharedBodyIndent = sharedBodyIndent === null
          ? lineIndent
          : sharedPrefix(sharedBodyIndent, lineIndent);
      }
      const canonicalIndentRaw = sharedBodyIndent === null ? indent : sharedPrefix(indent, sharedBodyIndent);
      const canonicalIndent = normalizeIndentToTaskDepth(canonicalIndentRaw);
      if (indent !== canonicalIndent) {
        const { content: taskContent } = splitIndent(getLine(lines, i));
        lines[i] = `${canonicalIndent}${taskContent}`;
      }
      if (sharedBodyIndent !== null && sharedBodyIndent !== canonicalIndent) {
        for (let j = start; j < end; j += 1) {
          const line = getLine(lines, j);
          if (line.trim() === "" || !line.startsWith(sharedBodyIndent)) {
            continue;
          }
          lines[j] = `${canonicalIndent}${line.slice(sharedBodyIndent.length)}`;
        }
      }
      lines.splice(start, 0, `${canonicalIndent}${desiredTokens}`);
      end += 1;
    }
  }

  const finalLines = ensureConfigTaskSeparator(compactBlankLines(lines));
  while (finalLines.length && getLine(finalLines, finalLines.length - 1).trim() === "") {
    finalLines.pop();
  }
  return finalLines.join("\n");
}
