import sys
import unittest
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from jira.worker import (
    TASK_FIELD_PEOPLE,
    TASK_FIELD_REFERENCE,
    TASK_FIELD_STATE,
    TASK_FIELD_TAG,
    TASK_MODIFY_ADD,
    TASK_MODIFY_REMOVE,
    modify_task_text,
    parse_space_tasks,
)
from jira.space import extract_linked_keys


class JiraSpaceTaskModificationTests(unittest.TestCase):
    def _parse_single_task(self, lines):
        tasks = parse_space_tasks(lines)
        self.assertEqual(len(tasks), 1, "expected exactly one parsed task")
        task = tasks[0]
        self.assertEqual(task.jira_key, "KAN-1")
        return task

    def _normalize_block(self, text):
        lines = text.strip("\n").split("\n")
        if not lines:
            return []
        shared_indent = None
        for line in lines:
            if not line.strip():
                continue
            indent = len(line) - len(line.lstrip(" "))
            shared_indent = indent if shared_indent is None else min(shared_indent, indent)
        if shared_indent and shared_indent > 0:
            lines = [line[shared_indent:] if len(line) >= shared_indent else line for line in lines]
        return lines

    def assert_space_modification(self, input_text, output_text, operation, field, values):
        input_lines = self._normalize_block(input_text)
        expected_lines = self._normalize_block(output_text)
        actual_text = modify_task_text(
            "\n".join(input_lines),
            operation,
            field,
            values,
        )
        self.assertEqual(actual_text.split("\n"), expected_lines)

    def test_add_tag_from_space_text_task(self):
        input_text = """
        % [JIRA:KAN-1] Sync task
        !todo #backend
        """
        output_text = """
        % [JIRA:KAN-1] Sync task
        !todo #backend #urgent
        """
        self.assert_space_modification(
            input_text,
            output_text,
            TASK_MODIFY_ADD,
            TASK_FIELD_TAG,
            ["urgent"],
        )

    def test_remove_tag_from_space_text_task(self):
        input_text = """
        % [JIRA:KAN-1] Sync task
        !todo #backend #urgent @maya
        """
        output_text = """
        % [JIRA:KAN-1] Sync task
        !todo #urgent @maya
        """
        self.assert_space_modification(
            input_text,
            output_text,
            TASK_MODIFY_REMOVE,
            TASK_FIELD_TAG,
            ["backend"],
        )

    def test_add_people_and_set_state_from_space_text_task(self):
        input_people = """
        % [JIRA:KAN-1] Sync task
        !todo #backend
        """
        output_people = """
        % [JIRA:KAN-1] Sync task
        !todo #backend @maya @sam
        """
        self.assert_space_modification(
            input_people,
            output_people,
            TASK_MODIFY_ADD,
            TASK_FIELD_PEOPLE,
            ["maya", "sam"],
        )

        input_state = """
        % [JIRA:KAN-1] Sync task
        !todo #backend
        """
        output_state = """
        % [JIRA:KAN-1] Sync task
        !inprogress #backend
        """
        self.assert_space_modification(
            input_state,
            output_state,
            TASK_MODIFY_ADD,
            TASK_FIELD_STATE,
            ["inprogress"],
        )

    def test_add_reference_from_space_text_task_description(self):
        input_text = """
        % [JIRA:KAN-1] Sync task
        !todo #backend
        """
        output_text = """
        % [JIRA:KAN-1] Sync task
        !todo #backend
        {Release Plan}
        """
        self.assert_space_modification(
            input_text,
            output_text,
            TASK_MODIFY_ADD,
            TASK_FIELD_REFERENCE,
            ["Release Plan"],
        )

        lines = self._normalize_block(output_text)
        updated_task = self._parse_single_task(lines)
        linked = extract_linked_keys(
            updated_task.description,
            {"release plan": "KAN-99"},
        )
        self.assertEqual(linked, ["KAN-99"])

    def test_space_modification_remove_tag_token_line(self):
        input_text = """
        % [JIRA:KAN-1] Task
        #tag1 #tag2 @fero
        description
        """
        output_text = """
        % [JIRA:KAN-1] Task
        #tag1 @fero
        description
        """
        self.assert_space_modification(
            input_text,
            output_text,
            TASK_MODIFY_REMOVE,
            TASK_FIELD_TAG,
            ["tag2"],
        )
        
    def test_space_modification_remove_tag_description_body(self):
        input_text = """
        % [JIRA:KAN-1] Task
        description
        #tag1 #tag2 @fero
        """
        output_text = """
        % [JIRA:KAN-1] Task
        description
        #tag1 @fero
        """
        self.assert_space_modification(
            input_text,
            output_text,
            TASK_MODIFY_REMOVE,
            TASK_FIELD_TAG,
            ["tag2"],
        )

    def test_space_modification_remove_people_token_line(self):
        input_text = """
        % [JIRA:KAN-1] Task
        !todo #tag1 @fero @maya
        description
        """
        output_text = """
        % [JIRA:KAN-1] Task
        !todo #tag1 @maya
        description
        """
        self.assert_space_modification(
            input_text,
            output_text,
            TASK_MODIFY_REMOVE,
            TASK_FIELD_PEOPLE,
            ["fero"],
        )

    def test_space_modification_remove_people_description_body(self):
        input_text = """
        % [JIRA:KAN-1] Task
        description
        owners @fero @maya
        """
        output_text = """
        % [JIRA:KAN-1] Task
        description
        owners @maya
        """
        self.assert_space_modification(
            input_text,
            output_text,
            TASK_MODIFY_REMOVE,
            TASK_FIELD_PEOPLE,
            ["fero"],
        )

    def test_space_modification_remove_state_token_line(self):
        input_text = """
        % [JIRA:KAN-1] Task
        !todo #tag1 @fero
        description
        """
        output_text = """
        % [JIRA:KAN-1] Task
        #tag1 @fero
        description
        """
        self.assert_space_modification(
            input_text,
            output_text,
            TASK_MODIFY_REMOVE,
            TASK_FIELD_STATE,
            [],
        )

    def test_space_modification_remove_state_description_body(self):
        input_text = """
        % [JIRA:KAN-1] Task
        description
        status !todo @fero
        """
        output_text = """
        % [JIRA:KAN-1] Task
        description
        status @fero
        """
        self.assert_space_modification(
            input_text,
            output_text,
            TASK_MODIFY_REMOVE,
            TASK_FIELD_STATE,
            [],
        )

    def test_space_modification_remove_reference_description_body(self):
        input_text = """
        % [JIRA:KAN-1] Task
        details {Release Plan} and link {KAN-2}
        {Release Plan}
        """
        output_text = """
        % [JIRA:KAN-1] Task
        details  and link {KAN-2}
        """
        self.assert_space_modification(
            input_text,
            output_text,
            TASK_MODIFY_REMOVE,
            TASK_FIELD_REFERENCE,
            ["Release Plan"],
        )


if __name__ == "__main__":
    unittest.main()
