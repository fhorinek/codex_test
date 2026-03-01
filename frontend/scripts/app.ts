/**
 * Module: Main frontend application orchestration, state management, and UI event wiring.
 */

import { parseTasks, parseJiraTitle, renderMarkdown } from "./task.js";
import { createEditor } from "./editor.js";
import { createCanvas } from "./canvas.js";
import {
  buildKanban as buildKanbanView,
  updateTaskState as updateTaskStateInEditor,
  updateTaskToken as updateTaskTokenInEditor,
} from "./kanban.js";
import { formatTaskScript } from "./formatter.js";
import { createAppDom } from "./appDom.js";
import {
  setGraphHiddenForLeftSnap,
  setGraphTopHiddenForKanbanHeight,
  updateGraphTopHiddenFromLayout,
} from "./layoutState.js";
import { createSlugRenameUi } from "./slugRenameUi.js";
import {
  createSlugRenameModalController,
} from "./slugRenameModal.js";
import {
  decorateDescriptionPills,
  decorateDescriptionReferences,
  renderTaskDescriptionNode,
  wireDescriptionCheckboxes,
} from "./taskDescription.js";
import {
  applyBoardNameToText,
  buildTaskCreateDraft,
  buildTaskEditDraft,
  createTaskCommandController,
  insertStateIntoBody,
  insertTokenIntoBody,
  normalizeBoardNameInput,
  parseTaskBody,
  removeStateFromBody,
  removeTokenFromBody,
  updateCheckboxInBody,
} from "./taskCommands.js";
import { createSyncEngine } from "./syncEngine.js";
import {
  initPerformanceMonitoring,
  measurePerformanceSync,
} from "./perfMonitor.js";

