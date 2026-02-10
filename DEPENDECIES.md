# Dependencies

Generated from local manifests and installed metadata.

## Backend

- `fastapi`
  - Web framework that exposes the REST API and serves the ASGI app.
  - Version: `0.128.5`
  - Author: unknown
  - Webpage: https://github.com/fastapi/fastapi

- `uvicorn[standard]`
  - ASGI server used to run the FastAPI backend (standard extras included).
  - Version: `0.40.0`
  - Author: Tom Christie <tom@tomchristie.com>
  - Webpage: https://uvicorn.dev/

- `ypy-websocket`
  - Yjs websocket server + persistence helpers for collaborative editing.
  - Version: `unknown`
  - Author: unknown
  - Webpage: unknown

## Frontend

- `@codemirror/autocomplete`
  - Autocomplete engine for tokens in the editor.
  - Version: `6.20.0`
  - Author: Marijn Haverbeke
  - Webpage: https://github.com/codemirror/autocomplete.git

- `@codemirror/commands`
  - Editor commands and keybindings (undo/redo, indent, etc.).
  - Version: `6.10.2`
  - Author: Marijn Haverbeke
  - Webpage: git+https://github.com/codemirror/commands.git

- `@codemirror/language`
  - Indentation and folding helpers for CodeMirror.
  - Version: `6.12.1`
  - Author: Marijn Haverbeke
  - Webpage: https://github.com/codemirror/language.git

- `@codemirror/search`
  - Search UI and keybindings in the editor.
  - Version: `6.6.0`
  - Author: Marijn Haverbeke
  - Webpage: git+https://github.com/codemirror/search.git

- `@codemirror/state`
  - Core CodeMirror state management.
  - Version: `6.5.4`
  - Author: Marijn Haverbeke
  - Webpage: git+https://github.com/codemirror/state.git

- `@codemirror/view`
  - CodeMirror editor view and DOM rendering.
  - Version: `6.39.13`
  - Author: Marijn Haverbeke
  - Webpage: git+https://github.com/codemirror/view.git

- `@fortawesome/fontawesome-free`
  - Icon set used in the UI.
  - Version: `7.1.0`
  - Author: The Font Awesome Team (https://github.com/orgs/FortAwesome/people)
  - Webpage: https://fontawesome.com

- `@replit/codemirror-indentation-markers`
  - Indentation guide markers in the editor.
  - Version: `^6.2.1`
  - Author: unknown
  - Webpage: unknown

- `y-textarea`
  - Yjs binding for the hidden textarea / editor sync.
  - Version: `1.0.2`
  - Author: Craig Matear <c.matear@gmail.com>
  - Webpage: https://github.com/cm226/y-textarea#readme

- `y-websocket`
  - Yjs websocket provider for collaboration.
  - Version: `3.0.0`
  - Author: Kevin Jahns <kevin.jahns@protonmail.com>
  - Webpage: https://github.com/yjs/y-websocket#readme

- `yjs`
  - Core CRDT engine powering collaborative editing.
  - Version: `13.6.29`
  - Author: Kevin Jahns
  - Webpage: https://docs.yjs.dev
