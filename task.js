export function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function applyInlineMarkdown(text) {
  let value = text;
  value = value.replace(
    /(^|\s)(#[^\s#@]+)/g,
    "$1<span class=\"pill inline-pill\" data-type=\"tag\" data-value=\"$2\">$2</span>"
  );
  value = value.replace(
    /(^|\s)@([^\s#@]+)/g,
    "$1<span class=\"pill inline-pill\" data-type=\"person\" data-value=\"@$2\">👤 $2</span>"
  );
  value = value.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "<img alt=\"$1\" src=\"$2\" />");
  value = value.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    "<a href=\"$2\" target=\"_blank\" rel=\"noopener\">$1</a>"
  );
  value = value.replace(
    /(https?:\/\/[^\s<]+)/g,
    "<a href=\"$1\" target=\"_blank\" rel=\"noopener\">$1</a>"
  );
  value = value.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  value = value.replace(/__([^_]+)__/g, "<u>$1</u>");
  value = value.replace(/==([^=]+)==/g, "<mark>$1</mark>");
  value = value.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  value = value.replace(/\{([^}]+)\}/g, "<span class=\"references\" data-ref=\"$1\">$1</span>");
  return value;
}

export function renderMarkdown(text) {
  const lines = escapeHtml(text).split("\n");
  let html = "";
  let inList = false;
  let inTable = false;
  let tableHeader = [];

  const closeList = () => {
    if (inList) {
      html += "</ul>";
      inList = false;
    }
  };

  const closeTable = () => {
    if (inTable) {
      html += "</tbody></table>";
      inTable = false;
      tableHeader = [];
    }
  };

  const toCells = (line) =>
    line
      .split("|")
      .map((cell) => cell.trim())
      .filter((cell) => cell.length);

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    const nextLine = lines[index + 1]?.trim() || "";
    const isTableSeparator = /^\|?\s*[-:]+/.test(nextLine) && nextLine.includes("|");

    if (trimmed.includes("|") && isTableSeparator && !inTable) {
      closeList();
      inTable = true;
      tableHeader = toCells(line);
      html += "<table><thead><tr>";
      tableHeader.forEach((cell) => {
        html += `<th>${applyInlineMarkdown(cell)}</th>`;
      });
      html += "</tr></thead><tbody>";
      return;
    }

    if (inTable) {
      if (!trimmed.includes("|") || trimmed === "") {
        closeTable();
      } else {
        const cells = toCells(line);
        if (cells.length) {
          html += "<tr>";
          cells.forEach((cell) => {
            html += `<td>${applyInlineMarkdown(cell)}</td>`;
          });
          html += "</tr>";
        }
        return;
      }
    }

    const checkboxMatch = trimmed.match(/^[-*]\s+\[([ xX])\]\s+(.*)/);
    const listMatch = trimmed.match(/^[-*]\s+(.*)/);

    if (checkboxMatch || listMatch) {
      closeTable();
      if (!inList) {
        html += "<ul>";
        inList = true;
      }
      if (checkboxMatch) {
        const checked = checkboxMatch[1].toLowerCase() === "x";
        html += `<li><input type="checkbox" disabled ${checked ? "checked" : ""} /> ${applyInlineMarkdown(checkboxMatch[2])}</li>`;
      } else if (listMatch) {
        html += `<li>${applyInlineMarkdown(listMatch[1])}</li>`;
      }
      return;
    }

    closeList();
    closeTable();

    if (trimmed === "") {
      html += "<br />";
    } else {
      html += `<p>${applyInlineMarkdown(trimmed)}</p>`;
    }
  });

  closeList();
  closeTable();
  return html;
}

export function parseTasks(text) {
  const lines = text.split("\n");
  const tasks = [];
  const stack = [];
  let currentTask = null;
  const tags = new Set();
  const people = new Set();

  lines.forEach((line, index) => {
    const raw = line;
    const trimmed = raw.trim();
    const taskMatch = raw.match(/^(\s*)\*\s+(.*)$/);
    if (taskMatch) {
      const indent = taskMatch[1].length;
      const depth = Math.floor(indent / 4);
      const name = taskMatch[2].trim();
      const task = {
        id: `${index}-${name}`,
        name,
        depth,
        parent: null,
        tags: [],
        people: [],
        description: [],
        references: [],
        children: [],
        lineIndex: index,
      };
      if (depth === 0) {
        tasks.push(task);
        stack.length = 0;
        stack.push(task);
      } else {
        const parent = stack[depth - 1];
        if (parent) {
          parent.children.push(task);
          task.parent = parent;
        }
        stack[depth] = task;
      }
      currentTask = task;
      return;
    }

    if (!currentTask || trimmed === "") {
      return;
    }
    currentTask.description.push(trimmed);
    const tagMatches = trimmed.matchAll(/(^|\s)(#[^\s#@]+)/g);
    for (const match of tagMatches) {
      const tag = match[2];
      if (tag && tag.length > 1) {
        currentTask.tags.push(tag);
        tags.add(tag);
      }
    }
    const personMatches = trimmed.matchAll(/(^|\s)(@[^\s#@]+)/g);
    for (const match of personMatches) {
      const person = match[2];
      if (person && person.length > 1) {
        currentTask.people.push(person);
        people.add(person);
      }
    }
    const matches = trimmed.matchAll(/\{([^}]+)\}/g);
    for (const match of matches) {
      currentTask.references.push(match[1]);
    }
  });

  const allTasks = [];
  const collect = (items) => {
    items.forEach((task) => {
      allTasks.push(task);
      if (task.children.length) {
        collect(task.children);
      }
    });
  };
  collect(tasks);

  return { tasks, tags, people, lines, allTasks };
}
