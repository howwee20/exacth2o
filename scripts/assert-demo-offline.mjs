import fs from 'node:fs';
import path from 'node:path';
for (const htmlPath of ['demo.html','demo-app/index.html','applications-demo-app/index.html']) {
 const html=fs.readFileSync(htmlPath,'utf8');
 if (!html.includes("connect-src 'none'")) throw new Error(`${htmlPath}: offline CSP missing`);
 const roots=[...html.matchAll(/(?:src|href)="([^"]+\.js(?:\?[^"]*)?)"/g)].map(m=>m[1].split('?')[0]);
 const base=htmlPath==='demo.html'?'demo-app':path.dirname(htmlPath),seen=new Set();
 const visit=file=>{
  if(seen.has(file)||!fs.existsSync(file)) return;seen.add(file);
  const source=fs.readFileSync(file,'utf8');
  if(source.includes('zmhdclcjrkntrpynozvo.supabase.co')) throw new Error(`${file}: production endpoint in offline graph`);
  for(const m of source.matchAll(/["']([^"'\s]+\.js)["']/g)) {
   const name=m[1];
   for(const candidate of [path.resolve(path.dirname(file),name),path.resolve(base,name),path.resolve(base,'assets',path.basename(name))]) {
    if(candidate.startsWith(path.resolve(base)+path.sep)) visit(candidate);
   }
  }
 };
 for(const root of roots)visit(root.startsWith('/')?path.resolve(root.slice(1)):path.resolve(path.dirname(htmlPath),root));
 if(seen.size===0)throw new Error(`${htmlPath}: no entry graph found`);
 console.log(`${htmlPath}: CSP and ${seen.size} reachable scripts verified`);
}
