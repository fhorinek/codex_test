import { colorFromString } from "./task.js";

export function createCanvas({
  state,
  dom,
  renderMarkdown,
  onSelectTask,
  findTaskByName,
  onUpdateTaskToken,
  onUpdateTaskState,
  onMakeSubtask,
  onToggleCheckbox,
  onFiltersChange,
}) {
  const { graphNodes, graphLines, graphCanvas } = dom;

  function renderGraph() {
    graphNodes.innerHTML = "";
    graphLines.innerHTML = "";
    const canvasRect = graphCanvas.getBoundingClientRect();

    const positions = new Map();
    const nodeWidth = 308;
    const startX = 60;
    const gapY = 40;

    let maxX = 0;
    let maxY = 0;
    const visibleTasks = gatherVisible(state.tasks);
    const nodesById = new Map();
    const heightsById = new Map();
    const widthsById = new Map();

    visibleTasks.forEach((task) => {
      const node = document.createElement("div");
      node.className = "task-node";
      node.style.left = `${startX + task.depth * (nodeWidth + 40)}px`;
      node.style.top = "0px";
      node.style.visibility = "hidden";

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
        toggle.addEventListener("click", (event) => {
          event.stopPropagation();
          if (state.collapsed.has(task.id)) {
            state.collapsed.delete(task.id);
          } else {
            state.collapsed.add(task.id);
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

      node.addEventListener("click", () => onSelectTask(task));
      node.draggable = true;
      node.addEventListener("dragstart", (event) => {
        event.dataTransfer.setData("text/plain", task.id);
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
      });
      node.addEventListener("dragover", (event) => {
        event.preventDefault();
      });
      node.addEventListener("drop", (event) => {
        event.preventDefault();
        event.stopPropagation();
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
            const sourceTask = state.allTasks.find((item) => item.id === data.taskId);
            if (sourceTask) {
              onMakeSubtask(sourceTask, task);
            }
            return;
          }
        }
        const taskId = event.dataTransfer.getData("text/plain");
        if (taskId && onMakeSubtask) {
          const sourceTask = state.allTasks.find((item) => item.id === taskId);
          if (sourceTask) {
            onMakeSubtask(sourceTask, task);
          }
        }
      });

      graphNodes.appendChild(node);
      nodesById.set(task.id, node);
      const rect = node.getBoundingClientRect();
      const scale = state.transform?.scale || 1;
      const measuredHeight = Math.ceil(rect.height / scale);
      const measuredWidth = Math.ceil(rect.width / scale);
      heightsById.set(task.id, measuredHeight || node.offsetHeight || 0);
      widthsById.set(task.id, measuredWidth || node.offsetWidth || nodeWidth);
    });

    const nodeHeightFor = (taskId) => heightsById.get(taskId) || 120;
    const nodeWidthFor = (taskId) => widthsById.get(taskId) || nodeWidth;
    let maxNodeWidth = nodeWidth;
    widthsById.forEach((width) => {
      maxNodeWidth = Math.max(maxNodeWidth, width);
    });
    const spacingX = maxNodeWidth + 40;

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
      task.children.forEach((child, index) => {
        if (!nodesById.has(child.id)) {
          return;
        }
        const childY = index === 0 ? yPos : currentBottom + gapY;
        const childBottom = placeTask(child, childY);
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

    const paths = [];
    visibleTasks.forEach((task) => {
      const node = nodesById.get(task.id);
      if (!node) {
        return;
      }
      const startX = node.offsetLeft + node.offsetWidth;
      const startY = node.offsetTop + node.offsetHeight / 2;
      task.children
        .filter((child) => nodesById.has(child.id))
        .forEach((child) => {
          const childNode = nodesById.get(child.id);
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
    if (dom.searchTag.checked && task.tags.join(" ").toLowerCase().includes(query)) {
      return true;
    }
    if (dom.searchPerson.checked && task.people.join(" ").toLowerCase().includes(query)) {
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

  function lightenColor(color, amount = 0.4) {
    const hex = color.replace("#", "");
    if (hex.length !== 6) {
      return color;
    }
    const num = parseInt(hex, 16);
    const r = (num >> 16) & 0xff;
    const g = (num >> 8) & 0xff;
    const b = num & 0xff;
    const mix = (channel) => Math.min(255, Math.round(channel + (255 - channel) * amount));
    const toHex = (channel) => channel.toString(16).padStart(2, "0");
    return `#${toHex(mix(r))}${toHex(mix(g))}${toHex(mix(b))}`;
  }
}
