import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from jira import config as jira_config


class JiraConfigTests(unittest.TestCase):
    def _patch_paths(self, tmpdir: str):
        root = Path(tmpdir)
        return patch.multiple(
            jira_config,
            JIRA_CONFIG_PATH=root / "jira_config.json",
            USERS_CONFIG_PATH=root / "users_config.json",
            LEGACY_USERS_CONFIG_PATH=root / "jira_users_config.json",
        )

    def test_load_jira_config_normalizes_values_and_enabled(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            with self._patch_paths(tmpdir):
                jira_path = jira_config.JIRA_CONFIG_PATH
                jira_path.write_text(
                    json.dumps(
                        {
                            "base_url": " https://jira.example.com/ ",
                            "email": " user@example.com ",
                            "token": " secret ",
                        }
                    ),
                    encoding="utf-8",
                )
                cfg = jira_config.load_jira_config()
        self.assertEqual(cfg.base_url, "https://jira.example.com")
        self.assertEqual(cfg.email, "user@example.com")
        self.assertEqual(cfg.token, "secret")
        self.assertTrue(cfg.enabled)

    def test_load_jira_config_data_invalid_json_returns_empty(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            with self._patch_paths(tmpdir):
                jira_config.JIRA_CONFIG_PATH.write_text("{not json", encoding="utf-8")
                self.assertEqual(jira_config.load_jira_config_data(), {})
                self.assertEqual(jira_config.load_jira_config().base_url, "")

    def test_save_jira_config_partial_payload_preserves_existing(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            with self._patch_paths(tmpdir):
                jira_config.JIRA_CONFIG_PATH.write_text(
                    json.dumps(
                        {
                            "base_url": "https://old.example.com/",
                            "email": "old@example.com",
                            "token": "old-token",
                            "extra": "keep-me",
                        }
                    ),
                    encoding="utf-8",
                )
                existing = jira_config.JiraConfig(
                    base_url="https://old.example.com",
                    email="old@example.com",
                    token="old-token",
                )
                saved = jira_config.save_jira_config(
                    {"email": "  new@example.com  "},
                    existing=existing,
                )
                written = json.loads(jira_config.JIRA_CONFIG_PATH.read_text(encoding="utf-8"))
        self.assertEqual(saved.base_url, "https://old.example.com")
        self.assertEqual(saved.email, "new@example.com")
        self.assertEqual(saved.token, "old-token")
        self.assertEqual(written["extra"], "keep-me")
        self.assertEqual(written["email"], "new@example.com")

    def test_save_jira_config_normalizes_base_url_and_non_string_values(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            with self._patch_paths(tmpdir):
                saved = jira_config.save_jira_config(
                    {
                        "base_url": " https://jira.example.com/// ",
                        "email": 123,
                        "token": None,
                    }
                )
                raw = json.loads(jira_config.JIRA_CONFIG_PATH.read_text(encoding="utf-8"))
        self.assertEqual(saved.base_url, "https://jira.example.com")
        self.assertEqual(saved.email, "")
        self.assertEqual(saved.token, "")
        self.assertEqual(raw["base_url"], "https://jira.example.com")

    def test_load_users_config_prefers_current_and_migrates_legacy(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            with self._patch_paths(tmpdir):
                current = {"users": [{"username": "current"}]}
                legacy = {"users": [{"username": "legacy"}]}
                jira_config.USERS_CONFIG_PATH.write_text(
                    json.dumps(current),
                    encoding="utf-8",
                )
                jira_config.LEGACY_USERS_CONFIG_PATH.write_text(
                    json.dumps(legacy),
                    encoding="utf-8",
                )
                loaded = jira_config.load_users_config_data()
                self.assertEqual(loaded, current)

                jira_config.USERS_CONFIG_PATH.unlink()
                migrated = jira_config.load_users_config_data()
                self.assertEqual(migrated, legacy)
                persisted = json.loads(jira_config.USERS_CONFIG_PATH.read_text(encoding="utf-8"))
                self.assertEqual(persisted, legacy)


if __name__ == "__main__":
    unittest.main()
