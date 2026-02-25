import { parseTasks, parseJiraTitle, renderMarkdown } from "./task.js";
import { createEditor } from "./editor.js";
import { createCanvas } from "./canvas.js";
import {
  buildKanban as buildKanbanView,
  updateTaskState as updateTaskStateInEditor,
  updateTaskToken as updateTaskTokenInEditor,
} from "./kanban.js";
import { formatTaskScript, normalizeContent } from "./formatter.js";

const REMOTE_BASE = window.location.origin;
const WS_BASE = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`;
const AUTH_TOKEN = "";
const COLLAB_LIBS = {
  yjs: "yjs",
  ywebsocket: "y-websocket",
  ycodemirror: "y-codemirror.next",
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
const OFFLINE_DRAFT_STORAGE_KEY = "taskScript.offlineDraft.v1";
const OFFLINE_DRAFT_SAVE_INTERVAL_MS = 10000;
const SPELLCHECK_STORAGE_KEY = "taskScript.spellcheckEnabled.v1";
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

async function copyToClipboard(text) {
  if (!text) {
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand("copy");
    } catch {
      // Ignore copy failures.
    }
    document.body.removeChild(textarea);
  }
}

function createJiraTitlePill(key) {
  const pill = document.createElement("span");
  pill.className = "pill jira-pill";
  pill.textContent = key;
  pill.title = `Copy ${key}`;
  pill.addEventListener("click", (event) => {
    event.stopPropagation();
    copyToClipboard(key);
  });
  return pill;
}

function ensureSecretVisibilityToggle(input) {
  if (!input || input.dataset.secretToggle === "true") {
    return;
  }
  if (input.tagName !== "INPUT") {
    return;
  }
  const parent = input.parentNode;
  if (!parent) {
    return;
  }
  const wrapper = document.createElement("div");
  wrapper.className = "password-with-toggle";
  parent.insertBefore(wrapper, input);
  wrapper.appendChild(input);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "password-toggle";
  button.setAttribute("aria-label", "Show value");
  button.title = "Show value";
  wrapper.appendChild(button);

  const icon = document.createElement("i");
  icon.setAttribute("aria-hidden", "true");
  button.appendChild(icon);

  const refresh = () => {
    const visible = input.type === "text";
    icon.className = `fa-solid ${visible ? "fa-eye-slash" : "fa-eye"}`;
    const label = visible ? "Hide value" : "Show value";
    button.setAttribute("aria-label", label);
    button.title = label;
    button.disabled = Boolean(input.disabled);
  };

  button.addEventListener("click", () => {
    input.type = input.type === "password" ? "text" : "password";
    refresh();
  });

  input.addEventListener("input", refresh);
  input.addEventListener("blur", refresh);
  input.dataset.secretToggle = "true";
  refresh();
}

function updateTaskEditJiraPill(key) {
  if (!dom.taskEditJiraPill) {
    return;
  }
  if (!key) {
    dom.taskEditJiraPill.classList.add("hidden");
    dom.taskEditJiraPill.textContent = "";
    dom.taskEditJiraPill.title = "";
    return;
  }
  dom.taskEditJiraPill.textContent = key;
  dom.taskEditJiraPill.title = `Copy ${key}`;
  dom.taskEditJiraPill.classList.remove("hidden");
}

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
  editorHost: document.getElementById("code-editor"),
  graphNodes: document.getElementById("graph-nodes"),
  graphLines: document.getElementById("graph-lines"),
  graphMinimap: document.getElementById("graph-minimap"),
  minimapSvg: document.getElementById("minimap-svg"),
  graphAddTask: document.getElementById("graph-add-task"),
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
  loginPassword: document.getElementById("login-password"),
  loginSubmit: document.getElementById("login-submit"),
  loginError: document.getElementById("login-error"),
  spacesModal: document.getElementById("spaces-modal"),
  spacesModalClose: document.getElementById("spaces-modal-close"),
  spacesLogout: document.getElementById("spaces-logout"),
  spacesTabCurrent: document.getElementById("spaces-tab-current"),
  profileButton: document.getElementById("profile-button"),
  jiraConfigButton: document.getElementById("jira-config-button"),
  usersButton: document.getElementById("users-button"),
  profileModal: document.getElementById("profile-modal"),
  profileClose: document.getElementById("profile-close"),
  profileError: document.getElementById("profile-error"),
  profileDisplayName: document.getElementById("profile-display-name"),
  profileCurrentPassword: document.getElementById("profile-current-password"),
  profilePassword: document.getElementById("profile-password"),
  profilePasswordConfirm: document.getElementById("profile-password-confirm"),
  profileLogoutModal: document.getElementById("profile-logout-modal"),
  profileLogoutCancel: document.getElementById("profile-logout-cancel"),
  profileLogoutConfirm: document.getElementById("profile-logout-confirm"),
  profileSave: document.getElementById("profile-save"),
  jiraConfigModal: document.getElementById("jira-config-modal"),
  jiraConfigClose: document.getElementById("jira-config-close"),
  jiraConfigBaseUrl: document.getElementById("jira-config-base-url"),
  jiraConfigEmail: document.getElementById("jira-config-email"),
  jiraConfigToken: document.getElementById("jira-config-token"),
  jiraConfigSave: document.getElementById("jira-config-save"),
  jiraConfigCancel: document.getElementById("jira-config-cancel"),
  jiraConfigError: document.getElementById("jira-config-error"),
  usersModal: document.getElementById("users-modal"),
  usersClose: document.getElementById("users-close"),
  usersError: document.getElementById("users-error"),
  usersAdminSection: document.getElementById("users-admin-section"),
  usersList: document.getElementById("users-list"),
  userOpenCreate: document.getElementById("user-open-create"),
  userNewUsername: document.getElementById("user-new-username"),
  userNewDisplayName: document.getElementById("user-new-display-name"),
  userNewPassword: document.getElementById("user-new-password"),
  userNewPasswordConfirm: document.getElementById("user-new-password-confirm"),
  userNewRole: document.getElementById("user-new-role"),
  userNewSpacesField: document.getElementById("user-new-spaces-field"),
  userNewSpaces: document.getElementById("user-new-spaces"),
  userCreateModal: document.getElementById("user-create-modal"),
  userCreateClose: document.getElementById("user-create-close"),
  userCreateError: document.getElementById("user-create-error"),
  userCreate: document.getElementById("user-create"),
  userPasswordModal: document.getElementById("user-password-modal"),
  userPasswordClose: document.getElementById("user-password-close"),
  userPasswordMessage: document.getElementById("user-password-message"),
  userPasswordNew: document.getElementById("user-password-new"),
  userPasswordRepeat: document.getElementById("user-password-repeat"),
  userPasswordError: document.getElementById("user-password-error"),
  userPasswordCancel: document.getElementById("user-password-cancel"),
  userPasswordSave: document.getElementById("user-password-save"),
  userDeleteModal: document.getElementById("user-delete-modal"),
  userDeleteMessage: document.getElementById("user-delete-message"),
  userDeleteCancel: document.getElementById("user-delete-cancel"),
  userDeleteConfirm: document.getElementById("user-delete-confirm"),
  taskEditModal: document.getElementById("task-edit-modal"),
  taskEditTitleInput: document.getElementById("task-edit-title-input"),
  taskEditJiraPill: document.getElementById("task-edit-jira-pill"),
  taskEditPreview: document.getElementById("task-edit-preview"),
  taskEditCode: document.getElementById("task-edit-code"),
  taskEditCodeHost: document.getElementById("task-edit-code-editor"),
  taskEditSide: document.getElementById("task-edit-side"),
  taskEditStates: document.getElementById("task-edit-states"),
  taskEditPeople: document.getElementById("task-edit-people"),
  taskEditTags: document.getElementById("task-edit-tags"),
  taskEditCancel: document.getElementById("task-edit-cancel"),
  taskEditSave: document.getElementById("task-edit-save"),
  taskEditError: document.getElementById("task-edit-error"),
  slugRenameModal: document.getElementById("slug-rename-modal"),
  slugRenameClose: document.getElementById("slug-rename-close"),
  slugRenameMessage: document.getElementById("slug-rename-message"),
  slugRenameCurrent: document.getElementById("slug-rename-current"),
  slugRenameNew: document.getElementById("slug-rename-new"),
  slugRenameDisplayNameField: document.getElementById("slug-rename-display-name-field"),
  slugRenameDisplayNameLabel: document.getElementById("slug-rename-display-name-label"),
  slugRenameDisplayName: document.getElementById("slug-rename-display-name"),
  slugRenameColorField: document.getElementById("slug-rename-color-field"),
  slugRenameColor: document.getElementById("slug-rename-color"),
  slugRenameColorSwatches: document.getElementById("slug-rename-color-swatches"),
  slugRenameColorPicker: document.getElementById("slug-rename-color-picker"),
  slugRenameColorClear: document.getElementById("slug-rename-color-clear"),
  slugRenameColorPreview: document.getElementById("slug-rename-color-preview"),
  slugRenameEmailField: document.getElementById("slug-rename-email-field"),
  slugRenameEmailLabel: document.getElementById("slug-rename-email-label"),
  slugRenameEmail: document.getElementById("slug-rename-email"),
  slugRenameJiraStateField: document.getElementById("slug-rename-jira-state-field"),
  slugRenameJiraStateLabel: document.getElementById("slug-rename-jira-state-label"),
  slugRenameJiraState: document.getElementById("slug-rename-jira-state"),
  slugRenameCancel: document.getElementById("slug-rename-cancel"),
  slugRenameSave: document.getElementById("slug-rename-save"),
  boardRenameModal: document.getElementById("board-rename-modal"),
  boardRenameClose: document.getElementById("board-rename-close"),
  boardRenameInput: document.getElementById("board-rename-input"),
  boardRenameCancel: document.getElementById("board-rename-cancel"),
  boardRenameSave: document.getElementById("board-rename-save"),
  taskTrash: document.getElementById("task-trash"),
  taskDeleteModal: document.getElementById("task-delete-modal"),
  taskDeleteMessage: document.getElementById("task-delete-message"),
  taskDeleteCancel: document.getElementById("task-delete-cancel"),
  taskDeleteConfirm: document.getElementById("task-delete-confirm"),
  taskDeleteConfirmAll: document.getElementById("task-delete-confirm-all"),
  spaceOpenCreate: document.getElementById("space-open-create"),
  spaceOpenFolderCreate: document.getElementById("space-open-folder-create"),
  spaceCreateModal: document.getElementById("space-create-modal"),
  spaceCreateClose: document.getElementById("space-create-close"),
  spaceCreateCancel: document.getElementById("space-create-cancel"),
  spaceNew: document.getElementById("space-new"),
  spaceCreate: document.getElementById("space-create"),
  spaceFolderCreateModal: document.getElementById("space-folder-create-modal"),
  spaceFolderCreateClose: document.getElementById("space-folder-create-close"),
  spaceFolderCreateCancel: document.getElementById("space-folder-create-cancel"),
  spaceFolderNew: document.getElementById("space-folder-new"),
  spaceFolderCreate: document.getElementById("space-folder-create"),
  folderDeleteModal: document.getElementById("folder-delete-modal"),
  folderDeleteMessage: document.getElementById("folder-delete-message"),
  folderDeleteCancel: document.getElementById("folder-delete-cancel"),
  folderDeleteConfirm: document.getElementById("folder-delete-confirm"),
  spaceError: document.getElementById("space-error"),
  spaceList: document.getElementById("space-list"),
  deleteModal: document.getElementById("delete-modal"),
  deleteModalMessage: document.getElementById("delete-modal-message"),
  deleteConfirm: document.getElementById("delete-confirm"),
  deleteCancel: document.getElementById("delete-cancel"),
  kanbanBoard: document.getElementById("kanban-board"),
  kanbanContent: document.getElementById("kanban-content"),
  kanbanDivider: document.getElementById("kanban-divider"),
  kanbanGroup: document.getElementById("kanban-group"),
  graphPanel: document.querySelector(".graph-panel"),
  legend: document.querySelector(".legend"),
  tagList: document.getElementById("tag-list"),
  personList: document.getElementById("person-list"),
  clearFilters: document.getElementById("clear-filters"),
  storyPointsSummaryGraph: document.getElementById("story-points-summary-graph"),
  storyPointsSummaryKanban: document.getElementById("story-points-summary-kanban"),
  graphCanvas: document.getElementById("graph-canvas"),
  divider: document.getElementById("divider"),
  spellcheckToggleMain: document.getElementById("spellcheck-toggle-main"),
  spellcheckToggleModal: document.getElementById("spellcheck-toggle-modal"),
};

function initializeSecretToggles() {
  [
    dom.loginPassword,
    dom.jiraConfigToken,
    dom.profilePassword,
    dom.userNewPassword,
    dom.userNewPasswordConfirm,
    dom.userPasswordNew,
    dom.userPasswordRepeat,
  ].forEach((input) => ensureSecretVisibilityToggle(input));
}

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

function getStoredSpellcheckEnabled() {
  try {
    return localStorage.getItem(SPELLCHECK_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
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
  totalStoryPoints: 0,
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
  kanbanGroupBy: "none",
  taskPathMaps: new Map(),
  incomingReferenceCountByName: new Map(),
  spellcheckEnabled: getStoredSpellcheckEnabled(),
  scopedSpellcheck: true,
};

const KANBAN_GROUPS = new Set(["none", "person", "tag"]);

function normalizeKanbanGroup(value) {
  if (typeof value !== "string") {
    return "none";
  }
  const trimmed = value.trim().toLowerCase();
  return KANBAN_GROUPS.has(trimmed) ? trimmed : "none";
}

function getStoredKanbanGroup() {
  try {
    return normalizeKanbanGroup(localStorage.getItem("kanbanGroupBy"));
  } catch {
    return "none";
  }
}

function updateKanbanGroupButtons() {
  if (!dom.kanbanGroup) {
    return;
  }
  const buttons = dom.kanbanGroup.querySelectorAll("button[data-kanban-group]");
  buttons.forEach((button) => {
    const isActive = button.dataset.kanbanGroup === state.kanbanGroupBy;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-checked", isActive ? "true" : "false");
  });
}

function setKanbanGroupBy(value, { persist = true } = {}) {
  const nextValue = normalizeKanbanGroup(value);
  if (nextValue === state.kanbanGroupBy) {
    return;
  }
  state.kanbanGroupBy = nextValue;
  updateKanbanGroupButtons();
  if (persist) {
    try {
      localStorage.setItem("kanbanGroupBy", nextValue);
    } catch {
      // Ignore storage errors.
    }
  }
  buildKanban();
}

const collab = {
  spaceId: null,
  spacePath: "",
  provider: null,
  ydoc: null,
  ytext: null,
  binding: null,
  bindingMode: null,
  saveTimer: null,
  presenceTimer: null,
  spacePoller: null,
  lastSpaceSnapshot: "",
  idleTimer: null,
  lastActivityAt: 0,
  synced: false,
  syncScheduled: false,
  modules: null,
  spaceIds: [],
  spaceFolders: [],
  spaceAccessOptions: [],
  openSpaceFolderId: null,
  openSpaceFolderInitialized: false,
  identity: getCollabIdentity(),
  username: "",
  displayName: "",
  role: "user",
  mustChangePassword: false,
  permissions: {
    can_manage_spaces: false,
    can_manage_jira: false,
    can_manage_users: false,
    can_assign_space_access: false,
  },
  authToken: AUTH_TOKEN,
  isAuthenticated: false,
  connectionStatus: "disconnected",
  offlineDraftTimer: null,
  offlineDraftDirty: false,
  offlineDraftSavedValue: "",
};

let pendingDeleteSpace = null;
let pendingDeleteFolder = null;
let pendingDeleteUser = null;
let pendingPasswordUser = null;
let pendingSlugRename = null;
let slugRenameColorControlsBound = false;
let pendingBoardRename = false;
let createUserSpacesPicker = null;
let toastContainer = null;
let lastToast = { message: "", kind: "", at: 0 };

function ensureToastContainer() {
  if (toastContainer && document.body.contains(toastContainer)) {
    return toastContainer;
  }
  toastContainer = document.createElement("div");
  toastContainer.className = "toast-container";
  toastContainer.setAttribute("aria-live", "polite");
  toastContainer.setAttribute("aria-atomic", "false");
  document.body.appendChild(toastContainer);
  return toastContainer;
}

function showToast(message, kind = "success", durationMs = 3200) {
  const text = typeof message === "string" ? message.trim() : "";
  if (!text) {
    return;
  }
  const normalizedKind = kind === "error" ? "error" : "success";
  const now = Date.now();
  if (
    lastToast.message === text
    && lastToast.kind === normalizedKind
    && now - lastToast.at < 400
  ) {
    return;
  }
  lastToast = { message: text, kind: normalizedKind, at: now };
  const container = ensureToastContainer();
  const toast = document.createElement("div");
  toast.className = `toast-item ${normalizedKind}`;
  toast.textContent = text;
  container.appendChild(toast);
  requestAnimationFrame(() => {
    toast.classList.add("show");
  });
  const closeToast = () => {
    if (!toast.parentElement) {
      return;
    }
    toast.classList.remove("show");
    setTimeout(() => {
      toast.remove();
    }, 180);
  };
  setTimeout(closeToast, Math.max(1200, durationMs));
}

function normalizePermissions(value) {
  if (!value || typeof value !== "object") {
    return {
      can_manage_spaces: false,
      can_manage_jira: false,
      can_manage_users: false,
      can_assign_space_access: false,
    };
  }
  return {
    can_manage_spaces: Boolean(value.can_manage_spaces),
    can_manage_jira: Boolean(value.can_manage_jira),
    can_manage_users: Boolean(value.can_manage_users),
    can_assign_space_access: Boolean(value.can_assign_space_access),
  };
}

function normalizeOptionalDisplayName(displayName, username) {
  const normalizedDisplayName =
    typeof displayName === "string" ? displayName.trim() : "";
  const normalizedUsername = typeof username === "string" ? username.trim() : "";
  if (!normalizedDisplayName) {
    return "";
  }
  if (normalizedUsername && normalizedDisplayName === normalizedUsername) {
    return "";
  }
  return normalizedDisplayName;
}

function applySessionFromServer(data) {
  if (!data || typeof data !== "object") {
    return;
  }
  const serverUser = data.user && typeof data.user === "object" ? data.user : null;
  if (serverUser) {
    const username =
      typeof serverUser.username === "string" && serverUser.username.trim()
        ? serverUser.username.trim()
        : collab.username;
    const displayName = normalizeOptionalDisplayName(
      serverUser.display_name,
      username
    );
    const role = typeof serverUser.role === "string" ? serverUser.role.trim().toLowerCase() : "user";
    if (username) {
      collab.username = username;
    }
    collab.displayName = displayName;
    collab.role = role || "user";
    if (dom.loginUsername && collab.username) {
      dom.loginUsername.value = collab.username;
    }
  }
  collab.permissions = normalizePermissions(data.permissions);
  collab.mustChangePassword = Boolean(
    data.must_change_password
    ?? (serverUser && serverUser.must_change_password)
  );
  const displayLabel = collab.displayName || collab.username || "user";
  collab.identity = getCollabIdentity(displayLabel);
  updateRoleVisibility();
}

function updateRoleVisibility() {
  if (dom.jiraConfigButton) {
    dom.jiraConfigButton.classList.toggle("hidden", !collab.permissions.can_manage_jira);
  }
  if (dom.profileButton) {
    dom.profileButton.classList.toggle("hidden", !collab.isAuthenticated);
  }
  if (dom.usersButton) {
    dom.usersButton.classList.toggle(
      "hidden",
      !collab.isAuthenticated || !collab.permissions.can_manage_users
    );
  }
  const canCreate = collab.permissions.can_manage_spaces;
  if (dom.spaceOpenCreate) {
    dom.spaceOpenCreate.classList.toggle("hidden", !canCreate);
  }
  if (dom.spaceOpenFolderCreate) {
    dom.spaceOpenFolderCreate.classList.toggle("hidden", !canCreate);
  }
  if (!canCreate) {
    if (dom.spaceNew) {
      dom.spaceNew.value = "";
    }
    if (dom.spaceFolderNew) {
      dom.spaceFolderNew.value = "";
    }
    closeSpaceCreateModal();
    closeSpaceFolderCreateModal();
  }
  updateCreateSpaceButton();
  updateCreateFolderButton();
}

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
  const authToken = dom.loginPassword?.value || AUTH_TOKEN;
  return { username, authToken };
}

function applyAuthFromInputs({ store = true, markDirty = true } = {}) {
  const { username, authToken } = readAuthInputs();
  const safeUsername = username || "user";
  collab.username = safeUsername;
  collab.authToken = authToken || AUTH_TOKEN;
  collab.identity = getCollabIdentity(collab.displayName || safeUsername);
  if (markDirty) {
    collab.isAuthenticated = false;
    collab.displayName = "";
    collab.role = "user";
    collab.mustChangePassword = false;
    collab.permissions = normalizePermissions(null);
  }
  if (collab.binding || collab.provider) {
    publishCollabIdentityAwareness();
  }
  updateBoardConnectionLabel();
  if (collab.spaceId) {
    startPresenceHeartbeat(collab.spaceId);
  }
  if (store) {
    persistAuth({
      username: safeUsername,
    });
  }
  updateRoleVisibility();
}

function initializeAuthInputs() {
  const stored = getStoredAuth();
  if (dom.loginUsername) {
    dom.loginUsername.value = stored?.username || dom.loginUsername.value || "user";
  }
  if (dom.loginPassword) {
    dom.loginPassword.value = "";
  }
  collab.displayName = "";
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
    const spaceRef = collab.spacePath || collab.spaceId;
    dom.boardConnection.textContent = "";
    const text = document.createElement("span");
    text.textContent = `${collab.username}@${getServerLabel()}/${spaceRef}`;
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

function isOfflineMode() {
  return !collab.spaceId;
}

function readOfflineDraft() {
  try {
    const raw = localStorage.getItem(OFFLINE_DRAFT_STORAGE_KEY);
    if (raw === null) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.text === "string") {
        return parsed.text;
      }
    } catch {
      // Fallback to raw string format.
    }
    return raw;
  } catch {
    return null;
  }
}

function writeOfflineDraft(text) {
  try {
    localStorage.setItem(
      OFFLINE_DRAFT_STORAGE_KEY,
      JSON.stringify({
        text,
        savedAt: Date.now(),
      })
    );
  } catch {
    // Ignore storage failures.
  }
}

function stopOfflineDraftTimer() {
  if (collab.offlineDraftTimer) {
    clearInterval(collab.offlineDraftTimer);
    collab.offlineDraftTimer = null;
  }
}

function flushOfflineDraft({ force = false } = {}) {
  if (!isOfflineMode()) {
    stopOfflineDraftTimer();
    collab.offlineDraftDirty = false;
    return;
  }
  const currentValue =
    editorController && typeof editorController.getValue === "function"
      ? editorController.getValue()
      : (dom.editor?.value || "");
  if (
    !force
    && !collab.offlineDraftDirty
    && currentValue === collab.offlineDraftSavedValue
  ) {
    return;
  }
  writeOfflineDraft(currentValue);
  collab.offlineDraftSavedValue = currentValue;
  collab.offlineDraftDirty = false;
}

function ensureOfflineDraftTimer() {
  if (collab.offlineDraftTimer) {
    return;
  }
  collab.offlineDraftTimer = setInterval(() => {
    if (!isOfflineMode()) {
      stopOfflineDraftTimer();
      collab.offlineDraftDirty = false;
      return;
    }
    if (!collab.offlineDraftDirty) {
      return;
    }
    flushOfflineDraft();
  }, OFFLINE_DRAFT_SAVE_INTERVAL_MS);
}

function trackOfflineDraftChange(value) {
  if (!isOfflineMode()) {
    stopOfflineDraftTimer();
    collab.offlineDraftDirty = false;
    return;
  }
  if (value === collab.offlineDraftSavedValue) {
    collab.offlineDraftDirty = false;
    return;
  }
  collab.offlineDraftDirty = true;
  ensureOfflineDraftTimer();
}

function getInitialEditorValue() {
  const stored = readOfflineDraft();
  if (stored !== null) {
    collab.offlineDraftSavedValue = stored;
    return stored;
  }
  collab.offlineDraftSavedValue = sample;
  return sample;
}

const sample = `Example board:\n    people:\n        maya:\n            name: Maya Rivera\n        luis:\n            name: Luis Ortega\n        sam:\n            name: Sam Patel\n        nina:\n            name: Nina Lopez\n        zara:\n            name: Zara Chen\n    tags:\n        planning\n        backend\n        ux\n        research\n\n% Kickoff sprint\n!todo @maya #planning #ux\n**Goal:** Align scope, risks, and owners. {Architecture}\n- Define success metrics\n- Draft roadmap milestones\n[ ] Share notes with stakeholders\n[ ] Lock sprint goals\n\n    % Collect requirements\n    !inprogress @sam #research\n    Interview 5 users and summarize themes.\n    [ ] Write interview guide\n    [x] Schedule sessions\n\n        % Summarize insights\n        !todo @nina #research #planning\n        Capture themes and map to product risks.\n\n    % Create UX flow\n    !todo @maya #ux\n    Map onboarding screens and happy path.\n    - Wireframe key screens\n    - Validate navigation\n\n% Architecture\n!inprogress @luis #backend\nDefine data contracts and core services.\n| Area | Owner | Status |\n| --- | --- | --- |\n| API | Luis | Draft |\n| Data | Maya | Review |\n\n    % Build service skeleton\n    !todo @luis #backend\n    [ ] Set up repo and CI\n    [ ] Define API endpoints\n\n    % Integrate auth\n    !todo @sam #backend\n    Connect OAuth provider and session storage.\n\n        % Validate permissions\n        !todo @zara #backend #research\n        Check scopes and error handling.\n\n% Release prep\n!todo @maya #planning\nFinalize checklist and release timeline.\n{Kickoff sprint}\n`;

