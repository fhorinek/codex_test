import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from fastapi.responses import Response

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import server  # noqa: E402
from jira import config as jira_config  # noqa: E402


class HistoryCheckpointHelpersTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self._tmp.name)
        self.history_dir = self.tmp_path / "history"
        self.users_config_path = self.tmp_path / "users_config.json"
        self.legacy_jira_users_config_path = self.tmp_path / "jira_users_config.json"
        self.jira_config_path = self.tmp_path / "jira_config.json"
        self.spaces_dir = self.tmp_path / "spaces"
        self.ystore_dir = self.tmp_path / "ystore"
        self.history_dir.mkdir(parents=True, exist_ok=True)
        self.spaces_dir.mkdir(parents=True, exist_ok=True)
        self.ystore_dir.mkdir(parents=True, exist_ok=True)
        self._patchers = [
            patch.object(server, "HISTORY_DIR", self.history_dir),
            patch.object(server, "HISTORY_AUTO_MIN_INTERVAL_SECONDS", 300),
            patch.object(server, "SPACES_DIR", self.spaces_dir),
            patch.object(server, "YSTORE_DIR", self.ystore_dir),
            patch.object(jira_config, "USERS_CONFIG_PATH", self.users_config_path),
            patch.object(jira_config, "LEGACY_USERS_CONFIG_PATH", self.legacy_jira_users_config_path),
            patch.object(jira_config, "JIRA_CONFIG_PATH", self.jira_config_path),
        ]
        for patcher in self._patchers:
            patcher.start()
        self.addCleanup(self._cleanup_patchers)

    def _cleanup_patchers(self):
        for patcher in reversed(self._patchers):
            patcher.stop()
        self._tmp.cleanup()

    def test_create_history_checkpoint_writes_index_and_content_file(self):
        meta = server.create_history_checkpoint(
            "demo_space",
            "hello history",
            kind="manual",
            label="milestone",
            created_at=1700000000,
        )

        self.assertEqual(meta["kind"], "manual")
        self.assertEqual(meta["label"], "milestone")
        self.assertEqual(meta["created_at"], 1700000000)
        self.assertEqual(meta["content_hash"], server.history_content_hash("hello history"))

        index_path = self.history_dir / "demo_space" / "index.json"
        self.assertTrue(index_path.exists())
        index = json.loads(index_path.read_text(encoding="utf-8"))
        self.assertEqual(len(index.get("checkpoints", [])), 1)
        self.assertEqual(index["checkpoints"][0]["id"], meta["id"])

        checkpoint_path = self.history_dir / "demo_space" / f"{meta['id']}.txt"
        self.assertEqual(checkpoint_path.read_text(encoding="utf-8"), "hello history")
        self.assertEqual(server.read_history_checkpoint("demo_space", meta["id"]), "hello history")

    def test_load_history_index_returns_sorted_normalized_entries(self):
        second = server.create_history_checkpoint(
            "demo_space",
            "second",
            kind="auto",
            created_at=1700000100,
        )
        first = server.create_history_checkpoint(
            "demo_space",
            "first",
            kind="manual",
            label="first label",
            created_at=1700000000,
        )

        entries = server.load_history_index("demo_space")
        self.assertEqual([entry["id"] for entry in entries], [first["id"], second["id"]])
        self.assertEqual(entries[0]["label"], "first label")
        self.assertEqual(entries[1]["kind"], "auto")

    def test_read_history_checkpoint_missing_raises_404(self):
        with self.assertRaises(HTTPException) as ctx:
            server.read_history_checkpoint("demo_space", "missing-1")
        self.assertEqual(ctx.exception.status_code, 404)

    def test_maybe_create_auto_history_checkpoint_uses_hash_and_interval_gating(self):
        first = server.maybe_create_auto_history_checkpoint(
            "demo_space",
            "v1",
            now_epoch=1700000000,
        )
        self.assertIsNotNone(first)

        same_content = server.maybe_create_auto_history_checkpoint(
            "demo_space",
            "v1",
            now_epoch=1700000300,
        )
        self.assertIsNone(same_content)

        changed_too_soon = server.maybe_create_auto_history_checkpoint(
            "demo_space",
            "v2",
            now_epoch=1700000100,
        )
        self.assertIsNone(changed_too_soon)

        changed_later = server.maybe_create_auto_history_checkpoint(
            "demo_space",
            "v2",
            now_epoch=1700000301,
        )
        self.assertIsNotNone(changed_later)

        entries = server.load_history_index("demo_space")
        self.assertEqual(len(entries), 2)
        self.assertEqual(entries[0]["content_hash"], server.history_content_hash("v1"))
        self.assertEqual(entries[1]["content_hash"], server.history_content_hash("v2"))

    def test_history_api_list_and_get_require_access_and_return_content(self):
        users = server.load_users_store()
        admin_record = users["admin"]
        admin = server.user_record_to_auth("admin", admin_record)
        space_file = self.spaces_dir / "demo_space.txt"
        space_file.write_text("live", encoding="utf-8")
        history_key = server.history_key_from_space_canonical_path("demo_space")

        first = server.create_history_checkpoint(history_key, "one", kind="auto", created_at=1700000000)
        second = server.create_history_checkpoint(
            history_key,
            "two",
            kind="manual",
            label="tagged",
            created_at=1700000100,
        )

        listing = server.read_space_history("demo_space", user=admin)
        self.assertEqual([entry["id"] for entry in listing["checkpoints"]], [first["id"], second["id"]])

        response = server.read_space_history_checkpoint("demo_space", second["id"], user=admin)
        self.assertIsInstance(response, Response)
        self.assertEqual(response.body.decode("utf-8"), "two")

        no_access = server.AuthUser(username="u", display_name="u", role="user", spaces=(), must_change_password=False)
        with self.assertRaises(HTTPException) as ctx:
            server.read_space_history("demo_space", user=no_access)
        self.assertEqual(ctx.exception.status_code, 403)

    def test_history_revert_stores_revoked_checkpoint_then_restores_selected_content(self):
        users = server.load_users_store()
        admin = server.user_record_to_auth("admin", users["admin"])
        space_file = self.spaces_dir / "demo_space.txt"
        space_file.write_text("live-current", encoding="utf-8")
        history_key = server.history_key_for_space("demo_space", users)

        target = server.create_history_checkpoint(
            history_key,
            "restored-from-history",
            kind="manual",
            label="milestone",
            created_at=1700000000,
        )

        result = asyncio_run(
            server.revert_space_history_checkpoint(
                "demo_space",
                payload={
                    "checkpoint_id": target["id"],
                    "pre_revert_content": "live-current",
                    "pre_revert_label": "revoked",
                },
                user=admin,
            )
        )

        self.assertTrue(result["ok"])
        self.assertEqual(result["content"], "restored-from-history")
        self.assertEqual(space_file.read_text(encoding="utf-8"), "restored-from-history")
        self.assertEqual(result["revert_base"]["kind"], "revert-base")
        self.assertEqual(result["revert_base"]["label"], "revoked")

        entries = server.load_history_index(history_key)
        self.assertEqual(len(entries), 2)
        self.assertEqual(entries[0]["id"], target["id"])
        self.assertEqual(entries[1]["label"], "revoked")
        self.assertEqual(server.read_history_checkpoint(history_key, entries[1]["id"]), "live-current")

    def test_history_tag_creates_manual_checkpoint_without_changing_live_space(self):
        users = server.load_users_store()
        admin = server.user_record_to_auth("admin", users["admin"])
        space_file = self.spaces_dir / "demo_space.txt"
        space_file.write_text("live-current", encoding="utf-8")
        history_key = server.history_key_for_space("demo_space", users)

        source = server.create_history_checkpoint(
            history_key,
            "checkpoint-content",
            kind="auto",
            created_at=1700000000,
        )

        response = server.tag_space_history_checkpoint(
            "demo_space",
            payload={
                "checkpoint_id": source["id"],
                "label": "Release Candidate",
            },
            user=admin,
        )

        self.assertTrue(response["ok"])
        tagged = response["checkpoint"]
        self.assertEqual(tagged["kind"], "manual")
        self.assertEqual(tagged["label"], "Release Candidate")
        self.assertEqual(space_file.read_text(encoding="utf-8"), "live-current")

        entries = server.load_history_index(history_key)
        self.assertEqual(len(entries), 2)
        self.assertEqual(entries[1]["id"], tagged["id"])
        self.assertEqual(server.read_history_checkpoint(history_key, tagged["id"]), "checkpoint-content")

    def test_history_tag_can_create_immediate_manual_snapshot_from_current_content(self):
        users = server.load_users_store()
        admin = server.user_record_to_auth("admin", users["admin"])
        space_file = self.spaces_dir / "demo_space.txt"
        space_file.write_text("live-current", encoding="utf-8")
        history_key = server.history_key_for_space("demo_space", users)

        existing = server.create_history_checkpoint(
            history_key,
            "live-current",
            kind="auto",
            created_at=1700000000,
        )

        response = server.tag_space_history_checkpoint(
            "demo_space",
            payload={
                "label": "Pinned now",
                "content": "live-current",
            },
            user=admin,
        )

        self.assertTrue(response["ok"])
        tagged = response["checkpoint"]
        self.assertEqual(tagged["kind"], "manual")
        self.assertEqual(tagged["label"], "Pinned now")
        self.assertNotEqual(tagged["id"], existing["id"])
        self.assertEqual(space_file.read_text(encoding="utf-8"), "live-current")

        entries = server.load_history_index(history_key)
        self.assertEqual(len(entries), 2)
        self.assertEqual(entries[0]["id"], existing["id"])
        self.assertEqual(entries[1]["id"], tagged["id"])
        self.assertEqual(server.read_history_checkpoint(history_key, tagged["id"]), "live-current")

    def test_history_moves_with_space_folder_change(self):
        users = server.load_users_store()
        admin = server.user_record_to_auth("admin", users["admin"])
        (self.spaces_dir / "demo_space.txt").write_text("live", encoding="utf-8")
        (self.spaces_dir / "team").mkdir(parents=True, exist_ok=True)

        old_key = server.history_key_from_space_canonical_path("demo_space")
        checkpoint = server.create_history_checkpoint(old_key, "v1", kind="manual", label="tag")
        self.assertTrue((self.history_dir / old_key).exists())

        result = server.set_space_folder(
            "demo_space",
            payload={"folder": "team"},
            user=admin,
        )
        self.assertTrue(result["ok"])

        new_key = server.history_key_from_space_canonical_path("team/demo_space")
        self.assertFalse((self.history_dir / old_key).exists())
        self.assertEqual(server.read_history_checkpoint(new_key, checkpoint["id"]), "v1")

    def test_history_moves_with_space_rename(self):
        users = server.load_users_store()
        admin = server.user_record_to_auth("admin", users["admin"])
        (self.spaces_dir / "demo_space.txt").write_text("live", encoding="utf-8")

        old_key = server.history_key_from_space_canonical_path("demo_space")
        checkpoint = server.create_history_checkpoint(old_key, "v1", kind="manual", label="tag")

        result = server.rename_space(
            "demo_space",
            payload={"name": "renamed_space"},
            user=admin,
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["id"], "renamed_space")

        new_key = server.history_key_from_space_canonical_path("renamed_space")
        self.assertFalse((self.history_dir / old_key).exists())
        self.assertEqual(server.read_history_checkpoint(new_key, checkpoint["id"]), "v1")

    def test_duplicate_space_names_in_different_folders_are_listed_and_read_by_path(self):
        users = server.load_users_store()
        admin = server.user_record_to_auth("admin", users["admin"])
        (self.spaces_dir / "demo_space.txt").write_text("root version", encoding="utf-8")
        (self.spaces_dir / "team").mkdir(parents=True, exist_ok=True)
        (self.spaces_dir / "team" / "demo_space.txt").write_text("team version", encoding="utf-8")

        listing = server.list_spaces(user=admin)
        demo_entries = [entry for entry in listing["spaces"] if entry.get("id") == "demo_space"]
        self.assertEqual(len(demo_entries), 2)
        self.assertEqual(
            sorted(entry.get("path") for entry in demo_entries),
            ["demo_space", "team/demo_space"],
        )

        root_response = server.read_space("demo_space", path="demo_space", user=admin)
        team_response = server.read_space("demo_space", path="team/demo_space", user=admin)
        self.assertEqual(root_response.body.decode("utf-8"), "root version")
        self.assertEqual(team_response.body.decode("utf-8"), "team version")


def asyncio_run(coro):
    import asyncio

    return asyncio.run(coro)


if __name__ == "__main__":
    unittest.main()
