# Usage Manual

## Overview

Task Script Board uses a text-first workflow:

- left pane: code editor
- right pane: graph + kanban
- collaboration: shared spaces with access control

Everything is synchronized live.

## Toolbar

Top toolbar buttons:

- Undo / Redo
- Load `.txt` from disk
- Save current script as `.txt`
- Format script
- Connect/Login
- Theme toggle
- Fullscreen toggle

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

- Task line starts with `%`.
- Subtasks use 4-space indentation.
- Description lines continue until next task of same/higher level.
- Optional tokens: `!state`, `#tag`, `@person`.
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
- Save applies changes to script and graph/kanban.

## Graph and Kanban

- Pan/zoom graph.
- Drag node to task to create subtask.
- Drag task to trash to delete (with confirmation options).
- Floating **Add Task** button opens create-task modal.
- Kanban supports grouping by none/person/tag.
- Drag kanban cards between columns to change state.

## Resizing and Snap Behavior

- Vertical code|graph divider supports edge snapping.
- When snapped to right edge, legend auto-hides to prevent overflow.
- Horizontal graph|kanban divider resizes kanban and can collapse it.

## Feedback

All success and error feedback is shown as top-right toasts.

## Persistence Files

- `backend/users_config.json`: users, roles, access paths
- `backend/sessions.json`: persistent sessions + last space
- `backend/jira/jira_config.json`: Jira configuration
- `backend/spaces/`: space files/folders
- `backend/ystore/`: collaboration state storage
