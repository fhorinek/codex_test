import { Compartment, EditorState, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentLess,
  indentMore,
  redo,
  undo,
} from "@codemirror/commands";
import { autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { search, searchKeymap } from "@codemirror/search";
import { foldGutter, foldKeymap, foldService, indentUnit } from "@codemirror/language";
import { indentationMarkers } from "@replit/codemirror-indentation-markers";

const taskLineDecoration = Decoration.line({ class: "cm-task-line" });
const subtaskLineDecoration = Decoration.line({ class: "cm-subtask-line" });
const configLineDecoration = Decoration.line({ class: "cm-config-line" });
const errorLineDecoration = Decoration.line({ class: "cm-error-line" });
const noSpellAttributes = { spellcheck: "false" };
const tagDecoration = Decoration.mark({ class: "cm-tag-token", attributes: noSpellAttributes });
const personDecoration = Decoration.mark({ class: "cm-person-token", attributes: noSpellAttributes });
const stateDecoration = Decoration.mark({ class: "cm-state-token", attributes: noSpellAttributes });
const invalidStateDecoration = Decoration.mark({
  class: "cm-state-token cm-error-token",
  attributes: noSpellAttributes,
});
const referenceDecoration = Decoration.mark({ class: "cm-reference-token", attributes: noSpellAttributes });
const invalidReferenceDecoration = Decoration.mark({
  class: "cm-reference-token cm-reference-token-invalid",
  attributes: noSpellAttributes,
});
const jiraDecoration = Decoration.mark({ class: "cm-jira-token", attributes: noSpellAttributes });
const selectedSpaceDecoration = Decoration.mark({ class: "cm-highlightSpace" });
const selectedTabDecoration = Decoration.mark({ class: "cm-highlightTab" });
const spellcheckDisabledDecoration = Decoration.mark({ attributes: noSpellAttributes });
const spellcheckEnabledDecoration = Decoration.mark({ class: "cm-spellcheck-enabled", attributes: { spellcheck: "true" } });

class TaskReferenceBadgeWidget extends WidgetType {
  constructor(referenceTasks, onOpenTaskLine) {
    super();
    const normalized = Array.isArray(referenceTasks)
      ? referenceTasks
        .map((item) => ({
          lineIndex: Number.parseInt(item?.lineIndex, 10),
          name: typeof item?.name === "string" ? item.name : "",
        }))
        .filter((item) => Number.isFinite(item.lineIndex))
      : [];
    this.referenceTasks = normalized;
    this.count = normalized.length;
    this.signature = normalized.map((item) => `${item.lineIndex}:${item.name}`).join("|");
    this.onOpenTaskLine = onOpenTaskLine;
  }
  eq(other) {
    return other.signature === this.signature;
  }
  toDOM() {
    const menu = document.createElement("span");
    menu.className = "task-reference-menu cm-task-reference-menu";
    const indicator = document.createElement("button");
    indicator.type = "button";
    indicator.className = "task-reference-indicator cm-task-reference-icon";
    const label = this.count === 1
      ? "Referenced by 1 task"
      : `Referenced by ${this.count} tasks`;
    indicator.title = `${label}. Click to open list.`;
    indicator.setAttribute("aria-label", `${label}. Click to open list.`);
    const icon = document.createElement("i");
    icon.className = "fa-solid fa-link";
    icon.setAttribute("aria-hidden", "true");
    const count = document.createElement("span");
    count.textContent = String(this.count);
    indicator.append(icon, count);
    const dropdown = document.createElement("div");
    dropdown.className = "task-reference-dropdown hidden";
    this.referenceTasks.forEach((referenceTask) => {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "task-reference-option";
      option.textContent = referenceTask.name || "Untitled task";
      option.title = "Focus task";
      option.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        dropdown.classList.add("hidden");
        if (typeof this.onOpenTaskLine === "function") {
          this.onOpenTaskLine(referenceTask.lineIndex);
        }
      });
      dropdown.appendChild(option);
    });
    indicator.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const root = menu.closest(".code-editor");
      root
        ?.querySelectorAll(".cm-task-reference-menu .task-reference-dropdown:not(.hidden)")
        ?.forEach((openDropdown) => {
          if (openDropdown !== dropdown) {
            openDropdown.classList.add("hidden");
          }
        });
      dropdown.classList.toggle("hidden");
    });
    menu.addEventListener("focusout", (event) => {
      if (!menu.contains(event.relatedTarget)) {
        dropdown.classList.add("hidden");
      }
    });
    menu.append(indicator, dropdown);
    return menu;
  }
  ignoreEvent() {
    return false;
  }
}

function taskReferenceBadgeDecoration(referenceTasks, onOpenTaskLine) {
  if (!Array.isArray(referenceTasks) || !referenceTasks.length) {
    return null;
  }
  return Decoration.widget({
    widget: new TaskReferenceBadgeWidget(referenceTasks, onOpenTaskLine),
    side: 1,
  });
}

function getIndent(text) {
  return text.match(/^\s*/)?.[0].length || 0;
}

function foldTaskBlock(state, line) {
  const baseIndent = getIndent(line.text);
  let endLine = line.number;
  for (let i = line.number + 1; i <= state.doc.lines; i += 1) {
    const current = state.doc.line(i);
    const currentText = current.text;
    const taskMatch = currentText.match(/^(\s*)%/);
    if (taskMatch) {
      const indent = taskMatch[1].length;
      if (indent <= baseIndent) {
        break;
      }
    }
    endLine = i;
  }
  if (endLine === line.number) {
    return null;
  }
  return { from: line.to, to: state.doc.line(endLine).to };
}

function foldConfigBlock(state, line) {
  const baseIndent = getIndent(line.text);
  let endLine = line.number;
  for (let i = line.number + 1; i <= state.doc.lines; i += 1) {
    const current = state.doc.line(i);
    const currentText = current.text;
    if (currentText.trim() === "") {
      endLine = i;
      continue;
    }
    if (/^\s*%/.test(currentText)) {
      break;
    }
    const indent = getIndent(currentText);
    if (indent <= baseIndent) {
      break;
    }
    endLine = i;
  }
  if (endLine === line.number) {
    return null;
  }
  return { from: line.to, to: state.doc.line(endLine).to };
}

const taskScriptFoldService = foldService.of((state, lineStart) => {
  const line = state.doc.lineAt(lineStart);
  const text = line.text;
  if (/^\s*%/.test(text)) {
    return foldTaskBlock(state, line);
  }
  if (/^\s*[a-zA-Z][\w-]*:\s*$/.test(text)) {
    return foldConfigBlock(state, line);
  }
  return null;
});

