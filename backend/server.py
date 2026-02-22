import asyncio
import base64
import json
import hashlib
import logging
import os
import re
import secrets
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
import uvicorn
from jira.config import (
    load_jira_config_data,
    load_jira_config,
    load_users_config_data,
    save_jira_config_data,
    save_users_config_data,
    save_jira_config,
)

ROOT_DIR = Path(__file__).resolve().parents[1]
FRONTEND_DIR = ROOT_DIR / "frontend"
SPACES_DIR = Path(__file__).resolve().parent / "spaces"
SPACES_DIR.mkdir(parents=True, exist_ok=True)
YSTORE_DIR = Path(__file__).resolve().parent / "ystore"
YSTORE_DIR.mkdir(parents=True, exist_ok=True)
LEGACY_USERS_FILE = Path(__file__).resolve().parent / "users.txt"
SESSIONS_FILE = Path(__file__).resolve().parent / "sessions.json"
LEGACY_SPACES_META_FILE = Path(__file__).resolve().parent / "spaces_config.json"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("server")

SPACE_ID_RE = re.compile(r"[a-zA-Z0-9_-]+")
VALID_ROLES = {"admin", "manager", "user"}
PASSWORD_SALT_BYTES = 8
DEFAULT_BOOTSTRAP_USERNAME = "admin"
DEFAULT_BOOTSTRAP_PASSWORD = "admin"
SESSION_COOKIE_NAME = "task_session"
SESSION_TTL_SECONDS = 60 * 60 * 24 * 30
PERSONAL_FOLDER_NAME = "personal"

PRESENCE_TTL = 40
presence: Dict[str, Dict[str, float]] = {}
space_save_tasks: Dict[str, asyncio.Task] = {}
SPACE_SAVE_DELAY = 0.5


@dataclass(frozen=True)
class AuthUser:
    username: str
    display_name: str
    role: str
    spaces: Tuple[str, ...]
    must_change_password: bool = False


def sanitize_space(space_id: str) -> str:
    if not re.fullmatch(SPACE_ID_RE, space_id or ""):
        raise HTTPException(status_code=400, detail="Invalid space id.")
    return space_id


def normalize_username(username: str) -> str:
    cleaned = (username or "").strip()
    if not re.fullmatch(SPACE_ID_RE, cleaned):
        raise HTTPException(status_code=400, detail="Invalid username.")
    return cleaned


def normalize_role(value: Any) -> str:
    role = value.strip().lower() if isinstance(value, str) else ""
    return role if role in VALID_ROLES else "user"


def normalize_display_name(username: str, value: Any) -> str:
    if isinstance(value, str):
        cleaned = value.strip()
        if cleaned:
            return cleaned
    return username


def sanitize_folder_name(folder_name: str) -> str:
    cleaned = (folder_name or "").strip().replace("\\", "/")
    cleaned = re.sub(r"/+", "/", cleaned).strip("/")
    if not cleaned:
        raise HTTPException(status_code=400, detail="Invalid folder name.")
    parts = cleaned.split("/")
    if not parts or any(not re.fullmatch(SPACE_ID_RE, part) for part in parts):
        raise HTTPException(status_code=400, detail="Invalid folder name.")
    return "/".join(parts)


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


def is_personal_folder_name(folder_name: str) -> bool:
    normalized = normalize_folder_name(folder_name)
    return normalized == PERSONAL_FOLDER_NAME or normalized.startswith(f"{PERSONAL_FOLDER_NAME}/")


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


def md5_digest(password: str, salt: str) -> str:
    data = f"{salt}:{password}".encode("utf-8")
    return hashlib.md5(data).hexdigest()


def build_password_record(password: str) -> Dict[str, str]:
    salt = secrets.token_hex(PASSWORD_SALT_BYTES)
    digest = md5_digest(password, salt)
    return {
        "password_salt": salt,
        "password_hash": digest,
    }


