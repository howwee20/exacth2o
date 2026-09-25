import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const websiteFiles = new Set([
  'index.html', 'about.html', 'applications.html', 'support.html', 'quote.html',
  'site-navigation.js', 'site-brand-footer.css', 'site-brand-footer.js',
  'CNAME', '.nojekyll',
]);

export function isWebsiteOnly(paths) {
  return paths.length > 0 && paths.every(path => websiteFiles.has(path)
    || /^[^/]+\.(?:avif|gif|ico|jpe?g|mp4|png|svg|webp)$/i.test(path));
}

export function changedPaths(base, head, cwd = process.cwd()) {
  // Disable rename detection so moving software into a website path still
  // includes the original software path and requires full validation.
  return execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', base, head],
    { cwd, encoding: 'utf8' }).split('\0').filter(Boolean);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let websiteOnly = false;
  try {
    const [base, head] = process.argv.slice(2);
    if (base && head) websiteOnly = isWebsiteOnly(changedPaths(base, head));
  } catch {
    console.log('Comparison unavailable; keeping full software validation.');
  }
  console.log(websiteOnly ? 'Website-only change: publish static files.' : 'Software or workflow change: run full validation.');
  appendFileSync(process.env.GITHUB_OUTPUT, `website_only=${websiteOnly}\n`);
}
