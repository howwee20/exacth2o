import { execFileSync } from 'node:child_process';
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
run('npm', ['run', 'build', '--prefix', 'research-portal']);
run('node', ['research-portal/node_modules/vite/bin/vite.js', 'build', '--config', 'applications-preview/vite.config.mjs']);
run('node', ['demo-preview/build.mjs']);
console.log('Website, portal, standalone demo and embedded demo are ready to commit together.');
