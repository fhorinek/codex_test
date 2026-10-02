import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from jira.daemon import JiraDaemons
from jira.definitions import jira_options, parse_jira_definitions, update_jira_definitions
from jira import worker
from space_tabs import TabStore

CONFIG = {'base_url': 'https://jira.example.com', 'email': 'test@example.com', 'token': 'SECRET'}

class JiraDaemonTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'spaces'; self.root.mkdir()
        self.store = TabStore(self.root)
        self.space = self.store.create_space('team/project', '% Task')
        self.source = update_jira_definitions('', CONFIG)
        self.manager = JiraDaemons(lambda: self.store, lambda sid: self.source, lambda: {'TEST_ENV': 'yes'})

    async def test_flags_validation_preservation_and_clear(self):
        self.assertEqual(jira_options(self.source), {'autostart': False, 'show_logs': True, 'show_cache': False})
        source = update_jira_definitions(self.source, {'autostart': True, 'show_logs': False, 'show_cache': True})
        self.assertTrue(parse_jira_definitions(source)[0].enabled)
        changed = update_jira_definitions(source, {'token': 'NEW'})
        self.assertEqual(jira_options(changed), {'autostart': True, 'show_logs': False, 'show_cache': True})
        self.assertFalse(parse_jira_definitions(update_jira_definitions(changed, dict.fromkeys(CONFIG, '')))[0].enabled)
        self.assertFalse(parse_jira_definitions(source.replace('autostart: true', 'autostart: maybe'))[0].enabled)
        with self.assertRaises(ValueError): update_jira_definitions(source, {'show_cache': 'false'})

    async def test_autostart_once_manual_stop_and_removal(self):
        self.manager.command = AsyncMock()
        await self.manager.reconcile(); self.manager.command.assert_not_called()
        self.source = update_jira_definitions(self.source, {'autostart': True})
        await self.manager.reconcile(); await self.manager.reconcile()
        self.manager.command.assert_awaited_once_with(self.space['id'], 'start')
        self.source = update_jira_definitions(self.source, {'autostart': False})
        await self.manager.reconcile()
        self.source = update_jira_definitions(self.source, {'autostart': True})
        await self.manager.reconcile()
        self.assertEqual(self.manager.command.await_count, 2)
        self.manager.processes[self.space['id']] = SimpleNamespace(returncode=None)
        self.source = ''
        await self.manager.reconcile()
        self.manager.command.assert_awaited_with(self.space['id'], 'stop')

    async def test_lifecycle_scoped_process_and_redacted_logs(self):
        class Process:
            def __init__(self):
                self.returncode = None
                self.stdin = SimpleNamespace(write=lambda value: writes.append(value), drain=AsyncMock())
                self.stdout = asyncio.StreamReader(); self.stdout.feed_data(b'account test@example.com token SECRET\n')
            def terminate(self): self.returncode = 0; self.stdout.feed_eof()
            def kill(self): self.terminate()
            async def wait(self): return self.returncode
        writes = []; spawned = []
        async def spawn(*args, **kwargs):
            spawned.append((args, kwargs)); return Process()
        with patch('jira.daemon.asyncio.create_subprocess_exec', side_effect=spawn):
            sid = self.space['id']
            await self.manager.command(sid, 'start'); await asyncio.sleep(0)
            self.assertTrue(self.manager.status(sid)['running'])
            self.assertIn(sid, spawned[0][0]); self.assertNotIn('SECRET', str(spawned))
            await self.manager.command(sid, 'sync'); self.assertEqual(writes, [b'sync\n'])
            await self.manager.command(sid, 'restart'); self.assertEqual(len(spawned), 2)
            await self.manager.shutdown()
            self.assertFalse(self.manager.status(sid)['running'])
            self.assertNotIn('SECRET', '\n'.join(self.manager.status(sid)['logs']))
            self.assertEqual(self.manager.status('another')['logs'], [])
        self.source = ''
        with self.assertRaises(ValueError): await self.manager.command(sid, 'start')

    async def test_space_local_creation_cache_migrates_legacy_and_cache_view(self):
        doc = self.store.document(self.space['id'])
        identity = json.dumps([doc['id'], 'Task', 'DEMO'])
        legacy = self.root.parent / 'jira-created-issues.json'
        legacy.write_text(json.dumps({identity: {'key': 'DEMO-1'}, json.dumps(['other', 'Task', 'DEMO']): {'key': 'DEMO-2'}}))
        with patch.object(worker, 'SPACES_DIR', self.root):
            self.assertEqual(worker.recovered_created_issue(doc['id'], 'Task', 'DEMO'), 'DEMO-1')
            path = worker.creation_journal_path(doc['id'])
            self.assertEqual(path.parent, self.store.path(doc).parent)
            self.assertNotIn(identity, json.loads(legacy.read_text()))
            self.assertEqual(self.manager.cache(self.space['id'])['jira-created-issues.json'][identity]['key'], 'DEMO-1')
            worker.forget_created_issue(doc['id'], 'DEMO-1')
            self.assertEqual(json.loads(path.read_text()), {})

    async def test_managed_sync_interrupts_sleep(self):
        event = asyncio.Event()
        with patch.object(worker, 'MANAGED_SYNC', event):
            pending = asyncio.create_task(worker.sleep_until_next_sync(100))
            event.set()
            self.assertTrue(await asyncio.wait_for(pending, 1))
            self.assertFalse(event.is_set())
            self.assertFalse(await worker.sleep_until_next_sync(.001))
