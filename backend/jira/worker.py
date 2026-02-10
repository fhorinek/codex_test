import asyncio
import logging
import re
import time
from dataclasses import dataclass
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
JIRA_KEY_RE = re.compile(r"\[JIRA:([A-Z][A-Z0-9]+-\d+)\]")

space_task_cache: Dict[str, Dict[str, Any]] = {}
JIRA_ACCOUNT_ID_BY_EMAIL: Dict[str, str] = {}
WS_BASE_URL = "ws://localhost:5000/ws"
SERVER_USER = "user"
SERVER_PASSWORD = "devtoken"

TASK_LINE_RE = re.compile(r"^(\s*)%\s+(.*)$")
TOKEN_LINE_RE = re.compile(r"(^|\s)[#!@]")
STATE_TOKEN_RE = re.compile(r"(^|\s)!([^\s#@]+)")
TAG_TOKEN_RE = re.compile(r"(^|\s)#([^\s#@]+)")
PERSON_TOKEN_RE = re.compile(r"(^|\s)@([^\s#@]+)")


@dataclass
class PersonConfig:
    slug: str
    name: str
    mail: str


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
    match = JIRA_KEY_RE.search(text)
    return match.group(1) if match else None


def strip_jira_key(text: str) -> str:
    return JIRA_KEY_RE.sub("", text).strip()


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


