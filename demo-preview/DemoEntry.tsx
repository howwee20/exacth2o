import { Component, lazy, Suspense, useState, type ReactNode } from 'react';
import { ProductHeader } from '../research-portal/src/product/ProductHeader';
import { DemoHome } from '../research-portal/src/product/DemoHome';
import { usePortalRoute } from '../research-portal/src/portalRoute';

// This entry never imports measurements or the offline adapter. Opening a working
// view downloads the full App/fixture chunk once; Back, refresh and deep links still work.
const FullDemo = lazy(() => import('../research-portal/src/App'));
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
    <DemoHome />
  </main>;
}
