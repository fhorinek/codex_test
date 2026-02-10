import { colorFromString } from "./task.js";

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
  onToggleCheckbox,
  onFiltersChange,
}) {
  const { graphNodes, graphLines, graphCanvas, graphMinimap, minimapSvg } = dom;
  let lineAnimationFrame = null;
  let lineAnimationUntil = 0;
  let lastVisibleTasks = [];
  let lastNodesById = new Map();

  const getTaskById = (taskId) =>
    state.allTasks.find((item) => item.id === taskId) || null;

  const isTaskDrag = (event) => {
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

  const getDraggedTaskId = (event) => {
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

  const bindTaskNode = (node) => {
    if (node.dataset.bound) {
      return;
    }
    node.dataset.bound = "true";
    node.draggable = true;
    node.addEventListener("click", () => {
      const task = getTaskById(node.dataset.taskId);
      if (task) {
        onSelectTask(task);
      }
    });
    node.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      if (!onEditTask) {
        return;
      }
      const task = getTaskById(node.dataset.taskId);
      if (task) {
        onEditTask(task);
      }
    });
    node.addEventListener("dragstart", (event) => {
      const task = getTaskById(node.dataset.taskId);
      if (!task) {
        return;
      }
      event.dataTransfer.setData("text/plain", task.id);
      event.dataTransfer.setData(
        "application/json",
        JSON.stringify({
          type: "task",
          source: "canvas",
          taskId: task.id,
        })
      );
      node.classList.add("dragging");
      window.dispatchEvent(new CustomEvent("taskdragstart"));
      const rect = node.getBoundingClientRect();
      const ghost = node.cloneNode(true);
      const scale = state.transform?.scale || 1;
      ghost.classList.add("drag-ghost");
      ghost.style.position = "absolute";
      ghost.style.top = "-9999px";
      ghost.style.left = "-9999px";
      ghost.style.margin = "0";
      ghost.style.width = `${rect.width / scale}px`;
      ghost.style.height = `${rect.height / scale}px`;
      if ("zoom" in ghost.style) {
        ghost.style.zoom = scale;
      } else {
        ghost.style.transformOrigin = "top left";
        ghost.style.transform = `scale(${scale})`;
      }
      ghost.style.pointerEvents = "none";
      document.body.appendChild(ghost);
      const offsetX = event.clientX - rect.left;
      const offsetY = event.clientY - rect.top;
      event.dataTransfer.setDragImage(ghost, offsetX, offsetY);
      node._dragGhost = ghost;
    });
    node.addEventListener("dragend", () => {
      if (node._dragGhost) {
        node._dragGhost.remove();
        node._dragGhost = null;
      }
      node.classList.remove("dragging");
      window.dispatchEvent(new CustomEvent("taskdragend"));
    });
    node.addEventListener("dragover", (event) => {
      event.preventDefault();
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
        node.classList.remove("drag-parent-target");
        return;
      }
      node.classList.add("drag-parent-target");
    });
    node.addEventListener("dragleave", () => {
      node.classList.remove("drag-parent-target");
    });
    node.addEventListener("drop", (event) => {
      event.preventDefault();
      event.stopPropagation();
      node.classList.remove("drag-parent-target");
      isDraggingToken = false;
      const task = getTaskById(node.dataset.taskId);
      if (!task) {
        return;
      }
      const payload = event.dataTransfer.getData("application/json");
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
          if (sourceTask) {
            onMakeSubtask(sourceTask, task);
          }
          return;
        }
      }
      const taskId = event.dataTransfer.getData("text/plain");
      if (taskId && onMakeSubtask) {
        const sourceTask = getTaskById(taskId);
        if (sourceTask) {
          onMakeSubtask(sourceTask, task);
        }
      }
    });
  };

  const updateGraphLines = () => {
    const paths = [];
    lastVisibleTasks.forEach((task) => {
      const node = lastNodesById.get(task.id);
      if (!node) {
        return;
      }
      const startX = node.offsetLeft + node.offsetWidth;
      const startY = node.offsetTop + node.offsetHeight / 2;
      task.children
        .filter((child) => lastNodesById.has(child.id))
        .forEach((child) => {
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

  const scheduleLineAnimation = (duration = 550) => {
    if (lineAnimationFrame) {
      cancelAnimationFrame(lineAnimationFrame);
      lineAnimationFrame = null;
    }
    lineAnimationUntil = performance.now() + duration;
    const tick = (now) => {
      updateGraphLines();
      if (now < lineAnimationUntil) {
        lineAnimationFrame = requestAnimationFrame(tick);
      } else {
        lineAnimationFrame = null;
      }
    };
    lineAnimationFrame = requestAnimationFrame(tick);
  };

  const renderTaskNodeContent = (node, task) => {
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
    title.textContent = task.name;
    const header = document.createElement("div");
    header.className = "task-header";
    header.appendChild(title);
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
      statePill.addEventListener("dragstart", (event) => {
        event.stopPropagation();
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

    const desc = document.createElement("div");
    desc.className = "description";
    const descriptionText = task.description
      .map((line) =>
        line
          .replace(/(^|\s)![^\s#@]+/g, "$1")
          .replace(/\s{2,}/g, " ")
          .trim()
      )
      .join("\n");
    desc.innerHTML = renderMarkdown(descriptionText, {
      lineIndexes: task.descriptionLineIndexes,
    });

    const toggle = document.createElement("div");
    toggle.className = "collapse-toggle";
    if (task.children.length) {
      const count = task.children.length;
      const countLabel = count === 1 ? "1 Subtask" : `${count} Subtasks`;
      toggle.textContent = countLabel;
      toggle.dataset.taskId = task.id;
      toggle.addEventListener("click", (event) => {
        event.stopPropagation();
        const targetTask = getTaskById(toggle.dataset.taskId);
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
      desc.querySelectorAll(".references").forEach((link) => {
        link.addEventListener("click", (event) => {
          event.stopPropagation();
          const ref = link.dataset.ref;
          const target = findTaskByName(ref);
          if (target) {
            onSelectTask(target);
          }
        });
      });
      desc.querySelectorAll(".inline-pill").forEach((pill) => {
        const type = pill.dataset.type;
        const value = pill.dataset.value;
        if (type === "tag" && state.selectedTags.has(value)) {
          pill.classList.add("active");
        }
        if (type === "person" && state.selectedPeople.has(value)) {
          pill.classList.add("active");
        }
        if (type === "tag") {
          const color = state.tagMeta?.get(value)?.color;
          if (color) {
            pill.style.borderColor = color;
          }
          const label = state.tagMeta?.get(value)?.name || value.replace("#", "");
          pill.textContent = `#${label}`;
        }
        if (type === "person") {
          const color = state.peopleMeta?.get(value)?.color;
          if (color) {
            pill.style.borderColor = color;
          }
          const personLabel = state.peopleMeta?.get(value)?.name || value.replace("@", "");
          pill.textContent = `👤 ${personLabel}`;
        }
        pill.draggable = true;
        pill.addEventListener("dragstart", (event) => {
          event.stopPropagation();
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
        pill.addEventListener("click", (event) => {
          event.stopPropagation();
          if (type === "tag") {
            toggleTag(value);
          } else if (type === "person") {
            togglePerson(value);
          }
        });
      });
      desc.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
        const lineIndex = Number.parseInt(
          checkbox.dataset.line || checkbox.closest(".checkbox-line")?.dataset.line,
          10
        );
        if (!Number.isFinite(lineIndex)) {
          checkbox.disabled = true;
          return;
        }
        checkbox.addEventListener("mousedown", (event) => {
          event.stopPropagation();
        });
        checkbox.addEventListener("click", (event) => {
          event.stopPropagation();
          if (onToggleCheckbox) {
            onToggleCheckbox(lineIndex, checkbox.checked);
          }
        });
      });
    }
    if (task.children.length) {
      node.appendChild(toggle);
    }
  };

  function renderGraph() {
    graphLines.innerHTML = "";
    const existingNodes = new Map();
    graphNodes.querySelectorAll(".task-node[data-task-id]").forEach((node) => {
      existingNodes.set(node.dataset.taskId, node);
    });
    const canvasRect = graphCanvas.getBoundingClientRect();

    const positions = new Map();
    const nodeWidth = 308;
    const startX = 60;
    const gapY = 24;

    let maxX = 0;
    let maxY = 0;
    const visibleTasks = gatherVisible(state.tasks);
    const nodesById = new Map();
    const heightsById = new Map();
    const widthsById = new Map();

    // First pass: build nodes to measure real sizes before layout.
    visibleTasks.forEach((task) => {
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

    existingNodes.forEach((node, taskId) => {
      if (!nodesById.has(taskId)) {
        node.remove();
      }
    });

    const nodeHeightFor = (taskId) => heightsById.get(taskId) || 120;
    const nodeWidthFor = (taskId) => widthsById.get(taskId) || nodeWidth;
    let maxNodeWidth = nodeWidth;
    widthsById.forEach((width) => {
      maxNodeWidth = Math.max(maxNodeWidth, width);
    });
    const spacingX = maxNodeWidth + 80;

    // Second pass: compute positions using measured heights to avoid overlaps.
    const placeTask = (task, yPos) => {
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
      task.children.forEach((child, index) => {
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
    state.tasks.forEach((task) => {
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

    nodesById.forEach((node, taskId) => {
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

  function gatherVisible(tasks, result = []) {
    tasks.forEach((task) => {
      result.push(task);
      if (!state.collapsed.has(task.id)) {
        gatherVisible(task.children, result);
      }
    });
    return result;
  }

  function buildPill(text, active, onClick, meta = null) {
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
      pill.addEventListener("dragstart", (event) => {
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

  function toggleTag(tag) {
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

  function togglePerson(person) {
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
    const ensureExpanded = (task, ancestors) => {
      const matches =
        task.tags.some((tag) => state.selectedTags.has(tag)) ||
        task.people.some((person) => state.selectedPeople.has(person));
      const childMatch = task.children.some((child) => ensureExpanded(child, [...ancestors, task]));
      if (matches || childMatch) {
        ancestors.forEach((ancestor) => state.collapsed.delete(ancestor.id));
        state.collapsed.delete(task.id);
      }
      return matches || childMatch;
    };
    state.tasks.forEach((task) => ensureExpanded(task, []));
  }

  function matchesFiltersTask(task) {
    if (!state.selectedTags.size && !state.selectedPeople.size) {
      return true;
    }
    return (
      task.tags.some((tag) => state.selectedTags.has(tag)) ||
      task.people.some((person) => state.selectedPeople.has(person))
    );
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

  function matchesSearch(task) {
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

  function focusOnTask(task) {
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

  let isPanning = false;
  let isDraggingToken = false;
  let lastPoint = { x: 0, y: 0 };

  graphCanvas.addEventListener("dragstart", (event) => {
    if (event.target.closest(".pill")) {
      isDraggingToken = true;
      isPanning = false;
    }
  });

  graphCanvas.addEventListener("dragend", (event) => {
    if (event.target.closest(".pill")) {
      isDraggingToken = false;
    }
  });

  window.addEventListener("dragend", () => {
    isDraggingToken = false;
  });

  window.addEventListener("drop", () => {
    isDraggingToken = false;
  });

  graphCanvas.addEventListener("drop", () => {
    isDraggingToken = false;
  });

  graphCanvas.addEventListener("mousedown", (event) => {
    if (isDraggingToken) {
      return;
    }
    if (event.target.closest(".task-node")) {
      return;
    }
    isPanning = true;
    lastPoint = { x: event.clientX, y: event.clientY };
  });

  graphCanvas.addEventListener("mousemove", (event) => {
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

  graphCanvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const delta = event.deltaY > 0 ? -0.1 : 0.1;
    const newScale = Math.min(1.6, Math.max(0.5, state.transform.scale + delta));
    const rect = graphCanvas.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    const scaleFactor = newScale / state.transform.scale;
    state.transform.x = pointerX - (pointerX - state.transform.x) * scaleFactor;
    state.transform.y = pointerY - (pointerY - state.transform.y) * scaleFactor;
    state.transform.scale = newScale;
    applyTransform();
  });

  graphCanvas.addEventListener("dragover", (event) => {
    event.preventDefault();
  });

  graphCanvas.addEventListener("drop", (event) => {
    if (event.defaultPrevented) {
      return;
    }
    event.preventDefault();
    const payload = event.dataTransfer.getData("application/json");
    if (!payload) {
      return;
    }
    const data = JSON.parse(payload);
    if (data.source === "task" && (data.type === "tag" || data.type === "person")) {
      if (!onUpdateTaskToken) {
        return;
      }
      const task = state.allTasks.find((item) => item.id === data.taskId);
      if (task) {
        onUpdateTaskToken(task, data.value, "remove");
      }
    }
    if (data.source === "task" && data.type === "state") {
      if (!onUpdateTaskState) {
        return;
      }
      const task = state.allTasks.find((item) => item.id === data.taskId);
      if (task) {
        onUpdateTaskState(task, null);
      }
    }
    if (data.source === "kanban" && data.type === "task") {
      if (!onUpdateTaskState) {
        return;
      }
      const task = state.allTasks.find((item) => item.id === data.taskId);
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
  }) {
    if (!minimapSvg || !graphMinimap) {
      return;
    }
    if (!visibleTasks.length) {
      graphMinimap.hidden = true;
      return;
    }
    graphMinimap.hidden = false;
    minimapSvg.setAttribute("viewBox", `0 0 ${viewWidth} ${viewHeight}`);
    const lines = [];
    const nodes = [];
    visibleTasks.forEach((task) => {
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
        .filter((child) => positions.has(child.id))
        .forEach((child) => {
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

  function getViewportRect(canvasRect, boundsWidth, boundsHeight) {
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
