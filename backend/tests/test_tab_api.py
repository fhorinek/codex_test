import sys
import asyncio
import os
import time
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
from space_tabs import TabStore
from fastapi import HTTPException

class TabApiTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.spaces = self.root / 'spaces'; self.spaces.mkdir()
        self.store = TabStore(self.spaces)
        self.space = self.store.create_space('team/demo', 'Board:\n    tags:\n        old:\n            background: #123456\n% Task\n#old')
        for name, value in [('SPACES_DIR', self.spaces), ('_tab_store', self.store), ('HISTORY_DIR', self.root / 'history'), ('YSTORE_DIR', self.root / 'ystore')]:
            patcher = patch.object(server, name, value); patcher.start(); self.addCleanup(patcher.stop)
        patcher = patch.object(server, 'load_users_store', return_value={'alice': {}}); patcher.start(); self.addCleanup(patcher.stop)
        patcher = patch.object(server, 'publish_tab_changes', new_callable=__import__('unittest.mock', fromlist=['AsyncMock']).AsyncMock); patcher.start(); self.addCleanup(patcher.stop)
        self.user = server.AuthUser('alice', 'Alice', 'user', ('team/*',))

    async def test_document_authorization_and_stable_storage(self):
        main = self.store.document(self.space['id'])
        self.assertTrue(server.can_access_space(self.user, main['id']))
        outsider = server.AuthUser('bob', 'Bob', 'user', ())
        self.assertFalse(server.can_access_space(outsider, main['id']))
        with self.assertRaises(HTTPException): await server.get_tab_space(main['id'], outsider)
        store_before = server.ystore_path(main['id'])
        await server.change_tab(self.space['id'], 'rename', {'id': main['id'], 'name': 'plan', 'revision': self.space['revision']}, self.user)
        self.assertEqual(server.ystore_path(main['id']), store_before)
        self.assertEqual(server.space_path(main['id']).name, '01_plan.txt')
        self.assertEqual(server.room_name('demo', space_path_hint='team/demo'), '/ws/' + main['id'])

    async def test_compare_and_swap_and_history_defs(self):
        listing = await server.tab_contents(self.space['id'], self.user)
        defs = next(d for d in listing['documents'] if d['kind'] == 'defs')
        original = defs['text']
        await server.change_shared_definitions(self.space['id'], {'changes': [{'id': defs['id'], 'expected': original, 'text': original.replace('#123456', '#ffffff')}]}, self.user)
        with self.assertRaises(HTTPException) as error:
            await server.change_shared_definitions(self.space['id'], {'changes': [{'id': defs['id'], 'expected': original, 'text': 'stale'}]}, self.user)
        self.assertEqual(error.exception.status_code, 409)
        main = self.store.document(self.space['id'])
        checkpoint = server.create_history_checkpoint(main['id'], self.store.read(main))
        source = server.read_history_definitions(main['id'], checkpoint['id'], self.user)
        self.assertIn(b'#ffffff', source.body)
        self.assertNotIn('Definitions:', server.read_history_checkpoint(main['id'], checkpoint['id']))

    async def test_restart_recovers_committed_snapshot_before_stale_collaboration(self):
        main = self.store.document(self.space['id'])
        path = server.ystore_path(main['id'])
        path.parent.mkdir(parents=True, exist_ok=True)
        old = server.Y.YDoc()
        server.replace_ydoc_text(old, '% Original')
        await server.FileYStore(str(path)).encode_state_as_update(old)
        target = '% Updated by shared rename\n#new'
        self.store.transaction({str(self.store.path(main).relative_to(self.spaces)): target})
        room = server.YRoom(ready=False, ystore=server.FileYStore(str(path)))
        with patch.object(server, 'schedule_space_snapshot'):
            await server.hydrate_room_from_storage(main['id'], room)
        self.assertEqual(server.ydoc_to_text(room.ydoc), target)
        persisted = server.Y.YDoc()
        await server.FileYStore(str(path)).apply_updates(persisted)
        self.assertEqual(server.ydoc_to_text(persisted), target)
        self.assertNotIn('pending_snapshot', self.store.document(main['id']))

    async def test_restart_keeps_newer_regular_snapshot_and_backs_up_stale_store(self):
        main = self.store.document(self.space['id'])
        path = server.ystore_path(main['id'])
        old = server.Y.YDoc()
        server.replace_ydoc_text(old, '% Several days old')
        await server.FileYStore(str(path)).encode_state_as_update(old)
        target = '% Latest saved task\n@anna'
        self.store.write(main, target)
        main.pop('pending_snapshot', None)
        stamp = time.time() + 1
        os.utime(self.store.path(main), (stamp, stamp))
        self.store.save()
        room = server.YRoom(ready=False, ystore=server.FileYStore(str(path)))
        await server.hydrate_room_from_storage(main['id'], room)
        self.assertEqual(server.ydoc_to_text(room.ydoc), target)
        persisted = server.Y.YDoc()
        await server.FileYStore(str(path)).apply_updates(persisted)
        self.assertEqual(server.ydoc_to_text(persisted), target)
        backups = [entry for entry in server.load_history_index(main['id'])
                   if entry.get('label') == 'Startup recovery: alternate saved version']
        self.assertEqual(len(backups), 1)
        self.assertEqual(server.read_history_checkpoint(main['id'], backups[0]['id']), '% Several days old')

    async def test_restart_keeps_newer_collaboration_updates_after_crash(self):
        main = self.store.document(self.space['id'])
        previous = self.store.read(main)
        main.pop('pending_snapshot', None)
        os.utime(self.store.path(main), (1, 1))
        latest = server.Y.YDoc()
        server.replace_ydoc_text(latest, '% Not yet snapshotted')
        path = server.ystore_path(main['id'])
        await server.FileYStore(str(path)).encode_state_as_update(latest)
        room = server.YRoom(ready=False, ystore=server.FileYStore(str(path)))
        await server.hydrate_room_from_storage(main['id'], room)
        self.assertEqual(server.ydoc_to_text(room.ydoc), '% Not yet snapshotted')
        backup = server.load_history_index(main['id'])[-1]
        self.assertEqual(server.read_history_checkpoint(main['id'], backup['id']), previous)

    async def test_shutdown_flush_persists_room_without_pending_debounce(self):
        main = self.store.document(self.space['id'])
        path = server.ystore_path(main['id'])
        room = server.YRoom(ready=False, ystore=server.FileYStore(str(path)))
        await server.hydrate_room_from_storage(main['id'], room)
        server.replace_ydoc_text(room.ydoc, '% Last edit before shutdown 🦄')
        with patch.object(server.websocket_server, 'rooms', {server.room_name(main['id']): room}):
            await server.flush_persistent_rooms()
        self.assertEqual(self.store.read(main), '% Last edit before shutdown 🦄')
        persisted = server.Y.YDoc()
        await server.FileYStore(str(path)).apply_updates(persisted)
        self.assertEqual(server.ydoc_to_text(persisted), self.store.read(main))

    async def test_snapshot_read_does_not_cancel_its_own_save(self):
        main = self.store.document(self.space['id'])
        path = server.ystore_path(main['id'])
        room = server.YRoom(ready=False, ystore=server.FileYStore(str(path)))
        await server.hydrate_room_from_storage(main['id'], room)
        with patch.object(server.websocket_server, 'rooms', {server.room_name(main['id']): room}), \
                patch.object(server, 'SPACE_SAVE_DELAY', 0.01):
            server.attach_snapshot_hook(main['id'], room)
            server.replace_ydoc_text(room.ydoc, '% Saved after debounce')
            task = server.space_save_tasks[server.room_name(main['id'])]
            await task
            self.assertEqual(self.store.read(main), '% Saved after debounce')
            self.assertNotIn(server.room_name(main['id']), server.space_save_tasks)
            persisted = server.Y.YDoc()
            await server.FileYStore(str(path)).apply_updates(persisted)
            self.assertEqual(server.ydoc_to_text(persisted), '% Saved after debounce')

    async def test_multi_document_transfer_is_atomic_and_authorized(self):
        main = self.store.document(self.space['id'])
        other = self.store.mutate(self.space, 'add', {'name': 'other', 'revision': self.space['revision']})
        original = self.store.read(main)
        changes = [{'id': main['id'], 'expected': original, 'text': ''},
                   {'id': other['id'], 'expected': 'stale', 'text': original}]
        with self.assertRaises(HTTPException) as error:
            await server.change_shared_definitions(self.space['id'], {'changes': changes}, self.user)
        self.assertEqual(error.exception.status_code, 409)
        self.assertEqual(self.store.read(main), original)
        changes[1]['expected'] = ''
        outsider = server.AuthUser('bob', 'Bob', 'user', ())
        with self.assertRaises(HTTPException):
            await server.change_shared_definitions(self.space['id'], {'changes': changes}, outsider)
        await server.change_shared_definitions(self.space['id'], {'changes': changes}, self.user)
        self.assertEqual(self.store.read(main), '')
        self.assertEqual(self.store.read(other), original)

    async def test_startup_migration_recovers_latest_nested_and_personal_content(self):
        nested = self.spaces / 'nested'; nested.mkdir()
        personal = self.spaces / 'personal'; personal.mkdir()
        (nested / 'project.txt').write_text('% stale disk')
        (personal / 'alice.txt').write_text('')
        legacy_store = server.YSTORE_DIR / 'nested/project.ystore'
        latest = server.Y.YDoc()
        source = 'Board:\n    tags:\n        urgent:\n            background: #123456\n% Latest collaborative task\n'
        server.replace_ydoc_text(latest, source)
        await server.FileYStore(str(legacy_store)).encode_state_as_update(latest)
        old_history = server.HISTORY_DIR / 'nested/project'
        old_history.mkdir(parents=True)
        (old_history / 'old.txt').write_text('% Historical task')
        with patch.object(server, 'schedule_space_snapshot'):
            await server.migrate_tab_spaces()
        migrated = server.tab_store()
        project = migrated.space('nested/project')
        main = migrated.document(project['id'])
        self.assertEqual(migrated.read(main), 'Board:\n% Latest collaborative task\n')
        self.assertIn('background: #123456', migrated.read(migrated.defs(project)))
        self.assertEqual((server.HISTORY_DIR / main['id'] / 'old.txt').read_text(), '% Historical task')
        self.assertEqual(migrated.read(migrated.document('personal/alice')), '')
        self.assertTrue(server.can_access_space(self.user, migrated.document('personal/alice')['id']))
        bob = server.AuthUser('bob', 'Bob', 'user', ())
        self.assertFalse(server.can_access_space(bob, migrated.document('personal/alice')['id']))
        self.assertEqual(server.room_name('project', space_path_hint='nested/project'), '/ws/' + main['id'])
        self.assertTrue((self.root / 'space-migration-backup/nested/project.txt').exists())
        await server.migrate_tab_spaces()
        self.assertEqual(server.tab_store().document('nested/project')['id'], main['id'])
