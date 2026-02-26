// @ts-check

import { colorFromString } from "./task.js";
import {
  decorateDescriptionPills,
  decorateDescriptionReferences,
  renderTaskDescriptionNode,
  wireDescriptionCheckboxes,
} from "./taskDescription.js";

type CreateCanvasOptions = {
  state: any;
  dom: any;
  renderMarkdown?: ((text: string, options?: any) => string) | null;
  onSelectTask: (task: any) => void;
  onEditTask?: ((task: any) => void) | null;
  findTaskByName: (name: string) => any;
  onUpdateTaskToken?: ((task: any, token: string, action: string) => void) | null;
  onUpdateTaskState?: ((task: any, stateTag: string | null) => void) | null;
  onMakeSubtask?: ((task: any, parentTask: any) => void) | null;
  onReorderTask?: ((task: any, targetTask: any, position: string, options?: any) => any) | null;
  onToggleCheckbox?: ((lineIndex: number, checked: boolean) => void) | null;
  onFiltersChange?: (() => void) | null;
};

export function createCanvas({
  state,
  dom,
  renderMarkdown,
  onSelectTask,
  onEditTask,
  findTaskByName,
  onUpdateTaskToken,
  onUpdateTaskState,
  onMakeSubtask,
  onReorderTask,
  onToggleCheckbox,
  onFiltersChange,
}: CreateCanvasOptions) {
  const { graphNodes, graphLines, graphCanvas, graphMinimap, minimapSvg } = dom;
  const GRAPH_ZOOM_MIN = 0.25;
  const GRAPH_ZOOM_MAX = 2.5;
  const GRAPH_ZOOM_STEP = 0.1;
  const ZOOM_REDRAW_DELAY_MS = 140;
  let lineAnimationFrame: number | null = null;
  let lineAnimationUntil = 0;
  let lastVisibleTasks: any[] = [];
  let lastNodesById = new Map();
  let lastClickAt = 0;
  let lastClickTaskId = "";
  let zoomRedrawTimeout: ReturnType<typeof setTimeout> | null = null;
  let openReferenceDropdown: HTMLElement | null = null;
  let activeDraggedTaskId = "";
  let activeGraphReorder: any = null;
  const GRAPH_REORDER_EDGE_PX = 18;
  const GRAPH_DROP_LINE_HEIGHT_PX = 3;
  const GRAPH_DROP_OUTER_SPACING_PX = 12;
  const GRAPH_DROP_PREVIEW_SHIFT_MAX_PX = 18;

  const formatStoryPointsNumber = (value: any): string => {
    if (!Number.isFinite(value)) {
      return "0";
    }
    return Number.isInteger(value) ? String(value) : String(value);
  };

  const createStoryPointsPill = (label: string): HTMLSpanElement => {
    const pill = document.createElement("span");
    pill.className = "pill story-points-pill";
    pill.textContent = label;
    pill.title = "Story points";
    return pill;
  };

  const copyToClipboard = async (text: string): Promise<void> => {
    if (!text) {
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Ignore and fallback below.
    }
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
  };

  const getTaskById = (taskId: string) =>
    state.allTasks.find((item: any) => item.id === taskId) || null;

  const closeReferenceDropdown = () => {
    if (!openReferenceDropdown) {
      return;
    }
    openReferenceDropdown.classList.add("hidden");
    openReferenceDropdown = null;
  };

  document.addEventListener("click", () => {
    closeReferenceDropdown();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeReferenceDropdown();
    }
  });

  const getIncomingReferenceTasks = (task: any): any[] => {
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
  };

  const createReferenceIndicator = (task: any): HTMLElement | null => {
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
          onSelectTask(liveTask);
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
  };

  let tokenDragGhost: HTMLElement | null = null;

  const clearTokenDragGhost = () => {
    if (!tokenDragGhost) {
      return;
    }
    tokenDragGhost.remove();
    tokenDragGhost = null;
  };

  const setTokenDragImage = (
    event: DragEvent,
    sourceEl: HTMLElement | null,
    options: { scaleWithZoom?: boolean } = {}
  ): void => {
    const dataTransfer = event.dataTransfer;
    if (!dataTransfer || !sourceEl) {
      return;
    }
    const rect = sourceEl.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return;
    }
    clearTokenDragGhost();
    const scaleWithZoom = options.scaleWithZoom !== false;
    const scale = scaleWithZoom ? Math.max(0.01, state.transform?.scale || 1) : 1;
    const ghost = sourceEl.cloneNode(true) as HTMLElement;
    ghost.classList.add("drag-ghost");
    ghost.style.position = "absolute";
    ghost.style.top = "-9999px";
    ghost.style.left = "-9999px";
    ghost.style.margin = "0";
    ghost.style.width = `${rect.width / scale}px`;
    ghost.style.height = `${rect.height / scale}px`;
    if ("zoom" in ghost.style) {
      (ghost.style as any).zoom = String(scale);
    } else {
      (ghost.style as CSSStyleDeclaration).transformOrigin = "top left";
      (ghost.style as CSSStyleDeclaration).transform = `scale(${scale})`;
    }
    ghost.style.pointerEvents = "none";
    document.body.appendChild(ghost);
    tokenDragGhost = ghost;
    const offsetX = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
    const offsetY = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
    dataTransfer.setDragImage(ghost, offsetX, offsetY);
  };

  const isTaskDrag = (event: DragEvent): boolean => {
    const dataTransfer = event.dataTransfer;
    if (!dataTransfer) {
      return false;
    }
    const types = Array.from(dataTransfer.types || []);
    if (types.includes("application/json")) {
      const payload = dataTransfer.getData("application/json");
      if (payload) {
        try {
          const data = JSON.parse(payload);
          return data.type === "task";
        } catch {
          return false;
        }
      }
    }
    return types.includes("text/plain");
  };

  const getDraggedTaskId = (event: DragEvent): string | null => {
    if (activeDraggedTaskId) {
      return activeDraggedTaskId;
    }
    const dataTransfer = event.dataTransfer;
    if (!dataTransfer) {
      return null;
    }
    const payload = dataTransfer.getData("application/json");
    if (payload) {
      try {
        const data = JSON.parse(payload);
        if (data.type === "task" && data.taskId) {
          return data.taskId;
        }
      } catch {
        return null;
      }
    }
    const text = dataTransfer.getData("text/plain");
    return text || null;
  };

  const clearGraphParentTargets = () => {
    graphNodes?.querySelectorAll?.(".task-node.drag-parent-target").forEach((node: any) => {
      node.classList.remove("drag-parent-target");
    });
  };

  const clearGraphReorderIndicators = () => {
    graphNodes?.querySelectorAll?.(".task-node").forEach((node: any) => {
      node.classList.remove("drop-before", "drop-after", "drop-gap-prev", "drop-gap-next");
      node.style.removeProperty("--task-drop-before-offset");
      node.style.removeProperty("--task-drop-after-offset");
      node.style.removeProperty("--task-drop-shift-y");
    });
    activeGraphReorder = null;
  };

  const clearGraphDropIndicators = () => {
    clearGraphParentTargets();
    clearGraphReorderIndicators();
  };

  const applyGraphReorderIndicator = (target: any): void => {
    if (
      activeGraphReorder &&
      target &&
      activeGraphReorder.targetTaskId === target.targetTaskId &&
      activeGraphReorder.position === target.position
    ) {
      clearGraphParentTargets();
      return;
    }
    clearGraphParentTargets();
    clearGraphReorderIndicators();
    if (!target?.node) {
      return;
    }
    // Keep reorder targeting state/animation, but do not render horizontal drop lines.
    target.node.style.removeProperty("--task-drop-before-offset");
    target.node.style.removeProperty("--task-drop-after-offset");
    if (target.previewPrevNode && target.previewNextNode && Number.isFinite(target.previewShiftPx)) {
      target.previewPrevNode.classList.add("drop-gap-prev");
      target.previewNextNode.classList.add("drop-gap-next");
      target.previewPrevNode.style.setProperty("--task-drop-shift-y", `${-target.previewShiftPx}px`);
      target.previewNextNode.style.setProperty("--task-drop-shift-y", `${target.previewShiftPx}px`);
    } else if (Number.isFinite(target.previewShiftPx)) {
      if (target.previewPrevNode) {
        target.previewPrevNode.classList.add("drop-gap-prev");
        target.previewPrevNode.style.setProperty("--task-drop-shift-y", `${-target.previewShiftPx}px`);
      }
      if (target.previewNextNode) {
        target.previewNextNode.classList.add("drop-gap-next");
        target.previewNextNode.style.setProperty("--task-drop-shift-y", `${target.previewShiftPx}px`);
      }
    }
    activeGraphReorder = {
      targetTaskId: target.targetTaskId,
      position: target.position,
      allowRootReparent: Boolean(target.allowRootReparent),
      beforeOffsetPx: Number.isFinite(target.beforeOffsetPx) ? target.beforeOffsetPx : null,
      afterOffsetPx: Number.isFinite(target.afterOffsetPx) ? target.afterOffsetPx : null,
    };
  };

  const getGraphReorderMode = (draggedTask: any, targetTask: any): "sibling" | "to-root" | null => {
    if (!draggedTask || !targetTask || draggedTask.id === targetTask.id) {
      return null;
    }
    const draggedParentId = draggedTask.parent?.id || null;
    const targetParentId = targetTask.parent?.id || null;
    if (draggedParentId === targetParentId) {
      return "sibling";
    }
    if (draggedParentId !== null && targetParentId === null) {
      return "to-root";
    }
    return null;
  };

  const isCurrentParentTarget = (draggedTask: any, targetTask: any): boolean => (
    Boolean(draggedTask && targetTask && (draggedTask.parent?.id || null) === targetTask.id)
  );

  const getGraphReorderCandidates = (draggedTask: any, clientX: number): any[] => {
    if (!draggedTask || !Number.isFinite(clientX)) {
      return [];
    }
    const candidates: any[] = [];
    graphNodes.querySelectorAll(".task-node[data-task-id]").forEach((node: any) => {
      const targetTaskId = node.dataset.taskId;
      if (!targetTaskId || targetTaskId === draggedTask.id) {
        return;
      }
      const targetTask = getTaskById(targetTaskId);
      const reorderMode = getGraphReorderMode(draggedTask, targetTask);
      if (!reorderMode) {
        return;
      }
      const rect = node.getBoundingClientRect();
      if (
        !Number.isFinite(rect.left) ||
        !Number.isFinite(rect.right) ||
        !Number.isFinite(rect.top) ||
        !Number.isFinite(rect.bottom)
      ) {
        return;
      }
      if (clientX < rect.left || clientX > rect.right) {
        return;
      }
      candidates.push({
        node,
        rect,
        targetTaskId,
        allowRootReparent: reorderMode === "to-root",
      });
    });
    candidates.sort((a, b) => a.rect.top - b.rect.top);
    return candidates;
  };

  const buildBeforeTargetFromCandidate = (candidates: any[], index: number): any => {
    const candidate = candidates[index];
    if (!candidate) {
      return null;
    }
    let beforeOffsetPx: number | null = null;
    let previewPrevNode: any = null;
    let previewNextNode: any = null;
    let previewShiftPx: number | null = null;
    if (index > 0) {
      const previous = candidates[index - 1];
      const gap = Math.max(0, candidate.rect.top - previous.rect.bottom);
      const midpointY = previous.rect.bottom + (gap / 2);
      beforeOffsetPx = midpointY - candidate.rect.top - (GRAPH_DROP_LINE_HEIGHT_PX / 2);
      const shift = Math.min(GRAPH_DROP_PREVIEW_SHIFT_MAX_PX, gap / 3);
      if (shift > 0.5) {
        previewPrevNode = previous.node;
        previewNextNode = candidate.node;
        previewShiftPx = shift;
      }
    } else {
      let outerSpacing = GRAPH_DROP_OUTER_SPACING_PX;
      if (candidates.length > 1) {
        const next = candidates[1];
        const gap = Math.max(0, next.rect.top - candidate.rect.bottom);
        outerSpacing = gap > 0 ? (gap / 2) : GRAPH_DROP_OUTER_SPACING_PX;
      }
      beforeOffsetPx = -(outerSpacing + (GRAPH_DROP_LINE_HEIGHT_PX / 2));
      const shift = Math.min(GRAPH_DROP_PREVIEW_SHIFT_MAX_PX, outerSpacing * 0.75);
      if (shift > 0.5) {
        previewNextNode = candidate.node;
        previewShiftPx = shift;
      }
    }
    return {
      node: candidate.node,
      targetTaskId: candidate.targetTaskId,
      position: "before",
      allowRootReparent: Boolean(candidate.allowRootReparent),
      beforeOffsetPx,
      previewPrevNode,
      previewNextNode,
      previewShiftPx,
    };
  };

  const buildAfterTargetFromCandidate = (candidates: any[], index: number): any => {
    const candidate = candidates[index];
    if (!candidate) {
      return null;
    }
    let afterOffsetPx: number | null = null;
    let previewPrevNode: any = null;
    let previewNextNode: any = null;
    let previewShiftPx: number | null = null;
    if (index >= 0 && index < candidates.length - 1) {
      const next = candidates[index + 1];
      const gap = Math.max(0, next.rect.top - candidate.rect.bottom);
      const midpointY = candidate.rect.bottom + (gap / 2);
      afterOffsetPx = candidate.rect.bottom - midpointY - (GRAPH_DROP_LINE_HEIGHT_PX / 2);
    } else {
      let outerSpacing = GRAPH_DROP_OUTER_SPACING_PX;
      if (candidates.length > 1) {
        const previous = candidates[candidates.length - 2];
        const gap = Math.max(0, candidate.rect.top - previous.rect.bottom);
        outerSpacing = gap > 0 ? (gap / 2) : GRAPH_DROP_OUTER_SPACING_PX;
      }
      afterOffsetPx = -(outerSpacing + (GRAPH_DROP_LINE_HEIGHT_PX / 2));
      const shift = Math.min(GRAPH_DROP_PREVIEW_SHIFT_MAX_PX, outerSpacing * 0.75);
      if (shift > 0.5) {
        previewPrevNode = candidate.node;
        previewShiftPx = shift;
      }
    }
    return {
      node: candidate.node,
      targetTaskId: candidate.targetTaskId,
      position: "after",
      allowRootReparent: Boolean(candidate.allowRootReparent),
      afterOffsetPx,
      previewPrevNode,
      previewNextNode,
      previewShiftPx,
    };
  };

  const getGraphReorderTarget = (event: DragEvent): any => {
    if (!onReorderTask || !event || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) {
      return null;
    }
    const draggedTaskId = activeDraggedTaskId || getDraggedTaskId(event) || "";
    if (!draggedTaskId) {
      return null;
    }
    const draggedTask = getTaskById(draggedTaskId);
    if (!draggedTask) {
      return null;
    }
    const candidates = getGraphReorderCandidates(draggedTask, event.clientX);
    if (!candidates.length) {
      return null;
    }
    const first = candidates[0];
    if (event.clientY < first.rect.top) {
      return buildBeforeTargetFromCandidate(candidates, 0);
    }
    const last = candidates[candidates.length - 1];
    if (event.clientY > last.rect.bottom) {
      return buildAfterTargetFromCandidate(candidates, candidates.length - 1);
    }
    let best = null;
    for (let index = 1; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      // Canonicalize every internal boundary to a single target:
      // "before" the lower task. This avoids showing two equivalent
      // targets for the same gap ("after" upper vs "before" lower).
      const previous = candidates[index - 1];
      const lineY = (previous.rect.bottom + candidate.rect.top) / 2;
      const distance = Math.abs(event.clientY - lineY);
      if (!best || distance < best.distance) {
        best = {
          target: buildBeforeTargetFromCandidate(candidates, index),
          distance,
        };
      }
    }
    return best ? best.target : buildBeforeTargetFromCandidate(candidates, 0);
  };

  const bindTaskNode = (node: any): void => {
    if (node.dataset.bound) {
      return;
    }
    node.dataset.bound = "true";
    node.draggable = true;
    node.addEventListener("click", () => {
      const task = getTaskById(node.dataset.taskId);
      if (task) {
        onSelectTask(task);
        const now = performance.now();
        if (lastClickTaskId === task.id && now - lastClickAt < 320) {
          if (onEditTask) {
            onEditTask(task);
          }
          lastClickAt = 0;
          lastClickTaskId = "";
        } else {
          lastClickAt = now;
          lastClickTaskId = task.id;
        }
      }
    });
    node.addEventListener("dblclick", (event: MouseEvent) => {
      event.stopPropagation();
      if (!onEditTask) {
        return;
      }
      const task = getTaskById(node.dataset.taskId);
      if (task) {
        onEditTask(task);
      }
    });
    node.addEventListener("dragstart", (event: DragEvent) => {
      const task = getTaskById(node.dataset.taskId);
      if (!task) {
        return;
      }
      const dataTransfer = event.dataTransfer;
      if (!dataTransfer) {
        return;
      }
      dataTransfer.setData("text/plain", task.id);
      dataTransfer.setData(
        "application/json",
        JSON.stringify({
          type: "task",
          source: "canvas",
          taskId: task.id,
        })
      );
      node.classList.add("dragging");
      activeDraggedTaskId = task.id;
      window.dispatchEvent(new CustomEvent("taskdragstart"));
      const rect = node.getBoundingClientRect();
      const ghost = node.cloneNode(true) as any;
      const scale = state.transform?.scale || 1;
      ghost.classList.add("drag-ghost");
      ghost.style.position = "absolute";
      ghost.style.top = "-9999px";
      ghost.style.left = "-9999px";
      ghost.style.margin = "0";
      ghost.style.width = `${rect.width / scale}px`;
      ghost.style.height = `${rect.height / scale}px`;
      if ("zoom" in ghost.style) {
        ghost.style.zoom = String(scale);
      } else {
        ghost.style.transformOrigin = "top left";
        ghost.style.transform = `scale(${scale})`;
      }
      ghost.style.pointerEvents = "none";
      document.body.appendChild(ghost);
      const offsetX = event.clientX - rect.left;
      const offsetY = event.clientY - rect.top;
      dataTransfer.setDragImage(ghost, offsetX, offsetY);
      node._dragGhost = ghost;
    });
    node.addEventListener("dragend", () => {
      if (node._dragGhost) {
        node._dragGhost.remove();
        node._dragGhost = null;
      }
      node.classList.remove("dragging");
      activeDraggedTaskId = "";
      clearGraphDropIndicators();
      window.dispatchEvent(new CustomEvent("taskdragend"));
    });
    node.addEventListener("dragover", (event: DragEvent) => {
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "move";
      }
      if (node.classList.contains("dragging")) {
        applyGraphReorderIndicator(null);
        node.classList.remove("drag-parent-target");
        return;
      }
      if (!isTaskDrag(event)) {
        node.classList.remove("drag-parent-target");
        return;
      }
      const task = getTaskById(node.dataset.taskId);
      if (!task) {
        node.classList.remove("drag-parent-target");
        return;
      }
      const draggedId = getDraggedTaskId(event);
      if (draggedId && draggedId === task.id) {
        applyGraphReorderIndicator(null);
        node.classList.remove("drag-parent-target");
        return;
      }
      const draggedTask = draggedId ? getTaskById(draggedId) : null;
      const targetIsCurrentParent = isCurrentParentTarget(draggedTask, task);
      const rect = node.getBoundingClientRect();
      const withinX = (
        Number.isFinite(event.clientX)
        && Number.isFinite(rect.left)
        && Number.isFinite(rect.right)
        && event.clientX >= rect.left
        && event.clientX <= rect.right
      );
      const edgeThreshold = Math.min(28, Math.max(GRAPH_REORDER_EDGE_PX, rect.height * 0.22));
      const reorderMode = getGraphReorderMode(draggedTask, task);
      const canEdgeReorder = Boolean(reorderMode && withinX && onReorderTask);
      if (
        canEdgeReorder &&
        Number.isFinite(event.clientY) &&
        (event.clientY <= rect.top + edgeThreshold || event.clientY >= rect.bottom - edgeThreshold)
      ) {
        const candidates = getGraphReorderCandidates(draggedTask, event.clientX);
        const currentIndex = candidates.findIndex((candidate) => candidate.targetTaskId === task.id);
        const isTopEdge = event.clientY <= rect.top + edgeThreshold;
        let indicatorTarget = null;
        if (isTopEdge) {
          indicatorTarget = buildBeforeTargetFromCandidate(
            candidates,
            currentIndex >= 0 ? currentIndex : 0
          );
        } else if (currentIndex >= 0 && currentIndex + 1 < candidates.length) {
          indicatorTarget = buildBeforeTargetFromCandidate(candidates, currentIndex + 1);
        } else {
          indicatorTarget = buildAfterTargetFromCandidate(
            candidates,
            currentIndex >= 0 ? currentIndex : (candidates.length - 1)
          );
        }
        applyGraphReorderIndicator({
          ...indicatorTarget,
        });
        node.classList.remove("drag-parent-target");
        return;
      }
      applyGraphReorderIndicator(null);
      if (targetIsCurrentParent) {
        node.classList.remove("drag-parent-target");
        return;
      }
      node.classList.add("drag-parent-target");
    });
    node.addEventListener("dragleave", (event: DragEvent) => {
      // Drag events can fire `dragleave` when moving between child elements
      // inside the same task node. Only clear when the pointer actually leaves
      // the node bounds.
      const related = event.relatedTarget;
      if (related && node.contains(related)) {
        return;
      }
      const rect = node.getBoundingClientRect();
      if (
        Number.isFinite(event.clientX) &&
        Number.isFinite(event.clientY) &&
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom
      ) {
        return;
      }
      node.classList.remove("drag-parent-target");
    });
    node.addEventListener("drop", (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const parentTargetVisible = node.classList.contains("drag-parent-target");
      node.classList.remove("drag-parent-target");
      isDraggingToken = false;
      const task = getTaskById(node.dataset.taskId);
      if (!task) {
        return;
      }
      const draggedTaskId = activeDraggedTaskId || getDraggedTaskId(event);
      const dropReorderTarget = activeGraphReorder || getGraphReorderTarget(event);
      if (!parentTargetVisible && draggedTaskId && dropReorderTarget && onReorderTask) {
        const sourceTask = getTaskById(draggedTaskId);
        const targetTask = getTaskById(dropReorderTarget.targetTaskId);
        clearGraphDropIndicators();
        if (
          sourceTask &&
          targetTask &&
          onReorderTask(sourceTask, targetTask, dropReorderTarget.position, {
            allowRootReparent: Boolean(dropReorderTarget.allowRootReparent),
          })
        ) {
          return;
        }
      } else {
        clearGraphReorderIndicators();
      }
      const dataTransfer = event.dataTransfer;
      if (!dataTransfer) {
        return;
      }
      const payload = dataTransfer.getData("application/json");
      if (payload) {
        const data = JSON.parse(payload);
        if (data.type === "tag" || data.type === "person") {
          if (!onUpdateTaskToken) {
            return;
          }
          onUpdateTaskToken(task, data.value, "add");
          return;
        }
        if (data.type === "task" && onMakeSubtask) {
          const sourceTask = getTaskById(data.taskId);
          if (sourceTask && !isCurrentParentTarget(sourceTask, task)) {
            onMakeSubtask(sourceTask, task);
          }
          return;
        }
      }
      const taskId = dataTransfer.getData("text/plain");
      if (taskId && onMakeSubtask) {
        const sourceTask = getTaskById(taskId);
        if (sourceTask && !isCurrentParentTarget(sourceTask, task)) {
          onMakeSubtask(sourceTask, task);
        }
      }
    });
  };

  const updateGraphLines = (): void => {
    const paths: string[] = [];
    lastVisibleTasks.forEach((task: any) => {
      const node = lastNodesById.get(task.id);
      if (!node) {
        return;
      }
      const startX = node.offsetLeft + node.offsetWidth;
      const startY = node.offsetTop + node.offsetHeight / 2;
      task.children
        .filter((child: any) => lastNodesById.has(child.id))
        .forEach((child: any) => {
          const childNode = lastNodesById.get(child.id);
          const endX = childNode.offsetLeft;
          const endY = childNode.offsetTop + childNode.offsetHeight / 2;
          const midX = (startX + endX) / 2;
          const muted = !matchesFiltersTask(task) || !matchesFiltersTask(child);
          paths.push(
            `<path d="M ${startX} ${startY} C ${midX} ${startY} ${midX} ${endY} ${endX} ${endY}" stroke="#b9c0ff" stroke-width="5" fill="none" stroke-opacity="${muted ? 0.15 : 1}" />`
          );
        });
    });
    graphLines.innerHTML = `<g>${paths.join("")}</g>`;
  };

  const scheduleLineAnimation = (duration = 550): void => {
    if (lineAnimationFrame) {
      cancelAnimationFrame(lineAnimationFrame);
      lineAnimationFrame = null;
    }
    lineAnimationUntil = performance.now() + duration;
    const tick = (now: number): void => {
      updateGraphLines();
      if (now < lineAnimationUntil) {
        lineAnimationFrame = requestAnimationFrame(tick);
      } else {
        lineAnimationFrame = null;
      }
    };
    lineAnimationFrame = requestAnimationFrame(tick);
  };

  const renderTaskNodeContent = (node: any, task: any): void => {
    const wasDragging = node.classList.contains("dragging");
    node.className = "task-node";
    if (wasDragging) {
      node.classList.add("dragging");
    }
    if (state.selectedTaskId === task.id) {
      node.classList.add("selected");
    }
    if (state.collapsed.has(task.id)) {
      node.classList.add("collapsed");
    }
    if (!matchesFiltersTask(task)) {
      node.classList.add("dimmed");
    }
    if (matchesSearch(task)) {
      node.classList.add("search-highlight");
    }
    node.innerHTML = "";

    const title = document.createElement("h4");
    const displayTitle = task.name || "Untitled task";
    if (task.jiraKey) {
      const pill = document.createElement("span");
      pill.className = "pill jira-pill";
      pill.textContent = task.jiraKey;
      pill.title = `Copy ${task.jiraKey}`;
      pill.addEventListener("click", (event: any) => {
        event.stopPropagation();
        copyToClipboard(task.jiraKey);
      });
      title.appendChild(pill);
    }
    title.append(displayTitle);
    const referenceIndicator = createReferenceIndicator(task);
    if (referenceIndicator) {
      title.appendChild(referenceIndicator);
    }
    const header = document.createElement("div");
    header.className = "task-header";
    header.appendChild(title);
    const ownStoryPoints = Number.isFinite(task.storyPoints) ? task.storyPoints : null;
    const subtaskStoryPoints = Number.isFinite(task.storyPointsSubtasksTotal)
      ? task.storyPointsSubtasksTotal
      : 0;
    const storyLabel = ownStoryPoints !== null
      ? (subtaskStoryPoints > 0
        ? `★ ${formatStoryPointsNumber(ownStoryPoints)} + ${formatStoryPointsNumber(subtaskStoryPoints)}`
        : `★ ${formatStoryPointsNumber(ownStoryPoints)}`)
      : (subtaskStoryPoints > 0 ? `★ +${formatStoryPointsNumber(subtaskStoryPoints)}` : "");
    if (task.state) {
      const statePill = document.createElement("span");
      statePill.className = "pill state-pill";
      const stateMeta = state.stateMeta?.get(task.state);
      statePill.textContent = stateMeta?.name || task.state.replace(/^!/, "");
      const stateColor = state.stateMeta?.get(task.state)?.color;
      if (stateColor) {
        statePill.style.borderColor = stateColor;
        statePill.style.color = stateColor;
      }
      statePill.draggable = true;
      statePill.addEventListener("dragstart", (event: any) => {
        event.stopPropagation();
        setTokenDragImage(event, statePill);
        event.dataTransfer.setData(
          "application/json",
          JSON.stringify({
            type: "state",
            value: task.state,
            source: "task",
            taskId: task.id,
          })
        );
      });
      header.appendChild(statePill);
    }

    const descriptionOptions: any = {
      task,
      className: "description",
      baseIndent: Number.isFinite(task.indent) ? task.indent : 0,
    };
    if (renderMarkdown !== undefined) {
      descriptionOptions.renderMarkdown = renderMarkdown;
    }
    if (Array.isArray(task.descriptionLineIndexes)) {
      descriptionOptions.lineIndexes = task.descriptionLineIndexes;
    }
    const { node: desc } = renderTaskDescriptionNode(descriptionOptions);

    const toggle = document.createElement("div");
    toggle.className = "collapse-toggle";
    if (task.children.length) {
      const count = task.children.length;
      const countLabel = count === 1 ? "1 Subtask" : `${count} Subtasks`;
      toggle.textContent = countLabel;
      toggle.dataset["taskId"] = task.id;
      toggle.addEventListener("click", (event: any) => {
        event.stopPropagation();
        const targetTaskId = toggle.dataset["taskId"] || "";
        if (!targetTaskId) {
          return;
        }
        const targetTask = getTaskById(targetTaskId);
        if (!targetTask) {
          return;
        }
        if (state.collapsed.has(targetTask.id)) {
          state.collapsed.delete(targetTask.id);
        } else {
          state.collapsed.add(targetTask.id);
        }
        renderGraph();
      });
    }

    node.appendChild(header);
    if (task.description.length) {
      node.appendChild(desc);
    }
    if (task.description.length) {
      decorateDescriptionReferences(desc, {
        resolveTaskByName: (name: string) => findTaskByName(name),
        getResolvedTitle: (target: any) => `Open task: ${target.name}`,
        stopPropagationOnClick: true,
        onReferenceClick: ({ name }: any) => {
          const target = findTaskByName(name);
          if (target) {
            onSelectTask(target);
          }
        },
      });
      decorateDescriptionPills(desc, {
        tagMeta: state.tagMeta,
        peopleMeta: state.peopleMeta,
        selectedTags: state.selectedTags,
        selectedPeople: state.selectedPeople,
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
            event.stopPropagation();
            setTokenDragImage(event, pill);
            event.dataTransfer.setData(
              "application/json",
              JSON.stringify({
                type,
                value,
                source: "task",
                taskId: task.id,
              })
            );
          });
          pill.addEventListener("click", (event: any) => {
            event.stopPropagation();
            if (type === "tag") {
              toggleTag(value);
            } else if (type === "person") {
              togglePerson(value);
            }
          });
        },
      });
      wireDescriptionCheckboxes(desc, {
        lineFromClosest: true,
        stopPropagationEvents: ["mousedown", "click"],
        triggerEvent: "click",
        disableWhenUnavailable: true,
        onToggle: ({ lineIndex, checked }: any) => {
          if (onToggleCheckbox) {
            onToggleCheckbox(lineIndex, checked);
          }
        },
      });
    }
    if (task.children.length || storyLabel) {
      const cornerMeta = document.createElement("div");
      cornerMeta.className = "task-corner-meta";
      if (task.children.length) {
        cornerMeta.appendChild(toggle);
      }
      if (storyLabel) {
        const storyPill = createStoryPointsPill(storyLabel);
        storyPill.classList.add("task-story-points-corner");
        cornerMeta.appendChild(storyPill);
      }
      node.appendChild(cornerMeta);
    }
  };

  function renderGraph() {
    closeReferenceDropdown();
    graphLines.innerHTML = "";
    const existingNodes = new Map();
    const existingNodesMap = existingNodes;
    graphNodes.querySelectorAll(".task-node[data-task-id]").forEach((node: any) => {
      existingNodesMap.set(node.dataset.taskId, node);
    });
    const canvasRect = graphCanvas.getBoundingClientRect();

    const positions = new Map();
    const nodeWidth = 308;
    const startX = 60;
    const gapY = 24;

    let maxX = 0;
    let maxY = 0;
    const visibleTasks: any[] = gatherVisible(state.tasks);
    const nodesById = new Map();
    const heightsById = new Map();
    const widthsById = new Map();

    // First pass: build nodes to measure real sizes before layout.
    visibleTasks.forEach((task: any) => {
      let node = existingNodes.get(task.id);
      if (!node) {
        node = document.createElement("div");
        node.className = "task-node";
        node.dataset.taskId = task.id;
        graphNodes.appendChild(node);
      } else if (node.dataset.taskId !== task.id) {
        node.dataset.taskId = task.id;
      }
      bindTaskNode(node);
      renderTaskNodeContent(node, task);
      node.style.left = `${startX + task.depth * (nodeWidth + 40)}px`;
      node.style.top = "0px";
      node.style.visibility = "hidden";
      nodesById.set(task.id, node);
      const rect = node.getBoundingClientRect();
      const scale = state.transform?.scale || 1;
      const measuredHeight = Math.ceil(rect.height / scale);
      const measuredWidth = Math.ceil(rect.width / scale);
      heightsById.set(task.id, measuredHeight || node.offsetHeight || 0);
      widthsById.set(task.id, measuredWidth || node.offsetWidth || nodeWidth);
    });

    existingNodes.forEach((node: any, taskId: any) => {
      if (!nodesById.has(taskId)) {
        node.remove();
      }
    });

    const nodeHeightFor = (taskId: any): number => heightsById.get(taskId) || 120;
    const nodeWidthFor = (taskId: any): number => widthsById.get(taskId) || nodeWidth;
    let maxNodeWidth = nodeWidth;
    widthsById.forEach((width: number) => {
      maxNodeWidth = Math.max(maxNodeWidth, width);
    });
    const spacingX = maxNodeWidth + 80;

    // Second pass: compute positions using measured heights to avoid overlaps.
    const placeTask = (task: any, yPos: number): number => {
      if (!nodesById.has(task.id)) {
        return yPos;
      }
      const x = startX + task.depth * spacingX;
      const height = nodeHeightFor(task.id);
      const width = nodeWidthFor(task.id);
      positions.set(task.id, { x, y: yPos });
      maxX = Math.max(maxX, x + width);
      maxY = Math.max(maxY, yPos + height);
      if (state.collapsed.has(task.id) || !task.children.length) {
        return yPos + height;
      }
      let currentBottom = yPos + height;
      let childStackBottom = yPos;
      task.children.forEach((child: any, index: number) => {
        if (!nodesById.has(child.id)) {
          return;
        }
        const childY = index === 0 ? yPos : childStackBottom + gapY;
        const childBottom = placeTask(child, childY);
        childStackBottom = Math.max(childStackBottom, childBottom);
        currentBottom = Math.max(currentBottom, childBottom);
      });
      return currentBottom;
    };

    let currentY = 40;
    state.tasks.forEach((task: any) => {
      if (!nodesById.has(task.id)) {
        return;
      }
      const bottomY = placeTask(task, currentY);
      currentY = bottomY + gapY;
    });

    state.positions = positions;
    const viewWidth = Math.max(1, Math.floor(Math.max(canvasRect.width, maxX + 60)));
    const viewHeight = Math.max(1, Math.floor(Math.max(canvasRect.height, maxY + 60)));
    state.graphBounds = { width: viewWidth, height: viewHeight };
    graphLines.setAttribute("width", `${viewWidth}`);
    graphLines.setAttribute("height", `${viewHeight}`);
    graphLines.style.width = `${viewWidth}px`;
    graphLines.style.height = `${viewHeight}px`;
    graphLines.setAttribute("viewBox", `0 0 ${viewWidth} ${viewHeight}`);

    nodesById.forEach((node: any, taskId: any) => {
      const pos = positions.get(taskId);
      if (!pos) {
        return;
      }
      node.style.left = `${pos.x}px`;
      node.style.top = `${pos.y}px`;
      node.style.visibility = "";
    });

    updateMinimap({
      visibleTasks,
      positions,
      nodeWidthFor,
      nodeHeightFor,
      viewWidth,
      viewHeight,
      canvasRect,
    });

    lastVisibleTasks = visibleTasks;
    lastNodesById = nodesById;
    updateGraphLines();
    scheduleLineAnimation();

    applyTransform(state.animateTransform);
    state.animateTransform = false;
  }

  function gatherVisible(tasks: any[], result: any[] = []): any[] {
    tasks.forEach((task: any) => {
      result.push(task);
      if (!state.collapsed.has(task.id)) {
        gatherVisible(task.children, result);
      }
    });
    return result;
  }

  function buildPill(text: string, active: boolean, onClick: any, meta: any = null) {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = `pill ${active ? "active" : ""}`;
    let label = meta?.name || text;
    if (text.startsWith("#")) {
      const tagLabel = meta?.name || text.replace("#", "");
      label = `#${tagLabel}`;
    } else if (text.startsWith("@")) {
      const personLabel = meta?.name || text.replace("@", "");
      label = `👤 ${personLabel}`;
    }
    pill.textContent = label;
    if (meta?.color) {
      pill.style.borderColor = meta.color;
    }
    if (text.startsWith("#") || text.startsWith("@")) {
      pill.draggable = true;
      pill.addEventListener("dragstart", (event: any) => {
        setTokenDragImage(event, pill, { scaleWithZoom: false });
        event.dataTransfer.setData(
          "application/json",
          JSON.stringify({
            type: text.startsWith("#") ? "tag" : "person",
            value: text,
            source: "legend",
          })
        );
      });
    }
    pill.addEventListener("click", onClick);
    return pill;
  }

  function toggleTag(tag: string): void {
    if (state.selectedTags.has(tag)) {
      state.selectedTags.delete(tag);
    } else {
      state.selectedTags.add(tag);
    }
    expandForFilters();
    renderGraph();
    if (onFiltersChange) {
      onFiltersChange();
    }
  }

  function togglePerson(person: string): void {
    if (state.selectedPeople.has(person)) {
      state.selectedPeople.delete(person);
    } else {
      state.selectedPeople.add(person);
    }
    expandForFilters();
    renderGraph();
    if (onFiltersChange) {
      onFiltersChange();
    }
  }

  function expandForFilters() {
    if (!state.selectedTags.size && !state.selectedPeople.size) {
      return;
    }
    const ensureExpanded = (task: any, ancestors: any[]): boolean => {
      const matches =
        task.tags.some((tag: any) => state.selectedTags.has(tag)) ||
        task.people.some((person: any) => state.selectedPeople.has(person));
      const childMatch = task.children.some((child: any) => ensureExpanded(child, [...ancestors, task]));
      if (matches || childMatch) {
        ancestors.forEach((ancestor: any) => state.collapsed.delete(ancestor.id));
        state.collapsed.delete(task.id);
      }
      return matches || childMatch;
    };
    state.tasks.forEach((task: any) => ensureExpanded(task, []));
  }

  function matchesFiltersTask(task: any): boolean {
    if (!state.selectedTags.size && !state.selectedPeople.size) {
      return true;
    }
    return (
      task.tags.some((tag: any) => state.selectedTags.has(tag)) ||
      task.people.some((person: any) => state.selectedPeople.has(person))
    );
  }

  function tokenMatchesQuery(token: string, metaMap: any, query: string): boolean {
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

  function tokensMatchQuery(tokens: any[], metaMap: any, query: string): boolean {
    return tokens.some((token: any) => tokenMatchesQuery(token, metaMap, query));
  }

  function matchesSearch(task: any): boolean {
    if (!state.searchQuery) {
      return false;
    }
    const query = state.searchQuery.toLowerCase();
    if (dom.searchName.checked && task.name.toLowerCase().includes(query)) {
      return true;
    }
    if (
      dom.searchDescription.checked &&
      task.description.join(" ").toLowerCase().includes(query)
    ) {
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

  function focusOnTask(task: any): void {
    const pos = state.positions.get(task.id);
    if (!pos) {
      return;
    }
    const canvasRect = graphCanvas.getBoundingClientRect();
    const centerX = pos.x + 110;
    const centerY = pos.y + 40;
    state.transform.x = canvasRect.width / 2 - centerX * state.transform.scale;
    state.transform.y = canvasRect.height / 2 - centerY * state.transform.scale;
    state.animateTransform = true;
    applyTransform(true);
  }

  function applyTransform(animate = false) {
    const { x, y, scale } = state.transform;
    const transitionValue = animate ? "transform 0.5s ease" : "none";
    graphNodes.style.transition = transitionValue;
    graphLines.style.transition = transitionValue;
    graphNodes.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    graphLines.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    updateMinimapViewport();
  }

  const scheduleZoomRedraw = () => {
    if (zoomRedrawTimeout) {
      clearTimeout(zoomRedrawTimeout);
    }
    zoomRedrawTimeout = setTimeout(() => {
      zoomRedrawTimeout = null;
      // Match focus flow redraw behavior used from editor selection.
      state.animateTransform = true;
      applyTransform(true);
      renderGraph();
    }, ZOOM_REDRAW_DELAY_MS);
  };

  let isPanning = false;
  let isDraggingToken = false;
  let lastPoint = { x: 0, y: 0 };

  graphCanvas.addEventListener("dragstart", (event: any) => {
    if (event.target.closest(".pill")) {
      isDraggingToken = true;
      isPanning = false;
    }
  });

  graphCanvas.addEventListener("dragend", (event: any) => {
    if (event.target.closest(".pill")) {
      isDraggingToken = false;
      clearTokenDragGhost();
    }
  });

  window.addEventListener("dragend", () => {
    isDraggingToken = false;
    clearTokenDragGhost();
    activeDraggedTaskId = "";
    clearGraphDropIndicators();
  });

  window.addEventListener("drop", () => {
    isDraggingToken = false;
    clearTokenDragGhost();
    activeDraggedTaskId = "";
    clearGraphDropIndicators();
  });

  graphCanvas.addEventListener("drop", () => {
    isDraggingToken = false;
    clearTokenDragGhost();
  });

  graphCanvas.addEventListener("mousedown", (event: any) => {
    if (isDraggingToken) {
      return;
    }
    if (event.target.closest(".task-node")) {
      return;
    }
    isPanning = true;
    lastPoint = { x: event.clientX, y: event.clientY };
  });

  graphCanvas.addEventListener("mousemove", (event: any) => {
    if (!isPanning || isDraggingToken) {
      return;
    }
    state.transform.x += event.clientX - lastPoint.x;
    state.transform.y += event.clientY - lastPoint.y;
    lastPoint = { x: event.clientX, y: event.clientY };
    applyTransform();
  });

  graphCanvas.addEventListener("mouseup", () => {
    isPanning = false;
  });

  graphCanvas.addEventListener("mouseleave", () => {
    isPanning = false;
  });

  graphCanvas.addEventListener("wheel", (event: any) => {
    event.preventDefault();
    const delta = event.deltaY > 0 ? -GRAPH_ZOOM_STEP : GRAPH_ZOOM_STEP;
    const newScale = Math.min(
      GRAPH_ZOOM_MAX,
      Math.max(GRAPH_ZOOM_MIN, state.transform.scale + delta)
    );
    const rect = graphCanvas.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    const scaleFactor = newScale / state.transform.scale;
    state.transform.x = pointerX - (pointerX - state.transform.x) * scaleFactor;
    state.transform.y = pointerY - (pointerY - state.transform.y) * scaleFactor;
    state.transform.scale = newScale;
    applyTransform();
    scheduleZoomRedraw();
  });

  graphCanvas.addEventListener("dragover", (event: any) => {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    if (event.target.closest(".task-node")) {
      return;
    }
    if (!onReorderTask || !activeDraggedTaskId) {
      applyGraphReorderIndicator(null);
      return;
    }
    applyGraphReorderIndicator(getGraphReorderTarget(event));
  });

  graphCanvas.addEventListener("drop", (event: any) => {
    if (event.defaultPrevented) {
      return;
    }
    event.preventDefault();
    const dropReorderTarget = activeGraphReorder || getGraphReorderTarget(event);
    const draggedTaskId = activeDraggedTaskId || getDraggedTaskId(event);
    if (draggedTaskId && dropReorderTarget && onReorderTask) {
      const sourceTask = getTaskById(draggedTaskId);
      const targetTask = getTaskById(dropReorderTarget.targetTaskId);
      clearGraphDropIndicators();
      if (
        sourceTask &&
        targetTask &&
        onReorderTask(sourceTask, targetTask, dropReorderTarget.position, {
          allowRootReparent: Boolean(dropReorderTarget.allowRootReparent),
        })
      ) {
        return;
      }
    } else {
      clearGraphReorderIndicators();
    }
    const payload = event.dataTransfer.getData("application/json");
    if (!payload) {
      return;
    }
    const data = JSON.parse(payload);
    if (data.source === "task" && (data.type === "tag" || data.type === "person")) {
      if (!onUpdateTaskToken) {
        return;
      }
      const task = state.allTasks.find((item: any) => item.id === data.taskId);
      if (task) {
        onUpdateTaskToken(task, data.value, "remove");
      }
    }
    if (data.source === "task" && data.type === "state") {
      if (!onUpdateTaskState) {
        return;
      }
      const task = state.allTasks.find((item: any) => item.id === data.taskId);
      if (task) {
        onUpdateTaskState(task, null);
      }
    }
    if (data.source === "kanban" && data.type === "task") {
      if (!onUpdateTaskState) {
        return;
      }
      const task = state.allTasks.find((item: any) => item.id === data.taskId);
      if (task) {
        onUpdateTaskState(task, null);
      }
    }
  });

  return {
    renderGraph,
    focusOnTask,
    applyTransform,
    toggleTag,
    togglePerson,
    buildPill,
  };

  function updateMinimap({
    visibleTasks,
    positions,
    nodeWidthFor,
    nodeHeightFor,
    viewWidth,
    viewHeight,
    canvasRect,
  }: any): void {
    if (!minimapSvg || !graphMinimap) {
      return;
    }
    if (!visibleTasks.length) {
      graphMinimap.hidden = true;
      return;
    }
    graphMinimap.hidden = false;
    minimapSvg.setAttribute("viewBox", `0 0 ${viewWidth} ${viewHeight}`);
    const lines: string[] = [];
    const nodes: string[] = [];
    visibleTasks.forEach((task: any) => {
      const pos = positions.get(task.id);
      if (!pos) {
        return;
      }
      const width = nodeWidthFor(task.id);
      const height = nodeHeightFor(task.id);
      const dimmed = !matchesFiltersTask(task);
      nodes.push(
        `<rect class="minimap-node${dimmed ? " dimmed" : ""}" x="${pos.x}" y="${pos.y}" width="${width}" height="${height}" rx="8" ry="8" />`
      );
      task.children
        .filter((child: any) => positions.has(child.id))
        .forEach((child: any) => {
          const childPos = positions.get(child.id);
          const childHeight = nodeHeightFor(child.id);
          const startX = pos.x + width;
          const startY = pos.y + height / 2;
          const endX = childPos.x;
          const endY = childPos.y + childHeight / 2;
          const midX = (startX + endX) / 2;
          lines.push(
            `<path class="minimap-line" d="M ${startX} ${startY} C ${midX} ${startY} ${midX} ${endY} ${endX} ${endY}" />`
          );
        });
    });
    const { viewportX, viewportY, viewportWidth, viewportHeight } = getViewportRect(
      canvasRect,
      viewWidth,
      viewHeight
    );
    minimapSvg.innerHTML = `<g>${nodes.join("")}</g><g>${lines.join("")}</g><rect class="minimap-viewport" x="${viewportX}" y="${viewportY}" width="${viewportWidth}" height="${viewportHeight}" />`;
  }

  function updateMinimapViewport() {
    if (!minimapSvg || !state.graphBounds) {
      return;
    }
    const viewport = minimapSvg.querySelector(".minimap-viewport");
    if (!viewport) {
      return;
    }
    const canvasRect = graphCanvas.getBoundingClientRect();
    const { viewportX, viewportY, viewportWidth, viewportHeight } = getViewportRect(
      canvasRect,
      state.graphBounds.width,
      state.graphBounds.height
    );
    viewport.setAttribute("x", `${viewportX}`);
    viewport.setAttribute("y", `${viewportY}`);
    viewport.setAttribute("width", `${viewportWidth}`);
    viewport.setAttribute("height", `${viewportHeight}`);
  }

  function getViewportRect(canvasRect: DOMRect, boundsWidth: number, boundsHeight: number) {
    const scale = state.transform.scale || 1;
    const rawWidth = canvasRect.width / scale;
    const rawHeight = canvasRect.height / scale;
    const viewportWidth = Math.min(boundsWidth, rawWidth);
    const viewportHeight = Math.min(boundsHeight, rawHeight);
    const rawX = (-state.transform.x) / scale;
    const rawY = (-state.transform.y) / scale;
    const maxX = Math.max(0, boundsWidth - viewportWidth);
    const maxY = Math.max(0, boundsHeight - viewportHeight);
    const viewportX = Math.min(maxX, Math.max(0, rawX));
    const viewportY = Math.min(maxY, Math.max(0, rawY));
    return { viewportX, viewportY, viewportWidth, viewportHeight };
  }
}
