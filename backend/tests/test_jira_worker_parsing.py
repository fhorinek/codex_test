import sys
import unittest
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from jira.worker import (
    assign_space_task_parents,
    build_reference_maps,
    build_jira_entity,
    build_space_entity,
    convert_description_to_jira,
    find_space_task_by_key,
    normalize_description_for_space,
    parse_space_tasks,
    parse_tasks,
)


class JiraWorkerParsingTests(unittest.TestCase):
    def test_parse_space_tasks_extracts_fields_and_project_hint(self):
        lines = [
            "% [KAN] Planned task",
            "!todo #backend ~2 @maya",
            "details {KAN-2}",
        ]
        tasks = parse_space_tasks(lines)
        self.assertEqual(len(tasks), 1)
        task = tasks[0]
        self.assertIsNone(task.jira_key)
        self.assertEqual(task.jira_project, "KAN")
        self.assertEqual(task.title, "Planned task")
        self.assertEqual(task.token_line_indices, [1])
        self.assertEqual(task.state, "todo")
        self.assertIn("backend", task.tags)
        self.assertIn("maya", task.people)
        self.assertEqual(task.story_points, 2.0)
        self.assertEqual(task.description, "!todo #backend ~2 @maya\ndetails {KAN-2}")

    def test_parse_space_tasks_stops_at_blank_line_and_finds_by_key(self):
        lines = [
            "% [KAN-1] First",
            "line one",
            "",
            "% [KAN-2] Second",
            "line two",
        ]
        tasks = parse_space_tasks(lines)
        self.assertEqual([task.jira_key for task in tasks], ["KAN-1", "KAN-2"])
        self.assertEqual(tasks[0].description, "line one")
        self.assertEqual(tasks[1].description, "line two")
        self.assertEqual(find_space_task_by_key(tasks, "KAN-2"), tasks[1])
        self.assertIsNone(find_space_task_by_key(tasks, "KAN-9"))

    def test_assign_space_task_parents_uses_indentation(self):
        lines = [
            "% [KAN-1] Root",
            "  % [KAN-2] Child A",
            "    % [KAN-3] Grandchild",
            "  % [KAN-4] Child B",
            "% [KAN-5] Root 2",
        ]
        tasks = parse_space_tasks(lines)
        assign_space_task_parents(tasks)
        parent_by_key = {task.jira_key: task.parent_index for task in tasks}
        line_by_key = {task.jira_key: task.line_index for task in tasks}
        self.assertIsNone(parent_by_key["KAN-1"])
        self.assertEqual(parent_by_key["KAN-2"], line_by_key["KAN-1"])
        self.assertEqual(parent_by_key["KAN-3"], line_by_key["KAN-2"])
        self.assertEqual(parent_by_key["KAN-4"], line_by_key["KAN-1"])
        self.assertIsNone(parent_by_key["KAN-5"])

    def test_reference_maps_and_description_conversion_helpers(self):
        lines = [
            "% [KAN-1] Alpha",
            "refs {KAN-2}",
            "% [KAN-2] Beta",
            "!todo",
            "% [KAN-3] Alpha",
            "duplicate title should not override first mapping",
        ]
        tasks = parse_space_tasks(lines)
        key_to_title, title_to_key = build_reference_maps(tasks)
        self.assertEqual(key_to_title["KAN-1"], "Alpha")
        self.assertEqual(key_to_title["KAN-2"], "Beta")
        self.assertEqual(title_to_key["alpha"], "KAN-1")
        self.assertEqual(title_to_key["beta"], "KAN-2")

        normalized = normalize_description_for_space(
            "line {KAN-2}\n#tag @maya\n!todo\nplain",
            key_to_title,
        )
        self.assertEqual(normalized, "line {Beta}\nplain")

        converted = convert_description_to_jira(
            "link {Beta} and unknown {Something Else}",
            title_to_key,
        )
        self.assertEqual(converted, "link {KAN-2} and unknown {Something Else}")

    def test_build_space_entity_normalizes_tokens_and_links(self):
        lines = [
            "% [KAN-1] Parent",
            "% [KAN-2] Child",
            "!todo #backend #backend @maya ~2",
            "depends on {KAN-1}",
        ]
        tasks = parse_space_tasks(lines)
        key_to_title, title_to_key = build_reference_maps(tasks)
        child = next(task for task in tasks if task.jira_key == "KAN-2")
        entity = build_space_entity(child, key_to_title, title_to_key)
        self.assertEqual(entity.key, "KAN-2")
        self.assertEqual(entity.title, "Child")
        self.assertEqual(entity.state, "todo")
        self.assertEqual(entity.tags, ["backend"])
        self.assertEqual(entity.owner, "maya")
        self.assertEqual(entity.description, "depends on {Parent}")
        self.assertEqual(entity.linked, ["KAN-1"])
        self.assertEqual(entity.story_points, 2.0)

    def test_parse_space_tasks_reads_state_and_estimate_from_any_body_line(self):
        lines = [
            "% [KAN-1] Task",
            "body !done ~3 #backend @maya",
        ]
        tasks = parse_space_tasks(lines)
        self.assertEqual(len(tasks), 1)
        task = tasks[0]
        self.assertEqual(task.state, "done")
        self.assertEqual(task.story_points, 3.0)
        self.assertEqual(task.tags, ["backend"])
        self.assertEqual(task.people, ["maya"])
        self.assertEqual(task.description, "body !done ~3 #backend @maya")

    def test_build_jira_entity_maps_original_estimate_to_story_points(self):
        issue = {
            "key": "KAN-7",
            "fields": {
                "summary": "Task",
                "description": "desc",
                "status": {"name": "Todo"},
                "labels": [],
                "assignee": None,
                "timeoriginalestimate": 5400,
            },
        }
        entity, state_added, person_added = build_jira_entity(
            issue,
            {},
            {},
            {},
            [],
            {},
            [],
        )
        self.assertEqual(entity.key, "KAN-7")
        self.assertEqual(entity.story_points, 1.5)
        self.assertEqual(entity.description, "desc")
        self.assertTrue(state_added)
        self.assertFalse(person_added)

    def test_parse_tasks_detects_token_line_and_description_range(self):
        lines = [
            "% [KAN-1] Task",
            "!todo #tag1 ~3 @maya",
            "desc line",
            "% [KAN-2] Task 2",
            "description starts immediately",
        ]
        tasks = parse_tasks(lines)
        self.assertEqual(len(tasks), 2)
        first, second = tasks
        self.assertEqual(first.jira_key, "KAN-1")
        self.assertEqual(first.token_line_index, 1)
        self.assertEqual(first.state, "todo")
        self.assertEqual(first.tags, ["tag1"])
        self.assertEqual(first.people, ["maya"])
        self.assertEqual(first.description, "desc line")
        self.assertIsNone(second.token_line_index)
        self.assertEqual(second.description, "description starts immediately")

    def test_build_space_entity_reads_story_points_from_token_line(self):
        lines = [
            "% [KAN-1] Task",
            "!todo #tag ~1.5 @maya",
            "body line",
        ]
        tasks = parse_space_tasks(lines)
        key_to_title, title_to_key = build_reference_maps(tasks)
        entity = build_space_entity(tasks[0], key_to_title, title_to_key)
        self.assertEqual(entity.story_points, 1.5)
        self.assertEqual(entity.description, "body line")


if __name__ == "__main__":
    unittest.main()
