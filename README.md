# Task Script Board

Task Script Board is a script-first planning app that combines a code editor, graph view, and kanban board with shared collaboration spaces.

## What It Is

- Text-first project planning: task script is the source of truth.
- Live synchronized views: code, graph, and kanban.
- Multi-user collaboration with role-based access.

## Run Requirements

- Python 3.8+
- Node.js + npm

## How To Run

```bash
bash setup.sh
bash run.sh
```

Open the URL printed by `run.sh`.

## Measure Responsiveness

Enable built-in frontend perf monitoring in either way:

- URL flag for one session: `http://localhost:4173/?perf=1`
- Browser console (persists): `window.__taskScriptPerf.enable()`

Use in console:

- `window.__taskScriptPerf.reset()` before your test run.
- Perform interactions (typing, dragging nodes, zooming graph, resizing panes).
- `window.__taskScriptPerf.print()` to print a summary and top metrics table.
- `window.__taskScriptPerf.snapshot()` to get raw JSON report.
- `window.__taskScriptPerf.disable()` to turn monitoring off.

Key metrics to watch in report:

- `browser.longtask`: main-thread tasks over 50ms.
- `browser.frameDelta`: frame spacing; higher p95/max means jank.
- `browser.event.*`: slow input event handlers.
- `app.*` and `canvas.*`: app-specific render/layout timing hotspots.

## Core Features

- Live editor + graph + kanban updates.
- Shared spaces and filesystem folder tree.
- Roles: `admin`, `manager`, `user`.
- User management, profile settings, Jira settings.
- Persistent sessions with last opened space restore.
- Toast-based success/error feedback.

## Where Is What

- `frontend/`: UI (HTML/CSS/JS)
- `backend/server.py`: API, auth/session handling, space operations
- `backend/spaces/`: space files and folder structure
- `backend/ystore/`: Yjs persistence
- `backend/users_config.json`: users, roles, access paths
- `backend/sessions.json`: persistent session store
- `backend/jira/jira_config.json`: Jira configuration
- `USAGE.md`: user workflow documentation
- `requirements.txt`: detailed functional requirements
