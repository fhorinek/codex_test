import { parseTasks } from './task.js';
import { findTaskBlock } from './taskCommands.js';
import { taskBackground } from './taskDescription.js';

export type ReferenceDocument = { id: string; name: string; text: string };
export type TaskOrigin = { documentId: string; tab: string; lineIndex: number; source: string; name: string };
export function taskSource(task: any, fallback: string | string[]): string | string[] {
  return task?.origin?.source ?? fallback;
}
export function taskSourceLine(task: any): number { return task?.origin?.lineIndex ?? task.lineIndex; }
export function rewriteTaskReferences(source: string, tab: string, name: string, nextTab: string, nextName: string): string {
  return source.split('\n').map(line => {
    const match = /^(\s*%{2,3}\s+)([A-Za-z0-9_-]+)::(.+?)(\s*)$/.exec(line);
    return match && match[2] === tab && match[3] === name ? `${match[1]}${nextTab}::${nextName}${match[4]}` : line;
  }).join('\n');
}

/** Resolve projections without altering the script or its source positions. */
export function resolveTaskReferences(parsed: any, documents: ReferenceDocument[], activeId: string, shared = '') {
  const sources = new Map(documents.map(doc => [doc.name, { ...doc, parsed: parseTasks(doc.text, shared) }]));
  const diagnostics: string[] = [];
  for (const [index, line] of parsed.lines.entries()) {
    if (/^\s*%%/.test(line) && !/^\s*%{2,3}\s+[A-Za-z0-9_-]+::.+?\s*$/.test(line)) diagnostics.push(`Line ${index + 1}: use %% tab::Task name or %%% tab::Task name.`);
  }
  const referenceLines = new Map<number, { origin: TaskOrigin; line: number }>();
  let checkboxLine = -1;
  const expand = (task: any, parent: any, depth: number, anchor: number, prefix: string, visited: Set<string>, owner?: ReferenceDocument, includeChildren = true): any => {
    if (task.referenceTarget) {
      const target = task.referenceTarget;
      const document = sources.get(target.tab);
      const candidates = document?.parsed.allTasks.filter((item: any) => item.name === target.name) || [];
      const originals = candidates.filter((item: any) => !item.referenceTarget);
      const matches = originals.length ? originals : candidates;
      const key = `${target.tab}::${target.name}`;
      if (!document || matches.length !== 1 || visited.has(key)) {
        diagnostics.push(`${key}: ${visited.has(key) ? 'circular reference' : matches.length > 1 ? 'ambiguous task name' : 'task not found'}.`);
        return { ...task, parent, depth, lineIndex: anchor, children: [], unresolvedReference: true };
      }
      const nextVisited = new Set([...visited, key]);
      const resolved = expand(matches[0], parent, depth, anchor, prefix, nextVisited, document, includeChildren && target.includeSubtasks !== false);
      if (includeChildren) {
        resolved.children.push(...task.children.map((child: any, index: number) => expand(child, resolved, depth + 1,
          owner ? anchor : child.lineIndex, owner ? `${prefix}/local-reference-${index}` : child.id, nextVisited, owner)));
      }
      return resolved;
    }
    const clone: any = { ...task, parent, depth, children: [] };
    clone.archived = Boolean(task.archived || parent?.archived);
    if (owner) {
      clone.id = prefix;
      clone.lineIndex = anchor;
      clone.origin = { documentId: owner.id, tab: owner.name, lineIndex: task.lineIndex, source: owner.text, name: task.name };
      clone.originMeta = { tagMeta: (owner as any).parsed.tagMeta, peopleMeta: (owner as any).parsed.peopleMeta, stateMeta: (owner as any).parsed.stateMeta };
      clone.originBackground = taskBackground(task, (owner as any).parsed.tagMeta);
      clone.descriptionLineIndexes = task.descriptionLineIndexes.map((line: number) => {
        const value = checkboxLine--; referenceLines.set(value, { origin: clone.origin, line }); return value;
      });
      for (const [setKey, mapKey, values] of [['tags', 'tagMeta', task.tags], ['people', 'peopleMeta', task.people], ['states', 'stateMeta', task.state ? [task.state] : []]] as any[]) {
        for (const token of values) { parsed[setKey].add(token); if (!parsed[mapKey].has(token)) parsed[mapKey].set(token, (owner as any).parsed[mapKey].get(token)); }
      }
    }
    clone.children = includeChildren ? task.children.map((child: any, index: number) => expand(child, clone, depth + 1, owner ? anchor : child.lineIndex, owner ? `${prefix}/reference-${index}` : child.id, visited, owner)) : [];
    return clone;
  };
  parsed.tasks = parsed.tasks.map((task: any) => expand(task, null, 0, task.lineIndex, task.id, new Set(), undefined));
  parsed.allTasks = [];
  const collect = (task: any) => { parsed.allTasks.push(task); task.children.forEach(collect); };
  parsed.tasks.forEach(collect);
  const total = (task: any): number => {
    task.storyPointsSubtasksTotal = task.children.reduce((sum: number, child: any) => sum + total(child), 0);
    task.storyPointsTotal = (task.storyPoints || 0) + task.storyPointsSubtasksTotal;
    return task.storyPointsTotal;
  };
  parsed.totalStoryPoints = parsed.tasks.reduce((sum: number, task: any) => sum + total(task), 0);
  return { ...parsed, referenceDiagnostics: diagnostics, referenceLines };
}

