const { test } = require('node:test');
const assert = require('node:assert/strict');

test('separators appear only between top-level task groups', async () => {
  const { timelineSeparatorWidth } = await import('../scripts/timelineLayout.ts');
  const root = { id: 'root' }, otherRoot = { id: 'other' };
  const child = { id: 'child', parent: root }, sibling = { id: 'sibling', parent: root };
  const grandchild = { id: 'grandchild', parent: child }, cousin = { id: 'cousin', parent: child };
  assert.equal(timelineSeparatorWidth(root, child), 0);
  assert.equal(timelineSeparatorWidth(child, sibling), 0);
  assert.equal(timelineSeparatorWidth(child, grandchild), 0);
  assert.equal(timelineSeparatorWidth(grandchild, otherRoot), 4);
  assert.equal(timelineSeparatorWidth(grandchild, sibling), 0);
  assert.equal(timelineSeparatorWidth(grandchild, cousin), 0);
  assert.equal(timelineSeparatorWidth(root), 0);
});

test('undated children do not split rows but dated descendants do', async () => {
  const { layoutTimeline } = await import('../scripts/timelineLayout.ts');
  const task = (id, children = []) => ({ id, children });
  const roots = [task('parent', [
    task('first', [task('undated')]), task('second'),
    task('branch', [task('undated-middle', [task('dated-grandchild')])]),
    task('last'),
  ])];
  const bands = layoutTimeline(roots, t => t.id.startsWith('undated') ? null : { start: 0, end: 5 });
  assert.deepEqual(bands.map(b => b.tasks.map(p => p.task.id)), [
    ['parent'], ['first', 'second'], ['branch'], ['dated-grandchild'], ['last'],
  ]);
  assert.deepEqual(bands.map(b => b.hiddenParent?.id), [undefined, undefined, undefined, 'undated-middle', undefined]);
});

test('leaf siblings share lanes and later overlapping tasks stack below', async () => {
  const { layoutTimeline } = await import('../scripts/timelineLayout.ts');
  const task = (id, children = []) => ({ id, children });
  const root = task('parent', [task('late'), task('early'), task('after')]);
  const spans = { parent: [0, 50], early: [1, 10], late: [5, 15], after: [15, 20] };
  const bands = layoutTimeline([root], t => ({ start: spans[t.id][0], end: spans[t.id][1] }));
  assert.equal(bands.length, 2);
  assert.equal(bands[1].lanes, 2);
  assert.deepEqual(bands[1].tasks.map(p => [p.task.id, p.lane]), [['early', 0], ['late', 1], ['after', 0]]);
});

test('branches, root siblings, undated parents and archived children retain hierarchy', async () => {
  const { layoutTimeline } = await import('../scripts/timelineLayout.ts');
  const task = (id, children = []) => ({ id, children });
  const root = task('undated', [task('leaf'), task('branch', [task('nested')]), task('last'), { ...task('archived-child', [task('hidden-child')]), archived: true }]);
  const archived = { ...task('archived', [task('hidden')]), archived: true };
  const bands = layoutTimeline([root, archived, task('root')], t => t.id === 'undated' ? null : { start: 0, end: 10 });
  assert.deepEqual(bands.map(b => b.tasks.map(p => p.task.id)), [['leaf'], ['branch'], ['nested'], ['last'], ['root']]);
  assert.deepEqual(bands.map(b => b.hiddenParent?.id), ['undated', 'undated', undefined, 'undated', undefined]);
});

test('later overlaps stay below an earlier task even when an upper lane is free', async () => {
  const { layoutTimeline } = await import('../scripts/timelineLayout.ts');
  const children = [0, 1, 2].map(id => ({ id: String(id), children: [] }));
  const spans = [[0, 4], [2, 9], [5, 8]];
  const bands = layoutTimeline([{ id: 'parent', children }], task => task.id === 'parent' ? null : { start: spans[Number(task.id)][0], end: spans[Number(task.id)][1] });
  assert.deepEqual(bands[0].tasks.map(p => p.lane), [0, 1, 2]);
});
