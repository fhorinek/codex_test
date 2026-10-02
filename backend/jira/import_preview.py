"""Read-only imports use the daemon's transformations and definition matching."""
import re
from .worker import (parse_states_config, parse_people_config, parse_space_tasks,
    build_reference_maps, build_jira_entity, build_task_line, build_space_task_body_lines,
    issue_type_to_tag)
from space_tabs import resolved_definition_source


def transform_issues(issues, source, shared):
    lines = resolved_definition_source(source, shared).split('\n')
    states, state_order, _ = parse_states_config(lines)
    people, people_order, _ = parse_people_config(lines)
    old_states, old_people = set(states), set(people)
    key_to_title, title_to_key = build_reference_maps(parse_space_tasks(source.split('\n')))
    for issue in issues:
        key_to_title[issue['key']] = ' '.join(issue.get('fields', {}).get('summary', '').split())
    title_to_key.update({title.lower(): key for key, title in key_to_title.items() if title})
    tasks = []; script = []
    for index, issue in enumerate(issues):
        entity, _, _ = build_jira_entity(issue, key_to_title, title_to_key, states, state_order, people, people_order)
        title = ' '.join(entity.title.split()) or entity.key
        kind = issue_type_to_tag((issue.get('fields', {}).get('issuetype') or {}).get('name', ''))
        tags = sorted(set(entity.tags + ([kind] if kind else [])))
        indent = '' if index == 0 else '    '
        body = build_space_task_body_lines(indent, entity.state, tags, [entity.owner] if entity.owner else [], entity.story_points, entity.description)
        script.extend([build_task_line(indent, title, entity.key), *body, ''])
        tasks.append({'key': entity.key, 'title': title, 'state': entity.state, 'tags': tags, 'people': [entity.owner] if entity.owner else [], 'story_points': entity.story_points, 'description': entity.description, 'depth': 0 if index == 0 else 1})
    definitions = [{'kind': 'state', 'slug': slug, 'metadata': {'name': states[slug].name, 'jiraState': ', '.join(states[slug].jira)}} for slug in state_order if slug not in old_states]
    definitions += [{'kind': 'person', 'slug': slug, 'metadata': {'name': people[slug].name, 'email': people[slug].mail}} for slug in people_order if slug not in old_people]
    return {'tasks': tasks, 'script': '\n'.join(script).rstrip() + '\n', 'definitions': definitions}


def subtask_keys(issue):
    return list(dict.fromkeys(child['key'] for child in (issue.get('fields', {}).get('subtasks') or []) if isinstance(child, dict) and re.fullmatch(r'[A-Z][A-Z0-9]*-[1-9]\d*', str(child.get('key', '')))))
