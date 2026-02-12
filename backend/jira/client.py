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

LOG_BORDER_WIDTH = 60

_BOLD_RE = re.compile(r"\*\*([^*]+)\*\*")
_UNDERLINE_RE = re.compile(r"__([^_]+)__")
_HIGHLIGHT_RE = re.compile(r"==([^=]+)==")
_ITALIC_RE = re.compile(r"(?<!\*)\*([^*]+)\*(?!\*)")
_REFERENCE_RE = re.compile(r"\{([^}]+)\}")
_REFERENCE_PREFIX = "https://task.local/"
_HIGHLIGHT_COLOR = "#FFAB00"
_JIRA_KEY_RE = re.compile(r"^[A-Z][A-Z0-9]+-\d+$")


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


def _paragraph(text: str) -> Dict[str, Any]:
    if text == "":
        return {"type": "paragraph", "content": []}
    return {"type": "paragraph", "content": _parse_inline(text)}


def _build_list_items(values: Iterable[str]) -> List[Dict[str, Any]]:
    return [
        {
            "type": "listItem",
            "content": [_paragraph(value)],
        }
        for value in values
    ]


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


def to_adf(text: str) -> Dict[str, Any]:
    lines = text.split("\n")
    content: List[Dict[str, Any]] = []
    list_mode: Optional[str] = None
    list_items: List[Any] = []
    checkbox_re = re.compile(r"^\[([ xX])\]\s+(.*)$")
    bullet_re = re.compile(r"^[-*]\s+(.*)$")

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
            item_text = checkbox_match.group(2)
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


def from_adf(doc: Any) -> str:
    if isinstance(doc, str):
        return doc
    if not isinstance(doc, dict):
        return ""
    lines = _collect_lines(doc)
    return "\n".join(lines).strip()


class JiraClient:
    def __init__(self, base_url: str, email: str, token: str) -> None:
        self.base_url = base_url.rstrip("/")
        auth = base64.b64encode(f"{email}:{token}".encode("utf-8")).decode("ascii")
        self.headers = {
            "Authorization": f"Basic {auth}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        }

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

    def _format_payload(self, payload: Any) -> str:
        if payload is None:
            return "(none)"
        if isinstance(payload, str):
            return payload
        try:
            return json.dumps(payload, ensure_ascii=False, indent=2)
        except Exception:
            return str(payload)

    def _format_block(self, title: str, body: str) -> str:
        prefix = f"=== {title} "
        width = max(LOG_BORDER_WIDTH, len(prefix) + 1)
        line = prefix + ("=" * (width - len(prefix)))
        border = "=" * len(line)
        return f"{line}\n{body}\n{border}"

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

    def get_issue(self, key: str) -> Tuple[Optional[Dict[str, Any]], Optional[int]]:
        try:
            data, status = self._request(
                "GET",
                f"/rest/api/3/issue/{key}?fields=summary,description,status,labels,assignee,issuelinks,subtasks,parent",
            )
            return data, status
        except Exception:
            logger.exception("Failed to fetch Jira issue %s", key)
            return None, None

    def create_issue(
        self,
        project_key: str,
        summary: str,
        description: str,
        labels: Optional[List[str]] = None,
        issue_type: str = "Task",
        parent_key: Optional[str] = None,
        assignee_id: Optional[str] = None,
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

    def update_issue(
        self,
        key: str,
        summary: Optional[str] = None,
        description: Optional[str] = None,
        labels: Optional[List[str]] = None,
        assignee_id: Optional[str] = None,
        clear_assignee: bool = False,
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
