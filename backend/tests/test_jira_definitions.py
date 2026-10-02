import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from jira.definitions import parse_jira_definitions, update_jira_definitions
from space_tabs import resolved_definition_source

CONFIG = {'base_url': 'https://jira.example.com', 'email': 'one@example.com', 'token': 'secret'}

class JiraDefinitionsTests(unittest.TestCase):
    def test_plain_and_legacy(self):
        for text in ('', 'Definitions:\n    tabs:\n        main:\n            icon: 🦄\n'):
            updated = update_jira_definitions(text, CONFIG)
            config, diagnostic = parse_jira_definitions(updated)
            self.assertTrue(config.enabled)
            self.assertEqual(config.token, 'secret')
            self.assertEqual(diagnostic, [])
            self.assertEqual(resolved_definition_source('% Task', updated).count('secret'), 0)

    def test_preserves_other_sections_and_comments(self):
        source = 'tabs:\n    main:\n        icon: 🦄\n# comment\njira:\n    # connection\n    base_url: https://old.example.com\n    email: old@example.com\n    token: previous\n\npeople:\n    alice:\n        name: Alice\n'
        updated = update_jira_definitions(source, CONFIG)
        self.assertIn('tabs:\n    main:\n        icon: 🦄\n# comment\n', updated)
        self.assertIn('    # connection\n', updated)
        self.assertIn('people:\n    alice:\n        name: Alice\n', updated)
        self.assertEqual(parse_jira_definitions(updated)[0].token, 'secret')
        self.assertFalse(parse_jira_definitions(update_jira_definitions(updated, dict.fromkeys(CONFIG, '')))[0].enabled)

    def test_invalid_and_duplicates_never_expose_values(self):
        for source in ('jira:\n    token: hidden', 'jira:\n    unexpected: hidden', 'jira:\n    token: hidden\njira:\n    token: another'):
            config, diagnostic = parse_jira_definitions(source)
            self.assertFalse(config.enabled)
            self.assertTrue(diagnostic)
            self.assertNotIn('hidden', ' '.join(diagnostic))
        for key, value in [('base_url', 'javascript:secret'), ('email', 'bad'), ('token', 'line\nvalue')]:
            with self.assertRaises(ValueError): update_jira_definitions('', {**CONFIG, key: value})

    def test_nested_task_metadata_is_ignored(self):
        config, _ = parse_jira_definitions('% Task\n    jira:\n        token: secret\n')
        self.assertFalse(config.enabled)
