import React from 'react';
import ReactDOM from 'react-dom/client';
import App from '../research-portal/src/App';
import '../research-portal/src/styles.css';
import './demo.css';

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);

// "DEMO" sits under the ExactH2O logo on every screen. Headers re-render between sign-in and the
// dashboard, so the mark is re-applied whenever the document changes.
function markLogos(){
 for(const logo of document.querySelectorAll<HTMLElement>('.portal-logo,.dashboard-logo')){
  if(logo.querySelector('.demo-account-mark'))continue;
  const mark=document.createElement('span');mark.className='demo-account-mark';mark.textContent='DEMO';logo.append(mark);
 }
}
markLogos();
new MutationObserver(markLogos).observe(document.body,{childList:true,subtree:true});
