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

Tags support `name`, `color` (pill color), and `background` (whole task background
in graph, kanban, and timeline). The first tag on a task with a configured
background wins. Children inherit the closest ancestor's background with 20%
more transparency per level, unless their own tag defines a background. Removing
an override restores the next tag's background, inherited background, or theme.
The tag edit dialog also provides a Task background color picker; Auto clears
the override.

```text
My board:
    tags:
        urgent:
            name: Urgent
            color: #e74c3c
            background: #fff0ed

% Fix the issue
#urgent
```

## Editor Interactions

- Double-click `%` task title in code editor: open task edit modal.
- Double-click a tag, person, or state in code, task views, legends, or the GUI task editor: open its definition dialog. Single-click still assigns, removes, or filters as usual.
- Slug rename also works for config header slugs and in task-edit code view.
- Double-click checkbox token (`[ ]` / `[x]`) in code editor toggles it.
- Press `Esc` inside search box to clear search.

When renaming a task title in task edit modal, `{old title}` references are updated across file.

The task editor's right sidebar includes **Jira** below tags. Click **Link Jira**
and type a project key for project suggestions. Continue with `-` to look up
recent issues in that project; typing a complete issue key also tries an exact
lookup. Choose an issue or press Enter to link a project/issue key. Use the small
**×** to unlink. These changes apply when you save the task. Suggestions require
a configured Jira connection; known task links and manual entry remain available.
Suggestions appear in a dropdown. A project-only key shows a note that a new
Jira task will be created in that project.

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

## Timeline

Use **Graph | Timeline** at the bottom-right of the graph pane to switch views. Your choice
is remembered on this browser. The timeline shows only tasks with valid dates, keeping parents and children in
hierarchical order, with a shared date ruler and a red Today line. Consecutive leaf
subtasks with no visible descendants share a row; overlapping tasks stack below
earlier-starting tasks and expand that row. Subtasks with dated descendants have
their own row, followed by those descendants. Undated children do not force a
separate row. There is no left task list.
When a parent has no timeline entry, its name appears above its children's row,
aligned with the first visible task. If that task is partially clipped, the name
stays at the left edge of the row.
Consecutive undated ancestors appear as a breadcrumb, such as `Parent > Sub-parent`.
Archived tasks and their descendants are excluded from the timeline and workload.

Dates use **day.month.year**, with four-digit years, anywhere in the task's own body:

```text
% Release
3.4.2026-8.4.2026
!inprogress #release @maya
    % Prepare notes
    3.4.2026
    % Final review
    -8.4.2026
```

A range has both ends; a single date (such as `30.9.2026` or `30.9.2026-`) is a
start with a fading right end; a leading
minus denotes a deadline with a fading left end. The first valid date expression
in each task's body controls its bar. Invalid dates and reversed ranges are ignored.

Drag a task from kanban onto the timeline to schedule it. Undated tasks and
tasks with invalid dates stay hidden until they have a valid date. New dates are inserted as the first body line; existing dates are
replaced in place. Drag a bar to move it, or its edges to resize. Dragging a faded
edge sets the missing date. Each gesture changes only that task, leaving children
unchanged, and is undoable in the editor. Escape or dropping outside cancels.

Double-click a task to edit, or drag it to the trash to use the usual deletion
dialog. Enter opens editing for a focused task. History views cannot be edited.
Drag empty space to pan horizontally or vertically. Wheel over the date ruler to
zoom time. Over task rows, wheel scrolls vertically, Shift + wheel pans horizontally,
and Ctrl/Cmd + wheel changes row height. With the timeline focused, arrow keys pan by a week
and +/− zoom. Dates snap to whole days at every zoom level.

