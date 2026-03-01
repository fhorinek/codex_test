// @ts-check

/**
 * Module: Token parsing utilities for tags, people, states, estimates, and references.
 */

// Stores the JIRA_MARKER_RE module constant.
export const JIRA_MARKER_RE = /\[([A-Z][A-Z0-9]+(?:-\d+)?)\]/;
// Stores the JIRA_MARKER_GLOBAL_RE module constant.
export const JIRA_MARKER_GLOBAL_RE = /\s*\[[A-Z][A-Z0-9]+(?:-\d+)?\]\s*/g;

// Stores the STATE_TOKEN_MATCH_RE module constant.
const STATE_TOKEN_MATCH_RE = /(^|\s)(![^\s#@~]+)(?=\s|$)/;
// Stores the STATE_TOKEN_REPLACE_RE module constant.
const STATE_TOKEN_REPLACE_RE = /(^|\s)![^\s#@~]+(?=\s|$)/g;
// Stores the ESTIMATE_TOKEN_MATCH_RE module constant.
const ESTIMATE_TOKEN_MATCH_RE = /(^|\s)(~\d+(?:\.\d+)?)(?=\s|$)/;
// Stores the ESTIMATE_TOKEN_REPLACE_RE module constant.
const ESTIMATE_TOKEN_REPLACE_RE = /(^|\s)~\d+(?:\.\d+)?(?=\s|$)/g;

/**
 * Handles the normalizeConfiguredColorValue function logic.
 * Input: value: unknown.
 * Output: string.
 */
export function normalizeConfiguredColorValue(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return "";
  }
  if (/^#[0-9a-fA-F]{3}$/.test(raw) || /^#[0-9a-fA-F]{6}$/.test(raw)) {
    return raw;
  }
  if (/^[0-9a-fA-F]{3}$/.test(raw) || /^[0-9a-fA-F]{6}$/.test(raw)) {
    return `#${raw}`;
  }
  return raw;
}

/**
 * Handles the isTaskTokenLiteral function logic.
 * Input: token: string.
 * Output: boolean.
 */
export function isTaskTokenLiteral(token: string): boolean {
  return /^~\d+(?:\.\d+)?$/.test(token) || /^[#@!][^\s#@~]+$/.test(token);
}

/**
 * Handles the isTokenOnlyLine function logic.
 * Input: line: string.
 * Output: boolean.
 */
export function isTokenOnlyLine(line: string): boolean {
  const trimmed = typeof line === "string" ? line.trim() : "";
  if (!trimmed) {
    return false;
  }
  return trimmed.split(/\s+/).every((token) => isTaskTokenLiteral(token));
}

/**
 * Handles the findStateToken function logic.
 * Input: text: string.
 * Output: string | null.
 */
export function findStateToken(text: string): string | null {
  const match = text.match(STATE_TOKEN_MATCH_RE);
  return match?.[2] ?? null;
}

/**
 * Handles the findEstimateToken function logic.
 * Input: text: string.
 * Output: string | null.
 */
export function findEstimateToken(text: string): string | null {
  const match = text.match(ESTIMATE_TOKEN_MATCH_RE);
  return match?.[2] ?? null;
}

/**
 * Handles the hasStateToken function logic.
 * Input: text: string.
 * Output: boolean.
 */
export function hasStateToken(text: string): boolean {
  return STATE_TOKEN_MATCH_RE.test(text);
}

/**
 * Handles the hasEstimateToken function logic.
 * Input: text: string.
 * Output: boolean.
 */
export function hasEstimateToken(text: string): boolean {
  return ESTIMATE_TOKEN_MATCH_RE.test(text);
}

/**
 * Handles the removeStateAndEstimateTokens function logic.
 * Input: text: string.
 * Output: string.
 */
export function removeStateAndEstimateTokens(text: string): string {
  return text.replace(STATE_TOKEN_REPLACE_RE, "$1").replace(ESTIMATE_TOKEN_REPLACE_RE, "$1");
}

/**
 * Handles the iterTagTokenMatches function logic.
 * Input: text: string.
 * Output: IterableIterator<RegExpMatchArray>.
 */
export function iterTagTokenMatches(text: string): IterableIterator<RegExpMatchArray> {
  return text.matchAll(/(^|\s)(#[^\s#@]+)/g);
}

/**
 * Handles the iterPersonTokenMatches function logic.
 * Input: text: string.
 * Output: IterableIterator<RegExpMatchArray>.
 */
export function iterPersonTokenMatches(text: string): IterableIterator<RegExpMatchArray> {
  return text.matchAll(/(^|\s)(@[^\s#@]+)/g);
}

/**
 * Handles the iterStateTokenMatches function logic.
 * Input: text: string.
 * Output: IterableIterator<RegExpMatchArray>.
 */
export function iterStateTokenMatches(text: string): IterableIterator<RegExpMatchArray> {
  return text.matchAll(/(^|\s)(![^\s#@~]+)/g);
}

/**
 * Handles the iterReferenceMatches function logic.
 * Input: text: string.
 * Output: IterableIterator<RegExpMatchArray>.
 */
export function iterReferenceMatches(text: string): IterableIterator<RegExpMatchArray> {
  return text.matchAll(/\{([^}]+)\}/g);
}

/**
 * Handles the findStoryPoints function logic.
 * Input: text: string.
 * Output: number | null.
 */
export function findStoryPoints(text: string): number | null {
  const match = text.match(/(^|\s)~(\d+(?:\.\d+)?)(?=\s|$)/);
  if (!match) {
    return null;
  }
  const parsedPoints = Number.parseFloat(match[2] ?? "");
  return Number.isFinite(parsedPoints) ? parsedPoints : null;
}
