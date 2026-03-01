import io
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.error import HTTPError

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from jira.client import (
    JiraClient,
    build_issue_type_hierarchy_levels,
    from_adf,
    normalize_project_issue_types,
    to_adf,
)


class JiraClientTests(unittest.TestCase):
    def setUp(self):
        self.client = JiraClient("https://jira.example.com/", "user@example.com", "token")

    def test_request_success_json_and_empty_body(self):
        response = Mock()
        response.getcode.return_value = 200
        response.read.return_value = b'{"ok": true}'
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)

        with patch("jira.client.urlopen", return_value=response) as mocked_urlopen:
            data, status = self.client._request("GET", "/rest/api/3/test")

        self.assertEqual(status, 200)
        self.assertEqual(data, {"ok": True})
        mocked_urlopen.assert_called_once()

        no_body = Mock()
        no_body.getcode.return_value = 204
        no_body.read.return_value = b""
        no_body.__enter__ = Mock(return_value=no_body)
        no_body.__exit__ = Mock(return_value=False)
        with patch("jira.client.urlopen", return_value=no_body):
            data, status = self.client._request("PUT", "/rest/api/3/test", {"x": 1})
        self.assertIsNone(data)
        self.assertEqual(status, 204)

    def test_request_http_error_raises_runtime_error(self):
        error = HTTPError(
            url="https://jira.example.com/rest/api/3/test",
            code=400,
            msg="Bad Request",
            hdrs=None,
            fp=io.BytesIO(b'{"errorMessages":["bad input"]}'),
        )
        with patch("jira.client.urlopen", side_effect=error):
            with self.assertRaisesRegex(RuntimeError, "Jira API error 400"):
                self.client._request("POST", "/rest/api/3/test", {"bad": True})

    def test_get_issue_handles_success_and_failure(self):
        with patch.object(self.client, "_request", return_value=({"key": "KAN-1"}, 200)) as mocked:
            data, status = self.client.get_issue("KAN-1")
        self.assertEqual(data, {"key": "KAN-1"})
        self.assertEqual(status, 200)
        method, path = mocked.call_args.args
        self.assertEqual(method, "GET")
        self.assertIn("timeoriginalestimate", path)
        self.assertIn("timetracking", path)

        with patch.object(self.client, "_request", side_effect=RuntimeError("boom")):
            data, status = self.client.get_issue("KAN-1")
        self.assertIsNone(data)
        self.assertIsNone(status)

    def test_create_issue_builds_payload_and_optional_fields(self):
        with patch.object(
            self.client,
            "_request",
            return_value=({"key": "KAN-9", "id": "123"}, 201),
        ) as mocked:
            key, status, result = self.client.create_issue(
                "KAN",
                "Summary",
                "Line 1\n- item",
                labels=["a", "b"],
                issue_type="Sub-task",
                parent_key="KAN-1",
                assignee_id="acct-1",
                original_estimate_minutes=120,
            )
        self.assertEqual((key, status), ("KAN-9", 201))
        self.assertEqual(result["id"], "123")
        method, path, payload = mocked.call_args.args
        self.assertEqual((method, path), ("POST", "/rest/api/3/issue"))
        self.assertEqual(payload["fields"]["project"], {"key": "KAN"})
        self.assertEqual(payload["fields"]["summary"], "Summary")
        self.assertEqual(payload["fields"]["issuetype"], {"name": "Sub-task"})
        self.assertEqual(payload["fields"]["labels"], ["a", "b"])
        self.assertEqual(payload["fields"]["parent"], {"key": "KAN-1"})
        self.assertEqual(payload["fields"]["assignee"], {"accountId": "acct-1"})
        self.assertEqual(
            payload["fields"]["timetracking"], {"originalEstimate": "120m"}
        )
        self.assertEqual(payload["fields"]["description"]["type"], "doc")

    def test_update_issue_builds_payload_clear_assignee_and_handles_failure(self):
        with patch.object(self.client, "_request", return_value=({}, 204)) as mocked:
            status, result = self.client.update_issue(
                "KAN-1",
                summary="Renamed",
                description="Body",
                labels=["x"],
                assignee_id="acct-1",
                clear_assignee=True,
                original_estimate_minutes=60,
            )
        self.assertEqual(status, 204)
        self.assertEqual(result, {})
        method, path, payload = mocked.call_args.args
        self.assertEqual((method, path), ("PUT", "/rest/api/3/issue/KAN-1"))
        self.assertEqual(payload["fields"]["summary"], "Renamed")
        self.assertEqual(payload["fields"]["labels"], ["x"])
        self.assertIsNone(payload["fields"]["assignee"])
        self.assertEqual(
            payload["fields"]["timetracking"], {"originalEstimate": "60m"}
        )
        self.assertEqual(payload["fields"]["description"]["type"], "doc")

        with patch.object(self.client, "_request", side_effect=RuntimeError("boom")):
            status, result = self.client.update_issue("KAN-1", summary="x")
        self.assertIsNone(status)
        self.assertIsNone(result)

    def test_update_issue_can_clear_original_estimate_with_null(self):
        with patch.object(self.client, "_request", return_value=({}, 204)) as mocked:
            status, result = self.client.update_issue(
                "KAN-1",
                original_estimate_minutes=None,
            )
        self.assertEqual(status, 204)
        self.assertEqual(result, {})
        method, path, payload = mocked.call_args.args
        self.assertEqual((method, path), ("PUT", "/rest/api/3/issue/KAN-1"))
        self.assertEqual(payload["fields"]["timetracking"], {"originalEstimate": None})

    def test_get_project_statuses_dedupes_and_validates_shape(self):
        api_payload = [
            {"statuses": [{"name": "To Do"}, {"name": "Done"}]},
            {"statuses": [{"name": "Done"}, {"name": "In Progress"}]},
            "ignored",
        ]
        with patch.object(self.client, "_request", return_value=(api_payload, 200)) as mocked:
            names, status = self.client.get_project_statuses("KAN")
        self.assertEqual(status, 200)
        self.assertEqual(names, ["Done", "In Progress", "To Do"])
        mocked.assert_called_once_with("GET", "/rest/api/3/project/KAN/statuses")

        with patch.object(self.client, "_request", return_value=({"bad": True}, 200)):
            names, status = self.client.get_project_statuses("KAN")
        self.assertIsNone(names)
        self.assertEqual(status, 200)

    def test_get_projects_normalizes_shape(self):
        payload = {
            "values": [
                {"id": "1", "key": "kan", "name": "Kanban", "projectTypeKey": "software"},
                {"id": 2, "key": "OPS", "name": "Operations"},
                {"key": "", "name": "ignored"},
                "ignored",
            ]
        }
        with patch.object(self.client, "_request", return_value=(payload, 200)) as mocked:
            projects, status = self.client.get_projects(max_results=50)
        self.assertEqual(status, 200)
        self.assertEqual(
            projects,
            [
                {
                    "id": "1",
                    "key": "KAN",
                    "name": "Kanban",
                    "project_type": "software",
                },
                {
                    "id": "2",
                    "key": "OPS",
                    "name": "Operations",
                },
            ],
        )
        mocked.assert_called_once_with("GET", "/rest/api/3/project/search?maxResults=50")

        with patch.object(self.client, "_request", return_value=({"bad": True}, 200)):
            projects, status = self.client.get_projects()
        self.assertIsNone(projects)
        self.assertEqual(status, 200)

    def test_get_project_issue_type_hierarchy_uses_project_issue_types(self):
        payload = {
            "issueTypes": [
                {"id": "10000", "name": "Task", "hierarchyLevel": 0, "subtask": False},
                {"id": "10001", "name": "Epic", "hierarchyLevel": 1, "subtask": False},
                {"id": "10002", "name": "Sub-task", "hierarchyLevel": -1, "subtask": True},
            ]
        }
        with patch.object(self.client, "_request", return_value=(payload, 200)) as mocked:
            issue_types, status = self.client.get_project_issue_type_hierarchy("KAN")
        self.assertEqual(status, 200)
        self.assertEqual(
            [item["name"] for item in issue_types],
            ["Epic", "Task", "Sub-task"],
        )
        self.assertEqual(
            [item["hierarchy_level"] for item in issue_types],
            [1, 0, -1],
        )
        method, path = mocked.call_args.args
        self.assertEqual(method, "GET")
        self.assertIn("/rest/api/3/project/KAN?expand=issueTypes", path)

    def test_get_project_issue_type_hierarchy_falls_back_to_statuses(self):
        with patch.object(
            self.client,
            "_request",
            side_effect=[
                ({}, 200),
                (
                    [
                        {"id": "3", "name": "Bug", "subtask": False},
                        {"id": "5", "name": "Sub-task", "subtask": True},
                    ],
                    200,
                ),
            ],
        ):
            issue_types, status = self.client.get_project_issue_type_hierarchy("KAN")
        self.assertEqual(status, 200)
        self.assertEqual(
            issue_types,
            [
                {"id": "3", "name": "Bug", "hierarchy_level": 0, "is_subtask": False},
                {
                    "id": "5",
                    "name": "Sub-task",
                    "hierarchy_level": -1,
                    "is_subtask": True,
                },
            ],
        )

    def test_issue_type_helpers_normalize_and_build_levels(self):
        normalized = normalize_project_issue_types(
            [
                {"name": "Story", "hierarchyLevel": 0},
                {"name": "Task", "hierarchyLevel": 0},
                {"name": "Epic", "hierarchyLevel": 1},
                {"name": "Sub-task", "subtask": True},
            ]
        )
        levels = build_issue_type_hierarchy_levels(normalized)
        self.assertEqual([item["issue_type"] for item in levels], ["Epic", "Task", "Sub-task"])
        self.assertEqual([item["hierarchy_level"] for item in levels], [1, 0, -1])

    def test_search_users_encodes_query_and_validates_shape(self):
        with patch.object(self.client, "_request", return_value=([{"accountId": "1"}], 200)) as mocked:
            users, status = self.client.search_users("Jane Doe", max_results=10)
        self.assertEqual(users, [{"accountId": "1"}])
        self.assertEqual(status, 200)
        method, path = mocked.call_args.args
        self.assertEqual(method, "GET")
        self.assertIn("query=Jane%20Doe", path)
        self.assertIn("maxResults=10", path)

        with patch.object(self.client, "_request", return_value=({"bad": True}, 200)):
            users, status = self.client.search_users("Jane")
        self.assertIsNone(users)
        self.assertEqual(status, 200)

    def test_transition_issue_happy_path_and_missing_target(self):
        transitions_payload = {
            "transitions": [
                {"id": "11", "to": {"name": "To Do"}},
                {"id": "22", "to": {"name": "In Progress"}},
            ]
        }
        with patch.object(
            self.client,
            "_request",
            side_effect=[(transitions_payload, 200), ({"ok": True}, 204)],
        ) as mocked:
            status, result = self.client.transition_issue("KAN-1", "in progress")
        self.assertEqual(status, 204)
        self.assertEqual(result, {"ok": True})
        self.assertEqual(mocked.call_args_list[0].args, ("GET", "/rest/api/3/issue/KAN-1/transitions"))
        self.assertEqual(
            mocked.call_args_list[1].args,
            ("POST", "/rest/api/3/issue/KAN-1/transitions", {"transition": {"id": "22"}}),
        )

        with patch.object(self.client, "_request", return_value=({"transitions": []}, 200)):
            status, result = self.client.transition_issue("KAN-1", "Done")
        self.assertIsNone(status)
        self.assertIsNone(result)

        with patch.object(self.client, "_request", side_effect=RuntimeError("boom")):
            status, result = self.client.transition_issue("KAN-1", "Done")
        self.assertIsNone(status)
        self.assertIsNone(result)

    def test_adf_checkbox_conversion_accepts_empty_labels(self):
        adf = to_adf("[ ]\n[x]\n[ ] named")
        self.assertEqual(adf["type"], "doc")
        self.assertEqual(len(adf["content"]), 1)
        task_list = adf["content"][0]
        self.assertEqual(task_list["type"], "taskList")
        items = task_list["content"]
        self.assertEqual(len(items), 3)
        self.assertEqual(items[0]["attrs"]["state"], "TODO")
        self.assertEqual(items[0]["content"], [{"type": "text", "text": ""}])
        self.assertEqual(items[1]["attrs"]["state"], "DONE")
        self.assertEqual(items[1]["content"], [{"type": "text", "text": ""}])
        self.assertEqual(from_adf(adf), "[ ]\n[x]\n[ ] named")


if __name__ == "__main__":
    unittest.main()
