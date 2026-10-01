import { buildDailyWorkload, workloadBoxSize } from "./timelineWorkload.js";
import { layoutTimeline, timelineSeparatorWidth } from "./timelineLayout.js";
import { decorateDescriptionPills, createTaskStatePill, applyTaskBackground } from "./taskDescription.js";
import { findTaskDates, formatDay, formatDates, todayDay, moveDates, resizeDates, type TaskDates } from './taskDates.js';

type Task = { id: string; name: string; lineIndex: number; depth: number; parent?: Task | null; children: Task[]; archived?: boolean; tags: string[]; people: string[]; state: string | null; jiraKey: string | null };
type Options = {
  host: HTMLElement; state: any; getSource: () => string; canEdit: () => boolean;
  onSelect: (task: Task) => void; onEdit: (task: Task) => void;
  onDates: (task: Task, dates: TaskDates, source: string) => void;
  onToken?: (task: Task, value: string, action?: 'add' | 'remove') => void;
  onState?: (task: Task, value: string) => void;
  onToggleToken?: (type: string, value: string) => void;
  matchesFilters: (task: Task) => boolean; matchesSearch: (task: Task) => boolean;
};
type Gesture = {
  task: Task | null; kind: 'pan' | 'move' | 'schedule' | 'start' | 'end';
  source: string; dates: TaskDates | null; preview: TaskDates | null;
  x: number; y: number; lastX: number; lastY: number; origin: number; scroll: number;
  pointer: number; moved: boolean; anchorDay: number;
};
const RULER_HEIGHT = 72;

