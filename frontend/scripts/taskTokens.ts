// @ts-check

export const JIRA_MARKER_RE = /\[JIRA:([A-Z][A-Z0-9]+(?:-\d+)?)\]/;
export const JIRA_MARKER_GLOBAL_RE = /\s*\[JIRA:[A-Z][A-Z0-9]+(?:-\d+)?\]\s*/g;

const STATE_TOKEN_MATCH_RE = /(^|\s)(![^\s#@~]+)(?=\s|$)/;
const STATE_TOKEN_REPLACE_RE = /(^|\s)![^\s#@~]+(?=\s|$)/g;
const ESTIMATE_TOKEN_MATCH_RE = /(^|\s)(~\d+(?:\.\d+)?)(?=\s|$)/;
const ESTIMATE_TOKEN_REPLACE_RE = /(^|\s)~\d+(?:\.\d+)?(?=\s|$)/g;

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

export function isTaskTokenLiteral(token: string): boolean {
  return /^~\d+(?:\.\d+)?$/.test(token) || /^[#@!][^\s#@~]+$/.test(token);
}

export function isTokenOnlyLine(line: string): boolean {
  const trimmed = typeof line === "string" ? line.trim() : "";
  if (!trimmed) {
    return false;
  }
  return trimmed.split(/\s+/).every((token) => isTaskTokenLiteral(token));
}

export function findStateToken(text: string): string | null {
  const match = text.match(STATE_TOKEN_MATCH_RE);
  return match?.[2] ?? null;
}

export function findEstimateToken(text: string): string | null {
  const match = text.match(ESTIMATE_TOKEN_MATCH_RE);
  return match?.[2] ?? null;
}

export function hasStateToken(text: string): boolean {
  return STATE_TOKEN_MATCH_RE.test(text);
}

export function hasEstimateToken(text: string): boolean {
  return ESTIMATE_TOKEN_MATCH_RE.test(text);
}

export function removeStateAndEstimateTokens(text: string): string {
  return text.replace(STATE_TOKEN_REPLACE_RE, "$1").replace(ESTIMATE_TOKEN_REPLACE_RE, "$1");
}

export function iterTagTokenMatches(text: string): IterableIterator<RegExpMatchArray> {
  return text.matchAll(/(^|\s)(#[^\s#@]+)/g);
}

export function iterPersonTokenMatches(text: string): IterableIterator<RegExpMatchArray> {
  return text.matchAll(/(^|\s)(@[^\s#@]+)/g);
}

export function iterStateTokenMatches(text: string): IterableIterator<RegExpMatchArray> {
  return text.matchAll(/(^|\s)(![^\s#@~]+)/g);
}

export function iterReferenceMatches(text: string): IterableIterator<RegExpMatchArray> {
  return text.matchAll(/\{([^}]+)\}/g);
}

export function findStoryPoints(text: string): number | null {
  const match = text.match(/(^|\s)~(\d+(?:\.\d+)?)(?=\s|$)/);
  if (!match) {
    return null;
  }
  const parsedPoints = Number.parseFloat(match[2] ?? "");
  return Number.isFinite(parsedPoints) ? parsedPoints : null;
}
