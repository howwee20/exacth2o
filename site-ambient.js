// Faint fields of sensor-style readings drift behind page headers.
// Decorative only: the canvas is hidden from assistive technology, steers around
// the host's content, pauses when offscreen, and stays still under reduced motion.
(() => {
  const hosts = [...document.querySelectorAll('[data-ambient]')];
  if (!hosts.length || !window.HTMLCanvasElement) return;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const FRAME_MS = 90;

  // Seeded so a still frame is identical between visits and screenshot runs.
  function random(seed) {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state ^ (state >>> 15), 2246822507) + 0x9e3779b9) >>> 0;
      state = Math.imul(state ^ (state >>> 13), 3266489909) >>> 0;
      return ((state ^ (state >>> 16)) >>> 0) / 4294967296;
    };
  }
  const smooth = t => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

  function reading(next) {
    const kind = next();
    if (kind < 0.45) return (12 + next() * 30).toFixed(1);      // moisture, % VWC
    if (kind < 0.7) return (0.1 + next() * 0.4).toFixed(3);     // volumetric fraction
    if (kind < 0.88) return (18 + next() * 9).toFixed(1);       // temperature, °C
    return String(Math.floor(next() * 96) + 1).padStart(2, '0'); // pot index
  }

  function field(host, index) {
    const style = getComputedStyle(host);
    const color = style.getPropertyValue('--ambient-color').trim() || '23 100 73';
    const peak = parseFloat(style.getPropertyValue('--ambient-opacity')) || 0.1;
    const size = parseFloat(style.getPropertyValue('--ambient-size')) || 12;
    const canvas = document.createElement('canvas');
    canvas.className = 'ambient-field';
    canvas.setAttribute('aria-hidden', 'true');
    host.append(canvas);
    const context = canvas.getContext('2d');
    if (!context) return;

    const next = random(0x51ed + index * 7919);
    const blobs = Array.from({ length: 4 }, () => ({
      x: next() * Math.PI * 2, y: next() * Math.PI * 2,
      sx: 0.000016 + next() * 0.00001, sy: 0.000013 + next() * 0.00001,
      r: 0.22 + next() * 0.16,
    }));
    let cols = 0, rows = 0, width = 0, height = 0, cellW = 0, cellH = 0;
    let glyphs = [], grain = [], tails = [], quiet = [];
    let clock = 0, last = 0, frame = 0, visible = true;

    function layout() {
      const rect = host.getBoundingClientRect();
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = width * ratio; canvas.height = height * ratio;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      cellW = size * 0.62; cellH = size * 1.6;
      cols = Math.ceil(width / cellW); rows = Math.ceil(height / cellH);
      glyphs = []; grain = []; tails = [];
      const fill = random(0xa11 + index * 131);
      for (let row = 0; row < rows; row++) {
        let line = '';
        while (line.length < cols) {
          const value = reading(fill);
          // The last digit of each reading is the one that ticks.
          if (line.length + value.length <= cols) tails.push(row * cols + line.length + value.length - 1);
          line += value + ' '.repeat(1 + Math.floor(fill() * 3));
        }
        for (let col = 0; col < cols; col++) { glyphs.push(line[col]); grain.push(fill()); }
      }
      // Readings thin out around the host's own words, controls and images,
      // measured by what they draw rather than by their full-width boxes.
      const range = document.createRange();
      const boxes = [...host.children].filter(child => child !== canvas && !child.hasAttribute('data-ambient-ignore'))
        .map(child => {
          const own = child.getBoundingClientRect();
          if (/^(IMG|SVG|PICTURE|VIDEO|CANVAS|IFRAME)$/i.test(child.tagName)) return own;
          range.selectNodeContents(child);
          const drawn = range.getBoundingClientRect();
          return drawn.width && drawn.height ? drawn : own;
        })
        .filter(box => box.width && box.height)
        .map(box => ({ l: box.left - rect.left, t: box.top - rect.top, r: box.right - rect.left, b: box.bottom - rect.top }));
      quiet = new Float32Array(cols * rows);
      for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
        const x = (col + 0.5) * cellW, y = (row + 0.5) * cellH;
        let distance = Infinity;
        for (const box of boxes) {
          const dx = Math.max(box.l - x, 0, x - box.r), dy = Math.max(box.t - y, 0, y - box.b);
          distance = Math.min(distance, Math.hypot(dx, dy));
        }
        const edge = smooth(Math.min(x, width - x, y, height - y) / 40);
        quiet[row * cols + col] = edge * (boxes.length ? 0.06 + 0.94 * smooth((distance - 16) / 64) : 1);
      }
    }

    function draw() {
      context.clearRect(0, 0, width, height);
      context.font = `400 ${size}px 'DM Mono', ui-monospace, SFMono-Regular, Menlo, monospace`;
      context.textBaseline = 'top';
      context.fillStyle = `rgb(${color})`;
      const span = Math.max(width, height);
      const centers = blobs.map(blob => ({
        x: width * (0.5 + 0.48 * Math.sin(blob.x + clock * blob.sx)),
        y: height * (0.5 + 0.46 * Math.sin(blob.y + clock * blob.sy)),
        r: blob.r * span,
      }));
      for (let row = 0; row < rows; row++) {
        const y = row * cellH + (cellH - size) / 2;
        for (let col = 0; col < cols; col++) {
          const cell = row * cols + col, glyph = glyphs[cell];
          if (glyph === ' ') continue;
          const x = col * cellW;
          let strength = 0;
          for (const center of centers) {
            const d = Math.hypot(x - center.x, y - center.y) / center.r;
            if (d < 1) strength = Math.max(strength, 1 - d * d);
          }
          strength *= quiet[cell];
          if (strength < grain[cell] * 0.85) continue;
          const alpha = peak * strength * (0.45 + 0.55 * grain[cell]);
          if (alpha < 0.008) continue;
          context.globalAlpha = alpha;
          context.fillText(glyph, x, y);
        }
      }
      context.globalAlpha = 1;
    }

    // A few readings settle by one step each frame, the way live values drift.
    function refresh() {
      const changes = Math.max(1, Math.round(tails.length * 0.03));
      for (let i = 0; i < changes; i++) {
        const cell = tails[Math.floor(Math.random() * tails.length)];
        const digit = Number(glyphs[cell]);
        glyphs[cell] = String((digit + (Math.random() < 0.5 ? 9 : 1)) % 10);
      }
    }

    function loop(now) {
      frame = 0;
      if (!running()) return;
      if (now - last >= FRAME_MS) {
        clock += last ? Math.min(now - last, 250) : 0;
        last = now;
        refresh(); draw();
      }
      frame = requestAnimationFrame(loop);
    }
    const running = () => visible && !document.hidden && !reducedMotion.matches;
    function sync() {
      if (running()) { if (!frame) { last = 0; frame = requestAnimationFrame(loop); } }
      else { cancelAnimationFrame(frame); frame = 0; draw(); }
    }

    layout(); draw(); sync();
    let resizeFrame = 0;
    const relayout = () => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => { layout(); draw(); });
    };
    if ('ResizeObserver' in window) new ResizeObserver(relayout).observe(host);
    else window.addEventListener('resize', relayout);
    document.fonts?.ready.then(relayout);
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); }).observe(host);
    }
    document.addEventListener('visibilitychange', sync);
    reducedMotion.addEventListener('change', sync);
  }

  hosts.forEach(field);
})();
