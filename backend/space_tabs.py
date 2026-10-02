"""File-backed space/tab catalogue. No application state is touched on import."""
from __future__ import annotations
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import threading
import time
import uuid

NAME = re.compile(r"[A-Za-z0-9_-]+\Z")
TAB = re.compile(r"(\.?)([0-9]{2,})_([A-Za-z0-9_-]+)\.txt\Z")
SPACE = re.compile(r"([0-9]{2,})_([A-Za-z0-9_-]+)\.space\Z")
SECTIONS = {"tags", "people", "states"}


def valid_appearance(values):
    return {key: value for key, value in values.items()
            if isinstance(value, str) and ((key == 'icon' and value)
                or (key == 'color' and re.fullmatch(r'#[0-9a-fA-F]{6}', value)))}


def rename_reference_tab(source, old, new):
    return re.sub(r'^(\s*%{2,3}[ \t]+)' + re.escape(old) + r'::',
                  lambda match: match[1] + new + '::', source, flags=re.MULTILINE)



def atomic(path: Path, text: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.tmp-' + uuid.uuid4().hex)
    try:
        temp.write_text(text, encoding='utf-8')
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def validate_name(name):
    if not isinstance(name, str) or not NAME.fullmatch(name) or name.lower() == 'defs':
        raise ValueError('Use letters, digits, underscores or hyphens; defs is reserved.')
    return name


def extract_definitions(source):
    lines = source.splitlines(keepends=True)
    shared, local = [], []
    take = False
    in_tasks = False
    for line in lines:
        if re.match(r'^\s*%', line):
            in_tasks = True
        if in_tasks:
            local.append(line)
            continue
        section = re.match(r'^ {4}([^\s:]+):\s*$', line)
        if section:
            take = section[1] in SECTIONS
        elif line.strip() and not line.startswith(' '):
            take = False
        (shared if take else local).append(line)
    return 'Definitions:\n' + ''.join(shared), ''.join(local)


def appearance(source):
    result, active, key = {}, False, None
    for line in source.splitlines():
        section = re.match(r'^ {4}([^\s:]+):\s*$', line)
        if section:
            active, key = section[1] == 'tabs', None
            continue
        if not active:
            continue
        match = re.match(r'^ {8}([A-Za-z0-9_-]+):\s*$', line)
        if match:
            key = match[1]
            result[key] = {}
        prop = re.match(r'^ {12}(icon|color):\s*(.*?)\s*$', line)
        if prop and key:
            result[key][prop[1]] = prop[2]
    return result


def edit_appearance(source, name, values=None, rename=None):
    """Edit one entry, leaving other sections and unrecognized lines untouched."""
    lines = source.splitlines()
    start = next((i for i, l in enumerate(lines) if l.strip() == 'tabs:' and l.startswith('    ') and not l.startswith('     ')), None)
    if start is None:
        if not values:
            return source
        first_task = next((i for i, l in enumerate(lines) if re.match(r'^\s*%', l)), len(lines))
        lines[first_task:first_task] = ['    tabs:']
        start = first_task
    end = next((i for i in range(start + 1, len(lines)) if lines[i].strip() and len(lines[i]) - len(lines[i].lstrip()) <= 4), len(lines))
    entry = next((i for i in range(start + 1, end) if lines[i] == f'        {name}:'), None)
    stop = end if entry is None else next((i for i in range(entry + 1, end) if lines[i].strip() and len(lines[i]) - len(lines[i].lstrip()) <= 8), end)
    if rename is not None:
        if entry is not None:
            lines[entry] = f'        {rename}:'
        return '\n'.join(lines) + '\n'
    if values is None:
        if entry is not None:
            del lines[entry:stop]
    else:
        if entry is None:
            entry = end
            lines.insert(entry, f'        {name}:')
            stop = entry + 1
        for prop, value in values.items():
            if prop not in {'icon', 'color'}:
                continue
            found = next((i for i in range(entry + 1, stop) if re.match(rf'^ {{12}}{prop}:', lines[i])), None)
            if found is not None:
                del lines[found]
                stop -= 1
            if value:
                lines.insert(stop, f'            {prop}: {value}')
                stop += 1
        if stop == entry + 1:
            del lines[entry]
    return '\n'.join(lines) + '\n'


class TabStore:
    def __init__(self, root: Path):
        self.root = root
        self.index_path = root.parent / 'space-index.json'
        self.journal_path = root.parent / 'space-tabs-journal.json'
        self.lock = threading.RLock()
        self.notices = []
        self.data = json.loads(self.index_path.read_text()) if self.index_path.exists() else {'version': 1, 'spaces': {}, 'documents': {}}
        self.recover()

    def save(self):
        atomic(self.index_path, json.dumps(self.data, indent=2, ensure_ascii=False))

    def safe_path(self, relative):
        path = self.root / relative
        if path.is_symlink() or any(p.is_symlink() for p in path.parents if p != self.root.parent):
            raise ValueError('Symlinks are not supported in space storage.')
        if not path.resolve().is_relative_to(self.root.resolve()):
            raise ValueError('Invalid storage path.')
        return path

    def transaction(self, writes, deletes=()):
        # The journal carries complete desired contents; replay is idempotent.
        plan = {'data': copy.deepcopy(self.data), 'writes': writes, 'deletes': list(deletes)}
        atomic(self.journal_path, json.dumps(plan, ensure_ascii=False))
        self.recover()

    def recover(self):
        if not self.journal_path.exists():
            return
        plan = json.loads(self.journal_path.read_text())
        for relative, text in plan['writes'].items():
            atomic(self.safe_path(relative), text)
        for relative in plan['deletes']:
            if relative not in plan['writes']:
                self.safe_path(relative).unlink(missing_ok=True)
        self.data = plan['data']
        for doc in self.data['documents'].values():
            path = self.path(doc)
            if path.exists() and str(path.relative_to(self.root)) in plan['writes']:
                doc['inode'] = path.stat().st_ino
                doc['disk_hash'] = digest(path.read_text(encoding='utf-8'))
                doc['pending_snapshot'] = doc['disk_hash']
        self.save()
        self.journal_path.unlink()

    def space(self, ref):
        if ref in self.data['spaces']:
            value = self.data['spaces'][ref]
            return None if value.get('deleted') else value
        if ref in self.data['documents']:
            return self.space(self.data['documents'][ref]['space_id'])
        matches = [s for s in self.data['spaces'].values() if not s.get('deleted') and ref in [s['path'], s['access'], *s.get('aliases', [])]]
        if not matches and '/' not in ref:
            matches = [s for s in self.data['spaces'].values() if not s.get('deleted') and s['name'] == ref]
        return matches[0] if len(matches) == 1 else None

    def document(self, ref):
        if ref in self.data['documents']:
            return self.data['documents'][ref]
        space = self.space(ref)
        return self.data['documents'].get(space['main']) if space else None

    def path(self, doc):
        space = self.data['spaces'][doc['space_id']]
        return self.safe_path(space['path'] + '/' + doc['filename'])

    def docs(self, space):
        return sorted((d for d in self.data['documents'].values() if d['space_id'] == space['id'] and not d.get('deleted')), key=lambda d: (d['kind'] != 'defs', d['order'], d['name']))

    def defs(self, space):
        return next(d for d in self.docs(space) if d['kind'] == 'defs')

    def new_doc(self, space, name, content, order=None, kind='task', closed=False):
        ident = 'doc_' + uuid.uuid4().hex
        order = order if order is not None else max((d['order'] for d in self.docs(space)), default=0) + 1
        filename = ('defs.txt' if kind == 'defs' else f'{order:02d}_{name}.txt')
        if closed:
            filename = '.' + filename
        doc = {'id': ident, 'space_id': space['id'], 'name': name, 'filename': filename, 'kind': kind, 'order': order, 'closed': closed, 'disk_hash': digest(content)}
        self.data['documents'][ident] = doc
        return doc

    def create_space(self, access, content='', folder_path=None, legacy_source=None):
        name = validate_name(access.split('/')[-1])
        parent = '/'.join(access.split('/')[:-1])
        folder = self.safe_path(parent)
        if any((match := SPACE.fullmatch(p.name)) and match[2].lower() == name.lower() for p in folder.glob('*.space')):
            raise ValueError('A space folder with this name already exists.')
        order = max([int(m[1]) for p in folder.glob('*.space') if (m := SPACE.fullmatch(p.name))] or [0]) + 1
        target = folder_path or ((parent + '/') if parent else '') + f'{order:02d}_{name}.space'
        if self.safe_path(target).exists():
            raise ValueError('Destination already exists.')
        ident = 'space_' + uuid.uuid4().hex
        space = {'id': ident, 'name': name, 'path': target, 'access': access, 'aliases': [access], 'revision': 1}
        if legacy_source:
            space.update(legacy_source=legacy_source, legacy_history=access)
        self.data['spaces'][ident] = space
        definitions, tasks = extract_definitions(content)
        main = self.new_doc(space, 'main', tasks, 1)
        defs = self.new_doc(space, 'defs', definitions, 0, 'defs')
        space['main'] = main['id']
        self.transaction({f'{target}/{main["filename"]}': tasks, f'{target}/defs.txt': definitions})
        return self.data["spaces"][ident]

    def migrate(self, recover_text=None):
        with self.lock:
            # Do not descend into converted spaces or arbitrary symlink trees.
            files = sorted(p for p in self.root.rglob('*.txt') if not any(x.name.endswith('.space') for x in p.parents) and not p.is_symlink())
            for path in files:
                self.safe_path(str(path.relative_to(self.root)))
                if not NAME.fullmatch(path.stem):
                    continue
                relative = path.relative_to(self.root).as_posix()
                access = relative[:-4]
                if self.space(access):
                    if self.space(access).get('legacy_source') != relative:
                        raise ValueError(f'Legacy space collides with an existing space: {relative}')
                    # A completed migration journal may leave its source behind.
                    path.unlink()
                    continue
                backup = self.root.parent / 'space-migration-backup' / relative
                if not backup.exists():
                    backup.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(path, backup)
                content = recover_text(access, path.read_text()) if recover_text else path.read_text()
                space = self.create_space(access, content, legacy_source=relative)
                space['legacy_history'] = access
                self.save()
                path.unlink()
            self.save()

    def read(self, doc):
        return self.path(doc).read_text(encoding='utf-8')

    def write(self, doc, text):
        with self.lock:
            doc = self.data['documents'].get(doc['id'], doc)
            if doc.get('deleted'):
                raise ValueError('Tab was deleted.')
            space = self.space(doc['space_id'])
            path = self.path(doc)
            if not path.exists() and doc.get('inode'):
                renamed = next((p for p in path.parent.iterdir() if p.is_file() and not p.is_symlink() and p.stat().st_ino == doc['inode']
                                and (TAB.fullmatch(p.name) or p.name in {'defs.txt', '.defs.txt'})), None)
                if renamed:
                    old_name = doc['name']
                    self.filename(doc, renamed.name)
                    path = self.path(doc)
                    if old_name != doc['name']:
                        # A background snapshot can observe a rename before the watcher.
                        # Let reconciliation update defs and its live collaborative room together.
                        doc.setdefault('appearance_rename_from', old_name)
                    space['revision'] += 1
                elif doc['kind'] != 'defs':
                    doc['deleted'] = True
                    if digest(text) != doc.get('disk_hash'):
                        recovery = self.new_doc(space, self.recovery_name(space, doc['name']), text)
                        self.write(recovery, text)
                        self.notices.append(f'Preserved edits to deleted tab {doc["name"]} as {recovery["name"]}.')
                    space['revision'] += 1
                    self.save()
                    return
            if path.exists():
                disk = path.read_text(encoding='utf-8')
                if digest(disk) != doc.get('disk_hash') and disk != text:
                    recovery = self.new_doc(space, self.recovery_name(space, doc['name']), disk)
                    self.write(recovery, disk)
                    space['revision'] += 1
                    self.notices.append(f'External edits to {doc["name"]} saved as {recovery["name"]}.')
            atomic(path, text)
            doc['disk_hash'] = digest(text)
            doc['inode'] = path.stat().st_ino
            self.save()

    def listing(self, space, read=None):
        read = read or self.read
        looks = appearance(read(self.defs(space)))
        return {'id': space['id'], 'name': space['name'], 'path': space['path'], 'access': space['access'], 'revision': space['revision'], 'tabs': [{**{k: d[k] for k in ('id', 'name', 'filename', 'kind', 'order', 'closed')}, 'appearance': valid_appearance(looks.get(d['name'], {}))} for d in self.docs(space)]}

    def mutate(self, space, action, payload, read=None):
        read = read or self.read
        with self.lock:
            if payload.get('revision') != space['revision']:
                raise ValueError('Tabs changed. Refresh and try again.')
            before = copy.deepcopy(self.data)
            try:
                docs = self.docs(space)
                doc = next((d for d in docs if d['id'] == payload.get('id')), None)
                definitions = self.defs(space)
                defs_text = read(definitions)
                writes, deletes = {}, []
                result = None
                if action in {'add', 'copy'}:
                    name = validate_name(payload.get('name'))
                    if any(d['name'].lower() == name.lower() for d in docs):
                        raise ValueError('Tab name already exists.')
                    if action == 'copy' and (not doc or doc['kind'] == 'defs'):
                        raise ValueError('Cannot copy this tab.')
                    result = self.new_doc(space, name, '')
                    writes[str(self.path(result).relative_to(self.root))] = read(doc) if action == 'copy' else ''
                    if doc and action == 'copy':
                        defs_text = edit_appearance(defs_text, name, appearance(defs_text).get(doc['name'], {}))
                        order = [d for d in docs if d['kind'] != 'defs']
                        order.insert(order.index(doc) + 1, result)
                    else:
                        order = []
                elif action == 'reorder':
                    ids = payload.get('ids', [])
                    opened = [d for d in docs if d['kind'] != 'defs' and not d['closed']]
                    if len(ids) != len(set(ids)) or set(ids) != {d['id'] for d in opened}:
                        raise ValueError('Reorder must include each open task tab once.')
                    by_id = {d['id']: d for d in opened}
                    iterator = iter(ids)
                    order = [d if d['closed'] else by_id[next(iterator)] for d in docs if d['kind'] != 'defs']
                else:
                    order = []
                    if not doc:
                        raise ValueError('Tab not found.')
                    if doc['kind'] == 'defs' and action not in {'close', 'open', 'appearance'}:
                        raise ValueError('The definitions tab cannot be renamed, copied, deleted or reordered.')
                    old = str(self.path(doc).relative_to(self.root))
                    if action in {'close', 'open', 'rename'}:
                        content = read(doc)
                        if action == 'rename':
                            name = validate_name(payload.get('name'))
                            if any(d['id'] != doc['id'] and d['name'].lower() == name.lower() for d in docs):
                                raise ValueError('Tab name already exists.')
                            defs_text = edit_appearance(defs_text, doc['name'], rename=name)
                            for sibling in docs:
                                if sibling['kind'] != 'task':
                                    continue
                                text = read(sibling)
                                updated = rename_reference_tab(text, doc['name'], name)
                                if sibling['id'] == doc['id']:
                                    content = updated
                                elif updated != text:
                                    writes[str(self.path(sibling).relative_to(self.root))] = updated
                            doc['name'] = name
                        else:
                            doc['closed'] = action == 'close'
                        doc['filename'] = ('.' if doc['closed'] else '') + ('defs.txt' if doc['kind'] == 'defs' else f'{doc["order"]:02d}_{doc["name"]}.txt')
                        writes[str(self.path(doc).relative_to(self.root))] = content
                        deletes.append(old)
                    elif action == 'delete':
                        doc['deleted'] = True
                        deletes.append(old)
                        defs_text = edit_appearance(defs_text, doc['name'])
                    elif action == 'appearance':
                        values = payload.get('appearance', {})
                        if not isinstance(values, dict):
                            raise ValueError('Invalid appearance.')
                        color, icon = values.get('color', ''), values.get('icon', '')
                        if not isinstance(color, str) or (color and not re.fullmatch(r'#[0-9a-fA-F]{6}', color)):
                            raise ValueError('Choose a valid color.')
                        if not isinstance(icon, str) or len(icon.splitlines()) > 1 or '\n' in icon or '\r' in icon:
                            raise ValueError('Use a single line of text for the icon.')
                        defs_text = edit_appearance(defs_text, doc['name'], values)
                    else:
                        raise ValueError('Unknown tab operation.')
                # Read all contents before changing any paths.
                contents = [(d, str(self.path(d).relative_to(self.root)), writes.get(str(self.path(d).relative_to(self.root)), '') if d is result else read(d)) for d in order]
                for number, (d, old, text) in enumerate(contents, 1):
                    d['order'] = number
                    d['filename'] = ('.' if d['closed'] else '') + f'{number:02d}_{d["name"]}.txt'
                    writes[str(self.path(d).relative_to(self.root))] = text
                    deletes.append(old)
                writes[str(self.path(definitions).relative_to(self.root))] = defs_text
                space['revision'] += 1
                self.transaction(writes, deletes)
                return result
            except Exception:
                if not self.journal_path.exists():
                    self.data = before
                raise

    def reconcile(self, live=None):
        """Import filesystem changes; return changed IDs and user-visible notices."""
        live = live or (lambda d: self.read(d) if self.path(d).exists() else None)
        changed, notices = [], self.notices[:]
        self.notices.clear()
        with self.lock:
            for space in list(self.data['spaces'].values()):
                if space.get('deleted'): continue
                directory = self.safe_path(space['path'])
                if not directory.exists():
                    notices.append(f'Space folder missing: {space["path"]}')
                    continue
                files = {}
                for path in directory.iterdir():
                    if path.is_symlink() or not path.is_file():
                        continue
                    if path.name in {'defs.txt', '.defs.txt'} or TAB.fullmatch(path.name):
                        files[path.name] = path
                    elif path.suffix == '.txt':
                        notices.append(f'Ignored invalid tab filename: {path.name}')
                if 'defs.txt' in files and '.defs.txt' in files:
                    notices.append(f'{space["name"]}: both defs.txt and .defs.txt exist.')
                    continue
                names = [TAB.fullmatch(name)[3].lower() for name in files if TAB.fullmatch(name)]
                if len(names) != len(set(names)) or 'defs' in names:
                    notices.append(f'{space["name"]}: duplicate or reserved tab filenames.')
                    continue
                known = self.docs(space)
                # Match exact paths or inodes for external rename, never guess by content.
                matches = {}
                for doc in known:
                    path = files.get(doc['filename'])
                    if path is None:
                        path = next((p for p in files.values() if p.stat().st_ino == doc.get('inode')), None)
                    if path:
                        matches[doc['id']] = path
                used = set(matches.values())
                for doc in known:
                    old_text = live(doc)
                    path = matches.get(doc['id'])
                    if path is None:
                        if doc['kind'] == 'defs':
                            self.write(doc, old_text or '')
                            changed.append(doc['id'])
                        else:
                            if old_text is not None and digest(old_text) != doc.get('disk_hash'):
                                recovery = self.new_doc(space, self.recovery_name(space, doc['name']), old_text)
                                self.write(recovery, old_text)
                                notices.append(f'Preserved edits to deleted tab {doc["name"]}.')
                            doc['deleted'] = True
                            changed.append(doc['id'])
                        continue
                    if path.name != doc['filename'] or doc.get('appearance_rename_from'):
                        previous = doc.pop('appearance_rename_from', doc['name'])
                        self.filename(doc, path.name)
                        defs = self.defs(space)
                        self.write(defs, edit_appearance(live(defs) or "", previous, rename=doc['name']))
                        changed.extend([doc['id'], defs['id']])
                    text = path.read_text(encoding='utf-8')
                    if digest(text) != doc.get('disk_hash'):
                        if old_text is not None and digest(old_text) not in {doc.get('disk_hash'), digest(text)}:
                            recovery = self.new_doc(space, self.recovery_name(space, doc['name']), text)
                            self.write(recovery, text)
                            doc['disk_hash'] = digest(text)
                            self.write(doc, old_text)
                            notices.append(f'External edits to {doc["name"]} saved as {recovery["name"]}.')
                            changed.append(recovery['id'])
                        else:
                            doc['disk_hash'] = digest(text)
                            doc['pending_snapshot'] = doc['disk_hash']
                            changed.append(doc['id'])
                    doc['inode'] = path.stat().st_ino
                for path in files.values():
                    if path in used:
                        continue
                    match = TAB.fullmatch(path.name)
                    if not match or match[3].lower() == 'defs' or any(d['name'].lower() == match[3].lower() for d in self.docs(space)):
                        notices.append(f'Ignored duplicate or invalid tab: {path.name}')
                        continue
                    doc = self.new_doc(space, match[3], path.read_text(), int(match[2]), closed=bool(match[1]))
                    doc['filename'], doc['inode'] = path.name, path.stat().st_ino
                    changed.append(doc['id'])
                if changed:
                    space['revision'] += 1
            if changed:
                self.save()
        return list(set(changed)), list(set(notices))

    def recovery_name(self, space, name):
        candidate = name + '_recovery'
        names = {d['name'] for d in self.docs(space)}
        number = 2
        while candidate in names:
            candidate = f'{name}_recovery_{number}'
            number += 1
        return candidate

    @staticmethod
    def filename(doc, filename):
        if filename in {'defs.txt', '.defs.txt'}:
            doc.update(filename=filename, closed=filename.startswith('.'))
        else:
            match = TAB.fullmatch(filename)
            if not match:
                raise ValueError('Invalid tab filename.')
            doc.update(filename=filename, closed=bool(match[1]), order=int(match[2]), name=match[3])

    def relocate(self, space, name=None, folder=None):
        with self.lock:
            name = validate_name(name or space['name'])
            parent = '/'.join(space['access'].split('/')[:-1]) if folder is None else folder
            destination_parent = self.safe_path(parent)
            if not destination_parent.is_dir():
                raise ValueError('Folder not found.')
            access = f'{parent}/{name}' if parent else name
            collision = self.space(access)
            if collision and collision['id'] != space['id']:
                raise ValueError('Space already exists.')
            old_path, old_access = space['path'], space['access']
            order = int(SPACE.fullmatch(Path(old_path).name)[1])
            if parent != '/'.join(old_access.split('/')[:-1]):
                order = max([int(m[1]) for p in destination_parent.glob('*.space') if (m := SPACE.fullmatch(p.name))] or [0]) + 1
            target = (parent + '/' if parent else '') + f'{order:02d}_{name}.space'
            if target != old_path and self.safe_path(target).exists():
                raise ValueError('Space already exists.')
            docs = self.docs(space)
            contents = [(d, self.read(d)) for d in docs]
            space.update(path=target, access=access, name=name, revision=space['revision'] + 1)
            if old_access not in space['aliases']: space['aliases'].append(old_access)
            writes = {f'{target}/{d["filename"]}': text for d, text in contents}
            self.transaction(writes, [f'{old_path}/{d["filename"]}' for d, _ in contents])
            if target != old_path:
                self.safe_path(old_path).rmdir()
            return old_access, access


def resolved_definition_source(local, shared):
    """Resolve only explicit properties; never prepend text to a task document."""
    def parse(text):
        data = {section: {} for section in SECTIONS}
        section = key = None
        for line in text.splitlines():
            if re.match(r'^\s*%', line): break
            header = re.match(r'^ {4}([^\s:]+):\s*$', line)
            if header:
                section, key = header[1], None
                continue
            entry = re.match(r'^ {8}([^\s:]+)(?::\s*(.*))?$', line)
            if entry and section in data:
                key = entry[1]
                data[section][key] = {'name': entry[2]} if entry[2] else {}
            prop = re.match(r'^ {12}([^\s:]+):\s*(.*)$', line)
            if prop and section in data and key:
                name = prop[1].lower().replace('_', '').replace('-', '')
                name = {'email': 'mail', 'jirastate': 'jira'}.get(name, name)
                data[section][key][name] = prop[2]
        return data
    merged, own = parse(shared), parse(local)
    for section in SECTIONS:
        for key, value in own[section].items(): merged[section].setdefault(key, {}).update(value)
    lines = ['Definitions:']
    for section in ['tags', 'people', 'states']:
        lines.append(f'    {section}:')
        for key, props in merged[section].items():
            lines.append(f'        {key}:')
            lines.extend(f'            {name}: {value}' for name, value in props.items())
    return '\n'.join(lines)
