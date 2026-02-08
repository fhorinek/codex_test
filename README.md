# Task Script Board

Task Script Board turns a simple text script into an interactive graph and kanban board. Edit the text on the left and watch the board update live on the right.

## Quick Start (TL;DR)
```bash
bash backend/run.sh
```

## Quick Start
1. Run the server (creates a venv, installs dependencies, and starts FastAPI):

```bash
bash backend/run.sh
```

2. Open the server URL shown in the terminal output.
3. Edit the script in the left pane.

## Collaboration
The app connects to shared spaces via Yjs on the same server.

1. Create one or more space files in `backend/spaces/` (e.g. `atlas.txt`).
2. In the app, click the connect button, log in, and pick a space.
3. User credentials live in `backend/users.txt` (format: `username:password`).

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
- Connect to a shared space for live collaboration.

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
- `backend/` collaboration server (optional).
