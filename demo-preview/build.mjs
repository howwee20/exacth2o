// Build the demo portal and point demo.html at the content-hashed entry, so every deploy is a new asset
// URL and neither browsers nor the Pages CDN can serve a stale bundle. The entry is referenced without a
// query: lazily loaded chunks import it by file name, and "demo.js?v=…" would load a second React copy.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
const root=path.dirname(new URL(import.meta.url).pathname),repo=path.dirname(root);
const build=spawnSync(process.execPath,[path.join(repo,'research-portal/node_modules/vite/bin/vite.js'),'build','--config',path.join(root,'vite.config.mjs')],{stdio:'inherit'});
if(build.status!==0)process.exit(build.status??1);
const entry=readFileSync(path.join(repo,'demo-app/index.html'),'utf8').match(/src="\/demo-app\/assets\/(demo-[A-Za-z0-9_-]+\.js)"/)?.[1];
if(!entry)throw new Error('demo-app/index.html does not reference a hashed demo-<hash>.js entry.');
const version=createHash('sha256').update(entry).update(readFileSync(path.join(repo,'demo-app/assets/index.css'))).digest('hex').slice(0,16);
const page=path.join(repo,'demo.html');
const html=readFileSync(page,'utf8')
  .replace(/\/demo-app\/assets\/demo(?:-[A-Za-z0-9_-]+)?\.js(?:\?v=[0-9a-f]+)?/g,`/demo-app/assets/${entry}`)
  .replace(/(\/demo-app\/assets\/index\.css)(\?v=[0-9a-f]+)?/g,`$1?v=${version}`);
if(!html.includes(`"/demo-app/assets/${entry}"`))throw new Error('demo.html has no demo entry script to update.');
writeFileSync(page,html);
console.log(`demo.html now loads ${entry} (stylesheet v=${version})`);
