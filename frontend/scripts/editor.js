import { EditorState, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
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

const taskLineDecoration = Decoration.line({ class: "cm-task-line" });
const subtaskLineDecoration = Decoration.line({ class: "cm-subtask-line" });
const configLineDecoration = Decoration.line({ class: "cm-config-line" });
const errorLineDecoration = Decoration.line({ class: "cm-error-line" });
const tagDecoration = Decoration.mark({ class: "cm-tag-token" });
const personDecoration = Decoration.mark({ class: "cm-person-token" });
const stateDecoration = Decoration.mark({ class: "cm-state-token" });
const invalidStateDecoration = Decoration.mark({ class: "cm-state-token cm-error-token" });
const referenceDecoration = Decoration.mark({ class: "cm-reference-token" });

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

function buildDecorations(view, appState) {
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
      } else if (/^\s*[a-zA-Z][\w-]*:\s*$/.test(text)) {
        ranges.push({
          from: line.from,
          to: line.from,
          decoration: configLineDecoration,
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
        ranges.push({
          from: line.from + match.index,
          to: line.from + match.index + match[0].length,
          decoration: referenceDecoration,
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

function createTaskScriptHighlight(appState) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = buildDecorations(view, appState);
      }
      update(update) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = buildDecorations(update.view, appState);
        }
      }
    },
    {
      decorations: (value) => value.decorations,
    }
  );
}

function taskScriptCompletionSource(state) {
  return (context) => {
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
  };
}

function insertTabAtCursor(view) {
  const range = view.state.selection.main;
  if (!range.empty) {
    return false;
  }
  const line = view.state.doc.lineAt(range.from);
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
  const line = view.state.doc.lineAt(range.from);
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

  if (listMatch && listMatch[2] === "-") {
    const listOnly = fullLine.trim() === listMatch[2];
    if (listOnly) {
      view.dispatch({
        changes: { from: lineStart, to: line.to, insert: indent },
        selection: { anchor: lineStart + indent.length },
      });
      return true;
    }
  }

  let insert = `\n${indent}`;
  if (checkboxMatch) {
    insert = `\n${indent}[ ] `;
  } else if (listMatch && listMatch[2] === "-") {
    insert = `\n${indent}- `;
  }

  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: { anchor: range.from + insert.length },
  });
  return true;
}

export function createEditor({
  state,
  dom,
  onSync,
  onSelectTask,
  onLocalChange,
  onSelectionChange,
  onFocusChange,
}) {
  const textarea = dom.editor;
  const host = dom.editorHost;
  if (!textarea || !host) {
    return {
      getValue: () => "",
      setValue: () => {},
      setValueFromRemote: () => {},
      replaceRange: () => {},
      focus: () => {},
      setSelectionRange: () => {},
      getSelectionRange: () => ({ start: 0, end: 0 }),
      getScroll: () => ({ top: 0, left: 0 }),
      setScroll: () => {},
      dispatchInput: () => {},
      updateSelectedLine: () => {},
      highlightText: () => {},
      updateSuggestions: () => {},
      undo: () => {},
      redo: () => {},
    };
  }

  let suppressTextareaInput = false;
  let suppressTextareaUpdate = false;
  let view;

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

  view = new EditorView({
    state: EditorState.create({
      doc: textarea.value,
      extensions: [
        lineNumbers(),
        foldGutter(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        indentUnit.of("    "),
        updateListener,
        createTaskScriptHighlight(state),
        taskScriptFoldService,
        autocompletion({ override: [completionSource] }),
        search({ top: true }),
        EditorView.contentAttributes.of({ "aria-label": "Task script editor" }),
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
    if (typeof onFocusChange === "function") {
      onFocusChange(false);
    }
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
    updateSelectedLine,
    highlightText: () => {},
    updateSuggestions: () => {},
    undo: () => {
      undo(view);
    },
    redo: () => {
      redo(view);
    },
  };
}
