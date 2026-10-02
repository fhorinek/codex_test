import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import tempfile
import unittest
from space_tabs import TabStore, extract_definitions, appearance


class SpaceTabsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'spaces'
        self.root.mkdir()
        self.store = TabStore(self.root)
        self.space = self.store.create_space('team/demo', 'Board:\n    tags:\n        urgent:\n            background: #ff0000\n% Task\n    % Child\n')
        self.sid = self.space['id']

    def mutate(self, action, **kwargs):
        space = self.store.space(self.sid)
        result = self.store.mutate(space, action, {'revision': space['revision'], **kwargs})
        return result

    def test_migrate_extract_and_restart(self):
        (self.root / 'legacy.txt').write_text('Board:\n    people:\n        anna:\n            name: Anna\n% Main\nnotes\n')
        self.store.migrate()
        space = self.store.space('legacy')
        self.assertTrue(space['path'].endswith('01_legacy.space'))
        self.assertIn('anna:', self.store.read(self.store.defs(space)))
        self.assertEqual(self.store.read(self.store.document('legacy')), 'Board:\n% Main\nnotes\n')
        self.assertFalse((self.root / 'legacy.txt').exists())
        self.assertTrue((self.root.parent / 'space-migration-backup/legacy.txt').exists())
        again = TabStore(self.root)
        again.migrate()
        self.assertEqual(again.space('legacy')['id'], space['id'])

    def test_appearance_rename_copy_close_and_reorder(self):
        main = self.store.document(self.sid)['id']
        self.mutate('appearance', id=main, appearance={'icon': '🦄', 'color': '#123456'})
        defs = self.store.read(self.store.defs(self.store.space(self.sid)))
        self.assertEqual(appearance(defs)['main']['icon'], '🦄')
        self.assertIn('background: #ff0000', defs)
        self.mutate('rename', id=main, name='roadmap')
        self.mutate('close', id=main)
        self.assertEqual(self.store.document(main)['filename'], '.01_roadmap.txt')
        copy = self.mutate('copy', id=main, name='release')
        self.assertEqual(self.store.read(self.store.document(copy['id'])), self.store.read(self.store.document(main)))
        self.assertEqual(appearance(self.store.read(self.store.defs(self.store.space(self.sid))))['release']['color'], '#123456')
        self.mutate('open', id=main)
        self.mutate('reorder', ids=[copy['id'], main])
        self.assertEqual(self.store.document(main)['filename'], '02_roadmap.txt')
        self.mutate('delete', id=copy['id'])
        self.assertTrue(self.store.document(copy['id'])['deleted'])

    def test_icon_text_and_color_validation_and_reset(self):
        main = self.store.document(self.sid)['id']
        for icon in ['🦄', '⭐', '🐶', '🐱', '👩🏽‍💻', '🇸🇰', 'Release candidate', '🐶🐱', 'v2: ready!', '<b>text</b>']:
            self.mutate('appearance', id=main, appearance={'icon': icon})
            self.assertEqual(self.store.listing(self.store.space(self.sid))['tabs'][1]['appearance']['icon'], icon)
        for icon in [42, 'text\n    tags:', 'text\rmore']:
            with self.assertRaises(ValueError): self.mutate('appearance', id=main, appearance={'icon': icon})
        defs = self.store.defs(self.store.space(self.sid))
        self.store.write(defs, 'Definitions:\n    tabs:\n        main:\n            icon: Release candidate 🦄\n')
        self.assertEqual(self.store.listing(self.store.space(self.sid))['tabs'][1]['appearance']['icon'], 'Release candidate 🦄')
        with self.assertRaises(ValueError): self.mutate('appearance', id=main, appearance={'color': 'invalid'})
        self.mutate('appearance', id=main, appearance={'icon': '', 'color': ''})
        self.assertNotIn('main', appearance(self.store.read(self.store.defs(self.store.space(self.sid)))))

    def test_validation_and_conflict(self):
        for name in ['a b', 'á', '../x', 'a.b', 'defs', 'MAIN']:
            with self.assertRaises(ValueError): self.mutate('add', name=name)
        with self.assertRaises(ValueError): self.store.mutate(self.store.space(self.sid), 'add', {'name': 'ok', 'revision': 0})
        defs = self.store.defs(self.store.space(self.sid))
        with self.assertRaises(ValueError): self.mutate('delete', id=defs['id'])
        self.mutate('close', id=defs['id'])
        self.assertTrue(self.store.path(self.store.document(defs['id'])).name.startswith('.'))

    def test_rename_updates_references_in_closed_tabs(self):
        main = self.store.document(self.sid)
        other = self.mutate('add', name='other')
        self.store.write(other, '%% main::Task\n    %%% main::Child\nbody main::Task\n%% elsewhere::Task')
        self.mutate('close', id=other['id'])
        self.mutate('rename', id=main['id'], name='renamed')
        self.assertEqual(self.store.read(self.store.document(other['id'])), '%% renamed::Task\n    %%% renamed::Child\nbody main::Task\n%% elsewhere::Task')

    def test_external_rename_and_conflict(self):
        main = self.store.document(self.sid)
        path = self.store.path(main)
        path.rename(path.with_name('.07_plan.txt'))
        changed, _ = self.store.reconcile()
        self.assertIn(main['id'], changed)
        self.assertEqual(main['name'], 'plan')
        self.store.path(main).write_text('% External')
        live = {d['id']: self.store.read(d) for d in self.store.docs(self.store.space(self.sid))}
        live[main['id']] = '% Live'
        changed, notices = self.store.reconcile(lambda d: live.get(d['id'], self.store.read(d)))
        self.assertTrue(notices)
        self.assertEqual(self.store.read(main), '% Live')
        recovery = next(d for d in self.store.docs(self.store.space(self.sid)) if 'recovery' in d['name'])
        self.assertEqual(self.store.read(recovery), '% External')

    def test_snapshot_before_watcher_keeps_external_rename_appearance(self):
        main = self.store.document(self.sid)
        self.mutate('appearance', id=main['id'], appearance={'icon': '🦄'})
        main = self.store.document(main['id'])
        path = self.store.path(main)
        path.rename(path.with_name('01_renamed.txt'))
        self.store.write(main, '% Task')
        defs = self.store.defs(self.store.space(self.sid))
        live_defs = self.store.read(defs)
        changed, _ = self.store.reconcile(lambda d: live_defs if d['kind'] == 'defs' else self.store.read(d))
        self.assertIn(defs['id'], changed)
        self.assertEqual(appearance(self.store.read(defs))['renamed']['icon'], '🦄')

    def test_numeric_order_and_stable_ids(self):
        space = self.store.space(self.sid)
        directory = self.root / space['path']
        (directory / '100_last.txt').write_text('% Last')
        (directory / '09_middle.txt').write_text('% Middle')
        self.store.reconcile()
        self.assertEqual([d['name'] for d in self.store.docs(space)], ['defs', 'main', 'middle', 'last'])

