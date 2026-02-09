import { parseTasks, renderMarkdown } from "./task.js";
import { createEditor } from "./editor.js";
import { createCanvas } from "./canvas.js";
import {
  buildKanban as buildKanbanView,
  updateTaskState as updateTaskStateInEditor,
  updateTaskToken as updateTaskTokenInEditor,
} from "./kanban.js";
import { formatTaskScript } from "./formatter.js";

const REMOTE_BASE = window.location.origin;
const WS_BASE = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`;
const AUTH_TOKEN = "devtoken";
const COLLAB_LIBS = {
  yjs: "yjs",
  ywebsocket: "y-websocket",
  ytextarea: "y-textarea",
};
const COLLAB_COLORS = [
  { r: 45, g: 80, b: 237 },
  { r: 232, g: 93, b: 73 },
  { r: 54, g: 170, b: 119 },
  { r: 176, g: 98, b: 216 },
  { r: 240, g: 173, b: 78 },
  { r: 66, g: 153, b: 225 },
  { r: 236, g: 112, b: 99 },
];
const IDLE_TIMEOUT_MS = 60000;
const IDLE_CHECK_MS = 5000;
const STATUS_LABELS = {
  connected: "live",
  connecting: "reconnecting",
  disconnected: "error/failed",
  syncing: "syncing",
  "auth-failed": "auth failed",
  "read-only": "read-only",
  offline: "offline",
  idle: "idle",
};

function getCollabIdentity(preferredName) {
  try {
    const cached = localStorage.getItem("collabIdentity");
    if (cached) {
      const parsed = JSON.parse(cached);
      if (
        parsed &&
        typeof parsed.name === "string" &&
        parsed.color &&
        Number.isFinite(parsed.color.r) &&
        Number.isFinite(parsed.color.g) &&
        Number.isFinite(parsed.color.b)
      ) {
        const nextIdentity = {
          name: preferredName || parsed.name,
          color: parsed.color,
        };
        if (preferredName && preferredName !== parsed.name) {
          try {
            localStorage.setItem("collabIdentity", JSON.stringify(nextIdentity));
          } catch {
            // Ignore storage failures.
          }
        }
        return nextIdentity;
      }
    }
  } catch {
    // Ignore cached identity errors.
  }
  const name = preferredName || `User ${Math.floor(100 + Math.random() * 900)}`;
  const color = COLLAB_COLORS[Math.floor(Math.random() * COLLAB_COLORS.length)];
  const identity = { name, color };
  try {
    localStorage.setItem("collabIdentity", JSON.stringify(identity));
  } catch {
    // Ignore storage failures.
  }
  return identity;
}

const dom = {
  editor: document.getElementById("task-editor"),
  highlightLayer: document.getElementById("highlight-layer"),
  suggestions: document.getElementById("suggestions"),
  graphNodes: document.getElementById("graph-nodes"),
  graphLines: document.getElementById("graph-lines"),
  graphMinimap: document.getElementById("graph-minimap"),
  minimapSvg: document.getElementById("minimap-svg"),
  lineNumbers: document.getElementById("line-numbers"),
  searchInput: document.getElementById("search-input"),
  searchName: document.getElementById("search-name"),
  searchDescription: document.getElementById("search-description"),
  searchTag: document.getElementById("search-tag"),
  searchPerson: document.getElementById("search-person"),
  boardTitle: document.getElementById("board-title"),
  boardConnection: document.getElementById("board-connection"),
  undoButton: document.getElementById("undo-button"),
  redoButton: document.getElementById("redo-button"),
  loadButton: document.getElementById("load-button"),
  saveButton: document.getElementById("save-button"),
  formatButton: document.getElementById("format-button"),
  connectButton: document.getElementById("connect-button"),
  themeButton: document.getElementById("theme-button"),
  fullscreenButton: document.getElementById("fullscreen-button"),
  fileInput: document.getElementById("file-input"),
  loginModal: document.getElementById("login-modal"),
  loginModalClose: document.getElementById("login-modal-close"),
  loginUsername: document.getElementById("login-username"),
  loginDisplayName: document.getElementById("login-displayname"),
  loginPassword: document.getElementById("login-password"),
  loginSubmit: document.getElementById("login-submit"),
  loginError: document.getElementById("login-error"),
  spacesModal: document.getElementById("spaces-modal"),
  spacesModalClose: document.getElementById("spaces-modal-close"),
  logoutButton: document.getElementById("logout-button"),
  spaceNew: document.getElementById("space-new"),
  spaceCreate: document.getElementById("space-create"),
  spaceError: document.getElementById("space-error"),
  spaceList: document.getElementById("space-list"),
  deleteModal: document.getElementById("delete-modal"),
  deleteModalMessage: document.getElementById("delete-modal-message"),
  deleteConfirm: document.getElementById("delete-confirm"),
  deleteCancel: document.getElementById("delete-cancel"),
  kanbanBoard: document.getElementById("kanban-board"),
  kanbanDivider: document.getElementById("kanban-divider"),
  graphPanel: document.querySelector(".graph-panel"),
  tagList: document.getElementById("tag-list"),
  personList: document.getElementById("person-list"),
  clearFilters: document.getElementById("clear-filters"),
  graphCanvas: document.getElementById("graph-canvas"),
  divider: document.getElementById("divider"),
};

function setButtonIcon(button, icon) {
  if (!button) {
    return;
  }
  let iconEl = button.querySelector("i");
  if (!iconEl) {
    iconEl = document.createElement("i");
    iconEl.setAttribute("aria-hidden", "true");
    button.textContent = "";
    button.appendChild(iconEl);
  }
  iconEl.className = `fa-solid ${icon}`;
}

const state = {
  tasks: [],
  allTasks: [],
  tags: new Set(),
  people: new Set(),
  states: new Set(),
  invalidStateTags: new Map(),
  config: null,
  tagMeta: new Map(),
  peopleMeta: new Map(),
  stateMeta: new Map(),
  selectedTags: new Set(),
  selectedPeople: new Set(),
  collapsed: new Set(),
  selectedTaskId: null,
  selectedLine: null,
  searchQuery: "",
  transform: { x: 40, y: 40, scale: 1 },
  animateTransform: false,
  positions: new Map(),
  suggestionIndex: 0,
  suggestionItems: [],
};

const collab = {
  spaceId: null,
  provider: null,
  ydoc: null,
  ytext: null,
  binding: null,
  bindingOptions: null,
  saveTimer: null,
  presenceTimer: null,
  spacePoller: null,
  lastSpaceSnapshot: "",
  idleTimer: null,
  lastActivityAt: 0,
  synced: false,
  syncScheduled: false,
  modules: null,
  identity: getCollabIdentity(),
  username: "",
  displayName: "",
  authToken: AUTH_TOKEN,
  isAuthenticated: false,
  connectionStatus: "disconnected",
};

let pendingDeleteSpace = null;

function getStoredAuth() {
  try {
    const cached = localStorage.getItem("collabAuth");
    if (!cached) {
      return null;
    }
    const parsed = JSON.parse(cached);
    if (parsed && typeof parsed === "object") {
      return {
        username: typeof parsed.username === "string" ? parsed.username : "",
        displayName: typeof parsed.displayName === "string" ? parsed.displayName : "",
        authToken: typeof parsed.authToken === "string" ? parsed.authToken : AUTH_TOKEN,
      };
    }
  } catch {
    // Ignore cached auth errors.
  }
  return null;
}

function persistAuth(auth) {
  try {
    localStorage.setItem("collabAuth", JSON.stringify(auth));
  } catch {
    // Ignore storage failures.
  }
}

function readAuthInputs() {
  const username = dom.loginUsername?.value?.trim() || "";
  const displayName = dom.loginDisplayName?.value?.trim() || "";
  const authToken = dom.loginPassword?.value || AUTH_TOKEN;
  return { username, displayName, authToken };
}

function applyAuthFromInputs({ store = true, markDirty = true } = {}) {
  const { username, displayName, authToken } = readAuthInputs();
  const safeUsername = username || "user";
  const displayLabel = displayName || safeUsername;
  collab.username = safeUsername;
  collab.displayName = displayName;
  collab.authToken = authToken || AUTH_TOKEN;
  collab.identity = getCollabIdentity(displayLabel);
  if (markDirty) {
    collab.isAuthenticated = false;
  }
  if (collab.bindingOptions) {
    collab.bindingOptions.clientName = collab.identity.name;
    collab.bindingOptions.color = collab.identity.color;
    if (collab.provider?.awareness && dom.editor?.id) {
      collab.provider.awareness.setLocalStateField(dom.editor.id, {
        user: collab.provider.awareness.clientID,
        selection: false,
        name: collab.identity.name,
        color: collab.identity.color,
      });
    }
  }
  updateBoardConnectionLabel();
  if (collab.spaceId) {
    startPresenceHeartbeat(collab.spaceId);
  }
  if (store) {
    persistAuth({
      username: safeUsername,
      displayName,
      authToken: collab.authToken,
    });
  }
}

function initializeAuthInputs() {
  const stored = getStoredAuth();
  if (dom.loginUsername) {
    dom.loginUsername.value = stored?.username || dom.loginUsername.value || "user";
  }
  if (dom.loginDisplayName) {
    dom.loginDisplayName.value =
      stored?.displayName || dom.loginDisplayName.value || "";
  }
  if (dom.loginPassword) {
    dom.loginPassword.value = stored?.authToken || dom.loginPassword.value || AUTH_TOKEN;
  }
  applyAuthFromInputs({ store: false, markDirty: false });
}

function getServerLabel() {
  try {
    return new URL(REMOTE_BASE).hostname;
  } catch {
    return REMOTE_BASE.replace(/^https?:\/\//, "").split(":")[0];
  }
}

function setConnectionStatus(status) {
  if (collab.connectionStatus === status) {
    return;
  }
  collab.connectionStatus = status;
  updateBoardConnectionLabel();
}

function markActivity() {
  collab.lastActivityAt = Date.now();
  if (collab.connectionStatus === "idle" && collab.synced) {
    setConnectionStatus("connected");
  }
}

function startIdleWatch() {
  collab.lastActivityAt = Date.now();
  if (collab.idleTimer) {
    clearInterval(collab.idleTimer);
  }
  collab.idleTimer = setInterval(() => {
    if (!collab.spaceId || !collab.synced) {
      return;
    }
    if (["offline", "auth-failed", "read-only"].includes(collab.connectionStatus)) {
      return;
    }
    if (Date.now() - collab.lastActivityAt > IDLE_TIMEOUT_MS) {
      setConnectionStatus("idle");
    }
  }, IDLE_CHECK_MS);
}

function stopIdleWatch() {
  if (collab.idleTimer) {
    clearInterval(collab.idleTimer);
    collab.idleTimer = null;
  }
}

function updateBoardConnectionLabel() {
  if (!dom.boardConnection) {
    return;
  }
  if (collab.spaceId) {
    const status = collab.connectionStatus || "disconnected";
    const statusLabel = STATUS_LABELS[status] || STATUS_LABELS.disconnected;
    dom.boardConnection.textContent = "";
    const text = document.createElement("span");
    text.textContent = `${collab.username}@${getServerLabel()}/${collab.spaceId}`;
    const pill = document.createElement("span");
    pill.className = `connection-status ${status}`;
    pill.textContent = statusLabel;
    dom.boardConnection.append(text, pill);
    dom.boardConnection.classList.remove("hidden");
  } else {
    dom.boardConnection.textContent = "";
    const text = document.createElement("span");
    text.textContent = "offline mode";
    dom.boardConnection.append(text);
    dom.boardConnection.classList.remove("hidden");
  }
}

const sample = `Example board:\n    people:\n        maya:\n            name: Maya Rivera\n        luis:\n            name: Luis Ortega\n        sam:\n            name: Sam Patel\n        nina:\n            name: Nina Lopez\n        zara:\n            name: Zara Chen\n    tags:\n        planning\n        backend\n        ux\n        research\n\n% Kickoff sprint\n!todo @maya #planning #ux\n**Goal:** Align scope, risks, and owners. {Architecture}\n- Define success metrics\n- Draft roadmap milestones\n[ ] Share notes with stakeholders\n[ ] Lock sprint goals\n\n    % Collect requirements\n    !inprogress @sam #research\n    Interview 5 users and summarize themes.\n    [ ] Write interview guide\n    [x] Schedule sessions\n\n        % Summarize insights\n        !todo @nina #research #planning\n        Capture themes and map to product risks.\n\n    % Create UX flow\n    !todo @maya #ux\n    Map onboarding screens and happy path.\n    - Wireframe key screens\n    - Validate navigation\n\n% Architecture\n!inprogress @luis #backend\nDefine data contracts and core services.\n| Area | Owner | Status |\n| --- | --- | --- |\n| API | Luis | Draft |\n| Data | Maya | Review |\n\n    % Build service skeleton\n    !todo @luis #backend\n    [ ] Set up repo and CI\n    [ ] Define API endpoints\n\n    % Integrate auth\n    !todo @sam #backend\n    Connect OAuth provider and session storage.\n\n        % Validate permissions\n        !todo @zara #backend #research\n        Check scopes and error handling.\n\n% Release prep\n!todo @maya #planning\nFinalize checklist and release timeline.\n{Kickoff sprint}\n`;

