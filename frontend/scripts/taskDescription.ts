/**
 * Module: Task description rendering and decoration helpers for markdown and tokens.
 */

type BackgroundTask = { tags: string[]; parent?: BackgroundTask | null; originMeta?: { tagMeta: Map<string, { background?: string }> }; originBackground?: string };

export function createTaskOriginIcon(task: any): HTMLElement | null {
  const reference = task?.origin || task?.referenceTarget;
  if (!reference) return null;
  const icon = document.createElement('span');
  icon.className = 'task-origin-icon';
  icon.setAttribute('role', 'img');
  icon.setAttribute('aria-label', 'Reference task');
  icon.title = `Reference to ${reference.tab}::${reference.name}. Ctrl-click to open original.`;
  const glyph = document.createElement('i');
  glyph.className = 'fa-solid fa-link';
  glyph.setAttribute('aria-hidden', 'true');
  icon.append(glyph);
  return icon;
}

const foregroundCache = new Map<string, string>();
let colorCanvas: CanvasRenderingContext2D | null = null;

/** Composite translucent colors on the view surface before choosing black or white. */
function contrastingForeground(background: string, surface: string): string {
  const key = `${surface}|${background}`;
  const cached = foregroundCache.get(key);
  if (cached) return cached;
  if (!colorCanvas) {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    colorCanvas = canvas.getContext('2d', { willReadFrequently: true });
  }
  if (!colorCanvas) return '#000000';
  colorCanvas.clearRect(0, 0, 1, 1);
  colorCanvas.fillStyle = surface; colorCanvas.fillRect(0, 0, 1, 1);
  colorCanvas.fillStyle = background; colorCanvas.fillRect(0, 0, 1, 1);
  const rgba = colorCanvas.getImageData(0, 0, 1, 1).data;
  const linear = (value: number) => { const v = value / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; };
  const luminance = .2126 * linear(rgba[0]!) + .7152 * linear(rgba[1]!) + .0722 * linear(rgba[2]!);
  const foreground = (luminance + .05) / .05 >= 1.05 / (luminance + .05) ? '#000000' : '#ffffff';
  if (foregroundCache.size > 256) foregroundCache.clear();
  foregroundCache.set(key, foreground);
  return foreground;
}

export function applyTaskBackground(element: HTMLElement, task: BackgroundTask, tagMeta?: Map<string, { background?: string }>, darkSurface = '#0f111a'): void {
  element.style.backgroundColor = '';
  element.style.backgroundColor = taskBackground(task, tagMeta);
  const background = element.style.backgroundColor;
  element.classList.toggle('has-task-background', Boolean(background));
  if (background) {
    element.style.setProperty('--task-foreground-light', contrastingForeground(background, '#ffffff'));
    element.style.setProperty('--task-foreground-dark', contrastingForeground(background, darkSurface));
  } else {
    element.style.removeProperty('--task-foreground-light');
    element.style.removeProperty('--task-foreground-dark');
  }
}

/** The nearest configured background wins, fading by twenty percentage points per level. */
export function taskBackground(task: BackgroundTask | string[], tagMeta?: Map<string, { background?: string }>): string {
  if (!Array.isArray(task) && task.originBackground) return task.originBackground;
  let current: BackgroundTask | null | undefined = Array.isArray(task) ? { tags: task } : task;
  let depth = 0;
  while (current) {
    for (const tag of current.tags) {
      const background = (current.originMeta?.tagMeta || tagMeta)?.get(tag)?.background;
      if (background) return depth === 0 ? background
        : `color-mix(in srgb, ${background} ${Math.max(0, 100 - depth * 20)}%, transparent)`;
    }
    current = current.parent;
    depth++;
  }
  return "";
}

// Defines the TaskDescriptionSource type structure for this module.
type TaskDescriptionSource = {
  description?: unknown[];
  descriptionLineIndexes?: number[];
  indent?: number;
};

// Defines the TaskDescriptionBuildOptions type structure for this module.
type TaskDescriptionBuildOptions = {
  showState?: boolean;
  showEstimate?: boolean;
};

// Defines the TaskDescriptionRenderOptions type structure for this module.
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

// Defines the DescriptionReferenceDecorateOptions type structure for this module.
type DescriptionReferenceDecorateOptions = {
  resolveTaskByName?: ((name: string) => any) | null;
  unresolvedTitle?: string;
  addInlineLinkClass?: boolean;
  getResolvedTitle?: ((target: any, name: string) => string) | null;
  onReferenceClick?: ((params: { event: MouseEvent; element: HTMLElement; name: string; target: any }) => void) | null;
  stopPropagationOnClick?: boolean;
};

// Defines the DescriptionPillDecorateOptions type structure for this module.
type DescriptionPillDecorateOptions = {
  tagMeta?: Map<string, any>;
  peopleMeta?: Map<string, any>;
  selectedTags?: Set<string>;
  selectedPeople?: Set<string>;
  colorText?: boolean;
  onPill?: ((params: { pill: HTMLElement; type: string; value: string }) => void) | null;
};

// Defines the DescriptionCheckboxWireOptions type structure for this module.
type DescriptionCheckboxWireOptions = {
  selector?: string;
  lineFromClosest?: boolean;
  stopPropagationEvents?: string[];
  triggerEvent?: "click" | "change";
  disableWhenUnavailable?: boolean;
  invalidTabIndex?: number | null;
  onToggle?: ((params: { checkbox: HTMLInputElement; lineIndex: number; checked: boolean; event: Event }) => void) | null;
};

// Stores the STATE_TOKEN_RE module constant.
const STATE_TOKEN_RE = /(^|\s)![^\s#@~]+(?=\s|$)/g;
// Stores the ESTIMATE_TOKEN_RE module constant.
const ESTIMATE_TOKEN_RE = /(^|\s)~\d+(?:\.\d+)?(?=\s|$)/g;

/**
 * Builds a normalized multi-line description string from task description lines.
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
 * Creates a rendered description node and returns it with the plain description text.
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
  }: TaskDescriptionRenderOptions = options || {};

  const descriptionText = buildTaskDescriptionText(task, { showState, showEstimate });
  const lineIndexes = Array.isArray(providedLineIndexes)
    ? providedLineIndexes
    : (task && Array.isArray(task.descriptionLineIndexes) ? task.descriptionLineIndexes : undefined);

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
 * Resolves and wires clickable reference elements inside a description node.
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
 * Applies metadata, selection state, and handlers to inline tag/person/jira pills.
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
 * Attaches checkbox toggle handlers for description checklist items.
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

/** Shared state badge used by graph and timeline tasks. */
export function createTaskStatePill(value: string, meta?: { name?: string; color?: string }): HTMLSpanElement {
  const pill = document.createElement("span");
  pill.className = "pill state-pill";
  pill.textContent = meta?.name || value.replace(/^!/, "");
  if (meta?.color) {
    pill.style.borderColor = meta.color;
    pill.style.color = meta.color;
  }
  pill.dataset["type"] = "state";
  pill.dataset["value"] = value;
  return pill;
}
