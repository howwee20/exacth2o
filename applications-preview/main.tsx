import {createRoot} from 'react-dom/client';
import { DemoEntry } from '../demo-preview/DemoEntry';
import '../research-portal/src/styles.css';
import './preview.css';
import {startDemoBridge} from './demo-bridge';

// The Applications page embeds the portal demonstration.
document.documentElement.dataset.portalMode = "demo";
const params = new URLSearchParams(window.location.search);
if (!params.has('experiment') && !params.has('view')) {
  params.set('experiment', 'experiment-1');
  window.history.replaceState(null, '', `${window.location.pathname}?${params}${window.location.hash}`);
}
createRoot(document.getElementById('root')!).render(<DemoEntry/>);
startDemoBridge();
