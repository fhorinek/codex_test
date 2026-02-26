type TaskDescriptionSource = {
  description?: unknown[];
  descriptionLineIndexes?: number[];
  indent?: number;
};

type TaskDescriptionBuildOptions = {
  showState?: boolean;
  showEstimate?: boolean;
};

type TaskDescriptionRenderOptions = {
  task: TaskDescriptionSource | null | undefined;
  renderMarkdown?: ((text: string, options?: any) => string) | null;
  className?: string;
  fallbackClassName?: string;
  lineIndexes?: number[] | undefined;
  baseIndent?: number;
  disableLinks?: boolean;
  showState?: boolean;
  showEstimate?: boolean;
};

type DescriptionReferenceDecorateOptions = {
  resolveTaskByName?: ((name: string) => any) | null;
  unresolvedTitle?: string;
  addInlineLinkClass?: boolean;
  getResolvedTitle?: ((target: any, name: string) => string) | null;
  onReferenceClick?: ((params: { event: MouseEvent; element: HTMLElement; name: string; target: any }) => void) | null;
  stopPropagationOnClick?: boolean;
};

type DescriptionPillDecorateOptions = {
  tagMeta?: Map<string, any>;
  peopleMeta?: Map<string, any>;
  selectedTags?: Set<string>;
  selectedPeople?: Set<string>;
  colorText?: boolean;
  onPill?: ((params: { pill: HTMLElement; type: string; value: string }) => void) | null;
};

type DescriptionCheckboxWireOptions = {
  selector?: string;
  lineFromClosest?: boolean;
  stopPropagationEvents?: string[];
  triggerEvent?: "click" | "change";
  disableWhenUnavailable?: boolean;
  invalidTabIndex?: number | null;
  onToggle?: ((params: { checkbox: HTMLInputElement; lineIndex: number; checked: boolean; event: Event }) => void) | null;
};