Timeline tags, people, and states use the same named and colored pills as the rest
of the app. Task borders follow the configured state color. Drag a person or tag
from the legend (or another task's pill) onto a timeline task to assign it; a state
pill can also be dropped onto a task. Clicking tag/person pills highlights matches.
Drag a timeline task into a kanban column to change its state without changing its
dates. Drag a kanban task back onto the timeline to schedule or reschedule it while
preserving its state.

### Daily workload

The People section at the bottom normally folds into a single compact row, hiding
names while keeping each person's colored bars in a separate thin horizontal strip.
Collapsed bars keep their normal date position and width, with a uniform height. Hover over it or
focus it with the keyboard to animate it open into one named row per person.
It folds back when you leave; reduced-motion preferences disable the animation.
Selected people keep their named workload rows expanded above the compact strip
for everyone else, even without hovering.
Each day with assigned tasks has a vertical bar: one task is a low bar, and the
largest visible overlap fills the available height. Intermediate counts scale
between them. Bar heights adapt to the visible date window and are comparable
across people; hover for the exact date and count. Unassigned days remain empty.

Ranges count on every day, including both ends. Start-only tasks count from their
start onward; deadline-only tasks count on every day up to their deadline. Only
tasks with valid dates are counted, and each task counts once per assigned person.
The workload shares the timeline's zoom and horizontal position. Use the wheel to
zoom, or drag within the workload area to pan and move through the person rows.

Drag a tag or person pill out of a timeline task and drop it on empty space to remove
that assignment. Dropping on another task assigns it there and keeps the original;
dropping back on the source task or cancelling the drag leaves it unchanged.

## Spaces and tabs

A space is a folder such as `01_project.space`. Its task scripts are tabs:

```text
01_project.space/
  defs.txt
  01_main.txt
  02_release.txt
  .03_backlog.txt
```

**Open** reopens a closed tab; **Add** creates a new one. Right-click a tab to open its context menu
with Icon, Color, Close, Rename, Copy, Delete, and movement commands. Click outside
or press Escape to dismiss it. Shift+F10 opens the same menu from the keyboard.
Use the tab's × to close it, the folder icon to reopen a tab, and + to create one.
You can also drag tabs to reorder them. When all tabs are closed, the workspace
lists every tab with its icon and color; click a row to reopen it. Closing adds a leading dot to
the filename; deletion removes its task file. Closing and ordering affect everyone
in the space, while the active tab and view position are personal.

Names accept ASCII letters, numbers, underscores, and hyphens. Spaces, extra dots,
and accented characters are not allowed. Order numbers sort numerically and grow
past `99` when needed. Closed tabs also reserve their names.

`defs.txt` shares tag, person, and state definitions with all task tabs in its
space. It can be closed as `.defs.txt` without disabling its definitions. Its name
and position are fixed, and it cannot be deleted or copied through the interface.
Task content belongs in task tabs, not in `defs.txt`.

Local definitions override only properties they explicitly specify. An empty
property resets that property instead of inheriting it. Definition dialogs let
you choose **Global definition** or **This tab only**. The switch defaults to a
local definition when one exists, otherwise to global. **Move to global definitions**
saves the entry in `defs.txt` and removes its local override. Renaming a shared
slug updates references in both open and closed tabs.

The definitions editor stays unfolded. Sections in `defs.txt` need no `Definitions:` header. Tab appearance is also stored there:

```text
tags:
    urgent:
        background: #551188
tabs:
    main:
        icon: 🦄
        color: #8b5cf6
    release:
        icon: ⭐
        color: #f59e0b
```

Use the tab's Appearance menu to choose an emoji (including unicorn, star, dog,
and cat) and a palette/custom color in the same dialog. No icon and Auto clear these
settings. Appearance keys omit filename numbers, extensions, and the close-dot.
The picker sets one emoji. For any other text, edit `icon:` directly in `defs.txt`,
for example `icon: Release candidate 🦄`.
Renaming and copying tabs maintain these settings automatically.

The server imports manual filename/content changes after they settle. If a file
edit conflicts with live collaborative edits, both versions are preserved: the
external version appears in a recovery tab and editors receive a notice. Invalid
or duplicate filenames are reported rather than silently merged.

On the first server startup with this version, legacy space files are converted
automatically. Definitions are extracted into `defs.txt`, tasks remain in
`01_main.txt`, and existing history and access rules are retained. Backups live
under `backend/space-migration-backup/`. A restart resumes an interrupted migration.
Do not remove the backup until you have verified the converted spaces.

`backend/space-index.json` preserves space/document identities independently of
filenames. Include it, the space folders, `ystore`, and `history` in backups. The
transaction journal is automatically replayed after interrupted filesystem writes.

Task references show an original task from another tab in the same space:

```text
%% main::Task name
%%% main::Task name
```

Use the tab name without its number or extension and the task's exact, unique
title. `%%` includes the task's children; `%%%` shows only the original task.
Both appear in graph, kanban, and
(for dated tasks) timeline. Editing a reference's title, body, tokens, checkboxes,
or dates changes the original. Closed source tabs remain available. Missing,
ambiguous, or circular references show a diagnostic above the editor.
Ctrl-click a reference (Cmd-click on macOS) to open its source tab and focus the
original task. A closed source tab reopens for space editors.
Archived tasks cannot receive new children, including tasks archived through
their parent. Unarchive them before assigning them as a parent.
Reparenting or reordering a reference moves its entry in the current tab and
leaves the original hierarchy unchanged. A reference can have an original task
as its parent, but new children cannot be added to a reference.

Type `%% ` or `%%% ` for task suggestions. To place a task in another tab, drag it over
that tab for one second, then drop onto graph, kanban, timeline, or the editor.
The drop menu offers **Move task here**, **Reference this task only**, and
**Reference task and subtasks**. Move transfers the task and its children;
either reference option leaves the original in place. Deleting a reference
removes only its local entry. Dropping on a
kanban column sets the original state; dropping on the timeline sets its dates.
Escape or dropping outside those panels cancels. Tab renames and GUI task title
changes update matching references; manual title changes require updating their
reference text. Moves are checked against both documents and recorded in history.

Right-click a task in graph, kanban, or timeline to archive or delete it, move it
to a new or existing tab, or add either kind of reference to another tab.
Move actions ask whether to just move the task or leave a reference behind.
The original task and its subtasks move together; a reference stays at the
original position when that option is chosen. Click outside a menu or press
Escape to close it. Use arrow keys to navigate its tab submenus.