function parseTaskTitleFromLine(text) {
  if (typeof text !== "string") {
    return "";
  }
  const taskMatch = text.match(/^\s*%\s+(.*)$/);
  if (!taskMatch) {
    return "";
  }
  return taskMatch[1]
    .replace(/\s*\[JIRA:[A-Z][A-Z0-9]+-\d+\]\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function taskTitleRangeFromLine(line) {
  if (!line || typeof line.text !== "string") {
    return null;
  }
  const text = line.text;
  const taskMatch = text.match(/^(\s*)%\s+/);
  if (!taskMatch) {
    return null;
  }
  const prefixLength = taskMatch[0].length;
  let titleStart = prefixLength;
  const jiraMatch = text.slice(titleStart).match(/^\[JIRA:[A-Z][A-Z0-9]+-\d+\]\s*/);
  if (jiraMatch) {
    titleStart += jiraMatch[0].length;
  }
  if (titleStart >= text.length) {
    return null;
  }
  let titleEnd = text.length;
  while (titleEnd > titleStart && /\s/.test(text[titleEnd - 1])) {
    titleEnd -= 1;
  }
  if (titleEnd <= titleStart) {
    return null;
  }
  return {
    from: line.from + titleStart,
    to: line.from + titleEnd,
  };
}

function collectIncomingReferenceData(doc) {
  const tasks = [];
  let currentTask = null;
  for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
    const text = doc.line(lineNumber).text;
    if (/^\s*%\s+/.test(text)) {
      currentTask = {
        lineIndex: lineNumber - 1,
        title: parseTaskTitleFromLine(text),
        references: new Set(),
      };
      tasks.push(currentTask);
      continue;
    }
    if (!currentTask || !text || !text.trim()) {
      continue;
    }
    let match;
    const refRegex = /\{([^}]+)\}/g;
    while ((match = refRegex.exec(text)) !== null) {
      const key = match[1].trim();
      if (key) {
        currentTask.references.add(key);
      }
    }
  }
  const incomingReferenceSources = new Map();
  tasks.forEach((task) => {
    if (!task.title) {
      return;
    }
    task.references.forEach((referenceName) => {
      const current = incomingReferenceSources.get(referenceName) || [];
      if (current.some((item) => item.lineIndex === task.lineIndex)) {
        return;
      }
      current.push({ lineIndex: task.lineIndex, name: task.title });
      incomingReferenceSources.set(referenceName, current);
    });
  });
  incomingReferenceSources.forEach((items) => {
    items.sort((a, b) => a.lineIndex - b.lineIndex);
  });
  return incomingReferenceSources;
}

function collectTaskTitleLookup(doc) {
  const exact = new Set();
  const lowercase = new Set();
  for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
    const text = doc.line(lineNumber).text;
    if (!/^\s*%\s+/.test(text)) {
      continue;
    }
    const title = parseTaskTitleFromLine(text);
    if (!title) {
      continue;
    }
    exact.add(title);
    lowercase.add(title.toLowerCase());
  }
  return { exact, lowercase };
}

function collectDescriptionLineIndexes(doc) {
  const descriptionLines = new Set();
  let inTaskBlock = false;
  for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
    const text = doc.line(lineNumber).text;
    if (/^\s*%\s+/.test(text)) {
      inTaskBlock = true;
      continue;
    }
    if (!inTaskBlock) {
      continue;
    }
    if (text.trim() === "") {
      continue;
    }
    descriptionLines.add(lineNumber - 1);
  }
  return descriptionLines;
}

