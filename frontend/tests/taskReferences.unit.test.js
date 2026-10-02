const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseTasks } = require('../scripts/task.ts');
const { resolveTaskReferences, transferTask, taskSource, taskSourceLine, rewriteTaskReferences } = require('../scripts/taskReferences.ts');
const { findTaskDates, updateTaskDates, parseDay } = require('../scripts/taskDates.ts');
const { formatTaskScript } = require('../scripts/formatter.ts');
const { createTaskCommandController } = require('../scripts/taskCommands.ts');
const source = '% Original\n#urgent @anna !todo\n1.10.2026-3.10.2026\n[ ] Check\n    % Child\n    4.10.2026\n% Other\n';
const documents = [{ id: 'main-id', name: 'main', text: source }];
const resolve = text => resolveTaskReferences(parseTasks(text), documents, 'current');
test('removing a projected task deletes only its local reference line', () => {
  let text = '% Parent\n    %% main::Original\n    % Local child\n    Keep this body\n% After\n';
  const parsed = resolve(text);
  const commands = createTaskCommandController({ getEditorValue: () => text, applyEditorValue: value => { text = value; }, syncEditorState: () => {} });
  commands.removeTaskReferenceAtLine(parsed.tasks[0].children[0].children[0].lineIndex);
  assert.equal(text, '% Parent\n    % Local child\n    Keep this body\n% After\n');
  assert.equal(documents[0].text, source);
  assert.equal(commands.removeTaskReferenceAtLine(0), null);
});
test('reference syntax preserves local source lines and hierarchy', () => {
  const text = '% Parent\n    %% main::Original\n% After\n';
  const parsed = resolve(text), ref = parsed.tasks[0].children[0];
  assert.equal(parsed.tasks[1].lineIndex, 2);
  assert.equal(ref.name, 'Original'); assert.equal(ref.depth, 1);
  assert.equal(ref.lineIndex, 1); assert.equal(ref.children[0].depth, 2);
  assert.equal(ref.children[0].lineIndex, 1); assert.equal(ref.children[0].origin.lineIndex, 4);
  assert.deepEqual(ref.tags, ['#urgent']); assert.deepEqual(ref.people, ['@anna']);
  assert.equal(ref.origin.documentId, 'main-id'); assert.equal(ref.parent, parsed.tasks[0]);
  assert.equal(parsed.referenceLines.get(ref.descriptionLineIndexes[2]).line, 3);
  assert.deepEqual(parsed.referenceDiagnostics, []); assert.equal(text, parsed.lines.join('\n'));
});
test('dates and edits use the original source rather than the reference line', () => {
  const ref = resolve('%% main::Original').tasks[0];
  assert.equal(findTaskDates(taskSource(ref, ''), taskSourceLine(ref)).end, parseDay('3.10.2026'));
  const updated = updateTaskDates(taskSource(ref, ''), taskSourceLine(ref), { start: parseDay('2.10.2026'), end: null });
  assert.match(updated, /2\.10\.2026\n\[ \] Check/); assert.match(updated, /% Child\n    4\.10\.2026/);
});
test('triple-percent references include only the original task and retain its edit source', () => {
  const parsed = resolve('%%% main::Original\n% Local');
  assert.equal(parsed.allTasks.length, 2);
  assert.deepEqual(parsed.tasks[0].children, []);
  assert.equal(parsed.tasks[0].origin.documentId, 'main-id');
  assert.deepEqual(parsed.tasks[0].tags, ['#urgent']);
  assert.deepEqual(parsed.referenceDiagnostics, []);
  const transferred = transferTask(source, 0, '', 0, 'main', 'reference-only');
  assert.equal(transferred.destination, '%%% main::Original\n');
  assert.equal(transferred.source, source);
  assert.equal(rewriteTaskReferences('%%% main::Original', 'main', 'Original', 'next', 'Renamed'), '%%% next::Renamed');
  assert.match(formatTaskScript('Board:\n%%% main::Original\n% Local\n#tag'), /%%% main::Original/);
  let text = transferred.destination;
  const commands = createTaskCommandController({ getEditorValue: () => text, applyEditorValue: value => { text = value; }, syncEditorState: () => {} });
  commands.removeTaskReferenceAtLine(0);
  assert.equal(text, '');
});
test('task-only references stay task-only through reference chains', () => {
  const docs = [...documents, { id: 'alias', name: 'alias', text: '%% main::Original' }];
  const parsed = resolveTaskReferences(parseTasks('%%% alias::Original'), docs, 'current');
  assert.equal(parsed.allTasks.length, 1);
  assert.equal(parsed.tasks[0].origin.documentId, 'main-id');
});
test('missing, ambiguous, malformed, and cyclic references are diagnostic', () => {
  assert.match(resolve('%% missing::Original').referenceDiagnostics[0], /not found/);
  assert.match(resolve('%% main::').referenceDiagnostics[0], /use %%/);
  const ambiguous = resolveTaskReferences(parseTasks('%% main::Same'), [{ id: 'x', name: 'main', text: '% Same\n% Same' }], 'current');
  assert.match(ambiguous.referenceDiagnostics[0], /ambiguous/);
  const cycle = resolveTaskReferences(parseTasks('%% main::Loop'), [{ id: 'x', name: 'main', text: '%% main::Loop' }], 'current');
  assert.match(cycle.referenceDiagnostics[0], /circular/);
});
test('archived parent state is preserved', () => {
  assert.equal(resolve('%. Archived\n    %% main::Original').tasks[0].children[0].archived, true);
});
test('reference insertion leaves original intact; move includes descendants', () => {
  const reference = transferTask(source, 0, '% Destination\n', 2, 'main', 'reference');
  assert.equal(reference.source, source); assert.match(reference.destination, /%% main::Original/);
  const moved = transferTask(source, 4, '% Destination\n', 2, 'main', 'move');
  assert.doesNotMatch(moved.source, /% Child/); assert.match(moved.source, /% Original/);
  assert.match(moved.destination, /\n% Child\n4\.10\.2026/);
  const whole = transferTask(source, 0, '', 0, 'main', 'move');
  assert.equal(whole.source, '% Other\n'); assert.match(whole.destination, /    % Child/);
});
test('reject stale line, projections, and duplicate source names', () => {
  assert.throws(() => transferTask(source, 100, '', 0, 'main', 'move'));
  assert.throws(() => transferTask('%% main::Original', 0, '', 0, 'main', 'move'));
  assert.throws(() => transferTask('% Same\n% Same', 0, '', 0, 'main', 'reference'));
});
test('rewriting references preserves unrelated body text and indentation', () => {
  const text = 'Notes\n%% main::Original\n    %% main::Original  \n%% other::Original\nbody main::Original';
  assert.equal(rewriteTaskReferences(text, 'main', 'Original', 'release', 'Renamed'), 'Notes\n%% release::Renamed\n    %% release::Renamed  \n%% other::Original\nbody main::Original');
});
test('formatting retains standalone reference syntax', () => {
  assert.match(formatTaskScript('Board:\n%% main::Original\n% Local\n#tag'), /%% main::Original/);
});
test('a reference beside its original is not ambiguous', () => {
  const doc = { id: 'main', name: 'main', text: '%% main::Original\n% Original\n1.10.2026' };
  const parsed = resolveTaskReferences(parseTasks(doc.text), [doc], 'main');
  assert.deepEqual(parsed.referenceDiagnostics, []);
  assert.equal(parsed.tasks[0].origin.lineIndex, 1);
  assert.doesNotThrow(() => transferTask(doc.text, 1, '', 0, 'main', 'move'));
});
test('moving a subtree supplies child names for reference updates and rejects destination conflicts', () => {
  assert.deepEqual(transferTask(source, 0, '', 0, 'main', 'move').names, ['Original', 'Child']);
  assert.throws(() => transferTask(source, 0, '% Child', 0, 'main', 'move'), /same name/);
});
test('a child projection retains its original inherited background', () => {
  const shared = 'Definitions:\n    tags:\n        urgent:\n            background: #ff0000\n';
  const parsed = resolveTaskReferences(parseTasks('%% main::Child', shared), documents, 'current', shared);
  assert.match(parsed.tasks[0].originBackground, /#ff0000 80%/);
});
