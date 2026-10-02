import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJiraLogs } from '../scripts/jiraLogs.ts';

test('Jira logs preserve severity and parse timestamped multiline JSON', () => {
  const entries = parseJiraLogs([
    '2026-10-02T12:00:00+00:00 2026-10-02 12:00:00,000 WARNING jira-worker: Retry scheduled',
    '2026-10-02T12:00:01+00:00 2026-10-02 12:00:01,001 INFO jira-worker: Payload: {',
    '2026-10-02T12:00:01+00:00 "nested": {"count": 2}',
    '2026-10-02T12:00:01+00:00 }',
    '2026-10-02 12:00:02,000 ERROR jira-worker: Failed',
    'continuation', 'Daemon started.',
  ]);
  assert.equal(entries[0].level, 'warning');
  assert.equal(entries[0].time, '2026-10-02 12:00:00,000');
  assert.equal(entries[1].kind, 'json');
  assert.deepEqual(entries[1].value, { nested: { count: 2 } });
  assert.equal(entries[2].level, 'error');
  assert.equal(entries[3].level, 'error');
  assert.equal(entries[4].level, 'success');
});

test('Jira difference tables preserve column boundaries and embedded pipes', () => {
  const headers = ['field', 'space', 'sync', 'jira'];
  const rows = [['title', 'A | B', '->', 'C'], ['', 'continued', '', 'more']];
  const widths = headers.map((value, index) => Math.max(value.length, ...rows.map(row => row[index].length)));
  const border = '+' + widths.map(width => '-'.repeat(width + 2)).join('+') + '+';
  const row = values => '| ' + values.map((value, index) => value.padEnd(widths[index])).join(' | ') + ' |';
  const entries = parseJiraLogs([border, row(headers), border, ...rows.map(row), border]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'table');
  assert.deepEqual(entries[0].headers, headers);
  assert.deepEqual(entries[0].rows, rows);
});

test('Jira logs preserve malformed payloads and bracketed labels as text', () => {
  const entries = parseJiraLogs(['[Space project] <script>plain text</script>', 'Payload: {', 'invalid', '2026-10-02 12:00:00,000 INFO jira-worker: items: [1,true,null]']);
  assert.equal(entries[0].kind, 'line');
  assert.equal(entries[0].message, '[Space project] <script>plain text</script>');
  assert.equal(entries[1].kind, 'line');
  assert.equal(entries[2].kind, 'line');
  assert.equal(entries[3].kind, 'json');
  assert.deepEqual(entries[3].value, [1, true, null]);
});
