# Module: Jira worker configuration loading, validation, and credential persistence utilities.

import json
import logging
import os
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

logger = logging.getLogger("jira-worker")
# Stores the _JSON_IO_LOCK module constant.
_JSON_IO_LOCK = threading.RLock()

# Stores the JIRA_DIR module constant.
JIRA_DIR = Path(__file__).resolve().parent
# Stores the BACKEND_DIR module constant.
BACKEND_DIR = JIRA_DIR.parent
# Stores the JIRA_CONFIG_PATH module constant.
JIRA_CONFIG_PATH = JIRA_DIR / "jira_config.json"
# Stores the USERS_CONFIG_PATH module constant.
USERS_CONFIG_PATH = BACKEND_DIR / "users_config.json"
# Stores the LEGACY_USERS_CONFIG_PATH module constant.
LEGACY_USERS_CONFIG_PATH = JIRA_DIR / "users_config.json"
# Stores the JIRA_DAEMON_USERNAME module constant.
JIRA_DAEMON_USERNAME = "jira-daemon"


# Defines the JiraConfig structure used by this module.
@dataclass(frozen=True)
class JiraConfig:
    base_url: str = ""
    email: str = ""
    token: str = ""

    # Handles the enabled function logic.
    # Input: self.
    # Output: bool.
    @property
    def enabled(self) -> bool:
        return bool(self.base_url and self.email and self.token)


# Handles the _normalize_value function logic.
# Input: value: Optional[Any].
# Output: str.
def _normalize_value(value: Optional[Any]) -> str:
    if not isinstance(value, str):
        return ""
    return value.strip()


# Handles the _normalize_base_url function logic.
# Input: value: Optional[Any].
# Output: str.
def _normalize_base_url(value: Optional[Any]) -> str:
    base_url = _normalize_value(value)
    return base_url.rstrip("/")


# Handles the _read_json_dict function logic.
# Input: path: Path, label: str.
# Output: Dict[str, Any].
def _read_json_dict(path: Path, label: str) -> Dict[str, Any]:
    if not path.exists():
        return {}
    try:
        with _JSON_IO_LOCK:
            raw = path.read_text(encoding="utf-8")
    except Exception:
        logger.exception("Failed to read %s from %s", label, path)
        return {}
    try:
        data = json.loads(raw) if raw.strip() else {}
    except Exception:
        logger.exception("Failed to parse %s JSON from %s", label, path)
        return {}
    return data if isinstance(data, dict) else {}


# Handles the _write_json_dict function logic.
# Input: path: Path, data: Dict[str, Any], label: str.
# Output: None.
def _write_json_dict(path: Path, data: Dict[str, Any], label: str) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(data, ensure_ascii=False, indent=2)
        with _JSON_IO_LOCK:
            with tempfile.NamedTemporaryFile(
                "w",
                encoding="utf-8",
                dir=str(path.parent),
                prefix=f".{path.name}.",
                suffix=".tmp",
                delete=False,
            ) as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
                temp_name = handle.name
            os.replace(temp_name, path)
    except Exception:
        logger.exception("Failed to write %s to %s", label, path)


# Handles the _mask_secret function logic.
# Input: value: str.
# Output: str.
def _mask_secret(value: str) -> str:
    secret = _normalize_value(value)
    if not secret:
        return ""
    if len(secret) <= 4:
        return "*" * len(secret)
    return f"{'*' * max(4, len(secret) - 4)}{secret[-4:]}"


# Handles the load_jira_config_data function logic.
# Input: none.
# Output: Dict[str, Any].
def load_jira_config_data() -> Dict[str, Any]:
    return _read_json_dict(JIRA_CONFIG_PATH, "jira config")


# Handles the save_jira_config_data function logic.
# Input: data: Dict[str, Any].
# Output: None.
def save_jira_config_data(data: Dict[str, Any]) -> None:
    _write_json_dict(JIRA_CONFIG_PATH, data, "jira config")


# Handles the load_users_config_data function logic.
# Input: none.
# Output: Dict[str, Any].
def load_users_config_data() -> Dict[str, Any]:
    data = _read_json_dict(USERS_CONFIG_PATH, "users config")
    if data:
        return data
    legacy = _read_json_dict(LEGACY_USERS_CONFIG_PATH, "legacy users config")
    if legacy:
        save_users_config_data(legacy)
        return legacy
    return {}


# Handles the save_users_config_data function logic.
# Input: data: Dict[str, Any].
# Output: None.
def save_users_config_data(data: Dict[str, Any]) -> None:
    _write_json_dict(USERS_CONFIG_PATH, data, "users config")


# Handles the load_jira_config function logic.
# Input: none.
# Output: JiraConfig.
def load_jira_config() -> JiraConfig:
    data = load_jira_config_data()
    return JiraConfig(
        base_url=_normalize_base_url(data.get("base_url")),
        email=_normalize_value(data.get("email")),
        token=_normalize_value(data.get("token")),
    )


# Handles the save_jira_config function logic.
# Input: payload: Dict[str, Any], existing: Optional[JiraConfig] = None.
# Output: JiraConfig.
def save_jira_config(
    payload: Dict[str, Any], existing: Optional[JiraConfig] = None
) -> JiraConfig:
    current = existing or load_jira_config()
    data = load_jira_config_data()
    base_url = current.base_url
    email = current.email
    token = current.token
    if "base_url" in payload:
        base_url = _normalize_base_url(payload.get("base_url"))
    if "email" in payload:
        email = _normalize_value(payload.get("email"))
    if "token" in payload:
        requested_token = _normalize_value(payload.get("token"))
        # If the UI round-trips a masked token returned by the API, preserve the
        # existing secret instead of overwriting it with the masked placeholder.
        if current.token and requested_token == _mask_secret(current.token):
            token = current.token
        else:
            token = requested_token
    config = JiraConfig(base_url=base_url, email=email, token=token)
    data["base_url"] = config.base_url
    data["email"] = config.email
    data["token"] = config.token
    save_jira_config_data(data)
    return config


# Handles the load_jira_worker_credentials function logic.
# Input: none.
# Output: Tuple[str, str].
def load_jira_worker_credentials() -> Tuple[str, str]:
    data = load_jira_config_data()
    username = _normalize_value(data.get("worker_username")) or JIRA_DAEMON_USERNAME
    password = _normalize_value(data.get("worker_password"))
    return username, password
