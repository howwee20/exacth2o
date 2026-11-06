/** Change trace visibility only. Selection never changes experiment assignments or targets. */
export function toggleTraceSelection(hidden: ReadonlySet<string>, names: readonly string[]): Set<string> {
  const hide = names.length > 0 && names.every(name => !hidden.has(name));
  const next = new Set(hidden);
  names.forEach(name => hide ? next.add(name) : next.delete(name));
  return next;
}
