/* Homepage hero background: a rolling 3D sheet of moisture traces, drawn like the portal's VWC lines. Decorative only. */
(function () {
  var canvas = document.querySelector('[data-hero-ribbon]');
  if (!canvas || !canvas.getContext) return;
  var hero = canvas.parentElement;
  var ctx = canvas.getContext('2d');
  var N = 40, STEPS = 200, CH = 5, DAYS = 9, FOCAL = 520;
  var W = 0, H = 0, running = false, visible = true;
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

  function resize() {
    var rect = hero.getBoundingClientRect();
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = document.documentElement.clientWidth; H = Math.round(rect.height);
    canvas.style.left = -rect.left + 'px';
    canvas.style.width = W + 'px';
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  var pts = traces.map(function () { return new Float32Array((STEPS + 1) * 3); });
  var roll = new Float32Array(STEPS + 1);
  function draw(t) {
    ctx.clearRect(0, 0, W, H);
    var narrow = W <= 900;
    var half = narrow ? Math.min(H * 0.1, 90) : Math.min(H * 0.24, 170);
    var j, i, s;
    for (j = 0; j <= STEPS; j++) {
      s = j / STEPS;
      var x = -W * 0.08 + s * W * 1.16;
      // Runs left to right: under the copy, behind the photograph, out past the top right.
      var cy = H * (narrow ? 0.5 : 0.8) - Math.pow(s, 2.1) * H * (narrow ? 0.08 : 0.6) + Math.sin(s * 4.6 + t * 0.2) * H * 0.035;
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
    // Thin the sheet out toward the left so the copy keeps its contrast, and at the foot so it never ends on a hard edge.
    ctx.globalCompositeOperation = 'destination-out';
    var fade = ctx.createLinearGradient(0, 0, W, 0);
    fade.addColorStop(0, 'rgba(0,0,0,0.96)');
    fade.addColorStop(narrow ? 0.5 : 0.36, 'rgba(0,0,0,0.84)');
    fade.addColorStop(narrow ? 1 : 0.6, narrow ? 'rgba(0,0,0,0.7)' : 'rgba(0,0,0,0)');
    ctx.fillStyle = fade;
    ctx.fillRect(0, 0, W, H);
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
  resize();
  draw(still ? 40 : performance.now() / 1000);
  window.addEventListener('resize', function () { resize(); draw(still ? 40 : performance.now() / 1000); });
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) { visible = entries[0].isIntersecting; start(); }).observe(hero);
  }
  document.addEventListener('visibilitychange', start);
  start();
})();
