# Module: Jira API client and conversion helpers between task text and Jira document formats.

import base64
import json
import logging
import random
import threading
import time
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import quote
from urllib.request import Request, urlopen
from urllib.error import HTTPError
import re
from urllib.parse import quote as url_quote
from urllib.parse import unquote as url_unquote
import uuid

logger = logging.getLogger("server")

# Stores the LOG_BORDER_WIDTH module constant.
LOG_BORDER_WIDTH = 60
# Stores the JIRA_ESTIMATE_UNSET module constant.
JIRA_ESTIMATE_UNSET = object()
# Stores the JIRA_RATE_LIMIT_MIN_INTERVAL_SECONDS module constant.
JIRA_RATE_LIMIT_MIN_INTERVAL_SECONDS = 0.5
# Stores the JIRA_RATE_LIMIT_MAX_RETRIES module constant.
JIRA_RATE_LIMIT_MAX_RETRIES = 5
# Stores the JIRA_RATE_LIMIT_MAX_BACKOFF_SECONDS module constant.
JIRA_RATE_LIMIT_MAX_BACKOFF_SECONDS = 60.0


class JiraRequestError(RuntimeError):
    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code

# Stores the _BOLD_RE module constant.
_BOLD_RE = re.compile(r"\*\*([^*]+)\*\*")
# Stores the _UNDERLINE_RE module constant.
_UNDERLINE_RE = re.compile(r"__([^_]+)__")
# Stores the _HIGHLIGHT_RE module constant.
_HIGHLIGHT_RE = re.compile(r"==([^=]+)==")
# Stores the _ITALIC_RE module constant.
_ITALIC_RE = re.compile(r"(?<!\*)\*([^*]+)\*(?!\*)")
# Stores the _REFERENCE_RE module constant.
_REFERENCE_RE = re.compile(r"\{([^}]+)\}")
# Stores the _REFERENCE_PREFIX module constant.
_REFERENCE_PREFIX = "https://task.local/"
# Stores the _HIGHLIGHT_COLOR module constant.
_HIGHLIGHT_COLOR = "#FFAB00"
# Stores the _JIRA_KEY_RE module constant.
_JIRA_KEY_RE = re.compile(r"^[A-Z][A-Z0-9]+-\d+$")
_SUBTASK_TYPE_NAMES = {"sub-task", "subtask"}
_MID_TIER_TYPE_PREFERENCE = ["task", "story", "bug", "issue"]
_TOP_TIER_TYPE_PREFERENCE = ["epic"]


# Handles the _parse_inline function logic.
# Input: text: str.
# Output: List[Dict[str, Any]].
def _parse_inline(text: str) -> List[Dict[str, Any]]:
    nodes: List[Dict[str, Any]] = []
    index = 0
    patterns = [
        ("bold", _BOLD_RE),
        ("underline", _UNDERLINE_RE),
        ("highlight", _HIGHLIGHT_RE),
        ("italic", _ITALIC_RE),
        ("reference", _REFERENCE_RE),
    ]
    while index < len(text):
        earliest = None
        earliest_kind = None
        for kind, pattern in patterns:
            match = pattern.search(text, index)
            if not match:
                continue
            if earliest is None or match.start() < earliest.start():
                earliest = match
                earliest_kind = kind
        if not earliest:
            if index < len(text):
                nodes.append({"type": "text", "text": text[index:]})
            break
        if earliest.start() > index:
            nodes.append({"type": "text", "text": text[index:earliest.start()]})
        inner = earliest.group(1)
        if earliest_kind == "reference":
            ref_target = inner.strip()
            nodes.append(
                {
                    "type": "text",
                    "text": ref_target,
                    "marks": [{"type": "underline"}],
                }
            )
        else:
            mark_type = {
                "bold": "strong",
                "italic": "em",
                "underline": "underline",
                "highlight": "textColor",
            }[earliest_kind]
            mark = {"type": mark_type}
            if mark_type == "textColor":
                mark["attrs"] = {"color": _HIGHLIGHT_COLOR}
            nodes.append({"type": "text", "text": inner, "marks": [mark]})
        index = earliest.end()
    return nodes


# Handles the _paragraph function logic.
# Input: text: str.
# Output: Dict[str, Any].
def _paragraph(text: str) -> Dict[str, Any]:
    if text == "":
        return {"type": "paragraph", "content": []}
    return {"type": "paragraph", "content": _parse_inline(text)}


# Handles the _build_list_items function logic.
# Input: values: Iterable[str].
# Output: List[Dict[str, Any]].
def _build_list_items(values: Iterable[str]) -> List[Dict[str, Any]]:
    return [
        {
            "type": "listItem",
            "content": [_paragraph(value)],
        }
        for value in values
    ]


# Handles the _build_task_items function logic.
# Input: values: Iterable[Tuple[bool, str]].
# Output: List[Dict[str, Any]].
def _build_task_items(values: Iterable[Tuple[bool, str]]) -> List[Dict[str, Any]]:
    items = []
    for checked, text in values:
        items.append(
            {
                "type": "taskItem",
                "attrs": {
                    "localId": str(uuid.uuid4()),
                    "state": "DONE" if checked else "TODO",
                },
                "content": [{"type": "text", "text": text}],
            }
        )
    return items


# Handles the to_adf function logic.
# Input: text: str.
# Output: Dict[str, Any].
def to_adf(text: str) -> Dict[str, Any]:
    lines = text.split("\n")
    content: List[Dict[str, Any]] = []
    list_mode: Optional[str] = None
    list_items: List[Any] = []
    checkbox_re = re.compile(r"^\[([ xX])\](?:\s+(.*))?$")
    bullet_re = re.compile(r"^[-*]\s+(.*)$")

    # Handles the flush_list function logic.
    # Input: none.
    # Output: None.
    def flush_list() -> None:
        nonlocal list_mode, list_items
        if not list_mode:
            return
        if list_mode == "bullet":
            content.append({"type": "bulletList", "content": _build_list_items(list_items)})
        elif list_mode == "task":
            content.append(
                {
                    "type": "taskList",
                    "attrs": {"localId": str(uuid.uuid4())},
                    "content": _build_task_items(list_items),
                }
            )
        list_mode = None
        list_items = []

    for raw in lines:
        stripped = raw.lstrip()
        checkbox_match = checkbox_re.match(stripped)
        bullet_match = bullet_re.match(stripped) if not checkbox_match else None
        if checkbox_match:
            checked = checkbox_match.group(1).lower() == "x"
            item_text = checkbox_match.group(2) or ""
            if list_mode != "task":
                flush_list()
                list_mode = "task"
            list_items.append((checked, item_text))
            continue
        if bullet_match:
            item_text = bullet_match.group(1)
            if list_mode != "bullet":
                flush_list()
                list_mode = "bullet"
            list_items.append(item_text)
            continue
        flush_list()
        if raw == "":
            continue
        content.append(_paragraph(raw))

    flush_list()
    return {"type": "doc", "version": 1, "content": content}


# Handles the _collect_text function logic.
# Input: node: Any.
# Output: str.
def _collect_text(node: Any) -> str:
    if not isinstance(node, dict):
        return ""
    node_type = node.get("type")
    if node_type == "text":
        text = node.get("text", "")
        marks = node.get("marks") or []
        return _apply_marks(text, marks)
    if node_type == "hardBreak":
        return "\n"
    if node_type == "mention":
        return node.get("attrs", {}).get("text", "")
    content = node.get("content")
    if isinstance(content, list):
        return "".join(_collect_text(child) for child in content)
    return ""


