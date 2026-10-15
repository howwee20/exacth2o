// Decorative sensor readings and flowing water. No live telemetry is implied.
(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const smooth = x => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
  document.querySelectorAll('[data-ambient]').forEach((host, index) => {
    const canvas = document.createElement('canvas');
    canvas.className = 'ambient-field'; canvas.setAttribute('aria-hidden', 'true');
    host.append(canvas);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const water = host.dataset.ambient === 'water';
    const style = getComputedStyle(host);
    const color = style.getPropertyValue('--ambient-color').trim() || '142 211 184';
    const peak = parseFloat(style.getPropertyValue('--ambient-opacity')) || .2;
    let w = 1, h = 1, quiet = [], points = [], time = 0, last = 0, frame = 0, visible = true;
    function layout() {
      const box = host.getBoundingClientRect(); w = box.width; h = box.height;
      const ratio = Math.min(devicePixelRatio || 1, 2);
      canvas.width = Math.round(w * ratio); canvas.height = Math.round(h * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      const range = document.createRange();
      quiet = [...host.children].filter(c => c !== canvas && !c.hasAttribute('data-ambient-ignore')).map(c => {
        range.selectNodeContents(c); const r = range.getBoundingClientRect();
        return {l:r.left-box.left-24,r:r.right-box.left+24,t:r.top-box.top-24,b:r.bottom-box.top+24};
      });
      points = [];
      for (let y = 30, row = 0; y < h; y += 54, row++) {
        for (let x = 24 + (row % 2) * 36; x < w; x += 104) {
          const seed = (row * 17 + x * 13 + index * 29) % 97;
          if (seed % 3 === 0) continue;
          points.push({x,y,phase:seed/97*Math.PI*2,value:18+seed*.23});
        }
      }
      draw();
    }
    function draw() {
      ctx.clearRect(0,0,w,h);
      if (water) {
        // Fine strands travel in coherent ribbons, with broad translucent depth.
        for (let ribbon=0;ribbon<3;ribbon++) {
          for (let strand=0;strand<12;strand++) {
            ctx.beginPath();
            for(let x=-20;x<=w+20;x+=8) {
              const u=x/Math.max(w,1), phase=time*.00018+ribbon*1.8;
              const y=h*(.24+ribbon*.28)+Math.sin(u*6.3+phase)*h*.16+
                Math.sin(u*11-phase*.7)*h*.045+(strand-6)*3.2;
              if(x===-20)ctx.moveTo(x,y);else ctx.lineTo(x,y);
            }
            const gradient=ctx.createLinearGradient(0,0,w,0);
            gradient.addColorStop(0,'rgba(31,126,192,0)');
            gradient.addColorStop(.18,`rgba(31,126,192,${.055+strand*.004})`);
            gradient.addColorStop(.5,'rgba(65,172,212,.035)');
            gradient.addColorStop(.82,`rgba(27,134,196,${.06+strand*.004})`);
            gradient.addColorStop(1,'rgba(31,126,192,0)');
            ctx.strokeStyle=gradient;ctx.lineWidth=strand===5?8:1;ctx.stroke();
          }
        }
      } else {
        ctx.font="400 12px 'DM Mono', ui-monospace, monospace";
        ctx.textBaseline='middle';ctx.fillStyle=`rgb(${color})`;
        for(const p of points) {
          const x=p.x+Math.sin(time*.00018+p.phase)*9;
          const y=p.y+Math.cos(time*.00014+p.phase)*7;
          let distance=Infinity;
          for(const q of quiet) distance=Math.min(distance,Math.hypot(Math.max(q.l-x,0,x-q.r),Math.max(q.t-y,0,y-q.b)));
          const edge=smooth(Math.min(x,w-x,y,h-y)/35);
          const fade=.42+.58*(.5+.5*Math.sin(time*.0006+p.phase));
          ctx.globalAlpha=peak*edge*smooth(distance/45)*fade;
          const value=p.value+Math.sin(time*.0003+p.phase)*.4;
          ctx.fillText(value.toFixed(1),x,y);
        }
        ctx.globalAlpha=1;
      }
    }
    function loop(now) {
      frame=0;
      if(!visible||document.hidden||reduced.matches)return;
      if(!last||now-last>=32){time+=last?Math.min(now-last,100):0;last=now;draw();}
      frame=requestAnimationFrame(loop);
    }
    function sync(){
      cancelAnimationFrame(frame);frame=0;last=0;
      if(reduced.matches){time=0;draw();}
      else if(visible&&!document.hidden)frame=requestAnimationFrame(loop);
    }
    layout();sync();
    new ResizeObserver(layout).observe(host);
    new IntersectionObserver(([entry])=>{visible=entry.isIntersecting;sync();}).observe(host);
    document.fonts?.ready.then(layout);
    document.addEventListener('visibilitychange',sync);reduced.addEventListener('change',sync);
  });
})();
