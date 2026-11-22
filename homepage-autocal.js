/* Homepage bench figure: one bench of 100 black pots in four colour zones and one controller off its end.
   The side of the controller that faces the table carries four rows of 25 valves. A tube runs from every valve to
   the ring on one pot: blue, green, red and white, as on the real benches. Every pot also holds a moisture sensor.
   It opens in a 3D view, seen from the near end of the bench. Scrolling through it plays one move in two parts.
   Hardware: the bench turns right round until it lies level seen from its other side. Data: the bench draws back and the
   live Drought response chart (homepage-traces.js) rises under it. One line, running through the charted pots'
   colours, leaves the bench, rounds the corner of the chart card, slips into its left edge and fades. From the moment
   it arrives the rest plays by itself, with no more scrolling: the colours come back as a glow along the chart's
   axis and bloom at the start of each pot's curve, and the curves draw out across the chart.
   Two captions over the stage swap as the move passes from one part to the other. Decorative. */
(function () {
  var canvas = document.querySelector('[data-autocal-bench]');
  if (!canvas || !canvas.getContext) return;
  var section = canvas.closest('section'), ctx = canvas.getContext('2d');
  // The canvas fills a stage that stays pinned while its tall track scrolls past. The section heading sits over
  // the stage's top left corner.
  var stage = canvas.parentElement, track = canvas.closest('.autocal-track') || stage, head = stage.querySelector('.autocal-head');
  // Two captions share that corner: one for the hardware, one for the data.
  var capA = head && head.querySelector('[data-caption="hardware"]'), capB = head && head.querySelector('[data-caption="data"]');
  // The live chart sits in the stage over the bench canvas, and a second canvas over the chart carries the lines
  // that run from the pots to its curves.
  var chartBox = stage.querySelector('.autocal-chart'), chartSvg = chartBox && chartBox.querySelector('#homepage-trace-chart');
  var links = stage.querySelector('[data-autocal-links]'), lctx = links && links.getContext ? links.getContext('2d') : null;
  var still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var COLS = 25, ROWS = 4;
  // Valve rows on the controller, top to bottom. White tubing is drawn grey so it shows on the white table.
  var zones = [
    { tube: '#2f6fd0', ring: '#3d7fe6' },
    { tube: '#2f9e5b', ring: '#35b266' },
    { tube: '#d63a3f', ring: '#e8454a' },
    { tube: '#b4bdb8', ring: '#f2f4f3' }
  ];
  // Zones as laid out on the bench: the two back rows are white then red, the two front rows green then blue, with
  // red and blue at the controller's end. Each pair of rows shares one bundle of tubes running between them.
  // In a bundle the tubes that turn off first lie on the outside, so none cross.
  var pots = [], lanes = [[], []], used = [0, 0, 0, 0];
  [0, 1].forEach(function (lane) {
    var order = [], c;
    for (c = COLS - 1; c >= 0; c--) order.push(lane * 2 * COLS + c);
    for (c = 0; c < COLS; c++) order.push((lane * 2 + 1) * COLS + c);
    order.forEach(function (n, at) {
      var row = Math.floor(n / COLS), col = n % COLS, far = col < (row % 2 === 0 ? 12 : 13);
      var zone = row < 2 ? (far ? 3 : 2) : (far ? 1 : 0);
      pots[n] = { zone: zone, lane: lane, off: at / (order.length - 1) - 0.5, valve: used[zone]++ };
      lanes[lane].push(n);
    });
  });
  function hash(a, b) { var x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return x - Math.floor(x); }
  function unit(x) { return Math.max(0, Math.min(1, x)); }
  function ease(x) { x = unit(x); return x * x * (3 - 2 * x); }
  pots.forEach(function (pot, n) {
    // Perlite in the soil: a few pale flecks at fixed places, as [x, y, size] within a circle of radius 1.
    pot.grit = [];
    for (var fleck = 0; fleck < 7; fleck++) {
      var turnBy = hash(n, 20 + fleck) * Math.PI * 2, out = Math.sqrt(hash(n, 40 + fleck)) * 0.78;
      pot.grit.push([Math.cos(turnBy) * out, Math.sin(turnBy) * out, 0.04 + hash(n, 60 + fleck) * 0.045]);
    }
    // The sensor head: where it sits in the soil, and the way its cable leaves over the rim.
    var lie = hash(n, 81) * Math.PI * 2, way = lie + 0.6 + hash(n, 83) * 0.8;
    pot.probe = [Math.cos(lie) * 0.3, Math.sin(lie) * 0.3, way];
  });
  var W = 0, H = 0, DPR = 1, reserve = 0, reserveB = 0, edgeL = 24, capRight = 0, visible = false, running = false;
  // How far through the move the figure is, 0 to 1. It trails the scroll a little so the motion glides. With motion
  // turned off it rests at the end, with the chart drawn.
  // The move opens at START, with the figure already tilted and swung into its 3D view.
  var START = 0.24, REST = 1, prog = still ? REST : START;
  // The scroll carries the move as far as END, a little past ARRIVE, where the line reaches the chart. From ARRIVE
  // on a clock takes over: `played` counts the seconds since, and runs back down if the page is scrolled back up.
  var END = 0.88, ARRIVE = 0.761, PLAY = 2.9, played = 0, lastMs = 0;

  // The pots the live chart is showing: for each, its pot, its colour and its curve. They are read from the chart
  // itself, so the lines always match what it draws. Their colours, run end to end in a loop, colour the one line
  // that carries them all.
  var feeds = [], PLOT_LEFT = 42, run = null;
  function readFeeds() {
    if (!chartSvg) return;
    var found = chartSvg.querySelectorAll('path[data-pot]');
    if (found.length === feeds.length && feeds.every(function (feed, i) { return feed.path === found[i]; })) return;
    feeds = [];
    for (var i = 0; i < found.length; i++) {
      var num = parseInt(found[i].getAttribute('data-pot'), 10);
      if (num >= 1 && num <= COLS * ROWS) feeds.push({ n: num - 1, ink: found[i].getAttribute('stroke') || '#2456d6', path: found[i] });
    }
    // The colour run: a strip 256 wide blending through the pots' colours and back to the first. They are taken in
    // hue order, so the line shades smoothly round the colour wheel, and each is softened a little toward white.
    run = null;
    if (feeds.length) {
      var strip = document.createElement('canvas'); strip.width = 256; strip.height = 1;
      var pen = strip.getContext('2d'), wash = pen.createLinearGradient(0, 0, 256, 0);
      var hueOf = function (ink) { var found = /hsl\(\s*(-?[\d.]+)/.exec(ink); return found ? +found[1] : 0; };
      var inks = feeds.map(function (feed) { return feed.ink; }).sort(function (one, two) { return hueOf(one) - hueOf(two); });
      inks.forEach(function (ink, at) { wash.addColorStop(at / inks.length, ink); });
      wash.addColorStop(1, inks[0]); pen.fillStyle = wash; pen.fillRect(0, 0, 256, 1);
      pen.fillStyle = 'rgba(255,255,255,0.14)'; pen.fillRect(0, 0, 256, 1);
      run = pen.getImageData(0, 0, 256, 1).data;
    }
  }
  // Where a feed's curve starts, in the stage's own coordinates: the point where it meets the plot's left edge.
  function startOf(feed, frame) {
    if (feed.path.getAttribute('visibility') === 'hidden') return null;
    var m = (feed.path.getAttribute('d') || '').match(/^M(-?[\d.]+),(-?[\d.]+)(?:L(-?[\d.]+),(-?[\d.]+))?/);
    if (!m) return null;
    var x0 = +m[1], y0 = +m[2], x = x0, y = y0;
    if (m[3] !== undefined && x0 < PLOT_LEFT && +m[3] > x0) { y = y0 + (+m[4] - y0) * (PLOT_LEFT - x0) / (+m[3] - x0); x = PLOT_LEFT; }
    var box = chartSvg.getBoundingClientRect(), view = chartSvg.viewBox.baseVal;
    return { x: box.left - frame.left + x * (view.width ? box.width / view.width : 1), y: box.top - frame.top + y * (view.height ? box.height / view.height : 1) };
  }

  function resize() {
    var dpr = DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (lctx) { links.width = canvas.width; links.height = canvas.height; lctx.setTransform(dpr, 0, 0, dpr, 0, 0); }
    // Room each caption takes from the top of the stage, and where the captions' column starts and ends.
    var frame = canvas.getBoundingClientRect(), boxA = capA ? capA.getBoundingClientRect() : null, boxB = capB ? capB.getBoundingClientRect() : null;
    reserve = boxA ? Math.max(0, boxA.bottom - frame.top + 16) : 0;
    reserveB = boxB ? Math.max(0, boxB.bottom - frame.top + 16) : reserve;
    edgeL = boxA ? Math.max(12, boxA.left - frame.left) : 24;
    capRight = boxB ? boxB.right - frame.left : 0;
  }
  // How far the pinned stage has travelled down its track, 0 to 1.
  function progress() {
    var lane = track.getBoundingClientRect(), box = stage.getBoundingClientRect();
    var travel = lane.height - box.height;
    if (travel < 40) return REST;
    return START + unit((box.top - lane.top) / travel) * (END - START);
  }

  function draw(t) {
    // Nothing to draw into until the canvas has a size (a tab that loads hidden starts at zero width).
    if (W < 40 || H < 40) return;
    ctx.clearRect(0, 0, W, H);
    // The move, in order: a short hold in the 3D view, then the turn right round to level.
    var tilt = 1, turn = ease((prog - 0.3) / 0.28);
    // The hand-over runs into the end of the turn so nothing stops: the bench draws back as it comes level, the
    // chart and its caption rise, the lines run down to the chart, and the curves draw out from where they land.
    var pull = ease((prog - 0.53) / 0.13), show = ease((prog - 0.6) / 0.1), link = unit((prog - 0.66) / 0.14), rec = ease((prog - 0.78) / 0.17);
    // Once the line has arrived, the glow, the blooms and then the curves run on the clock.
    if (played > 0) { link = Math.max(link, 0.72 + 0.28 * unit(played / 1.1)); rec = Math.max(rec, ease((played - 0.5) / 2.4)); }
    turn = turn * turn * (3 - 2 * turn);
    var angle = tilt * 1.08, sin = Math.sin(angle), cos = Math.cos(angle);
    var pad = W < 700 ? 8 : Math.max(24, W * 0.035), box = W < 700 ? 0 : 0.13;
    var pitch = (W - pad * 2) / (COLS + 1.2 + (COLS + 1.2) * box), r = pitch * 0.4, tall = r * 1.7 * tilt;
    var benchW = pitch * (COLS + 0.4), depth = pitch * (ROWS + 0.4), left = 0;
    // The bench top is a slab on legs; the floor lies under the legs.
    var thick = r * 0.55 * tilt, floor = -thick - pitch * 1.5 * tilt;
    // The controller: an upright cabinet on its own stand off the end of the table, taller than it is wide. The
    // side that faces the table carries the valves.
    var bx = left + benchW + pitch * 1.25, bw = pitch * 1.7, z0 = pitch * 1.0, z1 = pitch * 3.4, ch = pitch * 2.6 * tilt;
    var sx0 = bx - pitch * 0.16, sx1 = bx + bw + pitch * 0.16, sz0 = z0 - pitch * 0.16, sz1 = z1 + pitch * 0.16;
    // The swing eases in once the tilt is under way, so the flat plan never spins on the spot. The turn then
    // carries the view on round, past looking straight down the bench, to level from the other side.
    var swing = ease((tilt - 0.3) / 0.7), yaw = box ? 0.75 * swing + (Math.PI - 0.75) * turn : 0, ys = Math.sin(yaw), yc = Math.cos(yaw);
    var midX = (left + (box ? sx1 : benchW)) / 2, midZ = depth / 2;
    function raw(x, z, h) {
      var dx = x - midX, dz = z - midZ, across = dx * yc + dz * ys, near = dz * yc - dx * ys;
      var p = 1 + near / pitch * sin * 0.016;
      return { x: across * p, y: (near * cos - h * sin) * p, p: p };
    }
    // Fit the whole figure to the stage and centre it.
    var lo = [1e9, 1e9], hi = [-1e9, -1e9];
    [[left, 0, floor], [left + benchW, 0, floor], [left, depth, floor], [left + benchW, depth, floor],
      [left, 0, tall], [left + benchW, 0, tall], [left, depth, tall], [left + benchW, depth, tall]]
      .concat(box ? [[bx, z0, ch], [bx + bw, z0, ch], [bx, z1, ch], [bx + bw, z1, ch], [sx0, sz0, floor], [sx1, sz0, floor], [sx1, sz1, floor], [sx0, sz1, floor]] : [])
      .forEach(function (k) { var q = raw(k[0], k[1], k[2]); lo[0] = Math.min(lo[0], q.x); hi[0] = Math.max(hi[0], q.x); lo[1] = Math.min(lo[1], q.y); hi[1] = Math.max(hi[1], q.y); });
    hi[1] += 22;
    // The figure's place on the stage. Seen from above it keeps clear of the caption; in the 3D view it takes the
    // whole stage and the caption sits in the empty corner above the near end of the bench.
    var mix = function (from, to, k) { return from + (to - from) * k; };
    var top = Math.max(H * 0.07, reserve * (1 - swing));
    // For the data part it draws back: on a wide stage to the right of the caption, on a narrow one to a strip under
    // it. The chart takes the rest of the stage below.
    // Between the bench and the chart runs the band the line travels along.
    var beside = W >= 900, strip = Math.max(70, H * 0.14), band = beside ? 30 : 18;
    var chartTop = beside ? Math.max(reserveB + 12 + band, H * 0.4) : reserveB + strip + band, chartBottom = H - (beside ? 26 : 12);
    var boxL = mix(pad, beside ? capRight + 48 : pad, pull), boxR = mix(W - pad, W - edgeL, pull);
    var boxT = mix(top, beside ? H * 0.09 : reserveB - 8, pull), boxB = mix(H * 0.85, chartTop - band - (beside ? 10 : 2), pull);
    var fit = Math.min(1.8, (boxR - boxL) / (hi[0] - lo[0]), (boxB - boxT) / (hi[1] - lo[1]));
    // Point (x across, z toward the viewer, h up) to the screen.
    function at(x, z, h) {
      var q = raw(x, z, h);
      return { x: (boxL + boxR) / 2 + (q.x - (lo[0] + hi[0]) / 2) * fit, y: (boxT + boxB) / 2 + (q.y - (lo[1] + hi[1]) / 2) * fit, p: q.p * fit };
    }
    function shape(pts) {
      ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
      for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
    }
    function quad(a, b, c, d, fill, line) {
      shape([a, b, c, d]); ctx.fillStyle = fill; ctx.fill();
      if (line) { ctx.strokeStyle = line; ctx.lineWidth = 0.75; ctx.stroke(); }
    }
    // A fill that runs from one colour at one screen point to another colour at a second.
    function blend(p0, p1, c0, c1) { var gr = ctx.createLinearGradient(p0.x, p0.y, p1.x, p1.y); gr.addColorStop(0, c0); gr.addColorStop(1, c1); return gr; }
    // A soft shadow of a floor outline: the outline is drawn far off to one side and only its blurred shadow lands.
    function cast(pts, alpha, blur, dropY) {
      ctx.save(); ctx.shadowColor = 'rgba(16,31,26,' + alpha + ')'; ctx.shadowBlur = blur * DPR; ctx.shadowOffsetX = 20000 * DPR; ctx.shadowOffsetY = dropY * DPR;
      shape(pts.map(function (q) { return { x: q.x - 20000, y: q.y }; })); ctx.fillStyle = '#000'; ctx.fill(); ctx.restore();
    }
    // A leg: a dark square tube from the underside of a top down to the floor, with a little shadow at its foot.
    function leg(x, z) {
      if ((-floor - thick) * fit * sin < 2) return;
      var up = at(x, z, -thick), down = at(x, z, floor), wd = Math.max(1.5, pitch * 0.15 * down.p);
      // Its shadow where it meets the floor, then the tube shaded as a cylinder lit from the left, then its foot.
      ctx.fillStyle = 'rgba(16,31,26,0.16)'; ctx.beginPath(); ctx.ellipse(down.x + wd * 0.9, down.y + 1.5, wd * 2.2, Math.max(0.8, wd * 1.5 * cos), 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(16,31,26,0.3)'; ctx.beginPath(); ctx.ellipse(down.x + wd * 0.2, down.y + 0.8, wd * 1.1, Math.max(0.6, wd * 0.8 * cos), 0, 0, Math.PI * 2); ctx.fill();
      ctx.lineCap = 'butt';
      [['#0e100f', 1, 0], ['#2a2e2c', 0.62, -0.1], ['rgba(255,255,255,0.3)', 0.14, -0.26], ['rgba(255,255,255,0.07)', 0.1, 0.3]].forEach(function (band) {
        ctx.strokeStyle = band[0]; ctx.lineWidth = wd * band[1];
        ctx.beginPath(); ctx.moveTo(up.x + wd * band[2], up.y); ctx.lineTo(down.x + wd * band[2], down.y); ctx.stroke();
      });
      ctx.fillStyle = '#0b0c0c'; ctx.beginPath(); ctx.ellipse(down.x, down.y, wd * 0.72, Math.max(0.6, wd * 0.72 * cos), 0, 0, Math.PI * 2); ctx.fill();
    }
    var edge = 'rgba(16,31,26,0.2)', hoseW = Math.max(1.1, pitch * 0.045 * fit), spread = pitch * 0.17;
    // The hardware caption steps aside as the bench swings through its corner. The data caption comes in with the
    // chart.
    var showA = box ? (yaw < 1.2 ? 1 : unit(1 - (yaw - 1.2) / 0.4)) : 1 - ease((prog - 0.5) / 0.1);
    if (capA) { capA.style.opacity = showA; capA.style.visibility = showA > 0.02 ? 'visible' : 'hidden'; }
    if (capB) { capB.style.opacity = show; capB.style.visibility = show > 0.02 ? 'visible' : 'hidden'; }

    // A faint grid on the floor, fading toward the edges of the stage: graph paper from above, a floor once tilted.
    var cell = pitch * 2, gx0 = left - cell * 8, gx1 = left + benchW + cell * 9, gz0 = -cell * 9, gz1 = depth + cell * 9, g;
    ctx.strokeStyle = 'rgba(16,31,26,' + 0.075 * (1 - pull * 0.6) + ')'; ctx.lineWidth = 1; ctx.beginPath();
    for (g = gx0; g <= gx1 + 1; g += cell) { var ga = at(g, gz0, floor), gb = at(g, gz1, floor); ctx.moveTo(ga.x, ga.y); ctx.lineTo(gb.x, gb.y); }
    for (g = gz0; g <= gz1 + 1; g += cell) { var gc = at(gx0, g, floor), gd = at(gx1, g, floor); ctx.moveTo(gc.x, gc.y); ctx.lineTo(gd.x, gd.y); }
    ctx.stroke();
    var midY = (boxT + boxB) / 2, mist = ctx.createRadialGradient(W / 2, midY, Math.min(W, H) * 0.3, W / 2, midY, Math.max(W, H) * 0.66);
    mist.addColorStop(0, 'rgba(255,255,255,0)'); mist.addColorStop(1, '#fff');
    ctx.fillStyle = mist; ctx.fillRect(0, 0, W, H);

    var potX = function (n) { return left + pitch * (n % COLS + 0.7); }, potZ = function (n) { return pitch * (Math.floor(n / COLS) + 0.7); };
    // The data part: the live chart takes the lower part of the stage, rising into place.
    if (chartBox) {
      chartBox.style.top = chartTop + 'px'; chartBox.style.height = Math.max(120, chartBottom - chartTop) + 'px';
      chartBox.style.left = edgeL + 'px'; chartBox.style.right = edgeL + 'px';
      chartBox.style.opacity = show; chartBox.style.transform = 'translateY(' + ((1 - show) * 44).toFixed(1) + 'px)';
      chartBox.style.visibility = show > 0.02 ? 'visible' : 'hidden';
      // Its curves are held back until the lines land, then let out across the plot.
      var gate = chartSvg && chartSvg.querySelector('#homepage-trace-clip rect');
      if (gate && chartSvg.viewBox.baseVal.width) gate.setAttribute('width', Math.max(0, (chartSvg.viewBox.baseVal.width - 53) * rec));
    }

    // Shadows on the floor under the bench and the controller. From above they read as a soft lift off the page.
    var lift = 10 * (1 - tilt) + 3;
    var bed = [at(left, 0, floor), at(left + benchW, 0, floor), at(left + benchW, depth, floor), at(left, depth, floor)];
    cast(bed, 0.17, 34, lift + 4 * tilt); cast(bed, 0.14, 10, lift * 0.5);
    if (box) { var pad2 = [at(sx0, sz0, floor), at(sx1, sz0, floor), at(sx1, sz1, floor), at(sx0, sz1, floor)]; cast(pad2, 0.18, 28, lift + 4 * tilt); cast(pad2, 0.16, 9, lift * 0.5); }

    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    // Valves run along the table-facing side of the controller in four banks, one above the other.
    var valveZ = function (i) { return z0 + pitch * 0.18 + i * (z1 - z0 - pitch * 0.36) / (COLS - 1); };
    var bankTop = function (k) { return ch * (0.94 - 0.225 * k); };
    // The grey supply pipe stands just off the valve side, beside its z1 corner, with a tee to each bank.
    function pipe() {
      var px = bx - pitch * 0.04, pzz = z1 + pitch * 0.17, wd = Math.max(2, pitch * 0.17 * fit);
      if (ch * fit < 8) {
        // From above it is a ring beside the cabinet's corner.
        var dot = at(px, pzz, 0);
        ctx.fillStyle = '#8d9591'; ctx.beginPath(); ctx.arc(dot.x, dot.y, wd * 0.62, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#c3c9c6'; ctx.beginPath(); ctx.arc(dot.x - wd * 0.14, dot.y - wd * 0.14, wd * 0.28, 0, Math.PI * 2); ctx.fill();
        return;
      }
      var lower = at(px, pzz, ch * 0.03), upper = at(px, pzz, ch * 0.99);
      ctx.lineCap = 'round';
      for (var k = 0; k < ROWS; k++) {
        var tee0 = at(px, pzz, bankTop(k) - ch * 0.125), tee1 = at(bx, z1 - pitch * 0.1, bankTop(k) - ch * 0.125);
        ctx.strokeStyle = '#7c8480'; ctx.lineWidth = wd * 0.6; ctx.beginPath(); ctx.moveTo(tee0.x, tee0.y); ctx.lineTo(tee1.x, tee1.y); ctx.stroke();
      }
      ctx.strokeStyle = '#7f8783'; ctx.lineWidth = wd; ctx.beginPath(); ctx.moveTo(lower.x, lower.y); ctx.lineTo(upper.x, upper.y); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = wd * 0.26; ctx.beginPath(); ctx.moveTo(lower.x - wd * 0.2, lower.y); ctx.lineTo(upper.x - wd * 0.2, upper.y); ctx.stroke();
      // A collar on the pipe at each tee.
      ctx.lineCap = 'butt';
      for (var cl = 0; cl < ROWS; cl++) {
        var c0 = at(px, pzz, bankTop(cl) - ch * 0.1), c1 = at(px, pzz, bankTop(cl) - ch * 0.15);
        ctx.strokeStyle = '#6a726e'; ctx.lineWidth = wd * 1.3; ctx.beginPath(); ctx.moveTo(c0.x, c0.y); ctx.lineTo(c1.x, c1.y); ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = wd * 0.3; ctx.beginPath(); ctx.moveTo(c0.x - wd * 0.3, c0.y); ctx.lineTo(c1.x - wd * 0.3, c1.y); ctx.stroke();
      }
    }
    if (box) {
      // The stand under the cabinet, made like the bench: legs, then a pale top.
      var inset = pitch * 0.22;
      leg(sx0 + inset, sz0 + inset); leg(sx1 - inset, sz0 + inset); leg(sx0 + inset, sz1 - inset); leg(sx1 - inset, sz1 - inset);
      var standZ = yc >= 0 ? sz1 : sz0;
      quad(at(sx0, standZ, 0), at(sx1, standZ, 0), at(sx1, standZ, -thick), at(sx0, standZ, -thick), blend(at(sx0, standZ, 0), at(sx0, standZ, -thick), '#d9dedb', '#b9c0bc'), edge);
      quad(at(sx0, sz0, 0), at(sx0, sz1, 0), at(sx0, sz1, -thick), at(sx0, sz0, -thick), '#c3c9c6', edge);
      quad(at(sx0, sz0, 0), at(sx1, sz0, 0), at(sx1, sz1, 0), at(sx0, sz1, 0), blend(at(sx0, sz0, 0), at(sx1, sz1, 0), '#fbfcfb', '#eceeed'), edge);
      if (yc < 0) pipe();
      // The cabinet, in painted steel: its valve side, whichever of its other sides faces the viewer, then its top.
      var a = at(bx, z0, ch), b = at(bx + bw, z0, ch), c = at(bx + bw, z1, ch), d = at(bx, z1, ch), f0 = at(bx, z0, 0), f1 = at(bx, z1, 0);
      quad(a, d, f1, f0, blend(a, f0, '#dfe3e1', '#c9cfcc'), edge);
      var zf = yc >= 0 ? z1 : z0, s0 = at(bx, zf, ch), s1 = at(bx + bw, zf, ch), s2 = at(bx + bw, zf, 0), s3 = at(bx, zf, 0);
      quad(s0, s1, s2, s3, blend(s0, s3, '#e9ecea', '#cfd4d1'), edge);
      if (ch * fit > 16) {
        // A door on that side: its seam, two latches and a vent.
        shape([at(bx + bw * 0.07, zf, ch * 0.95), at(bx + bw * 0.93, zf, ch * 0.95), at(bx + bw * 0.93, zf, ch * 0.05), at(bx + bw * 0.07, zf, ch * 0.05)]);
        ctx.strokeStyle = 'rgba(16,31,26,0.26)'; ctx.lineWidth = 0.9; ctx.stroke();
        ctx.strokeStyle = '#1f2322'; ctx.lineCap = 'round'; ctx.lineWidth = Math.max(1.6, pitch * 0.07 * fit);
        [0.72, 0.3].forEach(function (hh) {
          var l0 = at(bx + bw * 0.15, zf, ch * (hh + 0.035)), l1 = at(bx + bw * 0.15, zf, ch * (hh - 0.035));
          ctx.beginPath(); ctx.moveTo(l0.x, l0.y); ctx.lineTo(l1.x, l1.y); ctx.stroke();
        });
        ctx.strokeStyle = 'rgba(16,31,26,0.3)'; ctx.lineWidth = 1;
        for (var vent = 0; vent < 4; vent++) {
          var n0 = at(bx + bw * 0.62, zf, ch * (0.2 - vent * 0.03)), n1 = at(bx + bw * 0.84, zf, ch * (0.2 - vent * 0.03));
          ctx.beginPath(); ctx.moveTo(n0.x, n0.y); ctx.lineTo(n1.x, n1.y); ctx.stroke();
        }
      }
      quad(a, b, c, d, blend(a, c, '#ffffff', '#eef1ef'), edge);
      if (ch * fit > 16) {
        // Light along the top's edges toward the viewer, and a small green status light on the door.
        ctx.lineCap = 'round'; ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(s0.x, s0.y + 0.6); ctx.lineTo(s1.x, s1.y + 0.6); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(a.x, a.y + 0.6); ctx.lineTo(d.x, d.y + 0.6); ctx.stroke();
        var lamp = at(bx + bw * 0.84, zf, ch * 0.88), lampR = Math.max(1.4, pitch * 0.05 * fit);
        ctx.fillStyle = 'rgba(52,199,89,0.28)'; ctx.beginPath(); ctx.arc(lamp.x, lamp.y, lampR * 2.6, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#34c759'; ctx.beginPath(); ctx.arc(lamp.x, lamp.y, lampR, 0, Math.PI * 2); ctx.fill();
      }
      // The lid's inset edge, so the top reads as a made thing from above as well.
      shape([at(bx + pitch * 0.12, z0 + pitch * 0.12, ch), at(bx + bw - pitch * 0.12, z0 + pitch * 0.12, ch), at(bx + bw - pitch * 0.12, z1 - pitch * 0.12, ch), at(bx + pitch * 0.12, z1 - pitch * 0.12, ch)]);
      ctx.strokeStyle = 'rgba(16,31,26,0.12)'; ctx.lineWidth = 0.75; ctx.stroke();
      if (ch * fit > 8 && Math.abs(f1.x - f0.x) > 6) {
        // Four banks of 25 black valves, each on its own aluminium rail.
        var half = (z1 - z0 - pitch * 0.36) / (COLS - 1) * 0.34;
        for (var k = 0; k < ROWS; k++) {
          var bank = bankTop(k), foot = bank - ch * 0.11;
          var rail0 = at(bx, z0 + pitch * 0.08, bank - ch * 0.125), rail1 = at(bx, z1 - pitch * 0.08, bank - ch * 0.125);
          ctx.lineCap = 'butt'; ctx.strokeStyle = '#9aa39e'; ctx.lineWidth = Math.max(1, ch * fit * 0.024);
          ctx.beginPath(); ctx.moveTo(rail0.x, rail0.y); ctx.lineTo(rail1.x, rail1.y); ctx.stroke();
          ctx.fillStyle = '#17191a'; ctx.beginPath();
          for (var i = 0; i < COLS; i++) {
            var vz = valveZ(i), v0 = at(bx, vz - half, bank), v1 = at(bx, vz + half, bank), v2 = at(bx, vz + half, foot), v3 = at(bx, vz - half, foot);
            ctx.moveTo(v0.x, v0.y); ctx.lineTo(v1.x, v1.y); ctx.lineTo(v2.x, v2.y); ctx.lineTo(v3.x, v3.y); ctx.closePath();
          }
          ctx.fill();
          // A line of light along the tops of the valves.
          var cap0 = at(bx, z0 + pitch * 0.16, bank), cap1 = at(bx, z1 - pitch * 0.16, bank);
          ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.moveTo(cap0.x, cap0.y); ctx.lineTo(cap1.x, cap1.y); ctx.stroke();
        }
      }
      if (yc >= 0) pipe();
    }

    // The bench: legs, then the slab's long edge and end toward the viewer, then its top.
    for (var lg = 0; lg < 6; lg++) {
      var lx = left + benchW * (0.03 + 0.94 * lg / 5);
      leg(lx, pitch * 0.4); leg(lx, depth - pitch * 0.4);
    }
    // A rail ties the legs together along the side toward the viewer.
    if ((-floor - thick) * fit * sin > 6) {
      var railZ = yc >= 0 ? depth - pitch * 0.4 : pitch * 0.4, railH = floor * 0.6, rail0 = at(left + benchW * 0.03, railZ, railH), rail1 = at(left + benchW * 0.97, railZ, railH), railW = Math.max(1.2, pitch * 0.09 * rail0.p);
      ctx.lineCap = 'butt'; ctx.strokeStyle = '#161918'; ctx.lineWidth = railW; ctx.beginPath(); ctx.moveTo(rail0.x, rail0.y); ctx.lineTo(rail1.x, rail1.y); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = railW * 0.25; ctx.beginPath(); ctx.moveTo(rail0.x, rail0.y - railW * 0.28); ctx.lineTo(rail1.x, rail1.y - railW * 0.28); ctx.stroke();
    }
    var edgeZ = yc >= 0 ? depth : 0, t0 = at(left, 0, 0), t1 = at(left + benchW, 0, 0), t2 = at(left + benchW, depth, 0), t3 = at(left, depth, 0);
    var e0 = at(left, edgeZ, 0), e1 = at(left + benchW, edgeZ, 0), e2 = at(left + benchW, edgeZ, -thick), e3 = at(left, edgeZ, -thick);
    quad(e0, e1, e2, e3, blend(e0, e3, '#d9dedb', '#b9c0bc'), edge);
    quad(t0, t3, at(left, depth, -thick), at(left, 0, -thick), '#c3c9c6', edge);
    quad(t0, t1, t2, t3, blend(t0, t2, '#ffffff', '#f1f3f2'), null);
    // The top is a fine mesh, like a real bench: a light grid across it.
    ctx.strokeStyle = 'rgba(16,31,26,0.06)'; ctx.lineWidth = 0.75; ctx.beginPath();
    for (var mx = 1; mx < COLS * 2 + 1; mx++) { var m0 = at(left + benchW * mx / (COLS * 2 + 1), 0, 0), m1 = at(left + benchW * mx / (COLS * 2 + 1), depth, 0); ctx.moveTo(m0.x, m0.y); ctx.lineTo(m1.x, m1.y); }
    for (var mz = 1; mz < 9; mz++) { var m2 = at(left, depth * mz / 9, 0), m3 = at(left + benchW, depth * mz / 9, 0); ctx.moveTo(m2.x, m2.y); ctx.lineTo(m3.x, m3.y); }
    ctx.stroke();
    shape([t0, t1, t2, t3]); ctx.strokeStyle = edge; ctx.lineWidth = 0.75; ctx.stroke();
    if (thick * fit * sin > 1.5) {
      // Light along the top's edge toward the viewer, and shade where its underside turns away.
      ctx.lineCap = 'butt'; ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(e0.x, e0.y + 0.6); ctx.lineTo(e1.x, e1.y + 0.6); ctx.stroke();
      ctx.strokeStyle = 'rgba(16,31,26,0.3)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(e3.x, e3.y); ctx.lineTo(e2.x, e2.y); ctx.stroke();
    }

    // Each pair of rows has one bundle of 50 tubes, gathered at rim height just off the end of the table, in line
    // with the gap between its two rows. Each bundle throws a soft shadow on the table under it.
    var laneZ = function (lane) { return pitch * (lane * 2 + 1.2); };
    var tieX = left + benchW + pitch * 0.12;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (var sh = 0; sh < 2; sh++) {
      var sh0 = at(left + benchW - pitch * 0.1, laneZ(sh) + pitch * 0.07, 0), sh1 = at(left + pitch * 0.7, laneZ(sh) + pitch * 0.07, 0);
      ctx.strokeStyle = 'rgba(16,31,26,0.1)'; ctx.lineWidth = Math.max(2, spread * fit * 1.1);
      ctx.beginPath(); ctx.moveTo(sh0.x, sh0.y); ctx.lineTo(sh1.x, sh1.y); ctx.stroke();
    }
    if (box) {
      // Off the valves: every tube sweeps down across the gap to its bundle. The bottom bank goes first so the upper
      // banks' tubes drape over the lower ones.
      for (var q = ROWS - 1; q >= 0; q--) {
        for (var f = 0; f < COLS * ROWS; f++) {
          var fed = pots[f];
          if (fed.zone !== q) continue;
          var fz = laneZ(fed.lane) + fed.off * spread, vzf = valveZ(fed.valve), fh = bankTop(fed.zone) - ch * 0.11;
          var from = at(bx, vzf, fh), sag = at(bx - (bx - tieX) * 0.55, vzf * 0.35 + fz * 0.65, Math.max(0, tall + (fh - tall) * 0.25 - ch * 0.04)), tied = at(tieX, fz, tall);
          ctx.strokeStyle = zones[fed.zone].tube; ctx.lineWidth = hoseW;
          ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.quadraticCurveTo(sag.x, sag.y, tied.x, tied.y); ctx.stroke();
        }
      }
    }

    // Each pot throws a soft shadow on the table, reaching toward the lower right as from one light.
    var dusk = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    dusk.addColorStop(0, 'rgba(8,14,11,0.55)'); dusk.addColorStop(0.5, 'rgba(8,14,11,0.26)'); dusk.addColorStop(1, 'rgba(8,14,11,0)');
    ctx.fillStyle = dusk;
    for (var sd = 0; sd < COLS * ROWS; sd++) {
      var foot1 = at(potX(sd), potZ(sd), 0), srx = r * foot1.p, sry = Math.max(srx * 0.3, srx * cos);
      ctx.save(); ctx.translate(foot1.x + srx * 0.34, foot1.y + sry * 0.3 + 1.5); ctx.scale(srx * 1.5, sry * 1.3);
      ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    }

    // Black nursery pots, farthest first so nearer ones overlap, whichever way the bench is turned.
    var soil = ctx.createRadialGradient(-0.3, -0.35, 0.05, 0, 0, 1);
    soil.addColorStop(0, '#75593f'); soil.addColorStop(0.6, '#59432f'); soil.addColorStop(1, '#3b2c1f');
    var order = [], depthOf = [];
    for (var o = 0; o < COLS * ROWS; o++) { order.push(o); depthOf.push((potZ(o) - midZ) * yc - (potX(o) - midX) * ys); }
    order.sort(function (u1, u2) { return depthOf[u1] - depthOf[u2]; });
    for (var oi = 0; oi < order.length; oi++) {
      var m = order[oi], rowN = Math.floor(m / COLS), me = pots[m], zone = zones[me.zone];
      var x = potX(m), pz = potZ(m);
      var base = at(x, pz, 0), rim = at(x, pz, tall), lip = at(x, pz, tall * 0.8);
      var rx = r * rim.p, ry = Math.max(0.6, rx * cos), fx = rx * 0.68, fy = Math.max(0.5, fx * cos);
      if (tall * fit > 0.5) {
        // Tapered wall, narrower at the foot, lit from the upper left.
        var wall = ctx.createLinearGradient(rim.x - rx, 0, rim.x + rx, 0);
        wall.addColorStop(0, '#1b1e1d'); wall.addColorStop(0.22, '#4d5350'); wall.addColorStop(0.4, '#2b2f2d'); wall.addColorStop(0.72, '#151716'); wall.addColorStop(1, '#0a0b0b');
        ctx.fillStyle = wall;
        ctx.beginPath(); ctx.ellipse(base.x, base.y, fx, fy, 0, 0, Math.PI); ctx.lineTo(lip.x - rx * 0.93, lip.y); ctx.lineTo(lip.x + rx * 0.93, lip.y); ctx.closePath(); ctx.fill();
        // A rolled collar around the top, a little wider than the wall, with a shadow line under it.
        ctx.beginPath(); ctx.ellipse(lip.x, lip.y, rx, ry, 0, 0, Math.PI); ctx.lineTo(rim.x - rx, rim.y); ctx.lineTo(rim.x + rx, rim.y); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = Math.max(0.8, rx * 0.06);
        ctx.beginPath(); ctx.ellipse(lip.x, lip.y, rx, ry, 0, 0.12, Math.PI - 0.12); ctx.stroke();
        // A streak of light down the lit side of the wall, and a fainter one on the collar above it.
        ctx.lineCap = 'round'; ctx.strokeStyle = 'rgba(255,255,255,0.17)'; ctx.lineWidth = Math.max(0.8, rx * 0.11);
        ctx.beginPath(); ctx.moveTo(lip.x - rx * 0.55, lip.y + ry * 0.75 + 2); ctx.lineTo(base.x - fx * 0.55, base.y + fy * 0.55); ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = Math.max(0.7, rx * 0.09);
        ctx.beginPath(); ctx.moveTo(rim.x - rx * 0.6, rim.y + ry * 0.82); ctx.lineTo(lip.x - rx * 0.6, lip.y + ry * 0.74); ctx.stroke();
      }
      // The rim's top face, with light catching its upper left edge.
      ctx.fillStyle = '#242827';
      ctx.beginPath(); ctx.ellipse(rim.x, rim.y, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.65)'; ctx.lineWidth = 0.75; ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = Math.max(0.8, rx * 0.07);
      ctx.beginPath(); ctx.ellipse(rim.x, rim.y, rx * 0.93, ry * 0.93, 0, Math.PI * 1.02, Math.PI * 1.72); ctx.stroke();
      // The moulded lip just inside the rim, and shade on the rim's near edge.
      ctx.strokeStyle = 'rgba(255,255,255,0.1)'; ctx.lineWidth = 0.75; ctx.beginPath(); ctx.ellipse(rim.x, rim.y, rx * 0.875, ry * 0.875, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = Math.max(0.8, rx * 0.05); ctx.beginPath(); ctx.ellipse(rim.x, rim.y, rx * 0.97, ry * 0.97, 0, Math.PI * 0.1, Math.PI * 0.7); ctx.stroke();
      // Inside the rim: the dark inner wall, then the soil a little way down, speckled with perlite.
      ctx.save();
      ctx.beginPath(); ctx.ellipse(rim.x, rim.y, rx * 0.84, ry * 0.84, 0, 0, Math.PI * 2); ctx.fillStyle = '#0c0d0d'; ctx.fill(); ctx.clip();
      var sink = ry * 0.2 * tilt, ex = rx * 0.84, ey = ry * 0.84;
      ctx.save(); ctx.translate(rim.x, rim.y + sink); ctx.scale(ex, ey);
      ctx.fillStyle = soil; ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(244,241,230,0.85)'; ctx.beginPath();
      for (var sp = 0; sp < me.grit.length; sp++) { var gr = me.grit[sp]; ctx.moveTo(gr[0] + gr[2], gr[1]); ctx.arc(gr[0], gr[1], gr[2], 0, Math.PI * 2); }
      ctx.fill();
      ctx.restore();
      // The inner wall's shadow falling across the lit side of the soil.
      ctx.strokeStyle = 'rgba(0,0,0,0.34)'; ctx.lineWidth = rx * 0.22;
      ctx.beginPath(); ctx.ellipse(rim.x, rim.y + sink, ex, ey, 0, Math.PI * 0.95, Math.PI * 1.8); ctx.stroke();
      // The pot's moisture sensor: a black head with a green tag, and its cable off over the rim.
      var hx = rim.x + ex * me.probe[0], hy = rim.y + sink + ey * me.probe[1], ha = me.probe[2], hl = rx * 0.12;
      ctx.lineCap = 'round'; ctx.strokeStyle = '#0d0f0e'; ctx.lineWidth = Math.max(0.6, rx * 0.035);
      ctx.beginPath(); ctx.moveTo(hx, hy); ctx.quadraticCurveTo(hx + Math.cos(ha) * rx * 0.5, hy + Math.sin(ha) * ry * 0.2, rim.x + Math.cos(ha) * rx, rim.y + Math.sin(ha) * ry); ctx.stroke();
      ctx.lineWidth = Math.max(1.4, rx * 0.15);
      ctx.beginPath(); ctx.moveTo(hx - Math.cos(ha) * hl, hy - Math.sin(ha) * hl * (ry / rx)); ctx.lineTo(hx + Math.cos(ha) * hl, hy + Math.sin(ha) * hl * (ry / rx)); ctx.stroke();
      ctx.lineCap = 'butt'; ctx.strokeStyle = '#9ae23c';
      ctx.beginPath(); ctx.moveTo(hx - Math.cos(ha) * hl * 0.3, hy - Math.sin(ha) * hl * 0.3 * (ry / rx)); ctx.lineTo(hx + Math.cos(ha) * hl * 0.45, hy + Math.sin(ha) * hl * 0.45 * (ry / rx)); ctx.stroke();
      ctx.restore();
      // The pot's ring of tubing in its zone colour, resting just inside the rim: its shadow, the tube, a highlight.
      var ringW = Math.max(1.3, rx * 0.15), ringY = rim.y + sink * 0.35;
      ctx.strokeStyle = 'rgba(0,0,0,0.38)'; ctx.lineWidth = ringW;
      ctx.beginPath(); ctx.ellipse(rim.x + ringW * 0.25, ringY + ringW * 0.45, rx * 0.68, ry * 0.68, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = zone.ring;
      ctx.beginPath(); ctx.ellipse(rim.x, ringY, rx * 0.68, ry * 0.68, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = ringW * 0.32;
      ctx.beginPath(); ctx.ellipse(rim.x, ringY - ringW * 0.18, rx * 0.68, ry * 0.68, 0, Math.PI * 1.05, Math.PI * 1.7); ctx.stroke();
      // The pot's own tube: from the bundle over the rim to a white clip on the ring.
      var side = rowN % 2 === 0 ? 1 : -1, feed = at(x, laneZ(me.lane) + me.off * spread, tall), clip = at(x, pz + side * r * 0.68, tall);
      ctx.strokeStyle = zone.tube; ctx.lineWidth = hoseW; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(feed.x, feed.y); ctx.lineTo(clip.x, clip.y + sink * 0.35); ctx.stroke();
      var tab = Math.max(1.4, rx * 0.15);
      ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(clip.x - tab + 0.6, clip.y + sink * 0.35 - tab * 0.6 + 0.8, tab * 2, tab * 1.2);
      ctx.fillStyle = '#fdfdfc'; ctx.fillRect(clip.x - tab, clip.y + sink * 0.35 - tab * 0.6, tab * 2, tab * 1.2);
    }

    // The bundles lie at rim height in the gaps between rows, so they go down over the pots: from the tie along
    // the gap, each tube stopping where it turns off to its pot.
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (var under = 0; under < 2; under++) {
      var u0 = at(box ? tieX : left + benchW + pitch * 0.6, laneZ(under), tall), u1 = at(potX(12), laneZ(under), tall);
      ctx.strokeStyle = 'rgba(8,14,11,0.28)'; ctx.lineWidth = Math.max(2, spread * fit * 1.05); ctx.beginPath(); ctx.moveTo(u0.x, u0.y + 1.6); ctx.lineTo(u1.x, u1.y + 1.6); ctx.stroke();
    }
    ctx.lineWidth = hoseW;
    for (var hn = 0; hn < COLS * ROWS; hn++) {
      var hp = pots[hn], hz = laneZ(hp.lane) + hp.off * spread;
      // On a phone there is no room for the controller, so the bundles come in from past the end of the table.
      var start = at(box ? tieX : left + benchW + pitch * 0.6, hz, tall), end = at(potX(hn), hz, tall);
      ctx.strokeStyle = zones[hp.zone].tube;
      ctx.beginPath(); ctx.moveTo(start.x, start.y); ctx.lineTo(end.x, end.y); ctx.stroke();
    }
    for (var over = 0; over < 2; over++) {
      var o0 = at(box ? tieX : left + benchW + pitch * 0.6, laneZ(over) - spread * 0.42, tall), o1 = at(potX(12), laneZ(over) - spread * 0.3, tall);
      ctx.strokeStyle = 'rgba(255,255,255,0.38)'; ctx.lineWidth = 0.9; ctx.beginPath(); ctx.moveTo(o0.x, o0.y); ctx.lineTo(o1.x, o1.y); ctx.stroke();
    }

    // Depth: a thin haze over the far end of the bench, so it sits further back than the near end.
    var nearPot = order[order.length - 1], farPot = order[0], deep = (depthOf[nearPot] - depthOf[farPot]) / pitch;
    if (deep > 6 && tilt > 0.05) {
      var nearAt = at(potX(nearPot), potZ(nearPot), tall), farAt = at(potX(farPot), potZ(farPot), tall), haze = ctx.createLinearGradient(nearAt.x, nearAt.y, farAt.x, farAt.y);
      haze.addColorStop(0, 'rgba(255,255,255,0)'); haze.addColorStop(0.35, 'rgba(255,255,255,0)'); haze.addColorStop(1, 'rgba(255,255,255,' + (0.2 * tilt * Math.min(1, (deep - 6) / 14)).toFixed(3) + ')');
      ctx.fillStyle = haze; ctx.fillRect(0, 0, W, H);
    }
    // Each charted pot wears a dot in its trace colour, so the eye can follow it down to the chart.
    readFeeds();
    if (lctx) lctx.clearRect(0, 0, W, H);
    if (show > 0.01 && feeds.length) {
      for (var mk = 0; mk < feeds.length; mk++) {
        var crown = at(potX(feeds[mk].n), potZ(feeds[mk].n), tall), dot = Math.max(2.6, r * crown.p * 0.3);
        ctx.globalAlpha = show; ctx.fillStyle = feeds[mk].ink; ctx.beginPath(); ctx.arc(crown.x, crown.y, dot, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.25; ctx.stroke(); ctx.globalAlpha = 1;
      }
    }
    // One line carries every charted pot's readings: straight down from the edge of the table under those pots,
    // along the band above the chart, round the card's top left corner and down its side, running through the pots'
    // colours as it goes, in dashes that march toward the chart. Level with the curves it turns in to the card's
    // edge and fades away into it. The colours
    // come back inside the chart: a glow along its axis, then a bloom at the start of each pot's curve.
    if (lctx && chartBox && link > 0 && feeds.length && run) {
      var frame = canvas.getBoundingClientRect(), live = [], midPot = 0;
      for (var fd = 0; fd < feeds.length; fd++) {
        midPot += potX(feeds[fd].n) / feeds.length;
        var landing = startOf(feeds[fd], frame);
        if (landing) live.push({ feed: feeds[fd], end: landing });
      }
      live.sort(function (one, two) { return one.end.y - two.end.y; });
      if (live.length) {
        var from = at(midPot, edgeZ, -thick), laneY = chartTop - band * 0.5, sideX = Math.max(6, edgeL - (beside ? 16 : 9));
        var highest = live[0].end.y, lowest = live[live.length - 1].end.y, midway = (highest + lowest) / 2, axisX = live[0].end.x;
        // The line as points, with its corners rounded. It ends just inside the card's edge.
        var corners = [[from.x, from.y + 1], [from.x, laneY], [sideX, laneY], [sideX, midway], [edgeL + (beside ? 16 : 9), midway]], pts = [corners[0]];
        for (var cn = 1; cn < corners.length - 1; cn++) {
          var before = corners[cn - 1], here = corners[cn], after = corners[cn + 1];
          var inLen = Math.hypot(here[0] - before[0], here[1] - before[1]), outLen = Math.hypot(after[0] - here[0], after[1] - here[1]);
          var bend = Math.min(beside ? 16 : 8, inLen / 2, outLen * (cn === 3 ? 0.9 : 0.5));
          if (bend < 0.5) { pts.push(here); continue; }
          var a0 = [here[0] + (before[0] - here[0]) / inLen * bend, here[1] + (before[1] - here[1]) / inLen * bend];
          var a1 = [here[0] + (after[0] - here[0]) / outLen * bend, here[1] + (after[1] - here[1]) / outLen * bend];
          for (var q8 = 0; q8 <= 10; q8++) {
            var w = q8 / 10, v = 1 - w;
            pts.push([v * v * a0[0] + 2 * v * w * here[0] + w * w * a1[0], v * v * a0[1] + 2 * v * w * here[1] + w * w * a1[1]]);
          }
        }
        pts.push(corners[corners.length - 1]);
        var lengths = [0];
        for (var pl = 1; pl < pts.length; pl++) lengths.push(lengths[pl - 1] + Math.hypot(pts[pl][0] - pts[pl - 1][0], pts[pl][1] - pts[pl - 1][1]));
        var whole = lengths[lengths.length - 1];
        var pointAt = function (dist) {
          for (var seg = 1; seg < pts.length; seg++) {
            if (lengths[seg] >= dist) { var part = (dist - lengths[seg - 1]) / Math.max(0.001, lengths[seg] - lengths[seg - 1]); return [pts[seg - 1][0] + (pts[seg][0] - pts[seg - 1][0]) * part, pts[seg - 1][1] + (pts[seg][1] - pts[seg - 1][1]) * part]; }
          }
          return pts[pts.length - 1];
        };
        var hueAt = function (shift) { var slot = ((Math.floor(shift * 256) % 256) + 256) % 256 * 4; return run[slot] + ',' + run[slot + 1] + ',' + run[slot + 2]; };
        // The line is drawn over the first part of this stretch of scroll; the bloom takes the rest.
        // Less than one turn of the colour run lies along the whole line at a time, and it drifts slowly.
        var trunk = whole * ease(link / 0.72), fadeLen = beside ? 34 : 20, flow = still ? 0 : t * 0.022, sweep = whole * 1.5;
        lctx.lineJoin = 'round'; lctx.lineCap = 'round';
        // A white edge first, so the dashes read cleanly over the floor grid. It stops short of the card.
        lctx.globalAlpha = show; lctx.strokeStyle = 'rgba(255,255,255,0.9)'; lctx.lineWidth = 4.5; lctx.beginPath(); lctx.moveTo(pts[0][0], pts[0][1]);
        var edgeStop = Math.min(trunk, whole - fadeLen);
        for (var hs = 1; hs < pts.length && lengths[hs] < edgeStop; hs++) lctx.lineTo(pts[hs][0], pts[hs][1]);
        var stopPt = pointAt(edgeStop); lctx.lineTo(stopPt[0], stopPt[1]); lctx.stroke();
        // The line is dashed, and the dashes march along it toward the chart. Each dash takes its colour from the
        // run. Over its last stretch the line thins out to nothing as it goes into the card.
        var DASH = 9, GAP = 7, march = still ? 0 : (t * 26) % (DASH + GAP);
        lctx.lineWidth = 2;
        for (var head = march - DASH - GAP; head < trunk; head += DASH + GAP) {
          var d0 = Math.max(0, head), d1 = Math.min(trunk, head + DASH);
          if (d1 - d0 < 0.5) continue;
          var left2 = unit((whole - (d0 + d1) / 2) / fadeLen), first = pointAt(d0);
          lctx.globalAlpha = show * left2 * left2; lctx.strokeStyle = 'rgb(' + hueAt((d0 + d1) / 2 / sweep - flow) + ')';
          lctx.beginPath(); lctx.moveTo(first[0], first[1]);
          for (var step = d0 + 3; step < d1; step += 3) { var mid = pointAt(step); lctx.lineTo(mid[0], mid[1]); }
          var last = pointAt(d1); lctx.lineTo(last[0], last[1]); lctx.stroke();
        }

        // Inside the chart the colours come back. First a soft glow up and down the axis from where the line went
        // in, reaching as far as the highest and lowest curve.
        var rise = ease((link - 0.66) / 0.2);
        if (rise > 0) {
          var glowTop = midway - (midway - highest + 10) * rise, glowBottom = midway + (lowest - midway + 10) * rise;
          var seam = lctx.createLinearGradient(0, glowTop, 0, glowBottom);
          for (var gs = 0; gs <= 8; gs++) seam.addColorStop(gs / 8, 'rgba(' + hueAt(whole / sweep + gs / 8 * 0.35 - flow) + ',' + (gs === 0 || gs === 8 ? 0 : 0.7) + ')');
          lctx.save(); lctx.globalAlpha = show * rise * 0.9; lctx.strokeStyle = seam; lctx.lineCap = 'round';
          lctx.shadowColor = 'rgba(' + hueAt(whole / sweep + 0.17 - flow) + ',0.4)'; lctx.shadowBlur = 8 * DPR; lctx.lineWidth = 1.8;
          lctx.beginPath(); lctx.moveTo(axisX - 1, glowTop); lctx.lineTo(axisX - 1, glowBottom); lctx.stroke(); lctx.restore();
        }
        // Then each pot's colour blooms where its curve starts, the ones nearest the line's way in first: a ring
        // that opens and fades, leaving a dot in a soft halo that breathes slowly.
        var reachY = Math.max(1, (lowest - highest) / 2 + 10);
        for (var bl = 0; bl < live.length; bl++) {
          var bud = live[bl], open = ease((link - 0.72 - 0.16 * Math.abs(bud.end.y - midway) / reachY) / 0.14);
          if (open <= 0) continue;
          var bx0 = bud.end.x, by0 = bud.end.y, ink = bud.feed.ink, pulse = still ? 0 : 0.18 * (0.5 + 0.5 * Math.sin(t * 1.5 + bl * 0.9));
          lctx.globalAlpha = show;
          if (open < 1) {
            lctx.save(); lctx.globalAlpha = show * (1 - open) * 0.7; lctx.strokeStyle = ink; lctx.lineWidth = 1.5;
            lctx.beginPath(); lctx.arc(bx0, by0, 4 + open * 16, 0, Math.PI * 2); lctx.stroke(); lctx.restore();
          }
          var halo = (9 + pulse * 7) * open, soft = lctx.createRadialGradient(bx0, by0, 0, bx0, by0, halo);
          soft.addColorStop(0, ink); soft.addColorStop(1, 'rgba(255,255,255,0)');
          lctx.save(); lctx.globalAlpha = show * (0.3 + pulse * 0.3) * open; lctx.fillStyle = soft; lctx.beginPath(); lctx.arc(bx0, by0, halo, 0, Math.PI * 2); lctx.fill(); lctx.restore();
          lctx.fillStyle = ink; lctx.beginPath(); lctx.arc(bx0, by0, (3.2 + pulse * 0.9) * Math.min(1, open * 1.3), 0, Math.PI * 2); lctx.fill();
          lctx.strokeStyle = '#fff'; lctx.lineWidth = 1.25; lctx.stroke();
        }
        lctx.globalAlpha = 1;
      }
    }
  }

  function frame(ms) {
    if (!visible || document.hidden) { running = false; lastMs = 0; return; }
    var now = ms / 1000, goal = progress(), moving = Math.abs(goal - prog) > 0.0003;
    if (canvas.clientWidth !== W || canvas.clientHeight !== H) { resize(); moving = true; }
    if (moving) prog += (goal - prog) * 0.07;
    var gone = lastMs ? Math.min(0.1, (ms - lastMs) / 1000) : 0, was = played; lastMs = ms;
    played = prog >= ARRIVE ? Math.min(PLAY, played + gone) : prog < ARRIVE - 0.02 ? Math.max(0, played - gone * 2.5) : played;
    // The only things that move on their own are the chart and the data running down to it, so outside that part the figure
    // is redrawn only while the scroll is still carrying it along.
    if (moving || prog > 0.58 || played !== was) draw(now);
    requestAnimationFrame(frame);
  }
  function start() {
    if (still || running) return;
    running = true;
    requestAnimationFrame(frame);
  }
  resize();
  draw(0);
  window.addEventListener('resize', function () { resize(); draw(performance.now() / 1000); });
  // The captions' size settles once the page's fonts are in.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { resize(); draw(performance.now() / 1000); });
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) { visible = entries[0].isIntersecting; start(); }, { rootMargin: '10% 0px' }).observe(section);
  } else { visible = true; }
  document.addEventListener('visibilitychange', start);
  start();
})();