// Stores the REMOTE_BASE module constant.
const REMOTE_BASE = window.location.origin;
// Stores the WS_BASE module constant.
const WS_BASE = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`;
// Stores the AUTH_TOKEN module constant.
const AUTH_TOKEN = "";
// Stores the COLLAB_LIBS module constant.
const COLLAB_LIBS = {
  yjs: "yjs",
  ywebsocket: "y-websocket",
  ycodemirror: "y-codemirror.next",
};
// Stores the COLLAB_COLORS module constant.
const COLLAB_COLORS = [
  { r: 45, g: 80, b: 237 },
  { r: 232, g: 93, b: 73 },
  { r: 54, g: 170, b: 119 },
  { r: 176, g: 98, b: 216 },
  { r: 240, g: 173, b: 78 },
  { r: 66, g: 153, b: 225 },
  { r: 236, g: 112, b: 99 },
];
// Stores the IDLE_TIMEOUT_MS module constant.
const IDLE_TIMEOUT_MS = 60000;
// Stores the IDLE_CHECK_MS module constant.
const IDLE_CHECK_MS = 5000;
// Stores the OFFLINE_DRAFT_STORAGE_KEY module constant.
const OFFLINE_DRAFT_STORAGE_KEY = "taskScript.offlineDraft.v1";
// Stores the OFFLINE_DRAFT_SAVE_INTERVAL_MS module constant.
const OFFLINE_DRAFT_SAVE_INTERVAL_MS = 10000;
// Stores the SPELLCHECK_STORAGE_KEY module constant.
const SPELLCHECK_STORAGE_KEY = "taskScript.spellcheckEnabled.v1";
// Stores the LAST_SPACE_STORAGE_KEY module constant.
const LAST_SPACE_STORAGE_KEY = "taskScript.lastSpace.v1";
// Stores the MOBILE_PANE_STORAGE_KEY module constant.
const MOBILE_PANE_STORAGE_KEY = "taskScript.mobilePane.v1";
// Stores the TABLET_PANE_STORAGE_KEY module constant.
const TABLET_PANE_STORAGE_KEY = "taskScript.tabletPane.v1";
// Stores the TABLET_PANE_LAYOUT_STORAGE_KEY module constant.
const TABLET_PANE_LAYOUT_STORAGE_KEY = "taskScript.tabletPaneLayout.v1";
// Stores the RESPONSIVE_LAYOUT_STORAGE_KEY module constant.
const RESPONSIVE_LAYOUT_STORAGE_KEY = "taskScript.responsiveLayout.v1";
// Stores the VIEWPORT_TABLET_MIN_PX module constant.
const VIEWPORT_TABLET_MIN_PX = 768;
// Stores the VIEWPORT_DESKTOP_MIN_PX module constant.
const VIEWPORT_DESKTOP_MIN_PX = 1200;
// Stores the VIEWPORT_COMPACT_HEIGHT_PX module constant.
const VIEWPORT_COMPACT_HEIGHT_PX = 700;
// Stores the HISTORY_PANEL_ANIMATION_MS module constant.
const HISTORY_PANEL_ANIMATION_MS = 220;
// Stores the BOOT_LOADER_CONNECT_TIMEOUT_MS module constant.
const BOOT_LOADER_CONNECT_TIMEOUT_MS = 15000;
// Stores the BOOT_LOADER_POLL_INTERVAL_MS module constant.
const BOOT_LOADER_POLL_INTERVAL_MS = 120;
// Stores the DEFAULT_LEFT_WIDTH_PERCENT module constant.
const DEFAULT_LEFT_WIDTH_PERCENT = 45;
// Stores the DEFAULT_KANBAN_HEIGHT_PX module constant.
const DEFAULT_KANBAN_HEIGHT_PX = 180;
// Stores the DEFAULT_TABLET_HORIZONTAL_TOP_PERCENT module constant.
const DEFAULT_TABLET_HORIZONTAL_TOP_PERCENT = 50;
// Stores the STATUS_LABELS module constant.
const STATUS_LABELS: Record<string, string> = {
  connected: "live",
  connecting: "reconnecting",
  disconnected: "error/failed",
  syncing: "syncing",
  "auth-failed": "auth failed",
  "read-only": "read-only",
  offline: "offline",
  idle: "idle",
};
// Stores the FRONTEND_BUILD_PLACEHOLDER module constant.
const FRONTEND_BUILD_PLACEHOLDER = "__TASKSCRIPT_FRONTEND_BUILD_ID__";
// Stores the FRONTEND_BUILD_ID module constant.
const FRONTEND_BUILD_ID = (() => {
  const raw = String(window.__taskScriptFrontendBuildId || "").trim();
  if (!raw || raw === FRONTEND_BUILD_PLACEHOLDER) {
    return "";
  }
  return raw;
})();
// Stores the FRONTEND_BUILD_INFO_URL module constant.
const FRONTEND_BUILD_INFO_URL = `${REMOTE_BASE}/build-info.json`;

initPerformanceMonitoring();

/**
 * Handles the copyToClipboard function logic.
 * Input: text: any.
 * Output: Promise<void>.
 */
async function copyToClipboard(text: any): Promise<void> {
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

/**
 * Handles the createJiraTitlePill function logic.
 * Input: key: any.
 * Output: result produced by this function.
 */
function createJiraTitlePill(key: any) {
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

/**
 * Handles the ensureSecretVisibilityToggle function logic.
 * Input: input: any.
 * Output: void.
 */
function ensureSecretVisibilityToggle(input: any): void {
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

  /**
   * Handles the refresh function logic.
   * Input: none.
   * Output: result produced by this function.
   */
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

/**
 * Handles the updateTaskEditJiraPill function logic.
 * Input: key: any.
 * Output: void.
 */
function updateTaskEditJiraPill(key: any): void {
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

/**
 * Handles the safeLocalStorageGet function logic.
 * Input: key: string.
 * Output: string | null.
 */
function safeLocalStorageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Handles the safeLocalStorageSet function logic.
 * Input: key: string, value: string.
 * Output: void.
 */
function safeLocalStorageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore storage failures.
  }
}

/**
 * Handles the getStoredResponsiveLayoutProfile function logic.
 * Input: none.
 * Output: any.
 */
function getStoredResponsiveLayoutProfile(): any {
  const raw = safeLocalStorageGet(RESPONSIVE_LAYOUT_STORAGE_KEY);
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Handles the persistResponsiveLayoutProfile function logic.
 * Input: none.
 * Output: void.
 */
function persistResponsiveLayoutProfile(): void {
  safeLocalStorageSet(RESPONSIVE_LAYOUT_STORAGE_KEY, JSON.stringify(responsiveLayoutProfile));
}

/**
 * Handles the normalizeViewportOrientation function logic.
 * Input: value: any.
 * Output: "portrait" | "landscape".
 */
function normalizeViewportOrientation(value: any): "portrait" | "landscape" {
  return String(value || "").toLowerCase() === "portrait" ? "portrait" : "landscape";
}

/**
 * Handles the getViewportOrientationForSize function logic.
 * Input: width: number, height: number.
 * Output: "portrait" | "landscape".
 */
function getViewportOrientationForSize(width: number, height: number): "portrait" | "landscape" {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return "landscape";
  }
  return height > width ? "portrait" : "landscape";
}

/**
 * Handles the parseFiniteNumber function logic.
 * Input: value: any, fallback: number.
 * Output: number.
 */
function parseFiniteNumber(value: any, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value || ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Handles the clampNumber function logic.
 * Input: value: number, min: number, max: number.
 * Output: number.
 */
function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Handles the normalizeLeftWidthPercent function logic.
 * Input: value: any, fallback = DEFAULT_LEFT_WIDTH_PERCENT.
 * Output: number.
 */
function normalizeLeftWidthPercent(value: any, fallback = DEFAULT_LEFT_WIDTH_PERCENT): number {
  return clampNumber(parseFiniteNumber(value, fallback), 0, 100);
}

/**
 * Handles the normalizeKanbanHeightPx function logic.
 * Input: value: any, fallback = DEFAULT_KANBAN_HEIGHT_PX.
 * Output: number.
 */
function normalizeKanbanHeightPx(value: any, fallback = DEFAULT_KANBAN_HEIGHT_PX): number {
  return Math.max(0, parseFiniteNumber(value, fallback));
}

/**
 * Handles the normalizeTabletHorizontalTopPercent function logic.
 * Input: value: any, fallback = DEFAULT_TABLET_HORIZONTAL_TOP_PERCENT.
 * Output: number.
 */
function normalizeTabletHorizontalTopPercent(
  value: any,
  fallback = DEFAULT_TABLET_HORIZONTAL_TOP_PERCENT
): number {
  return clampNumber(parseFiniteNumber(value, fallback), 0, 100);
}

/**
 * Handles the readCssCustomNumber function logic.
 * Input: name: string, fallback: number.
 * Output: number.
 */
function readCssCustomNumber(name: string, fallback: number): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return parseFiniteNumber(raw, fallback);
}

/**
 * Handles the getResponsiveLayoutBucket function logic.
 * Input: viewport: any, orientation: any, { create = false }: { create?: boolean } = {}.
 * Output: any.
 */
function getResponsiveLayoutBucket(
  viewport: any,
  orientation: any,
  { create = false }: { create?: boolean } = {}
): any {
  const viewportKey = String(viewport || "");
  if (viewportKey !== "mobile" && viewportKey !== "tablet" && viewportKey !== "desktop") {
    return null;
  }
  const orientationKey = normalizeViewportOrientation(orientation);
  const profileRoot = responsiveLayoutProfile || {};
  let viewportProfile = profileRoot[viewportKey];
  if (!viewportProfile || typeof viewportProfile !== "object") {
    if (!create) {
      return null;
    }
    viewportProfile = {};
    profileRoot[viewportKey] = viewportProfile;
  }
  let bucket = viewportProfile[orientationKey];
  if (!bucket || typeof bucket !== "object") {
    if (!create) {
      return null;
    }
    bucket = {};
    viewportProfile[orientationKey] = bucket;
  }
  responsiveLayoutProfile = profileRoot;
  return bucket;
}

// Stores the responsiveLayoutProfile module constant.
let responsiveLayoutProfile: any = getStoredResponsiveLayoutProfile();

/**
 * Handles the getStoredLastSpaceRef function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function getStoredLastSpaceRef(): { id: string; path: string } | null {
  const raw = safeLocalStorageGet(LAST_SPACE_STORAGE_KEY);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    const id = typeof parsed?.id === "string" ? parsed.id.trim() : "";
    const path = typeof parsed?.path === "string" ? parsed.path.trim() : "";
    if (!id) {
      return null;
    }
    return { id, path: path || id };
  } catch {
    return null;
  }
}

/**
 * Handles the setStoredLastSpaceRef function logic.
 * Input: spaceId: any, spacePath: any = "".
 * Output: void.
 */
function setStoredLastSpaceRef(spaceId: any, spacePath: any = ""): void {
  const id = typeof spaceId === "string" ? spaceId.trim() : "";
  if (!id) {
    return;
  }
  const path = typeof spacePath === "string" && spacePath.trim() ? spacePath.trim() : id;
  safeLocalStorageSet(LAST_SPACE_STORAGE_KEY, JSON.stringify({ id, path }));
}

/**
 * Handles the resetInlineError function logic.
 * Input: element: HTMLElement | null | undefined.
 * Output: void.
 */
function resetInlineError(element: HTMLElement | null | undefined): void {
  if (!element) {
    return;
  }
  element.textContent = "";
  element.classList.add("hidden");
}

/**
 * Handles the setInlineToastError function logic.
 * Input: element: HTMLElement | null | undefined, message: any.
 * Output: void.
 */
function setInlineToastError(element: HTMLElement | null | undefined, message: any): void {
  const text = typeof message === "string" ? message.trim() : "";
  resetInlineError(element);
  if (text) {
    showToast(text, "error");
  }
}

/**
 * Handles the getCollabIdentity function logic.
 * Input: preferredName?: string.
 * Output: result produced by this function.
 */
function getCollabIdentity(preferredName?: string) {
  const cached = safeLocalStorageGet("collabIdentity");
  if (cached) {
    try {
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
          safeLocalStorageSet("collabIdentity", JSON.stringify(nextIdentity));
        }
        return nextIdentity;
      }
    } catch {
      // Ignore cached identity errors.
    }
  }
  const name = preferredName || `User ${Math.floor(100 + Math.random() * 900)}`;
  const color = COLLAB_COLORS[Math.floor(Math.random() * COLLAB_COLORS.length)];
  const identity = { name, color };
  safeLocalStorageSet("collabIdentity", JSON.stringify(identity));
  return identity;
}

// Stores the dom module constant.
/** @type {import("./appDom.js").AppDom} */
const dom = createAppDom(document);
// Stores the slugRenameUi module constant.
const slugRenameUi = createSlugRenameUi(dom, document);

/**
 * Handles the initializeSecretToggles function logic.
 * Input: none.
 * Output: result produced by this function.
 */
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

/**
 * Handles the setButtonIcon function logic.
 * Input: button: any, icon: any.
 * Output: void.
 */
function setButtonIcon(button: any, icon: any): void {
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

/**
 * Handles the getStoredSpellcheckEnabled function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function getStoredSpellcheckEnabled() {
  return safeLocalStorageGet(SPELLCHECK_STORAGE_KEY) === "1";
}

// Stores the state module constant.
const state: any = {
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
  viewportMode: "desktop",
  viewportHeightMode: "regular",
  viewportOrientation: "",
  mobileActivePane: "code",
  tabletRightPane: "graph",
  tabletPaneLayout: "vertical",
  pendingResponsiveGraphRender: false,
  pendingResponsiveKanbanBuild: false,
};

// Stores the KANBAN_GROUPS module constant.
const KANBAN_GROUPS = new Set(["none", "person", "tag"]);

/**
 * Handles the normalizeKanbanGroup function logic.
 * Input: value: any.
 * Output: string.
 */
function normalizeKanbanGroup(value: any): string {
  if (typeof value !== "string") {
    return "none";
  }
  const trimmed = value.trim().toLowerCase();
  return KANBAN_GROUPS.has(trimmed) ? trimmed : "none";
}

/**
 * Handles the getStoredKanbanGroup function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function getStoredKanbanGroup() {
  return normalizeKanbanGroup(safeLocalStorageGet("kanbanGroupBy"));
}

/**
 * Handles the getStoredMobilePane function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function getStoredMobilePane() {
  return normalizeMobilePane(safeLocalStorageGet(MOBILE_PANE_STORAGE_KEY));
}

/**
 * Handles the getStoredTabletRightPane function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function getStoredTabletRightPane() {
  return normalizeTabletRightPane(safeLocalStorageGet(TABLET_PANE_STORAGE_KEY));
}

/**
 * Handles the normalizeTabletPaneLayout function logic.
 * Input: value: any.
 * Output: "code" | "hide" | "vertical" | "horizontal".
 */
function normalizeTabletPaneLayout(value: any): "code" | "hide" | "vertical" | "horizontal" {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "code") {
    return "code";
  }
  if (normalized === "hide") {
    return "hide";
  }
  if (normalized === "horizontal") {
    return "horizontal";
  }
  return "vertical";
}

/**
 * Handles the getStoredTabletPaneLayout function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function getStoredTabletPaneLayout() {
  return normalizeTabletPaneLayout(safeLocalStorageGet(TABLET_PANE_LAYOUT_STORAGE_KEY));
}

/**
 * Handles the rememberResponsivePaneSelectionForCurrentViewport function logic.
 * Input: none.
 * Output: void.
 */
function rememberResponsivePaneSelectionForCurrentViewport(): void {
  const bucket = getResponsiveLayoutBucket(state.viewportMode, state.viewportOrientation, { create: true });
  if (!bucket) {
    return;
  }
  if (state.viewportMode === "mobile") {
    bucket.mobilePane = normalizeMobilePane(state.mobileActivePane);
  } else if (state.viewportMode === "tablet") {
    bucket.tabletRightPane = normalizeTabletRightPane(state.tabletRightPane);
    bucket.tabletPaneLayout = normalizeTabletPaneLayout(state.tabletPaneLayout);
  }
  persistResponsiveLayoutProfile();
}

/**
 * Handles the rememberLayoutGeometryForCurrentViewport function logic.
 * Input: none.
 * Output: void.
 */
function rememberLayoutGeometryForCurrentViewport(): void {
  const bucket = getResponsiveLayoutBucket(state.viewportMode, state.viewportOrientation, { create: true });
  if (!bucket) {
    return;
  }
  if (state.viewportMode === "desktop") {
    bucket.leftWidth = normalizeLeftWidthPercent(
      readCssCustomNumber("--left-width", DEFAULT_LEFT_WIDTH_PERCENT)
    );
    bucket.kanbanHeight = normalizeKanbanHeightPx(
      readCssCustomNumber("--kanban-height", DEFAULT_KANBAN_HEIGHT_PX)
    );
    persistResponsiveLayoutProfile();
    return;
  }
  if (state.viewportMode === "tablet") {
    bucket.tabletRightPane = normalizeTabletRightPane(state.tabletRightPane);
    bucket.tabletPaneLayout = normalizeTabletPaneLayout(state.tabletPaneLayout);
    if (state.tabletPaneLayout === "horizontal") {
      bucket.tabletHorizontalTopHeight = normalizeTabletHorizontalTopPercent(
        readCssCustomNumber("--tablet-horizontal-top-height", DEFAULT_TABLET_HORIZONTAL_TOP_PERCENT)
      );
    } else if (state.tabletPaneLayout === "vertical") {
      bucket.leftWidth = normalizeLeftWidthPercent(
        readCssCustomNumber("--left-width", DEFAULT_LEFT_WIDTH_PERCENT)
      );
    }
    persistResponsiveLayoutProfile();
    return;
  }
  if (state.viewportMode === "mobile") {
    bucket.mobilePane = normalizeMobilePane(state.mobileActivePane);
    persistResponsiveLayoutProfile();
  }
}

/**
 * Handles the applyStoredLayoutForCurrentViewport function logic.
 * Input: none.
 * Output: void.
 */
function applyStoredLayoutForCurrentViewport(): void {
  const bucket = getResponsiveLayoutBucket(state.viewportMode, state.viewportOrientation);
  const currentLeftWidth = normalizeLeftWidthPercent(
    readCssCustomNumber("--left-width", DEFAULT_LEFT_WIDTH_PERCENT)
  );
  const currentKanbanHeight = normalizeKanbanHeightPx(
    readCssCustomNumber("--kanban-height", DEFAULT_KANBAN_HEIGHT_PX)
  );
  const currentTabletTop = normalizeTabletHorizontalTopPercent(
    readCssCustomNumber("--tablet-horizontal-top-height", DEFAULT_TABLET_HORIZONTAL_TOP_PERCENT)
  );

  if (state.viewportMode === "mobile") {
    state.mobileActivePane = normalizeMobilePane(bucket?.mobilePane ?? state.mobileActivePane);
    return;
  }

  if (state.viewportMode === "tablet") {
    state.tabletRightPane = normalizeTabletRightPane(bucket?.tabletRightPane ?? state.tabletRightPane);
    state.tabletPaneLayout = normalizeTabletPaneLayout(bucket?.tabletPaneLayout ?? state.tabletPaneLayout);
    const leftWidth = normalizeLeftWidthPercent(bucket?.leftWidth, currentLeftWidth);
    document.documentElement.style.setProperty("--left-width", `${leftWidth}%`);
    const tabletTop = normalizeTabletHorizontalTopPercent(
      bucket?.tabletHorizontalTopHeight,
      currentTabletTop
    );
    const topValue = `${tabletTop}%`;
    document.documentElement.style.setProperty("--tablet-horizontal-top-height", topValue);
    const appRoot = document.querySelector(".app") as HTMLElement | null;
    if (appRoot) {
      appRoot.style.setProperty("--tablet-horizontal-top-height", topValue);
    }
    return;
  }

  const leftWidth = normalizeLeftWidthPercent(bucket?.leftWidth, currentLeftWidth);
  const kanbanHeight = normalizeKanbanHeightPx(bucket?.kanbanHeight, currentKanbanHeight);
  document.documentElement.style.setProperty("--left-width", `${leftWidth}%`);
  document.documentElement.style.setProperty("--kanban-height", `${kanbanHeight}px`);
}

/**
 * Handles the updateKanbanGroupButtons function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function updateKanbanGroupButtons() {
  if (!dom.kanbanGroup) {
    return;
  }
  const buttons = dom.kanbanGroup.querySelectorAll("button[data-kanban-group]");
  buttons.forEach((button: any) => {
    const groupButton = /** @type {HTMLButtonElement} */ (button);
    const isActive = groupButton.dataset.kanbanGroup === state.kanbanGroupBy;
    groupButton.classList.toggle("active", isActive);
    groupButton.setAttribute("aria-checked", isActive ? "true" : "false");
  });
}

/**
 * Handles the setKanbanGroupBy function logic.
 * Input: value: any, { persist = true }: { persist?: boolean } = {}.
 * Output: result produced by this function.
 */
function setKanbanGroupBy(value: any, { persist = true }: { persist?: boolean } = {}) {
  const nextValue = normalizeKanbanGroup(value);
  if (nextValue === state.kanbanGroupBy) {
    return;
  }
  state.kanbanGroupBy = nextValue;
  updateKanbanGroupButtons();
  if (persist) {
    safeLocalStorageSet("kanbanGroupBy", nextValue);
  }
  buildKanban();
}

/**
 * Handles the applyResponsivePaneDatasets function logic.
 * Input: none.
 * Output: void.
 */
function applyResponsivePaneDatasets(): void {
  const root = document.documentElement;
  root.dataset["mobilePane"] = normalizeMobilePane(state.mobileActivePane);
  root.dataset["tabletRightPane"] = normalizeTabletRightPane(state.tabletRightPane);
  root.dataset["tabletPaneLayout"] = normalizeTabletPaneLayout(state.tabletPaneLayout);
}

/**
 * Handles the setMobileToolbarMenuOpen function logic.
 * Input: open: boolean.
 * Output: void.
 */
function setMobileToolbarMenuOpen(open: boolean): void {
  const next = Boolean(open) && (state.viewportMode === "mobile" || state.viewportMode === "tablet");
  document.documentElement.toggleAttribute("data-mobile-toolbar-open", next);
  if (dom.mobileToolbarToggle) {
    dom.mobileToolbarToggle.setAttribute("aria-expanded", next ? "true" : "false");
    dom.mobileToolbarToggle.setAttribute("aria-label", next ? "Close toolbar menu" : "Open toolbar menu");
    dom.mobileToolbarToggle.title = next ? "Close menu" : "Open menu";
  }
}

/**
 * Handles the closeMobileToolbarMenu function logic.
 * Input: none.
 * Output: void.
 */
function closeMobileToolbarMenu(): void {
  setMobileToolbarMenuOpen(false);
}

/**
 * Handles the toggleMobileToolbarMenu function logic.
 * Input: none.
 * Output: void.
 */
function toggleMobileToolbarMenu(): void {
  const isOpen = document.documentElement.hasAttribute("data-mobile-toolbar-open");
  setMobileToolbarMenuOpen(!isOpen);
}

/**
 * Handles the isCompactToolbarMenuViewport function logic.
 * Input: none.
 * Output: boolean.
 */
function isCompactToolbarMenuViewport(): boolean {
  return state.viewportMode === "mobile" || state.viewportMode === "tablet";
}

/**
 * Handles the updateResponsiveSearchPlacement function logic.
 * Input: none.
 * Output: void.
 */
function updateResponsiveSearchPlacement(): void {
  const searchRoot = dom.searchInput?.closest?.(".graph-search");
  if (!(searchRoot instanceof HTMLElement) || !dom.topbarActions) {
    return;
  }
  const topbarCenter = dom.taskTrash?.parentElement;
  if (!(topbarCenter instanceof HTMLElement)) {
    return;
  }
  if (state.viewportMode === "mobile") {
    if (!dom.topbarActions.contains(searchRoot)) {
      dom.topbarActions.prepend(searchRoot);
    }
    return;
  }
  if (topbarCenter.contains(searchRoot)) {
    return;
  }
  if (dom.taskTrash && dom.taskTrash.parentElement === topbarCenter) {
    topbarCenter.insertBefore(searchRoot, dom.taskTrash);
    return;
  }
  topbarCenter.prepend(searchRoot);
}

/**
 * Handles the updateResponsivePaneButtons function logic.
 * Input: none.
 * Output: void.
 */
function updateResponsivePaneButtons(): void {
  if (dom.mobilePaneTabs) {
    dom.mobilePaneTabs.querySelectorAll("button[data-mobile-pane]").forEach((button: any) => {
      const pane = String((button as HTMLButtonElement).dataset["mobilePane"] || "code");
      const active = pane === state.mobileActivePane;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
  }
  if (dom.tabletPaneToggle) {
    dom.tabletPaneToggle.querySelectorAll("button[data-tablet-pane]").forEach((button: any) => {
      const pane = String((button as HTMLButtonElement).dataset["tabletPane"] || "graph");
      const active = pane === state.tabletRightPane;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
  }
  if (dom.tabletLayoutToggle) {
    dom.tabletLayoutToggle.querySelectorAll("button[data-tablet-layout]").forEach((button: any) => {
      const layout = String((button as HTMLButtonElement).dataset["tabletLayout"] || "vertical");
      const active = layout === state.tabletPaneLayout;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
  }
}

/**
 * Handles the isResponsiveGraphVisible function logic.
 * Input: none.
 * Output: boolean.
 */
function isResponsiveGraphVisible(): boolean {
  if (state.viewportMode === "mobile") {
    return state.mobileActivePane === "graph";
  }
  if (state.viewportMode === "tablet") {
    if (state.tabletPaneLayout === "code") {
      return false;
    }
    return state.tabletRightPane === "graph";
  }
  return true;
}

/**
 * Handles the isResponsiveKanbanVisible function logic.
 * Input: none.
 * Output: boolean.
 */
function isResponsiveKanbanVisible(): boolean {
  if (state.viewportMode === "mobile") {
    return state.mobileActivePane === "kanban";
  }
  if (state.viewportMode === "tablet") {
    if (state.tabletPaneLayout === "code") {
      return false;
    }
    return state.tabletRightPane === "kanban";
  }
  return true;
}

/**
 * Handles the flushResponsiveDeferredRenders function logic.
 * Input: none.
 * Output: void.
 */
function flushResponsiveDeferredRenders(): void {
  if (state.pendingResponsiveGraphRender && isResponsiveGraphVisible()) {
    state.pendingResponsiveGraphRender = false;
    canvasController.renderGraph();
  }
  if (state.pendingResponsiveKanbanBuild && isResponsiveKanbanVisible()) {
    state.pendingResponsiveKanbanBuild = false;
    buildKanban();
  }
}

/**
 * Handles the setMobileActivePane function logic.
 * Input: value: any, { persist = true }: { persist?: boolean } = {}.
 * Output: void.
 */
function setMobileActivePane(value: any, { persist = true }: { persist?: boolean } = {}): void {
  const next = normalizeMobilePane(value);
  if (next === state.mobileActivePane) {
    return;
  }
  state.mobileActivePane = next;
  applyResponsivePaneDatasets();
  updateResponsivePaneButtons();
  if (persist) {
    safeLocalStorageSet(MOBILE_PANE_STORAGE_KEY, next);
    rememberResponsivePaneSelectionForCurrentViewport();
  }
  if (historyMode.panelOpen) {
    renderHistoryPanel();
  }
  flushResponsiveDeferredRenders();
}

/**
 * Handles the setTabletRightPane function logic.
 * Input: value: any, { persist = true }: { persist?: boolean } = {}.
 * Output: void.
 */
function setTabletRightPane(value: any, { persist = true }: { persist?: boolean } = {}): void {
  const next = normalizeTabletRightPane(value);
  if (next === state.tabletRightPane) {
    return;
  }
  state.tabletRightPane = next;
  applyResponsivePaneDatasets();
  updateResponsivePaneButtons();
  if (persist) {
    safeLocalStorageSet(TABLET_PANE_STORAGE_KEY, next);
    rememberResponsivePaneSelectionForCurrentViewport();
  }
  flushResponsiveDeferredRenders();
}

/**
 * Handles the setTabletPaneLayout function logic.
 * Input: value: any, { persist = true }: { persist?: boolean } = {}.
 * Output: void.
 */
function setTabletPaneLayout(value: any, { persist = true }: { persist?: boolean } = {}): void {
  const next = normalizeTabletPaneLayout(value);
  if (next === state.tabletPaneLayout) {
    return;
  }
  state.tabletPaneLayout = next;
  applyResponsivePaneDatasets();
  updateResponsivePaneButtons();
  if (persist) {
    safeLocalStorageSet(TABLET_PANE_LAYOUT_STORAGE_KEY, next);
    rememberResponsivePaneSelectionForCurrentViewport();
  }
  updateResponsiveLayoutOffsets();
  updateLegendHiddenFromLayout();
  flushResponsiveDeferredRenders();
}

// Stores the collab module constant.
const collab: any = {
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

// Stores the historyMode module constant.
const historyMode: any = {
  panelOpen: false,
  panelOpening: false,
  panelClosing: false,
  viewerActive: false,
  loading: false,
  spaceId: null,
  spacePath: "",
  originalText: "",
  wasConnected: false,
  checkpoints: [],
  selectedIndex: -1,
  cache: new Map(),
  disabledButtons: new Map(),
};

state.mobileActivePane = getStoredMobilePane();
state.tabletRightPane = getStoredTabletRightPane();
state.tabletPaneLayout = getStoredTabletPaneLayout();

// Stores the pendingDeleteSpace module constant.
let pendingDeleteSpace: any = null;
// Stores the pendingDeleteFolder module constant.
let pendingDeleteFolder: any = null;
// Stores the pendingDeleteUser module constant.
let pendingDeleteUser: any = null;
// Stores the pendingPasswordUser module constant.
let pendingPasswordUser: any = null;
// Stores the pendingBoardRename module constant.
let pendingBoardRename = false;
// Stores the createUserSpacesPicker module constant.
let createUserSpacesPicker: any = null;
// Stores the toastContainer module constant.
let toastContainer: any = null;
// Stores the lastToast module constant.
let lastToast = { message: "", kind: "", at: 0 };
// Stores the connectedAtLeastOnce module constant.
let connectedAtLeastOnce = false;
// Stores the checkFrontendVersionOnNextConnected module constant.
let checkFrontendVersionOnNextConnected = false;
// Stores the frontendVersionCheckInFlight module constant.
let frontendVersionCheckInFlight = false;
// Stores the staleFrontendToastShown module constant.
let staleFrontendToastShown = false;

/**
 * Handles the normalizeMobilePane function logic.
 * Input: value: any.
 * Output: "code" | "graph" | "kanban".
 */
function normalizeMobilePane(value: any): "code" | "graph" | "kanban" {
  switch (String(value || "").toLowerCase()) {
    case "graph":
      return "graph";
    case "kanban":
      return "kanban";
    default:
      return "code";
  }
}

/**
 * Handles the normalizeTabletRightPane function logic.
 * Input: value: any.
 * Output: "graph" | "kanban".
 */
function normalizeTabletRightPane(value: any): "graph" | "kanban" {
  return String(value || "").toLowerCase() === "kanban" ? "kanban" : "graph";
}

/**
 * Handles the getViewportModeForWidth function logic.
 * Input: width: number.
 * Output: "desktop" | "tablet" | "mobile".
 */
function getViewportModeForWidth(width: number): "desktop" | "tablet" | "mobile" {
  if (!Number.isFinite(width) || width < VIEWPORT_TABLET_MIN_PX) {
    return "mobile";
  }
  if (width < VIEWPORT_DESKTOP_MIN_PX) {
    return "tablet";
  }
  return "desktop";
}

/**
 * Handles the getViewportHeightModeForHeight function logic.
 * Input: height: number.
 * Output: "compact" | "regular".
 */
function getViewportHeightModeForHeight(height: number): "compact" | "regular" {
  if (!Number.isFinite(height) || height < VIEWPORT_COMPACT_HEIGHT_PX) {
    return "compact";
  }
  return "regular";
}

/**
 * Handles the applyViewportDatasets function logic.
 * Input: none.
 * Output: void.
 */
function applyViewportDatasets(): void {
  const root = document.documentElement;
  root.dataset["viewport"] = state.viewportMode || "desktop";
  root.dataset["viewportHeight"] = state.viewportHeightMode || "regular";
  root.dataset["viewportOrientation"] = normalizeViewportOrientation(state.viewportOrientation);
}

/**
 * Handles the updateResponsiveLayoutOffsets function logic.
 * Input: none.
 * Output: void.
 */
function updateResponsiveLayoutOffsets(): void {
  const root = document.documentElement;
  const appRoot = document.querySelector(".app") as HTMLElement | null;
  const topbar = document.querySelector(".app-topbar") as HTMLElement | null;
  const paneBar = dom.responsivePaneBar;
  const topbarHeight = Math.max(60, Math.ceil(topbar?.getBoundingClientRect().height || 60));
  let paneBarHeight = 0;
  if (paneBar) {
    const paneBarVisible = getComputedStyle(paneBar).display !== "none";
    if (paneBarVisible) {
      paneBarHeight = Math.ceil(paneBar.getBoundingClientRect().height || 0);
    }
  }
  let tabletLegendHeight = 0;
  if (state.viewportMode === "tablet" && dom.legend && !dom.legend.hidden) {
    const legendVisible = getComputedStyle(dom.legend).display !== "none";
    if (legendVisible) {
      tabletLegendHeight = Math.ceil(dom.legend.getBoundingClientRect().height || 0);
    }
  }
  root.style.setProperty("--app-topbar-height", `${topbarHeight}px`);
  root.style.setProperty("--responsive-pane-bar-height", `${paneBarHeight}px`);
  root.style.setProperty("--tablet-legend-height", `${tabletLegendHeight}px`);
  if (appRoot) {
    appRoot.style.setProperty("--app-topbar-height", `${topbarHeight}px`);
    appRoot.style.setProperty("--responsive-pane-bar-height", `${paneBarHeight}px`);
    appRoot.style.setProperty("--tablet-legend-height", `${tabletLegendHeight}px`);
  }
}

/**
 * Handles the updateViewportMode function logic.
 * Input: none.
 * Output: void.
 */
function updateViewportMode(): void {
  const width = window.innerWidth || document.documentElement.clientWidth || 0;
  const height = window.innerHeight || document.documentElement.clientHeight || 0;
  const nextViewport = getViewportModeForWidth(width);
  const nextHeightMode = getViewportHeightModeForHeight(height);
  const nextOrientation = getViewportOrientationForSize(width, height);
  const viewportChanged = nextViewport !== state.viewportMode;
  const orientationChanged = nextOrientation !== state.viewportOrientation;
  state.viewportMode = nextViewport;
  state.viewportHeightMode = nextHeightMode;
  state.viewportOrientation = nextOrientation;
  state.mobileActivePane = normalizeMobilePane(state.mobileActivePane);
  state.tabletRightPane = normalizeTabletRightPane(state.tabletRightPane);
  state.tabletPaneLayout = normalizeTabletPaneLayout(state.tabletPaneLayout);
  if (viewportChanged || orientationChanged) {
    applyStoredLayoutForCurrentViewport();
    rememberResponsivePaneSelectionForCurrentViewport();
    rememberLayoutGeometryForCurrentViewport();
  }
  applyViewportDatasets();
  applyResponsivePaneDatasets();
  updateResponsiveSearchPlacement();
  updateResponsivePaneButtons();
  updateResponsiveLayoutOffsets();
  if (!isCompactToolbarMenuViewport()) {
    closeMobileToolbarMenu();
  }
  flushResponsiveDeferredRenders();
}

/**
 * Handles the ensureToastContainer function logic.
 * Input: none.
 * Output: result produced by this function.
 */
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

/**
 * Handles the showToast function logic.
 * Input: message: any, kind: any = "success", durationMs = 3200.
 * Output: void.
 */
function showToast(message: any, kind: any = "success", durationMs = 3200): void {
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
  /**
   * Handles the closeToast function logic.
   * Input: none.
   * Output: result produced by this function.
   */
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

/**
 * Handles the showToastWithAction function logic.
 * Input: { message, kind = "error", actionLabel, onAction, durationMs = 0, }: any.
 * Output: void.
 */
function showToastWithAction({
  message,
  kind = "error",
  actionLabel,
  onAction,
  durationMs = 0,
}: any): void {
  const text = typeof message === "string" ? message.trim() : "";
  const label = typeof actionLabel === "string" ? actionLabel.trim() : "";
  if (!text || !label || typeof onAction !== "function") {
    return;
  }
  const normalizedKind = kind === "error" ? "error" : "success";
  const container = ensureToastContainer();
  const toast = document.createElement("div");
  toast.className = `toast-item ${normalizedKind}`;
  const textNode = document.createElement("div");
  textNode.className = "toast-message";
  textNode.textContent = text;
  const actions = document.createElement("div");
  actions.className = "toast-actions";
  const actionButton = document.createElement("button");
  actionButton.type = "button";
  actionButton.className = "toast-action-button";
  actionButton.textContent = label;
  actions.appendChild(actionButton);
  toast.appendChild(textNode);
  toast.appendChild(actions);
  container.appendChild(toast);
  requestAnimationFrame(() => {
    toast.classList.add("show");
  });

  /**
   * Handles the closeToast function logic.
   * Input: none.
   * Output: void.
   */
  const closeToast = () => {
    if (!toast.parentElement) {
      return;
    }
    toast.classList.remove("show");
    setTimeout(() => {
      toast.remove();
    }, 180);
  };

  actionButton.addEventListener("click", () => {
    closeToast();
    onAction();
  });

  if (Number.isFinite(durationMs) && durationMs > 0) {
    setTimeout(closeToast, Math.max(1200, durationMs));
  }
}

/**
 * Handles the fetchCurrentFrontendBuildId function logic.
 * Input: none.
 * Output: Promise<string>.
 */
async function fetchCurrentFrontendBuildId(): Promise<string> {
  try {
    const response = await fetch(`${FRONTEND_BUILD_INFO_URL}?t=${Date.now()}`, {
      cache: "no-store",
    });
    if (!response.ok) {
      return "";
    }
    const payload = await response.json();
    const value = typeof payload?.buildId === "string" ? payload.buildId.trim() : "";
    if (!value || value === FRONTEND_BUILD_PLACEHOLDER) {
      return "";
    }
    return value;
  } catch {
    return "";
  }
}

/**
 * Handles the checkFrontendVersionAfterReconnect function logic.
 * Input: none.
 * Output: Promise<void>.
 */
async function checkFrontendVersionAfterReconnect(): Promise<void> {
  if (frontendVersionCheckInFlight || staleFrontendToastShown || !FRONTEND_BUILD_ID) {
    return;
  }
  frontendVersionCheckInFlight = true;
  try {
    const serverBuildId = await fetchCurrentFrontendBuildId();
    if (!serverBuildId || serverBuildId === FRONTEND_BUILD_ID) {
      return;
    }
    staleFrontendToastShown = true;
    showToastWithAction({
      message: "You are running an older frontend version. Refresh to update.",
      kind: "error",
      actionLabel: "Refresh",
      onAction: () => window.location.reload(),
      durationMs: 0,
    });
  } finally {
    frontendVersionCheckInFlight = false;
  }
}

/**
 * Handles the updateBootLoaderStatus function logic.
 * Input: message: any.
 * Output: void.
 */
function updateBootLoaderStatus(message: any): void {
  if (!dom.appBootLoaderStatus) {
    return;
  }
  const text = typeof message === "string" ? message.trim() : "";
  dom.appBootLoaderStatus.textContent = text || "Preparing workspace...";
}

/**
 * Handles the setBootLoaderVisible function logic.
 * Input: visible: boolean, statusText = "".
 * Output: void.
 */
function setBootLoaderVisible(visible: boolean, statusText = ""): void {
  if (!dom.appBootLoader) {
    return;
  }
  if (statusText) {
    updateBootLoaderStatus(statusText);
  }
  dom.appBootLoader.classList.toggle("hidden", !visible);
}

/**
 * Handles the isBootLoaderVisible function logic.
 * Input: none.
 * Output: boolean.
 */
function isBootLoaderVisible(): boolean {
  return Boolean(dom.appBootLoader && !dom.appBootLoader.classList.contains("hidden"));
}

/**
 * Handles the updateBootLoaderStatusFromConnection function logic.
 * Input: status: string.
 * Output: void.
 */
function updateBootLoaderStatusFromConnection(status: string): void {
  if (!isBootLoaderVisible()) {
    return;
  }
  const normalized = String(status || "").toLowerCase();
  if (normalized === "connected" || normalized === "idle") {
    updateBootLoaderStatus("Loading task data...");
    return;
  }
  if (normalized === "syncing") {
    updateBootLoaderStatus("Syncing board data...");
    return;
  }
  if (normalized === "connecting") {
    updateBootLoaderStatus("Connecting to board...");
    return;
  }
  if (normalized === "offline") {
    updateBootLoaderStatus("Offline mode enabled.");
    return;
  }
  if (normalized === "auth-failed") {
    updateBootLoaderStatus("Authentication failed.");
    return;
  }
  if (normalized === "read-only") {
    updateBootLoaderStatus("Connected in read-only mode.");
    return;
  }
  if (normalized === "disconnected") {
    updateBootLoaderStatus("Unable to connect. Retrying...");
    return;
  }
  updateBootLoaderStatus("Preparing workspace...");
}

/**
 * Handles the waitForInitialConnectionReady function logic.
 * Input: timeoutMs = BOOT_LOADER_CONNECT_TIMEOUT_MS.
 * Output: Promise<void>.
 */
async function waitForInitialConnectionReady(timeoutMs = BOOT_LOADER_CONNECT_TIMEOUT_MS): Promise<void> {
  if (!collab.spaceId) {
    return;
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!collab.spaceId || collab.synced) {
      return;
    }
    if (["offline", "auth-failed", "read-only"].includes(collab.connectionStatus)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, BOOT_LOADER_POLL_INTERVAL_MS));
  }
}

/**
 * Handles the normalizePermissions function logic.
 * Input: value: any.
 * Output: result produced by this function.
 */
function normalizePermissions(value: any) {
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

/**
 * Handles the normalizeOptionalDisplayName function logic.
 * Input: displayName: any, username: any.
 * Output: result produced by this function.
 */
function normalizeOptionalDisplayName(displayName: any, username: any) {
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

/**
 * Handles the applySessionFromServer function logic.
 * Input: data: any.
 * Output: void.
 */
function applySessionFromServer(data: any): void {
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

/**
 * Handles the updateRoleVisibility function logic.
 * Input: none.
 * Output: result produced by this function.
 */
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

/**
 * Handles the getStoredAuth function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function getStoredAuth() {
  const cached = safeLocalStorageGet("collabAuth");
  if (!cached) {
    return null;
  }
  try {
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

/**
 * Handles the persistAuth function logic.
 * Input: auth: any.
 * Output: void.
 */
function persistAuth(auth: any): void {
  safeLocalStorageSet("collabAuth", JSON.stringify(auth));
}

/**
 * Handles the readAuthInputs function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function readAuthInputs() {
  const username = dom.loginUsername?.value?.trim() || "";
  const authToken = dom.loginPassword?.value || AUTH_TOKEN;
  return { username, authToken };
}

/**
 * Handles the applyAuthFromInputs function logic.
 * Input: { store = true, markDirty = true } = {}.
 * Output: result produced by this function.
 */
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

/**
 * Handles the initializeAuthInputs function logic.
 * Input: none.
 * Output: result produced by this function.
 */
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

/**
 * Handles the getServerLabel function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function getServerLabel() {
  try {
    return new URL(REMOTE_BASE).hostname;
  } catch {
    return REMOTE_BASE.replace(/^https?:\/\//, "").split(":")[0];
  }
}

/**
 * Handles the setConnectionStatus function logic.
 * Input: status: string.
 * Output: void.
 */
function setConnectionStatus(status: string): void {
  const previousStatus = collab.connectionStatus;
  if (previousStatus === status) {
    return;
  }
  collab.connectionStatus = status;
  if (
    previousStatus === "connected"
    && ["disconnected", "connecting", "offline"].includes(status)
  ) {
    checkFrontendVersionOnNextConnected = true;
  }
  if (status === "connected") {
    const reconnected = connectedAtLeastOnce && checkFrontendVersionOnNextConnected;
    connectedAtLeastOnce = true;
    checkFrontendVersionOnNextConnected = false;
    if (reconnected) {
      void checkFrontendVersionAfterReconnect();
    }
  }
  updateBootLoaderStatusFromConnection(status);
  updateBoardConnectionLabel();
}

/**
 * Handles the markActivity function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function markActivity() {
  collab.lastActivityAt = Date.now();
  if (collab.connectionStatus === "idle" && collab.synced) {
    setConnectionStatus("connected");
  }
}

/**
 * Handles the startIdleWatch function logic.
 * Input: none.
 * Output: result produced by this function.
 */
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

/**
 * Handles the stopIdleWatch function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function stopIdleWatch() {
  if (collab.idleTimer) {
    clearInterval(collab.idleTimer);
    collab.idleTimer = null;
  }
}

/**
 * Handles the updateBoardConnectionLabel function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function updateBoardConnectionLabel() {
  if (!dom.boardConnection && !dom.boardMobileConnection) {
    return;
  }
  const setMobileBoardConnectionStatus = (status: string | null): void => {
    if (!dom.boardMobileConnection) {
      return;
    }
    if (!status) {
      dom.boardMobileConnection.textContent = "";
      dom.boardMobileConnection.className = "connection-status board-mobile-connection hidden";
      return;
    }
    const normalizedStatus = String(status || "disconnected");
    const statusLabel = STATUS_LABELS[normalizedStatus] ?? STATUS_LABELS["disconnected"] ?? "disconnected";
    dom.boardMobileConnection.textContent = statusLabel;
    dom.boardMobileConnection.className = `connection-status board-mobile-connection ${normalizedStatus}`;
  };
  if (historyMode.viewerActive && !collab.spaceId) {
    if (dom.boardConnection) {
      dom.boardConnection.textContent = "";
      dom.boardConnection.classList.add("hidden");
    }
    setMobileBoardConnectionStatus(null);
    updateResponsiveLayoutOffsets();
    return;
  }
  if (collab.spaceId) {
    const status = collab.connectionStatus || "disconnected";
    const statusLabel = STATUS_LABELS[status] ?? STATUS_LABELS["disconnected"] ?? "disconnected";
    const spaceRef = collab.spacePath || collab.spaceId;
    if (dom.boardConnection) {
      dom.boardConnection.textContent = "";
      const text = document.createElement("span");
      text.textContent = `${collab.username}@${getServerLabel()}/${spaceRef}`;
      const pill = document.createElement("span");
      pill.className = `connection-status ${status}`;
      pill.textContent = statusLabel;
      dom.boardConnection.append(text, pill);
      dom.boardConnection.classList.remove("hidden");
    }
    setMobileBoardConnectionStatus(status);
  } else {
    if (dom.boardConnection) {
      dom.boardConnection.textContent = "";
      const text = document.createElement("span");
      text.textContent = "offline mode";
      dom.boardConnection.append(text);
      dom.boardConnection.classList.remove("hidden");
    }
    setMobileBoardConnectionStatus("offline");
  }
  updateResponsiveLayoutOffsets();
}

/**
 * Handles the isOfflineMode function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function isOfflineMode() {
  return !collab.spaceId;
}

/**
 * Handles the readOfflineDraft function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function readOfflineDraft() {
  const raw = safeLocalStorageGet(OFFLINE_DRAFT_STORAGE_KEY);
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
}

/**
 * Handles the writeOfflineDraft function logic.
 * Input: text: any.
 * Output: void.
 */
function writeOfflineDraft(text: any): void {
  safeLocalStorageSet(
    OFFLINE_DRAFT_STORAGE_KEY,
    JSON.stringify({
      text,
      savedAt: Date.now(),
    })
  );
}

/**
 * Handles the stopOfflineDraftTimer function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function stopOfflineDraftTimer() {
  if (collab.offlineDraftTimer) {
    clearInterval(collab.offlineDraftTimer);
    collab.offlineDraftTimer = null;
  }
}

/**
 * Handles the flushOfflineDraft function logic.
 * Input: { force = false } = {}.
 * Output: result produced by this function.
 */
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

/**
 * Handles the ensureOfflineDraftTimer function logic.
 * Input: none.
 * Output: result produced by this function.
 */
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

/**
 * Handles the trackOfflineDraftChange function logic.
 * Input: value: any.
 * Output: void.
 */
function trackOfflineDraftChange(value: any): void {
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

/**
 * Handles the getInitialEditorValue function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function getInitialEditorValue() {
  const stored = readOfflineDraft();
  if (stored !== null) {
    collab.offlineDraftSavedValue = stored;
    return stored;
  }
  collab.offlineDraftSavedValue = sample;
  return sample;
}

// Stores the sample module constant.
const sample = `Example board:\n    people:\n        maya:\n            name: Maya Rivera\n        luis:\n            name: Luis Ortega\n        sam:\n            name: Sam Patel\n        nina:\n            name: Nina Lopez\n        zara:\n            name: Zara Chen\n    tags:\n        planning\n        backend\n        ux\n        research\n\n% Kickoff sprint\n!todo @maya #planning #ux\n**Goal:** Align scope, risks, and owners. {Architecture}\n- Define success metrics\n- Draft roadmap milestones\n[ ] Share notes with stakeholders\n[ ] Lock sprint goals\n\n    % Collect requirements\n    !inprogress @sam #research\n    Interview 5 users and summarize themes.\n    [ ] Write interview guide\n    [x] Schedule sessions\n\n        % Summarize insights\n        !todo @nina #research #planning\n        Capture themes and map to product risks.\n\n    % Create UX flow\n    !todo @maya #ux\n    Map onboarding screens and happy path.\n    - Wireframe key screens\n    - Validate navigation\n\n% Architecture\n!inprogress @luis #backend\nDefine data contracts and core services.\n| Area | Owner | Status |\n| --- | --- | --- |\n| API | Luis | Draft |\n| Data | Maya | Review |\n\n    % Build service skeleton\n    !todo @luis #backend\n    [ ] Set up repo and CI\n    [ ] Define API endpoints\n\n    % Integrate auth\n    !todo @sam #backend\n    Connect OAuth provider and session storage.\n\n        % Validate permissions\n        !todo @zara #backend #research\n        Check scopes and error handling.\n\n% Release prep\n!todo @maya #planning\nFinalize checklist and release timeline.\n{Kickoff sprint}\n`;

