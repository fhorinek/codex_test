import unittest

from jira.space import (
    add_people_to_line,
    add_reference_to_description,
    add_tags_to_line,
    extract_linked_keys,
    remove_tags_from_line,
    set_state_in_line,
)
from jira.worker import parse_space_tasks


class JiraSpaceTaskModificationTests(unittest.TestCase):
    def _unique(self, values):
        return sorted(set(values or []))

    def _parse_single_task(self, lines):
        tasks = parse_space_tasks(lines)
        self.assertEqual(len(tasks), 1, "expected exactly one parsed task")
        task = tasks[0]
        self.assertEqual(task.jira_key, "KAN-1")
        return task

    def _replace_task_body(self, lines, task, description):
        token_lines = [
            lines[index]
            for index in task.token_line_indices
            if 0 <= index < len(lines)
        ]
        new_body = list(token_lines)
        if description:
            new_body.extend(description.split("\n"))
        lines[task.body_start:task.body_end] = new_body

    # Starts from a space task token line and verifies adding a tag updates parsed task tags.
    def test_add_tag_from_space_text_task(self):
        lines = [
            "% [JIRA:KAN-1] Sync task",
            "!todo #backend",
        ]
        task = self._parse_single_task(lines)
        token_line_index = task.token_line_indices[0]

        lines[token_line_index] = add_tags_to_line(lines[token_line_index], ["urgent"])

        updated = self._parse_single_task(lines)
        self.assertEqual(self._unique(updated.tags), ["backend", "urgent"])

    # Starts from a space task token line and verifies removing a tag keeps remaining tokens untouched.
    def test_remove_tag_from_space_text_task(self):
        lines = [
            "% [JIRA:KAN-1] Sync task",
            "!todo #backend #urgent @maya",
        ]
        task = self._parse_single_task(lines)
        token_line_index = task.token_line_indices[0]

        lines[token_line_index] = remove_tags_from_line(lines[token_line_index], ["backend"])

        updated = self._parse_single_task(lines)
        self.assertEqual(self._unique(updated.tags), ["urgent"])
        self.assertEqual(self._unique(updated.people), ["maya"])
        self.assertEqual(updated.state, "todo")

    # Starts from a space task token line and verifies adding people and changing state are reflected in parsed task data.
    def test_add_people_and_set_state_from_space_text_task(self):
        lines = [
            "% [JIRA:KAN-1] Sync task",
            "!todo #backend",
        ]
        task = self._parse_single_task(lines)
        token_line_index = task.token_line_indices[0]

        line = lines[token_line_index]
        line = add_people_to_line(line, ["maya", "sam"])
        line = set_state_in_line(line, "inprogress")
        lines[token_line_index] = line

        updated = self._parse_single_task(lines)
        self.assertEqual(updated.state, "inprogress")
        self.assertEqual(self._unique(updated.tags), ["backend"])
        self.assertEqual(self._unique(updated.people), ["maya", "sam"])

    # Starts from a space task description, adds a reference, writes it back to task body, and verifies linked Jira key extraction.
    def test_add_reference_from_space_text_task_description(self):
        lines = [
            "% [JIRA:KAN-1] Sync task",
            "!todo #backend",
        ]
        task = self._parse_single_task(lines)

        updated_description = add_reference_to_description(task.description, "Release Plan")
        self._replace_task_body(lines, task, updated_description)

        updated_task = self._parse_single_task(lines)
        self.assertEqual(updated_task.description, "{Release Plan}")
        linked = extract_linked_keys(
            updated_task.description,
            {"release plan": "KAN-99"},
        )
        self.assertEqual(linked, ["KAN-99"])


if __name__ == "__main__":
    unittest.main()
