import asyncio
import argparse
import difflib
import json
import logging
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
import sys
import unicodedata

import y_py as Y
import websockets
from websockets.exceptions import ConnectionClosed
from ypy_websocket.websocket_provider import WebsocketProvider

logger = logging.getLogger("jira-worker")

BACKEND_DIR = Path(__file__).resolve().parents[1]
if __package__ in (None, ""):
    sys.path.append(str(BACKEND_DIR))
    from jira.client import JiraClient, from_adf
else:
    from .client import JiraClient, from_adf
SPACES_DIR = BACKEND_DIR / "spaces"

JIRA_BASE_URL = "https://frantisek-horinek.atlassian.net"
JIRA_USER_EMAIL = "frantisekhorinek@gmail.com"
JIRA_API_TOKEN = "ATATT3xFfGF0gNsO7dTjDTs9h-ABRV7tPEfsvf6numTSsD0BgwFVwonJlyYSPDfoSlMhT5RZCD6aym42fbtgvURLSfghBI1M23MJUb98ndEagdA_3S_rOguc_uPY-cN-XMrxiBq0l7M0FpYXutx79CILZq9mZ8PPYBJU7i4v61azwcpDTuXAQys=5471EAAC"
JIRA_PROJECTS: Dict[str, str] = {
    "jira_test": "KAN",
}
JIRA_SYNC_INTERVAL = 10
JIRA_PULL_IDLE_SECONDS = 5
JIRA_ISSUE_TYPE = "Task"
JIRA_SUBTASK_ISSUE_TYPE = "Sub-task"
JIRA_DEFAULT_STATE = "Backlog"
JIRA_STATE_MAP = {
    "todo": "To Do",
    "inprogress": "In Progress",
    "done": "Done",
}
JIRA_STATE_MAP_BY_PROJECT: Dict[str, Dict[str, str]] = {}
JIRA_USER_MAP: Dict[str, str] = {
    # Space assignee -> Jira accountId
    # "maya": "5b10a2844c20165700ede21g",
}
JIRA_MARKER_RE = re.compile(r"\[JIRA:([A-Z][A-Z0-9]+(?:-\d+)?)\]")

space_entity_cache: Dict[str, Dict[str, Any]] = {}
jira_entity_cache: Dict[str, Dict[str, Any]] = {}
JIRA_ACCOUNT_ID_BY_EMAIL: Dict[str, str] = {}
WS_BASE_URL = "ws://localhost:5000/ws"
LOG_BORDER_WIDTH = 60
SERVER_USER = "user"
SERVER_PASSWORD = "devtoken"

TASK_LINE_RE = re.compile(r"^(\s*)%\s+(.*)$")
TOKEN_LINE_RE = re.compile(r"(^|\s)[#!@]")
STATE_TOKEN_RE = re.compile(r"(^|\s)!([^\s#@]+)")
TAG_TOKEN_RE = re.compile(r"(^|\s)#([^\s#@]+)")
PERSON_TOKEN_RE = re.compile(r"(^|\s)@([^\s#@]+)")
REFERENCE_RE = re.compile(r"\{([^}]+)\}")


@dataclass
class PersonConfig:
    slug: str
    name: str
    mail: str


@dataclass
class StateConfig:
    slug: str
    name: str
    jira: List[str]


@dataclass
class ParsedTask:
    line_index: int
    indent: str
    name: str
    jira_key: Optional[str]
    token_line_index: Optional[int]
    desc_start: int
    desc_end: int
    description: str
    state: Optional[str]
    tags: List[str]
    people: List[str]
    parent_index: Optional[int] = None


@dataclass
class SyncEntity:
    key: str
    title: str
    state: Optional[str]
    tags: List[str]
    owner: Optional[str]
    description: str
    linked: List[str]
    timestamp: float = 0.0
    field_timestamps: Dict[str, float] = field(default_factory=dict)


@dataclass
class SpaceTask:
    line_index: int
    indent: str
    title: str
    jira_key: Optional[str]
    jira_project: Optional[str]
    body_start: int
    body_end: int
    token_line_indices: List[int]
    state: Optional[str]
    tags: List[str]
    people: List[str]
    description: str
    parent_index: Optional[int] = None


def jira_enabled() -> bool:
    return (
        JIRA_BASE_URL
        and JIRA_USER_EMAIL
        and JIRA_API_TOKEN
        and "your-" not in JIRA_API_TOKEN
    )


def get_jira_project(space_id: str) -> Optional[str]:
    return (
        JIRA_PROJECTS.get(space_id)
        or JIRA_PROJECTS.get(space_id.lower())
    )


def extract_jira_key(text: str) -> Optional[str]:
    match = JIRA_MARKER_RE.search(text)
    if not match:
        return None
    value = match.group(1)
    if re.fullmatch(r"[A-Z][A-Z0-9]+-\d+", value):
        return value
    return None


def extract_jira_project_hint(text: str) -> Optional[str]:
    match = JIRA_MARKER_RE.search(text)
    if not match:
        return None
    value = match.group(1)
    if re.fullmatch(r"[A-Z][A-Z0-9]+-\d+", value):
        return None
    return value


def strip_jira_marker(text: str) -> str:
    return JIRA_MARKER_RE.sub("", text).strip()


def build_task_line(indent: str, name: str, jira_key: Optional[str]) -> str:
    base = name.strip()
    line = f"{indent}%"
    if jira_key:
        line = f"{line} [JIRA:{jira_key}]"
    if base:
        line = f"{line} {base}"
    return line.rstrip()


def _normalize_list(values: List[str]) -> List[str]:
    return sorted({value.strip() for value in values if value and value.strip()})


def task_snapshot(task: ParsedTask) -> Dict[str, Any]:
    return {
        "name": task.name,
        "description": task.description,
        "state": (task.state or "").strip(),
        "tags": _normalize_list(task.tags),
        "people": _normalize_list(task.people),
    }


def diff_snapshot(
    previous: Optional[Dict[str, Any]],
    current: Dict[str, Any],
) -> Dict[str, Tuple[Any, Any]]:
    changes: Dict[str, Tuple[Any, Any]] = {}
    fields = ("name", "description", "state", "tags", "people")
    for field in fields:
        old_value = previous.get(field) if previous else None
        new_value = current.get(field)
        if old_value != new_value:
            changes[field] = (old_value, new_value)
    return changes


def parse_people_config(
    lines: List[str],
) -> Tuple[Dict[str, PersonConfig], List[str], Optional[Tuple[int, int, str]]]:
    header_index, config_end, header_indent = find_config_bounds(lines)
    expected_indent = len(header_indent) + 4 if header_index is not None else 0
    for idx, line in enumerate(lines[:config_end]):
        if line.strip() != "people:":
            continue
        indent = len(line) - len(line.lstrip(" "))
        if indent != expected_indent:
            continue
        indent_str = line[: len(line) - len(line.lstrip(" "))]
        people_indent = len(indent_str)
        people: Dict[str, PersonConfig] = {}
        order: List[str] = []
        i = idx + 1
        while i < len(lines):
            raw = lines[i]
            if raw.strip() == "":
                i += 1
                continue
            current_indent = len(raw) - len(raw.lstrip(" "))
            if current_indent <= people_indent:
                break
            if current_indent == people_indent + 4 and raw.strip().endswith(":"):
                slug = raw.strip()[:-1].strip()
                name = ""
                mail = ""
                i += 1
                while i < len(lines):
                    nested = lines[i]
                    if nested.strip() == "":
                        i += 1
                        continue
                    nested_indent = len(nested) - len(nested.lstrip(" "))
                    if nested_indent <= people_indent + 4:
                        break
                    if ":" in nested:
                        key, value = nested.strip().split(":", 1)
                        key = key.strip().lower()
                        value = value.strip()
                        if key == "name":
                            name = value
                        elif key in ("mail", "email"):
                            mail = value
                    i += 1
                people[slug] = PersonConfig(slug=slug, name=name, mail=mail)
                order.append(slug)
                continue
            i += 1
        return people, order, (idx, i, indent_str)
    return {}, [], None


def parse_states_config(
    lines: List[str],
) -> Tuple[Dict[str, StateConfig], List[str], Optional[Tuple[int, int, str]]]:
    header_index, config_end, header_indent = find_config_bounds(lines)
    expected_indent = len(header_indent) + 4 if header_index is not None else 0
    for idx, line in enumerate(lines[:config_end]):
        if line.strip() != "states:":
            continue
        indent = len(line) - len(line.lstrip(" "))
        if indent != expected_indent:
            continue
        indent_str = line[: len(line) - len(line.lstrip(" "))]
        states_indent = len(indent_str)
        states: Dict[str, StateConfig] = {}
        order: List[str] = []
        i = idx + 1
        while i < len(lines):
            raw = lines[i]
            if raw.strip() == "":
                i += 1
                continue
            current_indent = len(raw) - len(raw.lstrip(" "))
            if current_indent <= states_indent:
                break
            if current_indent == states_indent + 4 and raw.strip().endswith(":"):
                slug = raw.strip()[:-1].strip()
                name = ""
                jira_values: List[str] = []
                i += 1
                while i < len(lines):
                    nested = lines[i]
                    if nested.strip() == "":
                        i += 1
                        continue
                    nested_indent = len(nested) - len(nested.lstrip(" "))
                    if nested_indent <= states_indent + 4:
                        break
                    if ":" in nested:
                        key, value = nested.strip().split(":", 1)
                        key = key.strip().lower()
                        value = value.strip()
                        if key == "name":
                            name = value
                        elif key == "jira":
                            jira_values = [
                                item.strip()
                                for item in value.split(",")
                                if item.strip()
                            ]
                    i += 1
                states[slug] = StateConfig(slug=slug, name=name, jira=jira_values)
                order.append(slug)
                continue
            i += 1
        return states, order, (idx, i, indent_str)
    return {}, [], None


