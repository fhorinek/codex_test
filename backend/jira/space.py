import asyncio
import difflib
import logging
import re
from dataclasses import dataclass
from typing import Any

import y_py as Y
import websockets
from ypy_websocket.websocket_provider import WebsocketProvider

logger = logging.getLogger("jira-worker")

WS_BASE_URL = "ws://localhost:5000/ws"
SERVER_USER = "admin"
SERVER_PASSWORD = "devtoken"

REFERENCE_RE = re.compile(r"\{([^}]+)\}")
STATE_TOKEN_RE = re.compile(r"(^|\s)!([^\s#@]+)")
TAG_TOKEN_RE = re.compile(r"(^|\s)#([^\s#@]+)")
PERSON_TOKEN_RE = re.compile(r"(^|\s)@([^\s#@]+)")
TOKEN_SPLIT_RE = re.compile(r"(\s+)")


def _normalize_list(values):
    return sorted({value.strip() for value in values if value and value.strip()})


def format_token_line(state, tags, people) -> str:
    tokens = []
    if state:
        tokens.append(f"!{state}")
    for tag in _normalize_list(tags or []):
        tokens.append(f"#{tag}")
    for person in _normalize_list(people or []):
        tokens.append(f"@{person}")
    return " ".join(tokens).strip()


def add_tags_to_line(line: str, tags) -> str:
    return _add_tokens_to_line(line, tags, "#", TAG_TOKEN_RE)


def remove_tags_from_line(line: str, tags) -> str:
    return _remove_tokens_from_line(line, tags, TAG_TOKEN_RE)


def add_people_to_line(line: str, people) -> str:
    return _add_tokens_to_line(line, people, "@", PERSON_TOKEN_RE)


def remove_people_from_line(line: str, people) -> str:
    return _remove_tokens_from_line(line, people, PERSON_TOKEN_RE)


def set_state_in_line(line: str, state) -> str:
    if state:
        line = remove_state_from_line(line)
        suffix = f"!{state}"
        return _append_token(line, suffix)
    return remove_state_from_line(line)


def remove_state_from_line(line: str) -> str:
    return _remove_tokens_from_line(line, ["*"], STATE_TOKEN_RE, match_all=True)


def extract_references(text: str):
    refs = []
    for match in REFERENCE_RE.finditer(text or ""):
        ref = match.group(1).strip()
        if ref:
            refs.append(ref)
    return refs


def normalize_reference_to_key(ref: str, title_to_key):
    cleaned = ref.strip()
    if not cleaned:
        return None
    if re.fullmatch(r"[A-Z][A-Z0-9]+-\d+", cleaned, flags=re.IGNORECASE):
        return cleaned.upper()
    return title_to_key.get(cleaned.lower()) if title_to_key else None


def extract_linked_keys(description: str, title_to_key):
    refs = extract_references(description)
    keys = []
    for ref in refs:
        key = normalize_reference_to_key(ref, title_to_key)
        if key:
            keys.append(key)
    return _normalize_list(keys)


def append_missing_references(description: str, refs) -> str:
    if not refs:
        return description
    description = description or ""
    existing = {ref.strip() for ref in extract_references(description)}
    missing = [ref for ref in refs if ref.strip() and ref.strip() not in existing]
    if not missing:
        return description
    lines = description.split("\n") if description else []
    if lines and lines[-1].strip() != "":
        lines.append("")
    for ref in missing:
        lines.append(f"{{{ref.strip()}}}")
    return "\n".join(lines).rstrip()


def apply_linked_references(
    description: str,
    linked_keys,
    key_to_title,
    title_to_key,
) -> str:
    if not description:
        description = ""
    desired_keys = {key.upper() for key in linked_keys}
    seen = set()
    lines = description.split("\n") if description else []
    new_lines = []

    def repl(match: re.Match) -> str:
        ref = match.group(1).strip()
        key = normalize_reference_to_key(ref, title_to_key)
        if key and key.upper() in desired_keys:
            seen.add(key.upper())
            ref_text = key_to_title.get(key.upper(), ref)
            return f"{{{ref_text}}}"
        return ""

    for line in lines:
        updated = REFERENCE_RE.sub(repl, line)
        if updated.strip() != "":
            new_lines.append(updated)
    missing = []
    for key in _normalize_list([key.upper() for key in linked_keys]):
        if key not in seen:
            missing.append(key_to_title.get(key, key))
    appended = append_missing_references("\n".join(new_lines).rstrip(), missing)
    return appended.rstrip()


