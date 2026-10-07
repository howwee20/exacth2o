// Shared by the Applications and /demo preview builds. A preview transform that silently stops
// matching would ship production behaviour (network effects, real copy) inside a public demo, so
// every required replacement must apply exactly once or the build fails.
export function replaceRequired(code, search, replacement, label) {
  const index = code.indexOf(search);
  if (index < 0) throw new Error(`Preview transform did not match (${label}). Update the preview build for the portal source change.`);
  if (code.indexOf(search, index + search.length) >= 0) throw new Error(`Preview transform matched more than once (${label}).`);
  return code.slice(0, index) + replacement + code.slice(index + search.length);
}

// Overview cards draw at their allocated size instead of the full-chart minimum.
export function compactOverviewCharts(code) {
  code = replaceRequired(code, 'const width = Math.max(320, rect.width);', 'const width = Math.max(wrapper.closest(".experiment-graph-chart") ? 120 : 320, rect.width);', 'chart width');
  return replaceRequired(code, 'const height = Math.max(360, rect.height);', 'const height = Math.max(wrapper.closest(".experiment-graph-chart") ? 80 : 360, rect.height);', 'chart height');
}
