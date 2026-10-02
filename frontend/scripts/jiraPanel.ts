import { createJiraLogViewer } from "./jiraLogs.js";
import { createJsonViewer } from "./jsonViewer.js";
/** Read-only space-local daemon logs and cache, with authenticated controls. */
export function createJiraPanel(options: {
  base: string; headers: () => Record<string, string>; canEdit: () => boolean;
  notify: (message: string, kind?: string) => void; showCache: () => void; autostart: () => boolean; setAutostart: (enabled: boolean) => Promise<void>;
}) {
  const panel = document.createElement('section'); panel.className = 'jira-panel'; panel.hidden = true;
  panel.setAttribute('aria-label', 'JIRA daemon'); document.querySelector('.app')!.append(panel);
  const toolbar = document.createElement('div'); toolbar.className = 'jira-panel-toolbar';
  const status = document.createElement('span'); status.className = 'jira-daemon-state'; status.setAttribute('role', 'status');
  const logs = createJiraLogViewer(); const output = logs.element;
  const viewer = createJsonViewer(); viewer.element.hidden = true;
  const autoLabel = document.createElement('label'); autoLabel.className = 'jira-autostart';
  const autostart = document.createElement('input'); autostart.type = 'checkbox';
  autoLabel.append(autostart, document.createTextNode('Autostart'));
  autostart.title = 'Start this space’s Jira daemon with the server';
  let savingAutostart = false;
  function updateAutostart() { autostart.checked = options.autostart(); autostart.disabled = savingAutostart || !options.canEdit(); }
  autostart.addEventListener('change', async () => {
    const enabled = autostart.checked; savingAutostart = true; autostart.disabled = true;
    try { await options.setAutostart(enabled); }
    catch (error: any) { options.notify(error.message, 'error'); }
    finally { savingAutostart = false; updateAutostart(); }
  });
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
      status.textContent = cache ? 'JIRA cache' : data.running ? 'Running' : 'Stopped';
      if (cache) { viewer.update(data, space); return; }
      logs.update(data.logs, space);
    } catch (error: any) { if (token === generation) status.textContent = error.message; }
  }
  for (const [label, action, glyph] of [['Start', 'start', 'play'], ['Stop', 'stop', 'stop'], ['Restart', 'restart', 'rotate-right'], ['Sync now', 'sync', 'arrows-rotate'], ['Show cache', 'cache', 'database'], ['Clear log', 'clear-log', 'eraser']]) {
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
  const cacheControls: HTMLButtonElement[] = [];
  for (const [label, open] of [['Expand all', true], ['Collapse all', false]] as const) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'toolbar-button'; button.textContent = label;
    button.addEventListener('click', () => viewer.expandAll(open)); cacheControls.push(button); toolbar.append(button);
  }
  const clearCache = document.createElement('button'); clearCache.type = 'button'; clearCache.className = 'toolbar-button';
  const clearIcon = document.createElement('i'); clearIcon.className = 'fa-solid fa-eraser'; clearIcon.setAttribute('aria-hidden', 'true');
  clearCache.append(clearIcon, document.createTextNode(' Clear cache'));
  clearCache.addEventListener('click', async () => {
    busy = true; clearCache.disabled = true;
    try { await request('/api/jira-daemon/clear-cache', 'POST'); }
    catch (error: any) { options.notify(error.message, 'error'); }
    finally { busy = false; clearCache.disabled = !options.canEdit(); void refresh(); }
  });
  cacheControls.push(clearCache); toolbar.append(clearCache);
  toolbar.append(autoLabel, status); panel.append(toolbar, output, viewer.element);
  window.setInterval(() => void refresh(), 2000);
  return {
    show(id: string, showCache: boolean) {
      generation++; space = id; cache = showCache; panel.hidden = false;
      output.hidden = showCache; viewer.element.hidden = !showCache;
      autoLabel.hidden = showCache; updateAutostart();
      cacheControls.forEach(button => button.hidden = !showCache);
      clearCache.disabled = busy || !options.canEdit();
      logs.reset(); status.textContent = '';
      buttons.forEach((item, index) => { item.hidden = showCache; item.disabled = index !== 4 && !options.canEdit(); });
      void refresh();
    },
    updateAutostart,
    async download() {
      if (panel.hidden) return;
      const token = generation, downloadingCache = cache;
      try {
        const data = await request(downloadingCache ? '/api/jira-cache' : '/api/jira-daemon');
        if (token !== generation || panel.hidden) return;
        const text = downloadingCache ? JSON.stringify(data, null, 2) + '\n' : data.logs.join('\n') + (data.logs.length ? '\n' : '');
        const blob = new Blob([text], { type: downloadingCache ? 'application/json' : 'text/plain' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a'); link.href = url;
        link.download = downloadingCache ? 'jira-cache.json' : 'jira-daemon.log';
        document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
      } catch (error: any) { if (token === generation) options.notify(error.message, 'error'); }
    },
    hide() { generation++; panel.hidden = true; },
  };
}
