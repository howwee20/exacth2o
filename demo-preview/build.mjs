// Build the demo portal and stamp demo.html with the bundle hash, so every deploy is a new asset URL
// and neither browsers nor the Pages CDN can serve a stale bundle.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
const root=path.dirname(new URL(import.meta.url).pathname),repo=path.dirname(root);
const build=spawnSync(process.execPath,[path.join(repo,'research-portal/node_modules/vite/bin/vite.js'),'build','--config',path.join(root,'vite.config.mjs')],{stdio:'inherit'});
if(build.status!==0)process.exit(build.status??1);
const hash=createHash('sha256');
for(const file of ['demo-app/assets/demo.js','demo-app/assets/index.css'])hash.update(readFileSync(path.join(repo,file)));
const version=hash.digest('hex').slice(0,16);
const page=path.join(repo,'demo.html');
const html=readFileSync(page,'utf8').replace(/(\/demo-app\/assets\/(?:demo\.js|index\.css))(\?v=[0-9a-f]+)?/g,`$1?v=${version}`);
writeFileSync(page,html);
console.log('demo.html assets stamped with v='+version);
