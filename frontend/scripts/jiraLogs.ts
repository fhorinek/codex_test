import { createJsonViewer } from './jsonViewer.js';
export type JiraLogEntry = { id: string; level: string; time: string; message: string } & (
  { kind: 'line' } | { kind: 'json'; value: unknown } | { kind: 'table'; headers: string[]; rows: string[][] }
);
/** Parse existing worker output, preserving malformed or incomplete payloads as text. */
export function parseJiraLogs(logs: string[]): JiraLogEntry[] {
  let level = 'info';
  const lines = logs.flatMap(line => line.split('\n')).map(raw => {
    const outer = /^(\d{4}-\d\d-\d\dT\S+)\s(.*)$/.exec(raw);
    const body = outer?.[2] ?? raw;
    const header = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:,\d+)?)\s+(DEBUG|INFO|WARNING|ERROR|CRITICAL)\s+[^:]+:\s?(.*)$/.exec(body);
    if (header) level = header[2]!.toLowerCase();
    const message = header?.[3] ?? body;
    const color = /Synchronization complete|Daemon started|worker started/.test(message) ? 'success' : level;
    return { id: raw, time: header?.[1] ?? outer?.[1] ?? '', message, level: color, header: Boolean(header) };
  });
  const result: JiraLogEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\+(?:-+\+)+$/.test(line.message.trim()) && lines[i + 1]?.message.trim().startsWith('|')) {
      const border = line.message.trim(), cuts = [...border.matchAll(/\+/g)].map(match => match.index!);
      const rows: string[][] = []; let end = i + 1;
      while (end < lines.length) {
        const row = lines[end]!.message;
        if (/^\+(?:-+\+)+$/.test(row.trim())) { end++; continue; }
        if (!row.startsWith('|') || !row.endsWith('|')) break;
        rows.push(cuts.slice(0, -1).map((from, column) => row.slice(from + 1, cuts[column + 1]).trim())); end++;
      }
      if (rows.length) { result.push({ ...line, kind: 'table', headers: rows[0]!, rows: rows.slice(1) }); i = end - 1; continue; }
    }
    const start = line.message.search(/\{(?=\s*(?:"|\}|$))|\[(?=\s*(?:["{\[\]\d-]|true\b|false\b|null\b|$))/);
    if (start >= 0) {
      let json = line.message.slice(start);
      for (let end = i; end < lines.length; end++) {
        if (end > i) {
          if (lines[end]!.header) break;
          json += '\n' + lines[end]!.message;
        }
        try {
          const value = JSON.parse(json);
          if (value !== null && typeof value === 'object') {
            result.push({ ...line, message: line.message.slice(0, start).trim() || 'JSON payload', kind: 'json', value });
            i = end; json = ''; break;
          }
        } catch { /* Keep gathering a multiline JSON value. */ }
      }
      if (!json) continue;
    }
    result.push({ ...line, kind: 'line' });
  }
  return result;
}

export function createJiraLogViewer() {
  const element = document.createElement('div'); element.className = 'jira-panel-output'; element.tabIndex = 0;
  const jsonViewers = new Map<string, ReturnType<typeof createJsonViewer>>(), expanded = new Map<string, boolean>();
  let serialized = '', space = '';
  return {
    element,
    reset() { serialized = ''; element.textContent = 'Loading…'; },
    update(logs: string[], spaceId: string) {
      if (space !== spaceId) { jsonViewers.clear(); expanded.clear(); serialized = ''; space = spaceId; }
      const next = JSON.stringify(logs); if (serialized === next) return; serialized = next;
      const bottom = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
      const scroll = element.scrollTop, focus = document.activeElement as HTMLElement;
      element.replaceChildren(); const used = new Set<string>();
      for (const entry of parseJiraLogs(logs)) {
        const row = document.createElement('div'); row.className = `jira-log-entry jira-log-${entry.level}`;
        if (entry.kind === 'line') {
          const time = document.createElement('span'); time.className = 'jira-log-time'; time.textContent = entry.time ? entry.time + ' ' : '';
          row.append(time, document.createTextNode(entry.message));
        } else if (entry.kind === 'json') {
          const details = document.createElement('details'); details.className = 'jira-log-json'; details.open = expanded.get(entry.id) ?? false;
          const summary = document.createElement('summary'); summary.textContent = `${entry.time} ${entry.message}`.trim(); details.append(summary);
          let viewer = jsonViewers.get(entry.id);
          if (!viewer) { viewer = createJsonViewer(); jsonViewers.set(entry.id, viewer); }
          viewer.update(entry.value, spaceId); details.append(viewer.element); row.append(details); used.add(entry.id);
          details.addEventListener('toggle', () => expanded.set(entry.id, details.open));
        } else {
          const wrapper = document.createElement('div'); wrapper.className = 'jira-log-table-wrap';
          const table = document.createElement('table'); table.className = 'jira-log-differences';
          const caption = document.createElement('caption'); caption.textContent = 'Synchronization differences'; table.append(caption);
          const head = document.createElement('thead'), headings = document.createElement('tr');
          entry.headers.forEach(value => { const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = value; headings.append(cell); }); head.append(headings);
          const body = document.createElement('tbody'); const sync = entry.headers.indexOf('sync');
          entry.rows.forEach(values => {
            const tr = document.createElement('tr');
            if (sync >= 0 && values[sync] && values[sync] !== '==') tr.classList.add('jira-log-difference');
            values.forEach(value => { const cell = document.createElement('td'); cell.textContent = value; tr.append(cell); }); body.append(tr);
          });
          table.append(head, body); wrapper.append(table); row.append(wrapper);
        }
        element.append(row);
      }
      if (!logs.length) element.textContent = 'No daemon activity yet.';
      for (const id of jsonViewers.keys()) if (!used.has(id)) { jsonViewers.delete(id); expanded.delete(id); }
      if (focus && element.contains(focus)) focus.focus({ preventScroll: true });
      element.scrollTop = bottom ? element.scrollHeight : scroll;
    },
  };
}
