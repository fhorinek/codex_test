// @ts-check

/**
 * Module: Slug rename modal controller, form logic, and rename operations.
 */

import { normalizeHexColorValue } from "./slugRenameUi.js";

// Defines the SlugKind type structure for this module.
type SlugKind = "tag" | "person" | "state";
// Defines the SlugSection type structure for this module.
type SlugSection = "tags" | "people" | "states";
// Defines the SlugConfigProp type structure for this module.
type SlugConfigProp = keyof SlugRenameMetadata;
// Defines the SlugRenameMetadata type structure for this module.
type SlugRenameMetadata = { name: string; color: string; email: string; jiraState: string };
// Defines the SlugRenameTokenInput type structure for this module.
type SlugRenameTokenInput = { type?: string; prefix?: string; slug?: string } | null | undefined;
// Defines the RenameWholeFileOptions type structure for this module.
type RenameWholeFileOptions = {
  kind: string;
  prefix: string;
  oldSlug: string;
  newSlug: string;
  metadata: Record<string, any>;
};
// Defines the SlugConfigEntryUpdateOptions type structure for this module.
type SlugConfigEntryUpdateOptions = { kind: string; newSlug: string; metadata: Record<string, any> };
// Defines the SlugConfigRenameOptions type structure for this module.
type SlugConfigRenameOptions = { kind: string; oldSlug: string; newSlug: string; metadata: Record<string, any> };

// Stores the SLUG_KIND_LABELS module constant.
const SLUG_KIND_LABELS: Record<SlugKind, string> = {
  tag: "Tag",
  person: "Person",
  state: "State",
};

// Stores the SLUG_SECTION_BY_KIND module constant.
const SLUG_SECTION_BY_KIND: Record<SlugKind, SlugSection> = {
  tag: "tags",
  person: "people",
  state: "states",
};

// Stores the SLUG_CONFIG_PROPS_BY_KIND module constant.
const SLUG_CONFIG_PROPS_BY_KIND: Record<SlugKind, SlugConfigProp[]> = {
  tag: ["name", "color"],
  person: ["name", "color", "email"],
  state: ["name", "color", "jiraState"],
};

// Stores the SLUG_VALUE_RE module constant.
export const SLUG_VALUE_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Handles the isSlugKind function logic.
 * Input: value: unknown.
 * Output: value is SlugKind.
 */
function isSlugKind(value: unknown): value is SlugKind {
  return value === "tag" || value === "person" || value === "state";
}

/**
 * Handles the getSlugConfigProps function logic.
 * Input: kind: string.
 * Output: SlugConfigProp[].
 */
function getSlugConfigProps(kind: string): SlugConfigProp[] {
  return isSlugKind(kind) ? SLUG_CONFIG_PROPS_BY_KIND[kind] : [];
}

/**
 * Handles the getSlugSection function logic.
 * Input: kind: string.
 * Output: SlugSection | null.
 */
function getSlugSection(kind: string): SlugSection | null {
  return isSlugKind(kind) ? SLUG_SECTION_BY_KIND[kind] : null;
}

/**
 * Handles the escapeRegExp function logic.
 * Input: value: string.
 * Output: string.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Handles the normalizeSlugInput function logic.
 * Input: value: string, prefix: string.
 * Output: string.
 */
