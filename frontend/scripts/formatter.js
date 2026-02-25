export function splitIndent(line) {
  const match = line.match(/^(\s*)/);
  const indent = match ? match[1] : "";
  return { indent, content: line.slice(indent.length) };
}

export function normalizeContent(content) {
  return content.replace(/\s{2,}/g, " ").trim();
}

function sharedPrefix(a, b) {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) {
    i += 1;
  }
  return a.slice(0, i);
}

function normalizeIndentToTaskDepth(indent) {
  if (!/^[ ]*$/.test(indent)) {
    return indent;
  }
  const depth = Math.floor(indent.length / 4);
  return " ".repeat(depth * 4);
}

export function prependTokenToLine(line, token) {
  const { indent, content } = splitIndent(line);
  const trimmed = content.trimStart();
  if (!trimmed) {
    return `${indent}${token}`;
  }
  return `${indent}${token} ${trimmed}`;
}

function compactBlankLines(lines) {
  const firstTaskIndex = lines.findIndex((line) => /^\s*%\s+/.test(line));
  const compact = [];
  let blankCount = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") {
      if (firstTaskIndex < 0 || i < firstTaskIndex) {
        continue;
      }
      blankCount += 1;
      if (compact.length === 0 || blankCount > 1) {
        continue;
      }
      compact.push("");
      continue;
    }
    blankCount = 0;
    compact.push(line);
  }
  return compact;
}

function ensureConfigTaskSeparator(lines) {
  const firstTaskIndex = lines.findIndex((line) => /^\s*%\s+/.test(line));
  if (firstTaskIndex <= 0) {
    return lines;
  }
  let hasConfigContent = false;
  for (let i = 0; i < firstTaskIndex; i += 1) {
    if (lines[i].trim() !== "") {
      hasConfigContent = true;
      break;
    }
  }
  if (!hasConfigContent) {
    return lines;
  }
  if (lines[firstTaskIndex - 1].trim() === "") {
    return lines;
  }
  const nextLines = [...lines];
  nextLines.splice(firstTaskIndex, 0, "");
  return nextLines;
}

