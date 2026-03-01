# Module: Jira API client and conversion helpers between task text and Jira document formats.

import base64
import json
import logging
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
    def _request(
        self, method: str, path: str, payload: Optional[Dict[str, Any]] = None
    ) -> Tuple[Any, int]:
        url = f"{self.base_url}{path}"
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = Request(url, data=data, headers=self.headers, method=method)
        try:
            with urlopen(request, timeout=20) as response:
                status = response.getcode()
                raw = response.read().decode("utf-8")
        except HTTPError as exc:
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
            raise RuntimeError(f"Jira API error {exc.code}: {preview}") from exc
        if not raw:
            return None, status
        return json.loads(raw), status

    # Handles the get_issue function logic.
    # Input: self, key: str.
    # Output: Tuple[Optional[Dict[str, Any]], Optional[int]].
    def get_issue(self, key: str) -> Tuple[Optional[Dict[str, Any]], Optional[int]]:
        try:
            data, status = self._request(
                "GET",
                f"/rest/api/3/issue/{key}?fields=summary,description,status,labels,assignee,issuetype,issuelinks,subtasks,parent,timetracking,timeoriginalestimate",
            )
            return data, status
        except Exception:
            logger.exception("Failed to fetch Jira issue %s", key)
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
            return None, None
        target = None
        for transition in candidates:
            to_state = transition.get("to", {}).get("name")
            if to_state and to_state.lower() == status_name.lower():
                target = transition.get("id")
                break
        if not target:
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
