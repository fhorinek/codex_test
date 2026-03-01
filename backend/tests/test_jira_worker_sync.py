import sys
import unittest
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from jira import worker


def _issue_payload(
    key: str,
    summary: str,
    description: str = "",
    labels=None,
    status_name=None,
    assignee=None,
    timeoriginalestimate=None,
    parent_key=None,
    issue_type="Task",
):
    labels = labels or []
    status = {"name": status_name} if status_name is not None else {}
    payload = {
        "key": key,
        "fields": {
            "summary": summary,
            "description": description,
            "status": status,
            "labels": labels,
            "assignee": assignee,
            "issuetype": {"name": issue_type},
            "issuelinks": [],
            "timeoriginalestimate": timeoriginalestimate,
        },
    }
    if parent_key:
        payload["fields"]["parent"] = {"key": parent_key}
    return payload


class JiraWorkerSyncTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        worker.space_entity_cache.clear()
        worker.jira_entity_cache.clear()
        worker.JIRA_ACCOUNT_ID_BY_EMAIL.clear()
        worker.JIRA_ISSUE_HIERARCHY_BY_PROJECT.clear()

    async def _run_sync(
        self,
        input_text,
        client,
        force_direction=None,
        space_id="sync-test",
        session_overrides=None,
        time_value=None,
    ):
        ydoc = {"text": input_text}
        writes = []
        session = SimpleNamespace(
            space_id=space_id,
            ydoc=ydoc,
            pending_change=False,
            last_content=input_text,
            ignore_until=0.0,
            last_change=0.0,
        )
        for key, value in (session_overrides or {}).items():
            setattr(session, key, value)
        if hasattr(client, "get_project_issue_type_hierarchy"):
            hierarchy_method = client.get_project_issue_type_hierarchy
            default_hierarchy = (
                [
                    {"name": "Task", "hierarchy_level": 0, "is_subtask": False},
                    {"name": "Sub-task", "hierarchy_level": -1, "is_subtask": True},
                ],
                200,
            )
            if getattr(hierarchy_method, "side_effect", None) is None and not isinstance(
                getattr(hierarchy_method, "return_value", None), tuple
            ):
                hierarchy_method.return_value = default_hierarchy

        async def fake_read(ydoc_obj):
            return ydoc_obj["text"]

        def fake_replace(ydoc_obj, content):
            ydoc_obj["text"] = content
            writes.append(content)

        async def fake_sleep(_seconds):
            return None

        async def fake_to_thread(func, *args, **kwargs):
            return func(*args, **kwargs)

        patches = [
            patch("jira.worker.read_ydoc_text", side_effect=fake_read),
            patch("jira.worker.replace_ydoc_text", side_effect=fake_replace),
            patch("jira.worker.asyncio.sleep", side_effect=fake_sleep),
            patch("jira.worker.asyncio.to_thread", side_effect=fake_to_thread),
        ]
        if time_value is not None:
            patches.append(patch("jira.worker.time.time", return_value=time_value))

        with ExitStack() as stack:
            for patcher in patches:
                stack.enter_context(patcher)
            await worker.sync_space_with_jira(
                client,
                session,
                "KAN",
                force_direction=force_direction,
            )
        return session, ydoc["text"], writes

    async def test_sync_space_with_jira_creates_pending_task_and_writes_key_back(self):
        client = Mock()
        client.create_issue.return_value = ("KAN-101", 201, {"key": "KAN-101"})
        client.get_issue.return_value = (
            _issue_payload("KAN-101", "New task", "details"),
            200,
        )
        client.update_issue.return_value = (204, {})
        client.transition_issue.return_value = (204, {})

        input_text = "\n".join(
            [
                "% [KAN] New task",
                "details",
            ]
        )

        _session, output_text, writes = await self._run_sync(input_text, client)

        self.assertEqual(
            output_text,
            "\n".join(
                [
                    "% [KAN-101] New task",
                    "details",
                ]
            ),
        )
        self.assertEqual(len(writes), 1)
        client.create_issue.assert_called_once_with(
            "KAN",
            "New task",
            "details",
            [],
            worker.JIRA_ISSUE_TYPE,
            None,
            None,
            0,
        )
        client.get_issue.assert_called_once_with("KAN-101")
        client.update_issue.assert_not_called()
        client.transition_issue.assert_not_called()

    async def test_sync_space_with_jira_skips_pending_project_marker_without_title(self):
        client = Mock()
        client.create_issue.return_value = ("KAN-999", 201, {"key": "KAN-999"})
        client.get_issue.return_value = (_issue_payload("KAN-999", "Ignored"), 200)
        client.update_issue.return_value = (204, {})
        client.transition_issue.return_value = (204, {})

        input_text = "\n".join(
            [
                "% [KAN]",
                "details without title",
            ]
        )

        _session, output_text, writes = await self._run_sync(input_text, client)

        self.assertEqual(output_text, input_text)
        self.assertEqual(writes, [])
        client.create_issue.assert_not_called()
        client.get_issue.assert_not_called()
        client.update_issue.assert_not_called()
        client.transition_issue.assert_not_called()

    async def test_sync_space_with_jira_creates_pending_child_as_subtask(self):
        client = Mock()
        client.create_issue.return_value = ("KAN-202", 201, {"key": "KAN-202"})
        client.get_issue.side_effect = [
            (_issue_payload("KAN-1", "Parent"), 200),
            (_issue_payload("KAN-202", "Child", parent_key="KAN-1"), 200),
        ]
        client.update_issue.return_value = (204, {})
        client.transition_issue.return_value = (204, {})

        input_text = "\n".join(
            [
                "% [KAN-1] Parent",
                "  % [KAN] Child",
            ]
        )

        _session, output_text, writes = await self._run_sync(
            input_text,
            client,
            space_id="sync-subtask",
        )

        self.assertEqual(
            output_text,
            "\n".join(
                [
                    "% [KAN-1] Parent",
                    "  % [KAN-202] Child",
                ]
            ),
        )
        self.assertEqual(writes, [output_text])
        client.create_issue.assert_called_once_with(
            "KAN",
            "Child",
            "",
            [],
            worker.JIRA_SUBTASK_ISSUE_TYPE,
            "KAN-1",
            None,
            0,
        )
        self.assertEqual(client.get_issue.call_count, 2)

    async def test_sync_space_with_jira_uses_hierarchy_for_issue_type_and_parent(self):
        client = Mock()
        client.get_project_issue_type_hierarchy.return_value = (
            [
                {"name": "Epic", "hierarchy_level": 1, "is_subtask": False},
                {"name": "Task", "hierarchy_level": 0, "is_subtask": False},
                {"name": "Sub-task", "hierarchy_level": -1, "is_subtask": True},
            ],
            200,
        )
        client.create_issue.side_effect = [
            ("KAN-10", 201, {"key": "KAN-10"}),
            ("KAN-11", 201, {"key": "KAN-11"}),
            ("KAN-12", 201, {"key": "KAN-12"}),
        ]
        client.get_issue.side_effect = [
            (_issue_payload("KAN-10", "Root"), 200),
            (_issue_payload("KAN-11", "Child", parent_key="KAN-10"), 200),
            (_issue_payload("KAN-12", "Leaf", parent_key="KAN-11"), 200),
        ]
        client.update_issue.return_value = (204, {})
        client.transition_issue.return_value = (204, {})

        input_text = "\n".join(
            [
                "% [KAN] Root",
                "  % [KAN] Child",
                "    % [KAN] Leaf",
            ]
        )

        _session, output_text, writes = await self._run_sync(
            input_text,
            client,
            space_id="sync-hierarchy-map",
        )

        self.assertEqual(
            output_text,
            "\n".join(
                [
                    "% [KAN-10] Root",
                    "  % [KAN-11] Child",
                    "    % [KAN-12] Leaf",
                ]
            ),
        )
        self.assertEqual(writes, [output_text])
        self.assertEqual(client.create_issue.call_count, 3)
        self.assertEqual(client.create_issue.call_args_list[0].args[4:6], ("Epic", None))
        self.assertEqual(client.create_issue.call_args_list[1].args[4:6], ("Task", "KAN-10"))
        self.assertEqual(
            client.create_issue.call_args_list[2].args[4:6],
            ("Sub-task", "KAN-11"),
        )

    async def test_sync_space_with_jira_skips_parent_for_depth_below_jira_hierarchy(self):
        client = Mock()
        client.get_project_issue_type_hierarchy.return_value = (
            [
                {"name": "Epic", "hierarchy_level": 1, "is_subtask": False},
                {"name": "Task", "hierarchy_level": 0, "is_subtask": False},
            ],
            200,
        )
        client.create_issue.side_effect = [
            ("KAN-20", 201, {"key": "KAN-20"}),
            ("KAN-21", 201, {"key": "KAN-21"}),
            ("KAN-22", 201, {"key": "KAN-22"}),
        ]
        client.get_issue.side_effect = [
            (_issue_payload("KAN-20", "Root"), 200),
            (_issue_payload("KAN-21", "Child", parent_key="KAN-20"), 200),
            (_issue_payload("KAN-22", "Leaf"), 200),
        ]
        client.update_issue.return_value = (204, {})
        client.transition_issue.return_value = (204, {})

        input_text = "\n".join(
            [
                "% [KAN] Root",
                "  % [KAN] Child",
                "    % [KAN] Leaf",
            ]
        )

        _session, output_text, writes = await self._run_sync(
            input_text,
            client,
            space_id="sync-hierarchy-overflow",
        )

        self.assertEqual(
            output_text,
            "\n".join(
                [
                    "% [KAN-20] Root",
                    "  % [KAN-21] Child",
                    "% [KAN-22] Leaf",
                ]
            ),
        )
        self.assertEqual(writes, [output_text])
        self.assertEqual(client.create_issue.call_count, 3)
        self.assertEqual(client.create_issue.call_args_list[0].args[4:6], ("Epic", None))
        self.assertEqual(client.create_issue.call_args_list[1].args[4:6], ("Task", "KAN-20"))
        self.assertEqual(client.create_issue.call_args_list[2].args[4:6], ("Task", None))

    async def test_sync_space_with_jira_pushes_space_changes_to_jira(self):
        client = Mock()
        client.get_issue.return_value = (
            _issue_payload(
                "KAN-1",
                "Remote title",
                "remote desc",
                labels=[],
            ),
            200,
        )
        client.update_issue.return_value = (204, {})
        client.transition_issue.return_value = (204, {})
        client.create_issue.return_value = (None, None, None)

        input_text = "\n".join(
            [
                "% [KAN-1] Local title",
                "#backend",
                "local desc",
            ]
        )

        _session, output_text, writes = await self._run_sync(
            input_text,
            client,
            force_direction="push",
            space_id="sync-push",
        )

        self.assertEqual(output_text, input_text)
        self.assertEqual(writes, [])
        client.get_issue.assert_called_once_with("KAN-1")
        client.update_issue.assert_called_once()
        args = client.update_issue.call_args.args
        self.assertEqual(
            args[:-1],
            ("KAN-1", "Local title", "local desc", ["backend"], None, False),
        )
        self.assertIs(args[-1], worker.JIRA_ESTIMATE_UNSET)
        client.transition_issue.assert_not_called()
        client.create_issue.assert_not_called()

    async def test_sync_space_with_jira_pushes_state_via_transition(self):
        client = Mock()
        client.get_issue.return_value = (
            _issue_payload(
                "KAN-1",
                "Task",
                "",
                labels=[],
                status_name="To Do",
            ),
            200,
        )
        client.update_issue.return_value = (204, {})
        client.transition_issue.return_value = (204, {})
        client.create_issue.return_value = (None, None, None)

        input_text = "\n".join(
            [
                "Board:",
                "    states:",
                "        todo:",
                "            jira: To Do",
                "        done:",
                "            jira: Done",
                "",
                "% [KAN-1] Task",
                "!done",
            ]
        )

        _session, output_text, writes = await self._run_sync(
            input_text,
            client,
            force_direction="push",
            space_id="sync-push-state",
        )

        self.assertEqual(output_text, input_text)
        self.assertEqual(writes, [])
        client.get_issue.assert_called_once_with("KAN-1")
        client.update_issue.assert_not_called()
        client.transition_issue.assert_called_once_with("KAN-1", "Done")

    async def test_sync_space_with_jira_marks_recent_field_dirty_and_skips_push(self):
        client = Mock()
        client.get_issue.return_value = (
            _issue_payload("KAN-1", "Remote title", "body"),
            200,
        )

        input_text = "\n".join(
            [
                "% [KAN-1] Local title",
                "body",
            ]
        )

        session, output_text, writes = await self._run_sync(
            input_text,
            client,
            space_id="sync-dirty-skip",
            session_overrides={
                "pending_change": True,
                "last_content": "older content",
                "ignore_until": 0.0,
                "last_change": 0.0,
            },
            time_value=100.0,
        )

        self.assertEqual(output_text, input_text)
        self.assertEqual(writes, [])
        self.assertEqual(session.last_change, 100.0)
        self.assertTrue(getattr(session, "sync_dirty", False))
        client.get_issue.assert_called_once_with("KAN-1")
        client.create_issue.assert_not_called()
        client.update_issue.assert_not_called()
        client.transition_issue.assert_not_called()

    async def test_sync_space_with_jira_pushes_owner_clear_assignee(self):
        client = Mock()
        client.get_issue.return_value = (
            _issue_payload(
                "KAN-1",
                "Task",
                "",
                labels=[],
                assignee={
                    "displayName": "Maya",
                    "emailAddress": "maya@example.com",
                    "accountId": "acct-7",
                },
            ),
            200,
        )
        client.update_issue.return_value = (204, {})
        client.transition_issue.return_value = (204, {})
        client.create_issue.return_value = (None, None, None)

        input_text = "\n".join(
            [
                "Board:",
                "    people:",
                "        maya:",
                "            name: Maya",
                "            mail: maya@example.com",
                "",
                "% [KAN-1] Task",
            ]
        )

        _session, output_text, writes = await self._run_sync(
            input_text,
            client,
            force_direction="push",
            space_id="sync-push-owner-clear",
        )

        self.assertEqual(output_text, input_text)
        self.assertEqual(writes, [])
        client.get_issue.assert_called_once_with("KAN-1")
        client.update_issue.assert_called_once()
        args = client.update_issue.call_args.args
        self.assertEqual(args[:-1], ("KAN-1", None, None, None, None, True))
        self.assertIs(args[-1], worker.JIRA_ESTIMATE_UNSET)
        client.transition_issue.assert_not_called()

    async def test_sync_space_with_jira_pushes_story_points_to_original_estimate(self):
        client = Mock()
        client.get_issue.return_value = (
            _issue_payload(
                "KAN-1",
                "Task",
                "body",
                labels=[],
                timeoriginalestimate=3600,
            ),
            200,
        )
        client.update_issue.return_value = (204, {})
        client.transition_issue.return_value = (204, {})
        client.create_issue.return_value = (None, None, None)

        input_text = "\n".join(
            [
                "% [KAN-1] Task",
                "~2",
                "body",
            ]
        )

        _session, output_text, writes = await self._run_sync(
            input_text,
            client,
            force_direction="push",
            space_id="sync-push-estimate",
        )

        self.assertEqual(output_text, input_text)
        self.assertEqual(writes, [])
        client.update_issue.assert_called_once_with(
            "KAN-1",
            None,
            None,
            None,
            None,
            False,
            120,
        )

    async def test_sync_space_with_jira_pushes_zero_estimate_when_missing_in_space(self):
        client = Mock()
        client.get_issue.return_value = (
            _issue_payload(
                "KAN-1",
                "Task",
                "body",
                labels=[],
                timeoriginalestimate=3600,
            ),
            200,
        )
        client.update_issue.return_value = (204, {})
        client.transition_issue.return_value = (204, {})
        client.create_issue.return_value = (None, None, None)

        input_text = "\n".join(
            [
                "% [KAN-1] Task",
                "body",
            ]
        )

        _session, output_text, writes = await self._run_sync(
            input_text,
            client,
            force_direction="push",
            space_id="sync-push-estimate-clear",
        )

        self.assertEqual(output_text, input_text)
        self.assertEqual(writes, [])
        client.update_issue.assert_called_once_with(
            "KAN-1",
            None,
            None,
            None,
            None,
            False,
            0,
        )

    async def test_sync_space_with_jira_pulls_jira_changes_into_space(self):
        client = Mock()
        client.get_issue.return_value = (
            _issue_payload(
                "KAN-1",
                "New title",
                "new desc",
                labels=["newtag"],
            ),
            200,
        )
        client.update_issue.return_value = (204, {})
        client.transition_issue.return_value = (204, {})
        client.create_issue.return_value = (None, None, None)

        input_text = "\n".join(
            [
                "% [KAN-1] Old title",
                "#oldtag",
                "old desc",
            ]
        )

        _session, output_text, writes = await self._run_sync(
            input_text,
            client,
            force_direction="pull",
            space_id="sync-pull",
        )

        self.assertEqual(
            output_text,
            "\n".join(
                [
                    "% [KAN-1] New title",
                    "#newtag",
                    "new desc",
                ]
            ),
        )
        self.assertEqual(writes, [output_text])
        client.get_issue.assert_called_once_with("KAN-1")
        client.update_issue.assert_not_called()
        client.transition_issue.assert_not_called()
        client.create_issue.assert_not_called()

    async def test_sync_space_with_jira_pull_reparents_task_under_new_parent(self):
        client = Mock()
        client.get_issue.side_effect = [
            (_issue_payload("KAN-1", "Parent A"), 200),
            (_issue_payload("KAN-2", "Child", parent_key="KAN-3"), 200),
            (_issue_payload("KAN-3", "Parent B"), 200),
        ]
        client.update_issue.return_value = (204, {})
        client.transition_issue.return_value = (204, {})
        client.create_issue.return_value = (None, None, None)

        input_text = "\n".join(
            [
                "% [KAN-1] Parent A",
                "  % [KAN-2] Child",
                "% [KAN-3] Parent B",
            ]
        )

        _session, output_text, writes = await self._run_sync(
            input_text,
            client,
            force_direction="pull",
            space_id="sync-pull-reparent-under-parent",
        )

        self.assertEqual(
            output_text,
            "\n".join(
                [
                    "% [KAN-1] Parent A",
                    "% [KAN-3] Parent B",
                    "  % [KAN-2] Child",
                ]
            ),
        )
        self.assertEqual(writes, [output_text])
        client.update_issue.assert_not_called()
        client.transition_issue.assert_not_called()

    async def test_sync_space_with_jira_pull_reparents_task_to_root(self):
        client = Mock()
        client.get_issue.side_effect = [
            (_issue_payload("KAN-1", "Parent"), 200),
            (_issue_payload("KAN-2", "Child", parent_key=None), 200),
            (_issue_payload("KAN-3", "Sibling"), 200),
        ]
        client.update_issue.return_value = (204, {})
        client.transition_issue.return_value = (204, {})
        client.create_issue.return_value = (None, None, None)

        input_text = "\n".join(
            [
                "% [KAN-1] Parent",
                "  % [KAN-2] Child",
                "% [KAN-3] Sibling",
            ]
        )

        _session, output_text, writes = await self._run_sync(
            input_text,
            client,
            force_direction="pull",
            space_id="sync-pull-reparent-root",
        )

        self.assertEqual(
            output_text,
            "\n".join(
                [
                    "% [KAN-1] Parent",
                    "% [KAN-3] Sibling",
                    "% [KAN-2] Child",
                ]
            ),
        )
        self.assertEqual(writes, [output_text])
        client.update_issue.assert_not_called()
        client.transition_issue.assert_not_called()

    async def test_sync_space_with_jira_pulls_original_estimate_into_story_points(self):
        client = Mock()
        client.get_issue.return_value = (
            _issue_payload(
                "KAN-1",
                "Task",
                "body",
                labels=[],
                timeoriginalestimate=7200,
            ),
            200,
        )
        client.update_issue.return_value = (204, {})
        client.transition_issue.return_value = (204, {})
        client.create_issue.return_value = (None, None, None)

        input_text = "\n".join(
            [
                "% [KAN-1] Task",
                "body",
            ]
        )

        _session, output_text, writes = await self._run_sync(
            input_text,
            client,
            force_direction="pull",
            space_id="sync-pull-estimate",
        )

        self.assertEqual(
            output_text,
            "\n".join(
                [
                    "% [KAN-1] Task",
                    "~2",
                    "body",
                ]
            ),
        )
        self.assertEqual(writes, [output_text])
        client.update_issue.assert_not_called()
        client.transition_issue.assert_not_called()

    async def test_sync_space_with_jira_zero_estimate_does_not_add_story_token(self):
        client = Mock()
        client.get_issue.return_value = (
            _issue_payload(
                "KAN-1",
                "Task",
                "body",
                labels=[],
                timeoriginalestimate=0,
            ),
            200,
        )
        client.update_issue.return_value = (204, {})
        client.transition_issue.return_value = (204, {})
        client.create_issue.return_value = (None, None, None)

        input_text = "\n".join(
            [
                "% [KAN-1] Task",
                "body",
            ]
        )

        _session, output_text, writes = await self._run_sync(
            input_text,
            client,
            force_direction="pull",
            space_id="sync-pull-zero-estimate-no-token",
        )

        self.assertEqual(output_text, input_text)
        self.assertEqual(writes, [])
        client.update_issue.assert_not_called()
        client.transition_issue.assert_not_called()

    async def test_sync_space_with_jira_zero_estimate_rewrites_existing_story_token_to_zero(self):
        client = Mock()
        client.get_issue.return_value = (
            _issue_payload(
                "KAN-1",
                "Task",
                "body",
                labels=[],
                status_name="Todo",
                timeoriginalestimate=0,
            ),
            200,
        )
        client.update_issue.return_value = (204, {})
        client.transition_issue.return_value = (204, {})
        client.create_issue.return_value = (None, None, None)

        input_text = "\n".join(
            [
                "Board:",
                "    states:",
                "        todo:",
                "            jira: Todo",
                "",
                "% [KAN-1] Task",
                "!todo ~2",
                "body",
            ]
        )

        _session, output_text, writes = await self._run_sync(
            input_text,
            client,
            force_direction="pull",
            space_id="sync-pull-zero-estimate-rewrite",
        )

        self.assertEqual(
            output_text,
            "\n".join(
                [
                    "Board:",
                    "    states:",
                    "        todo:",
                    "            jira: Todo",
                    "",
                    "% [KAN-1] Task",
                    "!todo ~0",
                    "body",
                ]
            ),
        )
        self.assertEqual(writes, [output_text])
        client.update_issue.assert_not_called()
        client.transition_issue.assert_not_called()

    async def test_sync_space_with_jira_places_story_points_at_end_of_token_line(self):
        client = Mock()
        client.get_issue.return_value = (
            _issue_payload(
                "KAN-1",
                "Task",
                "body line",
                labels=["backend"],
                status_name="Todo",
                assignee=None,
                timeoriginalestimate=7200,
            ),
            200,
        )
        client.update_issue.return_value = (204, {})
        client.transition_issue.return_value = (204, {})
        client.create_issue.return_value = (None, None, None)

        input_text = "\n".join(
            [
                "Board:",
                "    states:",
                "        todo:",
                "            jira: Todo",
                "",
                "% [KAN-1] Task",
                "!todo #backend @maya",
                "body ~1 line",
            ]
        )

        _session, output_text, writes = await self._run_sync(
            input_text,
            client,
            force_direction="pull",
            space_id="sync-pull-estimate-token-line",
        )

        self.assertEqual(
            output_text,
            "\n".join(
                [
                    "Board:",
                    "    states:",
                    "        todo:",
                    "            jira: Todo",
                    "",
                    "% [KAN-1] Task",
                    "!todo #backend ~2",
                    "body line",
                ]
            ),
        )
        self.assertEqual(writes, [output_text])
        client.update_issue.assert_not_called()
        client.transition_issue.assert_not_called()

    async def test_sync_space_with_jira_pull_removes_multiple_token_lines(self):
        client = Mock()
        client.get_issue.return_value = (
            _issue_payload(
                "KAN-1",
                "Task",
                "body",
                labels=[],
                assignee=None,
            ),
            200,
        )
        client.update_issue.return_value = (204, {})
        client.transition_issue.return_value = (204, {})
        client.create_issue.return_value = (None, None, None)

        input_text = "\n".join(
            [
                "% [KAN-1] Task",
                "#tag1",
                "@maya",
                "body",
            ]
        )

        _session, output_text, writes = await self._run_sync(
            input_text,
            client,
            force_direction="pull",
            space_id="sync-pull-token-cleanup",
        )

        self.assertEqual(
            output_text,
            "\n".join(
                [
                    "% [KAN-1] Task",
                    "body",
                ]
            ),
        )
        self.assertEqual(writes, [output_text])
        client.get_issue.assert_called_once_with("KAN-1")
        client.update_issue.assert_not_called()
        client.transition_issue.assert_not_called()

    async def test_sync_space_with_jira_pull_removes_tag_and_people_from_body(self):
        client = Mock()
        client.get_issue.return_value = (
            _issue_payload(
                "KAN-1",
                "Task",
                "body note",
                labels=[],
                assignee=None,
            ),
            200,
        )
        client.update_issue.return_value = (204, {})
        client.transition_issue.return_value = (204, {})
        client.create_issue.return_value = (None, None, None)

        input_text = "\n".join(
            [
                "% [KAN-1] Task",
                "#tag1 @maya",
                "body #tag1 note @maya",
            ]
        )

        _session, output_text, writes = await self._run_sync(
            input_text,
            client,
            force_direction="pull",
            space_id="sync-pull-body-token-removal",
        )

        self.assertEqual(
            output_text,
            "\n".join(
                [
                    "% [KAN-1] Task",
                    "body note",
                ]
            ),
        )
        self.assertEqual(writes, [output_text])
        client.get_issue.assert_called_once_with("KAN-1")
        client.update_issue.assert_not_called()
        client.transition_issue.assert_not_called()

    async def test_sync_space_with_jira_pull_preserves_body_tokens_still_present_in_jira(self):
        client = Mock()
        client.get_issue.return_value = (
            _issue_payload(
                "KAN-1",
                "Task",
                "body #tag1 note @maya remove #old @other",
                labels=["tag1"],
                assignee={
                    "displayName": "Maya",
                    "emailAddress": "maya@example.com",
                    "accountId": "acct-7",
                },
            ),
            200,
        )
        client.update_issue.return_value = (204, {})
        client.transition_issue.return_value = (204, {})
        client.create_issue.return_value = (None, None, None)

        input_text = "\n".join(
            [
                "Board:",
                "    people:",
                "        maya:",
                "            name: Maya",
                "            mail: maya@example.com",
                "",
                "% [KAN-1] Task",
                "#tag1 @maya",
                "body #tag1 note @maya remove #old @other",
            ]
        )

        _session, output_text, writes = await self._run_sync(
            input_text,
            client,
            force_direction="pull",
            space_id="sync-pull-body-token-preserve",
        )

        self.assertEqual(
            output_text,
            "\n".join(
                [
                    "Board:",
                    "    people:",
                    "        maya:",
                    "            name: Maya",
                    "            mail: maya@example.com",
                    "",
                    "% [KAN-1] Task",
                    "#tag1 @maya",
                    "body #tag1 note @maya remove @other",
                ]
            ),
        )
        self.assertEqual(writes, [output_text])
        client.get_issue.assert_called_once_with("KAN-1")
        client.update_issue.assert_not_called()


if __name__ == "__main__":
    unittest.main()
