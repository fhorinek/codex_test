import sys
import unittest
from pathlib import Path
from unittest.mock import patch, Mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
import test_tab_api
from jira.definitions import update_jira_definitions
from jira.import_preview import transform_issues
from jira.worker import parse_space_tasks

CONFIG = {'base_url': 'https://jira.example.com', 'email': 'a@example.com', 'token': 'SECRET'}
def issue(key='DEMO-12', title='Import task', children=None):
    return {'key': key, 'fields': {'summary': title, 'description': {'type': 'doc', 'version': 1, 'content': [{'type': 'paragraph', 'content': [{'type': 'text', 'text': 'Hello {DEMO-13}'}]}]}, 'status': {'name': 'In Progress'}, 'labels': ['urgent'], 'assignee': {'displayName': 'Anna', 'emailAddress': 'anna@example.com'}, 'issuetype': {'name': 'Task'}, 'timeoriginalestimate': 7200, 'subtasks': children or []}}

class JiraImportTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        test_tab_api.TabApiTests.setUp(self)
        self.store.write(self.store.defs(self.space), update_jira_definitions('states:\n    doing:\n        name: Doing\n        jira: In Progress\npeople:\n    anna:\n        name: Anna\n        mail: anna@example.com\n', CONFIG))
        async def immediate(fn, *args, **kwargs): return fn(*args, **kwargs)
        patcher = patch.object(server, 'run_blocking_io', side_effect=immediate); patcher.start(); self.addCleanup(patcher.stop)

    async def test_transform_reuses_mappings_adf_estimates_types_and_hierarchy(self):
        shared = self.store.read(self.store.defs(self.space))
        result = transform_issues([issue(children=[{'key': 'DEMO-13'}]), issue('DEMO-13', 'Child')], '', shared)
        self.assertEqual(result['definitions'], [])
        self.assertEqual(result['tasks'][0]['state'], 'doing')
        self.assertEqual(result['tasks'][0]['people'], ['anna'])
        self.assertEqual(result['tasks'][0]['story_points'], 2)
        self.assertEqual(result['tasks'][0]['tags'], ['task', 'urgent'])
        self.assertIn('Hello {Child}', result['script'])
        tasks = parse_space_tasks(result['script'].split('\n'))
        self.assertEqual([task.jira_key for task in tasks], ['DEMO-12', 'DEMO-13'])
        self.assertEqual(tasks[1].indent, '    ')
        self.assertNotIn('token:', result['script'])
        new = transform_issues([issue()], '% Existing', '')
        self.assertEqual([definition['kind'] for definition in new['definitions']], ['state', 'person'])

    async def test_preview_and_optional_children_never_write_documents(self):
        root = issue(children=[{'key': 'DEMO-13'}]); child = issue('DEMO-13', 'Child')
        main = self.store.document(self.space['id']); before = self.store.read(main)
        with patch.object(server.JiraClient, 'get_issue', side_effect=lambda key: ({'DEMO-12': root, 'DEMO-13': child}[key], 200)) as request:
            preview = await server.read_jira_import_preview(self.space['id'], main['id'], 'DEMO-12', False, self.user)
            self.assertEqual(preview['subtask_count'], 1); self.assertEqual(len(preview['tasks']), 1)
            request.assert_called_once_with('DEMO-12')
            preview = await server.read_jira_import_preview(self.space['id'], main['id'], 'DEMO-12', True, self.user)
            self.assertEqual(len(preview['tasks']), 2)
        self.assertEqual(self.store.read(main), before)

    async def test_invalid_keys_authorization_missing_issues_and_cross_space_document(self):
        sid = self.space['id']; main = self.store.document(sid)
        with patch.object(server.JiraClient, 'get_issue', return_value=(None, 404)) as request:
            for key in ('DEMO', 'DEMO-', 'DEMO-0', '../DEMO-1', 'DEMO-12?'):
                with self.assertRaises(server.HTTPException) as error: await server.read_jira_import_preview(sid, main['id'], key, False, self.user)
                self.assertEqual(error.exception.status_code, 400)
            request.assert_not_called()
            with self.assertRaises(server.HTTPException): await server.read_jira_import_preview(sid, main['id'], 'DEMO-12', False, server.AuthUser('bob', 'Bob', 'user', ()))
            request.assert_not_called()
            with self.assertRaises(server.HTTPException) as error: await server.read_jira_import_preview(sid, main['id'], 'DEMO-12', False, self.user)
            self.assertEqual(error.exception.status_code, 404)
        other = self.store.create_space('other', '')
        with self.assertRaises(server.HTTPException): await server.read_jira_import_preview(sid, self.store.document(other['id'])['id'], 'DEMO-12', False, self.user)

    async def test_changes_during_lookup_require_new_preview(self):
        main = self.store.document(self.space['id'])
        def fetch(key):
            self.store.write(main, '% Changed')
            return issue(), 200
        with patch.object(server.JiraClient, 'get_issue', side_effect=fetch):
            with self.assertRaises(server.HTTPException) as error: await server.read_jira_import_preview(self.space['id'], main['id'], 'DEMO-12', False, self.user)
            self.assertEqual(error.exception.status_code, 409)
