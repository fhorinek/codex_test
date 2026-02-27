# Module: Jira sync worker logic for parsing tasks and reconciling Jira and space state.

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

from websockets.exceptions import ConnectionClosed

logger = logging.getLogger("jira-worker")

# Stores the BACKEND_DIR module constant.
BACKEND_DIR = Path(__file__).resolve().parents[1]
if __package__ in (None, ""):
    sys.path.append(str(BACKEND_DIR))
    from jira.client import JiraClient, JIRA_ESTIMATE_UNSET, from_adf
    from jira.config import JiraConfig, load_jira_config
    from jira.space import (
        SpaceSession,
        add_reference_to_description,
        apply_linked_references,
        extract_linked_keys,
        format_token_line,
        normalize_reference_to_key,
        open_space_session,
        read_ydoc_text,
        remove_people_from_line,
        remove_reference_from_description,
        remove_state_from_line,
        remove_tags_from_line,
        replace_ydoc_text,
        scrub_body_tokens,
    )
else:
    from .client import JiraClient, JIRA_ESTIMATE_UNSET, from_adf
    from .config import JiraConfig, load_jira_config
    from .space import (
        SpaceSession,
        add_reference_to_description,
        apply_linked_references,
        extract_linked_keys,
        format_token_line,
        normalize_reference_to_key,
        open_space_session,
        read_ydoc_text,
        remove_people_from_line,
        remove_reference_from_description,
        remove_state_from_line,
        remove_tags_from_line,
        replace_ydoc_text,
        scrub_body_tokens,
    )
# Stores the SPACES_DIR module constant.
SPACES_DIR = BACKEND_DIR / "spaces"

# Stores the JIRA_PROJECTS module constant.
JIRA_PROJECTS: Dict[str, str] = {
    "jira_test": "KAN",
}
# Stores the JIRA_SYNC_INTERVAL module constant.
JIRA_SYNC_INTERVAL = 10
# Stores the JIRA_PULL_IDLE_SECONDS module constant.
JIRA_PULL_IDLE_SECONDS = 5
# Stores the JIRA_SPACE_STABLE_SECONDS module constant.
JIRA_SPACE_STABLE_SECONDS = 15
# Stores the JIRA_ISSUE_TYPE module constant.
JIRA_ISSUE_TYPE = "Task"
# Stores the JIRA_SUBTASK_ISSUE_TYPE module constant.
JIRA_SUBTASK_ISSUE_TYPE = "Sub-task"
# Stores the JIRA_DEFAULT_STATE module constant.
JIRA_DEFAULT_STATE = "Backlog"
# Stores the JIRA_STATE_MAP module constant.
JIRA_STATE_MAP = {
    "todo": "To Do",
    "inprogress": "In Progress",
    "done": "Done",
}
# Stores the JIRA_STATE_MAP_BY_PROJECT module constant.
JIRA_STATE_MAP_BY_PROJECT: Dict[str, Dict[str, str]] = {}
# Stores the JIRA_USER_MAP module constant.
JIRA_USER_MAP: Dict[str, str] = {
    # Space assignee -> Jira accountId
    # "maya": "5b10a2844c20165700ede21g",
}
# Stores the JIRA_MARKER_RE module constant.
JIRA_MARKER_RE = re.compile(r"\[JIRA:([A-Z][A-Z0-9]+(?:-\d+)?)\]")

space_entity_cache: Dict[str, Dict[str, Any]] = {}
jira_entity_cache: Dict[str, Dict[str, Any]] = {}
# Stores the JIRA_ACCOUNT_ID_BY_EMAIL module constant.
JIRA_ACCOUNT_ID_BY_EMAIL: Dict[str, str] = {}
# Stores the LOG_BORDER_WIDTH module constant.
LOG_BORDER_WIDTH = 60

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


# Stores the TASK_LINE_RE module constant.
TASK_LINE_RE = re.compile(r"^(\s*)%\s+(.*)$")
# Stores the TOKEN_LINE_RE module constant.
TOKEN_LINE_RE = re.compile(r"(^|\s)[#!@~]")
# Stores the STATE_TOKEN_RE module constant.
STATE_TOKEN_RE = re.compile(r"(^|\s)!([^\s#@]+)")
# Stores the TAG_TOKEN_RE module constant.
TAG_TOKEN_RE = re.compile(r"(^|\s)#([^\s#@]+)")
# Stores the PERSON_TOKEN_RE module constant.
PERSON_TOKEN_RE = re.compile(r"(^|\s)@([^\s#@]+)")
# Stores the REFERENCE_RE module constant.
REFERENCE_RE = re.compile(r"\{([^}]+)\}")
# Stores the STORY_POINTS_RE module constant.
STORY_POINTS_RE = re.compile(r"(^|\s)~(\d+(?:\.\d+)?)(?=\s|$)")

# Stores the TASK_MODIFY_ADD module constant.
TASK_MODIFY_ADD = "add"
# Stores the TASK_MODIFY_REMOVE module constant.
TASK_MODIFY_REMOVE = "remove"

# Stores the TASK_FIELD_TAG module constant.
TASK_FIELD_TAG = "tag"
# Stores the TASK_FIELD_DESCRIPTION module constant.
TASK_FIELD_DESCRIPTION = "description"
# Stores the TASK_FIELD_REFERENCE module constant.
TASK_FIELD_REFERENCE = "reference"
# Stores the TASK_FIELD_PEOPLE module constant.
TASK_FIELD_PEOPLE = "people"
# Stores the TASK_FIELD_NAME module constant.
TASK_FIELD_NAME = "name"
# Stores the TASK_FIELD_STATE module constant.
TASK_FIELD_STATE = "state"
# Stores the TASK_FIELD_JIRAKEY module constant.
TASK_FIELD_JIRAKEY = "jirakey"


