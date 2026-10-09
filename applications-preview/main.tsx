import {createRoot} from 'react-dom/client';
import App from '../research-portal/src/App';
import '../research-portal/src/styles.css';
import './preview.css';
import {startDemoBridge} from './demo-bridge';

// The Applications page embeds the portal demonstration.
createRoot(document.getElementById('root')!).render(<App/>);
startDemoBridge();
