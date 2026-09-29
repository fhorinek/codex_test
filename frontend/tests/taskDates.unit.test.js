const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../scripts/taskDates.ts');

test('dates parse valid calendar days and all three date forms', async () => {
  const { parseDay, findTaskDates, formatDates, todayDay } = await load();
  assert.equal(parseDay('29.2.2025'), null);
  assert.notEqual(parseDay('29.2.2024'), null);
  for (const token of ['3.4.2026', '-8.4.2026', '3.4.2026-8.4.2026']) {
    const found = findTaskDates(`% Task\n  plan ${token} notes`, 0);
    assert.equal(formatDates(found), token);
    assert.equal(found.from, 7);
    assert.equal(found.to, 7 + token.length);
  }
  assert.equal(todayDay(new Date(2026, 3, 3, 23)), parseDay('3.4.2026'));
});
test('invalid and reversed expressions never fall back to a partial date', async () => {
  const { findTaskDates } = await load();
  for (const token of ['31.4.2026', '8.4.2026-3.4.2026', '3.4.26', '3.4.2026-8.4', 'x3.4.2026', '3.4.2026.2', '--3.4.2026', '3.4.2026--', '31.9.2026-', '3.4.2026-99.4.2026']) {
    assert.equal(findTaskDates(`% Task\n${token}`, 0), null, token);
  }
});
test('first valid date wins and descendants are excluded', async () => {
  const { findTaskDates, formatDates } = await load();
  const source = '% Parent\ninvalid 31.2.2026 then 1.3.2026 and 4.3.2026\n    % Child\n    8.4.2026';
  assert.equal(formatDates(findTaskDates(source, 0)), '1.3.2026');
  assert.equal(findTaskDates('% Parent\n    % Child\n    8.4.2026', 0), null);
  assert.equal(formatDates(findTaskDates(source, 2)), '8.4.2026');
});
test('date edits preserve prose, later dates and child tasks; new dates are first body line', async () => {
  const { parseDay, updateTaskDates } = await load();
  const dates = { start: parseDay('9.4.2026'), end: null };
  const source = '% Parent\n  before 3.4.2026 after 4.4.2026\n    % Child\n    -8.4.2026';
  assert.equal(updateTaskDates(source, 0, dates), source.replace('3.4.2026', '9.4.2026'));
  assert.equal(updateTaskDates('% Parent\n    % Child\n    -8.4.2026', 0, dates), '% Parent\n9.4.2026\n    % Child\n    -8.4.2026');
  assert.equal(updateTaskDates('    % Child\n    #tag', 0, dates), '    % Child\n    9.4.2026\n    #tag');
  assert.equal(updateTaskDates('% Task\n\n  notes', 0, dates), '% Task\n  9.4.2026\n\n  notes');
});
test('move and resize retain open ends, clamp crossing, and use whole calendar days', async () => {
  const { parseDay, moveDates, resizeDates, formatDates } = await load();
  const start = parseDay('28.3.2026'), end = parseDay('30.3.2026');
  assert.equal(formatDates(moveDates({ start, end }, 2)), '30.3.2026-1.4.2026');
  assert.deepEqual(moveDates({ start, end: null }, 2), { start: start + 2, end: null });
  assert.deepEqual(moveDates({ start: null, end }, -1), { start: null, end: end - 1 });
  assert.deepEqual(resizeDates({ start, end: null }, 'end', end), { start, end });
  assert.deepEqual(resizeDates({ start: null, end }, 'start', start), { start, end });
  assert.deepEqual(resizeDates({ start, end }, 'start', end + 10), { start: end, end });
  assert.deepEqual(resizeDates({ start, end }, 'end', start - 10), { start, end: start });
});
test('date command commits once and rejects stale source snapshots', async () => {
  const { createTaskCommandController } = await import('../scripts/taskCommands.ts');
  const { parseDay } = await load();
  let source = '% Task', commits = 0, syncs = 0;
  const commands = createTaskCommandController({ getEditorValue: () => source, applyEditorValue: value => { source = value; commits++; }, syncEditorState: () => syncs++ });
  commands.setTaskDates(0, { start: parseDay('1.5.2026'), end: null }, source);
  assert.equal(source, '% Task\n1.5.2026'); assert.equal(commits, 1); assert.equal(syncs, 1);
  commands.setTaskDates(0, { start: parseDay('2.5.2026'), end: null }, '% Task');
  assert.equal(commits, 1);
});

test('trailing dash is an open start, preserved on moves and replaced when resized', async () => {
  const { findTaskDates, parseDay, updateTaskDates, moveDates, resizeDates } = await load();
  const source = '% Task\n  begins 30.9.2026- notes 5.10.2026\n    % Child\n    -8.10.2026';
  const found = findTaskDates(source, 0);
  assert.equal(found.start, parseDay('30.9.2026'));
  assert.equal(found.end, null);
  assert.equal(source.split('\n')[found.line].slice(found.from, found.to), '30.9.2026-');
  assert.equal(updateTaskDates(source, 0, moveDates(found, 1)), source.replace('30.9.2026-', '1.10.2026-'));
  assert.equal(updateTaskDates(source, 0, resizeDates(found, 'end', parseDay('4.10.2026'))), source.replace('30.9.2026-', '30.9.2026-4.10.2026'));
  assert.equal(findTaskDates('% Task\n30.9.2026-', 0).start, parseDay('30.9.2026'));
});