if (dom.editor) {
  dom.editor.value = getInitialEditorValue();
}

// Stores the editorController module constant.
let editorController: any;

/**
 * Handles the shouldSuppressTextareaInputEcho function logic.
 * Input: value: any.
 * Output: boolean.
 */
function shouldSuppressTextareaInputEcho(value: any): boolean {
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
  /**
   * Handles the onTaskTitleDoubleClick function logic.
   * Input: { lineIndex }: any.
   * Output: result produced by this function.
   */
  onTaskTitleDoubleClick: ({ lineIndex }: any) => {
    const task = state.allTasks.find((item: any) => item.lineIndex === lineIndex);
    if (!task) {
      return;
    }
    openTaskEditModal(task);
  },
  /**
   * Handles the onTokenDoubleClick function logic.
   * Input: token: any.
   * Output: result produced by this function.
   */
  onTokenDoubleClick: (token: any) => {
    openSlugRenameModal(token);
  },
  spellcheck: state.spellcheckEnabled,
  scopedSpellcheck: true,
});

// Stores the taskCommandController module constant.
const taskCommandController = createTaskCommandController({
  /**
   * Handles the getEditorValue function logic.
   * Input: none.
   * Output: result produced by this function.
   */
  getEditorValue: () => editorController.getValue(),
  /**
   * Handles the applyEditorValue function logic.
   * Input: value: string.
   * Output: result produced by this function.
   */
  applyEditorValue: (value: string) => {
    applyEditorValue(value);
  },
  /**
   * Handles the syncEditorState function logic.
   * Input: none.
   * Output: result produced by this function.
   */
  syncEditorState: () => {
    syncEditorState();
  },
});

// Stores the canvasController module constant.
const canvasController = createCanvas({
  state,
  dom,
  renderMarkdown,
  onSelectTask: selectTask,
  /**
   * Handles the onEditTask function logic.
   * Input: task: any.
   * Output: result produced by this function.
   */
  onEditTask: (task: any) => openTaskEditModal(task),
  findTaskByName,
  onUpdateTaskToken: updateTaskToken,
  onUpdateTaskState: updateTaskState,
  onMakeSubtask: moveTaskAsSubtask,
  onReorderTask: reorderKanbanTask,
  onToggleCheckbox: toggleCheckboxAtLine,
  /**
   * Handles the onFiltersChange function logic.
   * Input: none.
   * Output: result produced by this function.
   */
  onFiltersChange: () => {
    buildTagPersonLists();
    buildKanban();
    updateClearFiltersVisibility();
    renderStoryPointsSummary();
  },
});

if (canvasController?.renderGraph) {
  const rawRenderGraph = canvasController.renderGraph.bind(canvasController);
  canvasController.renderGraph = (...args: any[]) => {
    if (!isResponsiveGraphVisible()) {
      state.pendingResponsiveGraphRender = true;
      return;
    }
    state.pendingResponsiveGraphRender = false;
    return measurePerformanceSync("app.canvas.renderGraph", () => rawRenderGraph(...args));
  };
}

if (typeof window !== "undefined") {
  window.__taskScriptTestHooks = {
    /**
     * Handles the setEditorSelectionRange function logic.
     * Input: start: number, end: number.
     * Output: result produced by this function.
     */
    setEditorSelectionRange(start: number, end: number) {
      if (!editorController?.setSelectionRange) {
        return null;
      }
      editorController.setSelectionRange(start, end);
      return editorController.getSelectionRange?.() || null;
    },
    /**
     * Handles the getEditorSelectionRange function logic.
     * Input: none.
     * Output: result produced by this function.
     */
    getEditorSelectionRange() {
      return editorController?.getSelectionRange?.() || null;
    },
    /**
     * Handles the getEditorDisplayRects function logic.
     * Input: none.
     * Output: result produced by this function.
     */
    getEditorDisplayRects() {
      return {
        selection:
          editorController?.getDisplaySelectionRects?.() || [],
        cursor:
          editorController?.getDisplayCursorRects?.() || [],
      };
    },
    /**
     * Handles the syncEditorOverlayMetrics function logic.
     * Input: none.
     * Output: result produced by this function.
     */
    syncEditorOverlayMetrics() {
      editorController?.syncOverlayMetrics?.();
    },
  };
}

// Stores the modalEditorController module constant.
let modalEditorController: any = null;
// Stores the modalEditorState module constant.
let modalEditorState: any = null;

// Stores the slugRenameModalController module constant.
const slugRenameModalController = createSlugRenameModalController({
  dom,
  slugRenameUi,
  /**
   * Handles the getConfig function logic.
   * Input: none.
   * Output: result produced by this function.
   */
  getConfig: () => state.config,
  /**
   * Handles the getEditorValue function logic.
   * Input: none.
   * Output: result produced by this function.
   */
  getEditorValue: () => editorController.getValue(),
  /**
   * Handles the applyEditorValue function logic.
   * Input: value: string.
   * Output: result produced by this function.
   */
  applyEditorValue: (value: string) => {
    forceEditorRefresh(value, { collapseSelection: true });
  },
  /**
   * Handles the isTaskEditModalOpen function logic.
   * Input: none.
   * Output: result produced by this function.
   */
  isTaskEditModalOpen: () => Boolean(
    modalEditorController
    && dom.taskEditModal
    && !dom.taskEditModal.classList.contains("hidden")
  ),
  /**
   * Handles the getTaskEditModalValue function logic.
   * Input: none.
   * Output: result produced by this function.
   */
  getTaskEditModalValue: () => modalEditorController?.getValue?.() || "",
  /**
   * Handles the setTaskEditModalValue function logic.
   * Input: value: string.
   * Output: result produced by this function.
   */
  setTaskEditModalValue: (value: string) => {
    modalEditorController?.setValue?.(value);
  },
  /**
   * Handles the showToast function logic.
   * Input: message: any, kind: any.
   * Output: result produced by this function.
   */
  showToast: (message: any, kind: any) => {
    showToast(message, kind);
  },
});

setScopedSpellcheckEnabled(state.spellcheckEnabled, { persist: false });

// Stores the syncEngine module constant.
const syncEngine = createSyncEngine({
  collab,
  dom,
  remoteBase: REMOTE_BASE,
  wsBase: WS_BASE,
  /**
   * Handles the getEditorController function logic.
   * Input: none.
   * Output: result produced by this function.
   */
  getEditorController: () => editorController,
  applyAuthFromInputs,
  closeSpacesModal,
  loadCollabModules,
  stopOfflineDraftTimer,
  startIdleWatch,
  stopIdleWatch,
  setConnectionStatus,
  markActivity,
  publishCollabIdentityAwareness,
  updateConnectButtonLabel,
  updateBoardConnectionLabel,
  startPresenceHeartbeat,
  stopPresenceHeartbeat,
  authHeaders,
  forceEditorRefresh,
  syncEditorState,
  trackOfflineDraftChange,
});

/**
 * Handles the applyEditorValue function logic.
 * Input: nextValue: string.
 * Output: void.
 */
