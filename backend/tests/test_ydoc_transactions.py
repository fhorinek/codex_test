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