function buildDecorations(
  view,
  appState,
  incomingReferenceSources = new Map(),
  taskTitleLookup = { exact: new Set(), lowercase: new Set() },
  onOpenTaskLine = null
) {
  const scopedSpellcheckEnabled = Boolean(appState?.scopedSpellcheck && appState?.spellcheckEnabled);
  const descriptionLineIndexes = scopedSpellcheckEnabled
    ? collectDescriptionLineIndexes(view.state.doc)
    : new Set();
  const invalidStateTags =
    appState && appState.invalidStateTags instanceof Map ? appState.invalidStateTags : null;
  const builder = new RangeSetBuilder();
  for (const { from, to } of view.visibleRanges) {
    let line = view.state.doc.lineAt(from);
    while (line.from <= to) {
      const ranges = [];
      const text = line.text;
      const lineIndex = line.number - 1;
      const invalidTokens = invalidStateTags?.get(lineIndex) || null;
      if (invalidTokens && invalidTokens.length) {
        ranges.push({
          from: line.from,
          to: line.from,
          decoration: errorLineDecoration,
        });
      }
      const taskMatch = text.match(/^(\s*)%\s+/);
      if (taskMatch) {
        const indent = taskMatch[1].length;
        ranges.push({
          from: line.from,
          to: line.from,
          decoration: indent >= 4 ? subtaskLineDecoration : taskLineDecoration,
        });
        if (scopedSpellcheckEnabled) {
          if (line.from < line.to) {
            ranges.push({
              from: line.from,
              to: line.to,
              decoration: spellcheckDisabledDecoration,
            });
          }
          const titleRange = taskTitleRangeFromLine(line);
          if (titleRange) {
            ranges.push({
              from: titleRange.from,
              to: titleRange.to,
              decoration: spellcheckEnabledDecoration,
            });
          }
        }
        const taskTitle = parseTaskTitleFromLine(text);
        const incomingTasks = taskTitle
          ? incomingReferenceSources.get(taskTitle) || []
          : [];
        const badgeDecoration = taskReferenceBadgeDecoration(incomingTasks, onOpenTaskLine);
        if (badgeDecoration) {
          ranges.push({
            from: line.to,
            to: line.to,
            decoration: badgeDecoration,
          });
        }
      } else if (/^\s*[a-zA-Z][\w-]*:\s*$/.test(text)) {
        ranges.push({
          from: line.from,
          to: line.from,
          decoration: configLineDecoration,
        });
        if (scopedSpellcheckEnabled && line.from < line.to) {
          ranges.push({
            from: line.from,
            to: line.to,
            decoration: spellcheckDisabledDecoration,
          });
        }
      } else if (scopedSpellcheckEnabled && descriptionLineIndexes.has(lineIndex)) {
        const contentStart = text.search(/\S/);
        if (contentStart >= 0) {
          ranges.push({
            from: line.from + contentStart,
            to: line.to,
            decoration: spellcheckEnabledDecoration,
          });
        }
      } else if (scopedSpellcheckEnabled && line.from < line.to) {
        ranges.push({
          from: line.from,
          to: line.to,
          decoration: spellcheckDisabledDecoration,
        });
      }

      let match;
      const tagRegex = /(^|\s)(#[^\s#@]+)/g;
      while ((match = tagRegex.exec(text)) !== null) {
        const start = match.index + match[1].length;
        ranges.push({
          from: line.from + start,
          to: line.from + start + match[2].length,
          decoration: tagDecoration,
        });
      }
      const personRegex = /(^|\s)(@[^\s#@]+)/g;
      while ((match = personRegex.exec(text)) !== null) {
        const start = match.index + match[1].length;
        ranges.push({
          from: line.from + start,
          to: line.from + start + match[2].length,
          decoration: personDecoration,
        });
      }
      const stateRegex = /(^|\s)(![^\s#@]+)/g;
      while ((match = stateRegex.exec(text)) !== null) {
        const start = match.index + match[1].length;
        const token = match[2];
        const isInvalid = invalidTokens ? invalidTokens.includes(token) : false;
        ranges.push({
          from: line.from + start,
          to: line.from + start + token.length,
          decoration: isInvalid ? invalidStateDecoration : stateDecoration,
        });
      }
      const refRegex = /{[^}]+}/g;
      while ((match = refRegex.exec(text)) !== null) {
        const referenceName = match[0].slice(1, -1).trim();
        const hasTarget = referenceName
          ? taskTitleLookup.exact.has(referenceName) ||
            taskTitleLookup.lowercase.has(referenceName.toLowerCase())
          : false;
        ranges.push({
          from: line.from + match.index,
          to: line.from + match.index + match[0].length,
          decoration: hasTarget ? referenceDecoration : invalidReferenceDecoration,
        });
      }
      const jiraRegex = /\[JIRA:[A-Z][A-Z0-9]+-\d+\]/g;
      while ((match = jiraRegex.exec(text)) !== null) {
        ranges.push({
          from: line.from + match.index,
          to: line.from + match.index + match[0].length,
          decoration: jiraDecoration,
        });
      }

      ranges.sort((a, b) => {
        if (a.from !== b.from) {
          return a.from - b.from;
        }
        const aSide = a.decoration.startSide ?? 0;
        const bSide = b.decoration.startSide ?? 0;
        if (aSide !== bSide) {
          return aSide - bSide;
        }
        return a.to - b.to;
      });

      ranges.forEach((range) => {
        builder.add(range.from, range.to, range.decoration);
      });

      if (line.number === view.state.doc.lines) {
        break;
      }
      line = view.state.doc.line(line.number + 1);
    }
  }
  return builder.finish();
}

function createTaskScriptHighlight(appState, onOpenTaskLine) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.incomingReferenceSources = collectIncomingReferenceData(view.state.doc);
        this.taskTitleLookup = collectTaskTitleLookup(view.state.doc);
        this.decorations = buildDecorations(
          view,
          appState,
          this.incomingReferenceSources,
          this.taskTitleLookup,
          onOpenTaskLine
        );
      }
      update(update) {
        if (update.docChanged) {
          this.incomingReferenceSources = collectIncomingReferenceData(update.state.doc);
          this.taskTitleLookup = collectTaskTitleLookup(update.state.doc);
        }
        if (update.docChanged || update.viewportChanged || update.reconfigured) {
          this.decorations = buildDecorations(
            update.view,
            appState,
            this.incomingReferenceSources,
            this.taskTitleLookup,
            onOpenTaskLine
          );
        }
      }
    },
    {
      decorations: (value) => value.decorations,
    }
  );
}

function addSelectedWhitespaceDecorations(doc, builder, start, end) {
  let pos = start;
  while (pos < end) {
    const line = doc.lineAt(pos);
    const lineEnd = Math.min(line.to, end);
    const text = doc.sliceString(pos, lineEnd);
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      if (char === " ") {
        builder.add(pos + i, pos + i + 1, selectedSpaceDecoration);
      } else if (char === "\t") {
        builder.add(pos + i, pos + i + 1, selectedTabDecoration);
      }
    }
    pos = lineEnd + 1;
  }
}

function buildSelectedWhitespaceDecorations(view) {
  const builder = new RangeSetBuilder();
  const selectionRanges = view.state.selection.ranges.filter((range) => !range.empty);
  if (!selectionRanges.length) {
    return builder.finish();
  }
  for (const visible of view.visibleRanges) {
    for (const range of selectionRanges) {
      const start = Math.max(visible.from, range.from);
      const end = Math.min(visible.to, range.to);
      if (start >= end) {
        continue;
      }
      addSelectedWhitespaceDecorations(view.state.doc, builder, start, end);
    }
  }
  return builder.finish();
}

const selectedWhitespaceHighlighter = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildSelectedWhitespaceDecorations(view);
    }
    update(update) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildSelectedWhitespaceDecorations(update.view);
      }
    }
  },
  {
    decorations: (value) => value.decorations,
  }
);

function themeExtension(isDark) {
  return EditorView.theme({}, { dark: isDark });
}

function findFirstTaskLineNumber(doc) {
  for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
    if (/^\s*%/.test(doc.line(lineNumber).text)) {
      return lineNumber;
    }
  }
  return doc.lines + 1;
}

function currentHeaderSectionForLine(doc, lineNumber, firstTaskLineNumber) {
  const maxLine = Math.min(lineNumber, firstTaskLineNumber - 1);
  let section = "";
  for (let current = 1; current <= maxLine; current += 1) {
    const text = doc.line(current).text;
    const trimmed = text.trim();
    if (!trimmed) {
      continue;
    }
    const indent = text.match(/^\s*/)?.[0].length || 0;
    if (indent === 4 && trimmed.endsWith(":")) {
      const key = trimmed.slice(0, -1).trim().toLowerCase();
      section = key === "states" || key === "people" || key === "tags" ? key : "";
    }
  }
  return section;
}

function sortedSlugValues(values) {
  return Array.from(values).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  );
}