function applyEditorValue(nextValue: string): void {
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
  const adjustOffset = (pos: number): number => {
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

/**
 * Handles the dispatchEditorInput function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function dispatchEditorInput() {
  editorController.dispatchInput();
}

/**
 * Handles the forceEditorRefresh function logic.
 * Input: value: string, { collapseSelection = false }: { collapseSelection?: boolean } = {}.
 * Output: void.
 */
function forceEditorRefresh(value: string, { collapseSelection = false }: { collapseSelection?: boolean } = {}): void {
  applyEditorValue(value);
  if (collapseSelection) {
    const selection = editorController.getSelectionRange();
    const caret = Number.isFinite(selection?.end) ? selection.end : 0;
    editorController.setSelectionRange(caret, caret);
  }
  syncEditorState();
  dispatchEditorInput();
}

/**
 * Handles the handleEditorSelection function logic.
 * Input: line: any.
 * Output: void.
 */
function handleEditorSelection(line: any): void {
  const task = state.allTasks.find(
    (item: any) =>
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

/**
 * Handles the selectTask function logic.
 * Input: task: any.
 * Output: void.
 */
function selectTask(task: any): void {
  state.selectedTaskId = task.id;
  state.selectedLine = task.lineIndex;
  let current = task.parent;
  while (current) {
    state.collapsed.delete(current.id);
    current = current.parent;
  }
  const lines = editorController.getValue().split("\n");
  const targetLine = task.lineIndex;
  const caretPosition = lines
    .slice(0, targetLine)
    .reduce((sum: number, line: string) => sum + line.length + 1, 0);
  editorController.focus();
  editorController.setSelectionRange(caretPosition, caretPosition);
  editorController.updateSelectedLine();
  editorController.highlightText(lines);
  canvasController.focusOnTask(task);
  canvasController.renderGraph();
  buildKanban();
  renderStoryPointsSummary();
}

/**
 * Handles the buildTagPersonLists function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function buildTagPersonLists() {
  dom.tagList.innerHTML = "";
  dom.personList.innerHTML = "";
  const tagOrder = state.config?.tags?.map((tag: any) => `#${tag.key}`) || [];
  const extraTags = Array.from(state.tags).filter((tag: any) => !tagOrder.includes(tag)).sort();
  const tags = [...tagOrder, ...extraTags];
  tags.forEach((tag: any) => {
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
  const peopleOrder = state.config?.people?.map((person: any) => `@${person.key}`) || [];
  const extraPeople = Array.from(state.people)
    .filter((person) => !peopleOrder.includes(person))
    .sort();
  const people = [...peopleOrder, ...extraPeople];
  people.forEach((person: any) => {
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
  const peopleLegendGroup = dom.personList?.closest(".legend-group") as HTMLElement | null;
  const tagsLegendGroup = dom.tagList?.closest(".legend-group") as HTMLElement | null;
  const storyPointsLegendGroup = dom.storyPointsSummaryGraph?.closest(".legend-group") as HTMLElement | null;
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
    dom.legend.dataset["legendLayout"] = visibleLegendParts.join("-") || "empty";
  }
  const hasVisibleLegendGroups =
    (peopleLegendGroup !== null && !peopleLegendGroup.hidden)
    || (tagsLegendGroup !== null && !tagsLegendGroup.hidden)
    || (storyPointsLegendGroup !== null && !storyPointsLegendGroup.hidden);
  setLegendHasVisibleContent(hasVisibleLegendGroups);
}

/**
 * Handles the formatStoryPointsNumber function logic.
 * Input: value: any.
 * Output: string.
 */
function formatStoryPointsNumber(value: any): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return Number.isInteger(value) ? String(value) : String(value);
}

/**
 * Handles the renderStoryPointsSummary function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function renderStoryPointsSummary() {
  const targets = [dom.storyPointsSummaryGraph, dom.storyPointsSummaryKanban].filter(
    (pill): pill is HTMLElement => Boolean(pill)
  );
  if (!targets.length) {
    return;
  }
  const total = Number.isFinite(state.totalStoryPoints) ? state.totalStoryPoints : 0;
  const hasSearchSelection = Boolean(state.searchQuery && state.searchQuery.trim());
  const hasFilterSelection = Boolean(filtersActive());
  const hasSelection = hasSearchSelection || hasFilterSelection;
  let selectedTotal: number | null = null;
  if (hasSelection) {
    const selectedTasks = new Set();
    state.allTasks.forEach((task: any) => {
      const selectedBySearch = hasSearchSelection && matchesSearchTask(task);
      const selectedByFilters = hasFilterSelection && matchesFilters(task);
      if (selectedBySearch || selectedByFilters) {
        selectedTasks.add(task.id);
      }
    });
    selectedTotal = 0;
    state.allTasks.forEach((task: any) => {
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
  updateResponsiveLayoutOffsets();
}

/**
 * Handles the sync function logic.
 * Input: none.
 * Output: void.
 */
function sync(): void {
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
  applyStableTaskIds({ allTasks: Array.isArray(allTasks) ? allTasks : [] });
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
  updateResponsiveLayoutOffsets();
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

/**
 * Handles the buildKanban function logic.
 * Input: none.
 * Output: void.
 */
function buildKanban(): void {
  measurePerformanceSync("app.buildKanban", () => {
    if (!isResponsiveKanbanVisible()) {
      state.pendingResponsiveKanbanBuild = true;
      return;
    }
    state.pendingResponsiveKanbanBuild = false;
    buildKanbanView({
      state,
      dom,
      renderMarkdown,
      selectTask,
      /**
       * Handles the onEditTask function logic.
       * Input: task: any.
       * Output: result produced by this function.
       */
      onEditTask: (task: any) => openTaskEditModal(task),
      matchesSearchTask,
      filtersActive,
      matchesFilters,
      updateTaskState,
      onToggleCheckbox: toggleCheckboxAtLine,
      groupBy: state.kanbanGroupBy,
    });
  });
}

/**
 * Handles the updateTaskState function logic.
 * Input: task: any, newState: any.
 * Output: void.
 */
function updateTaskState(task: any, newState: any): void {
  updateTaskStateInEditor({ task, newState, dom, sync, applyEditorValue });
}

/**
 * Handles the updateTaskToken function logic.
 * Input: task: any, token: any, action: any.
 * Output: void.
 */
function updateTaskToken(task: any, token: any, action: any): void {
  updateTaskTokenInEditor({ task, token, action, dom, sync, applyEditorValue });
}

// Stores the editingTaskRange module constant.
let editingTaskRange: any = null;
// Stores the editingTaskIndent module constant.
let editingTaskIndent = "";
// Stores the editingTaskJiraKey module constant.
let editingTaskJiraKey: any = null;
// Stores the editingTaskRef module constant.
let editingTaskRef: any = null;
// Stores the creatingTask module constant.
let creatingTask = false;
// Stores the pendingDeleteTask module constant.
let pendingDeleteTask: any = null;
// Stores the isTaskDragActive module constant.
let isTaskDragActive = false;
// Stores the taskEditDragHandlersBound module constant.
let taskEditDragHandlersBound = false;

/**
 * Handles the getTaskEditParsedBody function logic.
 * Input: none.
 * Output: any.
 */
function getTaskEditParsedBody(): any {
  return parseTaskBody(modalEditorController?.getValue?.() || "");
}

/**
 * Handles the toggleTaskEditTokenByClick function logic.
 * Input: type: "state" | "tag" | "person", token: string.
 * Output: void.
 */
function toggleTaskEditTokenByClick(type: "state" | "tag" | "person", token: string): void {
  if (!modalEditorController || !token) {
    return;
  }
  const current = modalEditorController.getValue();
  const parsed = parseTaskBody(current);
  let updated = current;
  if (type === "state") {
    updated = parsed.state === token ? removeStateFromBody(current) : insertStateIntoBody(current, token);
  } else if (type === "tag") {
    updated = (parsed.tags || []).includes(token)
      ? removeTokenFromBody(current, token)
      : insertTokenIntoBody(current, token);
  } else {
    updated = (parsed.people || []).includes(token)
      ? removeTokenFromBody(current, token)
      : insertTokenIntoBody(current, token);
  }
  if (updated !== current) {
    modalEditorController.setValue(updated);
  }
}

/**
 * Handles the setTaskDragActive function logic.
 * Input: active: any.
 * Output: void.
 */
function setTaskDragActive(active: any): void {
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

/**
 * Handles the renderTaskEditTokenList function logic.
 * Input: container: any, tokens: any[], metaMap: any, type: any.
 * Output: void.
 */
function renderTaskEditTokenList(container: any, tokens: any[], metaMap: any, type: any): void {
  if (!container) {
    return;
  }
  container.innerHTML = "";
  const parsed = getTaskEditParsedBody();
  const activeSet = new Set(
    type === "tag"
      ? (Array.isArray(parsed?.tags) ? parsed.tags : [])
      : type === "person"
        ? (Array.isArray(parsed?.people) ? parsed.people : [])
        : []
  );
  const activeState = typeof parsed?.state === "string" ? parsed.state : null;
  tokens.forEach((token: any) => {
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
    const isActive = type === "state" ? activeState === token : activeSet.has(token);
    pill.classList.toggle("active", isActive);
    pill.title = isActive ? "Click to remove" : "Click to add";
    pill.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (type === "state" || type === "tag" || type === "person") {
        toggleTaskEditTokenByClick(type, token);
      }
    });
    pill.draggable = true;
    pill.addEventListener("dragstart", (event) => {
      const dragEvent = /** @type {DragEvent} */ (event);
      dragEvent.dataTransfer?.setData(
        "application/json",
        JSON.stringify({ type, value: token, source: "palette" })
      );
      if (dragEvent.dataTransfer) {
        dragEvent.dataTransfer.effectAllowed = "copy";
      }
    });
    container.appendChild(pill);
  });
}

/**
 * Handles the refreshTaskEditTokenLists function logic.
 * Input: none.
 * Output: void.
 */
function refreshTaskEditTokenLists(): void {
  const stateOrder = state.config?.states?.map((item: any) => `!${item.key}`) || [];
  const extraStates = Array.from(state.states)
    .filter((value) => !stateOrder.includes(value))
    .sort((a: string, b: string) => a.localeCompare(b));
  const stateTokens = [...stateOrder, ...extraStates];
  const tagOrder = state.config?.tags?.map((tag: any) => `#${tag.key}`) || [];
  const extraTags = Array.from(state.tags)
    .filter((tag) => !tagOrder.includes(tag))
    .sort((a: string, b: string) => a.localeCompare(b));
  const tagTokens = [...tagOrder, ...extraTags];
  const peopleOrder = state.config?.people?.map((person: any) => `@${person.key}`) || [];
  const extraPeople = Array.from(state.people)
    .filter((person) => !peopleOrder.includes(person))
    .sort((a: string, b: string) => a.localeCompare(b));
  const peopleTokens = [...peopleOrder, ...extraPeople];
  renderTaskEditTokenList(dom.taskEditStates, stateTokens, state.stateMeta, "state");
  renderTaskEditTokenList(dom.taskEditTags, tagTokens, state.tagMeta, "tag");
  renderTaskEditTokenList(dom.taskEditPeople, peopleTokens, state.peopleMeta, "person");
  const peopleListSection = dom.taskEditPeople?.closest(".task-edit-list") as HTMLElement | null;
  const tagsListSection = dom.taskEditTags?.closest(".task-edit-list") as HTMLElement | null;
  if (peopleListSection) {
    peopleListSection.hidden = peopleTokens.length === 0;
  }
  if (tagsListSection) {
    tagsListSection.hidden = tagTokens.length === 0;
  }
}

/**
 * Handles the ensureTaskEditDragHandlers function logic.
 * Input: none.
 * Output: void.
 */
function ensureTaskEditDragHandlers(): void {
  if (taskEditDragHandlersBound) {
    return;
  }
  taskEditDragHandlersBound = true;
  if (dom.taskEditPreview) {
    dom.taskEditPreview.addEventListener("dragover", (event: any) => {
      event.preventDefault();
      dom.taskEditPreview.classList.add("drag-over");
    });
    dom.taskEditPreview.addEventListener("dragleave", () => {
      dom.taskEditPreview.classList.remove("drag-over");
    });
    dom.taskEditPreview.addEventListener("drop", (event: any) => {
      const dragEvent = /** @type {DragEvent} */ (event);
      event.preventDefault();
      dom.taskEditPreview.classList.remove("drag-over");
      const payload = dragEvent.dataTransfer?.getData("application/json");
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
    dom.taskEditSide.addEventListener("dragover", (event: any) => {
      event.preventDefault();
      dom.taskEditSide.classList.add("drag-over");
    });
    dom.taskEditSide.addEventListener("dragleave", () => {
      dom.taskEditSide.classList.remove("drag-over");
    });
    dom.taskEditSide.addEventListener("drop", (event: any) => {
      const dragEvent = /** @type {DragEvent} */ (event);
      event.preventDefault();
      dom.taskEditSide.classList.remove("drag-over");
      const payload = dragEvent.dataTransfer?.getData("application/json");
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

/**
 * Handles the updateTaskEditPreviewFromText function logic.
 * Input: text: any.
 * Output: void.
 */
function updateTaskEditPreviewFromText(text: any): void {
  if (!dom.taskEditPreview) {
    return;
  }
  const parsed = parseTaskBody(text);
  const titleValue = dom.taskEditTitleInput?.value.trim() || "Untitled task";
  const { key: jiraKey, title: jiraTitle } = parseJiraTitle(titleValue);
  const displayKey = jiraKey || editingTaskJiraKey;
  updateTaskEditJiraPill(displayKey);
  const displayTitle = jiraTitle || "Untitled task";
  /**
   * Handles the formatStoryPoints function logic.
   * Input: value: any.
   * Output: String(value));.
   */
  const formatStoryPoints = (value: any) => (Number.isInteger(value) ? String(value) : String(value));
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
    const stateToken = parsed.state;
    const pill = document.createElement("span");
    pill.className = "pill state-pill";
    pill.draggable = true;
    const stateMeta = state.stateMeta?.get(stateToken);
    pill.textContent = stateMeta?.name || stateToken.replace(/^!/, "");
    const stateColor = stateMeta?.color;
    if (stateColor) {
      pill.style.borderColor = stateColor;
      pill.style.color = stateColor;
    }
    pill.addEventListener("dragstart", (event) => {
      const dataTransfer = event.dataTransfer;
      if (!dataTransfer) {
        return;
      }
      dataTransfer.setData(
        "application/json",
        JSON.stringify({ type: "state", value: stateToken, source: "preview" })
      );
      dataTransfer.effectAllowed = "move";
    });
    pill.title = "Click to remove state";
    pill.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleTaskEditTokenByClick("state", stateToken);
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
  const descriptionLines = (parsed.descriptionText || "").replace(/\r/g, "").split("\n");
  const lineIndexes = descriptionLines.map((_, index) => index);
  const { node: desc } = renderTaskDescriptionNode({
    task: {
      description: descriptionLines,
      descriptionLineIndexes: lineIndexes,
    },
    renderMarkdown,
    className: "description",
    lineIndexes,
    disableLinks: true,
  });
  desc.querySelectorAll("a").forEach((link: any) => {
    const span = document.createElement("span");
    span.className = "inline-link";
    span.textContent = link.textContent || link.getAttribute("href") || "";
    link.replaceWith(span);
  });
  decorateDescriptionReferences(desc, {
    addInlineLinkClass: true,
    /**
     * Handles the resolveTaskByName function logic.
     * Input: name: any.
     * Output: result produced by this function.
     */
    resolveTaskByName: (name: any) => findTaskByName(name),
  });
  card.appendChild(desc);
  dom.taskEditPreview.appendChild(card);

  decorateDescriptionPills(dom.taskEditPreview, {
    tagMeta: state.tagMeta,
    peopleMeta: state.peopleMeta,
    colorText: true,
    /**
     * Handles the onPill function logic.
     * Input: { pill, type, value }: any.
     * Output: result produced by this function.
     */
    onPill: ({ pill, type, value }: any) => {
      if (type === "jira") {
        pill.title = `Copy ${value}`;
        pill.addEventListener("click", (event: any) => {
          event.stopPropagation();
          copyToClipboard(value);
        });
        pill.draggable = false;
        return;
      }
      pill.draggable = true;
      pill.addEventListener("dragstart", (event: any) => {
        event.dataTransfer.setData(
          "application/json",
          JSON.stringify({ type, value, source: "preview" })
        );
        event.dataTransfer.effectAllowed = "move";
      });
      if (type === "tag" || type === "person") {
        pill.title = "Click to remove";
        pill.addEventListener("click", (event: any) => {
          event.preventDefault();
          event.stopPropagation();
          toggleTaskEditTokenByClick(type, value);
        });
      }
    },
  });
  wireDescriptionCheckboxes(dom.taskEditPreview, {
    selector: 'input[type="checkbox"][data-line]',
    lineFromClosest: false,
    triggerEvent: "change",
    /**
     * Handles the onToggle function logic.
     * Input: { lineIndex, checked }: any.
     * Output: result produced by this function.
     */
    onToggle: ({ lineIndex, checked }: any) => {
      if (!modalEditorController) {
        return;
      }
      const updated = updateCheckboxInBody(
        modalEditorController.getValue(),
        lineIndex,
        checked
      );
      modalEditorController.setValue(updated);
    },
  });
  ensureTaskEditDragHandlers();
  refreshTaskEditTokenLists();
}

/**
 * Handles the ensureTaskEditEditor function logic.
 * Input: none.
 * Output: result produced by this function.
 */
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
      /**
       * Handles the onSync function logic.
       * Input: none.
       * Output: result produced by this function.
       */
      onSync: () => {
        if (dom.taskEditModal && !dom.taskEditModal.classList.contains("hidden")) {
          updateTaskEditPreviewFromText(modalEditorController.getValue());
        }
      },
      /**
       * Handles the onSelectTask function logic.
       * Input: none.
       * Output: result produced by this function.
       */
      onSelectTask: () => {},
      /**
       * Handles the onLocalChange function logic.
       * Input: none.
       * Output: result produced by this function.
       */
      onLocalChange: () => true,
      /**
       * Handles the onSelectionChange function logic.
       * Input: none.
       * Output: result produced by this function.
       */
      onSelectionChange: () => {},
      /**
       * Handles the onFocusChange function logic.
       * Input: none.
       * Output: result produced by this function.
       */
      onFocusChange: () => {},
      /**
       * Handles the onTokenDoubleClick function logic.
       * Input: token: any.
       * Output: result produced by this function.
       */
      onTokenDoubleClick: (token: any) => {
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

/**
 * Handles the getTaskEditDeleteTarget function logic.
 * Input: none.
 * Output: any.
 */
function getTaskEditDeleteTarget(): any {
  if (creatingTask || !editingTaskRef) {
    return null;
  }
  const taskId = typeof editingTaskRef.id === "string" ? editingTaskRef.id : "";
  if (taskId) {
    const byId = state.allTasks.find((task: any) => task.id === taskId);
    if (byId) {
      return byId;
    }
  }
  const lineIndex = Number.isInteger(editingTaskRange?.start)
    ? editingTaskRange.start
    : editingTaskRef.lineIndex;
  if (Number.isInteger(lineIndex)) {
    const byLine = state.allTasks.find((task: any) => task.lineIndex === lineIndex);
    if (byLine) {
      return byLine;
    }
  }
  return editingTaskRef;
}

/**
 * Handles the updateTaskEditDeleteButtonVisibility function logic.
 * Input: none.
 * Output: void.
 */
function updateTaskEditDeleteButtonVisibility(): void {
  if (!dom.taskEditDelete) {
    return;
  }
  const hasDeleteTarget = Boolean(getTaskEditDeleteTarget());
  const visible = !creatingTask && hasDeleteTarget;
  dom.taskEditDelete.classList.toggle("hidden", !visible);
  dom.taskEditDelete.disabled = !visible;
}

/**
 * Handles the openTaskEditModal function logic.
 * Input: task: any.
 * Output: void.
 */
function openTaskEditModal(task: any): void {
  if (!dom.taskEditModal || !task) {
    return;
  }
  creatingTask = false;
  const lines = editorController.getValue().split("\n");
  const draft = buildTaskEditDraft(lines, task);
  if (!draft) {
    return;
  }
  editingTaskRef = task;
  editingTaskRange = draft.range;
  editingTaskIndent = draft.indent;
  if (dom.taskEditError) {
    dom.taskEditError.classList.add("hidden");
    dom.taskEditError.textContent = "";
  }
  if (dom.taskEditTitleInput) {
    editingTaskJiraKey = draft.jiraKey;
    dom.taskEditTitleInput.value = draft.title;
  }
  updateTaskEditJiraPill(editingTaskJiraKey);
  const modalEditor = ensureTaskEditEditor();
  if (modalEditor) {
    if (dom.taskEditCode) {
      dom.taskEditCode.value = draft.bodyText;
    }
    modalEditor.setValue(draft.bodyText);
  }
  refreshTaskEditTokenLists();
  updateTaskEditPreviewFromText(draft.bodyText);
  updateTaskEditDeleteButtonVisibility();
  dom.taskEditModal.classList.remove("hidden");
  if (modalEditor) {
    modalEditor.focus();
  }
}

/**
 * Handles the openTaskCreateModal function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function openTaskCreateModal() {
  if (!dom.taskEditModal) {
    return;
  }
  creatingTask = true;
  editingTaskRef = null;
  const lines = editorController.getValue().split("\n");
  const draft = buildTaskCreateDraft(lines);
  editingTaskRange = draft.range;
  editingTaskIndent = draft.indent;
  editingTaskJiraKey = draft.jiraKey;
  if (dom.taskEditError) {
    dom.taskEditError.classList.add("hidden");
    dom.taskEditError.textContent = "";
  }
  if (dom.taskEditTitleInput) {
    dom.taskEditTitleInput.value = draft.title;
  }
  updateTaskEditJiraPill(null);
  const modalEditor = ensureTaskEditEditor();
  if (modalEditor) {
    if (dom.taskEditCode) {
      dom.taskEditCode.value = draft.bodyText;
    }
    modalEditor.setValue(draft.bodyText);
  }
  refreshTaskEditTokenLists();
  updateTaskEditPreviewFromText(draft.bodyText);
  updateTaskEditDeleteButtonVisibility();
  dom.taskEditModal.classList.remove("hidden");
  dom.taskEditTitleInput?.focus();
}

/**
 * Handles the closeTaskEditModal function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function closeTaskEditModal() {
  if (!dom.taskEditModal) {
    return;
  }
  dom.taskEditModal.classList.add("hidden");
  editingTaskRange = null;
  editingTaskIndent = "";
  editingTaskJiraKey = null;
  editingTaskRef = null;
  creatingTask = false;
  updateTaskEditDeleteButtonVisibility();
  updateTaskEditJiraPill(null);
}

/**
 * Handles the updateBoardNameInEditor function logic.
 * Input: nextBoardName: any.
 * Output: void.
 */
function updateBoardNameInEditor(nextBoardName: any): void {
  if (!editorController) {
    return;
  }
  const nextText = applyBoardNameToText(editorController.getValue(), nextBoardName);
  forceEditorRefresh(nextText, { collapseSelection: true });
}

/**
 * Handles the openBoardRenameModal function logic.
 * Input: none.
 * Output: result produced by this function.
 */
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

/**
 * Handles the closeBoardRenameModal function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function closeBoardRenameModal() {
  if (!dom.boardRenameModal) {
    return;
  }
  dom.boardRenameModal.classList.add("hidden");
  pendingBoardRename = false;
}

/**
 * Handles the submitBoardRename function logic.
 * Input: none.
 * Output: result produced by this function.
 */
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

/**
 * Handles the openSlugRenameModal function logic.
 * Input: token: any.
 * Output: void.
 */
function openSlugRenameModal(token: any): void {
  slugRenameModalController.open(token);
}

/**
 * Handles the closeSlugRenameModal function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function closeSlugRenameModal() {
  slugRenameModalController.close();
}

/**
 * Handles the submitSlugRename function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function submitSlugRename() {
  slugRenameModalController.submit();
}

/**
 * Handles the countSubtasks function logic.
 * Input: task: any.
 * Output: number.
 */
function countSubtasks(task: any): number {
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

/**
 * Handles the openTaskDeleteModal function logic.
 * Input: task: any.
 * Output: void.
 */
function openTaskDeleteModal(task: any): void {
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

/**
 * Handles the closeTaskDeleteModal function logic.
 * Input: none.
 * Output: void.
 */
function closeTaskDeleteModal(): void {
  if (!dom.taskDeleteModal) {
    return;
  }
  dom.taskDeleteModal.classList.add("hidden");
  pendingDeleteTask = null;
  clearTaskDeletePreview();
}

/**
 * Handles the animateTaskRemoval function logic.
 * Input: task: any, onComplete: any.
 * Output: void.
 */
function animateTaskRemoval(task: any, onComplete: any): void {
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
  nodes.forEach((node: any) => node.classList.add("deleting"));
  setTimeout(onComplete, 220);
}

/**
 * Handles the deleteTask function logic.
 * Input: task: any.
 * Output: void.
 */
function deleteTask(task: any): void {
  if (!task) {
    return;
  }
  animateTaskRemoval(task, () => {
    const nextLine = taskCommandController.deleteTaskAtLine(task.lineIndex);
    if (nextLine !== null) {
      handleEditorSelection(nextLine);
    }
  });
}

/**
 * Handles the deleteTaskKeepSubtasks function logic.
 * Input: task: any.
 * Output: void.
 */
function deleteTaskKeepSubtasks(task: any): void {
  if (!task) {
    return;
  }
  animateTaskRemoval(task, () => {
    const nextLine = taskCommandController.deleteTaskKeepSubtasksAtLine(task.lineIndex);
    if (nextLine !== null) {
      handleEditorSelection(nextLine);
    }
  });
}

/**
 * Handles the clearTaskDeletePreview function logic.
 * Input: none.
 * Output: void.
 */
function clearTaskDeletePreview(): void {
  document.querySelectorAll(".task-node.delete-preview").forEach((node) => {
    node.classList.remove("delete-preview");
  });
  document.querySelectorAll(".kanban-card.delete-preview").forEach((card) => {
    card.classList.remove("delete-preview");
  });
}

/**
 * Handles the highlightTaskDeletePreview function logic.
 * Input: task: any, includeSubtasks: any.
 * Output: void.
 */
function highlightTaskDeletePreview(task: any, includeSubtasks: any): void {
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
  toHighlight.forEach((item: any) => {
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

/**
 * Handles the saveTaskEditModal function logic.
 * Input: none.
 * Output: result produced by this function.
 */
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
  const saveResult = taskCommandController.saveTaskEdit({
    taskRange: editingTaskRange,
    rawTitle,
    bodyText: modalEditor.getValue(),
    indent: editingTaskIndent,
    fallbackJiraKey: editingTaskJiraKey,
    creatingTask,
  });
  if (!saveResult.ok) {
    if (dom.taskEditError) {
      dom.taskEditError.textContent =
        ("error" in saveResult && saveResult.error) || "Unable to save task.";
      dom.taskEditError.classList.remove("hidden");
    }
    return;
  }
  handleEditorSelection(saveResult.lineIndex);
  if (creatingTask) {
    showToast(`Task '${saveResult.title}' created.`);
  }
  closeTaskEditModal();
}

/**
 * Handles the moveTaskAsSubtask function logic.
 * Input: sourceTask: any, targetTask: any.
 * Output: void.
 */
function moveTaskAsSubtask(sourceTask: any, targetTask: any): void {
  taskCommandController.moveTaskAsSubtask(sourceTask, targetTask);
}

/**
 * Handles the reorderKanbanTask function logic.
 * Input: sourceTask: any, targetTask: any, position: any, options: any = {}.
 * Output: result produced by this function.
 */
function reorderKanbanTask(sourceTask: any, targetTask: any, position: any, options: any = {}) {
  return taskCommandController.reorderTask(sourceTask, targetTask, position, options);
}

/**
 * Handles the findTaskByName function logic.
 * Input: name: any.
 * Output: result produced by this function.
 */
function findTaskByName(name: any) {
  const query = typeof name === "string" ? name.trim() : "";
  if (!query) {
    return null;
  }
  const exact = state.allTasks.find((task: any) => task.name === query);
  if (exact) {
    return exact;
  }
  const lowerQuery = query.toLowerCase();
  return (
    state.allTasks.find(
      (task: any) => typeof task.name === "string" && task.name.toLowerCase() === lowerQuery
    ) || null
  );
}

/**
 * Handles the syncEditorState function logic.
 * Input: none.
 * Output: void.
 */
function syncEditorState(): void {
  sync();
  editorController.updateSelectedLine();
}

/**
 * Handles the createTaskVisualId function logic.
 * Input: none.
 * Output: string.
 */
function createTaskVisualId(): string {
  const randomId =
    globalThis.crypto && typeof globalThis.crypto.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `task/${randomId}`;
}

/**
 * Handles the normalizeTaskPathPart function logic.
 * Input: name: any.
 * Output: string.
 */
function normalizeTaskPathPart(name: any): string {
  const text = typeof name === "string" ? name.trim().replace(/\s+/g, " ").toLowerCase() : "";
  return text || "_";
}

/**
 * Handles the buildTaskNamePath function logic.
 * Input: task: any.
 * Output: string.
 */
function buildTaskNamePath(task: any): string {
  const segments: string[] = [];
  let current = task;
  while (current) {
    segments.push(normalizeTaskPathPart(current.name));
    current = current.parent;
  }
  return segments.reverse().join("/");
}

/**
 * Handles the buildTaskPathSuffixes function logic.
 * Input: path: any.
 * Output: string[].
 */
function buildTaskPathSuffixes(path: any): string[] {
  const segments = String(path || "")
    .split("/")
    .filter(Boolean);
  const suffixes: string[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const suffix = segments.slice(index).join("/");
    if (suffix) {
      suffixes.push(suffix);
    }
  }
  return suffixes;
}

/**
 * Handles the findHeuristicTaskMatch function logic.
 * Input: previousPath: any, currentEntries: any[].
 * Output: number.
 */
function findHeuristicTaskMatch(previousPath: any, currentEntries: any[]): number {
  if (!previousPath || !Array.isArray(currentEntries) || !currentEntries.length) {
    return -1;
  }
  const suffixes = buildTaskPathSuffixes(previousPath);
  for (const suffix of suffixes) {
    let index = currentEntries.findIndex((entry: any) => entry.path.includes(suffix));
    if (index >= 0) {
      return index;
    }
    index = currentEntries.findIndex((entry: any) => suffix.includes(entry.path));
    if (index >= 0) {
      return index;
    }
  }
  return -1;
}

/**
 * Handles the getTaskPathMapKey function logic.
 * Input: none.
 * Output: string.
 */
function getTaskPathMapKey(): string {
  const spaceRef = (
    typeof collab.spacePath === "string" && collab.spacePath.trim()
      ? collab.spacePath.trim()
      : (typeof collab.spaceId === "string" ? collab.spaceId.trim() : "")
  );
  return spaceRef ? `space:${spaceRef}` : "local";
}

/**
 * Handles the applyStableTaskIds function logic.
 * Input: { allTasks }: { allTasks: any[] }.
 * Output: void.
 */
function applyStableTaskIds({ allTasks }: { allTasks: any[] }): void {
  const mapKey = getTaskPathMapKey();
  const previousMap = state.taskPathMaps.get(mapKey) || new Map();

  const previousEntries: any[] = [];
  previousMap.forEach((ids: any, path: any) => {
    (Array.isArray(ids) ? ids : []).forEach((id: any) => {
      if (typeof id === "string" && id.trim()) {
        previousEntries.push({ path, id });
      }
    });
  });

  const previousByPath = new Map();
  previousEntries.forEach((entry: any) => {
    const list = previousByPath.get(entry.path) || [];
    list.push(entry.id);
    previousByPath.set(entry.path, list);
  });

  const unpairedCurrent: any[] = [];
  allTasks.forEach((task: any) => {
    const path = buildTaskNamePath(task);
    const candidates = previousByPath.get(path);
    if (candidates && candidates.length) {
      task.id = candidates.shift();
      return;
    }
    unpairedCurrent.push({ task, path });
  });

  const unpairedPrevious: any[] = [];
  previousByPath.forEach((ids: any, path: any) => {
    ids.forEach((id: any) => {
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

  unpairedCurrent.forEach(({ task }: any) => {
    task.id = createTaskVisualId();
  });

  const nextMap = new Map();
  allTasks.forEach((task: any) => {
    const path = buildTaskNamePath(task);
    const list = nextMap.get(path) || [];
    list.push(task.id);
    nextMap.set(path, list);
  });
  state.taskPathMaps.set(mapKey, nextMap);
}

/**
 * Handles the toggleCheckboxAtLine function logic.
 * Input: lineIndex: any, checked: any = null.
 * Output: void.
 */
function toggleCheckboxAtLine(lineIndex: any, checked: any = null): void {
  taskCommandController.toggleCheckboxAtLine(lineIndex, checked);
}

/**
 * Handles the toSafeFilename function logic.
 * Input: value: any.
 * Output: string.
 */
function toSafeFilename(value: any): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "tasks";
}

/**
 * Handles the tokenMatchesQuery function logic.
 * Input: token: any, metaMap: any, query: any.
 * Output: boolean.
 */
function tokenMatchesQuery(token: any, metaMap: any, query: any): boolean {
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

/**
 * Handles the tokensMatchQuery function logic.
 * Input: tokens: any, metaMap: any, query: any.
 * Output: boolean.
 */
function tokensMatchQuery(tokens: any, metaMap: any, query: any): boolean {
  return tokens.some((token: any) => tokenMatchesQuery(token, metaMap, query));
}

/**
 * Handles the matchesSearchTask function logic.
 * Input: task: any.
 * Output: boolean.
 */
function matchesSearchTask(task: any): boolean {
  if (!state.searchQuery) {
    return false;
  }
  const query = state.searchQuery.toLowerCase();
  const searchNameEnabled = Boolean(dom.searchName?.checked);
  const searchDescriptionEnabled = Boolean(dom.searchDescription?.checked);
  const searchTagEnabled = Boolean(dom.searchTag?.checked);
  const searchPersonEnabled = Boolean(dom.searchPerson?.checked);
  if (
    searchNameEnabled &&
    (task.name.toLowerCase().includes(query) ||
      (task.jiraKey || "").toLowerCase().includes(query))
  ) {
    return true;
  }
  if (searchDescriptionEnabled && task.description.join(" ").toLowerCase().includes(query)) {
    return true;
  }
  if (searchTagEnabled && tokensMatchQuery(task.tags, state.tagMeta, query)) {
    return true;
  }
  if (searchPersonEnabled && tokensMatchQuery(task.people, state.peopleMeta, query)) {
    return true;
  }
  return false;
}

/**
 * Handles the filtersActive function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function filtersActive() {
  return state.selectedTags.size || state.selectedPeople.size;
}

/**
 * Handles the updateClearFiltersVisibility function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function updateClearFiltersVisibility() {
  if (!dom.clearFilters) {
    return;
  }
  const hasFilters = filtersActive();
  const hasSearch = Boolean(state.searchQuery && state.searchQuery.trim());
  dom.clearFilters.hidden = !(hasFilters || hasSearch);
}

/**
 * Handles the loadCollabModules function logic.
 * Input: none.
 * Output: result produced by this function.
 */
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

/**
 * Handles the collabUserAwarenessState function logic.
 * Input: identity: any.
 * Output: result produced by this function.
 */
function collabUserAwarenessState(identity: any) {
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

/**
 * Handles the publishCollabIdentityAwareness function logic.
 * Input: none.
 * Output: void.
 */
function publishCollabIdentityAwareness(): void {
  if (!collab.provider?.awareness) {
    return;
  }
  const identity =
    collab.identity || getCollabIdentity(collab.displayName || collab.username || "user");
  collab.provider.awareness.setLocalStateField("user", collabUserAwarenessState(identity));
}

/**
 * Handles the authHeaders function logic.
 * Input: { includeBasic = false } = {}.
 * Output: result produced by this function.
 */
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

/**
 * Handles the loginRequest function logic.
 * Input: username: any, password: any.
 * Output: result produced by this function.
 */
async function loginRequest(username: any, password: any) {
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

/**
 * Handles the verifyCurrentPassword function logic.
 * Input: password: any.
 * Output: result produced by this function.
 */
async function verifyCurrentPassword(password: any) {
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

/**
 * Handles the logoutRequest function logic.
 * Input: none.
 * Output: result produced by this function.
 */
async function logoutRequest() {
  try {
    await fetch(`${REMOTE_BASE}/api/logout`, {
      method: "POST",
    });
  } catch {
    // ignore
  }
}

/**
 * Handles the fetchSpaces function logic.
 * Input: none.
 * Output: result produced by this function.
 */
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
    .map((space: any) => {
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
    .filter((space: any) => space.id)
    : [];
  const folders = Array.isArray(data.folders)
    ? data.folders
      .filter((folder: any) => typeof folder === "string" && folder.trim())
      .map((folder: any) => folder.trim())
    : [];
  return {
    spaces,
    folders,
    user: data.user && typeof data.user === "object" ? data.user : null,
    permissions:
      data.permissions && typeof data.permissions === "object" ? data.permissions : null,
  };
}

/**
 * Handles the createSpaceFolderRequest function logic.
 * Input: name: any.
 * Output: result produced by this function.
 */
async function createSpaceFolderRequest(name: any) {
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

/**
 * Handles the deleteSpaceFolderRequest function logic.
 * Input: folderId: any.
 * Output: result produced by this function.
 */
async function deleteSpaceFolderRequest(folderId: any) {
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

/**
 * Handles the moveSpaceToFolderRequest function logic.
 * Input: spaceId: any, folder: any, spacePath: any = "".
 * Output: result produced by this function.
 */
async function moveSpaceToFolderRequest(spaceId: any, folder: any, spacePath: any = "") {
  const normalizedPath = typeof spacePath === "string" ? spacePath.trim() : "";
  let response;
  try {
    response = await fetch(`${REMOTE_BASE}/api/spaces/${encodeURIComponent(spaceId)}/folder`, {
      method: "PUT",
      headers: {
        ...authHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(normalizedPath ? { folder, path: normalizedPath } : { folder }),
    });
  } catch {
    throw new Error("Unable to reach the backend.");
  }
  if (!response.ok) {
    throw new Error(spaceResponseError(response, "Unable to move space."));
  }
  return response.json();
}

/**
 * Handles the fetchJiraConfig function logic.
 * Input: none.
 * Output: result produced by this function.
 */
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

/**
 * Handles the saveJiraConfig function logic.
 * Input: payload: any.
 * Output: result produced by this function.
 */
async function saveJiraConfig(payload: any) {
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

/**
 * Handles the fetchMe function logic.
 * Input: none.
 * Output: result produced by this function.
 */
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

/**
 * Handles the saveMyProfile function logic.
 * Input: payload: any.
 * Output: result produced by this function.
 */
async function saveMyProfile(payload: any) {
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

/**
 * Handles the fetchUsers function logic.
 * Input: none.
 * Output: result produced by this function.
 */
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

/**
 * Handles the createUserRequest function logic.
 * Input: payload: any.
 * Output: result produced by this function.
 */
async function createUserRequest(payload: any) {
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

/**
 * Handles the updateUserRequest function logic.
 * Input: username: any, payload: any.
 * Output: result produced by this function.
 */
async function updateUserRequest(username: any, payload: any) {
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

/**
 * Handles the deleteUserRequest function logic.
 * Input: username: any.
 * Output: result produced by this function.
 */
async function deleteUserRequest(username: any) {
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

/**
 * Handles the sortFolderIds function logic.
 * Input: folders: any.
 * Output: result produced by this function.
 */
function sortFolderIds(folders: any) {
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

/**
 * Handles the folderLabel function logic.
 * Input: folderId: any.
 * Output: result produced by this function.
 */
function folderLabel(folderId: any) {
  if (folderId === "personal") {
    return "Personal";
  }
  if (!folderId) {
    return "Root";
  }
  return folderId;
}

/**
 * Handles the normalizeSpaceFolder function logic.
 * Input: folder: any.
 * Output: result produced by this function.
 */
function normalizeSpaceFolder(folder: any) {
  if (typeof folder !== "string") {
    return "";
  }
  return folder.trim().replace(/^\/+|\/+$/g, "");
}

/**
 * Handles the buildSpacePath function logic.
 * Input: spaceId: any, folder: any = "".
 * Output: result produced by this function.
 */
function buildSpacePath(spaceId: any, folder: any = "") {
  const id = typeof spaceId === "string" ? spaceId.trim() : "";
  if (!id) {
    return "";
  }
  const normalizedFolder = normalizeSpaceFolder(folder);
  return normalizedFolder ? `${normalizedFolder}/${id}` : id;
}

/**
 * Handles the resolveSpacePath function logic.
 * Input: space: any.
 * Output: result produced by this function.
 */
function resolveSpacePath(space: any) {
  if (!space || typeof space !== "object") {
    return "";
  }
  const explicit = typeof space.path === "string" ? space.path.trim() : "";
  if (explicit) {
    return explicit;
  }
  return buildSpacePath(space.id, space.folder);
}

/**
 * Handles the getAssignableSpaces function logic.
 * Input: none.
 * Output: string[].
 */
function getAssignableSpaces(): string[] {
  const source = Array.isArray(collab.spaceAccessOptions) ? collab.spaceAccessOptions : [];
  const names: string[] = source.filter((item: any): item is string => typeof item === "string");
  return [...new Set<string>(names)].sort((a: string, b: string) => a.localeCompare(b));
}

/**
 * Handles the isPersonalFolderPath function logic.
 * Input: path: any.
 * Output: result produced by this function.
 */
function isPersonalFolderPath(path: any) {
  const normalized = typeof path === "string" ? path.trim() : "";
  return normalized === "personal" || normalized.startsWith("personal/");
}

/**
 * Handles the buildAssignableAccessOptions function logic.
 * Input: spaces: any[] = [], folders: any[] = [].
 * Output: result produced by this function.
 */
function buildAssignableAccessOptions(spaces: any[] = [], folders: any[] = []) {
  const options = new Set<string>();
  (Array.isArray(folders) ? folders : []).forEach((folder: any) => {
    const normalized = typeof folder === "string" ? folder.trim() : "";
    if (!normalized || isPersonalFolderPath(normalized)) {
      return;
    }
    options.add(`${normalized}/*`);
  });
  (Array.isArray(spaces) ? spaces : []).forEach((space: any) => {
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
  return [...options].sort((a: string, b: string) => a.localeCompare(b));
}

/**
 * Handles the isPersonalFolderId function logic.
 * Input: folderId: any.
 * Output: result produced by this function.
 */
function isPersonalFolderId(folderId: any) {
  const normalized = typeof folderId === "string" ? folderId.trim() : "";
  return normalized === "personal" || normalized.startsWith("personal/");
}

/**
 * Handles the renderSpaceList function logic.
 * Input: spaces: any, folders: any[] = [].
 * Output: result produced by this function.
 */
function renderSpaceList(spaces: any, folders: any[] = []) {
  if (!dom.spaceList) {
    return;
  }
  const canManageSpaces = collab.permissions.can_manage_spaces;
  dom.spaceList.innerHTML = "";
  const allSpaces = Array.isArray(spaces)
    ? [...spaces].sort((a: any, b: any) => resolveSpacePath(a).localeCompare(resolveSpacePath(b)))
    : [];
  const grouped = new Map();
  allSpaces.forEach((space: any) => {
    const rawFolderId = typeof space.folder === "string" ? space.folder.trim() : "";
    const folderId = space?.personal ? "personal" : rawFolderId;
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
  const folderSet = new Set<string>();
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
  childrenByParent.forEach((items: any[]) => {
    items.sort((a: any, b: any) => {
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
    ? allSpaces.find((space: any) => resolveSpacePath(space) === activeSpacePath)
    : (activeSpaceId ? allSpaces.find((space: any) => space.id === activeSpaceId) : null);
  const activeFolderCandidate =
    activeSpaceEntry
      ? (activeSpaceEntry.personal
          ? "personal"
          : (typeof activeSpaceEntry.folder === "string" ? activeSpaceEntry.folder.trim() : ""))
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

  /**
   * Handles the isExpandedFolder function logic.
   * Input: folderId: any.
   * Output: result produced by this function.
   */
  const isExpandedFolder = (folderId: any) => {
    if (!collab.openSpaceFolderId) {
      return false;
    }
    return (
      collab.openSpaceFolderId === folderId
      || collab.openSpaceFolderId.startsWith(`${folderId}/`)
    );
  };

  /**
   * Handles the renderSpaceRow function logic.
   * Input: space: any, container: any.
   * Output: result produced by this function.
   */
  const renderSpaceRow = (space: any, container: any) => {
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
          await moveSpaceToFolderRequest(draggedSpaceId, targetFolder, draggedSpacePath);
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
    /**
     * Handles the commitRename function logic.
     * Input: none.
     * Output: result produced by this function.
     */
    const commitRename = async () => {
      const trimmed = input.value.trim();
      if (!trimmed || trimmed === space.id) {
        row.classList.remove("editing");
        return;
      }
      try {
        const newSpacePath = buildSpacePath(trimmed, space.folder || "");
        await renameSpace(space.id, trimmed, spacePath);
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
      connectedUsers.forEach((user: any) => {
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

  /**
   * Handles the renderFolder function logic.
   * Input: folderId: any, parentId: any, container: any.
   * Output: result produced by this function.
   */
  const renderFolder = (folderId: any, parentId: any, container: any) => {
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

    /**
     * Handles the moveSpaceToFolder function logic.
     * Input: spaceId: any, sourcePath: any = "".
     * Output: result produced by this function.
     */
    const moveSpaceToFolder = async (spaceId: any, sourcePath: any = "") => {
      if (!spaceId) {
        return;
      }
      try {
        await moveSpaceToFolderRequest(spaceId, folderId, sourcePath);
        clearSpaceError();
        await loadSpaceList({ showLoading: false });
        const fromPath = sourcePath || spaceId;
        const toPath = buildSpacePath(spaceId, folderId);
        showToast(`Space '${fromPath}' moved to '${toPath}'.`);
      } catch (error) {
        setSpaceError(formatSpaceError(error, "Unable to move space."));
      }
    };

    /**
     * Handles the attachDropTarget function logic.
     * Input: targetEl: any.
     * Output: result produced by this function.
     */
    const attachDropTarget = (targetEl: any) => {
      if (!targetEl || !canManageSpaces || isPersonalFolderId(folderId)) {
        return;
      }
      targetEl.addEventListener("dragover", (event: any) => {
        event.preventDefault();
        folderBlock.classList.add("drag-over");
      });
      targetEl.addEventListener("dragleave", () => {
        folderBlock.classList.remove("drag-over");
      });
      targetEl.addEventListener("drop", async (event: any) => {
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
      removeFolder.addEventListener("click", (event: any) => {
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

    childFolders.forEach((child: any) => {
      renderFolder(child.id, folderId, folderBody);
    });

    folderSpaces.forEach((space: any) => {
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
        await moveSpaceToFolderRequest(draggedSpaceId, "", draggedSpacePath);
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
  rootFolders.forEach((folder: any) => {
    renderFolder(folder.id, "", dom.spaceList);
  });
  const rootSpaces = grouped.get("") || [];
  rootSpaces.forEach((space: any) => {
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

/**
 * Handles the loadSpaceList function logic.
 * Input: { showLoading = true } = {}.
 * Output: result produced by this function.
 */
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
        ? spaces.find((space: any) => resolveSpacePath(space) === collab.spacePath)
        : null;
      const currentById = spaces.find((space: any) => space.id === collab.spaceId);
      const current = currentByPath || currentById || null;
      const nextPath = current ? resolveSpacePath(current) : (collab.spacePath || collab.spaceId);
      if (nextPath !== collab.spacePath) {
        collab.spacePath = nextPath;
        updateBoardConnectionLabel();
      }
    }
    collab.spaceIds = spaces.map((space: any) => space.id).filter(Boolean).sort((a: any, b: any) => a.localeCompare(b));
    collab.spaceFolders = folders;
    collab.spaceAccessOptions = buildAssignableAccessOptions(spaces, folders);
    if (createUserSpacesPicker) {
      createUserSpacesPicker.refreshOptions();
    }
    const snapshot = JSON.stringify(
      {
        spaces: spaces.map((space: any) => ({
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

/**
 * Handles the setSpaceError function logic.
 * Input: message: any.
 * Output: result produced by this function.
 */
function setSpaceError(message: any) {
  setInlineToastError(dom.spaceError, message);
}

/**
 * Handles the clearSpaceError function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function clearSpaceError() {
  resetInlineError(dom.spaceError);
}

/**
 * Handles the setJiraConfigError function logic.
 * Input: message: any.
 * Output: result produced by this function.
 */
function setJiraConfigError(message: any) {
  setInlineToastError(dom.jiraConfigError, message);
}

/**
 * Handles the clearJiraConfigError function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function clearJiraConfigError() {
  resetInlineError(dom.jiraConfigError);
}

/**
 * Handles the fillJiraConfigForm function logic.
 * Input: config: any.
 * Output: result produced by this function.
 */
function fillJiraConfigForm(config: any) {
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

/**
 * Handles the readJiraConfigForm function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function readJiraConfigForm() {
  return {
    base_url: dom.jiraConfigBaseUrl?.value?.trim() || "",
    email: dom.jiraConfigEmail?.value?.trim() || "",
    token: dom.jiraConfigToken?.value || "",
  };
}

/**
 * Handles the openJiraConfigModal function logic.
 * Input: none.
 * Output: result produced by this function.
 */
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

/**
 * Handles the closeJiraConfigModal function logic.
 * Input: { reopenSpaces = true } = {}.
 * Output: result produced by this function.
 */
function closeJiraConfigModal({ reopenSpaces = true } = {}) {
  if (!dom.jiraConfigModal) {
    return;
  }
  dom.jiraConfigModal.classList.add("hidden");
  if (reopenSpaces) {
    openSpacesModal();
  }
}

/**
 * Handles the submitJiraConfig function logic.
 * Input: none.
 * Output: result produced by this function.
 */
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

/**
 * Handles the setUsersError function logic.
 * Input: message: any.
 * Output: result produced by this function.
 */
function setUsersError(message: any) {
  setInlineToastError(dom.usersError, message);
}

/**
 * Handles the clearUsersError function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function clearUsersError() {
  resetInlineError(dom.usersError);
}

/**
 * Handles the setProfileError function logic.
 * Input: message: any.
 * Output: result produced by this function.
 */
function setProfileError(message: any) {
  setInlineToastError(dom.profileError, message);
}

/**
 * Handles the clearProfileError function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function clearProfileError() {
  resetInlineError(dom.profileError);
}

/**
 * Handles the setUserCreateError function logic.
 * Input: message: any.
 * Output: result produced by this function.
 */
function setUserCreateError(message: any) {
  setInlineToastError(dom.userCreateError, message);
}

/**
 * Handles the clearUserCreateError function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function clearUserCreateError() {
  resetInlineError(dom.userCreateError);
}

/**
 * Handles the setUserPasswordError function logic.
 * Input: message: any.
 * Output: result produced by this function.
 */
function setUserPasswordError(message: any) {
  setInlineToastError(dom.userPasswordError, message);
}

/**
 * Handles the clearUserPasswordError function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function clearUserPasswordError() {
  resetInlineError(dom.userPasswordError);
}

/**
 * Handles the roleUsesSpaces function logic.
 * Input: role: any.
 * Output: result produced by this function.
 */
function roleUsesSpaces(role: any) {
  return String(role || "user").toLowerCase() === "user";
}

/**
 * Handles the updateCreateUserSpacesVisibility function logic.
 * Input: none.
 * Output: result produced by this function.
 */
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

/**
 * Handles the openUserDeleteModal function logic.
 * Input: userEntry: any.
 * Output: result produced by this function.
 */
function openUserDeleteModal(userEntry: any) {
  if (!dom.userDeleteModal || !dom.userDeleteMessage || !userEntry) {
    return;
  }
  pendingDeleteUser = userEntry;
  dom.userDeleteMessage.textContent = `Remove user "${userEntry.username}"? This cannot be undone.`;
  dom.userDeleteModal.classList.remove("hidden");
}

/**
 * Handles the closeUserDeleteModal function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function closeUserDeleteModal() {
  if (!dom.userDeleteModal) {
    return;
  }
  dom.userDeleteModal.classList.add("hidden");
  pendingDeleteUser = null;
}

/**
 * Handles the openUserCreateModal function logic.
 * Input: none.
 * Output: result produced by this function.
 */
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

/**
 * Handles the closeUserCreateModal function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function closeUserCreateModal() {
  if (!dom.userCreateModal) {
    return;
  }
  dom.userCreateModal.classList.add("hidden");
}

/**
 * Handles the openUserPasswordModal function logic.
 * Input: userEntry: any.
 * Output: result produced by this function.
 */
function openUserPasswordModal(userEntry: any) {
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

/**
 * Handles the closeUserPasswordModal function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function closeUserPasswordModal() {
  if (!dom.userPasswordModal) {
    return;
  }
  dom.userPasswordModal.classList.add("hidden");
  pendingPasswordUser = null;
  clearUserPasswordError();
}

/**
 * Handles the submitUserPasswordChange function logic.
 * Input: none.
 * Output: result produced by this function.
 */
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

/**
 * Handles the confirmDeleteUser function logic.
 * Input: none.
 * Output: result produced by this function.
 */
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

/**
 * Handles the normalizeSelectedSpaces function logic.
 * Input: values: any.
 * Output: string[].
 */
function normalizeSelectedSpaces(values: any): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  values.forEach((item: any) => {
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

/**
 * Handles the createSpacePicker function logic.
 * Input: { selected = [], getOptions = (): string[] => [], placeholder = "Search access paths", onChange = null, }: { selected?: string[]; getOptions?: () => string[]; placeholder?: string; onChange?: ((nextValues: string[]) => void) | null; } = {}.
 * Output: result produced by this function.
 */
function createSpacePicker({
  selected = [],
  getOptions = (): string[] => [],
  placeholder = "Search access paths",
  onChange = null,
}: {
  selected?: string[];
  getOptions?: () => string[];
  placeholder?: string;
  onChange?: ((nextValues: string[]) => void) | null;
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
  /**
   * Handles the emitChange function logic.
   * Input: none.
   * Output: result produced by this function.
   */
  const emitChange = () => {
    if (typeof onChange === "function") {
      onChange([...values]);
    }
  };

  const options = (): string[] =>
    [...new Set(getOptions().filter((name) => typeof name === "string" && name.trim()))].sort(
      (a, b) => a.localeCompare(b)
    );

  const suggestionList = (): string[] => {
    const query = input.value.trim().toLowerCase();
    return options().filter(
      (name) =>
        !values.includes(name) &&
        (!query || name.toLowerCase().includes(query))
    );
  };

  /**
   * Handles the render function logic.
   * Input: none.
   * Output: result produced by this function.
   */
  const render = () => {
    tags.innerHTML = "";
      values.forEach((name: string) => {
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
        suggestions.forEach((name: string) => {
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
    /**
     * Handles the getValues function logic.
     * Input: none.
     * Output: result produced by this function.
     */
    getValues() {
      return [...values];
    },
    /**
     * Handles the setValues function logic.
     * Input: nextValues: any.
     * Output: result produced by this function.
     */
    setValues(nextValues: any) {
      values = normalizeSelectedSpaces(nextValues);
      render();
      emitChange();
    },
    /**
     * Handles the setDisabled function logic.
     * Input: nextDisabled: any.
     * Output: result produced by this function.
     */
    setDisabled(nextDisabled: any) {
      isDisabled = Boolean(nextDisabled);
      if (isDisabled) {
        isOpen = false;
      }
      render();
    },
    /**
     * Handles the refreshOptions function logic.
     * Input: none.
     * Output: result produced by this function.
     */
    refreshOptions() {
      render();
    },
  };
}

/**
 * Handles the ensureCreateUserSpacesPicker function logic.
 * Input: none.
 * Output: result produced by this function.
 */
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

/**
 * Handles the roleOptionsMarkup function logic.
 * Input: selectedRole: any, allowAdminRoles: boolean = true.
 * Output: result produced by this function.
 */
function roleOptionsMarkup(selectedRole: any, allowAdminRoles: boolean = true) {
  const roles = allowAdminRoles ? ["admin", "manager", "user"] : ["user"];
  return roles
    .map((role) => `<option value="${role}"${role === selectedRole ? " selected" : ""}>${role}</option>`)
    .join("");
}

/**
 * Handles the renderUsersList function logic.
 * Input: users: any.
 * Output: result produced by this function.
 */
function renderUsersList(users: any) {
  if (!dom.usersList) {
    return;
  }
  dom.usersList.innerHTML = "";
  const visibleUsers = Array.isArray(users)
    ? users.filter((entry: any) => !(entry && entry.self))
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
      /**
       * Handles the onChange function logic.
       * Input: none.
       * Output: result produced by this function.
       */
      onChange: () => {
        refreshSaveButtonState();
      },
    });
    spacesField.appendChild(spacesPicker.root);

    const editable = Boolean(entry.editable);
    const self = Boolean(entry.self);
    const allowRoleAndSpaces = editable && !self;
    const normalizePaths = (paths: any): string[] =>
      normalizeSelectedSpaces(paths).sort((a: string, b: string) => a.localeCompare(b));
    /**
     * Handles the areEqualPaths function logic.
     * Input: left: string[], right: string[].
     * Output: result produced by this function.
     */
    const areEqualPaths = (left: string[], right: string[]) =>
      left.length === right.length && left.every((item, index) => item === right[index]);

    let saveBtn: HTMLButtonElement | null = null;
    /**
     * Handles the isUserDirty function logic.
     * Input: none.
     * Output: result produced by this function.
     */
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
    /**
     * Handles the refreshSaveButtonState function logic.
     * Input: none.
     * Output: result produced by this function.
     */
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
    /**
     * Handles the updateSpacesVisibility function logic.
     * Input: none.
     * Output: result produced by this function.
     */
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
        const payload: any = {
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

/**
 * Handles the loadUsersModalData function logic.
 * Input: { refreshSpaces = false } = {}.
 * Output: result produced by this function.
 */
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
        .map((space: any) => space.id)
        .filter(Boolean)
        .sort((a: any, b: any) => a.localeCompare(b));
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

/**
 * Handles the openUsersModal function logic.
 * Input: none.
 * Output: result produced by this function.
 */
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

/**
 * Handles the closeUsersModal function logic.
 * Input: { reopenSpaces = true } = {}.
 * Output: result produced by this function.
 */
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

/**
 * Handles the openProfileLogoutModal function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function openProfileLogoutModal() {
  if (!dom.profileLogoutModal) {
    return;
  }
  dom.profileLogoutModal.classList.remove("hidden");
}

/**
 * Handles the closeProfileLogoutModal function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function closeProfileLogoutModal() {
  if (!dom.profileLogoutModal) {
    return;
  }
  dom.profileLogoutModal.classList.add("hidden");
}

/**
 * Handles the loadProfileModalData function logic.
 * Input: none.
 * Output: result produced by this function.
 */
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

/**
 * Handles the openProfileModal function logic.
 * Input: none.
 * Output: result produced by this function.
 */
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

/**
 * Handles the closeProfileModal function logic.
 * Input: { reopenSpaces = true } = {}.
 * Output: result produced by this function.
 */
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

/**
 * Handles the submitProfileUpdate function logic.
 * Input: none.
 * Output: result produced by this function.
 */
async function submitProfileUpdate() {
  clearProfileError();
  const previousDisplayName = collab.displayName || "";
  const payload: any = {
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

/**
 * Handles the submitCreateUser function logic.
 * Input: none.
 * Output: result produced by this function.
 */
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
  const payload: any = {
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

/**
 * Handles the openSpaceCreateModal function logic.
 * Input: none.
 * Output: result produced by this function.
 */
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

/**
 * Handles the closeSpaceCreateModal function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function closeSpaceCreateModal() {
  if (!dom.spaceCreateModal) {
    return;
  }
  dom.spaceCreateModal.classList.add("hidden");
}

/**
 * Handles the openSpaceFolderCreateModal function logic.
 * Input: none.
 * Output: result produced by this function.
 */
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

/**
 * Handles the closeSpaceFolderCreateModal function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function closeSpaceFolderCreateModal() {
  if (!dom.spaceFolderCreateModal) {
    return;
  }
  dom.spaceFolderCreateModal.classList.add("hidden");
}

/**
 * Handles the updateCreateSpaceButton function logic.
 * Input: none.
 * Output: result produced by this function.
 */
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

/**
 * Handles the updateCreateFolderButton function logic.
 * Input: none.
 * Output: result produced by this function.
 */
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

/**
 * Handles the getCurrentFolderForCreate function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function getCurrentFolderForCreate() {
  const folderId =
    typeof collab.openSpaceFolderId === "string"
      ? collab.openSpaceFolderId.trim()
      : "";
  return folderId || "";
}

/**
 * Handles the submitCreateSpace function logic.
 * Input: none.
 * Output: result produced by this function.
 */
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
      await moveSpaceToFolderRequest(name, targetFolder, name);
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

/**
 * Handles the submitCreateFolder function logic.
 * Input: none.
 * Output: result produced by this function.
 */
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

/**
 * Handles the confirmDeleteFolder function logic.
 * Input: none.
 * Output: result produced by this function.
 */
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

/**
 * Handles the openDeleteModal function logic.
 * Input: spaceRef: any.
 * Output: result produced by this function.
 */
function openDeleteModal(spaceRef: any) {
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

/**
 * Handles the closeDeleteModal function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function closeDeleteModal() {
  if (!dom.deleteModal) {
    return;
  }
  dom.deleteModal.classList.add("hidden");
  pendingDeleteSpace = null;
}

/**
 * Handles the openFolderDeleteModal function logic.
 * Input: folderId: any.
 * Output: result produced by this function.
 */
function openFolderDeleteModal(folderId: any) {
  if (!dom.folderDeleteModal || !dom.folderDeleteMessage) {
    return;
  }
  pendingDeleteFolder = folderId;
  dom.folderDeleteMessage.textContent = `Delete folder "${folderId}"? Only empty folders can be deleted.`;
  dom.folderDeleteModal.classList.remove("hidden");
}

/**
 * Handles the closeFolderDeleteModal function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function closeFolderDeleteModal() {
  if (!dom.folderDeleteModal) {
    return;
  }
  dom.folderDeleteModal.classList.add("hidden");
  pendingDeleteFolder = null;
}

/**
 * Handles the formatSpaceError function logic.
 * Input: error: any, fallback: any.
 * Output: result produced by this function.
 */
function formatSpaceError(error: any, fallback: any) {
  if (error instanceof Error && error.message) {
    if (error.message === "Failed to fetch") {
      return "Unable to reach the backend.";
    }
    return error.message;
  }
  return fallback;
}

/**
 * Handles the loadSpaceText function logic.
 * Input: spaceId: any.
 * Output: result produced by this function.
 */
async function loadSpaceText(spaceId: any) {
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

/**
 * Handles the attemptLogin function logic.
 * Input: none.
 * Output: result produced by this function.
 */
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

/**
 * Handles the restoreSessionFromCookie function logic.
 * Input: none.
 * Output: result produced by this function.
 */
async function restoreSessionFromCookie() {
  try {
    const me = await fetchMe();
    applySessionFromServer(me);
    collab.isAuthenticated = true;
    collab.authToken = "";
    updateConnectButtonLabel();
    const allowedSpaces = Array.isArray(me.spaces)
      ? me.spaces.filter((spaceId: any) => typeof spaceId === "string")
      : [];
    const lastSpace =
      typeof me.last_space === "string" ? me.last_space.trim() : "";
    const storedLastSpace = getStoredLastSpaceRef();
    let restoreSpaceId = "";
    let restoreSpacePath = "";
    if (lastSpace && allowedSpaces.includes(lastSpace)) {
      restoreSpaceId = lastSpace;
      if (storedLastSpace && storedLastSpace.id === lastSpace) {
        restoreSpacePath = storedLastSpace.path || lastSpace;
      }
    } else if (storedLastSpace && allowedSpaces.includes(storedLastSpace.id)) {
      restoreSpaceId = storedLastSpace.id;
      restoreSpacePath = storedLastSpace.path || storedLastSpace.id;
    }
    if (restoreSpaceId) {
      try {
        await connectToSpace(restoreSpaceId, restoreSpacePath || restoreSpaceId, { showLoader: false });
      } catch {
        showToast("Failed to reconnect to the last space.", "error");
      }
    }
  } catch {
    collab.isAuthenticated = false;
    collab.mustChangePassword = false;
    collab.permissions = normalizePermissions(null);
    updateRoleVisibility();
    updateConnectButtonLabel();
  }
}

/**
 * Handles the logout function logic.
 * Input: none.
 * Output: result produced by this function.
 */
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

/**
 * Handles the spaceResponseError function logic.
 * Input: response: any, fallback: any.
 * Output: result produced by this function.
 */
function spaceResponseError(response: any, fallback: any) {
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

/**
 * Handles the userResponseError function logic.
 * Input: response: any, fallback: any.
 * Output: result produced by this function.
 */
function userResponseError(response: any, fallback: any) {
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

/**
 * Handles the createSpace function logic.
 * Input: name: any.
 * Output: result produced by this function.
 */
async function createSpace(name: any) {
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

/**
 * Handles the deleteSpace function logic.
 * Input: name: any, spacePath: any = "".
 * Output: result produced by this function.
 */
async function deleteSpace(name: any, spacePath: any = "") {
  const trimmed = String(name || "").trim();
  const normalizedSpacePath = typeof spacePath === "string" ? spacePath.trim() : "";
  if (!trimmed) {
    return;
  }
  applyAuthFromInputs({ markDirty: false });
  const pathQuery = normalizedSpacePath ? `?path=${encodeURIComponent(normalizedSpacePath)}` : "";
  const response = await fetch(`${REMOTE_BASE}/api/spaces/${encodeURIComponent(trimmed)}${pathQuery}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!response.ok) {
    throw new Error(spaceResponseError(response, "Unable to remove space."));
  }
  if (
    collab.spaceId === trimmed
    && (!normalizedSpacePath || !collab.spacePath || collab.spacePath === normalizedSpacePath)
  ) {
    disconnectSpace();
  }
  await loadSpaceList({ showLoading: false });
}

/**
 * Handles the renameSpace function logic.
 * Input: oldName: any, newName: any, oldPath: any = "".
 * Output: result produced by this function.
 */
async function renameSpace(oldName: any, newName: any, oldPath: any = "") {
  const source = oldName.trim();
  const target = newName.trim();
  const sourcePath = typeof oldPath === "string" ? oldPath.trim() : "";
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
      body: JSON.stringify(sourcePath ? { name: target, path: sourcePath } : { name: target }),
    }
  );
  if (!response.ok) {
    throw new Error(spaceResponseError(response, "Unable to rename space."));
  }
}

/**
 * Handles the startPresenceHeartbeat function logic.
 * Input: spaceId: any.
 * Output: result produced by this function.
 */
function startPresenceHeartbeat(spaceId: any) {
  void spaceId;
  if (collab.presenceTimer) {
    clearInterval(collab.presenceTimer);
    collab.presenceTimer = null;
  }
  // Space-list presence is derived from Yjs awareness on the backend now.
}

/**
 * Handles the stopPresenceHeartbeat function logic.
 * Input: spaceId: any.
 * Output: result produced by this function.
 */
function stopPresenceHeartbeat(spaceId: any) {
  void spaceId;
  if (collab.presenceTimer) {
    clearInterval(collab.presenceTimer);
    collab.presenceTimer = null;
  }
}

/**
 * Handles the openLoginModal function logic.
 * Input: none.
 * Output: result produced by this function.
 */
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

/**
 * Handles the closeLoginModal function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function closeLoginModal() {
  if (!dom.loginModal) {
    return;
  }
  dom.loginModal.classList.add("hidden");
}

/**
 * Handles the openSpacesModal function logic.
 * Input: none.
 * Output: result produced by this function.
 */
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

/**
 * Handles the closeSpacesModal function logic.
 * Input: none.
 * Output: result produced by this function.
 */
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

/**
 * Handles the updateConnectButtonLabel function logic.
 * Input: none.
 * Output: result produced by this function.
 */
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
    const labels = Array.from(dom.connectButton.querySelectorAll("span")) as HTMLElement[];
    let label: HTMLElement | null = labels[0] || null;
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

/**
 * Handles the disconnectSpace function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function disconnectSpace() {
  syncEngine.disconnectSpace();
  updateHistoryButtonState();
}

/**
 * Handles the hydrateFromRemote function logic.
 * Input: spaceId: any, ytext: any.
 * Output: result produced by this function.
 */
async function hydrateFromRemote(spaceId: any, ytext: any) {
  return syncEngine.hydrateFromRemote(spaceId, ytext);
}

/**
 * Handles the scheduleCollabSync function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function scheduleCollabSync() {
  syncEngine.scheduleCollabSync();
}

/**
 * Handles the connectToSpace function logic.
 * Input: spaceId: any, spacePath: any = "", { showLoader = true }: { showLoader?: boolean } = {}.
 * Output: result produced by this function.
 */
async function connectToSpace(
  spaceId: any,
  spacePath: any = "",
  { showLoader = true }: { showLoader?: boolean } = {}
) {
  if (showLoader) {
    setBootLoaderVisible(true, "Connecting to board...");
  }
  try {
    const result = await syncEngine.connectToSpace(spaceId, spacePath);
    if (collab.spaceId) {
      setStoredLastSpaceRef(collab.spaceId, collab.spacePath || spacePath || collab.spaceId);
      if (showLoader) {
        await waitForInitialConnectionReady();
      }
    }
    updateHistoryButtonState();
    return result;
  } finally {
    if (showLoader) {
      setBootLoaderVisible(false);
    }
  }
}

/**
 * Handles the historyCheckpointDisplayLabel function logic.
 * Input: checkpoint: any.
 * Output: string.
 */
function historyCheckpointDisplayLabel(checkpoint: any): string {
  if (!checkpoint || typeof checkpoint !== "object") {
    return "";
  }
  const formatHistoryDateTime = (date: Date): string => {
    const day = String(date.getDate()).padStart(2, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const year = String(date.getFullYear());
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${day}.${month}.${year} ${hours}:${minutes}`;
  };
  const ts = typeof checkpoint.created_at_iso === "string" && checkpoint.created_at_iso
    ? checkpoint.created_at_iso
    : (typeof checkpoint.created_at === "number"
      ? new Date(checkpoint.created_at * 1000).toISOString()
      : "");
  const date = ts ? new Date(ts) : null;
  const dateLabel = date && Number.isFinite(date.getTime())
    ? formatHistoryDateTime(date)
    : (ts || "Unknown time");
  const customLabel = typeof checkpoint.label === "string" && checkpoint.label.trim()
    ? checkpoint.label.trim()
    : "";
  return customLabel ? `${customLabel} · ${dateLabel}` : dateLabel;
}

/**
 * Handles the historyCheckpointTimestamp function logic.
 * Input: checkpoint: any.
 * Output: number | null.
 */
function historyCheckpointTimestamp(checkpoint: any): number | null {
  if (checkpoint && Number.isFinite(checkpoint.created_at)) {
    return Number(checkpoint.created_at);
  }
  if (typeof checkpoint?.created_at_iso === "string" && checkpoint.created_at_iso) {
    const ts = Date.parse(checkpoint.created_at_iso);
    if (Number.isFinite(ts)) {
      return Math.floor(ts / 1000);
    }
  }
  return null;
}

/**
 * Handles the getHistoryTimelineBounds function logic.
 * Input: checkpoints: any[].
 * Output: result produced by this function.
 */
function getHistoryTimelineBounds(checkpoints: any[]): { min: number; max: number } {
  const times = checkpoints
    .map((checkpoint) => historyCheckpointTimestamp(checkpoint))
    .filter((value): value is number => Number.isFinite(value));
  if (!times.length) {
    return { min: 0, max: 1 };
  }
  const min = Math.min(...times);
  const max = Math.max(...times);
  if (max <= min) {
    return { min, max: min + 1 };
  }
  return { min, max };
}

/**
 * Handles the historySliderValueForIndex function logic.
 * Input: checkpoints: any[], index: number.
 * Output: number.
 */
function historySliderValueForIndex(checkpoints: any[], index: number): number {
  const selected = checkpoints?.[Math.max(0, Math.min((checkpoints?.length || 1) - 1, index))];
  const timestamp = historyCheckpointTimestamp(selected);
  if (Number.isFinite(timestamp)) {
    return Number(timestamp);
  }
  const bounds = getHistoryTimelineBounds(checkpoints || []);
  if ((checkpoints?.length || 0) <= 1) {
    return bounds.min;
  }
  const ratio = Math.max(0, Math.min(1, index / ((checkpoints.length - 1) || 1)));
  return Math.round(bounds.min + (bounds.max - bounds.min) * ratio);
}

/**
 * Handles the findNearestHistoryCheckpointIndexByTime function logic.
 * Input: checkpoints: any[], value: number.
 * Output: number.
 */
function findNearestHistoryCheckpointIndexByTime(checkpoints: any[], value: number): number {
  if (!Array.isArray(checkpoints) || !checkpoints.length) {
    return -1;
  }
  const target = Number(value);
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  checkpoints.forEach((checkpoint, index) => {
    const ts = historyCheckpointTimestamp(checkpoint);
    const compare = Number.isFinite(ts) ? Number(ts) : historySliderValueForIndex(checkpoints, index);
    const distance = Math.abs(compare - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

/**
 * Handles the updateHistoryViewerBanner function logic.
 * Input: none.
 * Output: void.
 */
function updateHistoryViewerBanner(): void {
  const banner = dom.historyViewerBanner;
  const label = dom.historyViewerBannerLabel;
  if (!banner || !label) {
    return;
  }
  if (!historyMode.viewerActive) {
    banner.classList.add("hidden");
    return;
  }
  const checkpoints = Array.isArray(historyMode.checkpoints) ? historyMode.checkpoints : [];
  const selected = checkpoints[Math.max(0, Math.min(historyMode.selectedIndex, checkpoints.length - 1))];
  label.textContent = selected ? historyCheckpointDisplayLabel(selected) : "Unknown time";
  banner.classList.remove("hidden");
}

/**
 * Handles the setHistoryViewerButtonsDisabled function logic.
 * Input: disabled: boolean.
 * Output: void.
 */
function setHistoryViewerButtonsDisabled(disabled: boolean): void {
  const buttons = [dom.undoButton, dom.redoButton, dom.loadButton, dom.saveButton, dom.formatButton, dom.graphAddTask]
    .filter((button): button is HTMLButtonElement => Boolean(button));
  if (disabled) {
    historyMode.disabledButtons = new Map();
    buttons.forEach((button) => {
      historyMode.disabledButtons.set(button, Boolean(button.disabled));
      button.disabled = true;
    });
    return;
  }
  buttons.forEach((button) => {
    const previous = historyMode.disabledButtons?.get?.(button);
    button.disabled = Boolean(previous);
  });
  historyMode.disabledButtons = new Map();
}

/**
 * Handles the setHistoryViewerMode function logic.
 * Input: active: boolean.
 * Output: void.
 */
function setHistoryViewerMode(active: boolean): void {
  const next = Boolean(active);
  if (historyMode.viewerActive === next) {
    return;
  }
  historyMode.viewerActive = next;
  state.historyViewerActive = next;
  document.documentElement.toggleAttribute("data-history-viewer", next);
  dom.boardHistoryMode?.classList.toggle("hidden", !next);
  updateBoardConnectionLabel();
  if (next) {
    const activeEl = document.activeElement;
    if (activeEl instanceof HTMLElement) {
      activeEl.blur();
    }
  }
  editorController?.setReadOnly?.(next);
  setHistoryViewerButtonsDisabled(next);
  if (dom.historyRevertButton) {
    dom.historyRevertButton.disabled = !next;
  }
  updateResponsiveLayoutOffsets();
  updateHistoryViewerBanner();
  renderHistoryPanel();
}

/**
 * Handles the updateHistoryButtonState function logic.
 * Input: none.
 * Output: void.
 */
function updateHistoryButtonState(): void {
  if (!dom.historyButton) {
    return;
  }
  const available = Boolean(collab.spaceId && collab.isAuthenticated);
  dom.historyButton.disabled = historyMode.loading || !available;
}

/**
 * Handles the fetchSpaceHistoryList function logic.
 * Input: spaceId: string, spacePath = "".
 * Output: Promise<any[]>.
 */
async function fetchSpaceHistoryList(spaceId: string, spacePath = ""): Promise<any[]> {
  const pathQuery = spacePath ? `?path=${encodeURIComponent(spacePath)}` : "";
  const response = await fetch(`${REMOTE_BASE}/api/spaces/${encodeURIComponent(spaceId)}/history${pathQuery}`, {
    headers: authHeaders(),
  });
  if (!response.ok) {
    throw new Error(`History list request failed (${response.status})`);
  }
  const data = await response.json();
  return Array.isArray(data?.checkpoints) ? data.checkpoints : [];
}

/**
 * Handles the fetchSpaceHistoryCheckpointContent function logic.
 * Input: spaceId: string, checkpointId: string, spacePath = "".
 * Output: Promise<string>.
 */
async function fetchSpaceHistoryCheckpointContent(spaceId: string, checkpointId: string, spacePath = ""): Promise<string> {
  const pathQuery = spacePath ? `?path=${encodeURIComponent(spacePath)}` : "";
  const response = await fetch(
    `${REMOTE_BASE}/api/spaces/${encodeURIComponent(spaceId)}/history/${encodeURIComponent(checkpointId)}${pathQuery}`,
    { headers: authHeaders() }
  );
  if (!response.ok) {
    throw new Error(`History checkpoint request failed (${response.status})`);
  }
  return response.text();
}

/**
 * Handles the postSpaceHistoryRevert function logic.
 * Input: spaceId: string, checkpointId: string, preRevertContent: string, spacePath = "".
 * Output: Promise<any>.
 */
async function postSpaceHistoryRevert(
  spaceId: string,
  checkpointId: string,
  preRevertContent: string,
  spacePath = ""
): Promise<any> {
  const response = await fetch(
    `${REMOTE_BASE}/api/spaces/${encodeURIComponent(spaceId)}/history/revert`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify({
        checkpoint_id: checkpointId,
        pre_revert_content: preRevertContent,
        pre_revert_label: "revoked",
        path: spacePath || undefined,
      }),
    }
  );
  if (!response.ok) {
    throw new Error(`History revert failed (${response.status})`);
  }
  return response.json();
}

/**
 * Handles the postSpaceHistoryTag function logic.
 * Input: spaceId: string, options: { checkpointId?: string; label: string; content?: string; path?: string }.
 * Output: Promise<any>.
 */
async function postSpaceHistoryTag(
  spaceId: string,
  options: { checkpointId?: string; label: string; content?: string; path?: string }
): Promise<any> {
  const body: { label: string; checkpoint_id?: string; content?: string; path?: string } = {
    label: options.label,
  };
  if (typeof options.checkpointId === "string" && options.checkpointId) {
    body.checkpoint_id = options.checkpointId;
  }
  if (typeof options.content === "string") {
    body.content = options.content;
  }
  if (typeof options.path === "string" && options.path.trim()) {
    body.path = options.path.trim();
  }
  const response = await fetch(
    `${REMOTE_BASE}/api/spaces/${encodeURIComponent(spaceId)}/history/tag`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify(body),
    }
  );
  if (!response.ok) {
    throw new Error(`History tag failed (${response.status})`);
  }
  return response.json();
}

// Stores the historyPanelAnimationTimer module constant.
let historyPanelAnimationTimer: any = null;

/**
 * Handles the getHistoryPanelAnimationDurationMs function logic.
 * Input: none.
 * Output: number.
 */
function getHistoryPanelAnimationDurationMs(): number {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
    return 0;
  }
  return HISTORY_PANEL_ANIMATION_MS;
}

/**
 * Handles the clearHistoryPanelAnimationTimer function logic.
 * Input: none.
 * Output: void.
 */
function clearHistoryPanelAnimationTimer(): void {
  if (!historyPanelAnimationTimer) {
    return;
  }
  clearTimeout(historyPanelAnimationTimer);
  historyPanelAnimationTimer = null;
}

/**
 * Handles the startHistoryPanelOpenAnimation function logic.
 * Input: none.
 * Output: void.
 */
function startHistoryPanelOpenAnimation(): void {
  clearHistoryPanelAnimationTimer();
  historyMode.panelClosing = false;
  historyMode.panelOpening = true;
  renderHistoryPanel();
  const duration = getHistoryPanelAnimationDurationMs();
  if (duration <= 0) {
    historyMode.panelOpening = false;
    renderHistoryPanel();
    return;
  }
  requestAnimationFrame(() => {
    if (!historyMode.panelOpen) {
      return;
    }
    historyMode.panelOpening = false;
    renderHistoryPanel();
  });
}

/**
 * Handles the runHistoryPanelCloseAnimation function logic.
 * Input: none.
 * Output: Promise<void>.
 */
async function runHistoryPanelCloseAnimation(): Promise<void> {
  if (!dom.historyPanel) {
    return;
  }
  clearHistoryPanelAnimationTimer();
  historyMode.panelOpening = false;
  historyMode.panelClosing = true;
  renderHistoryPanel();
  const duration = getHistoryPanelAnimationDurationMs();
  if (duration <= 0) {
    return;
  }
  await new Promise<void>((resolve) => {
    historyPanelAnimationTimer = setTimeout(() => {
      historyPanelAnimationTimer = null;
      resolve();
    }, duration);
  });
}

/**
 * Handles the renderHistoryMarks function logic.
 * Input: none.
 * Output: void.
 */
function renderHistoryMarks(): void {
  if (!dom.historyMarks) {
    return;
  }
  dom.historyMarks.innerHTML = "";
  const checkpoints = Array.isArray(historyMode.checkpoints) ? historyMode.checkpoints : [];
  const bounds = getHistoryTimelineBounds(checkpoints);
  const span = Math.max(1, bounds.max - bounds.min);
  checkpoints.forEach((checkpoint: any, index: number) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "history-mark";
    if (index === historyMode.selectedIndex) {
      button.classList.add("active");
    }
    if (typeof checkpoint?.kind === "string") {
      button.dataset["kind"] = checkpoint.kind;
    }
    const label = historyCheckpointDisplayLabel(checkpoint);
    button.textContent = "";
    button.dataset["label"] = label;
    button.title = label;
    button.setAttribute("aria-label", label);
    const ts = historyCheckpointTimestamp(checkpoint);
    const percent = Number.isFinite(ts)
      ? Math.max(0, Math.min(100, ((Number(ts) - bounds.min) / span) * 100))
      : (checkpoints.length <= 1 ? 50 : (index / (checkpoints.length - 1)) * 100);
    button.style.left = `${percent}%`;
    button.addEventListener("click", () => {
      void selectHistoryCheckpoint(index);
    });
    dom.historyMarks?.appendChild(button);
  });
}

/**
 * Handles the renderHistoryPanel function logic.
 * Input: none.
 * Output: void.
 */
function renderHistoryPanel(): void {
  if (!dom.historyPanel || !dom.historySlider || !dom.historyCurrentLabel) {
    return;
  }
  const checkpoints = Array.isArray(historyMode.checkpoints) ? historyMode.checkpoints : [];
  const hasPoints = checkpoints.length > 0;
  const selected = hasPoints
    ? checkpoints[Math.max(0, Math.min(historyMode.selectedIndex, checkpoints.length - 1))]
    : null;
  const hasLoadedSnapshot = Boolean(
    historyMode.viewerActive
    && selected
    && typeof selected.id === "string"
  );
  const timelineBounds = getHistoryTimelineBounds(checkpoints);
  const shouldShowPanel = Boolean(historyMode.panelOpen || historyMode.panelOpening || historyMode.panelClosing);
  dom.historyPanel.classList.toggle("hidden", !shouldShowPanel);
  dom.historyPanel.classList.toggle(
    "history-panel-open",
    Boolean(historyMode.panelOpen && !historyMode.panelOpening && !historyMode.panelClosing)
  );
  dom.historySlider.disabled = !hasPoints;
  dom.historySlider.min = String(timelineBounds.min);
  dom.historySlider.max = String(timelineBounds.max);
  dom.historySlider.step = "1";
  dom.historySlider.value = String(
    hasPoints && historyMode.selectedIndex >= 0
      ? historySliderValueForIndex(checkpoints, historyMode.selectedIndex)
      : timelineBounds.min
  );
  if (dom.historyStepPrev) {
    dom.historyStepPrev.disabled = !hasPoints || historyMode.loading || historyMode.selectedIndex <= 0;
  }
  if (dom.historyStepNext) {
    dom.historyStepNext.disabled = !hasPoints || historyMode.loading || historyMode.selectedIndex < 0 || historyMode.selectedIndex >= checkpoints.length - 1;
  }
  if (dom.historyRevertButton) {
    dom.historyRevertButton.classList.toggle("hidden", !hasLoadedSnapshot);
    dom.historyRevertButton.disabled = !hasLoadedSnapshot || historyMode.loading;
  }
  if (!hasPoints) {
    dom.historyCurrentLabel.textContent = historyMode.loading ? "Loading history..." : "No history checkpoints for this space yet.";
    if (dom.historyRevertButton) {
      dom.historyRevertButton.textContent = "Revert";
    }
    if (dom.historyTagButton) {
      dom.historyTagButton.disabled = !Boolean(historyMode.panelOpen && historyMode.spaceId && !historyMode.loading);
    }
  } else {
    dom.historyCurrentLabel.textContent = selected
      ? historyCheckpointDisplayLabel(selected)
      : "Select a history point";
    if (dom.historyRevertButton) {
      dom.historyRevertButton.textContent = selected
        ? `Revert to ${historyCheckpointDisplayLabel(selected)}`
        : "Revert";
    }
    if (dom.historyTagButton) {
      dom.historyTagButton.disabled = !Boolean(historyMode.panelOpen && historyMode.spaceId && !historyMode.loading);
    }
  }
  updateHistoryViewerBanner();
  renderHistoryMarks();
}

/**
 * Handles the stepHistorySelection function logic.
 * Input: delta: number.
 * Output: Promise<void>.
 */
async function stepHistorySelection(delta: number): Promise<void> {
  const checkpoints = Array.isArray(historyMode.checkpoints) ? historyMode.checkpoints : [];
  if (!checkpoints.length) {
    return;
  }
  const current = Number.isFinite(historyMode.selectedIndex) ? historyMode.selectedIndex : -1;
  const fallback = checkpoints.length - 1;
  const baseIndex = current >= 0 ? current : fallback;
  const nextIndex = Math.max(0, Math.min(checkpoints.length - 1, baseIndex + (delta < 0 ? -1 : 1)));
  if (nextIndex === current) {
    return;
  }
  await selectHistoryCheckpoint(nextIndex);
}

/**
 * Handles the selectHistoryCheckpoint function logic.
 * Input: index: number.
 * Output: Promise<void>.
 */
async function selectHistoryCheckpoint(index: number): Promise<void> {
  const checkpoints = historyMode.checkpoints;
  if (!Array.isArray(checkpoints) || !checkpoints.length) {
    return;
  }
  const boundedIndex = Math.max(0, Math.min(checkpoints.length - 1, Number(index) || 0));
  historyMode.selectedIndex = boundedIndex;
  renderHistoryPanel();
  const selected = checkpoints[boundedIndex];
  if (!selected?.id || !historyMode.spaceId) {
    return;
  }
  if (!historyMode.viewerActive) {
    if (historyMode.wasConnected) {
      disconnectSpace();
    }
    setHistoryViewerMode(true);
  }
  try {
    const cacheKey = String(selected.id);
    let content = historyMode.cache.get(cacheKey);
    if (typeof content !== "string") {
      content = await fetchSpaceHistoryCheckpointContent(historyMode.spaceId, cacheKey, historyMode.spacePath || "");
      historyMode.cache.set(cacheKey, content);
    }
    forceEditorRefresh(content, { collapseSelection: true });
  } catch (error: any) {
    showToast(error?.message || "Failed to load history point.", "error");
  }
}

/**
 * Handles the closeHistoryPanel function logic.
 * Input: { restoreOriginal = true }: { restoreOriginal?: boolean } = {}.
 * Output: Promise<void>.
 */
async function closeHistoryPanel({ restoreOriginal = true }: { restoreOriginal?: boolean } = {}): Promise<void> {
  if (!historyMode.panelOpen && !historyMode.panelClosing) {
    return;
  }
  closeHistoryRevertModal();
  const shouldRestore = restoreOriginal && historyMode.viewerActive && typeof historyMode.originalText === "string";
  historyMode.panelOpen = false;
  await runHistoryPanelCloseAnimation();
  if (shouldRestore) {
    forceEditorRefresh(historyMode.originalText, { collapseSelection: true });
  }
  setHistoryViewerMode(false);
  historyMode.panelClosing = false;
  const reconnectSpaceId = historyMode.wasConnected ? historyMode.spaceId : null;
  const reconnectSpacePath = historyMode.spacePath;
  historyMode.spaceId = null;
  historyMode.spacePath = "";
  historyMode.originalText = "";
  historyMode.wasConnected = false;
  historyMode.checkpoints = [];
  historyMode.selectedIndex = -1;
  historyMode.cache = new Map();
  renderHistoryPanel();
  if (reconnectSpaceId) {
    try {
      await connectToSpace(reconnectSpaceId, reconnectSpacePath || "");
    } catch {
      showToast("Failed to reconnect after leaving history mode.", "error");
    }
  }
  updateHistoryButtonState();
}

/**
 * Handles the openHistoryPanel function logic.
 * Input: none.
 * Output: Promise<void>.
 */
async function openHistoryPanel(): Promise<void> {
  if (historyMode.loading) {
    return;
  }
  if (!collab.spaceId || !collab.isAuthenticated) {
    showToast("Open a shared space first to browse history.", "error");
    return;
  }
  historyMode.loading = true;
  closeHistoryRevertModal();
  updateHistoryButtonState();
  try {
    historyMode.panelClosing = false;
    historyMode.panelOpen = true;
    startHistoryPanelOpenAnimation();
    setHistoryViewerMode(false);
    historyMode.spaceId = String(collab.spaceId);
    historyMode.spacePath = String(collab.spacePath || "");
    historyMode.originalText = editorController.getValue();
    historyMode.wasConnected = Boolean(collab.spaceId);
    historyMode.cache = new Map();
    historyMode.checkpoints = await fetchSpaceHistoryList(historyMode.spaceId, historyMode.spacePath || "");
    historyMode.selectedIndex = historyMode.checkpoints.length ? (historyMode.checkpoints.length - 1) : -1;
    renderHistoryPanel();
  } catch (error: any) {
    historyMode.panelOpen = false;
    historyMode.panelOpening = false;
    historyMode.panelClosing = false;
    renderHistoryPanel();
    showToast(error?.message || "Failed to load history.", "error");
  } finally {
    if (historyMode.panelOpen) {
      historyMode.panelOpening = false;
    }
    historyMode.loading = false;
    renderHistoryPanel();
    updateHistoryButtonState();
  }
}

/**
 * Handles the getHistoryRevertSelection function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function getHistoryRevertSelection(): { checkpointId: string; targetLabel: string } | null {
  if (!historyMode.panelOpen || !historyMode.spaceId) {
    return null;
  }
  const selected = historyMode.checkpoints?.[historyMode.selectedIndex];
  const checkpointId = typeof selected?.id === "string" ? selected.id : "";
  if (!checkpointId) {
    return null;
  }
  const targetLabel = selected ? historyCheckpointDisplayLabel(selected) : "selected history point";
  return { checkpointId, targetLabel };
}

/**
 * Handles the openHistoryRevertModal function logic.
 * Input: none.
 * Output: void.
 */
function openHistoryRevertModal(): void {
  if (!dom.historyRevertModal) {
    return;
  }
  const selection = getHistoryRevertSelection();
  if (!selection) {
    return;
  }
  if (dom.historyRevertMessage) {
    dom.historyRevertMessage.textContent = `Revert to ${selection.targetLabel}? Current code will be saved to history as "revoked".`;
  }
  if (dom.historyRevertConfirm) {
    dom.historyRevertConfirm.disabled = false;
  }
  dom.historyRevertModal.classList.remove("hidden");
  queueMicrotask(() => {
    dom.historyRevertConfirm?.focus();
  });
}

/**
 * Handles the closeHistoryRevertModal function logic.
 * Input: none.
 * Output: void.
 */
function closeHistoryRevertModal(): void {
  if (!dom.historyRevertModal) {
    return;
  }
  dom.historyRevertModal.classList.add("hidden");
  if (dom.historyRevertConfirm) {
    dom.historyRevertConfirm.disabled = false;
  }
}

/**
 * Handles the openHistoryTagModal function logic.
 * Input: none.
 * Output: void.
 */
function openHistoryTagModal(): void {
  if (!dom.historyTagModal || !dom.historyTagInput) {
    return;
  }
  resetInlineError(dom.historyTagError);
  dom.historyTagInput.value = "";
  dom.historyTagModal.classList.remove("hidden");
  queueMicrotask(() => {
    dom.historyTagInput?.focus();
    dom.historyTagInput?.select();
  });
}

/**
 * Handles the closeHistoryTagModal function logic.
 * Input: none.
 * Output: void.
 */
function closeHistoryTagModal(): void {
  dom.historyTagModal?.classList.add("hidden");
  resetInlineError(dom.historyTagError);
}

/**
 * Handles the submitHistoryTag function logic.
 * Input: none.
 * Output: Promise<void>.
 */
async function submitHistoryTag(): Promise<void> {
  if (!historyMode.panelOpen || !historyMode.spaceId) {
    return;
  }
  const selected = historyMode.checkpoints?.[historyMode.selectedIndex];
  const checkpointId = typeof selected?.id === "string" ? selected.id : "";
  const label = dom.historyTagInput?.value?.trim() || "";
  if (!label) {
    setInlineToastError(dom.historyTagError, "Enter a label.");
    return;
  }
  try {
    if (dom.historyTagSave) {
      dom.historyTagSave.disabled = true;
    }
    const tagRequest: { label: string; checkpointId?: string; content: string; path?: string } = {
      label,
      content: editorController.getValue(),
    };
    if (historyMode.spacePath) {
      tagRequest.path = historyMode.spacePath;
    }
    if (checkpointId) {
      tagRequest.checkpointId = checkpointId;
    }
    const tagged = await postSpaceHistoryTag(historyMode.spaceId, tagRequest);
    closeHistoryTagModal();
    historyMode.checkpoints = await fetchSpaceHistoryList(historyMode.spaceId, historyMode.spacePath || "");
    const newId = tagged?.checkpoint?.id;
    if (typeof newId === "string") {
      const nextIndex = historyMode.checkpoints.findIndex((entry: any) => entry?.id === newId);
      historyMode.selectedIndex = nextIndex >= 0 ? nextIndex : historyMode.selectedIndex;
    }
    renderHistoryPanel();
    showToast("History point tagged.", "success");
  } catch (error: any) {
    setInlineToastError(dom.historyTagError, error?.message || "Failed to tag history point.");
  } finally {
    if (dom.historyTagSave) {
      dom.historyTagSave.disabled = false;
    }
  }
}

/**
 * Handles the revertFromHistorySelection function logic.
 * Input: { skipConfirmation = false }: { skipConfirmation?: boolean } = {}.
 * Output: Promise<void>.
 */
async function revertFromHistorySelection(
  { skipConfirmation = false }: { skipConfirmation?: boolean } = {}
): Promise<void> {
  if (!historyMode.viewerActive || !historyMode.spaceId) {
    return;
  }
  const selection = getHistoryRevertSelection();
  if (!selection) {
    return;
  }
  if (!skipConfirmation) {
    openHistoryRevertModal();
    return;
  }
  closeHistoryRevertModal();
  try {
    if (dom.historyRevertButton) {
      dom.historyRevertButton.disabled = true;
    }
    if (dom.historyRevertConfirm) {
      dom.historyRevertConfirm.disabled = true;
    }
    const result = await postSpaceHistoryRevert(
      historyMode.spaceId,
      selection.checkpointId,
      typeof historyMode.originalText === "string" ? historyMode.originalText : editorController.getValue(),
      historyMode.spacePath || ""
    );
    if (typeof result?.content === "string") {
      forceEditorRefresh(result.content, { collapseSelection: true });
    }
    await closeHistoryPanel({ restoreOriginal: false });
    showToast("Reverted to selected history point.", "success");
  } catch (error: any) {
    showToast(error?.message || "Failed to revert history point.", "error");
    renderHistoryPanel();
  } finally {
    if (dom.historyRevertButton && historyMode.panelOpen) {
      dom.historyRevertButton.disabled = false;
    }
    if (dom.historyRevertConfirm) {
      dom.historyRevertConfirm.disabled = false;
    }
  }
}

/**
 * Handles the matchesFilters function logic.
 * Input: task: any.
 * Output: result produced by this function.
 */
function matchesFilters(task: any) {
  if (!filtersActive()) {
    return true;
  }
  return (
    task.tags.some((tag: any) => state.selectedTags.has(tag)) ||
    task.people.some((person: any) => state.selectedPeople.has(person))
  );
}

if (dom.undoButton) {
  dom.undoButton.addEventListener("click", () => {
    if (historyMode.viewerActive) {
      return;
    }
    editorController.focus();
    editorController.undo();
    syncEditorState();
  });
}

if (dom.redoButton) {
  dom.redoButton.addEventListener("click", () => {
    if (historyMode.viewerActive) {
      return;
    }
    editorController.focus();
    editorController.redo();
    syncEditorState();
  });
}

if (dom.loadButton && dom.fileInput) {
  const fileInput = dom.fileInput;
  dom.loadButton.addEventListener("click", () => {
    fileInput.click();
  });
  fileInput.addEventListener("change", async (event) => {
    if (historyMode.viewerActive) {
      fileInput.value = "";
      return;
    }
    const target = event.target as HTMLInputElement | null;
    const file = target?.files?.[0];
    if (!file) {
      return;
    }
    const text = await file.text();
    editorController.setValue(text);
    fileInput.value = "";
    syncEditorState();
  });
}

if (dom.saveButton) {
  dom.saveButton.addEventListener("click", () => {
    if (historyMode.viewerActive) {
      return;
    }
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
    if (historyMode.viewerActive) {
      return;
    }
    const currentValue = editorController.getValue();
    const formatted = formatTaskScript(currentValue);
    if (formatted === currentValue) {
      return;
    }
    applyEditorValue(formatted);
    syncEditorState();
  });
}

if (dom.historyButton) {
  dom.historyButton.addEventListener("click", () => {
    if (historyMode.panelOpen) {
      void closeHistoryPanel();
      return;
    }
    void openHistoryPanel();
  });
}

if (dom.mobileToolbarToggle) {
  dom.mobileToolbarToggle.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!isCompactToolbarMenuViewport()) {
      return;
    }
    toggleMobileToolbarMenu();
  });
}

if (dom.topbarActions) {
  dom.topbarActions.addEventListener("click", (event) => {
    if (!isCompactToolbarMenuViewport()) {
      return;
    }
    const target = event.target instanceof Element ? event.target.closest("button") : null;
    if (!target) {
      return;
    }
    queueMicrotask(() => closeMobileToolbarMenu());
  });
}

if (dom.mobilePaneTabs) {
  dom.mobilePaneTabs.addEventListener("click", (event: any) => {
    const target = event.target instanceof Element
      ? event.target.closest("button[data-mobile-pane]")
      : null;
    if (!target) {
      return;
    }
    setMobileActivePane((target as HTMLButtonElement).dataset["mobilePane"]);
  });
}

if (dom.tabletPaneToggle) {
  dom.tabletPaneToggle.addEventListener("click", (event: any) => {
    const target = event.target instanceof Element
      ? event.target.closest("button[data-tablet-pane]")
      : null;
    if (!target) {
      return;
    }
    setTabletRightPane((target as HTMLButtonElement).dataset["tabletPane"]);
  });
}

if (dom.tabletLayoutToggle) {
  dom.tabletLayoutToggle.addEventListener("click", (event: any) => {
    const target = event.target instanceof Element
      ? event.target.closest("button[data-tablet-layout]")
      : null;
    if (!target) {
      return;
    }
    setTabletPaneLayout((target as HTMLButtonElement).dataset["tabletLayout"]);
  });
}

if (dom.historySlider) {
  dom.historySlider.addEventListener("input", (event) => {
    const target = event.target as HTMLInputElement | null;
    const sliderValue = Number.parseInt(target?.value || "0", 10);
    const index = findNearestHistoryCheckpointIndexByTime(historyMode.checkpoints, sliderValue);
    void selectHistoryCheckpoint(index);
  });
}

if (dom.historyStepPrev) {
  dom.historyStepPrev.addEventListener("click", () => {
    void stepHistorySelection(-1);
  });
}

if (dom.historyStepNext) {
  dom.historyStepNext.addEventListener("click", () => {
    void stepHistorySelection(1);
  });
}

if (dom.historyCancelButton) {
  dom.historyCancelButton.addEventListener("click", () => {
    void closeHistoryPanel();
  });
}

if (dom.historyTagButton) {
  dom.historyTagButton.addEventListener("click", () => {
    if (!historyMode.panelOpen || !historyMode.spaceId) {
      return;
    }
    openHistoryTagModal();
  });
}

if (dom.historyRevertButton) {
  dom.historyRevertButton.addEventListener("click", () => {
    openHistoryRevertModal();
  });
}

if (dom.historyRevertClose) {
  dom.historyRevertClose.addEventListener("click", () => {
    closeHistoryRevertModal();
  });
}

if (dom.historyRevertCancel) {
  dom.historyRevertCancel.addEventListener("click", () => {
    closeHistoryRevertModal();
  });
}

if (dom.historyRevertConfirm) {
  dom.historyRevertConfirm.addEventListener("click", () => {
    void revertFromHistorySelection({ skipConfirmation: true });
  });
}

if (dom.historyRevertModal) {
  dom.historyRevertModal.addEventListener("keydown", (event: any) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void revertFromHistorySelection({ skipConfirmation: true });
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeHistoryRevertModal();
    }
  });
}

if (dom.historyTagClose) {
  dom.historyTagClose.addEventListener("click", () => {
    closeHistoryTagModal();
  });
}

if (dom.historyTagCancel) {
  dom.historyTagCancel.addEventListener("click", () => {
    closeHistoryTagModal();
  });
}

if (dom.historyTagSave) {
  dom.historyTagSave.addEventListener("click", () => {
    void submitHistoryTag();
  });
}

if (dom.historyTagInput) {
  dom.historyTagInput.addEventListener("keydown", (event: any) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void submitHistoryTag();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeHistoryTagModal();
    }
  });
}

/**
 * Handles the setTheme function logic.
 * Input: theme: any.
 * Output: result produced by this function.
 */
function setTheme(theme: any) {
  const resolved = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset["theme"] = resolved;
  safeLocalStorageSet("theme", resolved);
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

/**
 * Handles the getSpellcheckToggleButtons function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function getSpellcheckToggleButtons() {
  return [dom.spellcheckToggleMain, dom.spellcheckToggleModal].filter(
    (button): button is HTMLButtonElement => Boolean(button)
  );
}

/**
 * Handles the updateSpellcheckToggleButton function logic.
 * Input: none.
 * Output: result produced by this function.
 */
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

/**
 * Handles the setScopedSpellcheckEnabled function logic.
 * Input: enabled: any, { persist = true }: { persist?: boolean } = {}.
 * Output: result produced by this function.
 */
function setScopedSpellcheckEnabled(enabled: any, { persist = true }: { persist?: boolean } = {}) {
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
    safeLocalStorageSet(SPELLCHECK_STORAGE_KEY, next ? "1" : "0");
  }
}

if (dom.themeButton) {
  const storedTheme = safeLocalStorageGet("theme");
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)")?.matches;
  setTheme(storedTheme || (prefersDark ? "dark" : "light"));
  dom.themeButton.addEventListener("click", () => {
    const current = document.documentElement.dataset["theme"];
    setTheme(current === "dark" ? "light" : "dark");
  });
}

// Stores the spellcheckToggleButtons module constant.
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

if (dom.taskEditDelete) {
  dom.taskEditDelete.addEventListener("click", () => {
    const task = getTaskEditDeleteTarget();
    if (!task) {
      return;
    }
    closeTaskEditModal();
    openTaskDeleteModal(task);
  });
}

if (dom.taskEditSave) {
  dom.taskEditSave.addEventListener("click", () => {
    saveTaskEditModal();
  });
}

if (dom.graphAddTask) {
  dom.graphAddTask.addEventListener("click", () => {
    if (historyMode.viewerActive) {
      return;
    }
    openTaskCreateModal();
  });
}

if (dom.boardTitle) {
  dom.boardTitle.addEventListener("dblclick", (event: any) => {
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
  dom.boardRenameInput.addEventListener("keydown", (event: any) => {
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
  dom.slugRenameNew.addEventListener("keydown", (event: any) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submitSlugRename();
    }
  });
}

if (dom.taskEditTitleInput) {
  const taskEditTitleInput = dom.taskEditTitleInput;
  dom.taskEditTitleInput.addEventListener("input", () => {
    if (!modalEditorController) {
      return;
    }
    const parsedTitle = parseJiraTitle(taskEditTitleInput.value || "");
    if (parsedTitle.key) {
      editingTaskJiraKey = parsedTitle.key;
    }
    updateTaskEditJiraPill(editingTaskJiraKey);
    updateTaskEditPreviewFromText(modalEditorController.getValue());
  });
}

if (dom.taskEditJiraPill) {
  dom.taskEditJiraPill.addEventListener("click", (event: any) => {
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
  dom.loginModal.addEventListener("keydown", (event: any) => {
    const keyboardEvent = /** @type {KeyboardEvent} */ (event);
    if (keyboardEvent.key === "Enter") {
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

window.addEventListener("taskdroptrash", (event: Event) => {
  if (historyMode.viewerActive) {
    return;
  }
  const customEvent = event as CustomEvent<any>;
  const taskId = String(customEvent?.detail?.taskId || "");
  if (!taskId) {
    return;
  }
  const task = state.allTasks.find((item: any) => item.id === taskId);
  if (task) {
    openTaskDeleteModal(task);
  }
});

if (dom.taskTrash) {
  dom.taskTrash.addEventListener("dragover", (event: any) => {
    if (historyMode.viewerActive) {
      return;
    }
    event.preventDefault();
    dom.taskTrash.classList.add("drag-over");
    document.body.classList.add("task-trash-over");
  });
  dom.taskTrash.addEventListener("dragleave", () => {
    dom.taskTrash.classList.remove("drag-over");
    document.body.classList.remove("task-trash-over");
  });
  dom.taskTrash.addEventListener("drop", (event: any) => {
    if (historyMode.viewerActive) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const dragEvent = /** @type {DragEvent} */ (event);
    event.preventDefault();
    event.stopPropagation();
    dom.taskTrash.classList.remove("drag-over");
    document.body.classList.remove("task-trash-over");
    setTaskDragActive(false);
    let taskId = "";
    const payload = dragEvent.dataTransfer?.getData("application/json");
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
      taskId = dragEvent.dataTransfer?.getData("text/plain") || "";
    }
    const task = state.allTasks.find((item: any) => item.id === taskId);
    if (task) {
      openTaskDeleteModal(task);
    }
  });
}

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeMobileToolbarMenu();
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

document.addEventListener("click", (event) => {
  if (!isCompactToolbarMenuViewport()) {
    return;
  }
  const target = event.target;
  if (!(target instanceof Node)) {
    return;
  }
  if (dom.mobileToolbarToggle?.contains(target)) {
    return;
  }
  if (dom.topbarActions?.contains(target)) {
    return;
  }
  closeMobileToolbarMenu();
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
    window.reportPresence?.(collab.spaceId, true);
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
  dom.spaceNew.addEventListener("keydown", (event: any) => {
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
  dom.spaceFolderNew.addEventListener("keydown", (event: any) => {
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
      await deleteSpace(target.id, target.path || "");
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

if (dom.searchInput) {
  const searchInput = dom.searchInput;
  searchInput.addEventListener("input", () => {
    state.searchQuery = searchInput.value;
    canvasController.renderGraph();
    buildKanban();
    updateClearFiltersVisibility();
    renderStoryPointsSummary();
  });

  searchInput.addEventListener("keydown", (event: any) => {
    if (event.key !== "Escape") {
      return;
    }
    if (!searchInput.value && !state.searchQuery) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    searchInput.value = "";
    state.searchQuery = "";
    canvasController.renderGraph();
    buildKanban();
    updateClearFiltersVisibility();
    renderStoryPointsSummary();
  });
}

[dom.kanbanGroup].filter(Boolean).forEach((group: any) => {
  group.addEventListener("click", (event: any) => {
    const target = event.target instanceof Element
      ? event.target.closest("button[data-kanban-group]")
      : null;
    if (!target) {
      return;
    }
    setKanbanGroupBy((/** @type {HTMLButtonElement} */ (target)).dataset.kanbanGroup);
  });
});

[dom.searchName, dom.searchDescription, dom.searchTag, dom.searchPerson]
  .filter((checkbox): checkbox is HTMLInputElement => Boolean(checkbox))
  .forEach((checkbox) => {
  checkbox.addEventListener("change", () => {
    canvasController.renderGraph();
    buildKanban();
    updateClearFiltersVisibility();
    renderStoryPointsSummary();
  });
});

if (dom.clearFilters) {
  dom.clearFilters.addEventListener("click", () => {
    state.selectedTags.clear();
    state.selectedPeople.clear();
    state.searchQuery = "";
    if (dom.searchInput) {
      dom.searchInput.value = "";
    }
    canvasController.renderGraph();
    buildTagPersonLists();
    buildKanban();
    updateClearFiltersVisibility();
    renderStoryPointsSummary();
  });
}

// Stores the resizing module constant.
let resizing = false;
// Stores the resizingKanban module constant.
let resizingKanban = false;
// Stores the pendingGraphRender module constant.
let pendingGraphRender: number | null = null;
// Stores the legendHiddenByDividerSnap module constant.
let legendHiddenByDividerSnap = false;
// Stores the legendHasVisibleContent module constant.
let legendHasVisibleContent = true;
// Stores the activeTouchDividerPointerId module constant.
let activeTouchDividerPointerId: number | null = null;
// Stores the activeTouchKanbanDividerPointerId module constant.
let activeTouchKanbanDividerPointerId: number | null = null;
// Stores the activeTouchDividerTouchId module constant.
let activeTouchDividerTouchId: number | null = null;
// Stores the activeTouchKanbanDividerTouchId module constant.
let activeTouchKanbanDividerTouchId: number | null = null;

/**
 * Handles the applyLegendHiddenState function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function applyLegendHiddenState() {
  if (!dom.legend) {
    return;
  }
  const shouldHide = legendHiddenByDividerSnap || !legendHasVisibleContent;
  dom.legend.hidden = shouldHide;
  document.documentElement.toggleAttribute("data-legend-hidden", shouldHide);
  updateResponsiveLayoutOffsets();
}

/**
 * Handles the setLegendHasVisibleContent function logic.
 * Input: hasVisibleContent: any.
 * Output: result produced by this function.
 */
function setLegendHasVisibleContent(hasVisibleContent: any) {
  legendHasVisibleContent = Boolean(hasVisibleContent);
  applyLegendHiddenState();
}

/**
 * Handles the scheduleGraphRender function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function scheduleGraphRender() {
  if (pendingGraphRender) {
    return;
  }
  // Batch graph reflows to one per frame while dragging resizers.
  pendingGraphRender = requestAnimationFrame(() => {
    pendingGraphRender = null;
    measurePerformanceSync("app.scheduleGraphRender.flush", () => {
      canvasController.renderGraph();
    });
  });
}

/**
 * Handles the findTouchByIdentifier function logic.
 * Input: touches: TouchList, identifier: number.
 * Output: Touch | null.
 */
function findTouchByIdentifier(touches: TouchList, identifier: number): Touch | null {
  for (let index = 0; index < touches.length; index += 1) {
    const touch = touches.item(index);
    if (touch && touch.identifier === identifier) {
      return touch;
    }
  }
  return null;
}

/**
 * Handles the updateKanbanHeightFromPointer function logic.
 * Input: clientY: number.
 * Output: void.
 */
function updateKanbanHeightFromPointer(clientY: number): void {
  const panelRect = (dom.graphPanel || dom.graphCanvas).getBoundingClientRect();
  const dividerHeight = dom.kanbanDivider?.offsetHeight || 0;
  const legendHeight = dom.legend?.getBoundingClientRect().height || 0;
  const minHeight = 0;
  const maxHeight = Math.max(minHeight, panelRect.height - legendHeight - dividerHeight);
  const desired = panelRect.bottom - clientY;
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
}

/**
 * Handles the updateMainDividerFromPointer function logic.
 * Input: clientX: number.
 * Output: void.
 */
function updateMainDividerFromPointer(clientX: number): void {
  const rect = document.body.getBoundingClientRect();
  const dividerWidth = Math.max(1, dom.divider?.offsetWidth || 8);
  const relativeX = clientX - rect.left;
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
}

/**
 * Handles the updateTabletHorizontalDividerFromPointer function logic.
 * Input: clientY: number.
 * Output: void.
 */
function updateTabletHorizontalDividerFromPointer(clientY: number): void {
  const appRoot = document.querySelector(".app") as HTMLElement | null;
  const rect = (appRoot || document.body).getBoundingClientRect();
  if (!rect.height) {
    return;
  }
  const dividerHeight = Math.max(1, dom.divider?.offsetHeight || 8);
  const relativeY = clientY - rect.top;
  const percentage = (relativeY / rect.height) * 100;
  const maxPercent = Math.max(0, ((rect.height - dividerHeight) / rect.height) * 100);
  const edgeSnapPx = 36;
  const maxY = Math.max(0, rect.height - dividerHeight);
  let clamped = Math.min(maxPercent, Math.max(0, percentage));
  if (relativeY <= edgeSnapPx) {
    clamped = 0;
  } else if (relativeY >= maxY - edgeSnapPx) {
    clamped = maxPercent;
  }
  const value = `${clamped}%`;
  document.documentElement.style.setProperty("--tablet-horizontal-top-height", value);
  if (appRoot) {
    appRoot.style.setProperty("--tablet-horizontal-top-height", value);
  }
  setLegendHiddenForTabletVerticalSnap(clamped, maxPercent);
  scheduleGraphRender();
}

/**
 * Handles the setLegendHiddenForRightSnap function logic.
 * Input: leftPercent: any, maxPercent: any.
 * Output: result produced by this function.
 */
function setLegendHiddenForRightSnap(leftPercent: any, maxPercent: any) {
  const hasValidNumbers = Number.isFinite(leftPercent) && Number.isFinite(maxPercent);
  const snappedLeft = hasValidNumbers && leftPercent <= 0.01;
  const snappedRight = hasValidNumbers && leftPercent >= (maxPercent - 0.01);
  legendHiddenByDividerSnap = state.viewportMode === "tablet"
    ? (snappedLeft || snappedRight)
    : snappedRight;
  applyLegendHiddenState();
}

/**
 * Handles the setLegendHiddenForTabletVerticalSnap function logic.
 * Input: topPercent: any, maxPercent: any.
 * Output: result produced by this function.
 */
function setLegendHiddenForTabletVerticalSnap(topPercent: any, maxPercent: any) {
  const shouldHide = state.viewportMode === "tablet"
    && state.tabletPaneLayout === "horizontal"
    && Number.isFinite(topPercent)
    && Number.isFinite(maxPercent)
    && (topPercent <= 0.01 || topPercent >= (maxPercent - 0.01));
  legendHiddenByDividerSnap = shouldHide;
  applyLegendHiddenState();
}

/**
 * Handles the updateLegendHiddenFromLayout function logic.
 * Input: none.
 * Output: result produced by this function.
 */
function updateLegendHiddenFromLayout() {
  const appRoot = document.querySelector(".app") as HTMLElement | null;
  const rect = (appRoot || document.body).getBoundingClientRect();
  if (!rect.width || !rect.height) {
    return;
  }
  const rootStyle = getComputedStyle(document.documentElement);
  const rawLeftWidth = rootStyle.getPropertyValue("--left-width").trim();
  const leftPercent = Number.parseFloat(rawLeftWidth);
  const safeLeftPercent = Number.isFinite(leftPercent) ? leftPercent : 45;
  setGraphHiddenForLeftSnap(safeLeftPercent);
  updateGraphTopHiddenFromLayout({ dom });
  if (state.viewportMode === "tablet" && state.tabletPaneLayout === "horizontal") {
    const dividerHeight = Math.max(1, dom.divider?.offsetHeight || 8);
    const maxTopPercent = Math.max(0, ((rect.height - dividerHeight) / rect.height) * 100);
    const rawTopHeight = rootStyle.getPropertyValue("--tablet-horizontal-top-height").trim();
    const topPercent = Number.parseFloat(rawTopHeight);
    setLegendHiddenForTabletVerticalSnap(
      Number.isFinite(topPercent) ? topPercent : 50,
      maxTopPercent
    );
    return;
  }
  const dividerWidth = Math.max(1, dom.divider?.offsetWidth || 8);
  const maxLeftPercent = Math.max(0, ((rect.width - dividerWidth) / rect.width) * 100);
  setLegendHiddenForRightSnap(safeLeftPercent, maxLeftPercent);
}

dom.divider.addEventListener("mousedown", () => {
  if (
    state.viewportMode === "mobile"
    || (state.viewportMode === "tablet" && (state.tabletPaneLayout === "hide" || state.tabletPaneLayout === "code"))
  ) {
    return;
  }
  resizing = true;
  dom.divider.classList.add("dragging");
});

dom.divider.addEventListener("pointerdown", (event: PointerEvent) => {
  if (event.pointerType !== "touch") {
    return;
  }
  if (
    state.viewportMode === "mobile"
    || (state.viewportMode === "tablet" && (state.tabletPaneLayout === "hide" || state.tabletPaneLayout === "code"))
  ) {
    return;
  }
  event.preventDefault();
  resizing = true;
  activeTouchDividerPointerId = event.pointerId;
  dom.divider.classList.add("dragging");
});

dom.divider.addEventListener("touchstart", (event: TouchEvent) => {
  if (
    state.viewportMode === "mobile"
    || (state.viewportMode === "tablet" && (state.tabletPaneLayout === "hide" || state.tabletPaneLayout === "code"))
  ) {
    return;
  }
  const touch = event.changedTouches.item(0);
  if (!touch) {
    return;
  }
  event.preventDefault();
  resizing = true;
  activeTouchDividerTouchId = touch.identifier;
  dom.divider.classList.add("dragging");
}, { passive: false });

if (dom.kanbanDivider) {
  dom.kanbanDivider.addEventListener("mousedown", () => {
    if (state.viewportMode !== "desktop") {
      return;
    }
    resizingKanban = true;
    dom.kanbanDivider.classList.add("dragging");
  });
  dom.kanbanDivider.addEventListener("pointerdown", (event: PointerEvent) => {
    if (event.pointerType !== "touch") {
      return;
    }
    if (state.viewportMode !== "desktop") {
      return;
    }
    event.preventDefault();
    resizingKanban = true;
    activeTouchKanbanDividerPointerId = event.pointerId;
    dom.kanbanDivider.classList.add("dragging");
  });
  dom.kanbanDivider.addEventListener("touchstart", (event: TouchEvent) => {
    if (state.viewportMode !== "desktop") {
      return;
    }
    const touch = event.changedTouches.item(0);
    if (!touch) {
      return;
    }
    event.preventDefault();
    resizingKanban = true;
    activeTouchKanbanDividerTouchId = touch.identifier;
    dom.kanbanDivider.classList.add("dragging");
  }, { passive: false });
}

window.addEventListener("mousemove", (event) => {
  if (!resizing) {
    if (resizingKanban) {
      updateKanbanHeightFromPointer(event.clientY);
      return;
    }
    return;
  }
  if (state.viewportMode === "tablet" && state.tabletPaneLayout === "horizontal") {
    updateTabletHorizontalDividerFromPointer(event.clientY);
    return;
  }
  updateMainDividerFromPointer(event.clientX);
});

window.addEventListener("mouseup", () => {
  if (!resizing) {
    if (resizingKanban) {
      resizingKanban = false;
      dom.kanbanDivider.classList.remove("dragging");
      rememberLayoutGeometryForCurrentViewport();
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
  rememberLayoutGeometryForCurrentViewport();
  scheduleGraphRender();
});

window.addEventListener("pointermove", (event: PointerEvent) => {
  if (event.pointerType !== "touch") {
    return;
  }
  const dividerActive = resizing && activeTouchDividerPointerId === event.pointerId;
  const kanbanActive = resizingKanban && activeTouchKanbanDividerPointerId === event.pointerId;
  if (!dividerActive && !kanbanActive) {
    return;
  }
  event.preventDefault();
  if (dividerActive) {
    if (state.viewportMode === "tablet" && state.tabletPaneLayout === "horizontal") {
      updateTabletHorizontalDividerFromPointer(event.clientY);
      return;
    }
    updateMainDividerFromPointer(event.clientX);
    return;
  }
  if (kanbanActive) {
    updateKanbanHeightFromPointer(event.clientY);
  }
}, { passive: false });

window.addEventListener("touchmove", (event: TouchEvent) => {
  let handled = false;
  if (resizing && activeTouchDividerTouchId !== null) {
    const touch = findTouchByIdentifier(event.touches, activeTouchDividerTouchId);
    if (touch) {
      if (state.viewportMode === "tablet" && state.tabletPaneLayout === "horizontal") {
        updateTabletHorizontalDividerFromPointer(touch.clientY);
      } else {
        updateMainDividerFromPointer(touch.clientX);
      }
      handled = true;
    }
  }
  if (resizingKanban && activeTouchKanbanDividerTouchId !== null) {
    const touch = findTouchByIdentifier(event.touches, activeTouchKanbanDividerTouchId);
    if (touch) {
      updateKanbanHeightFromPointer(touch.clientY);
      handled = true;
    }
  }
  if (handled) {
    event.preventDefault();
  }
}, { passive: false });

const finishTouchDividerResize = (pointerId: number): void => {
  let didFinish = false;
  if (resizing && activeTouchDividerPointerId === pointerId) {
    resizing = false;
    activeTouchDividerPointerId = null;
    dom.divider.classList.remove("dragging");
    didFinish = true;
  }
  if (resizingKanban && activeTouchKanbanDividerPointerId === pointerId) {
    resizingKanban = false;
    activeTouchKanbanDividerPointerId = null;
    dom.kanbanDivider?.classList.remove("dragging");
    didFinish = true;
  }
  if (didFinish) {
    rememberLayoutGeometryForCurrentViewport();
    scheduleGraphRender();
  }
};

const finishTouchDividerResizeByIdentifier = (touchIdentifier: number): void => {
  let didFinish = false;
  if (resizing && activeTouchDividerTouchId === touchIdentifier) {
    resizing = false;
    activeTouchDividerTouchId = null;
    dom.divider.classList.remove("dragging");
    didFinish = true;
  }
  if (resizingKanban && activeTouchKanbanDividerTouchId === touchIdentifier) {
    resizingKanban = false;
    activeTouchKanbanDividerTouchId = null;
    dom.kanbanDivider?.classList.remove("dragging");
    didFinish = true;
  }
  if (didFinish) {
    rememberLayoutGeometryForCurrentViewport();
    scheduleGraphRender();
  }
};

window.addEventListener("pointerup", (event: PointerEvent) => {
  if (event.pointerType !== "touch") {
    return;
  }
  finishTouchDividerResize(event.pointerId);
});

window.addEventListener("pointercancel", (event: PointerEvent) => {
  if (event.pointerType !== "touch") {
    return;
  }
  finishTouchDividerResize(event.pointerId);
});

window.addEventListener("touchend", (event: TouchEvent) => {
  for (let index = 0; index < event.changedTouches.length; index += 1) {
    const touch = event.changedTouches.item(index);
    if (touch) {
      finishTouchDividerResizeByIdentifier(touch.identifier);
    }
  }
}, { passive: true });

window.addEventListener("touchcancel", (event: TouchEvent) => {
  for (let index = 0; index < event.changedTouches.length; index += 1) {
    const touch = event.changedTouches.item(index);
    if (touch) {
      finishTouchDividerResizeByIdentifier(touch.identifier);
    }
  }
}, { passive: true });

window.addEventListener("resize", () => {
  updateViewportMode();
  updateLegendHiddenFromLayout();
  scheduleGraphRender();
});

state.kanbanGroupBy = getStoredKanbanGroup();
updateKanbanGroupButtons();

/**
 * Handles the initializeApp function logic.
 * Input: none.
 * Output: Promise<void>.
 */
async function initializeApp(): Promise<void> {
  setBootLoaderVisible(true, "Preparing workspace...");
  try {
    initializeSecretToggles();
    updateConnectButtonLabel();
    updateHistoryButtonState();
    updateViewportMode();
    updateLegendHiddenFromLayout();
    sync();
    updateBootLoaderStatus("Restoring session...");
    await restoreSessionFromCookie();
    if (collab.spaceId && !collab.synced) {
      updateBootLoaderStatusFromConnection(collab.connectionStatus);
      await waitForInitialConnectionReady();
    }
    sync();
  } finally {
    setBootLoaderVisible(false);
  }
}

void initializeApp();