dom.editor.value = sample;

const editorController = createEditor({
  state,
  dom,
  onSync: sync,
  onSelectTask: handleEditorSelection,
});

const canvasController = createCanvas({
  state,
  dom,
  renderMarkdown,
  onSelectTask: selectTask,
  findTaskByName,
  onUpdateTaskToken: updateTaskToken,
  onUpdateTaskState: updateTaskState,
  onMakeSubtask: moveTaskAsSubtask,
  onToggleCheckbox: toggleCheckboxAtLine,
  onFiltersChange: () => {
    buildTagPersonLists();
    buildKanban();
    updateClearFiltersVisibility();
  },
});

function applyEditorValue(nextValue) {
  const { editor } = dom;
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const scrollTop = editor.scrollTop;
  const scrollLeft = editor.scrollLeft;
  const currentValue = editor.value;
  if (currentValue === nextValue) {
    return;
  }
  // Apply a minimal text diff to preserve undo history and selection.
  let prefix = 0;
  const maxPrefix = Math.min(currentValue.length, nextValue.length);
  while (prefix < maxPrefix && currentValue[prefix] === nextValue[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  const maxSuffix = Math.min(
    currentValue.length - prefix,
    nextValue.length - prefix
  );
  while (
    suffix < maxSuffix &&
    currentValue[currentValue.length - 1 - suffix] ===
    nextValue[nextValue.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const oldReplaceStart = prefix;
  const oldReplaceEnd = currentValue.length - suffix;
  const newReplace = nextValue.slice(prefix, nextValue.length - suffix);
  editor.focus();
  editor.setSelectionRange(oldReplaceStart, oldReplaceEnd);
  let replaced = false;
  try {
    replaced = document.execCommand("insertText", false, newReplace);
  } catch {
    replaced = false;
  }
  if (!replaced) {
    editor.setRangeText(newReplace, oldReplaceStart, oldReplaceEnd, "end");
  }
  const delta = nextValue.length - currentValue.length;
  const adjustOffset = (pos) => {
    if (pos <= oldReplaceStart) {
      return pos;
    }
    if (pos >= oldReplaceEnd) {
      return pos + delta;
    }
    return oldReplaceStart + newReplace.length;
  };
  const clampedStart = Math.min(adjustOffset(start), editor.value.length);
  const clampedEnd = Math.min(adjustOffset(end), editor.value.length);
  editor.setSelectionRange(clampedStart, clampedEnd);
  editor.scrollTop = scrollTop;
  editor.scrollLeft = scrollLeft;
}

function dispatchEditorInput() {
  if (!dom.editor) {
    return;
  }
  dom.editor.dispatchEvent(new Event("input", { bubbles: true }));
}

function forceEditorRefresh(value) {
  applyEditorValue(value);
  syncEditorState();
  dispatchEditorInput();
}

function handleEditorSelection(line) {
  const task = state.allTasks.find((item) => item.lineIndex === line);
  if (task) {
    state.selectedTaskId = task.id;
    state.selectedLine = task.lineIndex;
    canvasController.focusOnTask(task);
    canvasController.renderGraph();
  } else {
    editorController.updateSelectedLine();
  }
}

function selectTask(task) {
  state.selectedTaskId = task.id;
  state.selectedLine = task.lineIndex;
  let current = task.parent;
  while (current) {
    state.collapsed.delete(current.id);
    current = current.parent;
  }
  const lines = dom.editor.value.split("\n");
  const targetLine = task.lineIndex;
  const caretPosition = lines.slice(0, targetLine).reduce((sum, line) => sum + line.length + 1, 0);
  dom.editor.focus();
  dom.editor.setSelectionRange(caretPosition, caretPosition);
  editorController.updateSelectedLine();
  editorController.highlightText(dom.editor.value.split("\n"));
  canvasController.focusOnTask(task);
  canvasController.renderGraph();
}

function buildTagPersonLists() {
  dom.tagList.innerHTML = "";
  dom.personList.innerHTML = "";
  const tagOrder = state.config?.tags?.map((tag) => `#${tag.key}`) || [];
  const extraTags = Array.from(state.tags).filter((tag) => !tagOrder.includes(tag)).sort();
  const tags = [...tagOrder, ...extraTags];
  tags.forEach((tag) => {
    const meta = state.tagMeta?.get(tag);
    dom.tagList.appendChild(
      canvasController.buildPill(
        tag,
        state.selectedTags.has(tag),
        () => {
          canvasController.toggleTag(tag);
        },
        meta
      )
    );
  });
  const peopleOrder = state.config?.people?.map((person) => `@${person.key}`) || [];
  const extraPeople = Array.from(state.people)
    .filter((person) => !peopleOrder.includes(person))
    .sort();
  const people = [...peopleOrder, ...extraPeople];
  people.forEach((person) => {
    const meta = state.peopleMeta?.get(person);
    dom.personList.appendChild(
      canvasController.buildPill(
        person,
        state.selectedPeople.has(person),
        () => {
          canvasController.togglePerson(person);
        },
        meta
      )
    );
  });
}

function sync() {
  const {
    tasks,
    tags,
    people,
    states,
    invalidStateTags,
    lines,
    allTasks,
    config,
    tagMeta,
    peopleMeta,
    stateMeta,
  } = parseTasks(dom.editor.value);
  state.tasks = tasks;
  state.allTasks = allTasks;
  state.tags = tags;
  state.people = people;
  state.states = states;
  state.invalidStateTags = invalidStateTags;
  state.config = config;
  state.tagMeta = tagMeta;
  state.peopleMeta = peopleMeta;
  state.stateMeta = stateMeta;
  if (dom.boardTitle) {
    const title = config.boardName || "Task Script";
    dom.boardTitle.textContent = title;
    document.title = title;
  }
  if (state.selectedLine === null) {
    state.selectedLine = 0;
  }
  editorController.highlightText(lines);
  buildTagPersonLists();
  buildKanban();
  canvasController.renderGraph();
  editorController.updateSuggestions();
  updateClearFiltersVisibility();
}

function buildKanban() {
  buildKanbanView({
    state,
    dom,
    selectTask,
    matchesSearchTask,
    filtersActive,
    matchesFilters,
    updateTaskState,
  });
}

function updateTaskState(task, newState) {
  updateTaskStateInEditor({ task, newState, dom, sync, applyEditorValue });
}

function updateTaskToken(task, token, action) {
  updateTaskTokenInEditor({ task, token, action, dom, sync, applyEditorValue });
}

function moveTaskAsSubtask(sourceTask, targetTask) {
  if (!sourceTask || !targetTask || sourceTask.id === targetTask.id) {
    return;
  }
  let current = targetTask.parent;
  while (current) {
    if (current.id === sourceTask.id) {
      return;
    }
    current = current.parent;
  }
  const lines = dom.editor.value.split("\n");
  const sourceBlock = findTaskBlock(lines, sourceTask.lineIndex);
  const targetBlock = findTaskBlock(lines, targetTask.lineIndex);
  if (!sourceBlock || !targetBlock) {
    return;
  }
  // Move the entire source block and re-indent it under the target task.
  const indentDelta = (targetBlock.depth + 1 - sourceBlock.depth) * 4;
  const blockLines = lines.slice(sourceBlock.start, sourceBlock.end);
  lines.splice(sourceBlock.start, sourceBlock.end - sourceBlock.start);
  let insertIndex = targetBlock.end;
  if (sourceBlock.start < insertIndex) {
    insertIndex -= blockLines.length;
  }
  const adjustedLines = blockLines.map((line) => adjustIndent(line, indentDelta));
  lines.splice(insertIndex, 0, ...adjustedLines);
  applyEditorValue(lines.join("\n"));
  syncEditorState();
}

function findTaskByName(name) {
  return state.allTasks.find((task) => task.name === name);
}

function syncEditorState() {
  sync();
  editorController.updateSelectedLine();
}

function findTaskBlock(lines, lineIndex) {
  const taskLine = lines[lineIndex] || "";
  const match = taskLine.match(/^(\s*)%/);
  if (!match) {
    return null;
  }
  const indent = match[1] || "";
  const depth = Math.floor(indent.length / 4);
  let end = lineIndex + 1;
  while (end < lines.length) {
    const line = lines[end];
    const taskMatch = line.match(/^(\s*)%/);
    if (taskMatch) {
      const lineDepth = Math.floor(taskMatch[1].length / 4);
      if (lineDepth <= depth) {
        break;
      }
    }
    end += 1;
  }
  return { start: lineIndex, end, depth, indent };
}

function adjustIndent(line, deltaSpaces) {
  if (!deltaSpaces || !line.trim()) {
    return line;
  }
  if (deltaSpaces > 0) {
    return `${" ".repeat(deltaSpaces)}${line}`;
  }
  const leading = line.match(/^\s*/)?.[0] || "";
  const removeCount = Math.min(leading.length, Math.abs(deltaSpaces));
  return line.slice(removeCount);
}

function toggleCheckboxAtLine(lineIndex, checked = null) {
  const lines = dom.editor.value.split("\n");
  const line = lines[lineIndex];
  if (!line) {
    return;
  }
  const match = line.match(/^(\s*\[)([ xX])(\])/);
  if (!match) {
    return;
  }
  const nextValue =
    checked === null
      ? match[2].toLowerCase() === "x"
        ? " "
        : "x"
      : checked
        ? "x"
        : " ";
  lines[lineIndex] = line.replace(/^(\s*\[)([ xX])(\])/, `$1${nextValue}$3`);
  applyEditorValue(lines.join("\n"));
  syncEditorState();
}

function toSafeFilename(value) {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "tasks";
}

function tokenMatchesQuery(token, metaMap, query) {
  if (token.toLowerCase().includes(query)) {
    return true;
  }
  if (!metaMap) {
    return false;
  }
  const meta = metaMap.get(token);
  if (!meta) {
    return false;
  }
  const name = typeof meta.name === "string" ? meta.name.toLowerCase() : "";
  const key = typeof meta.key === "string" ? meta.key.toLowerCase() : "";
  return (name && name.includes(query)) || (key && key.includes(query));
}

function tokensMatchQuery(tokens, metaMap, query) {
  return tokens.some((token) => tokenMatchesQuery(token, metaMap, query));
}

function matchesSearchTask(task) {
  if (!state.searchQuery) {
    return false;
  }
  const query = state.searchQuery.toLowerCase();
  if (dom.searchName.checked && task.name.toLowerCase().includes(query)) {
    return true;
  }
  if (dom.searchDescription.checked && task.description.join(" ").toLowerCase().includes(query)) {
    return true;
  }
  if (dom.searchTag.checked && tokensMatchQuery(task.tags, state.tagMeta, query)) {
    return true;
  }
  if (dom.searchPerson.checked && tokensMatchQuery(task.people, state.peopleMeta, query)) {
    return true;
  }
  return false;
}

function filtersActive() {
  return state.selectedTags.size || state.selectedPeople.size;
}

function updateClearFiltersVisibility() {
  if (!dom.clearFilters) {
    return;
  }
  const hasFilters = filtersActive();
  const hasSearch = Boolean(state.searchQuery && state.searchQuery.trim());
  dom.clearFilters.hidden = !(hasFilters || hasSearch);
}

async function loadCollabModules() {
  if (collab.modules) {
    return collab.modules;
  }
  const [Y, websocket, textarea] = await Promise.all([
    import(COLLAB_LIBS.yjs),
    import(COLLAB_LIBS.ywebsocket),
    import(COLLAB_LIBS.ytextarea),
  ]);
  collab.modules = {
    Y,
    WebsocketProvider: websocket.WebsocketProvider,
    TextAreaBinding: textarea.TextAreaBinding || textarea.TextareaBinding,
  };
  return collab.modules;
}

function authHeaders() {
  const user = collab.username || "user";
  const pass = collab.authToken || AUTH_TOKEN;
  const token = btoa(`${user}:${pass}`);
  return {
    Authorization: `Basic ${token}`,
  };
}

async function fetchSpaces() {
  let response;
  try {
    response = await fetch(`${REMOTE_BASE}/api/spaces`, {
      headers: authHeaders(),
    });
  } catch {
    throw new Error("Unable to reach the backend.");
  }
  if (response.status === 401) {
    throw new Error("Unauthorized");
  }
  if (!response.ok) {
    throw new Error("Unable to fetch spaces.");
  }
  const data = await response.json();
  if (!Array.isArray(data.spaces)) {
    return [];
  }
  return data.spaces
    .map((space) => {
      if (typeof space === "string") {
        return { id: space, users: [] };
      }
      if (space && typeof space === "object") {
        const id = space.id || space.name || space.space || "";
        const users = Array.isArray(space.users) ? space.users : [];
        return { id, users };
      }
      return { id: "", users: [] };
    })
    .filter((space) => space.id);
}

function renderSpaceList(spaces) {
  if (!dom.spaceList) {
    return;
  }
  dom.spaceList.innerHTML = "";
  if (!spaces.length) {
    const empty = document.createElement("div");
    empty.className = "modal-help";
    empty.textContent = "No spaces yet. Create one above.";
    dom.spaceList.appendChild(empty);
    return;
  }
  spaces.forEach((space) => {
    const row = document.createElement("div");
    row.className = "space-item";
    const header = document.createElement("div");
    header.className = "space-row";

    const label = document.createElement("span");
    label.className = "space-label";
    label.textContent = space.id;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "space-input";
    input.value = space.id;

    const actions = document.createElement("div");
    actions.className = "space-actions";

    const connectButton = document.createElement("button");
    connectButton.type = "button";
    connectButton.className = "toolbar-button space-connect";
    connectButton.textContent = collab.spaceId === space.id ? "Active" : "Connect";
    connectButton.disabled = collab.spaceId === space.id;
    if (collab.spaceId === space.id) {
      connectButton.classList.add("space-active");
    }
    connectButton.addEventListener("click", () => {
      connectToSpace(space.id);
    });

    const rename = document.createElement("button");
    rename.type = "button";
    rename.className = "toolbar-button space-edit";
    rename.innerHTML = '<i class="fa-solid fa-pen-to-square" aria-hidden="true"></i>';
    rename.title = "Rename";
    rename.setAttribute("aria-label", "Rename");
    rename.addEventListener("click", () => {
      row.classList.add("editing");
      input.value = space.id;
      input.focus();
      input.select();
    });

    const save = document.createElement("button");
    save.type = "button";
    save.className = "toolbar-button space-save";
    save.innerHTML = '<i class="fa-solid fa-check" aria-hidden="true"></i>';
    save.title = "Save";
    save.setAttribute("aria-label", "Save");
    const commitRename = async () => {
      const trimmed = input.value.trim();
      if (!trimmed || trimmed === space.id) {
        row.classList.remove("editing");
        return;
      }
      try {
        await renameSpace(space.id, trimmed);
        clearSpaceError();
        row.classList.remove("editing");
        await loadSpaceList({ showLoading: false });
        if (collab.spaceId === space.id) {
          connectToSpace(trimmed);
        }
      } catch (error) {
        setSpaceError(formatSpaceError(error, "Unable to rename space."));
      }
    };
    save.addEventListener("click", commitRename);

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "toolbar-button space-cancel";
    cancel.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
    cancel.title = "Cancel";
    cancel.setAttribute("aria-label", "Cancel");
    cancel.addEventListener("click", () => {
      row.classList.remove("editing");
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commitRename();
      } else if (event.key === "Escape") {
        event.preventDefault();
        row.classList.remove("editing");
      }
    });
    input.addEventListener("input", () => {
      clearSpaceError();
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "toolbar-button danger";
    remove.innerHTML = '<i class="fa-solid fa-trash" aria-hidden="true"></i>';
    remove.title = "Delete";
    remove.setAttribute("aria-label", "Delete");
    remove.addEventListener("click", async () => {
      openDeleteModal(space.id);
    });

    actions.appendChild(connectButton);
    actions.appendChild(rename);
    actions.appendChild(save);
    actions.appendChild(cancel);
    actions.appendChild(remove);
    header.appendChild(label);
    header.appendChild(input);
    header.appendChild(actions);

    const users = document.createElement("div");
    users.className = "space-users";
    if (space.users.length) {
      space.users.forEach((user) => {
        const pill = document.createElement("span");
        pill.className = "space-user-pill";
        pill.textContent = user;
        users.appendChild(pill);
      });
    } else {
      const empty = document.createElement("span");
      empty.className = "space-users-empty";
      empty.textContent = "No users connected";
      users.appendChild(empty);
    }

    row.appendChild(header);
    row.appendChild(users);
    dom.spaceList.appendChild(row);
  });
}

async function loadSpaceList({ showLoading = true } = {}) {
  if (!dom.spaceList) {
    return;
  }
  if (showLoading) {
    dom.spaceList.innerHTML = "";
    const loading = document.createElement("div");
    loading.className = "modal-help";
    loading.textContent = "Loading spaces…";
    dom.spaceList.appendChild(loading);
  }
  try {
    const spaces = await fetchSpaces();
    const snapshot = JSON.stringify(
      spaces.map((space) => ({ id: space.id, users: [...space.users].sort() }))
    );
    if (snapshot === collab.lastSpaceSnapshot) {
      return;
    }
    collab.lastSpaceSnapshot = snapshot;
    renderSpaceList(spaces);
  } catch (error) {
    if (showLoading) {
      dom.spaceList.innerHTML = "";
      const message = document.createElement("div");
      message.className = "modal-help error";
      message.textContent = "Unable to reach the backend.";
      dom.spaceList.appendChild(message);
    }
    collab.isAuthenticated = false;
    updateConnectButtonLabel();
  }
}

function setSpaceError(message) {
  if (!dom.spaceError) {
    return;
  }
  dom.spaceError.textContent = message;
  dom.spaceError.classList.remove("hidden");
}

function clearSpaceError() {
  if (!dom.spaceError) {
    return;
  }
  dom.spaceError.textContent = "";
  dom.spaceError.classList.add("hidden");
}

function updateCreateSpaceButton() {
  if (!dom.spaceCreate || !dom.spaceNew) {
    return;
  }
  const hasName = Boolean(dom.spaceNew.value.trim());
  dom.spaceCreate.disabled = !hasName;
}

function openDeleteModal(spaceId) {
  if (!dom.deleteModal || !dom.deleteModalMessage) {
    return;
  }
  pendingDeleteSpace = spaceId;
  dom.deleteModalMessage.textContent = `Delete space "${spaceId}"? This cannot be undone.`;
  dom.deleteModal.classList.remove("hidden");
}

function closeDeleteModal() {
  if (!dom.deleteModal) {
    return;
  }
  dom.deleteModal.classList.add("hidden");
  pendingDeleteSpace = null;
}

function formatSpaceError(error, fallback) {
  if (error instanceof Error && error.message) {
    if (error.message === "Failed to fetch") {
      return "Unable to reach the backend.";
    }
    return error.message;
  }
  return fallback;
}

async function loadSpaceText(spaceId) {
  const trimmed = spaceId.trim();
  if (!trimmed) {
    return;
  }
  try {
    applyAuthFromInputs({ markDirty: false });
    disconnectSpace();
    const response = await fetch(
      `${REMOTE_BASE}/api/spaces/${encodeURIComponent(trimmed)}`,
      { headers: authHeaders() }
    );
    if (!response.ok) {
      throw new Error("Unable to load space.");
    }
    const text = await response.text();
    applyEditorValue(text);
    syncEditorState();
    closeSpacesModal();
  } catch {
    alert("Unable to load space. Check the credentials.");
  }
}

async function attemptLogin() {
  applyAuthFromInputs({ markDirty: false });
  if (dom.loginError) {
    dom.loginError.classList.add("hidden");
  }
  try {
    await fetchSpaces();
    collab.isAuthenticated = true;
    updateConnectButtonLabel();
    closeLoginModal();
    openSpacesModal();
  } catch (error) {
    collab.isAuthenticated = false;
    updateConnectButtonLabel();
    if (dom.loginError) {
      const message =
        error instanceof Error && error.message === "Unable to reach the backend."
          ? "Backend is not running."
          : "Invalid credentials.";
      dom.loginError.textContent = message;
      dom.loginError.classList.remove("hidden");
    }
  }
}

function logout() {
  disconnectSpace();
  collab.isAuthenticated = false;
  collab.username = "";
  collab.displayName = "";
  collab.authToken = AUTH_TOKEN;
  collab.identity = getCollabIdentity("user");
  try {
    localStorage.removeItem("collabAuth");
  } catch {
    // Ignore storage failures.
  }
  updateConnectButtonLabel();
  closeSpacesModal();
  openLoginModal();
}

function spaceResponseError(response, fallback) {
  if (!response) {
    return fallback;
  }
  if (response.status === 400) {
    return "Invalid space name.";
  }
  if (response.status === 401) {
    return "Invalid credentials.";
  }
  if (response.status === 403) {
    return "Not allowed.";
  }
  if (response.status === 404) {
    return "Space not found.";
  }
  if (response.status === 409) {
    return "Space name already exists.";
  }
  return fallback;
}

async function createSpace(name) {
  const trimmed = name.trim();
  if (!trimmed) {
    return;
  }
  const response = await fetch(`${REMOTE_BASE}/api/spaces/${encodeURIComponent(trimmed)}`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!response.ok) {
    throw new Error(spaceResponseError(response, "Unable to create space."));
  }
}

async function deleteSpace(name) {
  const trimmed = name.trim();
  if (!trimmed) {
    return;
  }
  applyAuthFromInputs({ markDirty: false });
  const response = await fetch(`${REMOTE_BASE}/api/spaces/${encodeURIComponent(trimmed)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!response.ok) {
    throw new Error(spaceResponseError(response, "Unable to remove space."));
  }
  if (collab.spaceId === trimmed) {
    disconnectSpace();
  }
  await loadSpaceList({ showLoading: false });
}

async function renameSpace(oldName, newName) {
  const source = oldName.trim();
  const target = newName.trim();
  if (!source || !target || source === target) {
    return;
  }
  applyAuthFromInputs({ markDirty: false });
  const response = await fetch(
    `${REMOTE_BASE}/api/spaces/${encodeURIComponent(source)}/rename`,
    {
      method: "POST",
      headers: {
        ...authHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: target }),
    }
  );
  if (!response.ok) {
    throw new Error(spaceResponseError(response, "Unable to rename space."));
  }
}

async function reportPresence(spaceId, remove = false) {
  if (!spaceId) {
    return;
  }
  const method = remove ? "DELETE" : "POST";
  fetch(`${REMOTE_BASE}/api/spaces/${encodeURIComponent(spaceId)}/presence`, {
    method,
    headers: authHeaders(),
  }).catch(() => { });
}

function startPresenceHeartbeat(spaceId) {
  if (collab.presenceTimer) {
    clearInterval(collab.presenceTimer);
  }
  reportPresence(spaceId);
  collab.presenceTimer = setInterval(() => {
    reportPresence(spaceId);
  }, 15000);
}

function stopPresenceHeartbeat(spaceId) {
  if (collab.presenceTimer) {
    clearInterval(collab.presenceTimer);
    collab.presenceTimer = null;
  }
  if (spaceId) {
    reportPresence(spaceId, true);
  }
}

function openLoginModal() {
  if (!dom.loginModal) {
    return;
  }
  if (dom.loginError) {
    dom.loginError.classList.add("hidden");
  }
  initializeAuthInputs();
  dom.loginModal.classList.remove("hidden");
}

function closeLoginModal() {
  if (!dom.loginModal) {
    return;
  }
  dom.loginModal.classList.add("hidden");
}

function openSpacesModal() {
  if (!dom.spacesModal) {
    return;
  }
  if (!collab.isAuthenticated) {
    openLoginModal();
    return;
  }
  closeLoginModal();
  closeDeleteModal();
  dom.spacesModal.classList.remove("hidden");
  applyAuthFromInputs({ markDirty: false });
  clearSpaceError();
  updateCreateSpaceButton();
  collab.lastSpaceSnapshot = "";
  loadSpaceList({ showLoading: true });
  if (collab.spacePoller) {
    clearInterval(collab.spacePoller);
  }
  collab.spacePoller = setInterval(() => {
    loadSpaceList({ showLoading: false });
  }, 8000);
}

function closeSpacesModal() {
  if (!dom.spacesModal) {
    return;
  }
  dom.spacesModal.classList.add("hidden");
  if (collab.spacePoller) {
    clearInterval(collab.spacePoller);
    collab.spacePoller = null;
  }
}

function updateConnectButtonLabel() {
  if (!dom.connectButton) {
    return;
  }
  if (collab.spaceId || collab.isAuthenticated) {
    setButtonIcon(dom.connectButton, "fa-right-left");
    dom.connectButton.title = "Switch space";
    dom.connectButton.setAttribute("aria-label", "Switch space");
  } else {
    setButtonIcon(dom.connectButton, "fa-cloud");
    dom.connectButton.title = "Login";
    dom.connectButton.setAttribute("aria-label", "Login");
  }
  updateBoardConnectionLabel();
}

function disconnectSpace() {
  stopPresenceHeartbeat(collab.spaceId);
  stopIdleWatch();
  if (collab.binding?.destroy) {
    collab.binding.destroy();
  }
  if (collab.provider) {
    collab.provider.destroy();
  }
  if (collab.ydoc) {
    collab.ydoc.destroy();
  }
  if (collab.saveTimer) {
    clearTimeout(collab.saveTimer);
  }
  collab.spaceId = null;
  collab.provider = null;
  collab.ydoc = null;
  collab.ytext = null;
  collab.binding = null;
  collab.bindingOptions = null;
  collab.saveTimer = null;
  collab.presenceTimer = null;
  collab.synced = false;
  collab.lastActivityAt = 0;
  collab.connectionStatus = "disconnected";
  updateConnectButtonLabel();
  updateBoardConnectionLabel();
}

async function hydrateFromRemote(spaceId, ytext) {
  try {
    const response = await fetch(`${REMOTE_BASE}/api/spaces/${spaceId}`, {
      headers: authHeaders(),
    });
    if (!response.ok) {
      return;
    }
    const content = await response.text();
    const current = ytext.toString();
    if (!content) {
      if (current) {
        ytext.delete(0, ytext.length);
      }
      forceEditorRefresh("");
      return;
    }
    if (!current && content) {
      ytext.insert(0, content);
      forceEditorRefresh(content);
      return;
    }
    if (current && current !== content) {
      scheduleRemoteSave();
    }
  } catch {
    // Ignore hydration errors.
  }
}

function scheduleRemoteSave() {
  if (!collab.spaceId) {
    return;
  }
  if (collab.saveTimer) {
    clearTimeout(collab.saveTimer);
  }
  collab.saveTimer = setTimeout(() => {
    const body = dom.editor.value;
    fetch(`${REMOTE_BASE}/api/spaces/${collab.spaceId}`, {
      method: "PUT",
      headers: {
        ...authHeaders(),
        "Content-Type": "text/plain",
      },
      body,
    })
      .then((response) => {
        if (response.ok) {
          return;
        }
        if (response.status === 401) {
          setConnectionStatus("auth-failed");
        } else if (response.status === 403) {
          setConnectionStatus("read-only");
        } else {
          setConnectionStatus("disconnected");
        }
      })
      .catch(() => {
        if (!navigator.onLine) {
          setConnectionStatus("offline");
        } else {
          setConnectionStatus("disconnected");
        }
      });
  }, 600);
}

function scheduleCollabSync() {
  if (collab.syncScheduled) {
    return;
  }
  collab.syncScheduled = true;
  requestAnimationFrame(() => {
    collab.syncScheduled = false;
    syncEditorState();
  });
}

async function connectToSpace(spaceId) {
  if (!spaceId || !dom.editor) {
    return;
  }
  applyAuthFromInputs({ markDirty: false });
  closeSpacesModal();
  const { Y, WebsocketProvider, TextAreaBinding } = await loadCollabModules();
  if (!TextAreaBinding) {
    return;
  }
  disconnectSpace();

  const ydoc = new Y.Doc();
  collab.synced = false;
  setConnectionStatus("connecting");
  startIdleWatch();
  const provider = new WebsocketProvider(WS_BASE, spaceId, ydoc, {
    params: { user: collab.username || "user", pass: collab.authToken || AUTH_TOKEN },
  });
  const identity =
    collab.identity ||
    getCollabIdentity(collab.displayName || collab.username || "user");
  const ytext = ydoc.getText("content");
  const bindingOptions = {
    awareness: provider.awareness,
    clientName: identity.name,
    color: identity.color,
  };
  const binding = new TextAreaBinding(ytext, dom.editor, bindingOptions);
  provider.awareness.setLocalStateField(dom.editor.id, {
    user: provider.awareness.clientID,
    selection: false,
    name: identity.name,
    color: identity.color,
  });

  collab.spaceId = spaceId;
  collab.provider = provider;
  collab.ydoc = ydoc;
  collab.ytext = ytext;
  collab.binding = binding;
  collab.bindingOptions = bindingOptions;
  updateConnectButtonLabel();
  updateBoardConnectionLabel();
  startPresenceHeartbeat(spaceId);
  hydrateFromRemote(spaceId, ytext);

  provider.on("status", ({ status }) => {
    if (!navigator.onLine) {
      setConnectionStatus("offline");
      return;
    }
    if (status === "connected") {
      setConnectionStatus(collab.synced ? "connected" : "syncing");
    } else if (status === "connecting") {
      setConnectionStatus("connecting");
    } else {
      setConnectionStatus("disconnected");
    }
  });

  provider.on("sync", (synced) => {
    collab.synced = synced;
    if (synced) {
      markActivity();
      if (!["offline", "auth-failed", "read-only"].includes(collab.connectionStatus)) {
        setConnectionStatus("connected");
      }
    } else if (collab.connectionStatus === "connecting") {
      setConnectionStatus("syncing");
    }
    if (synced) {
      hydrateFromRemote(spaceId, ytext);
    }
  });

  ytext.observe(() => {
    markActivity();
    scheduleRemoteSave();
    scheduleCollabSync();
  });
}

function matchesFilters(task) {
  if (!filtersActive()) {
    return true;
  }
  return (
    task.tags.some((tag) => state.selectedTags.has(tag)) ||
    task.people.some((person) => state.selectedPeople.has(person))
  );
}

if (dom.undoButton) {
  dom.undoButton.addEventListener("click", () => {
    dom.editor.focus();
    document.execCommand("undo");
    syncEditorState();
  });
}

if (dom.redoButton) {
  dom.redoButton.addEventListener("click", () => {
    dom.editor.focus();
    document.execCommand("redo");
    syncEditorState();
  });
}

if (dom.loadButton && dom.fileInput) {
  dom.loadButton.addEventListener("click", () => {
    dom.fileInput.click();
  });
  dom.fileInput.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    const text = await file.text();
    dom.editor.value = text;
    dom.fileInput.value = "";
    syncEditorState();
  });
}

if (dom.saveButton) {
  dom.saveButton.addEventListener("click", () => {
    const title = state.config?.boardName || dom.boardTitle?.textContent || "tasks";
    const filename = `${toSafeFilename(title)}.txt`;
    const blob = new Blob([dom.editor.value], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  });
}

if (dom.formatButton) {
  dom.formatButton.addEventListener("click", () => {
    const formatted = formatTaskScript(dom.editor.value);
    if (formatted === dom.editor.value) {
      return;
    }
    applyEditorValue(formatted);
    syncEditorState();
  });
}

function setTheme(theme) {
  const resolved = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = resolved;
  localStorage.setItem("theme", resolved);
  if (dom.themeButton) {
    setButtonIcon(dom.themeButton, resolved === "dark" ? "fa-moon" : "fa-sun");
    dom.themeButton.title = "Toggle light/dark mode";
    dom.themeButton.setAttribute("aria-label", "Toggle light/dark mode");
  }
}

if (dom.themeButton) {
  const storedTheme = localStorage.getItem("theme");
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)")?.matches;
  setTheme(storedTheme || (prefersDark ? "dark" : "light"));
  dom.themeButton.addEventListener("click", () => {
    const current = document.documentElement.dataset.theme;
    setTheme(current === "dark" ? "light" : "dark");
  });
}

if (dom.fullscreenButton) {
  dom.fullscreenButton.addEventListener("click", async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    await document.documentElement.requestFullscreen();
  });
}

if (dom.connectButton) {
  dom.connectButton.addEventListener("click", () => {
    if (collab.isAuthenticated) {
      openSpacesModal();
    } else {
      openLoginModal();
    }
  });
}

if (dom.loginSubmit) {
  dom.loginSubmit.addEventListener("click", () => {
    attemptLogin();
  });
}

if (dom.logoutButton) {
  dom.logoutButton.addEventListener("click", () => {
    logout();
  });
}

if (dom.loginModalClose) {
  dom.loginModalClose.addEventListener("click", () => {
    closeLoginModal();
  });
}

if (dom.spacesModalClose) {
  dom.spacesModalClose.addEventListener("click", () => {
    closeSpacesModal();
  });
}

if (dom.loginModal) {
  dom.loginModal.addEventListener("click", (event) => {
    if (event.target === dom.loginModal) {
      closeLoginModal();
    }
  });
  dom.loginModal.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      attemptLogin();
    }
  });
}

if (dom.spacesModal) {
  dom.spacesModal.addEventListener("click", (event) => {
    if (event.target === dom.spacesModal) {
      closeSpacesModal();
    }
  });
}

if (dom.deleteModal) {
  dom.deleteModal.addEventListener("click", (event) => {
    if (event.target === dom.deleteModal) {
      closeDeleteModal();
    }
  });
}

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeLoginModal();
    closeSpacesModal();
    closeDeleteModal();
  }
});

window.addEventListener("offline", () => {
  if (collab.spaceId) {
    setConnectionStatus("offline");
  }
});

window.addEventListener("online", () => {
  if (collab.spaceId) {
    setConnectionStatus(collab.synced ? "connected" : "connecting");
  }
});

window.addEventListener("beforeunload", () => {
  if (collab.spaceId) {
    reportPresence(collab.spaceId, true);
  }
});

if (dom.spaceCreate && dom.spaceNew) {
  dom.spaceCreate.addEventListener("click", async () => {
    try {
      applyAuthFromInputs({ markDirty: false });
      await createSpace(dom.spaceNew.value);
      dom.spaceNew.value = "";
      clearSpaceError();
      updateCreateSpaceButton();
      await loadSpaceList({ showLoading: false });
    } catch (error) {
      setSpaceError(formatSpaceError(error, "Unable to create space."));
    }
  });
  dom.spaceNew.addEventListener("keydown", async (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      try {
        applyAuthFromInputs({ markDirty: false });
        await createSpace(dom.spaceNew.value);
        dom.spaceNew.value = "";
        clearSpaceError();
        updateCreateSpaceButton();
        await loadSpaceList({ showLoading: false });
      } catch (error) {
        setSpaceError(formatSpaceError(error, "Unable to create space."));
      }
    }
  });
  dom.spaceNew.addEventListener("input", () => {
    clearSpaceError();
    updateCreateSpaceButton();
  });
  updateCreateSpaceButton();
}

if (dom.deleteCancel) {
  dom.deleteCancel.addEventListener("click", () => {
    closeDeleteModal();
  });
}

if (dom.deleteConfirm) {
  dom.deleteConfirm.addEventListener("click", async () => {
    if (!pendingDeleteSpace) {
      closeDeleteModal();
      return;
    }
    const target = pendingDeleteSpace;
    try {
      await deleteSpace(target);
      clearSpaceError();
    } catch (error) {
      setSpaceError(formatSpaceError(error, "Unable to remove space."));
    }
    closeDeleteModal();
  });
}

if (dom.loginUsername) {
  dom.loginUsername.addEventListener("input", () => {
    applyAuthFromInputs();
    dom.loginError?.classList.add("hidden");
  });
}

if (dom.loginDisplayName) {
  dom.loginDisplayName.addEventListener("input", () => {
    applyAuthFromInputs();
    dom.loginError?.classList.add("hidden");
  });
}

if (dom.loginPassword) {
  dom.loginPassword.addEventListener("input", () => {
    applyAuthFromInputs();
    dom.loginError?.classList.add("hidden");
  });
}

dom.searchInput.addEventListener("input", () => {
  state.searchQuery = dom.searchInput.value;
  canvasController.renderGraph();
  buildKanban();
  updateClearFiltersVisibility();
});

[dom.searchName, dom.searchDescription, dom.searchTag, dom.searchPerson].forEach((checkbox) => {
  checkbox.addEventListener("change", () => {
    canvasController.renderGraph();
    buildKanban();
    updateClearFiltersVisibility();
  });
});

dom.clearFilters.addEventListener("click", () => {
  state.selectedTags.clear();
  state.selectedPeople.clear();
  state.searchQuery = "";
  dom.searchInput.value = "";
  canvasController.renderGraph();
  buildTagPersonLists();
  buildKanban();
  updateClearFiltersVisibility();
});

let resizing = false;
let resizingKanban = false;
let pendingGraphRender = null;

function scheduleGraphRender() {
  if (pendingGraphRender) {
    return;
  }
  // Batch graph reflows to one per frame while dragging resizers.
  pendingGraphRender = requestAnimationFrame(() => {
    pendingGraphRender = null;
    canvasController.renderGraph();
  });
}

dom.divider.addEventListener("mousedown", () => {
  resizing = true;
  dom.divider.classList.add("dragging");
});

if (dom.kanbanDivider) {
  dom.kanbanDivider.addEventListener("mousedown", () => {
    resizingKanban = true;
    dom.kanbanDivider.classList.add("dragging");
  });
}

window.addEventListener("mousemove", (event) => {
  if (!resizing) {
    if (resizingKanban) {
      const panelRect = (dom.graphPanel || dom.graphCanvas).getBoundingClientRect();
      const dividerHeight = dom.kanbanDivider?.offsetHeight || 0;
      const minHeight = 120;
      const minGraphHeight = 200;
      const maxHeight = Math.max(minHeight, panelRect.height - minGraphHeight - dividerHeight);
      const desired = panelRect.bottom - event.clientY;
      const clamped = Math.min(maxHeight, Math.max(minHeight, desired));
      document.documentElement.style.setProperty("--kanban-height", `${clamped}px`);
      scheduleGraphRender();
      return;
    }
    return;
  }
  const rect = document.body.getBoundingClientRect();
  const percentage = (event.clientX / rect.width) * 100;
  const clamped = Math.min(70, Math.max(25, percentage));
  document.documentElement.style.setProperty("--left-width", `${clamped}%`);
  scheduleGraphRender();
});

window.addEventListener("mouseup", () => {
  if (!resizing) {
    if (resizingKanban) {
      resizingKanban = false;
      dom.kanbanDivider.classList.remove("dragging");
      scheduleGraphRender();
      return;
    }
    return;
  }
  resizing = false;
  dom.divider.classList.remove("dragging");
  if (resizingKanban) {
    resizingKanban = false;
    dom.kanbanDivider.classList.remove("dragging");
  }
  scheduleGraphRender();
});

window.addEventListener("resize", scheduleGraphRender);

updateConnectButtonLabel();
sync();