def render_states_config(
    indent: str, states: Dict[str, StateConfig], order: List[str]
) -> List[str]:
    lines = [f"{indent}states:"]
    entry_indent = indent + " " * 4
    prop_indent = indent + " " * 8
    for slug in order:
        state = states.get(slug)
        if not state:
            continue
        lines.append(f"{entry_indent}{slug}:")
        if state.name:
            lines.append(f"{prop_indent}name: {state.name}")
        if state.jira:
            lines.append(f"{prop_indent}jira: {', '.join(state.jira)}")
    return lines


def apply_states_config(
    lines: List[str],
    states: Dict[str, StateConfig],
    order: List[str],
    block: Optional[Tuple[int, int, str]],
) -> Tuple[List[str], Tuple[int, int, str]]:
    if block:
        start, end, indent = block
        new_block = render_states_config(indent, states, order)
    else:
        header_index, config_end, header_indent = find_config_bounds(lines)
        if header_index is None:
            insert_at = 0
            for idx, line in enumerate(lines):
                if line.strip():
                    insert_at = idx
                    break
            indent = " " * 4
            start, end = insert_at, insert_at
            new_block = ["Board:"] + render_states_config(indent, states, order)
        else:
            indent = header_indent + " " * 4
            start, end = config_end, config_end
            new_block = render_states_config(indent, states, order)
    add_blank = end < len(lines) and lines[end].strip() != ""
    if add_blank:
        new_block.append("")
    lines[start:end] = new_block
    return lines, (start, start + len(new_block), indent)


def render_people_config(
    indent: str, people: Dict[str, PersonConfig], order: List[str]
) -> List[str]:
    lines = [f"{indent}people:"]
    entry_indent = indent + " " * 4
    prop_indent = indent + " " * 8
    for slug in order:
        person = people.get(slug)
        if not person:
            continue
        lines.append(f"{entry_indent}{slug}:")
        if person.name:
            lines.append(f"{prop_indent}name: {person.name}")
        if person.mail:
            lines.append(f"{prop_indent}mail: {person.mail}")
    return lines


def slugify_person(name: str) -> str:
    normalized = unicodedata.normalize("NFKD", name)
    ascii_text = normalized.encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", ascii_text.strip().lower())
    slug = slug.strip("-")
    return slug or "person"


def ensure_unique_slug(base: str, existing: List[str]) -> str:
    candidate = base or "person"
    existing_set = {item.lower() for item in existing}
    if candidate.lower() not in existing_set:
        return candidate
    counter = 2
    while True:
        proposal = f"{candidate}-{counter}"
        if proposal.lower() not in existing_set:
            return proposal
        counter += 1


def apply_people_config(
    lines: List[str],
    people: Dict[str, PersonConfig],
    order: List[str],
    block: Optional[Tuple[int, int, str]],
) -> Tuple[List[str], Tuple[int, int, str]]:
    if block:
        start, end, indent = block
    else:
        header_index, config_end, header_indent = find_config_bounds(lines)
        if header_index is None:
            insert_at = 0
            for idx, line in enumerate(lines):
                if line.strip():
                    insert_at = idx
                    break
            indent = " " * 4
            start, end = insert_at, insert_at
            new_block = ["Board:"] + render_people_config(indent, people, order)
        else:
            indent = header_indent + " " * 4
            start, end = config_end, config_end
            new_block = render_people_config(indent, people, order)
    add_blank = end < len(lines) and lines[end].strip() != ""
    if add_blank:
        new_block.append("")
    lines[start:end] = new_block
    return lines, (start, start + len(new_block), indent)


def find_config_bounds(lines: List[str]) -> Tuple[Optional[int], int, str]:
    first_non_empty = None
    for idx, line in enumerate(lines):
        if line.strip() == "":
            continue
        first_non_empty = idx
        break
    if first_non_empty is None:
        return None, 0, ""
    first_line = lines[first_non_empty]
    if first_line.lstrip().startswith("%"):
        return None, first_non_empty, ""
    if first_line.strip().endswith(":"):
        header_indent = first_line[: len(first_line) - len(first_line.lstrip(" "))]
        start = first_non_empty + 1
        config_end = len(lines)
        for idx in range(start, len(lines)):
            if lines[idx].lstrip().startswith("%"):
                config_end = idx
                break
        return first_non_empty, config_end, header_indent
    config_end = len(lines)
    for idx in range(first_non_empty, len(lines)):
        if lines[idx].lstrip().startswith("%"):
            config_end = idx
            break
    return None, config_end, ""


def is_token_line(text: str) -> bool:
    stripped = text.strip()
    if not stripped:
        return False
    for token in stripped.split():
        if not re.fullmatch(r"[#!@][^\s#@]+", token):
            return False
    return True


def parse_space_tasks(lines: List[str]) -> List[SpaceTask]:
    tasks: List[SpaceTask] = []
    for index, line in enumerate(lines):
        match = TASK_LINE_RE.match(line)
        if not match:
            continue
        indent = match.group(1)
        raw_name = match.group(2).strip()
        jira_key = extract_jira_key(raw_name)
        jira_project = extract_jira_project_hint(raw_name)
        title = strip_jira_marker(raw_name).strip()
        body_start = index + 1
        body_end = body_start
        while body_end < len(lines):
            if TASK_LINE_RE.match(lines[body_end]):
                break
            if lines[body_end].strip() == "":
                break
            body_end += 1
        token_line_indices: List[int] = []
        state: Optional[str] = None
        tags: List[str] = []
        people: List[str] = []
        description_lines: List[str] = []
        for line_index in range(body_start, body_end):
            entry = lines[line_index]
            if entry.startswith(indent):
                entry = entry[len(indent):]
            tags.extend(match.group(2) for match in TAG_TOKEN_RE.finditer(entry))
            people.extend(match.group(2) for match in PERSON_TOKEN_RE.finditer(entry))
            if not state:
                state_match_any = STATE_TOKEN_RE.search(entry)
                if state_match_any:
                    state = state_match_any.group(2)
            if is_token_line(entry):
                token_line_indices.append(line_index)
                token_line = entry.strip()
                state_match = STATE_TOKEN_RE.search(token_line)
                if state_match and not state:
                    state = state_match.group(2)
                tags.extend(match.group(2) for match in TAG_TOKEN_RE.finditer(token_line))
                people.extend(
                    match.group(2) for match in PERSON_TOKEN_RE.finditer(token_line)
                )
                continue
            description_lines.append(entry)
        description = "\n".join(description_lines).rstrip()
        tasks.append(
            SpaceTask(
                line_index=index,
                indent=indent,
                title=title,
                jira_key=jira_key,
                jira_project=jira_project,
                body_start=body_start,
                body_end=body_end,
                token_line_indices=token_line_indices,
                state=state,
                tags=tags,
                people=people,
                description=description,
            )
        )
    return tasks


def find_space_task_by_key(tasks: List[SpaceTask], key: str) -> Optional[SpaceTask]:
    for task in tasks:
        if task.jira_key == key:
            return task
    return None


def assign_space_task_parents(tasks: List[SpaceTask]) -> None:
    stack: List[SpaceTask] = []
    for task in tasks:
        indent = len(task.indent)
        while stack and len(stack[-1].indent) >= indent:
            stack.pop()
        task.parent_index = stack[-1].line_index if stack else None
        stack.append(task)


def build_reference_maps(
    tasks: List[SpaceTask],
) -> Tuple[Dict[str, str], Dict[str, str]]:
    key_to_title: Dict[str, str] = {}
    title_to_key: Dict[str, str] = {}
    for task in tasks:
        if not task.jira_key:
            continue
        title = task.title.strip()
        key = task.jira_key
        if key:
            key_to_title[key] = title
        if title:
            title_lower = title.lower()
            title_to_key.setdefault(title_lower, key)
    return key_to_title, title_to_key


def extract_references(text: str) -> List[str]:
    refs: List[str] = []
    for match in REFERENCE_RE.finditer(text or ""):
        ref = match.group(1).strip()
        if ref:
            refs.append(ref)
    return refs


def normalize_reference_to_key(ref: str, title_to_key: Dict[str, str]) -> Optional[str]:
    cleaned = ref.strip()
    if not cleaned:
        return None
    if re.fullmatch(r"[A-Z][A-Z0-9]+-\d+", cleaned, flags=re.IGNORECASE):
        return cleaned.upper()
    return title_to_key.get(cleaned.lower())


