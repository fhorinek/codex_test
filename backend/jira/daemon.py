"""Server-owned, isolated Jira workers. No Jira credentials leave defs.txt."""
import asyncio
from collections import deque
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys


class JiraDaemons:
    def __init__(self, store, definitions, environment):
        self.store = store
        self.definitions = definitions
        self.environment = environment
        self.processes = {}
        self.logs = {}
        self.readers = {}
        self.locks = {}
        self.auto_seen = {}
        self.secrets = {}

    def log(self, space_id, message):
        from .definitions import parse_jira_definitions
        config, _ = parse_jira_definitions(self.definitions(space_id))
        for secret in set((config.token, config.email)) | self.secrets.get(space_id, set()):
            if secret: message = message.replace(secret, '[redacted]')
        self.logs.setdefault(space_id, deque(maxlen=1000)).append(datetime.now(timezone.utc).isoformat(timespec='seconds') + ' ' + message.rstrip())

    async def read_output(self, space_id, process):
        while True:
            line = await process.stdout.readline()
            if not line: break
            self.log(space_id, line.decode('utf-8', errors='replace'))
        await process.wait()
        self.log(space_id, 'Daemon stopped (exit %s).' % process.returncode)

    async def command(self, space_id, action):
        from .definitions import parse_jira_definitions
        async with self.locks.setdefault(space_id, asyncio.Lock()):
            process = self.processes.get(space_id)
            running = process is not None and process.returncode is None
            if action in ('stop', 'restart') and running:
                self.log(space_id, 'Stopping daemon.')
                process.terminate()
                try: await asyncio.wait_for(process.wait(), 8)
                except asyncio.TimeoutError:
                    process.kill()
                    await process.wait()
                reader = self.readers.get(space_id)
                if reader: await reader
                running = False
            if action in ('start', 'restart', 'sync'):
                config, diagnostics = parse_jira_definitions(self.definitions(space_id))
                if not config.enabled: raise ValueError('Configure Jira in defs.txt before starting the daemon.')
                if not running:
                    from .config import load_jira_worker_credentials
                    self.secrets.setdefault(space_id, set()).update((config.token, config.email, load_jira_worker_credentials()[1]))
                    env = {**os.environ, **self.environment()}
                    process = await asyncio.create_subprocess_exec(sys.executable, '-u', '-m', 'jira.worker', '--space', space_id, '--managed',
                        cwd=str(Path(__file__).resolve().parents[1]), env=env, stdin=asyncio.subprocess.PIPE,
                        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, limit=1024 * 1024)
                    self.processes[space_id] = process
                    self.readers[space_id] = asyncio.create_task(self.read_output(space_id, process))
                    self.log(space_id, 'Daemon started.')
                if action == 'sync':
                    process.stdin.write(b'sync\n')
                    await process.stdin.drain()
                    self.log(space_id, 'Synchronization requested.')
            elif action != 'stop': raise ValueError('Unknown daemon command.')
        return self.status(space_id)

    def status(self, space_id):
        process = self.processes.get(space_id)
        return {'running': process is not None and process.returncode is None, 'logs': list(self.logs.get(space_id, []))}

    def cache(self, space_id):
        store = self.store()
        directory = store.safe_path(store.space(space_id)['path'])
        result = {}
        for name in ('jira-cache.json', 'jira-created-issues.json'):
            path = directory / name
            if path.is_symlink(): continue
            if path.exists():
                try: result[name] = json.loads(path.read_text(encoding='utf-8'))
                except (ValueError, OSError): result[name] = {'error': 'Cache could not be read.'}
        return result

    async def reconcile(self):
        from .definitions import parse_jira_definitions, jira_options
        store = self.store()
        live = set()
        if store:
            for space in list(store.data['spaces'].values()):
                if space.get('deleted'): continue
                sid = space['id']; live.add(sid)
                source = self.definitions(sid)
                enabled = parse_jira_definitions(source)[0].enabled
                auto = enabled and jira_options(source)['autostart']
                if auto and not self.auto_seen.get(sid):
                    await self.command(sid, 'start')
                self.auto_seen[sid] = auto
                if not enabled and self.status(sid)['running']: await self.command(sid, 'stop')
        for sid in list(self.processes):
            if sid not in live and self.status(sid)['running']: await self.command(sid, 'stop')

    async def shutdown(self):
        for sid in list(self.processes):
            if self.status(sid)['running']: await self.command(sid, 'stop')
        await asyncio.gather(*self.readers.values(), return_exceptions=True)