# Defines the PersonConfig structure used by this module.
@dataclass
class PersonConfig:
    slug: str
    name: str
    mail: str


# Defines the StateConfig structure used by this module.
@dataclass
class StateConfig:
    slug: str
    name: str
    jira: List[str]


# Defines the ParsedTask structure used by this module.
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


# Defines the SyncEntity structure used by this module.
@dataclass
class SyncEntity:
    key: str
    title: str
    state: Optional[str]
    tags: List[str]
    owner: Optional[str]
    description: str
    linked: List[str]
    story_points: Optional[float] = None
    timestamp: float = 0.0
    field_timestamps: Dict[str, float] = field(default_factory=dict)


# Defines the SpaceTask structure used by this module.
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
    story_points: Optional[float] = None
    parent_index: Optional[int] = None


# Handles the jira_enabled function logic.
# Input: config: JiraConfig.
# Output: bool.
def jira_enabled(config: JiraConfig) -> bool:
    return config.enabled


# Handles the get_jira_project function logic.
# Input: space_id: str.
# Output: Optional[str].
def get_jira_project(space_id: str) -> Optional[str]:
    return (
        JIRA_PROJECTS.get(space_id)
        or JIRA_PROJECTS.get(space_id.lower())
    )


# Handles the extract_jira_key function logic.
# Input: text: str.
# Output: Optional[str].
def extract_jira_key(text: str) -> Optional[str]:
    match = JIRA_MARKER_RE.search(text)
    if not match:
        return None
    value = match.group(1)
    if re.fullmatch(r"[A-Z][A-Z0-9]+-\d+", value):
        return value
    return None


# Handles the extract_jira_project_hint function logic.
# Input: text: str.
# Output: Optional[str].
def extract_jira_project_hint(text: str) -> Optional[str]:
    match = JIRA_MARKER_RE.search(text)
    if not match:
        return None
    value = match.group(1)
    if re.fullmatch(r"[A-Z][A-Z0-9]+-\d+", value):
        return None
    return value


# Handles the strip_jira_marker function logic.
# Input: text: str.
# Output: str.
def strip_jira_marker(text: str) -> str:
    return JIRA_MARKER_RE.sub("", text).strip()


# Handles the build_task_line function logic.
# Input: indent: str, name: str, jira_key: Optional[str].
# Output: str.
def build_task_line(indent: str, name: str, jira_key: Optional[str]) -> str:
    base = name.strip()
    line = f"{indent}%"
    if jira_key:
        line = f"{line} [JIRA:{jira_key}]"
    if base:
        line = f"{line} {base}"
    return line.rstrip()


# Handles the _normalize_list function logic.
# Input: values: List[str].
# Output: List[str].
def _normalize_list(values: List[str]) -> List[str]:
    return sorted({value.strip() for value in values if value and value.strip()})


# Handles the task_snapshot function logic.
# Input: task: ParsedTask.
# Output: Dict[str, Any].
def task_snapshot(task: ParsedTask) -> Dict[str, Any]:
    return {
        "name": task.name,
        "description": task.description,
        "state": (task.state or "").strip(),
        "tags": _normalize_list(task.tags),
        "people": _normalize_list(task.people),
    }


# Handles the diff_snapshot function logic.
# Input: previous: Optional[Dict[str, Any]], current: Dict[str, Any],.
# Output: Dict[str, Tuple[Any, Any]].
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


# Handles the parse_people_config function logic.
# Input: lines: List[str],.
# Output: Tuple[Dict[str, PersonConfig], List[str], Optional[Tuple[int, int, str]]].
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


# Handles the parse_states_config function logic.
# Input: lines: List[str],.
# Output: Tuple[Dict[str, StateConfig], List[str], Optional[Tuple[int, int, str]]].
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


# Handles the render_states_config function logic.
# Input: indent: str, states: Dict[str, StateConfig], order: List[str].
# Output: List[str].
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


# Handles the apply_states_config function logic.
# Input: lines: List[str], states: Dict[str, StateConfig], order: List[str], block: Optional[Tuple[int, int, str]],.
# Output: Tuple[List[str], Tuple[int, int, str]].
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


# Handles the render_people_config function logic.
# Input: indent: str, people: Dict[str, PersonConfig], order: List[str].
# Output: List[str].
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


# Handles the slugify_person function logic.
# Input: name: str.
# Output: str.
def slugify_person(name: str) -> str:
    normalized = unicodedata.normalize("NFKD", name)
    ascii_text = normalized.encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", ascii_text.strip().lower())
    slug = slug.strip("-")
    return slug or "person"


# Handles the ensure_unique_slug function logic.
# Input: base: str, existing: List[str].
# Output: str.
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


# Handles the apply_people_config function logic.
# Input: lines: List[str], people: Dict[str, PersonConfig], order: List[str], block: Optional[Tuple[int, int, str]],.
# Output: Tuple[List[str], Tuple[int, int, str]].
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


# Handles the find_config_bounds function logic.
# Input: lines: List[str].
# Output: Tuple[Optional[int], int, str].
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


# Handles the is_token_line function logic.
# Input: text: str.
# Output: bool.
def is_token_line(text: str) -> bool:
    stripped = text.strip()
    if not stripped:
        return False
    for token in stripped.split():
        if re.fullmatch(r"~\d+(?:\.\d+)?", token):
            continue
        if not re.fullmatch(r"[#!@][^\s#@~]+", token):
            return False
    return True