def parse_combined_password_hash(value: Any) -> Optional[Dict[str, str]]:
    if not isinstance(value, str):
        return None
    parts = value.split("$")
    if len(parts) != 3:
        return None
    algo, salt, digest = parts
    if algo != "md5":
        return None
    if not salt or not re.fullmatch(r"[0-9a-fA-F]+", salt):
        return None
    if not re.fullmatch(r"[0-9a-fA-F]{32}", digest):
        return None
    return {
        "password_salt": salt.lower(),
        "password_hash": digest.lower(),
    }


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
        legacy_hash = parse_combined_password_hash(raw.get("password_hash"))
        if legacy_hash:
            return legacy_hash
        password = raw.get("password")
        if isinstance(password, str):
            return build_password_record(password)
    return build_password_record(DEFAULT_BOOTSTRAP_PASSWORD)


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


def verify_password(user_record: Dict[str, Any], password: str) -> bool:
    if not isinstance(password, str):
        return False
    salt = user_record.get("password_salt")
    digest = user_record.get("password_hash")
    if not isinstance(salt, str) or not isinstance(digest, str):
        return False
    return md5_digest(password, salt) == digest


def _load_sessions_data() -> Dict[str, Any]:
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


def _save_sessions_data(data: Dict[str, Any]) -> None:
    try:
        SESSIONS_FILE.write_text(
            json.dumps(data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except Exception:
        logger.exception("Failed to write sessions to %s", SESSIONS_FILE)


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


def create_session(username: str) -> Tuple[str, int]:
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


def remove_session(token: Optional[str]) -> None:
    if not token:
        return
    data = _load_sessions_data()
    sessions, changed = _cleanup_sessions(data)
    if token in sessions:
        sessions.pop(token, None)
        changed = True
    if changed:
        data["sessions"] = sessions
        _save_sessions_data(data)


def remove_sessions_for_user(username: str) -> None:
    data = _load_sessions_data()
    sessions, changed = _cleanup_sessions(data)
    keys = [token for token, payload in sessions.items() if payload.get("username") == username]
    if keys:
        for key in keys:
            sessions.pop(key, None)
        changed = True
    if changed:
        data["sessions"] = sessions
        _save_sessions_data(data)


def auth_from_session(token: Optional[str]) -> Optional[AuthUser]:
    if not token:
        return None
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


def get_session_last_space(token: Optional[str], auth: AuthUser) -> str:
    if not token:
        return ""
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


def set_session_last_space(token: Optional[str], space_id: str) -> None:
    if not token:
        return
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


def update_last_space_for_renamed_space(source_id: str, target_id: str) -> None:
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


def clear_last_space_for_deleted_space(space_id: str) -> None:
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


def load_legacy_users() -> Dict[str, str]:
    users: Dict[str, str] = {}
    if not LEGACY_USERS_FILE.exists():
        return users
    for line in LEGACY_USERS_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if ":" not in line:
            continue
        username, password = line.split(":", 1)
        username = username.strip()
        password = password.strip()
        if username and re.fullmatch(SPACE_ID_RE, username) and password:
            users[username] = password
    return users


def bootstrap_users_from_legacy() -> Dict[str, Dict[str, Any]]:
    legacy = load_legacy_users()
    result: Dict[str, Dict[str, Any]] = {}
    if legacy:
        names = list(legacy.keys())
        for index, username in enumerate(names):
            password = legacy[username]
            role = "admin" if index == 0 else "user"
            result[username] = {
                "display_name": username,
                "role": role,
                "spaces": [],
                **build_password_record(password),
            }
        return result
    result[DEFAULT_BOOTSTRAP_USERNAME] = {
        "display_name": DEFAULT_BOOTSTRAP_USERNAME,
        "role": "admin",
        "spaces": [],
        "must_change_password": True,
        **build_password_record(DEFAULT_BOOTSTRAP_PASSWORD),
    }
    return result


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


def ensure_personal_spaces(users: Dict[str, Dict[str, Any]]) -> None:
    for username in users.keys():
        ensure_personal_space(username)


def load_users_store() -> Dict[str, Dict[str, Any]]:
    users_data = load_users_config_data()
    users, changed = _normalize_users_store(users_data.get("users"))

    if not users:
        jira_data = load_jira_config_data()
        migrated_users, migrated_changed = _normalize_users_store(jira_data.get("users"))
        if migrated_users:
            users = migrated_users
            changed = True
            if "users" in jira_data:
                jira_data.pop("users", None)
                save_jira_config_data(jira_data)
            if migrated_changed:
                changed = True

    if not users:
        users = bootstrap_users_from_legacy()
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


def save_users_store(users: Dict[str, Dict[str, Any]]) -> None:
    users_data = load_users_config_data()
    users_data["users"] = users
    save_users_config_data(users_data)
    ensure_personal_spaces(users)


def sorted_folder_names(names: Set[str]) -> List[str]:
    normalized: Set[str] = set()
    for name in names:
        candidate = normalize_folder_name(name)
        if not candidate or is_personal_folder_name(candidate):
            continue
        normalized.add(candidate)
    return [PERSONAL_FOLDER_NAME, *sorted(normalized)]


def personal_folder_path() -> Path:
    return SPACES_DIR / PERSONAL_FOLDER_NAME


def ensure_personal_folder() -> Path:
    folder = personal_folder_path()
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def folder_path(folder_name: str) -> Path:
    normalized = sanitize_folder_name(folder_name)
    return SPACES_DIR.joinpath(*normalized.split("/"))


def personal_space_path(username: str) -> Path:
    return personal_folder_path() / f"{sanitize_space(username)}.txt"


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


def iter_space_files() -> List[Path]:
    files: List[Path] = []
    for path in SPACES_DIR.rglob("*.txt"):
        if path.is_file():
            files.append(path)
    return files


def folder_from_space_path(path: Path) -> str:
    try:
        rel_parent = path.parent.relative_to(SPACES_DIR)
    except Exception:
        return ""
    if rel_parent == Path("."):
        return ""
    folder_name = normalize_folder_name(rel_parent.as_posix())
    return folder_name


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


def normalize_space_id_from_filename(path: Path) -> str:
    if path.suffix != ".txt":
        return ""
    stem = path.stem
    if not re.fullmatch(SPACE_ID_RE, stem):
        return ""
    return stem


def find_space_file(space_id: str) -> Optional[Path]:
    safe_id = sanitize_space(space_id)
    return scan_space_files().get(safe_id)


def folder_for_space(
    space_id: str,
    users: Dict[str, Dict[str, Any]],
) -> str:
    if space_id in users:
        return PERSONAL_FOLDER_NAME
    path = find_space_file(space_id)
    if not path:
        return ""
    folder_name = folder_from_space_path(path)
    if is_personal_folder_name(folder_name):
        return ""
    return folder_name


def space_access_path(space_id: str, users: Dict[str, Dict[str, Any]]) -> str:
    folder_name = folder_for_space(space_id, users)
    return f"{folder_name}/{space_id}" if folder_name else space_id


def build_space_path_index(
    users: Dict[str, Dict[str, Any]],
) -> Tuple[Dict[str, str], Set[str]]:
    space_by_path: Dict[str, str] = {}
    folder_paths: Set[str] = set()
    for folder in list_space_folder_names():
        normalized = normalize_folder_name(folder)
        if normalized:
            folder_paths.add(normalized)
    for space_id in existing_space_ids():
        path = space_access_path(space_id, users)
        normalized_path = normalize_folder_name(path)
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


def path_rule_allows_space(rule: str, space_path: str) -> bool:
    if rule.endswith("/*"):
        folder = rule[:-2]
        return space_path.startswith(f"{folder}/")
    return rule == space_path


def update_access_paths_for_space_change(
    old_space_path: str,
    new_space_path: str,
) -> None:
    if not old_space_path or not new_space_path or old_space_path == new_space_path:
        return
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


def migrate_legacy_space_config_to_filesystem() -> None:
    if not LEGACY_SPACES_META_FILE.exists():
        return
    try:
        raw_text = LEGACY_SPACES_META_FILE.read_text(encoding="utf-8")
        raw = json.loads(raw_text) if raw_text.strip() else {}
    except Exception:
        logger.exception(
            "Failed to read legacy spaces config from %s",
            LEGACY_SPACES_META_FILE,
        )
        return
    if not isinstance(raw, dict):
        return

    folders = raw.get("folders")
    if isinstance(folders, list):
        for item in folders:
            folder_name = normalize_folder_name(item)
            if not folder_name or is_personal_folder_name(folder_name):
                continue
            try:
                folder_path(folder_name).mkdir(parents=True, exist_ok=True)
            except Exception:
                logger.exception("Failed to create folder %s from legacy config", folder_name)

    mapping = raw.get("space_folders")
    if isinstance(mapping, dict):
        for raw_space_id, raw_folder in mapping.items():
            if not isinstance(raw_space_id, str):
                continue
            try:
                space_id = sanitize_space(raw_space_id)
            except HTTPException:
                continue
            folder_name = normalize_folder_name(raw_folder)
            if not folder_name or is_personal_folder_name(folder_name):
                continue
            source = find_space_file(space_id)
            if not source:
                continue
            target_dir = folder_path(folder_name)
            target_dir.mkdir(parents=True, exist_ok=True)
            target = target_dir / f"{space_id}.txt"
            if source == target:
                continue
            if target.exists():
                logger.warning(
                    "Skipping legacy move for %s to %s because target exists",
                    space_id,
                    target,
                )
                continue
            try:
                source.rename(target)
            except Exception:
                logger.exception(
                    "Failed to move %s to folder %s during legacy migration",
                    source,
                    folder_name,
                )

    backup = LEGACY_SPACES_META_FILE.with_name(
        f"{LEGACY_SPACES_META_FILE.stem}.migrated.{int(time.time())}.json"
    )
    try:
        LEGACY_SPACES_META_FILE.rename(backup)
        logger.info("Legacy spaces config migrated and archived to %s", backup)
    except Exception:
        logger.exception("Failed to archive legacy spaces config %s", LEGACY_SPACES_META_FILE)


def user_record_to_auth(username: str, record: Dict[str, Any]) -> AuthUser:
    return AuthUser(
        username=username,
        display_name=record.get("display_name", username),
        role=record.get("role", "user"),
        spaces=tuple(record.get("spaces", [])),
        must_change_password=bool(record.get("must_change_password")),
    )


def authenticate(username: str, password: str) -> Optional[AuthUser]:
    users = load_users_store()
    record = users.get(username)
    if not record:
        return None
    if not verify_password(record, password):
        return None
    return user_record_to_auth(username, record)


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


def can_manage_spaces(auth: AuthUser) -> bool:
    return auth.role == "admin"


def can_manage_jira(auth: AuthUser) -> bool:
    return auth.role == "admin"


def can_manage_users(auth: AuthUser) -> bool:
    return auth.role in {"admin", "manager"}


def can_assign_space_access(auth: AuthUser) -> bool:
    return auth.role in {"admin", "manager"}


def can_access_space(
    auth: AuthUser,
    space_id: str,
    users: Optional[Dict[str, Dict[str, Any]]] = None,
) -> bool:
    users = users or load_users_store()
    if is_personal_space(space_id, users):
        if auth.role == "admin":
            return True
        return auth.username == space_id
    if auth.role in {"admin", "manager"}:
        return True
    space_access = space_access_path(space_id, users)
    rules = set(auth.spaces)
    for rule in rules:
        if path_rule_allows_space(rule, space_access):
            return True
    return False


def ensure_space_access(
    auth: AuthUser,
    space_id: str,
    users: Optional[Dict[str, Dict[str, Any]]] = None,
) -> None:
    if not can_access_space(auth, space_id, users):
        raise HTTPException(status_code=403, detail="Access denied.")


def serialize_auth(auth: AuthUser) -> Dict[str, Any]:
    return {
        "username": auth.username,
        "display_name": auth.display_name,
        "role": auth.role,
        "spaces": sorted(set(auth.spaces)),
        "must_change_password": bool(auth.must_change_password),
    }


def serialize_permissions(auth: AuthUser) -> Dict[str, bool]:
    return {
        "can_manage_spaces": can_manage_spaces(auth),
        "can_manage_jira": can_manage_jira(auth),
        "can_manage_users": can_manage_users(auth),
        "can_assign_space_access": can_assign_space_access(auth),
    }


def is_personal_space(
    space_id: str,
    users: Optional[Dict[str, Dict[str, Any]]] = None,
) -> bool:
    users = users or load_users_store()
    return space_id in users


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


def remove_presence_from_all_spaces(username: str) -> None:
    for space_id in list(presence.keys()):
        remove_presence(space_id, username)


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


def list_visible_spaces(auth: AuthUser) -> List[str]:
    users = load_users_store()
    spaces = sorted(existing_space_ids())
    return [space_id for space_id in spaces if can_access_space(auth, space_id, users)]


def existing_space_ids() -> Set[str]:
    return set(scan_space_files().keys())


def ensure_space_exists(space_id: str) -> None:
    if space_id not in existing_space_ids():
        raise HTTPException(status_code=404, detail="Space not found.")


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


def space_path(space_id: str) -> Path:
    safe = sanitize_space(space_id)
    existing = find_space_file(safe)
    if existing:
        return existing
    return SPACES_DIR / f"{safe}.txt"


def ystore_path(space_id: str) -> Path:
    safe = sanitize_space(space_id)
    return YSTORE_DIR / f"{safe}.ystore"


def room_name(space_id: str) -> str:
    return f"/ws/{sanitize_space(space_id)}"


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


def ydoc_to_text(ydoc: Y.YDoc) -> str:
    text = ydoc.get_text("content")
    raw = text.to_json()
    if isinstance(raw, str):
        if len(raw) >= 2 and raw[0] == raw[-1] == '"':
            return raw[1:-1]
        return raw
    return str(raw)


def replace_ydoc_text(ydoc: Y.YDoc, content: str) -> None:
    text = ydoc.get_text("content")

    def apply(txn):
        if len(text):
            text.delete_range(txn, 0, len(text))
        if content:
            text.insert(txn, 0, content)

    ydoc.transact(apply)


def schedule_space_snapshot(space_id: str, room) -> None:
    mapped_room = websocket_server.rooms.get(room_name(space_id))
    if mapped_room is not room:
        return
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        try:
            content = ydoc_to_text(room.ydoc)
            space_path(space_id).write_text(content, encoding="utf-8")
        except Exception:
            logger.exception("Failed to snapshot space %s (sync)", space_id)
        return

    if space_id in space_save_tasks:
        space_save_tasks[space_id].cancel()

    async def _save():
        try:
            await asyncio.sleep(SPACE_SAVE_DELAY)
            content = ydoc_to_text(room.ydoc)
            space_path(space_id).write_text(content, encoding="utf-8")
        except asyncio.CancelledError:
            return
        except Exception:
            logger.exception("Failed to snapshot space %s", space_id)
        finally:
            space_save_tasks.pop(space_id, None)

    space_save_tasks[space_id] = asyncio.create_task(_save())


async def hydrate_room_from_storage(space_id: str, room) -> None:
    store_path = ystore_path(space_id)
    if store_path.exists():
        try:
            await room.ystore.apply_updates(room.ydoc)
        except Exception:
            logger.exception("Failed to apply ystore for %s; rebuilding from snapshot", space_id)
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
            content_path = space_path(space_id)
            if content_path.exists():
                content = content_path.read_text(encoding="utf-8")
                if content:
                    replace_ydoc_text(room.ydoc, content)
                    await room.ystore.encode_state_as_update(room.ydoc)
    else:
        content_path = space_path(space_id)
        if content_path.exists():
            content = content_path.read_text(encoding="utf-8")
            if content:
                replace_ydoc_text(room.ydoc, content)
                await room.ystore.encode_state_as_update(room.ydoc)
    room.ready = True
    schedule_space_snapshot(space_id, room)


def attach_snapshot_hook(space_id: str, room) -> None:
    if getattr(room, "_snapshot_hook", False):
        return

    def _after_txn(*_args, **_kwargs):
        schedule_space_snapshot(space_id, room)

    room.ydoc.observe_after_transaction(_after_txn)
    room._snapshot_hook = True


async def scan_ystore_files() -> None:
    if not YSTORE_DIR.exists():
        return
    for store_path in YSTORE_DIR.glob("*.ystore"):
        space_id = store_path.stem
        logger.info("Scanning ystore for %s", space_id)
        ydoc = Y.YDoc()
        store = FileYStore(str(store_path))
        try:
            await store.apply_updates(ydoc)
            continue
        except Exception:
            logger.exception("Corrupt ystore detected for %s; rebuilding", space_id)
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
        content_path = space_path(space_id)
        if content_path.exists():
            content = content_path.read_text(encoding="utf-8")
            if content:
                replace_ydoc_text(ydoc, content)
            try:
                await store.encode_state_as_update(ydoc)
                logger.info("Rebuilt ystore for %s from snapshot", space_id)
            except Exception:
                logger.exception("Failed to rebuild ystore for %s", space_id)
        else:
            logger.warning("No snapshot found for %s; skipping rebuild", space_id)


app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "PUT", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


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


@app.post("/api/logout")
def logout(request: Request, response: ApiResponse) -> Dict[str, Any]:
    remove_session(request.cookies.get(SESSION_COOKIE_NAME))
    response.delete_cookie(key=SESSION_COOKIE_NAME, path="/")
    return {"ok": True}


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


@app.put("/api/me")
def update_me(
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
    refreshed = user_record_to_auth(user.username, users[user.username])
    return {
        "ok": True,
        "user": serialize_auth(refreshed),
        "permissions": serialize_permissions(refreshed),
    }


@app.get("/api/users")
def list_users(user: AuthUser = Depends(require_auth)) -> Dict[str, Any]:
    if not can_manage_users(user):
        raise HTTPException(status_code=403, detail="Not allowed.")
    users = load_users_store()
    rows = [
        user_view(username, users[username], user)
        for username in sorted(users.keys())
    ]
    return {
        "users": rows,
        "roles": ["admin", "manager", "user"],
    }


@app.post("/api/users")
def create_user(
    payload: Dict[str, Any] = Body(default={}),
    user: AuthUser = Depends(require_auth),
) -> Dict[str, Any]:
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Invalid user payload.")
    username = normalize_username(str(payload.get("username") or ""))
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


@app.put("/api/users/{username}")
def update_user(
    username: str,
    payload: Dict[str, Any] = Body(default={}),
    user: AuthUser = Depends(require_auth),
) -> Dict[str, Any]:
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Invalid user payload.")
    target_username = normalize_username(username)
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
    return {"ok": True, "user": user_view(target_username, users[target_username], user)}


@app.delete("/api/users/{username}")
def delete_user(username: str, user: AuthUser = Depends(require_auth)) -> Dict[str, Any]:
    target_username = normalize_username(username)
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


@app.get("/api/spaces")
def list_spaces(user: AuthUser = Depends(require_auth)) -> Dict[str, Any]:
    visible = list_visible_spaces(user)
    users = load_users_store()
    data = [
        {
            "id": space_id,
            "users": users_for_space(space_id),
            "folder": folder_for_space(space_id, users),
            "path": space_access_path(space_id, users),
            "personal": space_id in users,
        }
        for space_id in visible
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
    ensure_space_exists(safe_id)
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

    source = find_space_file(safe_id)
    if not source:
        raise HTTPException(status_code=404, detail="Space not found.")
    users = load_users_store()
    old_space_path = space_access_path(safe_id, users)

    if not folder_name:
        target = SPACES_DIR / f"{safe_id}.txt"
        if source != target:
            if target.exists():
                raise HTTPException(status_code=409, detail="Space already exists.")
            source.rename(target)
            update_access_paths_for_space_change(old_space_path, safe_id)
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
        update_access_paths_for_space_change(
            old_space_path,
            f"{folder_name}/{safe_id}",
        )
    return {"ok": True, "folder": folder_name}


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
    return {
        "ok": True,
        "base_url": config.base_url,
        "email": config.email,
        "token": config.token,
    }


@app.get("/api/spaces/{space_id}")
def read_space(space_id: str, user: AuthUser = Depends(require_auth)) -> Response:
    safe_id = sanitize_space(space_id)
    ensure_space_access(user, safe_id)
    path = space_path(safe_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Space not found.")
    return Response(path.read_text(encoding="utf-8"), media_type="text/plain")


@app.put("/api/spaces/{space_id}")
async def write_space(
    space_id: str,
    content: str = Body(default="", media_type="text/plain"),
    user: AuthUser = Depends(require_auth),
) -> Dict[str, Any]:
    safe_id = sanitize_space(space_id)
    ensure_space_access(user, safe_id)
    path = space_path(safe_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Space not found.")
    path.write_text(content, encoding="utf-8")
    room = websocket_server.rooms.get(room_name(safe_id))
    if room:
        replace_ydoc_text(room.ydoc, content)
        schedule_space_snapshot(safe_id, room)
    else:
        store_path = ystore_path(safe_id)
        if store_path.exists():
            store_path.unlink()
    return {"ok": True}


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


@app.delete("/api/spaces/{space_id}")
async def delete_space(space_id: str, user: AuthUser = Depends(require_auth)) -> Dict[str, Any]:
    if not can_manage_spaces(user):
        raise HTTPException(status_code=403, detail="Not allowed.")
    safe_id = sanitize_space(space_id)
    if is_personal_space(safe_id):
        raise HTTPException(status_code=400, detail="Personal spaces cannot be deleted.")

    await disconnect_space_clients(safe_id)

    room_key = room_name(safe_id)
    room = websocket_server.rooms.get(room_key)
    if room:
        try:
            websocket_server.delete_room(name=room_key)
        except Exception:
            logger.exception("Failed to stop websocket room for %s", safe_id)
            websocket_server.rooms.pop(room_key, None)

    task = space_save_tasks.pop(safe_id, None)
    if task:
        task.cancel()
    removed = False
    for candidate in iter_space_files():
        if normalize_space_id_from_filename(candidate) != safe_id:
            continue
        try:
            candidate.unlink()
            removed = True
        except FileNotFoundError:
            continue
    if not removed:
        raise HTTPException(status_code=404, detail="Space not found.")
    clear_last_space_for_deleted_space(safe_id)
    store_path = ystore_path(safe_id)
    if store_path.exists():
        store_path.unlink()
    presence.pop(safe_id, None)
    return {"ok": True}


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
    old_space_path = space_access_path(source_id, users)

    old_folder = folder_for_space(source_id, users)
    source = space_path(source_id)
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
    if find_space_file(target_id):
        raise HTTPException(status_code=409, detail="Space already exists.")
    source.rename(target)
    new_space_path = f"{old_folder}/{target_id}" if old_folder else target_id
    update_access_paths_for_space_change(old_space_path, new_space_path)
    update_last_space_for_renamed_space(source_id, target_id)
    source_store = ystore_path(source_id)
    target_store = ystore_path(target_id)
    if source_store.exists():
        source_store.rename(target_store)
    room = websocket_server.rooms.get(room_name(source_id))
    if room:
        websocket_server.rename_room(to_name=room_name(target_id), from_room=room)
        schedule_space_snapshot(target_id, room)
    if source_id in presence:
        presence[target_id] = presence.pop(source_id)
    return {"ok": True, "id": target_id}


@app.post("/api/spaces/{space_id}/presence")
def update_presence(
    space_id: str,
    request: Request,
    user: AuthUser = Depends(require_auth),
) -> Dict[str, Any]:
    safe_id = sanitize_space(space_id)
    ensure_space_access(user, safe_id)
    if not space_path(safe_id).exists():
        raise HTTPException(status_code=404, detail="Space not found.")
    set_session_last_space(request.cookies.get(SESSION_COOKIE_NAME), safe_id)
    mark_presence(safe_id, user.username)
    return {"ok": True}


@app.delete("/api/spaces/{space_id}/presence")
def clear_presence(space_id: str, user: AuthUser = Depends(require_auth)) -> Dict[str, Any]:
    safe_id = sanitize_space(space_id)
    ensure_space_access(user, safe_id)
    if not space_path(safe_id).exists():
        raise HTTPException(status_code=404, detail="Space not found.")
    remove_presence(safe_id, user.username)
    return {"ok": True}


def cleanup_presence() -> None:
    now = time.time()
    for space_id in list(presence.keys()):
        users = presence[space_id]
        stale = [name for name, ts in users.items() if now - ts > PRESENCE_TTL]
        for name in stale:
            users.pop(name, None)
        if not users:
            presence.pop(space_id, None)


def mark_presence(space_id: str, username: str) -> None:
    cleanup_presence()
    presence.setdefault(space_id, {})[username] = time.time()


def remove_presence(space_id: str, username: str) -> None:
    users = presence.get(space_id)
    if not users:
        return
    users.pop(username, None)
    if not users:
        presence.pop(space_id, None)


def users_for_space(space_id: str) -> List[str]:
    cleanup_presence()
    users = presence.get(space_id, {})
    return sorted(users.keys())


def space_from_path(path: str) -> Optional[str]:
    if "/ws/" not in path:
        return None
    tail = path.split("/ws/", 1)[1]
    if not tail:
        return None
    name = tail.split("/", 1)[0]
    try:
        return sanitize_space(name)
    except HTTPException:
        return None


def ws_credentials(scope: Dict[str, Any]) -> Tuple[Optional[str], Optional[str]]:
    query = parse_qs(scope.get("query_string", b"").decode())
    user = query.get("user", [None])[0] or query.get("username", [None])[0]
    password = query.get("pass", [None])[0] or query.get("password", [None])[0]
    return user, password


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


async def on_connect(_message: Dict[str, Any], scope: Dict[str, Any]) -> bool:
    space_id = space_from_path(scope.get("path", ""))
    if not space_id:
        return True
    try:
        ensure_space_exists(space_id)
    except HTTPException:
        return True

    auth = auth_from_session(ws_session_token(scope))
    if auth:
        if not can_access_space(auth, space_id):
            return True
        mark_presence(space_id, auth.username)
        return False

    username, password = ws_credentials(scope)
    if not username or not password:
        return True
    auth = authenticate(username.strip(), password)
    if not auth:
        return True
    if not can_access_space(auth, space_id):
        return True
    mark_presence(space_id, auth.username)
    return False


class PersistentWebsocketServer(WebsocketServer):
    async def get_room(self, name: str):
        if name not in self.rooms.keys():
            space_id = space_from_path(name)
            if space_id:
                store = FileYStore(str(ystore_path(space_id)))
                room = YRoom(ready=False, ystore=store, log=self.log)
                self.rooms[name] = room
                await hydrate_room_from_storage(space_id, room)
                attach_snapshot_hook(space_id, room)
            else:
                self.rooms[name] = YRoom(ready=self.rooms_ready, log=self.log)
        room = self.rooms[name]
        await self.start_room(room)
        return room


websocket_server = PersistentWebsocketServer()
app.mount("/ws", ASGIServer(websocket_server, on_connect=on_connect))
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="static")


async def main() -> None:
    migrate_legacy_space_config_to_filesystem()
    load_users_store()
    await scan_ystore_files()
    port_value = os.getenv("PORT", "5000").strip()
    try:
        port = int(port_value)
    except ValueError:
        port = 5000
    config = uvicorn.Config(app, host="0.0.0.0", port=port, log_level="info")
    server = uvicorn.Server(config)
    async with websocket_server:
        await server.serve()


if __name__ == "__main__":
    asyncio.run(main())
