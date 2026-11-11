import{c as o,j as e,r as l}from"./demo-B9o0U9nW.js";import{a4 as d,f as h,g as u,a5 as p,a2 as f}from"./App-Bgp2HVJd.js";import{C as y}from"./download-BPr25Ncr.js";/**
 * @license lucide-react v0.468.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const x=o("CircleCheck",[["circle",{cx:"12",cy:"12",r:"10",key:"1mglay"}],["path",{d:"m9 12 2 2 4-4",key:"dzmm74"}]]);/**
 * @license lucide-react v0.468.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const m=o("CircleX",[["circle",{cx:"12",cy:"12",r:"10",key:"1mglay"}],["path",{d:"m15 9-6 6",key:"1uzhvr"}],["path",{d:"m9 9 6 6",key:"z0biqf"}]]);/**
 * @license lucide-react v0.468.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const j=o("Info",[["circle",{cx:"12",cy:"12",r:"10",key:"1mglay"}],["path",{d:"M12 16v-4",key:"1dtifu"}],["path",{d:"M12 8h.01",key:"e9boi3"}]]);/**
 * @license lucide-react v0.468.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const g=o("WifiOff",[["path",{d:"M12 20h.01",key:"zekei9"}],["path",{d:"M8.5 16.429a5 5 0 0 1 7 0",key:"1bycff"}],["path",{d:"M5 12.859a10 10 0 0 1 5.17-2.69",key:"1dl1wf"}],["path",{d:"M19 12.859a10 10 0 0 0-2.007-1.523",key:"4k23kn"}],["path",{d:"M2 8.82a15 15 0 0 1 4.177-2.643",key:"1grhjp"}],["path",{d:"M22 8.82a15 15 0 0 0-11.288-3.764",key:"z3jwby"}],["path",{d:"m2 2 20 20",key:"1ooewy"}]]),k={ok:x,warning:h,bad:m,unknown:d,info:j};function C({tone:t,children:s}){const r=k[t];return e.jsxs("span",{className:`settings-chip is-${t}`,children:[e.jsx(r,{size:13,"aria-hidden":"true"}),e.jsx("span",{children:s})]})}function N({value:t,label:s,maxLength:r=22}){const[a,i]=l.useState(!1),n=l.useRef(null);if(l.useEffect(()=>()=>{n.current!=null&&window.clearTimeout(n.current)},[]),!t)return e.jsx("span",{className:"settings-empty-value",children:"Not reported"});async function c(){if(t)try{await navigator.clipboard.writeText(t),i(!0),n.current!=null&&window.clearTimeout(n.current),n.current=window.setTimeout(()=>i(!1),1800)}catch{i(!1)}}return e.jsxs("span",{className:"settings-copyable",children:[e.jsx("code",{title:t,children:p(t,r)}),e.jsx("button",{type:"button",onClick:()=>void c(),"aria-label":a?`${s} copied`:`Copy ${s}`,children:a?e.jsx(f,{size:13,"aria-hidden":"true"}):e.jsx(y,{size:13,"aria-hidden":"true"})}),e.jsx("span",{className:"settings-visually-hidden",role:"status",children:a?`${s} copied`:""})]})}function M({presence:t}){return t.status==="online"?null:e.jsxs("p",{className:"settings-queued-note",role:"note",children:[e.jsx(g,{size:15,"aria-hidden":"true"}),e.jsx("span",{children:t.status==="never"?"Waiting for the controller to connect before settings can change.":"Controller offline. Reconnect before changing settings."})]})}function T({title:t,tone:s,status:r,lines:a,actionLabel:i,onAction:n}){return e.jsxs("section",{className:"settings-readiness-tile",children:[e.jsxs("header",{children:[e.jsx("h3",{children:t}),e.jsx(C,{tone:s,children:r})]}),e.jsx("dl",{children:a.map(c=>e.jsxs("div",{children:[e.jsx("dt",{children:c.label}),e.jsx("dd",{children:c.value})]},c.label))}),i&&n?e.jsxs("button",{type:"button",className:"settings-text-action",onClick:n,children:[i," ",e.jsx(u,{size:14,"aria-hidden":"true"})]}):null]})}function v({title:t,children:s}){return e.jsxs("div",{className:"settings-empty-state",children:[e.jsx("strong",{children:t}),s?e.jsx("p",{children:s}):null]})}export{x as C,M as Q,T as R,C as S,N as a,v as b};