def add_reference_to_description(description: str, ref: str) -> str:
    return append_missing_references(description, [ref])


def remove_reference_from_description(description: str, ref: str) -> str:
    if not description:
        return ""
    target = ref.strip()
    if not target:
        return description
    refs = {target.lower()}
    lines = []
    for line in description.split("\n"):
        updated = REFERENCE_RE.sub(
            lambda match: ""
            if match.group(1).strip().lower() in refs
            else match.group(0),
            line,
        )
        if updated.strip() != "":
            lines.append(updated)
    return "\n".join(lines).rstrip()


def scrub_body_tokens(
    description: str,
    desired_state,
    desired_tags,
    desired_people,
) -> str:
    if not description:
        return ""
    cleaned_lines = []
    for raw_line in description.split("\n"):
        line = raw_line
        line = _remove_tokens_from_line(
            line,
            desired_tags,
            TAG_TOKEN_RE,
            invert=True,
        )
        line = _remove_tokens_from_line(
            line,
            desired_people,
            PERSON_TOKEN_RE,
            invert=True,
        )
        line = _remove_state_token_from_line(line, desired_state)
        if line.strip() == "":
            continue
        cleaned_lines.append(line.strip())
    return "\n".join(cleaned_lines).rstrip()


def _append_token(line: str, token: str) -> str:
    token = token.strip()
    if not token:
        return line
    if not line or line.endswith(" "):
        return f"{line}{token}".rstrip()
    return f"{line} {token}".rstrip()


def _add_tokens_to_line(line: str, tokens, prefix: str, token_re) -> str:
    tokens = _normalize_list(tokens or [])
    if not tokens:
        return line
    existing = {match.group(2).lower() for match in token_re.finditer(line)}
    missing = [value for value in tokens if value.lower() not in existing]
    for value in missing:
        line = _append_token(line, f"{prefix}{value}")
    return line.rstrip()


def _remove_tokens_from_line(
    line: str,
    tokens,
    token_re,
    invert: bool = False,
    match_all: bool = False,
) -> str:
    if not line:
        return ""
    if match_all:
        targets = set()
    else:
        targets = {value.lower() for value in _normalize_list(tokens or [])}
    parts = TOKEN_SPLIT_RE.split(line)
    kept = []
    for part in parts:
        if not part or part.isspace():
            kept.append(part)
            continue
        match = token_re.fullmatch(part)
        if not match:
            kept.append(part)
            continue
        if match_all:
            continue
        token_value = match.group(2).lower()
        if invert:
            if token_value in targets:
                kept.append(part)
            continue
        if token_value in targets:
            continue
        kept.append(part)
    return "".join(kept).strip()


def _remove_state_token_from_line(line: str, desired_state) -> str:
    if not line:
        return ""
    desired = (desired_state or "").lower()
    parts = TOKEN_SPLIT_RE.split(line)
    kept = []
    for part in parts:
        if not part or part.isspace():
            kept.append(part)
            continue
        match = STATE_TOKEN_RE.fullmatch(part)
        if not match:
            kept.append(part)
            continue
        token_value = match.group(2).lower()
        if desired and token_value == desired:
            kept.append(part)
        continue
    return "".join(kept).strip()


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
    current = ydoc_to_text(ydoc)
    if current == content:
        return
    matcher = difflib.SequenceMatcher(a=current, b=content)
    opcodes = matcher.get_opcodes()

    def apply(txn):
        for tag, i1, i2, j1, j2 in reversed(opcodes):
            if tag == "equal":
                continue
            if tag in ("delete", "replace"):
                if i2 > i1:
                    text.delete_range(txn, i1, i2 - i1)
            if tag in ("insert", "replace"):
                if j2 > j1:
                    text.insert(txn, i1, content[j1:j2])

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
