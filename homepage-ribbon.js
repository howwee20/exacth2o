/* Homepage backgrounds: a rolling 3D sheet of moisture traces, drawn like the portal's VWC lines. Decorative only.
   Two looks, chosen by the canvas's data-hero-ribbon value: "sheet" (behind "Discuss your setup", shown faintly;
   see .cta-strip .hero-ribbon in homepage.css) and "graph".
   The "graph" look is stored, not in use: it sat behind the hero headline until 14 Nov 2026. To use it again, put
   <canvas class="hero-ribbon" data-hero-ribbon="graph" aria-hidden="true"></canvas> as the first child of any
   section that is position: relative. */
(function () {
  var N = 40, STEPS = 200, CH = 5, DAYS = 9, FOCAL = 520;
  var still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function hash(a, b) {
    var x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return x - Math.floor(x);
  }
  // The portal's own color rule (research-portal/src/potColors.ts): one fixed color per physical pot number.
  function potColor(pot) {
    var hue = (pot * 137.50776405003785) % 360, sat = (72 + (pot % 4) * 4) / 100, lig = (40 + (pot % 3) * 5) / 100;
    var c = (1 - Math.abs(2 * lig - 1)) * sat, x = c * (1 - Math.abs((hue / 60) % 2 - 1)), m = lig - c / 2;
    var rgb = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
    return { hue: hue, rgb: [(rgb[0] + m) * 255, (rgb[1] + m) * 255, (rgb[2] + m) * 255] };
  }
  // Pots 37 to 76, laid across the sheet in hue order so neighbouring traces blend.
  var pots = [];
  for (var pot = 37; pot < 37 + N; pot++) pots.push(potColor(pot));
  pots.sort(function (u, v) { return u.hue - v.hue; });
  var traces = [];
  for (var n = 0; n < N; n++) {
    traces.push({ lane: (n / (N - 1)) * 2 - 1, rgb: pots[n].rgb, drought: n % 3 === 1, phase: hash(n, 3) * 0.25, period: 1.6 + hash(n, 5) * 1.4 });
  }
  // Moisture-like signal: a daily wave, a jump at each watering, then a dry-down. Drought pots step down instead.
  function signal(tr, i, day) {
    var wave = 0.03 * Math.sin((day + tr.phase) * Math.PI * 2);
    var k = Math.floor(day / tr.period), f = day / tr.period - k, rise = Math.min(1, f * 30);
    if (tr.drought) return wave - 0.1 * f - (hash(i, k) - 0.35) * 0.14 * rise + 0.05;
    return wave + (0.05 + hash(i, k) * 0.2) * Math.exp(-f * 2.6) * rise - 0.05;
  }
  // Light from the upper left: face-on parts lift toward white, parts turned away deepen.
  function shade(rgb, light) {
    var r = rgb[0], g = rgb[1], b = rgb[2];
    if (light > 0) { r += (255 - r) * light; g += (255 - g) * light; b += (255 - b) * light; }
    else { var d = 1 + light * 0.3; r *= d; g *= d; b *= d; }
    return 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')';
  }

  /* Two looks: "graph" is a flat portal-style moisture graph, "sheet" is the rolling 3D sheet. Either can sit behind
     the opening copy (text on the left) or the closing strip (text in the middle). */
  function mount(canvas) {
    var host = canvas.parentElement, ctx = canvas.getContext('2d');
    var graph = canvas.getAttribute('data-hero-ribbon') === 'graph', strip = host.classList.contains('cta-strip');
    var W = 0, H = 0, running = false, visible = true;
    var pts = traces.map(function () { return new Float32Array((STEPS + 1) * 3); });
    var roll = new Float32Array(STEPS + 1);
    // Pointer brushing: where the pointer is, how hard it is pressing in, and the wake it leaves along the sheet.
    var brush = { x: 0, y: 0, vx: 0, vy: 0, on: 0, over: false, at: 0 };
    var wake = new Float32Array(STEPS + 1), wakeSpeed = new Float32Array(STEPS + 1), wakeAt = new Float32Array(STEPS + 1);

    function resize() {
      var rect = host.getBoundingClientRect();
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = document.documentElement.clientWidth; H = Math.round(rect.height);
      canvas.style.left = -rect.left + 'px';
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // Thin the drawing where the text sits: the middle of the closing strip, the left of the opening.
    function clearForText() {
      var narrow = W <= 900, fade = ctx.createLinearGradient(0, 0, W, 0);
      ctx.globalCompositeOperation = 'destination-out';
      if (strip) {
        var wide = narrow ? 0.05 : 0.24;
        fade.addColorStop(0, 'rgba(0,0,0,0.25)');
        fade.addColorStop(wide, 'rgba(0,0,0,0.3)');
        fade.addColorStop(Math.min(0.49, wide + 0.12), 'rgba(0,0,0,0.9)');
        fade.addColorStop(Math.max(0.51, 1 - wide - 0.12), 'rgba(0,0,0,0.9)');
        fade.addColorStop(1 - wide, 'rgba(0,0,0,0.2)');
        fade.addColorStop(1, 'rgba(0,0,0,0)');
      } else {
        fade.addColorStop(0, 'rgba(0,0,0,0.96)');
        fade.addColorStop(narrow ? 0.5 : 0.36, 'rgba(0,0,0,0.84)');
        fade.addColorStop(narrow ? 1 : 0.6, narrow ? 'rgba(0,0,0,0.7)' : 'rgba(0,0,0,0)');
      }
      ctx.fillStyle = fade;
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
    }

    // Opening: nothing is drawn behind the words. The copy block is cleared with a soft edge, wherever it sits.
    function clearCopy() {
      var copy = host.querySelector('.cinema-content');
      if (!copy) { clearForText(); return; }
      var box = copy.getBoundingClientRect(), frame = canvas.getBoundingClientRect();
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.shadowColor = '#000'; ctx.shadowBlur = 70;
      ctx.fillStyle = '#000';
      for (var pass = 0; pass < 2; pass++) ctx.fillRect(box.left - frame.left - 10, box.top - frame.top - 6, box.width + 20, box.height + 12);
      ctx.restore();
    }

    /* A few pots as a researcher sees them on the portal graph, with other traces passing through at random. */
    function drawGraph(t) {
      ctx.clearRect(0, 0, W, H);
      // Behind the opening copy the graph is drawn large: fewer days across, taller, heavier lines.
      var big = !strip, span = big ? (W <= 900 ? 1.8 : 3.2) : (W <= 900 ? 3 : 6), now = 400 + t * (big ? 0.065 : 0.11), x0 = now - span * 0.94;
      var y = function (v) { return big ? H * 0.97 - ((v - 6) / 40) * H * 0.92 : H * 0.9 - ((v - 5) / 40) * H * 0.8; };
      var g, d, i, k;
      // Behind the opening copy the graph is a quiet backdrop: traces only, no grid or target lines.
      if (!big) {
      ctx.lineWidth = 1; ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(16,31,26,0.07)';
      for (g = 10; g <= 40; g += 10) { ctx.beginPath(); ctx.moveTo(0, y(g)); ctx.lineTo(W, y(g)); ctx.stroke(); }
      for (d = Math.ceil(x0); d <= now; d++) { var gx = ((d - x0) / span) * W; ctx.beginPath(); ctx.moveTo(gx, y(45)); ctx.lineTo(gx, y(5)); ctx.stroke(); }
      // Treatment targets, dashed as on the portal: control 30%, drought 10%.
      ctx.strokeStyle = 'rgba(16,31,26,0.3)'; ctx.setLineDash([5, 5]);
      [30, 10].forEach(function (target) { ctx.beginPath(); ctx.moveTo(0, y(target)); ctx.lineTo(W, y(target)); ctx.stroke(); });
      }
      ctx.lineJoin = 'round'; ctx.lineWidth = big ? 2.6 : 1.7;
      var dot = big ? 4.5 : 3;
      var cols = Math.ceil(W / 3);
      for (i = 0; i < 5; i++) {
        var drought = i === 1 || i === 3, c = potColor(65 + i * 2 + (i > 2 ? 1 : 0)).rgb;
        var last = 0, live = Math.floor(cols * 0.94);
        ctx.beginPath();
        for (k = 0; k <= live; k++) {
          var day = x0 + (k / cols) * span;
          var wave = Math.sin((day + hash(i, 1) * 0.2) * Math.PI * 2) * (1.1 + hash(i, 2) * 0.9) + Math.sin(day * 7.3 + i * 1.7) * 0.25;
          var v;
          if (drought) {
            // Dries down from the control level to the drought target, then holds there on small pulses.
            var cycle = 5 + hash(i, 4) * 3, f = ((day + hash(i, 6) * cycle) / cycle) % 1;
            var held = (day * 2.2 + hash(i, 8)) % 1;
            var stepDown = Math.floor(f * 6) / 6 * 3 * hash(i, Math.floor(day / cycle) + 11);
            v = f < 0.72 ? 33 - 22 * Math.pow(f / 0.72, 0.75) - stepDown * (1 - f) + wave * (1 - f) : f < 0.96 ? 11 + 2.4 * Math.exp(-held * 3) + wave * 0.3 : 11 + (f - 0.96) / 0.04 * 22;
          } else {
            // Holds at target: each watering pulse lifts the pot, then it dries back until the next one.
            var period = 0.3 + hash(i, 3) * 0.35, n = Math.floor(day / period), frac = day / period - n;
            // Most pulses are small; about one in six is a heavy watering that takes a day to dry back.
            var big = hash(i, n + 40) > 0.84 ? 6 + hash(i, n + 80) * 5 : 0;
            v = 30 + (1.2 + hash(i, n) * 3.2 + big) * Math.exp(-frac * (big ? 1.2 : 2.4)) * Math.min(1, frac * 60) + wave * 0.6 + hash(i, 5) * 2;
          }
          ctx.lineTo((k / cols) * W, y(v));
          last = v;
        }
        var ink = 'rgb(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ')';
        ctx.setLineDash(drought ? (big ? [11, 8] : [7, 5]) : []);
        ctx.strokeStyle = ink;
        ctx.globalAlpha = big ? 0.36 : 1;
        ctx.stroke();
        // The newest reading of each pot: a dot with a slow pulse, like a live point on the graph.
        var lx = (live / cols) * W, beat = (t * 0.6 + i * 0.13) % 1;
        ctx.setLineDash([]);
        ctx.fillStyle = ink;
        ctx.globalAlpha = 0.28 * (1 - beat);
        // (the stroke above used the backdrop strength; live points stay at full colour)
        ctx.beginPath(); ctx.arc(lx, y(last), dot + beat * dot * 3, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
        ctx.beginPath(); ctx.arc(lx, y(last), dot, 0, Math.PI * 2); ctx.fill();
      }
      ctx.setLineDash([]);
      // Passing traces: now and then another pot's line sweeps across at its own level, colour and pace, then is gone.
      for (i = 0; i < (big ? 1 : 4); i++) {
        var lap = 9 + i * 3.7, turn = Math.floor((t + i * 5.3) / lap), go = (t + i * 5.3) / lap - turn;
        if (hash(i + 20, turn) < 0.3) continue;
        var level = 8 + hash(i + 30, turn) * 34, tint = potColor(1 + Math.floor(hash(i + 50, turn) * 100)).rgb;
        var head = -0.1 + go * 1.5, tail = head - 0.22 - hash(i + 60, turn) * 0.2;
        var from = Math.max(0, Math.floor(tail * cols)), to = Math.min(cols, Math.floor(head * cols));
        if (to <= from) continue;
        var stroke = ctx.createLinearGradient(tail * W, 0, head * W, 0);
        var rgb = (tint[0] | 0) + ',' + (tint[1] | 0) + ',' + (tint[2] | 0);
        stroke.addColorStop(0, 'rgba(' + rgb + ',0)');
        stroke.addColorStop(1, 'rgba(' + rgb + ',' + (big ? 0.4 : 0.85) + ')');
        ctx.beginPath();
        var py = 0;
        for (k = from; k <= to; k++) {
          var u = (k / cols) * span + turn * 3.1 + i;
          var pulse = u / 0.45 - Math.floor(u / 0.45);
          py = y(level + Math.sin(u * Math.PI * 2) * 1.2 + (1 + hash(i + 70, Math.floor(u / 0.45)) * 3) * Math.exp(-pulse * 2.4) * Math.min(1, pulse * 40));
          ctx.lineTo((k / cols) * W, py);
        }
        ctx.strokeStyle = stroke;
        ctx.setLineDash(hash(i + 90, turn) > 0.6 ? [7, 5] : []);
        ctx.stroke();
        ctx.setLineDash([]);
        if (head < 1) { ctx.fillStyle = 'rgb(' + rgb + ')'; ctx.beginPath(); ctx.arc((to / cols) * W, py, dot * 0.85, 0, Math.PI * 2); ctx.fill(); }
      }
      if (big) clearCopy(); else clearForText();
    }

    function draw(t) {
      if (graph) { drawGraph(t); return; }
      ctx.clearRect(0, 0, W, H);
      var narrow = W <= 900;
      var half = strip ? Math.min(H * 0.2, 80) : narrow ? Math.min(H * 0.1, 90) : Math.min(H * 0.22, 170);
      var j, i, s;
      for (j = 0; j <= STEPS; j++) {
        s = j / STEPS;
        var x = -W * 0.08 + s * W * 1.16;
        var cy = strip
          ? H * 0.6 + Math.sin(s * 5 + t * 0.12) * H * 0.12
          : H * (narrow ? 0.52 : 0.82) - Math.pow(s, 2.1) * H * (narrow ? 0.08 : 0.64) + Math.sin(s * 4.6 + t * 0.2) * H * 0.035;
        var angle = s * 5.2 - 1.2 + t * 0.14 + Math.sin(t * 0.09 + s * 2.2) * 0.4;
        var c = Math.cos(angle), sn = Math.sin(angle);
        roll[j] = angle;
        var day = s * DAYS - t * 0.1;
        for (i = 0; i < N; i++) {
          var tr = traces[i], sig = signal(tr, i, day);
          var a = (tr.lane + sig * 0.7) * half, b = sig * half * 1.5;
          var z = a * sn + b * c, p = FOCAL / (FOCAL + z), o = j * 3;
          pts[i][o] = W * 0.5 + (x - W * 0.5) * (0.88 + 0.12 * p);
          pts[i][o + 1] = cy + (a * c - b * sn) * p;
          pts[i][o + 2] = p;
        }
      }
      // The pointer parts the traces around itself and drags a wake that springs back after it passes.
      var dt = Math.min(0.05, Math.max(0.001, t - brush.at)); brush.at = t;
      brush.on += ((brush.over ? 1 : 0) - brush.on) * Math.min(1, dt * 6);
      for (j = 0; j <= STEPS; j++) {
        var colX = pts[0][j * 3], near = Math.exp(-Math.pow((colX - brush.x) / 70, 2));
        if (brush.over) {
          wakeSpeed[j] += (brush.vy * 0.5 + (colX > brush.x ? 1 : -1) * Math.abs(brush.vx) * 0.12) * near * dt * 9;
          wakeAt[j] += (brush.y - wakeAt[j]) * near;
        }
        wakeSpeed[j] += (-wake[j] * 42 - wakeSpeed[j] * 3.4) * dt;
        wake[j] += wakeSpeed[j] * dt;
      }
      brush.vx *= 0.8; brush.vy *= 0.8;
      if (brush.on > 0.01 || strip) {
        for (i = 0; i < N; i++) {
          for (j = 0; j <= STEPS; j++) {
            var px = pts[i][j * 3], pyy = pts[i][j * 3 + 1], ddx = px - brush.x, ddy = pyy - brush.y;
            var dist = Math.sqrt(ddx * ddx + ddy * ddy) + 0.001;
            var part = Math.exp(-(dist * dist) / 9000) * 46 * brush.on;
            pts[i][j * 3] = px + (ddx / dist) * part * 0.35;
            pts[i][j * 3 + 1] = pyy + (ddy / dist) * part + wake[j] * Math.exp(-Math.pow((pyy - wakeAt[j]) / 90, 2));
          }
        }
      }
      // Far pieces first, so the near side of the sheet overlaps the far side where it turns over.
      var pieces = [], chunks = STEPS / CH, k, mid;
      for (k = 0; k < chunks; k++) {
        mid = (k * CH + (CH >> 1)) * 3 + 2;
        for (i = 0; i < N; i++) {
          pieces.push({ k: k, i: i, p: pts[i][mid], band: false });
          if (i < N - 1) pieces.push({ k: k, i: i, p: (pts[i][mid] + pts[i + 1][mid]) / 2 - 0.001, band: true });
        }
      }
      pieces.sort(function (u, v) { return u.p - v.p; });
      ctx.lineJoin = 'round'; ctx.lineCap = 'butt';
      for (var q = 0; q < pieces.length; q++) {
        var pc = pieces[q], j0 = pc.k * CH, j1 = j0 + CH, A = pts[pc.i], trc = traces[pc.i];
        var near = Math.max(0, Math.min(1, (pc.p - 0.74) / 0.62));
        var ang = roll[j0 + (CH >> 1)];
        // Surface normal against the light direction, with a narrow highlight where they line up.
        var facing = Math.cos(ang - 0.7), light = facing * 0.34 + Math.pow(Math.max(0, facing), 14) * 0.5;
        ctx.beginPath();
        if (pc.band) {
          var B = pts[pc.i + 1];
          for (j = j0; j <= j1; j++) ctx.lineTo(A[j * 3], A[j * 3 + 1]);
          for (j = j1; j >= j0; j--) ctx.lineTo(B[j * 3], B[j * 3 + 1]);
          ctx.closePath();
          ctx.globalAlpha = 0.34 + 0.34 * (1 - Math.abs(Math.cos(ang))) + 0.14 * near;
          ctx.fillStyle = shade(trc.rgb, light);
          ctx.fill();
        } else {
          for (j = j0; j <= j1; j++) ctx.lineTo(A[j * 3], A[j * 3 + 1]);
          ctx.setLineDash(trc.drought ? [7 * pc.p, 5 * pc.p] : []);
          ctx.lineDashOffset = -j0 * 2.4;
          ctx.globalAlpha = 0.3 + 0.7 * near;
          ctx.lineWidth = 0.5 + 1.5 * near;
          ctx.strokeStyle = shade(trc.rgb, light * 0.5 - 0.05);
          ctx.stroke();
        }
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      clearForText();
      // Soften the foot so the sheet never ends on a hard edge.
      ctx.globalCompositeOperation = 'destination-out';
      var foot = ctx.createLinearGradient(0, H - 72, 0, H);
      foot.addColorStop(0, 'rgba(0,0,0,0)');
      foot.addColorStop(1, 'rgba(0,0,0,1)');
      ctx.fillStyle = foot;
      ctx.fillRect(0, H - 72, W, 72);
      ctx.globalCompositeOperation = 'source-over';
    }

    function frame(ms) {
      if (!visible || document.hidden) { running = false; return; }
      draw(ms / 1000);
      requestAnimationFrame(frame);
    }
    function start() {
      if (still || running) return;
      running = true;
      requestAnimationFrame(frame);
    }
    if (!graph && !still) {
      host.addEventListener('pointermove', function (event) {
        var box = canvas.getBoundingClientRect(), x = event.clientX - box.left, y = event.clientY - box.top;
        if (brush.over) { brush.vx += (x - brush.x) * 6; brush.vy += (y - brush.y) * 6; }
        brush.x = x; brush.y = y; brush.over = true;
      });
      host.addEventListener('pointerleave', function () { brush.over = false; });
    }
    function redraw() { resize(); draw(still ? 40 : performance.now() / 1000); }
    redraw();
    window.addEventListener('resize', redraw);
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) { visible = entries[0].isIntersecting; start(); }).observe(host);
    }
    document.addEventListener('visibilitychange', start);
    start();
  }

  var canvases = document.querySelectorAll('[data-hero-ribbon]');
  for (var m = 0; m < canvases.length; m++) if (canvases[m].getContext) mount(canvases[m]);

  /* Sections below the first screen rise into place once, as they are scrolled to. */
  if (still || !('IntersectionObserver' in window)) return;
  var targets = document.querySelectorAll('.home-page .home-head, .home-page .features-grid > *, .home-page [data-homepage-traces] .home-inner > :not(.home-head), .home-page .cta-strip > :not(canvas)');
  var seen = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      entry.target.classList.remove('reveal-wait');
      seen.unobserve(entry.target);
    });
  }, { rootMargin: '0px 0px -8% 0px' });
  for (var r = 0; r < targets.length; r++) {
    if (targets[r].getBoundingClientRect().top < window.innerHeight) continue;
    targets[r].classList.add('reveal', 'reveal-wait');
    seen.observe(targets[r]);
  }
})();
