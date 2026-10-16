import {useEffect,useRef,type ReactNode} from 'react';
export function PotInspector({onClose,children}:{onClose:()=>void;children:ReactNode}) {
 const close=useRef<HTMLButtonElement>(null);const callback=useRef(onClose);callback.current=onClose;
 useEffect(()=>{const previous=document.activeElement as HTMLElement|null;close.current?.focus();const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.stopPropagation();callback.current();}};document.addEventListener('keydown',escape);return()=>{document.removeEventListener('keydown',escape);previous?.focus();};},[]);
 return <aside className="px-pot-inspector" aria-label="Pot inspector"><button ref={close} className="px-button px-inspector-close" onClick={onClose}>Close pot details</button>{children}</aside>;
}
