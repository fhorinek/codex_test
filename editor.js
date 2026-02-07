import { escapeHtml } from "./task.js";

export function createEditor({ state, dom, onSync, onSelectTask }) {
  const { editor, highlightLayer, suggestions, lineNumbers } = dom;

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
        if (line.trim().startsWith("#")) {
          return `<span class=\"${baseClass} highlight-tags\">${escapeHtml(line)}</span>`;
        }
        if (line.trim().startsWith("@")) {
          return `<span class=\"${baseClass} highlight-people\">${escapeHtml(line)}</span>`;
        }
        if (line.trim() !== "") {
          return `<span class=\"${baseClass} highlight-description\">${escapeHtml(line)}</span>`;
        }
        return `<span class=\"${baseClass}\">&nbsp;</span>`;
      })
      .join("");
    highlightLayer.innerHTML = highlighted;
  }

  function updateLineNumbers(lines) {
    if (!lineNumbers) {
      return;
    }
    lineNumbers.innerHTML = lines
      .map((_, index) => `<span>${index + 1}</span>`)
      .join("");
  }

  function updateSuggestions() {
    const cursor = editor.selectionStart;
    const before = editor.value.slice(0, cursor);
    const triggerMatch = before.match(/([#@{])([^\s}]*)$/);
    if (!triggerMatch) {
      suggestions.classList.add("hidden");
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
        const insert = trigger === "{" ? `${item}}` : item.slice(1);
        const start = cursor - partial.length;
        editor.setRangeText(insert, start, cursor, "end");
        editor.focus();
        suggestions.classList.add("hidden");
        onSync();
      });
      suggestions.appendChild(button);
    });
    setActiveSuggestion();
    positionSuggestions();
    suggestions.classList.remove("hidden");
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
    div.style.whiteSpace = "pre-wrap";
    div.style.wordWrap = "break-word";
    div.style.overflow = "auto";
    div.style.height = "auto";
    div.style.width = `${textarea.clientWidth}px`;
    div.textContent = textarea.value.slice(0, position);
    const span = document.createElement("span");
    span.textContent = textarea.value.slice(position) || ".";
    div.appendChild(span);
    document.body.appendChild(div);
    const rect = span.getBoundingClientRect();
    const textRect = textarea.getBoundingClientRect();
    const top = rect.top - div.getBoundingClientRect().top + textRect.top - textarea.scrollTop;
    const left = rect.left - div.getBoundingClientRect().left + textRect.left - textarea.scrollLeft;
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
    highlightLayer.scrollTop = editor.scrollTop;
    highlightLayer.scrollLeft = editor.scrollLeft;
    if (lineNumbers) {
      lineNumbers.scrollTop = editor.scrollTop;
    }
    if (!suggestions.classList.contains("hidden")) {
      positionSuggestions();
    }
  });

  editor.addEventListener("input", () => {
    onSync();
    updateSelectedLine();
  });

  editor.addEventListener("click", () => {
    updateSuggestions();
    updateSelectedLine();
    const line = editor.value.slice(0, editor.selectionStart).split("\n").length - 1;
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
      if (event.key === "Enter") {
        event.preventDefault();
        const item = state.suggestionItems[state.suggestionIndex];
        if (item) {
          const cursor = editor.selectionStart;
          const before = editor.value.slice(0, cursor);
          const triggerMatch = before.match(/([#@{])([^\s}]*)$/);
          const trigger = triggerMatch?.[1] || "";
          const partial = triggerMatch?.[2] || "";
          const insert = trigger === "{" ? `${item}}` : item.slice(1);
          const start = cursor - partial.length;
          editor.setRangeText(insert, start, cursor, "end");
          suggestions.classList.add("hidden");
          onSync();
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
    }
  });

  editor.addEventListener("keyup", (event) => {
    if (["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) {
      return;
    }
    updateSuggestions();
    updateSelectedLine();
  });

  return {
    highlightText,
    updateSuggestions,
    updateSelectedLine,
  };
}
