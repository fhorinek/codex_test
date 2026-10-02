import sys
from pathlib import Path
from unittest.mock import patch, AsyncMock, Mock
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import test_tab_api
import server
from jira import config as storage
from jira.definitions import parse_jira_definitions

CONFIG = {'base_url': 'https://one.example.com', 'email': 'one@example.com', 'token': 'ONE'}

class JiraSpaceApiTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        test_tab_api.TabApiTests.setUp(self)
        patcher = patch.object(storage, 'JIRA_CONFIG_PATH', self.root / 'jira.json')
        patcher.start(); self.addCleanup(patcher.stop)
        async def immediate(function, *args, **kwargs): return function(*args, **kwargs)
        io_patch = patch.object(server, 'run_blocking_io', side_effect=immediate)
        io_patch.start(); self.addCleanup(io_patch.stop)
        self.admin = server.AuthUser('admin', 'Admin', 'admin', ())

    async def test_space_configuration_and_closed_defs_without_global_fallback(self):
        storage.save_jira_config_data(CONFIG)
        sid = self.space['id']
        self.assertFalse((await server.read_jira_status(sid, self.user))['configured'])
        await server.write_jira_config(sid, CONFIG, self.user)
        defs = self.store.defs(self.store.space(sid))
        self.assertIn('token: ONE', self.store.read(defs))
        self.store.mutate(self.store.space(sid), 'close', {'id': defs['id'], 'revision': self.store.space(sid)['revision']})
        self.assertEqual(self.store.defs(self.store.space(sid))['filename'], '.defs.txt')
        self.assertTrue((await server.read_jira_status(sid, self.user))['configured'])
        outsider = server.AuthUser('bob', 'Bob', 'user', ())
        with self.assertRaises(server.HTTPException): await server.read_jira_config(sid, outsider)
        with self.assertRaises(server.HTTPException): await server.write_jira_config(sid, CONFIG, outsider)
        await server.write_jira_config(sid, dict.fromkeys(CONFIG, ''), self.user)
        self.assertFalse((await server.read_jira_status(sid, self.user))['configured'])

    async def test_live_definitions_are_used_before_disk_persistence(self):
        from types import SimpleNamespace
        doc = self.store.defs(self.space)
        ydoc = server.Y.YDoc()
        server.replace_ydoc_text(ydoc, 'jira:\n    base_url: https://live.example.com\n    email: live@example.com\n    token: LIVE\n')
        room = SimpleNamespace(ydoc=ydoc, ystore=SimpleNamespace(encode_state_as_update=AsyncMock()))
        with patch.object(server.websocket_server, 'rooms', {f"/ws/{doc['id']}": room}):
            self.assertTrue((await server.read_jira_status(self.space['id'], self.user))['configured'])
            self.assertEqual((await server.read_jira_config(self.space['id'], self.user))['token'], 'LIVE')
            checkpoint = server.create_history_checkpoint(self.store.document(self.space['id'])['id'], '% Task')
            saved = server.history_checkpoint_path(self.store.document(self.space['id'])['id'], checkpoint['id']).with_suffix('.defs').read_text()
            self.assertIn('token: LIVE', saved)
            await server.write_jira_config(self.space['id'], {'token': 'NEW'}, self.user)
            self.assertIn('token: NEW', server.ydoc_to_text(room.ydoc))
            self.assertIn('https://live.example.com', self.store.read(doc))

    async def test_restoring_task_does_not_replace_current_jira_configuration(self):
        await server.write_jira_config(self.space['id'], CONFIG, self.user)
        main = self.store.document(self.space['id'])
        checkpoint = server.create_history_checkpoint(main['id'], '% Older task')
        await server.write_jira_config(self.space['id'], {**CONFIG, 'token': 'CURRENT'}, self.user)
        await server.revert_space_history_checkpoint(main['id'], {'checkpoint_id': checkpoint['id'], 'pre_revert_content': '% Current task'}, self.user)
        self.assertEqual((await server.read_jira_config(self.space['id'], self.user))['token'], 'CURRENT')
        self.assertEqual(self.store.read(main), '% Older task')

    async def test_accounts_and_suggestions_use_only_requested_space(self):
        other = self.store.create_space('team/other', '')
        await server.write_jira_config(self.space['id'], CONFIG, self.user)
        second = {**CONFIG, 'base_url': 'https://two.example.com', 'token': 'TWO'}
        await server.write_jira_config(other['id'], second, self.user)
        with patch.object(server, 'JiraClient') as factory:
            factory.return_value.get_projects.return_value = ([], 200)
            factory.return_value.suggest_issues.return_value = ([{'key': 'SAME-1', 'name': 'one'}], 200)
            await server.read_jira_projects(self.space['id'], self.user)
            await server.read_jira_issue_suggestions(other['id'], 'SAME-', self.user)
            self.assertEqual(factory.call_args_list[0].args, ('https://one.example.com', 'one@example.com', 'ONE'))
            self.assertEqual(factory.call_args_list[1].args, ('https://two.example.com', 'one@example.com', 'TWO'))

    async def test_selected_migration_includes_personal_and_preserves_global_login(self):
        personal = self.store.create_space('personal/alice', '')
        storage.save_jira_config_data({**CONFIG, 'worker_username': 'jira-daemon', 'worker_password': 'daemon-login'})
        listing = await server.read_jira_migration(self.admin)
        self.assertTrue(listing['pending']); self.assertEqual(listing['selection'], [])
        await server.migrate_jira_config({'spaces': [personal['id']]}, self.admin)
        self.assertFalse((await server.read_jira_status(self.space['id'], self.user))['configured'])
        self.assertTrue((await server.read_jira_status(personal['id'], self.user))['configured'])
        self.assertFalse(storage.load_jira_config().enabled)
        self.assertEqual(storage.load_jira_worker_credentials()[1], 'daemon-login')
        self.assertTrue((self.root / 'jira_config.migration-backup.json').exists())
        daemon = server.AuthUser('jira-daemon', 'Daemon', 'manager', ())
        self.assertTrue(server.can_access_space(daemon, personal['id']))
        manager = server.AuthUser('manager', 'Manager', 'manager', ())
        self.assertFalse(server.can_access_space(manager, personal['id']))

    async def test_migration_conflicts_are_validated_before_any_writes(self):
        other = self.store.create_space('team/other', '')
        await server.write_jira_config(other['id'], CONFIG, self.user)
        storage.save_jira_config_data(CONFIG)
        with self.assertRaises(server.HTTPException):
            await server.migrate_jira_config({'spaces': [self.space['id'], other['id']]}, self.admin)
        self.assertFalse((await server.read_jira_status(self.space['id'], self.user))['configured'])
        self.assertTrue(storage.load_jira_config().enabled)

    async def test_interrupted_migration_resumes_without_overwriting(self):
        storage.save_jira_config_data(CONFIG)
        transaction = self.store.transaction
        def interrupted(*args):
            transaction(*args)
            raise RuntimeError('interrupted')
        with patch.object(self.store, 'transaction', side_effect=interrupted):
            with self.assertRaises(RuntimeError): await server.migrate_jira_config({'spaces': [self.space['id']]}, self.admin)
        self.assertTrue(storage.load_jira_config().enabled)
        await server.migrate_jira_config({'spaces': [self.space['id']]}, self.admin)
        self.assertTrue((await server.read_jira_status(self.space['id'], self.user))['configured'])
        self.assertFalse(storage.load_jira_config().enabled)

    async def test_migrate_none_retires_legacy_without_configuring_spaces(self):
        storage.save_jira_config_data(CONFIG)
        await server.migrate_jira_config({'spaces': []}, self.admin)
        self.assertFalse(storage.load_jira_config().enabled)
        self.assertFalse((await server.read_jira_status(self.space['id'], self.user))['configured'])

    async def test_daemon_controls_logs_and_cache_authorize_the_space(self):
        sid = self.space['id']
        outsider = server.AuthUser('bob', 'Bob', 'user', ())
        for endpoint in (server.read_jira_daemon, server.read_jira_cache):
            with self.assertRaises(server.HTTPException): await endpoint(sid, outsider)
        with patch.object(server.jira_daemons, 'command', new_callable=AsyncMock, return_value={'running': True}) as command:
            with self.assertRaises(server.HTTPException): await server.control_jira_daemon('start', sid, outsider)
            command.assert_not_called()
            self.assertTrue((await server.control_jira_daemon('sync', sid, self.admin))['running'])
            command.assert_awaited_once_with(sid, 'sync')
            with self.assertRaises(server.HTTPException): await server.control_jira_daemon('invalid', sid, self.admin)
        self.assertEqual(await server.read_jira_cache(sid, self.admin), {})

    async def test_daemon_tools_reject_non_admin_space_editors_and_managers(self):
        sid = self.space['id']
        for user in (self.user, server.AuthUser(self.user.username, 'Manager', 'manager', self.user.spaces)):
            for endpoint in (server.read_jira_daemon, server.read_jira_cache):
                with self.assertRaises(server.HTTPException) as error:
                    await endpoint(sid, user)
                self.assertEqual(error.exception.status_code, 403)
            with patch.object(server.jira_daemons, 'command', new_callable=AsyncMock) as command:
                with self.assertRaises(server.HTTPException) as error:
                    await server.control_jira_daemon('start', sid, user)
                self.assertEqual(error.exception.status_code, 403)
                command.assert_not_called()
