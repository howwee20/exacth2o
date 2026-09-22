// Demo portal at /demo: the production App with the shared demo account and sample data.
// Derived from applications-preview/vite.config.mjs; the live-readings subscription is kept so the demo ticks.
import {defineConfig} from '../research-portal/node_modules/vite/dist/node/index.js';
import react from '../research-portal/node_modules/@vitejs/plugin-react/dist/index.js';
import {createRequire} from 'node:module';
const ts=createRequire(import.meta.url)('../research-portal/node_modules/typescript/lib/typescript.js');
import path from 'node:path';
const root=path.dirname(new URL(import.meta.url).pathname),repo=path.dirname(root);
export default defineConfig({root,base:'/demo-app/',publicDir:false,resolve:{alias:[{find:/^\.\/supabase$/,replacement:path.join(root,'offline.ts')},{find:/^react(.*)$/,replacement:path.join(repo,'research-portal/node_modules/react$1')},{find:/^react-dom(.*)$/,replacement:path.join(repo,'research-portal/node_modules/react-dom$1')},{find:/^lucide-react$/,replacement:path.join(repo,'research-portal/node_modules/lucide-react')}],dedupe:['react','react-dom']},plugins:[{
 name:'demo-portal-data',enforce:'pre',transform(code,id){if(id===path.join(repo,'research-portal/src/WalkerObservationView.tsx'))return code.replace('Walker Pi 5 Observation','Experiment 3');if(id!==path.join(repo,'research-portal/src/App.tsx'))return;
 const source=ts.createSourceFile(id,code,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),edits=[];
 const app=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='App');
 const init={email:'""',authMode:'"sign-in"',inviteToken:'null',sessionReady:'demoSession()',data:'fixture.data',portalAccess:'fixture.access',experimentCatalog:'fixture.experiments',healthSnapshot:'fixture.health',valveEvents:'fixture.valveEvents'};
 for(const statement of app.body.statements){if(ts.isExpressionStatement(statement)&&ts.isCallExpression(statement.expression)&&statement.expression.expression.getText(source)==='useEffect'&&statement.getText(source).match(/supabase|loadPortalAccess|loadExperimentCatalog|loadHealthSnapshot|loadValveEvents|loadDeviceSyncState|loadSalesSupport|refresh\(/)&&!statement.getText(source).includes('exacth2o-dashboard-live')){edits.push([statement.getStart(source),statement.end,'']);}
 if(ts.isVariableStatement(statement))for(const d of statement.declarationList.declarations){if(ts.isArrayBindingPattern(d.name)&&ts.isCallExpression(d.initializer)){const name=d.name.elements[0].name.getText(source);if(name in init&&d.initializer.arguments[0])edits.push([d.initializer.arguments[0].getStart(source),d.initializer.arguments[0].end,init[name]]);}}
 }
 if(edits.length < 15) throw new Error('Portal source changed: verify offline state and effects before building.');
 // Omit the internal support card from the public overview; all other components are the production source.
 function visit(n){if(ts.isJsxSelfClosingElement(n)&&n.tagName.getText(source)==='ChamberControlAdminTile'){edits.push([n.getStart(source),n.end,'{null}']);return;}if(ts.isJsxElement(n)&&n.openingElement.tagName.getText(source)==='button'&&n.openingElement.attributes.properties.some(a=>ts.isJsxAttribute(a)&&a.name.text==='className'&&a.initializer?.getText(source).includes('portal-launch-card is-support')))edits.push([n.getStart(source),n.end,'{null}']);else ts.forEachChild(n,visit);}visit(source);
 for(const [start,end,text] of edits.sort((a,b)=>b[0]-a[0]))code=code.slice(0,start)+text+code.slice(end);
 code=code.replace('<h1 className="experiment-view-title">Walker Pi 5</h1>','<h1 className="experiment-view-title">Experiment 3</h1>');
 code=code.replace('nextSnapshot.sensors.map((sensor) => sensor.source_sensor_id)','nextSnapshot.sensors.filter((_, index) => index % 16 === 0).map((sensor) => sensor.source_sensor_id)');
 return 'import {fixture} from '+JSON.stringify(path.join(root,'fixtures.ts'))+';\nimport {demoSession} from '+JSON.stringify(path.join(root,'offline.ts'))+';\n'+code;
 }},react()],build:{outDir:path.join(repo,'demo-app'),emptyOutDir:true,rollupOptions:{output:{entryFileNames:'assets/demo.js',assetFileNames:'assets/[name][extname]'}}}});