def normalize_description_for_space(
    description: str, key_to_title: Dict[str, str]
) -> str:
    if not description:
        return ""

    def repl(match: re.Match) -> str:
        ref = match.group(1).strip()
        if not ref:
            return match.group(0)
        if re.fullmatch(r"[A-Z][A-Z0-9]+-\d+", ref, flags=re.IGNORECASE):
            title = key_to_title.get(ref.upper())
            if title:
                return f"{{{title}}}"
        return f"{{{ref}}}"

    normalized = REFERENCE_RE.sub(repl, description)
    filtered_lines: List[str] = []
    for line in normalized.split("\n"):
        if is_token_line(line):
            continue
        filtered_lines.append(line)
    return "\n".join(filtered_lines).rstrip()


def convert_description_to_jira(
    description: str, title_to_key: Dict[str, str]
) -> str:
    if not description:
        return ""

    def repl(match: re.Match) -> str:
        ref = match.group(1).strip()
        key = normalize_reference_to_key(ref, title_to_key)
        if key:
            return f"{{{key}}}"
        return f"{{{ref}}}"

    return REFERENCE_RE.sub(repl, description).rstrip()


def extract_linked_keys(
    description: str, title_to_key: Dict[str, str]
) -> List[str]:
    refs = extract_references(description)
    keys: List[str] = []
    for ref in refs:
        key = normalize_reference_to_key(ref, title_to_key)
        if key:
            keys.append(key)
    return _normalize_list(keys)


SYNC_FIELDS = ["title", "state", "tags", "owner", "description", "linked"]


def _entity_field_value(entity: SyncEntity, field: str) -> Any:
    if field == "title":
        return entity.title or ""
    if field == "state":
        return entity.state or ""
    if field == "tags":
        return _normalize_list(entity.tags)
    if field == "owner":
        return entity.owner or ""
    if field == "description":
        return entity.description or ""
    if field == "linked":
        return _normalize_list(entity.linked)
    return None


def entities_equal(left: SyncEntity, right: SyncEntity) -> bool:
    return all(
        _entity_field_value(left, field) == _entity_field_value(right, field)
        for field in SYNC_FIELDS
    )


def update_entity_cache(
    cache: Dict[str, SyncEntity],
    entity: SyncEntity,
    timestamp: float,
) -> SyncEntity:
    existing = cache.get(entity.key)
    field_timestamps: Dict[str, float] = {}
    max_ts = 0.0
    for field in SYNC_FIELDS:
        new_value = _entity_field_value(entity, field)
        if existing:
            old_value = _entity_field_value(existing, field)
            if new_value == old_value:
                existing_field_ts = existing.field_timestamps.get(
                    field, existing.timestamp
                )
                field_ts = existing_field_ts
            else:
                field_ts = timestamp
        else:
            field_ts = timestamp
        field_timestamps[field] = field_ts
        if field_ts > max_ts:
            max_ts = field_ts
    entity.field_timestamps = field_timestamps
    entity.timestamp = max_ts
    cache[entity.key] = entity
    return entity


def copy_entity(entity: SyncEntity, timestamp: Optional[float] = None) -> SyncEntity:
    return SyncEntity(
        key=entity.key,
        title=entity.title,
        state=entity.state,
        tags=list(entity.tags),
        owner=entity.owner,
        description=entity.description,
        linked=list(entity.linked),
        timestamp=entity.timestamp if timestamp is None else timestamp,
        field_timestamps=dict(entity.field_timestamps),
    )


def prune_entity_cache(cache: Dict[str, SyncEntity], keys: List[str]) -> None:
    keep = set(keys)
    for key in list(cache.keys()):
        if key not in keep:
            del cache[key]


def build_space_entity(
    task: SpaceTask,
    key_to_title: Dict[str, str],
    title_to_key: Dict[str, str],
) -> SyncEntity:
    title = task.title.strip()
    description = normalize_description_for_space(task.description, key_to_title)
    linked = extract_linked_keys(description, title_to_key)
    owner = task.people[0] if task.people else None
    state = task.state.strip() if task.state else None
    return SyncEntity(
        key=task.jira_key or "",
        title=title,
        state=state,
        tags=_normalize_list(task.tags),
        owner=owner,
        description=description,
        linked=linked,
    )


def resolve_state_slug(
    status_name: Optional[str],
    states: Dict[str, StateConfig],
    order: List[str],
) -> Tuple[Optional[str], bool]:
    if not status_name:
        return None, False
    for slug, state in states.items():
        for jira_status in state.jira:
            if jira_status.lower() == status_name.lower():
                return slug, False
        if state.name and state.name.lower() == status_name.lower():
            return slug, False
    slug = ensure_unique_slug(slugify_state(status_name), order)
    states[slug] = StateConfig(slug=slug, name=status_name, jira=[status_name])
    order.append(slug)
    return slug, True


def map_space_state_to_jira(
    state: Optional[str], states: Dict[str, StateConfig]
) -> Optional[str]:
    if not state:
        return None
    normalized = state.strip()
    if not normalized:
        return None
    config = states.get(normalized)
    if not config:
        return None
    if config.jira:
        return config.jira[0]
    if config.name:
        return config.name
    return None


def resolve_assignee_slug(
    assignee: Optional[Dict[str, Any]],
    people: Dict[str, PersonConfig],
    order: List[str],
) -> Tuple[Optional[str], bool]:
    slug = map_assignee_to_person(assignee, people)
    if slug:
        return slug, False
    if not assignee:
        return None, False
    display_name = assignee.get("displayName") or assignee.get("name") or "person"
    slug = ensure_unique_slug(slugify_person(display_name), order)
    mail = assignee.get("emailAddress") or ""
    people[slug] = PersonConfig(slug=slug, name=display_name, mail=mail)
    order.append(slug)
    return slug, True


def build_jira_entity(
    issue: Dict[str, Any],
    key_to_title: Dict[str, str],
    title_to_key: Dict[str, str],
    states: Dict[str, StateConfig],
    state_order: List[str],
    people: Dict[str, PersonConfig],
    people_order: List[str],
) -> Tuple[SyncEntity, bool, bool]:
    fields = issue.get("fields", {}) if isinstance(issue, dict) else {}
    jira_key = issue.get("key") if isinstance(issue, dict) else None
    summary = (fields.get("summary") or "").strip()
    description_raw = from_adf(fields.get("description"))
    linked = extract_linked_keys(description_raw, title_to_key)
    description = normalize_description_for_space(description_raw, key_to_title)
    status_name = fields.get("status", {}).get("name")
    state_slug, state_changed = resolve_state_slug(status_name, states, state_order)
    labels = fields.get("labels") or []
    assignee = fields.get("assignee")
    owner_slug, people_changed = resolve_assignee_slug(
        assignee, people, people_order
    )
    entity = SyncEntity(
        key=jira_key or "",
        title=summary,
        state=state_slug,
        tags=_normalize_list(labels),
        owner=owner_slug,
        description=description,
        linked=linked,
    )
    return entity, state_changed, people_changed


def apply_linked_references(
    description: str,
    linked_keys: List[str],
    key_to_title: Dict[str, str],
    title_to_key: Dict[str, str],
) -> str:
    if not description:
        description = ""
    desired_keys = {key.upper() for key in linked_keys}
    seen: set = set()
    lines = description.split("\n") if description else []
    new_lines: List[str] = []

    def repl(match: re.Match) -> str:
        ref = match.group(1).strip()
        key = normalize_reference_to_key(ref, title_to_key)
        if key and key.upper() in desired_keys:
            seen.add(key.upper())
            ref_text = key_to_title.get(key.upper(), ref)
            return f"{{{ref_text}}}"
        return ""

    for line in lines:
        if line.strip() == "":
            new_lines.append(line)
            continue
        updated = REFERENCE_RE.sub(repl, line)
        if updated.strip() == "":
            continue
        new_lines.append(updated.rstrip())

    for key in _normalize_list([key.upper() for key in linked_keys]):
        if key in seen:
            continue
        ref_text = key_to_title.get(key, key)
        new_lines.append(f"{{{ref_text}}}")

    return "\n".join(new_lines).rstrip()