function collectConfigSlugValues(section, state) {
  const values = new Set();
  const prefixBySection = {
    tags: "#",
    people: "@",
    states: "!",
  };
  const prefix = prefixBySection[section] || "";
  const tokenSources = {
    tags: state?.tags,
    people: state?.people,
    states: state?.states,
  };
  const tokenSet = tokenSources[section];
  if (tokenSet && typeof tokenSet.forEach === "function") {
    tokenSet.forEach((tokenValue) => {
      if (typeof tokenValue !== "string") {
        return;
      }
      const normalized = prefix && tokenValue.startsWith(prefix)
        ? tokenValue.slice(1)
        : tokenValue;
      const slug = normalized.trim();
      if (slug) {
        values.add(slug);
      }
    });
  }
  const configEntries = state?.config?.[section];
  if (Array.isArray(configEntries)) {
    configEntries.forEach((entry) => {
      const key = typeof entry?.key === "string" ? entry.key.trim() : "";
      if (key) {
        values.add(key);
      }
    });
  }
  return sortedSlugValues(values);
}

function buildTokenCompletions(context, state) {
  const before = context.matchBefore(/(?:^|\s)([#@!{])([^\s}]*)$/);
  if (!before) {
    return null;
  }
  if (before.from === before.to && !context.explicit) {
    return null;
  }
  const triggerMatch = before.text.match(/[#@!{]/);
  if (!triggerMatch) {
    return null;
  }
  const trigger = triggerMatch[0];
  const triggerIndex = before.text.lastIndexOf(trigger);
  const partial = before.text.slice(triggerIndex + 1);
  const from = before.from + triggerIndex + (trigger === "{" ? 1 : 0);
  let options = [];
  if (trigger === "#") {
    options = Array.from(state.tags).map((value) => ({ label: value, type: "tag" }));
  } else if (trigger === "@") {
    options = Array.from(state.people).map((value) => ({ label: value, type: "person" }));
  } else if (trigger === "!") {
    options = Array.from(state.states).map((value) => ({ label: value, type: "state" }));
  } else {
    options = state.allTasks.map((task) => ({
      label: task.name,
      type: "reference",
      apply: `${task.name}}`,
    }));
  }
  const lowerPartial = partial.toLowerCase();
  const filtered = options.filter((option) => option.label.toLowerCase().includes(lowerPartial));
  if (!filtered.length) {
    return null;
  }
  return {
    from,
    to: before.to,
    options: filtered,
    validFor: /[^\s}]*/,
  };
}

function buildHeaderConfigCompletions(context, state) {
  const doc = context.state.doc;
  const line = doc.lineAt(context.pos);
  const firstTaskLineNumber = findFirstTaskLineNumber(doc);
  if (line.number >= firstTaskLineNumber) {
    return null;
  }
  const linePrefix = line.text.slice(0, context.pos - line.from);

  const sectionMatch = linePrefix.match(/^(\s{4})([A-Za-z-]*)$/);
  if (sectionMatch) {
    const partial = sectionMatch[2] || "";
    if (!context.explicit && !partial) {
      return null;
    }
    const options = [
      { label: "states:", type: "state" },
      { label: "people:", type: "person" },
      { label: "tags:", type: "tag" },
    ].filter((option) => option.label.toLowerCase().includes(partial.toLowerCase()));
    if (!options.length) {
      return null;
    }
    return {
      from: line.from + sectionMatch[1].length,
      to: context.pos,
      options,
      validFor: /[A-Za-z-]*/,
    };
  }

  const currentSection = currentHeaderSectionForLine(doc, line.number, firstTaskLineNumber);
  const entryMatch = linePrefix.match(/^(\s{8})([A-Za-z0-9_-]*)$/);
  if (entryMatch && currentSection) {
    const partial = entryMatch[2] || "";
    if (!context.explicit && !partial) {
      return null;
    }
    const entryTypeBySection = {
      tags: "tag",
      people: "person",
      states: "state",
    };
    const optionType = entryTypeBySection[currentSection] || "text";
    const options = collectConfigSlugValues(currentSection, state)
      .filter((slug) => slug.toLowerCase().includes(partial.toLowerCase()))
      .map((slug) => ({
        label: slug,
        type: optionType,
        apply: `${slug}:`,
      }));
    if (!options.length) {
      return null;
    }
    return {
      from: line.from + entryMatch[1].length,
      to: context.pos,
      options,
      validFor: /[A-Za-z0-9_-]*/,
    };
  }

  const propertyMatch = linePrefix.match(/^(\s{12})([A-Za-z]*)$/);
  if (propertyMatch && currentSection) {
    const partial = propertyMatch[2] || "";
    if (!context.explicit && !partial) {
      return null;
    }
    const options = [
      { label: "name:", type: "property", apply: "name: " },
      { label: "color:", type: "property", apply: "color: " },
    ].filter((option) => option.label.toLowerCase().includes(partial.toLowerCase()));
    if (!options.length) {
      return null;
    }
    return {
      from: line.from + propertyMatch[1].length,
      to: context.pos,
      options,
      validFor: /[A-Za-z]*/,
    };
  }

  return null;
}

function taskScriptCompletionSource(state) {
  return (context) => {
    const tokenCompletions = buildTokenCompletions(context, state);
    if (tokenCompletions) {
      return tokenCompletions;
    }
    return buildHeaderConfigCompletions(context, state);
  };
}

function listMarkerRange(text) {
  if (typeof text !== "string" || !text.length) {
    return null;
  }
  const match = text.match(/^(\s*)(?:\[[ xX]\]|[-*]|\d+\.)(?:\s+|$)/);
  if (!match) {
    return null;
  }
  return {
    indentLength: match[1].length,
  };
}

function parseOrderedListLine(text) {
  if (typeof text !== "string" || !text.length) {
    return null;
  }
  const match = text.match(/^(\s*)(\d+)\.(\s*)(.*)$/);
  if (!match) {
    return null;
  }
  if (!match[3] && match[4]) {
    return null;
  }
  return {
    indentLength: match[1].length,
    number: Number.parseInt(match[2], 10),
    numberText: match[2],
  };
}

function getTaskContextForLine(doc, lineNumber) {
  const safeLine = Math.max(1, Math.min(lineNumber, doc.lines));
  for (let current = safeLine; current >= 1; current -= 1) {
    const text = doc.line(current).text;
    const taskMatch = text.match(/^(\s*)%\s+/);
    if (taskMatch) {
      return {
        taskLineNumber: current,
        taskIndent: taskMatch[1].length,
      };
    }
  }
  return {
    taskLineNumber: 0,
    taskIndent: 0,
  };
}

function listLevelFromIndent(indentLength, taskIndent) {
  const relativeIndent = Math.max(0, indentLength - taskIndent);
  return Math.floor(relativeIndent / 4);
}

function listLineType(text) {
  if (typeof text !== "string") {
    return "other";
  }
  if (text.trim() === "") {
    return "blank";
  }
  if (parseOrderedListLine(text)) {
    return "ordered";
  }
  if (/^\s*\[[ xX]\](?:\s+|$)/.test(text)) {
    return "checkbox";
  }
  if (/^\s*[-*](?:\s+|$)/.test(text)) {
    return "unordered";
  }
  return "other";
}

function isListBlockLine(text) {
  const type = listLineType(text);
  return type !== "other";
}

function findTaskBodyEndLine(doc, taskLineNumber) {
  if (!Number.isFinite(taskLineNumber) || taskLineNumber <= 0) {
    return doc.lines;
  }
  for (let current = taskLineNumber + 1; current <= doc.lines; current += 1) {
    if (/^\s*%/.test(doc.line(current).text)) {
      return current - 1;
    }
  }
  return doc.lines;
}

function findOrderedListBlock(doc, lineNumber) {
  const safeLine = Math.max(1, Math.min(lineNumber, doc.lines));
  const context = getTaskContextForLine(doc, safeLine);
  const taskStart = context.taskLineNumber > 0 ? context.taskLineNumber + 1 : 1;
  const taskEnd = findTaskBodyEndLine(doc, context.taskLineNumber);
  if (taskEnd < taskStart) {
    return null;
  }
  const startLine = Math.max(taskStart, Math.min(safeLine, taskEnd));
  let from = startLine;
  let to = startLine;
  while (from > taskStart && isListBlockLine(doc.line(from - 1).text)) {
    from -= 1;
  }
  while (to < taskEnd && isListBlockLine(doc.line(to + 1).text)) {
    to += 1;
  }
  return {
    fromLine: from,
    toLine: to,
    taskIndent: context.taskIndent,
  };
}

function buildOrderedRenumberChanges(doc, block) {
  if (!block) {
    return [];
  }
  const counters = [];
  const changes = [];
  for (let lineNumber = block.fromLine; lineNumber <= block.toLine; lineNumber += 1) {
    const line = doc.line(lineNumber);
    const ordered = parseOrderedListLine(line.text);
    if (!ordered) {
      continue;
    }
    const level = listLevelFromIndent(ordered.indentLength, block.taskIndent);
    counters.length = level + 1;
    const nextNumber = (counters[level] || 0) + 1;
    counters[level] = nextNumber;
    const nextNumberText = String(nextNumber);
    if (nextNumberText === ordered.numberText) {
      continue;
    }
    const from = line.from + ordered.indentLength;
    const to = from + ordered.numberText.length;
    changes.push({ from, to, insert: nextNumberText });
  }
  return changes;
}

function renumberOrderedListBlock(view, lineNumber) {
  const block = findOrderedListBlock(view.state.doc, lineNumber);
  const changes = buildOrderedRenumberChanges(view.state.doc, block);
  if (!changes.length) {
    return false;
  }
  view.dispatch({ changes });
  return true;
}

function insertTabAtCursor(view) {
  const range = view.state.selection.main;
  if (!range.empty) {
    return false;
  }
  const doc = view.state.doc;
  const line = doc.lineAt(range.from);
  const listMarker = listMarkerRange(line.text);
  if (listMarker) {
    view.dispatch({
      changes: { from: line.from, to: line.from, insert: "    " },
      selection: {
        anchor: range.from + 4,
        head: range.to + 4,
      },
    });
    renumberOrderedListBlock(view, line.number);
    return true;
  }
  const column = range.from - line.from;
  const remainder = column % 4;
  const spaces = remainder === 0 ? 4 : 4 - remainder;
  const insert = " ".repeat(spaces);
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: { anchor: range.from + insert.length },
  });
  return true;
}

function outdentAtCursor(view) {
  const range = view.state.selection.main;
  if (!range.empty) {
    return false;
  }
  const doc = view.state.doc;
  const line = doc.lineAt(range.from);
  const listMarker = listMarkerRange(line.text);
  if (listMarker) {
    const { taskIndent } = getTaskContextForLine(doc, line.number);
    if (listMarker.indentLength <= taskIndent) {
      return true;
    }
    const remove = Math.min(4, listMarker.indentLength - taskIndent);
    const nextAnchor = Math.max(line.from, range.from - remove);
    view.dispatch({
      changes: { from: line.from, to: line.from + remove, insert: "" },
      selection: {
        anchor: nextAnchor,
        head: nextAnchor,
      },
    });
    renumberOrderedListBlock(view, line.number);
    return true;
  }
  const column = range.from - line.from;
  if (column === 0) {
    return true;
  }
  const remainder = column % 4;
  const spaces = remainder === 0 ? 4 : remainder;
  const start = Math.max(line.from, range.from - spaces);
  const current = view.state.doc.sliceString(start, range.from);
  if (!/^\s+$/.test(current)) {
    return true;
  }
  view.dispatch({
    changes: { from: start, to: range.from, insert: "" },
    selection: { anchor: start },
  });
  return true;
}

function handleEnter(view) {
  const range = view.state.selection.main;
  const line = view.state.doc.lineAt(range.from);
  const lineStart = line.from;
  const fullLine = line.text;
  const indent = fullLine.match(/^\s*/)?.[0] || "";
  const checkboxMatch = fullLine.match(/^(\s*)\[([ xX])\](?:\s+|$)/);
  const listMatch = fullLine.match(/^(\s*)([*-])(?:\s+|$)/);
  const orderedList = parseOrderedListLine(fullLine);

  if (checkboxMatch) {
    const checkboxOnly = fullLine.trim() === `[${checkboxMatch[2]}]`;
    if (checkboxOnly) {
      view.dispatch({
        changes: { from: lineStart, to: line.to, insert: indent },
        selection: { anchor: lineStart + indent.length },
      });
      return true;
    }
  }

  if (listMatch) {
    const listOnly = fullLine.trim() === listMatch[2];
    if (listOnly) {
      view.dispatch({
        changes: { from: lineStart, to: line.to, insert: indent },
        selection: { anchor: lineStart + indent.length },
      });
      return true;
    }
  }

  if (orderedList) {
    const markerOnly = fullLine.trim() === `${orderedList.number}.`;
    if (markerOnly) {
      view.dispatch({
        changes: { from: lineStart, to: line.to, insert: indent },
        selection: { anchor: lineStart + indent.length },
      });
      renumberOrderedListBlock(view, line.number);
      return true;
    }
  }

  let insert = `\n${indent}`;
  if (checkboxMatch) {
    insert = `\n${indent}[ ] `;
  } else if (listMatch) {
    insert = `\n${indent}${listMatch[2]} `;
  } else if (orderedList) {
    insert = `\n${indent}1. `;
  }

  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: { anchor: range.from + insert.length },
  });
  if (orderedList) {
    renumberOrderedListBlock(view, line.number + 1);
  }
  return true;
}

