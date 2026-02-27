# Module: HTTP and websocket backend server with auth, spaces, history, and collaboration APIs.

import asyncio
import base64
import json
import hashlib
import logging
import os
import re
import secrets
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import parse_qs
from http.cookies import SimpleCookie

from typing import Any, Dict, List, Optional, Set, Tuple

import y_py as Y
from fastapi import Body, Depends, FastAPI, Header, HTTPException, Query, Request, Response as ApiResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from ypy_websocket import WebsocketServer, YRoom
from ypy_websocket.asgi_server import ASGIServer
from ypy_websocket.ystore import FileYStore
from ypy_websocket.yutils import YMessageType
import uvicorn
from uvicorn.protocols.utils import ClientDisconnected
from websockets.exceptions import ConnectionClosedOK
from jira.config import (
    JIRA_DAEMON_USERNAME,
    load_jira_config_data,
    load_jira_config,
    load_users_config_data,
    save_jira_config_data,
    save_users_config_data,
    save_jira_config,
)

# Stores the ROOT_DIR module constant.
ROOT_DIR = Path(__file__).resolve().parents[1]
# Stores the FRONTEND_DIR module constant.
FRONTEND_DIR = ROOT_DIR / "frontend"
# Stores the FRONTEND_DIST_DIR module constant.
FRONTEND_DIST_DIR = FRONTEND_DIR / "dist"
# Stores the FRONTEND_NODE_MODULES_DIR module constant.
FRONTEND_NODE_MODULES_DIR = FRONTEND_DIR / "node_modules"
# Stores the FRONTEND_STATIC_DIR module constant.
FRONTEND_STATIC_DIR = FRONTEND_DIST_DIR if FRONTEND_DIST_DIR.exists() else FRONTEND_DIR
# Stores the SPACES_DIR module constant.
SPACES_DIR = Path(__file__).resolve().parent / "spaces"
SPACES_DIR.mkdir(parents=True, exist_ok=True)
# Stores the YSTORE_DIR module constant.
YSTORE_DIR = Path(__file__).resolve().parent / "ystore"
YSTORE_DIR.mkdir(parents=True, exist_ok=True)
# Stores the HISTORY_DIR module constant.
HISTORY_DIR = Path(__file__).resolve().parent / "history"
HISTORY_DIR.mkdir(parents=True, exist_ok=True)
# Stores the SESSIONS_FILE module constant.
SESSIONS_FILE = Path(__file__).resolve().parent / "sessions.json"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("server")

try:
    BASE_EXCEPTION_GROUP_TYPE = BaseExceptionGroup  # type: ignore[name-defined]
except NameError:  # pragma: no cover - Python < 3.11
    BASE_EXCEPTION_GROUP_TYPE = None

# Stores the SPACE_ID_RE module constant.
SPACE_ID_RE = re.compile(r"[a-zA-Z0-9_-]+")
# Stores the VALID_ROLES module constant.
VALID_ROLES = {"admin", "manager", "user"}
# Stores the PASSWORD_SALT_BYTES module constant.
PASSWORD_SALT_BYTES = 8
# Stores the DEFAULT_BOOTSTRAP_USERNAME module constant.
DEFAULT_BOOTSTRAP_USERNAME = "admin"
# Stores the DEFAULT_BOOTSTRAP_PASSWORD module constant.
DEFAULT_BOOTSTRAP_PASSWORD = "admin"
# Stores the SESSION_COOKIE_NAME module constant.
SESSION_COOKIE_NAME = "task_session"
# Stores the SESSION_TTL_SECONDS module constant.
SESSION_TTL_SECONDS = 60 * 60 * 24 * 30
# Stores the PERSONAL_FOLDER_NAME module constant.
PERSONAL_FOLDER_NAME = "personal"
# Stores the JIRA_DAEMON_DISPLAY_NAME module constant.
JIRA_DAEMON_DISPLAY_NAME = "Jira Daemon"

# Stores the PRESENCE_TTL module constant.
PRESENCE_TTL = 40
# Stores the AWARENESS_TTL_MS module constant.
AWARENESS_TTL_MS = PRESENCE_TTL * 1000
presence: Dict[str, Dict[str, float]] = {}
space_save_tasks: Dict[str, asyncio.Task] = {}
# Stores the SPACE_SAVE_DELAY module constant.
SPACE_SAVE_DELAY = 0.5
# Stores the HISTORY_AUTO_MIN_INTERVAL_SECONDS module constant.
HISTORY_AUTO_MIN_INTERVAL_SECONDS = 5 * 60
# Stores the SESSIONS_LOCK module constant.
SESSIONS_LOCK = threading.RLock()
# Stores the USERS_STORE_LOCK module constant.
USERS_STORE_LOCK = threading.RLock()
# Stores the HISTORY_LOCK module constant.
HISTORY_LOCK = threading.RLock()


# Defines the AuthUser structure used by this module.
@dataclass(frozen=True)
class AuthUser:
    username: str
    display_name: str
    role: str
    spaces: Tuple[str, ...]
    must_change_password: bool = False


# Handles the sanitize_space function logic.
# Input: space_id: str.
# Output: str.
def sanitize_space(space_id: str) -> str:
    if not re.fullmatch(SPACE_ID_RE, space_id or ""):
        raise HTTPException(status_code=400, detail="Invalid space id.")
    return space_id


# Handles the normalize_username function logic.
# Input: username: str.
# Output: str.
def normalize_username(username: str) -> str:
    cleaned = (username or "").strip()
    if not re.fullmatch(SPACE_ID_RE, cleaned):
        raise HTTPException(status_code=400, detail="Invalid username.")
    return cleaned


# Handles the normalize_role function logic.
# Input: value: Any.
# Output: str.
def normalize_role(value: Any) -> str:
    role = value.strip().lower() if isinstance(value, str) else ""
    return role if role in VALID_ROLES else "user"


# Handles the normalize_display_name function logic.
# Input: username: str, value: Any.
# Output: str.
def normalize_display_name(username: str, value: Any) -> str:
    if isinstance(value, str):
        cleaned = value.strip()
        if cleaned:
            return cleaned
    return username


# Handles the sanitize_folder_name function logic.
# Input: folder_name: str.
# Output: str.
def sanitize_folder_name(folder_name: str) -> str:
    cleaned = (folder_name or "").strip().replace("\\", "/")
    cleaned = re.sub(r"/+", "/", cleaned).strip("/")
    if not cleaned:
        raise HTTPException(status_code=400, detail="Invalid folder name.")
    parts = cleaned.split("/")
    if not parts or any(not re.fullmatch(SPACE_ID_RE, part) for part in parts):
        raise HTTPException(status_code=400, detail="Invalid folder name.")
    return "/".join(parts)


# Handles the normalize_folder_name function logic.
# Input: value: Any.
# Output: str.
def normalize_folder_name(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    cleaned = value.strip().replace("\\", "/")
    cleaned = re.sub(r"/+", "/", cleaned).strip("/")
    if not cleaned:
        return ""
    parts = cleaned.split("/")
    if not parts or any(not re.fullmatch(SPACE_ID_RE, part) for part in parts):
        return ""
    return "/".join(parts)


# Handles the is_personal_folder_name function logic.
# Input: folder_name: str.
# Output: bool.
def is_personal_folder_name(folder_name: str) -> bool:
    normalized = normalize_folder_name(folder_name)
    return normalized == PERSONAL_FOLDER_NAME or normalized.startswith(f"{PERSONAL_FOLDER_NAME}/")


# Handles the normalize_space_list function logic.
# Input: value: Any.
# Output: List[str].
def normalize_space_list(value: Any) -> List[str]:
    if not isinstance(value, list):
        return []
    normalized: List[str] = []
    seen: Set[str] = set()
    for item in value:
        if not isinstance(item, str):
            continue
        candidate = item.strip().replace("\\", "/")
        candidate = re.sub(r"/+", "/", candidate).strip("/")
        if not candidate:
            continue
        is_wildcard = candidate.endswith("/*")
        base = candidate[:-2] if is_wildcard else candidate
        base = normalize_folder_name(base)
        if not base:
            continue
        candidate = f"{base}/*" if is_wildcard else base
        if candidate in seen:
            continue
        seen.add(candidate)
        normalized.append(candidate)
    return sorted(normalized)


# Handles the md5_digest function logic.
# Input: password: str, salt: str.
# Output: str.
def md5_digest(password: str, salt: str) -> str:
    data = f"{salt}:{password}".encode("utf-8")
    return hashlib.md5(data).hexdigest()


# Handles the build_password_record function logic.
# Input: password: str.
# Output: Dict[str, str].
def build_password_record(password: str) -> Dict[str, str]:
    salt = secrets.token_hex(PASSWORD_SALT_BYTES)
    digest = md5_digest(password, salt)
    return {
        "password_salt": salt,
        "password_hash": digest,
    }


# Handles the is_hidden_system_user function logic.
# Input: username: str.
# Output: bool.
def is_hidden_system_user(username: str) -> bool:
    return username == JIRA_DAEMON_USERNAME


# Handles the normalize_password_record function logic.
# Input: raw: Any.
# Output: Dict[str, str].
def normalize_password_record(raw: Any) -> Dict[str, str]:
    if isinstance(raw, dict):
        salt = raw.get("password_salt")
        digest = raw.get("password_hash")
        algo = raw.get("password_algo")
        if (
            isinstance(salt, str)
            and isinstance(digest, str)
            and re.fullmatch(r"[0-9a-fA-F]+", salt)
            and re.fullmatch(r"[0-9a-fA-F]{32}", digest)
            and (
                algo is None
                or (isinstance(algo, str) and algo.lower() == "md5")
            )
        ):
            return {
                "password_salt": salt.lower(),
                "password_hash": digest.lower(),
            }
    return build_password_record(DEFAULT_BOOTSTRAP_PASSWORD)


# Handles the normalize_user_record function logic.
# Input: username: str, raw: Any.
# Output: Dict[str, Any].
def normalize_user_record(username: str, raw: Any) -> Dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    role = normalize_role(source.get("role"))
    display_name = normalize_display_name(username, source.get("display_name"))
    # Keep stored space rules for every role so they can be restored if role returns to "user".
    # Access checks still ignore these rules for admin/manager accounts.
    spaces = normalize_space_list(source.get("spaces"))
    password_record = normalize_password_record(source)
    return {
        "display_name": display_name,
        "role": role,
        "spaces": spaces,
        "must_change_password": bool(source.get("must_change_password")),
        **password_record,
    }


# Handles the verify_password function logic.
# Input: user_record: Dict[str, Any], password: str.
# Output: bool.
def verify_password(user_record: Dict[str, Any], password: str) -> bool:
    if not isinstance(password, str):
        return False
    salt = user_record.get("password_salt")
    digest = user_record.get("password_hash")
    if not isinstance(salt, str) or not isinstance(digest, str):
        return False
    return md5_digest(password, salt) == digest


# Handles the _atomic_write_text function logic.
# Input: path: Path, content: str.
# Output: None.
def _atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=str(path.parent),
        prefix=f".{path.name}.",
        suffix=".tmp",
        delete=False,
    ) as handle:
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())
        temp_name = handle.name
    os.replace(temp_name, path)


# Handles the run_blocking_io function logic.
# Input: func, *args: Any, **kwargs: Any.
# Output: Any.
async def run_blocking_io(func, *args: Any, **kwargs: Any) -> Any:
    to_thread = getattr(asyncio, "to_thread", None)
    if callable(to_thread):
        return await to_thread(func, *args, **kwargs)
    loop = asyncio.get_running_loop()
    if kwargs:
        return await loop.run_in_executor(None, lambda: func(*args, **kwargs))
    return await loop.run_in_executor(None, func, *args)


# Handles the _mask_secret function logic.
# Input: value: str.
# Output: str.
def _mask_secret(value: str) -> str:
    secret = value.strip() if isinstance(value, str) else ""
    if not secret:
        return ""
    if len(secret) <= 4:
        return "*" * len(secret)
    return f"{'*' * max(4, len(secret) - 4)}{secret[-4:]}"


# Handles the _load_sessions_data function logic.
# Input: none.
# Output: Dict[str, Any].
def _load_sessions_data() -> Dict[str, Any]:
    with SESSIONS_LOCK:
        if not SESSIONS_FILE.exists():
            return {"sessions": {}}
        try:
            raw = SESSIONS_FILE.read_text(encoding="utf-8")
        except Exception:
            logger.exception("Failed to read sessions from %s", SESSIONS_FILE)
            return {"sessions": {}}
        try:
            data = json.loads(raw) if raw.strip() else {}
        except Exception:
            logger.exception("Failed to parse sessions JSON from %s", SESSIONS_FILE)
            return {"sessions": {}}
        if not isinstance(data, dict):
            return {"sessions": {}}
        sessions = data.get("sessions")
        if not isinstance(sessions, dict):
            data["sessions"] = {}
        return data


# Handles the _save_sessions_data function logic.
# Input: data: Dict[str, Any].
# Output: None.
def _save_sessions_data(data: Dict[str, Any]) -> None:
    try:
        with SESSIONS_LOCK:
            _atomic_write_text(
                SESSIONS_FILE,
                json.dumps(data, ensure_ascii=False, indent=2),
            )
    except Exception:
        logger.exception("Failed to write sessions to %s", SESSIONS_FILE)


# Handles the _cleanup_sessions function logic.
# Input: data: Dict[str, Any].
# Output: Tuple[Dict[str, Dict[str, Any]], bool].
def _cleanup_sessions(data: Dict[str, Any]) -> Tuple[Dict[str, Dict[str, Any]], bool]:
    changed = False
    now = int(time.time())
    source = data.get("sessions")
    sessions = source if isinstance(source, dict) else {}
    if source is not sessions:
        changed = True
    valid: Dict[str, Dict[str, Any]] = {}
    for token, payload in sessions.items():
        if not isinstance(token, str) or not isinstance(payload, dict):
            changed = True
            continue
        username = payload.get("username")
        expires_at = payload.get("expires_at")
        created_at = payload.get("created_at")
        if not isinstance(username, str) or not username:
            changed = True
            continue
        if not isinstance(expires_at, int) or expires_at <= now:
            changed = True
            continue
        if not isinstance(created_at, int):
            created_at = now
            changed = True
        session_payload = {
            "username": username,
            "created_at": created_at,
            "expires_at": expires_at,
        }
        last_space = payload.get("last_space")
        if isinstance(last_space, str):
            candidate = last_space.strip()
            if candidate and re.fullmatch(SPACE_ID_RE, candidate):
                session_payload["last_space"] = candidate
            elif candidate:
                changed = True
        elif last_space is not None:
            changed = True
        valid[token] = session_payload
    if valid != sessions:
        data["sessions"] = valid
        changed = True
    return valid, changed


