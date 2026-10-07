// Shared by the Applications and /demo preview builds. A preview transform that silently stops
// matching would ship production behaviour (network effects, real copy) inside a public demo, so
// every required replacement must apply exactly once or the build fails.
export function replaceRequired(code, search, replacement, label) {
  const index = code.indexOf(search);
  if (index < 0) throw new Error(`Preview transform did not match (${label}). Update the preview build for the portal source change.`);
  if (code.indexOf(search, index + search.length) >= 0) throw new Error(`Preview transform matched more than once (${label}).`);
  return code.slice(0, index) + replacement + code.slice(index + search.length);
}