function checkboxTokenAtPosition(doc, pos) {
  if (!doc || typeof pos !== "number" || pos < 0) {
    return null;
  }
  const safePos = Math.max(0, Math.min(pos, doc.length));
  const line = doc.lineAt(safePos);
  const text = line.text;
  if (!text) {
    return null;
  }
  const checkboxMatch = text.match(/^(\s*)\[([ xX])\](?=\s|$)/);
  if (!checkboxMatch) {
    return null;
  }
  const tokenStart = checkboxMatch[1].length;
  const tokenEnd = tokenStart + 3;
  const relativePos = safePos - line.from;
  if (relativePos < tokenStart || relativePos >= tokenEnd) {
    return null;
  }
  const nextValue = checkboxMatch[2].toLowerCase() === "x" ? " " : "x";
  return {
    from: line.from + tokenStart,
    to: line.from + tokenEnd,
    insert: `[${nextValue}]`,
    cursor: line.from + tokenStart + 1,
  };
}

function taskTitleAtPosition(doc, pos) {
  if (!doc || typeof pos !== "number" || pos < 0) {
    return null;
  }
  const safePos = Math.max(0, Math.min(pos, doc.length));
  const line = doc.lineAt(safePos);
  const text = line.text;
  if (!text) {
    return null;
  }
  const relativePos = safePos - line.from;
  let cursor = 0;
  while (cursor < text.length && /\s/.test(text[cursor])) {
    cursor += 1;
  }
  if (text[cursor] !== "%") {
    return null;
  }
  cursor += 1;
  while (cursor < text.length && /\s/.test(text[cursor])) {
    cursor += 1;
  }
  const jiraMatch = text.slice(cursor).match(/^\[JIRA:[A-Z][A-Z0-9]+-\d+\]/);
  if (jiraMatch) {
    cursor += jiraMatch[0].length;
    while (cursor < text.length && /\s/.test(text[cursor])) {
      cursor += 1;
    }
  }
  const titleStart = cursor;
  let titleEnd = text.length;
  while (titleEnd > titleStart && /\s/.test(text[titleEnd - 1])) {
    titleEnd -= 1;
  }
  if (titleEnd <= titleStart) {
    return null;
  }
  if (relativePos < titleStart || relativePos >= titleEnd) {
    return null;
  }
  return {
    lineIndex: line.number - 1,
    from: line.from + titleStart,
    to: line.from + titleEnd,
    title: text.slice(titleStart, titleEnd),
  };
}

