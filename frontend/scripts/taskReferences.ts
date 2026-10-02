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
      return expand(matches[0], parent, depth, anchor, prefix, new Set([...visited, key]), document, includeChildren && target.includeSubtasks !== false);
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

export function transferTask(source: string, taskLine: number, destination: string, line: number, tab: string, mode: 'move' | 'reference' | 'reference-only') {
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
  if (mode === 'move') lines.splice(block.start, block.end - block.start);
  const names = [...new Set(movedTasks.filter(item => sourceTasks.filter(other => !other.referenceTarget && other.name === item.name).length === 1).map(item => item.name))];
  return { source: lines.join('\n'), destination: target.join('\n'), name: task.name, names, insertedLine: position };
}
