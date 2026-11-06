// Offline layout preview. All new experiment drafts stay in this page's React state.
import { createRoot } from 'react-dom/client';
import { useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import { QuietSpineHome, type InstallationState } from '../src/product/QuietSpineHome';
import { ProductHeader } from '../src/product/ProductHeader';
import { SystemSection } from '../src/product/SystemSection';
import { WebsiteAnalyticsSummary, type WebsiteAnalyticsSummaryData } from '../src/WebsiteAnalyticsSummary';
import type { PortalExperiment } from '../src/experimentRegistry';
import '../src/styles.css';
import '../src/product/product.css';

const active: PortalExperiment = { id: 'preview-pan', name: 'Huiqiao Pan experiment', shortDescription: '', mode: 'controlled', status: 'active', groupNames: [], pairingNames: Array.from({length:12},(_,i)=>`Pot ${65+i}`), assignments: [] };
const completed: PortalExperiment[] = [1,2,3].map(n=>({ ...active, id:`preview-completed-${n}`, name:`Example completed study ${n}`, status:'completed', pairingNames:active.pairingNames.slice(0,6) }));
const sampleAnalytics: WebsiteAnalyticsSummaryData = {
  status:'ready', dashboardUrl:null, visitors:842, demoClicks:76, quoteClicks:23, inquiries:6, inquirySource:'server',
  days:[81,106,94,158,129,140,134].map((visitors,index)=>({date:`2026-${index<4?'10':'11'}-${index<4?28+index:String(index-3).padStart(2,'0')}`,visitors})),
};
function Preview() {
  const [message,setMessage]=useState('');
  const [creating,setCreating]=useState<string|null>(null);
  const [walkerDrafts,setWalkerDrafts]=useState<string[]>([]);
  const [irrigationDrafts,setIrrigationDrafts]=useState<PortalExperiment[]>([]);
  const status=new URLSearchParams(location.search).get('status');
  const installation: InstallationState = status==='offline' ? {status:'offline',lastSeenAt:Date.now()-3600000} : status==='unknown' ? {status:'unknown'} : {status:'online',lastSeenAt:Date.now()};
  const preview=(name:string)=>setMessage(`${name} is available in the portal. This local preview uses sample data and has no live connection.`);
  const createDraft=(event:FormEvent<HTMLFormElement>)=>{
    event.preventDefault();
    const name=String(new FormData(event.currentTarget).get('name')??'').trim();
    if(!name)return;
    if(creating==='Walker Pi')setWalkerDrafts(items=>[...items,name]);
    else setIrrigationDrafts(items=>[...items,{...active,id:`local-${items.length}`,name,status:undefined,pairingNames:[]}]);
    setCreating(null);
  };
  return <main className="px-shell" onClickCapture={event=>{const link=(event.target as Element).closest('a');if(link){event.preventDefault();event.stopPropagation();preview(link.textContent?.trim()||'Navigation');}}}>
    <div style={{padding:'7px 20px',background:'#eaf2fb',color:'#40536b',font:'12px system-ui',textAlign:'center'}}>Local design preview · Sample data</div>
    <ProductHeader onFindPot={()=>preview('Find pot')} onOpenAccount={()=>preview('Account')} onSignOut={()=>preview('Sign out')}/>
    <QuietSpineHome systemName="Rhee Lab" experiments={[active,...irrigationDrafts,...completed]} exceptions={[]} nowMs={Date.now()} checking={false} catalogError={null} installation={installation} canCreate onNewExperiment={()=>setCreating('Rhee Lab')} onEditExperiment={()=>preview('Edit experiment')} recordAvailable
      healthLink={<div className="px-node-actions"><a href="#health">System health →</a><a href="#calibrate">Autocalibrate →</a></div>}
      machines={<>
        <SystemSection name="Walker Pi" action={<button className="px-button is-primary" aria-label="Create experiment on Walker Pi" onClick={()=>setCreating('Walker Pi')}><Plus size={16}/>Create experiment</button>}>
          {walkerDrafts.length ? walkerDrafts.map((name,index)=><article className="px-local-draft" key={index}><strong>{name}</strong><span>Local draft</span></article>) : <p className="px-system-empty">No experiments yet.</p>}
          <div className="px-system-links"><a href="#walker">View readings →</a></div>
        </SystemSection>
        <SystemSection name="Chamber" defaultExpanded={false} description="Gas mixer · Lighting" action={<button className="px-button" onClick={()=>preview('Chamber')}>Open system</button>}>
          <p style={{margin:0,color:'var(--px-muted)'}}>Control and schedules</p>
        </SystemSection>
      </>}
      tools={<>
        <button className="portal-launch-card" onClick={()=>preview('Sales & Support')}><span className="portal-launch-copy"><span className="portal-launch-title">Sales &amp; Support</span></span><span className="portal-launch-action">Open →</span></button>
        <div className="portal-launch-card is-website-analytics"><WebsiteAnalyticsSummary summary={sampleAnalytics} onOpen={()=>preview('Website analytics')}/></div>
      </>}/>
    {creating&&<div className="portal-preview-backdrop" role="dialog" aria-modal="true" aria-labelledby="preview-create-title" onKeyDown={event=>{if(event.key==='Escape')setCreating(null);}}><form className="portal-preview-dialog" onSubmit={createDraft}>
      <h2 id="preview-create-title">Create experiment</h2><p>{creating}</p>
      <label htmlFor="preview-experiment-name">Experiment name</label><input autoFocus required id="preview-experiment-name" name="name" maxLength={100}/>
      <small>This preview creates a local draft.</small>
      <div className="portal-preview-dialog-actions"><button className="px-button" type="button" onClick={()=>setCreating(null)}>Cancel</button><button className="px-button is-primary" type="submit">Create experiment</button></div>
    </form></div>}
    {message&&<div className="portal-preview-backdrop" role="dialog" aria-modal="true" aria-label="Preview action"><div className="portal-preview-dialog"><p>{message}</p><button autoFocus className="px-button" onClick={()=>setMessage('')}>Close</button></div></div>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Preview/>);
