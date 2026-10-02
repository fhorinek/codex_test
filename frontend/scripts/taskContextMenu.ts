import type { TaskOrigin, ReferenceDocument } from './taskReferences.js';
import { parseTasks } from './task.js';
type Tab = { id: string; name: string; kind: string; appearance: { icon?: string } };
type Mode = 'move' | 'reference-only' | 'reference';
type Point = { x: number; y: number; timeline: boolean };

function taskDialog(title: string) {
  const dialog = document.createElement('dialog'); dialog.className = 'tab-dialog modal-card';
  const header = document.createElement('div'); header.className = 'modal-header';
  const heading = document.createElement('h2'); heading.textContent = title;
  heading.id = 'task-action-dialog-title'; dialog.setAttribute('aria-labelledby', heading.id);
  const close = document.createElement('button'); close.type = 'button'; close.className = 'toolbar-icon'; close.setAttribute('aria-label', 'Close');
  close.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>'; close.onclick = () => dialog.close();
  const body = document.createElement('div'); body.className = 'modal-body';
  const footer = document.createElement('div'); footer.className = 'modal-actions';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'toolbar-button'; cancel.textContent = 'Cancel'; cancel.onclick = () => dialog.close();
  header.append(heading, close); footer.append(cancel); dialog.append(header, body, footer); document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  return { dialog, body, footer };
}

export function confirmTaskMove(tabName: string): Promise<boolean | null> {
  return new Promise(resolve => {
    const { dialog, body, footer } = taskDialog(`Move to ${tabName}`);
    const text = document.createElement('p'); text.className = 'modal-help';
    text.textContent = 'Move the task and its subtasks. Choose whether to leave a reference in the current tab.'; body.append(text);
    let result: boolean | null = null;
    for (const [label, leave] of [['Just move task', false], [`Move to ${tabName} and leave reference`, true]] as const) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'toolbar-button success'; button.textContent = label;
      button.onclick = () => { result = leave; dialog.close(); }; footer.append(button);
    }
    dialog.classList.add('task-move-dialog');
    dialog.addEventListener('close', () => resolve(result)); dialog.showModal();
  });
}

function newTabName(): Promise<string | null> {
  return new Promise(resolve => {
    const { dialog, body, footer } = taskDialog('Move to new tab');
    const field = document.createElement('label'); field.className = 'modal-field'; field.textContent = 'Tab name';
    const input = document.createElement('input'); input.type = 'text'; input.required = true; input.pattern = '[A-Za-z0-9_-]+'; input.placeholder = 'e.g. release'; input.autocomplete = 'off'; input.spellcheck = false; field.append(input);
    const help = document.createElement('p'); help.className = 'modal-help'; help.textContent = 'Letters, digits, underscores and hyphens only.'; body.append(field, help);
    let result: string | null = null;
    const next = document.createElement('button'); next.type = 'button'; next.className = 'toolbar-button success'; next.textContent = 'Continue';
    const submit = () => { if (input.reportValidity()) { result = input.value; dialog.close(); } };
    next.onclick = submit; input.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); submit(); } }; footer.append(next);
    dialog.addEventListener('close', () => resolve(result)); dialog.showModal(); input.focus();
  });
}

