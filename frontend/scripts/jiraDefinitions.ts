/** Jira is space metadata, never part of a task tab's definition overrides. */
export function jiraMetadataRanges(source: string): Array<{ start: number; end: number }> {
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) || [];
  const ranges: Array<{ start: number; end: number }> = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*%/.test(line)) break;
    const match = /^( *)jira:\s*$/.exec(line.trimEnd());
    const roots = lines.slice(0, i).filter(prior => prior.trim() && !prior.startsWith(' ') && !prior.trimStart().startsWith('#'));
    if (match && (!match[1]!.length || (match[1]!.length === 4 && roots[roots.length - 1]?.trim() === 'Definitions:'))) {
      const indent = match[1]!.length;
      let end = offset + line.length;
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j]!;
        if (next.trim() && next.length - next.trimStart().length <= indent) break;
        end += next.length;
      }
      ranges.push({ start: offset, end });
    }
    offset += line.length;
  }
  return ranges;
}

export function parseSpaceJira(source: string): { configured: boolean; diagnostics: string[] } {
  const ranges = jiraMetadataRanges(source);
  if (!ranges.length) return { configured: false, diagnostics: [] };
  if (ranges.length !== 1) return { configured: false, diagnostics: ['Duplicate Jira configuration.'] };
  const range = ranges[0]!;
  const values: Record<string, string> = {};
  const diagnostics: string[] = [];
  for (const line of source.slice(range.start, range.end).split('\n').slice(1)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^\s+(base_url|email|token|autostart|show_logs|show_cache):\s*(.*?)\s*$/.exec(line);
    if (!match || match[1]! in values) diagnostics.push('Invalid Jira configuration property.');
    else values[match[1]!] = match[2]!;
  }
  for (const key of ['autostart', 'show_logs', 'show_cache']) if (key in values && !['true', 'false'].includes(values[key]!)) diagnostics.push(`Jira ${key} must be true or false.`);
  if (!values['base_url'] || !values['email'] || !values['token']) diagnostics.push('Jira requires a base URL, email, and API token.');
  if (values['base_url']) {
    try { const url = new URL(values['base_url']); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(); }
    catch { diagnostics.push('Jira base URL must be an HTTP or HTTPS URL.'); }
  }
  if (values['email'] && !/^[^\s@]+@[^\s@]+$/.test(values['email'])) diagnostics.push('Invalid Jira email.');
  return { configured: !diagnostics.length, diagnostics };
}

export function jiraViewOptions(source: string) {
  const options = { autostart: false, show_logs: true, show_cache: false };
  const range = jiraMetadataRanges(source)[0];
  if (range) for (const match of source.slice(range.start, range.end).matchAll(/^\s+(autostart|show_logs|show_cache):\s*(true|false)\s*$/gm)) options[match[1] as keyof typeof options] = match[2] === 'true';
  return options;
}
