export function splitIndent(line) {
  const match = line.match(/^(\s*)/);
  const indent = match ? match[1] : "";
  return { indent, content: line.slice(indent.length) };
}

export function normalizeContent(content) {
  return content.replace(/\s{2,}/g, " ").trim();
}

export function prependTokenToLine(line, token) {
  const { indent, content } = splitIndent(line);
  const trimmed = content.trimStart();
  if (!trimmed) {
    return `${indent}${token}`;
  }
  return `${indent}${token} ${trimmed}`;
}

export function formatTaskScript(text) {
  const normalized = text.replace(/\r\n?/g, "\n");
  let lines = normalized.split("\n").map((line) => line.replace(/[ \t]+$/g, ""));
  const compact = [];
  let blankCount = 0;
  lines.forEach((line) => {
    if (line.trim() === "") {
      blankCount += 1;
      if (compact.length === 0 || blankCount > 1) {
        return;
      }
      compact.push("");
      return;
    }
    blankCount = 0;
    compact.push(line);
  });
  while (compact.length && compact[compact.length - 1].trim() === "") {
    compact.pop();
  }
  lines = compact;

  const stateMatch = /(^|\s)![^\s#@]+(?=\s|$)/;
  const stateReplace = /(^|\s)![^\s#@]+(?=\s|$)/g;
  const removeStateTokens = (line) => {
    const { indent, content } = splitIndent(line);
    if (!stateMatch.test(content)) {
      return line;
    }
    const cleaned = normalizeContent(content.replace(stateReplace, "$1"));
    return cleaned ? `${indent}${cleaned}` : "";
  };

  for (let i = 0; i < lines.length; i += 1) {
    const taskMatch = lines[i].match(/^(\s*)%\s+/);
    if (!taskMatch) {
      continue;
    }
    const indent = taskMatch[1] || "";
    let start = i + 1;
    let end = start;
    while (end < lines.length) {
      const line = lines[end];
      if (line.trim() === "" || /^\s*%/.test(line)) {
        break;
      }
      end += 1;
    }
    if (start === end) {
      continue;
    }
    let stateToken = null;
    for (let j = start; j < end; j += 1) {
      const match = lines[j].match(/(^|\s)(![^\s#@]+)/);
      if (match) {
        stateToken = match[2];
        break;
      }
    }
    if (!stateToken) {
      continue;
    }
    for (let j = start; j < end; j += 1) {
      lines[j] = removeStateTokens(lines[j]);
    }
    if (lines[start].trim() === "") {
      lines[start] = `${indent}${stateToken}`;
    } else {
      lines[start] = prependTokenToLine(lines[start], stateToken);
    }
  }

  const finalLines = [];
  blankCount = 0;
  lines.forEach((line) => {
    if (line.trim() === "") {
      blankCount += 1;
      if (finalLines.length === 0 || blankCount > 1) {
        return;
      }
      finalLines.push("");
      return;
    }
    blankCount = 0;
    finalLines.push(line);
  });
  while (finalLines.length && finalLines[finalLines.length - 1].trim() === "") {
    finalLines.pop();
  }
  return finalLines.join("\n");
}
