import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpaceJira } from '../scripts/jiraDefinitions.ts';
import { renameSlugInWholeFile } from '../scripts/slugRenameModal.ts';
import { formatTaskScript } from '../scripts/formatter.ts';
const source = 'jira:\n    base_url: https://jira.example.com\n    email: user@example.com\n    token: #old\ntags:\n    old:\n        name: Old\n';
test('space Jira validates plain/legacy metadata and omits secrets from diagnostics', () => {
  assert.equal(parseSpaceJira(source).configured, true);
  assert.equal(parseSpaceJira('Definitions:\n' + source.split('\n').map(line => '    '+line).join('\n')).configured, true);
  const invalid = parseSpaceJira('jira:\n    token: SECRET');
  assert.equal(invalid.configured, false);
  assert.doesNotMatch(invalid.diagnostics.join(' '), /SECRET/);
  assert.equal(parseSpaceJira('% Task\n    jira:\n        token: SECRET').configured, false);
});
test('slug rename and formatting preserve Jira properties', () => {
  const renamed = renameSlugInWholeFile(source, { kind: 'tag', prefix: '#', oldSlug: 'old', newSlug: 'new' }).text;
  assert.match(renamed, /token: #old/);
  assert.match(renamed, /new:/);
  assert.match(formatTaskScript(source), /token: #old/);
});

test('daemon visibility and autostart flags validate without exposing credentials', async () => {
  const { jiraViewOptions } = await import('../scripts/jiraDefinitions.ts');
  const source = 'jira:\n    base_url: https://jira.example.com\n    email: a@example.com\n    token: SECRET\n    autostart: true\n    show_logs: false\n    show_cache: true\n';
  assert.equal(parseSpaceJira(source).configured, true);
  assert.deepEqual(jiraViewOptions(source), { autostart: true, show_logs: false, show_cache: true });
  assert.equal(parseSpaceJira(source.replace('show_cache: true', 'show_cache: invalid')).configured, false);
});
