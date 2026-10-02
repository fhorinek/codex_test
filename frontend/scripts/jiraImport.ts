import type { JiraSuggestion } from './taskJiraLink.js';
export type JiraImportContext = { space: string; document: string; source: string; definitions: string };
export type JiraImportPreview = { key: string; subtask_count: number; script: string; tasks: any[]; definitions: any[] };
export function createJiraImport(options: {
  isLinked: (key: string) => boolean;
  context: () => JiraImportContext; projects: () => JiraSuggestion[];
  issues: (query: string, signal: AbortSignal) => Promise<JiraSuggestion[]>;
  preview: (context: JiraImportContext, key: string, children: boolean, signal: AbortSignal) => Promise<JiraImportPreview>;
  render: (host: HTMLElement, data: JiraImportPreview) => void;
  commit: (data: JiraImportPreview, context: JiraImportContext) => void; canEdit: () => boolean;
}) {
  const dialog = document.createElement('dialog'); dialog.className = 'modal-card tab-dialog jira-import-dialog';
  dialog.setAttribute('aria-label', 'Add task from JIRA');
  const header = document.createElement('div'); header.className = 'modal-header';
  const heading = document.createElement('h2'); heading.textContent = 'Add task from JIRA'; header.append(heading);
  const body = document.createElement('div'); body.className = 'modal-body';
  const editor = document.createElement('div'); editor.className = 'task-edit-jira-editor';
  const field = document.createElement('label'); field.className = 'modal-field'; field.append(document.createTextNode('Jira issue key'));
  const input = document.createElement('input'); input.autocomplete = 'off'; input.spellcheck = false; input.placeholder = 'PROJECT-123';
  input.setAttribute('role', 'combobox'); input.setAttribute('aria-label', 'Jira issue key'); input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('aria-controls', 'jira-import-options');
  const list = document.createElement('div'); list.className = 'task-edit-jira-options'; list.id = 'jira-import-options'; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', 'Jira suggestions'); list.hidden = true;
  field.append(input); editor.append(field, list);
  const status = document.createElement('p'); status.className = 'modal-help'; status.setAttribute('role', 'status');
  const childrenLabel = document.createElement('label'); childrenLabel.className = 'jira-import-children'; childrenLabel.hidden = true;
  const children = document.createElement('input'); children.type = 'checkbox'; const childrenText = document.createElement('span'); childrenLabel.append(children, childrenText);
  const preview = document.createElement('div'); preview.className = 'task-edit-preview jira-import-preview';
  body.append(editor, status, childrenLabel, preview);
  const actions = document.createElement('div'); actions.className = 'modal-actions';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'toolbar-button'; cancel.textContent = 'Cancel'; cancel.onclick = () => dialog.close();
  const add = document.createElement('button'); add.type = 'button'; add.className = 'toolbar-button success'; add.textContent = 'Import task'; add.disabled = true;
  actions.append(cancel, add); dialog.append(header, body, actions); document.body.append(dialog);
  let version = 0, lookup: AbortController | undefined, suggestionsRequest: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let data: JiraImportPreview | null = null, snapshot: JiraImportContext | null = null, suggestions: JiraSuggestion[] = [], active = -1;
  function stop() { version++; lookup?.abort(); suggestionsRequest?.abort(); clearTimeout(timer); }
  function showSuggestions() {
    list.replaceChildren(); list.hidden = !suggestions.length;
    input.setAttribute('aria-expanded', String(!list.hidden));
    if (active >= 0) input.setAttribute('aria-activedescendant', `jira-import-option-${active}`); else input.removeAttribute('aria-activedescendant');
    suggestions.forEach((item, index) => {
      const option = document.createElement('button'); option.type = 'button'; option.className = 'pill'; option.id = `jira-import-option-${index}`;
      option.setAttribute('role', 'option'); option.setAttribute('aria-selected', String(active === index)); option.tabIndex = -1;
      option.append(document.createTextNode(item.key));
      if (item.name && item.name !== item.key) { const summary = document.createElement('small'); summary.textContent = item.name; option.append(summary); }
      option.onclick = () => { input.value = item.key.includes('-') ? item.key : item.key + '-'; children.checked = false; update(); suggestions = []; showSuggestions(); input.focus(); }; list.append(option);
    });
  }
  async function load(key: string, token: number) {
    data = null; snapshot = options.context(); add.disabled = true; preview.replaceChildren();
    if (options.isLinked(key)) { childrenLabel.hidden = true; status.textContent = `${key} is already linked in this space.`; return; }
    status.textContent = 'Loading Jira task…'; lookup = new AbortController();
    try {
      const result = await options.preview(snapshot, key, children.checked, lookup.signal);
      if (token !== version || !dialog.open) return;
      data = result; childrenLabel.hidden = result.subtask_count === 0;
      childrenText.textContent = `Also import ${result.subtask_count} subtasks`;
      options.render(preview, result); status.textContent = ''; add.disabled = !options.canEdit();
    } catch (error: any) { if (token === version && error.name !== 'AbortError') status.textContent = error.message; }
  }
  function update(resetChildren = true) {
    stop(); const token = version; input.value = input.value.toUpperCase(); const query = input.value.trim();
    data = null; add.disabled = true; preview.replaceChildren(); active = -1;
    if (resetChildren) { children.checked = false; childrenLabel.hidden = true; }
    suggestions = []; status.textContent = 'Enter a full issue key, such as PROJECT-123.';
    if (!query.includes('-')) suggestions = options.projects().filter(item => item.key.startsWith(query));
    else if (/^[A-Z][A-Z0-9]*-\d*$/.test(query)) {
      timer = setTimeout(async () => {
        suggestionsRequest = new AbortController();
        try { const result = await options.issues(query, suggestionsRequest.signal); if (token === version && dialog.open) { suggestions = result.filter(item => !options.isLinked(item.key)); if (document.activeElement === input) showSuggestions(); } }
        catch { /* A valid exact key can still be looked up without suggestions. */ }
      }, 250);
    }
    showSuggestions();
    if (/^[A-Z][A-Z0-9]*-[1-9]\d*$/.test(query)) void load(query, token);
  }
  input.oninput = () => update();
  input.onfocus = () => { if (suggestions.length) showSuggestions(); };
  children.onchange = () => update(false);
  input.onkeydown = event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); if (suggestions.length) { active = (active + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length; showSuggestions(); }
    } else if (event.key === 'Enter') { event.preventDefault(); if (active >= 0) list.querySelectorAll<HTMLButtonElement>('button')[active]?.click(); else update(false); }
    else if (event.key === 'Escape' && !list.hidden) { event.preventDefault(); event.stopPropagation(); suggestions = []; showSuggestions(); }
  };
  document.addEventListener('pointerdown', event => { if (!editor.contains(event.target as Node)) { suggestions = []; showSuggestions(); } });
  dialog.addEventListener('close', () => { stop(); data = null; preview.replaceChildren(); });
  add.onclick = () => {
    if (!data || !snapshot || !options.canEdit()) return;
    try {
      const linked = data.tasks.find(task => options.isLinked(task.key));
      if (linked) throw new Error(`${linked.key} is already linked in this space.`);
      options.commit(data, snapshot); dialog.close();
    }
    catch (error: any) { status.textContent = error.message; add.disabled = true; }
  };
  return { open() { if (!options.canEdit()) return; input.value = ''; children.checked = false; dialog.showModal(); update(); input.focus(); } };
}
