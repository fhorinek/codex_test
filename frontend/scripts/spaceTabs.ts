import { createJiraPanel } from "./jiraPanel.js";
import { jiraMetadataRanges, jiraViewOptions, parseSpaceJira } from "./jiraDefinitions.js";
import { renameSlugInWholeFile, replaceSlugTokenOccurrences, removeSlugDefinition } from "./slugRenameModal.js";
import { parseTasks } from "./task.js";
import { definitionsConfigSource, plainDefinitions } from './definitionsSource.js';
import { normalizeHexColorValue, createSlugColorControls } from "./slugRenameUi.js";
import { transferTask, importTaskSelection, rewriteTaskReferences, type TaskOrigin, type ReferenceDocument } from './taskReferences.js';
/** Space navigation. Names/order/visibility come from filenames; looks live in defs.txt. */
export type SpaceTab = { id: string; name: string; filename: string; kind: 'task' | 'defs'; order: number; closed: boolean; appearance: { icon?: string; color?: string } };
type Listing = { id: string; name: string; access: string; revision: number; tabs: SpaceTab[]; created?: string };
type Options = {
  base: string; wsBase: string; headers: () => Record<string, string>; collab: any;
  modules: () => Promise<any>; connect: (id: string) => Promise<void>; disconnect: () => void;
  definitions: (source: string) => void; mode: (kind: 'task' | 'defs' | 'empty' | 'jira') => void;
  capture: () => any; restore: (value: any) => void; notify: (message: string, kind?: string) => void;
  release: (id: string) => void;
  acquire: (id: string) => Promise<any>; referencesChanged: () => void;
  layout: () => void; canEdit: () => boolean;
};
const EMOJI_GROUPS = [
  { name: 'Projects', icons: [['📋', 'Clipboard'], ['📅', 'Calendar'], ['📁', 'Folder'], ['📌', 'Pin'], ['📚', 'Books'], ['📝', 'Notes'], ['📊', 'Chart'], ['💼', 'Briefcase'], ['💻', 'Laptop'], ['🔧', 'Tools'], ['⚙️', 'Settings'], ['💡', 'Idea'], ['🎯', 'Target'], ['🚀', 'Rocket'], ['🧩', 'Puzzle']] },
  { name: 'Highlights', icons: [['⭐', 'Star'], ['🌟', 'Sparkling star'], ['✨', 'Sparkles'], ['✅', 'Checkmark'], ['☑️', 'Check'], ['🚧', 'Construction'], ['⏳', 'Hourglass'], ['⏰', 'Alarm'], ['🔔', 'Bell'], ['🔥', 'Fire'], ['⚡', 'Lightning'], ['🏆', 'Trophy'], ['🎉', 'Celebration'], ['🎨', 'Art'], ['🎵', 'Music'], ['❤️', 'Heart']] },
  { name: 'Animals & nature', icons: [['🦄', 'Unicorn'], ['🐶', 'Dog'], ['🐱', 'Cat'], ['🦊', 'Fox'], ['🐼', 'Panda'], ['🐻', 'Bear'], ['🐸', 'Frog'], ['🐝', 'Bee'], ['🦋', 'Butterfly'], ['🌱', 'Growth'], ['🌳', 'Tree'], ['🌻', 'Sunflower'], ['🍀', 'Clover'], ['☀️', 'Sun'], ['🌙', 'Moon'], ['🌈', 'Rainbow']] },
  { name: 'Places & activities', icons: [['🏠', 'Home'], ['🏢', 'Office'], ['🏫', 'School'], ['🏕️', 'Camping'], ['🏖️', 'Beach'], ['🌍', 'World'], ['✈️', 'Airplane'], ['🚗', 'Car'], ['🚲', 'Bicycle'], ['⛵', 'Boat'], ['🎮', 'Games'], ['⚽', 'Football'], ['🎁', 'Gift'], ['☕', 'Coffee'], ['🍕', 'Pizza'], ['🔒', 'Lock']] },
  { name: 'More', icons: [['🤖', 'Robot'], ['🗑️', 'Wastebasket'], ['🛢️', 'Oil drum'], ['♻️', 'Recycling'], ['🔐', 'Locked with key'], ['💳', 'Credit card'], ['💩', 'Pile of poo'], ['🥤', 'Cup with straw']] },
];
export function parseTabAppearance(source: string) {
  const entries: Record<string, { icon?: string; color?: string }> = {};
  const diagnostics: string[] = [];
  let section = '', key = '';
  for (const line of definitionsConfigSource(source).split('\n')) {
    if (/^\s*%/.test(line)) diagnostics.push('Tasks are not allowed in defs.txt.');
    const header = /^ {4}([^\s:]+):\s*$/.exec(line);
    if (header) { section = header[1]!; key = ''; }
    if (section !== 'tabs') continue;
    const entry = /^ {8}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (entry) { key = entry[1]!; entries[key] = {}; }
    const property = /^ {12}(icon|color):\s*(.*?)\s*$/.exec(line);
    if (key && property) {
      const value = property[2]!;
      if (property[1] === 'color') {
        if (/^#[\da-f]{6}$/i.test(value)) entries[key]!.color = value;
        else if (value) diagnostics.push(`Invalid tab color for ${key}.`);
      } else {
        if (value) entries[key]!.icon = value;
      }
    }
  }
  return { entries, diagnostics: [...new Set(diagnostics)] };
}
export function createSpaceTabs(options: Options) {
  const root = document.createElement('nav'); root.className = 'space-tabs'; root.hidden = true; root.setAttribute('aria-label', 'Space tabs');
  document.querySelector('.app-topbar')!.append(root);
  const emptyWorkspace = document.createElement('section'); emptyWorkspace.className = 'space-tabs-empty'; emptyWorkspace.hidden = true;
  emptyWorkspace.setAttribute('aria-label', 'Space tabs'); document.querySelector('.app')!.append(emptyWorkspace);
  const diagnostic = document.createElement('div'); diagnostic.className = 'defs-diagnostics'; diagnostic.hidden = true;
  document.querySelector('.editor-wrapper')!.prepend(diagnostic);
  const referenceDiagnostic = document.createElement('div'); referenceDiagnostic.className = 'defs-diagnostics'; referenceDiagnostic.hidden = true;
  document.querySelector('.editor-wrapper')!.prepend(referenceDiagnostic);
  let listing: Listing | null = null, active = '', defsProvider: any, defsDoc: any, defsText: any;
  let switching = false, refreshPending = false, generation = 0;
  const jiraPanel = createJiraPanel({ ...options,
    autostart: () => jiraViewOptions(defsText?.toString() || '').autostart,
    setAutostart: enabled => setJiraOption('autostart', enabled),
    showCache: () => {
    void setJiraVisible('cache', true).then(() => activate('jira:cache')).catch(error => options.notify(error.message, 'error'));
  } });
  function jiraTabs() {
    const source = defsText?.toString() || '';
    if (!parseSpaceJira(source).configured) return [];
    const flags = jiraViewOptions(source);
    return [{ id: 'jira:logs', name: 'JIRA', visible: flags.show_logs }, { id: 'jira:cache', name: 'JIRA Cache', visible: flags.show_cache }];
  }
  async function setJiraVisible(kind: string, visible: boolean) {
    await setJiraOption(kind === 'cache' ? 'show_cache' : 'show_logs', visible);
  }
  async function setJiraOption(property: 'autostart' | 'show_cache' | 'show_logs', visible: boolean) {
    if (!options.canEdit() || !defsProvider?.synced || !defsProvider?.wsconnected) throw new Error('Reconnect before changing Jira tabs.');
    const source = defsText.toString(), range = jiraMetadataRanges(source)[0];
    if (!range) return;
    const block = source.slice(range.start, range.end);
    const match = new RegExp(`^( +)${property}:.*$`, 'm').exec(block);
    const indent = /^ */.exec(block)![0] + '    ';
    const next = match ? block.replace(match[0], `${match[1]}${property}: ${visible}`) : block + (block.endsWith('\n') ? '' : '\n') + `${indent}${property}: ${visible}\n`;
    defsDoc.transact(() => { defsText.delete(range.start, range.end - range.start); defsText.insert(range.start, next); });
  }
  async function closeJiraTab(id: string) {
    await setJiraVisible(id.split(':')[1]!, false);
  }
  async function fallbackFromJira() {
    if (!active.startsWith('jira:') || jiraTabs().some(tab => tab.id === active && tab.visible)) return;
    const previous = active;
    active = ''; jiraPanel.hide();
    const next = (previous === 'jira:logs' ? jiraTabs().find(tab => tab.id === 'jira:cache' && tab.visible) : undefined) || jiraTabs().find(tab => tab.visible) || listing?.tabs.filter(tab => !tab.closed).at(-1);
    if (next) await activate(next.id); else { options.mode('empty'); render(); }
  }

  const referenceDocs = new Map<string, { tab: SpaceTab; document: any; observe: () => void }>();
  function clearReferences() {
    for (const item of referenceDocs.values()) item.document.text.unobserve(item.observe);
    referenceDocs.clear();
  }
  async function subscribeReferences() {
    if (!listing) return;
    const token = generation;
    for (const [id, item] of referenceDocs) {
      const tab = listing.tabs.find(t => t.id === id && t.kind === 'task');
      if (!tab) { item.document.text.unobserve(item.observe); referenceDocs.delete(id); }
      else item.tab = tab;
    }
    await Promise.all(listing.tabs.filter(t => t.kind === 'task' && !referenceDocs.has(t.id)).map(async tab => {
      const document = await options.acquire(tab.id);
      if (token !== generation) return;
      const observe = () => options.referencesChanged();
      referenceDocs.set(tab.id, { tab, document, observe }); document.text.observe(observe);
    }));
    options.referencesChanged();
  }
  function sourceDocuments(): ReferenceDocument[] {
    return [...referenceDocs.values()].map(item => ({ id: item.tab.id, name: item.tab.name, text: item.document.text.toString() }));
  }
  function editOrigin(origin: TaskOrigin, expected: string, value: string) {
    const item = referenceDocs.get(origin.documentId);
    if (!options.canEdit() || !item || item.document.text.toString() !== expected) throw new Error('The original task changed. Reopen it and retry.');
    if (!item.document.provider.wsconnected || !item.document.provider.synced) throw new Error('Reconnect to the original tab before editing this reference.');
    if (expected === value) return;
    let from = 0, end = 0;
    while (from < expected.length && from < value.length && expected[from] === value[from]) from++;
    while (end < expected.length - from && end < value.length - from && expected[expected.length - 1 - end] === value[value.length - 1 - end]) end++;
    item.document.undoManager.stopCapturing();
    item.document.ydoc.transact(() => {
      item.document.text.delete(from, expected.length - from - end);
      item.document.text.insert(from, value.slice(from, value.length - end));
    });
    item.document.undoManager.stopCapturing();
    const renamed = parseTasks(value).allTasks.find(task => task.lineIndex === origin.lineIndex);
    if (renamed && renamed.name !== origin.name) renameReferences(origin.tab, origin.name, origin.tab, renamed.name);
  }
  function renameReferences(tab: string, name: string, nextTab: string, nextName: string) {
    if (!options.canEdit()) return;
    for (const item of referenceDocs.values()) {
      const source = item.document.text.toString(), value = rewriteTaskReferences(source, tab, name, nextTab, nextName);
      if (source !== value) {
        item.document.undoManager.stopCapturing();
        item.document.ydoc.transact(() => { item.document.text.delete(0, source.length); item.document.text.insert(0, value); });
        item.document.undoManager.stopCapturing();
      }
    }
  }
  let contextMenu: HTMLElement | null = null, menuOwner: HTMLElement | null = null;
  let draggedTabId = '';
  let tabDrop: { id: string; after: boolean } | null = null;
  let dragRects: { id: string; left: number; right: number }[] = [], dragScrollStart = 0;
  let droppedTabPositions: Map<string, number> | null = null;
  const button = (label: string, action: () => any) => {
    const result = document.createElement('button'); result.type = 'button'; result.textContent = label;
    result.addEventListener('click', () => { Promise.resolve().then(action).catch(error => options.notify(error.message || String(error), 'error')); });
    return result;
  };
  function icon(name: string) {
    const element = document.createElement('i'); element.className = `fa-solid fa-${name}`;
    element.setAttribute('aria-hidden', 'true'); return element;
  }
  function iconButton(label: string, glyph: string, action: () => any) {
    const result = button('', action); result.append(icon(glyph));
    result.setAttribute('aria-label', label); result.title = label; return result;
  }
  function closeContextMenu(restoreFocus = false) {
    contextMenu?.remove(); contextMenu = null;
    menuOwner?.setAttribute('aria-expanded', 'false');
    if (restoreFocus && menuOwner?.isConnected) menuOwner.focus();
    menuOwner = null;
  }
  document.addEventListener('pointerdown', event => {
    if (contextMenu && !contextMenu.contains(event.target as Node)
      && !(contextMenu.classList.contains('space-tab-open-menu') && menuOwner?.contains(event.target as Node))) closeContextMenu();
  }, true);
  document.addEventListener('contextmenu', event => {
    if (!(event.target as Element).closest('.space-tab')) closeContextMenu();
  });
  window.addEventListener('resize', () => closeContextMenu());
  window.addEventListener('scroll', event => {
    if (contextMenu && !contextMenu.contains(event.target as Node)) closeContextMenu();
  }, true);
  function showContextMenu(tab: SpaceTab, owner: HTMLElement, x: number, y: number) {
    closeContextMenu();
    const menu = document.createElement('div'); menu.className = 'space-tab-context-menu';
    menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', `Options for ${tab.name}`);
    const action = (label: string, glyph: string, run: () => any, destructive = false) => {
      const item = button('', () => { closeContextMenu(true); return run(); });
      item.setAttribute('role', 'menuitem'); item.tabIndex = -1; item.disabled = !options.canEdit();
      const text = document.createElement('span'); text.textContent = label;
      item.append(icon(glyph), text); item.classList.toggle('destructive', destructive); menu.append(item);
    };
    const separator = () => { const line = document.createElement('div'); line.className = 'space-tab-menu-separator'; line.setAttribute('role', 'separator'); menu.append(line); };
    action('Appearance', 'palette', () => appearanceDialog(tab));
    if (tab.kind !== 'defs') {
      separator();
      action('Rename', 'pen-to-square', () => named('rename', tab));
      action('Copy', 'copy', () => named('copy', tab));
      const peers = listing!.tabs.filter(t => t.kind !== 'defs' && !t.closed), index = peers.indexOf(tab);
      if (index > 0) action('Move left', 'arrow-left', () => move(tab, peers[index - 1]!));
      if (index < peers.length - 1) action('Move right', 'arrow-right', () => move(tab, peers[index + 1]!));
    }
    separator();
    action('Close', 'xmark', () => mutate('close', tab));
    if (tab.kind !== 'defs') action('Delete', 'trash-can', () => {
      const { d, content, footer } = dialog(`Delete ${tab.name}?`);
      const message = document.createElement('p'); message.className = 'modal-help';
      message.textContent = 'This deletes the tab and its tasks. Close it instead to keep its contents.';
      content.append(message);
      const confirm = button('Delete', async () => { await mutate('delete', tab); d.close(); });
      confirm.className = 'toolbar-button danger'; footer.append(confirm);
      footer.querySelector<HTMLButtonElement>('button')?.focus();
    }, true);
    mountMenu(menu, owner, x, y);
  }
  function mountMenu(menu: HTMLElement, owner: HTMLElement, x: number, y: number) {
    contextMenu = menu; menuOwner = owner; owner.setAttribute('aria-expanded', 'true');
    document.body.append(menu);
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - bounds.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - bounds.height - 4))}px`;
    const items = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    menu.tabIndex = -1;
    (items[0] || menu).focus({ preventScroll: true });
    menu.addEventListener('keydown', event => {
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeContextMenu(true); }
      else if (event.key === 'Tab') closeContextMenu();
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && items.length) {
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]!.focus();
      }
    });
  }
  function showOpenTabs(owner: HTMLElement) {
    if (contextMenu && menuOwner === owner) { closeContextMenu(true); return; }
    closeContextMenu();
    const menu = document.createElement('div'); menu.className = 'space-tab-context-menu space-tab-open-menu';
    menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'Closed tabs');
    const closed = listing?.tabs.filter(tab => tab.closed) || [];
    for (const tab of closed) {
      const item = button('', () => reopenTab(tab));
      item.setAttribute('role', 'menuitem'); item.tabIndex = -1; item.disabled = !options.canEdit(); item.title = tab.filename;
      item.setAttribute('aria-label', `${tab.appearance.icon || ''} ${tab.name}`.trim());
      item.style.setProperty('--closed-tab-color', tab.appearance.color || 'var(--timeline-border)');
      const glyph = document.createElement('span'); glyph.className = 'space-tab-open-icon'; glyph.setAttribute('aria-hidden', 'true');
      if (tab.appearance.icon) glyph.textContent = tab.appearance.icon; else glyph.append(icon('file-lines'));
      const name = document.createElement('span'); name.className = 'space-tab-open-name'; name.textContent = tab.name;
      item.append(glyph, name); menu.append(item);
    }
    const closedJira = jiraTabs().filter(tab => !tab.visible);
    for (const tab of closedJira) {
      const item = button(tab.name, async () => { closeContextMenu(); await setJiraVisible(tab.id.split(':')[1]!, true); await activate(tab.id); });
      item.setAttribute('role', 'menuitem'); item.disabled = !options.canEdit(); menu.append(item);
    }
    if (!closed.length && !closedJira.length) {
      const empty = document.createElement('div'); empty.className = 'space-tab-menu-empty'; empty.textContent = 'No closed tabs.'; menu.append(empty);
    }
    const bounds = owner.getBoundingClientRect(); mountMenu(menu, owner, bounds.left, bounds.bottom + 4);
  }
  async function reopenTab(tab: SpaceTab) {
    closeContextMenu(); await mutate('open', tab); await activate(tab.id);
  }
  function renderEmptyWorkspace() {
    emptyWorkspace.replaceChildren();
    emptyWorkspace.hidden = !listing || listing.tabs.some(tab => !tab.closed) || jiraTabs().some(tab => tab.visible);
    if (emptyWorkspace.hidden || !listing) return;
    const card = document.createElement('div'); card.className = 'space-tabs-empty-card';
    const heading = document.createElement('h2'); heading.textContent = 'Open a tab';
    const tabs = document.createElement('div'); tabs.className = 'space-tabs-empty-list';
    for (const tab of listing.tabs) {
      const item = button('', () => reopenTab(tab)); item.className = 'space-tabs-empty-tab';
      item.setAttribute('aria-label', `Open ${tab.appearance.icon || ''} ${tab.name}`.replace(/ +/g, ' ').trim());
      item.disabled = !options.canEdit(); item.title = tab.filename;
      item.style.setProperty('--closed-tab-color', tab.appearance.color || 'var(--timeline-border)');
      const glyph = document.createElement('span'); glyph.className = 'space-tab-open-icon'; glyph.setAttribute('aria-hidden', 'true');
      if (tab.appearance.icon) glyph.textContent = tab.appearance.icon; else glyph.append(icon(tab.kind === 'defs' ? 'sliders' : 'file-lines'));
      const label = document.createElement('span'); label.className = 'space-tabs-empty-label';
      const name = document.createElement('span'); name.textContent = tab.name;
      const filename = document.createElement('small'); filename.textContent = tab.filename;
      label.append(name, filename);
      const open = icon('folder-open'); open.classList.add('space-tabs-empty-open');
      item.append(glyph, label, open); tabs.append(item);
    }
    for (const tab of jiraTabs()) {
      const item = button(tab.name, async () => { await setJiraVisible(tab.id.split(':')[1]!, true); await activate(tab.id); });
      item.className = 'space-tabs-empty-tab'; item.disabled = !options.canEdit(); tabs.append(item);
    }
    card.append(heading, tabs); emptyWorkspace.append(card);
  }
  async function request(path: string, body?: any) {
    const response = await fetch(options.base + path, { credentials: 'include', method: body ? 'POST' : 'GET', headers: { ...options.headers(), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : null });
    if (!response.ok) { const value = await response.json().catch(() => ({})); throw new Error(value.detail || `Request failed (${response.status}).`); }
    return response.json();
  }
  function saveView() {
    try { if (active) localStorage.setItem('tab-view:' + active, JSON.stringify(options.capture())); } catch { /* Storage may be unavailable or full. */ }
  }
  async function flush() {
    if (!active || active.startsWith('jira:') || !options.collab.ydoc) return;
    if (!options.collab.provider?.wsconnected || !options.collab.synced) throw new Error('Reconnect before switching or changing tabs; your edits are still local.');
    const { Y } = await options.modules();
    const update = Array.from(Y.encodeStateAsUpdate(options.collab.ydoc));
    await request(`/api/tab-spaces/${listing!.id}/flush`, { id: active, update });
  }
  async function activate(id: string) {
    if (switching || id === active) return;
    switching = true;
    try {
      await flush(); saveView();
      const tab = listing?.tabs.find(t => t.id === id && !t.closed);
      const jira = jiraTabs().find(tab => tab.id === id && tab.visible);
      if (jira) {
        options.disconnect(); active = id; options.mode('jira');
        localStorage.setItem('active-tab:' + listing!.id, id);
        jiraPanel.show(listing!.id, id === 'jira:cache'); render(); return;
      }
      if (!tab) return;
      jiraPanel.hide();
      active = id;
      options.mode(tab.kind);
      await options.connect(id);
      const definitions = defsText?.toString() || '';
      const plain = plainDefinitions(definitions);
      if (plain !== definitions && defsProvider?.synced && options.canEdit()) {
        defsDoc.transact(() => { defsText.delete(0, definitions.length); defsText.insert(0, plain); });
      }
      localStorage.setItem('active-tab:' + listing!.id, id);
      const saved = localStorage.getItem('tab-view:' + id);
      if (saved) { try { options.restore(JSON.parse(saved)); } catch { /* Ignore obsolete preferences. */ } }
      render();
    } finally { switching = false; }
  }
  async function apply(next: Listing) {
    const removed = listing?.tabs.filter(t => !next.tabs.some(n => n.id === t.id)) || [];
    const old = listing?.tabs.filter(t => !t.closed) || [];
    const index = old.findIndex(t => t.id === active);
    listing = next;
    await subscribeReferences();
    if (active && !active.startsWith('jira:') && !next.tabs.some(t => t.id === active && !t.closed)) {
      saveView(); active = ''; options.disconnect();
      const open = next.tabs.filter(t => !t.closed);
      if (open.length) await activate(open[Math.min(Math.max(index, 0), open.length - 1)]!.id);
      else options.mode('empty');
    }
    removed.forEach(tab => options.release(tab.id));
    render();
  }
  async function mutate(action: string, tab?: SpaceTab, extra = {}) {
    if (!listing || !options.canEdit()) return;
    await flush();
    const next: Listing = await request(`/api/tab-spaces/${listing.id}/tabs/${action}`, { revision: listing.revision, id: tab?.id, ...extra });
    await apply(next);
    if (next.created) await activate(next.created);
  }
  function dialog(title: string) {
    const d = document.createElement('dialog'); d.className = 'tab-dialog modal-card';
    const header = document.createElement('div'); header.className = 'modal-header';
    const heading = document.createElement('h2'); heading.textContent = title;
    heading.id = 'tab-dialog-title'; d.setAttribute('aria-labelledby', heading.id);
    const close = iconButton('Close', 'xmark', () => d.close()); close.className = 'toolbar-icon';
    header.append(heading, close);
    const content = document.createElement('div'); content.className = 'tab-dialog-content modal-body';
    const footer = document.createElement('div'); footer.className = 'modal-actions';
    const cancel = button('Cancel', () => d.close()); cancel.className = 'toolbar-button'; footer.append(cancel);
    d.append(header, content, footer);
    d.addEventListener('close', () => d.remove()); document.body.append(d); d.showModal();
    return { d, content, footer };
  }
  function named(action: 'add' | 'rename' | 'copy', tab?: SpaceTab) {
    const { d, content, footer } = dialog(action === 'add' ? 'Add tab' : action === 'copy' ? 'Copy tab' : 'Rename tab');
    const fieldName = action === 'copy' ? 'Copy name' : action === 'rename' ? 'New tab name' : 'Tab name';
    const input = document.createElement('input'); input.type = 'text'; input.setAttribute('aria-label', fieldName); input.pattern = '[A-Za-z0-9_-]+'; input.required = true;
    input.value = action === 'copy' ? tab!.name + '_copy' : action === 'rename' ? tab!.name : '';
    const field = document.createElement('label'); field.className = 'modal-field'; field.textContent = fieldName; field.append(input);
    input.placeholder = 'e.g. release'; input.autocomplete = 'off'; input.spellcheck = false;
    const help = document.createElement('p'); help.className = 'modal-help'; help.id = 'tab-name-help';
    help.textContent = 'Letters, digits, underscores and hyphens only.'; input.setAttribute('aria-describedby', help.id);
    const submit = async () => {
      if (!input.reportValidity()) return;
      await mutate(action, tab, { name: input.value }); d.close();
    };
    if (tab) {
      const context = document.createElement('p'); context.className = 'modal-help';
      context.textContent = action === 'copy' ? 'Create a copy of “' + tab.name + '”.' : 'Rename “' + tab.name + '”.';
      content.append(context);
    }
    const save = button(action === 'add' ? 'Create' : action === 'copy' ? 'Copy' : 'Rename', submit); save.className = 'toolbar-button success';
    content.append(field, help); footer.append(save);
    input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void submit().catch(error => options.notify(error.message, 'error')); } }); input.focus(); input.select();
  }
  function appearanceDialog(tab: SpaceTab) {
    const { d, content, footer } = dialog('Tab appearance');
    d.classList.add('tab-appearance-dialog');
    footer.querySelector('button')!.remove();
    let selectedIcon = tab.appearance.icon || '', selectedColor = tab.appearance.color || '';
    let customDirty = false, pending = Promise.resolve();
    const help = document.createElement('p'); help.className = 'modal-help';
    help.textContent = 'Choose an icon and color for ' + tab.name + '. Changes save immediately.';
    const preview = document.createElement('div'); preview.className = 'tab-color-preview';
    const sample = document.createElement('span'); sample.className = 'tab-color-preview-tab'; preview.append(sample);
    const heading = (title: string) => { const h = document.createElement('h3'); h.className = 'tab-appearance-heading'; h.textContent = title; return h; };
    const choices = document.createElement('div'); choices.className = 'slug-color-swatches'; choices.setAttribute('role', 'group'); choices.setAttribute('aria-label', 'Tab color choices');
    const field = document.createElement('label'); field.className = 'modal-field'; field.textContent = 'Color';
    const controls = document.createElement('div'); controls.className = 'slug-color-controls';
    const picker = document.createElement('input'); picker.type = 'color'; picker.className = 'slug-color-picker';
    picker.value = selectedColor || '#cfe8ff'; picker.setAttribute('aria-label', 'Custom tab color');
    const valueInput = document.createElement('input'); valueInput.type = 'hidden';
    const auto = document.createElement('button'); auto.type = 'button'; auto.className = 'toolbar-button'; auto.textContent = 'Auto';
    const colorPreview = document.createElement('span'); colorPreview.className = 'slug-color-preview';
    const updatePreview = () => {
      sample.textContent = `${selectedIcon} ${tab.name}`.trim();
      sample.style.setProperty('--tab-preview-color', (customDirty ? normalizeHexColorValue(valueInput.value) : selectedColor) || 'var(--timeline-border)');
    };
    const set = (kind: 'icon' | 'color', value: string) => {
      const save = pending.then(async () => {
        await mutate('appearance', tab, { appearance: { [kind]: value } });
        if (kind === 'icon') selectedIcon = value;
        else { selectedColor = value; customDirty = false; colorUi.setColorValue(value); }
        content.querySelectorAll<HTMLButtonElement>(`[data-appearance-kind="${kind}"]`).forEach(item => item.setAttribute('aria-pressed', String(item.dataset['value'] === value)));
        updatePreview();
      });
      pending = save.catch(() => {});
      return save;
    };
    const mark = (item: HTMLButtonElement, kind: 'icon' | 'color', value: string) => {
      item.dataset['appearanceKind'] = kind; item.dataset['value'] = value;
      item.setAttribute('aria-pressed', String((kind === 'icon' ? selectedIcon : selectedColor).toLowerCase() === value.toLowerCase()));
    };
    const colorUi = createSlugColorControls({ slugRenameColor: valueInput, slugRenameColorPicker: picker,
      slugRenameColorSwatches: choices, slugRenameColorClear: auto, slugRenameColorPreview: colorPreview }, document,
      (value, commit) => { customDirty = true; updatePreview(); if (commit) void set('color', value).catch(error => options.notify(error.message, 'error')); });
    colorUi.bindControls(); colorUi.setColorValue(selectedColor);
    const applyCustom = async () => {
      if (!customDirty) return true;
      const color = normalizeHexColorValue(valueInput.value);
      await set('color', color); return true;
    };
    const saveCustom = () => { void applyCustom().catch(error => options.notify(error.message, 'error')); };
    picker.addEventListener('change', saveCustom);
    const done = button('Done', async () => { await pending; if (await applyCustom()) d.close(); }); done.className = 'toolbar-button primary'; footer.append(done);
    controls.append(picker, auto, colorPreview); field.append(valueInput, choices, controls);
    content.append(help, preview, field, heading('Icon'));
    const icons = document.createElement('div'); icons.className = 'tab-icon-choices'; icons.setAttribute('role', 'group'); icons.setAttribute('aria-label', 'Tab icons');
    const choice = (emoji: string, name: string) => {
      const item = button(emoji, () => set('icon', emoji)); item.className = 'tab-icon-choice';
      item.setAttribute('aria-label', name); item.title = name; mark(item, 'icon', emoji);
      if (!emoji) item.classList.add('is-empty'); icons.append(item);
    };
    choice('', 'No icon');
    for (const group of EMOJI_GROUPS) for (const [emoji, name] of group.icons) choice(emoji!, name!);
    content.append(icons);
    updatePreview();
  }
  async function move(tab: SpaceTab, target: SpaceTab, after?: boolean) {
    const ids = listing!.tabs.filter(t => !t.closed && t.kind !== 'defs').map(t => t.id);
    const from = ids.indexOf(tab.id), to = ids.indexOf(target.id);
    if (from < 0 || to < 0 || from === to) return;
    const insertAfter = after ?? from < to;
    ids.splice(from, 1); ids.splice(ids.indexOf(target.id) + (insertAfter ? 1 : 0), 0, tab.id);
    await mutate('reorder', tab, { ids });
  }
  function clearTabDrop() {
    tabDrop = null;
    root.querySelectorAll<HTMLElement>('.space-tab').forEach(item => {
      item.style.removeProperty('--tab-drag-shift');
    });
    root.querySelector<HTMLElement>('.space-tab-drop-gap')?.setAttribute('hidden', '');
  }
  function endTabDrag() {
    clearTabDrop(); draggedTabId = ''; dragRects = [];
    root.querySelector('.space-tab-list')?.classList.remove('tab-dragging');
    root.querySelectorAll('.space-tab.dragging').forEach(item => item.classList.remove('dragging'));
  }
  function previewTabDrop(event: DragEvent, tabs: HTMLElement, gap: HTMLElement) {
    if (!draggedTabId || !event.dataTransfer?.types.includes('application/x-space-tab') || !options.canEdit()) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'move';
    const scroll = dragScrollStart - tabs.scrollLeft;
    // Use positions captured before the preview shifts tabs so the target remains
    // stable while the pointer crosses the animated gap.
    const x = event.clientX - scroll;
    if (!dragRects.length) { clearTabDrop(); return; }
    const target = dragRects.find(rect => x <= rect.right) || dragRects[dragRects.length - 1]!;
    if (target.id === draggedTabId) { clearTabDrop(); return; }
    const after = x >= (target.left + target.right) / 2;
    const sourceIndex = dragRects.findIndex(rect => rect.id === draggedTabId);
    const insertion = dragRects.indexOf(target) + (after ? 1 : 0);
    if (insertion - (sourceIndex < insertion ? 1 : 0) === sourceIndex) { clearTabDrop(); return; }
    tabDrop = { id: target.id, after };
    root.querySelectorAll<HTMLElement>('.space-tab').forEach(item => {
      const index = dragRects.findIndex(rect => rect.id === item.dataset['tabId']);
      item.style.setProperty('--tab-drag-shift', index >= insertion ? '18px' : '0px');
    });
    const boundary = after ? target.right : target.left;
    gap.style.left = `${boundary + scroll - tabs.getBoundingClientRect().left + tabs.scrollLeft + 3}px`;
    gap.hidden = false;
  }
  function render() {
    const previousTabs = [...root.querySelectorAll<HTMLElement>('.space-tab')];
    const previousOrder = previousTabs.map(item => item.dataset['tabId']).join('|');
    const wasAnimating = previousTabs.some(item => item.getAnimations().some(animation => animation.id === 'tab-reorder'));
    const previousPositions = droppedTabPositions || new Map(previousTabs.map(item => [item.dataset['tabId']!, item.getBoundingClientRect().left]));
    endTabDrag();
    closeContextMenu();
    root.replaceChildren(); root.hidden = !listing;
    renderEmptyWorkspace();
    document.querySelector('.app')?.classList.toggle('has-space-tabs', Boolean(listing));
    if (!listing) { options.layout(); return; }
    const open = iconButton('Open', 'folder-open', () => showOpenTabs(open));
    open.setAttribute('aria-haspopup', 'menu'); open.setAttribute('aria-expanded', 'false');
    open.addEventListener('keydown', event => { if (event.key === 'ArrowDown') { event.preventDefault(); showOpenTabs(open); } });
    const add = iconButton('Add', 'plus', () => named('add')); open.className = add.className = 'space-tab-tool'; open.disabled = add.disabled = !options.canEdit(); root.append(open, add);
    const tabs = document.createElement('div'); tabs.className = 'space-tab-list'; tabs.setAttribute('role', 'tablist'); root.append(tabs);
    const gap = document.createElement('span'); gap.className = 'space-tab-drop-gap'; gap.hidden = true; gap.setAttribute('aria-hidden', 'true');
    tabs.addEventListener('dragover', event => previewTabDrop(event, tabs, gap));
    tabs.addEventListener('dragleave', event => { if (!tabs.contains(event.relatedTarget as Node)) clearTabDrop(); });
    tabs.addEventListener('drop', event => {
      previewTabDrop(event, tabs, gap);
      const placement = tabDrop, from = listing?.tabs.find(tab => tab.id === draggedTabId);
      const target = listing?.tabs.find(tab => tab.id === placement?.id);
      if (from && target && placement) {
        droppedTabPositions = new Map([...tabs.querySelectorAll<HTMLElement>('.space-tab')].map(item => [item.dataset['tabId']!, item.getBoundingClientRect().left]));
      }
      endTabDrag();
      if (from && target && placement) { event.preventDefault(); void move(from, target, placement.after).catch(error => { droppedTabPositions = null; options.notify(error.message, 'error'); }); }
    });
    for (const tab of listing.tabs.filter(t => !t.closed)) {
      const item = document.createElement('div'); item.className = 'space-tab'; item.dataset['tabId'] = tab.id; item.dataset['kind'] = tab.kind; item.classList.toggle('active', tab.id === active);
      const color = tab.appearance.color;
      if (color && /^#[\da-f]{6}$/i.test(color)) {
        item.style.setProperty('--tab-color', color);
        item.style.setProperty('--tab-accent', color);
      }
      const select = button(`${tab.appearance.icon || ''} ${tab.name}`, () => activate(tab.id)); select.setAttribute('role', 'tab'); select.setAttribute('aria-selected', String(tab.id === active)); select.title = tab.filename;
      select.className = 'space-tab-select'; select.setAttribute('aria-haspopup', 'menu'); select.setAttribute('aria-expanded', 'false');
      const close = iconButton(`Close ${tab.name}`, 'xmark', () => mutate('close', tab));
      close.className = 'space-tab-close'; close.disabled = !options.canEdit(); close.draggable = false;
      close.addEventListener('dragstart', event => event.preventDefault());
      item.append(select, close);
      item.addEventListener('contextmenu', event => { event.preventDefault(); showContextMenu(tab, select, event.clientX, event.clientY); });
      select.addEventListener('keydown', event => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault(); const bounds = select.getBoundingClientRect();
          showContextMenu(tab, select, bounds.left, bounds.bottom);
        }
      });
      if (tab.kind !== 'defs') {
        item.draggable = options.canEdit();
        item.addEventListener('dragstart', event => {
          if (event.defaultPrevented || !event.dataTransfer) return;
          closeContextMenu(); endTabDrag(); draggedTabId = tab.id;
          tabs.querySelectorAll<HTMLElement>('.space-tab').forEach(element => element.getAnimations().forEach(animation => animation.finish()));
          item.classList.add('dragging'); tabs.classList.add('tab-dragging'); dragScrollStart = tabs.scrollLeft;
          dragRects = [...tabs.querySelectorAll<HTMLElement>('.space-tab[data-kind="task"]')].map(element => {
            const bounds = element.getBoundingClientRect(); return { id: element.dataset['tabId']!, left: bounds.left, right: bounds.right };
          });
          event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-space-tab', tab.id);
        });
        item.addEventListener('dragend', endTabDrag);
      }
      tabs.append(item);
    }
    tabs.append(gap);
    for (const tab of jiraTabs().filter(tab => tab.visible)) {
      const item = document.createElement('div'); item.className = 'space-tab'; item.classList.toggle('active', active === tab.id);
      const select = button(tab.name, () => activate(tab.id)); select.className = 'space-tab-select'; select.setAttribute('role', 'tab'); select.setAttribute('aria-selected', String(active === tab.id));
      const close = iconButton(`Close ${tab.name}`, 'xmark', () => closeJiraTab(tab.id)); close.className = 'space-tab-close'; close.disabled = !options.canEdit();
      item.append(select, close); tabs.append(item);
    }
    diagnostic.hidden = !diagnostic.textContent || listing.tabs.find(t => t.id === active)?.kind !== 'defs';
    options.layout();
    const nextTabs = [...tabs.querySelectorAll<HTMLElement>('.space-tab')];
    if (wasAnimating || previousOrder !== nextTabs.map(item => item.dataset['tabId']).join('|')) {
      droppedTabPositions = null;
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        for (const item of nextTabs) {
          const oldLeft = previousPositions.get(item.dataset['tabId']!);
          if (oldLeft === undefined) continue;
          const offset = oldLeft - item.getBoundingClientRect().left;
          if (Math.abs(offset) < 1) continue;
          const animation = item.animate([{ transform: `translateX(${offset}px)` }, { transform: 'translateX(0)' }], { duration: 220, easing: 'ease-out' });
          animation.id = 'tab-reorder';
        }
      }
    }
  }
  function definitionsChanged() {
    jiraPanel.updateAutostart();
    const text = defsText?.toString() || '';
    options.definitions(text);
    const { entries, diagnostics } = parseTabAppearance(text);
    diagnostic.textContent = [...diagnostics, ...parseSpaceJira(text).diagnostics].join(' ');
    listing?.tabs.forEach(tab => { tab.appearance = entries[tab.name] || {}; }); render();
    if (!switching) void fallbackFromJira();
  }
  async function openSpace(ref: string) {
    const next: Listing = await request('/api/tab-spaces?ref=' + encodeURIComponent(ref));
    await flush(); saveView(); generation++;
    clearReferences(); jiraPanel.hide(); defsProvider?.destroy(); defsDoc?.destroy(); active = ''; listing = next;
    const { Y, WebsocketProvider } = await options.modules();
    defsDoc = new Y.Doc(); const params: Record<string, string> = {};
    if (options.collab.username && options.collab.authToken) { params["user"] = options.collab.username; params["pass"] = options.collab.authToken; }
    defsProvider = new WebsocketProvider(options.wsBase, next.tabs.find(t => t.kind === 'defs')!.id, defsDoc, { params });
    defsText = defsDoc.getText('content'); defsText.observe(definitionsChanged);
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Could not load shared definitions.')), 15000); const synced = (value: boolean) => { if (value) { clearTimeout(timer); defsProvider.off('sync', synced); resolve(); } }; defsProvider.on('sync', synced); if (defsProvider.synced) synced(true); });
    definitionsChanged();
    await subscribeReferences();
    const preferred = localStorage.getItem('active-tab:' + next.id);
    const tab = next.tabs.find(t => !t.closed && (t.id === ref || t.id === preferred)) || next.tabs.find(t => !t.closed && t.kind === 'task') || next.tabs.find(t => !t.closed);
    if (preferred && jiraTabs().some(tab => tab.id === preferred && tab.visible)) await activate(preferred);
    else if (tab) await activate(tab.id); else { options.disconnect(); options.mode('empty'); render(); }
  }
  async function refresh() {
    if (!listing || switching || refreshPending) return;
    refreshPending = true; const token = generation;
    try { const next = await request('/api/tab-spaces?ref=' + listing.id); if (token === generation && next.revision !== listing?.revision) await apply(next); }
    catch (error) { /* Reconnect retains local edits; explicit operations surface errors. */ }
    finally { refreshPending = false; }
  }
  window.addEventListener('space-tabs-changed', () => void refresh());
  window.setInterval(() => void refresh(), 3000);
  window.addEventListener('beforeunload', saveView);
  return {
    async openDocument(id: string) {
      const tab = listing?.tabs.find(tab => tab.id === id);
      if (!tab) throw new Error('The source tab is no longer available.');
      if (tab.closed) {
        if (!options.canEdit()) throw new Error('Ask a space editor to reopen the source tab.');
        await reopenTab(tab);
      } else await activate(id);
      if (active !== id) throw new Error('The source tab could not be opened. Try again.');
    },
    openSpace, flush, refresh, render, activate, editOrigin, sourceDocuments, renameReferences,
    showReferenceDiagnostics(messages: string[]) { referenceDiagnostic.textContent = messages.join(' '); referenceDiagnostic.hidden = !messages.length; },
    async createTaskTab(name: string) {
      if (!listing || !options.canEdit()) throw new Error('Connect to an editable space first.');
      await flush();
      const next: Listing = await request(`/api/tab-spaces/${listing.id}/tabs/add`, { revision: listing.revision, name });
      await apply(next);
      return next.tabs.find(tab => tab.id === next.created)!;
    },
    async importTasks(origins: TaskOrigin[], mode: 'move' | 'reference' | 'reference-only', parentLine?: number, expectedTarget?: string, leaveReference = false, prepare?: (source: string, line: number) => string) {
      if (!listing || !active || !options.canEdit()) return;
      await flush();
      const documents = sourceDocuments();
      if (expectedTarget !== undefined && documents.find(doc => doc.id === active)?.text !== expectedTarget) throw new Error('The destination changed. Reopen the menu and try again.');
      const changes = importTaskSelection(documents, origins, active, mode, parentLine, leaveReference, prepare);
      await request(`/api/tab-spaces/${listing.id}/documents`, { changes });
    },
    async transfer(origin: TaskOrigin, mode: 'move' | 'reference' | 'reference-only', line: number, prepare?: (source: string, line: number) => string, destinationId = active, leaveReference = false) {
      if (!listing || !options.canEdit() || !active) return;
      if (origin.documentId === destinationId) throw new Error('The original task is already in this tab.');
      await flush();
      const documents = sourceDocuments(), source = documents.find(doc => doc.id === origin.documentId), destination = documents.find(doc => doc.id === destinationId);
      if (!source || !destination || source.text !== origin.source) throw new Error('The original task changed while dragging. Retry the drag.');
      const updatedSource = prepare ? prepare(source.text, origin.lineIndex) : source.text;
      const result = transferTask(updatedSource, origin.lineIndex, destination.text, line, source.name, mode, leaveReference ? destination.name : undefined);
      const changes = documents.map(doc => {
        let text = doc.id === destinationId ? result.destination : doc.id === source.id ? result.source : doc.text;
        if (mode === 'move') for (const name of result.names) text = rewriteTaskReferences(text, source.name, name, destination.name, name);
        return { id: doc.id, expected: doc.text, text };
      }).filter(doc => doc.expected !== doc.text);
      await request(`/api/tab-spaces/${listing.id}/documents`, { changes });
    },
    async saveShared(change: any, moveLocal = false) {
      if (!listing) throw new Error("Connect to a space first.");
      await flush();
      const snapshot = await request(`/api/tab-spaces/${listing.id}/contents`);
      const changes = snapshot.documents.map((doc: any) => {
        const parsed = parseTasks(doc.text);
        const section = change.kind === "tag" ? "tags" : change.kind === "person" ? "people" : "states";
        if (change.oldSlug !== change.newSlug && ((parsed.config as any)[section].some((entry: any) => entry.key === change.newSlug) || replaceSlugTokenOccurrences(doc.text, change.prefix + change.newSlug, change.prefix + change.newSlug).count > 0)) throw new Error(`The slug ${change.newSlug} already exists in a tab.`);
        const result = renameSlugInWholeFile(doc.text, doc.kind === "defs" ? change : { ...change, metadata: undefined });
        if (moveLocal && doc.id === active && doc.kind === 'task') result.text = removeSlugDefinition(result.text, change.kind, change.newSlug);
        return { id: doc.id, expected: doc.text, text: result.text };
      }).filter((doc: any) => doc.expected !== doc.text);
      await request(`/api/tab-spaces/${listing.id}/definitions`, { changes });
    },
    get space() { return listing; },
    get active() { return listing?.tabs.find(t => t.id === active); },
    get definitions() { return defsText?.toString() || ''; },
    disconnect() { jiraPanel.hide(); generation++; saveView(); clearReferences(); defsProvider?.destroy(); defsDoc?.destroy(); defsText = null; listing = null; active = ''; options.definitions(''); options.mode('task'); render(); },
  };
}
