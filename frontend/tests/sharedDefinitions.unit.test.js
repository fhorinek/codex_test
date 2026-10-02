const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseTasks } = require('../scripts/task.ts');
const { parseTabAppearance } = require('../scripts/spaceTabs.ts');
const { plainDefinitions } = require('../scripts/definitionsSource.ts');
const { renameSlugInWholeFile, definitionScopeFor, removeSlugDefinition } = require('../scripts/slugRenameModal.ts');
const shared = 'Definitions:\n    tags:\n        hot:\n            name: Urgent\n            color: #ff0000\n            background: #222222\n    people:\n        anna:\n            email: anna@example.com\n    states:\n        review:\n            name: Review\n';
test('local definitions create a missing tab-named root and preserve task text', () => {
  for (const [kind, prefix, section] of [['tag', '#', 'tags'], ['person', '@', 'people'], ['state', '!', 'states']]) {
    const body = `% Task\n${prefix}entry\n    % Child\n    notes\n`;
    const edited = renameSlugInWholeFile(body, { kind, prefix, oldSlug: 'entry', newSlug: 'entry', metadata: { name: 'Entry' }, rootName: 'release' });
    assert.ok(edited.text.startsWith(`release:\n    ${section}:`));
    assert.ok(edited.text.endsWith(body));
    const parsed = parseTasks(edited.text);
    assert.equal(parsed.config.boardName, 'release');
    assert.equal(parsed.config[section].find(entry => entry.key === 'entry').name, 'Entry');
    const existing = renameSlugInWholeFile(`Existing:\n${body}`, { kind, prefix, oldSlug: 'entry', newSlug: 'entry', metadata: { name: 'Entry' }, rootName: 'release' });
    assert.ok(existing.text.startsWith('Existing:\n'));
  }
  const flat = renameSlugInWholeFile('tags:\n    old:\n        name: Old\n% Task\n#old\n', { kind: 'tag', prefix: '#', oldSlug: 'old', newSlug: 'new', metadata: { name: 'New' }, rootName: 'release' });
  assert.equal(parseTasks(flat.text).config.boardName, 'release');
  assert.ok(flat.text.endsWith('% Task\n#new\n'));
  assert.equal(parseTasks(flat.text).tagMeta.get('#new').name, 'New');
});
test('headerless definitions resolve and edit without adding a header or shifting task offsets', () => {
  const plain = plainDefinitions(shared);
  assert.ok(plain.startsWith('tags:\n'));
  const parsed = parseTasks('% Task\n#hot @anna !review', plain);
  assert.equal(parsed.allTasks[0].lineIndex, 0);
  assert.equal(parsed.tagMeta.get('#hot').background, '#222222');
  assert.equal(parsed.peopleMeta.get('@anna').email, 'anna@example.com');
  const edited = renameSlugInWholeFile(plain, { kind: 'tag', prefix: '#', oldSlug: 'hot', newSlug: 'warm', metadata: { background: '#123456' } });
  assert.ok(edited.text.startsWith('tags:\n'));
  assert.doesNotMatch(edited.text, /Definitions:/);
  assert.equal(parseTasks('% Task\n#warm', edited.text).tagMeta.get('#warm').background, '#123456');
  assert.equal(parseTabAppearance('tabs:\n    main:\n        icon: 🦄\n        color: #123456').entries.main.color, '#123456');
});
test('scope defaults prefer explicit local definitions and moving removes only that entry', () => {
  const local = 'Board:\n    tags:\n        hot:\n            background: #123456\n        other:\n            name: Other\n    people:\n        anna:\n            email: local@example.com\n    states:\n        todo:\n            name: Local todo\n% Task\n#hot @anna !todo\n';
  for (const [kind, slug] of [['tag', 'hot'], ['person', 'anna'], ['state', 'todo']]) assert.equal(definitionScopeFor(local, kind, slug), 'local');
  for (const [kind, slug] of [['tag', 'new'], ['person', 'new'], ['state', 'todo']]) assert.equal(definitionScopeFor('% Task', kind, slug), 'shared');
  const removed = removeSlugDefinition(local, 'tag', 'hot');
  assert.doesNotMatch(removed, /        hot:/);
  assert.match(removed, /        other:\n            name: Other/);
  assert.ok(removed.endsWith('% Task\n#hot @anna !todo\n'));
  const plain = removeSlugDefinition(plainDefinitions(shared), 'tag', 'hot');
  assert.doesNotMatch(plain, /Definitions:|    hot:/);
  assert.match(plain, /people:\n    anna:/);
});
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
test('shared slug rename preserves local override properties', () => {
  const source = 'Board:\n    tags:\n        hot:\n            background: #ffffff\n% Task\n#hot';
  const result = renameSlugInWholeFile(source, { kind: 'tag', prefix: '#', oldSlug: 'hot', newSlug: 'urgent', metadata: undefined });
  assert.match(result.text, /urgent:\n            background: #ffffff/);
  assert.match(result.text, /% Task\n#urgent/);
});
