/** Keep legacy header-based definitions readable while storing a plain section list. */
export function plainDefinitions(source: string): string {
  if (!/^Definitions:\s*\r?$/m.test(source)) return source;
  return source.split('\n').filter(line => !/^Definitions:\s*\r?$/.test(line))
    .map(line => line.startsWith('    ') ? line.slice(4) : line).join('\n');
}
export function definitionsConfigSource(source: string): string {
  const config = source.split(/^\s*%/m)[0] || '';
  if (!/^(?:tags|people|states|tabs):\s*$/m.test(config)) return source;
  return 'Definitions:\n' + source.split('\n').map(line => line ? '    ' + line : line).join('\n');
}