function referenceTokenAtPosition(doc, pos) {
  if (!doc || typeof pos !== "number" || pos < 0) {
    return null;
  }
  const safePos = Math.max(0, Math.min(pos, doc.length));
  const line = doc.lineAt(safePos);
  const text = line.text;
  if (!text) {
    return null;
  }
  const relativePos = safePos - line.from;
  let match;
  const referenceRegex = /\{([^}]+)\}/g;
  while ((match = referenceRegex.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (relativePos < start || relativePos >= end) {
      continue;
    }
    const name = match[1].trim();
    if (!name) {
      return null;
    }
    return {
      from: line.from + start,
      to: line.from + end,
      name,
    };
  }
  return null;
}

function findTaskLineByTitle(doc, title) {
  if (!doc || typeof title !== "string") {
    return null;
  }
  const query = title.trim();
  if (!query) {
    return null;
  }
  const normalizedQuery = query.toLowerCase();
  let fuzzyMatch = null;
  for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
    const text = doc.line(lineNumber).text;
    if (!/^\s*%\s+/.test(text)) {
      continue;
    }
    const parsedTitle = parseTaskTitleFromLine(text);
    if (!parsedTitle) {
      continue;
    }
    if (parsedTitle === query) {
      return lineNumber - 1;
    }
    if (fuzzyMatch === null && parsedTitle.toLowerCase() === normalizedQuery) {
      fuzzyMatch = lineNumber - 1;
    }
  }
  return fuzzyMatch;
}

function findConfigLineForToken(doc, token) {
  if (!doc || !token || typeof token.type !== "string") {
    return null;
  }
  const sectionByType = {
    tag: "tags",
    person: "people",
    state: "states",
  };
  const targetSection = sectionByType[token.type];
  if (!targetSection) {
    return null;
  }
  const slug = typeof token.slug === "string" ? token.slug.trim() : "";
  const slugLower = slug.toLowerCase();
  let currentSection = "";
  let sectionHeaderLine = null;
  let fuzzyMatch = null;
  for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
    const text = doc.line(lineNumber).text;
    if (/^\s*%/.test(text)) {
      break;
    }
    if (!text.trim()) {
      continue;
    }
    const indent = text.match(/^\s*/)?.[0].length || 0;
    const trimmed = text.trim();
    if (indent === 4 && trimmed.endsWith(":")) {
      currentSection = trimmed.slice(0, -1).trim().toLowerCase();
      if (currentSection === targetSection) {
        sectionHeaderLine = lineNumber - 1;
      }
      continue;
    }
    if (currentSection !== targetSection || indent !== 8) {
      continue;
    }
    const entryMatch = trimmed.match(/^([A-Za-z0-9_-]+)\s*(?::|$)/);
    const entryKey = entryMatch?.[1] || "";
    if (!entryKey) {
      continue;
    }
    if (entryKey === slug) {
      return lineNumber - 1;
    }
    if (fuzzyMatch === null && entryKey.toLowerCase() === slugLower) {
      fuzzyMatch = lineNumber - 1;
    }
  }
  if (fuzzyMatch !== null) {
    return fuzzyMatch;
  }
  return sectionHeaderLine;
}

