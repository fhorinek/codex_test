# Task Script Board

Task Script Board turns a simple text script into an interactive graph and kanban board. Edit the text on the left and watch the board update live on the right.

## Quick Start
1. Run the local server:

```bash
python serve.py
```

2. Open `http://0.0.0.0:4000` in your browser.
3. Edit the script in the left pane.

## Task Format
- Task lines start with `%`.
- Subtasks are indented by 4 spaces.
- Put the token line directly under the task line.

```text
% Kickoff sprint
!todo @maya #planning #ux
Description line 1
Description line 2

    % Collect requirements
    !inprogress @sam #research
    [ ] Write interview guide
```

## What You Can Do
- Pan and zoom the graph.
- Drag tasks onto other tasks to make subtasks.
- Drag kanban cards between columns to change state.
- Drag tags/people onto tasks to add them; drag pills out to remove.
- Toggle checkboxes directly on the graph.
- Filter by tags/people or search by name, description, tags, or people.

## Config Header (Optional)
Define board name, people, tags, and states before the first task line.

```text
Atlas board:
    people:
        maya:
            name: Maya Rivera
    tags:
        planning
```

If `states` are omitted, defaults are `todo`, `inprogress`, `done`.

## Project Structure
- `index.html` main entry.
- `scripts/` JavaScript modules.
- `styles/` CSS.
