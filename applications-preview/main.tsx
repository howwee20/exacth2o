import {createRoot} from 'react-dom/client';
import App from '../research-portal/src/App';
import '../research-portal/src/styles.css';
import './preview.css';
import {startDemoBridge} from './demo-bridge';

// The Applications page embeds the production portal, unchanged, on synthetic sample data.
createRoot(document.getElementById('root')!).render(<App/>);
startDemoBridge();
const badge=document.createElement('div');badge.className='demo-sample-badge';badge.textContent='Synthetic sample data';badge.setAttribute('role','note');document.body.append(badge);
