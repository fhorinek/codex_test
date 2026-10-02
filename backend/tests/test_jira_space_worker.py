import sys
import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch, AsyncMock, Mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import y_py as Y
from jira import worker
from jira.config import JiraConfig
from space_tabs import TabStore
from jira.definitions import update_jira_definitions

class JiraSpaceWorkerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'spaces'; self.root.mkdir()
        self.store = TabStore(self.root)
        self.first = self.store.create_space('one', '% [SAME] One')
        self.second = self.store.create_space('personal/alice', '% [SAME] Two')
        self.disabled = self.store.create_space('disabled', '% [SAME] No')
        for space, token in ((self.first, 'ONE'), (self.second, 'TWO')):
            defs = self.store.defs(space)
            self.store.write(defs, update_jira_definitions('', {'base_url': 'https://jira.example.com', 'email': token+'@example.com', 'token': token}))
        self.store.mutate(self.second, 'close', {'id': self.store.document(self.second['id'])['id'], 'revision': self.second['revision']})
        self.store.mutate(self.second, 'close', {'id': self.store.defs(self.second)['id'], 'revision': self.second['revision']})
        self.sessions = {}
        for doc in self.store.data['documents'].values():
            ydoc = Y.YDoc(); worker.replace_ydoc_text(ydoc, self.store.read(doc))
            self.sessions[doc['id']] = SimpleNamespace(space_id=doc['id'], ydoc=ydoc, close=AsyncMock())

    async def test_spaces_use_independent_accounts_and_caches_including_closed_personal(self):
        seen = []
        async def opened(document): return self.sessions[document]
        async def synchronized(client, session, *args, **kwargs):
            seen.append((session.space_id, client.config.token, worker.JIRA_ACCOUNT_ID_BY_EMAIL.copy()))
            worker.JIRA_ACCOUNT_ID_BY_EMAIL['same@example.com'] = client.config.token
            return {'SAME'}
        with patch.object(worker, 'SPACES_DIR', self.root), patch.object(worker, 'worker_can_access_space', return_value=(True, '')), patch.object(worker, 'open_space_session', side_effect=opened), patch.object(worker, 'sync_space_with_jira', side_effect=synchronized), patch.object(worker, 'load_jira_config', side_effect=AssertionError('global fallback')):
            await worker.jira_sync_loop(one_shot=True)
        self.assertEqual([entry[1] for entry in seen], ['ONE', 'TWO'])
        self.assertEqual([entry[2] for entry in seen], [{}, {}])
        self.assertNotIn(self.store.document(self.disabled['id'])['id'], [entry[0] for entry in seen])
        self.assertTrue(all(session.close.await_count == 1 for session in self.sessions.values() if session.space_id in [entry[0] for entry in seen]))

    async def test_client_checks_current_config_on_event_loop_before_network(self):
        active = JiraConfig('https://jira.example.com', 'a@example.com', 'one')
        client = worker.SpaceJiraClient(active, lambda: JiraConfig())
        with patch.object(worker.JiraClient, '_request_once') as request:
            with self.assertRaisesRegex(RuntimeError, 'configuration changed'):
                await worker.run_blocking_io(client.get_issue, 'SAME-1')
            request.assert_not_called()
        client.cancelled.set()
        with self.assertRaises(RuntimeError): client._request('GET', '/anything')

    async def test_configuration_change_cancels_remaining_requests_and_resets_context(self):
        async def opened(document): return self.sessions[document]
        seen = []
        async def synchronized(client, session, *args, **kwargs):
            if client.config.token == 'ONE':
                defs = self.store.defs(self.first)
                worker.replace_ydoc_text(self.sessions[defs['id']].ydoc, '')
                await asyncio.sleep(0)
                self.assertTrue(client.cancelled.is_set())
                self.assertFalse(session.jira_config_current())
            seen.append(client.config.token)
            return set()
        with patch.object(worker, 'SPACES_DIR', self.root), patch.object(worker, 'worker_can_access_space', return_value=(True, '')), patch.object(worker, 'open_space_session', side_effect=opened), patch.object(worker, 'sync_space_with_jira', side_effect=synchronized):
            await worker.jira_sync_loop(one_shot=True)
        self.assertEqual(seen, ['ONE', 'TWO'])
