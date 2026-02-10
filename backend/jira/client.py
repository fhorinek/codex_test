import base64
import json
import logging
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote
from urllib.request import Request, urlopen

logger = logging.getLogger("server")


def to_adf(text: str) -> Dict[str, Any]:
    paragraphs = []
    for line in text.split("\n"):
        if line == "":
            paragraphs.append({"type": "paragraph", "content": []})
        else:
            paragraphs.append(
                {"type": "paragraph", "content": [{"type": "text", "text": line}]}
            )
    return {"type": "doc", "version": 1, "content": paragraphs}


def from_adf(doc: Any) -> str:
    if isinstance(doc, str):
        return doc
    if not isinstance(doc, dict):
        return ""
    content = doc.get("content", [])
    lines = []
    for block in content:
        if not isinstance(block, dict):
            continue
        if block.get("type") != "paragraph":
            continue
        texts = []
        for item in block.get("content", []) or []:
            if isinstance(item, dict) and item.get("type") == "text":
                texts.append(item.get("text", ""))
        lines.append("".join(texts))
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

    def _request(
        self, method: str, path: str, payload: Optional[Dict[str, Any]] = None
    ) -> Tuple[Any, int]:
        url = f"{self.base_url}{path}"
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = Request(url, data=data, headers=self.headers, method=method)
        with urlopen(request, timeout=20) as response:
            status = response.getcode()
            raw = response.read().decode("utf-8")
        if not raw:
            return None, status
        return json.loads(raw), status

    def get_issue(self, key: str) -> Tuple[Optional[Dict[str, Any]], Optional[int]]:
        try:
            data, status = self._request(
                "GET",
                f"/rest/api/3/issue/{key}?fields=summary,description,status,labels,assignee",
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
        if assignee_id:
            payload["fields"]["assignee"] = {"accountId": assignee_id}
        try:
            result, status = self._request("POST", "/rest/api/3/issue", payload)
            key = result.get("key") if isinstance(result, dict) else None
            return key, status, result if isinstance(result, dict) else None
        except Exception:
            logger.exception("Failed to create Jira issue in %s", project_key)
            return None, None, None

    def update_issue(
        self,
        key: str,
        summary: str,
        description: str,
        labels: Optional[List[str]],
        assignee_id: Optional[str] = None,
    ) -> Tuple[Optional[int], Optional[Dict[str, Any]]]:
        payload = {
            "fields": {
                "summary": summary,
                "description": to_adf(description),
                "labels": labels or [],
            }
        }
        if assignee_id:
            payload["fields"]["assignee"] = {"accountId": assignee_id}
        try:
            result, status = self._request("PUT", f"/rest/api/3/issue/{key}", payload)
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
            return status, result if isinstance(result, dict) else None
        except Exception:
            logger.exception("Failed to transition Jira issue %s to %s", key, status_name)
            return None, None
