// @ts-check

import { splitIndent, normalizeContent, prependTokenToLine } from "./formatter.js";
import { parseJiraTitle } from "./task.js";
import {
  buildTaskDescriptionText,
  decorateDescriptionPills,
  decorateDescriptionReferences,
  renderTaskDescriptionNode,
  wireDescriptionCheckboxes,
} from "./taskDescription.js";

type KanbanGroupBy = "none" | "person" | "tag";

type BuildKanbanOptions = {
  state: any;
  dom: any;
  renderMarkdown?: ((text: string, options?: any) => string) | null;
  selectTask: (task: any) => void;
  onEditTask?: ((task: any) => void) | null;
  matchesSearchTask: (task: any) => boolean;
  filtersActive: () => boolean | number;
  matchesFilters: (task: any) => boolean;
  updateTaskState: (task: any, nextState: string) => void;
  onToggleCheckbox?: ((lineIndex: number, checked: boolean) => void) | null;
  groupBy?: string;
};

type UpdateTaskStateOptions = {
  task: any;
  newState: string;
  dom: any;
  sync: () => void;
  applyEditorValue?: ((value: string) => void) | null;
};

type UpdateTaskTokenOptions = {
  task: any;
  token: string;
  action: "add" | "remove";
  dom: any;
  sync: () => void;
  applyEditorValue?: ((value: string) => void) | null;
};

function lightenColor(color: string, amount = 0.4): string {
  const hex = color.replace("#", "");
  if (hex.length !== 6) {
    return color;
  }
  const num = parseInt(hex, 16);
  const r = (num >> 16) & 0xff;
  const g = (num >> 8) & 0xff;
  const b = num & 0xff;
  const mix = (channel: number) => Math.min(255, Math.round(channel + (255 - channel) * amount));
  const toHex = (channel: number) => channel.toString(16).padStart(2, "0");
  return `#${toHex(mix(r))}${toHex(mix(g))}${toHex(mix(b))}`;
}

function formatStoryPointsNumber(value: any): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return Number.isInteger(value) ? String(value) : String(value);
}

