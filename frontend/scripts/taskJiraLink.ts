export type JiraSuggestion = { key: string; name?: string };

export function createTaskJiraLink(host: HTMLElement, options: {
  projects: () => JiraSuggestion[];
  issues: (query: string, signal: AbortSignal) => Promise<JiraSuggestion[]>;
  changed: (key: string) => void;
}) {
  const link = document.createElement('button'); link.type = 'button'; link.className = 'pill'; link.textContent = 'Link Jira';
  const linked = document.createElement('span'); linked.className = 'task-edit-jira-linked';
  const keyLabel = document.createElement('span'); keyLabel.className = 'pill jira-pill';
  const unlink = document.createElement('button'); unlink.type = 'button'; unlink.className = 'toolbar-icon task-edit-jira-unlink'; unlink.textContent = '×'; unlink.setAttribute('aria-label', 'Unlink Jira'); unlink.title = 'Unlink Jira';
  linked.append(keyLabel, unlink);
  const field = document.createElement('label'); field.className = 'modal-field task-edit-jira-field';
  const input = document.createElement('input'); input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false; input.placeholder = 'PROJECT or PROJECT-123';
  input.setAttribute('aria-label', 'Jira key'); input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('aria-controls', 'task-edit-jira-options');
  field.append(input);
  const list = document.createElement('div'); list.id = 'task-edit-jira-options'; list.className = 'task-edit-jira-options'; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', 'Jira suggestions');
  const status = document.createElement('p'); status.className = 'modal-help task-edit-jira-status'; status.setAttribute('aria-live', 'polite');
  host.append(link, linked, field, list, status);
  let value = '', entering = false, suggestions: JiraSuggestion[] = [], active = -1, version = 0;
  let timer: ReturnType<typeof setTimeout> | undefined, request: AbortController | undefined;
  const stop = () => { version++; clearTimeout(timer); request?.abort(); };
  const render = () => {
    link.hidden = entering || Boolean(value); linked.hidden = entering || !value; field.hidden = !entering;
    keyLabel.textContent = value; list.hidden = !entering || !suggestions.length;
    status.hidden = !entering || !status.textContent;
    input.setAttribute('aria-expanded', String(!list.hidden));
    if (active >= 0) input.setAttribute('aria-activedescendant', `task-edit-jira-option-${active}`); else input.removeAttribute('aria-activedescendant');
    list.replaceChildren();
    suggestions.forEach((item, index) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'pill'; button.id = `task-edit-jira-option-${index}`; button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(active === index));
      button.append(document.createTextNode(item.key));
      if (item.name && item.name !== item.key) { const summary = document.createElement('small'); summary.textContent = item.name; button.append(summary); }
      button.onclick = () => choose(item); list.append(button);
    });
  };
  const set = (key: string, notify = false) => {
    stop(); value = key.trim().toUpperCase(); entering = false; suggestions = []; active = -1; input.value = value; status.textContent = ''; input.setCustomValidity(''); render();
    if (notify) options.changed(value);
  };
  function choose(item: JiraSuggestion) {
    if (!item.key.includes('-')) { input.value = item.key; update(); input.focus(); }
    else set(item.key, true);
  }
  function update() {
    stop(); active = -1; input.setCustomValidity(''); status.textContent = '';
    input.value = input.value.toUpperCase();
    const query = input.value.trim();
    if (!query.includes('-')) {
      suggestions = options.projects().filter(project => project.key.startsWith(query));
      if (!suggestions.length) status.textContent = 'Type a project key, then - to look up issues.';
      render(); return;
    }
    suggestions = []; render();
    if (!/^[A-Z][A-Z0-9]+-\d*$/.test(query)) { status.textContent = 'Use PROJECT-123 for an issue key.'; render(); return; }
    const current = version;
    status.textContent = 'Looking up Jira issues…'; render();
    timer = setTimeout(async () => {
      request = new AbortController();
      try {
        const result = await options.issues(query, request.signal);
        if (current !== version) return;
        suggestions = result; status.textContent = result.length ? '' : 'No matching issues. You can enter a key manually.';
      } catch (error: any) {
        if (current !== version || error.name === 'AbortError') return;
        status.textContent = 'Jira suggestions unavailable. You can enter a key manually.';
      }
      render();
    }, 250);
  }
  function commit() {
    if (!entering) return true;
    const key = input.value.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9]+(?:-\d+)?$/.test(key)) {
      input.setCustomValidity('Enter a project key or an issue key such as PROJECT-123.'); input.reportValidity(); return false;
    }
    set(key, true); return true;
  }
  link.onclick = () => { entering = true; input.value = ''; update(); input.focus(); };
  unlink.onclick = () => { set('', true); link.focus(); };
  input.oninput = update;
  input.onkeydown = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); set(value); link.hidden ? unlink.focus() : link.focus(); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); if (suggestions.length) { active = (active + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length; render(); }
    } else if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); if (active >= 0 && suggestions[active]) choose(suggestions[active]!); else commit(); }
  };
  set('');
  return { set, commit };
}