export function formatTaskScript(text) {
  const normalized = text.replace(/\r\n?/g, "\n");
  let lines = normalized.split("\n").map((line) => line.replace(/[ \t]+$/g, ""));
  const compact = compactBlankLines(lines);
  while (compact.length && compact[compact.length - 1].trim() === "") {
    compact.pop();
  }
  lines = ensureConfigTaskSeparator(compact);

  const stateMatch = /(^|\s)(![^\s#@~]+)(?=\s|$)/;
  const stateReplace = /(^|\s)![^\s#@~]+(?=\s|$)/g;
  const estimateMatch = /(^|\s)(~\d+(?:\.\d+)?)(?=\s|$)/;
  const estimateReplace = /(^|\s)~\d+(?:\.\d+)?(?=\s|$)/g;
  const isTokenOnlyLine = (line) => {
    const { content } = splitIndent(line);
    const trimmed = content.trim();
    if (!trimmed) {
      return false;
    }
    return trimmed.split(/\s+/).every((token) => (
      /^~\d+(?:\.\d+)?$/.test(token) || /^[#@!][^\s#@~]+$/.test(token)
    ));
  };
  const removeStateEstimateTokens = (line) => {
    const { indent, content } = splitIndent(line);
    if (!stateMatch.test(content) && !estimateMatch.test(content)) {
      return line;
    }
    const cleaned = normalizeContent(
      content.replace(stateReplace, "$1").replace(estimateReplace, "$1")
    );
    return cleaned ? `${indent}${cleaned}` : "";
  };

  for (let i = 0; i < lines.length; i += 1) {
    const taskMatch = lines[i].match(/^(\s*)%\s+/);
    if (!taskMatch) {
      continue;
    }
    const indent = taskMatch[1] || "";
    const taskIndent = normalizeIndentToTaskDepth(indent);
    let start = i + 1;
    // Canonical form keeps the token line directly adjacent to description.
    // If the first body line is token-only and the next line is a blank followed
    // by more task content, remove that blank even when no tokens are moved.
    if (
      start + 2 < lines.length &&
      isTokenOnlyLine(lines[start]) &&
      lines[start + 1].trim() === "" &&
      lines[start + 2].trim() !== "" &&
      !/^\s*%/.test(lines[start + 2])
    ) {
      lines.splice(start + 1, 1);
    }
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
    let estimateToken = null;
    for (let j = start; j < end; j += 1) {
      if (!stateToken) {
        const match = lines[j].match(/(^|\s)(![^\s#@~]+)(?=\s|$)/);
        if (match) {
          stateToken = match[2];
        }
      }
      if (!estimateToken) {
        const match = lines[j].match(/(^|\s)(~\d+(?:\.\d+)?)(?=\s|$)/);
        if (match) {
          estimateToken = match[2];
        }
      }
      if (stateToken && estimateToken) {
        break;
      }
    }
    if (!stateToken && !estimateToken) {
      continue;
    }
    for (let j = start; j < end; j += 1) {
      lines[j] = removeStateEstimateTokens(lines[j]);
    }
    // Lines that become empty after stripping state/estimate were created by
    // normalization, not authored as task separators. Drop them so the token
    // line stays adjacent to the description.
    for (let j = start; j < end; ) {
      if (lines[j].trim() !== "") {
        j += 1;
        continue;
      }
      lines.splice(j, 1);
      end -= 1;
    }
    let tokenLineIndex = -1;
    for (let j = start; j < end; j += 1) {
      if (lines[j].trim() === "") {
        continue;
      }
      if (isTokenOnlyLine(lines[j])) {
        tokenLineIndex = j;
      }
      break;
    }
    const desiredTokens = [stateToken, estimateToken].filter(Boolean).join(" ");
    if (!desiredTokens) {
      continue;
    }
    if (tokenLineIndex >= 0) {
      const { indent: lineIndent, content } = splitIndent(lines[tokenLineIndex]);
      const cleaned = normalizeContent(content);
      const finalContent = cleaned
        ? normalizeContent(`${cleaned} ${desiredTokens}`)
        : desiredTokens;
      lines[tokenLineIndex] = `${lineIndent}${finalContent}`;
      if (taskIndent !== indent) {
        // Snap malformed task/token indentation to 4-space depth increments.
        const { content: taskContent } = splitIndent(lines[i]);
        lines[i] = `${taskIndent}${taskContent}`;
        const { content: tokenContent } = splitIndent(lines[tokenLineIndex]);
        lines[tokenLineIndex] = `${taskIndent}${tokenContent}`;
      }
    } else {
      let sharedBodyIndent = null;
      for (let j = start; j < end; j += 1) {
        if (lines[j].trim() === "") {
          continue;
        }
        const lineIndent = splitIndent(lines[j]).indent;
        sharedBodyIndent = sharedBodyIndent === null
          ? lineIndent
          : sharedPrefix(sharedBodyIndent, lineIndent);
      }
      const canonicalIndentRaw = sharedBodyIndent === null ? indent : sharedPrefix(indent, sharedBodyIndent);
      const canonicalIndent = normalizeIndentToTaskDepth(canonicalIndentRaw);
      if (indent !== canonicalIndent) {
        const { content: taskContent } = splitIndent(lines[i]);
        lines[i] = `${canonicalIndent}${taskContent}`;
      }
      if (sharedBodyIndent !== null && sharedBodyIndent !== canonicalIndent) {
        for (let j = start; j < end; j += 1) {
          if (lines[j].trim() === "" || !lines[j].startsWith(sharedBodyIndent)) {
            continue;
          }
          lines[j] = `${canonicalIndent}${lines[j].slice(sharedBodyIndent.length)}`;
        }
      }
      lines.splice(start, 0, `${canonicalIndent}${desiredTokens}`);
      end += 1;
    }
  }

  const finalLines = ensureConfigTaskSeparator(compactBlankLines(lines));
  while (finalLines.length && finalLines[finalLines.length - 1].trim() === "") {
    finalLines.pop();
  }
  return finalLines.join("\n");
}
