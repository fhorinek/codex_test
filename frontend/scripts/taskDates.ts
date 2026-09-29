/** Calendar dates are UTC day numbers, never local timestamps. */
export type TaskDates = { start: number | null; end: number | null };
export type DateMatch = TaskDates & { line: number; from: number; to: number };
const DAY = 86400000;
export function todayDay(now = new Date()): number {
  return Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / DAY);
}
export function parseDay(value: string): number | null {
  const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(value);
  if (!match) return null;
  const [, d, m, y] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  if (year < 1000) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? Math.floor(date.getTime() / DAY) : null;
}
export function formatDay(day: number): string {
  const date = new Date(day * DAY);
  return `${date.getUTCDate()}.${date.getUTCMonth() + 1}.${date.getUTCFullYear()}`;
}
export function formatDates(dates: TaskDates): string {
  if (dates.start === null) return `-${formatDay(dates.end!)}`;
  return dates.end === null ? formatDay(dates.start) : `${formatDay(dates.start)}-${formatDay(dates.end)}`;
}
export function findTaskDates(source: string | string[], taskLine: number): DateMatch | null {
  const lines = typeof source === 'string' ? source.split('\n') : source;
  for (let line = taskLine + 1; line < lines.length; line++) {
    const text = lines[line]!;
    if (/^\s*%/.test(text)) break;
    // Consume malformed ranges as a whole, so their endpoints cannot become single dates.
    const candidates = /-?\d+\.\d+\.\d+(?:[ \t]*-[ \t]*\d+(?:\.\d+)*|-)?/g;
    for (const match of text.matchAll(candidates)) {
      const from = match.index!, to = from + match[0].length;
      if (/[\w.\/-]/.test(text[from - 1] || '') || /[\w.\/-]/.test(text[to] || '')) continue;
      if (/^[ \t]+-/.test(text.slice(to))) continue;
      const token = match[0].replace(/[ \t]/g, '');
      let start: number | null = null, end: number | null = null;
      if (token.startsWith('-')) {
        end = parseDay(token.slice(1));
        if (end === null) continue;
      } else if (token.endsWith('-')) {
        start = parseDay(token.slice(0, -1));
        if (start === null) continue;
      } else if (token.includes('-')) {
        const parts = token.split('-');
        start = parseDay(parts[0]!); end = parseDay(parts[1]!);
        if (start === null || end === null || end < start) continue;
      } else {
        start = parseDay(token);
        if (start === null) continue;
      }
      return { start, end, line, from, to };
    }
  }
  return null;
}
export function updateTaskDates(source: string, taskLine: number, dates: TaskDates): string {
  if ((dates.start === null && dates.end === null) ||
      (dates.start !== null && dates.end !== null && dates.end < dates.start)) return source;
  for (const day of [dates.start, dates.end]) {
    if (day !== null && (!Number.isInteger(day) || parseDay(formatDay(day)) === null)) return source;
  }
  const lines = source.split('\n');
  const header = lines[taskLine];
  if (header === undefined || !/^\s*%/.test(header)) return source;
  const found = findTaskDates(source, taskLine);
  const keepTrailingDash = found && dates.start !== null && dates.end === null
    && lines[found.line]!.slice(found.from, found.to).endsWith('-');
  const replacement = formatDates(dates) + (keepTrailingDash ? '-' : '');
  if (found) {
    const line = lines[found.line]!;
    lines[found.line] = line.slice(0, found.from) + replacement + line.slice(found.to);
  } else {
    let indent = header.match(/^\s*/)?.[0];
    for (let index = taskLine + 1; index < lines.length; index++) {
      const body = lines[index]!;
      if (/^\s*%/.test(body)) break;
      if (body.trim()) { indent = body.match(/^\s*/)?.[0]; break; }
    }
    lines.splice(taskLine + 1, 0, `${indent || ''}${replacement}`);
  }
  return lines.join('\n');
}
export function moveDates(dates: TaskDates, delta: number): TaskDates {
  return { start: dates.start === null ? null : dates.start + delta, end: dates.end === null ? null : dates.end + delta };
}
export function resizeDates(dates: TaskDates, edge: 'start' | 'end', day: number): TaskDates {
  return edge === 'start'
    ? { start: dates.end === null ? day : Math.min(day, dates.end), end: dates.end }
    : { start: dates.start, end: dates.start === null ? day : Math.max(day, dates.start) };
}