dom.editor.value = getInitialEditorValue();

let editorController;

function shouldSuppressTextareaInputEcho(value) {
  void value;
  if (!collab.ytext || !collab.ydoc) {
    return false;
  }
  // yCollab already propagates CodeMirror document updates into Y.Text, so the
  // hidden textarea "input" echo event is unnecessary while connected.
  return collab.bindingMode === "cm6";
}
editorController = createEditor({
  state,
  dom,
  onSync: sync,
  onSelectTask: handleEditorSelection,
  onLocalChange: shouldSuppressTextareaInputEcho,
  onTaskTitleDoubleClick: ({ lineIndex }) => {
    const task = state.allTasks.find((item) => item.lineIndex === lineIndex);
    if (!task) {
      return;
    }
    openTaskEditModal(task);
  },
  onTokenDoubleClick: (token) => {
    openSlugRenameModal(token);
  },
  spellcheck: state.spellcheckEnabled,
  scopedSpellcheck: true,
});

const canvasController = createCanvas({
  state,
  dom,
  renderMarkdown,
  onSelectTask: selectTask,
  onEditTask: (task) => openTaskEditModal(task),
  findTaskByName,
  onUpdateTaskToken: updateTaskToken,
  onUpdateTaskState: updateTaskState,
  onMakeSubtask: moveTaskAsSubtask,
  onReorderTask: reorderKanbanTask,
  onToggleCheckbox: toggleCheckboxAtLine,
  onFiltersChange: () => {
    buildTagPersonLists();
    buildKanban();
    updateClearFiltersVisibility();
    renderStoryPointsSummary();
  },
});

if (typeof window !== "undefined") {
  window.__taskScriptTestHooks = {
    setEditorSelectionRange(start, end) {
      if (!editorController?.setSelectionRange) {
        return null;
      }
      editorController.setSelectionRange(start, end);
      return editorController.getSelectionRange?.() || null;
    },
    getEditorSelectionRange() {
      return editorController?.getSelectionRange?.() || null;
    },
    getEditorDisplayRects() {
      return {
        selection:
          editorController?.getDisplaySelectionRects?.() || [],
        cursor:
          editorController?.getDisplayCursorRects?.() || [],
      };
    },
    syncEditorOverlayMetrics() {
      editorController?.syncOverlayMetrics?.();
    },
  };
}

let modalEditorController = null;
let modalEditorState = null;

setScopedSpellcheckEnabled(state.spellcheckEnabled, { persist: false });

function applyEditorValue(nextValue) {
  const currentValue = editorController.getValue();
  const { start, end } = editorController.getSelectionRange();
  const { top: scrollTop, left: scrollLeft } = editorController.getScroll();
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
  editorController.focus();
  editorController.replaceRange(oldReplaceStart, oldReplaceEnd, newReplace);
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
  const clampedStart = Math.min(adjustOffset(start), nextValue.length);
  const clampedEnd = Math.min(adjustOffset(end), nextValue.length);
  editorController.setSelectionRange(clampedStart, clampedEnd);
  editorController.setScroll({ top: scrollTop, left: scrollLeft });
}

function dispatchEditorInput() {
  editorController.dispatchInput();
}

function forceEditorRefresh(value, { collapseSelection = false } = {}) {
  applyEditorValue(value);
  if (collapseSelection) {
    const selection = editorController.getSelectionRange();
    const caret = Number.isFinite(selection?.end) ? selection.end : 0;
    editorController.setSelectionRange(caret, caret);
  }
  syncEditorState();
  dispatchEditorInput();
}

function handleEditorSelection(line) {
  const task = state.allTasks.find(
    (item) =>
      item.lineIndex === line ||
      (item.descriptionLineIndexes && item.descriptionLineIndexes.includes(line))
  );
  if (task) {
    if (state.selectedTaskId === task.id) {
      return;
    }
    state.selectedTaskId = task.id;
    state.selectedLine = line;
    canvasController.focusOnTask(task);
    canvasController.renderGraph();
    buildKanban();
    renderStoryPointsSummary();
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
  const lines = editorController.getValue().split("\n");
  const targetLine = task.lineIndex;
  const caretPosition = lines.slice(0, targetLine).reduce((sum, line) => sum + line.length + 1, 0);
  editorController.focus();
  editorController.setSelectionRange(caretPosition, caretPosition);
  editorController.updateSelectedLine();
  editorController.highlightText(lines);
  canvasController.focusOnTask(task);
  canvasController.renderGraph();
  buildKanban();
  renderStoryPointsSummary();
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
  const peopleLegendGroup = dom.personList?.closest(".legend-group");
  const tagsLegendGroup = dom.tagList?.closest(".legend-group");
  const storyPointsLegendGroup = dom.storyPointsSummaryGraph?.closest(".legend-group");
  if (peopleLegendGroup) {
    peopleLegendGroup.hidden = people.length === 0;
  }
  if (tagsLegendGroup) {
    tagsLegendGroup.hidden = tags.length === 0;
  }
  if (storyPointsLegendGroup) {
    storyPointsLegendGroup.hidden = !(Number.isFinite(state.totalStoryPoints) && state.totalStoryPoints > 0);
  }
  const visibleLegendParts = [
    !peopleLegendGroup?.hidden ? "people" : "",
    !storyPointsLegendGroup?.hidden ? "story" : "",
    !tagsLegendGroup?.hidden ? "tags" : "",
  ].filter(Boolean);
  if (dom.legend) {
    dom.legend.dataset.legendLayout = visibleLegendParts.join("-") || "empty";
  }
  const hasVisibleLegendGroups =
    (Boolean(peopleLegendGroup) && !peopleLegendGroup.hidden)
    || (Boolean(tagsLegendGroup) && !tagsLegendGroup.hidden)
    || (Boolean(storyPointsLegendGroup) && !storyPointsLegendGroup.hidden);
  setLegendHasVisibleContent(hasVisibleLegendGroups);
}

function formatStoryPointsNumber(value) {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return Number.isInteger(value) ? String(value) : String(value);
}

function renderStoryPointsSummary() {
  const targets = [dom.storyPointsSummaryGraph, dom.storyPointsSummaryKanban].filter(Boolean);
  if (!targets.length) {
    return;
  }
  const total = Number.isFinite(state.totalStoryPoints) ? state.totalStoryPoints : 0;
  const hasSearchSelection = Boolean(state.searchQuery && state.searchQuery.trim());
  const hasFilterSelection = Boolean(filtersActive());
  const hasSelection = hasSearchSelection || hasFilterSelection;
  let selectedTotal = null;
  if (hasSelection) {
    const selectedTasks = new Set();
    state.allTasks.forEach((task) => {
      const selectedBySearch = hasSearchSelection && matchesSearchTask(task);
      const selectedByFilters = hasFilterSelection && matchesFilters(task);
      if (selectedBySearch || selectedByFilters) {
        selectedTasks.add(task.id);
      }
    });
    selectedTotal = 0;
    state.allTasks.forEach((task) => {
      if (!selectedTasks.has(task.id)) {
        return;
      }
      let ancestor = task.parent;
      while (ancestor) {
        if (selectedTasks.has(ancestor.id)) {
          return;
        }
        ancestor = ancestor.parent;
      }
      selectedTotal += Number.isFinite(task.storyPointsTotal) ? task.storyPointsTotal : 0;
    });
  }
  const hasAnyPoints = total > 0 || (selectedTotal !== null && selectedTotal > 0);
  targets.forEach((pill) => {
    if (!hasAnyPoints) {
      pill.hidden = true;
      pill.textContent = "";
      pill.title = "";
      return;
    }
    pill.hidden = false;
    if (hasSelection && selectedTotal !== null) {
      pill.textContent = `★ ${formatStoryPointsNumber(selectedTotal)} out of ${formatStoryPointsNumber(total)}`;
      pill.title = "Story points";
    } else {
      pill.textContent = `★ ${formatStoryPointsNumber(total)}`;
      pill.title = "Story points";
    }
  });
}

function sync() {
  if (!editorController) {
    return;
  }
  const sourceText = editorController.getValue();
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
    incomingReferenceCountByName,
    totalStoryPoints,
  } = parseTasks(sourceText);
  applyStableTaskIds({ allTasks });
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
  state.incomingReferenceCountByName = incomingReferenceCountByName;
  state.totalStoryPoints = totalStoryPoints;
  trackOfflineDraftChange(sourceText);
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
  renderStoryPointsSummary();
  editorController.updateSuggestions();
  updateClearFiltersVisibility();
}

function buildKanban() {
  buildKanbanView({
    state,
    dom,
    renderMarkdown,
    selectTask,
    onEditTask: (task) => openTaskEditModal(task),
    matchesSearchTask,
    filtersActive,
    matchesFilters,
    updateTaskState,
    onToggleCheckbox: toggleCheckboxAtLine,
    groupBy: state.kanbanGroupBy,
  });
}

function updateTaskState(task, newState) {
  updateTaskStateInEditor({ task, newState, dom, sync, applyEditorValue });
}

function updateTaskToken(task, token, action) {
  updateTaskTokenInEditor({ task, token, action, dom, sync, applyEditorValue });
}

let editingTaskRange = null;
let editingTaskIndent = "";
let editingTaskJiraKey = null;
let creatingTask = false;
let pendingDeleteTask = null;
let isTaskDragActive = false;
let taskEditDragHandlersBound = false;

function getTaskBlockRange(lines, lineIndex) {
  let start = lineIndex;
  let end = lineIndex + 1;
  while (end < lines.length) {
    if (/^\s*%/.test(lines[end])) {
      break;
    }
    end += 1;
  }
  return { start, end };
}

function setTaskDragActive(active) {
  if (isTaskDragActive === active) {
    return;
  }
  isTaskDragActive = active;
  document.body.classList.toggle("dragging-task", active);
  if (!active && dom.taskTrash) {
    dom.taskTrash.classList.remove("drag-over");
    document.body.classList.remove("task-trash-over");
  }
}