# Handles the parse_space_tasks function logic.
# Input: lines: List[str].
# Output: List[SpaceTask].
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
        story_points: Optional[float] = None
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
            if story_points is None:
                story_match_any = STORY_POINTS_RE.search(entry)
                if story_match_any:
                    try:
                        parsed_story = float(story_match_any.group(2))
                    except ValueError:
                        parsed_story = None
                    if parsed_story is not None and parsed_story >= 0:
                        story_points = parsed_story
            if is_token_line(entry):
                token_line_indices.append(line_index)
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
                story_points=story_points,
            )
        )
    return tasks


# Handles the find_space_task_by_key function logic.
# Input: tasks: List[SpaceTask], key: str.
# Output: Optional[SpaceTask].
def find_space_task_by_key(tasks: List[SpaceTask], key: str) -> Optional[SpaceTask]:
    for task in tasks:
        if task.jira_key == key:
            return task
    return None


# Handles the assign_space_task_parents function logic.
# Input: tasks: List[SpaceTask].
# Output: None.
def assign_space_task_parents(tasks: List[SpaceTask]) -> None:
    stack: List[SpaceTask] = []
    for task in tasks:
        indent = len(task.indent)
        while stack and len(stack[-1].indent) >= indent:
            stack.pop()
        task.parent_index = stack[-1].line_index if stack else None
        stack.append(task)


# Handles the build_reference_maps function logic.
# Input: tasks: List[SpaceTask],.
# Output: Tuple[Dict[str, str], Dict[str, str]].
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


# Handles the normalize_description_for_space function logic.
# Input: description: str, key_to_title: Dict[str, str].
# Output: str.
def normalize_description_for_space(
    description: str, key_to_title: Dict[str, str]
) -> str:
    if not description:
        return ""

    # Handles the repl function logic.
    # Input: match: re.Match.
    # Output: str.
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


# Handles the strip_token_lines_from_description function logic.
# Input: description: str.
# Output: str.
def strip_token_lines_from_description(description: str) -> str:
    if not description:
        return ""
    kept: List[str] = []
    for line in description.split("\n"):
        if is_token_line(line):
            continue
        kept.append(line)
    return "\n".join(kept).rstrip()


# Handles the convert_description_to_jira function logic.
# Input: description: str, title_to_key: Dict[str, str].
# Output: str.
def convert_description_to_jira(
    description: str, title_to_key: Dict[str, str]
) -> str:
    if not description:
        return ""

    # Handles the repl function logic.
    # Input: match: re.Match.
    # Output: str.
    def repl(match: re.Match) -> str:
        ref = match.group(1).strip()
        key = normalize_reference_to_key(ref, title_to_key)
        if key:
            return f"{{{key}}}"
        return f"{{{ref}}}"

    return REFERENCE_RE.sub(repl, description).rstrip()


# Handles the _clean_story_points_line function logic.
# Input: line: str.
# Output: str.
def _clean_story_points_line(line: str) -> str:
    cleaned = STORY_POINTS_RE.sub(" ", line)
    return " ".join(cleaned.split())


# Handles the extract_story_points_from_description function logic.
# Input: description: str.
# Output: Optional[float].
def extract_story_points_from_description(description: str) -> Optional[float]:
    if not description:
        return None
    for line in description.split("\n"):
        match = STORY_POINTS_RE.search(line)
        if not match:
            continue
        try:
            value = float(match.group(2))
        except ValueError:
            return None
        if value >= 0:
            return value
    return None


# Handles the strip_story_points_from_description function logic.
# Input: description: str.
# Output: str.
def strip_story_points_from_description(description: str) -> str:
    if not description:
        return ""
    lines: List[str] = []
    for line in description.split("\n"):
        cleaned = _clean_story_points_line(line)
        if cleaned:
            lines.append(cleaned)
    return "\n".join(lines).rstrip()


# Handles the format_story_points_token function logic.
# Input: value: float.
# Output: str.
def format_story_points_token(value: float) -> str:
    if float(value).is_integer():
        return str(int(value))
    return f"{value:.4f}".rstrip("0").rstrip(".")


# Handles the format_token_line_with_story_points function logic.
# Input: state: Optional[str], tags: List[str], people: List[str], story_points: Optional[float],.
# Output: str.
def format_token_line_with_story_points(
    state: Optional[str],
    tags: List[str],
    people: List[str],
    story_points: Optional[float],
) -> str:
    base = format_token_line(state, tags, people)
    if story_points is None:
        return base
    story_token = f"~{format_story_points_token(story_points)}"
    if not base:
        return story_token
    return f"{base} {story_token}"


# Handles the story_points_to_estimate_minutes function logic.
# Input: story_points: Optional[float].
# Output: Optional[int].
def story_points_to_estimate_minutes(story_points: Optional[float]) -> Optional[int]:
    if story_points is None:
        return 0
    if story_points < 0:
        return None
    return max(0, int(round(float(story_points) * 60.0)))


# Handles the estimate_seconds_to_story_points function logic.
# Input: seconds: Any.
# Output: Optional[float].
def estimate_seconds_to_story_points(seconds: Any) -> Optional[float]:
    if not isinstance(seconds, (int, float)):
        return None
    if seconds < 0:
        return None
    value = round(float(seconds) / 3600.0, 4)
    if value.is_integer():
        return float(int(value))
    return value