def parse_tasks(lines: List[str]) -> List[ParsedTask]:
    tasks: List[ParsedTask] = []
    for index, line in enumerate(lines):
        match = TASK_LINE_RE.match(line)
        if not match:
            continue
        indent = match.group(1)
        raw_name = match.group(2).strip()
        jira_key = extract_jira_key(raw_name)
        name = strip_jira_key(raw_name)
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
) -> None:
    prefix = f"[Space {space_id}] <- [JIRA {project_key}] {jira_key}"
    logger.info("%s summary=%s", prefix, summary)
    logger.info("%s description=%s", prefix, description)
    logger.info("%s status_name=%s", prefix, status_name or "")
    logger.info("%s next_state=%s", prefix, next_state or "")
    logger.info("%s labels=%s", prefix, ",".join(labels))
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
    client: JiraClient, session: SpaceSession, project_key: str
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
            logger.debug("Received Yjs update without content change for %s", session.space_id)
        session.pending_change = False
    lines = content.split("\n")
    people_config, people_order, people_block = parse_people_config(lines)
    people_config_changed = False

    async def resolve_assignee_id(people: List[str]) -> Optional[str]:
        for person in _normalize_list(people):
            account_id = JIRA_USER_MAP.get(person)
            if account_id:
                return account_id
            config = people_config.get(person)
            if not config:
                continue
            if not config.mail:
                logger.debug(
                    "[Space %s] no mail for @%s in people config",
                    session.space_id,
                    person,
                )
                continue
            account_id = await resolve_account_id(client, config.mail)
            if account_id:
                return account_id
        return None
    tasks = parse_tasks(lines)
    if not tasks:
        logger.debug("No tasks found in space %s", session.space_id)
        return
    logger.debug("Parsed %s tasks from space %s", len(tasks), session.space_id)
    for task in tasks:
        log_parsed_task(session.space_id, task)

    cache = space_task_cache.setdefault(session.space_id, {})
    changed = False

    for task in tasks:
        if task.jira_key:
            continue
        logger.info(
            "[Space %s] -> [JIRA %s] create issue for '%s'",
            session.space_id,
            project_key,
            task.name,
        )
        assignee_id = await resolve_assignee_id(task.people)
        issue_key, status, payload = await asyncio.to_thread(
            client.create_issue,
            project_key,
            task.name,
            task.description,
            task.tags,
            JIRA_ISSUE_TYPE,
            assignee_id,
        )
        logger.info(
            "[Space %s] -> [JIRA %s] create response for '%s': %s",
            session.space_id,
            project_key,
            task.name,
            summarize_jira_response(status, payload),
        )
        if not issue_key:
            logger.warning(
                "[Space %s] -> [JIRA %s] failed to create issue for '%s'",
                session.space_id,
                project_key,
                task.name,
            )
            continue
        logger.info(
            "[Space %s] -> [JIRA %s] created %s for '%s'",
            session.space_id,
            project_key,
            issue_key,
            task.name,
        )
        insert_jira_key(lines, task, issue_key)
        task.jira_key = issue_key
        cache[issue_key] = task_snapshot(task)
        changed = True

    if changed:
        content = "\n".join(lines)
        logger.info("Writing Jira keys back to space %s", session.space_id)
        session.ignore_until = time.time() + 0.2
        replace_ydoc_text(session.ydoc, content)
        await asyncio.sleep(0.1)
        lines = content.split("\n")
        tasks = parse_tasks(lines)

    for task in tasks:
        if not task.jira_key:
            continue
        if not cache:
            logger.debug(
                "[Space %s] -> [JIRA %s] skipping push for %s (cache not initialized)",
                session.space_id,
                project_key,
                task.jira_key,
            )
            continue
        current_snapshot = task_snapshot(task)
        previous_snapshot = cache.get(task.jira_key)
        changes = diff_snapshot(previous_snapshot, current_snapshot)
        if not changes:
            continue
        for field, (old_value, new_value) in changes.items():
            log_field_change(
                "->",
                session.space_id,
                project_key,
                task.jira_key,
                field,
                old_value,
                new_value,
            )
        assignee_id = None
        if "people" in changes:
            assignee_id = await resolve_assignee_id(task.people)
            if not assignee_id:
                logger.info(
                    "[Space %s] -> [JIRA %s] %s assignee not mapped; skipping Jira assignee update",
                    session.space_id,
                    project_key,
                    task.jira_key,
                )
        update_fields = {"name", "description", "tags"}
        should_update_issue = any(field in changes for field in update_fields) or (
            assignee_id is not None and "people" in changes
        )
        if should_update_issue:
            status, payload = await asyncio.to_thread(
                client.update_issue,
                task.jira_key,
                task.name,
                task.description,
                task.tags,
                assignee_id,
            )
            logger.info(
                "[Space %s] -> [JIRA %s] update response for %s: %s",
                session.space_id,
                project_key,
                task.jira_key,
                summarize_jira_response(status, payload),
            )
        if "state" in changes:
            jira_status = map_state_to_jira(task.state, project_key)
            if jira_status:
                logger.info(
                    "[Space %s] -> [JIRA %s] transition %s -> %s",
                    session.space_id,
                    project_key,
                    task.jira_key,
                    jira_status,
                )
                status, payload = await asyncio.to_thread(
                    client.transition_issue, task.jira_key, jira_status
                )
                logger.info(
                    "[Space %s] -> [JIRA %s] transition response for %s: %s",
                    session.space_id,
                    project_key,
                    task.jira_key,
                    summarize_jira_response(status, payload),
                )
        cache[task.jira_key] = current_snapshot

    if cache and time.time() - session.last_change < JIRA_PULL_IDLE_SECONDS:
        logger.debug("Skipping Jira pull for %s (recent edit)", session.space_id)
        return

    pull_changed = False
    tasks_by_index = sorted(tasks, key=lambda t: t.line_index, reverse=True)
    for task in tasks_by_index:
        if not task.jira_key:
            continue
        logger.debug("Fetching Jira issue %s for space %s", task.jira_key, session.space_id)
        issue, status = await asyncio.to_thread(client.get_issue, task.jira_key)
        logger.debug(
            "[Space %s] <- [JIRA %s] fetch response for %s: %s",
            session.space_id,
            project_key,
            task.jira_key,
            summarize_jira_response(status, issue if isinstance(issue, dict) else None),
        )
        if not issue:
            continue
        fields = issue.get("fields", {})
        summary = fields.get("summary") or task.name
        description = from_adf(fields.get("description"))
        status_name = fields.get("status", {}).get("name")
        next_state = map_jira_to_state(status_name)
        if not next_state and status_name:
            next_state = slugify_state(status_name)
        labels = fields.get("labels") or []
        assignee = fields.get("assignee")
        assignee_person = map_assignee_to_person(assignee, people_config)
        log_jira_issue_fields(
            session.space_id,
            project_key,
            task.jira_key,
            summary,
            description,
            status_name,
            next_state,
            labels,
            assignee,
        )
        if assignee and not assignee_person:
            display_name = assignee.get("displayName") or assignee.get("name") or "person"
            slug = ensure_unique_slug(
                slugify_person(display_name),
                list(people_config.keys()),
            )
            mail = assignee.get("emailAddress") or ""
            people_config[slug] = PersonConfig(slug=slug, name=display_name, mail=mail)
            people_order.append(slug)
            people_config_changed = True
            logger.info(
                "[Space %s] <- [JIRA %s] added person config @%s (%s)",
                session.space_id,
                project_key,
                slug,
                display_name,
            )
            assignee_person = slug

        changes: Dict[str, Tuple[Any, Any]] = {}
        if summary != task.name:
            changes["name"] = (task.name, summary)
        if description != task.description:
            changes["description"] = (task.description, description)
        if _normalize_list(labels) != _normalize_list(task.tags):
            changes["tags"] = (task.tags, labels)
        if next_state:
            current_state = (task.state or "").strip().lower()
            next_state_normalized = next_state.strip().lower()
            if next_state_normalized != current_state:
                changes["state"] = (task.state, next_state)
        if assignee_person:
            if _normalize_list(task.people) != _normalize_list([assignee_person]):
                changes["people"] = (task.people, [assignee_person])

        if not changes:
            continue
        for field, (old_value, new_value) in changes.items():
            log_field_change(
                "<-",
                session.space_id,
                project_key,
                task.jira_key,
                field,
                old_value,
                new_value,
            )
        if "name" in changes:
            set_task_name(lines, task, summary)
            pull_changed = True
        if "description" in changes:
            set_task_description(lines, task, description, task.desc_start, task.desc_end)
            pull_changed = True
        if any(field in changes for field in ("state", "tags", "people")):
            next_tags = labels if "tags" in changes else task.tags
            next_people = [assignee_person] if "people" in changes else task.people
            next_state_value = next_state if "state" in changes else task.state
            _, desc_start, desc_end = ensure_task_tokens(
                lines,
                task,
                next_state_value,
                next_tags,
                next_people,
            )
            task.desc_start = desc_start
            task.desc_end = desc_end
            pull_changed = True

    if people_config_changed:
        lines, people_block = apply_people_config(
            lines, people_config, people_order, people_block
        )
        pull_changed = True

    if pull_changed:
        content = "\n".join(lines)
        logger.info("Writing Jira updates to space %s", session.space_id)
        session.ignore_until = time.time() + 0.2
        replace_ydoc_text(session.ydoc, content)
        await asyncio.sleep(0.1)
        tasks = parse_tasks(content.split("\n"))
        cache.clear()
        for task in tasks:
            if task.jira_key:
                cache[task.jira_key] = task_snapshot(task)
    elif not cache:
        for task in tasks:
            if task.jira_key:
                cache[task.jira_key] = task_snapshot(task)


async def jira_sync_loop() -> None:
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
                await ensure_project_state_map(client, project_key)
                logger.debug("Syncing space %s -> project %s", space_id, project_key)
                session = sessions.get(space_id)
                if not session:
                    try:
                        session = await open_space_session(space_id)
                    except TimeoutError:
                        logger.warning("Skipping space %s due to connection timeout", space_id)
                        continue
                    sessions[space_id] = session
                await sync_space_with_jira(client, session, project_key)
        except ConnectionClosed:
            logger.warning("Websocket disconnected; will reconnect")
            for session in sessions.values():
                await session.close()
            sessions.clear()
        except Exception:
            logger.exception("Jira sync loop failed")
        await asyncio.sleep(JIRA_SYNC_INTERVAL)


def main() -> None:
    logging.basicConfig(
        level=logging.DEBUG,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    logging.getLogger("websockets").setLevel(logging.WARNING)
    logging.getLogger("websockets.client").setLevel(logging.WARNING)
    logging.getLogger("websockets.server").setLevel(logging.WARNING)
    asyncio.run(jira_sync_loop())


if __name__ == "__main__":
    main()
