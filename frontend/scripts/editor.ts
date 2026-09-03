/**
 * Module: Editor integration, parsing support, and text interaction behaviors.
 */

import { Compartment, EditorState, RangeSetBuilder } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentLess, indentMore, redo, undo, } from "@codemirror/commands";
import { autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { search, searchKeymap } from "@codemirror/search";
import { foldEffect, foldedRanges, foldGutter, foldKeymap, foldService, indentUnit } from "@codemirror/language";
import { indentationMarkers } from "@replit/codemirror-indentation-markers";
// Stores the taskLineDecoration module constant.
const taskLineDecoration = Decoration.line({ class: "cm-task-line" });
// Stores the subtaskLineDecoration module constant.
const subtaskLineDecoration = Decoration.line({ class: "cm-subtask-line" });
// Stores the configLineDecoration module constant.
const configLineDecoration = Decoration.line({ class: "cm-config-line" });
// Stores the errorLineDecoration module constant.
const errorLineDecoration = Decoration.line({ class: "cm-error-line" });
// Stores the noSpellAttributes module constant.
const noSpellAttributes = { spellcheck: "false" };
// Stores the tagDecoration module constant.
const tagDecoration = Decoration.mark({ class: "cm-tag-token", attributes: noSpellAttributes });
// Stores the personDecoration module constant.
const personDecoration = Decoration.mark({ class: "cm-person-token", attributes: noSpellAttributes });
// Stores the stateDecoration module constant.
const stateDecoration = Decoration.mark({ class: "cm-state-token", attributes: noSpellAttributes });
// Stores the invalidStateDecoration module constant.
const invalidStateDecoration = Decoration.mark({
    class: "cm-state-token cm-error-token",
    attributes: noSpellAttributes,
});
// Stores the referenceDecoration module constant.
const referenceDecoration = Decoration.mark({ class: "cm-reference-token", attributes: noSpellAttributes });
// Stores the invalidReferenceDecoration module constant.
const invalidReferenceDecoration = Decoration.mark({
    class: "cm-reference-token cm-reference-token-invalid",
    attributes: noSpellAttributes,
});
// Stores the jiraDecoration module constant.
const jiraDecoration = Decoration.mark({ class: "cm-jira-token", attributes: noSpellAttributes });
// Stores the selectedSpaceDecoration module constant.
const selectedSpaceDecoration = Decoration.mark({ class: "cm-highlightSpace" });
// Stores the selectedTabDecoration module constant.
const selectedTabDecoration = Decoration.mark({ class: "cm-highlightTab" });
// Stores the spellcheckDisabledDecoration module constant.
const spellcheckDisabledDecoration = Decoration.mark({ attributes: noSpellAttributes });
// Stores the spellcheckEnabledDecoration module constant.
const spellcheckEnabledDecoration = Decoration.mark({ class: "cm-spellcheck-enabled", attributes: { spellcheck: "true" } });
// Defines the SlugSection type structure for this module.
type SlugSection = "tags" | "people" | "states";
// Defines the VisibleRect type structure for this module.
type VisibleRect = { x: number; y: number; width: number; height: number };
// Defines the TaskReferenceBadgeItem type structure for this module.
type TaskReferenceBadgeItem = {
    lineIndex: number;
    name: string;
};
// Defines the TaskReferenceBadgeWidget class used by this module.
class TaskReferenceBadgeWidget extends WidgetType {
    referenceTasks: TaskReferenceBadgeItem[];
    count: number;
    signature: string;
    /**
     * Handles the onOpenTaskLine function logic.
     * Input: (lineIndex: number) => void.
     * Output: result produced by this function.
     */
    onOpenTaskLine: ((lineIndex: number) => void) | null | undefined;
    constructor(referenceTasks: any, onOpenTaskLine: ((lineIndex: number) => void) | null | undefined) {
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
    /**
     * Handles the eq function logic.
     * Input: other: any.
     * Output: result produced by this function.
     */
    eq(other: any) {
        return other.signature === this.signature;
    }
    /**
     * Handles the toDOM function logic.
     * Input: none.
     * Output: result produced by this function.
     */
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
            const related = event.relatedTarget;
            if (!(related instanceof Node) || !menu.contains(related)) {
                dropdown.classList.add("hidden");
            }
        });
        menu.append(indicator, dropdown);
        return menu;
    }
    /**
     * Handles the ignoreEvent function logic.
     * Input: none.
     * Output: result produced by this function.
     */
    ignoreEvent() {
        return false;
    }
}
/**
 * Handles the taskReferenceBadgeDecoration function logic.
 * Input: referenceTasks: any, onOpenTaskLine: any.
 * Output: result produced by this function.
 */
function taskReferenceBadgeDecoration(referenceTasks: any, onOpenTaskLine: any) {
    if (!Array.isArray(referenceTasks) || !referenceTasks.length) {
        return null;
    }
    return Decoration.widget({
        widget: new TaskReferenceBadgeWidget(referenceTasks, onOpenTaskLine),
        side: 1,
    });
}
/**
 * Handles the getIndent function logic.
 * Input: text: string.
 * Output: result produced by this function.
 */
function getIndent(text: string) {
    return text.match(/^\s*/)?.[0].length || 0;
}
/**
 * Handles the foldTaskBlock function logic.
 * Input: state: any, line: any.
 * Output: result produced by this function.
 */