Right-click empty graph or timeline space to add a task or bring tasks here from
other tabs. Move and reference actions open a searchable list with a tab filter
and multiple selection. The same actions on an original task place the new tasks
under it. A reference's context menu displays “This is reference” and hides
these four child-creation actions. Archive, delete, move, and outgoing reference
actions remain available; deleting removes only the local reference. Timeline
placement schedules imported or newly created tasks on the clicked day.


### Jira per space

Configure Jira from the space’s Jira settings, or edit its shared `defs.txt`:

```text
jira:
    base_url: https://example.atlassian.net
    email: account@example.com
    token: api-token
```

Credentials are readable by space members. The daemon uses them only for that
space, including its closed task tabs and configured personal spaces. Closing
`defs.txt` to `.defs.txt` keeps the integration active. Task tabs cannot override
these settings. Missing or invalid credentials disable the integration and hide
**Link Jira**; existing links can still be unlinked.

Existing global credentials are no longer used for synchronization. Admins opening
Jira settings receive a migration dialog: select the spaces to configure, or
choose **Migrate none**. Existing space configurations are never overwritten.
Migration keeps a recovery backup and can resume an interrupted selection.
Daemon login credentials remain separate from the Jira account.

When creating an issue from a project key, the daemon compares Jira’s initial
status with the task’s state and transitions Jira to the mapped state when needed.
It verifies the result. If the workflow rejects the change, it reports the failure
and accepts Jira’s actual state while retaining the new issue link. If Jira cannot
be read, it keeps our state until verification becomes possible. A recovery journal
retains returned issue keys across interruptions to prevent duplicate creation.

The **JIRA Daemon** tab appears after the document tabs for admins when Jira is configured.
The daemon and cache tabs, their Open menu entries, and daemon tools are admin-only. It shows
space-local daemon activity and **Start**, **Stop**, **Restart**, **Sync now**, and
**Show cache** controls. Show cache opens a separate **JIRA Cache** tab. Logs are
limited to the latest 1,000 lines of this server session. Closing either tab only
hides that view; it does not stop the daemon.

Add these optional settings under `jira:` in `defs.txt` (also works while closed):

```text
    autostart: true
    show_logs: true
    show_cache: false
```

`autostart` defaults to `false`; `show_logs` defaults to `true`; `show_cache`
defaults to `false`. Autostart launches the space's worker when the server starts,
and when the setting is enabled while running. A manually stopped worker stays
stopped until started again or autostart is toggled off and on. **Sync now** starts
a stopped worker and requests a full scan, including tasks otherwise marked dirty.
The **Open** menu reopens hidden JIRA views; visibility flags are shared.

Each space stores its latest synchronization cache in `jira-cache.json` and its
new-issue recovery journal in `jira-created-issues.json` inside its `.space`
folder. Existing recovery entries move there on the next scan. Caches contain
sync data, not API credentials. Restart rebuilds the in-memory lookup cache from
the source documents and Jira; recovery records continue preventing duplicate
issue creation. The server stops its workers when shutting down.

The JIRA Daemon tab also has an **Autostart** checkbox, saving the space's `autostart`
setting directly in shared definitions. The cache viewer expands nested objects
and arrays with keyboard-accessible disclosure arrows. **Expand all** and
**Collapse all** control the whole tree; refreshes preserve expanded sections.

When Jira is configured, **from JIRA** beside **Add Task**, or **Add task from JIRA**
in the graph/timeline task dropdown, opens an issue importer. Type a
complete key such as `DEMO-123`, or choose an issue from the project/issue
suggestions. A valid key immediately loads a preview using the daemon's Jira
transformations, including state/people mappings, labels, issue type, description,
and estimates. **Also import N subtasks** appears only when the issue has subtasks.
Checking it loads their previews and imports them under the parent.

**Import task** adds the preview to the active task tab; newly discovered state
and people definitions are added locally. Previewing makes no changes. Import
uses normal undo/redo and synchronization. Issues already in the active tab are
rejected, and changing the tab or definitions requires a fresh preview.

Middle-click a tab with the mouse wheel to close it, just like its × button.
This also works for definitions and JIRA tabs; use **Open** to reopen them.

The Open menu groups Jira tools separately from document tabs. Daemon logs use
severity colors, expandable JSON payloads, and tables for synchronization
differences. Incomplete payloads remain visible as plain text.

Jira import suggestions exclude issues already linked in any task tab of the space,
including closed tabs. Entering an already linked key displays a notice instead of a preview.

**Clear log** in JIRA Daemon removes the space's current server-session log entries.
**Clear cache** in JIRA Cache removes the synchronization cache and restarts a running
worker to reset its in-memory cache. A stopped worker stays stopped. The cache is
rebuilt on the next synchronization; the issue-creation recovery journal is retained.

The toolbar **Download** button exports `jira-daemon.log` from JIRA Daemon and
`jira-cache.json` from JIRA Cache, using a fresh snapshot from the server.