function pickTasks(documents: ReferenceDocument[], activeId: string, mode: Mode): Promise<TaskOrigin[] | null> {
  return new Promise(resolve => {
    const { dialog, body, footer } = taskDialog(mode === 'move' ? 'Move tasks here' : mode === 'reference-only' ? 'Reference tasks here' : 'Reference tasks with subtasks here');
    dialog.classList.add('task-picker-modal');
    const filters = document.createElement('div'); filters.className = 'task-picker-filters';
    const searchField = document.createElement('label'); searchField.className = 'modal-field'; searchField.textContent = 'Search tasks';
    const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Search by task or tab name'; searchField.append(search);
    const tabField = document.createElement('label'); tabField.className = 'modal-field'; tabField.textContent = 'Filter tabs';
    const tabs = document.createElement('select'); tabs.setAttribute('aria-label', 'Filter tabs'); tabField.append(tabs);
    const other = documents.filter(doc => doc.id !== activeId);
    for (const [value, name] of [['', 'All other tabs'], ...other.map(doc => [doc.id, doc.name])]) {
      const option = document.createElement('option'); option.value = value!; option.textContent = name!; tabs.append(option);
    }
    const tasks = other.flatMap(doc => parseTasks(doc.text).allTasks.filter(task => !task.referenceTarget).map(task => ({
      key: `${doc.id}:${task.lineIndex}`, depth: task.depth,
      origin: { documentId: doc.id, tab: doc.name, lineIndex: task.lineIndex, source: doc.text, name: task.name } as TaskOrigin,
    })));
    const selected = new Set<string>();
    const list = document.createElement('div'); list.className = 'task-picker-list'; list.setAttribute('role', 'group'); list.setAttribute('aria-label', 'Tasks from other tabs');
    const count = document.createElement('p'); count.className = 'modal-help'; count.setAttribute('aria-live', 'polite');
    const save = document.createElement('button'); save.type = 'button'; save.className = 'toolbar-button success'; save.textContent = mode === 'move' ? 'Move selected tasks' : 'Reference selected tasks'; save.disabled = true;
    let result: TaskOrigin[] | null = null;
    const renderList = () => {
      list.replaceChildren(); const query = search.value.trim().toLocaleLowerCase();
      const filtered = tasks.filter(task => (!tabs.value || task.origin.documentId === tabs.value) && `${task.origin.name} ${task.origin.tab}`.toLocaleLowerCase().includes(query));
      for (const task of filtered) {
        const row = document.createElement('label'); row.className = 'task-picker-item';
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(task.key);
        const title = document.createElement('span'); title.textContent = task.origin.name;
        const tab = document.createElement('small'); tab.textContent = task.origin.tab;
        checkbox.onchange = () => { if (checkbox.checked) selected.add(task.key); else selected.delete(task.key); save.disabled = !selected.size; count.textContent = `${selected.size} selected`; };
        row.append(checkbox, title, tab); list.append(row);
      }
      if (!filtered.length) { const empty = document.createElement('p'); empty.className = 'modal-help'; empty.textContent = 'No matching tasks.'; list.append(empty); }
      count.textContent = `${selected.size} selected`;
    };
    save.onclick = () => { result = tasks.filter(task => selected.has(task.key)).map(task => task.origin); dialog.close(); };
    search.oninput = renderList; tabs.onchange = renderList;
    filters.append(searchField, tabField); body.append(filters, list, count); footer.append(save);
    dialog.addEventListener('close', () => resolve(result)); dialog.showModal(); renderList(); search.focus();
  });
}

