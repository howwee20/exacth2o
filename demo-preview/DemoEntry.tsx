import { Component, lazy, Suspense, useState, type ReactNode } from 'react';
import { ProductHeader } from '../research-portal/src/product/ProductHeader';
import { QuietSpineHome } from '../research-portal/src/product/QuietSpineHome';
import { usePortalRoute } from '../research-portal/src/portalRoute';
import type { PortalExperiment } from '../research-portal/src/experimentRegistry';

// This entry never imports measurements or the offline adapter. Opening a working
// view downloads the full App/fixture chunk once; Back, refresh and deep links still work.
const FullDemo = lazy(() => import('../research-portal/src/App'));
const catalog: PortalExperiment[] = [
  { id: 'experiment-1', name: 'Drought response', mode: 'observation', status: 'published_sensing', count: 10, first: 61 },
  { id: 'experiment-2', name: 'Recovery after drought', mode: 'controlled', status: 'active', count: 24, first: 1 },
  { id: 'experiment-3', name: 'Crop comparison', mode: 'controlled', status: 'active', count: 24, first: 101 },
].map(e => ({ ...e, mode: e.mode as PortalExperiment['mode'], status: e.status as PortalExperiment['status'], shortDescription: '', groupNames: [e.id], pairingNames: Array.from({length:e.count}, (_,i) => `Pot ${e.first+i}`) }));
class DemoLoadBoundary extends Component<{children: ReactNode}, {failed: boolean}> {
  state = { failed: false };
  static getDerivedStateFromError() { return {failed: true}; }
  render() { return this.state.failed ? <main className="px-shell"><div className="px-page" role="alert"><p>The experiment could not load.</p><button className="px-button" onClick={() => location.reload()}>Try again</button></div></main> : this.props.children; }
}
export function DemoEntry() {
  const route = usePortalRoute();
  const [search, setSearch] = useState(false);
  if (route.view !== 'home' || search) return <DemoLoadBoundary><Suspense fallback={<main className="px-shell"><ProductHeader onFindPot={() => setSearch(true)} onSignOut={() => {}} demo /><div className="px-page" role="status">Loading…</div></main>}><FullDemo initialFindPot={search}/></Suspense></DemoLoadBoundary>;
  return <main className="px-shell">
    <ProductHeader onFindPot={() => setSearch(true)} onSignOut={() => {}} demo />
    <QuietSpineHome experiments={catalog} exceptions={[]} nowMs={Date.now()} checking={false} catalogError={null}
      installation={{status:'online',lastSeenAt:Date.now()}} canCreate={false} onNewExperiment={() => {}} onEditExperiment={() => {}} recordAvailable />
  </main>;
}
