import { escapeHtml } from "./task.js";

export function createEditor({ state, dom, onSync, onSelectTask }) {
  const { editor, highlightLayer, suggestions, lineNumbers } = dom;
  const triggerChars = new Set(["#", "@", "{", "!"]);

  function closeSuggestions() {
    suggestions.classList.add("hidden");
    suggestions.classList.remove("open");
    suggestions.innerHTML = "";
  }

  function highlightText(lines) {
    updateLineNumbers(lines);
    const highlighted = lines
      .map((line, index) => {
        const taskMatch = line.match(/^(\s*)%\s+(.*)$/);
        const isActive = state.selectedLine === index;
        const baseClass = isActive ? "highlight-line active" : "highlight-line";
        if (taskMatch) {
          const indent = taskMatch[1];
          const name = taskMatch[2];
          const className = indent.length >= 4 ? "highlight-subtask" : "highlight-task";
          return `<span class=\"${baseClass} ${className}\">${escapeHtml(indent)}% ${escapeHtml(name)}</span>`;
        }
        if (line.trim() !== "") {
          return `<span class=\"${baseClass} highlight-description\">${highlightInlineTokens(
            line,
            index
          )}</span>`;
        }
        return `<span class=\"${baseClass}\">&nbsp;</span>`;
      })
      .join("");
    highlightLayer.innerHTML = highlighted;
    highlightLayer.style.width = `${Math.max(editor.scrollWidth, editor.clientWidth)}px`;
    highlightLayer.style.height = `${Math.max(editor.scrollHeight, editor.clientHeight)}px`;
    highlightLayer.style.transform = `translate(${-editor.scrollLeft}px, ${-editor.scrollTop}px)`;
    if (lineNumbers) {
      lineNumbers.style.transform = `translate(${-editor.scrollLeft}px, ${-editor.scrollTop}px)`;
    }
  }

  function updateLineNumbers(lines) {
    if (!lineNumbers) {
      return;
    }
    lineNumbers.innerHTML = lines
      .map((_, index) => `<span>${index + 1}</span>`)
      .join("");
  }

  function highlightInlineTokens(line, index) {
    const escaped = escapeHtml(line);
    const invalidStates = state.invalidStateTags?.get(index) || [];
    const invalidLookup = new Set(invalidStates);
    return escaped
      .replace(/(^|\s)(#[^\s#@]+)/g, "$1<span class=\"highlight-tags\">$2</span>")
      .replace(/(^|\s)(@[^\s#@]+)/g, "$1<span class=\"highlight-people\">$2</span>")
      .replace(/(^|\s)(![^\s#@]+)/g, (match, prefix, token) => {
        if (invalidLookup.has(token)) {
          return `${prefix}<span class="highlight-invalid-state">${token}</span>`;
        }
        return `${prefix}<span class="highlight-state">${token}</span>`;
      });
  }

  function updateSuggestions({ forceOpen = false } = {}) {
    const cursor = editor.selectionStart;
    const before = editor.value.slice(0, cursor);
    const triggerMatch = before.match(/(^|\s)([#@{!])([^\s}]*)$/);
    if (!triggerMatch || (!forceOpen && !suggestions.classList.contains("open"))) {
      closeSuggestions();
      return;
    }
    const trigger = triggerMatch[2];
    const partial = triggerMatch[3].toLowerCase();
    let items = [];
    if (trigger === "#") {
      items = Array.from(state.tags);
    } else if (trigger === "@") {
      items = Array.from(state.people);
    } else if (trigger === "!") {
      items = Array.from(state.states);
    } else {
      items = state.allTasks.map((task) => task.name);
    }
    const filtered = items.filter((item) => item.toLowerCase().includes(partial));
    if (!filtered.length) {
      closeSuggestions();
      return;
    }
    suggestions.innerHTML = "";
    state.suggestionItems = filtered;
    state.suggestionIndex = 0;
    filtered.forEach((item) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = item;
      button.addEventListener("click", () => {
        applySuggestion({ item, trigger, partial, cursor });
      });
      suggestions.appendChild(button);
    });
    setActiveSuggestion();
    positionSuggestions();
    suggestions.classList.remove("hidden");
    suggestions.classList.add("open");
  }

  function applySuggestion({ item, trigger, partial, cursor }) {
    const tokenValue = trigger === "{" ? item : item.slice(1);
    const lowerToken = tokenValue.toLowerCase();
    const lowerPartial = partial.toLowerCase();
    const canAppend = lowerToken.startsWith(lowerPartial);
    const insert = trigger === "{"
      ? `${canAppend ? tokenValue.slice(partial.length) : tokenValue}}`
      : canAppend
        ? tokenValue.slice(partial.length)
        : tokenValue;
    const start = canAppend ? cursor : cursor - partial.length;
    editor.setRangeText(insert, start, cursor, "end");
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    editor.focus();
    closeSuggestions();
  }

  function setActiveSuggestion() {
    const buttons = Array.from(suggestions.querySelectorAll("button"));
    buttons.forEach((button, index) => {
      button.classList.toggle("active", index === state.suggestionIndex);
    });
  }

  function positionSuggestions() {
    const cursor = editor.selectionStart;
    const coords = getCaretCoordinates(editor, cursor);
    const editorRect = editor.getBoundingClientRect();
    const wrapperRect = editor.parentElement.getBoundingClientRect();
    const offsetLeft = editorRect.left - wrapperRect.left;
    const offsetTop = editorRect.top - wrapperRect.top;
    suggestions.style.left = `${offsetLeft + coords.left}px`;
    suggestions.style.top = `${offsetTop + coords.top + coords.height + 6}px`;
  }

  function getCaretCoordinates(textarea, position) {
    const div = document.createElement("div");
    const style = window.getComputedStyle(textarea);
    Array.from(style).forEach((prop) => {
      div.style[prop] = style[prop];
    });
    div.style.position = "absolute";
    div.style.visibility = "hidden";
    div.style.whiteSpace = "pre-wrap";
    div.style.wordWrap = "break-word";
    div.style.overflowWrap = "break-word";
    div.style.overflow = "auto";
    div.style.height = `${textarea.clientHeight}px`;
    div.style.width = `${textarea.clientWidth}px`;
    div.textContent = textarea.value.slice(0, position);
    const span = document.createElement("span");
    span.textContent = ".";
    div.appendChild(span);
    document.body.appendChild(div);
    div.scrollTop = textarea.scrollTop;
    div.scrollLeft = textarea.scrollLeft;
    const top = span.offsetTop - div.scrollTop;
    const left = span.offsetLeft - div.scrollLeft;
    const height = span.offsetHeight;
    document.body.removeChild(div);
    return { top, left, height };
  }

  function updateSelectedLine() {
    const line = editor.value.slice(0, editor.selectionStart).split("\n").length - 1;
    state.selectedLine = line;
    highlightText(editor.value.split("\n"));
    ensureCaretVisible();
  }

  function ensureCaretVisible() {
    const cursor = editor.selectionStart;
    const coords = getCaretCoordinates(editor, cursor);
    const style = window.getComputedStyle(editor);
    const lineHeight = Number.parseFloat(style.lineHeight) || 18;
    const margin = lineHeight * 2;
    const minTop = margin;
    const maxBottom = editor.clientHeight - margin;
    let nextScrollTop = editor.scrollTop;
    if (coords.top < minTop) {
      nextScrollTop = Math.max(0, nextScrollTop - (minTop - coords.top));
    } else if (coords.top + coords.height > maxBottom) {
      nextScrollTop += coords.top + coords.height - maxBottom;
    }
    const minLeft = margin;
    const maxRight = editor.clientWidth - margin;
    let nextScrollLeft = editor.scrollLeft;
    if (coords.left < minLeft) {
      nextScrollLeft = Math.max(0, nextScrollLeft - (minLeft - coords.left));
    } else if (coords.left > maxRight) {
      nextScrollLeft += coords.left - maxRight;
    }
    if (nextScrollTop !== editor.scrollTop) {
      editor.scrollTop = nextScrollTop;
    }
    if (nextScrollLeft !== editor.scrollLeft) {
      editor.scrollLeft = nextScrollLeft;
    }
  }

  editor.addEventListener("scroll", () => {
    highlightLayer.style.transform = `translate(${-editor.scrollLeft}px, ${-editor.scrollTop}px)`;
    if (lineNumbers) {
      lineNumbers.style.transform = `translate(${-editor.scrollLeft}px, ${-editor.scrollTop}px)`;
    }
    if (!suggestions.classList.contains("hidden")) {
      positionSuggestions();
    }
  });

  editor.addEventListener("input", () => {
    onSync();
    updateSelectedLine();
    const cursor = editor.selectionStart;
    const lastChar = editor.value[cursor - 1];
    if (triggerChars.has(lastChar)) {
      const beforeTrigger = editor.value[cursor - 2] || "";
      if (cursor - 1 === 0 || /\s/.test(beforeTrigger)) {
        updateSuggestions({ forceOpen: true });
      } else {
        closeSuggestions();
      }
      return;
    }
    if (suggestions.classList.contains("open")) {
      updateSuggestions({ forceOpen: true });
    } else {
      closeSuggestions();
    }
  });

  editor.addEventListener("click", () => {
    const line = editor.value.slice(0, editor.selectionStart).split("\n").length - 1;
    updateSelectedLine();
    onSelectTask(line);
    if (suggestions.classList.contains("open")) {
      updateSuggestions({ forceOpen: true });
    }
  });

  editor.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && suggestions.classList.contains("open")) {
      event.preventDefault();
      closeSuggestions();
      return;
    }
    if (!suggestions.classList.contains("hidden")) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        state.suggestionIndex = Math.min(
          state.suggestionIndex + 1,
          state.suggestionItems.length - 1
        );
        setActiveSuggestion();
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        state.suggestionIndex = Math.max(state.suggestionIndex - 1, 0);
        setActiveSuggestion();
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const cursor = editor.selectionStart;
        const before = editor.value.slice(0, cursor);
        const triggerMatch = before.match(/([#@{!])([^\s}]*)$/);
        const trigger = triggerMatch?.[1] || "";
        const partial = triggerMatch?.[2] || "";
        const item = state.suggestionItems[state.suggestionIndex];
        if (item) {
          applySuggestion({ item, trigger, partial, cursor });
        } else {
          closeSuggestions();
        }
        return;
      }
    }

    if (event.key === "Tab") {
      event.preventDefault();
      const start = editor.selectionStart;
      const end = editor.selectionEnd;
      if (!event.ctrlKey && start === end) {
        if (event.shiftKey) {
          const lineStart = editor.value.lastIndexOf("\n", start - 1) + 1;
          const column = start - lineStart;
          const remainder = column % 4;
          const spaces = remainder === 0 ? 4 : remainder;
          const target = Math.max(lineStart, start - spaces);
          editor.setSelectionRange(target, target);
          updateSelectedLine();
          return;
        }
        const lineStart = editor.value.lastIndexOf("\n", start - 1) + 1;
        const column = start - lineStart;
        const remainder = column % 4;
        const spaces = remainder === 0 ? 4 : 4 - remainder;
        const insert = " ".repeat(spaces);
        editor.setRangeText(insert, start, start, "end");
        onSync();
        updateSelectedLine();
        return;
      }
      const value = editor.value;
      const selected = value.slice(start, end) || "";
      if (event.shiftKey || event.ctrlKey) {
        const updated = selected
          .split("\n")
          .map((line) => (line.startsWith("    ") ? line.slice(4) : line))
          .join("\n");
        editor.setRangeText(updated, start, end, "select");
      } else {
        const updated = selected
          .split("\n")
          .map((line) => `    ${line}`)
          .join("\n");
        editor.setRangeText(updated, start, end, "select");
      }
      onSync();
    }

    if (event.key === "Enter") {
      event.preventDefault();
      const start = editor.selectionStart;
      const value = editor.value;
      const lineStart = value.lastIndexOf("\n", start - 1) + 1;
      const lineEnd = value.indexOf("\n", lineStart);
      const resolvedLineEnd = lineEnd === -1 ? value.length : lineEnd;
      const fullLine = value.slice(lineStart, resolvedLineEnd);
      const currentLine = value.slice(lineStart, start);
      const indent = fullLine.match(/^\s*/)[0];
      const checkboxMatch = fullLine.match(/^(\s*)\[([ xX])\](?:\s+|$)/);
      const listMatch = fullLine.match(/^(\s*)([*-])(?:\s+|$)/);
      if (checkboxMatch) {
        const checkboxOnly = fullLine.trim() === `[${checkboxMatch[2]}]`;
        if (checkboxOnly) {
          editor.setRangeText(indent, lineStart, resolvedLineEnd, "end");
          editor.dispatchEvent(new Event("input", { bubbles: true }));
          onSync();
          updateSelectedLine();
          return;
        }
      }
      if (listMatch && listMatch[2] === "-") {
        const listOnly = fullLine.trim() === listMatch[2];
        if (listOnly) {
          editor.setRangeText(indent, lineStart, resolvedLineEnd, "end");
          editor.dispatchEvent(new Event("input", { bubbles: true }));
          onSync();
          updateSelectedLine();
          return;
        }
      }
      if (checkboxMatch) {
        editor.setRangeText(`\n${indent}[ ] `, start, start, "end");
      } else if (listMatch && listMatch[2] === "-") {
        editor.setRangeText(`\n${indent}- `, start, start, "end");
      } else {
        editor.setRangeText(`\n${indent}`, start, start, "end");
      }
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      onSync();
      updateSelectedLine();
    }
  });

  editor.addEventListener("keyup", (event) => {
    if (
      suggestions.classList.contains("open") &&
      (event.key === "ArrowDown" || event.key === "ArrowUp")
    ) {
      return;
    }
    if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      const line = editor.value.slice(0, editor.selectionStart).split("\n").length - 1;
      updateSelectedLine();
      onSelectTask(line);
      return;
    }
    if (!["Enter", "Tab"].includes(event.key)) {
      updateSelectedLine();
    }
  });

  editor.addEventListener("blur", () => {
    closeSuggestions();
  });

  suggestions.addEventListener("mousedown", (event) => {
    event.preventDefault();
  });

  document.addEventListener("mousedown", (event) => {
    if (
      suggestions.classList.contains("open") &&
      !suggestions.contains(event.target) &&
      event.target !== editor
    ) {
      closeSuggestions();
    }
  });

  return {
    highlightText,
    updateSuggestions,
    updateSelectedLine,
  };
}
