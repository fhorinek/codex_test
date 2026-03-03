import sys
import unittest
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from jira.space import (
    SYSTEM_SHARED_ROOM_ID,
    format_space_label,
)


class JiraSpaceLabelTests(unittest.TestCase):
    def test_format_space_label_keeps_path_like_values(self):
        self.assertEqual(format_space_label("team/jira_test"), "team/jira_test")

    def test_format_space_label_keeps_non_encoded_and_system_ids(self):
        self.assertEqual(format_space_label("jira_test"), "jira_test")
        self.assertEqual(format_space_label(SYSTEM_SHARED_ROOM_ID), SYSTEM_SHARED_ROOM_ID)


if __name__ == "__main__":
    unittest.main()
