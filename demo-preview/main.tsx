import React from 'react';
import ReactDOM from 'react-dom/client';
import App from '../research-portal/src/App';
import '../research-portal/src/styles.css';
import './demo.css';
import {demoSignedIn} from './offline';

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);

// A quiet reminder once signed in; the login page is the production page.
const badge=document.createElement('div');badge.className='demo-account-badge';badge.setAttribute('role','status');badge.textContent='Demo account · sample data · monitoring only';badge.hidden=true;document.body.append(badge);
setInterval(()=>{badge.hidden=!demoSignedIn();},1000);