# Handles the create_session function logic.
# Input: username: str.
# Output: Tuple[str, int].
def create_session(username: str) -> Tuple[str, int]:
    with SESSIONS_LOCK:
        data = _load_sessions_data()
        sessions, _ = _cleanup_sessions(data)
        token = secrets.token_urlsafe(32)
        now = int(time.time())
        expires_at = now + SESSION_TTL_SECONDS
        sessions[token] = {
            "username": username,
            "created_at": now,
            "expires_at": expires_at,
            "last_space": "",
        }
        data["sessions"] = sessions
        _save_sessions_data(data)
        return token, expires_at


# Handles the remove_session function logic.
# Input: token: Optional[str].
# Output: None.
def remove_session(token: Optional[str]) -> None:
    if not token:
        return
    with SESSIONS_LOCK:
        data = _load_sessions_data()
        sessions, changed = _cleanup_sessions(data)
        if token in sessions:
            sessions.pop(token, None)
            changed = True
        if changed:
            data["sessions"] = sessions
            _save_sessions_data(data)


# Handles the remove_sessions_for_user function logic.
# Input: username: str, keep_token: Optional[str] = None.
# Output: None.
def remove_sessions_for_user(username: str, keep_token: Optional[str] = None) -> None:
    with SESSIONS_LOCK:
        data = _load_sessions_data()
        sessions, changed = _cleanup_sessions(data)
        keys = [
            token
            for token, payload in sessions.items()
            if payload.get("username") == username and token != keep_token
        ]
        if keys:
            for key in keys:
                sessions.pop(key, None)
            changed = True
        if changed:
            data["sessions"] = sessions
            _save_sessions_data(data)


# Handles the auth_from_session function logic.
# Input: token: Optional[str].
# Output: Optional[AuthUser].
def auth_from_session(token: Optional[str]) -> Optional[AuthUser]:
    if not token:
        return None
    with SESSIONS_LOCK:
        data = _load_sessions_data()
        sessions, changed = _cleanup_sessions(data)
        payload = sessions.get(token)
        if changed:
            data["sessions"] = sessions
            _save_sessions_data(data)
        if not payload:
            return None
        username = payload.get("username")
        if not isinstance(username, str) or not username:
            return None
        users = load_users_store()
        record = users.get(username)
        if not record:
            sessions.pop(token, None)
            data["sessions"] = sessions
            _save_sessions_data(data)
            return None
        return user_record_to_auth(username, record)


# Handles the get_session_last_space function logic.
# Input: token: Optional[str], auth: AuthUser.
# Output: str.
def get_session_last_space(token: Optional[str], auth: AuthUser) -> str:
    if not token:
        return ""
    with SESSIONS_LOCK:
        data = _load_sessions_data()
        sessions, changed = _cleanup_sessions(data)
        payload = sessions.get(token)
        if not isinstance(payload, dict):
            if changed:
                data["sessions"] = sessions
                _save_sessions_data(data)
            return ""
        last_space = payload.get("last_space")
        if not isinstance(last_space, str):
            if changed:
                data["sessions"] = sessions
                _save_sessions_data(data)
            return ""
        candidate = last_space.strip()
        if not candidate:
            if changed:
                data["sessions"] = sessions
                _save_sessions_data(data)
            return ""
        if not re.fullmatch(SPACE_ID_RE, candidate):
            payload.pop("last_space", None)
            data["sessions"] = sessions
            _save_sessions_data(data)
            return ""
        if not space_path(candidate).exists() or not can_access_space(auth, candidate):
            payload.pop("last_space", None)
            data["sessions"] = sessions
            _save_sessions_data(data)
            return ""
        if changed:
            data["sessions"] = sessions
            _save_sessions_data(data)
        return candidate


# Handles the set_session_last_space function logic.
# Input: token: Optional[str], space_id: str.
# Output: None.
def set_session_last_space(token: Optional[str], space_id: str) -> None:
    if not token:
        return
    with SESSIONS_LOCK:
        data = _load_sessions_data()
        sessions, changed = _cleanup_sessions(data)
        payload = sessions.get(token)
        if not isinstance(payload, dict):
            if changed:
                data["sessions"] = sessions
                _save_sessions_data(data)
            return
        current = payload.get("last_space")
        if current != space_id:
            payload["last_space"] = space_id
            changed = True
        if changed:
            data["sessions"] = sessions
            _save_sessions_data(data)


# Handles the update_last_space_for_renamed_space function logic.
# Input: source_id: str, target_id: str.
# Output: None.
def update_last_space_for_renamed_space(source_id: str, target_id: str) -> None:
    with SESSIONS_LOCK:
        data = _load_sessions_data()
        sessions, changed = _cleanup_sessions(data)
        for payload in sessions.values():
            if not isinstance(payload, dict):
                continue
            if payload.get("last_space") == source_id:
                payload["last_space"] = target_id
                changed = True
        if changed:
            data["sessions"] = sessions
            _save_sessions_data(data)


# Handles the clear_last_space_for_deleted_space function logic.
# Input: space_id: str.
# Output: None.
def clear_last_space_for_deleted_space(space_id: str) -> None:
    with SESSIONS_LOCK:
        data = _load_sessions_data()
        sessions, changed = _cleanup_sessions(data)
        for payload in sessions.values():
            if not isinstance(payload, dict):
                continue
            if payload.get("last_space") == space_id:
                payload.pop("last_space", None)
                changed = True
        if changed:
            data["sessions"] = sessions
            _save_sessions_data(data)


# Handles the _normalize_users_store function logic.
# Input: raw_users: Any.
# Output: Tuple[Dict[str, Dict[str, Any]], bool].
def _normalize_users_store(raw_users: Any) -> Tuple[Dict[str, Dict[str, Any]], bool]:
    users: Dict[str, Dict[str, Any]] = {}
    changed = False
    if not isinstance(raw_users, dict):
        return users, True
    for username, raw_record in raw_users.items():
        if not isinstance(username, str):
            changed = True
            continue
        candidate = username.strip()
        if not candidate or not re.fullmatch(SPACE_ID_RE, candidate):
            changed = True
            continue
        normalized = normalize_user_record(candidate, raw_record)
        users[candidate] = normalized
        if raw_record != normalized:
            changed = True
    return users, changed


# Handles the ensure_personal_space function logic.
# Input: username: str.
# Output: None.
def ensure_personal_space(username: str) -> None:
    ensure_personal_folder()
    target = personal_space_path(username)
    existing = find_space_file(username)
    if existing and existing != target and not target.exists():
        try:
            existing.rename(target)
        except Exception:
            logger.exception(
                "Failed to move personal space %s from %s to %s",
                username,
                existing,
                target,
            )
    if not target.exists():
        target.write_text("", encoding="utf-8")


# Handles the ensure_personal_spaces function logic.
# Input: users: Dict[str, Dict[str, Any]].
# Output: None.
def ensure_personal_spaces(users: Dict[str, Dict[str, Any]]) -> None:
    for username in users.keys():
        ensure_personal_space(username)


# Handles the load_users_store function logic.
# Input: none.
# Output: Dict[str, Dict[str, Any]].
def load_users_store() -> Dict[str, Dict[str, Any]]:
    with USERS_STORE_LOCK:
        users_data = load_users_config_data()
        users, changed = _normalize_users_store(users_data.get("users"))

        if not users:
            users = {
                DEFAULT_BOOTSTRAP_USERNAME: {
                    "display_name": DEFAULT_BOOTSTRAP_USERNAME,
                    "role": "admin",
                    "spaces": [],
                    "must_change_password": True,
                    **build_password_record(DEFAULT_BOOTSTRAP_PASSWORD),
                }
            }
            changed = True
        if not any(record.get("role") == "admin" for record in users.values()):
            first_user = sorted(users.keys())[0]
            users[first_user]["role"] = "admin"
            changed = True
        if changed:
            users_data["users"] = users
            save_users_config_data(users_data)
        ensure_personal_spaces(users)
        return users


# Handles the save_users_store function logic.
# Input: users: Dict[str, Dict[str, Any]].
# Output: None.
def save_users_store(users: Dict[str, Dict[str, Any]]) -> None:
    with USERS_STORE_LOCK:
        users_data = load_users_config_data()
        users_data["users"] = users
        save_users_config_data(users_data)
        ensure_personal_spaces(users)


# Handles the sorted_folder_names function logic.
# Input: names: Set[str].
# Output: List[str].
def sorted_folder_names(names: Set[str]) -> List[str]:
    normalized: Set[str] = set()
    for name in names:
        candidate = normalize_folder_name(name)
        if not candidate or is_personal_folder_name(candidate):
            continue
        normalized.add(candidate)
    return [PERSONAL_FOLDER_NAME, *sorted(normalized)]


# Handles the personal_folder_path function logic.
# Input: none.
# Output: Path.
def personal_folder_path() -> Path:
    return SPACES_DIR / PERSONAL_FOLDER_NAME


# Handles the ensure_personal_folder function logic.
# Input: none.
# Output: Path.
def ensure_personal_folder() -> Path:
    folder = personal_folder_path()
    folder.mkdir(parents=True, exist_ok=True)
    return folder


# Handles the folder_path function logic.
# Input: folder_name: str.
# Output: Path.
def folder_path(folder_name: str) -> Path:
    normalized = sanitize_folder_name(folder_name)
    return SPACES_DIR.joinpath(*normalized.split("/"))


# Handles the personal_space_path function logic.
# Input: username: str.
# Output: Path.
def personal_space_path(username: str) -> Path:
    return personal_folder_path() / f"{sanitize_space(username)}.txt"


# Handles the list_space_folder_names function logic.
# Input: none.
# Output: List[str].
def list_space_folder_names() -> List[str]:
    folders: Set[str] = set()
    ensure_personal_folder()
    for entry in SPACES_DIR.rglob("*"):
        if not entry.is_dir():
            continue
        try:
            relative = entry.relative_to(SPACES_DIR).as_posix()
        except Exception:
            continue
        folder_name = normalize_folder_name(relative)
        if folder_name and not is_personal_folder_name(folder_name):
            folders.add(folder_name)
    return sorted_folder_names(folders)


# Handles the iter_space_files function logic.
# Input: none.
# Output: List[Path].
def iter_space_files() -> List[Path]:
    files: List[Path] = []
    for path in SPACES_DIR.rglob("*.txt"):
        if path.is_file():
            files.append(path)
    return files


# Handles the folder_from_space_path function logic.
# Input: path: Path.
# Output: str.
def folder_from_space_path(path: Path) -> str:
    try:
        rel_parent = path.parent.relative_to(SPACES_DIR)
    except Exception:
        return ""
    if rel_parent == Path("."):
        return ""
    folder_name = normalize_folder_name(rel_parent.as_posix())
    return folder_name


# Handles the scan_space_files function logic.
# Input: none.
# Output: Dict[str, Path].
def scan_space_files() -> Dict[str, Path]:
    mapping: Dict[str, Path] = {}
    preferred_personal = personal_folder_path()
    for path in iter_space_files():
        space_id = normalize_space_id_from_filename(path)
        if not space_id:
            continue
        existing = mapping.get(space_id)
        if existing:
            if existing.parent != preferred_personal and path.parent == preferred_personal:
                mapping[space_id] = path
            logger.warning(
                "Duplicate space file for %s: keeping %s and ignoring %s",
                space_id,
                mapping[space_id],
                path,
            )
            continue
        mapping[space_id] = path
    return mapping


# Handles the canonical_space_path_for_file function logic.
# Input: path: Path, users: Optional[Dict[str, Dict[str, Any]]] = None.
# Output: str.
def canonical_space_path_for_file(path: Path, users: Optional[Dict[str, Dict[str, Any]]] = None) -> str:
    space_id = normalize_space_id_from_filename(path)
    if not space_id:
        return ""
    users = users or load_users_store()
    if space_id in users and path.parent == personal_folder_path():
        return space_id
    folder_name = folder_from_space_path(path)
    if not folder_name or is_personal_folder_name(folder_name):
        return space_id
    return f"{folder_name}/{space_id}"


# Handles the list_space_entries function logic.
# Input: users: Optional[Dict[str, Dict[str, Any]]] = None.
# Output: List[Dict[str, Any]].
def list_space_entries(users: Optional[Dict[str, Dict[str, Any]]] = None) -> List[Dict[str, Any]]:
    users = users or load_users_store()
    entries: List[Dict[str, Any]] = []
    for path in iter_space_files():
        space_id = normalize_space_id_from_filename(path)
        if not space_id:
            continue
        canonical_path = canonical_space_path_for_file(path, users)
        if not canonical_path:
            continue
        folder_name = folder_from_space_path(path)
        personal = space_id in users and path.parent == personal_folder_path()
        if is_personal_folder_name(folder_name):
            folder_name = ""
        entries.append(
            {
                "id": space_id,
                "path": canonical_path,
                "folder": folder_name,
                "personal": personal,
                "file": path,
            }
        )
    entries.sort(key=lambda entry: str(entry.get("path") or entry.get("id") or ""))
    return entries


# Handles the find_space_file_by_access_path function logic.
# Input: space_path_value: str, users: Optional[Dict[str, Dict[str, Any]]] = None,.
# Output: Optional[Path].
def find_space_file_by_access_path(
    space_path_value: str,
    users: Optional[Dict[str, Dict[str, Any]]] = None,
) -> Optional[Path]:
    normalized = normalize_folder_name(space_path_value)
    if not normalized:
        return None
    users = users or load_users_store()
    for entry in list_space_entries(users):
        if entry.get("path") == normalized:
            file_path = entry.get("file")
            return file_path if isinstance(file_path, Path) else None
    return None