export function transferTask(source: string, taskLine: number, destination: string, line: number, tab: string, mode: 'move' | 'reference' | 'reference-only', leaveReferenceTab?: string) {
  const lines = source.split('\n');
  const block = findTaskBlock(lines, taskLine);
  if (!block || /^\s*%%/.test(lines[taskLine]!)) throw new Error('Drag the original task to move or reference it.');
  const task = parseTasks(source).allTasks.find(item => item.lineIndex === taskLine);
  if (!task) throw new Error('The original task is no longer available.');
  const sourceTasks = parseTasks(source).allTasks;
  if (mode !== 'move' && sourceTasks.filter(item => !item.referenceTarget && item.name === task.name).length !== 1) throw new Error('Give the task a unique name before referencing it.');
  const movedTasks = sourceTasks.filter(item => item.lineIndex >= block.start && item.lineIndex < block.end);
  if (mode === 'move') {
    const destinationTasks = parseTasks(destination).allTasks.filter(item => !item.referenceTarget);
    if (movedTasks.some(item => !item.referenceTarget && destinationTasks.some(other => other.name === item.name))) throw new Error('A task with the same name already exists in the destination tab.');
  }
  const incoming = mode !== 'move' ? [`${mode === 'reference-only' ? '%%%' : '%%'} ${tab}::${task.name}`] : lines.slice(block.start, block.end).map(text => text.startsWith(block.indent) ? text.slice(block.indent.length) : text);
  const target = destination.split('\n');
  const position = Math.max(0, Math.min(line, target.length));
  target.splice(position, 0, ...incoming);
  if (mode === 'move') {
    if (leaveReferenceTab && sourceTasks.filter(item => !item.referenceTarget && item.name === task.name).length !== 1) throw new Error('Give the task a unique name before leaving a reference.');
    lines.splice(block.start, block.end - block.start, ...(leaveReferenceTab ? [`${block.indent}%% ${leaveReferenceTab}::${task.name}`] : []));
  }
  const names = [...new Set(movedTasks.filter(item => sourceTasks.filter(other => !other.referenceTarget && other.name === item.name).length === 1).map(item => item.name))];
  return { source: lines.join('\n'), destination: target.join('\n'), name: task.name, names, insertedLine: position };
}

/** Build one recoverable multi-document import, using the exact source snapshots. */
export function importTaskSelection(documents: ReferenceDocument[], origins: TaskOrigin[], destinationId: string,
  mode: 'move' | 'reference' | 'reference-only', parentLine?: number, leaveReference = false,
  prepare?: (source: string, line: number) => string) {
  const destination = documents.find(doc => doc.id === destinationId);
  if (!destination) throw new Error('The destination tab is no longer available.');
  const sources = new Map(documents.map(doc => [doc.id, doc.text]));
  const blocks = origins.map(origin => {
    const source = documents.find(doc => doc.id === origin.documentId);
    if (!source || source.id === destinationId || source.text !== origin.source) throw new Error('A selected task changed. Reopen the task list and try again.');
    const block = findTaskBlock(source.text.split('\n'), origin.lineIndex);
    if (!block) throw new Error('A selected task is no longer available.');
    return { origin, block, source };
  });
  // Selecting a parent already includes its children when moving or referencing its subtree.
  const selected = blocks.filter(item => mode === 'reference-only' || !blocks.some(other => other !== item && other.source.id === item.source.id && other.block.start < item.block.start && other.block.end > item.block.start));
  selected.sort((a, b) => a.source.id.localeCompare(b.source.id) || b.origin.lineIndex - a.origin.lineIndex);
  const parent = parentLine === undefined ? null : findTaskBlock(destination.text.split('\n'), parentLine);
  if (parentLine !== undefined && (!parent || /^\s*%%/.test(destination.text.split('\n')[parentLine]!))) throw new Error('The parent task changed. Reopen the menu and try again.');
  if (parentLine !== undefined && parseTasks(destination.text).allTasks.find(task => task.lineIndex === parentLine)?.archived) throw new Error('Archived tasks cannot be parents.');
  let target = destination.text;
  const renames: { tab: string; name: string }[] = [];
  for (const { origin, source } of selected) {
    let current = sources.get(source.id)!;
    if (prepare) current = prepare(current, origin.lineIndex);
    const insertion = parent ? parent.end : destination.text ? destination.text.split('\n').length : 0;
    const transferred = transferTask(current, origin.lineIndex, target, insertion, source.name, mode, leaveReference ? destination.name : undefined);
    if (parent) {
      const before = target.split('\n'), after = transferred.destination.split('\n');
      const count = after.length - before.length;
      const indent = parent.indent + '    ';
      for (let i = insertion; i < insertion + count; i++) if (after[i]!.trim()) after[i] = indent + after[i];
      target = after.join('\n');
    } else target = transferred.destination;
    sources.set(source.id, transferred.source);
    if (mode === 'move') for (const name of transferred.names) renames.push({ tab: source.name, name });
  }
  sources.set(destinationId, target);
  return documents.map(doc => {
    let text = sources.get(doc.id)!;
    for (const rename of renames) text = rewriteTaskReferences(text, rename.tab, rename.name, destination.name, rename.name);
    return { id: doc.id, expected: doc.text, text };
  }).filter(change => change.text !== change.expected);
}
