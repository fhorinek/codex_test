import type { TaskOrigin } from './taskReferences.js';
type Options = {
  getOrigin: (id: string) => TaskOrigin | null;
  activeDocument: () => string | undefined;
  activate: (id: string) => Promise<void>;
  canEdit: () => boolean;
  drop: (origin: TaskOrigin, mode: 'move' | 'reference' | 'reference-only', target: Element, x: number, y: number) => Promise<void>;
  notify: (message: string) => void;
};
/** Preserve the source before changing editors; ordinary in-tab drags remain untouched. */
export function createCrossTabDrag(options: Options) {
  let pointerOrigin: TaskOrigin | null = null;
  let drag: { origin: TaskOrigin; native: boolean; fromDocument: string | undefined } | null = null;
  let hover = '', timer: ReturnType<typeof setTimeout> | undefined;
  let menu: HTMLElement | null = null;
  const clearHover = () => { clearTimeout(timer); timer = undefined; hover = ''; document.querySelectorAll('.task-tab-hover').forEach(el => el.classList.remove('task-tab-hover')); };
  const closeMenu = () => { menu?.remove(); menu = null; };
  const stop = () => { clearHover(); drag = null; pointerOrigin = null; };
  function over(x: number, y: number) {
    if (!drag || !options.canEdit()) return;
    const tab = document.elementFromPoint(x, y)?.closest<HTMLElement>('.space-tab[data-kind="task"]');
    const id = tab?.dataset['tabId'] || '';
    if (!id || id === options.activeDocument()) { clearHover(); return; }
    if (id === hover) return;
    clearHover(); hover = id; tab!.classList.add('task-tab-hover');
    timer = setTimeout(() => {
      if (hover !== id || !drag) return;
      void options.activate(id).catch(error => options.notify(error.message));
    }, 1000);
  }
  function showMenu(origin: TaskOrigin, target: Element, x: number, y: number) {
    closeMenu();
    menu = document.createElement('div'); menu.className = 'space-tab-context-menu task-transfer-menu';
    menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'Place task in this tab');
    for (const [mode, label, glyph] of [['move', 'Move task here', 'arrow-right'], ['reference-only', 'Reference this task only', 'link'], ['reference', 'Reference task and subtasks', 'sitemap']] as const) {
      const item = document.createElement('button'); item.type = 'button'; item.setAttribute('role', 'menuitem');
      const icon = document.createElement('i'); icon.className = `fa-solid fa-${glyph}`; icon.setAttribute('aria-hidden', 'true');
      item.append(icon, document.createTextNode(label));
      item.addEventListener('click', () => { closeMenu(); void options.drop(origin, mode, target, x, y).catch(error => options.notify(error.message)); });
      menu.append(item);
    }
    document.body.append(menu);
    const rect = menu.getBoundingClientRect(); menu.style.left = `${Math.max(4, Math.min(x, innerWidth - rect.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, innerHeight - rect.height - 4))}px`;
    menu.querySelector('button')?.focus();
  }
  function finish(event: MouseEvent) {
    if (!drag || drag.fromDocument === options.activeDocument()) return false;
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.kanban-column, .graph-canvas, .editor-wrapper');
    if (!target || !options.canEdit()) { stop(); return false; }
    event.preventDefault(); event.stopImmediatePropagation();
    const origin = drag.origin; stop(); window.dispatchEvent(new CustomEvent('taskdragend'));
    showMenu(origin, target, event.clientX, event.clientY); return true;
  }
  document.addEventListener('pointerdown', event => {
    if (menu && !menu.contains(event.target as Node)) closeMenu();
    const target = event.target as Element;
    if (target.closest('.pill, button, input, textarea, .timeline-handle')) { pointerOrigin = null; return; }
    const id = target.closest<HTMLElement>('[data-task-id]')?.dataset['taskId'];
    pointerOrigin = id ? options.getOrigin(id) : null;
  }, true);
  window.addEventListener('taskdragstart', () => { if (pointerOrigin) drag = { origin: pointerOrigin, native: false, fromDocument: options.activeDocument() }; });
  document.addEventListener('dragstart', event => {
    const payload = event.dataTransfer?.getData('application/json');
    if (!payload) return;
    try { const data = JSON.parse(payload); if (data.type === 'task') { const origin = options.getOrigin(data.taskId); if (origin) drag = { origin, native: true, fromDocument: options.activeDocument() }; } } catch { /* Other drag formats are handled by their owners. */ }
  });
  document.addEventListener('dragover', event => {
    over(event.clientX, event.clientY);
    if (drag && drag.fromDocument !== options.activeDocument()) { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; }
  }, true);
  document.addEventListener('dragenter', event => { over(event.clientX, event.clientY); if (drag) event.preventDefault(); }, true);
  document.addEventListener('pointermove', event => { if (drag && !drag.native) over(event.clientX, event.clientY); }, true);
  document.addEventListener('drop', event => { finish(event); stop(); }, true);
  document.addEventListener('pointerup', event => { if (drag && !drag.native) { finish(event); stop(); } pointerOrigin = null; }, true);
  document.addEventListener('pointercancel', () => { if (!drag?.native) stop(); }, true);
  document.addEventListener('dragend', stop);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { closeMenu(); stop(); }
    if (event.key === 'Tab') closeMenu();
    if (!menu || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const items = [...menu.querySelectorAll('button')], index = items.indexOf(document.activeElement as HTMLButtonElement);
    items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  });
  window.addEventListener('resize', closeMenu);
}
