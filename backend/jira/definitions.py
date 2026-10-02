"""Space-local Jira metadata. Never falls back to the legacy global credentials."""
import re
from urllib.parse import urlsplit
from .config import JiraConfig


def jira_span(source):
    lines = source.splitlines(keepends=True)
    spans = []
    for index, line in enumerate(lines):
        if re.match(r"^\s*%", line): break
        match = re.fullmatch(r'( *)jira:\s*(?:\r?\n)?', line)
        if not match:
            continue
        indent = len(match[1])
        # Only a top-level section or a legacy Definitions child is metadata.
        roots = [prior.strip() for prior in lines[:index] if prior.strip() and not prior.startswith(' ') and not prior.lstrip().startswith('#')]
        if indent and (indent != 4 or not roots or roots[-1] != 'Definitions:'):
            continue
        end = index + 1
        while end < len(lines):
            next_line = lines[end]
            if next_line.strip() and len(next_line) - len(next_line.lstrip(' ')) <= indent:
                break
            end += 1
        spans.append((sum(map(len, lines[:index])), sum(map(len, lines[:end])), indent))
    return spans


def parse_jira_definitions(source):
    spans = jira_span(source)
    diagnostics = []
    if len(spans) > 1:
        return JiraConfig(), ['Duplicate Jira configuration.']
    if not spans:
        return JiraConfig(), []
    start, end, indent = spans[0]
    values = {}
    for line in source[start:end].splitlines()[1:]:
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        match = re.fullmatch(r'\s+(base_url|email|token|autostart|show_logs|show_cache):\s*(.*?)\s*', line)
        if not match or match[1] in values:
            diagnostics.append('Invalid Jira configuration property.')
        else:
            values[match[1]] = match[2]
    for key in ('autostart', 'show_logs', 'show_cache'):
        if key in values and values[key] not in ('true', 'false'):
            diagnostics.append('Jira ' + key + ' must be true or false.')
    config = JiraConfig(values.get('base_url', '').rstrip('/'), values.get('email', ''), values.get('token', ''))
    if not config.enabled:
        diagnostics.append('Jira requires a base URL, email, and API token.')
    try:
        url = urlsplit(config.base_url)
        url.port  # Access validates malformed or out-of-range ports.
    except ValueError:
        url = urlsplit("")
    if config.base_url and (any(character.isspace() for character in config.base_url) or url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password or url.query or url.fragment):
        diagnostics.append('Jira base URL must be an HTTP or HTTPS URL.')
    if config.email and not re.fullmatch(r'[^\s@]+@[^\s@]+', config.email):
        diagnostics.append('Invalid Jira email.')
    return (JiraConfig() if diagnostics else config), diagnostics


def update_jira_definitions(source, payload):
    spans = jira_span(source)
    if len(spans) > 1:
        raise ValueError('Resolve duplicate Jira sections before saving.')
    current, _ = parse_jira_definitions(source)
    values = {key: str(payload.get(key, getattr(current, key)) or '').strip() for key in ('base_url', 'email', 'token')}
    if any('\n' in value or '\r' in value for value in values.values()):
        raise ValueError('Jira properties must each be on one line.')
    options = jira_options(source)
    for key in ('autostart', 'show_logs', 'show_cache'):
        if key in payload:
            if not isinstance(payload[key], bool): raise ValueError(key + ' must be a boolean.')
            options[key] = payload[key]
    if spans:
        existing = source[spans[0][0]:spans[0][1]]
    else: existing = ''
    for key in options:
        if key in payload or re.search(r'\b' + key + r':', existing):
            values[key] = 'true' if options[key] else 'false'
    indent = spans[0][2] if spans else (4 if re.search(r'^Definitions:\s*$', source, re.M) else 0)
    pad = ' ' * indent
    block = pad + 'jira:\n' + ''.join(pad + '    ' + key + ': ' + value + '\n' for key, value in values.items()) if any(values[key] for key in ('base_url', 'email', 'token')) else ''
    if block:
        _, diagnostics = parse_jira_definitions(('Definitions:\n' if indent else '') + block)
        if diagnostics:
            raise ValueError(' '.join(diagnostics))
    if spans:
        start, end, _ = spans[0]
        # Preserve section comments and unfamiliar formatting around other metadata.
        comments = ''.join(line for line in source[start:end].splitlines(keepends=True)[1:] if not line.strip() or line.lstrip().startswith('#'))
        return source[:start] + block + comments + source[end:]
    return source + ('\n' if source and not source.endswith('\n') else '') + block


def jira_options(source):
    """View flags are metadata; absence keeps the log available, cache closed."""
    options = {'autostart': False, 'show_logs': True, 'show_cache': False}
    spans = jira_span(source)
    if len(spans) == 1:
        start, end, _ = spans[0]
        for key, value in re.findall(r'^\s+(autostart|show_logs|show_cache):\s*(true|false)\s*$', source[start:end], re.M):
            options[key] = value == 'true'
    return options