# Handles the extract_jira_original_estimate_seconds function logic.
# Input: fields: Dict[str, Any].
# Output: Optional[int].
def extract_jira_original_estimate_seconds(fields: Dict[str, Any]) -> Optional[int]:
    value = fields.get("timeoriginalestimate")
    if isinstance(value, (int, float)):
        return int(value)
    timetracking = fields.get("timetracking")
    if isinstance(timetracking, dict):
        value = timetracking.get("originalEstimateSeconds")
        if isinstance(value, (int, float)):
            return int(value)
    return None


# Stores the SYNC_FIELDS module constant.
SYNC_FIELDS = [
    "title",
    "state",
    "tags",
    "owner",
    "description",
    "linked",
    "story_points",
]


# Handles the _entity_field_value function logic.
# Input: entity: SyncEntity, field: str.
# Output: Any.
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
    if field == "story_points":
        if entity.story_points is None:
            return 0.0
        return float(entity.story_points)
    return None


# Handles the entities_equal function logic.
# Input: left: SyncEntity, right: SyncEntity.
# Output: bool.
def entities_equal(left: SyncEntity, right: SyncEntity) -> bool:
    return all(
        _entity_field_value(left, field) == _entity_field_value(right, field)
        for field in SYNC_FIELDS
    )


# Handles the update_entity_cache function logic.
# Input: cache: Dict[str, SyncEntity], entity: SyncEntity, timestamp: float,.
# Output: SyncEntity.
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


# Handles the copy_entity function logic.
# Input: entity: SyncEntity, timestamp: Optional[float] = None.
# Output: SyncEntity.
def copy_entity(entity: SyncEntity, timestamp: Optional[float] = None) -> SyncEntity:
    return SyncEntity(
        key=entity.key,
        title=entity.title,
        state=entity.state,
        tags=list(entity.tags),
        owner=entity.owner,
        description=entity.description,
        linked=list(entity.linked),
        story_points=entity.story_points,
        timestamp=entity.timestamp if timestamp is None else timestamp,
        field_timestamps=dict(entity.field_timestamps),
    )


# Handles the prune_entity_cache function logic.
# Input: cache: Dict[str, SyncEntity], keys: List[str].
# Output: None.
def prune_entity_cache(cache: Dict[str, SyncEntity], keys: List[str]) -> None:
    keep = set(keys)
    for key in list(cache.keys()):
        if key not in keep:
            del cache[key]


# Handles the build_space_entity function logic.
# Input: task: SpaceTask, key_to_title: Dict[str, str], title_to_key: Dict[str, str],.
# Output: SyncEntity.
def build_space_entity(
    task: SpaceTask,
    key_to_title: Dict[str, str],
    title_to_key: Dict[str, str],
) -> SyncEntity:
    title = task.title.strip()
    story_points = (
        task.story_points
        if task.story_points is not None
        else extract_story_points_from_description(task.description)
    )
    description = normalize_description_for_space(task.description, key_to_title)
    description = strip_story_points_from_description(description)
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
        story_points=story_points,
    )


# Handles the resolve_state_slug function logic.
# Input: status_name: Optional[str], states: Dict[str, StateConfig], order: List[str],.
# Output: Tuple[Optional[str], bool].
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


# Handles the map_space_state_to_jira function logic.
# Input: state: Optional[str], states: Dict[str, StateConfig].
# Output: Optional[str].
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


# Handles the resolve_assignee_slug function logic.
# Input: assignee: Optional[Dict[str, Any]], people: Dict[str, PersonConfig], order: List[str],.
# Output: Tuple[Optional[str], bool].
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


# Handles the build_jira_entity function logic.
# Input: issue: Dict[str, Any], key_to_title: Dict[str, str], title_to_key: Dict[str, str], states: Dict[str, StateConfig], state_order: List[str], people: Dict[str, PersonConfig], people_order: List[str],.
# Output: Tuple[SyncEntity, bool, bool].
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
    description = strip_story_points_from_description(description)
    status_name = fields.get("status", {}).get("name")
    state_slug, state_changed = resolve_state_slug(status_name, states, state_order)
    labels = fields.get("labels") or []
    assignee = fields.get("assignee")
    estimate_seconds = extract_jira_original_estimate_seconds(fields)
    story_points = estimate_seconds_to_story_points(estimate_seconds)
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
        story_points=story_points,
    )
    return entity, state_changed, people_changed


# Handles the parse_tasks function logic.
# Input: lines: List[str].
# Output: List[ParsedTask].
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
            if candidate and is_token_line(candidate):
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


# Handles the parse_space_task_token_values function logic.
# Input: lines: List[str], task: SpaceTask.
# Output: Tuple[Optional[str], List[str], List[str], Optional[float]].
def parse_space_task_token_values(
    lines: List[str], task: SpaceTask
) -> Tuple[Optional[str], List[str], List[str], Optional[float]]:
    state: Optional[str] = None
    tags: List[str] = []
    people: List[str] = []
    story_points: Optional[float] = None
    for index in task.token_line_indices:
        if index < 0 or index >= len(lines):
            continue
        raw = lines[index]
        entry = raw
        if entry.startswith(task.indent):
            entry = entry[len(task.indent):]
        token_line = entry.strip()
        if not token_line:
            continue
        if state is None:
            state_match = STATE_TOKEN_RE.search(token_line)
            if state_match:
                state = state_match.group(2)
        tags.extend(match.group(2) for match in TAG_TOKEN_RE.finditer(token_line))
        people.extend(match.group(2) for match in PERSON_TOKEN_RE.finditer(token_line))
        if story_points is None:
            story_match = STORY_POINTS_RE.search(token_line)
            if story_match:
                try:
                    value = float(story_match.group(2))
                except ValueError:
                    value = None
                if value is not None and value >= 0:
                    story_points = value
    return state, _normalize_list(tags), _normalize_list(people), story_points