export function createTimeline(options: Options) {
  const { host, state, getSource } = options;
  const viewport = document.createElement('div');
  viewport.className = 'timeline-viewport';
  viewport.tabIndex = 0;
  viewport.setAttribute('aria-label', 'Task timeline. Wheel scrolls rows; Shift pans horizontally; Control adjusts row height. Wheel over dates zooms time.');
  const ruler = document.createElement('div'); ruler.className = 'timeline-ruler';
  const rows = document.createElement('div'); rows.className = 'timeline-rows';
  const workload = document.createElement('section'); workload.className = 'timeline-workload';
  workload.tabIndex = 0;
  workload.setAttribute('aria-label', 'People workload. Hover or focus to expand.');
  workload.setAttribute('aria-label', 'Daily workload by person');
  workload.tabIndex = 0;
  viewport.append(ruler, rows); host.append(viewport, workload);
  let origin = todayDay() - 15, scale = 24, initialized = false;
  let rowHeight = 72;
  let active = false, gesture: Gesture | null = null, frame = 0, lastSource = '';
  let focusFrame = 0;
  let externalDragSource: string | null = null;
  let tokenDrag: { taskId: string; value: string; source: string } | null = null;
  let dragGhost: HTMLElement | null = null;
  let suppressClickUntil = 0, lastTaskClick = "", lastTaskClickTime = 0;
  const availableWidth = () => Math.max(80, viewport.clientWidth);
  const dayAt = (x: number) => origin + (x - viewport.getBoundingClientRect().left) / scale;
  const node = (tag: string, className: string, text?: string) => {
    const element = document.createElement(tag); element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  function zoom(factor: number, x = viewport.getBoundingClientRect().left + availableWidth() / 2) {
    cancel(); const anchor = dayAt(x);
    const next = Math.max(2, Math.min(100, scale * factor));
    origin = anchor - (anchor - origin) * scale / next; scale = next; paint();
  }
  function tasks(): Task[] {
    const result: Task[] = [];
    const visit = (task: Task) => {
      if (task.archived) return;
      result.push(task);
      task.children?.forEach(visit);
    };
    (state.tasks || []).forEach(visit); return result;
  }
  function makeBar(task: Task, dates: TaskDates): HTMLElement {
    const bar = node('div', 'timeline-bar');
    applyTaskBackground(bar, task, state.tagMeta);
    bar.dataset['taskId'] = task.id; bar.dataset['kind'] = 'move'; bar.tabIndex = 0;
    bar.setAttribute('role', 'button'); bar.setAttribute('aria-label', `${task.name}, ${formatDates(dates)}. Enter to edit.`);
    if (state.selectedTaskId === task.id) bar.classList.add('selected');
    if (options.matchesSearch(task)) bar.classList.add('search-highlight');
    if (!options.matchesFilters(task)) bar.classList.add('dimmed');
    if (task.archived) bar.classList.add('archived');
    if (gesture?.task?.id === task.id && gesture.moved && isOverTrash(gesture.lastX, gesture.lastY)) bar.classList.add('delete-preview');
    const startX = dates.start === null ? (dates.end! + 1 - origin) * scale - 130 : (dates.start - origin) * scale;
    const endX = dates.end === null ? startX + 130 : (dates.end + 1 - origin) * scale;
    bar.style.left = `${startX}px`; bar.style.width = `${Math.max(scale, endX - startX)}px`;
    if (dates.start === null) bar.classList.add('open-start');
    if (dates.end === null) bar.classList.add('open-end');
    bar.append(node('strong', 'timeline-title', task.name));
    bar.append(node('span', 'timeline-dates', formatDates(dates)));
    const metadata = node('div', 'timeline-metadata');
    const wirePill = (pill: HTMLElement, type: string, value: string) => {
      pill.draggable = options.canEdit() && type !== 'jira';
      pill.tabIndex = 0;
      pill.setAttribute('role', 'button');
      pill.addEventListener('pointerdown', event => event.stopPropagation());
      pill.addEventListener('dblclick', event => event.stopPropagation());
      pill.addEventListener('click', event => {
        event.stopPropagation();
        if (type === 'tag' || type === 'person') options.onToggleToken?.(type, value);
        else if (type === 'jira') navigator.clipboard?.writeText(value).catch(() => {});
      });
      pill.addEventListener('keydown', event => {
        event.stopPropagation();
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pill.click(); }
      });
      pill.addEventListener('dragstart', event => {
        event.stopPropagation();
        if (!options.canEdit()) { event.preventDefault(); return; }
        event.dataTransfer?.setData('application/json', JSON.stringify({ type, value, source: 'task', taskId: task.id }));
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copyMove';
        if (type === 'tag' || type === 'person') {
          tokenDrag = { taskId: task.id, value, source: getSource() };
          externalDragSource = getSource();
        }
      });
    };
    if (task.state) {
      const meta = state.stateMeta?.get(task.state);
      if (meta?.color) bar.style.borderColor = meta.color;
      const pill = createTaskStatePill(task.state, meta);
      wirePill(pill, 'state', task.state); metadata.append(pill);
    }
    for (const [type, values] of [['jira', task.jiraKey ? [task.jiraKey] : []], ['tag', task.tags], ['person', task.people]] as const) {
      for (const value of new Set(values)) {
        const pill = node('span', `pill inline-pill${type === 'jira' ? ' jira-pill' : ''}`);
        pill.dataset['type'] = type; pill.dataset['value'] = value; metadata.append(pill);
      }
    }
    decorateDescriptionPills(metadata, {
      tagMeta: state.tagMeta, peopleMeta: state.peopleMeta,
      selectedTags: state.selectedTags, selectedPeople: state.selectedPeople,
      onPill: ({ pill, type, value }) => wirePill(pill, type, value),
    });
    bar.append(metadata);
    bar.title = [task.name, formatDates(dates), metadata.textContent].join('\n');
    if (options.canEdit()) {
      for (const edge of ['start', 'end'] as const) {
        const handle = node('span', `timeline-handle ${edge}`); handle.dataset['kind'] = edge;
        handle.title = `Drag to set ${edge} date`; bar.append(handle);
      }
    }
    return bar;
  }
  function renderWorkload(visible: Task[], sourceLines: string[], todayX: number, yearBoundaries: number[], monthBoundaries: number[]) {
    const data = buildDailyWorkload(visible.map(task => ({
      people: task.people,
      dates: gesture?.task?.id === task.id && gesture.preview ? gesture.preview : findTaskDates(sourceLines, task.lineIndex)!,
    })), Math.floor(origin), Math.ceil(origin + availableWidth() / scale) - 1);
    const scrollTop = workload.scrollTop;
    workload.replaceChildren();
    workload.hidden = !data.people.length;
    if (!data.people.length) {
      return;
    }
    data.people.sort((a, b) => Number(Boolean(state.selectedPeople?.has(b.person))) - Number(Boolean(state.selectedPeople?.has(a.person)))
      || String(state.peopleMeta?.get(a.person)?.name || a.person).localeCompare(String(state.peopleMeta?.get(b.person)?.name || b.person)));
    workload.style.setProperty('--workload-height', `${data.people.length * 28}px`);
    const selectedCount = data.people.filter(person => state.selectedPeople?.has(person.person)).length;
    const compactCount = data.people.length - selectedCount;
    const compactStripHeight = 28 / Math.max(1, compactCount);
    workload.style.setProperty('--compact-strip-height', `${compactStripHeight}px`);
    workload.style.setProperty('--compact-bar-height', `${compactStripHeight * .8}px`);
    workload.style.setProperty('--resting-height', `${selectedCount * 28 + (compactCount ? 28 : 0)}px`);
    workload.classList.toggle('has-selected-people', selectedCount > 0);
    const content = node('div', 'timeline-workload-content');
    workload.append(content);
    let restingTop = 0;
    for (const [personIndex, person] of data.people.entries()) {
      const row = node('div', 'timeline-workload-person'); row.dataset['person'] = person.person;
      const selected = Boolean(state.selectedPeople?.has(person.person));
      row.classList.toggle('selected', selected);
      row.style.setProperty('--person-top', `${personIndex * 28}px`);
      row.style.setProperty('--compact-person-top', `${restingTop}px`);
      restingTop += selected ? 28 : compactStripHeight;
      const name = node('span', 'pill inline-pill timeline-workload-name');
      name.dataset['type'] = 'person'; name.dataset['value'] = person.person;
      const cells = node('div', 'timeline-workload-days');
      cells.append(name);
      decorateDescriptionPills(cells, { peopleMeta: state.peopleMeta, selectedPeople: state.selectedPeople });
      cells.style.width = `${availableWidth()}px`;
      for (const { day, count } of person.days) {
        const size = workloadBoxSize(count, data.peak);
        const width = Math.max(1, Math.min(6, scale - Math.min(3, scale / 4)));
        const cell = node('span', 'timeline-workload-box');
        cell.dataset['day'] = String(day); cell.dataset['count'] = String(count);
        cell.style.setProperty('--expanded-left', `${(day - origin) * scale + (scale - width) / 2}px`);
        cell.style.setProperty('--expanded-width', `${width}px`);
        cell.style.setProperty('--expanded-height', `${size}px`);
        cell.style.backgroundColor = state.peopleMeta?.get(person.person)?.color || 'var(--timeline-accent)';
        const label = `${state.peopleMeta?.get(person.person)?.name || person.person.replace(/^@/, '')} · ${formatDay(day)} · ${count} ${count === 1 ? 'task' : 'tasks'}`;
        cell.title = label; cell.setAttribute('aria-label', label); cell.setAttribute('role', 'img');
        cells.append(cell);
      }
      for (const x of monthBoundaries) {
        const line = node('div', 'timeline-month-boundary'); line.style.left = `${x}px`; cells.append(line);
      }
      for (const x of yearBoundaries) {
        const line = node('div', 'timeline-year-boundary'); line.style.left = `${x}px`; cells.append(line);
      }
      const today = node('div', 'timeline-today-line'); today.style.left = `${todayX}px`; cells.append(today);
      row.append(cells); content.append(row);
    }
    workload.scrollTop = scrollTop;
  }
  function paint() {
    if (!active) return;
    const scrollTop = viewport.scrollTop;
    if (!initialized && host.clientWidth) { scale = availableWidth() / 30; initialized = true; }
    const source = getSource();
    const sourceLines = source.split('\n');
    ruler.replaceChildren();
    const ticks = node('div', 'timeline-ticks'); ruler.append(ticks);
    const end = origin + availableWidth() / scale;
    const firstDate = new Date(Math.floor(origin) * 86400000);
    const addSection = (className: string, text: string, start: number, finish: number) => {
      const left = Math.max(0, (start - origin) * scale);
      const right = Math.min(availableWidth(), (finish - origin) * scale);
      if (right <= left) return;
      const section = node('span', `timeline-section ${className}`, text);
      section.style.left = `${left}px`; section.style.width = `${right - left}px`;
      section.title = text; ticks.append(section);
    };
    const yearBoundaries: number[] = [];
    for (let year = firstDate.getUTCFullYear(); Date.UTC(year, 0, 1) / 86400000 <= end; year++) {
      const yearStart = Date.UTC(year, 0, 1) / 86400000;
      addSection('timeline-year', String(year), yearStart, Date.UTC(year + 1, 0, 1) / 86400000);
      if (yearStart >= origin) yearBoundaries.push((yearStart - origin) * scale);
    }
    const lastDate = new Date((Math.ceil(end) - 1) * 86400000);
    const visibleMonths = (lastDate.getUTCFullYear() - firstDate.getUTCFullYear()) * 12
      + lastDate.getUTCMonth() - firstDate.getUTCMonth() + 1;
    const monthBoundaries: number[] = [];
    let month = Date.UTC(firstDate.getUTCFullYear(), firstDate.getUTCMonth(), 1) / 86400000;
    while (month <= end) {
      const date = new Date(month * 86400000);
      const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / 86400000;
      if (visibleMonths <= 3 && month >= origin && month < end && date.getUTCMonth() !== 0) monthBoundaries.push((month - origin) * scale);
      addSection('timeline-month', date.toLocaleDateString(undefined, { month: 'long', timeZone: 'UTC' }), month, next);
      month = next;
    }
    const labelEvery = Math.max(1, Math.ceil(20 / scale));
    for (let tick = Math.floor(origin); tick <= Math.ceil(end); tick++) {
      const day = new Date(tick * 86400000).getUTCDate();
      const label = node('span', 'timeline-tick', (day - 1) % labelEvery === 0 ? String(day) : '');
      label.style.left = `${(tick - origin) * scale}px`; label.style.width = `${scale}px`;
      label.title = formatDay(tick); ticks.append(label);
    }
    const todayX = (todayDay() - origin) * scale;
    rows.style.backgroundPositionX = `${todayX}px`;
    const today = node('span', 'timeline-today-label', String(new Date().getDate()));
    today.title = `Today · ${formatDay(todayDay())}`;
    today.setAttribute('aria-label', today.title);
    today.style.left = `${todayX}px`; today.style.width = `${Math.max(scale, 20)}px`; ticks.append(today);
    rows.replaceChildren();
    for (const x of monthBoundaries) {
      const line = node('div', 'timeline-month-boundary');
      line.style.left = `${x}px`; line.setAttribute('aria-hidden', 'true'); rows.append(line);
    }
    for (const x of yearBoundaries) {
      for (const container of [ticks, rows]) {
        const line = node('div', 'timeline-year-boundary');
        line.style.left = `${x}px`; line.setAttribute('aria-hidden', 'true'); container.append(line);
      }
    }
    const visible = tasks().filter(task => findTaskDates(sourceLines, task.lineIndex));
    const bands = layoutTimeline<Task>(state.tasks || [], task => {
      const dates = findTaskDates(sourceLines, task.lineIndex);
      if (!dates) return null;
      const start = dates.start === null ? (dates.end! + 1) * scale - 130 : dates.start * scale;
      const end = dates.end === null ? start + 130 : (dates.end + 1) * scale;
      return { start, end: Math.max(start + scale, end) };
    });
    const groups: { task: Task; element: HTMLElement; heading: HTMLElement; aligned: boolean }[] = [];
    for (const [index, band] of bands.entries()) {
      // Undated ancestors own a group spanning every descendant band, even
      // when a dated task appears between that ancestor and its grandchildren.
      const ancestors: Task[] = [];
      let ancestor = band.tasks[0]!.task.parent;
      while (ancestor) {
        if (!findTaskDates(sourceLines, ancestor.lineIndex)) ancestors.unshift(ancestor);
        ancestor = ancestor.parent;
      }
      let shared = 0;
      while (shared < groups.length && groups[shared]!.task.id === ancestors[shared]?.id) shared++;
      groups.length = shared;
      for (const task of ancestors.slice(shared)) {
        const element = node('div', 'timeline-parent-group');
        const heading = node('div', 'timeline-parent-name');
        heading.append(node('span', 'timeline-parent-label', task.name));
        heading.style.top = `${RULER_HEIGHT + groups.length * 22}px`;
        heading.style.zIndex = String(100 - groups.length);
        applyTaskBackground(heading, task, state.tagMeta);
        heading.title = task.name;
        element.append(heading);
        (groups.at(-1)?.element || rows).append(element);
        groups.push({ task, element, heading, aligned: false });
      }
      const row = node('div', 'timeline-row');
      const nextBand = bands[index + 1];
      const separatorWidth = nextBand?.hiddenParent ? 0 : timelineSeparatorWidth(band.tasks[0]!.task, nextBand?.tasks[0]?.task);
      row.style.borderBottomWidth = `${separatorWidth}px`;
      row.style.borderBottomColor = `color-mix(in srgb, var(--timeline-text) ${Math.max(0, separatorWidth - 1) * 12}%, var(--timeline-grid))`;
      row.style.height = `${band.lanes * rowHeight + Math.max(0, separatorWidth - 1)}px`;
      row.dataset['rowTaskId'] = band.tasks[0]!.task.id;
      const track = node('div', 'timeline-track');
      let firstVisible: { left: number; right: number } | null = null;
      for (const { task, lane } of band.tasks) {
        const dates = gesture?.task?.id === task.id && gesture.preview ? gesture.preview : findTaskDates(sourceLines, task.lineIndex);
        if (dates) {
          const bar = makeBar(task, dates);
          bar.style.top = `${lane * rowHeight + 7}px`;
          bar.style.height = `${rowHeight - 14}px`;
          bar.dataset['lane'] = String(lane);
          const left = parseFloat(bar.style.left), right = left + parseFloat(bar.style.width);
          if (right > 0 && left < availableWidth() && (!firstVisible || left < firstVisible.left)) {
            firstVisible = { left, right };
          }
          track.append(bar);
        }
      }
      if (firstVisible) {
        for (const group of groups) {
          if (group.aligned) continue;
          if (firstVisible.left >= 0 && firstVisible.right <= availableWidth()) group.heading.style.paddingLeft = `${firstVisible.left}px`;
          group.aligned = true;
        }
      }
      const line = node('div', 'timeline-today-line'); line.style.left = `${todayX}px`; track.append(line);
      row.append(track); (groups.at(-1)?.element || rows).append(row);
    }
    if (!visible.length) rows.append(node('div', 'timeline-empty', 'No tasks with valid dates. Drag a task from kanban here to schedule it, or add dates in the editor.'));
    renderWorkload(visible, sourceLines, todayX, yearBoundaries, monthBoundaries);
    viewport.scrollTop = scrollTop;
    lastSource = source;
  }
  function cancel() {
    cancelAnimationFrame(focusFrame); focusFrame = 0;
    if (!gesture) return;
    gesture = null; cancelAnimationFrame(frame);
    dragGhost?.remove(); dragGhost = null;
    host.classList.remove('is-dragging');
    document.querySelector('#task-trash')?.classList.remove('drag-over');
    document.querySelectorAll('.kanban-column.timeline-drop-target').forEach(column => column.classList.remove('timeline-drop-target'));
    window.dispatchEvent(new CustomEvent('taskdragend'));
    paint();
  }
  function isInTimeline(x: number, y: number) {
    const rect = viewport.getBoundingClientRect();
    return x >= rect.left && x < rect.right && y >= rect.top + RULER_HEIGHT && y < rect.bottom;
  }
  function isInTaskRow(g: Gesture, x: number, y: number): boolean {
    if (!g.task || !isInTimeline(x, y)) return false;
    const bar = Array.from(rows.querySelectorAll<HTMLElement>('.timeline-bar')).find(element => element.dataset['taskId'] === g.task!.id);
    if (!bar) return false;
    const top = bar.getBoundingClientRect().top - 7;
    return y >= top && y < top + rowHeight;
  }
  function isOverTrash(x: number, y: number) {
    return Boolean(document.elementFromPoint(x, y)?.closest('#task-trash'));
  }
  function preview(g: Gesture) {
    if (g.kind === 'pan') {
      origin = g.origin - (g.lastX - g.x) / scale;
      viewport.scrollTop = g.scroll - (g.lastY - g.y); return;
    }
    const day = Math.floor(dayAt(g.lastX));
    const inOwnRow = isInTaskRow(g, g.lastX, g.lastY);
    if (!inOwnRow) {
      g.preview = null;
    } else if (g.kind === 'schedule') {
      g.preview = g.dates ? moveDates(g.dates, day - (g.dates.start ?? g.dates.end!)) : { start: day, end: null };
    } else if (g.kind === 'move') {
      g.preview = moveDates(g.dates!, Math.round(dayAt(g.lastX) - g.anchorDay));
    } else {
      g.preview = resizeDates(g.dates!, g.kind, day);
    }
    if (g.task && ['move', 'schedule'].includes(g.kind) && !inOwnRow) {
      if (!dragGhost) {
        dragGhost = node('div', 'timeline-drag-ghost', g.task.name);
        document.body.append(dragGhost);
      }
      dragGhost.style.left = `${g.lastX + 12}px`; dragGhost.style.top = `${g.lastY + 12}px`;
    } else { dragGhost?.remove(); dragGhost = null; }
    document.querySelector('#task-trash')?.classList.toggle('drag-over', isOverTrash(g.lastX, g.lastY));
    const column = document.elementFromPoint(g.lastX, g.lastY)?.closest('.kanban-column');
    document.querySelectorAll('.kanban-column').forEach(item => item.classList.toggle('timeline-drop-target', item === column && ['move', 'schedule'].includes(g.kind)));
  }
  function autoScroll() {
    const g = gesture;
    if (!g?.moved || g.kind === 'pan' || g.kind === 'start' || g.kind === 'end') return;
    const rect = viewport.getBoundingClientRect();
    const previousOrigin = origin, previousScroll = viewport.scrollTop;
    if (isInTaskRow(g, g.lastX, g.lastY)) {
      if (g.lastX > rect.right - 32 && g.lastX <= rect.right) origin += 8 / scale;
      if (g.lastX < rect.left + 32 && g.lastX >= rect.left) origin -= 8 / scale;
      if (g.lastY > rect.bottom - 32) viewport.scrollTop += 8;
      if (g.lastY < rect.top + RULER_HEIGHT + 32) viewport.scrollTop -= 8;
      if (origin !== previousOrigin || viewport.scrollTop !== previousScroll) { preview(g); paint(); }
    }
    frame = requestAnimationFrame(autoScroll);
  }
  viewport.addEventListener('pointerdown', (event) => {
    cancelAnimationFrame(focusFrame); focusFrame = 0;
    if (event.button !== 0 || gesture) return;
    const target = event.target as HTMLElement;
    if (target.closest('.timeline-ruler')) return;
    const taskNode = target.closest<HTMLElement>('[data-task-id]');
    const task = taskNode ? tasks().find(t => t.id === taskNode.dataset['taskId']) || null : null;

    const source = getSource(), dates = task ? findTaskDates(source, task.lineIndex) : null;
    const kind = task ? (target.closest<HTMLElement>('[data-kind]')?.dataset['kind'] || 'move') as Gesture['kind'] : 'pan';
    gesture = { task, kind, source, dates, preview: null, x: event.clientX, y: event.clientY,
      lastX: event.clientX, lastY: event.clientY, origin, scroll: viewport.scrollTop,
      pointer: event.pointerId, moved: false, anchorDay: dayAt(event.clientX) };
    viewport.setPointerCapture(event.pointerId);
  });
  viewport.addEventListener('pointermove', (event) => {
    const g = gesture;
    if (!g || g.pointer !== event.pointerId) return;
    if (getSource() !== g.source) { cancel(); return; }
    if (g.task && !options.canEdit()) return;
    g.lastX = event.clientX; g.lastY = event.clientY;
    if (!g.moved && Math.hypot(g.lastX - g.x, g.lastY - g.y) < 5) return;
    if (!g.moved) {
      g.moved = true; host.classList.add('is-dragging');
      if (g.task) { window.dispatchEvent(new CustomEvent('taskdragstart')); frame = requestAnimationFrame(autoScroll); }
    }
    preview(g); paint(); event.preventDefault();
  });
  viewport.addEventListener('pointerup', (event) => {
    const g = gesture;
    if (!g || g.pointer !== event.pointerId) return;
    if (!g.moved) {
      gesture = null;
      if (g.task) {
        const doubleClick = lastTaskClick === g.task.id && Date.now() - lastTaskClickTime < 400;
        lastTaskClick = g.task.id; lastTaskClickTime = Date.now();
        suppressClickUntil = Date.now() + 100;
        if (doubleClick && options.canEdit()) options.onEdit(g.task);
        else options.onSelect(g.task);
      }
      return;
    }
    if (g.moved) suppressClickUntil = Date.now() + 300;
    const valid = getSource() === g.source && options.canEdit();
    const trash = g.task && g.moved && isOverTrash(event.clientX, event.clientY);
    const commit = g.task && g.moved && g.preview && isInTaskRow(g, event.clientX, event.clientY);
    const column = g.task && ['move', 'schedule'].includes(g.kind)
      ? document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('.kanban-column') : null;
    const nextState = column?.dataset['stateTag'];
    cancel();
    if (!valid) return;
    if (trash) window.dispatchEvent(new CustomEvent('taskdroptrash', { detail: { taskId: g.task!.id } }));
    else if (column && nextState !== undefined) options.onState?.(g.task!, nextState);
    else if (commit) {
      options.onDates(g.task!, g.preview!, g.source);
      if (g.kind === 'start' || g.kind === 'end') controller.focusOnTask(g.task!, true);
    }
  });
  window.addEventListener('keydown', event => { if (event.key === 'Escape' && gesture) { cancel(); event.preventDefault(); } });
  viewport.addEventListener('pointercancel', () => cancel());
  viewport.addEventListener('lostpointercapture', event => {
    if (gesture?.pointer === event.pointerId) cancel();
  });
  viewport.addEventListener('click', (event) => {
    if (Date.now() < suppressClickUntil) return;
    const id = (event.target as HTMLElement).closest<HTMLElement>('[data-task-id]')?.dataset['taskId'];
    const task = tasks().find(t => t.id === id); if (task) options.onSelect(task);
  });
  viewport.addEventListener('dblclick', (event) => {
    if (Date.now() < suppressClickUntil || !options.canEdit()) return;
    const id = (event.target as HTMLElement).closest<HTMLElement>('[data-task-id]')?.dataset['taskId'];
    const task = tasks().find(t => t.id === id); if (task) options.onEdit(task);
  });
  host.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { cancel(); event.stopPropagation(); }
    if (event.key === 'Enter' && options.canEdit()) {
      const id = (event.target as HTMLElement).closest<HTMLElement>('[data-task-id]')?.dataset['taskId'];
      const task = tasks().find(t => t.id === id); if (task) { event.preventDefault(); options.onEdit(task); }
    }
    if (event.target === viewport && ['ArrowLeft', 'ArrowRight', '+', '-'].includes(event.key)) {
      event.preventDefault();
      if (event.key === '+') zoom(1.4);
      else if (event.key === '-') zoom(1 / 1.4);
      else { origin += event.key === 'ArrowLeft' ? -7 : 7; paint(); }
    }
  });
  host.addEventListener('wheel', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? viewport.clientHeight : 1;
    const delta = (event.deltaY || event.deltaX) * unit;
    const target = event.target as HTMLElement;
    if (target.closest('.timeline-ticks, .timeline-workload')) {
      zoom(Math.exp(-delta * .005), event.clientX);
    } else if (event.ctrlKey || event.metaKey) {
      cancel();
      const previousHeight = rowHeight;
      rowHeight = Math.max(36, Math.min(180, rowHeight * Math.exp(-delta * .005)));
      const pointerY = Math.max(0, event.clientY - viewport.getBoundingClientRect().top - RULER_HEIGHT);
      const anchor = viewport.scrollTop + pointerY;
      paint();
      viewport.scrollTop = anchor * rowHeight / previousHeight - pointerY;
    } else if (event.shiftKey) {
      cancel(); origin += delta / scale; paint();
    } else {
      cancel(); viewport.scrollTop += event.deltaY * unit;
    }
  }, { passive: false });
  let workloadPan: { x: number; y: number; origin: number; scroll: number; pointer: number } | null = null;
  workload.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    cancel();
    workloadPan = { x: event.clientX, y: event.clientY, origin, scroll: workload.scrollTop, pointer: event.pointerId };
    workload.setPointerCapture(event.pointerId);
  });
  workload.addEventListener('pointermove', event => {
    if (!workloadPan || workloadPan.pointer !== event.pointerId) return;
    origin = workloadPan.origin - (event.clientX - workloadPan.x) / scale;
    workload.scrollTop = workloadPan.scroll - (event.clientY - workloadPan.y);
    paint(); event.preventDefault();
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) workload.addEventListener(name, () => { workloadPan = null; });
  host.addEventListener('dragover', (event) => {
    if (!options.canEdit()) return;
    event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  });
  host.addEventListener('drop', (event) => {
    event.preventDefault(); event.stopPropagation();
    if (!options.canEdit()) return;
    if (externalDragSource !== null && externalDragSource !== getSource()) return;
    let id = event.dataTransfer?.getData('text/plain');
    try {
      const data = JSON.parse(event.dataTransfer?.getData('application/json') || '{}');
      if (['tag', 'person', 'state'].includes(data.type)) {
        const targetId = (event.target as HTMLElement).closest<HTMLElement>('.timeline-bar')?.dataset['taskId'];
        const target = tasks().find(task => task.id === targetId);
        if (typeof data.value !== 'string') return;
        const isToken = (data.type === 'tag' && /^#[^\s]+$/.test(data.value)) || (data.type === 'person' && /^@[^\s]+$/.test(data.value));
        if (target) {
          if (data.source === 'task' && data.taskId === target.id) return;
          if (data.type === 'state' && /^![^\s]+$/.test(data.value)) options.onState?.(target, data.value);
          else if (isToken) options.onToken?.(target, data.value, 'add');
        } else if (isToken && data.source === 'task') {
          const sourceTask = tasks().find(task => task.id === data.taskId);
          if (sourceTask) options.onToken?.(sourceTask, data.value, 'remove');
        }
        return;
      }
      if (data.type === 'task') id = data.taskId;
    } catch { /* Plain-text task ID fallback. */ }
    if (!isInTimeline(event.clientX, event.clientY)) return;
    const task = tasks().find(t => t.id === id); if (!task) return;
    const source = getSource(), dates = findTaskDates(source, task.lineIndex), day = Math.floor(dayAt(event.clientX));
    options.onDates(task, dates ? moveDates(dates, day - (dates.start ?? dates.end!)) : { start: day, end: null }, source);
    window.dispatchEvent(new CustomEvent('taskdragend'));
  });
  // A real drop on otherwise unhandled page space removes a task pill.
  // Consumed drops retain their target behavior; Escape/outside-window cancellation never removes it.
  document.addEventListener('dragover', event => {
    if (tokenDrag && options.canEdit()) event.preventDefault();
  });
  document.addEventListener('drop', event => {
    if (!tokenDrag || event.defaultPrevented || !options.canEdit() || getSource() !== tokenDrag.source) return;
    event.preventDefault();
    const sourceTask = tasks().find(task => task.id === tokenDrag!.taskId);
    if (sourceTask) options.onToken?.(sourceTask, tokenDrag.value, 'remove');
  });
  window.addEventListener('drop', () => queueMicrotask(() => { tokenDrag = null; externalDragSource = null; }), true);
  window.addEventListener('dragend', () => { tokenDrag = null; externalDragSource = null; }, true);
  window.addEventListener('taskdroptimeline', (event) => {
    const { taskId, clientX, clientY } = (event as CustomEvent).detail || {};
    if (!active || !options.canEdit() || !isInTimeline(clientX, clientY)) return;
    if (externalDragSource !== null && externalDragSource !== getSource()) return;
    const task = tasks().find(item => item.id === taskId); if (!task) return;
    const source = getSource(), dates = findTaskDates(source, task.lineIndex), day = Math.floor(dayAt(clientX));
    options.onDates(task, dates ? moveDates(dates, day - (dates.start ?? dates.end!)) : { start: day, end: null }, source);
  });
  window.addEventListener('taskdragstart', () => { if (!gesture) externalDragSource = getSource(); });
  window.addEventListener('taskdragend', () => { externalDragSource = null; });
  // Keep graph canvas gestures from consuming timeline input.
  for (const name of ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mousemove', 'mouseup', 'touchstart', 'touchmove', 'touchend', 'click', 'dblclick', 'dragover', 'drop', 'wheel']) {
    host.addEventListener(name, event => event.stopPropagation());
  }
  new ResizeObserver(() => { if (active) paint(); }).observe(host);
  let lastToday = todayDay();
  window.setInterval(() => { const day = todayDay(); if (day !== lastToday) { lastToday = day; paint(); } }, 60000);
  const controller = {
    setActive(value: boolean) { cancel(); active = value; host.hidden = !value; if (value) paint(); },
    focusOnTask(task: Task, onlyIfClipped = false) {
      if (!active || gesture?.kind === 'start' || gesture?.kind === 'end') return;
      const bar = Array.from(rows.querySelectorAll<HTMLElement>('.timeline-bar')).find(element => element.dataset['taskId'] === task.id);
      if (!bar) return;
      if (onlyIfClipped) {
        const bounds = bar.getBoundingClientRect(), view = viewport.getBoundingClientRect();
        if (bounds.left >= view.left && bounds.right <= view.left + viewport.clientWidth
          && bounds.top >= view.top + RULER_HEIGHT && bounds.bottom <= view.top + viewport.clientHeight) return;
      }
      cancelAnimationFrame(focusFrame); focusFrame = 0;
      const visibleHeight = viewport.clientHeight - RULER_HEIGHT;
      // Allow the last task to center without adding empty space above the first.
      const padding = Math.max(0, visibleHeight / 2);
      rows.style.paddingBottom = `${padding}px`;
      const rect = bar.getBoundingClientRect();
      const targetScroll = Math.max(0, rect.top - rows.getBoundingClientRect().top + rect.height / 2 - visibleHeight / 2);
      const targetOrigin = origin + (parseFloat(bar.style.left) + parseFloat(bar.style.width) / 2 - availableWidth() / 2) / scale;
      const startOrigin = origin, startScroll = viewport.scrollTop;
      const source = getSource(), started = performance.now();
      const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 220;
      const tick = (now: number) => {
        if (!active || source !== getSource()) { focusFrame = 0; return; }
        const progress = duration ? Math.min(1, (now - started) / duration) : 1;
        const eased = 1 - (1 - progress) ** 3;
        origin = startOrigin + (targetOrigin - startOrigin) * eased;
        paint();
        viewport.scrollTop = startScroll + (targetScroll - startScroll) * eased;
        focusFrame = progress < 1 ? requestAnimationFrame(tick) : 0;
      };
      focusFrame = requestAnimationFrame(tick);
    },
    render() { if (gesture && (lastSource !== getSource() || !options.canEdit())) cancel(); paint(); },
  };
  return controller;
}
