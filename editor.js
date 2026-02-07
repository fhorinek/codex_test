import { escapeHtml } from "./task.js";

export function createEditor({ state, dom, onSync, onSelectTask }) {
  const { editor, highlightLayer, suggestions, lineNumbers } = dom;
  const triggerChars = new Set(["#", "@", "{"]);

  function highlightText(lines) {
    updateLineNumbers(lines);
    const highlighted = lines
      .map((line, index) => {
        const taskMatch = line.match(/^(\s*)\*\s+(.*)$/);
        const isActive = state.selectedLine === index;
        const baseClass = isActive ? "highlight-line active" : "highlight-line";
        if (taskMatch) {
          const indent = taskMatch[1];
          const name = taskMatch[2];
          const className = indent.length >= 4 ? "highlight-subtask" : "highlight-task";
          return `<span class=\"${baseClass} ${className}\">${escapeHtml(indent)}* ${escapeHtml(name)}</span>`;
        }
        if (line.trim() !== "") {
          return `<span class=\"${baseClass} highlight-description\">${highlightInlineTokens(line)}</span>`;
        }
        return `<span class=\"${baseClass}\">&nbsp;</span>`;
      })
      .join("");
    highlightLayer.innerHTML = highlighted;
    highlightLayer.style.transform = `translate(${-editor.scrollLeft}px, ${-editor.scrollTop}px)`;
    if (lineNumbers) {
      lineNumbers.style.transform = `translateY(${-editor.scrollTop}px)`;
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

  function highlightInlineTokens(line) {
    const escaped = escapeHtml(line);
    return escaped
      .replace(/(^|\s)(#[^\s#@]+)/g, "$1<span class=\"highlight-tags\">$2</span>")
      .replace(/(^|\s)(@[^\s#@]+)/g, "$1<span class=\"highlight-people\">$2</span>");
  }

  function updateSuggestions({ forceOpen = false } = {}) {
    const cursor = editor.selectionStart;
    const before = editor.value.slice(0, cursor);
    const triggerMatch = before.match(/([#@{])([^\s}]*)$/);
    if (!triggerMatch || (!forceOpen && !suggestions.classList.contains("open"))) {
      suggestions.classList.add("hidden");
      suggestions.classList.remove("open");
      suggestions.innerHTML = "";
      return;
    }
    const trigger = triggerMatch[1];
    const partial = triggerMatch[2].toLowerCase();
    let items = [];
    if (trigger === "#") {
      items = Array.from(state.tags);
    } else if (trigger === "@") {
      items = Array.from(state.people);
    } else {
      items = state.allTasks.map((task) => task.name);
    }
    const filtered = items.filter((item) => item.toLowerCase().includes(partial));
    if (!filtered.length) {
      suggestions.classList.add("hidden");
      suggestions.classList.remove("open");
      suggestions.innerHTML = "";
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
    const insert = trigger === "{" ? `${item}}` : item.slice(1);
    const start = cursor - partial.length;
    editor.setRangeText(insert, start, cursor, "end");
    editor.focus();
    suggestions.classList.add("hidden");
    suggestions.classList.remove("open");
    onSync();
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
    suggestions.style.left = `${coords.left - editorRect.left}px`;
    suggestions.style.top = `${coords.top - editorRect.top + coords.height + 6}px`;
  }

  function getCaretCoordinates(textarea, position) {
    const div = document.createElement("div");
    const style = window.getComputedStyle(textarea);
    Array.from(style).forEach((prop) => {
      div.style[prop] = style[prop];
    });
    div.style.position = "absolute";
    div.style.visibility = "hidden";
    div.style.whiteSpace = "pre";
    div.style.wordWrap = "normal";
    div.style.overflow = "auto";
    div.style.height = `${textarea.clientHeight}px`;
    div.style.width = `${textarea.clientWidth}px`;
    div.textContent = textarea.value.slice(0, position);
    const span = document.createElement("span");
    span.textContent = textarea.value.slice(position) || ".";
    div.appendChild(span);
    document.body.appendChild(div);
    div.scrollTop = textarea.scrollTop;
    div.scrollLeft = textarea.scrollLeft;
    const rect = span.getBoundingClientRect();
    const textRect = textarea.getBoundingClientRect();
    const divRect = div.getBoundingClientRect();
    const top = rect.top - divRect.top + textRect.top;
    const left = rect.left - divRect.left + textRect.left;
    const height = rect.height;
    document.body.removeChild(div);
    return { top, left, height };
  }

  function updateSelectedLine() {
    const line = editor.value.slice(0, editor.selectionStart).split("\n").length - 1;
    state.selectedLine = line;
    highlightText(editor.value.split("\n"));
  }

  editor.addEventListener("scroll", () => {
    highlightLayer.style.transform = `translate(${-editor.scrollLeft}px, ${-editor.scrollTop}px)`;
    if (lineNumbers) {
      lineNumbers.style.transform = `translateY(${-editor.scrollTop}px)`;
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
      updateSuggestions({ forceOpen: true });
      return;
    }
    if (suggestions.classList.contains("open")) {
      updateSuggestions({ forceOpen: true });
    } else {
      suggestions.classList.add("hidden");
      suggestions.classList.remove("open");
    }
  });

  editor.addEventListener("click", () => {
    const line = editor.value.slice(0, editor.selectionStart).split("\n").length - 1;
    updateSelectedLine();
    onSelectTask(line);
  });

  editor.addEventListener("keydown", (event) => {
    if (event.key === "Tab") {
      event.preventDefault();
      const start = editor.selectionStart;
      const end = editor.selectionEnd;
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
        const item = state.suggestionItems[state.suggestionIndex];
        if (item) {
          const cursor = editor.selectionStart;
          const before = editor.value.slice(0, cursor);
          const triggerMatch = before.match(/([#@{])([^\s}]*)$/);
          const trigger = triggerMatch?.[1] || "";
          const partial = triggerMatch?.[2] || "";
          applySuggestion({ item, trigger, partial, cursor });
        } else {
          suggestions.classList.add("hidden");
          suggestions.classList.remove("open");
        }
        return;
      }
    }

    if (event.key === "Enter") {
      event.preventDefault();
      const start = editor.selectionStart;
      const value = editor.value;
      const lineStart = value.lastIndexOf("\n", start - 1) + 1;
      const currentLine = value.slice(lineStart, start);
      const indent = currentLine.match(/^\s*/)[0];
      editor.setRangeText(`\n${indent}`, start, start, "end");
      onSync();
      updateSelectedLine();
    }
  });

  editor.addEventListener("keyup", (event) => {
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

  return {
    highlightText,
    updateSuggestions,
    updateSelectedLine,
  };
}