# Handles the assign_task_parents function logic.
# Input: tasks: List[ParsedTask].
# Output: None.
def assign_task_parents(tasks: List[ParsedTask]) -> None:
    stack: List[ParsedTask] = []
    for task in tasks:
        indent = len(task.indent)
        while stack and len(stack[-1].indent) >= indent:
            stack.pop()
        task.parent_index = stack[-1].line_index if stack else None
        stack.append(task)


# Handles the find_task_by_line function logic.
# Input: tasks: List[ParsedTask], line_index: int.
# Output: Optional[ParsedTask].
def find_task_by_line(tasks: List[ParsedTask], line_index: int) -> Optional[ParsedTask]:
    for task in tasks:
        if task.line_index == line_index:
            return task
    return None


# Handles the extract_issue_link_refs function logic.
# Input: issue: Dict[str, Any].
# Output: List[str].
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


# Handles the insert_jira_key function logic.
# Input: lines: List[str], task: ParsedTask, jira_key: str.
# Output: None.
def insert_jira_key(lines: List[str], task: ParsedTask, jira_key: str) -> None:
    lines[task.line_index] = build_task_line(task.indent, task.name, jira_key)


# Handles the set_task_name function logic.
# Input: lines: List[str], task: ParsedTask, name: str.
# Output: None.
def set_task_name(lines: List[str], task: ParsedTask, name: str) -> None:
    lines[task.line_index] = build_task_line(task.indent, name, task.jira_key)


# Handles the ensure_task_tokens function logic.
# Input: lines: List[str], task: ParsedTask, state: Optional[str], tags: List[str], people: List[str],.
# Output: Tuple[Optional[int], int, int].
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


# Handles the set_task_description function logic.
# Input: lines: List[str], task: ParsedTask, description: str, desc_start: int, desc_end: int.
# Output: None.
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


# Handles the modify_task function logic.
# Input: lines: List[str], task: ParsedTask, operation: str, field: str, values: Optional[List[str]] = None,.
# Output: None.
def modify_task(
    lines: List[str],
    task: ParsedTask,
    operation: str,
    field: str,
    values: Optional[List[str]] = None,
) -> None:
    values = list(values or [])

    if field == TASK_FIELD_TAG:
        if operation == TASK_MODIFY_ADD:
            desired_tags = _normalize_list(list(task.tags) + values)
            ensure_task_tokens(lines, task, task.state, desired_tags, task.people)
        elif operation == TASK_MODIFY_REMOVE:
            remove_set = {value for value in values if value}
            desired_tags = [tag for tag in task.tags if tag not in remove_set]
            _, desc_start, desc_end = ensure_task_tokens(
                lines,
                task,
                task.state,
                desired_tags,
                task.people,
            )
            updated_description_lines: List[str] = []
            for line in task.description.split("\n"):
                cleaned = remove_tags_from_line(line, values)
                if cleaned:
                    updated_description_lines.append(cleaned)
            updated_description = "\n".join(updated_description_lines).rstrip()
            set_task_description(
                lines,
                task,
                updated_description,
                desc_start,
                desc_end,
            )
        else:
            raise ValueError(f"unsupported operation for {field}: {operation}")
        return

    if field == TASK_FIELD_PEOPLE:
        if operation == TASK_MODIFY_ADD:
            desired_people = _normalize_list(list(task.people) + values)
            ensure_task_tokens(lines, task, task.state, task.tags, desired_people)
        elif operation == TASK_MODIFY_REMOVE:
            remove_set = {value for value in values if value}
            desired_people = [person for person in task.people if person not in remove_set]
            _, desc_start, desc_end = ensure_task_tokens(
                lines,
                task,
                task.state,
                task.tags,
                desired_people,
            )
            updated_description_lines: List[str] = []
            for line in task.description.split("\n"):
                cleaned = remove_people_from_line(line, values)
                if cleaned:
                    updated_description_lines.append(cleaned)
            updated_description = "\n".join(updated_description_lines).rstrip()
            set_task_description(
                lines,
                task,
                updated_description,
                desc_start,
                desc_end,
            )
        else:
            raise ValueError(f"unsupported operation for {field}: {operation}")
        return

    if field == TASK_FIELD_STATE:
        if operation == TASK_MODIFY_ADD:
            state = values[0] if values else ""
            ensure_task_tokens(lines, task, state, task.tags, task.people)
        elif operation == TASK_MODIFY_REMOVE:
            _, desc_start, desc_end = ensure_task_tokens(
                lines,
                task,
                None,
                task.tags,
                task.people,
            )
            updated_description_lines: List[str] = []
            for line in task.description.split("\n"):
                cleaned = remove_state_from_line(line)
                if cleaned:
                    updated_description_lines.append(cleaned)
            updated_description = "\n".join(updated_description_lines).rstrip()
            set_task_description(
                lines,
                task,
                updated_description,
                desc_start,
                desc_end,
            )
        else:
            raise ValueError(f"unsupported operation for {field}: {operation}")
        return

    if field == TASK_FIELD_REFERENCE:
        updated_description = task.description
        if operation == TASK_MODIFY_ADD:
            for ref in values:
                updated_description = add_reference_to_description(
                    updated_description, ref
                )
        elif operation == TASK_MODIFY_REMOVE:
            for ref in values:
                updated_description = remove_reference_from_description(
                    updated_description, ref
                )
        else:
            raise ValueError(f"unsupported operation for {field}: {operation}")
        set_task_description(
            lines,
            task,
            updated_description,
            task.desc_start,
            task.desc_end,
        )
        return

    if field == TASK_FIELD_DESCRIPTION:
        if operation == TASK_MODIFY_ADD:
            extra = "\n".join(value for value in values if value)
            if task.description and extra:
                updated_description = f"{task.description}\n{extra}"
            else:
                updated_description = task.description or extra
        elif operation == TASK_MODIFY_REMOVE:
            remove_set = {value for value in values if value}
            kept_lines = [
                line
                for line in task.description.split("\n")
                if line and line not in remove_set
            ]
            updated_description = "\n".join(kept_lines).rstrip()
        else:
            raise ValueError(f"unsupported operation for {field}: {operation}")
        set_task_description(
            lines,
            task,
            updated_description,
            task.desc_start,
            task.desc_end,
        )
        return

    if field == TASK_FIELD_NAME:
        if operation == TASK_MODIFY_ADD:
            name = values[0] if values else ""
            set_task_name(lines, task, name)
        elif operation == TASK_MODIFY_REMOVE:
            set_task_name(lines, task, "")
        else:
            raise ValueError(f"unsupported operation for {field}: {operation}")
        return

    if field == TASK_FIELD_JIRAKEY:
        if operation == TASK_MODIFY_ADD:
            jira_key = values[0] if values else ""
            insert_jira_key(lines, task, jira_key)
        elif operation == TASK_MODIFY_REMOVE:
            lines[task.line_index] = build_task_line(task.indent, task.name, None)
        else:
            raise ValueError(f"unsupported operation for {field}: {operation}")
        return

    raise ValueError(f"unsupported field: {field}")


