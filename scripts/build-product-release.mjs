import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
run('npm', ['run', 'build', '--prefix', 'research-portal']);
run('node', ['research-portal/node_modules/vite/bin/vite.js', 'build', '--config', 'applications-preview/vite.config.mjs']);
// Refresh the embedded document URL whenever its release changes; otherwise a
// cached iframe index can keep a visitor on an older portal bundle.
const embedVersion = createHash('sha256').update(readFileSync('applications-demo-app/index.html')).digest('hex').slice(0, 12);
const applications = readFileSync('applications.html', 'utf8').replace(/src="\/applications-demo-app\/index\.html(?:\?v=[a-f0-9]+)?"/, `src="/applications-demo-app/index.html?v=${embedVersion}"`);
writeFileSync('applications.html', applications);
run('node', ['demo-preview/build.mjs']);
console.log('Website, portal, standalone demo and embedded demo are ready to commit together.');
