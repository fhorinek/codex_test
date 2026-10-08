import json
import sys
import unittest
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import y_py as Y
import server
from jira import space


class YDocTransactionTests(unittest.TestCase):
    def test_shared_values_can_be_published(self):
        for update in (server.set_system_shared_map_values, space.set_shared_map_values):
            with self.subTest(update=update.__module__):
                doc = Y.YDoc()
                self.assertTrue(update(doc, {"build": "test", "presence": {}}))
                shared = doc.get_map(server.SYSTEM_SHARED_MAP_NAME)
                self.assertEqual(shared.get("build"), "test")
                self.assertEqual(json.loads(shared.get("presence")), {})

    def test_document_text_can_be_replaced_and_cleared(self):
        for replace in (server.replace_ydoc_text, space.replace_ydoc_text):
            with self.subTest(replace=replace.__module__):
                doc = Y.YDoc()
                for content in ("first", "replacement", ""):
                    replace(doc, content)
                    self.assertEqual(str(doc.get_text("content")), content)

    def test_distant_edits_retain_middle_text_and_use_one_transaction(self):
        for replace in (server.replace_ydoc_text, space.replace_ydoc_text):
            doc = Y.YDoc(); text = doc.get_text('content')
            original = '% First\n!todo\n% Unchanged\nkeep cursor here\n% Last\n!todo\n'
            replace(doc, original)
            deltas = []
            text.observe(lambda event: deltas.append(event.delta))
            target = original.replace('!todo', '!done')
            replace(doc, target)
            self.assertEqual(str(text), target)
            self.assertEqual(len(deltas), 1)
            self.assertTrue(any(item.get('retain', 0) >= len('\n% Unchanged\nkeep cursor here\n% Last\n!') for item in deltas[0]))
            replace(doc, target)
            self.assertEqual(len(deltas), 1)

    def test_unicode_insert_delete_and_legacy_json_normalization(self):
        for replace in (server.replace_ydoc_text, space.replace_ydoc_text):
            doc = Y.YDoc()
            for content in ('% Žltý 🦄\n!todo\nčlovek\n', '% Žltý 🦄\n!inprogress\nčlovek\n', '% Žltý 🦄\nčlovek\n', '🥤\n% Žltý 🦄\nčlovek\n', ''):
                replace(doc, content)
                self.assertEqual(str(doc.get_text('content')), content)
            encoded = json.dumps('% Žltý 🦄\nbody')
            with doc.begin_transaction() as transaction:
                doc.get_text('content').insert(transaction, 0, encoded)
            replace(doc, encoded)
            self.assertEqual(str(doc.get_text('content')), '% Žltý 🦄\nbody')