function foldTaskBlock(state: any, line: any) {
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
/**
 * Handles the foldConfigBlock function logic.
 * Input: state: any, line: any.
 * Output: result produced by this function.
 */
function foldConfigBlock(state: any, line: any) {
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
/**
 * Handles the isHeaderConfigHeading function logic.
 * Input: state: any, line: any.
 * Output: boolean.
 */
function isHeaderConfigHeading(state: any, line: any): boolean {
    const text = line?.text || "";
    const trimmed = text.trim();
    if (!trimmed || !trimmed.endsWith(":") || /^\s*%/.test(text)) {
        return false;
    }
    return line.number < findFirstTaskLineNumber(state.doc);
}
/**
 * Handles the lineHasNestedConfigSection function logic.
 * Input: state: any, line: any, firstTaskLineNumber: number.
 * Output: boolean.
 */
function lineHasNestedConfigSection(state: any, line: any, firstTaskLineNumber: number): boolean {
    const baseIndent = getIndent(line.text);
    for (let i = line.number + 1; i < firstTaskLineNumber; i += 1) {
        const current = state.doc.line(i);
        const text = current.text;
        if (text.trim() === "") {
            continue;
        }
        const indent = getIndent(text);
        if (indent <= baseIndent) {
            return false;
        }
        const key = text.trim().replace(/:$/, "").toLowerCase();
        if (indent > baseIndent && (key === "states" || key === "people" || key === "tags")) {
            return true;
        }
    }
    return false;
}
/**
 * Handles the findInitialBoardConfigFoldRange function logic.
 * Input: state: any.
 * Output: fold range or null.
 */
function findInitialBoardConfigFoldRange(state: any) {
    const firstTaskLineNumber = findFirstTaskLineNumber(state.doc);
    for (let lineNumber = 1; lineNumber < firstTaskLineNumber; lineNumber += 1) {
        const line = state.doc.line(lineNumber);
        const trimmed = line.text.trim();
        if (!trimmed || getIndent(line.text) !== 0 || !trimmed.endsWith(":")) {
            continue;
        }
        if (!lineHasNestedConfigSection(state, line, firstTaskLineNumber)) {
            continue;
        }
        return foldConfigBlock(state, line);
    }
    return null;
}
/**
 * Handles the foldInitialBoardConfig function logic.
 * Input: view: any.
 * Output: void.
 */
function foldInitialBoardConfig(view: any): void {
    const range = findInitialBoardConfigFoldRange(view.state);
    if (!range || range.to <= range.from) {
        return;
    }
    let alreadyFolded = false;
    foldedRanges(view.state).between(range.from, range.to, (from: number, to: number) => {
        if (from === range.from && to === range.to) {
            alreadyFolded = true;
        }
    });
    if (!alreadyFolded) {
        view.dispatch({ effects: foldEffect.of(range) });
    }
}
const taskScriptFoldService = foldService.of((state, lineStart) => {
    const line = state.doc.lineAt(lineStart);
    const text = line.text;
    if (/^\s*%/.test(text)) {
        return foldTaskBlock(state, line);
    }
    if (/^\s*[a-zA-Z][\w-]*:\s*$/.test(text) || isHeaderConfigHeading(state, line)) {
        return foldConfigBlock(state, line);
    }
    return null;
});
/**
 * Handles the parseTaskTitleFromLine function logic.
 * Input: text: any.
 * Output: result produced by this function.
 */
function parseTaskTitleFromLine(text: any) {
    if (typeof text !== "string") {
        return "";
    }
    const taskMatch = text.match(/^\s*%\.?\s+(.*)$/);
    if (!taskMatch) {
        return "";
    }
    return (taskMatch[1] ?? "")
        .replace(/\s*\[[A-Z][A-Z0-9]+(?:-\d+)?\]\s*/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim();
}
/**
 * Handles the taskTitleRangeFromLine function logic.
 * Input: line: any.
 * Output: result produced by this function.
 */
function taskTitleRangeFromLine(line: any) {
    if (!line || typeof line.text !== "string") {
        return null;
    }
    const text = line.text;
    const taskMatch = text.match(/^(\s*)%\.?\s+/);
    if (!taskMatch) {
        return null;
    }
    const prefixLength = taskMatch[0].length;
    let titleStart = prefixLength;
    const jiraMatch = text.slice(titleStart).match(/^\[[A-Z][A-Z0-9]+(?:-\d+)?\]\s*/);
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
/**
 * Handles the collectIncomingReferenceData function logic.
 * Input: doc: any.
 * Output: result produced by this function.
 */
function collectIncomingReferenceData(doc: any) {
    const tasks = [];
    let currentTask = null;
    for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
        const text = doc.line(lineNumber).text;
        if (/^\s*%\.?\s+/.test(text)) {
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
            const key = (match[1] ?? "").trim();
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
            if (current.some((item: any) => item.lineIndex === task.lineIndex)) {
                return;
            }
            current.push({ lineIndex: task.lineIndex, name: task.title });
            incomingReferenceSources.set(referenceName, current);
        });
    });
    incomingReferenceSources.forEach((items) => {
        items.sort((a: any, b: any) => a.lineIndex - b.lineIndex);
    });
    return incomingReferenceSources;
}
/**
 * Handles the collectTaskTitleLookup function logic.
 * Input: doc: any.
 * Output: result produced by this function.
 */
function collectTaskTitleLookup(doc: any) {
    const exact = new Set();
    const lowercase = new Set();
    for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
        const text = doc.line(lineNumber).text;
        if (!/^\s*%\.?\s+/.test(text)) {
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
/**
 * Handles the collectDescriptionLineIndexes function logic.
 * Input: doc: any.
 * Output: result produced by this function.
 */
function collectDescriptionLineIndexes(doc: any) {
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
/**
 * @returns {import("@codemirror/view").DecorationSet}
 */
function buildDecorations(view: any, appState: any, incomingReferenceSources = new Map(), taskTitleLookup = { exact: new Set(), lowercase: new Set() }, onOpenTaskLine: any = null) {
    const scopedSpellcheckEnabled = Boolean(appState?.scopedSpellcheck && appState?.spellcheckEnabled);
    const descriptionLineIndexes = scopedSpellcheckEnabled
        ? collectDescriptionLineIndexes(view.state.doc)
        : new Set();
    const invalidStateTags = appState && appState.invalidStateTags instanceof Map ? appState.invalidStateTags : null;
    const builder = new RangeSetBuilder<Decoration>();
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
            const taskMatch = text.match(/^(\s*)%\.?\s+/);
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
            }
            else if (/^\s*[a-zA-Z][\w-]*:\s*$/.test(text)) {
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
            }
            else if (scopedSpellcheckEnabled && descriptionLineIndexes.has(lineIndex)) {
                const contentStart = text.search(/\S/);
                if (contentStart >= 0) {
                    ranges.push({
                        from: line.from + contentStart,
                        to: line.to,
                        decoration: spellcheckEnabledDecoration,
                    });
                }
            }
            else if (scopedSpellcheckEnabled && line.from < line.to) {
                ranges.push({
                    from: line.from,
                    to: line.to,
                    decoration: spellcheckDisabledDecoration,
                });
            }
            let match;
            const tagRegex = /(^|\s)(#[^\s#@]+)/g;
            while ((match = tagRegex.exec(text)) !== null) {
                const start = match.index + (match[1] ?? "").length;
                ranges.push({
                    from: line.from + start,
                    to: line.from + start + (match[2] ?? "").length,
                    decoration: tagDecoration,
                });
            }
            const personRegex = /(^|\s)(@[^\s#@]+)/g;
            while ((match = personRegex.exec(text)) !== null) {
                const start = match.index + (match[1] ?? "").length;
                ranges.push({
                    from: line.from + start,
                    to: line.from + start + (match[2] ?? "").length,
                    decoration: personDecoration,
                });
            }
            const stateRegex = /(^|\s)(![^\s#@]+)/g;
            while ((match = stateRegex.exec(text)) !== null) {
                const start = match.index + (match[1] ?? "").length;
                const token = match[2] ?? "";
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
            const jiraRegex = /\[[A-Z][A-Z0-9]+(?:-\d+)?\]/g;
            while ((match = jiraRegex.exec(text)) !== null) {
                ranges.push({
                    from: line.from + match.index,
                    to: line.from + match.index + match[0].length,
                    decoration: jiraDecoration,
                });
            }
            ranges.sort((a: any, b: any) => {
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
            ranges.forEach((range: any) => {
                builder.add(range.from, range.to, range.decoration);
            });
            if (line.number === view.state.doc.lines) {
                break;
            }
            line = view.state.doc.line(line.number + 1);
        }
    }
    return /** @type {import("@codemirror/view").DecorationSet} */ (builder.finish());
}
/**
 * Handles the createTaskScriptHighlight function logic.
 * Input: appState: any, onOpenTaskLine: any.
 * Output: result produced by this function.
 */
function createTaskScriptHighlight(appState: any, onOpenTaskLine: any) {
    return ViewPlugin.fromClass(class {
        incomingReferenceSources: ReturnType<typeof collectIncomingReferenceData>;
        taskTitleLookup: ReturnType<typeof collectTaskTitleLookup>;
        decorations: import("@codemirror/view").DecorationSet;
        /**
         * Handles the constructor function logic.
         * Input: view: any.
         * Output: result produced by this function.
         */
        constructor(view: any) {
            this.incomingReferenceSources = collectIncomingReferenceData(view.state.doc);
            this.taskTitleLookup = collectTaskTitleLookup(view.state.doc);
            /** @type {import("@codemirror/view").DecorationSet} */
            this.decorations = buildDecorations(view, appState, this.incomingReferenceSources, this.taskTitleLookup, onOpenTaskLine);
        }
        /**
         * Handles the update function logic.
         * Input: update: any.
         * Output: result produced by this function.
         */
        update(update: any) {
            if (update.docChanged) {
                this.incomingReferenceSources = collectIncomingReferenceData(update.state.doc);
                this.taskTitleLookup = collectTaskTitleLookup(update.state.doc);
            }
            if (update.docChanged || update.viewportChanged || update.reconfigured) {
                this.decorations = buildDecorations(update.view, appState, this.incomingReferenceSources, this.taskTitleLookup, onOpenTaskLine);
            }
        }
    }, {
        /**
         * Handles the decorations function logic.
         * Input: value.
         * Output: result produced by this function.
         */
        decorations: (value) => value.decorations,
    });
}
/**
 * Handles the addSelectedWhitespaceDecorations function logic.
 * Input: doc: any, builder: any, start: number, end: number.
 * Output: result produced by this function.
 */
function addSelectedWhitespaceDecorations(doc: any, builder: any, start: number, end: number) {
    let pos = start;
    while (pos < end) {
        const line = doc.lineAt(pos);
        const lineEnd = Math.min(line.to, end);
        const text = doc.sliceString(pos, lineEnd);
        for (let i = 0; i < text.length; i += 1) {
            const char = text[i];
            if (char === " ") {
                builder.add(pos + i, pos + i + 1, selectedSpaceDecoration);
            }
            else if (char === "\t") {
                builder.add(pos + i, pos + i + 1, selectedTabDecoration);
            }
        }
        pos = lineEnd + 1;
    }
}
/**
 * @param {EditorView} view
 * @returns {import("@codemirror/view").DecorationSet}
 */
function buildSelectedWhitespaceDecorations(view: any) {
    const builder = new RangeSetBuilder<Decoration>();
    const selectionRanges = view.state.selection.ranges.filter((range: any) => !range.empty);
    if (!selectionRanges.length) {
        return /** @type {import("@codemirror/view").DecorationSet} */ (builder.finish());
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
    return /** @type {import("@codemirror/view").DecorationSet} */ (builder.finish());
}
// Stores the selectedWhitespaceHighlighter module constant.
const selectedWhitespaceHighlighter = ViewPlugin.fromClass(class {
    decorations: import("@codemirror/view").DecorationSet;
    /**
     * Handles the constructor function logic.
     * Input: view: any.
     * Output: result produced by this function.
     */
    constructor(view: any) {
        /** @type {import("@codemirror/view").DecorationSet} */
        this.decorations = buildSelectedWhitespaceDecorations(view);
    }
    /**
     * Handles the update function logic.
     * Input: update: any.
     * Output: result produced by this function.
     */
    update(update: any) {
        if (update.docChanged || update.selectionSet || update.viewportChanged) {
            this.decorations = buildSelectedWhitespaceDecorations(update.view);
        }
    }
}, {
    /**
     * Handles the decorations function logic.
     * Input: value.
     * Output: result produced by this function.
     */
    decorations: (value) => value.decorations,
});
/**
 * Handles the themeExtension function logic.
 * Input: isDark: any.
 * Output: result produced by this function.
 */
function themeExtension(isDark: any) {
    return EditorView.theme({}, { dark: isDark });
}
/**
 * Handles the findFirstTaskLineNumber function logic.
 * Input: doc: any.
 * Output: result produced by this function.
 */
function findFirstTaskLineNumber(doc: any) {
    for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
        if (/^\s*%/.test(doc.line(lineNumber).text)) {
            return lineNumber;
        }
    }
    return doc.lines + 1;
}
/**
 * Handles the currentHeaderSectionForLine function logic.
 * Input: doc: any, lineNumber: number, firstTaskLineNumber: number.
 * Output: SlugSection | "".
 */
function currentHeaderSectionForLine(doc: any, lineNumber: number, firstTaskLineNumber: number): SlugSection | "" {
    const maxLine = Math.min(lineNumber, firstTaskLineNumber - 1);
    let section: SlugSection | "" = "";
    for (let current = 1; current <= maxLine; current += 1) {
        const text = doc.line(current).text;
        const trimmed = text.trim();
        if (!trimmed) {
            continue;
        }
        const indent = text.match(/^\s*/)?.[0].length || 0;
        if (indent === 4 && trimmed.endsWith(":")) {
            const key = trimmed.slice(0, -1).trim().toLowerCase();
            section = key === "states" || key === "people" || key === "tags" ? key as SlugSection : "";
        }
    }
    return section;
}
/**
 * Handles the sortedSlugValues function logic.
 * Input: values: Iterable<string>.
 * Output: result produced by this function.
 */
function sortedSlugValues(values: Iterable<string>) {
    return Array.from(values).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}
/**
 * Handles the collectConfigSlugValues function logic.
 * Input: section: SlugSection, state: any.
 * Output: result produced by this function.
 */
function collectConfigSlugValues(section: SlugSection, state: any) {
    const values = new Set<string>();
    const prefixBySection: Record<SlugSection, string> = {
        tags: "#",
        people: "@",
        states: "!",
    };
    const prefix = prefixBySection[section] || "";
    const tokenSources: Record<SlugSection, any> = {
        tags: state?.tags,
        people: state?.people,
        states: state?.states,
    };
    const tokenSet = tokenSources[section];
    if (tokenSet && typeof tokenSet.forEach === "function") {
        tokenSet.forEach((tokenValue: any) => {
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
        configEntries.forEach((entry: any) => {
            const key = typeof entry?.key === "string" ? entry.key.trim() : "";
            if (key) {
                values.add(key);
            }
        });
    }
    return sortedSlugValues(values);
}
/**
 * Handles the collectJiraMarkerValues function logic.
 * Input: state: any.
 * Output: string[].
 */
function collectJiraMarkerValues(state: any): string[] {
    const values = new Set<string>();
    const addValue = (value: any): void => {
        if (typeof value !== "string") {
            return;
        }
        const normalized = value.trim().toUpperCase();
        if (!/^[A-Z][A-Z0-9]+(?:-\d+)?$/.test(normalized)) {
            return;
        }
        values.add(normalized);
    };
    const addFromIterable = (source: any): void => {
        if (!source || typeof source.forEach !== "function") {
            return;
        }
        source.forEach((entry: any) => addValue(entry));
    };
    addFromIterable(state?.jiraProjectKeys);
    if (Array.isArray(state?.jiraProjects)) {
        state.jiraProjects.forEach((project: any) => addValue(project?.key));
    }
    return sortedSlugValues(values);
}
/**
 * Handles the buildTokenCompletions function logic.
 * Input: context: any, state: any.
 * Output: result produced by this function.
 */
function buildTokenCompletions(context: any, state: any) {
    const before = context.matchBefore(/(?:^|\s)([#@!{\[])([^\s\]}]*)$/);
    if (!before) {
        return null;
    }
    if (before.from === before.to && !context.explicit) {
        return null;
    }
    const triggerMatch = before.text.match(/[#@!{\[]/);
    if (!triggerMatch) {
        return null;
    }
    const trigger = triggerMatch[0];
    const triggerIndex = before.text.lastIndexOf(trigger);
    const partial = before.text.slice(triggerIndex + 1);
    const from = before.from + triggerIndex + (trigger === "{" || trigger === "[" ? 1 : 0);
    let options = [];
    if (trigger === "#") {
        options = Array.from(state.tags).map((value) => ({ label: value, type: "tag" }));
    }
    else if (trigger === "@") {
        options = Array.from(state.people).map((value) => ({ label: value, type: "person" }));
    }
    else if (trigger === "!") {
        options = Array.from(state.states).map((value) => ({ label: value, type: "state" }));
    }
    else if (trigger === "{") {
        options = state.allTasks.map((task: any) => ({
            label: task.name,
            type: "reference",
            apply: `${task.name}}`,
        }));
    }
    else {
        options = collectJiraMarkerValues(state).map((value) => ({
            label: value,
            type: "reference",
            detail: /-\d+$/.test(value) ? "Issue key" : "Project key",
            apply: `${value}]`,
        }));
    }
    const lowerPartial = partial.toLowerCase();
    const filtered = options.filter((option: any) => option.label.toLowerCase().includes(lowerPartial));
    if (!filtered.length) {
        return null;
    }
    const validFor = trigger === "[" ? /[A-Z0-9-]*/ : /[^\s}]*/;
    return {
        from,
        to: before.to,
        options: filtered,
        validFor,
    };
}
/**
 * Handles the buildHeaderConfigCompletions function logic.
 * Input: context: any, state: any.
 * Output: result produced by this function.
 */
function buildHeaderConfigCompletions(context: any, state: any) {
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
        const entryTypeBySection: Record<SlugSection, string> = {
            tags: "tag",
            people: "person",
            states: "state",
        };
        const optionType = entryTypeBySection[currentSection as SlugSection] || "text";
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
/**
 * Handles the taskScriptCompletionSource function logic.
 * Input: state: any.
 * Output: result produced by this function.
 */
function taskScriptCompletionSource(state: any) {
    return (context: any) => {
        const tokenCompletions = buildTokenCompletions(context, state);
        if (tokenCompletions) {
            return tokenCompletions;
        }
        return buildHeaderConfigCompletions(context, state);
    };
}
/**
 * Handles the listMarkerRange function logic.
 * Input: text: any.
 * Output: result produced by this function.
 */
function listMarkerRange(text: any) {
    if (typeof text !== "string" || !text.length) {
        return null;
    }
    const match = text.match(/^(\s*)(?:\[[ xX]\]|[-*]|\d+\.)(?:\s+|$)/);
    if (!match) {
        return null;
    }
    return {
        indentLength: (match[1] ?? "").length,
    };
}
/**
 * Handles the parseOrderedListLine function logic.
 * Input: text: any.
 * Output: result produced by this function.
 */
function parseOrderedListLine(text: any) {
    if (typeof text !== "string" || !text.length) {
        return null;
    }
    const match = text.match(/^(\s*)(\d+)\.(\s*)(.*)$/);
    if (!match) {
        return null;
    }
    if (!(match[3] ?? "") && (match[4] ?? "")) {
        return null;
    }
    return {
        indentLength: (match[1] ?? "").length,
        number: Number.parseInt(match[2] ?? "0", 10),
        numberText: match[2] ?? "",
    };
}
/**
 * Handles the getTaskContextForLine function logic.
 * Input: doc: any, lineNumber: number.
 * Output: result produced by this function.
 */
function getTaskContextForLine(doc: any, lineNumber: number) {
    const safeLine = Math.max(1, Math.min(lineNumber, doc.lines));
    for (let current = safeLine; current >= 1; current -= 1) {
        const text = doc.line(current).text;
        const taskMatch = text.match(/^(\s*)%\.?\s+/);
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
/**
 * Handles the listLevelFromIndent function logic.
 * Input: indentLength: number, taskIndent: number.
 * Output: result produced by this function.
 */
function listLevelFromIndent(indentLength: number, taskIndent: number) {
    const relativeIndent = Math.max(0, indentLength - taskIndent);
    return Math.floor(relativeIndent / 4);
}
/**
 * Handles the listLineType function logic.
 * Input: text: any.
 * Output: result produced by this function.
 */
function listLineType(text: any) {
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
/**
 * Handles the isListBlockLine function logic.
 * Input: text: any.
 * Output: result produced by this function.
 */
function isListBlockLine(text: any) {
    const type = listLineType(text);
    return type !== "other";
}
/**
 * Handles the findTaskBodyEndLine function logic.
 * Input: doc: any, taskLineNumber: number.
 * Output: result produced by this function.
 */
function findTaskBodyEndLine(doc: any, taskLineNumber: number) {
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
/**
 * Handles the findOrderedListBlock function logic.
 * Input: doc: any, lineNumber: number.
 * Output: result produced by this function.
 */
function findOrderedListBlock(doc: any, lineNumber: number) {
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
/**
 * Handles the buildOrderedRenumberChanges function logic.
 * Input: doc: any, block: any.
 * Output: result produced by this function.
 */
function buildOrderedRenumberChanges(doc: any, block: any) {
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
        const nextNumber: number = (counters[level] || 0) + 1;
        counters[level] = nextNumber;
        const nextNumberText = String(nextNumber);
        if (nextNumberText === ordered.numberText) {
            continue;
        }
        const from = line.from + ordered.indentLength;
        const to = from + (ordered.numberText ?? "").length;
        changes.push({ from, to, insert: nextNumberText });
    }
    return changes;
}
/**
 * Handles the renumberOrderedListBlock function logic.
 * Input: view: any, lineNumber: number.
 * Output: result produced by this function.
 */
function renumberOrderedListBlock(view: any, lineNumber: number) {
    const block = findOrderedListBlock(view.state.doc, lineNumber);
    const changes = buildOrderedRenumberChanges(view.state.doc, block);
    if (!changes.length) {
        return false;
    }
    view.dispatch({ changes });
    return true;
}
/**
 * Handles the insertTabAtCursor function logic.
 * Input: view: any.
 * Output: result produced by this function.
 */
function insertTabAtCursor(view: any) {
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
/**
 * Handles the outdentAtCursor function logic.
 * Input: view: any.
 * Output: result produced by this function.
 */
function outdentAtCursor(view: any) {
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
/**
 * Handles the handleEnter function logic.
 * Input: view: any.
 * Output: result produced by this function.
 */
function handleEnter(view: any) {
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
    }
    else if (listMatch) {
        insert = `\n${indent}${listMatch[2]} `;
    }
    else if (orderedList) {
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
/**
 * Handles the checkboxTokenAtPosition function logic.
 * Input: doc: any, pos: any.
 * Output: result produced by this function.
 */
function checkboxTokenAtPosition(doc: any, pos: any) {
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
/**
 * Handles the taskTitleAtPosition function logic.
 * Input: doc: any, pos: any.
 * Output: result produced by this function.
 */
function taskTitleAtPosition(doc: any, pos: any) {
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
    const jiraMatch = text.slice(cursor).match(/^\[[A-Z][A-Z0-9]+(?:-\d+)?\]/);
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
/**
 * Handles the referenceTokenAtPosition function logic.
 * Input: doc: any, pos: any.
 * Output: result produced by this function.
 */
function referenceTokenAtPosition(doc: any, pos: any) {
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
        const name = (match[1] ?? "").trim();
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
/**
 * Handles the findTaskLineByTitle function logic.
 * Input: doc: any, title: any.
 * Output: result produced by this function.
 */
function findTaskLineByTitle(doc: any, title: any) {
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
        if (!/^\s*%\.?\s+/.test(text)) {
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
/**
 * Handles the findConfigLineForToken function logic.
 * Input: doc: any, token: any.
 * Output: result produced by this function.
 */
function findConfigLineForToken(doc: any, token: any) {
    if (!doc || !token || typeof token.type !== "string") {
        return null;
    }
    const sectionByType: Record<string, string> = {
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
/**
 * Handles the slugTokenAtPosition function logic.
 * Input: doc: any, pos: any.
 * Output: result produced by this function.
 */
function slugTokenAtPosition(doc: any, pos: any) {
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
        const prefixOffset = match.index + (match[1] ?? "").length;
        const tokenStart = line.from + prefixOffset;
        const slugStart = tokenStart + 1;
        const tokenEnd = slugStart + (match[3] ?? "").length;
        if (line.from + probePos < slugStart || line.from + probePos >= tokenEnd) {
            continue;
        }
        const prefix = match[2] ?? "";
        return {
            type: prefix === "#" ? "tag" : (prefix === "@" ? "person" : "state"),
            prefix,
            slug: match[3] ?? "",
            token: `${prefix}${match[3] ?? ""}`,
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
    }
    else if (currentSection === "people") {
        kind = "person";
        prefix = "@";
    }
    else if (currentSection === "states") {
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
// Defines the CreateEditorOptions type structure for this module.
type CreateEditorOptions = {
    state: any;
    dom: any;
    /**
     * Handles the onSync function logic.
     * Input: none.
     * Output: result produced by this function.
     */
    onSync: () => void;
    onSelectTask?: ((task: any) => void) | null;
    onLocalChange?: ((value?: string) => boolean | void) | null;
    onSelectionChange?: ((from?: number, to?: number) => void) | null;
    onFocusChange?: ((focused?: boolean, from?: number, to?: number) => void) | null;
    onTaskTitleDoubleClick?: ((payload: any) => void) | null;
    onTokenDoubleClick?: ((token: any) => void) | null;
    spellcheck?: boolean;
    scopedSpellcheck?: boolean;
};
/**
 * Handles the createEditor function logic.
 * Input: { state, dom, onSync, onSelectTask, onLocalChange, onSelectionChange, onFocusChange, onTaskTitleDoubleClick, onTokenDoubleClick, spellcheck = false, scopedSpellcheck = false, }: CreateEditorOptions.
 * Output: result produced by this function.
 */
export function createEditor({ state, dom, onSync, onSelectTask, onLocalChange, onSelectionChange, onFocusChange, onTaskTitleDoubleClick, onTokenDoubleClick, spellcheck = false, scopedSpellcheck = false, }: CreateEditorOptions) {
    const textarea = dom.editor;
    const host = dom.editorHost;
    if (!textarea || !host) {
        return {
            /**
             * Handles the getValue function logic.
             * Input: none.
             * Output: result produced by this function.
             */
            getValue: () => "",
            /**
             * Handles the setValue function logic.
             * Input: none.
             * Output: result produced by this function.
             */
            setValue: () => { },
            /**
             * Handles the setValueFromRemote function logic.
             * Input: none.
             * Output: result produced by this function.
             */
            setValueFromRemote: () => { },
            /**
             * Handles the replaceRange function logic.
             * Input: none.
             * Output: result produced by this function.
             */
            replaceRange: () => { },
            /**
             * Handles the focus function logic.
             * Input: none.
             * Output: result produced by this function.
             */
            focus: () => { },
            /**
             * Handles the setSelectionRange function logic.
             * Input: none.
             * Output: result produced by this function.
             */
            setSelectionRange: () => { },
            /**
             * Handles the getSelectionRange function logic.
             * Input: none.
             * Output: result produced by this function.
             */
            getSelectionRange: () => ({ start: 0, end: 0 }),
            /**
             * Handles the getScroll function logic.
             * Input: none.
             * Output: result produced by this function.
             */
            getScroll: () => ({ top: 0, left: 0 }),
            /**
             * Handles the setScroll function logic.
             * Input: none.
             * Output: result produced by this function.
             */
            setScroll: () => { },
            /**
             * Handles the dispatchInput function logic.
             * Input: none.
             * Output: result produced by this function.
             */
            dispatchInput: () => { },
            /**
             * Handles the updateSelectedLine function logic.
             * Input: none.
             * Output: result produced by this function.
             */
            updateSelectedLine: () => { },
            /**
             * Handles the highlightText function logic.
             * Input: none.
             * Output: result produced by this function.
             */
            highlightText: () => { },
            /**
             * Handles the updateSuggestions function logic.
             * Input: none.
             * Output: result produced by this function.
             */
            updateSuggestions: () => { },
            /**
             * Handles the setSpellcheckEnabled function logic.
             * Input: none.
             * Output: result produced by this function.
             */
            setSpellcheckEnabled: () => { },
            /**
             * Handles the undo function logic.
             * Input: none.
             * Output: result produced by this function.
             */
            undo: () => { },
            /**
             * Handles the redo function logic.
             * Input: none.
             * Output: result produced by this function.
             */
            redo: () => { },
            getDisplaySelectionRects: (): VisibleRect[] => [],
            getDisplayCursorRects: (): VisibleRect[] => [],
            /**
             * Handles the syncOverlayMetrics function logic.
             * Input: none.
             * Output: result produced by this function.
             */
            syncOverlayMetrics: () => { },
            /**
             * Handles the setCollabExtensions function logic.
             * Input: none.
             * Output: result produced by this function.
             */
            setCollabExtensions: () => { },
            /**
             * Handles the setReadOnly function logic.
             * Input: none.
             * Output: result produced by this function.
             */
            setReadOnly: () => { },
        };
    }
    let suppressTextareaInput = false;
    let suppressTextareaUpdate = false;
    let view: any;
    const editorRoot = host.classList.contains("code-editor")
        ? host
        : host.closest(".code-editor");
    let modifierNavActive = false;
    const themeCompartment = new Compartment();
    const contentAttrCompartment = new Compartment();
    const collabCompartment = new Compartment();
    const readOnlyCompartment = new Compartment();
    const editableCompartment = new Compartment();
    const initialDarkTheme = document.documentElement.dataset["theme"] === "dark";
    let spellcheckEnabled = Boolean(spellcheck);
    const scopedSpellcheckEnabled = Boolean(scopedSpellcheck);
    if (state && typeof state === "object") {
        state.spellcheckEnabled = spellcheckEnabled;
        state.scopedSpellcheck = scopedSpellcheckEnabled;
    }
    /**
     * Handles the contentAttributesExtension function logic.
     * Input: none.
     * Output: "off", });.
     */
    const contentAttributesExtension = () => EditorView.contentAttributes.of({
        "aria-label": "Task script editor",
        spellcheck: spellcheckEnabled ? "true" : "false",
        "data-spellcheck-scope": scopedSpellcheckEnabled
            ? (spellcheckEnabled ? "on" : "off")
            : "off",
    });
    const completionSource = taskScriptCompletionSource(state);
    /**
     * Handles the syncTextareaOverlayMetrics function logic.
     * Input: none.
     * Output: result produced by this function.
     */
    const syncTextareaOverlayMetrics = () => {
        if (!textarea || !view?.scrollDOM || !view?.contentDOM) {
            return;
        }
        const wrapper = textarea.offsetParent instanceof HTMLElement
            ? textarea.offsetParent
            : textarea.parentElement;
        if (!wrapper) {
            return;
        }
        const wrapperRect = wrapper.getBoundingClientRect();
        const scrollerRect = view.scrollDOM.getBoundingClientRect();
        const contentRect = view.contentDOM.getBoundingClientRect();
        if (!wrapperRect.width || !wrapperRect.height || !scrollerRect.width || !scrollerRect.height) {
            return;
        }
        // Align the hidden textarea to the visible CodeMirror content area so y-textarea
        // remote cursor/selection overlays are positioned against the same text origin.
        const contentInsetX = (contentRect.left - scrollerRect.left) + view.scrollDOM.scrollLeft;
        const contentInsetY = (contentRect.top - scrollerRect.top) + view.scrollDOM.scrollTop;
        let linePaddingLeft = 0;
        let linePaddingRight = 0;
        const sampleLine = view.contentDOM.querySelector(".cm-line");
        if (sampleLine instanceof HTMLElement) {
            const lineStyles = getComputedStyle(sampleLine);
            linePaddingLeft = parseFloat(lineStyles.paddingLeft || "0") || 0;
            linePaddingRight = parseFloat(lineStyles.paddingRight || "0") || 0;
        }
        const left = (scrollerRect.left - wrapperRect.left) + contentInsetX + linePaddingLeft;
        const top = (scrollerRect.top - wrapperRect.top) + contentInsetY;
        const width = Math.max(1, view.scrollDOM.clientWidth - contentInsetX - linePaddingLeft - linePaddingRight);
        const height = Math.max(1, view.scrollDOM.clientHeight - contentInsetY);
        textarea.style.inset = "auto";
        textarea.style.left = `${Math.max(0, left)}px`;
        textarea.style.top = `${Math.max(0, top)}px`;
        textarea.style.right = "auto";
        textarea.style.bottom = "auto";
        textarea.style.width = `${width}px`;
        textarea.style.height = `${height}px`;
        textarea.style.padding = "0";
        const contentStyles = getComputedStyle(view.contentDOM);
        const editorStyles = getComputedStyle(view.dom);
        if (contentStyles.fontFamily) {
            textarea.style.fontFamily = contentStyles.fontFamily;
        }
        if (contentStyles.fontSize) {
            textarea.style.fontSize = contentStyles.fontSize;
        }
        if (contentStyles.lineHeight) {
            textarea.style.lineHeight = contentStyles.lineHeight;
        }
        else if (editorStyles.lineHeight) {
            textarea.style.lineHeight = editorStyles.lineHeight;
        }
        const contentTextStyles = getComputedStyle(sampleLine || view.contentDOM);
        if (contentTextStyles.letterSpacing) {
            textarea.style.letterSpacing = contentTextStyles.letterSpacing;
        }
        if (contentTextStyles.fontWeight) {
            textarea.style.fontWeight = contentTextStyles.fontWeight;
        }
        if (contentTextStyles.fontVariantLigatures) {
            textarea.style.fontVariantLigatures = contentTextStyles.fontVariantLigatures;
        }
        if (contentTextStyles.tabSize) {
            textarea.style.tabSize = contentTextStyles.tabSize;
        }
    };
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
            const isUser = update.transactions.some((transaction) => transaction.isUserEvent("select") ||
                transaction.isUserEvent("input"));
            if (isUser && line !== null && line !== previousLine) {
                if (typeof onSelectTask === "function") {
                    onSelectTask(line);
                }
            }
        }
        if (update.docChanged || update.selectionSet || update.viewportChanged || update.geometryChanged) {
            syncTextareaOverlayMetrics();
        }
    });
    const openReferenceTaskLine = (lineIndex: number): void => {
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
    const setModifierNavActive = (active: any): void => {
        const next = Boolean(active);
        if (modifierNavActive === next) {
            return;
        }
        modifierNavActive = next;
        editorRoot?.classList.toggle("modifier-nav-active", next);
    };
    const syncModifierNavFromEvent = (event: any): void => {
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
                collabCompartment.of([]),
                readOnlyCompartment.of(EditorState.readOnly.of(false)),
                editableCompartment.of(EditorView.editable.of(true)),
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
                        /**
                         * Handles the run function logic.
                         * Input: viewInstance.
                         * Output: result produced by this function.
                         */
                        run: (viewInstance) => insertTabAtCursor(viewInstance) || indentMore(viewInstance),
                    },
                    {
                        key: "Shift-Tab",
                        /**
                         * Handles the run function logic.
                         * Input: viewInstance.
                         * Output: result produced by this function.
                         */
                        run: (viewInstance) => outdentAtCursor(viewInstance) || indentLess(viewInstance),
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
        syncTextareaOverlayMetrics();
    }
    foldInitialBoardConfig(view);
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
        syncTextareaOverlayMetrics();
    });
    const resizeObserver = typeof ResizeObserver === "function"
        ? new ResizeObserver(() => {
            syncTextareaOverlayMetrics();
        })
        : null;
    resizeObserver?.observe(host);
    resizeObserver?.observe(view.scrollDOM);
    view.dom.addEventListener("focus", () => {
        if (typeof onFocusChange !== "function") {
            return;
        }
        /**
         * Handles the emitFocusedSelection function logic.
         * Input: none.
         * Output: result produced by this function.
         */
        const emitFocusedSelection = () => {
            if (!view.hasFocus) {
                return;
            }
            const selection = view.state.selection.main;
            onFocusChange(true, selection.from, selection.to);
        };
        if (typeof requestAnimationFrame === "function") {
            requestAnimationFrame(() => {
                emitFocusedSelection();
            });
        }
        else {
            queueMicrotask(() => {
                emitFocusedSelection();
            });
        }
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
    view.dom.addEventListener("dblclick", (event: any) => {
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
    view.dom.addEventListener("click", (event: any) => {
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
            if (typeof targetLine === "number" && Number.isFinite(targetLine)) {
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
        if (!(typeof targetLine === "number" && Number.isFinite(targetLine))) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        openReferenceTaskLine(targetLine);
    });
    /**
     * Handles the updateSelectedLine function logic.
     * Input: none.
     * Output: result produced by this function.
     */
    const updateSelectedLine = () => {
        const line = view.state.doc.lineAt(view.state.selection.main.head).number - 1;
        state.selectedLine = line;
        return line;
    };
    const getVisibleRects = (selector: string): VisibleRect[] => Array.from(view.dom.querySelectorAll(selector))
        .map((node: Element): VisibleRect | null => {
        const rect = node.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) {
            return null;
        }
        const styles = getComputedStyle(node);
        if (styles.display === "none" || styles.visibility === "hidden") {
            return null;
        }
        return {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
        };
    })
        .filter((item: VisibleRect | null): item is VisibleRect => Boolean(item));
    return {
        /**
         * Handles the getValue function logic.
         * Input: none.
         * Output: result produced by this function.
         */
        getValue: () => view.state.doc.toString(),
        /**
         * Handles the setValue function logic.
         * Input: nextValue: string.
         * Output: result produced by this function.
         */
        setValue: (nextValue: string) => {
            if (nextValue === view.state.doc.toString()) {
                return;
            }
            view.dispatch({
                changes: { from: 0, to: view.state.doc.length, insert: nextValue },
            });
            foldInitialBoardConfig(view);
        },
        /**
         * Handles the setValueFromRemote function logic.
         * Input: nextValue: string.
         * Output: result produced by this function.
         */
        setValueFromRemote: (nextValue: string) => {
            if (nextValue === view.state.doc.toString()) {
                return;
            }
            const currentValue = view.state.doc.toString();
            const selection = view.state.selection.main;
            const scrollTop = view.scrollDOM.scrollTop;
            const scrollLeft = view.scrollDOM.scrollLeft;
            // Preserve local caret/selection when remote edits arrive by mapping the
            // current selection through a minimal whole-document diff.
            let prefix = 0;
            const maxPrefix = Math.min(currentValue.length, nextValue.length);
            while (prefix < maxPrefix && currentValue[prefix] === nextValue[prefix]) {
                prefix += 1;
            }
            let suffix = 0;
            const maxSuffix = Math.min(currentValue.length - prefix, nextValue.length - prefix);
            while (suffix < maxSuffix &&
                currentValue[currentValue.length - 1 - suffix] ===
                    nextValue[nextValue.length - 1 - suffix]) {
                suffix += 1;
            }
            const oldReplaceStart = prefix;
            const oldReplaceEnd = currentValue.length - suffix;
            const newReplace = nextValue.slice(prefix, nextValue.length - suffix);
            const delta = nextValue.length - currentValue.length;
            /**
             * Handles the adjustOffset function logic.
             * Input: pos: number.
             * Output: result produced by this function.
             */
            const adjustOffset = (pos: number) => {
                if (pos <= oldReplaceStart) {
                    return pos;
                }
                if (pos >= oldReplaceEnd) {
                    return pos + delta;
                }
                return oldReplaceStart + newReplace.length;
            };
            const nextAnchor = Math.max(0, Math.min(nextValue.length, adjustOffset(selection.from)));
            const nextHead = Math.max(0, Math.min(nextValue.length, adjustOffset(selection.to)));
            suppressTextareaUpdate = true;
            view.dispatch({
                changes: { from: 0, to: view.state.doc.length, insert: nextValue },
                selection: { anchor: nextAnchor, head: nextHead },
            });
            suppressTextareaUpdate = false;
            view.scrollDOM.scrollTop = scrollTop;
            view.scrollDOM.scrollLeft = scrollLeft;
            if (textarea) {
                textarea.scrollTop = scrollTop;
                textarea.scrollLeft = scrollLeft;
            }
            syncTextareaOverlayMetrics();
        },
        /**
         * Handles the replaceRange function logic.
         * Input: from: number, to: number, insert: string.
         * Output: result produced by this function.
         */
        replaceRange: (from: number, to: number, insert: string) => {
            view.dispatch({
                changes: { from, to, insert },
            });
        },
        /**
         * Handles the focus function logic.
         * Input: none.
         * Output: result produced by this function.
         */
        focus: () => view.focus(),
        /**
         * Handles the setSelectionRange function logic.
         * Input: start: number, end: number.
         * Output: result produced by this function.
         */
        setSelectionRange: (start: number, end: number) => {
            view.dispatch({
                selection: { anchor: start, head: end },
                scrollIntoView: true,
            });
        },
        /**
         * Handles the getSelectionRange function logic.
         * Input: none.
         * Output: result produced by this function.
         */
        getSelectionRange: () => ({
            start: view.state.selection.main.from,
            end: view.state.selection.main.to,
        }),
        /**
         * Handles the getScroll function logic.
         * Input: none.
         * Output: result produced by this function.
         */
        getScroll: () => ({
            top: view.scrollDOM.scrollTop,
            left: view.scrollDOM.scrollLeft,
        }),
        /**
         * Handles the setScroll function logic.
         * Input: { top, left }: { top?: number; left?: number }.
         * Output: result produced by this function.
         */
        setScroll: ({ top, left }: { top?: number; left?: number }) => {
            if (typeof top === "number") {
                view.scrollDOM.scrollTop = top;
            }
            if (typeof left === "number") {
                view.scrollDOM.scrollLeft = left;
            }
        },
        /**
         * Handles the foldTaskLines function logic.
         * Input: lineIndexes: number[].
         * Output: void.
         */
        foldTaskLines: (lineIndexes: number[]) => {
            if (!Array.isArray(lineIndexes) || !lineIndexes.length) {
                return;
            }
            const effects: any[] = [];
            const seen = new Set();
            const currentFolds = foldedRanges(view.state);
            lineIndexes.forEach((lineIndex: number) => {
                if (!Number.isInteger(lineIndex) || lineIndex < 0 || seen.has(lineIndex)) {
                    return;
                }
                seen.add(lineIndex);
                if (lineIndex >= view.state.doc.lines) {
                    return;
                }
                const line = view.state.doc.line(lineIndex + 1);
                const range = foldTaskBlock(view.state, line);
                if (!range || range.to <= range.from) {
                    return;
                }
                let alreadyFolded = false;
                currentFolds.between(range.from, range.to, (from: number, to: number) => {
                    if (from === range.from && to === range.to) {
                        alreadyFolded = true;
                    }
                });
                if (alreadyFolded) {
                    return;
                }
                effects.push(foldEffect.of(range));
            });
            if (effects.length) {
                view.dispatch({ effects });
            }
        },
        /**
         * Handles the dispatchInput function logic.
         * Input: none.
         * Output: result produced by this function.
         */
        dispatchInput: () => {
            textarea.dispatchEvent(new Event("input", { bubbles: true }));
        },
        /**
         * Handles the setTheme function logic.
         * Input: theme: any.
         * Output: result produced by this function.
         */
        setTheme: (theme: any) => {
            const isDark = theme === "dark";
            view.dispatch({
                effects: themeCompartment.reconfigure(themeExtension(isDark)),
            });
        },
        /**
         * Handles the setSpellcheckEnabled function logic.
         * Input: enabled: any.
         * Output: result produced by this function.
         */
        setSpellcheckEnabled: (enabled: any) => {
            spellcheckEnabled = Boolean(enabled);
            if (state && typeof state === "object") {
                state.spellcheckEnabled = spellcheckEnabled;
            }
            view.dispatch({
                effects: contentAttrCompartment.reconfigure(contentAttributesExtension()),
            });
        },
        updateSelectedLine,
        /**
         * Handles the highlightText function logic.
         * Input: none.
         * Output: result produced by this function.
         */
        highlightText: () => { },
        /**
         * Handles the updateSuggestions function logic.
         * Input: none.
         * Output: result produced by this function.
         */
        updateSuggestions: () => { },
        /**
         * Handles the undo function logic.
         * Input: none.
         * Output: result produced by this function.
         */
        undo: () => {
            undo(view);
        },
        /**
         * Handles the redo function logic.
         * Input: none.
         * Output: result produced by this function.
         */
        redo: () => {
            redo(view);
        },
        /**
         * Handles the getDisplaySelectionRects function logic.
         * Input: none.
         * Output: result produced by this function.
         */
        getDisplaySelectionRects: () => getVisibleRects(".cm-selectionLayer .cm-selectionBackground"),
        /**
         * Handles the getDisplayCursorRects function logic.
         * Input: none.
         * Output: result produced by this function.
         */
        getDisplayCursorRects: () => getVisibleRects(".cm-cursorLayer .cm-cursor"),
        syncOverlayMetrics: syncTextareaOverlayMetrics,
        /**
         * Handles the setCollabExtensions function logic.
         * Input: extensions: any[] | any = [].
         * Output: result produced by this function.
         */
        setCollabExtensions: (extensions: any[] | any = []) => {
            const normalized = Array.isArray(extensions) ? extensions : [extensions];
            view.dispatch({
                effects: collabCompartment.reconfigure(normalized.filter(Boolean)),
            });
            syncTextareaOverlayMetrics();
        },
        /**
         * Handles the setReadOnly function logic.
         * Input: enabled: any.
         * Output: result produced by this function.
         */
        setReadOnly: (enabled: any) => {
            const readOnly = Boolean(enabled);
            view.dispatch({
                effects: [
                    readOnlyCompartment.reconfigure(EditorState.readOnly.of(readOnly)),
                    editableCompartment.reconfigure(EditorView.editable.of(!readOnly)),
                ],
            });
        },
    };
}