if __name__ == '__main__': unittest.main()

class TabSafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'spaces'
        self.root.mkdir()
        self.store = TabStore(self.root)

    def test_migration_collision_does_not_overwrite(self):
        (self.root / 'demo.txt').write_text('% Original')
        (self.root / '01_demo.space').mkdir()
        (self.root / '01_demo.space/01_main.txt').write_text('% Keep')
        # Existing folders reserve numbers; migration must not silently adopt one.
        space = self.store.create_space('other')
        self.assertEqual(self.store.read(self.store.document(space['id'])), '')
        with self.assertRaises(ValueError): self.store.migrate()
        self.assertEqual((self.root / '01_demo.space/01_main.txt').read_text(), '% Keep')
        self.assertEqual((self.root / 'demo.txt').read_text(), '% Original')

    def test_missing_defs_and_closed_defs(self):
        space = self.store.create_space('demo')
        defs = self.store.defs(space)
        self.store.path(defs).unlink()
        self.store.reconcile()
        self.assertTrue(self.store.path(defs).exists())
        self.store.path(defs).rename(self.store.path(defs).with_name('.defs.txt'))
        self.store.reconcile()
        self.assertEqual(defs['filename'], '.defs.txt')
        self.assertTrue(defs['closed'])

    def test_interrupted_transaction_replays(self):
        import json
        space = self.store.create_space('demo')
        doc = self.store.document(space['id'])
        relative = str(self.store.path(doc).relative_to(self.root))
        self.store.journal_path.write_text(json.dumps({'data': self.store.data, 'writes': {relative: '% recovered'}, 'deletes': []}))
        again = TabStore(self.root)
        self.assertEqual(again.read(again.document(doc['id'])), '% recovered')
        self.assertFalse(again.journal_path.exists())

    def test_deleted_file_preserves_unsaved_live_content(self):
        space = self.store.create_space('demo', '% old')
        doc = self.store.document(space['id'])
        self.store.path(doc).unlink()
        self.store.reconcile(lambda d: '% unsaved' if d['id'] == doc['id'] else self.store.read(d))
        recovery = next(d for d in self.store.docs(space) if 'recovery' in d['name'])
        self.assertEqual(self.store.read(recovery), '% unsaved')

    def test_symlink_rejected(self):
        outside = self.root.parent / 'outside'
        outside.mkdir()
        (self.root / 'linked').symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError): self.store.create_space('linked/demo')

    def test_jira_discoveries_keep_shared_properties_out_of_local_tab(self):
        from jira.worker import parse_people_config, local_definition_changes
        local, _, _ = parse_people_config(['Board:', '    people:', '        anna:', '            name: Local Anna'])
        resolved, _, _ = parse_people_config(['Board:', '    people:', '        anna:', '            name: Local Anna', '            email: anna@example.com', '        bob:', '            name: Bob'])
        import copy
        original = copy.deepcopy(resolved)
        added, _, _ = parse_people_config(['Board:', '    people:', '        cat:', '            name: Cat'])
        resolved.update(added)
        saved = local_definition_changes(local, original, resolved)
        self.assertEqual(saved['anna'], local['anna'])
        self.assertNotIn('bob', saved)
        self.assertEqual(saved['cat'], added['cat'])