# Handles the modify_task_text function logic.
# Input: input_text: str, operation: str, field: str, values: Optional[List[str]] = None,.
# Output: str.
def modify_task_text(
    input_text: str,
    operation: str,
    field: str,
    values: Optional[List[str]] = None,
) -> str:
    lines = input_text.split("\n")
    tasks = parse_tasks(lines)
    if len(tasks) != 1:
        raise ValueError("expected exactly one task in input_text")
    modify_task(lines, tasks[0], operation, field, values)
    return "\n".join(lines)


# Handles the map_state_to_jira function logic.
# Input: state: Optional[str], project_key: Optional[str] = None.
# Output: Optional[str].
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


# Handles the map_jira_to_state function logic.
# Input: status_name: Optional[str].
# Output: Optional[str].
def map_jira_to_state(status_name: Optional[str]) -> Optional[str]:
    if not status_name:
        return None
    for state, jira_status in JIRA_STATE_MAP.items():
        if jira_status.lower() == status_name.lower():
            return state
    return None


# Handles the slugify_state function logic.
# Input: status_name: str.
# Output: str.
def slugify_state(status_name: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", status_name.strip().lower())
    return slug.strip("-") or "state"


# Handles the build_project_state_map function logic.
# Input: statuses: List[str].
# Output: Dict[str, str].
def build_project_state_map(statuses: List[str]) -> Dict[str, str]:
    state_map: Dict[str, str] = {}
    for status in statuses:
        if not status:
            continue
        state_map[slugify_state(status)] = status
    return state_map


# Handles the ensure_project_state_map function logic.
# Input: client: JiraClient, project_key: str.
# Output: None.
async def ensure_project_state_map(
    client: JiraClient, project_key: str
) -> None:
    if project_key in JIRA_STATE_MAP_BY_PROJECT:
        return
    statuses, status_code = await run_blocking_io(
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


# Handles the map_assignee_to_person function logic.
# Input: assignee: Optional[Dict[str, Any]], people: Dict[str, PersonConfig],.
# Output: Optional[str].
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


# Handles the summarize_text function logic.
# Input: text: Optional[str], limit: int = 60.
# Output: str.
def summarize_text(text: Optional[str], limit: int = 60) -> str:
    if text is None:
        return "(none)"
    single = " ".join(text.split())
    if not single:
        return "(empty)"
    if len(single) > limit:
        return single[: limit - 3] + "..."
    return single


# Handles the format_timestamp function logic.
# Input: ts: float.
# Output: str.
def format_timestamp(ts: float) -> str:
    if not ts:
        return "-"
    return time.strftime("%m-%d %H:%M:%S", time.localtime(ts))


# Handles the format_entity_summary function logic.
# Input: entity: Optional[SyncEntity].
# Output: str.
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
    if entity.story_points is not None:
        parts.append(f"story=~{format_story_points_token(entity.story_points)}")
    if entity.description:
        parts.append(f"desc={summarize_text(entity.description, limit=60)}")
    return " ".join(parts).strip() or "-"


# Handles the render_ascii_table function logic.
# Input: headers: List[str], rows: List[List[str]].
# Output: str.
def render_ascii_table(headers: List[str], rows: List[List[str]]) -> str:
    widths = [len(header) for header in headers]
    for row in rows:
        for idx, cell in enumerate(row):
            widths[idx] = max(widths[idx], len(cell))

    # Handles the sep function logic.
    # Input: none.
    # Output: str.
    def sep() -> str:
        return "+-" + "-+-".join("-" * width for width in widths) + "-+"

    # Handles the render_row function logic.
    # Input: row: List[str].
    # Output: str.
    def render_row(row: List[str]) -> str:
        return "| " + " | ".join(
            cell.ljust(widths[idx]) for idx, cell in enumerate(row)
        ) + " |"

    lines = [sep(), render_row(headers), sep()]
    for row in rows:
        lines.append(render_row(row))
    lines.append(sep())
    return "\n".join(lines)


# Handles the format_field_value function logic.
# Input: field: str, entity: Optional[SyncEntity].
# Output: str.
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
    if field == "story_points":
        if entity.story_points is None:
            return "-"
        return f"~{format_story_points_token(entity.story_points)}"
    return "-"


# Handles the get_field_timestamp function logic.
# Input: entity: Optional[SyncEntity], field: str.
# Output: float.
def get_field_timestamp(entity: Optional[SyncEntity], field: str) -> float:
    if not entity:
        return 0.0
    return entity.field_timestamps.get(field, entity.timestamp)


# Handles the format_field_timestamp function logic.
# Input: entity: Optional[SyncEntity], field: str.
# Output: str.
def format_field_timestamp(entity: Optional[SyncEntity], field: str) -> str:
    if not entity:
        return "-"
    return format_timestamp(get_field_timestamp(entity, field))


# Handles the is_recent_space_field_change function logic.
# Input: entity: Optional[SyncEntity], field: str, now: float, session_last_change: float,.
# Output: bool.
def is_recent_space_field_change(
    entity: Optional[SyncEntity],
    field: str,
    now: float,
    session_last_change: float,
) -> bool:
    if not entity or not session_last_change:
        return False
    if (now - session_last_change) >= JIRA_SPACE_STABLE_SECONDS:
        return False
    field_ts = get_field_timestamp(entity, field)
    if not field_ts:
        return False
    # Only treat values touched at/after the latest recorded local change as dirty.
    if field_ts + 0.001 < session_last_change:
        return False
    return (now - field_ts) < JIRA_SPACE_STABLE_SECONDS


# Handles the wrap_text function logic.
# Input: value: str, width: int.
# Output: List[str].
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


# Handles the format_sync_status function logic.
# Input: direction: str, status: Optional[Dict[str, Optional[int]]].
# Output: str.
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


# Handles the render_space_change_log function logic.
# Input: space_id: str, old_lines: List[str], new_lines: List[str].
# Output: Optional[str].
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


# Handles the format_tokens function logic.
# Input: prefix: str, values: List[str].
# Output: str.
def format_tokens(prefix: str, values: List[str]) -> str:
    items = _normalize_list(values)
    if not items:
        return "(none)"
    return " ".join(f"{prefix}{value}" for value in items)


# Handles the log_field_change function logic.
# Input: direction: str, space_id: str, project_key: str, jira_key: str, field: str, old: Any, new: Any,.
# Output: None.
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


# Handles the summarize_jira_response function logic.
# Input: status: Optional[int], payload: Optional[Dict[str, Any]].
# Output: str.
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


# Handles the log_parsed_task function logic.
# Input: space_id: str, task: ParsedTask.
# Output: None.
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


# Handles the log_jira_issue_fields function logic.
# Input: space_id: str, project_key: str, jira_key: str, summary: str, description: str, status_name: Optional[str], next_state: Optional[str], labels: List[str], assignee: Optional[Dict[str, Any]], issue_links: Optional[List[str]] = None,.
# Output: None.
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


# Handles the resolve_account_id function logic.
# Input: client: JiraClient, email: str.
# Output: Optional[str].
async def resolve_account_id(
    client: JiraClient, email: str
) -> Optional[str]:
    normalized = email.strip().lower()
    if not normalized:
        return None
    cached = JIRA_ACCOUNT_ID_BY_EMAIL.get(normalized)
    if cached:
        return cached
    users, status = await run_blocking_io(client.search_users, normalized)
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


# Handles the resolve_owner_account_id function logic.
# Input: client: JiraClient, owner: Optional[str], people: Dict[str, PersonConfig],.
# Output: Optional[str].
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


# Handles the sync_space_with_jira function logic.
# Input: client: JiraClient, session: SpaceSession, project_key: str, force_direction: Optional[str] = None,.
# Output: None.
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
        pending_story_points = (
            task.story_points
            if task.story_points is not None
            else extract_story_points_from_description(task.description)
        )
        jira_description = convert_description_to_jira(
            strip_story_points_from_description(task.description),
            title_to_key,
        )
        original_estimate_minutes = story_points_to_estimate_minutes(
            pending_story_points
        )
        owner_slug = task.people[0] if task.people else None
        assignee_id = await resolve_owner_account_id(
            client, owner_slug, people_config
        )
        logger.info("* Adding task %s to jira", task.title)
        issue_key, status, payload = await run_blocking_io(
            client.create_issue,
            project_key_hint,
            task.title,
            jira_description,
            task.tags,
            issue_type,
            parent_key,
            assignee_id,
            original_estimate_minutes,
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
        issue, status = await run_blocking_io(client.get_issue, key)
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
    now = time.time()
    session_last_change = getattr(session, "last_change", 0.0) or 0.0
    setattr(session, "sync_dirty", False)
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
            if is_recent_space_field_change(
                space_entity, field, now, session_last_change
            ):
                field_dirs[field] = "dirty"
                setattr(session, "sync_dirty", True)
                logger.debug(
                    "[Space %s] %s field %s is dirty (<%ss), skipping comparison/sync this round",
                    session.space_id,
                    key,
                    field,
                    JIRA_SPACE_STABLE_SECONDS,
                )
                continue
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
            if "story_points" in push_fields:
                changes["story_points"] = (
                    jira_entity.story_points,
                    space_entity.story_points,
                )
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
                if "story_points" in changes:
                    logger.info(
                        "* Updating jira original estimate to %s",
                        (
                            f"~{format_story_points_token(space_entity.story_points)}"
                            if space_entity.story_points is not None
                            else "(none)"
                        ),
                    )
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
                update_estimate = "story_points" in changes
                should_update_issue = (
                    update_summary
                    or update_description
                    or update_labels
                    or update_estimate
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
                    original_estimate_minutes = (
                        story_points_to_estimate_minutes(space_entity.story_points)
                        if update_estimate
                        else JIRA_ESTIMATE_UNSET
                    )
                    status, payload = await run_blocking_io(
                        client.update_issue,
                        key,
                        space_entity.title if update_summary else None,
                        jira_description,
                        space_entity.tags if update_labels else None,
                        assignee_id,
                        clear_assignee,
                        original_estimate_minutes,
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
                        if update_estimate:
                            updated_jira.story_points = space_entity.story_points
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
                        status, payload = await run_blocking_io(
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

            (
                current_token_state,
                current_token_tags,
                current_token_people,
                current_token_story_points,
            ) = parse_space_task_token_values(lines, task)
            desired_state = (
                jira_entity.state if "state" in pull_fields else current_token_state
            )
            desired_tags = (
                jira_entity.tags if "tags" in pull_fields else current_token_tags
            )
            task_story_points = (
                task.story_points
                if task.story_points is not None
                else extract_story_points_from_description(task.description)
            )
            desired_story_points = (
                jira_entity.story_points
                if "story_points" in pull_fields
                else current_token_story_points
            )
            if "owner" in pull_fields:
                desired_owner = [jira_entity.owner] if jira_entity.owner else []
            else:
                desired_owner = list(current_token_people)
            tokens_need_change = (
                (desired_state or "") != (current_token_state or "")
                or _normalize_list(desired_tags) != _normalize_list(current_token_tags)
                or _normalize_list(desired_owner) != _normalize_list(current_token_people)
                or desired_story_points != current_token_story_points
            )
            if tokens_need_change:
                desired_token = format_token_line_with_story_points(
                    desired_state,
                    desired_tags,
                    desired_owner,
                    desired_story_points,
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

            pull_description = bool(
                {"description", "linked", "story_points", "state", "tags", "owner"}
                & pull_fields
            )
            updated_description = task.description
            if pull_description:
                if {"description", "linked"} & pull_fields:
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
                    base_description = strip_story_points_from_description(description)
                else:
                    base_description = scrub_body_tokens(
                        strip_token_lines_from_description(task.description),
                        desired_state,
                        desired_tags,
                        desired_owner,
                    )
                    base_description = strip_story_points_from_description(base_description)
                    if "owner" in pull_fields:
                        old_owner = task.people[0] if task.people else None
                        if old_owner and old_owner != (jira_entity.owner or None):
                            kept_lines: List[str] = []
                            for line in base_description.split("\n"):
                                cleaned = remove_people_from_line(line, [old_owner])
                                if cleaned:
                                    kept_lines.append(cleaned)
                            base_description = "\n".join(kept_lines).rstrip()
                desired_story_points = (
                    jira_entity.story_points
                    if "story_points" in pull_fields
                    else task_story_points
                )
                description = base_description
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
                    updated_space.description = strip_story_points_from_description(
                        updated_description
                    )
                if "linked" in pull_fields or "description" in pull_fields:
                    updated_space.linked = list(jira_entity.linked)
                if "story_points" in pull_fields:
                    updated_space.story_points = jira_entity.story_points
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

    if created or space_changed or states_changed or people_changed:
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


# Handles the jira_sync_loop function logic.
# Input: one_shot: bool = False, force_direction: Optional[str] = None.
# Output: None.
async def jira_sync_loop(
    one_shot: bool = False, force_direction: Optional[str] = None
) -> None:
    SPACES_DIR.mkdir(parents=True, exist_ok=True)
    logger.info("Jira worker started. Polling every %ss", JIRA_SYNC_INTERVAL)
    sessions: Dict[str, SpaceSession] = {}
    client: Optional[JiraClient] = None
    active_config = JiraConfig()
    config_missing_logged = False
    while True:
        try:
            logger.info("-" * 40 + " tick")
            config = load_jira_config()
            enabled = jira_enabled(config)
            if not enabled:
                if not config_missing_logged:
                    logger.info(
                        "Jira sync disabled. Configure Jira in the UI to enable."
                    )
                    config_missing_logged = True
            else:
                config_missing_logged = False
                if config != active_config or client is None:
                    active_config = config
                    client = JiraClient(
                        config.base_url, config.email, config.token
                    )
            if enabled and client:
                for path in SPACES_DIR.glob("*.txt"):
                    space_id = path.stem
                    project_key = get_jira_project(space_id)
                    if not project_key:
                        logger.debug("No Jira project mapping for space %s", space_id)
                        continue
                    logger.debug(
                        "Syncing space %s -> project %s", space_id, project_key
                    )
                    session = sessions.get(space_id)
                    if not session:
                        try:
                            session = await open_space_session(space_id)
                        except TimeoutError:
                            logger.warning(
                                "Skipping space %s due to connection timeout",
                                space_id,
                            )
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


# Handles the main function logic.
# Input: none.
# Output: None.
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
