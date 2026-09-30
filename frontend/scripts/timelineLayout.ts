type TreeTask = { id: string; children: TreeTask[]; archived?: boolean };
type Span = { start: number; end: number };

type HierarchyTask = { id: string; parent?: HierarchyTask | null };

/** Entering a child group uses that group's width; leaving it uses the shared ancestor level. */
export function timelineSeparatorWidth(current: HierarchyTask, next?: HierarchyTask): number {
  if (!next) return 0;
  const path = (task: HierarchyTask) => {
    const ids: string[] = [];
    let node: HierarchyTask | null | undefined = task;
    while (node) { ids.unshift(node.id); node = node.parent; }
    return ids;
  };
  const left = path(current), right = path(next);
  let shared = 0;
  while (shared < left.length && shared < right.length && left[shared] === right[shared]) shared++;
  return Math.max(1, 4 - shared);
}

/** Siblings without visible descendants share a band. Visible branches stay separate. */
export function layoutTimeline<T extends TreeTask>(roots: T[], spanFor: (task: T) => Span | null) {
  const bands: { tasks: { task: T; lane: number }[]; lanes: number; hiddenParent: T | undefined }[] = [];
  const visibleDescendants = new Map<string, boolean>();
  function hasVisibleDescendants(task: T): boolean {
    const cached = visibleDescendants.get(task.id);
    if (cached !== undefined) return cached;
    const visible = !task.archived && (task.children as T[]).some(child =>
      !child.archived && (spanFor(child) !== null || hasVisibleDescendants(child)));
    visibleDescendants.set(task.id, visible);
    return visible;
  }
  function addBand(tasks: T[], parent?: T) {
    const dated = tasks.map((task, order) => ({ task, order, span: spanFor(task) }))
      .filter((item): item is { task: T; order: number; span: Span } => item.span !== null)
      .sort((a, b) => a.span.start - b.span.start || a.order - b.order);
    if (!dated.length) return;
    const ends: number[] = [];
    const placements = dated.map(({ task, span }) => {
      // A later overlapping task stays below every earlier task it overlaps.
      let lane = 0;
      ends.forEach((end, index) => { if (end > span.start) lane = index + 1; });
      ends[lane] = span.end;
      return { task, lane };
    });
    bands.push({ tasks: placements, lanes: ends.length, hiddenParent: parent && !spanFor(parent) ? parent : undefined });
  }
  function visit(task: T, parent?: T) {
    if (task.archived) return;
    addBand([task], parent);
    let leaves: T[] = [];
    for (const child of task.children as T[]) {
      if (child.archived) continue;
      if (hasVisibleDescendants(child)) {
        addBand(leaves, task); leaves = [];
        visit(child, task);
      } else leaves.push(child);
    }
    addBand(leaves, task);
  }
  roots.forEach(task => visit(task));
  return bands;
}