function buildTaskStoryPointsLabel(task: any): string {
  if (!task) {
    return "";
  }
  const own = Number.isFinite(task.storyPoints) ? task.storyPoints : null;
  const subtask = Number.isFinite(task.storyPointsSubtasksTotal) ? task.storyPointsSubtasksTotal : 0;
  if (own !== null) {
    if (subtask > 0) {
      return `★ ${formatStoryPointsNumber(own)} + ${formatStoryPointsNumber(subtask)}`;
    }
    return `★ ${formatStoryPointsNumber(own)}`;
  }
  if (subtask > 0) {
    return `★ +${formatStoryPointsNumber(subtask)}`;
  }
  return "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function insertTokenRespectState(line: string, token: string): string {
  const { indent, content } = splitIndent(line);
  const trimmed = content.trim();
  if (!trimmed) {
    return `${indent}${token}`;
  }
  const stateMatch = trimmed.match(/(^|\s)(![^\s#@~]+)/);
  if (stateMatch) {
    const stateToken = stateMatch[2];
    const rest = normalizeContent(
      trimmed.replace(/(^|\s)![^\s#@~]+(?=\s|$)/g, "$1")
    );
    const combined = rest ? `${stateToken} ${token} ${rest}` : `${stateToken} ${token}`;
    return `${indent}${normalizeContent(combined)}`;
  }
  return `${indent}${normalizeContent(`${token} ${trimmed}`)}`;
}

function findFirstNonEmptyLine(lines: string[], start: number, end: number): number {
  for (let i = start; i < end; i += 1) {
    if ((lines[i] ?? "").trim() !== "") {
      return i;
    }
  }
  return -1;
}

function lineHasTokens(line: string): boolean {
  const { content } = splitIndent(line);
  const trimmed = content.trim();
  if (!trimmed) {
    return false;
  }
  return trimmed.split(/\s+/).every((part) => (
    /^~\d+(?:\.\d+)?$/.test(part) || /^[#@!][^\s#@~]+$/.test(part)
  ));
}

function isEstimateToken(token: string): boolean {
  return /^~\d+(?:\.\d+)?$/.test((token || "").trim());
}

function removeEstimateTokensFromContent(content: string): string {
  return normalizeContent(content.replace(/(^|\s)~\d+(?:\.\d+)?(?=\s|$)/g, "$1"));
}

function appendEstimateTokenToLine(line: string, token: string): string {
  const { indent, content } = splitIndent(line);
  const cleaned = removeEstimateTokensFromContent(content);
  if (!cleaned) {
    return `${indent}${token}`;
  }
  return `${indent}${normalizeContent(`${cleaned} ${token}`)}`;
}

function removeLeadingBlankLines(lines: string[], start: number, end: number): number {
  let currentEnd = end;
  while (start < currentEnd && (lines[start] ?? "").trim() === "") {
    lines.splice(start, 1);
    currentEnd -= 1;
  }
  return currentEnd;
}

const UNASSIGNED_GROUP = "__unassigned__";
let lastKanbanClickAt = 0;
let lastKanbanClickId = "";
let openReferenceDropdown: HTMLElement | null = null;
let referenceDropdownHandlersBound = false;
const KANBAN_TOUCH_DRAG_THRESHOLD_PX = 10;
const KANBAN_TOUCH_DRAG_SUPPRESS_CLICK_MS = 360;
let activeKanbanTouchDrag: any = null;

function closeReferenceDropdown() {
  if (!openReferenceDropdown) {
    return;
  }
  openReferenceDropdown.classList.add("hidden");
  openReferenceDropdown = null;
}

function ensureReferenceDropdownHandlers() {
  if (referenceDropdownHandlersBound) {
    return;
  }
  referenceDropdownHandlersBound = true;
  document.addEventListener("click", () => {
    closeReferenceDropdown();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeReferenceDropdown();
    }
  });
}

function normalizeGroupBy(value: any): KanbanGroupBy {
  return value === "person" || value === "tag" ? value : "none";
}

function isKanbanDragDisabled(state: any): boolean {
  if (state?.historyViewerActive) {
    return true;
  }
  const viewportMode = String(state?.viewportMode || "");
  if (viewportMode === "mobile") {
    return true;
  }
  if (viewportMode === "tablet") {
    try {
      if (typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)")?.matches) {
        return true;
      }
    } catch {
      // Ignore environment capability errors.
    }
  }
  return false;
}

function findTouchByIdentifier(touches: TouchList, identifier: number): Touch | null {
  for (let index = 0; index < touches.length; index += 1) {
    const touch = touches.item(index);
    if (touch && touch.identifier === identifier) {
      return touch;
    }
  }
  return null;
}

function shouldIgnoreKanbanTouchDragStart(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  return Boolean(
    target.closest(
      "input, textarea, select, a, .pill, .task-reference-menu, .task-reference-dropdown, .task-reference-option"
    )
  );
}

function clearKanbanTouchDragHoverColumn(drag: any): void {
  if (!drag?.hoverColumn) {
    return;
  }
  drag.hoverColumn.classList.remove("drag-over");
  drag.hoverColumn = null;
}

function setKanbanTouchDragHoverColumn(drag: any, column: HTMLElement | null): void {
  if (drag?.hoverColumn === column) {
    return;
  }
  clearKanbanTouchDragHoverColumn(drag);
  if (!column) {
    return;
  }
  column.classList.add("drag-over");
  drag.hoverColumn = column;
}

function createKanbanTouchDragGhost(card: HTMLElement, clientX: number, clientY: number): any {
  const rect = card.getBoundingClientRect();
  const ghost = card.cloneNode(true) as HTMLElement;
  ghost.classList.remove("dragging", "deleting", "delete-preview");
  ghost.classList.add("drag-ghost");
  ghost.style.position = "fixed";
  ghost.style.top = "0";
  ghost.style.left = "0";
  ghost.style.margin = "0";
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  ghost.style.pointerEvents = "none";
  ghost.style.zIndex = "1200";
  document.body.appendChild(ghost);
  const offsetX = Math.max(0, Math.min(rect.width, clientX - rect.left));
  const offsetY = Math.max(0, Math.min(rect.height, clientY - rect.top));
  ghost.style.transform = `translate(${clientX - offsetX}px, ${clientY - offsetY}px)`;
  return { ghost, offsetX, offsetY };
}

function updateKanbanTouchDragGhost(drag: any): void {
  if (!drag?.ghost) {
    return;
  }
  drag.ghost.style.transform = `translate(${drag.lastClientX - drag.ghostOffsetX}px, ${drag.lastClientY - drag.ghostOffsetY}px)`;
}

function clearKanbanTouchDragGhost(drag: any): void {
  if (!drag?.ghost) {
    return;
  }
  drag.ghost.remove();
  drag.ghost = null;
}

function uniqueTokens(tokens: any[]): any[] {
  return Array.from(new Set(tokens));
}

function getGroupTokens(state: any, groupBy: KanbanGroupBy): string[] {
  if (groupBy === "person") {
    const order = state.config?.people?.map((person: any) => `@${person.key}`) || [];
    const extras = Array.from(state.people)
      .filter((person: any) => !order.includes(person))
      .sort((a, b) => String(a).localeCompare(String(b)));
    return [...order, ...extras];
  }
  if (groupBy === "tag") {
    const order = state.config?.tags?.map((tag: any) => `#${tag.key}`) || [];
    const extras = Array.from(state.tags)
      .filter((tag: any) => !order.includes(tag))
      .sort((a, b) => String(a).localeCompare(String(b)));
    return [...order, ...extras];
  }
  return [];
}

function getGroupMeta(state: any, groupBy: KanbanGroupBy, token: string): any {
  if (groupBy === "person") {
    return state.peopleMeta?.get(token);
  }
  if (groupBy === "tag") {
    return state.tagMeta?.get(token);
  }
  return null;
}

function getGroupLabel(groupBy: KanbanGroupBy, token: string, meta: any): string {
  if (token === UNASSIGNED_GROUP) {
    return groupBy === "person" ? "Unassigned" : "No tag";
  }
  const fallback = token.replace(/^[@#]/, "");
  if (groupBy === "person") {
    return `👤 ${meta?.name || fallback}`;
  }
  if (groupBy === "tag") {
    return `#${meta?.name || fallback}`;
  }
  return fallback;
}

function getTaskGroupKeys(task: any, groupBy: KanbanGroupBy): string[] {
  if (groupBy === "person") {
    const people = uniqueTokens(task.people || []);
    return people.length ? people : [UNASSIGNED_GROUP];
  }
  if (groupBy === "tag") {
    const tags = uniqueTokens(task.tags || []);
    return tags.length ? tags : [UNASSIGNED_GROUP];
  }
  return [UNASSIGNED_GROUP];
}

function getIncomingReferenceTasks(task: any): any[] {
  if (!task || !Array.isArray(task.incomingReferences)) {
    return [];
  }
  const unique: any[] = [];
  const seen = new Set();
  task.incomingReferences.forEach((sourceTask: any) => {
    const id = sourceTask?.id;
    if (!id || seen.has(id) || id === task.id) {
      return;
    }
    seen.add(id);
    unique.push(sourceTask);
  });
  unique.sort((a, b) => (a?.lineIndex || 0) - (b?.lineIndex || 0));
  return unique;
}

function renderKanbanDescription(
  { task, state, renderMarkdown, onToggleCheckbox }: {
    task: any;
    state: any;
    renderMarkdown?: ((text: string, options?: any) => string) | null;
    onToggleCheckbox?: ((lineIndex: number, checked: boolean) => void) | null;
  }
): HTMLElement | null {
  const descriptionText = buildTaskDescriptionText(task);
  if (!descriptionText || !descriptionText.trim()) {
    return null;
  }
  const descriptionOptions: any = {
    task,
    className: "kanban-card-description description",
    fallbackClassName: "kanban-card-description",
    baseIndent: Number.isFinite(task?.indent) ? task.indent : 0,
  };
  if (renderMarkdown !== undefined) {
    descriptionOptions.renderMarkdown = renderMarkdown;
  }
  if (Array.isArray(task?.descriptionLineIndexes)) {
    descriptionOptions.lineIndexes = task.descriptionLineIndexes;
  }
  const { node } = renderTaskDescriptionNode(descriptionOptions);

  decorateDescriptionReferences(node, {
    resolveTaskByName: (name: string) =>
      state.allTasks?.find((item: any) => (item?.name || "").trim() === name) || null,
  });
  decorateDescriptionPills(node, {
    tagMeta: state.tagMeta,
    peopleMeta: state.peopleMeta,
  });
  wireDescriptionCheckboxes(node, {
    lineFromClosest: false,
    stopPropagationEvents: ["click", "change"],
    triggerEvent: "change",
    disableWhenUnavailable: true,
    invalidTabIndex: -1,
    onToggle: ({ lineIndex, checked }) => {
      if (typeof onToggleCheckbox === "function") {
        onToggleCheckbox(lineIndex, checked);
      }
    },
  });

  return node;
}

function createReferenceIndicator(
  task: any,
  { selectTask, getTaskById }: { selectTask: (task: any) => void; getTaskById: (taskId: string) => any; }
): HTMLElement | null {
  const referenceTasks = getIncomingReferenceTasks(task);
  const safeCount = referenceTasks.length;
  if (!safeCount) {
    return null;
  }
  const label = safeCount === 1
    ? "Referenced by 1 task"
    : `Referenced by ${safeCount} tasks`;
  const menu = document.createElement("div");
  menu.className = "task-reference-menu";
  const indicator = document.createElement("button");
  indicator.type = "button";
  indicator.className = "task-reference-indicator";
  indicator.title = `${label}. Click to open list.`;
  indicator.setAttribute("aria-label", `${label}. Click to open list.`);
  const icon = document.createElement("i");
  icon.className = "fa-solid fa-link";
  icon.setAttribute("aria-hidden", "true");
  const countNode = document.createElement("span");
  countNode.textContent = String(safeCount);
  indicator.append(icon, countNode);
  const dropdown = document.createElement("div");
  dropdown.className = "task-reference-dropdown hidden";
  referenceTasks.forEach((sourceTask) => {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "task-reference-option";
    option.textContent = sourceTask?.name || "Untitled task";
    option.title = "Focus task";
    option.addEventListener("click", (event) => {
      event.stopPropagation();
      closeReferenceDropdown();
      const liveTask = getTaskById(sourceTask.id);
      if (liveTask) {
        selectTask(liveTask);
      }
    });
    dropdown.appendChild(option);
  });
  menu.append(indicator, dropdown);
  menu.addEventListener("click", (event) => {
    event.stopPropagation();
  });
  indicator.addEventListener("click", (event) => {
    event.stopPropagation();
    const isOpen = openReferenceDropdown === dropdown && !dropdown.classList.contains("hidden");
    closeReferenceDropdown();
    if (isOpen) {
      return;
    }
    dropdown.classList.remove("hidden");
    openReferenceDropdown = dropdown;
  });
  return menu;
}

function renderKanbanCardContent({
  card,
  task,
  state,
  renderMarkdown,
  onToggleCheckbox,
  matchesSearchTask,
  filtersActive,
  matchesFilters,
  selectTask,
  getTaskById,
}: any): void {
  const wasDragging = card.classList.contains("dragging");
  card.className = "kanban-card";
  if (wasDragging) {
    card.classList.add("dragging");
  }
  card.dataset.taskId = task.id;
  card.setAttribute("aria-current", "false");
  if (state.selectedTaskId === task.id) {
    card.classList.add("selected");
    card.setAttribute("aria-current", "true");
  } else {
    card.removeAttribute("aria-current");
  }
  card.style.borderColor = "";
  card.innerHTML = "";

  const titleNode = document.createElement("div");
  titleNode.className = "kanban-card-title";
  const displayTitle = task.name || "Untitled task";
  const jiraKey = task.jiraKey || parseJiraTitle(task.name || "").key;
  if (jiraKey) {
    const pill = document.createElement("span");
    pill.className = "pill jira-pill";
    pill.textContent = jiraKey;
    pill.title = `Copy ${jiraKey}`;
    pill.addEventListener("click", (event) => {
      event.stopPropagation();
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(jiraKey);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = jiraKey;
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
    });
    titleNode.appendChild(pill);
  }
  titleNode.append(displayTitle);
  const referenceIndicator = createReferenceIndicator(task, { selectTask, getTaskById });
  if (referenceIndicator) {
    titleNode.appendChild(referenceIndicator);
  }
  card.appendChild(titleNode);
  const metaWrap = document.createElement("div");
  metaWrap.className = "kanban-card-meta";
  let hasMeta = false;
  const storyPointsLabel = buildTaskStoryPointsLabel(task);
  if (task.people.length) {
    const person = task.people[0];
    const meta = state.peopleMeta?.get(person);
    const pill = document.createElement("span");
    pill.className = "pill kanban-person";
    pill.textContent = `👤 ${meta?.name || person.replace("@", "")}`;
    if (meta?.color) {
      pill.style.borderColor = meta.color;
    }
    metaWrap.appendChild(pill);
    hasMeta = true;
  }
  if (task.tags.length) {
    const seenTags = new Set();
    task.tags.forEach((tag: any) => {
      if (seenTags.has(tag)) {
        return;
      }
      seenTags.add(tag);
      const meta = state.tagMeta?.get(tag);
      const pill = document.createElement("span");
      pill.className = "pill kanban-tag";
      pill.textContent = `#${meta?.name || tag.replace("#", "")}`;
      if (meta?.color) {
        pill.style.borderColor = meta.color;
      }
      metaWrap.appendChild(pill);
      hasMeta = true;
    });
  }
  if (hasMeta) {
    card.appendChild(metaWrap);
  }
  const descriptionNode = renderKanbanDescription({
    task,
    state,
    renderMarkdown,
    onToggleCheckbox,
  });
  if (descriptionNode) {
    card.appendChild(descriptionNode);
  }
  if (storyPointsLabel) {
    const storyPill = document.createElement("span");
    storyPill.className = "pill story-points-pill task-story-points-corner";
    storyPill.textContent = storyPointsLabel;
    card.appendChild(storyPill);
  }
  if (matchesSearchTask(task)) {
    card.classList.add("kanban-search");
  }
  if (filtersActive() && !matchesFilters(task)) {
    card.classList.add("kanban-hidden");
  }
  if (task.state) {
    const color = state.stateMeta?.get(task.state)?.color;
    if (color) {
      card.style.borderColor = lightenColor(color, 0.5);
    }
  }
}

function bindKanbanCard({
  card,
  state,
  selectTask,
  onEditTask,
  getTaskById,
  updateTaskState,
}: any): void {
  card.draggable = !isKanbanDragDisabled(state);
  if (card.dataset.bound) {
    return;
  }
  card.dataset.bound = "true";
  card.addEventListener("click", () => {
    const suppressUntil = Number(card.dataset.touchDragSuppressUntil || "0");
    if (Number.isFinite(suppressUntil) && suppressUntil > Date.now()) {
      return;
    }
    const task = getTaskById(card.dataset.taskId);
    if (task) {
      selectTask(task);
      const now = performance.now();
      if (lastKanbanClickId === task.id && now - lastKanbanClickAt < 320) {
        if (onEditTask) {
          onEditTask(task);
        }
        lastKanbanClickAt = 0;
        lastKanbanClickId = "";
      } else {
        lastKanbanClickAt = now;
        lastKanbanClickId = task.id;
      }
    }
  });
  card.addEventListener("dblclick", () => {
    if (!onEditTask) {
      return;
    }
    const task = getTaskById(card.dataset.taskId);
    if (task) {
      onEditTask(task);
    }
  });
  card.addEventListener("touchstart", (event: TouchEvent) => {
    if (state?.historyViewerActive || shouldIgnoreKanbanTouchDragStart(event.target)) {
      return;
    }
    if (event.touches.length !== 1 || activeKanbanTouchDrag) {
      return;
    }
    const task = getTaskById(card.dataset.taskId);
    if (!task) {
      return;
    }
    const touch = event.changedTouches.item(0);
    if (!touch) {
      return;
    }
    activeKanbanTouchDrag = {
      taskId: task.id,
      touchId: touch.identifier,
      card,
      startClientX: touch.clientX,
      startClientY: touch.clientY,
      lastClientX: touch.clientX,
      lastClientY: touch.clientY,
      dragging: false,
      ghost: null,
      ghostOffsetX: 0,
      ghostOffsetY: 0,
      hoverColumn: null,
    };
  }, { passive: true });
  card.addEventListener("touchmove", (event: TouchEvent) => {
    const drag = activeKanbanTouchDrag;
    if (!drag || drag.card !== card) {
      return;
    }
    const touch = findTouchByIdentifier(event.touches, drag.touchId);
    if (!touch) {
      return;
    }
    drag.lastClientX = touch.clientX;
    drag.lastClientY = touch.clientY;
    if (!drag.dragging) {
      const distance = Math.hypot(
        drag.lastClientX - drag.startClientX,
        drag.lastClientY - drag.startClientY
      );
      if (distance < KANBAN_TOUCH_DRAG_THRESHOLD_PX) {
        event.preventDefault();
        return;
      }
      drag.dragging = true;
      card.classList.add("dragging");
      const ghostPayload = createKanbanTouchDragGhost(card, drag.lastClientX, drag.lastClientY);
      drag.ghost = ghostPayload.ghost;
      drag.ghostOffsetX = ghostPayload.offsetX;
      drag.ghostOffsetY = ghostPayload.offsetY;
      window.dispatchEvent(new CustomEvent("taskdragstart"));
    }
    event.preventDefault();
    updateKanbanTouchDragGhost(drag);
    const hoveredElement = document.elementFromPoint(drag.lastClientX, drag.lastClientY);
    const hoveredColumn = hoveredElement?.closest?.(".kanban-column") as HTMLElement | null;
    setKanbanTouchDragHoverColumn(drag, hoveredColumn);
  }, { passive: false });
  card.addEventListener("touchend", (event: TouchEvent) => {
    const drag = activeKanbanTouchDrag;
    if (!drag || drag.card !== card) {
      return;
    }
    const endedTouch = findTouchByIdentifier(event.changedTouches, drag.touchId);
    if (!endedTouch) {
      return;
    }
    drag.lastClientX = endedTouch.clientX;
    drag.lastClientY = endedTouch.clientY;
    if (drag.dragging) {
      event.preventDefault();
      const task = getTaskById(drag.taskId);
      const nextState = String(drag.hoverColumn?.dataset?.stateTag || "");
      if (task && nextState && task.state !== nextState) {
        updateTaskState(task, nextState);
      }
      card.dataset.touchDragSuppressUntil = String(Date.now() + KANBAN_TOUCH_DRAG_SUPPRESS_CLICK_MS);
      window.dispatchEvent(new CustomEvent("taskdragend"));
    }
    clearKanbanTouchDragHoverColumn(drag);
    clearKanbanTouchDragGhost(drag);
    card.classList.remove("dragging");
    activeKanbanTouchDrag = null;
  }, { passive: false });
  card.addEventListener("touchcancel", () => {
    const drag = activeKanbanTouchDrag;
    if (!drag || drag.card !== card) {
      return;
    }
    if (drag.dragging) {
      window.dispatchEvent(new CustomEvent("taskdragend"));
    }
    clearKanbanTouchDragHoverColumn(drag);
    clearKanbanTouchDragGhost(drag);
    card.classList.remove("dragging");
    activeKanbanTouchDrag = null;
  });
  card.addEventListener("dragstart", (event: DragEvent) => {
    if (isKanbanDragDisabled(state)) {
      event.preventDefault();
      return;
    }
    const task = getTaskById(card.dataset.taskId);
    if (!task) {
      return;
    }
    const dataTransfer = event.dataTransfer;
    if (!dataTransfer) {
      return;
    }
    const rect = card.getBoundingClientRect();
    const ghost = card.cloneNode(true);
    ghost.classList.add("drag-ghost");
    ghost.style.position = "absolute";
    ghost.style.top = "-9999px";
    ghost.style.left = "-9999px";
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    document.body.appendChild(ghost);
    dataTransfer.setDragImage(
      ghost,
      ghost.offsetWidth / 2,
      ghost.offsetHeight / 2
    );
    card.classList.add("dragging");
    dataTransfer.setData("text/plain", task.id);
    dataTransfer.setData(
      "application/json",
      JSON.stringify({
        type: "task",
        source: "kanban",
        taskId: task.id,
      })
    );
    window.dispatchEvent(new CustomEvent("taskdragstart"));
    card._dragGhost = ghost;
  });
  card.addEventListener("dragend", () => {
    card.classList.remove("dragging");
    if (card._dragGhost) {
      card._dragGhost.remove();
      card._dragGhost = null;
    }
    window.dispatchEvent(new CustomEvent("taskdragend"));
  });
}

function createKanbanColumn({
  state,
  stateTag,
  tasks,
  selectTask,
  onEditTask,
  matchesSearchTask,
  filtersActive,
  matchesFilters,
  renderMarkdown,
  onToggleCheckbox,
  updateTaskState,
  existingCards,
  getTaskById,
}: any): HTMLDivElement {
  const column = document.createElement("div");
  column.className = "kanban-column";
  column.dataset["stateTag"] = stateTag;
  const metaColor = state.stateMeta?.get(stateTag)?.color;
  if (metaColor) {
    column.style.borderColor = lightenColor(metaColor, 0.5);
  }
  const title = document.createElement("h3");
  title.textContent =
    state.stateMeta?.get(stateTag)?.name ||
    stateTag.replace(/^!/, "").replace(/^\w/, (char: string) => char.toUpperCase());
  column.appendChild(title);
  const list = document.createElement("div");
  list.className = "kanban-list";
  tasks.forEach((task: any) => {
    let card = existingCards?.get(task.id);
    if (!card) {
      card = document.createElement("button");
      card.type = "button";
    }
    renderKanbanCardContent({
      card,
      task,
      state,
      renderMarkdown,
      onToggleCheckbox,
      matchesSearchTask,
      filtersActive,
      matchesFilters,
      selectTask,
      getTaskById,
    });
    bindKanbanCard({
      card,
      state,
      selectTask,
      onEditTask,
      getTaskById,
      updateTaskState,
    });
    list.appendChild(card);
  });
  column.appendChild(list);
  column.addEventListener("dragover", (event) => {
    if (isKanbanDragDisabled(state)) {
      return;
    }
    event.preventDefault();
    column.classList.add("drag-over");
  });
  column.addEventListener("dragleave", (event) => {
    if (event.relatedTarget instanceof Node && column.contains(event.relatedTarget)) {
      return;
    }
    column.classList.remove("drag-over");
  });
  column.addEventListener("drop", (event) => {
    if (isKanbanDragDisabled(state)) {
      event.preventDefault();
      column.classList.remove("drag-over");
      return;
    }
    event.preventDefault();
    column.classList.remove("drag-over");
    const dataTransfer = event.dataTransfer;
    if (!dataTransfer) {
      return;
    }
    const taskId = dataTransfer.getData("text/plain");
    const task = state.allTasks.find((item: any) => item.id === taskId);
    if (!task) {
      return;
    }
    const nextState = column.dataset["stateTag"];
    if (task.state === nextState) {
      return;
    }
    updateTaskState(task, nextState);
  });
  return column;
}

export function buildKanban({
  state,
  dom,
  renderMarkdown,
  selectTask,
  onEditTask,
  matchesSearchTask,
  filtersActive,
  matchesFilters,
  updateTaskState,
  onToggleCheckbox,
  groupBy = "none",
}: BuildKanbanOptions): void {
  if (!dom.kanbanBoard) {
    return;
  }
  ensureReferenceDropdownHandlers();
  closeReferenceDropdown();
  const getTaskById = (taskId: string) =>
    state.allTasks.find((item: any) => item.id === taskId) || null;
  const normalizedGroupBy = normalizeGroupBy(groupBy);
  const reuseCards = normalizedGroupBy === "none";
  const existingCards = reuseCards ? new Map() : null;
  if (reuseCards) {
    const existingCardsMap = existingCards;
    if (!existingCardsMap) {
      return;
    }
    dom.kanbanBoard
      .querySelectorAll(".kanban-card[data-task-id]")
      .forEach((card: any) => {
        existingCardsMap.set(card.dataset.taskId, card);
      });
  }
  const content = dom.kanbanContent || dom.kanbanBoard;
  let groupFloat = null;
  if (content === dom.kanbanBoard) {
    groupFloat = dom.kanbanBoard.querySelector(".kanban-group-float");
    if (groupFloat) {
      groupFloat.remove();
    }
  }
  content.innerHTML = "";
  if (groupFloat) {
    content.appendChild(groupFloat);
  }
  dom.kanbanBoard.classList.toggle("kanban-grouped", normalizedGroupBy !== "none");
  const stateOrder = state.config?.states?.map((stateItem: any) => `!${stateItem.key}`) || [];
  const extraStates = Array.from(state.states)
    .filter((stateTag: any) => !stateOrder.includes(stateTag))
    .sort((a, b) => String(a).localeCompare(String(b)));
  const states = [...stateOrder, ...extraStates];
  const stateSet = new Set(states);
  const filterEnabled = filtersActive();
  const shouldIncludeTask = (task: any) => !filterEnabled || matchesFilters(task);
  if (normalizedGroupBy === "none") {
    const tasksByState = new Map();
    states.forEach((stateTag) => tasksByState.set(stateTag, []));
    state.allTasks.forEach((task: any) => {
      if (task.state && tasksByState.has(task.state)) {
        if (!shouldIncludeTask(task)) {
          return;
        }
        tasksByState.get(task.state)?.push(task);
      }
    });
    states.forEach((stateTag) => {
      const column = createKanbanColumn({
        state,
        stateTag,
        tasks: tasksByState.get(stateTag) || [],
        selectTask,
        onEditTask,
        matchesSearchTask,
        filtersActive,
        matchesFilters,
        renderMarkdown,
        onToggleCheckbox,
        updateTaskState,
        existingCards,
        getTaskById,
      });
      content.appendChild(column);
    });
    return;
  }

  const groups = getGroupTokens(state, normalizedGroupBy).map((token: string) => {
    const meta = getGroupMeta(state, normalizedGroupBy, token);
    return {
      key: token,
      label: getGroupLabel(normalizedGroupBy, token, meta),
      color: meta?.color || "",
    };
  });

  const needsUnassigned = state.allTasks.some((task: any) => {
    if (!task.state || !stateSet.has(task.state)) {
      return false;
    }
    if (!shouldIncludeTask(task)) {
      return false;
    }
    if (normalizedGroupBy === "person") {
      return !task.people?.length;
    }
    if (normalizedGroupBy === "tag") {
      return !task.tags?.length;
    }
    return false;
  });
  if (needsUnassigned) {
    groups.push({
      key: UNASSIGNED_GROUP,
      label: getGroupLabel(normalizedGroupBy, UNASSIGNED_GROUP, null),
      color: "",
    });
  }

  const groupedTasks = new Map();
  groups.forEach((group) => {
    const byState = new Map();
    states.forEach((stateTag) => byState.set(stateTag, []));
    groupedTasks.set(group.key, byState);
  });

  state.allTasks.forEach((task: any) => {
    if (!task.state || !stateSet.has(task.state)) {
      return;
    }
    if (!shouldIncludeTask(task)) {
      return;
    }
    const groupKeys = getTaskGroupKeys(task, normalizedGroupBy);
    groupKeys.forEach((key) => {
      const groupBucket = groupedTasks.get(key);
      if (!groupBucket) {
        return;
      }
      groupBucket.get(task.state)?.push(task);
    });
  });

  const visibleGroups = groups.filter((group: any) => {
    const groupBucket = groupedTasks.get(group.key);
    if (!groupBucket) {
      return false;
    }
    for (const tasks of groupBucket.values()) {
      if (tasks.length) {
        return true;
      }
    }
    return false;
  });

  visibleGroups.forEach((group: any) => {
    const lane = document.createElement("div");
    lane.className = "kanban-lane";
    lane.dataset["groupKey"] = group.key;
    const header = document.createElement("div");
    header.className = "kanban-lane-header";
    const dot = document.createElement("span");
    dot.className = "kanban-lane-dot";
    if (group.color) {
      dot.style.background = group.color;
    } else {
      dot.classList.add("empty");
    }
    const title = document.createElement("span");
    title.textContent = group.label;
    header.appendChild(dot);
    header.appendChild(title);
    lane.appendChild(header);
    const columns = document.createElement("div");
    columns.className = "kanban-lane-columns";
    states.forEach((stateTag) => {
      const column = createKanbanColumn({
        state,
        stateTag,
        tasks: groupedTasks.get(group.key)?.get(stateTag) || [],
        selectTask,
        onEditTask,
        matchesSearchTask,
        filtersActive,
        matchesFilters,
        renderMarkdown,
        onToggleCheckbox,
        updateTaskState,
        existingCards: null,
        getTaskById,
      });
      columns.appendChild(column);
    });
    lane.appendChild(columns);
    content.appendChild(lane);
  });
}

export function updateTaskState(
  { task, newState, dom, sync, applyEditorValue }: UpdateTaskStateOptions
): void {
  const lines = dom.editor.value.split("\n");
  const taskLine = lines[task.lineIndex] || "";
  const indentMatch = taskLine.match(/^(\s*)%/) || ["", ""];
  const indent = indentMatch[1] || "";
  let start = task.lineIndex + 1;
  let end = start;
  while (end < lines.length) {
    const line = lines[end];
    if (/^\s*%/.test(line)) {
      break;
    }
    end += 1;
  }
  const originalSlice = lines.slice(start, end);
  const stateMatch = /(^|\s)![^\s#@]+(?=\s|$)/;
  const stateReplace = /(^|\s)![^\s#@]+(?=\s|$)/g;
  if (start === end) {
    if (newState) {
      lines.splice(start, 0, `${indent}${newState}`, "");
    }
  } else {
    for (let i = start; i < end; i += 1) {
      if (lines[i].trim() === "") {
        continue;
      }
      const { indent: lineIndent, content } = splitIndent(lines[i]);
      if (stateMatch.test(content)) {
        const cleaned = normalizeContent(content.replace(stateReplace, "$1"));
        lines[i] = cleaned ? `${lineIndent}${cleaned}` : "";
      }
    }
    const emptyIndexes = [];
    for (let i = start; i < end; i += 1) {
      if (lines[i].trim() === "" && originalSlice[i - start].trim() !== "") {
        emptyIndexes.push(i);
      }
    }
    for (let i = emptyIndexes.length - 1; i >= 0; i -= 1) {
      lines.splice(emptyIndexes[i], 1);
      end -= 1;
    }
    if (newState) {
      const firstNonEmpty = findFirstNonEmptyLine(lines, start, end);
      if (firstNonEmpty === -1) {
        lines.splice(start, 0, `${indent}${newState}`, "");
      } else if (lineHasTokens(lines[firstNonEmpty])) {
        lines[firstNonEmpty] = prependTokenToLine(lines[firstNonEmpty], newState);
      } else {
        lines.splice(start, 0, `${indent}${newState}`);
      }
    } else {
      end = removeLeadingBlankLines(lines, start, end);
    }
  }
  const nextValue = lines.join("\n");
  if (applyEditorValue) {
    applyEditorValue(nextValue);
  } else {
    dom.editor.value = nextValue;
  }
  sync();
}

export function updateTaskToken(
  { task, token, action, dom, sync, applyEditorValue }: UpdateTaskTokenOptions
): void {
  const lines = dom.editor.value.split("\n");
  const taskLine = lines[task.lineIndex] || "";
  const indentMatch = taskLine.match(/^(\s*)%/) || ["", ""];
  const indent = indentMatch[1] || "";
  let start = task.lineIndex + 1;
  let end = start;
  while (end < lines.length) {
    const line = lines[end];
    if (/^\s*%/.test(line)) {
      break;
    }
    end += 1;
  }
  const originalSlice = lines.slice(start, end);
  const estimateToken = isEstimateToken(token);
  const tokenMatch = estimateToken
    ? /(^|\s)~\d+(?:\.\d+)?(?=\s|$)/
    : new RegExp(`(^|\\s)${escapeRegExp(token)}(?=\\s|$)`);
  const tokenReplace = estimateToken
    ? /(^|\s)~\d+(?:\.\d+)?(?=\s|$)/g
    : new RegExp(`(^|\\s)${escapeRegExp(token)}(?=\\s|$)`, "g");
  const hasToken = lines
    .slice(start, end)
    .some((line: string) => tokenMatch.test(splitIndent(line).content));
  if (action === "add") {
    const stripToken = (line: string): string => {
      const { indent: lineIndent, content } = splitIndent(line);
      if (!tokenMatch.test(content)) {
        return line;
      }
      const cleaned = estimateToken
        ? removeEstimateTokensFromContent(content)
        : normalizeContent(content.replace(tokenReplace, "$1"));
      return cleaned ? `${lineIndent}${cleaned}` : "";
    };
    if (hasToken) {
      for (let i = start; i < end; i += 1) {
        lines[i] = stripToken(lines[i]);
      }
    }
    const firstNonEmpty = findFirstNonEmptyLine(lines, start, end);
    if (firstNonEmpty === -1) {
      lines.splice(start, 0, `${indent}${token}`, "");
    } else if (lineHasTokens(lines[firstNonEmpty])) {
      lines[firstNonEmpty] = estimateToken
        ? appendEstimateTokenToLine(lines[firstNonEmpty], token)
        : insertTokenRespectState(lines[firstNonEmpty], token);
    } else {
      lines.splice(start, 0, `${indent}${token}`);
    }
  } else if (action === "remove") {
    if (start === end) {
      return;
    }
    for (let i = start; i < end; i += 1) {
      const { indent: lineIndent, content } = splitIndent(lines[i]);
      if (!tokenMatch.test(content)) {
        continue;
      }
      const cleaned = estimateToken
        ? removeEstimateTokensFromContent(content)
        : normalizeContent(content.replace(tokenReplace, "$1"));
      lines[i] = cleaned ? `${lineIndent}${cleaned}` : "";
    }
    const emptyIndexes = [];
    for (let i = start; i < end; i += 1) {
      if (lines[i].trim() === "" && originalSlice[i - start].trim() !== "") {
        emptyIndexes.push(i);
      }
    }
    for (let i = emptyIndexes.length - 1; i >= 0; i -= 1) {
      lines.splice(emptyIndexes[i], 1);
    }
    removeLeadingBlankLines(lines, start, end);
  }
  const nextValue = lines.join("\n");
  if (applyEditorValue) {
    applyEditorValue(nextValue);
  } else {
    dom.editor.value = nextValue;
  }
  sync();
}