function slugTokenAtPosition(doc, pos) {
  if (!doc || typeof pos !== "number" || pos < 0) {
    return null;
  }
  const safePos = Math.max(0, Math.min(pos, doc.length));
  const line = doc.lineAt(safePos);
  const text = line.text;
  if (!text) {
    return null;
  }
  const relativePos = safePos - line.from;
  const probePos = Math.min(Math.max(relativePos, 0), Math.max(0, text.length - 1));
  const tokenRegex = /(^|\s)([#@!])([A-Za-z0-9_-]+)/g;
  let match;
  while ((match = tokenRegex.exec(text)) !== null) {
    const prefixOffset = match.index + match[1].length;
    const tokenStart = line.from + prefixOffset;
    const slugStart = tokenStart + 1;
    const tokenEnd = slugStart + match[3].length;
    if (line.from + probePos < slugStart || line.from + probePos >= tokenEnd) {
      continue;
    }
    const prefix = match[2];
    return {
      type: prefix === "#" ? "tag" : (prefix === "@" ? "person" : "state"),
      prefix,
      slug: match[3],
      token: `${prefix}${match[3]}`,
      from: tokenStart,
      to: tokenEnd,
    };
  }
  const lineIndent = text.match(/^\s*/)?.[0].length || 0;
  if (lineIndent !== 8) {
    return null;
  }
  let currentSection = "";
  for (let lineNumber = 1; lineNumber <= line.number; lineNumber += 1) {
    const configLine = doc.line(lineNumber).text;
    if (/^\s*%/.test(configLine)) {
      break;
    }
    const trimmed = configLine.trim();
    if (!trimmed) {
      continue;
    }
    const indent = configLine.match(/^\s*/)?.[0].length || 0;
    if (indent === 4 && trimmed.endsWith(":")) {
      currentSection = trimmed.slice(0, -1).trim().toLowerCase();
    }
  }
  let kind = null;
  let prefix = "";
  if (currentSection === "tags") {
    kind = "tag";
    prefix = "#";
  } else if (currentSection === "people") {
    kind = "person";
    prefix = "@";
  } else if (currentSection === "states") {
    kind = "state";
    prefix = "!";
  }
  if (!kind) {
    return null;
  }
  const configSlugMatch = text.match(/^\s*([A-Za-z0-9_-]+)(?=\s*:|$)/);
  const configSlug = configSlugMatch?.[1] || "";
  if (!configSlug) {
    return null;
  }
  const slugStart = text.indexOf(configSlug);
  if (slugStart < 0) {
    return null;
  }
  const slugEnd = slugStart + configSlug.length;
  if (probePos < slugStart || probePos >= slugEnd) {
    return null;
  }
  return {
    type: kind,
    prefix,
    slug: configSlug,
    token: `${prefix}${configSlug}`,
    from: line.from + slugStart,
    to: line.from + slugEnd,
  };
}

export function createEditor({
  state,
  dom,
  onSync,
  onSelectTask,
  onLocalChange,
  onSelectionChange,
  onFocusChange,
  onTaskTitleDoubleClick,
  onTokenDoubleClick,
  spellcheck = false,
  scopedSpellcheck = false,
}) {
  const textarea = dom.editor;
  const host = dom.editorHost;
  if (!textarea || !host) {
    return {
      getValue: () => "",
      setValue: () => { },
      setValueFromRemote: () => { },
      replaceRange: () => { },
      focus: () => { },
      setSelectionRange: () => { },
      getSelectionRange: () => ({ start: 0, end: 0 }),
      getScroll: () => ({ top: 0, left: 0 }),
      setScroll: () => { },
      dispatchInput: () => { },
      updateSelectedLine: () => { },
      highlightText: () => { },
      updateSuggestions: () => { },
      setSpellcheckEnabled: () => { },
      undo: () => { },
      redo: () => { },
    };
  }

  let suppressTextareaInput = false;
  let suppressTextareaUpdate = false;
  let view;
  const editorRoot = host.classList.contains("code-editor")
    ? host
    : host.closest(".code-editor");
  let modifierNavActive = false;
  const themeCompartment = new Compartment();
  const contentAttrCompartment = new Compartment();
  const initialDarkTheme = document.documentElement.dataset.theme === "dark";
  let spellcheckEnabled = Boolean(spellcheck);
  const scopedSpellcheckEnabled = Boolean(scopedSpellcheck);
  if (state && typeof state === "object") {
    state.spellcheckEnabled = spellcheckEnabled;
    state.scopedSpellcheck = scopedSpellcheckEnabled;
  }

  const contentAttributesExtension = () =>
    EditorView.contentAttributes.of({
      "aria-label": "Task script editor",
      spellcheck: spellcheckEnabled ? "true" : "false",
      "data-spellcheck-scope": scopedSpellcheckEnabled
        ? (spellcheckEnabled ? "on" : "off")
        : "off",
    });

  const completionSource = taskScriptCompletionSource(state);

  const updateListener = EditorView.updateListener.of((update) => {
    if (update.docChanged) {
      const value = update.state.doc.toString();
      if (!suppressTextareaUpdate && textarea.value !== value) {
        suppressTextareaInput = true;
        textarea.value = value;
        const handled = typeof onLocalChange === "function"
          ? onLocalChange(value) === true
          : false;
        if (!handled) {
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
        }
        suppressTextareaInput = false;
      }
      onSync();
    }
    if (update.selectionSet) {
      const previousLine = state.selectedLine;
      const line = update.state.doc.lineAt(update.state.selection.main.head).number - 1;
      state.selectedLine = line;
      if (textarea) {
        const selection = update.state.selection.main;
        textarea.setSelectionRange(selection.from, selection.to);
      }
      if (typeof onSelectionChange === "function") {
        const selection = update.state.selection.main;
        onSelectionChange(selection.from, selection.to);
      }
      const isUser = update.transactions.some(
        (transaction) =>
          transaction.isUserEvent("select") ||
          transaction.isUserEvent("input")
      );
      if (isUser && line !== null && line !== previousLine) {
        onSelectTask(line);
      }
    }
  });

  const openReferenceTaskLine = (lineIndex) => {
    if (!Number.isFinite(lineIndex) || !view) {
      return;
    }
    const lineNumber = Math.max(1, Math.min(view.state.doc.lines, lineIndex + 1));
    const line = view.state.doc.line(lineNumber);
    view.dispatch({
      selection: { anchor: line.from, head: line.from },
      scrollIntoView: true,
    });
    view.focus();
    if (typeof onSelectTask === "function") {
      onSelectTask(lineNumber - 1);
    }
  };

  const setModifierNavActive = (active) => {
    const next = Boolean(active);
    if (modifierNavActive === next) {
      return;
    }
    modifierNavActive = next;
    editorRoot?.classList.toggle("modifier-nav-active", next);
  };

  const syncModifierNavFromEvent = (event) => {
    setModifierNavActive(Boolean(event?.ctrlKey || event?.metaKey));
  };

  view = new EditorView({
    state: EditorState.create({
      doc: textarea.value,
      extensions: [
        lineNumbers(),
        foldGutter(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        indentationMarkers({
          activeThickness: 2,
          colors: {
            light: "#e1e5f2",
            dark: "#1a1f2e",
            activeLight: "#c7d2ff",
            activeDark: "#2a3145",
          },
        }),
        selectedWhitespaceHighlighter,
        themeCompartment.of(themeExtension(initialDarkTheme)),
        contentAttrCompartment.of(contentAttributesExtension()),
        history(),
        indentUnit.of("    "),
        updateListener,
        createTaskScriptHighlight(state, openReferenceTaskLine),
        taskScriptFoldService,
        autocompletion({ override: [completionSource] }),
        search({ top: true }),
        keymap.of([
          {
            key: "Tab",
            run: (viewInstance) =>
              insertTabAtCursor(viewInstance) || indentMore(viewInstance),
          },
          {
            key: "Shift-Tab",
            run: (viewInstance) =>
              outdentAtCursor(viewInstance) || indentLess(viewInstance),
          },
          { key: "Enter", run: handleEnter },
          ...foldKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...completionKeymap,
          ...searchKeymap,
        ]),
      ],
    }),
    parent: host,
  });

  if (textarea) {
    const selection = view.state.selection.main;
    textarea.setSelectionRange(selection.from, selection.to);
    textarea.scrollTop = view.scrollDOM.scrollTop;
    textarea.scrollLeft = view.scrollDOM.scrollLeft;
  }

  textarea.addEventListener("input", () => {
    if (suppressTextareaInput) {
      return;
    }
    const value = textarea.value;
    if (value === view.state.doc.toString()) {
      return;
    }
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    });
  });

  view.scrollDOM.addEventListener("scroll", () => {
    if (!textarea) {
      return;
    }
    textarea.scrollTop = view.scrollDOM.scrollTop;
    textarea.scrollLeft = view.scrollDOM.scrollLeft;
    textarea.dispatchEvent(new Event("scroll"));
  });

  view.dom.addEventListener("focus", () => {
    if (typeof onFocusChange !== "function") {
      return;
    }
    const selection = view.state.selection.main;
    onFocusChange(true, selection.from, selection.to);
  });

  view.dom.addEventListener("blur", () => {
    setModifierNavActive(false);
    if (typeof onFocusChange === "function") {
      onFocusChange(false);
    }
  });

  view.dom.addEventListener("keydown", syncModifierNavFromEvent);
  view.dom.addEventListener("keyup", syncModifierNavFromEvent);
  view.dom.addEventListener("mousemove", syncModifierNavFromEvent);
  view.dom.addEventListener("mouseleave", () => {
    setModifierNavActive(false);
  });

  view.dom.addEventListener("dblclick", (event) => {
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (typeof pos !== "number") {
      return;
    }
    const checkbox = checkboxTokenAtPosition(view.state.doc, pos);
    if (checkbox) {
      event.preventDefault();
      view.dispatch({
        changes: { from: checkbox.from, to: checkbox.to, insert: checkbox.insert },
        selection: { anchor: checkbox.cursor },
      });
      return;
    }
    const taskTitle = taskTitleAtPosition(view.state.doc, pos);
    if (taskTitle && typeof onTaskTitleDoubleClick === "function") {
      event.preventDefault();
      onTaskTitleDoubleClick(taskTitle);
      return;
    }
    if (typeof onTokenDoubleClick !== "function") {
      return;
    }
    const token = slugTokenAtPosition(view.state.doc, pos);
    if (!token) {
      return;
    }
    onTokenDoubleClick(token);
  });

  view.dom.addEventListener("click", (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.button !== 0) {
      return;
    }
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (typeof pos !== "number") {
      return;
    }
    const reference = referenceTokenAtPosition(view.state.doc, pos);
    if (reference?.name) {
      const targetLine = findTaskLineByTitle(view.state.doc, reference.name);
      if (Number.isFinite(targetLine)) {
        event.preventDefault();
        event.stopPropagation();
        openReferenceTaskLine(targetLine);
      }
      return;
    }
    const token = slugTokenAtPosition(view.state.doc, pos);
    if (!token) {
      return;
    }
    const targetLine = findConfigLineForToken(view.state.doc, token);
    if (!Number.isFinite(targetLine)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    openReferenceTaskLine(targetLine);
  });

  const updateSelectedLine = () => {
    const line = view.state.doc.lineAt(view.state.selection.main.head).number - 1;
    state.selectedLine = line;
    return line;
  };

  return {
    getValue: () => view.state.doc.toString(),
    setValue: (nextValue) => {
      if (nextValue === view.state.doc.toString()) {
        return;
      }
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: nextValue },
      });
    },
    setValueFromRemote: (nextValue) => {
      if (nextValue === view.state.doc.toString()) {
        return;
      }
      suppressTextareaUpdate = true;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: nextValue },
      });
      suppressTextareaUpdate = false;
    },
    replaceRange: (from, to, insert) => {
      view.dispatch({
        changes: { from, to, insert },
      });
    },
    focus: () => view.focus(),
    setSelectionRange: (start, end) => {
      view.dispatch({
        selection: { anchor: start, head: end },
        scrollIntoView: true,
      });
    },
    getSelectionRange: () => ({
      start: view.state.selection.main.from,
      end: view.state.selection.main.to,
    }),
    getScroll: () => ({
      top: view.scrollDOM.scrollTop,
      left: view.scrollDOM.scrollLeft,
    }),
    setScroll: ({ top, left }) => {
      if (typeof top === "number") {
        view.scrollDOM.scrollTop = top;
      }
      if (typeof left === "number") {
        view.scrollDOM.scrollLeft = left;
      }
    },
    dispatchInput: () => {
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    },
    setTheme: (theme) => {
      const isDark = theme === "dark";
      view.dispatch({
        effects: themeCompartment.reconfigure(themeExtension(isDark)),
      });
    },
    setSpellcheckEnabled: (enabled) => {
      spellcheckEnabled = Boolean(enabled);
      if (state && typeof state === "object") {
        state.spellcheckEnabled = spellcheckEnabled;
      }
      view.dispatch({
        effects: contentAttrCompartment.reconfigure(contentAttributesExtension()),
      });
    },
    updateSelectedLine,
    highlightText: () => { },
    updateSuggestions: () => { },
    undo: () => {
      undo(view);
    },
    redo: () => {
      redo(view);
    },
  };
}