export function normalizeSlugInput(value: string, prefix: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return "";
  }
  if (raw.startsWith(prefix)) {
    return raw.slice(prefix.length).trim();
  }
  return raw.replace(/^[@#!]/, "").trim();
}

/**
 * Handles the slugKindLabel function logic.
 * Input: kind: string.
 * Output: string.
 */
export function slugKindLabel(kind: string): string {
  return isSlugKind(kind) ? SLUG_KIND_LABELS[kind] : "Token";
}

/**
 * @param {string} kind
 * @param {Record<string, any>} [metadata]
 * @returns {{ name: string, color: string, email: string, jiraState: string }}
 */
export function normalizeSlugMetadata(kind: string, metadata: Record<string, any> = {}): SlugRenameMetadata {
  const normalized = {
    name: typeof metadata["name"] === "string" ? metadata["name"].trim() : "",
    color: typeof metadata["color"] === "string" ? metadata["color"].trim() : "",
    email: "",
    jiraState: "",
  };
  if (kind === "person") {
    normalized.email = typeof metadata["email"] === "string" ? metadata["email"].trim() : "";
  }
  if (kind === "state") {
    normalized.jiraState =
      typeof metadata["jiraState"] === "string" ? metadata["jiraState"].trim() : "";
  }
  return normalized;
}

/**
 * @param {string} kind
 * @param {Record<string, any>} [left]
 * @param {Record<string, any>} [right]
 * @returns {boolean}
 */
export function slugMetadataEqual(kind: string, left: Record<string, any> = {}, right: Record<string, any> = {}) {
  const keys = getSlugConfigProps(kind);
  return keys.every((key: SlugConfigProp) => {
    const a = typeof left[key] === "string" ? left[key].trim() : "";
    const b = typeof right[key] === "string" ? right[key].trim() : "";
    return a === b;
  });
}

/**
 * Handles the buildSlugRenameMetadataFromConfig function logic.
 * Input: config: Record<string, any> | null | undefined, kind: string, slug: string.
 * Output: SlugRenameMetadata.
 */
export function buildSlugRenameMetadataFromConfig(
  config: Record<string, any> | null | undefined,
  kind: string,
  slug: string
): SlugRenameMetadata {
  const section = getSlugSection(kind);
  if (!section) {
    return normalizeSlugMetadata(kind, {});
  }
  const sectionEntries = config?.[section];
  const entries = Array.isArray(sectionEntries) ? sectionEntries : [];
  const entry = entries.find((candidate) => candidate?.key === slug) || null;
  return normalizeSlugMetadata(kind, {
    name: entry?.["name"] && entry["name"] !== slug ? entry["name"] : "",
    color: entry?.["color"] || "",
    email: entry?.["email"] || "",
    jiraState: entry?.["jiraState"] || "",
  });
}

/**
 * Handles the replaceSlugTokenOccurrences function logic.
 * Input: text: string, oldToken: string, newToken: string.
 * Output: result produced by this function.
 */
export function replaceSlugTokenOccurrences(text: string, oldToken: string, newToken: string): { text: string; count: number } {
  const pattern = new RegExp(`(^|\\s)${escapeRegExp(oldToken)}(?=\\s|$)`, "gm");
  let count = 0;
  const nextText = text.replace(pattern, (_match: string, leading: string) => {
    count += 1;
    return `${leading}${newToken}`;
  });
  return { text: nextText, count };
}

/**
 * @param {string} kind
 * @param {Record<string, any>} [metadata]
 * @returns {boolean}
 */
function hasSlugMetadataInput(kind: string, metadata: Record<string, any> = {}) {
  const keys = getSlugConfigProps(kind);
  return keys.some((key: SlugConfigProp) => {
    const value = metadata[key];
    return typeof value === "string" && value.trim() !== "";
  });
}

/**
 * Handles the slugConfigPropOutputName function logic.
 * Input: kind: string, prop: SlugConfigProp.
 * Output: string.
 */
function slugConfigPropOutputName(kind: string, prop: SlugConfigProp): string {
  if (kind === "person" && prop === "email") {
    return "mail";
  }
  if (kind === "state" && prop === "jiraState") {
    return "jira";
  }
  return prop;
}

/**
 * Handles the slugConfigPropOutputValue function logic.
 * Input: prop: SlugConfigProp, value: string.
 * Output: string.
 */
function slugConfigPropOutputValue(prop: SlugConfigProp, value: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (prop === "color") {
    const normalized = normalizeHexColorValue(raw);
    if (normalized) {
      return normalized.slice(1);
    }
  }
  return raw;
}

/**
 * Handles the formatSlugConfigPropLine function logic.
 * Input: kind: string, prop: SlugConfigProp, value: string.
 * Output: string.
 */
function formatSlugConfigPropLine(kind: string, prop: SlugConfigProp, value: string): string {
  const outputProp = slugConfigPropOutputName(kind, prop);
  const outputValue = slugConfigPropOutputValue(prop, value);
  return `            ${outputProp}: ${outputValue}`;
}

/**
 * Handles the normalizeSlugConfigPropName function logic.
 * Input: prop: string.
 * Output: SlugConfigProp | "".
 */
function normalizeSlugConfigPropName(prop: string): SlugConfigProp | "" {
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

/**
 * Handles the buildSlugConfigEntryLines function logic.
 * Input: kind: string, slug: string, metadata: Record<string, any>.
 * Output: string[].
 */
function buildSlugConfigEntryLines(kind: string, slug: string, metadata: Record<string, any>): string[] {
  const normalizedMeta = normalizeSlugMetadata(kind, metadata);
  const props = getSlugConfigProps(kind);
  const propLines = props
    .filter((prop: SlugConfigProp) => Boolean(normalizedMeta[prop]))
    .map((prop: SlugConfigProp) => formatSlugConfigPropLine(kind, prop, normalizedMeta[prop]));
  const header = `        ${slug}${propLines.length ? ":" : ""}`;
  return [header, ...propLines];
}

/**
 * Handles the updateSlugConfigEntryBlock function logic.
 * Input: entryLines: string[], { kind, newSlug, metadata }: SlugConfigEntryUpdateOptions.
 * Output: result produced by this function.
 */
function updateSlugConfigEntryBlock(
  entryLines: string[],
  { kind, newSlug, metadata }: SlugConfigEntryUpdateOptions
): { lines: string[]; changed: boolean } {
  if (!Array.isArray(entryLines) || !entryLines.length) {
    return { lines: buildSlugConfigEntryLines(kind, newSlug, metadata), changed: true };
  }
  const normalizedMeta = normalizeSlugMetadata(kind, metadata);
  const targetProps = getSlugConfigProps(kind);
  const headerRaw = entryLines[0] || "";
  const headerIndent = headerRaw.match(/^\s*/)?.[0] || "        ";
  let bodyLines: Array<string | null> = entryLines.slice(1);
  const propIndexes = new Map<SlugConfigProp, number>();
  bodyLines.forEach((line: string | null, index: number) => {
    const trimmed = (line || "").trim();
    const indent = line?.match?.(/^\s*/)?.[0]?.length || 0;
    if (indent !== 12 || !trimmed) {
      return;
    }
    const propMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (!propMatch) {
      return;
    }
    const propName = normalizeSlugConfigPropName(propMatch[1] || "");
    if (!propName) {
      return;
    }
    if (targetProps.includes(propName) && !propIndexes.has(propName)) {
      propIndexes.set(propName, index);
    }
  });

  targetProps.forEach((prop: SlugConfigProp) => {
    const nextValue = normalizedMeta[prop] || "";
    const existingIndex = propIndexes.get(prop);
    if (nextValue) {
      const nextLine = formatSlugConfigPropLine(kind, prop, nextValue);
      if (typeof existingIndex === "number") {
        bodyLines[existingIndex] = nextLine;
      } else {
        bodyLines.push(nextLine);
      }
      return;
    }
    if (typeof existingIndex === "number") {
      bodyLines[existingIndex] = null;
    }
  });

  const filteredBodyLines = bodyLines.filter((line: string | null): line is string => line !== null);
  const hasNestedContent = filteredBodyLines.some((line) => (line || "").trim() !== "");
  const nextHeader = `${headerIndent}${newSlug}${hasNestedContent ? ":" : ""}`;
  const nextLines = [nextHeader, ...filteredBodyLines];
  const changed = nextLines.join("\n") !== entryLines.join("\n");
  return { lines: nextLines, changed };
}

/**
 * Handles the renameSlugConfigEntries function logic.
 * Input: lines: string[], { kind, oldSlug, newSlug, metadata }: SlugConfigRenameOptions.
 * Output: result produced by this function.
 */
function renameSlugConfigEntries(
  lines: string[],
  { kind, oldSlug, newSlug, metadata }: SlugConfigRenameOptions
): { changed: boolean } {
  const targetSection = getSlugSection(kind);
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

/**
 * Handles the renameSlugInWholeFile function logic.
 * Input: text: string, { kind, prefix, oldSlug, newSlug, metadata }: RenameWholeFileOptions.
 * Output: result produced by this function.
 */
export function renameSlugInWholeFile(
  text: string,
  { kind, prefix, oldSlug, newSlug, metadata }: RenameWholeFileOptions
) {
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

// Defines the SlugRenameModalDom type structure for this module.
type SlugRenameModalDom = {
  slugRenameModal?: HTMLElement | null;
  slugRenameMessage?: HTMLElement | null;
  slugRenameCurrent?: HTMLInputElement | null;
  slugRenameNew?: HTMLInputElement | null;
  slugRenameDisplayName?: HTMLInputElement | null;
  slugRenameColor?: HTMLInputElement | null;
  slugRenameEmail?: HTMLInputElement | null;
  slugRenameJiraState?: HTMLInputElement | null;
  taskEditModal?: HTMLElement | null;
};

// Defines the SlugRenameUiApi type structure for this module.
type SlugRenameUiApi = {
  /**
   * Handles the ensureColorControls function logic.
   * Input: none.
   * Output: result produced by this function.
   */
  ensureColorControls: () => void;
  /**
   * Handles the setFieldVisibility function logic.
   * Input: kind: string.
   * Output: result produced by this function.
   */
  setFieldVisibility: (kind: string) => void;
  /**
   * Handles the configureContext function logic.
   * Input: kind: string.
   * Output: result produced by this function.
   */
  configureContext: (kind: string) => void;
  /**
   * Handles the setColorValue function logic.
   * Input: value: string.
   * Output: result produced by this function.
   */
  setColorValue: (value: string) => void;
};

// Defines the PendingSlugRename type structure for this module.
type PendingSlugRename = {
  kind: SlugKind;
  prefix: string;
  slug: string;
  metadata: SlugRenameMetadata;
};

// Defines the SlugRenameModalControllerOptions type structure for this module.
type SlugRenameModalControllerOptions = {
  dom: SlugRenameModalDom;
  slugRenameUi: SlugRenameUiApi;
  /**
   * Handles the getConfig function logic.
   * Input: none.
   * Output: result produced by this function.
   */
  getConfig: () => Record<string, any> | null | undefined;
  /**
   * Handles the getEditorValue function logic.
   * Input: none.
   * Output: result produced by this function.
   */
  getEditorValue: () => string;
  /**
   * Handles the applyEditorValue function logic.
   * Input: value: string.
   * Output: result produced by this function.
   */
  applyEditorValue: (value: string) => void;
  /**
   * Handles the isTaskEditModalOpen function logic.
   * Input: none.
   * Output: result produced by this function.
   */
  isTaskEditModalOpen: () => boolean;
  /**
   * Handles the getTaskEditModalValue function logic.
   * Input: none.
   * Output: result produced by this function.
   */
  getTaskEditModalValue: () => string;
  /**
   * Handles the setTaskEditModalValue function logic.
   * Input: value: string.
   * Output: result produced by this function.
   */
  setTaskEditModalValue: (value: string) => void;
  /**
   * Handles the showToast function logic.
   * Input: message: string, kind?: string.
   * Output: result produced by this function.
   */
  showToast: (message: string, kind?: string) => void;
};

/**
 * Handles the createSlugRenameModalController function logic.
 * Input: options: SlugRenameModalControllerOptions.
 * Output: result produced by this function.
 */
export function createSlugRenameModalController(options: SlugRenameModalControllerOptions) {
  const {
    dom,
    slugRenameUi,
    getConfig,
    getEditorValue,
    applyEditorValue,
    isTaskEditModalOpen,
    getTaskEditModalValue,
    setTaskEditModalValue,
    showToast,
  } = options;

  let pendingSlugRename: PendingSlugRename | null = null;

  /**
   * Handles the close function logic.
   * Input: none.
   * Output: result produced by this function.
   */
  function close() {
    if (!dom.slugRenameModal) {
      return;
    }
    dom.slugRenameModal.classList.add("hidden");
    if (dom.slugRenameDisplayName) {
      dom.slugRenameDisplayName.value = "";
    }
    slugRenameUi.setColorValue("");
    if (dom.slugRenameEmail) {
      dom.slugRenameEmail.value = "";
    }
    if (dom.slugRenameJiraState) {
      dom.slugRenameJiraState.value = "";
    }
    pendingSlugRename = null;
  }

  /**
   */
  function open(token: SlugRenameTokenInput): void {
    if (!dom.slugRenameModal || !token) {
      return;
    }
    const kind = token.type;
    const prefix = typeof token.prefix === "string" ? token.prefix : "";
    const slug = typeof token.slug === "string" ? token.slug.trim() : "";
    if (
      !slug
      || !isSlugKind(kind)
      || !["#", "@", "!"].includes(prefix || "")
    ) {
      return;
    }
    const pending: PendingSlugRename = {
      kind,
      prefix,
      slug,
      metadata: buildSlugRenameMetadataFromConfig(getConfig(), kind, slug),
    };
    pendingSlugRename = pending;
    if (dom.slugRenameMessage) {
      dom.slugRenameMessage.textContent =
        `Rename ${slugKindLabel(kind).toLowerCase()} slug "${prefix}${slug}" in whole file.`;
    }
    if (dom.slugRenameCurrent) {
      dom.slugRenameCurrent.value = `${prefix}${slug}`;
    }
    if (dom.slugRenameNew) {
      dom.slugRenameNew.value = slug;
    }
    slugRenameUi.ensureColorControls();
    slugRenameUi.setFieldVisibility(kind);
    slugRenameUi.configureContext(kind);
    if (dom.slugRenameDisplayName) {
      dom.slugRenameDisplayName.value = pending.metadata.name || "";
    }
    slugRenameUi.setColorValue(pending.metadata.color || "");
    if (dom.slugRenameEmail) {
      dom.slugRenameEmail.value = pending.metadata.email || "";
    }
    if (dom.slugRenameJiraState) {
      dom.slugRenameJiraState.value = pending.metadata.jiraState || "";
    }
    dom.slugRenameModal.classList.remove("hidden");
    dom.slugRenameNew?.focus();
    dom.slugRenameNew?.select();
  }

  /**
   * Handles the submit function logic.
   * Input: none.
   * Output: void.
   */
  function submit(): void {
    const pending = pendingSlugRename;
    if (!pending) {
      close();
      return;
    }
    const nextSlug = normalizeSlugInput(dom.slugRenameNew?.value || "", pending.prefix);
    if (!nextSlug) {
      showToast("New slug is required.", "error");
      return;
    }
    if (!SLUG_VALUE_RE.test(nextSlug)) {
      showToast("Slug can contain only letters, numbers, '-' and '_'.", "error");
      return;
    }
    const nextMetadata = normalizeSlugMetadata(pending.kind, {
      name: dom.slugRenameDisplayName?.value || "",
      color: dom.slugRenameColor?.value || "",
      email: dom.slugRenameEmail?.value || "",
      jiraState: dom.slugRenameJiraState?.value || "",
    });
    const slugChanged = nextSlug !== pending.slug;
    const metadataChanged = !slugMetadataEqual(
      pending.kind,
      pending.metadata,
      nextMetadata
    );
    if (!slugChanged && !metadataChanged) {
      close();
      return;
    }
    const original = getEditorValue();
    const oldToken = `${pending.prefix}${pending.slug}`;
    const result = renameSlugInWholeFile(original, {
      kind: pending.kind,
      prefix: pending.prefix,
      oldSlug: pending.slug,
      newSlug: nextSlug,
      metadata: nextMetadata,
    });
    if (!result.changed) {
      showToast(`No '${oldToken}' slug occurrences found.`, "error");
      return;
    }
    applyEditorValue(result.text);

    if (slugChanged && isTaskEditModalOpen()) {
      const modalValue = getTaskEditModalValue();
      const modalRename = replaceSlugTokenOccurrences(
        modalValue,
        result.oldToken,
        result.newToken
      );
      if (modalRename.text !== modalValue) {
        setTaskEditModalValue(modalRename.text);
      }
    }

    if (slugChanged) {
      showToast(
        `${slugKindLabel(pending.kind)} slug '${result.oldToken}' renamed to '${result.newToken}'.`
      );
    } else {
      showToast(`${slugKindLabel(pending.kind)} metadata updated.`);
    }
    close();
  }

  return {
    open,
    close,
    submit,
  };
}