# Handles the normalize_space_id_from_filename function logic.
# Input: path: Path.
# Output: str.
def normalize_space_id_from_filename(path: Path) -> str:
    if path.suffix != ".txt":
        return ""
    stem = path.stem
    if not re.fullmatch(SPACE_ID_RE, stem):
        return ""
    return stem


# Handles the find_space_file function logic.
# Input: space_id: str.
# Output: Optional[Path].
def find_space_file(space_id: str) -> Optional[Path]:
    safe_id = sanitize_space(space_id)
    return scan_space_files().get(safe_id)


# Handles the resolve_space_file function logic.
# Input: space_id: str, *, users: Optional[Dict[str, Dict[str, Any]]] = None, space_path_hint: Optional[str] = None,.
# Output: Optional[Path].
def resolve_space_file(
    space_id: str,
    *,
    users: Optional[Dict[str, Dict[str, Any]]] = None,
    space_path_hint: Optional[str] = None,
) -> Optional[Path]:
    safe_id = sanitize_space(space_id)
    users = users or load_users_store()
    normalized_hint = normalize_folder_name(space_path_hint)
    if normalized_hint:
        hinted_path = find_space_file_by_access_path(normalized_hint, users)
        if hinted_path and normalize_space_id_from_filename(hinted_path) == safe_id:
            return hinted_path
    return find_space_file(safe_id)


# Handles the folder_for_space function logic.
# Input: space_id: str, users: Dict[str, Dict[str, Any]], space_path_hint: Optional[str] = None,.
# Output: str.
def folder_for_space(
    space_id: str,
    users: Dict[str, Dict[str, Any]],
    space_path_hint: Optional[str] = None,
) -> str:
    if space_id in users:
        return PERSONAL_FOLDER_NAME
    path = resolve_space_file(space_id, users=users, space_path_hint=space_path_hint)
    if not path:
        return ""
    folder_name = folder_from_space_path(path)
    if is_personal_folder_name(folder_name):
        return ""
    return folder_name


# Handles the space_access_path function logic.
# Input: space_id: str, users: Dict[str, Dict[str, Any]].
# Output: str.
def space_access_path(space_id: str, users: Dict[str, Dict[str, Any]]) -> str:
    folder_name = folder_for_space(space_id, users)
    return f"{folder_name}/{space_id}" if folder_name else space_id


# Handles the build_space_path_index function logic.
# Input: users: Dict[str, Dict[str, Any]],.
# Output: Tuple[Dict[str, str], Set[str]].
def build_space_path_index(
    users: Dict[str, Dict[str, Any]],
) -> Tuple[Dict[str, str], Set[str]]:
    space_by_path: Dict[str, str] = {}
    folder_paths: Set[str] = set()
    for folder in list_space_folder_names():
        normalized = normalize_folder_name(folder)
        if normalized:
            folder_paths.add(normalized)
    for entry in list_space_entries(users):
        space_id = entry.get("id")
        if not isinstance(space_id, str):
            continue
        normalized_path = normalize_folder_name(entry.get("path"))
        if not normalized_path:
            continue
        space_by_path[normalized_path] = space_id
        if "/" in normalized_path:
            parts = normalized_path.split("/")[:-1]
            current = ""
            for part in parts:
                current = f"{current}/{part}" if current else part
                folder_paths.add(current)
    return space_by_path, folder_paths


# Handles the path_rule_allows_space function logic.
# Input: rule: str, space_path: str.
# Output: bool.
def path_rule_allows_space(rule: str, space_path: str) -> bool:
    if rule.endswith("/*"):
        folder = rule[:-2]
        return space_path.startswith(f"{folder}/")
    return rule == space_path


# Handles the update_access_paths_for_space_change function logic.
# Input: old_space_path: str, new_space_path: str,.
# Output: None.
def update_access_paths_for_space_change(
    old_space_path: str,
    new_space_path: str,
) -> None:
    if not old_space_path or not new_space_path or old_space_path == new_space_path:
        return
    with USERS_STORE_LOCK:
        users = load_users_store()
        changed = False
        for username, record in users.items():
            role = record.get("role", "user")
            if role != "user":
                continue
            rules = record.get("spaces")
            if not isinstance(rules, list):
                continue
            next_rules: List[str] = []
            local_changed = False
            for raw_rule in rules:
                if not isinstance(raw_rule, str):
                    continue
                rule = raw_rule.strip()
                if not rule:
                    continue
                if rule == old_space_path:
                    next_rules.append(new_space_path)
                    local_changed = True
                else:
                    next_rules.append(rule)
            if local_changed:
                normalized = normalize_user_record(
                    username,
                    {
                        **record,
                        "spaces": next_rules,
                    },
                )
                users[username] = normalized
                changed = True
        if changed:
            save_users_store(users)


# Handles the user_record_to_auth function logic.
# Input: username: str, record: Dict[str, Any].
# Output: AuthUser.
def user_record_to_auth(username: str, record: Dict[str, Any]) -> AuthUser:
    return AuthUser(
        username=username,
        display_name=record.get("display_name", username),
        role=record.get("role", "user"),
        spaces=tuple(record.get("spaces", [])),
        must_change_password=bool(record.get("must_change_password")),
    )


# Handles the authenticate function logic.
# Input: username: str, password: str.
# Output: Optional[AuthUser].
def authenticate(username: str, password: str) -> Optional[AuthUser]:
    users = load_users_store()
    record = users.get(username)
    if not record:
        return None
    if not verify_password(record, password):
        return None
    return user_record_to_auth(username, record)


# Handles the parse_basic_auth function logic.
# Input: authorization: Optional[str].
# Output: Optional[Tuple[str, str]].
def parse_basic_auth(authorization: Optional[str]) -> Optional[Tuple[str, str]]:
    if not authorization or not authorization.startswith("Basic "):
        return None
    token = authorization.split(" ", 1)[1]
    try:
        decoded = base64.b64decode(token).decode("utf-8")
    except Exception:
        return None
    if ":" not in decoded:
        return None
    username, password = decoded.split(":", 1)
    return username.strip(), password


# Handles the require_auth function logic.
# Input: request: Request, authorization: Optional[str] = Header(default=None), user: Optional[str] = Query(default=None), password: Optional[str] = Query(default=None),.
# Output: AuthUser.
def require_auth(
    request: Request,
    authorization: Optional[str] = Header(default=None),
    user: Optional[str] = Query(default=None),
    password: Optional[str] = Query(default=None),
) -> AuthUser:
    session_token = request.cookies.get(SESSION_COOKIE_NAME)
    auth = auth_from_session(session_token)
    if auth:
        return auth
    basic = parse_basic_auth(authorization)
    if basic:
        username, pwd = basic
        auth = authenticate(username, pwd)
        if auth:
            return auth
    if user and password:
        auth = authenticate(user.strip(), password)
        if auth:
            return auth
    raise HTTPException(status_code=401, detail="Unauthorized")


# Handles the can_manage_spaces function logic.
# Input: auth: AuthUser.
# Output: bool.
def can_manage_spaces(auth: AuthUser) -> bool:
    return auth.role == "admin"


# Handles the can_manage_jira function logic.
# Input: auth: AuthUser.
# Output: bool.
def can_manage_jira(auth: AuthUser) -> bool:
    return auth.role == "admin"


# Handles the can_manage_users function logic.
# Input: auth: AuthUser.
# Output: bool.
def can_manage_users(auth: AuthUser) -> bool:
    return auth.role in {"admin", "manager"}


# Handles the can_assign_space_access function logic.
# Input: auth: AuthUser.
# Output: bool.
def can_assign_space_access(auth: AuthUser) -> bool:
    return auth.role in {"admin", "manager"}


# Handles the can_access_space function logic.
# Input: auth: AuthUser, space_id: str, users: Optional[Dict[str, Dict[str, Any]]] = None, space_path_hint: Optional[str] = None,.
# Output: bool.
def can_access_space(
    auth: AuthUser,
    space_id: str,
    users: Optional[Dict[str, Dict[str, Any]]] = None,
    space_path_hint: Optional[str] = None,
) -> bool:
    users = users or load_users_store()
    if is_personal_space(space_id, users):
        if auth.role == "admin":
            return True
        return auth.username == space_id
    if auth.role in {"admin", "manager"}:
        return True
    normalized_hint = normalize_folder_name(space_path_hint)
    if normalized_hint and normalized_hint.split("/")[-1] == space_id:
        space_access = normalized_hint
    else:
        space_access = space_access_path(space_id, users)
    rules = set(auth.spaces)
    for rule in rules:
        if path_rule_allows_space(rule, space_access):
            return True
    return False


# Handles the ensure_space_access function logic.
# Input: auth: AuthUser, space_id: str, users: Optional[Dict[str, Dict[str, Any]]] = None, space_path_hint: Optional[str] = None,.
# Output: None.
def ensure_space_access(
    auth: AuthUser,
    space_id: str,
    users: Optional[Dict[str, Dict[str, Any]]] = None,
    space_path_hint: Optional[str] = None,
) -> None:
    if not can_access_space(auth, space_id, users, space_path_hint=space_path_hint):
        raise HTTPException(status_code=403, detail="Access denied.")


# Handles the serialize_auth function logic.
# Input: auth: AuthUser.
# Output: Dict[str, Any].
def serialize_auth(auth: AuthUser) -> Dict[str, Any]:
    return {
        "username": auth.username,
        "display_name": auth.display_name,
        "role": auth.role,
        "spaces": sorted(set(auth.spaces)),
        "must_change_password": bool(auth.must_change_password),
    }


# Handles the serialize_permissions function logic.
# Input: auth: AuthUser.
# Output: Dict[str, bool].
def serialize_permissions(auth: AuthUser) -> Dict[str, bool]:
    return {
        "can_manage_spaces": can_manage_spaces(auth),
        "can_manage_jira": can_manage_jira(auth),
        "can_manage_users": can_manage_users(auth),
        "can_assign_space_access": can_assign_space_access(auth),
    }


# Handles the is_personal_space function logic.
# Input: space_id: str, users: Optional[Dict[str, Dict[str, Any]]] = None,.
# Output: bool.
def is_personal_space(
    space_id: str,
    users: Optional[Dict[str, Dict[str, Any]]] = None,
) -> bool:
    users = users or load_users_store()
    return space_id in users


# Handles the validate_user_target_permissions function logic.
# Input: actor: AuthUser, target_username: str, target_record: Optional[Dict[str, Any]], desired_role: Optional[str] = None,.
# Output: None.
def validate_user_target_permissions(
    actor: AuthUser,
    target_username: str,
    target_record: Optional[Dict[str, Any]],
    desired_role: Optional[str] = None,
) -> None:
    if not can_manage_users(actor):
        raise HTTPException(status_code=403, detail="Not allowed.")
    if actor.role == "admin":
        return
    if target_username == actor.username:
        raise HTTPException(status_code=403, detail="Managers cannot edit their own role.")
    target_role = target_record.get("role") if target_record else desired_role or "user"
    if target_role != "user":
        raise HTTPException(status_code=403, detail="Managers can only manage user accounts.")
    if desired_role and desired_role != "user":
        raise HTTPException(status_code=403, detail="Managers can only assign the user role.")


# Handles the remove_presence_from_all_spaces function logic.
# Input: username: str.
# Output: None.
def remove_presence_from_all_spaces(username: str) -> None:
    for space_id in list(presence.keys()):
        remove_presence(space_id, username)


# Handles the user_view function logic.
# Input: username: str, record: Dict[str, Any], actor: AuthUser,.
# Output: Dict[str, Any].
def user_view(
    username: str,
    record: Dict[str, Any],
    actor: AuthUser,
) -> Dict[str, Any]:
    role = record.get("role", "user")
    spaces = sorted(record.get("spaces", []))
    editable = actor.role == "admin" or (
        actor.role == "manager" and role == "user" and username != actor.username
    )
    if username == actor.username:
        editable = True
    deletable = actor.role == "admin" or (
        actor.role == "manager" and role == "user" and username != actor.username
    )
    return {
        "username": username,
        "display_name": record.get("display_name", username),
        "role": role,
        "spaces": spaces,
        "personal_space": username,
        "self": username == actor.username,
        "editable": editable,
        "deletable": deletable,
    }


# Handles the list_visible_spaces function logic.
# Input: auth: AuthUser.
# Output: List[str].
def list_visible_spaces(auth: AuthUser) -> List[str]:
    users = load_users_store()
    spaces = sorted(existing_space_ids())
    return [space_id for space_id in spaces if can_access_space(auth, space_id, users)]


# Handles the list_visible_space_entries function logic.
# Input: auth: AuthUser.
# Output: List[Dict[str, Any]].
def list_visible_space_entries(auth: AuthUser) -> List[Dict[str, Any]]:
    users = load_users_store()
    visible: List[Dict[str, Any]] = []
    for entry in list_space_entries(users):
        space_id = entry.get("id")
        space_path_value = entry.get("path")
        if not isinstance(space_id, str) or not isinstance(space_path_value, str):
            continue
        if can_access_space(auth, space_id, users, space_path_hint=space_path_value):
            visible.append(entry)
    return visible


