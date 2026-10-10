import {defineConfig} from '../research-portal/node_modules/vite/dist/node/index.js';
import react from '../research-portal/node_modules/@vitejs/plugin-react/dist/index.js';
import {createRequire} from 'node:module';
const ts=createRequire(import.meta.url)('../research-portal/node_modules/typescript/lib/typescript.js');
import path from 'node:path';
import {replaceRequired} from './transform-helpers.mjs';
const root=path.dirname(new URL(import.meta.url).pathname),repo=path.dirname(root);
export default defineConfig({root,base:'/applications-demo-app/',publicDir:false,resolve:{alias:[{find:/^\.\/supabase$/,replacement:path.join(root,'offline.ts')},{find:/^\.\.?\/pageClock$/,replacement:path.join(root,'pageClock.ts')},{find:/^react(.*)$/,replacement:path.join(repo,'research-portal/node_modules/react$1')},{find:/^react-dom(.*)$/,replacement:path.join(repo,'research-portal/node_modules/react-dom$1')},{find:/^lucide-react$/,replacement:path.join(repo,'research-portal/node_modules/lucide-react')}],dedupe:['react','react-dom']},plugins:[{
 name:'offline-portal-data',enforce:'pre',transform(code,id){
 if(id===path.join(repo,'research-portal/src/experimentPresentation.ts'))return replaceRequired(code,'const groups = new Map<string, PortalExperimentAssignment[]>();',`if (experiment?.id === 'experiment-1' || experiment?.id === 'experiment-2') {
 const buckets = experiment.id === 'experiment-1' ? ['all'] : ['control', 'drought'];
 return buckets.map(treatment => {
 const assignments = experiment.assignments.filter(a => treatment === 'all' || a.treatment === treatment);
 return {id:treatment,label:treatment === 'all' ? 'All pots' : treatment === 'control' ? 'Control' : 'Drought',crop:'',treatment,target:treatment === 'all' ? null : assignments[0]?.target_vwc_percent ?? null,pairingNames:assignments.map(a=>a.pairing_name),potNumbers:assignments.map(a=>a.pot_number)};
 });
}
const groups = new Map<string, PortalExperimentAssignment[]>();`,'experiment graph groups');if(id===path.join(repo,'research-portal/src/WalkerObservationView.tsx'))return replaceRequired(code,'Walker Pi 5 Observation','Experiment 3','walker tile title');if(id!==path.join(repo,'research-portal/src/App.tsx'))return;
 const source=ts.createSourceFile(id,code,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),edits=[];
 const app=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='App');
 const init={email:'""',authMode:'"sign-in"',inviteToken:'null',sessionReady:'true',data:'fixture.data',portalAccess:'fixture.access',experimentCatalog:'fixture.experiments',healthSnapshot:'fixture.health',valveEvents:'fixture.valveEvents',runtimeState:'fixture.runtime',configState:'fixture.config'};
 for(const statement of app.body.statements){if(ts.isExpressionStatement(statement)&&ts.isCallExpression(statement.expression)&&statement.expression.expression.getText(source)==='useEffect'&&statement.getText(source).match(/supabase|loadPortalAccess|loadExperimentCatalog|loadHealthSnapshot|loadValveEvents|loadDeviceSyncState|loadSalesSupport|refresh\(/)){edits.push([statement.getStart(source),statement.end,'']);}
 if(ts.isVariableStatement(statement))for(const d of statement.declarationList.declarations){if(ts.isArrayBindingPattern(d.name)&&ts.isCallExpression(d.initializer)){const name=d.name.elements[0].name.getText(source);if(name in init&&d.initializer.arguments[0])edits.push([d.initializer.arguments[0].getStart(source),d.initializer.arguments[0].end,init[name]]);}}
 }
 if(edits.length < 15) throw new Error('Portal source changed: verify offline state and effects before building.');
 // Omit the internal support card from the public overview; all other components are the production source.
 function visit(n){if(ts.isJsxAttribute(n)&&n.name.text==='machines'){edits.push([n.getStart(source),n.end,'machines={undefined}']);return;}if(ts.isJsxSelfClosingElement(n)&&['ChamberControlAdminTile','WalkerMachineTile','WebsiteAnalyticsTile'].includes(n.tagName.getText(source))){edits.push([n.getStart(source),n.end,'{null}']);return;}if(ts.isJsxElement(n)&&n.openingElement.tagName.getText(source)==='button'&&n.openingElement.attributes.properties.some(a=>ts.isJsxAttribute(a)&&a.name.text==='className'&&a.initializer?.getText(source).includes('portal-launch-card is-support')))edits.push([n.getStart(source),n.end,'{null}']);else ts.forEachChild(n,visit);}visit(source);
 for(const [start,end,text] of edits.sort((a,b)=>b[0]-a[0]))code=code.slice(0,start)+text+code.slice(end);
 return 'import {fixture} from '+JSON.stringify(path.join(root,'portalFixtures.ts'))+';\n'+code;
 }},react()],build:{cssCodeSplit:false,outDir:path.join(repo,'applications-demo-app'),emptyOutDir:true,rollupOptions:{output:{entryFileNames:'assets/demo-[hash].js',assetFileNames:info=>info.name?.endsWith('.css')?'assets/index-[hash].css':'assets/[name][extname]'}}}});
