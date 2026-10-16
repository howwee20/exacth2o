import { useRef, type PointerEvent } from 'react';
import type { DirectTarget } from './DirectExperiment';
export function TargetHandle({target,top,left,pixelsPerPercent}:{target:DirectTarget;top:number;left:number;pixelsPerPercent:number}) {
 const drag=useRef<{y:number;value:number;scale:number}|null>(null);
 const start=(e:PointerEvent<HTMLButtonElement>)=>{if(target.disabled)return;e.preventDefault();e.stopPropagation();e.currentTarget.setPointerCapture(e.pointerId);drag.current={y:e.clientY,value:target.value,scale:pixelsPerPercent};};
 return <button type="button" className="px-target-handle" role="slider" aria-label={`${target.label} target`} aria-valuemin={0} aria-valuemax={80} aria-valuenow={target.value} aria-valuetext={`${target.value}% target for ${target.label}`} aria-orientation="vertical" disabled={target.disabled}
 style={{top,left}} title="Drag up or down. Arrow keys change 1%. Use the target field for an exact value."
 onPointerDown={start} onPointerMove={e=>{if(drag.current)target.onChange(Math.max(0,Math.min(80,Math.round(drag.current.value+(drag.current.y-e.clientY)/drag.current.scale))));}}
 onPointerUp={e=>{drag.current=null;if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);}} onPointerCancel={()=>{drag.current=null;}}
 onKeyDown={e=>{if(['ArrowUp','ArrowDown','Home','End'].includes(e.key)){e.preventDefault();e.stopPropagation();target.onChange(e.key==='Home'?0:e.key==='End'?80:target.value+(e.key==='ArrowUp'?1:-1));}}}>
 <span aria-hidden="true">⠿</span> {target.label} <strong>{target.value}% target</strong>
 </button>;
}
