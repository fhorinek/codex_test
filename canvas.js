export function createCanvas({
  state,
  dom,
  renderMarkdown,
  onSelectTask,
  findTaskByName,
  onUpdateTaskToken,
  onUpdateTaskState,
  onFiltersChange,
}) {
  const { graphNodes, graphLines, graphCanvas } = dom;

  function renderGraph() {
    graphNodes.innerHTML = "";
    graphLines.innerHTML = "";
    const canvasRect = graphCanvas.getBoundingClientRect();

    const visibleTasks = gatherVisible(state.tasks);
    const positions = new Map();
    let y = 40;
    const spacingY = 170;
    const nodeWidth = 220;
    const nodeHeight = 120;

    let maxX = 0;
    let maxY = 0;
    visibleTasks.forEach((task) => {
      const x = 60 + task.depth * 260;
      positions.set(task.id, { x, y });
      maxX = Math.max(maxX, x + nodeWidth);
      maxY = Math.max(maxY, y + nodeHeight);
      y += spacingY;
    });
    state.positions = positions;
    graphLines.setAttribute(
      "viewBox",
      `0 0 ${Math.max(1, Math.floor(Math.max(canvasRect.width, maxX + 60)))} ${Math.max(
        1,
        Math.floor(Math.max(canvasRect.height, maxY + 60))
      )}`
    );

    const paths = [];
    visibleTasks.forEach((task) => {
      const pos = positions.get(task.id);
      task.children
        .filter((child) => positions.has(child.id))
        .forEach((child) => {
          const childPos = positions.get(child.id);
          const startX = pos.x + nodeWidth;
          const startY = pos.y + nodeHeight / 2;
          const endX = childPos.x;
          const endY = childPos.y + nodeHeight / 2;
          const midX = (startX + endX) / 2;
          const midY = (startY + endY) / 2;
          paths.push(
            `<path d="M ${startX} ${startY} C ${midX} ${startY} ${midX} ${endY} ${endX} ${endY}" stroke="#b9c0ff" stroke-width="5" fill="none" />`
          );
        });
    });
    graphLines.innerHTML = `<g>${paths.join("")}</g>`;

    visibleTasks.forEach((task) => {
      const pos = positions.get(task.id);
      const node = document.createElement("div");
      node.className = "task-node";
      node.style.left = `${pos.x}px`;
      node.style.top = `${pos.y}px`;

      if (state.selectedTaskId === task.id) {
        node.classList.add("selected");
      }

      const hasFilters = state.selectedTags.size || state.selectedPeople.size;
      if (hasFilters) {
        const matches =
          task.tags.some((tag) => state.selectedTags.has(tag)) ||
          task.people.some((person) => state.selectedPeople.has(person));
        if (!matches) {
          node.classList.add("dimmed");
        }
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
        .join("\n")
        .replace(/(^|\s)![^\s#@]+/g, "$1")
        .replace(/\s{2,}/g, " ")
        .trim();
      desc.innerHTML = renderMarkdown(descriptionText);

      const toggle = document.createElement("div");
      toggle.className = "collapse-toggle";
      if (task.children.length) {
        const label = state.collapsed.has(task.id)
          ? `${task.children.length} Subtasks show`
          : `${task.children.length} Subtasks hide`;
        toggle.textContent = label;
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
            const label = state.tagMeta?.get(value)?.name || value;
            pill.textContent = label;
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
      }
      if (task.children.length) {
        node.appendChild(toggle);
      }

      node.addEventListener("click", () => onSelectTask(task));
      node.draggable = true;
      node.addEventListener("dragstart", (event) => {
        event.dataTransfer.setData("text/plain", task.id);
      });
      node.addEventListener("dragover", (event) => {
        event.preventDefault();
      });
      node.addEventListener("drop", (event) => {
        event.preventDefault();
        const payload = event.dataTransfer.getData("application/json");
        if (!payload) {
          return;
        }
        const data = JSON.parse(payload);
        if (!onUpdateTaskToken || (data.type !== "tag" && data.type !== "person")) {
          return;
        }
        onUpdateTaskToken(task, data.value, "add");
      });

      graphNodes.appendChild(node);
    });

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
    const label = meta?.name || text;
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
  });

  return {
    renderGraph,
    focusOnTask,
    applyTransform,
    toggleTag,
    togglePerson,
    buildPill,
  };
}
