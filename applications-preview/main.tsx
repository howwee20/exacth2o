import {createRoot} from 'react-dom/client';
import { DemoEntry } from '../demo-preview/DemoEntry';
import '../research-portal/src/styles.css';
import './preview.css';
import {startDemoBridge} from './demo-bridge';

// The Applications page embeds the portal demonstration.
document.documentElement.dataset.portalMode = "demo";
createRoot(document.getElementById('root')!).render(<DemoEntry/>);
startDemoBridge();