# Handles the _apply_marks function logic.
# Input: text: str, marks: List[Dict[str, Any]].
# Output: str.
def _apply_marks(text: str, marks: List[Dict[str, Any]]) -> str:
    if not marks:
        return text
    attrs_by_type = {mark.get("type"): mark.get("attrs", {}) for mark in marks}
    link_attrs = attrs_by_type.get("link")
    if link_attrs and isinstance(link_attrs, dict):
        href = link_attrs.get("href", "")
        if isinstance(href, str) and href.startswith(_REFERENCE_PREFIX):
            ref = url_unquote(href[len(_REFERENCE_PREFIX):])
            return f"{{{ref}}}"
        if href:
            return f"[{text}]({href})"
    if "backgroundColor" in attrs_by_type:
        text = f"=={text}=="
    text_color = attrs_by_type.get("textColor")
    if isinstance(text_color, dict) and text_color.get("color") == _HIGHLIGHT_COLOR:
        text = f"=={text}=="
    if "underline" in attrs_by_type:
        text = f"__{text}__"
    if "em" in attrs_by_type:
        text = f"*{text}*"
    if "strong" in attrs_by_type:
        text = f"**{text}**"
    return text


# Handles the _collect_references function logic.
# Input: node: Any, refs: List[str].
# Output: None.
def _collect_references(node: Any, refs: List[str]) -> None:
    if not isinstance(node, dict):
        return
    node_type = node.get("type")
    if node_type == "text":
        for mark in node.get("marks") or []:
            if not isinstance(mark, dict):
                continue
            if mark.get("type") != "link":
                continue
            attrs = mark.get("attrs") or {}
            href = attrs.get("href") if isinstance(attrs, dict) else None
            if isinstance(href, str) and href.startswith(_REFERENCE_PREFIX):
                refs.append(url_unquote(href[len(_REFERENCE_PREFIX):]))
        return
    for child in node.get("content", []) or []:
        _collect_references(child, refs)


# Handles the extract_references_from_adf function logic.
# Input: doc: Any.
# Output: List[str].
def extract_references_from_adf(doc: Any) -> List[str]:
    if not isinstance(doc, dict):
        return []
    refs: List[str] = []
    _collect_references(doc, refs)
    seen = set()
    unique = []
    for ref in refs:
        if ref in seen:
            continue
        seen.add(ref)
        unique.append(ref)
    return unique


# Handles the _extract_list_item_text function logic.
# Input: item: Dict[str, Any].
# Output: str.
def _extract_list_item_text(item: Dict[str, Any]) -> str:
    parts: List[str] = []
    for child in item.get("content", []) or []:
        child_type = child.get("type") if isinstance(child, dict) else None
        if child_type == "paragraph":
            parts.append(_collect_text(child))
        elif isinstance(child, dict) and child.get("content"):
            nested_lines = _collect_lines(child)
            if nested_lines:
                parts.append(" ".join(nested_lines))
    text = " ".join(part for part in parts if part).strip()
    if not text:
        text = _collect_text(item).strip()
    return text


# Handles the _collect_lines function logic.
# Input: node: Any.
# Output: List[str].
def _collect_lines(node: Any) -> List[str]:
    if not isinstance(node, dict):
        return []
    node_type = node.get("type")
    if node_type == "doc":
        lines: List[str] = []
        for child in node.get("content", []) or []:
            lines.extend(_collect_lines(child))
        return lines
    if node_type == "paragraph":
        return [_collect_text(node)]
    if node_type == "bulletList":
        lines = []
        for item in node.get("content", []) or []:
            if isinstance(item, dict):
                text = _extract_list_item_text(item)
                lines.append(f"- {text}".rstrip())
        return lines
    if node_type == "taskList":
        lines = []
        for item in node.get("content", []) or []:
            if isinstance(item, dict):
                state = item.get("attrs", {}).get("state", "TODO")
                checked = state.upper() == "DONE"
                text = _extract_list_item_text(item)
                prefix = "[x]" if checked else "[ ]"
                lines.append(f"{prefix} {text}".rstrip())
        return lines
    if isinstance(node.get("content"), list):
        lines: List[str] = []
        for child in node.get("content", []) or []:
            lines.extend(_collect_lines(child))
        return lines
    return []


# Handles the from_adf function logic.
# Input: doc: Any.
# Output: str.
def from_adf(doc: Any) -> str:
    if isinstance(doc, str):
        return doc
    if not isinstance(doc, dict):
        return ""
    lines = _collect_lines(doc)
    return "\n".join(lines).strip()


# Handles the _issue_type_preference function logic.
# Input: issue_type: Dict[str, Any].
# Output: Tuple[int, str].
def _issue_type_preference(issue_type: Dict[str, Any]) -> Tuple[int, str]:
    name = str(issue_type.get("name") or "").strip()
    level = int(issue_type.get("hierarchy_level", 0))
    is_subtask = bool(issue_type.get("is_subtask"))
    lowered = name.lower()
    if is_subtask or level < 0:
        if lowered in _SUBTASK_TYPE_NAMES:
            return (0, lowered)
        return (10, lowered)
    if level > 0:
        if lowered in _TOP_TIER_TYPE_PREFERENCE:
            return (0, lowered)
        return (10, lowered)
    if lowered in _MID_TIER_TYPE_PREFERENCE:
        return (_MID_TIER_TYPE_PREFERENCE.index(lowered), lowered)
    return (10, lowered)


# Handles the normalize_project_issue_types function logic.
# Input: raw_issue_types: Any.
# Output: List[Dict[str, Any]].
def normalize_project_issue_types(raw_issue_types: Any) -> List[Dict[str, Any]]:
    if not isinstance(raw_issue_types, list):
        return []
    normalized: List[Dict[str, Any]] = []
    seen = set()
    for entry in raw_issue_types:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        if not isinstance(name, str) or not name.strip():
            continue
        raw_level = entry.get("hierarchyLevel")
        if isinstance(raw_level, bool):
            raw_level = 0
        level: int
        if isinstance(raw_level, (int, float)):
            level = int(raw_level)
        elif entry.get("subtask") is True:
            level = -1
        else:
            level = 0
        is_subtask = bool(entry.get("subtask") is True or level < 0)
        normalized_name = name.strip()
        key = (normalized_name.lower(), level, is_subtask)
        if key in seen:
            continue
        seen.add(key)
        issue_id = entry.get("id")
        normalized.append(
            {
                "id": str(issue_id) if issue_id is not None else None,
                "name": normalized_name,
                "hierarchy_level": level,
                "is_subtask": is_subtask,
            }
        )
    normalized.sort(
        key=lambda item: (
            -int(item.get("hierarchy_level", 0)),
            1 if item.get("is_subtask") else 0,
            str(item.get("name", "")).lower(),
        )
    )
    return normalized