export function createTaskContextMenu(options: {
  task: (id: string) => any; origin: (task: any) => TaskOrigin | null;
  tabs: () => Tab[]; canEdit: () => boolean;
  archive: (task: any, archived: boolean) => void; remove: (task: any) => void;
  createTab: (name: string) => Promise<Tab>;
  activeTab: () => Tab | undefined; documents: () => ReferenceDocument[];
  newTask: (parent: any | null, point: Point) => void;
  importTasks: (origins: TaskOrigin[], mode: Mode, parent: any | null, point: Point, leave: boolean, expectedTarget: string) => Promise<void>;
  transfer: (origin: TaskOrigin, tab: Tab, mode: Mode, leave: boolean) => Promise<void>;
  notify: (message: string) => void;
}) {
  let menu: HTMLElement | null = null, submenu: HTMLElement | null = null;
  const close = () => { menu?.remove(); submenu?.remove(); menu = submenu = null; };
  const position = (element: HTMLElement, x: number, y: number) => {
    const bounds = element.getBoundingClientRect();
    element.style.left = `${Math.max(4, Math.min(x, innerWidth - bounds.width - 4))}px`;
    element.style.top = `${Math.max(4, Math.min(y, innerHeight - bounds.height - 4))}px`;
  };
  const action = (parent: HTMLElement, label: string, glyph: string, run: () => any) => {
    const button = document.createElement('button'); button.type = 'button'; button.setAttribute('role', 'menuitem');
    const icon = document.createElement('i'); icon.className = `fa-solid fa-${glyph}`; icon.setAttribute('aria-hidden', 'true');
    button.append(icon, document.createTextNode(label));
    button.onmouseenter = () => {
      if (parent !== menu) return;
      submenu?.remove(); submenu = null;
      menu?.querySelectorAll('[aria-expanded]').forEach(item => item.setAttribute('aria-expanded', 'false'));
    };
    button.onclick = () => { Promise.resolve().then(run).catch(error => options.notify(error.message)); };
    parent.append(button); return button;
  };
  const keyboard = (element: HTMLElement, back?: HTMLElement) => {
    element.onkeydown = event => {
      const buttons = [...element.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'Escape' || event.key === 'Tab') { close(); return; }
      if (event.key === 'ArrowLeft' && back) { submenu?.remove(); submenu = null; back.focus(); event.preventDefault(); }
      if (event.key === 'ArrowRight' && !back && document.activeElement?.getAttribute('aria-haspopup') === 'menu') { (document.activeElement as HTMLButtonElement).click(); event.preventDefault(); }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length]?.focus();
      }
    };
  };
  document.addEventListener('pointerdown', event => { if (!menu?.contains(event.target as Node) && !submenu?.contains(event.target as Node)) close(); }, true);
  window.addEventListener('resize', close);
  // Focus animations can keep scrolling after a menu opens. Only user scrolling
  // should dismiss the menu, so the first action remains available immediately.
  window.addEventListener('wheel', event => { if (!menu?.contains(event.target as Node) && !submenu?.contains(event.target as Node)) close(); }, true);
  document.addEventListener('contextmenu', event => {
    const node = (event.target as Element).closest<HTMLElement>('.task-node[data-task-id], .kanban-card[data-task-id], .timeline-bar[data-task-id]');
    const background = (event.target as Element).closest('.graph-canvas, .timeline-rows');
    close(); if ((!node && !background) || !options.canEdit()) return;
    const task = node ? options.task(node.dataset['taskId']!) : null; if (node && !task) return;
    event.preventDefault(); event.stopPropagation();
    const origin = task ? options.origin(task) : null;
    const contextDocument = options.activeTab()?.id;
    const contextSource = options.documents().find(doc => doc.id === contextDocument)?.text || '';
    const point = { x: event.clientX, y: event.clientY, timeline: Boolean((event.target as Element).closest('.timeline-rows')) };
    menu = document.createElement('div'); menu.className = 'space-tab-context-menu task-context-menu'; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', task ? `Actions for ${task.name}` : 'Workspace actions');
    const isReference = Boolean(task?.origin || task?.referenceTarget);
    if (isReference) {
      const message = document.createElement('div'); message.className = 'space-tab-menu-empty'; message.textContent = 'This is reference'; menu.append(message);
    }
    if (!isReference) {
      const add = action(menu, 'Add task', 'plus', () => { close(); options.newTask(task, point); });
      add.disabled = Boolean(task?.archived);
      if (add.disabled) add.title = 'Archived tasks cannot be parents.';
      for (const [mode, label, glyph] of [['move', 'Move task here', 'arrow-down'], ['reference-only', 'Reference tasks here', 'link'], ['reference', 'Reference tasks with subtasks here', 'sitemap']] as const) {
        const incoming = action(menu, label, glyph, async () => {
          close(); const active = options.activeTab(); if (!active) return;
          if (active.id !== contextDocument) throw new Error('The destination tab changed. Reopen the menu and try again.');
          const expectedTarget = contextSource;
          const selected = await pickTasks(options.documents(), active.id, mode); if (!selected?.length) return;
          const leave = mode === 'move' ? await confirmTaskMove(active.name) : false; if (leave === null) return;
          if (options.activeTab()?.id !== active.id) throw new Error('The destination tab changed. Reopen the menu and try again.');
          await options.importTasks(selected, mode, task, point, leave, expectedTarget);
        });
        incoming.disabled = Boolean(task?.archived);
        if (incoming.disabled) incoming.title = 'Archived tasks cannot be parents.';
      }
    }
    if (!task) { document.body.append(menu); position(menu, event.clientX, event.clientY); keyboard(menu); menu.querySelector('button')?.focus(); return; }
    const incomingSeparator = document.createElement('div'); incomingSeparator.className = 'space-tab-menu-separator'; incomingSeparator.setAttribute('role', 'separator'); menu.append(incomingSeparator);
    const perform = async (tab: Tab, mode: Mode) => {
      close(); if (!origin) return;
      const leave = mode === 'move' ? await confirmTaskMove(tab.name) : false;
      if (leave === null) return;
      await options.transfer(origin, tab, mode, leave);
    };
    const separator = () => { const line = document.createElement('div'); line.className = 'space-tab-menu-separator'; line.setAttribute('role', 'separator'); menu!.append(line); };
    const ownArchived = origin && /^\s*%\.\s+/.test(origin.source.split('\n')[origin.lineIndex] || '');
    const archive = action(menu, task.archived ? 'Unarchive' : 'Archive', task.archived ? 'box-open' : 'box-archive', () => { close(); options.archive(task, !task.archived); });
    archive.disabled = !origin || (task.archived && !ownArchived);
    if (task.archived && !ownArchived) archive.title = 'Unarchive the parent task first.';
    const remove = action(menu, 'Delete', 'trash-can', () => { close(); options.remove(task); }); remove.classList.add('destructive');
    separator();
    const newTab = action(menu, 'Move to new tab', 'file-circle-plus', async () => {
      close(); if (!origin) return;
      const name = await newTabName(); if (!name) return;
      const leave = await confirmTaskMove(name); if (leave === null) return;
      const tab = await options.createTab(name); await options.transfer(origin, tab, 'move', leave);
    }); newTab.disabled = !origin;
    for (const [mode, label, glyph] of [['move', 'Move to', 'arrow-right'], ['reference-only', 'Reference this task only', 'link'], ['reference', 'Reference task and subtasks', 'sitemap']] as const) {
      const button = action(menu, label, glyph, () => openSubmenu(true));
      button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-expanded', 'false');
      const arrow = document.createElement('i'); arrow.className = 'fa-solid fa-chevron-right task-submenu-arrow'; arrow.setAttribute('aria-hidden', 'true'); button.append(arrow);
      const targets = options.tabs().filter(tab => tab.kind === 'task' && tab.id !== origin?.documentId);
      button.disabled = !origin || !targets.length;
      const openSubmenu = (focus: boolean) => {
        if (button.disabled) return;
        menu?.querySelectorAll('[aria-expanded]').forEach(item => item.setAttribute('aria-expanded', 'false'));
        submenu?.remove(); submenu = document.createElement('div'); submenu.className = 'space-tab-context-menu task-context-submenu'; submenu.setAttribute('role', 'menu'); submenu.setAttribute('aria-label', label);
        for (const tab of targets) action(submenu, `${tab.appearance.icon || ''} ${tab.name}`.trim(), 'file-lines', () => perform(tab, mode));
        document.body.append(submenu); const bounds = button.getBoundingClientRect();
        position(submenu, bounds.right + 3, bounds.top); button.setAttribute('aria-expanded', 'true'); keyboard(submenu, button);
        if (focus) submenu.querySelector('button')?.focus();
      };
      button.onmouseenter = () => openSubmenu(false);
    }
    document.body.append(menu); position(menu, event.clientX, event.clientY); keyboard(menu); menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  });
}
