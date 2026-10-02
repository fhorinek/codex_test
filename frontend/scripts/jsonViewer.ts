/** Native disclosure controls keep nested JSON keyboard accessible. */
export function createJsonViewer() {
  const element = document.createElement('div'); element.className = 'jira-json-viewer';
  const expanded = new Map<string, boolean>();
  let value: unknown, serialized = '', space = '';
  function render() {
    const focused = (document.activeElement as HTMLElement | null)?.dataset['jsonPath'];
    const scroll = element.scrollTop;
    element.replaceChildren();
    function node(key: string, item: unknown, path: string[], depth: number): HTMLElement {
      const id = JSON.stringify(path);
      const label = document.createElement('span'); label.className = 'jira-json-key'; label.textContent = key;
      if (item !== null && typeof item === 'object') {
        const entries = Object.entries(item);
        const details = document.createElement('details'); details.className = 'jira-json-branch';
        details.open = expanded.get(id) ?? depth === 0;
        const summary = document.createElement('summary'); summary.dataset['jsonPath'] = id;
        const size = document.createElement('span'); size.className = 'jira-json-size';
        size.textContent = Array.isArray(item) ? ` [${entries.length} items]` : ` {${entries.length} properties}`;
        summary.append(label, size); details.append(summary);
        const children = document.createElement('div'); children.className = 'jira-json-children';
        for (const [childKey, child] of entries) children.append(node(childKey, child, [...path, childKey], depth + 1));
        details.append(children);
        details.addEventListener('toggle', () => expanded.set(id, details.open));
        return details;
      }
      const row = document.createElement('div'); row.className = 'jira-json-value-row';
      const content = document.createElement('span'); content.className = `jira-json-value jira-json-${item === null ? 'null' : typeof item}`;
      content.textContent = JSON.stringify(item) ?? 'undefined';
      row.append(label, document.createTextNode(': '), content); return row;
    }
    if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value);
      if (!entries.length) element.textContent = 'No cached data yet.';
      for (const [key, item] of entries) element.append(node(key, item, [key], 0));
    } else element.append(node('Cache', value, [], 0));
    if (focused) [...element.querySelectorAll<HTMLElement>('summary')].find(item => item.dataset['jsonPath'] === focused)?.focus({ preventScroll: true });
    element.scrollTop = scroll;
  }
  return {
    element,
    update(data: unknown, spaceId: string) {
      const next = JSON.stringify(data);
      if (space !== spaceId) { expanded.clear(); serialized = ''; space = spaceId; }
      if (serialized === next) return;
      value = data; serialized = next; render();
    },
    expandAll(open: boolean) {
      element.querySelectorAll<HTMLDetailsElement>('details').forEach(item => {
        expanded.set(item.querySelector('summary')!.dataset['jsonPath']!, open); item.open = open;
      });
    },
  };
}
