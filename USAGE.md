# Usage Manual

## Overview

This app turns a lightweight task script into an interactive graph and kanban board. You edit text on the left, and the right side updates live.

## Editor Toolbar

The top toolbar shows the board name and buttons for undo, redo, load, save, format, theme, and fullscreen.

- Undo/Redo use the editor history.
- Load opens a `.txt` file from disk.
- Save downloads the current script as a `.txt` file.
- Format removes extra blank lines/trailing whitespace and moves the `!state` token to the first position after the task name.
- Theme toggles light/dark mode and remembers your choice.
- Connect opens the spaces modal for collaboration.

## Folding & Errors

- Config headers and task blocks can be folded using the gutter.
- If a task contains more than one `!state`, the extras are underlined and the line is highlighted as an error.

## Writing Tasks

Each task starts with a `%` line. Subtasks are indented by 4 spaces.

```text
% Launch sprint board
    % Define parsing rules
```

Descriptions are free-form lines after the task line until a blank line.

## Tags, People, and References

Add tags, people, and references anywhere in the description lines.

```text
% Launch sprint board
#productivity #planning !todo
@maya @luis
**Goal:** Turn raw task scripts into a visual map. {Refinement}
```

## Default States

If the header does not define states, the board uses these defaults:

- `!todo` labeled `TODO`
- `!inprogress` labeled `In progress`
- `!done` labeled `Done`

## Automatic Colors

When a tag, person, or state does not have an explicit color, the app assigns one automatically.

## Config Header

The optional header appears before the first task and lets you define board name, states, people, and tags.

```text
Launch board:
    states:
        todo:
            name: TODO
        inprogress:
            name: In progress
        done:
            name: Done
    people:
        bob:
            name: Bob Dilan
            color: #ff00bb
        jesica
        fero
```

If you include a `states:` section, it replaces the defaults.

## Drag and Drop

- Drag legend tags/people onto a task to add them.
- Drag pills out of a task to remove them.
- Drag tasks between kanban columns to change `!state`.
- Drag a kanban card onto the graph to clear `!state`.

When a tag, person, or state is added via drag, it is inserted at the start of the first description line under the task. If no token line exists, one is created under the task and a blank line is left for the description.

## Checkboxes

Checkboxes in task descriptions can be toggled directly on the graph, and the editor text updates accordingly.
Use `[ ]` or `[x]` for checkbox items.

## Task Edit Modal

Double-click a graph node or kanban card to open the edit modal.

- Title field edits the task name.
- Preview shows rendered markdown; checkboxes update the code editor.
- State/people/tags palettes show display names and colors; drag into the preview to add.
- Drag pills out of the preview to remove tokens.

## Kanban Cards

The kanban board sits below the graph.

Each kanban card shows the task name plus pills for the first assigned person and any tags.

State pills use the configured state colors when available.

## Kanban Grouping & Resizing

- Use the grouping switch (none/person/tag) to add swimlanes; empty groups are hidden.
- Drag the horizontal divider to resize the kanban panel; drag to collapse it while keeping the legend visible.

## Deleting Tasks

Drag a task to the trash icon to remove it. The confirmation modal offers:
- **Remove**: deletes the task and promotes its subtasks.
- **Remove with all subtasks**: deletes the entire subtree.