function parseTaskBody(text) {
  const lines = text.replace(/\r/g, "").split("\n");
  const tags = new Set();
  const people = new Set();
  let stateToken = null;
  let storyPoints = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    let match;
    const tagRegex = /(^|\s)(#[^\s#@]+)/g;
    while ((match = tagRegex.exec(line)) !== null) {
      tags.add(match[2]);
    }
    const personRegex = /(^|\s)(@[^\s#@]+)/g;
    while ((match = personRegex.exec(line)) !== null) {
      people.add(match[2]);
    }
    if (!stateToken) {
      const stateMatch = line.match(/(^|\s)(![^\s#@]+)/);
      if (stateMatch) {
        stateToken = stateMatch[2];
      }
    }
    if (storyPoints === null) {
      const storyMatch = line.match(/(^|\s)~(\d+(?:\.\d+)?)(?=\s|$)/);
      if (storyMatch) {
        const parsedPoints = Number.parseFloat(storyMatch[2]);
        if (Number.isFinite(parsedPoints)) {
          storyPoints = parsedPoints;
        }
      }
    }
  }
  return {
    descriptionText: lines.join("\n"),
    tags: Array.from(tags),
    people: Array.from(people),
    state: stateToken,
    storyPoints,
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SLUG_KIND_LABELS = {
  tag: "Tag",
  person: "Person",
  state: "State",
};

const SLUG_SECTION_BY_KIND = {
  tag: "tags",
  person: "people",
  state: "states",
};

const SLUG_CONFIG_PROPS_BY_KIND = {
  tag: ["name", "color"],
  person: ["name", "color", "email"],
  state: ["name", "color", "jiraState"],
};

const SLUG_RENAME_SWATCH_COLORS = [
  "#e85d75",
  "#f28a2e",
  "#d6b100",
  "#5ea63a",
  "#0fa58a",
  "#1d8fe1",
  "#5d6bff",
  "#b24be0",
];

const SLUG_VALUE_RE = /^[A-Za-z0-9_-]+$/;

function normalizeSlugInput(value, prefix) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return "";
  }
  if (raw.startsWith(prefix)) {
    return raw.slice(prefix.length).trim();
  }
  return raw.replace(/^[@#!]/, "").trim();
}

function slugKindLabel(kind) {
  return SLUG_KIND_LABELS[kind] || "Token";
}

function replaceSlugTokenOccurrences(text, oldToken, newToken) {
  const pattern = new RegExp(`(^|\\s)${escapeRegExp(oldToken)}(?=\\s|$)`, "gm");
  let count = 0;
  const nextText = text.replace(pattern, (match, leading) => {
    count += 1;
    return `${leading}${newToken}`;
  });
  return { text: nextText, count };
}

function getSlugConfigEntry(kind, slug) {
  const section = SLUG_SECTION_BY_KIND[kind];
  const entries = Array.isArray(state.config?.[section]) ? state.config[section] : [];
  return entries.find((entry) => entry?.key === slug) || null;
}

function normalizeSlugMetadata(kind, metadata = {}) {
  const normalized = {
    name: typeof metadata.name === "string" ? metadata.name.trim() : "",
    color: typeof metadata.color === "string" ? metadata.color.trim() : "",
    email: "",
    jiraState: "",
  };
  if (kind === "person") {
    normalized.email = typeof metadata.email === "string" ? metadata.email.trim() : "";
  }
  if (kind === "state") {
    normalized.jiraState =
      typeof metadata.jiraState === "string" ? metadata.jiraState.trim() : "";
  }
  return normalized;
}

function hasSlugMetadataInput(kind, metadata = {}) {
  const keys = SLUG_CONFIG_PROPS_BY_KIND[kind] || [];
  return keys.some((key) => {
    const value = metadata[key];
    return typeof value === "string" && value.trim() !== "";
  });
}

function slugMetadataEqual(kind, left = {}, right = {}) {
  const keys = SLUG_CONFIG_PROPS_BY_KIND[kind] || [];
  return keys.every((key) => {
    const a = typeof left[key] === "string" ? left[key].trim() : "";
    const b = typeof right[key] === "string" ? right[key].trim() : "";
    return a === b;
  });
}

function buildSlugRenameMetadata(kind, slug) {
  const entry = getSlugConfigEntry(kind, slug);
  return normalizeSlugMetadata(kind, {
    name: entry?.name && entry.name !== slug ? entry.name : "",
    color: entry?.color || "",
    email: entry?.email || "",
    jiraState: entry?.jiraState || "",
  });
}

function setSlugRenameFieldVisibility(kind) {
  dom.slugRenameDisplayNameField?.classList.remove("hidden");
  dom.slugRenameColorField?.classList.remove("hidden");
  dom.slugRenameEmailField?.classList.toggle("hidden", kind !== "person");
  dom.slugRenameJiraStateField?.classList.toggle("hidden", kind !== "state");
}

function normalizeHexColorValue(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return "";
  }
  const hex = raw.startsWith("#") ? raw : `#${raw}`;
  if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
    return hex.toLowerCase();
  }
  const shortMatch = hex.match(/^#([0-9a-fA-F]{3})$/);
  if (!shortMatch) {
    return "";
  }
  const [r, g, b] = shortMatch[1].split("");
  return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
}

function updateSlugRenameColorPreview(value) {
  if (!dom.slugRenameColorPreview) {
    return;
  }
  const raw = typeof value === "string" ? value.trim() : "";
  const hex = normalizeHexColorValue(raw);
  dom.slugRenameColorPreview.textContent = raw || "Auto";
  dom.slugRenameColorPreview.style.setProperty(
    "--slug-rename-preview-color",
    hex || "transparent"
  );
  dom.slugRenameColorPreview.classList.toggle("has-color", Boolean(hex));
}

function setSlugRenameColorValue(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (dom.slugRenameColor) {
    dom.slugRenameColor.value = raw;
  }
  const hex = normalizeHexColorValue(raw);
  if (dom.slugRenameColorPicker && hex) {
    dom.slugRenameColorPicker.value = hex;
  }
  if (dom.slugRenameColorSwatches) {
    dom.slugRenameColorSwatches
      .querySelectorAll("button[data-color]")
      .forEach((button) => {
        const swatchColor = normalizeHexColorValue(button.dataset.color || "");
        button.classList.toggle("active", Boolean(hex) && swatchColor === hex);
        button.setAttribute(
          "aria-pressed",
          Boolean(hex) && swatchColor === hex ? "true" : "false"
        );
      });
  }
  updateSlugRenameColorPreview(raw);
}

function ensureSlugRenameColorControls() {
  if (slugRenameColorControlsBound) {
    return;
  }
  slugRenameColorControlsBound = true;
  if (dom.slugRenameColorSwatches) {
    dom.slugRenameColorSwatches.innerHTML = "";
    SLUG_RENAME_SWATCH_COLORS.forEach((color, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "slug-color-swatch";
      button.dataset.color = color;
      button.style.setProperty("--swatch-color", color);
      button.setAttribute("aria-label", `Color ${index + 1}`);
      button.setAttribute("aria-pressed", "false");
      button.addEventListener("click", () => {
        setSlugRenameColorValue(color);
      });
      dom.slugRenameColorSwatches.appendChild(button);
    });
  }
  dom.slugRenameColorPicker?.addEventListener("input", (event) => {
    const value = event.currentTarget?.value || "";
    setSlugRenameColorValue(value);
  });
  dom.slugRenameColorClear?.addEventListener("click", () => {
    setSlugRenameColorValue("");
  });
  setSlugRenameColorValue("");
}

function configureSlugRenameContext(kind) {
  const displayLabel = "Display name";

  if (dom.slugRenameDisplayNameLabel) {
    dom.slugRenameDisplayNameLabel.textContent = displayLabel;
  }
  if (dom.slugRenameDisplayName) {
    dom.slugRenameDisplayName.placeholder = "";
    dom.slugRenameDisplayName.autocomplete = kind === "person" ? "name" : "off";
  }

  if (dom.slugRenameEmailLabel) {
    dom.slugRenameEmailLabel.textContent = "Email";
  }
  if (dom.slugRenameEmail) {
    dom.slugRenameEmail.placeholder = "";
    dom.slugRenameEmail.autocomplete = "email";
  }

  if (dom.slugRenameJiraStateLabel) {
    dom.slugRenameJiraStateLabel.textContent = "Jira state";
  }
  if (dom.slugRenameJiraState) {
    dom.slugRenameJiraState.placeholder = "";
    dom.slugRenameJiraState.autocomplete = "off";
  }
}

function slugConfigPropOutputName(kind, prop) {
  if (kind === "person" && prop === "email") {
    return "mail";
  }
  if (kind === "state" && prop === "jiraState") {
    return "jira";
  }
  return prop;
}

function slugConfigPropOutputValue(prop, value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (prop === "color") {
    const normalized = normalizeHexColorValue(raw);
    if (normalized) {
      return normalized.slice(1);
    }
  }
  return raw;
}

function formatSlugConfigPropLine(kind, prop, value) {
  const outputProp = slugConfigPropOutputName(kind, prop);
  const outputValue = slugConfigPropOutputValue(prop, value);
  return `            ${outputProp}: ${outputValue}`;
}

function normalizeSlugConfigPropName(prop) {
  const raw = typeof prop === "string" ? prop.trim() : "";
  const compact = raw.toLowerCase().replace(/[_-]/g, "");
  if (compact === "jira" || compact === "jirastate") {
    return "jiraState";
  }
  if (compact === "name") {
    return "name";
  }
  if (compact === "color") {
    return "color";
  }
  if (compact === "email") {
    return "email";
  }
  return "";
}

function buildSlugConfigEntryLines(kind, slug, metadata) {
  const normalizedMeta = normalizeSlugMetadata(kind, metadata);
  const props = SLUG_CONFIG_PROPS_BY_KIND[kind] || [];
  const propLines = props
    .filter((prop) => normalizedMeta[prop])
    .map((prop) => formatSlugConfigPropLine(kind, prop, normalizedMeta[prop]));
  const header = `        ${slug}${propLines.length ? ":" : ""}`;
  return [header, ...propLines];
}

function updateSlugConfigEntryBlock(entryLines, { kind, newSlug, metadata }) {
  if (!Array.isArray(entryLines) || !entryLines.length) {
    return { lines: buildSlugConfigEntryLines(kind, newSlug, metadata), changed: true };
  }
  const normalizedMeta = normalizeSlugMetadata(kind, metadata);
  const targetProps = SLUG_CONFIG_PROPS_BY_KIND[kind] || [];
  const headerRaw = entryLines[0] || "";
  const headerIndent = headerRaw.match(/^\s*/)?.[0] || "        ";
  let bodyLines = entryLines.slice(1);
  const propIndexes = new Map();
  bodyLines.forEach((line, index) => {
    const trimmed = (line || "").trim();
    const indent = line?.match?.(/^\s*/)?.[0]?.length || 0;
    if (indent !== 12 || !trimmed) {
      return;
    }
    const propMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (!propMatch) {
      return;
    }
    const propName = normalizeSlugConfigPropName(propMatch[1]);
    if (targetProps.includes(propName) && !propIndexes.has(propName)) {
      propIndexes.set(propName, index);
    }
  });

  targetProps.forEach((prop) => {
    const nextValue = normalizedMeta[prop] || "";
    const existingIndex = propIndexes.get(prop);
    if (nextValue) {
      const nextLine = formatSlugConfigPropLine(kind, prop, nextValue);
      if (Number.isInteger(existingIndex)) {
        bodyLines[existingIndex] = nextLine;
      } else {
        bodyLines.push(nextLine);
      }
      return;
    }
    if (Number.isInteger(existingIndex)) {
      bodyLines[existingIndex] = null;
    }
  });

  bodyLines = bodyLines.filter((line) => line !== null);
  const hasNestedContent = bodyLines.some((line) => (line || "").trim() !== "");
  const nextHeader = `${headerIndent}${newSlug}${hasNestedContent ? ":" : ""}`;
  const nextLines = [nextHeader, ...bodyLines];
  const changed = nextLines.join("\n") !== entryLines.join("\n");
  return { lines: nextLines, changed };
}

function renameSlugConfigEntries(lines, { kind, oldSlug, newSlug, metadata }) {
  const targetSection = SLUG_SECTION_BY_KIND[kind];
  if (!targetSection || !Array.isArray(lines) || !lines.length) {
    return { changed: false };
  }
  const normalizedMeta = normalizeSlugMetadata(kind, metadata);
  const shouldCreateEntry = hasSlugMetadataInput(kind, normalizedMeta);
  let configEnd = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*%/.test(lines[index] || "")) {
      configEnd = index;
      break;
    }
  }

  let sectionStart = -1;
  let sectionEnd = configEnd;
  for (let index = 0; index < configEnd; index += 1) {
    const raw = lines[index] || "";
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    const indent = raw.match(/^\s*/)?.[0].length || 0;
    if (indent !== 4 || !trimmed.endsWith(":")) {
      continue;
    }
    const sectionName = trimmed.slice(0, -1).trim().toLowerCase();
    if (sectionStart !== -1) {
      sectionEnd = index;
      break;
    }
    if (sectionName === targetSection) {
      sectionStart = index;
      sectionEnd = configEnd;
    }
  }

  let entryStart = -1;
  let entryEnd = -1;
  if (sectionStart !== -1) {
    for (let index = sectionStart + 1; index < sectionEnd; index += 1) {
      const raw = lines[index] || "";
      const trimmed = raw.trim();
      if (!trimmed) {
        continue;
      }
      const indent = raw.match(/^\s*/)?.[0].length || 0;
      if (indent !== 8) {
        continue;
      }
      const entryMatch = trimmed.match(/^([^\s:]+)(\s*:.*)?$/);
      if (!entryMatch || entryMatch[1] !== oldSlug) {
        continue;
      }
      entryStart = index;
      entryEnd = sectionEnd;
      for (let next = index + 1; next < sectionEnd; next += 1) {
        const nextRaw = lines[next] || "";
        const nextTrimmed = nextRaw.trim();
        if (!nextTrimmed) {
          continue;
        }
        const nextIndent = nextRaw.match(/^\s*/)?.[0].length || 0;
        if (nextIndent <= 8) {
          entryEnd = next;
          break;
        }
      }
      break;
    }
  }

  let changed = false;
  if (entryStart !== -1) {
    const existingBlock = lines.slice(entryStart, entryEnd);
    const updatedBlock = updateSlugConfigEntryBlock(existingBlock, {
      kind,
      newSlug,
      metadata: normalizedMeta,
    });
    if (updatedBlock.changed) {
      lines.splice(entryStart, entryEnd - entryStart, ...updatedBlock.lines);
      changed = true;
    }
    return { changed };
  }

  if (!shouldCreateEntry) {
    return { changed };
  }

  const entryLines = buildSlugConfigEntryLines(kind, newSlug, normalizedMeta);
  if (sectionStart === -1) {
    lines.splice(configEnd, 0, `    ${targetSection}:`, ...entryLines);
    return { changed: true };
  }
  lines.splice(sectionEnd, 0, ...entryLines);
  return { changed: true };
}

function renameSlugInWholeFile(text, { kind, prefix, oldSlug, newSlug, metadata }) {
  const oldToken = `${prefix}${oldSlug}`;
  const newToken = `${prefix}${newSlug}`;
  const tokenResult =
    oldToken === newToken
      ? { text, count: 0 }
      : replaceSlugTokenOccurrences(text, oldToken, newToken);
  const lines = tokenResult.text.split("\n");
  const configResult = renameSlugConfigEntries(lines, {
    kind,
    oldSlug,
    newSlug,
    metadata,
  });
  const nextText = configResult.changed ? lines.join("\n") : tokenResult.text;
  return {
    oldToken,
    newToken,
    text: nextText,
    changed: nextText !== text,
    replacements: tokenResult.count,
    configChanged: configResult.changed,
  };
}

function insertTokenIntoBody(text, token) {
  const tokenMatch = new RegExp(`(^|\\s)${escapeRegExp(token)}(?=\\s|$)`);
  if (tokenMatch.test(text)) {
    return text;
  }
  const lines = text.replace(/\r/g, "").split("\n");
  let targetIndex = lines.findIndex((line) => line.trim() !== "");
  if (targetIndex === -1) {
    return `${token}\n`;
  }
  const trimmed = lines[targetIndex].trim();
  const hasTokenLine = /(^|\s)([#@!][^\s#@]+)/.test(trimmed);
  if (!hasTokenLine) {
    lines.splice(targetIndex, 0, token);
    return lines.join("\n");
  }
  const stateMatch = trimmed.match(/(^|\s)(![^\s#@]+)/);
  if (stateMatch) {
    const stateToken = stateMatch[2];
    const rest = normalizeContent(trimmed.replace(/(^|\s)![^\s#@]+(?=\s|$)/g, "$1"));
    lines[targetIndex] = rest ? `${stateToken} ${token} ${rest}` : `${stateToken} ${token}`;
  } else {
    lines[targetIndex] = normalizeContent(`${token} ${trimmed}`);
  }
  return lines.join("\n");
}

function insertStateIntoBody(text, stateToken) {
  if (!stateToken) {
    return text;
  }
  const lines = text.replace(/\r/g, "").split("\n");
  const stateReplace = /(^|\s)![^\s#@]+(?=\s|$)/g;
  const cleaned = lines.map((line) => normalizeContent(line.replace(stateReplace, "$1")));
  let targetIndex = cleaned.findIndex((line) => line.trim() !== "");
  if (targetIndex === -1) {
    return `${stateToken}\n`;
  }
  const trimmed = cleaned[targetIndex].trim();
  const hasTokenLine = /(^|\s)([#@!][^\s#@]+)/.test(trimmed);
  if (!hasTokenLine) {
    cleaned.splice(targetIndex, 0, stateToken);
    return cleaned.join("\n");
  }
  cleaned[targetIndex] = trimmed ? `${stateToken} ${trimmed}` : stateToken;
  return cleaned.join("\n");
}

function updateCheckboxInBody(text, lineIndex, checked) {
  const lines = text.replace(/\r/g, "").split("\n");
  if (!Number.isFinite(lineIndex) || lineIndex < 0 || lineIndex >= lines.length) {
    return text;
  }
  const line = lines[lineIndex];
  const updated = line.replace(/^(\s*)\[[ xX]\](\s+|$)/, `$1[${checked ? "x" : " "}]$2`);
  if (updated === line) {
    return text;
  }
  lines[lineIndex] = updated;
  return lines.join("\n");
}

function removeTokenFromBody(text, token) {
  const tokenReplace = new RegExp(`(^|\\s)${escapeRegExp(token)}(?=\\s|$)`, "g");
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => normalizeContent(line.replace(tokenReplace, "$1")));
  while (lines.length && lines[0].trim() === "") {
    lines.shift();
  }
  return lines.join("\n");
}

function removeStateFromBody(text) {
  const stateReplace = /(^|\s)![^\s#@]+(?=\s|$)/g;
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => normalizeContent(line.replace(stateReplace, "$1")));
  while (lines.length && lines[0].trim() === "") {
    lines.shift();
  }
  return lines.join("\n");
}

function renderTaskEditTokenList(container, tokens, metaMap, type) {
  if (!container) {
    return;
  }
  container.innerHTML = "";
  tokens.forEach((token) => {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "pill";
    const meta = metaMap?.get(token);
    if (meta?.color) {
      pill.style.borderColor = meta.color;
      pill.style.color = meta.color;
    }
    if (type === "state") {
      const label = meta?.name || token.replace(/^!/, "");
      pill.classList.add("state-pill");
      pill.textContent = label;
    } else if (type === "tag") {
      const label = meta?.name || token.replace("#", "");
      pill.textContent = `#${label}`;
    } else {
      const label = meta?.name || token.replace("@", "");
      pill.textContent = `👤 ${label}`;
    }
    pill.draggable = true;
    pill.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData(
        "application/json",
        JSON.stringify({ type, value: token, source: "palette" })
      );
      event.dataTransfer.effectAllowed = "copy";
    });
    container.appendChild(pill);
  });
}

function refreshTaskEditTokenLists() {
  const stateOrder = state.config?.states?.map((item) => `!${item.key}`) || [];
  const extraStates = Array.from(state.states)
    .filter((value) => !stateOrder.includes(value))
    .sort((a, b) => a.localeCompare(b));
  const stateTokens = [...stateOrder, ...extraStates];
  const tagOrder = state.config?.tags?.map((tag) => `#${tag.key}`) || [];
  const extraTags = Array.from(state.tags)
    .filter((tag) => !tagOrder.includes(tag))
    .sort((a, b) => a.localeCompare(b));
  const tagTokens = [...tagOrder, ...extraTags];
  const peopleOrder = state.config?.people?.map((person) => `@${person.key}`) || [];
  const extraPeople = Array.from(state.people)
    .filter((person) => !peopleOrder.includes(person))
    .sort((a, b) => a.localeCompare(b));
  const peopleTokens = [...peopleOrder, ...extraPeople];
  renderTaskEditTokenList(dom.taskEditStates, stateTokens, state.stateMeta, "state");
  renderTaskEditTokenList(dom.taskEditTags, tagTokens, state.tagMeta, "tag");
  renderTaskEditTokenList(dom.taskEditPeople, peopleTokens, state.peopleMeta, "person");
  const peopleListSection = dom.taskEditPeople?.closest(".task-edit-list");
  const tagsListSection = dom.taskEditTags?.closest(".task-edit-list");
  if (peopleListSection) {
    peopleListSection.hidden = peopleTokens.length === 0;
  }
  if (tagsListSection) {
    tagsListSection.hidden = tagTokens.length === 0;
  }
}

function ensureTaskEditDragHandlers() {
  if (taskEditDragHandlersBound) {
    return;
  }
  taskEditDragHandlersBound = true;
  if (dom.taskEditPreview) {
    dom.taskEditPreview.addEventListener("dragover", (event) => {
      event.preventDefault();
      dom.taskEditPreview.classList.add("drag-over");
    });
    dom.taskEditPreview.addEventListener("dragleave", () => {
      dom.taskEditPreview.classList.remove("drag-over");
    });
    dom.taskEditPreview.addEventListener("drop", (event) => {
      event.preventDefault();
      dom.taskEditPreview.classList.remove("drag-over");
      const payload = event.dataTransfer?.getData("application/json");
      if (!payload || !modalEditorController) {
        return;
      }
      try {
        const data = JSON.parse(payload);
        if (data.source !== "palette") {
          return;
        }
        if (data.type !== "tag" && data.type !== "person" && data.type !== "state") {
          return;
        }
        const updated =
          data.type === "state"
            ? insertStateIntoBody(modalEditorController.getValue(), data.value)
            : insertTokenIntoBody(modalEditorController.getValue(), data.value);
        modalEditorController.setValue(updated);
      } catch {
        // ignore invalid payloads
      }
    });
  }
  if (dom.taskEditSide) {
    dom.taskEditSide.addEventListener("dragover", (event) => {
      event.preventDefault();
      dom.taskEditSide.classList.add("drag-over");
    });
    dom.taskEditSide.addEventListener("dragleave", () => {
      dom.taskEditSide.classList.remove("drag-over");
    });
    dom.taskEditSide.addEventListener("drop", (event) => {
      event.preventDefault();
      dom.taskEditSide.classList.remove("drag-over");
      const payload = event.dataTransfer?.getData("application/json");
      if (!payload || !modalEditorController) {
        return;
      }
      try {
        const data = JSON.parse(payload);
        if (data.source !== "preview") {
          return;
        }
        if (data.type !== "tag" && data.type !== "person" && data.type !== "state") {
          return;
        }
        const updated =
          data.type === "state"
            ? removeStateFromBody(modalEditorController.getValue())
            : removeTokenFromBody(modalEditorController.getValue(), data.value);
        modalEditorController.setValue(updated);
      } catch {
        // ignore invalid payloads
      }
    });
  }
}

function updateTaskEditPreviewFromText(text) {
  if (!dom.taskEditPreview) {
    return;
  }
  const parsed = parseTaskBody(text);
  const titleValue = dom.taskEditTitleInput?.value.trim() || "Untitled task";
  const { key: jiraKey, title: jiraTitle } = parseJiraTitle(titleValue);
  const displayKey = jiraKey || editingTaskJiraKey;
  updateTaskEditJiraPill(displayKey);
  const displayTitle = jiraTitle || "Untitled task";
  const formatStoryPoints = (value) => (Number.isInteger(value) ? String(value) : String(value));
  dom.taskEditPreview.innerHTML = "";
  const card = document.createElement("div");
  card.className = "task-preview-card";
  const header = document.createElement("div");
  header.className = "task-header";
  const title = document.createElement("h4");
  if (displayKey) {
    title.appendChild(createJiraTitlePill(displayKey));
  }
  title.append(displayTitle);
  header.appendChild(title);
  if (parsed.state) {
    const pill = document.createElement("span");
    pill.className = "pill state-pill";
    pill.draggable = true;
    const stateMeta = state.stateMeta?.get(parsed.state);
    pill.textContent = stateMeta?.name || parsed.state.replace(/^!/, "");
    const stateColor = stateMeta?.color;
    if (stateColor) {
      pill.style.borderColor = stateColor;
      pill.style.color = stateColor;
    }
    pill.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData(
        "application/json",
        JSON.stringify({ type: "state", value: parsed.state, source: "preview" })
      );
      event.dataTransfer.effectAllowed = "move";
    });
    header.appendChild(pill);
  }
  card.appendChild(header);
  if (Number.isFinite(parsed.storyPoints)) {
    const storyPill = document.createElement("span");
    storyPill.className = "pill story-points-pill task-story-points-corner";
    storyPill.textContent = `★ ${formatStoryPoints(parsed.storyPoints)}`;
    storyPill.title = "Story points";
    card.appendChild(storyPill);
  }
  const desc = document.createElement("div");
  desc.className = "description";
  const descriptionLines = (parsed.descriptionText || "").replace(/\r/g, "").split("\n");
  const cleanedDescription = descriptionLines
    .map((line) => {
      const rawLine = typeof line === "string" ? line : "";
      const indent = rawLine.match(/^\s*/)?.[0] || "";
      const content = rawLine
        .slice(indent.length)
        .replace(/(^|\s)![^\s#@]+/g, "$1")
        .replace(/(^|\s)~\d+(?:\.\d+)?(?=\s|$)/g, "$1")
        .replace(/\s{2,}/g, " ")
        .trim();
      return content ? `${indent}${content}` : "";
    })
    .join("\n");
  const lineIndexes = descriptionLines.map((_, index) => index);
  desc.innerHTML = renderMarkdown(cleanedDescription, { lineIndexes, disableLinks: true });
  desc.querySelectorAll("a").forEach((link) => {
    const span = document.createElement("span");
    span.className = "inline-link";
    span.textContent = link.textContent || link.getAttribute("href") || "";
    link.replaceWith(span);
  });
  desc.querySelectorAll(".references").forEach((ref) => {
    ref.classList.add("inline-link");
    const referenceName = typeof ref.dataset.ref === "string" ? ref.dataset.ref.trim() : "";
    if (!findTaskByName(referenceName)) {
      ref.classList.add("unresolved");
      ref.title = "Reference target not found";
    }
  });
  card.appendChild(desc);
  dom.taskEditPreview.appendChild(card);

  dom.taskEditPreview.querySelectorAll(".inline-pill").forEach((pill) => {
    const type = pill.dataset.type;
    const value = pill.dataset.value;
    if (!type || !value) {
      return;
    }
    if (type === "tag") {
      const meta = state.tagMeta?.get(value);
      const label = meta?.name || value.replace("#", "");
      pill.textContent = `#${label}`;
      if (meta?.color) {
        pill.style.borderColor = meta.color;
        pill.style.color = meta.color;
      }
    } else if (type === "person") {
      const meta = state.peopleMeta?.get(value);
      const label = meta?.name || value.replace("@", "");
      pill.textContent = `👤 ${label}`;
      if (meta?.color) {
        pill.style.borderColor = meta.color;
        pill.style.color = meta.color;
      }
    } else if (type === "jira") {
      pill.textContent = value;
      pill.title = `Copy ${value}`;
      pill.addEventListener("click", (event) => {
        event.stopPropagation();
        copyToClipboard(value);
      });
      pill.draggable = false;
      return;
    }
    pill.draggable = true;
    pill.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData(
        "application/json",
        JSON.stringify({ type, value, source: "preview" })
      );
      event.dataTransfer.effectAllowed = "move";
    });
  });
  dom.taskEditPreview
    .querySelectorAll('input[type="checkbox"][data-line]')
    .forEach((checkbox) => {
      checkbox.addEventListener("change", (event) => {
        if (!modalEditorController) {
          return;
        }
        const target = event.currentTarget;
        const lineIndex = Number(target.dataset.line);
        if (!Number.isFinite(lineIndex)) {
          return;
        }
        const updated = updateCheckboxInBody(
          modalEditorController.getValue(),
          lineIndex,
          target.checked
        );
        modalEditorController.setValue(updated);
      });
    });
  ensureTaskEditDragHandlers();
}

function ensureTaskEditEditor() {
  if (!dom.taskEditCode || !dom.taskEditCodeHost) {
    return null;
  }
  if (!modalEditorState) {
    modalEditorState = {
      tags: state.tags,
      people: state.people,
      states: state.states,
      allTasks: state.allTasks,
      selectedLine: 0,
    };
  }
  modalEditorState.tags = state.tags;
  modalEditorState.people = state.people;
  modalEditorState.states = state.states;
  modalEditorState.allTasks = state.allTasks;
  if (!modalEditorController) {
    modalEditorController = createEditor({
      state: modalEditorState,
      dom: { editor: dom.taskEditCode, editorHost: dom.taskEditCodeHost },
      onSync: () => {
        if (dom.taskEditModal && !dom.taskEditModal.classList.contains("hidden")) {
          updateTaskEditPreviewFromText(modalEditorController.getValue());
        }
      },
      onSelectTask: () => {},
      onLocalChange: () => true,
      onSelectionChange: () => {},
      onFocusChange: () => {},
      onTokenDoubleClick: (token) => {
        openSlugRenameModal(token);
      },
      spellcheck: state.spellcheckEnabled,
    });
  }
  if (modalEditorController?.setSpellcheckEnabled) {
    modalEditorController.setSpellcheckEnabled(state.spellcheckEnabled);
  }
  return modalEditorController;
}

function openTaskEditModal(task) {
  if (!dom.taskEditModal || !task) {
    return;
  }
  creatingTask = false;
  const lines = editorController.getValue().split("\n");
  const { start, end } = getTaskBlockRange(lines, task.lineIndex);
  editingTaskRange = { start, end };
  const taskLine = lines[task.lineIndex] || "";
  editingTaskIndent = taskLine.match(/^\s*/)?.[0] || "";
  if (dom.taskEditError) {
    dom.taskEditError.classList.add("hidden");
    dom.taskEditError.textContent = "";
  }
  if (dom.taskEditTitleInput) {
    const parsedTitle = parseJiraTitle(task.name || "");
    editingTaskJiraKey = task.jiraKey || parsedTitle.key;
    dom.taskEditTitleInput.value = task.name || parsedTitle.title || "";
  }
  updateTaskEditJiraPill(editingTaskJiraKey);
  const bodyLines = lines
    .slice(task.lineIndex + 1, end)
    .map((line) =>
      line.startsWith(editingTaskIndent) ? line.slice(editingTaskIndent.length) : line.trimStart()
    );
  const bodyText = bodyLines.join("\n");
  const modalEditor = ensureTaskEditEditor();
  if (modalEditor) {
    dom.taskEditCode.value = bodyText;
    modalEditor.setValue(bodyText);
  }
  refreshTaskEditTokenLists();
  updateTaskEditPreviewFromText(bodyText);
  dom.taskEditModal.classList.remove("hidden");
  if (modalEditor) {
    modalEditor.focus();
  }
}

function getTaskCreateRange(lines) {
  if (!Array.isArray(lines) || !lines.length) {
    return { start: 0, end: 0 };
  }
  const lastNonEmptyIndex = lines
    .map((line, index) => ({ line, index }))
    .filter((entry) => entry.line.trim() !== "")
    .map((entry) => entry.index)
    .pop();
  if (!Number.isFinite(lastNonEmptyIndex)) {
    return { start: 0, end: lines.length };
  }
  const insertIndex = Math.max(0, lastNonEmptyIndex + 1);
  if (insertIndex < lines.length) {
    return { start: insertIndex, end: insertIndex + 1 };
  }
  return { start: insertIndex, end: insertIndex };
}

function openTaskCreateModal() {
  if (!dom.taskEditModal) {
    return;
  }
  creatingTask = true;
  const lines = editorController.getValue().split("\n");
  const range = getTaskCreateRange(lines);
  editingTaskRange = range;
  editingTaskIndent = "";
  editingTaskJiraKey = null;
  if (dom.taskEditError) {
    dom.taskEditError.classList.add("hidden");
    dom.taskEditError.textContent = "";
  }
  if (dom.taskEditTitleInput) {
    dom.taskEditTitleInput.value = "";
  }
  updateTaskEditJiraPill(null);
  const modalEditor = ensureTaskEditEditor();
  if (modalEditor) {
    dom.taskEditCode.value = "";
    modalEditor.setValue("");
  }
  refreshTaskEditTokenLists();
  updateTaskEditPreviewFromText("");
  dom.taskEditModal.classList.remove("hidden");
  dom.taskEditTitleInput?.focus();
}

function closeTaskEditModal() {
  if (!dom.taskEditModal) {
    return;
  }
  dom.taskEditModal.classList.add("hidden");
  editingTaskRange = null;
  editingTaskIndent = "";
  editingTaskJiraKey = null;
  creatingTask = false;
  updateTaskEditJiraPill(null);
}

function normalizeBoardNameInput(value) {
  const raw = typeof value === "string" ? value : "";
  const trimmed = raw.trim().replace(/:+\s*$/, "").trim();
  return trimmed || "Task Script";
}

function updateBoardNameInEditor(nextBoardName) {
  if (!editorController) {
    return;
  }
  const normalizedBoardName = normalizeBoardNameInput(nextBoardName);
  const headerLine = `${normalizedBoardName}:`;
  const lines = editorController.getValue().replace(/\r/g, "").split("\n");
  const firstTrimmed = (lines[0] || "").trim();
  const hasExplicitHeader =
    Boolean(firstTrimmed)
    && !firstTrimmed.startsWith("%")
    && firstTrimmed.endsWith(":");
  if (hasExplicitHeader) {
    lines[0] = headerLine;
  } else {
    lines.unshift(headerLine);
  }
  forceEditorRefresh(lines.join("\n"), { collapseSelection: true });
}

function openBoardRenameModal() {
  if (!dom.boardRenameModal || !dom.boardRenameInput) {
    return;
  }
  pendingBoardRename = true;
  const currentBoardName = normalizeBoardNameInput(
    state.config?.boardName || dom.boardTitle?.textContent || "Task Script"
  );
  dom.boardRenameInput.value = currentBoardName;
  dom.boardRenameModal.classList.remove("hidden");
  dom.boardRenameInput.focus();
  dom.boardRenameInput.select();
}

function closeBoardRenameModal() {
  if (!dom.boardRenameModal) {
    return;
  }
  dom.boardRenameModal.classList.add("hidden");
  pendingBoardRename = false;
}

function submitBoardRename() {
  if (!pendingBoardRename) {
    closeBoardRenameModal();
    return;
  }
  const nextBoardName = normalizeBoardNameInput(dom.boardRenameInput?.value || "");
  const currentBoardName = normalizeBoardNameInput(
    state.config?.boardName || dom.boardTitle?.textContent || "Task Script"
  );
  if (nextBoardName !== currentBoardName) {
    updateBoardNameInEditor(nextBoardName);
  }
  closeBoardRenameModal();
}

function openSlugRenameModal(token) {
  if (!dom.slugRenameModal || !token) {
    return;
  }
  const kind = token.type;
  const prefix = token.prefix;
  const slug = typeof token.slug === "string" ? token.slug.trim() : "";
  if (
    !slug
    || !["tag", "person", "state"].includes(kind)
    || !["#", "@", "!"].includes(prefix)
  ) {
    return;
  }
  pendingSlugRename = {
    kind,
    prefix,
    slug,
    metadata: buildSlugRenameMetadata(kind, slug),
  };
  if (dom.slugRenameMessage) {
    dom.slugRenameMessage.textContent = `Rename ${slugKindLabel(kind).toLowerCase()} slug "${prefix}${slug}" in whole file.`;
  }
  if (dom.slugRenameCurrent) {
    dom.slugRenameCurrent.value = `${prefix}${slug}`;
  }
  if (dom.slugRenameNew) {
    dom.slugRenameNew.value = slug;
  }
  ensureSlugRenameColorControls();
  setSlugRenameFieldVisibility(kind);
  configureSlugRenameContext(kind);
  if (dom.slugRenameDisplayName) {
    dom.slugRenameDisplayName.value = pendingSlugRename.metadata.name || "";
  }
  setSlugRenameColorValue(pendingSlugRename.metadata.color || "");
  if (dom.slugRenameEmail) {
    dom.slugRenameEmail.value = pendingSlugRename.metadata.email || "";
  }
  if (dom.slugRenameJiraState) {
    dom.slugRenameJiraState.value = pendingSlugRename.metadata.jiraState || "";
  }
  dom.slugRenameModal.classList.remove("hidden");
  dom.slugRenameNew?.focus();
  dom.slugRenameNew?.select();
}

function closeSlugRenameModal() {
  if (!dom.slugRenameModal) {
    return;
  }
  dom.slugRenameModal.classList.add("hidden");
  if (dom.slugRenameDisplayName) {
    dom.slugRenameDisplayName.value = "";
  }
  setSlugRenameColorValue("");
  if (dom.slugRenameEmail) {
    dom.slugRenameEmail.value = "";
  }
  if (dom.slugRenameJiraState) {
    dom.slugRenameJiraState.value = "";
  }
  pendingSlugRename = null;
}

function submitSlugRename() {
  if (!pendingSlugRename) {
    closeSlugRenameModal();
    return;
  }
  const nextSlug = normalizeSlugInput(dom.slugRenameNew?.value || "", pendingSlugRename.prefix);
  if (!nextSlug) {
    showToast("New slug is required.", "error");
    return;
  }
  if (!SLUG_VALUE_RE.test(nextSlug)) {
    showToast("Slug can contain only letters, numbers, '-' and '_'.", "error");
    return;
  }
  const nextMetadata = normalizeSlugMetadata(pendingSlugRename.kind, {
    name: dom.slugRenameDisplayName?.value || "",
    color: dom.slugRenameColor?.value || "",
    email: dom.slugRenameEmail?.value || "",
    jiraState: dom.slugRenameJiraState?.value || "",
  });
  const slugChanged = nextSlug !== pendingSlugRename.slug;
  const metadataChanged = !slugMetadataEqual(
    pendingSlugRename.kind,
    pendingSlugRename.metadata,
    nextMetadata
  );
  if (!slugChanged && !metadataChanged) {
    closeSlugRenameModal();
    return;
  }
  const original = editorController.getValue();
  const oldToken = `${pendingSlugRename.prefix}${pendingSlugRename.slug}`;
  const result = renameSlugInWholeFile(original, {
    kind: pendingSlugRename.kind,
    prefix: pendingSlugRename.prefix,
    oldSlug: pendingSlugRename.slug,
    newSlug: nextSlug,
    metadata: nextMetadata,
  });
  if (!result.changed) {
    showToast(`No '${oldToken}' slug occurrences found.`, "error");
    return;
  }
  forceEditorRefresh(result.text, { collapseSelection: true });
  if (
    modalEditorController
    && dom.taskEditModal
    && !dom.taskEditModal.classList.contains("hidden")
  ) {
    const modalValue = modalEditorController.getValue();
    if (slugChanged) {
      const modalRename = replaceSlugTokenOccurrences(
        modalValue,
        result.oldToken,
        result.newToken
      );
      if (modalRename.text !== modalValue) {
        modalEditorController.setValue(modalRename.text);
      }
    }
  }
  if (slugChanged) {
    showToast(
      `${slugKindLabel(pendingSlugRename.kind)} slug '${result.oldToken}' renamed to '${result.newToken}'.`
    );
  } else {
    showToast(`${slugKindLabel(pendingSlugRename.kind)} metadata updated.`);
  }
  closeSlugRenameModal();
}

function countSubtasks(task) {
  if (!task || !Array.isArray(task.children)) {
    return 0;
  }
  let count = 0;
  const stack = [...task.children];
  while (stack.length) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    count += 1;
    if (Array.isArray(current.children) && current.children.length) {
      stack.push(...current.children);
    }
  }
  return count;
}

function openTaskDeleteModal(task) {
  if (!dom.taskDeleteModal || !task) {
    return;
  }
  pendingDeleteTask = task;
  if (dom.taskDeleteMessage) {
    const name = task.name || "this task";
    dom.taskDeleteMessage.textContent = `Remove "${name}"?`;
  }
  if (dom.taskDeleteConfirmAll) {
    const subtaskCount = countSubtasks(task);
    const hasSubtasks = subtaskCount > 0;
    const label = subtaskCount === 1 ? "Delete with 1 subtask" : `Delete with ${subtaskCount} subtasks`;
    dom.taskDeleteConfirmAll.textContent = label;
    dom.taskDeleteConfirmAll.classList.toggle("hidden", !hasSubtasks);
    dom.taskDeleteConfirmAll.disabled = !hasSubtasks;
  }
  dom.taskDeleteModal.classList.remove("hidden");
}

function closeTaskDeleteModal() {
  if (!dom.taskDeleteModal) {
    return;
  }
  dom.taskDeleteModal.classList.add("hidden");
  pendingDeleteTask = null;
  clearTaskDeletePreview();
}

function animateTaskRemoval(task, onComplete) {
  if (!task) {
    onComplete();
    return;
  }
  const nodes = [];
  const graphNode = document.querySelector(`.task-node[data-task-id="${task.id}"]`);
  if (graphNode) {
    nodes.push(graphNode);
  }
  const kanbanCard = document.querySelector(`.kanban-card[data-task-id="${task.id}"]`);
  if (kanbanCard) {
    nodes.push(kanbanCard);
  }
  if (!nodes.length) {
    onComplete();
    return;
  }
  nodes.forEach((node) => node.classList.add("deleting"));
  setTimeout(onComplete, 220);
}

function deleteTask(task) {
  if (!task) {
    return;
  }
  animateTaskRemoval(task, () => {
    const lines = editorController.getValue().split("\n");
    const block = findTaskBlock(lines, task.lineIndex);
    if (!block) {
      return;
    }
    lines.splice(block.start, block.end - block.start);
    applyEditorValue(lines.join("\n"));
    syncEditorState();
    handleEditorSelection(Math.max(0, block.start - 1));
  });
}

function deleteTaskKeepSubtasks(task) {
  if (!task) {
    return;
  }
  animateTaskRemoval(task, () => {
    const lines = editorController.getValue().split("\n");
    const block = findTaskBlock(lines, task.lineIndex);
    if (!block) {
      return;
    }
    const blockLines = lines.slice(block.start, block.end);
    if (blockLines.length <= 1) {
      lines.splice(block.start, block.end - block.start);
      applyEditorValue(lines.join("\n"));
      syncEditorState();
      handleEditorSelection(Math.max(0, block.start - 1));
      return;
    }
    const childBlocks = [];
    let index = block.start + 1;
    while (index < block.end) {
      const line = lines[index];
      const taskMatch = line.match(/^(\s*)%/);
      if (taskMatch) {
        const lineDepth = Math.floor(taskMatch[1].length / 4);
        if (lineDepth === block.depth + 1) {
          const childBlock = findTaskBlock(lines, index);
          if (childBlock) {
            const childLines = lines
              .slice(childBlock.start, childBlock.end)
              .map((childLine) => adjustIndent(childLine, -4));
            childBlocks.push(...childLines);
            index = childBlock.end;
            continue;
          }
        }
      }
      index += 1;
    }
    if (!childBlocks.length) {
      lines.splice(block.start, block.end - block.start);
    } else {
      lines.splice(block.start, block.end - block.start, ...childBlocks);
    }
    applyEditorValue(lines.join("\n"));
    syncEditorState();
    handleEditorSelection(Math.max(0, block.start - 1));
  });
}

function clearTaskDeletePreview() {
  document.querySelectorAll(".task-node.delete-preview").forEach((node) => {
    node.classList.remove("delete-preview");
  });
  document.querySelectorAll(".kanban-card.delete-preview").forEach((card) => {
    card.classList.remove("delete-preview");
  });
}

function highlightTaskDeletePreview(task, includeSubtasks) {
  clearTaskDeletePreview();
  if (!task) {
    return;
  }
  const toHighlight = [task];
  if (includeSubtasks) {
    const stack = [...task.children];
    while (stack.length) {
      const current = stack.shift();
      if (!current) {
        continue;
      }
      toHighlight.push(current);
      if (current.children?.length) {
        stack.push(...current.children);
      }
    }
  }
  toHighlight.forEach((item) => {
    const node = document.querySelector(`.task-node[data-task-id="${item.id}"]`);
    if (node) {
      node.classList.add("delete-preview");
    }
    const card = document.querySelector(`.kanban-card[data-task-id="${item.id}"]`);
    if (card) {
      card.classList.add("delete-preview");
    }
  });
}

function saveTaskEditModal() {
  if (!dom.taskEditModal) {
    return;
  }
  const modalEditor = ensureTaskEditEditor();
  if (!modalEditor || !editingTaskRange) {
    closeTaskEditModal();
    return;
  }
  const rawTitle = dom.taskEditTitleInput?.value.trim() || "";
  if (!rawTitle) {
    if (dom.taskEditError) {
      dom.taskEditError.textContent = "Title is required.";
      dom.taskEditError.classList.remove("hidden");
    }
    return;
  }
  const parsedTitle = parseJiraTitle(rawTitle);
  const jiraKey = parsedTitle.key || editingTaskJiraKey;
  const title = parsedTitle.title || "";
  if (!title) {
    if (dom.taskEditError) {
      dom.taskEditError.textContent = "Title is required.";
      dom.taskEditError.classList.remove("hidden");
    }
    return;
  }
  const bodyLines = modalEditor
    .getValue()
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => (line.trim() === "" ? "" : `${editingTaskIndent}${line}`));
  const jiraPrefix = jiraKey ? ` [JIRA:${jiraKey}]` : "";
  const nextLines = [`${editingTaskIndent}%${jiraPrefix} ${title}`, ...bodyLines];
  const lines = editorController.getValue().split("\n");
  const oldTitle = creatingTask ? "" : parseTaskTitleFromLine(lines[editingTaskRange.start] || "");
  lines.splice(editingTaskRange.start, editingTaskRange.end - editingTaskRange.start, ...nextLines);
  renameTaskReferencesInLines(lines, oldTitle, title);
  applyEditorValue(lines.join("\n"));
  syncEditorState();
  handleEditorSelection(editingTaskRange.start);
  if (creatingTask) {
    showToast(`Task '${title}' created.`);
  }
  closeTaskEditModal();
}

function moveTaskAsSubtask(sourceTask, targetTask) {
  if (!sourceTask || !targetTask || sourceTask.id === targetTask.id) {
    return;
  }
  let targetIsDescendantOfSource = false;
  let current = targetTask.parent;
  while (current) {
    if (current.id === sourceTask.id) {
      targetIsDescendantOfSource = true;
      break;
    }
    current = current.parent;
  }
  const lines = editorController.getValue().split("\n");
  const sourceBlock = findTaskBlock(lines, sourceTask.lineIndex);
  const targetBlock = findTaskBlock(lines, targetTask.lineIndex);
  if (!sourceBlock || !targetBlock) {
    return;
  }
  if (targetIsDescendantOfSource) {
    if (targetBlock.start <= sourceBlock.start || targetBlock.end > sourceBlock.end) {
      return;
    }
    const sourceLines = lines.slice(sourceBlock.start, sourceBlock.end);
    const relStart = targetBlock.start - sourceBlock.start;
    const relEnd = targetBlock.end - sourceBlock.start;
    const targetLines = sourceLines.slice(relStart, relEnd);
    const sourceWithoutTargetLines = [
      ...sourceLines.slice(0, relStart),
      ...sourceLines.slice(relEnd),
    ];
    if (!targetLines.length || !sourceWithoutTargetLines.length) {
      return;
    }
    // Switch relation: promote the target child to the source depth, then
    // demote the source block (without that child) under the promoted target.
    const promoteDelta = (sourceBlock.depth - targetBlock.depth) * 4;
    const promotedTargetLines = targetLines.map((line) => adjustIndent(line, promoteDelta));
    const demotedSourceLines = sourceWithoutTargetLines.map((line) => adjustIndent(line, 4));
    lines.splice(
      sourceBlock.start,
      sourceBlock.end - sourceBlock.start,
      ...promotedTargetLines,
      ...demotedSourceLines
    );
    applyEditorValue(lines.join("\n"));
    syncEditorState();
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

function reorderKanbanTask(sourceTask, targetTask, position, options = {}) {
  if (
    !sourceTask ||
    !targetTask ||
    sourceTask.id === targetTask.id ||
    (position !== "before" && position !== "after")
  ) {
    return false;
  }
  const allowRootReparent = Boolean(options.allowRootReparent);
  const sourceParentId = sourceTask.parent?.id || null;
  const targetParentId = targetTask.parent?.id || null;
  const allowDifferentParent =
    allowRootReparent &&
    sourceParentId !== null &&
    targetParentId === null;
  if (sourceParentId !== targetParentId && !allowDifferentParent) {
    return false;
  }
  const lines = editorController.getValue().split("\n");
  const sourceBlock = findTaskBlock(lines, sourceTask.lineIndex);
  const targetBlock = findTaskBlock(lines, targetTask.lineIndex);
  if (!sourceBlock || !targetBlock) {
    return false;
  }
  const targetDepth = targetBlock.depth;
  if (sourceBlock.depth !== targetDepth && !allowDifferentParent) {
    return false;
  }
  if (targetBlock.start >= sourceBlock.start && targetBlock.start < sourceBlock.end) {
    return false;
  }
  const insertAt = position === "before" ? targetBlock.start : targetBlock.end;
  const blockLines = lines.slice(sourceBlock.start, sourceBlock.end);
  if (!blockLines.length) {
    return false;
  }
  const indentDelta = (targetDepth - sourceBlock.depth) * 4;
  const adjustedBlockLines = indentDelta
    ? blockLines.map((line) => adjustIndent(line, indentDelta))
    : blockLines;
  lines.splice(sourceBlock.start, sourceBlock.end - sourceBlock.start);
  let nextInsertAt = insertAt;
  if (sourceBlock.start < nextInsertAt) {
    nextInsertAt -= adjustedBlockLines.length;
  }
  const originalStart = sourceBlock.start;
  if (nextInsertAt === originalStart && indentDelta === 0) {
    return false;
  }
  lines.splice(nextInsertAt, 0, ...adjustedBlockLines);
  applyEditorValue(lines.join("\n"));
  syncEditorState();
  return true;
}

function parseTaskTitleFromLine(line) {
  const raw = typeof line === "string" ? line : "";
  const match = raw.match(/^\s*%\s*(.*)$/);
  if (!match) {
    return "";
  }
  const parsed = parseJiraTitle(match[1]);
  return parsed.title || "";
}

function renameTaskReferencesInLines(lines, oldTitle, newTitle) {
  if (!Array.isArray(lines)) {
    return false;
  }
  const from = typeof oldTitle === "string" ? oldTitle.trim() : "";
  const to = typeof newTitle === "string" ? newTitle.trim() : "";
  if (!from || !to || from === to) {
    return false;
  }
  const refPattern = new RegExp(`\\{\\s*${escapeRegExp(from)}\\s*\\}`, "g");
  let changed = false;
  lines.forEach((line, index) => {
    const updated = (line || "").replace(refPattern, `{${to}}`);
    if (updated !== line) {
      lines[index] = updated;
      changed = true;
    }
  });
  return changed;
}

function findTaskByName(name) {
  const query = typeof name === "string" ? name.trim() : "";
  if (!query) {
    return null;
  }
  const exact = state.allTasks.find((task) => task.name === query);
  if (exact) {
    return exact;
  }
  const lowerQuery = query.toLowerCase();
  return (
    state.allTasks.find(
      (task) => typeof task.name === "string" && task.name.toLowerCase() === lowerQuery
    ) || null
  );
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

function createTaskVisualId() {
  const randomId =
    globalThis.crypto && typeof globalThis.crypto.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `task/${randomId}`;
}

function normalizeTaskPathPart(name) {
  const text = typeof name === "string" ? name.trim().replace(/\s+/g, " ").toLowerCase() : "";
  return text || "_";
}

function buildTaskNamePath(task) {
  const segments = [];
  let current = task;
  while (current) {
    segments.push(normalizeTaskPathPart(current.name));
    current = current.parent;
  }
  return segments.reverse().join("/");
}

function buildTaskPathSuffixes(path) {
  const segments = String(path || "")
    .split("/")
    .filter(Boolean);
  const suffixes = [];
  for (let index = 0; index < segments.length; index += 1) {
    const suffix = segments.slice(index).join("/");
    if (suffix) {
      suffixes.push(suffix);
    }
  }
  return suffixes;
}

function findHeuristicTaskMatch(previousPath, currentEntries) {
  if (!previousPath || !Array.isArray(currentEntries) || !currentEntries.length) {
    return -1;
  }
  const suffixes = buildTaskPathSuffixes(previousPath);
  for (const suffix of suffixes) {
    let index = currentEntries.findIndex((entry) => entry.path.includes(suffix));
    if (index >= 0) {
      return index;
    }
    index = currentEntries.findIndex((entry) => suffix.includes(entry.path));
    if (index >= 0) {
      return index;
    }
  }
  return -1;
}

function getTaskPathMapKey() {
  const spaceRef = (
    typeof collab.spacePath === "string" && collab.spacePath.trim()
      ? collab.spacePath.trim()
      : (typeof collab.spaceId === "string" ? collab.spaceId.trim() : "")
  );
  return spaceRef ? `space:${spaceRef}` : "local";
}

function applyStableTaskIds({ allTasks }) {
  const mapKey = getTaskPathMapKey();
  const previousMap = state.taskPathMaps.get(mapKey) || new Map();

  const previousEntries = [];
  previousMap.forEach((ids, path) => {
    (Array.isArray(ids) ? ids : []).forEach((id) => {
      if (typeof id === "string" && id.trim()) {
        previousEntries.push({ path, id });
      }
    });
  });

  const previousByPath = new Map();
  previousEntries.forEach((entry) => {
    const list = previousByPath.get(entry.path) || [];
    list.push(entry.id);
    previousByPath.set(entry.path, list);
  });

  const unpairedCurrent = [];
  allTasks.forEach((task) => {
    const path = buildTaskNamePath(task);
    const candidates = previousByPath.get(path);
    if (candidates && candidates.length) {
      task.id = candidates.shift();
      return;
    }
    unpairedCurrent.push({ task, path });
  });

  const unpairedPrevious = [];
  previousByPath.forEach((ids, path) => {
    ids.forEach((id) => {
      unpairedPrevious.push({ path, id });
    });
  });

  for (let index = 0; index < unpairedPrevious.length; index += 1) {
    const previous = unpairedPrevious[index];
    const matchIndex = findHeuristicTaskMatch(previous.path, unpairedCurrent);
    if (matchIndex < 0) {
      continue;
    }
    const match = unpairedCurrent[matchIndex];
    match.task.id = previous.id;
    unpairedCurrent.splice(matchIndex, 1);
    unpairedPrevious.splice(index, 1);
    index -= 1;
  }

  // Last-resort recovery before creating a new visual object.
  if (unpairedPrevious.length === 1 && unpairedCurrent.length === 1) {
    unpairedCurrent[0].task.id = unpairedPrevious[0].id;
    unpairedCurrent.length = 0;
    unpairedPrevious.length = 0;
  }

  unpairedCurrent.forEach(({ task }) => {
    task.id = createTaskVisualId();
  });

  const nextMap = new Map();
  allTasks.forEach((task) => {
    const path = buildTaskNamePath(task);
    const list = nextMap.get(path) || [];
    list.push(task.id);
    nextMap.set(path, list);
  });
  state.taskPathMaps.set(mapKey, nextMap);
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
  const lines = editorController.getValue().split("\n");
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
  if (
    dom.searchName.checked &&
    (task.name.toLowerCase().includes(query) ||
      (task.jiraKey || "").toLowerCase().includes(query))
  ) {
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
  const [Y, websocket, cmYjs] = await Promise.all([
    import(COLLAB_LIBS.yjs),
    import(COLLAB_LIBS.ywebsocket),
    import(COLLAB_LIBS.ycodemirror),
  ]);
  collab.modules = {
    Y,
    WebsocketProvider: websocket.WebsocketProvider,
    yCollab: cmYjs?.yCollab || cmYjs?.default?.yCollab || null,
  };
  return collab.modules;
}

function collabUserAwarenessState(identity) {
  const rawColor = identity?.color;
  let color = "rgb(45, 80, 237)";
  let colorLight = "rgba(45, 80, 237, 0.2)";

  if (
    rawColor &&
    typeof rawColor === "object" &&
    Number.isFinite(rawColor.r) &&
    Number.isFinite(rawColor.g) &&
    Number.isFinite(rawColor.b)
  ) {
    const r = Math.max(0, Math.min(255, Math.round(rawColor.r)));
    const g = Math.max(0, Math.min(255, Math.round(rawColor.g)));
    const b = Math.max(0, Math.min(255, Math.round(rawColor.b)));
    color = `rgb(${r}, ${g}, ${b})`;
    colorLight = `rgba(${r}, ${g}, ${b}, 0.2)`;
  } else if (typeof rawColor === "string" && rawColor.trim()) {
    color = rawColor;
    const rgbMatch = rawColor.match(/\brgba?\(\s*(\d+)\s*[,\s]+(\d+)\s*[,\s]+(\d+)/i);
    if (rgbMatch) {
      const [, r, g, b] = rgbMatch;
      colorLight = `rgba(${r}, ${g}, ${b}, 0.2)`;
    }
  }
  return {
    name: identity?.name || "user",
    color,
    colorLight,
  };
}

function publishCollabIdentityAwareness() {
  if (!collab.provider?.awareness) {
    return;
  }
  const identity =
    collab.identity || getCollabIdentity(collab.displayName || collab.username || "user");
  collab.provider.awareness.setLocalStateField("user", collabUserAwarenessState(identity));
}

function authHeaders({ includeBasic = false } = {}) {
  if (!includeBasic) {
    return {};
  }
  const user = collab.username || "user";
  const pass = collab.authToken || AUTH_TOKEN;
  const token = btoa(`${user}:${pass}`);
  return {
    Authorization: `Basic ${token}`,
  };
}

async function loginRequest(username, password) {
  let response;
  try {
    response = await fetch(`${REMOTE_BASE}/api/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username, password }),
    });
  } catch {
    throw new Error("Unable to reach the backend.");
  }
  if (response.status === 401) {
    throw new Error("Unauthorized");
  }
  if (!response.ok) {
    throw new Error("Unable to login.");
  }
  return response.json();
}

async function verifyCurrentPassword(password) {
  const username = (collab.username || "").trim();
  if (!username || !password) {
    throw new Error("Current password is required.");
  }
  try {
    await loginRequest(username, password);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      throw new Error("Current password is incorrect.");
    }
    throw error;
  }
}

async function logoutRequest() {
  try {
    await fetch(`${REMOTE_BASE}/api/logout`, {
      method: "POST",
    });
  } catch {
    // ignore
  }
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
  const spaces = Array.isArray(data.spaces)
    ? data.spaces
    .map((space) => {
      if (typeof space === "string") {
        const id = space.trim();
        return {
          id,
          users: [],
          folder: "",
          personal: false,
          path: buildSpacePath(id, ""),
        };
      }
      if (space && typeof space === "object") {
        const id = space.id || space.name || space.space || "";
        const users = Array.isArray(space.users) ? space.users : [];
        const folder = typeof space.folder === "string" ? space.folder.trim() : "";
        const personal = Boolean(space.personal);
        const explicitPath = typeof space.path === "string" ? space.path.trim() : "";
        const path = explicitPath || buildSpacePath(id, folder);
        return { id, users, folder, personal, path };
      }
      return { id: "", users: [], folder: "", personal: false, path: "" };
    })
    .filter((space) => space.id)
    : [];
  const folders = Array.isArray(data.folders)
    ? data.folders
      .filter((folder) => typeof folder === "string" && folder.trim())
      .map((folder) => folder.trim())
    : [];
  return {
    spaces,
    folders,
    user: data.user && typeof data.user === "object" ? data.user : null,
    permissions:
      data.permissions && typeof data.permissions === "object" ? data.permissions : null,
  };
}

async function createSpaceFolderRequest(name) {
  let response;
  try {
    response = await fetch(`${REMOTE_BASE}/api/space-folders`, {
      method: "POST",
      headers: {
        ...authHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name }),
    });
  } catch {
    throw new Error("Unable to reach the backend.");
  }
  if (!response.ok) {
    throw new Error(spaceResponseError(response, "Unable to create folder."));
  }
  return response.json();
}

async function deleteSpaceFolderRequest(folderId) {
  const trimmed = String(folderId || "").trim();
  if (!trimmed) {
    throw new Error("Invalid folder name.");
  }
  let response;
  try {
    response = await fetch(
      `${REMOTE_BASE}/api/space-folders/${encodeURIComponent(trimmed)}`,
      {
        method: "DELETE",
        headers: authHeaders(),
      }
    );
  } catch {
    throw new Error("Unable to reach the backend.");
  }
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error("Folder not found.");
    }
    if (response.status === 409) {
      throw new Error("Folder is not empty.");
    }
    if (response.status === 400) {
      throw new Error("Invalid folder name.");
    }
    throw new Error("Unable to delete folder.");
  }
  return response.json();
}

async function moveSpaceToFolderRequest(spaceId, folder) {
  let response;
  try {
    response = await fetch(`${REMOTE_BASE}/api/spaces/${encodeURIComponent(spaceId)}/folder`, {
      method: "PUT",
      headers: {
        ...authHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ folder }),
    });
  } catch {
    throw new Error("Unable to reach the backend.");
  }
  if (!response.ok) {
    throw new Error(spaceResponseError(response, "Unable to move space."));
  }
  return response.json();
}

async function fetchJiraConfig() {
  let response;
  try {
    response = await fetch(`${REMOTE_BASE}/api/jira-config`, {
      headers: authHeaders(),
    });
  } catch {
    throw new Error("Unable to reach the backend.");
  }
  if (response.status === 401) {
    throw new Error("Unauthorized");
  }
  if (!response.ok) {
    throw new Error("Unable to fetch Jira configuration.");
  }
  const data = await response.json();
  return {
    baseUrl: typeof data.base_url === "string" ? data.base_url : "",
    email: typeof data.email === "string" ? data.email : "",
    token: typeof data.token === "string" ? data.token : "",
  };
}

async function saveJiraConfig(payload) {
  let response;
  try {
    response = await fetch(`${REMOTE_BASE}/api/jira-config`, {
      method: "PUT",
      headers: {
        ...authHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload || {}),
    });
  } catch {
    throw new Error("Unable to reach the backend.");
  }
  if (response.status === 401) {
    throw new Error("Unauthorized");
  }
  if (!response.ok) {
    throw new Error("Unable to save Jira configuration.");
  }
  const data = await response.json();
  return {
    baseUrl: typeof data.base_url === "string" ? data.base_url : "",
    email: typeof data.email === "string" ? data.email : "",
    token: typeof data.token === "string" ? data.token : "",
  };
}

async function fetchMe() {
  let response;
  try {
    response = await fetch(`${REMOTE_BASE}/api/me`, {
      headers: authHeaders(),
    });
  } catch {
    throw new Error("Unable to reach the backend.");
  }
  if (response.status === 401) {
    throw new Error("Unauthorized");
  }
  if (!response.ok) {
    throw new Error("Unable to load user profile.");
  }
  return response.json();
}

async function saveMyProfile(payload) {
  let response;
  try {
    response = await fetch(`${REMOTE_BASE}/api/me`, {
      method: "PUT",
      headers: {
        ...authHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload || {}),
    });
  } catch {
    throw new Error("Unable to reach the backend.");
  }
  if (response.status === 401) {
    throw new Error("Unauthorized");
  }
  if (!response.ok) {
    let detail = "";
    try {
      const data = await response.json();
      detail = typeof data?.detail === "string" ? data.detail : "";
    } catch {
      // ignore
    }
    throw new Error(detail || "Unable to update profile.");
  }
  return response.json();
}

async function fetchUsers() {
  let response;
  try {
    response = await fetch(`${REMOTE_BASE}/api/users`, {
      headers: authHeaders(),
    });
  } catch {
    throw new Error("Unable to reach the backend.");
  }
  if (response.status === 401) {
    throw new Error("Unauthorized");
  }
  if (!response.ok) {
    throw new Error("Unable to fetch users.");
  }
  return response.json();
}

async function createUserRequest(payload) {
  let response;
  try {
    response = await fetch(`${REMOTE_BASE}/api/users`, {
      method: "POST",
      headers: {
        ...authHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload || {}),
    });
  } catch {
    throw new Error("Unable to reach the backend.");
  }
  if (!response.ok) {
    throw new Error(userResponseError(response, "Unable to create user."));
  }
  return response.json();
}

async function updateUserRequest(username, payload) {
  let response;
  try {
    response = await fetch(`${REMOTE_BASE}/api/users/${encodeURIComponent(username)}`, {
      method: "PUT",
      headers: {
        ...authHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload || {}),
    });
  } catch {
    throw new Error("Unable to reach the backend.");
  }
  if (!response.ok) {
    throw new Error(userResponseError(response, "Unable to update user."));
  }
  return response.json();
}

async function deleteUserRequest(username) {
  let response;
  try {
    response = await fetch(`${REMOTE_BASE}/api/users/${encodeURIComponent(username)}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
  } catch {
    throw new Error("Unable to reach the backend.");
  }
  if (!response.ok) {
    throw new Error(userResponseError(response, "Unable to remove user."));
  }
  return response.json();
}

function sortFolderIds(folders) {
  const names = Array.from(
    new Set(
      (Array.isArray(folders) ? folders : [])
        .filter((item) => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    )
  );
  const hasPersonal = names.includes("personal");
  const filtered = names.filter((name) => name !== "personal");
  filtered.sort((a, b) => a.localeCompare(b));
  return hasPersonal ? ["personal", ...filtered] : filtered;
}

function folderLabel(folderId) {
  if (folderId === "personal") {
    return "Personal";
  }
  if (!folderId) {
    return "Root";
  }
  return folderId;
}

function normalizeSpaceFolder(folder) {
  if (typeof folder !== "string") {
    return "";
  }
  return folder.trim().replace(/^\/+|\/+$/g, "");
}

function buildSpacePath(spaceId, folder = "") {
  const id = typeof spaceId === "string" ? spaceId.trim() : "";
  if (!id) {
    return "";
  }
  const normalizedFolder = normalizeSpaceFolder(folder);
  return normalizedFolder ? `${normalizedFolder}/${id}` : id;
}

function resolveSpacePath(space) {
  if (!space || typeof space !== "object") {
    return "";
  }
  const explicit = typeof space.path === "string" ? space.path.trim() : "";
  if (explicit) {
    return explicit;
  }
  return buildSpacePath(space.id, space.folder);
}

function getAssignableSpaces() {
  return [...new Set(collab.spaceAccessOptions || [])].sort((a, b) => a.localeCompare(b));
}

function isPersonalFolderPath(path) {
  const normalized = typeof path === "string" ? path.trim() : "";
  return normalized === "personal" || normalized.startsWith("personal/");
}

function buildAssignableAccessOptions(spaces = [], folders = []) {
  const options = new Set();
  (Array.isArray(folders) ? folders : []).forEach((folder) => {
    const normalized = typeof folder === "string" ? folder.trim() : "";
    if (!normalized || isPersonalFolderPath(normalized)) {
      return;
    }
    options.add(`${normalized}/*`);
  });
  (Array.isArray(spaces) ? spaces : []).forEach((space) => {
    if (!space || typeof space !== "object") {
      return;
    }
    if (space.personal) {
      return;
    }
    const id = typeof space.id === "string" ? space.id.trim() : "";
    if (!id) {
      return;
    }
    const folder = typeof space.folder === "string" ? space.folder.trim() : "";
    if (folder && !isPersonalFolderPath(folder)) {
      options.add(`${folder}/${id}`);
      return;
    }
    options.add(id);
  });
  return [...options].sort((a, b) => a.localeCompare(b));
}

function isPersonalFolderId(folderId) {
  const normalized = typeof folderId === "string" ? folderId.trim() : "";
  return normalized === "personal" || normalized.startsWith("personal/");
}

function renderSpaceList(spaces, folders = []) {
  if (!dom.spaceList) {
    return;
  }
  const canManageSpaces = collab.permissions.can_manage_spaces;
  dom.spaceList.innerHTML = "";
  const allSpaces = Array.isArray(spaces)
    ? [...spaces].sort((a, b) => resolveSpacePath(a).localeCompare(resolveSpacePath(b)))
    : [];
  const grouped = new Map();
  allSpaces.forEach((space) => {
    const folderId = typeof space.folder === "string" ? space.folder.trim() : "";
    const key = folderId || "";
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(space);
  });
  const folderSources = [
    ...(Array.isArray(folders) ? folders : []),
    ...Array.from(grouped.keys()).filter(Boolean),
  ];
  const orderedFolders = sortFolderIds(folderSources);
  const folderSet = new Set();
  orderedFolders.forEach((folderId) => {
    const parts = folderId.split("/").filter(Boolean);
    let current = "";
    parts.forEach((part) => {
      current = current ? `${current}/${part}` : part;
      folderSet.add(current);
    });
  });
  const folderMeta = new Map();
  folderSet.forEach((folderId) => {
    const parts = folderId.split("/");
    const name = parts[parts.length - 1] || folderId;
    const parentId = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
    folderMeta.set(folderId, { id: folderId, name, parentId });
  });
  const childrenByParent = new Map();
  folderMeta.forEach((folder) => {
    const parent = folder.parentId || "";
    if (!childrenByParent.has(parent)) {
      childrenByParent.set(parent, []);
    }
    childrenByParent.get(parent).push(folder);
  });
  childrenByParent.forEach((items) => {
    items.sort((a, b) => {
      if (a.id === "personal") {
        return -1;
      }
      if (b.id === "personal") {
        return 1;
      }
      return a.name.localeCompare(b.name);
    });
  });

  const activeSpaceId = typeof collab.spaceId === "string" ? collab.spaceId.trim() : "";
  const activeSpacePath = typeof collab.spacePath === "string" ? collab.spacePath.trim() : "";
  const activeSpaceEntry = activeSpacePath
    ? allSpaces.find((space) => resolveSpacePath(space) === activeSpacePath)
    : (activeSpaceId ? allSpaces.find((space) => space.id === activeSpaceId) : null);
  const activeFolderCandidate =
    activeSpaceEntry && typeof activeSpaceEntry.folder === "string"
      ? activeSpaceEntry.folder.trim()
      : "";
  const activeFolderId = activeSpaceEntry && folderMeta.has(activeFolderCandidate)
    ? activeFolderCandidate
    : null;
  const knownFolders = new Set(folderMeta.keys());
  if (!collab.openSpaceFolderInitialized) {
    if (activeFolderId !== null && knownFolders.has(activeFolderId)) {
      collab.openSpaceFolderId = activeFolderId;
    } else {
      collab.openSpaceFolderId = null;
    }
    collab.openSpaceFolderInitialized = true;
  } else if (
    typeof collab.openSpaceFolderId === "string"
    && !knownFolders.has(collab.openSpaceFolderId)
  ) {
    collab.openSpaceFolderId = null;
  }

  const isExpandedFolder = (folderId) => {
    if (!collab.openSpaceFolderId) {
      return false;
    }
    return (
      collab.openSpaceFolderId === folderId
      || collab.openSpaceFolderId.startsWith(`${folderId}/`)
    );
  };

  const renderSpaceRow = (space, container) => {
    const row = document.createElement("div");
    row.className = "space-item";
    const spacePath = resolveSpacePath(space);
    const isActiveSpace = (
      (collab.spacePath && collab.spacePath === spacePath)
      || (!collab.spacePath && collab.spaceId === space.id)
    );
    if (isActiveSpace) {
      row.classList.add("active-space");
    }
    const isPersonal = Boolean(space.personal);
    if (canManageSpaces && !isPersonal) {
      row.draggable = true;
      row.addEventListener("dragstart", (event) => {
        row.classList.add("dragging");
        event.dataTransfer?.setData("text/x-space-id", space.id);
        event.dataTransfer?.setData("text/x-space-path", spacePath);
        event.dataTransfer?.setData("text/plain", spacePath || space.id);
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "move";
        }
      });
      row.addEventListener("dragend", () => {
        row.classList.remove("dragging");
      });
    }
    const targetFolder = typeof space.folder === "string" ? space.folder.trim() : "";
    if (canManageSpaces && !isPersonalFolderId(targetFolder)) {
      row.addEventListener("dragover", (event) => {
        event.preventDefault();
        event.stopPropagation();
        row.classList.add("drag-over");
      });
      row.addEventListener("dragleave", () => {
        row.classList.remove("drag-over");
      });
      row.addEventListener("drop", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        row.classList.remove("drag-over");
        const draggedSpaceId = event.dataTransfer?.getData("text/x-space-id") || "";
        const draggedSpacePath = event.dataTransfer?.getData("text/x-space-path") || draggedSpaceId;
        if (
          !draggedSpaceId
          || (draggedSpaceId === space.id && draggedSpacePath === spacePath)
        ) {
          return;
        }
        try {
          await moveSpaceToFolderRequest(draggedSpaceId, targetFolder);
          clearSpaceError();
          await loadSpaceList({ showLoading: false });
          const movedPath = buildSpacePath(draggedSpaceId, targetFolder);
          showToast(`Space '${draggedSpacePath}' moved to '${movedPath}'.`);
        } catch (error) {
          setSpaceError(formatSpaceError(error, "Unable to move space."));
        }
      });
    }
    const header = document.createElement("div");
    header.className = "space-row";

    const label = document.createElement("span");
    label.className = "space-label";
    const labelIcon = document.createElement("i");
    labelIcon.className = "fa-solid fa-file-lines space-label-icon";
    labelIcon.setAttribute("aria-hidden", "true");
    const labelText = document.createElement("span");
    labelText.textContent = spacePath || space.id;
    label.append(labelIcon, labelText);

    const input = document.createElement("input");
    input.type = "text";
    input.className = "space-input";
    input.value = space.id;

    const actions = document.createElement("div");
    actions.className = "space-actions";

    const connectButton = document.createElement("button");
    connectButton.type = "button";
    connectButton.className = "toolbar-button space-connect";
    connectButton.textContent = isActiveSpace ? "Active" : "Connect";
    connectButton.disabled = isActiveSpace;
    if (isActiveSpace) {
      connectButton.classList.add("space-active");
    }
    connectButton.addEventListener("click", () => {
      connectToSpace(space.id, spacePath);
    });

    const rename = document.createElement("button");
    rename.type = "button";
    rename.className = "toolbar-button space-edit";
    rename.innerHTML = '<i class="fa-solid fa-pen-to-square" aria-hidden="true"></i>';
    rename.title = "Rename";
    rename.setAttribute("aria-label", "Rename");
    if (canManageSpaces && !isPersonal) {
      rename.addEventListener("click", () => {
        row.classList.add("editing");
        input.value = space.id;
        input.focus();
        input.select();
      });
    } else {
      rename.disabled = true;
      rename.classList.add("hidden");
    }

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
        const newSpacePath = buildSpacePath(trimmed, space.folder || "");
        await renameSpace(space.id, trimmed);
        clearSpaceError();
        row.classList.remove("editing");
        await loadSpaceList({ showLoading: false });
        showToast(`Space '${spacePath}' renamed to '${newSpacePath}'.`);
        if (isActiveSpace) {
          connectToSpace(trimmed, newSpacePath);
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
    if (canManageSpaces && !isPersonal) {
      remove.addEventListener("click", async () => {
        openDeleteModal({
          id: space.id,
          folder: space.folder || "",
          path: spacePath,
        });
      });
    } else {
      remove.disabled = true;
      remove.classList.add("hidden");
    }

    actions.appendChild(connectButton);
    actions.appendChild(rename);
    if (canManageSpaces && !isPersonal) {
      actions.appendChild(save);
      actions.appendChild(cancel);
    }
    actions.appendChild(remove);
    header.appendChild(label);
    header.appendChild(input);
    header.appendChild(actions);

    const users = document.createElement("div");
    users.className = "space-users";
    const connectedUsers = Array.isArray(space.users) ? space.users : [];
    if (connectedUsers.length) {
      connectedUsers.forEach((user) => {
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
    container.appendChild(row);
  };

  const renderFolder = (folderId, parentId, container) => {
    const folderSpaces = grouped.get(folderId) || [];
    const childFolders = childrenByParent.get(folderId) || [];
    if (!canManageSpaces && folderSpaces.length === 0 && childFolders.length === 0) {
      return;
    }
    const isOpen = isExpandedFolder(folderId);

    const folderBlock = document.createElement("div");
    folderBlock.className = "space-folder";
    if (isPersonalFolderId(folderId)) {
      folderBlock.classList.add("personal");
    }
    if (folderId === activeFolderId) {
      folderBlock.classList.add("active-folder");
    }
    folderBlock.classList.toggle("collapsed", !isOpen);

    const moveSpaceToFolder = async (spaceId, sourcePath = "") => {
      if (!spaceId) {
        return;
      }
      try {
        await moveSpaceToFolderRequest(spaceId, folderId);
        clearSpaceError();
        await loadSpaceList({ showLoading: false });
        const fromPath = sourcePath || spaceId;
        const toPath = buildSpacePath(spaceId, folderId);
        showToast(`Space '${fromPath}' moved to '${toPath}'.`);
      } catch (error) {
        setSpaceError(formatSpaceError(error, "Unable to move space."));
      }
    };

    const attachDropTarget = (targetEl) => {
      if (!targetEl || !canManageSpaces || isPersonalFolderId(folderId)) {
        return;
      }
      targetEl.addEventListener("dragover", (event) => {
        event.preventDefault();
        folderBlock.classList.add("drag-over");
      });
      targetEl.addEventListener("dragleave", () => {
        folderBlock.classList.remove("drag-over");
      });
      targetEl.addEventListener("drop", async (event) => {
        event.preventDefault();
        folderBlock.classList.remove("drag-over");
        const draggedSpaceId = event.dataTransfer?.getData("text/x-space-id") || "";
        const draggedSpacePath = event.dataTransfer?.getData("text/x-space-path") || draggedSpaceId;
        await moveSpaceToFolder(draggedSpaceId, draggedSpacePath);
      });
    };

    const folderHeader = document.createElement("button");
    folderHeader.type = "button";
    folderHeader.className = "space-folder-header";
    folderHeader.setAttribute("aria-expanded", String(isOpen));
    if (folderId === activeFolderId) {
      folderHeader.setAttribute("aria-current", "true");
    }
    const folderToggle = document.createElement("i");
    folderToggle.className = "fa-solid fa-chevron-right space-folder-toggle";
    folderToggle.setAttribute("aria-hidden", "true");
    const folderIcon = document.createElement("i");
    folderIcon.className = "fa-solid fa-folder";
    folderIcon.setAttribute("aria-hidden", "true");
    const folderTitle = document.createElement("span");
    folderTitle.className = "space-folder-title";
    const meta = folderMeta.get(folderId);
    folderTitle.textContent =
      folderId === "personal"
        ? "Personal"
        : (meta?.name || folderId);
    const folderCount = document.createElement("span");
    folderCount.className = "space-folder-count";
    folderCount.textContent = `${folderSpaces.length + childFolders.length}`;
    folderHeader.append(folderToggle, folderIcon, folderTitle, folderCount);
    folderHeader.addEventListener("click", () => {
      collab.openSpaceFolderId =
        collab.openSpaceFolderId === folderId ? (parentId || null) : folderId;
      renderSpaceList(spaces, folders);
    });
    attachDropTarget(folderHeader);

    const folderHeaderRow = document.createElement("div");
    folderHeaderRow.className = "space-folder-header-row";
    folderHeaderRow.appendChild(folderHeader);
    if (canManageSpaces && !isPersonalFolderId(folderId)) {
      const removeFolder = document.createElement("button");
      removeFolder.type = "button";
      removeFolder.className = "toolbar-icon space-folder-remove";
      removeFolder.title = "Delete folder";
      removeFolder.setAttribute("aria-label", "Delete folder");
      removeFolder.innerHTML = '<i class="fa-solid fa-folder-minus" aria-hidden="true"></i>';
      removeFolder.addEventListener("click", (event) => {
        event.stopPropagation();
        openFolderDeleteModal(folderId);
      });
      folderHeaderRow.appendChild(removeFolder);
    }

    const folderBody = document.createElement("div");
    folderBody.className = "space-folder-body";
    attachDropTarget(folderBody);

    if (!isOpen) {
      folderBlock.append(folderHeaderRow, folderBody);
      container.appendChild(folderBlock);
      return;
    }

    childFolders.forEach((child) => {
      renderFolder(child.id, folderId, folderBody);
    });

    folderSpaces.forEach((space) => {
      renderSpaceRow(space, folderBody);
    });

    if (!folderSpaces.length && !childFolders.length) {
      const emptyFolder = document.createElement("div");
      emptyFolder.className = "space-folder-empty";
      emptyFolder.textContent = canManageSpaces && !isPersonalFolderId(folderId)
        ? "Drop spaces here"
        : "Folder is empty";
      folderBody.appendChild(emptyFolder);
    }

    folderBlock.append(folderHeaderRow, folderBody);
    container.appendChild(folderBlock);
  };

  if (canManageSpaces) {
    const rootDrop = document.createElement("div");
    rootDrop.className = "space-root-drop";
    rootDrop.innerHTML = '<i class="fa-solid fa-house" aria-hidden="true"></i><span>Root</span>';
    rootDrop.addEventListener("dragover", (event) => {
      event.preventDefault();
      rootDrop.classList.add("drag-over");
    });
    rootDrop.addEventListener("dragleave", () => {
      rootDrop.classList.remove("drag-over");
    });
    rootDrop.addEventListener("drop", async (event) => {
      event.preventDefault();
      rootDrop.classList.remove("drag-over");
      const draggedSpaceId = event.dataTransfer?.getData("text/x-space-id") || "";
      const draggedSpacePath = event.dataTransfer?.getData("text/x-space-path") || draggedSpaceId;
      if (!draggedSpaceId) {
        return;
      }
      try {
        await moveSpaceToFolderRequest(draggedSpaceId, "");
        clearSpaceError();
        await loadSpaceList({ showLoading: false });
        showToast(`Space '${draggedSpacePath}' moved to '${draggedSpaceId}'.`);
      } catch (error) {
        setSpaceError(formatSpaceError(error, "Unable to move space."));
      }
    });
    dom.spaceList.appendChild(rootDrop);
  }

  const rootFolders = childrenByParent.get("") || [];
  rootFolders.forEach((folder) => {
    renderFolder(folder.id, "", dom.spaceList);
  });
  const rootSpaces = grouped.get("") || [];
  rootSpaces.forEach((space) => {
    renderSpaceRow(space, dom.spaceList);
  });

  if (!dom.spaceList.childElementCount) {
    const empty = document.createElement("div");
    empty.className = "modal-help";
    empty.textContent = canManageSpaces
      ? "No spaces yet. Use the add icons."
      : "No spaces available for this account.";
    dom.spaceList.appendChild(empty);
  }
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
    const result = await fetchSpaces();
    applySessionFromServer(result);
    updateCreateSpaceButton();
    updateCreateFolderButton();
    const spaces = result.spaces || [];
    const folders = sortFolderIds(result.folders || []);
    if (collab.spaceId) {
      const currentByPath = collab.spacePath
        ? spaces.find((space) => resolveSpacePath(space) === collab.spacePath)
        : null;
      const currentById = spaces.find((space) => space.id === collab.spaceId);
      const current = currentByPath || currentById || null;
      const nextPath = current ? resolveSpacePath(current) : (collab.spacePath || collab.spaceId);
      if (nextPath !== collab.spacePath) {
        collab.spacePath = nextPath;
        updateBoardConnectionLabel();
      }
    }
    collab.spaceIds = spaces.map((space) => space.id).filter(Boolean).sort((a, b) => a.localeCompare(b));
    collab.spaceFolders = folders;
    collab.spaceAccessOptions = buildAssignableAccessOptions(spaces, folders);
    if (createUserSpacesPicker) {
      createUserSpacesPicker.refreshOptions();
    }
    const snapshot = JSON.stringify(
      {
        spaces: spaces.map((space) => ({
          id: space.id,
          users: [...space.users].sort(),
          folder: space.folder || "",
          path: resolveSpacePath(space),
          personal: Boolean(space.personal),
        })),
        folders,
      }
    );
    if (snapshot === collab.lastSpaceSnapshot) {
      return;
    }
    collab.lastSpaceSnapshot = snapshot;
    renderSpaceList(spaces, folders);
  } catch (error) {
    if (showLoading) {
      dom.spaceList.innerHTML = "";
      const message = document.createElement("div");
      message.className = "modal-help error";
      message.textContent = "Unable to reach the backend.";
      dom.spaceList.appendChild(message);
    }
    collab.isAuthenticated = false;
    collab.permissions = normalizePermissions(null);
    updateRoleVisibility();
    updateConnectButtonLabel();
  }
}

function setSpaceError(message) {
  const text = typeof message === "string" ? message.trim() : "";
  if (dom.spaceError) {
    dom.spaceError.textContent = "";
    dom.spaceError.classList.add("hidden");
  }
  if (text) {
    showToast(text, "error");
  }
}

function clearSpaceError() {
  if (!dom.spaceError) {
    return;
  }
  dom.spaceError.textContent = "";
  dom.spaceError.classList.add("hidden");
}

function setJiraConfigError(message) {
  const text = typeof message === "string" ? message.trim() : "";
  if (dom.jiraConfigError) {
    dom.jiraConfigError.textContent = "";
    dom.jiraConfigError.classList.add("hidden");
  }
  if (text) {
    showToast(text, "error");
  }
}

function clearJiraConfigError() {
  if (!dom.jiraConfigError) {
    return;
  }
  dom.jiraConfigError.textContent = "";
  dom.jiraConfigError.classList.add("hidden");
}

function fillJiraConfigForm(config) {
  if (dom.jiraConfigBaseUrl) {
    dom.jiraConfigBaseUrl.value = config.baseUrl || "";
  }
  if (dom.jiraConfigEmail) {
    dom.jiraConfigEmail.value = config.email || "";
  }
  if (dom.jiraConfigToken) {
    dom.jiraConfigToken.value = config.token || "";
  }
}

function readJiraConfigForm() {
  return {
    base_url: dom.jiraConfigBaseUrl?.value?.trim() || "",
    email: dom.jiraConfigEmail?.value?.trim() || "",
    token: dom.jiraConfigToken?.value || "",
  };
}

async function openJiraConfigModal() {
  if (!dom.jiraConfigModal) {
    return;
  }
  if (!collab.isAuthenticated) {
    openLoginModal();
    return;
  }
  if (!collab.permissions.can_manage_jira) {
    setSpaceError("Only admins can change Jira settings.");
    return;
  }
  closeSpacesModal();
  closeProfileModal({ reopenSpaces: false });
  closeUsersModal({ reopenSpaces: false });
  closeSlugRenameModal();
  clearJiraConfigError();
  dom.jiraConfigModal.classList.remove("hidden");
  applyAuthFromInputs({ markDirty: false });
  try {
    const config = await fetchJiraConfig();
    fillJiraConfigForm(config);
  } catch (error) {
    setJiraConfigError(formatSpaceError(error, "Unable to load Jira config."));
  }
}

function closeJiraConfigModal({ reopenSpaces = true } = {}) {
  if (!dom.jiraConfigModal) {
    return;
  }
  dom.jiraConfigModal.classList.add("hidden");
  if (reopenSpaces) {
    openSpacesModal();
  }
}

async function submitJiraConfig() {
  clearJiraConfigError();
  try {
    const payload = readJiraConfigForm();
    const saved = await saveJiraConfig(payload);
    fillJiraConfigForm(saved);
    showToast("Jira configuration saved.");
    closeJiraConfigModal({ reopenSpaces: true });
  } catch (error) {
    setJiraConfigError(formatSpaceError(error, "Unable to save Jira config."));
  }
}

function setUsersError(message) {
  const text = typeof message === "string" ? message.trim() : "";
  if (dom.usersError) {
    dom.usersError.textContent = "";
    dom.usersError.classList.add("hidden");
  }
  if (text) {
    showToast(text, "error");
  }
}

function clearUsersError() {
  if (!dom.usersError) {
    return;
  }
  dom.usersError.textContent = "";
  dom.usersError.classList.add("hidden");
}

function setProfileError(message) {
  const text = typeof message === "string" ? message.trim() : "";
  if (dom.profileError) {
    dom.profileError.textContent = "";
    dom.profileError.classList.add("hidden");
  }
  if (text) {
    showToast(text, "error");
  }
}

function clearProfileError() {
  if (!dom.profileError) {
    return;
  }
  dom.profileError.textContent = "";
  dom.profileError.classList.add("hidden");
}

function setUserCreateError(message) {
  const text = typeof message === "string" ? message.trim() : "";
  if (dom.userCreateError) {
    dom.userCreateError.textContent = "";
    dom.userCreateError.classList.add("hidden");
  }
  if (text) {
    showToast(text, "error");
  }
}

function clearUserCreateError() {
  if (!dom.userCreateError) {
    return;
  }
  dom.userCreateError.textContent = "";
  dom.userCreateError.classList.add("hidden");
}

function setUserPasswordError(message) {
  const text = typeof message === "string" ? message.trim() : "";
  if (dom.userPasswordError) {
    dom.userPasswordError.textContent = "";
    dom.userPasswordError.classList.add("hidden");
  }
  if (text) {
    showToast(text, "error");
  }
}

function clearUserPasswordError() {
  if (!dom.userPasswordError) {
    return;
  }
  dom.userPasswordError.textContent = "";
  dom.userPasswordError.classList.add("hidden");
}

function roleUsesSpaces(role) {
  return String(role || "user").toLowerCase() === "user";
}

function updateCreateUserSpacesVisibility() {
  const showSpaces = roleUsesSpaces(dom.userNewRole?.value);
  if (dom.userNewSpacesField) {
    dom.userNewSpacesField.classList.toggle("hidden", !showSpaces);
  }
  const picker = ensureCreateUserSpacesPicker();
  if (!picker) {
    return;
  }
  if (!showSpaces) {
    picker.setValues([]);
  }
  picker.setDisabled(!showSpaces || !collab.permissions.can_assign_space_access);
}

function openUserDeleteModal(userEntry) {
  if (!dom.userDeleteModal || !dom.userDeleteMessage || !userEntry) {
    return;
  }
  pendingDeleteUser = userEntry;
  dom.userDeleteMessage.textContent = `Remove user "${userEntry.username}"? This cannot be undone.`;
  dom.userDeleteModal.classList.remove("hidden");
}

function closeUserDeleteModal() {
  if (!dom.userDeleteModal) {
    return;
  }
  dom.userDeleteModal.classList.add("hidden");
  pendingDeleteUser = null;
}

function openUserCreateModal() {
  if (!dom.userCreateModal) {
    return;
  }
  clearUserCreateError();
  if (dom.userNewUsername) {
    dom.userNewUsername.value = "";
  }
  if (dom.userNewDisplayName) {
    dom.userNewDisplayName.value = "";
  }
  if (dom.userNewPassword) {
    dom.userNewPassword.value = "";
  }
  if (dom.userNewPasswordConfirm) {
    dom.userNewPasswordConfirm.value = "";
  }
  if (dom.userNewRole) {
    dom.userNewRole.value = "user";
  }
  const picker = ensureCreateUserSpacesPicker();
  if (picker) {
    picker.setValues([]);
    picker.refreshOptions();
  }
  updateCreateUserSpacesVisibility();
  dom.userCreateModal.classList.remove("hidden");
}

function closeUserCreateModal() {
  if (!dom.userCreateModal) {
    return;
  }
  dom.userCreateModal.classList.add("hidden");
}

function openUserPasswordModal(userEntry) {
  if (!dom.userPasswordModal || !userEntry) {
    return;
  }
  pendingPasswordUser = userEntry;
  clearUsersError();
  clearUserPasswordError();
  if (dom.userPasswordMessage) {
    dom.userPasswordMessage.textContent = `Set a new password for "${userEntry.username}".`;
  }
  if (dom.userPasswordNew) {
    dom.userPasswordNew.value = "";
  }
  if (dom.userPasswordRepeat) {
    dom.userPasswordRepeat.value = "";
  }
  dom.userPasswordModal.classList.remove("hidden");
}

function closeUserPasswordModal() {
  if (!dom.userPasswordModal) {
    return;
  }
  dom.userPasswordModal.classList.add("hidden");
  pendingPasswordUser = null;
  clearUserPasswordError();
}

async function submitUserPasswordChange() {
  if (!pendingPasswordUser) {
    closeUserPasswordModal();
    return;
  }
  const targetUsername = pendingPasswordUser.username;
  clearUsersError();
  clearUserPasswordError();
  const nextPassword = dom.userPasswordNew?.value || "";
  const repeatPassword = dom.userPasswordRepeat?.value || "";
  if (!nextPassword || !repeatPassword) {
    setUserPasswordError("Enter and repeat the new password.");
    return;
  }
  if (nextPassword !== repeatPassword) {
    setUserPasswordError("Passwords do not match.");
    return;
  }
  try {
    await updateUserRequest(targetUsername, { password: nextPassword });
    closeUserPasswordModal();
    await loadUsersModalData({ refreshSpaces: false });
    showToast(`Password changed for '${targetUsername}'.`);
  } catch (error) {
    setUserPasswordError(formatSpaceError(error, "Unable to change password."));
  }
}

async function confirmDeleteUser() {
  if (!pendingDeleteUser) {
    closeUserDeleteModal();
    return;
  }
  const targetUsername = pendingDeleteUser.username;
  clearUsersError();
  try {
    await deleteUserRequest(targetUsername);
    closeUserDeleteModal();
    await loadUsersModalData({ refreshSpaces: true });
    showToast(`User '${targetUsername}' deleted.`);
  } catch (error) {
    setUsersError(formatSpaceError(error, "Unable to remove user."));
  }
}

function normalizeSelectedSpaces(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  const seen = new Set();
  const normalized = [];
  values.forEach((item) => {
    if (typeof item !== "string") {
      return;
    }
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  });
  return normalized;
}

function createSpacePicker({
  selected = [],
  getOptions = () => [],
  placeholder = "Search access paths",
  onChange = null,
} = {}) {
  const root = document.createElement("div");
  root.className = "space-picker";
  const tags = document.createElement("div");
  tags.className = "space-picker-tags";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "space-picker-input";
  input.placeholder = placeholder;
  const dropdown = document.createElement("div");
  dropdown.className = "space-picker-dropdown hidden";
  root.append(tags, input, dropdown);

  let isOpen = false;
  let isDisabled = false;
  let values = normalizeSelectedSpaces(selected);
  const emitChange = () => {
    if (typeof onChange === "function") {
      onChange([...values]);
    }
  };

  const options = () =>
    [...new Set(getOptions().filter((name) => typeof name === "string" && name.trim()))].sort(
      (a, b) => a.localeCompare(b)
    );

  const suggestionList = () => {
    const query = input.value.trim().toLowerCase();
    return options().filter(
      (name) =>
        !values.includes(name) &&
        (!query || name.toLowerCase().includes(query))
    );
  };

  const render = () => {
    tags.innerHTML = "";
    values.forEach((name) => {
      const chip = document.createElement("span");
      chip.className = "space-picker-chip";
      const label = document.createElement("span");
      label.textContent = name;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "space-picker-chip-remove";
      remove.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
      remove.setAttribute("aria-label", `Remove ${name}`);
      remove.disabled = isDisabled;
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        values = values.filter((item) => item !== name);
        render();
        emitChange();
      });
      chip.append(label, remove);
      tags.appendChild(chip);
    });

    const suggestions = suggestionList();
    dropdown.innerHTML = "";
    if (!isDisabled && isOpen) {
      if (suggestions.length) {
        suggestions.forEach((name) => {
          const option = document.createElement("button");
          option.type = "button";
          option.className = "space-picker-option";
          option.textContent = name;
          option.addEventListener("mousedown", (event) => {
            event.preventDefault();
            if (values.includes(name)) {
              return;
            }
            values.push(name);
            input.value = "";
            isOpen = true;
            render();
            emitChange();
            input.focus();
          });
          dropdown.appendChild(option);
        });
      } else {
        const empty = document.createElement("div");
        empty.className = "space-picker-empty";
        empty.textContent = "No matching paths";
        dropdown.appendChild(empty);
      }
    }
    dropdown.classList.toggle("hidden", !isOpen || isDisabled);
    input.disabled = isDisabled;
    root.classList.toggle("disabled", isDisabled);
  };

  input.addEventListener("focus", () => {
    if (isDisabled) {
      return;
    }
    isOpen = true;
    render();
  });
  input.addEventListener("input", () => {
    isOpen = true;
    render();
  });
  input.addEventListener("keydown", (event) => {
    if (isDisabled) {
      return;
    }
    if (event.key === "Backspace" && !input.value.trim() && values.length) {
      values = values.slice(0, -1);
      render();
      emitChange();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const first = suggestionList()[0];
      if (!first) {
        return;
      }
      values.push(first);
      input.value = "";
      isOpen = true;
      render();
      emitChange();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      isOpen = false;
      render();
    }
  });
  input.addEventListener("blur", () => {
    setTimeout(() => {
      isOpen = false;
      render();
    }, 120);
  });
  root.addEventListener("click", () => {
    if (isDisabled) {
      return;
    }
    input.focus();
  });

  render();
  return {
    root,
    getValues() {
      return [...values];
    },
    setValues(nextValues) {
      values = normalizeSelectedSpaces(nextValues);
      render();
      emitChange();
    },
    setDisabled(nextDisabled) {
      isDisabled = Boolean(nextDisabled);
      if (isDisabled) {
        isOpen = false;
      }
      render();
    },
    refreshOptions() {
      render();
    },
  };
}

function ensureCreateUserSpacesPicker() {
  if (!dom.userNewSpaces) {
    return null;
  }
  if (!createUserSpacesPicker) {
    createUserSpacesPicker = createSpacePicker({
      selected: [],
      getOptions: getAssignableSpaces,
      placeholder: "Add path access",
    });
    dom.userNewSpaces.innerHTML = "";
    dom.userNewSpaces.appendChild(createUserSpacesPicker.root);
  }
  return createUserSpacesPicker;
}

function roleOptionsMarkup(selectedRole, allowAdminRoles = true) {
  const roles = allowAdminRoles ? ["admin", "manager", "user"] : ["user"];
  return roles
    .map((role) => `<option value="${role}"${role === selectedRole ? " selected" : ""}>${role}</option>`)
    .join("");
}

function renderUsersList(users) {
  if (!dom.usersList) {
    return;
  }
  dom.usersList.innerHTML = "";
  const visibleUsers = Array.isArray(users)
    ? users.filter((entry) => !(entry && entry.self))
    : [];
  if (!visibleUsers.length) {
    const empty = document.createElement("div");
    empty.className = "modal-help";
    empty.textContent = "No users found.";
    dom.usersList.appendChild(empty);
    return;
  }
  const canSetAdminRoles = collab.role === "admin";
  visibleUsers.forEach((entry) => {
    const row = document.createElement("div");
    row.className = "user-row";

    const info = document.createElement("div");
    info.className = "user-row-info";
    info.textContent = `${entry.username}${entry.self ? " (you)" : ""}`;

    const grid = document.createElement("div");
    grid.className = "users-edit-grid";
    const displayInput = document.createElement("input");
    displayInput.type = "text";
    const entryDisplayName = normalizeOptionalDisplayName(
      entry.display_name,
      entry.username
    );
    displayInput.value = entryDisplayName;
    displayInput.placeholder = "Display name";
    const initialDisplayName = entryDisplayName;

    const roleSelect = document.createElement("select");
    roleSelect.className = "user-role-select";
    roleSelect.innerHTML = roleOptionsMarkup(entry.role || "user", canSetAdminRoles);
    const initialRole = String(entry.role || "user").toLowerCase();

    const spacesField = document.createElement("div");
    spacesField.className = "user-row-space";
    spacesField.classList.add("user-permissions-field");
    const initialSpaces = normalizeSelectedSpaces(
      Array.isArray(entry.spaces) ? entry.spaces : []
    );
    const spacesPicker = createSpacePicker({
      selected: initialSpaces,
      getOptions: getAssignableSpaces,
      placeholder: "Add path access",
      onChange: () => {
        refreshSaveButtonState();
      },
    });
    spacesField.appendChild(spacesPicker.root);

    const editable = Boolean(entry.editable);
    const self = Boolean(entry.self);
    const allowRoleAndSpaces = editable && !self;
    const normalizePaths = (paths) =>
      normalizeSelectedSpaces(paths).sort((a, b) => a.localeCompare(b));
    const areEqualPaths = (left, right) =>
      left.length === right.length && left.every((item, index) => item === right[index]);

    let saveBtn = null;
    const isUserDirty = () => {
      const displayDirty = (displayInput.value || "").trim() !== initialDisplayName;
      if (self) {
        return displayDirty;
      }
      const currentRole = String(roleSelect.value || "user").toLowerCase();
      const roleDirty = currentRole !== initialRole;
      const baselineSpaces = roleUsesSpaces(initialRole) ? normalizePaths(initialSpaces) : [];
      const currentSpaces = roleUsesSpaces(currentRole)
        ? normalizePaths(spacesPicker.getValues())
        : [];
      const spacesDirty = !areEqualPaths(currentSpaces, baselineSpaces);
      return displayDirty || roleDirty || spacesDirty;
    };
    function refreshSaveButtonState() {
      if (!saveBtn) {
        return;
      }
      const dirty = editable && isUserDirty();
      saveBtn.classList.toggle("success", dirty);
      saveBtn.disabled = !dirty;
    }

    displayInput.disabled = !editable;
    roleSelect.disabled = !allowRoleAndSpaces;
    const updateSpacesVisibility = () => {
      const visible = allowRoleAndSpaces && roleUsesSpaces(roleSelect.value);
      spacesField.classList.toggle("hidden", !visible);
      spacesPicker.setDisabled(!visible);
      refreshSaveButtonState();
    };
    roleSelect.addEventListener("change", updateSpacesVisibility);
    displayInput.addEventListener("input", refreshSaveButtonState);
    updateSpacesVisibility();

    grid.append(displayInput, roleSelect, spacesField);

    const actions = document.createElement("div");
    actions.className = "user-row-actions";
    const passwordBtn = document.createElement("button");
    passwordBtn.type = "button";
    passwordBtn.className = "toolbar-button";
    passwordBtn.title = "Change password";
    passwordBtn.setAttribute("aria-label", "Change password");
    passwordBtn.innerHTML = '<i class="fa-solid fa-key" aria-hidden="true"></i><span>Change Password</span>';
    passwordBtn.disabled = !editable;
    passwordBtn.addEventListener("click", () => {
      openUserPasswordModal(entry);
    });

    saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "toolbar-button user-save";
    saveBtn.title = "Save";
    saveBtn.setAttribute("aria-label", "Save");
    saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk" aria-hidden="true"></i><span>Save</span>';
    saveBtn.disabled = true;
    saveBtn.addEventListener("click", async () => {
      clearUsersError();
      const currentDisplayName = (displayInput.value || "").trim();
      const currentRole = String(roleSelect.value || "user").toLowerCase();
      const baselineSpaces = roleUsesSpaces(initialRole) ? normalizePaths(initialSpaces) : [];
      const currentSpaces = roleUsesSpaces(currentRole)
        ? normalizePaths(spacesPicker.getValues())
        : [];
      const displayChanged = currentDisplayName !== initialDisplayName;
      const roleChanged = !self && currentRole !== initialRole;
      const permissionsChanged = !self && !areEqualPaths(currentSpaces, baselineSpaces);
      try {
        const payload = {
          display_name: currentDisplayName,
        };
        if (!self) {
          payload.role = currentRole;
          if (roleUsesSpaces(currentRole)) {
            payload.spaces = currentSpaces;
          }
        }
        await updateUserRequest(entry.username, payload);
        if (displayChanged) {
          showToast("Display name updated.");
        }
        if (roleChanged) {
          showToast("Role updated.");
        }
        if (permissionsChanged) {
          showToast("Permission updated.");
        }
        if (!displayChanged && !roleChanged && !permissionsChanged) {
          showToast("User updated.");
        }
        await loadUsersModalData({ refreshSpaces: true });
      } catch (error) {
        setUsersError(formatSpaceError(error, "Unable to save user."));
      }
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "toolbar-button danger";
    deleteBtn.title = "Delete user";
    deleteBtn.setAttribute("aria-label", "Delete user");
    deleteBtn.innerHTML = '<i class="fa-solid fa-trash" aria-hidden="true"></i><span>Delete User</span>';
    deleteBtn.disabled = !entry.deletable;
    deleteBtn.addEventListener("click", () => {
      openUserDeleteModal(entry);
    });

    actions.append(passwordBtn, saveBtn, deleteBtn);
    row.append(info, grid, actions);
    dom.usersList.appendChild(row);
    refreshSaveButtonState();
  });
}

async function loadUsersModalData({ refreshSpaces = false } = {}) {
  clearUsersError();
  const me = await fetchMe();
  applySessionFromServer(me);
  collab.isAuthenticated = true;
  updateConnectButtonLabel();
  if (collab.permissions.can_assign_space_access) {
    try {
      const spacesResult = await fetchSpaces();
      const fetchedSpaces = spacesResult.spaces || [];
      const fetchedFolders = sortFolderIds(spacesResult.folders || []);
      collab.spaceIds = fetchedSpaces
        .map((space) => space.id)
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
      collab.spaceFolders = fetchedFolders;
      collab.spaceAccessOptions = buildAssignableAccessOptions(
        fetchedSpaces,
        fetchedFolders
      );
    } catch {
      // Keep existing options when spaces are temporarily unavailable.
    }
  }
  if (dom.userNewRole) {
    const allowAdminRoles = collab.role === "admin";
    dom.userNewRole.innerHTML = roleOptionsMarkup("user", allowAdminRoles);
    dom.userNewRole.disabled = !collab.permissions.can_manage_users;
  }
  updateCreateUserSpacesVisibility();
  const createPicker = ensureCreateUserSpacesPicker();
  if (createPicker) {
    createPicker.refreshOptions();
  }
  if (dom.usersAdminSection) {
    dom.usersAdminSection.classList.toggle("hidden", !collab.permissions.can_manage_users);
  }

  if (collab.permissions.can_manage_users) {
    const userData = await fetchUsers();
    renderUsersList(userData.users || []);
  } else if (dom.usersList) {
    dom.usersList.innerHTML = "";
  }
  if (refreshSpaces && collab.isAuthenticated) {
    await loadSpaceList({ showLoading: false });
  }
}

async function openUsersModal() {
  if (!dom.usersModal) {
    return;
  }
  if (!collab.isAuthenticated) {
    openLoginModal();
    return;
  }
  if (!collab.permissions.can_manage_users) {
    setSpaceError("You do not have permission to manage users.");
    return;
  }
  closeSpacesModal();
  closeProfileModal({ reopenSpaces: false });
  closeJiraConfigModal({ reopenSpaces: false });
  closeSlugRenameModal();
  dom.usersModal.classList.remove("hidden");
  applyAuthFromInputs({ markDirty: false });
  try {
    await loadUsersModalData();
  } catch (error) {
    setUsersError(formatSpaceError(error, "Unable to load user data."));
  }
}

function closeUsersModal({ reopenSpaces = true } = {}) {
  if (!dom.usersModal) {
    return;
  }
  dom.usersModal.classList.add("hidden");
  closeUserCreateModal();
  closeUserPasswordModal();
  closeUserDeleteModal();
  if (reopenSpaces) {
    openSpacesModal();
  }
}

function openProfileLogoutModal() {
  if (!dom.profileLogoutModal) {
    return;
  }
  dom.profileLogoutModal.classList.remove("hidden");
}

function closeProfileLogoutModal() {
  if (!dom.profileLogoutModal) {
    return;
  }
  dom.profileLogoutModal.classList.add("hidden");
}

async function loadProfileModalData() {
  clearProfileError();
  const me = await fetchMe();
  applySessionFromServer(me);
  collab.isAuthenticated = true;
  updateConnectButtonLabel();
  if (dom.profileDisplayName) {
    dom.profileDisplayName.value = collab.displayName || "";
  }
  if (dom.profileCurrentPassword) {
    dom.profileCurrentPassword.value = "";
  }
  if (dom.profilePassword) {
    dom.profilePassword.value = "";
  }
  if (dom.profilePasswordConfirm) {
    dom.profilePasswordConfirm.value = "";
  }
}

async function openProfileModal() {
  if (!dom.profileModal) {
    return;
  }
  if (!collab.isAuthenticated) {
    openLoginModal();
    return;
  }
  closeSpacesModal();
  closeUsersModal({ reopenSpaces: false });
  closeJiraConfigModal({ reopenSpaces: false });
  closeProfileLogoutModal();
  closeSlugRenameModal();
  dom.profileModal.classList.remove("hidden");
  applyAuthFromInputs({ markDirty: false });
  try {
    await loadProfileModalData();
  } catch (error) {
    setProfileError(formatSpaceError(error, "Unable to load profile."));
  }
}

function closeProfileModal({ reopenSpaces = true } = {}) {
  if (!dom.profileModal) {
    return;
  }
  dom.profileModal.classList.add("hidden");
  closeProfileLogoutModal();
  if (reopenSpaces) {
    openSpacesModal();
  }
}

async function submitProfileUpdate() {
  clearProfileError();
  const previousDisplayName = collab.displayName || "";
  const payload = {
    display_name: dom.profileDisplayName?.value?.trim() || "",
  };
  const currentPassword = dom.profileCurrentPassword?.value || "";
  const nextPassword = dom.profilePassword?.value || "";
  const confirmPassword = dom.profilePasswordConfirm?.value || "";
  if (nextPassword || confirmPassword) {
    if (!nextPassword || !confirmPassword) {
      setProfileError("Enter and confirm the new password.");
      return;
    }
    if (!currentPassword) {
      setProfileError("Current password is required.");
      return;
    }
    if (nextPassword !== confirmPassword) {
      setProfileError("Passwords do not match.");
      return;
    }
    payload.current_password = currentPassword;
    payload.password = nextPassword;
  }
  try {
    const displayChanged = payload.display_name !== previousDisplayName;
    const passwordChanged = Boolean(payload.password);
    if (passwordChanged) {
      await verifyCurrentPassword(currentPassword);
    }
    const data = await saveMyProfile(payload);
    applySessionFromServer(data);
    persistAuth({
      username: collab.username,
    });
    if (dom.profilePassword) {
      dom.profilePassword.value = "";
    }
    if (dom.profilePasswordConfirm) {
      dom.profilePasswordConfirm.value = "";
    }
    if (dom.profileCurrentPassword) {
      dom.profileCurrentPassword.value = "";
    }
    if (displayChanged) {
      showToast("Display name updated.");
    }
    if (passwordChanged) {
      showToast("Password changed.");
    }
    if (!displayChanged && !passwordChanged) {
      showToast("Profile updated.");
    }
    closeProfileModal({ reopenSpaces: true });
  } catch (error) {
    setProfileError(formatSpaceError(error, "Unable to update profile."));
  }
}

async function submitCreateUser() {
  clearUsersError();
  clearUserCreateError();
  const username = dom.userNewUsername?.value?.trim() || "";
  const password = dom.userNewPassword?.value || "";
  const passwordConfirm = dom.userNewPasswordConfirm?.value || "";
  if (!username || !password || !passwordConfirm) {
    setUserCreateError("Username, password, and confirmation are required.");
    return;
  }
  if (password !== passwordConfirm) {
    setUserCreateError("Passwords do not match.");
    return;
  }
  const payload = {
    username,
    display_name: dom.userNewDisplayName?.value?.trim() || username,
    password,
    role: dom.userNewRole?.value || "user",
  };
  if (roleUsesSpaces(payload.role)) {
    const picker = ensureCreateUserSpacesPicker();
    payload.spaces = picker ? picker.getValues() : [];
  }
  try {
    await createUserRequest(payload);
    if (dom.userNewUsername) {
      dom.userNewUsername.value = "";
    }
    if (dom.userNewDisplayName) {
      dom.userNewDisplayName.value = "";
    }
    if (dom.userNewPassword) {
      dom.userNewPassword.value = "";
    }
    if (dom.userNewPasswordConfirm) {
      dom.userNewPasswordConfirm.value = "";
    }
    const picker = ensureCreateUserSpacesPicker();
    if (picker) {
      picker.setValues([]);
    }
    updateCreateUserSpacesVisibility();
    closeUserCreateModal();
    await loadUsersModalData({ refreshSpaces: true });
    showToast(`User '${username}' created.`);
  } catch (error) {
    setUserCreateError(formatSpaceError(error, "Unable to create user."));
  }
}

function openSpaceCreateModal() {
  if (!dom.spaceCreateModal || !collab.permissions.can_manage_spaces) {
    return;
  }
  clearSpaceError();
  if (dom.spaceNew) {
    dom.spaceNew.value = "";
  }
  updateCreateSpaceButton();
  dom.spaceCreateModal.classList.remove("hidden");
  dom.spaceNew?.focus();
}

function closeSpaceCreateModal() {
  if (!dom.spaceCreateModal) {
    return;
  }
  dom.spaceCreateModal.classList.add("hidden");
}

function openSpaceFolderCreateModal() {
  if (!dom.spaceFolderCreateModal || !collab.permissions.can_manage_spaces) {
    return;
  }
  clearSpaceError();
  if (dom.spaceFolderNew) {
    dom.spaceFolderNew.value = "";
  }
  updateCreateFolderButton();
  dom.spaceFolderCreateModal.classList.remove("hidden");
  dom.spaceFolderNew?.focus();
}

function closeSpaceFolderCreateModal() {
  if (!dom.spaceFolderCreateModal) {
    return;
  }
  dom.spaceFolderCreateModal.classList.add("hidden");
}

function updateCreateSpaceButton() {
  if (!dom.spaceCreate || !dom.spaceNew) {
    return;
  }
  if (!collab.permissions.can_manage_spaces) {
    dom.spaceCreate.disabled = true;
    return;
  }
  const hasName = Boolean(dom.spaceNew.value.trim());
  dom.spaceCreate.disabled = !hasName;
}

function updateCreateFolderButton() {
  if (!dom.spaceFolderCreate || !dom.spaceFolderNew) {
    return;
  }
  if (!collab.permissions.can_manage_spaces) {
    dom.spaceFolderCreate.disabled = true;
    return;
  }
  const hasName = Boolean(dom.spaceFolderNew.value.trim());
  dom.spaceFolderCreate.disabled = !hasName;
}

function getCurrentFolderForCreate() {
  const folderId =
    typeof collab.openSpaceFolderId === "string"
      ? collab.openSpaceFolderId.trim()
      : "";
  return folderId || "";
}

async function submitCreateSpace() {
  if (!collab.permissions.can_manage_spaces) {
    return;
  }
  const name = dom.spaceNew?.value?.trim() || "";
  if (!name) {
    updateCreateSpaceButton();
    return;
  }
  const targetFolder = getCurrentFolderForCreate();
  if (isPersonalFolderId(targetFolder)) {
    setSpaceError("Cannot create a shared space in the personal folder.");
    return;
  }
  try {
    applyAuthFromInputs({ markDirty: false });
    await createSpace(name);
    if (targetFolder) {
      await moveSpaceToFolderRequest(name, targetFolder);
    }
    if (dom.spaceNew) {
      dom.spaceNew.value = "";
    }
    clearSpaceError();
    updateCreateSpaceButton();
    closeSpaceCreateModal();
    await loadSpaceList({ showLoading: false });
    showToast(`Space '${buildSpacePath(name, targetFolder)}' created.`);
  } catch (error) {
    setSpaceError(formatSpaceError(error, "Unable to create space."));
  }
}

async function submitCreateFolder() {
  if (!collab.permissions.can_manage_spaces) {
    return;
  }
  const name = dom.spaceFolderNew?.value?.trim() || "";
  if (!name) {
    updateCreateFolderButton();
    return;
  }
  const currentFolder = getCurrentFolderForCreate();
  if (isPersonalFolderId(currentFolder)) {
    setSpaceError("Cannot create folders inside the personal folder.");
    return;
  }
  const targetName = currentFolder ? `${currentFolder}/${name}` : name;
  try {
    applyAuthFromInputs({ markDirty: false });
    await createSpaceFolderRequest(targetName);
    collab.openSpaceFolderId = targetName;
    if (dom.spaceFolderNew) {
      dom.spaceFolderNew.value = "";
    }
    clearSpaceError();
    updateCreateFolderButton();
    closeSpaceFolderCreateModal();
    await loadSpaceList({ showLoading: false });
    showToast(`Folder '${targetName}' created.`);
  } catch (error) {
    setSpaceError(formatSpaceError(error, "Unable to create folder."));
  }
}

async function confirmDeleteFolder() {
  if (!pendingDeleteFolder) {
    closeFolderDeleteModal();
    return;
  }
  const folderToDelete = pendingDeleteFolder;
  try {
    applyAuthFromInputs({ markDirty: false });
    await deleteSpaceFolderRequest(folderToDelete);
    closeFolderDeleteModal();
    clearSpaceError();
    await loadSpaceList({ showLoading: false });
    showToast(`Folder '${folderToDelete}' deleted.`);
  } catch (error) {
    closeFolderDeleteModal();
    setSpaceError(formatSpaceError(error, "Unable to delete folder."));
  }
}

function openDeleteModal(spaceRef) {
  if (!dom.deleteModal || !dom.deleteModalMessage) {
    return;
  }
  const parsed = (
    typeof spaceRef === "string"
      ? { id: spaceRef.trim(), path: spaceRef.trim() }
      : {
        id: typeof spaceRef?.id === "string" ? spaceRef.id.trim() : "",
        path: typeof spaceRef?.path === "string" && spaceRef.path.trim()
          ? spaceRef.path.trim()
          : buildSpacePath(spaceRef?.id, spaceRef?.folder),
      }
  );
  if (!parsed.id) {
    return;
  }
  pendingDeleteSpace = parsed;
  dom.deleteModalMessage.textContent = `Delete space "${parsed.path || parsed.id}"? This cannot be undone.`;
  dom.deleteModal.classList.remove("hidden");
}

function closeDeleteModal() {
  if (!dom.deleteModal) {
    return;
  }
  dom.deleteModal.classList.add("hidden");
  pendingDeleteSpace = null;
}

function openFolderDeleteModal(folderId) {
  if (!dom.folderDeleteModal || !dom.folderDeleteMessage) {
    return;
  }
  pendingDeleteFolder = folderId;
  dom.folderDeleteMessage.textContent = `Delete folder "${folderId}"? Only empty folders can be deleted.`;
  dom.folderDeleteModal.classList.remove("hidden");
}

function closeFolderDeleteModal() {
  if (!dom.folderDeleteModal) {
    return;
  }
  dom.folderDeleteModal.classList.add("hidden");
  pendingDeleteFolder = null;
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
    showToast("Unable to load space. Check the credentials.", "error");
  }
}

async function attemptLogin() {
  applyAuthFromInputs({ markDirty: false });
  if (dom.loginError) {
    dom.loginError.classList.add("hidden");
    dom.loginError.textContent = "";
  }
  try {
    const credentials = readAuthInputs();
    if (!credentials.username || !credentials.authToken) {
      throw new Error("Unauthorized");
    }
    const result = await loginRequest(credentials.username, credentials.authToken);
    applySessionFromServer(result);
    collab.isAuthenticated = true;
    collab.authToken = "";
    if (dom.loginPassword) {
      dom.loginPassword.value = "";
    }
    persistAuth({
      username: collab.username,
    });
    updateConnectButtonLabel();
    closeLoginModal();
    openSpacesModal();
    showToast("Logged in.");
    if (collab.mustChangePassword) {
      showToast("Change the default admin password.", "error");
      openProfileModal();
    }
  } catch (error) {
    collab.isAuthenticated = false;
    collab.mustChangePassword = false;
    collab.permissions = normalizePermissions(null);
    updateRoleVisibility();
    updateConnectButtonLabel();
    if (dom.loginError) {
      dom.loginError.classList.add("hidden");
      dom.loginError.textContent = "";
    }
    const message =
      error instanceof Error && error.message === "Unable to reach the backend."
        ? "Backend is not running."
        : "Invalid credentials.";
    showToast(message, "error");
  }
}

async function restoreSessionFromCookie() {
  try {
    const me = await fetchMe();
    applySessionFromServer(me);
    collab.isAuthenticated = true;
    collab.authToken = "";
    updateConnectButtonLabel();
    const allowedSpaces = Array.isArray(me.spaces)
      ? me.spaces.filter((spaceId) => typeof spaceId === "string")
      : [];
    const lastSpace =
      typeof me.last_space === "string" ? me.last_space.trim() : "";
    if (lastSpace && allowedSpaces.includes(lastSpace)) {
      connectToSpace(lastSpace);
    }
  } catch {
    collab.isAuthenticated = false;
    collab.mustChangePassword = false;
    collab.permissions = normalizePermissions(null);
    updateRoleVisibility();
    updateConnectButtonLabel();
  }
}

async function logout() {
  disconnectSpace();
  await logoutRequest();
  collab.isAuthenticated = false;
  collab.username = "";
  collab.displayName = "";
  collab.role = "user";
  collab.mustChangePassword = false;
  collab.permissions = normalizePermissions(null);
  collab.authToken = AUTH_TOKEN;
  collab.identity = getCollabIdentity("user");
  try {
    localStorage.removeItem("collabAuth");
  } catch {
    // Ignore storage failures.
  }
  updateConnectButtonLabel();
  updateRoleVisibility();
  closeProfileModal({ reopenSpaces: false });
  closeJiraConfigModal({ reopenSpaces: false });
  closeUsersModal({ reopenSpaces: false });
  closeSpacesModal();
  openLoginModal();
  showToast("Logged out.");
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

function userResponseError(response, fallback) {
  if (!response) {
    return fallback;
  }
  if (response.status === 400) {
    return "Invalid user data.";
  }
  if (response.status === 401) {
    return "Invalid credentials.";
  }
  if (response.status === 403) {
    return "Not allowed.";
  }
  if (response.status === 404) {
    return "User not found.";
  }
  if (response.status === 409) {
    return "User already exists.";
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

function startPresenceHeartbeat(spaceId) {
  void spaceId;
  if (collab.presenceTimer) {
    clearInterval(collab.presenceTimer);
    collab.presenceTimer = null;
  }
  // Space-list presence is derived from Yjs awareness on the backend now.
}

function stopPresenceHeartbeat(spaceId) {
  void spaceId;
  if (collab.presenceTimer) {
    clearInterval(collab.presenceTimer);
    collab.presenceTimer = null;
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
  closeSlugRenameModal();
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
  closeProfileModal({ reopenSpaces: false });
  closeJiraConfigModal({ reopenSpaces: false });
  closeUsersModal({ reopenSpaces: false });
  closeSpaceCreateModal();
  closeSpaceFolderCreateModal();
  closeFolderDeleteModal();
  closeSlugRenameModal();
  dom.spacesModal.classList.remove("hidden");
  applyAuthFromInputs({ markDirty: false });
  clearSpaceError();
  updateRoleVisibility();
  updateCreateSpaceButton();
  updateCreateFolderButton();
  collab.lastSpaceSnapshot = "";
  collab.openSpaceFolderId = null;
  collab.openSpaceFolderInitialized = false;
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
  closeSlugRenameModal();
  closeSpaceCreateModal();
  closeSpaceFolderCreateModal();
  closeFolderDeleteModal();
  if (collab.spacePoller) {
    clearInterval(collab.spacePoller);
    collab.spacePoller = null;
  }
}

function updateConnectButtonLabel() {
  if (!dom.connectButton) {
    return;
  }
  let buttonText = "Login";
  if (collab.spaceId || collab.isAuthenticated) {
    setButtonIcon(dom.connectButton, "fa-right-left");
    dom.connectButton.title = "Switch space";
    dom.connectButton.setAttribute("aria-label", "Switch space");
    buttonText = "Switch";
  } else {
    setButtonIcon(dom.connectButton, "fa-cloud");
    dom.connectButton.title = "Login";
    dom.connectButton.setAttribute("aria-label", "Login");
    buttonText = "Login";
  }
  if (dom.connectButton.classList.contains("topbar-connect-button")) {
    const labels = Array.from(dom.connectButton.querySelectorAll("span"));
    let label = labels[0] || null;
    if (!label) {
      label = document.createElement("span");
      dom.connectButton.appendChild(label);
    }
    label.textContent = buttonText;
    labels.slice(1).forEach((extra) => extra.remove());
  }
  updateRoleVisibility();
  updateBoardConnectionLabel();
}

function disconnectSpace() {
  stopPresenceHeartbeat(collab.spaceId);
  stopIdleWatch();
  editorController?.setCollabExtensions?.([]);
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
  collab.spacePath = "";
  collab.provider = null;
  collab.ydoc = null;
  collab.ytext = null;
  collab.binding = null;
  collab.bindingMode = null;
  collab.saveTimer = null;
  collab.presenceTimer = null;
  collab.synced = false;
  collab.lastActivityAt = 0;
  collab.connectionStatus = "disconnected";
  trackOfflineDraftChange(editorController?.getValue?.() || dom.editor?.value || "");
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
      if (collab.bindingMode !== "cm6") {
        forceEditorRefresh("");
      }
      return;
    }
    if (!current && content) {
      ytext.insert(0, content);
      if (collab.bindingMode !== "cm6") {
        forceEditorRefresh(content);
      }
      return;
    }
    if (current && current !== content) {
      // Backend persists Yjs room state to the space text file; no client-side
      // REST PUT echo is needed here.
    }
  } catch {
    // Ignore hydration errors.
  }
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

async function connectToSpace(spaceId, spacePath = "") {
  if (!spaceId || !dom.editor) {
    return;
  }
  const normalizedPath =
    typeof spacePath === "string" && spacePath.trim() ? spacePath.trim() : spaceId;
  applyAuthFromInputs({ markDirty: false });
  closeSpacesModal();
  const { Y, WebsocketProvider, yCollab } = await loadCollabModules();
  if (!yCollab) {
    return;
  }
  disconnectSpace();
  stopOfflineDraftTimer();
  collab.offlineDraftDirty = false;

  const ydoc = new Y.Doc();
  collab.synced = false;
  setConnectionStatus("connecting");
  startIdleWatch();
  const wsParams = {};
  if (collab.username && collab.authToken) {
    wsParams.user = collab.username;
    wsParams.pass = collab.authToken;
  }
  const provider = new WebsocketProvider(WS_BASE, spaceId, ydoc, {
    params: wsParams,
  });
  const identity =
    collab.identity ||
    getCollabIdentity(collab.displayName || collab.username || "user");
  const ytext = ydoc.getText("content");

  // y-codemirror.next applies Y.Text deltas onto the existing CodeMirror document.
  // Clear the pre-connect local editor content first so remote hydration/sync doesn't
  // prepend/merge with whatever was previously open (sample/offline draft/local space).
  editorController?.setValue("");

  const collabExtension = yCollab(ytext, provider.awareness);
  editorController?.setCollabExtensions?.([collabExtension]);
  const binding = {
    destroy() {
      editorController?.setCollabExtensions?.([]);
    },
  };
  const bindingMode = "cm6";

  collab.spaceId = spaceId;
  collab.spacePath = normalizedPath;
  collab.provider = provider;
  collab.ydoc = ydoc;
  collab.ytext = ytext;
  collab.binding = binding;
  collab.bindingMode = bindingMode;
  publishCollabIdentityAwareness();
  updateConnectButtonLabel();
  updateBoardConnectionLabel();
  startPresenceHeartbeat(spaceId);

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

  ytext.observe((event, transaction) => {
    void event;
    void transaction;
    markActivity();
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
    editorController.focus();
    editorController.undo();
    syncEditorState();
  });
}

if (dom.redoButton) {
  dom.redoButton.addEventListener("click", () => {
    editorController.focus();
    editorController.redo();
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
    editorController.setValue(text);
    dom.fileInput.value = "";
    syncEditorState();
  });
}

if (dom.saveButton) {
  dom.saveButton.addEventListener("click", () => {
    const title = state.config?.boardName || dom.boardTitle?.textContent || "tasks";
    const filename = `${toSafeFilename(title)}.txt`;
    const blob = new Blob([editorController.getValue()], { type: "text/plain" });
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
    const currentValue = editorController.getValue();
    const formatted = formatTaskScript(currentValue);
    if (formatted === currentValue) {
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
  if (editorController?.setTheme) {
    editorController.setTheme(resolved);
  }
  if (modalEditorController?.setTheme) {
    modalEditorController.setTheme(resolved);
  }
  if (dom.themeButton) {
    setButtonIcon(dom.themeButton, resolved === "dark" ? "fa-moon" : "fa-sun");
    dom.themeButton.title = "Toggle light/dark mode";
    dom.themeButton.setAttribute("aria-label", "Toggle light/dark mode");
  }
}

function getSpellcheckToggleButtons() {
  return [dom.spellcheckToggleMain, dom.spellcheckToggleModal].filter(Boolean);
}

function updateSpellcheckToggleButton() {
  const buttons = getSpellcheckToggleButtons();
  if (!buttons.length) {
    return;
  }
  const enabled = Boolean(state.spellcheckEnabled);
  const label = enabled
    ? "Disable spellcheck (titles and descriptions)"
    : "Enable spellcheck (titles and descriptions)";
  buttons.forEach((button) => {
    button.classList.toggle("active", enabled);
    button.setAttribute("aria-pressed", enabled ? "true" : "false");
    button.title = label;
    button.setAttribute("aria-label", label);
  });
}

function setScopedSpellcheckEnabled(enabled, { persist = true } = {}) {
  const next = Boolean(enabled);
  state.spellcheckEnabled = next;
  if (state.scopedSpellcheck !== true) {
    state.scopedSpellcheck = true;
  }
  if (editorController?.setSpellcheckEnabled) {
    editorController.setSpellcheckEnabled(next);
  }
  if (modalEditorController?.setSpellcheckEnabled) {
    modalEditorController.setSpellcheckEnabled(next);
  }
  updateSpellcheckToggleButton();
  if (persist) {
    try {
      localStorage.setItem(SPELLCHECK_STORAGE_KEY, next ? "1" : "0");
    } catch {
      // Ignore storage failures.
    }
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

const spellcheckToggleButtons = getSpellcheckToggleButtons();
if (spellcheckToggleButtons.length) {
  updateSpellcheckToggleButton();
  spellcheckToggleButtons.forEach((button) => {
    button.addEventListener("click", () => {
      setScopedSpellcheckEnabled(!state.spellcheckEnabled);
    });
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

if (dom.profileButton) {
  dom.profileButton.addEventListener("click", () => {
    openProfileModal();
  });
}

if (dom.jiraConfigButton) {
  dom.jiraConfigButton.addEventListener("click", () => {
    openJiraConfigModal();
  });
}

if (dom.usersButton) {
  dom.usersButton.addEventListener("click", () => {
    openUsersModal();
  });
}

if (dom.jiraConfigClose) {
  dom.jiraConfigClose.addEventListener("click", () => {
    closeJiraConfigModal({ reopenSpaces: true });
  });
}

if (dom.jiraConfigCancel) {
  dom.jiraConfigCancel.addEventListener("click", () => {
    closeJiraConfigModal({ reopenSpaces: true });
  });
}

if (dom.jiraConfigSave) {
  dom.jiraConfigSave.addEventListener("click", () => {
    submitJiraConfig();
  });
}

if (dom.usersClose) {
  dom.usersClose.addEventListener("click", () => {
    closeUsersModal({ reopenSpaces: true });
  });
}

if (dom.profileClose) {
  dom.profileClose.addEventListener("click", () => {
    closeProfileModal({ reopenSpaces: true });
  });
}

if (dom.profileSave) {
  dom.profileSave.addEventListener("click", () => {
    submitProfileUpdate();
  });
}

if (dom.profileLogoutCancel) {
  dom.profileLogoutCancel.addEventListener("click", () => {
    closeProfileLogoutModal();
  });
}

if (dom.profileLogoutConfirm) {
  dom.profileLogoutConfirm.addEventListener("click", () => {
    closeProfileLogoutModal();
    logout();
  });
}

if (dom.userCreate) {
  dom.userCreate.addEventListener("click", () => {
    submitCreateUser();
  });
}

if (dom.userOpenCreate) {
  dom.userOpenCreate.addEventListener("click", () => {
    openUserCreateModal();
  });
}

if (dom.userNewRole) {
  dom.userNewRole.addEventListener("change", () => {
    updateCreateUserSpacesVisibility();
  });
}

if (dom.userCreateClose) {
  dom.userCreateClose.addEventListener("click", () => {
    closeUserCreateModal();
  });
}

if (dom.userPasswordClose) {
  dom.userPasswordClose.addEventListener("click", () => {
    closeUserPasswordModal();
  });
}

if (dom.userPasswordCancel) {
  dom.userPasswordCancel.addEventListener("click", () => {
    closeUserPasswordModal();
  });
}

if (dom.userPasswordSave) {
  dom.userPasswordSave.addEventListener("click", () => {
    submitUserPasswordChange();
  });
}

if (dom.userDeleteCancel) {
  dom.userDeleteCancel.addEventListener("click", () => {
    closeUserDeleteModal();
  });
}

if (dom.userDeleteConfirm) {
  dom.userDeleteConfirm.addEventListener("click", () => {
    confirmDeleteUser();
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

if (dom.spacesLogout) {
  dom.spacesLogout.addEventListener("click", () => {
    openProfileLogoutModal();
  });
}

if (dom.taskEditCancel) {
  dom.taskEditCancel.addEventListener("click", () => {
    closeTaskEditModal();
  });
}

if (dom.taskEditSave) {
  dom.taskEditSave.addEventListener("click", () => {
    saveTaskEditModal();
  });
}

if (dom.graphAddTask) {
  dom.graphAddTask.addEventListener("click", () => {
    openTaskCreateModal();
  });
}

if (dom.boardTitle) {
  dom.boardTitle.addEventListener("dblclick", (event) => {
    event.preventDefault();
    openBoardRenameModal();
  });
}

if (dom.boardRenameClose) {
  dom.boardRenameClose.addEventListener("click", () => {
    closeBoardRenameModal();
  });
}

if (dom.boardRenameCancel) {
  dom.boardRenameCancel.addEventListener("click", () => {
    closeBoardRenameModal();
  });
}

if (dom.boardRenameSave) {
  dom.boardRenameSave.addEventListener("click", () => {
    submitBoardRename();
  });
}

if (dom.boardRenameInput) {
  dom.boardRenameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submitBoardRename();
    }
  });
}

if (dom.slugRenameClose) {
  dom.slugRenameClose.addEventListener("click", () => {
    closeSlugRenameModal();
  });
}

if (dom.slugRenameCancel) {
  dom.slugRenameCancel.addEventListener("click", () => {
    closeSlugRenameModal();
  });
}

if (dom.slugRenameSave) {
  dom.slugRenameSave.addEventListener("click", () => {
    submitSlugRename();
  });
}

if (dom.slugRenameNew) {
  dom.slugRenameNew.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submitSlugRename();
    }
  });
}

if (dom.taskEditTitleInput) {
  dom.taskEditTitleInput.addEventListener("input", () => {
    if (!modalEditorController) {
      return;
    }
    const parsedTitle = parseJiraTitle(dom.taskEditTitleInput.value || "");
    if (parsedTitle.key) {
      editingTaskJiraKey = parsedTitle.key;
    }
    updateTaskEditJiraPill(editingTaskJiraKey);
    updateTaskEditPreviewFromText(modalEditorController.getValue());
  });
}

if (dom.taskEditJiraPill) {
  dom.taskEditJiraPill.addEventListener("click", (event) => {
    event.stopPropagation();
    if (editingTaskJiraKey) {
      copyToClipboard(editingTaskJiraKey);
    }
  });
}

if (dom.taskDeleteCancel) {
  dom.taskDeleteCancel.addEventListener("click", () => {
    closeTaskDeleteModal();
  });
}

if (dom.taskDeleteConfirm) {
  dom.taskDeleteConfirm.addEventListener("click", () => {
    if (pendingDeleteTask) {
      deleteTaskKeepSubtasks(pendingDeleteTask);
    }
    closeTaskDeleteModal();
  });
}

if (dom.taskDeleteConfirmAll) {
  dom.taskDeleteConfirmAll.addEventListener("click", () => {
    if (pendingDeleteTask) {
      deleteTask(pendingDeleteTask);
    }
    closeTaskDeleteModal();
  });
}

if (dom.taskDeleteConfirm) {
  dom.taskDeleteConfirm.addEventListener("mouseenter", () => {
    if (pendingDeleteTask) {
      highlightTaskDeletePreview(pendingDeleteTask, false);
    }
  });
  dom.taskDeleteConfirm.addEventListener("mouseleave", () => {
    clearTaskDeletePreview();
  });
}

if (dom.taskDeleteConfirmAll) {
  dom.taskDeleteConfirmAll.addEventListener("mouseenter", () => {
    if (pendingDeleteTask) {
      highlightTaskDeletePreview(pendingDeleteTask, true);
    }
  });
  dom.taskDeleteConfirmAll.addEventListener("mouseleave", () => {
    clearTaskDeletePreview();
  });
}

if (dom.taskDeleteCancel) {
  dom.taskDeleteCancel.addEventListener("mouseenter", () => {
    clearTaskDeletePreview();
  });
}

if (dom.loginModal) {
  dom.loginModal.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      attemptLogin();
    }
  });
}

if (dom.taskEditModal) {
  dom.taskEditModal.addEventListener("click", () => {});
}

window.addEventListener("taskdragstart", () => {
  setTaskDragActive(true);
});

window.addEventListener("taskdragend", () => {
  setTaskDragActive(false);
});

if (dom.taskTrash) {
  dom.taskTrash.addEventListener("dragover", (event) => {
    event.preventDefault();
    dom.taskTrash.classList.add("drag-over");
    document.body.classList.add("task-trash-over");
  });
  dom.taskTrash.addEventListener("dragleave", () => {
    dom.taskTrash.classList.remove("drag-over");
    document.body.classList.remove("task-trash-over");
  });
  dom.taskTrash.addEventListener("drop", (event) => {
    event.preventDefault();
    event.stopPropagation();
    dom.taskTrash.classList.remove("drag-over");
    document.body.classList.remove("task-trash-over");
    setTaskDragActive(false);
    let taskId = "";
    const payload = event.dataTransfer?.getData("application/json");
    if (payload) {
      try {
        const data = JSON.parse(payload);
        if (data.type === "task" && data.taskId) {
          taskId = data.taskId;
        }
      } catch {
        // ignore
      }
    }
    if (!taskId) {
      taskId = event.dataTransfer?.getData("text/plain") || "";
    }
    const task = state.allTasks.find((item) => item.id === taskId);
    if (task) {
      openTaskDeleteModal(task);
    }
  });
}

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeSlugRenameModal();
    closeLoginModal();
    closeSpacesModal();
    closeSpaceCreateModal();
    closeSpaceFolderCreateModal();
    closeFolderDeleteModal();
    closeProfileModal({ reopenSpaces: false });
    closeJiraConfigModal({ reopenSpaces: false });
    closeUsersModal({ reopenSpaces: false });
    closeUserCreateModal();
    closeUserPasswordModal();
    closeUserDeleteModal();
    closeDeleteModal();
    closeTaskEditModal();
    closeTaskDeleteModal();
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
  flushOfflineDraft({ force: true });
});

if (dom.spaceOpenCreate) {
  dom.spaceOpenCreate.addEventListener("click", () => {
    openSpaceCreateModal();
  });
}

if (dom.spaceOpenFolderCreate) {
  dom.spaceOpenFolderCreate.addEventListener("click", () => {
    openSpaceFolderCreateModal();
  });
}

if (dom.spaceCreateClose) {
  dom.spaceCreateClose.addEventListener("click", () => {
    closeSpaceCreateModal();
  });
}

if (dom.spaceCreateCancel) {
  dom.spaceCreateCancel.addEventListener("click", () => {
    closeSpaceCreateModal();
  });
}

if (dom.spaceFolderCreateClose) {
  dom.spaceFolderCreateClose.addEventListener("click", () => {
    closeSpaceFolderCreateModal();
  });
}

if (dom.spaceFolderCreateCancel) {
  dom.spaceFolderCreateCancel.addEventListener("click", () => {
    closeSpaceFolderCreateModal();
  });
}

if (dom.spaceCreate && dom.spaceNew) {
  dom.spaceCreate.addEventListener("click", () => {
    submitCreateSpace();
  });
  dom.spaceNew.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submitCreateSpace();
    }
  });
  dom.spaceNew.addEventListener("input", () => {
    clearSpaceError();
    updateCreateSpaceButton();
  });
  updateCreateSpaceButton();
}

if (dom.spaceFolderCreate && dom.spaceFolderNew) {
  dom.spaceFolderCreate.addEventListener("click", () => {
    submitCreateFolder();
  });
  dom.spaceFolderNew.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submitCreateFolder();
    }
  });
  dom.spaceFolderNew.addEventListener("input", () => {
    clearSpaceError();
    updateCreateFolderButton();
  });
  updateCreateFolderButton();
}

if (dom.deleteCancel) {
  dom.deleteCancel.addEventListener("click", () => {
    closeDeleteModal();
  });
}

if (dom.folderDeleteCancel) {
  dom.folderDeleteCancel.addEventListener("click", () => {
    closeFolderDeleteModal();
  });
}

if (dom.folderDeleteConfirm) {
  dom.folderDeleteConfirm.addEventListener("click", () => {
    confirmDeleteFolder();
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
      await deleteSpace(target.id);
      clearSpaceError();
      showToast(`Space '${target.path || target.id}' deleted.`);
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
  renderStoryPointsSummary();
});

dom.searchInput.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") {
    return;
  }
  if (!dom.searchInput.value && !state.searchQuery) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  dom.searchInput.value = "";
  state.searchQuery = "";
  canvasController.renderGraph();
  buildKanban();
  updateClearFiltersVisibility();
  renderStoryPointsSummary();
});

[dom.kanbanGroup].filter(Boolean).forEach((group) => {
  group.addEventListener("click", (event) => {
    const target = event.target.closest("button[data-kanban-group]");
    if (!target) {
      return;
    }
    setKanbanGroupBy(target.dataset.kanbanGroup);
  });
});

[dom.searchName, dom.searchDescription, dom.searchTag, dom.searchPerson].forEach((checkbox) => {
  checkbox.addEventListener("change", () => {
    canvasController.renderGraph();
    buildKanban();
    updateClearFiltersVisibility();
    renderStoryPointsSummary();
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
  renderStoryPointsSummary();
});

let resizing = false;
let resizingKanban = false;
let pendingGraphRender = null;
let legendHiddenByRightSnap = false;
let legendHasVisibleContent = true;

function applyLegendHiddenState() {
  if (!dom.legend) {
    return;
  }
  const shouldHide = legendHiddenByRightSnap || !legendHasVisibleContent;
  dom.legend.hidden = shouldHide;
  document.documentElement.toggleAttribute("data-legend-hidden", shouldHide);
}

function setLegendHasVisibleContent(hasVisibleContent) {
  legendHasVisibleContent = Boolean(hasVisibleContent);
  applyLegendHiddenState();
}

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

function setLegendHiddenForRightSnap(leftPercent, maxPercent) {
  legendHiddenByRightSnap = Number.isFinite(leftPercent)
    && Number.isFinite(maxPercent)
    && leftPercent >= (maxPercent - 0.01);
  applyLegendHiddenState();
}

function setGraphHiddenForLeftSnap(leftPercent) {
  const graphHidden = Number.isFinite(leftPercent) && leftPercent <= 0.01;
  if (graphHidden) {
    document.documentElement.setAttribute("data-graph-hidden", "true");
  } else {
    document.documentElement.removeAttribute("data-graph-hidden");
  }
}

function setGraphTopHiddenForKanbanHeight(kanbanHeightPx, maxHeightPx) {
  const graphTopHidden =
    Number.isFinite(kanbanHeightPx)
    && Number.isFinite(maxHeightPx)
    && maxHeightPx >= 0
    && (maxHeightPx - kanbanHeightPx) <= 0.5;
  if (graphTopHidden) {
    document.documentElement.setAttribute("data-graph-top-hidden", "true");
  } else {
    document.documentElement.removeAttribute("data-graph-top-hidden");
  }
}

function updateGraphTopHiddenFromLayout() {
  const panelRect = (dom.graphPanel || dom.graphCanvas)?.getBoundingClientRect?.();
  if (!panelRect) {
    return;
  }
  const dividerHeight = dom.kanbanDivider?.offsetHeight || 0;
  const legendHeight = dom.legend?.getBoundingClientRect?.().height || 0;
  const maxHeight = Math.max(0, panelRect.height - legendHeight - dividerHeight);
  const rawKanbanHeight = getComputedStyle(document.documentElement)
    .getPropertyValue("--kanban-height")
    .trim();
  const kanbanHeight = Number.parseFloat(rawKanbanHeight);
  setGraphTopHiddenForKanbanHeight(
    Number.isFinite(kanbanHeight) ? kanbanHeight : 180,
    maxHeight
  );
}

function updateLegendHiddenFromLayout() {
  const rect = document.body.getBoundingClientRect();
  if (!rect.width) {
    return;
  }
  const dividerWidth = Math.max(1, dom.divider?.offsetWidth || 8);
  const maxPercent = Math.max(0, ((rect.width - dividerWidth) / rect.width) * 100);
  const rawLeftWidth = getComputedStyle(document.documentElement)
    .getPropertyValue("--left-width")
    .trim();
  const leftPercent = Number.parseFloat(rawLeftWidth);
  setGraphHiddenForLeftSnap(Number.isFinite(leftPercent) ? leftPercent : 45);
  updateGraphTopHiddenFromLayout();
  setLegendHiddenForRightSnap(
    Number.isFinite(leftPercent) ? leftPercent : 45,
    maxPercent
  );
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
      const legendHeight = dom.legend?.getBoundingClientRect().height || 0;
      const minHeight = 0;
      const maxHeight = Math.max(minHeight, panelRect.height - legendHeight - dividerHeight);
      const desired = panelRect.bottom - event.clientY;
      let clamped = Math.min(maxHeight, Math.max(minHeight, desired));
      const collapseThreshold = 48;
      const isCollapsed = clamped < collapseThreshold;
      if (isCollapsed) {
        clamped = 0;
        document.documentElement.setAttribute("data-kanban-collapsed", "true");
      } else {
        document.documentElement.removeAttribute("data-kanban-collapsed");
      }
      document.documentElement.style.setProperty("--kanban-height", `${clamped}px`);
      setGraphTopHiddenForKanbanHeight(clamped, maxHeight);
      scheduleGraphRender();
      return;
    }
    return;
  }
  const rect = document.body.getBoundingClientRect();
  const dividerWidth = Math.max(1, dom.divider?.offsetWidth || 8);
  const relativeX = event.clientX - rect.left;
  const percentage = (relativeX / rect.width) * 100;
  const maxPercent = Math.max(0, ((rect.width - dividerWidth) / rect.width) * 100);
  const edgeSnapPx = 36;
  const maxX = Math.max(0, rect.width - dividerWidth);
  let clamped = Math.min(maxPercent, Math.max(0, percentage));
  if (relativeX <= edgeSnapPx) {
    clamped = 0;
  } else if (relativeX >= maxX - edgeSnapPx) {
    clamped = maxPercent;
  }
  document.documentElement.style.setProperty("--left-width", `${clamped}%`);
  setGraphHiddenForLeftSnap(clamped);
  setLegendHiddenForRightSnap(clamped, maxPercent);
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

window.addEventListener("resize", () => {
  updateLegendHiddenFromLayout();
  scheduleGraphRender();
});

state.kanbanGroupBy = getStoredKanbanGroup();
updateKanbanGroupButtons();

initializeSecretToggles();
updateConnectButtonLabel();
updateLegendHiddenFromLayout();
restoreSessionFromCookie();
sync();
