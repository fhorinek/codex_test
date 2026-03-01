# Usage Manual

## Overview

Task Script Board uses a text-first workflow:

- left pane: code editor
- right pane: graph + kanban
- collaboration: shared spaces with access control

Everything is synchronized live.

## Run and Build

Recommended start command:

- `./run.sh`

What `run.sh` does now:

- activates `backend/.venv`
- builds the frontend (`frontend/dist`) via `npm run build:dist`
- starts `backend/server.py`

Notes:

- `npm` is required (frontend build runs on every start).
- Backend serves the built frontend from `frontend/dist` when present.
- Directly opening/serving raw `frontend/index.html` is not the primary runtime path anymore.

## Developer Commands

Run from `frontend/`:

- `npm run build:dist` - build browser app to `frontend/dist`
- `npm run build:dist:watch` - watch TS compile for dist scripts
- `npm run typecheck` - main TypeScript check
- `npm run typecheck:core` - faster core subset typecheck
- `npm run typecheck:strict:helpers` - stricter staged helper/module lane
- `npm run test:unit` - unit/contract tests (loads TS sources via `tsx`)
- `npm run test:e2e` - app/backend end-to-end tests
- `npm run test:e2e:chrome-connect` - Playwright Chrome connect flow tests

## Toolbar

Top toolbar buttons:

- Undo / Redo
- Load `.txt` from disk
- Save current script as `.txt`
- Format script
- Connect/Login
- Theme toggle
- Fullscreen toggle

## Responsive Layout (Mobile / Tablet / Desktop)

- Desktop (`>=1200px`):
  - current split layout remains (code + graph/kanban pane)
  - all desktop drag/drop interactions remain available
- Tablet (`768px-1199px`):
  - two-pane layout remains (editor left + right visualization pane)
  - right pane has a **Graph / Kanban** toggle
  - graph legend/minimap are reduced/hidden by default for space
- Mobile (`<768px`):
  - single-pane mode with tabs: `Code`, `Graph`, `Kanban`, `History`
  - split dividers are hidden
  - history panel becomes a mobile bottom sheet

Touch interaction notes:

- Precision drag/drop interactions are reduced/disabled on touch-first small screens where they are unreliable.
- History viewer mode remains read-only and disables task/code interactions across all breakpoints.

## Login and Sessions

- Click **Connect** and log in with username/password.
- A persistent session cookie is created.
- Last opened space is remembered and restored after login.
- Logout is available from the Spaces modal.

## Spaces Modal (Tabs)

The Spaces modal title is **Choose project space** and includes tabs:

- Spaces
- Profile
- Jira
- User management

Modals close with their close button or `Esc`.

## Roles

- `admin`: all spaces, manage spaces, Jira settings, user management.
- `manager`: all spaces, user management.
- `user`: only assigned access paths.

Every user has a personal space in `personal/<username>`.
Only that user and admins can access it.

## Spaces and Folder Tree

- Folder tree is filesystem-backed under `backend/spaces/`.
- Folders are collapsible and only one branch is open at a time.
- Active folder/space is highlighted.
- Add-space and add-folder actions create items in the currently open folder.
- Spaces can be dragged:
    - into folders (open or closed)
    - onto another space (moves to that space's folder)
    - to root via the root drop target
- Space rename/move updates path-based permissions.
- Deleting a space disconnects active users first, then removes the space and ystore.

## User Management

Available to admins and managers.

- Create user from dedicated modal.
- Edit display name, role, and access paths.
- Change password via dedicated modal (new + repeat).
- Delete user with confirmation modal.
- Managers can manage only `user` accounts.
- Your own account is not shown in the user management list.

For `user` role, permissions are path-based:

- single space path (example: `teamA/roadmap`)
- folder wildcard path (example: `teamA/*`)

## Profile

- Update display name.
- Change password (requires current password).
- New password requires confirmation.
- Secret fields include show/hide eye toggle where configured.

## Jira Settings

Admin-only modal:

- Base URL
- Email
- API token

## Task Script Format

- Task line starts with `%` and may include optional Jira marker:
  - `% [ABC] Task title` creates a new Jira issue in project `ABC`
  - `% [ABC-123] Task title` links an existing Jira issue
- Subtasks use 4-space indentation.
- Optional tag line is the first body line (same indentation as task line body):
  - tokens only, e.g. `@person !state #tag ~2`
- `!state` and `~estimate` may appear anywhere in task body; only first occurrence is used.
- `#tag` and `@person` may appear in tag line or description body.
- First `@person` occurrence is used as the owner.
- The token line is part of the task description/body block.
- Description/body continues until blank line or next task.
- Description lines should use the same indentation level as the task body.
- References use `{Task Name}`.

Optional config header before first task:

- board title
- `states:`
- `people:`
- `tags:`

If `states:` is omitted, defaults are `todo`, `inprogress`, `done`.

## Editor Interactions

- Double-click `%` task title in code editor: open task edit modal.
- Double-click slug (`#tag`, `@person`, `!state`): open slug rename modal.
- Slug rename also works for config header slugs and in task-edit code view.
- Double-click checkbox token (`[ ]` / `[x]`) in code editor toggles it.
- Press `Esc` inside search box to clear search.

When renaming a task title in task edit modal, `{old title}` references are updated across file.

## Task Edit Modal

- Edit title and body code.
- Live preview of markdown.
- Token palettes (state/people/tags) with drag-in and drag-out behavior.
- GUI/Jira edits add tokens to the token line only (create token line if missing).
- Auto-format canonicalizes `!state` and `~estimate` into the token line (creates token line if needed).
- Auto-format enforces 4-space task indentation levels.
- Save applies changes to script and graph/kanban.

## Graph and Kanban

- Pan/zoom graph.
- Drag node to task to create subtask.
- Drag parent onto child in graph can switch the relation (target child becomes parent).
- Drag task to trash to delete (with confirmation options).
- Floating **Add Task** button opens create-task modal.
- Kanban supports grouping by none/person/tag.
- Drag kanban cards between columns to change state.
- Graph supports task reorder by drag (including root-level unparenting when dropping a child on root task edges).
- Kanban reordering is disabled (state changes only).

## Resizing and Snap Behavior

- Vertical code|graph divider supports edge snapping.
- When snapped to right edge, legend auto-hides to prevent overflow.
- Horizontal graph|kanban divider resizes kanban and can collapse it.
- When the graph pane is fully hidden or the graph-top area is collapsed, kanban cards show full task descriptions (graph-style markdown rendering).
- On mobile, split-pane resizing is disabled (single-pane tabs are used instead).

## Feedback

All success and error feedback is shown as top-right toasts.

## Persistence Files

- `backend/users_config.json`: users, roles, access paths
- `backend/sessions.json`: persistent sessions + last space
- `backend/jira/jira_config.json`: Jira configuration
- `backend/spaces/`: space files/folders
- `backend/ystore/`: collaboration state storage