const STATE_TOKEN_RE = /(^|\s)![^\s#@~]+(?=\s|$)/g;
const ESTIMATE_TOKEN_RE = /(^|\s)~\d+(?:\.\d+)?(?=\s|$)/g;

/**
 * @param {TaskDescriptionSource | null | undefined} task
 * @param {TaskDescriptionBuildOptions} [options]
 * @returns {string}
 */
export function buildTaskDescriptionText(task: TaskDescriptionSource | null | undefined, options: TaskDescriptionBuildOptions = {}) {
  if (!task || !Array.isArray(task.description) || !task.description.length) {
    return "";
  }
  const showState = Boolean(options.showState);
  const showEstimate = Boolean(options.showEstimate);
  return task.description
    .map((line) => {
      const rawLine = typeof line === "string" ? line : "";
      const indent = rawLine.match(/^\s*/)?.[0] || "";
      let content = rawLine.slice(indent.length);
      if (!showState) {
        content = content.replace(STATE_TOKEN_RE, "$1");
      }
      if (!showEstimate) {
        content = content.replace(ESTIMATE_TOKEN_RE, "$1");
      }
      content = content.replace(/\s{2,}/g, " ").trim();
      return content ? `${indent}${content}` : "";
    })
    .join("\n");
}

/**
 * @param {TaskDescriptionRenderOptions} options
 * @returns {{ node: HTMLElement, descriptionText: string }}
 */
export function renderTaskDescriptionNode(options: TaskDescriptionRenderOptions) {
  const {
    task,
    renderMarkdown,
    className = "description",
    fallbackClassName = className,
    lineIndexes: providedLineIndexes,
    baseIndent = 0,
    disableLinks = false,
    showState = false,
    showEstimate = false,
  } = options || {};

  const descriptionText = buildTaskDescriptionText(task, { showState, showEstimate });
  const lineIndexes = Array.isArray(providedLineIndexes)
    ? providedLineIndexes
    : (Array.isArray(task?.descriptionLineIndexes) ? task.descriptionLineIndexes : undefined);

  if (typeof renderMarkdown !== "function") {
    const fallback = document.createElement("pre");
    fallback.className = fallbackClassName;
    fallback.textContent = descriptionText;
    return { node: fallback, descriptionText };
  }

  const node = document.createElement("div");
  node.className = className;
  node.innerHTML = renderMarkdown(descriptionText, {
    lineIndexes,
    baseIndent: Number.isFinite(baseIndent) ? baseIndent : 0,
    disableLinks: Boolean(disableLinks),
  });
  return { node, descriptionText };
}

/**
 * @param {ParentNode} node
 * @param {DescriptionReferenceDecorateOptions} [options]
 */
export function decorateDescriptionReferences(node: ParentNode, options: DescriptionReferenceDecorateOptions = {}) {
  const {
    resolveTaskByName = null,
    unresolvedTitle = "Reference target not found",
    addInlineLinkClass = false,
    getResolvedTitle = null,
    onReferenceClick = null,
    stopPropagationOnClick = false,
  } = options;
  node.querySelectorAll(".references").forEach((link) => {
    const refEl = link as HTMLElement;
    if (addInlineLinkClass) {
      refEl.classList.add("inline-link");
    }
    const referenceName = typeof refEl.dataset["ref"] === "string" ? refEl.dataset["ref"].trim() : "";
    const target = referenceName && typeof resolveTaskByName === "function"
      ? resolveTaskByName(referenceName)
      : null;
    if (!target) {
      refEl.classList.add("unresolved");
      refEl.title = unresolvedTitle;
      return;
    }
    if (typeof getResolvedTitle === "function") {
      const title = getResolvedTitle(target, referenceName);
      if (title) {
        refEl.title = title;
      }
    }
    if (typeof onReferenceClick === "function") {
      refEl.addEventListener("click", (event) => {
        const mouseEvent = event as MouseEvent;
        if (stopPropagationOnClick) {
          mouseEvent.stopPropagation();
        }
        onReferenceClick({
          event: mouseEvent,
          element: refEl,
          name: referenceName,
          target,
        });
      });
    }
  });
}

/**
 * @param {ParentNode} node
 * @param {DescriptionPillDecorateOptions} [options]
 */
export function decorateDescriptionPills(node: ParentNode, options: DescriptionPillDecorateOptions = {}) {
  const {
    tagMeta,
    peopleMeta,
    selectedTags,
    selectedPeople,
    colorText = false,
    onPill = null,
  } = options;
  node.querySelectorAll(".inline-pill").forEach((pillNode) => {
    const pill = pillNode as HTMLElement;
    const type = pill.dataset["type"];
    const value = pill.dataset["value"];
    if (!type || !value) {
      return;
    }
    if (type === "tag" && selectedTags?.has(value)) {
      pill.classList.add("active");
    }
    if (type === "person" && selectedPeople?.has(value)) {
      pill.classList.add("active");
    }
    if (type === "tag") {
      const meta = tagMeta?.get(value);
      const label = meta?.name || value.replace("#", "");
      pill.textContent = `#${label}`;
      if (meta?.color) {
        pill.style.borderColor = meta.color;
        if (colorText) {
          pill.style.color = meta.color;
        }
      }
    } else if (type === "person") {
      const meta = peopleMeta?.get(value);
      const label = meta?.name || value.replace("@", "");
      pill.textContent = `👤 ${label}`;
      if (meta?.color) {
        pill.style.borderColor = meta.color;
        if (colorText) {
          pill.style.color = meta.color;
        }
      }
    } else if (type === "jira") {
      pill.textContent = value;
    }
    if (typeof onPill === "function") {
      onPill({ pill, type, value });
    }
  });
}

/**
 * @param {ParentNode} node
 * @param {DescriptionCheckboxWireOptions} [options]
 */
export function wireDescriptionCheckboxes(node: ParentNode, options: DescriptionCheckboxWireOptions = {}) {
  const {
    selector = 'input[type="checkbox"]',
    lineFromClosest = true,
    stopPropagationEvents = [],
    triggerEvent = "change",
    disableWhenUnavailable = false,
    invalidTabIndex = null,
    onToggle = null,
  } = options;
  node.querySelectorAll(selector).forEach((checkboxNode) => {
    const checkbox = checkboxNode as HTMLInputElement;
    const rawLine = checkbox.dataset["line"] || (
      lineFromClosest
        ? (checkbox.closest(".checkbox-line") as HTMLElement | null)?.dataset["line"]
        : undefined
    );
    const lineIndex = Number.parseInt(rawLine ?? "", 10);
    if (!Number.isFinite(lineIndex) || typeof onToggle !== "function") {
      if (disableWhenUnavailable) {
        checkbox.disabled = true;
        if (typeof invalidTabIndex === "number") {
          checkbox.tabIndex = invalidTabIndex;
        }
      }
      return;
    }
    stopPropagationEvents.forEach((eventName) => {
      checkbox.addEventListener(eventName, (event) => {
        event.stopPropagation();
      });
    });
    checkbox.addEventListener(triggerEvent, (event) => {
      if (!stopPropagationEvents.includes(triggerEvent)) {
        // Keep existing semantics configurable per caller.
      }
      onToggle({
        checkbox,
        lineIndex,
        checked: checkbox.checked,
        event,
      });
    });
  });
}