# Handles the filter_history_key_alias_space_entries function logic.
# Input: entries: List[Dict[str, Any]].
# Output: List[Dict[str, Any]].
def filter_history_key_alias_space_entries(entries: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    # Hide legacy/accidental space files named with a history storage key when the real
    # canonical space path is already present in the listing.
    history_key_matches: Dict[str, Set[str]] = {}
    for entry in entries:
        path_value = entry.get("path")
        if not isinstance(path_value, str) or not path_value.strip():
            continue
        canonical_path = normalize_folder_name(path_value) or sanitize_space(path_value)
        if not canonical_path:
            continue
        key = history_key_from_space_canonical_path(canonical_path)
        history_key_matches.setdefault(key, set()).add(canonical_path)

    filtered: List[Dict[str, Any]] = []
    for entry in entries:
        space_id = entry.get("id")
        path_value = entry.get("path")
        canonical_path = ""
        if isinstance(path_value, str) and path_value.strip():
            canonical_path = normalize_folder_name(path_value) or sanitize_space(path_value)
        if not isinstance(space_id, str) or not space_id:
            continue
        matching_paths = history_key_matches.get(space_id, set())
        if any(candidate != canonical_path for candidate in matching_paths):
            continue
        filtered.append(entry)
    return filtered


# Handles the existing_space_ids function logic.
# Input: none.
# Output: Set[str].
def existing_space_ids() -> Set[str]:
    return set(scan_space_files().keys())


# Handles the ensure_space_exists function logic.
# Input: space_id: str.
# Output: None.
def ensure_space_exists(space_id: str) -> None:
    if space_id not in existing_space_ids():
        raise HTTPException(status_code=404, detail="Space not found.")


# Handles the validate_assigned_spaces function logic.
# Input: spaces: List[str], target_username: str, users: Optional[Dict[str, Dict[str, Any]]] = None,.
# Output: List[str].
def validate_assigned_spaces(
    spaces: List[str],
    target_username: str,
    users: Optional[Dict[str, Dict[str, Any]]] = None,
) -> List[str]:
    users = users or load_users_store()
    space_by_path, folder_paths = build_space_path_index(users)
    normalized = normalize_space_list(spaces)
    result: List[str] = []
    seen: Set[str] = set()
    invalid_paths: List[str] = []

    for raw_entry in normalized:
        entry = raw_entry.strip()
        canonical = ""
        if entry.endswith("/*"):
            folder = normalize_folder_name(entry[:-2])
            if (
                not folder
                or is_personal_folder_name(folder)
                or folder not in folder_paths
            ):
                invalid_paths.append(raw_entry)
                continue
            canonical = f"{folder}/*"
        else:
            path = normalize_folder_name(entry)
            if not path or is_personal_folder_name(path):
                invalid_paths.append(raw_entry)
                continue
            if path in space_by_path:
                canonical = path
            elif path in folder_paths:
                canonical = f"{path}/*"
            else:
                invalid_paths.append(raw_entry)
                continue
        if canonical in seen:
            continue
        seen.add(canonical)
        result.append(canonical)

    if invalid_paths:
        names = ", ".join(sorted(set(invalid_paths)))
        raise HTTPException(status_code=400, detail=f"Unknown access paths: {names}.")

    return sorted(result)


# Handles the space_path function logic.
# Input: space_id: str, *, users: Optional[Dict[str, Dict[str, Any]]] = None, space_path_hint: Optional[str] = None,.
# Output: Path.
def space_path(
    space_id: str,
    *,
    users: Optional[Dict[str, Dict[str, Any]]] = None,
    space_path_hint: Optional[str] = None,
) -> Path:
    safe = sanitize_space(space_id)
    existing = resolve_space_file(safe, users=users, space_path_hint=space_path_hint)
    if existing:
        return existing
    return SPACES_DIR / f"{safe}.txt"


# Handles the ystore_key_for_space function logic.
# Input: space_id: str, *, users: Optional[Dict[str, Dict[str, Any]]] = None, space_path_hint: Optional[str] = None.
# Output: str.
def ystore_key_for_space(space_id: str, *, users: Optional[Dict[str, Dict[str, Any]]] = None, space_path_hint: Optional[str] = None) -> str:
    safe = sanitize_space(space_id)
    normalized_hint = normalize_folder_name(space_path_hint)
    if normalized_hint and normalized_hint.split("/")[-1] == safe:
        return history_key_from_space_canonical_path(normalized_hint)
    users = users or load_users_store()
    canonical = space_access_path(safe, users)
    return history_key_from_space_canonical_path(canonical)


# Handles the ystore_path function logic.
# Input: space_id: str, *, users: Optional[Dict[str, Dict[str, Any]]] = None, space_path_hint: Optional[str] = None.
# Output: Path.
def ystore_path(space_id: str, *, users: Optional[Dict[str, Dict[str, Any]]] = None, space_path_hint: Optional[str] = None) -> Path:
    key = ystore_key_for_space(space_id, users=users, space_path_hint=space_path_hint)
    return YSTORE_DIR / f"{key}.ystore"


# Handles the history_key_from_space_canonical_path function logic.
# Input: space_path_value: str.
# Output: str.
def history_key_from_space_canonical_path(space_path_value: str) -> str:
    canonical = normalize_folder_name(space_path_value)
    if not canonical:
        canonical = sanitize_space(space_path_value)
    # Filesystem-safe and stable for a given canonical path.
    raw = canonical.encode("utf-8")
    encoded = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    return encoded or "root"


# Handles the history_key_for_space function logic.
# Input: space_id: str, users: Optional[Dict[str, Dict[str, Any]]] = None, *, space_path_hint: Optional[str] = None,.
# Output: str.
def history_key_for_space(
    space_id: str,
    users: Optional[Dict[str, Dict[str, Any]]] = None,
    *,
    space_path_hint: Optional[str] = None,
) -> str:
    safe_id = sanitize_space(space_id)
    normalized_hint = normalize_folder_name(space_path_hint)
    if normalized_hint and normalized_hint.split("/")[-1] == safe_id:
        return history_key_from_space_canonical_path(normalized_hint)
    users = users or load_users_store()
    canonical = space_access_path(safe_id, users)
    return history_key_from_space_canonical_path(canonical)


# Handles the move_history_for_space_path_change function logic.
# Input: old_space_path: str, new_space_path: str.
# Output: None.
def move_history_for_space_path_change(old_space_path: str, new_space_path: str) -> None:
    old_path = normalize_folder_name(old_space_path)
    new_path = normalize_folder_name(new_space_path)
    if not old_path:
        old_path = sanitize_space(old_space_path)
    if not new_path:
        new_path = sanitize_space(new_space_path)
    if old_path == new_path:
        return

    old_key = history_key_from_space_canonical_path(old_path)
    new_key = history_key_from_space_canonical_path(new_path)
    if old_key == new_key:
        return

    source_dir = history_space_dir(old_key)
    target_dir = history_space_dir(new_key)

    with HISTORY_LOCK:
        if not source_dir.exists():
            return
        if not target_dir.exists():
            source_dir.rename(target_dir)
            return

        source_entries = load_history_index(old_key)
        target_entries = load_history_index(new_key)
        merged_entries = list(target_entries)

        for entry in source_entries:
            checkpoint_id = entry.get("id")
            if not isinstance(checkpoint_id, str):
                continue
            source_file = history_checkpoint_path(old_key, checkpoint_id)
            if not source_file.exists():
                continue
            target_checkpoint_id = checkpoint_id
            target_file = history_checkpoint_path(new_key, target_checkpoint_id)
            if target_file.exists():
                target_checkpoint_id = f"{checkpoint_id}-{secrets.token_hex(2)}"
                target_file = history_checkpoint_path(new_key, target_checkpoint_id)
                entry = {**entry, "id": target_checkpoint_id}
            target_file.parent.mkdir(parents=True, exist_ok=True)
            source_file.rename(target_file)
            merged_entries.append(entry)

        save_history_index(new_key, merged_entries)
        try:
            source_index = history_index_path(old_key)
            if source_index.exists():
                source_index.unlink()
            source_dir.rmdir()
        except Exception:
            logger.exception("Failed to clean old history dir %s after merge", source_dir)


# Handles the history_space_dir function logic.
# Input: space_key: str.
# Output: Path.
def history_space_dir(space_key: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", space_key or ""):
        raise HTTPException(status_code=400, detail="Invalid history key.")
    return HISTORY_DIR / space_key


# Handles the history_index_path function logic.
# Input: space_key: str.
# Output: Path.
def history_index_path(space_key: str) -> Path:
    return history_space_dir(space_key) / "index.json"


# Handles the history_checkpoint_path function logic.
# Input: space_key: str, checkpoint_id: str.
# Output: Path.
def history_checkpoint_path(space_key: str, checkpoint_id: str) -> Path:
    if not re.fullmatch(r"[a-zA-Z0-9_.-]+", checkpoint_id or ""):
        raise HTTPException(status_code=400, detail="Invalid checkpoint id.")
    if checkpoint_id == "index":
        raise HTTPException(status_code=400, detail="Invalid checkpoint id.")
    return history_space_dir(space_key) / f"{checkpoint_id}.txt"


# Handles the history_content_hash function logic.
# Input: content: str.
# Output: str.
def history_content_hash(content: str) -> str:
    return hashlib.sha256((content or "").encode("utf-8")).hexdigest()


# Handles the _history_timestamp_iso function logic.
# Input: epoch_seconds: int.
# Output: str.
def _history_timestamp_iso(epoch_seconds: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch_seconds))


# Handles the _normalize_history_index function logic.
# Input: raw: Any.
# Output: List[Dict[str, Any]].
def _normalize_history_index(raw: Any) -> List[Dict[str, Any]]:
    if not isinstance(raw, dict):
        return []
    entries = raw.get("checkpoints")
    if not isinstance(entries, list):
        return []
    normalized: List[Dict[str, Any]] = []
    for item in entries:
        if not isinstance(item, dict):
            continue
        checkpoint_id = item.get("id")
        if not isinstance(checkpoint_id, str) or not re.fullmatch(r"[a-zA-Z0-9_.-]+", checkpoint_id):
            continue
        created_at = item.get("created_at")
        if not isinstance(created_at, int):
            continue
        kind = item.get("kind")
        if kind not in {"auto", "manual", "revert-base"}:
            kind = "auto"
        label = item.get("label")
        if not isinstance(label, str) or not label.strip():
            label = None
        content_hash = item.get("content_hash")
        if not isinstance(content_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", content_hash):
            continue
        size = item.get("size")
        if not isinstance(size, int) or size < 0:
            size = 0
        created_at_iso = item.get("created_at_iso")
        if not isinstance(created_at_iso, str) or not created_at_iso.strip():
            created_at_iso = _history_timestamp_iso(created_at)
        normalized.append(
            {
                "id": checkpoint_id,
                "created_at": created_at,
                "created_at_iso": created_at_iso,
                "kind": kind,
                "label": label,
                "content_hash": content_hash,
                "size": size,
            }
        )
    normalized.sort(key=lambda entry: int(entry.get("created_at", 0)))
    return normalized


# Handles the load_history_index function logic.
# Input: space_key: str.
# Output: List[Dict[str, Any]].
def load_history_index(space_key: str) -> List[Dict[str, Any]]:
    index_path = history_index_path(space_key)
    with HISTORY_LOCK:
        if not index_path.exists():
            return []
        try:
            raw = index_path.read_text(encoding="utf-8")
        except Exception:
            logger.exception("Failed to read history index for key %s", space_key)
            return []
        try:
            data = json.loads(raw) if raw.strip() else {}
        except Exception:
            logger.exception("Failed to parse history index for key %s", space_key)
            return []
        return _normalize_history_index(data)


# Handles the save_history_index function logic.
# Input: space_key: str, checkpoints: List[Dict[str, Any]].
# Output: None.
def save_history_index(space_key: str, checkpoints: List[Dict[str, Any]]) -> None:
    index_path = history_index_path(space_key)
    payload = json.dumps(
        {
            "checkpoints": _normalize_history_index({"checkpoints": checkpoints}),
        },
        ensure_ascii=False,
        indent=2,
    )
    with HISTORY_LOCK:
        _atomic_write_text(index_path, payload)


# Handles the read_history_checkpoint function logic.
# Input: space_key: str, checkpoint_id: str.
# Output: str.
def read_history_checkpoint(space_key: str, checkpoint_id: str) -> str:
    path = history_checkpoint_path(space_key, checkpoint_id)
    with HISTORY_LOCK:
        if not path.exists():
            raise HTTPException(status_code=404, detail="History checkpoint not found.")
        try:
            return path.read_text(encoding="utf-8")
        except Exception:
            logger.exception("Failed to read history checkpoint %s for key %s", checkpoint_id, space_key)
            raise HTTPException(status_code=500, detail="Failed to read history checkpoint.")


# Handles the create_history_checkpoint function logic.
# Input: space_key: str, content: str, *, kind: str = "auto", label: Optional[str] = None, created_at: Optional[int] = None,.
# Output: Dict[str, Any].
def create_history_checkpoint(
    space_key: str,
    content: str,
    *,
    kind: str = "auto",
    label: Optional[str] = None,
    created_at: Optional[int] = None,
) -> Dict[str, Any]:
    if kind not in {"auto", "manual", "revert-base"}:
        kind = "auto"
    normalized_label = label.strip() if isinstance(label, str) else ""
    if not normalized_label:
        normalized_label = None
    timestamp = int(created_at if isinstance(created_at, int) else time.time())
    checkpoint_id = f"{timestamp}-{secrets.token_hex(4)}"
    text = content if isinstance(content, str) else str(content or "")
    metadata = {
        "id": checkpoint_id,
        "created_at": timestamp,
        "created_at_iso": _history_timestamp_iso(timestamp),
        "kind": kind,
        "label": normalized_label,
        "content_hash": history_content_hash(text),
        "size": len(text),
    }
    checkpoint_path = history_checkpoint_path(space_key, checkpoint_id)
    with HISTORY_LOCK:
        _atomic_write_text(checkpoint_path, text)
        checkpoints = load_history_index(space_key)
        checkpoints.append(metadata)
        save_history_index(space_key, checkpoints)
    return metadata


# Handles the latest_history_checkpoint function logic.
# Input: space_key: str.
# Output: Optional[Dict[str, Any]].
def latest_history_checkpoint(space_key: str) -> Optional[Dict[str, Any]]:
    checkpoints = load_history_index(space_key)
    return checkpoints[-1] if checkpoints else None


# Handles the maybe_create_auto_history_checkpoint function logic.
# Input: space_key: str, content: str, *, now_epoch: Optional[int] = None,.
# Output: Optional[Dict[str, Any]].
def maybe_create_auto_history_checkpoint(
    space_key: str,
    content: str,
    *,
    now_epoch: Optional[int] = None,
) -> Optional[Dict[str, Any]]:
    timestamp = int(now_epoch if isinstance(now_epoch, int) else time.time())
    text = content if isinstance(content, str) else str(content or "")
    digest = history_content_hash(text)
    previous = latest_history_checkpoint(space_key)
    if previous:
        if previous.get("content_hash") == digest:
            return None
        previous_ts = previous.get("created_at")
        if isinstance(previous_ts, int) and timestamp - previous_ts < HISTORY_AUTO_MIN_INTERVAL_SECONDS:
            return None
    return create_history_checkpoint(
        space_key,
        text,
        kind="auto",
        created_at=timestamp,
    )


# Handles the write_space_text_and_maybe_checkpoint function logic.
# Input: space_id: str, content: str, *, space_path_hint: Optional[str] = None.
# Output: None.
def write_space_text_and_maybe_checkpoint(space_id: str, content: str, *, space_path_hint: Optional[str] = None) -> None:
    text = content if isinstance(content, str) else str(content or "")
    _atomic_write_text(space_path(space_id, space_path_hint=space_path_hint), text)
    maybe_create_auto_history_checkpoint(history_key_for_space(space_id, space_path_hint=space_path_hint), text)


# Handles the room_name function logic.
# Input: space_id: str, *, users: Optional[Dict[str, Dict[str, Any]]] = None, space_path_hint: Optional[str] = None.
# Output: str.
def room_name(space_id: str, *, users: Optional[Dict[str, Dict[str, Any]]] = None, space_path_hint: Optional[str] = None) -> str:
    safe_id = sanitize_space(space_id)
    normalized_hint = normalize_folder_name(space_path_hint)
    if normalized_hint and normalized_hint.split("/")[-1] == safe_id:
        return f"/ws/{normalized_hint}"
    return f"/ws/{safe_id}"


# Handles the normalize_space_path_hint_for_id function logic.
# Input: space_id: str, value: Any.
# Output: str.
def normalize_space_path_hint_for_id(space_id: str, value: Any) -> str:
    normalized = normalize_folder_name(value)
    if not normalized:
        return ""
    safe_id = sanitize_space(space_id)
    if normalized.split("/")[-1] != safe_id:
        raise HTTPException(status_code=400, detail="Space path does not match space id.")
    return normalized


# Handles the disconnect_space_clients function logic.
# Input: space_id: str.
# Output: int.
async def disconnect_space_clients(space_id: str) -> int:
    room = websocket_server.rooms.get(room_name(space_id))
    if not room:
        return 0

    disconnected = 0
    clients = list(getattr(room, "clients", []))
    for client in clients:
        try:
            close = getattr(client, "close", None)
            if callable(close):
                try:
                    result = close(code=1001, reason="Space deleted")
                except TypeError:
                    result = close()
                if hasattr(result, "__await__"):
                    await result
                disconnected += 1
                continue

            sender = getattr(client, "_send", None)
            if callable(sender):
                await sender(
                    {
                        "type": "websocket.close",
                        "code": 1001,
                        "reason": "Space deleted",
                    }
                )
                disconnected += 1
        except Exception:
            logger.exception("Failed to disconnect websocket client for space %s", space_id)

    return disconnected


# Handles the ydoc_to_text function logic.
# Input: ydoc: Y.YDoc.
# Output: str.
def ydoc_to_text(ydoc: Y.YDoc) -> str:
    text = ydoc.get_text("content")
    raw = text.to_json()
    if isinstance(raw, str):
        if len(raw) >= 2 and raw[0] == raw[-1] == '"':
            return raw[1:-1]
        return raw
    return str(raw)


# Handles the replace_ydoc_text function logic.
# Input: ydoc: Y.YDoc, content: str.
# Output: None.
def replace_ydoc_text(ydoc: Y.YDoc, content: str) -> None:
    text = ydoc.get_text("content")

    # Handles the apply function logic.
    # Input: txn.
    # Output: value produced by this function.
    def apply(txn):
        if len(text):
            text.delete_range(txn, 0, len(text))
        if content:
            text.insert(txn, 0, content)

    ydoc.transact(apply)


# Handles the schedule_space_snapshot function logic.
# Input: space_id: str, room, *, space_path_hint: Optional[str] = None.
# Output: None.
def schedule_space_snapshot(space_id: str, room, *, space_path_hint: Optional[str] = None) -> None:
    task_key = room_name(space_id, space_path_hint=space_path_hint)
    mapped_room = websocket_server.rooms.get(task_key)
    if mapped_room is not room:
        return
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        try:
            content = ydoc_to_text(room.ydoc)
            write_space_text_and_maybe_checkpoint(space_id, content, space_path_hint=space_path_hint)
        except Exception:
            logger.exception("Failed to snapshot space %s (sync)", space_id)
        return

    if task_key in space_save_tasks:
        space_save_tasks[task_key].cancel()

    task_ref: Optional[asyncio.Task] = None

    # Handles the _save function logic.
    # Input: none.
    # Output: value produced by this function.
    async def _save():
        try:
            await asyncio.sleep(SPACE_SAVE_DELAY)
            content = ydoc_to_text(room.ydoc)
            await run_blocking_io(
                write_space_text_and_maybe_checkpoint,
                space_id,
                content,
                space_path_hint=space_path_hint,
            )
        except asyncio.CancelledError:
            return
        except Exception:
            logger.exception("Failed to snapshot space %s", space_id)
        finally:
            if task_ref is not None and space_save_tasks.get(task_key) is task_ref:
                space_save_tasks.pop(task_key, None)

    task_ref = asyncio.create_task(_save())
    space_save_tasks[task_key] = task_ref


# Handles the hydrate_room_from_storage function logic.
# Input: space_id: str, room, *, space_path_hint: Optional[str] = None.
# Output: None.
async def hydrate_room_from_storage(space_id: str, room, *, space_path_hint: Optional[str] = None) -> None:
    store_path = ystore_path(space_id, space_path_hint=space_path_hint)
    loaded_from_ystore = False
    if store_path.exists():
        try:
            await room.ystore.apply_updates(room.ydoc)
            loaded_from_ystore = True
        except Exception:
            logger.exception(
                "Failed to apply ystore for %s; falling back to snapshot",
                space_id,
            )
            backup_path = store_path.with_suffix(f".ystore.corrupt.{int(time.time())}")
            try:
                store_path.rename(backup_path)
                logger.warning("Corrupt ystore moved to %s", backup_path)
            except Exception:
                try:
                    store_path.unlink()
                    logger.warning("Corrupt ystore removed for %s", space_id)
                except Exception:
                    logger.exception("Failed to remove corrupt ystore for %s", space_id)

    if not loaded_from_ystore:
        content_path = space_path(space_id, space_path_hint=space_path_hint)
        if content_path.exists():
            content = content_path.read_text(encoding="utf-8")
            if content:
                replace_ydoc_text(room.ydoc, content)
                try:
                    await room.ystore.encode_state_as_update(room.ydoc)
                except Exception:
                    logger.exception("Failed to seed ystore for %s from snapshot", space_id)
    room.ready = True
    schedule_space_snapshot(space_id, room, space_path_hint=space_path_hint)


# Handles the attach_snapshot_hook function logic.
# Input: space_id: str, room, *, space_path_hint: Optional[str] = None.
# Output: None.
def attach_snapshot_hook(space_id: str, room, *, space_path_hint: Optional[str] = None) -> None:
    if getattr(room, "_snapshot_hook", False):
        return

    # Handles the _after_txn function logic.
    # Input: *_args, **_kwargs.
    # Output: value produced by this function.
    def _after_txn(*_args, **_kwargs):
        schedule_space_snapshot(space_id, room, space_path_hint=space_path_hint)

    room.ydoc.observe_after_transaction(_after_txn)
    room._snapshot_hook = True


# Handles the attach_awareness_hook function logic.
# Input: room.
# Output: None.
def attach_awareness_hook(room) -> None:
    if getattr(room, "_awareness_hook", False):
        return

    previous_handler = getattr(room, "on_message", None)

    # Handles the _on_message function logic.
    # Input: message: bytes.
    # Output: bool.
    def _on_message(message: bytes) -> bool:
        try:
            if message and message[0] == int(YMessageType.AWARENESS):
                room.awareness.get_changes(message[1:])
        except Exception:
            logger.exception("Failed to parse awareness message")
        if callable(previous_handler):
            result = previous_handler(message)
            return bool(result)
        return False

    room.on_message = _on_message
    room._awareness_hook = True


# Handles the _cleanup_room_awareness function logic.
# Input: room.
# Output: None.
def _cleanup_room_awareness(room) -> None:
    awareness = getattr(room, "awareness", None)
    if awareness is None:
        return
    now_ms = int(time.time() * 1000)
    stale_client_ids = []
    for client_id, meta in list(getattr(awareness, "meta", {}).items()):
        last_updated = meta.get("last_updated") if isinstance(meta, dict) else None
        if not isinstance(last_updated, (int, float)):
            continue
        if now_ms - int(last_updated) > AWARENESS_TTL_MS:
            stale_client_ids.append(client_id)
    for client_id in stale_client_ids:
        awareness.meta.pop(client_id, None)
        awareness.states.pop(client_id, None)


# Handles the sync_snapshots_from_ystore_on_startup function logic.
# Input: none.
# Output: None.
async def sync_snapshots_from_ystore_on_startup() -> None:
    if not YSTORE_DIR.exists():
        return
    for store_path in YSTORE_DIR.glob("*.ystore"):
        space_id = store_path.stem
        logger.info("Boot sync: loading ystore for %s", space_id)
        ydoc = Y.YDoc()
        store = FileYStore(str(store_path))
        try:
            await store.apply_updates(ydoc)
        except Exception:
            logger.exception("Failed to load ystore for %s during boot sync", space_id)
            backup_path = store_path.with_suffix(f".ystore.corrupt.{int(time.time())}")
            try:
                store_path.rename(backup_path)
                logger.warning("Corrupt ystore moved to %s", backup_path)
            except Exception:
                try:
                    store_path.unlink()
                    logger.warning("Corrupt ystore removed for %s", space_id)
                except Exception:
                    logger.exception("Failed to remove corrupt ystore for %s", space_id)
            continue

        content_path = space_path(space_id)
        try:
            content_path.parent.mkdir(parents=True, exist_ok=True)
            content_path.write_text(ydoc_to_text(ydoc), encoding="utf-8")
            logger.info("Boot sync: wrote snapshot for %s from %s", space_id, store_path.name)
        except Exception:
            logger.exception("Failed boot snapshot sync for %s", space_id)

        temp_store_path = store_path.with_name(f"{store_path.name}.compact.tmp")
        try:
            if temp_store_path.exists():
                temp_store_path.unlink()
            compacted_store = FileYStore(str(temp_store_path))
            await compacted_store.encode_state_as_update(ydoc)
            before_size = store_path.stat().st_size if store_path.exists() else 0
            after_size = temp_store_path.stat().st_size
            temp_store_path.replace(store_path)
            logger.info(
                "Boot compaction: compacted ystore for %s (%d -> %d bytes)",
                space_id,
                before_size,
                after_size,
            )
        except Exception:
            logger.exception("Failed boot ystore compaction for %s", space_id)
            try:
                if temp_store_path.exists():
                    temp_store_path.unlink()
            except Exception:
                logger.exception("Failed to clean temp compacted ystore for %s", space_id)


app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "PUT", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


# Handles the login function logic.
# Input: response: ApiResponse, payload: Dict[str, Any] = Body(default={}),.
# Output: Dict[str, Any].
@app.post("/api/login")
def login(
    response: ApiResponse,
    payload: Dict[str, Any] = Body(default={}),
) -> Dict[str, Any]:
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Invalid login payload.")
    username = payload.get("username")
    password = payload.get("password")
    if not isinstance(username, str) or not isinstance(password, str):
        raise HTTPException(status_code=400, detail="Username and password are required.")
    auth = authenticate(username.strip(), password)
    if not auth:
        raise HTTPException(status_code=401, detail="Unauthorized")
    session_token, _expires_at = create_session(auth.username)
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=session_token,
        max_age=SESSION_TTL_SECONDS,
        httponly=True,
        samesite="lax",
        secure=False,
        path="/",
    )
    return {
        "ok": True,
        "user": serialize_auth(auth),
        "permissions": serialize_permissions(auth),
        "must_change_password": bool(auth.must_change_password),
    }


# Handles the logout function logic.
# Input: request: Request, response: ApiResponse.
# Output: Dict[str, Any].
@app.post("/api/logout")
def logout(request: Request, response: ApiResponse) -> Dict[str, Any]:
    remove_session(request.cookies.get(SESSION_COOKIE_NAME))
    response.delete_cookie(key=SESSION_COOKIE_NAME, path="/")
    return {"ok": True}


# Handles the read_me function logic.
# Input: request: Request, user: AuthUser = Depends(require_auth).
# Output: Dict[str, Any].
@app.get("/api/me")
def read_me(request: Request, user: AuthUser = Depends(require_auth)) -> Dict[str, Any]:
    last_space = get_session_last_space(
        request.cookies.get(SESSION_COOKIE_NAME),
        user,
    )
    return {
        "user": serialize_auth(user),
        "permissions": serialize_permissions(user),
        "spaces": list_visible_spaces(user),
        "last_space": last_space,
        "must_change_password": bool(user.must_change_password),
    }


# Handles the update_me function logic.
# Input: request: Request = None, payload: Dict[str, Any] = Body(default={}), user: AuthUser = Depends(require_auth),.
# Output: Dict[str, Any].
@app.put("/api/me")
def update_me(
    request: Request = None,
    payload: Dict[str, Any] = Body(default={}),
    user: AuthUser = Depends(require_auth),
) -> Dict[str, Any]:
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Invalid user payload.")
    users = load_users_store()
    record = users.get(user.username)
    if not record:
        raise HTTPException(status_code=404, detail="User not found.")

    if "display_name" in payload:
        record["display_name"] = normalize_display_name(
            user.username, payload.get("display_name")
        )

    if "password" in payload:
        password = payload.get("password")
        if not isinstance(password, str) or not password:
            raise HTTPException(status_code=400, detail="Password is required.")
        current_password = payload.get("current_password")
        if not isinstance(current_password, str) or not current_password:
            raise HTTPException(status_code=400, detail="Current password is required.")
        if not verify_password(record, current_password):
            raise HTTPException(status_code=403, detail="Current password is incorrect.")
        record.update(build_password_record(password))
        record["must_change_password"] = False

    users[user.username] = normalize_user_record(user.username, record)
    save_users_store(users)
    if "password" in payload and request is not None:
        remove_sessions_for_user(
            user.username,
            keep_token=request.cookies.get(SESSION_COOKIE_NAME),
        )
    refreshed = user_record_to_auth(user.username, users[user.username])
    return {
        "ok": True,
        "user": serialize_auth(refreshed),
        "permissions": serialize_permissions(refreshed),
    }


# Handles the list_users function logic.
# Input: user: AuthUser = Depends(require_auth).
# Output: Dict[str, Any].
@app.get("/api/users")
def list_users(user: AuthUser = Depends(require_auth)) -> Dict[str, Any]:
    if not can_manage_users(user):
        raise HTTPException(status_code=403, detail="Not allowed.")
    users = load_users_store()
    rows = [
        user_view(username, users[username], user)
        for username in sorted(users.keys())
        if not is_hidden_system_user(username)
    ]
    return {
        "users": rows,
        "roles": ["admin", "manager", "user"],
    }


# Handles the create_user function logic.
# Input: payload: Dict[str, Any] = Body(default={}), user: AuthUser = Depends(require_auth),.
# Output: Dict[str, Any].
@app.post("/api/users")
def create_user(
    payload: Dict[str, Any] = Body(default={}),
    user: AuthUser = Depends(require_auth),
) -> Dict[str, Any]:
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Invalid user payload.")
    username = normalize_username(str(payload.get("username") or ""))
    if is_hidden_system_user(username):
        raise HTTPException(status_code=400, detail="Reserved username.")
    password = payload.get("password")
    if not isinstance(password, str) or not password:
        raise HTTPException(status_code=400, detail="Password is required.")

    desired_role = normalize_role(payload.get("role"))
    validate_user_target_permissions(user, username, None, desired_role)

    users = load_users_store()
    if username in users:
        raise HTTPException(status_code=409, detail="User already exists.")

    spaces = validate_assigned_spaces(
        normalize_space_list(payload.get("spaces")),
        username,
        users,
    )
    if user.role == "manager":
        desired_role = "user"

    users[username] = normalize_user_record(
        username,
        {
            "display_name": payload.get("display_name"),
            "role": desired_role,
            "spaces": spaces,
            **build_password_record(password),
        },
    )
    save_users_store(users)
    return {"ok": True, "user": user_view(username, users[username], user)}


# Handles the update_user function logic.
# Input: username: str, request: Request = None, payload: Dict[str, Any] = Body(default={}), user: AuthUser = Depends(require_auth),.
# Output: Dict[str, Any].
@app.put("/api/users/{username}")
def update_user(
    username: str,
    request: Request = None,
    payload: Dict[str, Any] = Body(default={}),
    user: AuthUser = Depends(require_auth),
) -> Dict[str, Any]:
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Invalid user payload.")
    target_username = normalize_username(username)
    if is_hidden_system_user(target_username):
        raise HTTPException(status_code=404, detail="User not found.")
    users = load_users_store()
    target = users.get(target_username)
    if not target:
        raise HTTPException(status_code=404, detail="User not found.")

    is_self = target_username == user.username

    if is_self:
        if "display_name" in payload:
            target["display_name"] = normalize_display_name(
                target_username, payload.get("display_name")
            )
        if "password" in payload:
            password = payload.get("password")
            if not isinstance(password, str) or not password:
                raise HTTPException(status_code=400, detail="Password is required.")
            current_password = payload.get("current_password")
            if not isinstance(current_password, str) or not current_password:
                raise HTTPException(
                    status_code=400, detail="Current password is required."
                )
            if not verify_password(target, current_password):
                raise HTTPException(
                    status_code=403, detail="Current password is incorrect."
                )
            target.update(build_password_record(password))
            target["must_change_password"] = False
        users[target_username] = normalize_user_record(target_username, target)
        save_users_store(users)
        if "password" in payload and request is not None:
            remove_sessions_for_user(
                target_username,
                keep_token=request.cookies.get(SESSION_COOKIE_NAME),
            )
        return {"ok": True, "user": user_view(target_username, users[target_username], user)}

    desired_role = None
    if "role" in payload:
        desired_role = normalize_role(payload.get("role"))
    validate_user_target_permissions(user, target_username, target, desired_role)

    if "display_name" in payload:
        target["display_name"] = normalize_display_name(
            target_username, payload.get("display_name")
        )
    if "password" in payload:
        password = payload.get("password")
        if not isinstance(password, str) or not password:
            raise HTTPException(status_code=400, detail="Password is required.")
        target.update(build_password_record(password))
        target["must_change_password"] = False
    if "spaces" in payload:
        if not can_assign_space_access(user):
            raise HTTPException(status_code=403, detail="Not allowed.")
        target["spaces"] = validate_assigned_spaces(
            normalize_space_list(payload.get("spaces")),
            target_username,
            users,
        )
    if "role" in payload:
        target["role"] = desired_role or target.get("role", "user")

    users[target_username] = normalize_user_record(target_username, target)
    save_users_store(users)
    if "password" in payload:
        remove_sessions_for_user(target_username)
    return {"ok": True, "user": user_view(target_username, users[target_username], user)}


# Handles the delete_user function logic.
# Input: username: str, user: AuthUser = Depends(require_auth).
# Output: Dict[str, Any].
@app.delete("/api/users/{username}")
def delete_user(username: str, user: AuthUser = Depends(require_auth)) -> Dict[str, Any]:
    target_username = normalize_username(username)
    if is_hidden_system_user(target_username):
        raise HTTPException(status_code=404, detail="User not found.")
    users = load_users_store()
    target = users.get(target_username)
    if not target:
        raise HTTPException(status_code=404, detail="User not found.")

    validate_user_target_permissions(user, target_username, target)

    if target_username == user.username:
        raise HTTPException(status_code=400, detail="You cannot delete your own account.")

    if target.get("role") == "admin":
        admins = [name for name, record in users.items() if record.get("role") == "admin"]
        if len(admins) <= 1:
            raise HTTPException(status_code=400, detail="Cannot remove the last admin.")

    users.pop(target_username, None)
    save_users_store(users)
    remove_presence_from_all_spaces(target_username)
    remove_sessions_for_user(target_username)
    return {"ok": True}


# Handles the list_spaces function logic.
# Input: user: AuthUser = Depends(require_auth).
# Output: Dict[str, Any].
@app.get("/api/spaces")
def list_spaces(user: AuthUser = Depends(require_auth)) -> Dict[str, Any]:
    visible_entries = filter_history_key_alias_space_entries(list_visible_space_entries(user))
    users = load_users_store()
    data = [
        {
            "id": entry["id"],
            "users": users_for_space(entry["id"], space_path_hint=entry.get("path")),
            "folder": entry.get("folder", ""),
            "path": entry.get("path", entry["id"]),
            "personal": bool(entry.get("personal")),
        }
        for entry in visible_entries
    ]
    if can_manage_spaces(user):
        folders = list_space_folder_names()
    else:
        folders = sorted_folder_names({entry["folder"] for entry in data if entry.get("folder")})
    return {
        "spaces": data,
        "folders": folders,
        "user": serialize_auth(user),
        "permissions": serialize_permissions(user),
    }


# Handles the create_space_folder function logic.
# Input: payload: Dict[str, Any] = Body(default={}), user: AuthUser = Depends(require_auth),.
# Output: Dict[str, Any].
@app.post("/api/space-folders")
def create_space_folder(
    payload: Dict[str, Any] = Body(default={}),
    user: AuthUser = Depends(require_auth),
) -> Dict[str, Any]:
    if not can_manage_spaces(user):
        raise HTTPException(status_code=403, detail="Not allowed.")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Invalid folder payload.")
    folder_name = sanitize_folder_name(str(payload.get("name") or ""))
    if is_personal_folder_name(folder_name):
        raise HTTPException(
            status_code=400,
            detail="The personal folder is reserved.",
        )
    folder = folder_path(folder_name)
    if folder.exists() and not folder.is_dir():
        raise HTTPException(status_code=409, detail="Folder name is already used by a file.")
    folder.mkdir(parents=True, exist_ok=True)
    return {"ok": True, "name": folder_name}


# Handles the delete_space_folder function logic.
# Input: folder_id: str, user: AuthUser = Depends(require_auth),.
# Output: Dict[str, Any].
@app.delete("/api/space-folders/{folder_id:path}")
def delete_space_folder(
    folder_id: str,
    user: AuthUser = Depends(require_auth),
) -> Dict[str, Any]:
    if not can_manage_spaces(user):
        raise HTTPException(status_code=403, detail="Not allowed.")
    folder_name = sanitize_folder_name(folder_id)
    if is_personal_folder_name(folder_name):
        raise HTTPException(
            status_code=400,
            detail="The personal folder is reserved.",
        )
    folder = folder_path(folder_name)
    if not folder.exists() or not folder.is_dir():
        raise HTTPException(status_code=404, detail="Folder not found.")
    if any(folder.iterdir()):
        raise HTTPException(status_code=409, detail="Folder is not empty.")
    folder.rmdir()
    return {"ok": True}


# Handles the set_space_folder function logic.
# Input: space_id: str, payload: Dict[str, Any] = Body(default={}), user: AuthUser = Depends(require_auth),.
# Output: Dict[str, Any].
@app.put("/api/spaces/{space_id}/folder")
def set_space_folder(
    space_id: str,
    payload: Dict[str, Any] = Body(default={}),
    user: AuthUser = Depends(require_auth),
) -> Dict[str, Any]:
    if not can_manage_spaces(user):
        raise HTTPException(status_code=403, detail="Not allowed.")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Invalid folder payload.")
    safe_id = sanitize_space(space_id)
    space_path_hint = normalize_space_path_hint_for_id(safe_id, payload.get("path") if isinstance(payload, dict) else None)
    if not space_path(safe_id, space_path_hint=space_path_hint).exists():
        raise HTTPException(status_code=404, detail="Space not found.")
    if is_personal_space(safe_id):
        raise HTTPException(
            status_code=400,
            detail="Personal spaces stay in the personal folder.",
        )
    folder_raw = payload.get("folder")
    if folder_raw is None:
        folder_raw = payload.get("name")
    if folder_raw is None:
        folder_name = ""
    elif isinstance(folder_raw, str):
        folder_name = folder_raw.strip()
    else:
        raise HTTPException(status_code=400, detail="Invalid folder payload.")

    source = resolve_space_file(safe_id, users=load_users_store(), space_path_hint=space_path_hint)
    if not source:
        raise HTTPException(status_code=404, detail="Space not found.")
    users = load_users_store()
    old_space_path = space_access_path(safe_id, users)
    if space_path_hint:
        old_space_path = space_path_hint

    if not folder_name:
        target = SPACES_DIR / f"{safe_id}.txt"
        if source != target:
            if target.exists():
                raise HTTPException(status_code=409, detail="Space already exists.")
            source.rename(target)
            update_access_paths_for_space_change(old_space_path, safe_id)
            move_history_for_space_path_change(old_space_path, safe_id)
            source_store = ystore_path(safe_id, users=users, space_path_hint=old_space_path)
            target_store = ystore_path(safe_id, users=users, space_path_hint=safe_id)
            if source_store.exists():
                source_store.rename(target_store)
            room = websocket_server.rooms.get(room_name(safe_id, space_path_hint=old_space_path))
            if room:
                websocket_server.rename_room(to_name=room_name(safe_id, space_path_hint=safe_id), from_room=room)
                schedule_space_snapshot(safe_id, room, space_path_hint=safe_id)
            if old_space_path in presence:
                presence[safe_id] = presence.pop(old_space_path)
        return {"ok": True, "folder": ""}

    folder_name = sanitize_folder_name(folder_name)
    if is_personal_folder_name(folder_name):
        raise HTTPException(
            status_code=400,
            detail="Only personal spaces can use the personal folder.",
        )
    folder = folder_path(folder_name)
    if not folder.exists() or not folder.is_dir():
        raise HTTPException(status_code=404, detail="Folder not found.")
    target = folder / f"{safe_id}.txt"
    if source != target:
        if target.exists():
            raise HTTPException(status_code=409, detail="Space already exists.")
        source.rename(target)
        new_space_path = f"{folder_name}/{safe_id}"
        update_access_paths_for_space_change(
            old_space_path,
            new_space_path,
        )
        move_history_for_space_path_change(old_space_path, new_space_path)
        source_store = ystore_path(safe_id, users=users, space_path_hint=old_space_path)
        target_store = ystore_path(safe_id, users=users, space_path_hint=new_space_path)
        if source_store.exists():
            source_store.rename(target_store)
        room = websocket_server.rooms.get(room_name(safe_id, space_path_hint=old_space_path))
        if room:
            websocket_server.rename_room(to_name=room_name(safe_id, space_path_hint=new_space_path), from_room=room)
            schedule_space_snapshot(safe_id, room, space_path_hint=new_space_path)
        if old_space_path in presence:
            presence[new_space_path] = presence.pop(old_space_path)
    return {"ok": True, "folder": folder_name}


# Handles the read_space_history function logic.
# Input: space_id: str, path: Optional[str] = Query(default=None), user: AuthUser = Depends(require_auth),.
# Output: Dict[str, Any].
@app.get("/api/spaces/{space_id}/history")
def read_space_history(
    space_id: str,
    path: Optional[str] = Query(default=None),
    user: AuthUser = Depends(require_auth),
) -> Dict[str, Any]:
    safe_id = sanitize_space(space_id)
    space_path_hint = normalize_space_path_hint_for_id(safe_id, path)
    ensure_space_access(user, safe_id, space_path_hint=space_path_hint)
    if not space_path(safe_id, space_path_hint=space_path_hint).exists():
        raise HTTPException(status_code=404, detail="Space not found.")
    return {"checkpoints": load_history_index(history_key_for_space(safe_id, space_path_hint=space_path_hint))}


# Handles the read_space_history_checkpoint function logic.
# Input: space_id: str, checkpoint_id: str, path: Optional[str] = Query(default=None), user: AuthUser = Depends(require_auth),.
# Output: Response.
@app.get("/api/spaces/{space_id}/history/{checkpoint_id}")
def read_space_history_checkpoint(
    space_id: str,
    checkpoint_id: str,
    path: Optional[str] = Query(default=None),
    user: AuthUser = Depends(require_auth),
) -> Response:
    safe_id = sanitize_space(space_id)
    space_path_hint = normalize_space_path_hint_for_id(safe_id, path)
    ensure_space_access(user, safe_id, space_path_hint=space_path_hint)
    if not space_path(safe_id, space_path_hint=space_path_hint).exists():
        raise HTTPException(status_code=404, detail="Space not found.")
    history_key = history_key_for_space(safe_id, space_path_hint=space_path_hint)
    return Response(
        read_history_checkpoint(history_key, checkpoint_id),
        media_type="text/plain",
    )


# Handles the revert_space_history_checkpoint function logic.
# Input: space_id: str, payload: Dict[str, Any] = Body(default={}), user: AuthUser = Depends(require_auth),.
# Output: Dict[str, Any].
@app.post("/api/spaces/{space_id}/history/revert")
async def revert_space_history_checkpoint(
    space_id: str,
    payload: Dict[str, Any] = Body(default={}),
    user: AuthUser = Depends(require_auth),
) -> Dict[str, Any]:
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Invalid history revert payload.")
    safe_id = sanitize_space(space_id)
    space_path_hint = normalize_space_path_hint_for_id(safe_id, payload.get("path") if isinstance(payload, dict) else None)
    ensure_space_access(user, safe_id, space_path_hint=space_path_hint)
    target_path = space_path(safe_id, space_path_hint=space_path_hint)
    if not target_path.exists():
        raise HTTPException(status_code=404, detail="Space not found.")
    checkpoint_id = payload.get("checkpoint_id")
    if not isinstance(checkpoint_id, str) or not checkpoint_id.strip():
        raise HTTPException(status_code=400, detail="Checkpoint id is required.")
    pre_revert_content = payload.get("pre_revert_content")
    if not isinstance(pre_revert_content, str):
        raise HTTPException(status_code=400, detail="Pre-revert content is required.")
    pre_revert_label = payload.get("pre_revert_label")
    if not isinstance(pre_revert_label, str) or not pre_revert_label.strip():
        pre_revert_label = "revoked"

    history_key = history_key_for_space(safe_id, space_path_hint=space_path_hint)
    restored_content = read_history_checkpoint(history_key, checkpoint_id.strip())
    revert_base = create_history_checkpoint(
        history_key,
        pre_revert_content,
        kind="revert-base",
        label=pre_revert_label,
    )

    _atomic_write_text(target_path, restored_content)
    room = websocket_server.rooms.get(room_name(safe_id, space_path_hint=space_path_hint))
    if room:
        replace_ydoc_text(room.ydoc, restored_content)
        schedule_space_snapshot(safe_id, room, space_path_hint=space_path_hint)
    else:
        store_path = ystore_path(safe_id, space_path_hint=space_path_hint)
        if store_path.exists():
            try:
                store_path.unlink()
            except Exception:
                logger.exception("Failed to remove ystore after history revert for %s", safe_id)

    return {
        "ok": True,
        "content": restored_content,
        "revert_base": revert_base,
    }


# Handles the tag_space_history_checkpoint function logic.
# Input: space_id: str, payload: Dict[str, Any] = Body(default={}), user: AuthUser = Depends(require_auth),.
# Output: Dict[str, Any].
@app.post("/api/spaces/{space_id}/history/tag")
def tag_space_history_checkpoint(
    space_id: str,
    payload: Dict[str, Any] = Body(default={}),
    user: AuthUser = Depends(require_auth),
) -> Dict[str, Any]:
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Invalid history tag payload.")
    safe_id = sanitize_space(space_id)
    space_path_hint = normalize_space_path_hint_for_id(safe_id, payload.get("path") if isinstance(payload, dict) else None)
    ensure_space_access(user, safe_id, space_path_hint=space_path_hint)
    if not space_path(safe_id, space_path_hint=space_path_hint).exists():
        raise HTTPException(status_code=404, detail="Space not found.")
    label = payload.get("label")
    if not isinstance(label, str) or not label.strip():
        raise HTTPException(status_code=400, detail="Label is required.")
    history_key = history_key_for_space(safe_id, space_path_hint=space_path_hint)
    raw_content = payload.get("content")
    if isinstance(raw_content, str):
        content = raw_content
    else:
        checkpoint_id = payload.get("checkpoint_id")
        if not isinstance(checkpoint_id, str) or not checkpoint_id.strip():
            raise HTTPException(status_code=400, detail="Checkpoint id or content is required.")
        content = read_history_checkpoint(history_key, checkpoint_id.strip())
    checkpoint = create_history_checkpoint(
        history_key,
        content,
        kind="manual",
        label=label.strip(),
    )
    return {"ok": True, "checkpoint": checkpoint}


# Handles the read_jira_config function logic.
# Input: user: AuthUser = Depends(require_auth).
# Output: Dict[str, Any].
@app.get("/api/jira-config")
def read_jira_config(user: AuthUser = Depends(require_auth)) -> Dict[str, Any]:
    if not can_manage_jira(user):
        raise HTTPException(status_code=403, detail="Not allowed.")
    config = load_jira_config()
    return {
        "base_url": config.base_url,
        "email": config.email,
        "token": config.token,
    }


# Handles the write_jira_config function logic.
# Input: payload: Dict[str, Any] = Body(default={}), user: AuthUser = Depends(require_auth),.
# Output: Dict[str, Any].
@app.put("/api/jira-config")
def write_jira_config(
    payload: Dict[str, Any] = Body(default={}),
    user: AuthUser = Depends(require_auth),
) -> Dict[str, Any]:
    if not can_manage_jira(user):
        raise HTTPException(status_code=403, detail="Not allowed.")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Invalid Jira config payload.")
    config = save_jira_config(payload)
    ensure_jira_daemon_credentials()
    return {
        "ok": True,
        "base_url": config.base_url,
        "email": config.email,
        "token": config.token,
    }


# Handles the read_space function logic.
# Input: space_id: str, path: Optional[str] = Query(default=None), user: AuthUser = Depends(require_auth),.
# Output: Response.
@app.get("/api/spaces/{space_id}")
def read_space(
    space_id: str,
    path: Optional[str] = Query(default=None),
    user: AuthUser = Depends(require_auth),
) -> Response:
    safe_id = sanitize_space(space_id)
    space_path_hint = normalize_space_path_hint_for_id(safe_id, path)
    ensure_space_access(user, safe_id, space_path_hint=space_path_hint)
    target_path = space_path(safe_id, space_path_hint=space_path_hint)
    if not target_path.exists():
        raise HTTPException(status_code=404, detail="Space not found.")
    return Response(target_path.read_text(encoding="utf-8"), media_type="text/plain")


# Handles the write_space function logic.
# Input: space_id: str, content: str = Body(default="", media_type="text/plain"), path: Optional[str] = Query(default=None), user: AuthUser = Depends(require_auth),.
# Output: Dict[str, Any].
@app.put("/api/spaces/{space_id}")
async def write_space(
    space_id: str,
    content: str = Body(default="", media_type="text/plain"),
    path: Optional[str] = Query(default=None),
    user: AuthUser = Depends(require_auth),
) -> Dict[str, Any]:
    safe_id = sanitize_space(space_id)
    space_path_hint = normalize_space_path_hint_for_id(safe_id, path)
    ensure_space_access(user, safe_id, space_path_hint=space_path_hint)
    target_path = space_path(safe_id, space_path_hint=space_path_hint)
    if not target_path.exists():
        raise HTTPException(status_code=404, detail="Space not found.")
    await run_blocking_io(
        write_space_text_and_maybe_checkpoint,
        safe_id,
        content,
        space_path_hint=space_path_hint,
    )
    room = websocket_server.rooms.get(room_name(safe_id, space_path_hint=space_path_hint))
    if room:
        replace_ydoc_text(room.ydoc, content)
        schedule_space_snapshot(safe_id, room, space_path_hint=space_path_hint)
    else:
        store_path = ystore_path(safe_id, space_path_hint=space_path_hint)
        if store_path.exists():
            store_path.unlink()
    return {"ok": True}


# Handles the create_space function logic.
# Input: space_id: str, user: AuthUser = Depends(require_auth).
# Output: Dict[str, Any].
@app.post("/api/spaces/{space_id}")
def create_space(space_id: str, user: AuthUser = Depends(require_auth)) -> Dict[str, Any]:
    if not can_manage_spaces(user):
        raise HTTPException(status_code=403, detail="Not allowed.")
    safe_id = sanitize_space(space_id)
    path = space_path(safe_id)
    if path.exists():
        raise HTTPException(status_code=409, detail="Space already exists.")
    path.write_text("", encoding="utf-8")
    return {"ok": True}


# Handles the delete_space function logic.
# Input: space_id: str, path: Optional[str] = Query(default=None), user: AuthUser = Depends(require_auth),.
# Output: Dict[str, Any].
@app.delete("/api/spaces/{space_id}")
async def delete_space(
    space_id: str,
    path: Optional[str] = Query(default=None),
    user: AuthUser = Depends(require_auth),
) -> Dict[str, Any]:
    if not can_manage_spaces(user):
        raise HTTPException(status_code=403, detail="Not allowed.")
    safe_id = sanitize_space(space_id)
    request_path_hint = normalize_space_path_hint_for_id(safe_id, path)
    if is_personal_space(safe_id):
        raise HTTPException(status_code=400, detail="Personal spaces cannot be deleted.")
    users = load_users_store()
    target_path = resolve_space_file(safe_id, users=users, space_path_hint=request_path_hint)
    if not target_path:
        raise HTTPException(status_code=404, detail="Space not found.")
    canonical_path = canonical_space_path_for_file(target_path, users)

    room_key = room_name(safe_id, space_path_hint=canonical_path)
    room = websocket_server.rooms.get(room_key)
    if room:
        try:
            websocket_server.delete_room(name=room_key)
        except Exception:
            logger.exception("Failed to stop websocket room for %s", safe_id)
            websocket_server.rooms.pop(room_key, None)

    task = space_save_tasks.pop(room_key, None)
    if task:
        task.cancel()
    try:
        target_path.unlink()
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Space not found.")
    clear_last_space_for_deleted_space(safe_id)
    store_path = ystore_path(safe_id, users=users, space_path_hint=canonical_path)
    if store_path.exists():
        store_path.unlink()
    presence.pop(canonical_path, None)
    return {"ok": True}


# Handles the rename_space function logic.
# Input: space_id: str, payload: Dict[str, Any] = Body(default={}), user: AuthUser = Depends(require_auth),.
# Output: Dict[str, Any].
@app.post("/api/spaces/{space_id}/rename")
def rename_space(
    space_id: str,
    payload: Dict[str, Any] = Body(default={}),
    user: AuthUser = Depends(require_auth),
) -> Dict[str, Any]:
    if not can_manage_spaces(user):
        raise HTTPException(status_code=403, detail="Not allowed.")
    source_id = sanitize_space(space_id)
    if is_personal_space(source_id):
        raise HTTPException(status_code=400, detail="Personal spaces cannot be renamed.")
    users = load_users_store()
    source_path_hint = normalize_space_path_hint_for_id(source_id, payload.get("path") if isinstance(payload, dict) else None)
    old_space_path = source_path_hint or space_access_path(source_id, users)

    old_folder = folder_for_space(source_id, users, space_path_hint=source_path_hint)
    source = space_path(source_id, users=users, space_path_hint=source_path_hint)
    if not source.exists():
        raise HTTPException(status_code=404, detail="Space not found.")
    new_name = ""
    if isinstance(payload, dict):
        candidate = payload.get("name") or payload.get("id") or payload.get("space")
        if isinstance(candidate, str):
            new_name = candidate.strip()
    if not new_name:
        raise HTTPException(status_code=400, detail="Invalid space id.")
    target_id = sanitize_space(new_name)
    if is_personal_space(target_id):
        raise HTTPException(
            status_code=400,
            detail="Space id is reserved for a personal space.",
        )
    target = source.with_name(f"{target_id}.txt")
    if target.exists():
        raise HTTPException(status_code=409, detail="Space already exists.")
    source.rename(target)
    new_space_path = f"{old_folder}/{target_id}" if old_folder else target_id
    update_access_paths_for_space_change(old_space_path, new_space_path)
    move_history_for_space_path_change(old_space_path, new_space_path)
    update_last_space_for_renamed_space(source_id, target_id)
    source_store = ystore_path(source_id, users=users, space_path_hint=old_space_path)
    target_store = ystore_path(target_id, users=users, space_path_hint=new_space_path)
    if source_store.exists():
        source_store.rename(target_store)
    room = websocket_server.rooms.get(room_name(source_id, space_path_hint=old_space_path))
    if room:
        websocket_server.rename_room(to_name=room_name(target_id, space_path_hint=new_space_path), from_room=room)
        schedule_space_snapshot(target_id, room, space_path_hint=new_space_path)
    if old_space_path in presence:
        presence[new_space_path] = presence.pop(old_space_path)
    return {"ok": True, "id": target_id}


# Handles the update_presence function logic.
# Input: space_id: str, request: Request, path: Optional[str] = Query(default=None), user: AuthUser = Depends(require_auth),.
# Output: Dict[str, Any].
@app.post("/api/spaces/{space_id}/presence")
def update_presence(
    space_id: str,
    request: Request,
    path: Optional[str] = Query(default=None),
    user: AuthUser = Depends(require_auth),
) -> Dict[str, Any]:
    safe_id = sanitize_space(space_id)
    space_path_hint = normalize_space_path_hint_for_id(safe_id, path)
    ensure_space_access(user, safe_id, space_path_hint=space_path_hint)
    if not space_path(safe_id, space_path_hint=space_path_hint).exists():
        raise HTTPException(status_code=404, detail="Space not found.")
    set_session_last_space(request.cookies.get(SESSION_COOKIE_NAME), safe_id)
    mark_presence(safe_id, user.username, space_path_hint=space_path_hint)
    return {"ok": True}


# Handles the clear_presence function logic.
# Input: space_id: str, path: Optional[str] = Query(default=None), user: AuthUser = Depends(require_auth),.
# Output: Dict[str, Any].
@app.delete("/api/spaces/{space_id}/presence")
def clear_presence(
    space_id: str,
    path: Optional[str] = Query(default=None),
    user: AuthUser = Depends(require_auth),
) -> Dict[str, Any]:
    safe_id = sanitize_space(space_id)
    space_path_hint = normalize_space_path_hint_for_id(safe_id, path)
    ensure_space_access(user, safe_id, space_path_hint=space_path_hint)
    if not space_path(safe_id, space_path_hint=space_path_hint).exists():
        raise HTTPException(status_code=404, detail="Space not found.")
    remove_presence(safe_id, user.username, space_path_hint=space_path_hint)
    return {"ok": True}


# Handles the cleanup_presence function logic.
# Input: none.
# Output: None.
def cleanup_presence() -> None:
    now = time.time()
    for space_id in list(presence.keys()):
        users = presence[space_id]
        stale = [name for name, ts in users.items() if now - ts > PRESENCE_TTL]
        for name in stale:
            users.pop(name, None)
        if not users:
            presence.pop(space_id, None)


# Handles the _presence_key function logic.
# Input: space_id: str, *, space_path_hint: Optional[str] = None.
# Output: str.
def _presence_key(space_id: str, *, space_path_hint: Optional[str] = None) -> str:
    normalized_hint = normalize_folder_name(space_path_hint)
    if normalized_hint:
        return normalized_hint
    return sanitize_space(space_id)


# Handles the mark_presence function logic.
# Input: space_id: str, username: str, *, space_path_hint: Optional[str] = None.
# Output: None.
def mark_presence(space_id: str, username: str, *, space_path_hint: Optional[str] = None) -> None:
    cleanup_presence()
    presence.setdefault(_presence_key(space_id, space_path_hint=space_path_hint), {})[username] = time.time()


# Handles the remove_presence function logic.
# Input: space_id: str, username: str, *, space_path_hint: Optional[str] = None.
# Output: None.
def remove_presence(space_id: str, username: str, *, space_path_hint: Optional[str] = None) -> None:
    users = presence.get(_presence_key(space_id, space_path_hint=space_path_hint))
    if not users:
        return
    users.pop(username, None)
    if not users:
        presence.pop(_presence_key(space_id, space_path_hint=space_path_hint), None)


# Handles the users_for_space function logic.
# Input: space_id: str, *, space_path_hint: Optional[str] = None.
# Output: List[str].
def users_for_space(space_id: str, *, space_path_hint: Optional[str] = None) -> List[str]:
    room = websocket_server.rooms.get(room_name(space_id, space_path_hint=space_path_hint))
    if room is not None and getattr(room, "awareness", None) is not None:
        _cleanup_room_awareness(room)
        names: Set[str] = set()
        for state in getattr(room.awareness, "states", {}).values():
            if not isinstance(state, dict):
                continue
            user = state.get("user")
            if isinstance(user, dict):
                display_name = user.get("name")
                if isinstance(display_name, str) and display_name.strip():
                    names.add(display_name.strip())
                    continue
                username = user.get("username")
                if isinstance(username, str) and username.strip():
                    names.add(username.strip())
                    continue
            # Fallback for non-standard awareness payloads.
            if isinstance(state.get("name"), str) and state["name"].strip():
                names.add(state["name"].strip())
        if names:
            return sorted(names)
    cleanup_presence()
    users = presence.get(_presence_key(space_id, space_path_hint=space_path_hint), {})
    return sorted(users.keys())


# Handles the ensure_jira_daemon_credentials function logic.
# Input: none.
# Output: None.
def ensure_jira_daemon_credentials() -> None:
    jira_data = load_jira_config_data()
    username = JIRA_DAEMON_USERNAME
    worker_username = (
        str(jira_data.get("worker_username") or "").strip() or username
    )
    if worker_username != username:
        worker_username = username

    worker_password = str(jira_data.get("worker_password") or "").strip()
    if not worker_password:
        worker_password = secrets.token_urlsafe(24)

    users = load_users_store()
    users[username] = normalize_user_record(
        username,
        {
            "display_name": JIRA_DAEMON_DISPLAY_NAME,
            "role": "manager",
            "spaces": [],
            "must_change_password": False,
            **build_password_record(worker_password),
        },
    )
    save_users_store(users)

    if (
        jira_data.get("worker_username") != worker_username
        or jira_data.get("worker_password") != worker_password
    ):
        jira_data["worker_username"] = worker_username
        jira_data["worker_password"] = worker_password
        save_jira_config_data(jira_data)


# Handles the space_ref_from_ws_path function logic.
# Input: path: str.
# Output: Optional[Tuple[str, str]].
def space_ref_from_ws_path(path: str) -> Optional[Tuple[str, str]]:
    if "/ws/" not in path:
        return None
    tail = path.split("/ws/", 1)[1]
    if not tail:
        return None
    canonical = normalize_folder_name(tail)
    if not canonical:
        return None
    name = canonical.split("/")[-1]
    try:
        return sanitize_space(name), canonical
    except HTTPException:
        return None


# Handles the space_from_path function logic.
# Input: path: str.
# Output: Optional[str].
def space_from_path(path: str) -> Optional[str]:
    ref = space_ref_from_ws_path(path)
    return ref[0] if ref else None


# Handles the ws_credentials function logic.
# Input: scope: Dict[str, Any].
# Output: Tuple[Optional[str], Optional[str]].
def ws_credentials(scope: Dict[str, Any]) -> Tuple[Optional[str], Optional[str]]:
    query = parse_qs(scope.get("query_string", b"").decode())
    user = query.get("user", [None])[0] or query.get("username", [None])[0]
    password = query.get("pass", [None])[0] or query.get("password", [None])[0]
    return user, password


# Handles the ws_session_token function logic.
# Input: scope: Dict[str, Any].
# Output: Optional[str].
def ws_session_token(scope: Dict[str, Any]) -> Optional[str]:
    headers = scope.get("headers") or []
    cookie_header = None
    for key, value in headers:
        if key == b"cookie":
            try:
                cookie_header = value.decode("utf-8")
            except Exception:
                cookie_header = None
            break
    if not cookie_header:
        return None
    cookie = SimpleCookie()
    try:
        cookie.load(cookie_header)
    except Exception:
        return None
    morsel = cookie.get(SESSION_COOKIE_NAME)
    if not morsel:
        return None
    token = morsel.value.strip()
    return token or None


# Handles the on_connect function logic.
# Input: _message: Dict[str, Any], scope: Dict[str, Any].
# Output: bool.
async def on_connect(_message: Dict[str, Any], scope: Dict[str, Any]) -> bool:
    ref = space_ref_from_ws_path(scope.get("path", ""))
    if not ref:
        return True
    space_id, space_path_hint = ref
    try:
        if not space_path(space_id, space_path_hint=space_path_hint).exists():
            raise HTTPException(status_code=404, detail="Space not found.")
    except HTTPException:
        return True

    auth = auth_from_session(ws_session_token(scope))
    if auth:
        if not can_access_space(auth, space_id, space_path_hint=space_path_hint):
            return True
        mark_presence(space_id, auth.username, space_path_hint=space_path_hint)
        return False

    username, password = ws_credentials(scope)
    if not username or not password:
        return True
    auth = authenticate(username.strip(), password)
    if not auth:
        return True
    if not can_access_space(auth, space_id, space_path_hint=space_path_hint):
        return True
    mark_presence(space_id, auth.username, space_path_hint=space_path_hint)
    return False


# Defines the PersistentWebsocketServer structure used by this module.
class PersistentWebsocketServer(WebsocketServer):
    # Handles the get_room function logic.
    # Input: self, name: str.
    # Output: value produced by this function.
    async def get_room(self, name: str):
        if name not in self.rooms.keys():
            ref = space_ref_from_ws_path(name)
            if ref:
                space_id, space_path_hint = ref
                store = FileYStore(str(ystore_path(space_id, space_path_hint=space_path_hint)))
                room = YRoom(ready=False, ystore=store, log=self.log)
                self.rooms[name] = room
                await hydrate_room_from_storage(space_id, room, space_path_hint=space_path_hint)
                attach_snapshot_hook(space_id, room, space_path_hint=space_path_hint)
                attach_awareness_hook(room)
            else:
                room = YRoom(ready=self.rooms_ready, log=self.log)
                self.rooms[name] = room
                attach_awareness_hook(room)
        room = self.rooms[name]
        await self.start_room(room)
        return room


websocket_server = PersistentWebsocketServer()
# Handles the _is_benign_shutdown_error function logic.
# Input: exc: BaseException.
# Output: bool.
def _is_benign_shutdown_error(exc: BaseException) -> bool:
    if isinstance(exc, RuntimeError):
        message = str(exc)
        if (
            "Unexpected ASGI message 'websocket.send'" in message
            and "after sending 'websocket.close'" in message
        ):
            return True
    return (
        isinstance(exc, (ClientDisconnected, ConnectionClosedOK, asyncio.CancelledError))
    )


# Defines the _SuppressBenignShutdownASGI structure used by this module.
class _SuppressBenignShutdownASGI:
    # Handles the __init__ function logic.
    # Input: self, app: Any.
    # Output: None.
    def __init__(self, app: Any) -> None:
        self._app = app

    # Handles the __call__ function logic.
    # Input: self, scope: Dict[str, Any], receive: Any, send: Any.
    # Output: Any.
    async def __call__(self, scope: Dict[str, Any], receive: Any, send: Any) -> Any:
        response_started = False
        response_completed = False

        # Handles the tracked_send function logic.
        # Input: message: Dict[str, Any].
        # Output: Any.
        async def tracked_send(message: Dict[str, Any]) -> Any:
            nonlocal response_started, response_completed
            message_type = message.get("type")
            if scope.get("type") == "http":
                if message_type == "http.response.start":
                    response_started = True
                elif message_type == "http.response.body" and not message.get("more_body", False):
                    response_completed = True
            elif scope.get("type") == "websocket":
                if message_type == "websocket.close":
                    response_completed = True
            return await send(message)

        try:
            return await self._app(scope, receive, tracked_send)
        except BaseException as exc:
            if BASE_EXCEPTION_GROUP_TYPE is not None and isinstance(exc, BASE_EXCEPTION_GROUP_TYPE):
                benign, remainder = exc.split(_is_benign_shutdown_error)
                if remainder is None:
                    if scope.get("type") == "http":
                        await self._finish_cancelled_http_response(
                            send,
                            response_started=response_started,
                            response_completed=response_completed,
                        )
                    logger.info(
                        "Suppressed benign %s shutdown errors during ASGI request.",
                        scope.get("type", "unknown"),
                    )
                    return None
                raise remainder
            if _is_benign_shutdown_error(exc):
                if scope.get("type") == "http":
                    await self._finish_cancelled_http_response(
                        send,
                        response_started=response_started,
                        response_completed=response_completed,
                    )
                logger.info(
                    "Suppressed benign %s disconnect/cancel during ASGI request shutdown.",
                    scope.get("type", "unknown"),
                )
                return None
            raise

    # Handles the _finish_cancelled_http_response function logic.
    # Input: self, send: Any, *, response_started: bool, response_completed: bool,.
    # Output: None.
    async def _finish_cancelled_http_response(
        self,
        send: Any,
        *,
        response_started: bool,
        response_completed: bool,
    ) -> None:
        if response_completed:
            return
        try:
            if not response_started:
                await send(
                    {
                        "type": "http.response.start",
                        "status": 204,
                        "headers": [],
                    }
                )
            await send(
                {
                    "type": "http.response.body",
                    "body": b"",
                    "more_body": False,
                }
            )
        except BaseException:
            # Client is usually already gone during shutdown; best effort only.
            pass


app.mount(
    "/ws",
    _SuppressBenignShutdownASGI(ASGIServer(websocket_server, on_connect=on_connect)),
)
if FRONTEND_NODE_MODULES_DIR.exists():
    app.mount("/node_modules", StaticFiles(directory=FRONTEND_NODE_MODULES_DIR), name="node_modules")
app.mount("/", StaticFiles(directory=FRONTEND_STATIC_DIR, html=True), name="static")


# Handles the main function logic.
# Input: none.
# Output: None.
async def main() -> None:
    load_users_store()
    await sync_snapshots_from_ystore_on_startup()
    port_value = os.getenv("PORT", "5000").strip()
    try:
        port = int(port_value)
    except ValueError:
        port = 5000
    # We don't use FastAPI lifespan hooks here, and disabling lifespan avoids
    # noisy CancelledError traces during server shutdown on Python 3.12.
    config = uvicorn.Config(
        _SuppressBenignShutdownASGI(app),
        host="0.0.0.0",
        port=port,
        log_level="info",
        lifespan="off",
    )
    server = uvicorn.Server(config)
    try:
        async with websocket_server:
            await server.serve()
    except BaseException as exc:
        if BASE_EXCEPTION_GROUP_TYPE is not None and isinstance(exc, BASE_EXCEPTION_GROUP_TYPE):
            _benign, remainder = exc.split(_is_benign_shutdown_error)
            if remainder is not None:
                raise remainder
            logger.info("Suppressed benign websocket disconnect errors during shutdown.")
        elif _is_benign_shutdown_error(exc):
            logger.info("Suppressed benign websocket disconnect error during shutdown.")
        else:
            raise
    finally:
        pending_save_tasks = list(space_save_tasks.values())
        for task in pending_save_tasks:
            task.cancel()
        if pending_save_tasks:
            results = await asyncio.gather(*pending_save_tasks, return_exceptions=True)
            for result in results:
                if isinstance(result, BaseException) and not _is_benign_shutdown_error(result):
                    logger.warning("Unexpected error while shutting down snapshot task: %r", result)
        space_save_tasks.clear()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Shutdown requested (Ctrl+C).")