def parse_tasks(lines: List[str]) -> List[ParsedTask]:
    tasks: List[ParsedTask] = []
    for index, line in enumerate(lines):
        match = TASK_LINE_RE.match(line)
        if not match:
            continue
        indent = match.group(1)
        raw_name = match.group(2).strip()
        jira_key = extract_jira_key(raw_name)
        name = strip_jira_marker(raw_name)
        token_line_index = None
        desc_start = index + 1
        if desc_start < len(lines):
            candidate = lines[desc_start].strip()
            if candidate and TOKEN_LINE_RE.search(candidate):
                token_line_index = desc_start
                desc_start += 1
        desc_end = desc_start
        while desc_end < len(lines):
            if TASK_LINE_RE.match(lines[desc_end]):
                break
            if lines[desc_end].strip() == "":
                break
            desc_end += 1
        description_lines = []
        for line_index in range(desc_start, desc_end):
            entry = lines[line_index]
            if entry.startswith(indent):
                entry = entry[len(indent):]
            description_lines.append(entry)
        description = "\n".join(description_lines).strip()
        state = None
        tags: List[str] = []
        people: List[str] = []
        if token_line_index is not None:
            token_line = lines[token_line_index].strip()
            state_match = STATE_TOKEN_RE.search(token_line)
            if state_match:
                state = state_match.group(2)
            tags = [match.group(2) for match in TAG_TOKEN_RE.finditer(token_line)]
            people = [match.group(2) for match in PERSON_TOKEN_RE.finditer(token_line)]
        tasks.append(
            ParsedTask(
                line_index=index,
                indent=indent,
                name=name,
                jira_key=jira_key,
                token_line_index=token_line_index,
                desc_start=desc_start,
                desc_end=desc_end,
                description=description,
                state=state,
                tags=tags,
                people=people,
            )
        )
    return tasks


def assign_task_parents(tasks: List[ParsedTask]) -> None:
    stack: List[ParsedTask] = []
    for task in tasks:
        indent = len(task.indent)
        while stack and len(stack[-1].indent) >= indent:
            stack.pop()
        task.parent_index = stack[-1].line_index if stack else None
        stack.append(task)


def find_task_by_line(tasks: List[ParsedTask], line_index: int) -> Optional[ParsedTask]:
    for task in tasks:
        if task.line_index == line_index:
            return task
    return None


def append_missing_references(description: str, refs: List[str]) -> str:
    if not refs:
        return description
    existing = set(re.findall(r"\{([^}]+)\}", description))
    missing = []
    for ref in refs:
        if ref in existing or ref in missing:
            continue
        missing.append(ref)
    if not missing:
        return description
    lines = description.split("\n") if description else []
    lines.extend([f"{{{ref}}}" for ref in missing])
    return "\n".join(lines)


def extract_issue_link_refs(issue: Dict[str, Any]) -> List[str]:
    fields = issue.get("fields", {}) if isinstance(issue, dict) else {}
    links = fields.get("issuelinks") or []
    refs: List[str] = []
    for link in links:
        if not isinstance(link, dict):
            continue
        inward = link.get("inwardIssue")
        outward = link.get("outwardIssue")
        if isinstance(inward, dict):
            ref = inward.get("fields", {}).get("summary") or inward.get("key")
            if ref:
                refs.append(ref)
        if isinstance(outward, dict):
            ref = outward.get("fields", {}).get("summary") or outward.get("key")
            if ref:
                refs.append(ref)
    seen = set()
    unique = []
    for ref in refs:
        if ref in seen:
            continue
        seen.add(ref)
        unique.append(ref)
    return unique


def insert_jira_key(lines: List[str], task: ParsedTask, jira_key: str) -> None:
    lines[task.line_index] = build_task_line(task.indent, task.name, jira_key)


def set_task_name(lines: List[str], task: ParsedTask, name: str) -> None:
    lines[task.line_index] = build_task_line(task.indent, name, task.jira_key)


def format_token_line(state: Optional[str], tags: List[str], people: List[str]) -> str:
    tokens: List[str] = []
    if state:
        tokens.append(f"!{state}")
    for tag in _normalize_list(tags):
        tokens.append(f"#{tag}")
    for person in _normalize_list(people):
        tokens.append(f"@{person}")
    return " ".join(tokens).strip()


def ensure_task_tokens(
    lines: List[str],
    task: ParsedTask,
    state: Optional[str],
    tags: List[str],
    people: List[str],
) -> Tuple[Optional[int], int, int]:
    token_line_index = task.token_line_index
    desc_start = task.desc_start
    desc_end = task.desc_end
    content = format_token_line(state, tags, people)
    if token_line_index is None:
        if not content:
            return token_line_index, desc_start, desc_end
        insert_at = task.line_index + 1
        lines.insert(insert_at, f"{task.indent}{content}")
        token_line_index = insert_at
        if desc_start >= insert_at:
            desc_start += 1
            desc_end += 1
        return token_line_index, desc_start, desc_end
    if content:
        lines[token_line_index] = f"{task.indent}{content}"
        return token_line_index, desc_start, desc_end
    del lines[token_line_index]
    if desc_start > token_line_index:
        desc_start -= 1
        desc_end -= 1
    token_line_index = None
    return token_line_index, desc_start, desc_end


def set_task_description(
    lines: List[str], task: ParsedTask, description: str, desc_start: int, desc_end: int
) -> None:
    if description.strip():
        desc_lines = description.split("\n")
    else:
        desc_lines = []
    new_block = [
        f"{task.indent}{entry}" if entry else "" for entry in desc_lines
    ]
    lines[desc_start:desc_end] = new_block


def map_state_to_jira(state: Optional[str], project_key: Optional[str] = None) -> Optional[str]:
    if not state:
        return JIRA_DEFAULT_STATE
    normalized = state.strip()
    if not normalized:
        return JIRA_DEFAULT_STATE
    if normalized in JIRA_STATE_MAP:
        return JIRA_STATE_MAP[normalized]
    slug = slugify_state(normalized)
    if slug in JIRA_STATE_MAP:
        return JIRA_STATE_MAP[slug]
    if project_key:
        project_map = JIRA_STATE_MAP_BY_PROJECT.get(project_key, {})
        if normalized in project_map:
            return project_map[normalized]
        if slug in project_map:
            return project_map[slug]
    return None


def map_jira_to_state(status_name: Optional[str]) -> Optional[str]:
    if not status_name:
        return None
    for state, jira_status in JIRA_STATE_MAP.items():
        if jira_status.lower() == status_name.lower():
            return state
    return None


