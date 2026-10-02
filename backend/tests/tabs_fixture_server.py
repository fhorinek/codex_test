"""Disposable browser-test server; every writable data path is supplied by the test."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import asyncio
import os
import server
from jira import config

root = Path(sys.argv[1])
for name, folder in [('SPACES_DIR', 'spaces'), ('YSTORE_DIR', 'ystore'), ('HISTORY_DIR', 'history')]:
    path = root / folder
    path.mkdir(parents=True, exist_ok=True)
    setattr(server, name, path)
server.SESSIONS_FILE = root / 'sessions.json'
config.USERS_CONFIG_PATH = root / 'users_config.json'
config.LEGACY_USERS_CONFIG_PATH = root / 'legacy.json'
config.JIRA_CONFIG_PATH = root / 'jira.json'
users = server.load_users_store()
users['admin']['must_change_password'] = False
server.save_users_store(users)
legacy = server.SPACES_DIR / 'demo.txt'
if not (root / 'space-index.json').exists():
    legacy.write_text('Demo:\n    tags:\n        urgent:\n            background: #551188\n    people:\n        anna:\n            name: Anna\n    states:\n        todo:\n            name: To do\n% Task\n#urgent @anna !todo\n1.10.2026-5.10.2026\n')
os.environ['PORT'] = sys.argv[2]
asyncio.run(server.main())