# Handles the build_issue_type_hierarchy_levels function logic.
# Input: issue_types: List[Dict[str, Any]].
# Output: List[Dict[str, Any]].
def build_issue_type_hierarchy_levels(
    issue_types: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    if not issue_types:
        return []
    by_level: Dict[int, List[Dict[str, Any]]] = {}
    for item in issue_types:
        level = int(item.get("hierarchy_level", 0))
        by_level.setdefault(level, []).append(item)
    levels: List[Dict[str, Any]] = []
    for depth, hierarchy_level in enumerate(sorted(by_level.keys(), reverse=True)):
        candidates = sorted(by_level[hierarchy_level], key=_issue_type_preference)
        chosen = candidates[0]
        levels.append(
            {
                "depth": depth,
                "hierarchy_level": hierarchy_level,
                "issue_type": chosen.get("name"),
                "is_subtask": bool(chosen.get("is_subtask")),
                "issue_types": [entry.get("name") for entry in candidates if entry.get("name")],
            }
        )
    return levels


# Defines the JiraClient structure used by this module.
class JiraClient:
    _rate_lock = threading.Lock()
    _next_request_at = 0.0
    _dynamic_delay_seconds = JIRA_RATE_LIMIT_MIN_INTERVAL_SECONDS

    # Handles the __init__ function logic.
    # Input: self, base_url: str, email: str, token: str.
    # Output: None.
    def __init__(self, base_url: str, email: str, token: str) -> None:
        self.base_url = base_url.rstrip("/")
        auth = base64.b64encode(f"{email}:{token}".encode("utf-8")).decode("ascii")
        self.headers = {
            "Authorization": f"Basic {auth}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        }

    # Handles the _normalize_issue_type_name function logic.
    # Input: issue_type: str.
    # Output: str.
    def _normalize_issue_type_name(self, issue_type: str) -> str:
        return re.sub(r"[^a-z0-9]+", "", (issue_type or "").strip().lower())

    # Handles the _resolve_project_issue_type_id function logic.
    # Input: project_key: str, issue_type: str.
    # Output: Optional[str].
    def _resolve_project_issue_type_id(
        self, project_key: str, issue_type: str
    ) -> Optional[str]:
        normalized_target = self._normalize_issue_type_name(issue_type)
        if not normalized_target:
            return None
        issue_types, _ = self.get_project_issue_type_hierarchy(project_key)
        if not isinstance(issue_types, list):
            return None
        for entry in issue_types:
            if not isinstance(entry, dict):
                continue
            issue_type_id = entry.get("id")
            if issue_type_id is None:
                continue
            entry_name = entry.get("name")
            if not isinstance(entry_name, str) or not entry_name.strip():
                continue
            if self._normalize_issue_type_name(entry_name) == normalized_target:
                return str(issue_type_id).strip() or None
        if normalized_target == "subtask":
            for entry in issue_types:
                if not isinstance(entry, dict) or not bool(entry.get("is_subtask")):
                    continue
                issue_type_id = entry.get("id")
                if issue_type_id is None:
                    continue
                return str(issue_type_id).strip() or None
        return None

    # Handles the _fetch_project_status_entries function logic.
    # Input: self, project_key: str.
    # Output: Optional[List[Dict[str, str]]].
    def _fetch_project_status_entries(
        self,
        project_key: str,
    ) -> Optional[List[Dict[str, str]]]:
        if not project_key:
            return None
        try:
            data, _ = self._request(
                "GET", f"/rest/api/3/project/{project_key}/statuses"
            )
        except Exception:
            logger.exception(
                "Failed to fetch Jira statuses for project %s",
                project_key,
            )
            return None
        if not isinstance(data, list):
            return None
        entries: List[Dict[str, str]] = []
        seen = set()
        for issue_type in data:
            if not isinstance(issue_type, dict):
                continue
            raw_issue_type_id = issue_type.get("id")
            issue_type_id = (
                str(raw_issue_type_id).strip()
                if raw_issue_type_id is not None
                else ""
            )
            raw_issue_type_name = issue_type.get("name")
            issue_type_name = (
                raw_issue_type_name.strip()
                if isinstance(raw_issue_type_name, str)
                else ""
            )
            for status_entry in issue_type.get("statuses", []) or []:
                if not isinstance(status_entry, dict):
                    continue
                raw_status_id = status_entry.get("id")
                raw_status_name = status_entry.get("name")
                if raw_status_id is None or not isinstance(raw_status_name, str):
                    continue
                status_id = str(raw_status_id).strip()
                status_name = raw_status_name.strip()
                if not status_id or not status_name:
                    continue
                key = (issue_type_id, status_id, status_name.lower())
                if key in seen:
                    continue
                seen.add(key)
                entries.append(
                    {
                        "issue_type_id": issue_type_id,
                        "issue_type_name": issue_type_name,
                        "status_id": status_id,
                        "status_name": status_name,
                    }
                )
        return entries

    # Handles the _resolve_status_id_from_entries function logic.
    # Input: self, entries: List[Dict[str, str]], status_name: str, issue_type_id: Optional[str] = None.
    # Output: Optional[str].
    def _resolve_status_id_from_entries(
        self,
        entries: List[Dict[str, str]],
        status_name: str,
        issue_type_id: Optional[str] = None,
    ) -> Optional[str]:
        normalized_target = (status_name or "").strip().lower()
        if not normalized_target:
            return None
        fallback = None
        normalized_issue_type_id = str(issue_type_id or "").strip()
        for entry in entries:
            if entry.get("status_name", "").strip().lower() != normalized_target:
                continue
            status_id = entry.get("status_id", "").strip()
            if not status_id:
                continue
            if normalized_issue_type_id and entry.get("issue_type_id") == normalized_issue_type_id:
                return status_id
            if fallback is None:
                fallback = status_id
        return fallback

    # Handles the _resolve_project_status_id function logic.
    # Input: self, project_key: str, status_name: str, issue_type_id: Optional[str] = None.
    # Output: Optional[str].
    def _resolve_project_status_id(
        self,
        project_key: str,
        status_name: str,
        issue_type_id: Optional[str] = None,
    ) -> Optional[str]:
        entries = self._fetch_project_status_entries(project_key)
        if entries is None:
            return None
        return self._resolve_status_id_from_entries(entries, status_name, issue_type_id)

    # Handles the _extract_issue_move_context function logic.
    # Input: issue: Any.
    # Output: Optional[Dict[str, str]].
    def _extract_issue_move_context(self, issue: Any) -> Optional[Dict[str, str]]:
        if not isinstance(issue, dict):
            return None
        fields = issue.get("fields")
        if not isinstance(fields, dict):
            return None
        project = fields.get("project")
        issue_type = fields.get("issuetype")
        status = fields.get("status")
        if not isinstance(project, dict) or not isinstance(issue_type, dict) or not isinstance(status, dict):
            return None
        project_key = str(project.get("key") or "").strip().upper()
        issue_type_id = str(issue_type.get("id") or "").strip()
        status_id = str(status.get("id") or "").strip()
        if not project_key or not issue_type_id or not status_id:
            return None
        context = {
            "project_key": project_key,
            "issue_type_id": issue_type_id,
            "status_id": status_id,
        }
        parent = fields.get("parent")
        if isinstance(parent, dict):
            parent_key = str(parent.get("key") or "").strip().upper()
            if parent_key:
                context["parent_key"] = parent_key
        return context

    # Handles the _summarize_payload function logic.
    # Input: self, payload: Optional[Dict[str, Any]].
    # Output: str.
    def _summarize_payload(self, payload: Optional[Dict[str, Any]]) -> str:
        if payload is None:
            return "(none)"
        try:
            rendered = json.dumps(payload, ensure_ascii=True)
        except Exception:
            rendered = str(payload)
        if len(rendered) > 2000:
            rendered = rendered[:1997] + "..."
        return rendered

    # Handles the _format_payload function logic.
    # Input: self, payload: Any.
    # Output: str.
    def _format_payload(self, payload: Any) -> str:
        if payload is None:
            return "(none)"
        if isinstance(payload, str):
            return payload
        try:
            return json.dumps(payload, ensure_ascii=False, indent=2)
        except Exception:
            return str(payload)

    # Handles the _format_block function logic.
    # Input: self, title: str, body: str.
    # Output: str.
    def _format_block(self, title: str, body: str) -> str:
        prefix = f"=== {title} "
        width = max(LOG_BORDER_WIDTH, len(prefix) + 1)
        line = prefix + ("=" * (width - len(prefix)))
        border = "=" * len(line)
        return f"{line}\n{body}\n{border}"

    # Handles the _request function logic.
    # Input: self, method: str, path: str, payload: Optional[Dict[str, Any]] = None.
    # Output: Tuple[Any, int].
    def _wait_for_rate_limit_slot(self) -> None:
        with JiraClient._rate_lock:
            now = time.monotonic()
            wait_seconds = max(0.0, JiraClient._next_request_at - now)
            if wait_seconds > 0:
                time.sleep(wait_seconds)
                now = time.monotonic()
            JiraClient._next_request_at = now + max(
                JIRA_RATE_LIMIT_MIN_INTERVAL_SECONDS,
                JiraClient._dynamic_delay_seconds,
            )

    def _apply_near_limit_slowdown(self, headers: Any) -> None:
        near_limit = ""
        try:
            near_limit = str(headers.get("X-RateLimit-NearLimit") or "").lower()
        except Exception:
            near_limit = ""
        with JiraClient._rate_lock:
            if near_limit == "true":
                JiraClient._dynamic_delay_seconds = min(
                    JIRA_RATE_LIMIT_MAX_BACKOFF_SECONDS,
                    max(JiraClient._dynamic_delay_seconds * 2.0, 2.0),
                )
            else:
                JiraClient._dynamic_delay_seconds = max(
                    JIRA_RATE_LIMIT_MIN_INTERVAL_SECONDS,
                    JiraClient._dynamic_delay_seconds * 0.9,
                )

    def _parse_retry_after_seconds(self, headers: Any) -> Optional[float]:
        try:
            raw_value = headers.get("Retry-After")
        except Exception:
            raw_value = None
        if raw_value is None:
            return None
        try:
            value = float(str(raw_value).strip())
        except Exception:
            return None
        if not value or value < 0:
            return None
        return min(value, JIRA_RATE_LIMIT_MAX_BACKOFF_SECONDS)

    def _request_once(
        self, method: str, path: str, payload: Optional[Dict[str, Any]] = None
    ) -> Tuple[Any, int]:
        url = f"{self.base_url}{path}"
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = Request(url, data=data, headers=self.headers, method=method)
        self._wait_for_rate_limit_slot()
        with urlopen(request, timeout=20) as response:
            status = response.getcode()
            raw = response.read().decode("utf-8")
            self._apply_near_limit_slowdown(response.headers)
        if not raw:
            return None, status
        return json.loads(raw), status

    def _request(
        self, method: str, path: str, payload: Optional[Dict[str, Any]] = None
    ) -> Tuple[Any, int]:
        url = f"{self.base_url}{path}"
        attempt = 0
        last_rate_limit_error: Optional[HTTPError] = None
        while attempt <= JIRA_RATE_LIMIT_MAX_RETRIES:
            try:
                return self._request_once(method, path, payload)
            except HTTPError as exc:
                if exc.code == 429:
                    last_rate_limit_error = exc
                    retry_after = self._parse_retry_after_seconds(exc.headers)
                    backoff = retry_after if retry_after is not None else min(
                        JIRA_RATE_LIMIT_MAX_BACKOFF_SECONDS,
                        (2.0 ** attempt) + random.uniform(0.0, 1.0),
                    )
                    with JiraClient._rate_lock:
                        JiraClient._dynamic_delay_seconds = min(
                            JIRA_RATE_LIMIT_MAX_BACKOFF_SECONDS,
                            max(JiraClient._dynamic_delay_seconds * 2.0, backoff),
                        )
                    logger.warning(
                        "Jira API rate limited %s %s; retrying in %.1fs",
                        method,
                        path,
                        backoff,
                    )
                    time.sleep(backoff)
                    attempt += 1
                    continue
                try:
                    error_body = exc.read().decode("utf-8")
                except Exception:
                    error_body = ""
                preview = error_body
                if len(preview) > 2000:
                    preview = preview[:1997] + "..."
                logger.error(
                    "Jira API error %s %s -> %s: %s",
                    method,
                    path,
                    exc.code,
                    preview,
                )
                logger.error(
                    "Jira API request failed: method=%s url=%s payload=%s",
                    method,
                    url,
                    self._summarize_payload(payload),
                )
                error_payload: Any = None
                if error_body:
                    try:
                        error_payload = json.loads(error_body)
                    except Exception:
                        error_payload = error_body
                logger.error(
                    "%s",
                    self._format_block(
                        "calling JIRA API",
                        "\n".join(
                            [
                                f"{method} {url}",
                                self._format_payload(payload),
                                f"RESPONSE {exc.code} - ERROR",
                                self._format_payload(error_payload),
                            ]
                        ),
                    ),
                )
                raise JiraRequestError(
                    exc.code, f"Jira API error {exc.code}: {preview}"
                ) from exc
        if last_rate_limit_error is not None:
            raise RuntimeError(
                f"Jira API rate limited after {JIRA_RATE_LIMIT_MAX_RETRIES} retries"
            ) from last_rate_limit_error
        raise RuntimeError(f"Jira API request failed: {method} {url}")

    # Handles the get_issue function logic.
    # Input: self, key: str.
    # Output: Tuple[Optional[Dict[str, Any]], Optional[int]].
    def get_issue(self, key: str) -> Tuple[Optional[Dict[str, Any]], Optional[int]]:
        try:
            data, status = self._request(
                "GET",
                f"/rest/api/3/issue/{key}?fields=summary,description,status,labels,assignee,issuetype,issuelinks,subtasks,parent,project,timetracking,timeoriginalestimate",
            )
            return data, status
        except JiraRequestError as exc:
            logger.exception("Failed to fetch Jira issue %s", key)
            return None, exc.status_code
        except Exception:
            logger.exception("Failed to fetch Jira issue %s", key)
            return None, None

    # Handles the search_updated_issue_keys function logic.
    # Input: self, project_keys: Iterable[str], updated_since: str, max_results: int = 100.
    # Output: Tuple[Optional[List[str]], Optional[int]].
    def search_updated_issue_keys(
        self,
        project_keys: Iterable[str],
        updated_since: str,
        max_results: int = 100,
    ) -> Tuple[Optional[List[str]], Optional[int]]:
        normalized_projects = sorted({
            str(project).strip().upper()
            for project in project_keys
            if str(project).strip()
        })
        if not normalized_projects:
            return [], 200
        safe_max = max(1, min(int(max_results or 100), 100))
        project_clause = ", ".join(normalized_projects)
        jql = (
            f"project in ({project_clause}) "
            f"AND updated >= \"{updated_since}\" "
            "ORDER BY updated ASC"
        )
        next_page_token: Optional[str] = None
        keys: List[str] = []
        last_status: Optional[int] = None
        try:
            while True:
                payload: Dict[str, Any] = {
                    "jql": jql,
                    "fields": ["key", "updated"],
                    "maxResults": safe_max,
                }
                if next_page_token:
                    payload["nextPageToken"] = next_page_token
                data, status = self._request(
                    "POST",
                    "/rest/api/3/search/jql",
                    payload,
                )
                last_status = status
                if not isinstance(data, dict):
                    return None, status
                issues = data.get("issues")
                if not isinstance(issues, list):
                    return None, status
                for issue in issues:
                    if not isinstance(issue, dict):
                        continue
                    key = issue.get("key")
                    if isinstance(key, str) and key.strip():
                        keys.append(key.strip().upper())
                raw_next_page_token = data.get("nextPageToken")
                if isinstance(raw_next_page_token, str) and raw_next_page_token.strip():
                    next_page_token = raw_next_page_token.strip()
                    continue
                total = data.get("total")
                fetched = len(issues)
                if not fetched:
                    break
                if not isinstance(total, int):
                    break
            return sorted(set(keys)), last_status
        except Exception:
            logger.exception("Failed to search Jira updated issues for %s", jql)
            return None, last_status

    # Handles the get_issue_editmeta function logic.
    # Input: self, key: str.
    # Output: Tuple[Optional[Dict[str, Any]], Optional[int]].
    def get_issue_editmeta(
        self, key: str
    ) -> Tuple[Optional[Dict[str, Any]], Optional[int]]:
        try:
            data, status = self._request(
                "GET",
                f"/rest/api/3/issue/{key}/editmeta",
            )
            if isinstance(data, dict):
                return data, status
            return None, status
        except Exception:
            logger.exception("Failed to fetch Jira editmeta for %s", key)
            return None, None

    # Handles the get_bulk_operation_progress function logic.
    # Input: self, task_id: str.
    # Output: Tuple[Optional[Dict[str, Any]], Optional[int]].
    def get_bulk_operation_progress(
        self, task_id: str
    ) -> Tuple[Optional[Dict[str, Any]], Optional[int]]:
        normalized_task_id = quote((task_id or "").strip())
        try:
            data, status = self._request(
                "GET",
                f"/rest/api/3/bulk/queue/{normalized_task_id}",
            )
            if isinstance(data, dict):
                return data, status
            return None, status
        except Exception:
            logger.exception(
                "Failed to fetch Jira bulk operation progress for task %s", task_id
            )
            return None, None

    # Handles the create_issue function logic.
    # Input: self, project_key: str, summary: str, description: str, labels: Optional[List[str]] = None, issue_type: str = "Task", parent_key: Optional[str] = None, assignee_id: Optional[str] = None, original_estimate_minutes: Any = JIRA_ESTIMATE_UNSET,.
    # Output: Tuple[Optional[str], Optional[int], Optional[Dict[str, Any]]].
    def create_issue(
        self,
        project_key: str,
        summary: str,
        description: str,
        labels: Optional[List[str]] = None,
        issue_type: str = "Task",
        parent_key: Optional[str] = None,
        assignee_id: Optional[str] = None,
        original_estimate_minutes: Any = JIRA_ESTIMATE_UNSET,
    ) -> Tuple[Optional[str], Optional[int], Optional[Dict[str, Any]]]:
        payload = {
            "fields": {
                "project": {"key": project_key},
                "summary": summary,
                "description": to_adf(description),
                "issuetype": {"name": issue_type},
                "labels": labels or [],
            }
        }
        if parent_key:
            payload["fields"]["parent"] = {"key": parent_key}
        if assignee_id:
            payload["fields"]["assignee"] = {"accountId": assignee_id}
        if original_estimate_minutes is not JIRA_ESTIMATE_UNSET:
            if original_estimate_minutes is None:
                payload["fields"]["timetracking"] = {"originalEstimate": None}
            else:
                payload["fields"]["timetracking"] = {
                    "originalEstimate": f"{max(0, int(original_estimate_minutes))}m"
                }
        try:
            result, status = self._request("POST", "/rest/api/3/issue", payload)
            logger.info(
                "%s",
                self._format_block(
                    "calling JIRA API",
                    "\n".join(
                        [
                            f"POST {self.base_url}/rest/api/3/issue",
                            self._format_payload(payload),
                            f"RESPONSE {status} - OK",
                            self._format_payload(result),
                        ]
                    ),
                ),
            )
            key = result.get("key") if isinstance(result, dict) else None
            return key, status, result if isinstance(result, dict) else None
        except Exception:
            logger.exception("Failed to create Jira issue in %s", project_key)
            return None, None, None

    # Handles the update_issue function logic.
    # Input: self, key: str, summary: Optional[str] = None, description: Optional[str] = None, labels: Optional[List[str]] = None, assignee_id: Optional[str] = None, clear_assignee: bool = False, original_estimate_minutes: Any = JIRA_ESTIMATE_UNSET,.
    # Output: Tuple[Optional[int], Optional[Dict[str, Any]]].
    def update_issue(
        self,
        key: str,
        summary: Optional[str] = None,
        description: Optional[str] = None,
        labels: Optional[List[str]] = None,
        assignee_id: Optional[str] = None,
        clear_assignee: bool = False,
        original_estimate_minutes: Any = JIRA_ESTIMATE_UNSET,
    ) -> Tuple[Optional[int], Optional[Dict[str, Any]]]:
        payload = {"fields": {}}
        if summary is not None:
            payload["fields"]["summary"] = summary
        if description is not None:
            payload["fields"]["description"] = to_adf(description)
        if labels is not None:
            payload["fields"]["labels"] = labels
        if clear_assignee:
            payload["fields"]["assignee"] = None
        elif assignee_id:
            payload["fields"]["assignee"] = {"accountId": assignee_id}
        if original_estimate_minutes is not JIRA_ESTIMATE_UNSET:
            if original_estimate_minutes is None:
                payload["fields"]["timetracking"] = {"originalEstimate": None}
            else:
                payload["fields"]["timetracking"] = {
                    "originalEstimate": f"{max(0, int(original_estimate_minutes))}m"
                }
        try:
            result, status = self._request("PUT", f"/rest/api/3/issue/{key}", payload)
            logger.info(
                "%s",
                self._format_block(
                    "calling JIRA API",
                    "\n".join(
                        [
                            f"PUT {self.base_url}/rest/api/3/issue/{key}",
                            self._format_payload(payload),
                            f"RESPONSE {status} - OK",
                            self._format_payload(result),
                        ]
                    ),
                ),
            )
            return status, result if isinstance(result, dict) else None
        except Exception:
            logger.exception("Failed to update Jira issue %s", key)
            return None, None

    # Handles the update_issue_type function logic.
    # Input: self, key: str, issue_type: str, parent_key: Optional[str] = None, clear_parent: bool = False.
    # Output: Tuple[Optional[int], Optional[Dict[str, Any]]].
    def update_issue_type(
        self,
        key: str,
        issue_type: str,
        parent_key: Optional[str] = None,
        clear_parent: bool = False,
    ) -> Tuple[Optional[int], Optional[Dict[str, Any]]]:
        if parent_key and not clear_parent:
            issue_project_key = key.split("-", 1)[0].strip().upper() if "-" in key else ""
            issue_type_id = (
                self._resolve_project_issue_type_id(issue_project_key, issue_type)
                if issue_project_key
                else None
            )
            if issue_project_key and issue_type_id:
                mapping_key = f"{issue_project_key},{issue_type_id},{parent_key}"
                payload = {
                    "sendBulkNotification": False,
                    "targetToSourcesMapping": {
                        mapping_key: {
                            "issueIdsOrKeys": [key],
                            "inferClassificationDefaults": True,
                            "inferFieldDefaults": True,
                            "inferStatusDefaults": True,
                            "inferSubtaskTypeDefault": True,
                            "targetMandatoryFields": [],
                        }
                    },
                }
                try:
                    result, status = self._request(
                        "POST",
                        "/rest/api/3/bulk/issues/move",
                        payload,
                    )
                    logger.info(
                        "%s",
                        self._format_block(
                            "calling JIRA API",
                            "\n".join(
                                [
                                    f"POST {self.base_url}/rest/api/3/bulk/issues/move",
                                    self._format_payload(payload),
                                    f"RESPONSE {status} - OK",
                                    self._format_payload(result),
                                ]
                            ),
                        ),
                    )
                    return status, result if isinstance(result, dict) else None
                except Exception:
                    logger.exception(
                        "Failed to bulk move Jira issue %s with type %s under parent %s",
                        key,
                        issue_type,
                        parent_key,
                    )
                    return None, None
            logger.info(
                "Bulk move context missing for %s type update (project=%s, issue_type=%s, issue_type_id=%s); using PUT fallback",
                key,
                issue_project_key,
                issue_type,
                issue_type_id or "",
            )
        payload: Dict[str, Any] = {
            "fields": {
                "issuetype": {"name": issue_type},
            }
        }
        if clear_parent:
            payload["fields"]["parent"] = None
        elif parent_key:
            payload["fields"]["parent"] = {"key": parent_key}
        try:
            result, status = self._request("PUT", f"/rest/api/3/issue/{key}", payload)
            logger.info(
                "%s",
                self._format_block(
                    "calling JIRA API",
                    "\n".join(
                        [
                            f"PUT {self.base_url}/rest/api/3/issue/{key}",
                            self._format_payload(payload),
                            f"RESPONSE {status} - OK",
                            self._format_payload(result),
                        ]
                    ),
                ),
            )
            return status, result if isinstance(result, dict) else None
        except Exception:
            logger.exception("Failed to update Jira issue type %s to %s", key, issue_type)
            return None, None

    # Handles the update_issue_parent function logic.
    # Input: self, key: str, parent_key: Optional[str] = None, clear_parent: bool = False, issue_project_key: Optional[str] = None, issue_type_id: Optional[str] = None.
    # Output: Tuple[Optional[int], Optional[Dict[str, Any]]].
    def update_issue_parent(
        self,
        key: str,
        parent_key: Optional[str] = None,
        clear_parent: bool = False,
        issue_project_key: Optional[str] = None,
        issue_type_id: Optional[str] = None,
    ) -> Tuple[Optional[int], Optional[Dict[str, Any]]]:
        if parent_key and not clear_parent and issue_project_key and issue_type_id:
            mapping_key = f"{issue_project_key},{issue_type_id},{parent_key}"
            payload = {
                "sendBulkNotification": False,
                "targetToSourcesMapping": {
                    mapping_key: {
                        "issueIdsOrKeys": [key],
                        "inferClassificationDefaults": True,
                        "inferFieldDefaults": True,
                        "inferStatusDefaults": True,
                        "inferSubtaskTypeDefault": True,
                        "targetMandatoryFields": [],
                    }
                },
            }
            try:
                result, status = self._request(
                    "POST",
                    "/rest/api/3/bulk/issues/move",
                    payload,
                )
                logger.info(
                    "%s",
                    self._format_block(
                        "calling JIRA API",
                        "\n".join(
                            [
                                f"POST {self.base_url}/rest/api/3/bulk/issues/move",
                                self._format_payload(payload),
                                f"RESPONSE {status} - OK",
                                self._format_payload(result),
                            ]
                        ),
                    ),
                )
                return status, result if isinstance(result, dict) else None
            except Exception:
                logger.exception(
                    "Failed to bulk move Jira issue %s under parent %s",
                    key,
                    parent_key,
                )
                return None, None
        if parent_key and not clear_parent and (not issue_project_key or not issue_type_id):
            logger.info(
                "Bulk move context missing for %s (project=%s, issue_type_id=%s); using PUT parent update fallback",
                key,
                issue_project_key or "",
                issue_type_id or "",
            )
        payload = {"fields": {}}
        if clear_parent:
            payload["fields"]["parent"] = None
        elif parent_key:
            payload["fields"]["parent"] = {"key": parent_key}
        try:
            result, status = self._request("PUT", f"/rest/api/3/issue/{key}", payload)
            logger.info(
                "%s",
                self._format_block(
                    "calling JIRA API",
                    "\n".join(
                        [
                            f"PUT {self.base_url}/rest/api/3/issue/{key}",
                            self._format_payload(payload),
                            f"RESPONSE {status} - OK",
                            self._format_payload(result),
                        ]
                    ),
                ),
            )
            return status, result if isinstance(result, dict) else None
        except Exception:
            logger.exception("Failed to update Jira issue parent %s", key)
            return None, None

    # Handles the move_issue_status function logic.
    # Input: self, key: str, status_name: str.
    # Output: Tuple[Optional[int], Optional[Dict[str, Any]]].
    def move_issue_status(
        self, key: str, status_name: str
    ) -> Tuple[Optional[int], Optional[Dict[str, Any]]]:
        try:
            issue, issue_status = self.get_issue(key)
            context = self._extract_issue_move_context(issue)
            if not context:
                logger.warning(
                    "Bulk status move context missing for %s while targeting %s (fetch status: %s)",
                    key,
                    status_name,
                    issue_status if issue_status is not None else "(none)",
                )
                return None, None
            status_entries = self._fetch_project_status_entries(context["project_key"])
            if status_entries is None:
                logger.warning(
                    "Bulk status move could not list project statuses for %s in project %s",
                    key,
                    context["project_key"],
                )
                return None, None
            matching_type_entries = [
                entry
                for entry in status_entries
                if entry.get("issue_type_id") == context["issue_type_id"]
            ]
            log_entries = matching_type_entries or status_entries
            logger.info(
                "Jira statuses before bulk status move for %s: project=%s issue_type=%s statuses=%s",
                key,
                context["project_key"],
                context["issue_type_id"],
                ", ".join(
                    f"{entry.get('status_id')}:{entry.get('status_name')}"
                    for entry in log_entries
                ) or "(none)",
            )
            target_status_id = self._resolve_status_id_from_entries(
                status_entries,
                status_name,
                context["issue_type_id"],
            )
            if not target_status_id:
                logger.warning(
                    "Bulk status move target %s does not exist for %s in project %s issue type %s",
                    status_name,
                    key,
                    context["project_key"],
                    context["issue_type_id"],
                )
                return None, None
            if target_status_id == context["status_id"]:
                logger.info(
                    "Bulk status move skipped for %s; Jira already reports %s",
                    key,
                    status_name,
                )
                return 204, {}
            logger.info(
                "Bulk status move context for %s: project=%s issue_type=%s current_status=%s target_status=%s",
                key,
                context["project_key"],
                context["issue_type_id"],
                context["status_id"],
                target_status_id,
            )
            mapping_key = f"{context['project_key']},{context['issue_type_id']}"
            if context.get("parent_key"):
                mapping_key = f"{mapping_key},{context['parent_key']}"
            payload = {
                "sendBulkNotification": False,
                "targetToSourcesMapping": {
                    mapping_key: {
                        "issueIdsOrKeys": [key],
                        "inferClassificationDefaults": True,
                        "inferFieldDefaults": True,
                        "inferStatusDefaults": False,
                        "inferSubtaskTypeDefault": True,
                        "targetMandatoryFields": [],
                        "targetStatus": [
                            {
                                "statuses": {
                                    target_status_id: [context["status_id"]],
                                }
                            }
                        ],
                    }
                },
            }
            result, status = self._request(
                "POST",
                "/rest/api/3/bulk/issues/move",
                payload,
            )
            logger.info(
                "%s",
                self._format_block(
                    "calling JIRA API",
                    "\n".join(
                        [
                            f"POST {self.base_url}/rest/api/3/bulk/issues/move",
                            self._format_payload(payload),
                            f"RESPONSE {status} - OK",
                            self._format_payload(result),
                        ]
                    ),
                ),
            )
            return status, result if isinstance(result, dict) else None
        except Exception:
            logger.exception(
                "Failed to bulk move Jira issue %s to status %s",
                key,
                status_name,
            )
            return None, None

    # Handles the bulk_edit_issue_status function logic.
    # Input: self, key: str, status_name: str.
    # Output: Tuple[Optional[int], Optional[Dict[str, Any]]].
    def bulk_edit_issue_status(
        self, key: str, status_name: str
    ) -> Tuple[Optional[int], Optional[Dict[str, Any]]]:
        try:
            issue, issue_status = self.get_issue(key)
            context = self._extract_issue_move_context(issue)
            if not context:
                logger.warning(
                    "Bulk edit status context missing for %s while targeting %s (fetch status: %s)",
                    key,
                    status_name,
                    issue_status if issue_status is not None else "(none)",
                )
                return None, None
            status_entries = self._fetch_project_status_entries(context["project_key"])
            if status_entries is None:
                logger.warning(
                    "Bulk edit status could not list project statuses for %s in project %s",
                    key,
                    context["project_key"],
                )
                return None, None
            matching_type_entries = [
                entry
                for entry in status_entries
                if entry.get("issue_type_id") == context["issue_type_id"]
            ]
            log_entries = matching_type_entries or status_entries
            logger.info(
                "Jira statuses before bulk edit status for %s: project=%s issue_type=%s statuses=%s",
                key,
                context["project_key"],
                context["issue_type_id"],
                ", ".join(
                    f"{entry.get('status_id')}:{entry.get('status_name')}"
                    for entry in log_entries
                ) or "(none)",
            )
            editable_fields, editable_fields_status = self._request(
                "GET",
                f"/rest/api/3/bulk/issues/fields?issueIdsOrKeys={quote(str(key), safe='')}",
            )
            fields_payload = (
                editable_fields.get("fields")
                if isinstance(editable_fields, dict)
                else None
            )
            fields = fields_payload if isinstance(fields_payload, list) else []
            log_fields = [
                f"{field.get('id')}:{field.get('name')}"
                + (
                    f" unavailable={field.get('unavailableMessage')}"
                    if field.get("unavailableMessage")
                    else ""
                )
                for field in fields
                if isinstance(field, dict)
            ]
            logger.info(
                "Jira bulk editable fields for %s: status=%s fields=%s",
                key,
                editable_fields_status,
                ", ".join(log_fields) or "(none)",
            )
            status_field = next(
                (
                    field
                    for field in fields
                    if isinstance(field, dict) and field.get("id") == "status"
                ),
                None,
            )
            if not status_field or status_field.get("unavailableMessage"):
                logger.warning(
                    "Bulk edit status is not available for %s; Jira editable fields status=%s status_field=%s",
                    key,
                    editable_fields_status,
                    self._format_payload(status_field) if status_field else "(missing)",
                )
                return None, None
            target_status_id = self._resolve_status_id_from_entries(
                status_entries,
                status_name,
                context["issue_type_id"],
            )
            if not target_status_id:
                logger.warning(
                    "Bulk edit status target %s does not exist for %s in project %s issue type %s",
                    status_name,
                    key,
                    context["project_key"],
                    context["issue_type_id"],
                )
                return None, None
            if target_status_id == context["status_id"]:
                logger.info(
                    "Bulk edit status skipped for %s; Jira already reports %s",
                    key,
                    status_name,
                )
                return 204, {}
            logger.info(
                "Bulk edit status context for %s: project=%s issue_type=%s current_status=%s target_status=%s",
                key,
                context["project_key"],
                context["issue_type_id"],
                context["status_id"],
                target_status_id,
            )
            payload = {
                "selectedIssueIdsOrKeys": [key],
                "selectedActions": ["status"],
                "editedFieldsInput": {
                    "status": {
                        "statusId": target_status_id,
                    }
                },
                "sendBulkNotification": False,
            }
            result, status = self._request(
                "POST",
                "/rest/api/3/bulk/issues/fields",
                payload,
            )
            logger.info(
                "%s",
                self._format_block(
                    "calling JIRA API",
                    "\n".join(
                        [
                            f"POST {self.base_url}/rest/api/3/bulk/issues/fields",
                            self._format_payload(payload),
                            f"RESPONSE {status} - OK",
                            self._format_payload(result),
                        ]
                    ),
                ),
            )
            return status, result if isinstance(result, dict) else None
        except Exception:
            logger.exception(
                "Failed to bulk edit Jira issue %s to status %s",
                key,
                status_name,
            )
            return None, None

    # Handles the get_projects function logic.
    # Input: self, max_results: int = 200.
    # Output: Tuple[Optional[List[Dict[str, Any]]], Optional[int]].
    def get_projects(
        self, max_results: int = 200
    ) -> Tuple[Optional[List[Dict[str, Any]]], Optional[int]]:
        safe_max = max(1, int(max_results or 200))
        try:
            data, status = self._request(
                "GET",
                f"/rest/api/3/project/search?maxResults={safe_max}",
            )
            raw_projects: List[Any] = []
            if isinstance(data, dict):
                values = data.get("values")
                if isinstance(values, list):
                    raw_projects = values
                elif isinstance(data.get("projects"), list):
                    raw_projects = data.get("projects")
                else:
                    return None, status
            elif isinstance(data, list):
                raw_projects = data
            else:
                return None, status

            normalized: Dict[str, Dict[str, Any]] = {}
            for entry in raw_projects:
                if not isinstance(entry, dict):
                    continue
                raw_key = entry.get("key")
                if not isinstance(raw_key, str) or not raw_key.strip():
                    continue
                key = raw_key.strip().upper()
                raw_name = entry.get("name")
                name = raw_name.strip() if isinstance(raw_name, str) and raw_name.strip() else key
                item: Dict[str, Any] = {
                    "key": key,
                    "name": name,
                }
                raw_id = entry.get("id")
                if raw_id is not None:
                    item["id"] = str(raw_id)
                raw_type = entry.get("projectTypeKey")
                if isinstance(raw_type, str) and raw_type.strip():
                    item["project_type"] = raw_type.strip()
                if key not in normalized:
                    normalized[key] = item

            return sorted(normalized.values(), key=lambda item: item.get("key", "")), status
        except Exception:
            logger.exception("Failed to fetch Jira projects")
            return None, None

    # Handles the get_project_statuses function logic.
    # Input: self, project_key: str.
    # Output: Tuple[Optional[List[str]], Optional[int]].
    def get_project_statuses(
        self, project_key: str
    ) -> Tuple[Optional[List[str]], Optional[int]]:
        try:
            data, status = self._request(
                "GET", f"/rest/api/3/project/{project_key}/statuses"
            )
            if not isinstance(data, list):
                return None, status
            names = []
            for issue_type in data:
                if not isinstance(issue_type, dict):
                    continue
                for entry in issue_type.get("statuses", []) or []:
                    if isinstance(entry, dict):
                        name = entry.get("name")
                        if name:
                            names.append(name)
            unique = sorted({name for name in names})
            return unique, status
        except Exception:
            logger.exception("Failed to fetch Jira statuses for %s", project_key)
            return None, None

    # Handles the get_project_issue_type_hierarchy function logic.
    # Input: self, project_key: str.
    # Output: Tuple[Optional[List[Dict[str, Any]]], Optional[int]].
    def get_project_issue_type_hierarchy(
        self, project_key: str
    ) -> Tuple[Optional[List[Dict[str, Any]]], Optional[int]]:
        encoded_project = quote(project_key)
        try:
            data, status = self._request(
                "GET", f"/rest/api/3/project/{encoded_project}?expand=issueTypes"
            )
            issue_types = (
                data.get("issueTypes")
                if isinstance(data, dict)
                else None
            )
            normalized = normalize_project_issue_types(issue_types)
            if normalized:
                return normalized, status
            fallback, fallback_status = self._request(
                "GET", f"/rest/api/3/project/{encoded_project}/statuses"
            )
            fallback_issue_types = (
                [
                    {
                        "id": str(entry.get("id")) if entry.get("id") is not None else None,
                        "name": entry.get("name"),
                        "subtask": bool(entry.get("subtask")),
                    }
                    for entry in fallback
                    if isinstance(entry, dict)
                ]
                if isinstance(fallback, list)
                else []
            )
            normalized = normalize_project_issue_types(fallback_issue_types)
            if normalized:
                return normalized, fallback_status
            return None, fallback_status
        except JiraRequestError as exc:
            logger.exception("Failed to fetch Jira issue type hierarchy for %s", project_key)
            return None, exc.status_code
        except Exception:
            logger.exception("Failed to fetch Jira issue type hierarchy for %s", project_key)
            return None, None

    # Handles the search_users function logic.
    # Input: self, query: str, max_results: int = 50.
    # Output: Tuple[Optional[List[Dict[str, Any]]], Optional[int]].
    def search_users(
        self, query: str, max_results: int = 50
    ) -> Tuple[Optional[List[Dict[str, Any]]], Optional[int]]:
        try:
            encoded = quote(query)
            data, status = self._request(
                "GET",
                f"/rest/api/3/user/search?query={encoded}&maxResults={max_results}",
            )
            if isinstance(data, list):
                return data, status
            return None, status
        except Exception:
            logger.exception("Failed to search Jira users for %s", query)
            return None, None

    # Handles the transition_issue function logic.
    # Input: self, key: str, status_name: str.
    # Output: Tuple[Optional[int], Optional[Dict[str, Any]]].
    def transition_issue(
        self, key: str, status_name: str
    ) -> Tuple[Optional[int], Optional[Dict[str, Any]]]:
        try:
            transitions, _ = self._request(
                "GET", f"/rest/api/3/issue/{key}/transitions"
            )
            transitions = transitions or {}
        except Exception:
            logger.exception("Failed to fetch Jira transitions for %s", key)
            return None, None
        candidates = transitions.get("transitions") if isinstance(transitions, dict) else None
        if not candidates:
            logger.warning(
                "No Jira transitions returned for %s while targeting status %s",
                key,
                status_name,
            )
            return None, None
        target = None
        available = []
        for transition in candidates:
            to_state = transition.get("to", {}).get("name")
            transition_name = transition.get("name")
            transition_id = transition.get("id")
            available.append(
                f"{transition_id or '?'}:{transition_name or '?'}->{to_state or '?'}"
            )
            if to_state and to_state.lower() == status_name.lower():
                target = transition.get("id")
                break
        if not target:
            logger.warning(
                "No Jira transition target matched %s for %s. Available: %s",
                status_name,
                key,
                ", ".join(available) or "(none)",
            )
            return None, None
        payload = {"transition": {"id": target}}
        try:
            result, status = self._request(
                "POST", f"/rest/api/3/issue/{key}/transitions", payload
            )
            logger.info(
                "%s",
                self._format_block(
                    "calling JIRA API",
                    "\n".join(
                        [
                            f"POST {self.base_url}/rest/api/3/issue/{key}/transitions",
                            self._format_payload(payload),
                            f"RESPONSE {status} - OK",
                            self._format_payload(result),
                        ]
                    ),
                ),
            )
            return status, result if isinstance(result, dict) else None
        except Exception:
            logger.exception("Failed to transition Jira issue %s to %s", key, status_name)
            return None, None

    # Handles the transition_issue_via_path function logic.
    # Input: self, key: str, status_name: str, max_steps: int = 5.
    # Output: Tuple[Optional[int], Optional[Dict[str, Any]]].
    def transition_issue_via_path(
        self, key: str, status_name: str, max_steps: int = 5
    ) -> Tuple[Optional[int], Optional[Dict[str, Any]]]:
        def status_matches(value: Any) -> bool:
            return isinstance(value, str) and value.lower() == status_name.lower()

        def transition_target(transition: Dict[str, Any]) -> Tuple[str, str]:
            to_state = transition.get("to") if isinstance(transition, dict) else None
            if not isinstance(to_state, dict):
                return "", ""
            raw_name = to_state.get("name")
            raw_id = to_state.get("id")
            name = raw_name.strip() if isinstance(raw_name, str) else ""
            status_id = str(raw_id).strip() if raw_id is not None else ""
            return name, status_id

        def transition_score(transition: Dict[str, Any], current_name: str) -> Tuple[int, str]:
            to_name, _ = transition_target(transition)
            text = " ".join(
                str(part or "").lower()
                for part in (transition.get("name"), to_name)
            )
            score = 50
            if to_name.lower() == current_name.lower():
                score += 100
            if "back" in text or "todo" in text or "to do" in text or "backlog" in text:
                score += 20
            if "progress" in text:
                score -= 12
            if "review" in text or "approval" in text:
                score -= 8
            if "test" in text or "ready" in text:
                score -= 6
            if "closed" in text or "done" in text:
                score += 12
            return score, str(transition.get("id") or "")

        path: List[Dict[str, str]] = []
        visited_statuses = set()
        last_status: Optional[int] = None
        last_result: Optional[Dict[str, Any]] = None
        try:
            issue, issue_status = self.get_issue(key)
            current_name = ""
            current_id = ""
            fields = issue.get("fields") if isinstance(issue, dict) else None
            status_field = fields.get("status") if isinstance(fields, dict) else None
            if isinstance(status_field, dict):
                raw_current_name = status_field.get("name")
                raw_current_id = status_field.get("id")
                current_name = (
                    raw_current_name.strip()
                    if isinstance(raw_current_name, str)
                    else ""
                )
                current_id = str(raw_current_id).strip() if raw_current_id is not None else ""
            if current_name:
                visited_statuses.add(current_name.lower())
            if status_matches(current_name):
                return 204, {"path": path}
            for step in range(max(1, int(max_steps or 1))):
                transitions, transition_fetch_status = self._request(
                    "GET", f"/rest/api/3/issue/{key}/transitions"
                )
                candidates = (
                    transitions.get("transitions")
                    if isinstance(transitions, dict)
                    else None
                )
                if not candidates:
                    logger.warning(
                        "No Jira transition path candidates for %s while targeting %s from %s (status=%s)",
                        key,
                        status_name,
                        current_name or "(unknown)",
                        transition_fetch_status,
                    )
                    return None, {"path": path} if path else None
                direct = None
                available = []
                for transition in candidates:
                    if not isinstance(transition, dict):
                        continue
                    to_name, _ = transition_target(transition)
                    transition_id = transition.get("id")
                    transition_name = transition.get("name")
                    available.append(
                        f"{transition_id or '?'}:{transition_name or '?'}->{to_name or '?'}"
                    )
                    if transition_id and status_matches(to_name):
                        direct = transition
                        break
                if direct is None:
                    next_options = []
                    for transition in candidates:
                        if not isinstance(transition, dict) or not transition.get("id"):
                            continue
                        to_name, _ = transition_target(transition)
                        if not to_name:
                            continue
                        if to_name.lower() in visited_statuses:
                            continue
                        next_options.append(transition)
                    if not next_options:
                        logger.warning(
                            "No Jira transition path from %s to %s for %s. Visited=%s Available=%s",
                            current_name or "(unknown)",
                            status_name,
                            key,
                            ", ".join(sorted(visited_statuses)) or "(none)",
                            ", ".join(available) or "(none)",
                        )
                        return None, {"path": path} if path else None
                    direct = sorted(
                        next_options,
                        key=lambda transition: transition_score(transition, current_name),
                    )[0]
                transition_id = str(direct.get("id") or "").strip()
                transition_name = str(direct.get("name") or "").strip()
                to_name, to_id = transition_target(direct)
                logger.info(
                    "Jira transition path step %s for %s: %s -> %s via %s:%s",
                    step + 1,
                    key,
                    current_name or current_id or "(unknown)",
                    to_name or to_id or "(unknown)",
                    transition_id or "?",
                    transition_name or "?",
                )
                payload = {"transition": {"id": transition_id}}
                result, status = self._request(
                    "POST", f"/rest/api/3/issue/{key}/transitions", payload
                )
                logger.info(
                    "%s",
                    self._format_block(
                        "calling JIRA API",
                        "\n".join(
                            [
                                f"POST {self.base_url}/rest/api/3/issue/{key}/transitions",
                                self._format_payload(payload),
                                f"RESPONSE {status} - OK",
                                self._format_payload(result),
                            ]
                        ),
                    ),
                )
                last_status = status
                last_result = result if isinstance(result, dict) else {}
                path.append(
                    {
                        "transition_id": transition_id,
                        "transition_name": transition_name,
                        "from_status": current_name,
                        "to_status": to_name,
                        "to_status_id": to_id,
                    }
                )
                issue, issue_status = self.get_issue(key)
                fields = issue.get("fields") if isinstance(issue, dict) else None
                status_field = fields.get("status") if isinstance(fields, dict) else None
                next_name = ""
                next_id = ""
                if isinstance(status_field, dict):
                    raw_next_name = status_field.get("name")
                    raw_next_id = status_field.get("id")
                    next_name = raw_next_name.strip() if isinstance(raw_next_name, str) else ""
                    next_id = str(raw_next_id).strip() if raw_next_id is not None else ""
                if not next_name and to_name:
                    next_name = to_name
                    next_id = to_id
                current_name = next_name
                current_id = next_id
                if current_name:
                    visited_statuses.add(current_name.lower())
                if status_matches(current_name):
                    payload_result = dict(last_result or {})
                    payload_result["path"] = path
                    return last_status, payload_result
            logger.warning(
                "Jira transition path for %s did not reach %s after %s steps; current=%s path=%s",
                key,
                status_name,
                max_steps,
                current_name or current_id or "(unknown)",
                " -> ".join(
                    item.get("to_status") or item.get("to_status_id") or "(unknown)"
                    for item in path
                ) or "(none)",
            )
            return None, {"path": path} if path else None
        except Exception:
            logger.exception("Failed to transition Jira issue %s to %s via path", key, status_name)
            return None, {"path": path} if path else None
