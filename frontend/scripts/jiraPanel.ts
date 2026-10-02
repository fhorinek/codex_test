/** Read-only space-local daemon logs and cache, with authenticated controls. */
export function createJiraPanel(options: {
  base: string; headers: () => Record<string, string>; canEdit: () => boolean;
  notify: (message: string, kind?: string) => void; showCache: () => void;
}) {
  const panel = document.createElement('section'); panel.className = 'jira-panel'; panel.hidden = true;
  panel.setAttribute('aria-label', 'JIRA daemon'); document.querySelector('.app')!.append(panel);
  const toolbar = document.createElement('div'); toolbar.className = 'jira-panel-toolbar';
  const status = document.createElement('span'); status.className = 'jira-daemon-state'; status.setAttribute('role', 'status');
  const output = document.createElement('pre'); output.className = 'jira-panel-output'; output.tabIndex = 0;
  let space = '', cache = false, generation = 0, busy = false;
  const buttons: HTMLButtonElement[] = [];
  async function request(path: string, method = 'GET') {
    const response = await fetch(`${options.base}${path}?space=${encodeURIComponent(space)}`, { method, credentials: 'include', headers: options.headers() });
    const data = await response.json(); if (!response.ok) throw new Error(data.detail || 'Could not read Jira daemon.'); return data;
  }
  async function refresh() {
    if (panel.hidden || busy) return;
    const token = generation;
    try {
      const data = await request(cache ? '/api/jira-cache' : '/api/jira-daemon');
      if (token !== generation) return;
      const bottom = output.scrollHeight - output.scrollTop - output.clientHeight < 40;
      status.textContent = cache ? 'JIRA cache' : data.running ? 'Running' : 'Stopped';
      const content = cache ? JSON.stringify(data, null, 2) : data.logs.join('\n') || 'No daemon activity yet.';
      if (output.textContent !== content) { output.textContent = content; if (bottom && !cache) output.scrollTop = output.scrollHeight; }
    } catch (error: any) { if (token === generation) status.textContent = error.message; }
  }
  for (const [label, action, glyph] of [['Start', 'start', 'play'], ['Stop', 'stop', 'stop'], ['Restart', 'restart', 'rotate-right'], ['Sync now', 'sync', 'arrows-rotate'], ['Show cache', 'cache', 'database']]) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'toolbar-button';
    const icon = document.createElement('i'); icon.className = `fa-solid fa-${glyph}`; icon.setAttribute('aria-hidden', 'true');
    button.append(icon, document.createTextNode(` ${label}`)); buttons.push(button);
    button.addEventListener('click', async () => {
      if (action === 'cache') { options.showCache(); return; }
      busy = true; buttons.forEach(item => item.disabled = true);
      try { await request('/api/jira-daemon/' + action, 'POST'); }
      catch (error: any) { options.notify(error.message, 'error'); }
      finally { busy = false; buttons.forEach(item => item.disabled = !options.canEdit()); void refresh(); }
    }); toolbar.append(button);
  }
  toolbar.append(status); panel.append(toolbar, output);
  window.setInterval(() => void refresh(), 2000);
  return {
    show(id: string, showCache: boolean) {
      generation++; space = id; cache = showCache; panel.hidden = false;
      output.textContent = 'Loading…'; status.textContent = '';
      buttons.forEach((item, index) => { item.hidden = showCache; item.disabled = index !== 4 && !options.canEdit(); });
      void refresh();
    },
    hide() { generation++; panel.hidden = true; },
  };
}