def slugify_state(status_name: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", status_name.strip().lower())
    return slug.strip("-") or "state"


def build_project_state_map(statuses: List[str]) -> Dict[str, str]:
    state_map: Dict[str, str] = {}
    for status in statuses:
        if not status:
            continue
        state_map[slugify_state(status)] = status
    return state_map


async def ensure_project_state_map(
    client: JiraClient, project_key: str
) -> None:
    if project_key in JIRA_STATE_MAP_BY_PROJECT:
        return
    statuses, status_code = await asyncio.to_thread(
        client.get_project_statuses, project_key
    )
    if not statuses:
        logger.warning(
            "[JIRA %s] failed to load statuses (status: %s)",
            project_key,
            status_code,
        )
        return
    JIRA_STATE_MAP_BY_PROJECT[project_key] = build_project_state_map(statuses)
    logger.info(
        "[JIRA %s] loaded %s statuses",
        project_key,
        len(statuses),
    )


def map_assignee_to_person(
    assignee: Optional[Dict[str, Any]],
    people: Dict[str, PersonConfig],
) -> Optional[str]:
    if not assignee:
        return None
    email = assignee.get("emailAddress")
    if email:
        for slug, person in people.items():
            if person.mail and person.mail.lower() == email.lower():
                return slug
    display = assignee.get("displayName") or assignee.get("name")
    if display:
        for slug, person in people.items():
            if person.name and person.name.lower() == display.lower():
                return slug
    account_id = assignee.get("accountId")
    if account_id:
        for person, mapped_id in JIRA_USER_MAP.items():
            if mapped_id == account_id:
                return person
    return None


def summarize_text(text: Optional[str], limit: int = 60) -> str:
    if text is None:
        return "(none)"
    single = " ".join(text.split())
    if not single:
        return "(empty)"
    if len(single) > limit:
        return single[: limit - 3] + "..."
    return single


def format_timestamp(ts: float) -> str:
    if not ts:
        return "-"
    return time.strftime("%m-%d %H:%M:%S", time.localtime(ts))


def format_entity_summary(entity: Optional[SyncEntity]) -> str:
    if not entity:
        return "-"
    parts: List[str] = []
    if entity.title:
        parts.append(entity.title)
    if entity.state:
        parts.append(f"!{entity.state}")
    if entity.owner:
        parts.append(f"@{entity.owner}")
    if entity.tags:
        parts.append(f"tags={','.join(_normalize_list(entity.tags))}")
    if entity.linked:
        parts.append(f"linked={','.join(_normalize_list(entity.linked))}")
    if entity.description:
        parts.append(f"desc={summarize_text(entity.description, limit=60)}")
    return " ".join(parts).strip() or "-"


def render_ascii_table(headers: List[str], rows: List[List[str]]) -> str:
    widths = [len(header) for header in headers]
    for row in rows:
        for idx, cell in enumerate(row):
            widths[idx] = max(widths[idx], len(cell))

    def sep() -> str:
        return "+-" + "-+-".join("-" * width for width in widths) + "-+"

    def render_row(row: List[str]) -> str:
        return "| " + " | ".join(
            cell.ljust(widths[idx]) for idx, cell in enumerate(row)
        ) + " |"

    lines = [sep(), render_row(headers), sep()]
    for row in rows:
        lines.append(render_row(row))
    lines.append(sep())
    return "\n".join(lines)


def format_field_value(field: str, entity: Optional[SyncEntity]) -> str:
    if not entity:
        return "-"
    if field == "title":
        return entity.title or "-"
    if field == "state":
        return f"!{entity.state}" if entity.state else "-"
    if field == "tags":
        tags = _normalize_list(entity.tags)
        return ",".join(tags) if tags else "-"
    if field == "owner":
        return f"@{entity.owner}" if entity.owner else "-"
    if field == "description":
        return summarize_text(entity.description, limit=80)
    if field == "linked":
        linked = _normalize_list(entity.linked)
        return ",".join(linked) if linked else "-"
    return "-"


def get_field_timestamp(entity: Optional[SyncEntity], field: str) -> float:
    if not entity:
        return 0.0
    return entity.field_timestamps.get(field, entity.timestamp)


def format_field_timestamp(entity: Optional[SyncEntity], field: str) -> str:
    if not entity:
        return "-"
    return format_timestamp(get_field_timestamp(entity, field))


def wrap_text(value: str, width: int) -> List[str]:
    if not value or value == "-":
        return ["-"]
    words = value.split()
    if not words:
        return ["-"]
    lines: List[str] = []
    current: List[str] = []
    length = 0
    for word in words:
        word_len = len(word)
        if not current:
            current = [word]
            length = word_len
            continue
        if length + 1 + word_len <= width:
            current.append(word)
            length += 1 + word_len
            continue
        lines.append(" ".join(current))
        current = [word]
        length = word_len
    if current:
        lines.append(" ".join(current))
    return lines or ["-"]


def format_sync_status(
    direction: str, status: Optional[Dict[str, Optional[int]]]
) -> str:
    if direction != "->" or not status:
        return direction
    parts: List[str] = []
    update = status.get("update")
    transition = status.get("transition")
    if update is not None:
        parts.append(f"u={update}")
    if transition is not None:
        parts.append(f"t={transition}")
    if not parts:
        return direction
    return f"{direction}({','.join(parts)})"


def scrub_body_tokens(
    description: str,
    desired_state: Optional[str],
    desired_tags: List[str],
    desired_people: List[str],
) -> str:
    if not description:
        return ""
    tag_set = {tag.lower() for tag in _normalize_list(desired_tags)}
    people_set = {person.lower() for person in _normalize_list(desired_people)}
    state_value = (desired_state or "").lower()
    cleaned_lines: List[str] = []
    for raw_line in description.split("\n"):
        parts = re.split(r"(\s+)", raw_line)
        kept: List[str] = []
        for part in parts:
            if not part or part.isspace():
                kept.append(part)
                continue
            tag_match = TAG_TOKEN_RE.fullmatch(part)
            if tag_match:
                tag = tag_match.group(2).lower()
                if tag in tag_set:
                    kept.append(part)
                continue
            person_match = PERSON_TOKEN_RE.fullmatch(part)
            if person_match:
                person = person_match.group(2).lower()
                if person in people_set:
                    kept.append(part)
                continue
            state_match = STATE_TOKEN_RE.fullmatch(part)
            if state_match:
                state = state_match.group(2).lower()
                if state_value and state == state_value:
                    kept.append(part)
                continue
            kept.append(part)
        line = "".join(kept).strip()
        if line == "":
            continue
        cleaned_lines.append(line)
    return "\n".join(cleaned_lines).rstrip()


def render_space_change_log(
    space_id: str, old_lines: List[str], new_lines: List[str]
) -> Optional[str]:
    matcher = difflib.SequenceMatcher(a=old_lines, b=new_lines)
    entries: List[str] = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue
        if tag == "replace":
            old_slice = old_lines[i1:i2]
            new_slice = new_lines[j1:j2]
            max_len = max(len(old_slice), len(new_slice))
            for idx in range(max_len):
                old = old_slice[idx] if idx < len(old_slice) else ""
                new = new_slice[idx] if idx < len(new_slice) else ""
                if old == new:
                    continue
                line_no = j1 + idx + 1 if idx < len(new_slice) else i1 + idx + 1
                if old and new:
                    entries.append(f"{line_no}: {old} -> {new}")
                elif new:
                    entries.append(f"{line_no}: {new}")
                elif old:
                    entries.append(f"{line_no}: {old}")
        elif tag == "insert":
            for idx, new in enumerate(new_lines[j1:j2]):
                line_no = j1 + idx + 1
                entries.append(f"{line_no}: {new}")
        elif tag == "delete":
            for idx, old in enumerate(old_lines[i1:i2]):
                line_no = i1 + idx + 1
                entries.append(f"{line_no}: {old}")
    if not entries:
        return None
    prefix = "=== changing space "
    width = max(LOG_BORDER_WIDTH, len(prefix) + 1)
    line = prefix + ("=" * (width - len(prefix)))
    border = "=" * len(line)
    return (
        f"{line}\n"
        f"Endpoint {space_id}\n"
        + "\n".join(entries)
        + "\n"
        f"{border}"
    )


def format_tokens(prefix: str, values: List[str]) -> str:
    items = _normalize_list(values)
    if not items:
        return "(none)"
    return " ".join(f"{prefix}{value}" for value in items)


def log_field_change(
    direction: str,
    space_id: str,
    project_key: str,
    jira_key: str,
    field: str,
    old: Any,
    new: Any,
) -> None:
    if field == "name":
        logger.info(
            "[Space %s] %s [JIRA %s] %s title: %s -> %s",
            space_id,
            direction,
            project_key,
            jira_key,
            summarize_text(str(old) if old is not None else ""),
            summarize_text(str(new) if new is not None else ""),
        )
        return
    if field == "description":
        logger.info(
            "[Space %s] %s [JIRA %s] %s description: %s -> %s",
            space_id,
            direction,
            project_key,
            jira_key,
            summarize_text(old if isinstance(old, str) else ""),
            summarize_text(new if isinstance(new, str) else ""),
        )
        return
    if field == "tags":
        logger.info(
            "[Space %s] %s [JIRA %s] %s tags: %s -> %s",
            space_id,
            direction,
            project_key,
            jira_key,
            format_tokens("#", old or []),
            format_tokens("#", new or []),
        )
        return
    if field == "people":
        logger.info(
            "[Space %s] %s [JIRA %s] %s assignee: %s -> %s",
            space_id,
            direction,
            project_key,
            jira_key,
            format_tokens("@", old or []),
            format_tokens("@", new or []),
        )
        return
    if field == "state":
        old_state = f"!{old}" if old else "(none)"
        new_state = f"!{new}" if new else "(none)"
        logger.info(
            "[Space %s] %s [JIRA %s] %s state: %s -> %s",
            space_id,
            direction,
            project_key,
            jira_key,
            old_state,
            new_state,
        )
        return


def summarize_jira_response(
    status: Optional[int], payload: Optional[Dict[str, Any]]
) -> str:
    if status is None:
        return "status: (none)"
    if not payload:
        return f"status: {status}"
    preview = str(payload)
    if len(preview) > 200:
        preview = preview[:197] + "..."
    return f"status: {status}, payload: {preview}"


def log_parsed_task(space_id: str, task: ParsedTask) -> None:
    logger.info("[Space %s] parsed line_index=%s", space_id, task.line_index)
    logger.info("[Space %s] parsed indent=%s", space_id, repr(task.indent))
    logger.info("[Space %s] parsed name=%s", space_id, task.name)
    logger.info("[Space %s] parsed jira_key=%s", space_id, task.jira_key or "")
    logger.info("[Space %s] parsed token_line_index=%s", space_id, task.token_line_index)
    logger.info("[Space %s] parsed desc_start=%s", space_id, task.desc_start)
    logger.info("[Space %s] parsed desc_end=%s", space_id, task.desc_end)
    logger.info("[Space %s] parsed description=%s", space_id, task.description)
    logger.info("[Space %s] parsed state=%s", space_id, task.state or "")
    logger.info("[Space %s] parsed tags=%s", space_id, ",".join(task.tags))
    logger.info("[Space %s] parsed people=%s", space_id, ",".join(task.people))


def log_jira_issue_fields(
    space_id: str,
    project_key: str,
    jira_key: str,
    summary: str,
    description: str,
    status_name: Optional[str],
    next_state: Optional[str],
    labels: List[str],
    assignee: Optional[Dict[str, Any]],
    issue_links: Optional[List[str]] = None,
) -> None:
    prefix = f"[Space {space_id}] <- [JIRA {project_key}] {jira_key}"
    logger.info("%s summary=%s", prefix, summary)
    logger.info("%s description=%s", prefix, description)
    logger.info("%s status_name=%s", prefix, status_name or "")
    logger.info("%s next_state=%s", prefix, next_state or "")
    logger.info("%s labels=%s", prefix, ",".join(labels))
    if issue_links is not None:
        logger.info("%s issuelinks=%s", prefix, ",".join(issue_links))
    if assignee:
        logger.info("%s assignee.displayName=%s", prefix, assignee.get("displayName", ""))
        logger.info("%s assignee.email=%s", prefix, assignee.get("emailAddress", ""))
        logger.info("%s assignee.accountId=%s", prefix, assignee.get("accountId", ""))
    else:
        logger.info("%s assignee.displayName=", prefix)
        logger.info("%s assignee.email=", prefix)
        logger.info("%s assignee.accountId=", prefix)


async def resolve_account_id(
    client: JiraClient, email: str
) -> Optional[str]:
    normalized = email.strip().lower()
    if not normalized:
        return None
    cached = JIRA_ACCOUNT_ID_BY_EMAIL.get(normalized)
    if cached:
        return cached
    users, status = await asyncio.to_thread(client.search_users, normalized)
    if not users:
        logger.warning("Jira user search failed for %s (status: %s)", email, status)
        return None
    for user in users:
        if not isinstance(user, dict):
            continue
        user_email = user.get("emailAddress")
        if user_email and user_email.lower() == normalized:
            account_id = user.get("accountId")
            if account_id:
                JIRA_ACCOUNT_ID_BY_EMAIL[normalized] = account_id
                return account_id
    for user in users:
        if isinstance(user, dict):
            account_id = user.get("accountId")
            if account_id:
                JIRA_ACCOUNT_ID_BY_EMAIL[normalized] = account_id
                logger.info(
                    "Falling back to first Jira user match for %s (status: %s)",
                    email,
                    status,
                )
                return account_id
    return None


async def resolve_owner_account_id(
    client: JiraClient,
    owner: Optional[str],
    people: Dict[str, PersonConfig],
) -> Optional[str]:
    if not owner:
        return None
    account_id = JIRA_USER_MAP.get(owner)
    if account_id:
        return account_id
    config = people.get(owner)
    if not config:
        return None
    if not config.mail:
        return None
    return await resolve_account_id(client, config.mail)


class WebsocketAdapter:
    def __init__(self, websocket, path: str) -> None:
        self._websocket = websocket
        self._path = path

    @property
    def path(self) -> str:
        return self._path

    def __aiter__(self):
        return self

    async def __anext__(self) -> bytes:
        try:
            return await self.recv()
        except Exception:
            raise StopAsyncIteration()

    async def send(self, message: bytes) -> None:
        await self._websocket.send(message)

    async def recv(self) -> bytes:
        message = await self._websocket.recv()
        if isinstance(message, bytes):
            return message
        return message.encode("utf-8")


@dataclass
class SpaceSession:
    space_id: str
    websocket: Any
    provider: WebsocketProvider
    ydoc: Y.YDoc
    provider_task: asyncio.Task
    last_change: float = 0.0
    ignore_until: float = 0.0
    last_content_len: int = -1
    pending_change: bool = False
    last_content: str = ""

    async def close(self) -> None:
        try:
            await self.provider.stop()
        except Exception:
            logger.debug("Failed stopping provider for %s", self.space_id)
        try:
            await asyncio.wait_for(self.provider_task, timeout=2)
        except Exception:
            logger.debug("Failed waiting for provider task for %s", self.space_id)
        try:
            await self.websocket.close()
        except Exception:
            logger.debug("Failed closing websocket for %s", self.space_id)


async def open_space_session(space_id: str) -> SpaceSession:
    url = f"{WS_BASE_URL}/{space_id}?user={SERVER_USER}&password={SERVER_PASSWORD}"
    logger.debug("Connecting to space %s via %s", space_id, url)
    try:
        ws = await asyncio.wait_for(
            websockets.connect(
                url,
                max_size=8 * 1024 * 1024,
                open_timeout=5,
                ping_interval=20,
                ping_timeout=20,
            ),
            timeout=6,
        )
    except TimeoutError:
        logger.error("Timed out opening websocket to %s", url)
        raise
    except Exception:
        logger.exception("Failed to connect to %s", url)
        raise
    logger.debug("Websocket connected for space %s", space_id)
    adapter = WebsocketAdapter(ws, path=f"/ws/{space_id}")
    ydoc = Y.YDoc()
    provider_logger = logging.getLogger("jira-worker.yjs")
    provider_logger.setLevel(logging.WARNING)
    provider = WebsocketProvider(ydoc, adapter, log=provider_logger)
    logger.debug("Starting Yjs provider for space %s", space_id)
    provider_task = asyncio.create_task(provider.start())
    try:
        await asyncio.wait_for(provider.started.wait(), timeout=5)
    except TimeoutError:
        logger.error("Timed out waiting for Yjs provider to start for %s", space_id)
        provider_task.cancel()
        await ws.close()
        raise
    logger.info("Yjs provider started for space %s", space_id)
    await asyncio.sleep(0.2)
    session = SpaceSession(
        space_id=space_id,
        websocket=ws,
        provider=provider,
        ydoc=ydoc,
        provider_task=provider_task,
    )

    def _after_txn(*_args, **_kwargs):
        session.pending_change = True

    ydoc.observe_after_transaction(_after_txn)
    logger.info("Connected to space %s via Yjs", space_id)
    return session


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


async def read_ydoc_text(ydoc: Y.YDoc, retries: int = 5) -> str:
    for attempt in range(retries):
        try:
            return ydoc_to_text(ydoc)
        except RuntimeError:
            if attempt == retries - 1:
                raise
            await asyncio.sleep(0.05)
    return ""


async def sync_space_with_jira(
    client: JiraClient,
    session: SpaceSession,
    project_key: str,
    force_direction: Optional[str] = None,
) -> None:
    content = await read_ydoc_text(session.ydoc)
    if not content.strip():
        for _ in range(20):
            await asyncio.sleep(0.1)
            content = await read_ydoc_text(session.ydoc)
            if content.strip():
                break
    logger.debug(
        "Read %s chars from space %s",
        len(content),
        session.space_id,
    )
    if session.pending_change:
        if content != session.last_content:
            session.last_content = content
            if time.time() >= session.ignore_until:
                session.last_change = time.time()
                logger.debug("Recorded user change for %s", session.space_id)
            else:
                logger.debug("Ignoring worker-applied change for %s", session.space_id)
        else:
            logger.debug(
                "Received Yjs update without content change for %s", session.space_id
            )
        session.pending_change = False

    lines = content.split("\n")
    original_lines = list(lines)
    people_config, people_order, people_block = parse_people_config(lines)
    states_config, states_order, states_block = parse_states_config(lines)
    tasks = parse_space_tasks(lines)
    assign_space_task_parents(tasks)
    if not tasks:
        logger.debug("No tasks found in space %s", session.space_id)
        return

    pending_tasks = [task for task in tasks if task.jira_project and not task.jira_key]
    logger.info("* Scanning for new tasks")
    if pending_tasks:
        logger.info("    %s Found", len(pending_tasks))
    else:
        logger.info("    none found")

    key_to_title, title_to_key = build_reference_maps(tasks)
    tasks_by_line: Dict[int, SpaceTask] = {task.line_index: task for task in tasks}
    created = False
    for task in tasks:
        if task.jira_key or not task.jira_project:
            continue
        parent_task = (
            tasks_by_line.get(task.parent_index)
            if task.parent_index is not None
            else None
        )
        issue_type = (
            JIRA_SUBTASK_ISSUE_TYPE
            if parent_task and parent_task.jira_key
            else JIRA_ISSUE_TYPE
        )
        parent_key = parent_task.jira_key if parent_task and parent_task.jira_key else None
        project_key_hint = task.jira_project.upper()
        jira_description = convert_description_to_jira(task.description, title_to_key)
        owner_slug = task.people[0] if task.people else None
        assignee_id = await resolve_owner_account_id(
            client, owner_slug, people_config
        )
        logger.info("* Adding task %s to jira", task.title)
        issue_key, status, payload = await asyncio.to_thread(
            client.create_issue,
            project_key_hint,
            task.title,
            jira_description,
            task.tags,
            issue_type,
            parent_key,
            assignee_id,
        )
        logger.info("* Assigned key %s", issue_key or "(none)")
        if not issue_key:
            logger.warning(
                "[Space %s] -> [JIRA %s] failed to create issue for '%s'",
                session.space_id,
                project_key_hint,
                task.title,
            )
            continue
        lines[task.line_index] = build_task_line(task.indent, task.title, issue_key)
        created = True

    if created:
        tasks = parse_space_tasks(lines)
        assign_space_task_parents(tasks)
        key_to_title, title_to_key = build_reference_maps(tasks)

    tasks_by_key: Dict[str, SpaceTask] = {
        task.jira_key: task for task in tasks if task.jira_key
    }

    space_cache = space_entity_cache.setdefault(session.space_id, {})
    space_entities: Dict[str, SyncEntity] = {}
    for task in tasks:
        if not task.jira_key:
            continue
        entity = build_space_entity(task, key_to_title, title_to_key)
        entity = update_entity_cache(space_cache, entity, time.time())
        space_entities[entity.key] = entity
    prune_entity_cache(space_cache, list(space_entities.keys()))

    jira_cache = jira_entity_cache.setdefault(session.space_id, {})
    jira_entities: Dict[str, SyncEntity] = {}
    states_changed = False
    people_changed = False

    for key in space_entities:
        logger.debug("Fetching Jira issue %s for space %s", key, session.space_id)
        issue, status = await asyncio.to_thread(client.get_issue, key)
        logger.debug(
            "[Space %s] <- [JIRA %s] fetch response for %s: %s",
            session.space_id,
            project_key,
            key,
            summarize_jira_response(status, issue if isinstance(issue, dict) else None),
        )
        if not issue or not isinstance(issue, dict):
            continue
        if isinstance(issue, dict):
            logger.debug(
                "[Space %s] <- [JIRA %s] payload for %s:\n%s",
                session.space_id,
                project_key,
                key,
                json.dumps(issue, ensure_ascii=False, indent=2),
            )
        entity, state_added, person_added = build_jira_entity(
            issue,
            key_to_title,
            title_to_key,
            states_config,
            states_order,
            people_config,
            people_order,
        )
        states_changed = states_changed or state_added
        people_changed = people_changed or person_added
        entity = update_entity_cache(jira_cache, entity, time.time())
        jira_entities[entity.key] = entity

    prune_entity_cache(jira_cache, list(jira_entities.keys()))

    field_directions_by_key: Dict[str, Dict[str, str]] = {}
    diff_fields_by_key: Dict[str, set] = {}
    for key, space_entity in space_entities.items():
        jira_entity = jira_entities.get(key)
        field_dirs: Dict[str, str] = {}
        if not jira_entity:
            field_directions_by_key[key] = field_dirs
            continue
        diff_fields: set = set()
        for field in SYNC_FIELDS:
            if _entity_field_value(space_entity, field) == _entity_field_value(
                jira_entity, field
            ):
                continue
            diff_fields.add(field)
            if force_direction == "push":
                field_dirs[field] = "->"
            elif force_direction == "pull":
                field_dirs[field] = "<-"
            else:
                space_ts = get_field_timestamp(space_entity, field)
                jira_ts = get_field_timestamp(jira_entity, field)
                if space_ts > jira_ts:
                    field_dirs[field] = "->"
                elif jira_ts > space_ts:
                    field_dirs[field] = "<-"
                else:
                    field_dirs[field] = "??"
                    logger.debug(
                        "[Space %s] %s field %s has equal timestamps; skipping sync this round",
                        session.space_id,
                        key,
                        field,
                    )
        if diff_fields:
            diff_fields_by_key[key] = diff_fields
        field_directions_by_key[key] = field_dirs

    field_order = list(SYNC_FIELDS)
    jira_status_by_key: Dict[str, Dict[str, Optional[int]]] = {}
    space_changed = False
    space_change_logged = False

    if states_changed:
        before_lines = list(lines)
        lines, states_block = apply_states_config(
            lines, states_config, states_order, states_block
        )
        _, _, people_block = parse_people_config(lines)
        change_log = render_space_change_log(
            session.space_id, before_lines, lines
        )
        if change_log:
            logger.info("%s", change_log)
            space_change_logged = True
        space_changed = space_changed or (before_lines != lines)
    if people_changed:
        before_lines = list(lines)
        lines, people_block = apply_people_config(
            lines, people_config, people_order, people_block
        )
        change_log = render_space_change_log(
            session.space_id, before_lines, lines
        )
        if change_log:
            logger.info("%s", change_log)
            space_change_logged = True
        space_changed = space_changed or (before_lines != lines)

    if states_changed or people_changed:
        tasks = parse_space_tasks(lines)
        assign_space_task_parents(tasks)
        key_to_title, title_to_key = build_reference_maps(tasks)
        tasks_by_key = {task.jira_key: task for task in tasks if task.jira_key}
        tasks_by_line = {task.line_index: task for task in tasks}

    ordered_keys = sorted(
        tasks_by_key.keys(),
        key=lambda item: tasks_by_key.get(item).line_index
        if tasks_by_key.get(item)
        else 0,
    )

    ref_key_to_title = dict(key_to_title)
    for key, entity in jira_entities.items():
        if entity.title:
            ref_key_to_title[key] = entity.title
    ref_title_to_key = {
        title.lower(): key for key, title in ref_key_to_title.items() if title
    }

    for key in ordered_keys:
        logger.info("* Syncing task %s", key)
        logger.info("* Getting data from space")
        space_entity = space_entities.get(key)
        logger.info("* Getting data from Jira")
        jira_entity = jira_entities.get(key)

        field_directions = field_directions_by_key.get(key, {})
        status = jira_status_by_key.get(key)
        diff_fields = diff_fields_by_key.get(key, set())
        push_fields = {
            field for field, direction in field_directions.items() if direction == "->"
        }
        pull_fields = {
            field for field, direction in field_directions.items() if direction == "<-"
        }

        rows: List[List[str]] = []
        for field in field_order:
            space_value = format_field_value(field, space_entity)
            jira_value = format_field_value(field, jira_entity)
            field_changed = field in diff_fields
            if field == "description":
                space_lines = wrap_text(space_value, 60)
                jira_lines = wrap_text(jira_value, 60)
                max_lines = max(len(space_lines), len(jira_lines))
                for idx in range(max_lines):
                    sync_value = ""
                    if field_changed and idx == 0:
                        sync_value = format_sync_status(
                            field_directions.get(field, "??"), status
                        )
                    rows.append(
                        [
                            field if idx == 0 else "",
                            space_lines[idx] if idx < len(space_lines) else "",
                            format_field_timestamp(space_entity, field)
                            if idx == 0
                            else "",
                            sync_value,
                            jira_lines[idx] if idx < len(jira_lines) else "",
                            format_field_timestamp(jira_entity, field)
                            if idx == 0
                            else "",
                        ]
                    )
            else:
                sync_value = ""
                if field_changed:
                    sync_value = format_sync_status(
                        field_directions.get(field, "??"), status
                    )
                rows.append(
                    [
                        field,
                        space_value,
                        format_field_timestamp(space_entity, field),
                        sync_value,
                        jira_value,
                        format_field_timestamp(jira_entity, field),
                    ]
                )
        table = render_ascii_table(
            ["field", "space", "space ts", "sync", "jira", "jira ts"],
            rows,
        )
        logger.info("%s", table)

        if push_fields and space_entity and jira_entity:
            changes: Dict[str, Tuple[Any, Any]] = {}
            if "title" in push_fields:
                changes["title"] = (jira_entity.title, space_entity.title)
            if "description" in push_fields or "linked" in push_fields:
                changes["description"] = (
                    jira_entity.description,
                    space_entity.description,
                )
                changes["linked"] = (jira_entity.linked, space_entity.linked)
            if "tags" in push_fields:
                changes["tags"] = (jira_entity.tags, space_entity.tags)
            if "owner" in push_fields:
                changes["owner"] = (jira_entity.owner, space_entity.owner)
            if "state" in push_fields:
                changes["state"] = (jira_entity.state, space_entity.state)
            if changes:
                if "title" in changes:
                    logger.info("* Updating jira title to %s", space_entity.title)
                if "owner" in changes:
                    owner = space_entity.owner or ""
                    logger.info(
                        "* Updating jira owner to %s",
                        f"@{owner}" if owner else "(none)",
                    )
                if "state" in changes:
                    logger.info(
                        "* Updating jira state to %s",
                        space_entity.state or "(none)",
                    )
                if "tags" in changes:
                    logger.info(
                        "* Updating jira tags to %s",
                        ",".join(_normalize_list(space_entity.tags)) or "(none)",
                    )
                if "description" in changes:
                    logger.info("* Updating jira description")
                assignee_id = None
                clear_assignee = False
                if "owner" in changes and space_entity.owner:
                    assignee_id = await resolve_owner_account_id(
                        client, space_entity.owner, people_config
                    )
                    if not assignee_id:
                        logger.info(
                            "[Space %s] -> [JIRA %s] %s owner not mapped; skipping Jira assignee update",
                            session.space_id,
                            project_key,
                            key,
                        )
                if "owner" in changes and not space_entity.owner:
                    clear_assignee = True
                update_summary = "title" in changes
                update_description = "description" in changes
                update_labels = "tags" in changes
                should_update_issue = (
                    update_summary
                    or update_description
                    or update_labels
                    or ((assignee_id is not None or clear_assignee) and "owner" in changes)
                )
                updated_jira = copy_entity(jira_entity)
                jira_updated = False
                if should_update_issue:
                    jira_description = None
                    if update_description:
                        jira_description = convert_description_to_jira(
                            space_entity.description, title_to_key
                        )
                    status, payload = await asyncio.to_thread(
                        client.update_issue,
                        key,
                        space_entity.title if update_summary else None,
                        jira_description,
                        space_entity.tags if update_labels else None,
                        assignee_id,
                        clear_assignee,
                    )
                    jira_status_by_key.setdefault(key, {})["update"] = status
                    logger.debug(
                        "[Space %s] -> [JIRA %s] update response for %s: %s",
                        session.space_id,
                        project_key,
                        key,
                        summarize_jira_response(status, payload),
                    )
                    if status is not None:
                        if update_summary:
                            updated_jira.title = space_entity.title
                        if update_description:
                            updated_jira.description = space_entity.description
                            updated_jira.linked = list(space_entity.linked)
                        if update_labels:
                            updated_jira.tags = list(space_entity.tags)
                        if assignee_id is not None or clear_assignee:
                            updated_jira.owner = space_entity.owner
                        jira_updated = True
                if "state" in changes:
                    jira_status = map_space_state_to_jira(
                        space_entity.state, states_config
                    )
                    if jira_status:
                        logger.info(
                            "[Space %s] -> [JIRA %s] transition %s -> %s",
                            session.space_id,
                            project_key,
                            key,
                            jira_status,
                        )
                        status, payload = await asyncio.to_thread(
                            client.transition_issue, key, jira_status
                        )
                        jira_status_by_key.setdefault(key, {})["transition"] = status
                        logger.debug(
                            "[Space %s] -> [JIRA %s] transition response for %s: %s",
                            session.space_id,
                            project_key,
                            key,
                            summarize_jira_response(status, payload),
                        )
                    if status is not None:
                        updated_jira.state = space_entity.state
                        jira_updated = True
                if jira_updated:
                    updated_jira = update_entity_cache(
                        jira_cache, updated_jira, time.time()
                    )
                    jira_entities[key] = updated_jira

        if pull_fields and jira_entity:
            task = tasks_by_key.get(key)
            if not task:
                logger.info("* Task %s done", key)
                continue
            before_task_lines = list(lines)
            task_changed = False
            if "title" in pull_fields:
                desired_title = jira_entity.title
                if desired_title and desired_title != task.title:
                    lines[task.line_index] = build_task_line(
                        task.indent, desired_title, key
                    )
                    task_changed = True

            desired_state = (
                jira_entity.state if "state" in pull_fields else task.state
            )
            desired_tags = (
                jira_entity.tags if "tags" in pull_fields else task.tags
            )
            if "owner" in pull_fields:
                desired_owner = [jira_entity.owner] if jira_entity.owner else []
            else:
                desired_owner = list(task.people)
            tokens_need_change = (
                (desired_state or "") != (task.state or "")
                or _normalize_list(desired_tags) != _normalize_list(task.tags)
                or _normalize_list(desired_owner) != _normalize_list(task.people)
            )
            if tokens_need_change:
                desired_token = format_token_line(
                    desired_state, desired_tags, desired_owner
                )
                token_line_indices = list(task.token_line_indices)
                if desired_token:
                    desired_line = f"{task.indent}{desired_token}"
                    if token_line_indices:
                        current_line = lines[token_line_indices[0]]
                        if current_line != desired_line:
                            lines[token_line_indices[0]] = desired_line
                            task_changed = True
                        if len(token_line_indices) > 1:
                            for index in reversed(token_line_indices[1:]):
                                del lines[index]
                            task_changed = True
                    else:
                        insert_at = task.body_start
                        lines.insert(insert_at, desired_line)
                        task_changed = True
                else:
                    if token_line_indices:
                        for index in reversed(token_line_indices):
                            del lines[index]
                        task_changed = True

            if tokens_need_change and task_changed:
                tasks = parse_space_tasks(lines)
                assign_space_task_parents(tasks)
                task = find_space_task_by_key(tasks, key)
                tasks_by_key = {
                    task.jira_key: task for task in tasks if task.jira_key
                }
                tasks_by_line = {task.line_index: task for task in tasks}
                key_to_title, title_to_key = build_reference_maps(tasks)
                if not task:
                    continue

            pull_description = bool({"description", "linked"} & pull_fields)
            updated_description = task.description
            if pull_description:
                description = apply_linked_references(
                    jira_entity.description,
                    jira_entity.linked,
                    ref_key_to_title,
                    ref_title_to_key,
                )
                description = scrub_body_tokens(
                    description,
                    desired_state,
                    desired_tags,
                    desired_owner,
                )
                if description != task.description:
                    updated_description = description
                    token_lines = [
                        lines[index]
                        for index in task.token_line_indices
                        if index < len(lines)
                    ]
                    new_body_lines: List[str] = []
                    new_body_lines.extend(token_lines)
                    if description:
                        for entry in description.split("\n"):
                            new_body_lines.append(
                                f"{task.indent}{entry}" if entry else ""
                            )
                    lines[task.body_start:task.body_end] = new_body_lines
                    task_changed = True

            if task_changed:
                space_changed = True
                if space_entity:
                    updated_space = copy_entity(space_entity)
                else:
                    updated_space = copy_entity(jira_entity)
                if "title" in pull_fields:
                    updated_space.title = jira_entity.title
                if "state" in pull_fields:
                    updated_space.state = jira_entity.state
                if "tags" in pull_fields:
                    updated_space.tags = list(jira_entity.tags)
                if "owner" in pull_fields:
                    updated_space.owner = jira_entity.owner
                if pull_description:
                    updated_space.description = updated_description
                    updated_space.linked = list(jira_entity.linked)
                updated_space = update_entity_cache(
                    space_cache, updated_space, time.time()
                )
                space_entities[key] = updated_space
                logger.info("* Updating space")
                change_log = render_space_change_log(
                    session.space_id, before_task_lines, lines
                )
                if change_log:
                    logger.info("%s", change_log)
                    space_change_logged = True
                tasks = parse_space_tasks(lines)
                assign_space_task_parents(tasks)
                key_to_title, title_to_key = build_reference_maps(tasks)
                tasks_by_key = {
                    task.jira_key: task for task in tasks if task.jira_key
                }
                tasks_by_line = {task.line_index: task for task in tasks}
                ref_key_to_title = dict(key_to_title)
                for ref_key, entity in jira_entities.items():
                    if entity.title:
                        ref_key_to_title[ref_key] = entity.title
                ref_title_to_key = {
                    title.lower(): key
                    for key, title in ref_key_to_title.items()
                    if title
                }
        logger.info("* Task %s done", key)

    if space_changed or states_changed or people_changed:
        if not space_change_logged:
            change_log = render_space_change_log(
                session.space_id, original_lines, lines
            )
            if change_log:
                logger.info("%s", change_log)
        content = "\n".join(lines)
        logger.debug("Writing Jira updates to space %s", session.space_id)
        session.ignore_until = time.time() + 0.2
        replace_ydoc_text(session.ydoc, content)
        await asyncio.sleep(0.1)


async def jira_sync_loop(
    one_shot: bool = False, force_direction: Optional[str] = None
) -> None:
    if not jira_enabled():
        logger.info("Jira sync disabled. Configure JIRA_* constants to enable.")
        return
    SPACES_DIR.mkdir(parents=True, exist_ok=True)
    client = JiraClient(JIRA_BASE_URL, JIRA_USER_EMAIL, JIRA_API_TOKEN)
    logger.info("Jira worker started. Polling every %ss", JIRA_SYNC_INTERVAL)
    sessions: Dict[str, SpaceSession] = {}
    while True:
        try:
            logger.info("-" * 40 + " tick")
            for path in SPACES_DIR.glob("*.txt"):
                space_id = path.stem
                project_key = get_jira_project(space_id)
                if not project_key:
                    logger.debug("No Jira project mapping for space %s", space_id)
                    continue
                logger.debug("Syncing space %s -> project %s", space_id, project_key)
                session = sessions.get(space_id)
                if not session:
                    try:
                        session = await open_space_session(space_id)
                    except TimeoutError:
                        logger.warning("Skipping space %s due to connection timeout", space_id)
                        continue
                    sessions[space_id] = session
                await sync_space_with_jira(
                    client,
                    session,
                    project_key,
                    force_direction=force_direction,
                )
        except ConnectionClosed:
            logger.warning("Websocket disconnected; will reconnect")
            for session in sessions.values():
                await session.close()
            sessions.clear()
        except Exception:
            logger.exception("Jira sync loop failed")
        if one_shot:
            break
        logger.info("* Sleeping")
        await asyncio.sleep(JIRA_SYNC_INTERVAL)


def main() -> None:
    parser = argparse.ArgumentParser(description="Jira sync worker")
    parser.add_argument(
        "--one-shot",
        action="store_true",
        help="Run a single sync cycle and exit (debug mode).",
    )
    mode_group = parser.add_mutually_exclusive_group()
    mode_group.add_argument(
        "--push",
        action="store_true",
        help="Force Space -> Jira updates for differing tasks.",
    )
    mode_group.add_argument(
        "--pull",
        action="store_true",
        help="Force Jira -> Space updates for differing tasks.",
    )
    args = parser.parse_args()
    logging.basicConfig(
        level=logging.DEBUG,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    logging.getLogger("websockets").setLevel(logging.WARNING)
    logging.getLogger("websockets.client").setLevel(logging.WARNING)
    logging.getLogger("websockets.server").setLevel(logging.WARNING)
    force_direction = None
    if args.push:
        force_direction = "push"
    elif args.pull:
        force_direction = "pull"
    asyncio.run(jira_sync_loop(one_shot=args.one_shot, force_direction=force_direction))


if __name__ == "__main__":
    main()
