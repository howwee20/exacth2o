import React, {useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import App from '../research-portal/src/App';
import '../research-portal/src/styles.css';
import './preview.css';

const positions=new Map<string,{x:number,y:number}>();
function Preview(){
 useEffect(()=>{
  let grid:HTMLElement|null=null;
  let updateFlow=()=>{};
  const spread=1,tileWidth=392,canvasWidth=826;
  function enhance(){
   const next=document.querySelector<HTMLElement>('.portal-launch-grid');
   document.body.classList.toggle('preview-home',Boolean(next));
   if(next===grid)return;
   grid=next;
   window.scrollTo(0,0);
   updateFlow=()=>{};
   if(!grid)return;
   const stage=grid;
   const cards=[...stage.querySelectorAll<HTMLElement>('.portal-launch-card-shell'),...stage.querySelectorAll<HTMLElement>('.portal-business-stack > .portal-launch-card,.portal-experiment-column > .portal-launch-card.is-health')];
   const defaults:Record<string,[number,number]>={'Experiment 1':[0,0],'SWC Saturation Calibration':[434,0],'Experiment 2':[0,220],'Experiment 3':[434,220],'System Health':[217,440]};
   const svgNS='http://www.w3.org/2000/svg';
   const connections=document.createElementNS(svgNS,'svg');connections.classList.add('tile-connections');connections.setAttribute('viewBox','0 0 826 644');connections.setAttribute('aria-hidden','true');stage.prepend(connections);
   const paths=['Experiment 1','Experiment 2','Experiment 3'].map(title=>{const path=document.createElementNS(svgNS,'path');path.dataset.experiment=title;connections.append(path);return {title,path};});
   function connect(){
    const healthPosition=positions.get('System Health');if(!healthPosition)return;
    const health={x:healthPosition.x*spread,y:healthPosition.y};
    connections.setAttribute('viewBox',`0 0 ${canvasWidth} 644`);
    paths.forEach(({title,path},i)=>{
     const position=positions.get(title);if(!position)return;
     const from={x:position.x*spread,y:position.y};
     const endX=health.x+tileWidth*(i+1)/4;
     if(from.y+204<health.y-40){
      const gutter=Math.min(from.x,health.x)-14;
      path.setAttribute('d',`M ${from.x} ${from.y+102} H ${gutter} V ${health.y+102} H ${health.x}`);
     }else{
      const middle=(from.y+204+health.y)/2;
      path.setAttribute('d',`M ${from.x+tileWidth/2} ${from.y+204} V ${middle} H ${endX} V ${health.y}`);
     }
    });
   }
   updateFlow=connect;
   cards.forEach((card,i)=>{
    const title=card.querySelector('.portal-launch-title')?.textContent||`Tile ${i+1}`;
    const [x,y]=defaults[title]||[0,0];
    card.classList.add('preview-tile');
    card.style.left=x+'px';card.style.top=y+'px';card.style.width=tileWidth+'px';
    card.draggable=false;
    positions.set(title,{x,y});
   });
   connect();resize();
  }
  function resize(){
   const stage=document.querySelector<HTMLElement>('.portal-launch-grid');if(!stage)return;
   const scale=Math.max(.3,Math.min(.9,(window.innerWidth-48)/826,(window.innerHeight-102)/644));
   document.documentElement.style.setProperty('--preview-scale',String(scale));
   document.documentElement.style.setProperty('--preview-canvas-width',canvasWidth+'px');
   document.documentElement.style.setProperty('--preview-tile-width',tileWidth+'px');
   document.documentElement.style.setProperty('--preview-stage-height',`${644*scale}px`);
   updateFlow();
  }
  const observer=new MutationObserver(enhance);observer.observe(document.querySelector('#root')!,{subtree:true,childList:true});window.addEventListener('resize',resize);enhance();
  return()=>{observer.disconnect();window.removeEventListener('resize',resize);};
 },[]);
 return <App/>;
}
createRoot(document.getElementById('root')!).render(<Preview/>);
