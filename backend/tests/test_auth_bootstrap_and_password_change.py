import json
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException, Response as ApiResponse
from starlette.requests import Request

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import server  # noqa: E402
from jira import config as jira_config  # noqa: E402


class AuthBootstrapAndPasswordChangeTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self._tmp.name)
        self.users_config_path = self.tmp_path / "users_config.json"
        self.legacy_jira_users_config_path = self.tmp_path / "jira_users_config.json"
        self.jira_config_path = self.tmp_path / "jira_config.json"
        self.legacy_users_file = self.tmp_path / "users.txt"
        self.sessions_file = self.tmp_path / "sessions.json"
        self.spaces_dir = self.tmp_path / "spaces"
        self.ystore_dir = self.tmp_path / "ystore"
        self.spaces_dir.mkdir(parents=True, exist_ok=True)
        self.ystore_dir.mkdir(parents=True, exist_ok=True)

        self._patchers = [
            patch.object(jira_config, "USERS_CONFIG_PATH", self.users_config_path),
            patch.object(jira_config, "LEGACY_USERS_CONFIG_PATH", self.legacy_jira_users_config_path),
            patch.object(jira_config, "JIRA_CONFIG_PATH", self.jira_config_path),
            patch.object(server, "SESSIONS_FILE", self.sessions_file),
            patch.object(server, "SPACES_DIR", self.spaces_dir),
            patch.object(server, "YSTORE_DIR", self.ystore_dir),
            patch.object(server, "presence", {}),
            patch.object(server, "space_save_tasks", {}),
        ]
        for patcher in self._patchers:
            patcher.start()
        self.addCleanup(self._cleanup_patchers)

    def _cleanup_patchers(self):
        for patcher in reversed(self._patchers):
            patcher.stop()
        self._tmp.cleanup()

    def _session_token_from_response(self, response: ApiResponse) -> str:
        raw = response.headers.get("set-cookie", "")
        prefix = f"{server.SESSION_COOKIE_NAME}="
        for part in raw.split(";"):
            part = part.strip()
            if part.startswith(prefix):
                return part[len(prefix):]
        self.fail(f"Missing session cookie in response headers: {raw}")

    def _request_with_session_cookie(
        self,
        session_token: str,
        *,
        method: str = "GET",
        path: str = "/api/me",
    ) -> Request:
        scope = {
            "type": "http",
            "method": method,
            "path": path,
            "headers": [
                (
                    b"cookie",
                    f"{server.SESSION_COOKIE_NAME}={session_token}".encode("utf-8"),
                )
            ],
        }
        return Request(scope)

    def test_bootstrap_admin_is_created_when_users_config_missing(self):
        self.assertFalse(self.users_config_path.exists())

        users = server.load_users_store()

        self.assertIn("admin", users)
        admin = users["admin"]
        self.assertEqual(admin.get("role"), "admin")
        self.assertEqual(admin.get("display_name"), "admin")
        self.assertTrue(admin.get("must_change_password"))
        self.assertTrue(server.verify_password(admin, "admin"))

        auth = server.authenticate("admin", "admin")
        self.assertIsNotNone(auth)
        self.assertTrue(auth.must_change_password)

        self.assertTrue(self.users_config_path.exists(), "bootstrap users config should be persisted")
        saved = json.loads(self.users_config_path.read_text(encoding="utf-8"))
        self.assertIn("users", saved)
        self.assertIn("admin", saved["users"])
        self.assertTrue(saved["users"]["admin"].get("must_change_password"))

        self.assertTrue(
            (self.spaces_dir / "personal" / "admin.txt").exists(),
            "bootstrap should create personal admin space",
        )

    def test_login_and_me_include_must_change_password_for_bootstrap_admin(self):
        response = ApiResponse()
        login_data = server.login(
            response=response,
            payload={"username": "admin", "password": "admin"},
        )
        self.assertTrue(login_data.get("ok"))
        self.assertTrue(login_data.get("must_change_password"))
        self.assertTrue(login_data.get("user", {}).get("must_change_password"))

        session_token = self._session_token_from_response(response)
        auth = server.auth_from_session(session_token)
        self.assertIsNotNone(auth)
        me_data = server.read_me(
            request=self._request_with_session_cookie(session_token),
            user=auth,
        )
        self.assertTrue(me_data.get("must_change_password"))
        self.assertTrue(me_data.get("user", {}).get("must_change_password"))

    def test_password_change_clears_must_change_password_flag(self):
        response = ApiResponse()
        login_data = server.login(
            response=response,
            payload={"username": "admin", "password": "admin"},
        )
        self.assertTrue(login_data.get("must_change_password"))

        session_token = self._session_token_from_response(response)
        auth = server.auth_from_session(session_token)
        self.assertIsNotNone(auth)

        update_data = server.update_me(
            payload={
                "current_password": "admin",
                "password": "changed-admin-password",
            },
            user=auth,
        )
        self.assertTrue(update_data.get("ok"))
        self.assertFalse(update_data.get("user", {}).get("must_change_password"))

        refreshed_auth = server.auth_from_session(session_token)
        self.assertIsNotNone(refreshed_auth)
        me_data = server.read_me(
            request=self._request_with_session_cookie(session_token),
            user=refreshed_auth,
        )
        self.assertFalse(me_data.get("must_change_password"))
        self.assertFalse(me_data.get("user", {}).get("must_change_password"))

        self.assertIsNone(server.authenticate("admin", "admin"))
        auth = server.authenticate("admin", "changed-admin-password")
        self.assertIsNotNone(auth)
        self.assertFalse(auth.must_change_password)

        stored = server.load_users_store()
        self.assertFalse(stored["admin"].get("must_change_password"))

    def test_login_rejects_invalid_payloads_and_wrong_password(self):
        invalid_cases = [
            ("non-dict payload", [], 400),
            ("missing username", {"password": "admin"}, 400),
            ("missing password", {"username": "admin"}, 400),
            ("non-string username", {"username": 123, "password": "admin"}, 400),
            ("non-string password", {"username": "admin", "password": 123}, 400),
            ("wrong password", {"username": "admin", "password": "wrong"}, 401),
        ]
        for label, payload, expected_status in invalid_cases:
            with self.subTest(label=label):
                response = ApiResponse()
                with self.assertRaises(HTTPException) as ctx:
                    server.login(response=response, payload=payload)
                self.assertEqual(ctx.exception.status_code, expected_status)

    def test_logout_removes_session_and_cookie(self):
        login_response = ApiResponse()
        login_data = server.login(
            response=login_response,
            payload={"username": "admin", "password": "admin"},
        )
        self.assertTrue(login_data.get("ok"))
        session_token = self._session_token_from_response(login_response)
        self.assertIsNotNone(server.auth_from_session(session_token))

        logout_response = ApiResponse()
        logout_data = server.logout(
            request=self._request_with_session_cookie(
                session_token,
                method="POST",
                path="/api/logout",
            ),
            response=logout_response,
        )
        self.assertEqual(logout_data, {"ok": True})
        self.assertIsNone(server.auth_from_session(session_token))

        set_cookie = logout_response.headers.get("set-cookie", "")
        self.assertIn(f"{server.SESSION_COOKIE_NAME}=\"\"", set_cookie)
        self.assertIn("Max-Age=0", set_cookie)

        sessions_data = server._load_sessions_data()
        self.assertEqual(sessions_data.get("sessions"), {})

    def test_expired_session_is_cleaned_up_on_access(self):
        # Bootstrap users so session auth lookup has a valid user base.
        server.load_users_store()
        token = "expired_token"
        expired_payload = {
            "sessions": {
                token: {
                    "username": "admin",
                    "created_at": int(time.time()) - 10,
                    "expires_at": int(time.time()) - 1,
                    "last_space": "admin",
                }
            }
        }
        self.sessions_file.write_text(
            f"{json.dumps(expired_payload, indent=2)}\n",
            encoding="utf-8",
        )

        self.assertIsNone(server.auth_from_session(token))

        cleaned = json.loads(self.sessions_file.read_text(encoding="utf-8"))
        self.assertEqual(cleaned.get("sessions"), {})


if __name__ == "__main__":
    unittest.main()
