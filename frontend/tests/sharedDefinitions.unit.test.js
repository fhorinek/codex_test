const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseTasks } = require('../scripts/task.ts');
const { parseTabAppearance } = require('../scripts/spaceTabs.ts');
const shared = 'Definitions:\n    tags:\n        hot:\n            name: Urgent\n            color: #ff0000\n            background: #222222\n    people:\n        anna:\n            email: anna@example.com\n    states:\n        review:\n            name: Review\n';
test('shared metadata resolves explicit properties without moving source lines', () => {
  const source = 'Board:\n    tags:\n        hot:\n            background: #ffffff\n% Task\n#hot @anna !review\n';
  const result = parseTasks(source, shared);
  assert.equal(result.allTasks[0].lineIndex, 4);
  assert.equal(result.tagMeta.get('#hot').name, 'Urgent');
  assert.equal(result.tagMeta.get('#hot').color, '#ff0000');
  assert.equal(result.tagMeta.get('#hot').background, '#ffffff');
  assert.equal(result.peopleMeta.get('@anna').email, 'anna@example.com');
  assert.deepEqual([...result.states], ['!review']);
  assert.equal(result.invalidStateTags.size, 0);
});
test('explicit empty properties reset shared properties', () => {
  const result = parseTasks('Board:\n    tags:\n        hot:\n            background:\n% Task\n#hot', shared);
  assert.equal(result.tagMeta.get('#hot').background, '');
  assert.equal(result.tagMeta.get('#hot').name, 'Urgent');
});
test('appearance is separate from task configuration and reports invalid values', () => {
  const text = 'Definitions:\n    tabs:\n        main:\n            icon: 🦄\n            color: #123456\n        bad:\n            icon: 🐶🐱\n            color: nope\n% Invalid';
  const parsed = parseTabAppearance(text);
  assert.equal(parsed.entries.main.icon, '🦄');
  assert.equal(parsed.entries.main.color, '#123456');
  assert.equal(parsed.entries.bad.icon, '🐶🐱');
  assert.equal(parsed.diagnostics.length, 2);
  assert.equal(parseTasks(text).tags.size, 0);
});
test('tab icons accept manually entered text and empty values clear them', () => {
  for (const icon of ['Release candidate', '🐶🐱', 'v2: ready!', '<b>text</b>', '1️⃣']) {
    const parsed = parseTabAppearance('Definitions:\n    tabs:\n        main:\n            icon: ' + icon);
    assert.equal(parsed.entries.main.icon, icon);
    assert.deepEqual(parsed.diagnostics, []);
  }
  assert.equal(parseTabAppearance('Definitions:\n    tabs:\n        main:\n            icon:').entries.main.icon, undefined);
});
const { renameSlugInWholeFile } = require('../scripts/slugRenameModal.ts');
test('shared slug rename preserves local override properties', () => {
  const source = 'Board:\n    tags:\n        hot:\n            background: #ffffff\n% Task\n#hot';
  const result = renameSlugInWholeFile(source, { kind: 'tag', prefix: '#', oldSlug: 'hot', newSlug: 'urgent', metadata: undefined });
  assert.match(result.text, /urgent:\n            background: #ffffff/);
  assert.match(result.text, /% Task\n#urgent/);
});
