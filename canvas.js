export function createCanvas({
  state,
  dom,
  renderMarkdown,
  onSelectTask,
  findTaskByName,
  onFiltersChange,
}) {
  const { graphNodes, graphLines, graphCanvas } = dom;

  function renderGraph() {
    graphNodes.innerHTML = "";
    graphLines.innerHTML = "";
    graphLines.setAttribute("viewBox", "0 0 1200 800");

    const visibleTasks = gatherVisible(state.tasks);
    const positions = new Map();
    let y = 40;
    const spacingY = 170;
    const nodeWidth = 220;
    const nodeHeight = 120;

    visibleTasks.forEach((task) => {
      const x = 60 + task.depth * 260;
      positions.set(task.id, { x, y });
      y += spacingY;
    });
    state.positions = positions;

    const paths = [];
    visibleTasks.forEach((task) => {
      const pos = positions.get(task.id);
      task.children
        .filter((child) => positions.has(child.id))
        .forEach((child) => {
          const childPos = positions.get(child.id);
          const startX = pos.x + nodeWidth / 2;
          const startY = pos.y + 40;
          const endX = childPos.x;
          const endY = childPos.y + nodeHeight / 2;
          const midY = (startY + endY) / 2;
          paths.push(
            `<path d="M ${startX} ${startY} C ${startX} ${midY} ${endX} ${midY} ${endX} ${endY}" stroke="#b9c0ff" stroke-width="2" fill="none" />`
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

      const desc = document.createElement("div");
      desc.className = "description";
      desc.innerHTML = renderMarkdown(task.description.join("\n"));

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

      node.appendChild(title);
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
          pill.addEventListener("click", (event) => {
            event.stopPropagation();
            const type = pill.dataset.type;
            const value = pill.dataset.value;
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

      graphNodes.appendChild(node);
    });

    applyTransform();
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

  function buildPill(text, active, onClick) {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = `pill ${active ? "active" : ""}`;
    pill.textContent = text;
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
  let lastPoint = { x: 0, y: 0 };

  graphCanvas.addEventListener("mousedown", (event) => {
    if (event.target.closest(".task-node")) {
      return;
    }
    isPanning = true;
    lastPoint = { x: event.clientX, y: event.clientY };
  });

  graphCanvas.addEventListener("mousemove", (event) => {
    if (!isPanning) {
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

  return {
    renderGraph,
    focusOnTask,
    applyTransform,
    toggleTag,
    togglePerson,
    buildPill,
  };
}
