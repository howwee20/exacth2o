import React from 'react';
import ReactDOM from 'react-dom/client';
import App from '../research-portal/src/App';
import '../research-portal/src/styles.css';
import './demo.css';

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);

// "DEMO" sits directly under the ExactH2O logo on every screen. The logo link is a clipped fixed-size
// box, so the mark is a positioned sibling in the header rather than a child of the link. Headers
// re-render between sign-in and the dashboard, so the mark is re-applied whenever the document changes.
function place(mark:HTMLElement,logo:HTMLElement){mark.style.left=logo.offsetLeft+'px';mark.style.top=(logo.offsetTop+logo.offsetHeight+3)+'px';}
function markLogos(){
 for(const logo of document.querySelectorAll<HTMLElement>('.portal-logo,.dashboard-logo')){
  const header=logo.parentElement;if(!header)continue;
  let mark=header.querySelector<HTMLElement>(':scope > .demo-account-mark');
  if(!mark){if(getComputedStyle(header).position==='static')header.style.position='relative';mark=document.createElement('span');mark.className='demo-account-mark';mark.textContent='DEMO';header.append(mark);}
  place(mark,logo);
 }
}
markLogos();
new MutationObserver(markLogos).observe(document.body,{childList:true,subtree:true});
window.addEventListener('resize',markLogos);
