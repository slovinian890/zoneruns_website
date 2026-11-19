/* ZoneRuns landing page
 * No dependencies. Sections: helpers → map art → hero scene → phone → compete board → heroes → misc.
 * Game rules mirrored from the app's Supabase migrations (see README notes in the repo):
 *   - flat-top hex lattice, a claim covers every hex the closed loop touches
 *   - new hexes start at level 2 (3 at night), enemy hit = -1, finishing hit = neutral (+ bounty)
 *   - fortify costs 15/30/60/120/240/480/960/1920 for ceilings 3..10
 */
(() => {
  'use strict';

  /* ───────────── Config ───────────── */
  // Paste store URLs here when they exist; the buttons in the CTA section switch on automatically.
  const STORE_LINKS = { ios: '', android: '' };

  const SQ3 = Math.sqrt(3);
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ───────────── Helpers ───────────── */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeInOut = (t) => 0.5 - Math.cos(Math.PI * clamp(t, 0, 1)) / 2;
  const easeOut = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);

  const svgEl = (name, attrs = {}, parent) => {
    const el = document.createElementNS(SVG_NS, name);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(el);
    return el;
  };

  // Small seeded PRNG so every visit draws the same map
  const rng = (seed) => () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const pad2 = (n) => String(n).padStart(2, '0');
  const fmtTime = (sec) => {
    const s = Math.round(sec);
    return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
  };

  /* ───────────── Hex geometry (flat-top, axial q/r) ───────────── */
  const hexCenter = (q, r, R, ox, oy) => [ox + R * 1.5 * q, oy + R * (SQ3 / 2 * q + SQ3 * r)];

  const cubeRound = (q, r) => {
    const x = q, z = r, y = -x - z;
    let rx = Math.round(x), ry = Math.round(y), rz = Math.round(z);
    const dx = Math.abs(rx - x), dy = Math.abs(ry - y), dz = Math.abs(rz - z);
    if (dx > dy && dx > dz) rx = -ry - rz; else if (dy > dz) ry = -rx - rz; else rz = -rx - ry;
    return [rx, rz];
  };
  const pixelToHex = (x, y, R, ox, oy) => {
    const px = x - ox, py = y - oy;
    return cubeRound((2 / 3 * px) / R, (-1 / 3 * px + SQ3 / 3 * py) / R);
  };
  const hexCorners = (cx, cy, R) =>
    Array.from({ length: 6 }, (_, i) => {
      const a = Math.PI / 3 * i;
      return [cx + R * Math.cos(a), cy + R * Math.sin(a)];
    });
  const pointsAttr = (pts) => pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');

  const pointInPoly = (x, y, poly) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };

  /** Build the lattice that covers a W×H viewport. Returns a Map keyed "q,r". */
  const buildLattice = (parent, W, H, R, ox, oy) => {
    const cells = new Map();
    const g = svgEl('g', { class: 'lattice' }, parent);
    const qMin = Math.floor((-R - ox) / (R * 1.5)) - 1;
    const qMax = Math.ceil((W + R - ox) / (R * 1.5)) + 1;
    for (let q = qMin; q <= qMax; q++) {
      const rMin = Math.floor((-R - oy - R * SQ3 / 2 * q) / (R * SQ3)) - 1;
      const rMax = Math.ceil((H + R - oy - R * SQ3 / 2 * q) / (R * SQ3)) + 1;
      for (let r = rMin; r <= rMax; r++) {
        const [cx, cy] = hexCenter(q, r, R, ox, oy);
        if (cx < -R || cx > W + R || cy < -R || cy > H + R) continue;
        const el = svgEl('polygon', { class: 'hx', points: pointsAttr(hexCorners(cx, cy, R)) }, g);
        cells.set(`${q},${r}`, { q, r, cx, cy, el, lbl: null, state: 0 });
      }
    }
    return cells;
  };

  /* ───────────── Route (smooth loop) ───────────── */
  // A block-following loop in hero space (720×760): straight-ish street runs, rounded corners,
  // a little GPS wobble. Start and finish are ~12 units apart (≈ 15 m, well inside the 40 m gate).
  const ROUTE = (() => {
    const corners = [
      [262, 590], [250, 452], [232, 372], [300, 292], [452, 276], [520, 336],
      [586, 356], [580, 500], [506, 556], [440, 604], [300, 614], [268, 598],
    ];
    const rnd = rng(9);
    const pts = [corners[0]];
    for (let i = 0; i < corners.length - 1; i++) {
      const [x0, y0] = corners[i], [x1, y1] = corners[i + 1];
      const len = Math.hypot(x1 - x0, y1 - y0), n = Math.max(2, Math.round(len / 24));
      const nx = -(y1 - y0) / len, ny = (x1 - x0) / len;
      for (let k = 1; k <= n; k++) {
        const f = k / n, wob = k === n ? 0 : (rnd() - 0.5) * 7;
        pts.push([x0 + (x1 - x0) * f + nx * wob, y0 + (y1 - y0) * f + ny * wob]);
      }
    }
    return pts;
  })();
  const START = ROUTE[0];
  const END = ROUTE[ROUTE.length - 1];
  const HERO_R = 34, HERO_OX = 6, HERO_OY = 20;
  const HEX_RADIUS_M = 43.2;              // HEX_SIZE_M in the app
  const HEX_AREA_M2 = 2.598 * HEX_RADIUS_M * HEX_RADIUS_M;
  const RUN_KM = 1.94, PACE_S = 324;      // 5:24 /km

  const transformPts = (pts, s, tx, ty) => pts.map(([x, y]) => [x * s + tx, y * s + ty]);

  /** Catmull-Rom → cubic Béziers. Returns the SVG path and dense samples of the same curve. */
  const buildCurve = (pts, perSeg = 8) => {
    let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
    const samples = [pts[0].slice()];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
      const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      d += ` C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
      for (let k = 1; k <= perSeg; k++) {
        const t = k / perSeg, u = 1 - t;
        samples.push([
          u * u * u * p1[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p2[0],
          u * u * u * p1[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p2[1],
        ]);
      }
    }
    const cum = [0];
    for (let i = 1; i < samples.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(samples[i][0] - samples[i - 1][0], samples[i][1] - samples[i - 1][1]));
    }
    return { d, samples, cum, length: cum[cum.length - 1] };
  };

  /** The app's rule: a claim covers every hex the closed polygon touches. */
  const computeClaim = (curve, R, ox, oy) => {
    const { samples, cum } = curve;
    const crossed = new Set();
    const crossedAt = [];            // cumulative # of hexes crossed at each sample
    samples.forEach(([x, y]) => {
      const [q, r] = pixelToHex(x, y, R, ox, oy);
      crossed.add(`${q},${r}`);
      crossedAt.push(crossed.size);
    });
    const claimed = new Set(crossed);
    const qs = samples.map((p) => pixelToHex(p[0], p[1], R, ox, oy));
    const qMin = Math.min(...qs.map((p) => p[0])) - 2, qMax = Math.max(...qs.map((p) => p[0])) + 2;
    const rMin = Math.min(...qs.map((p) => p[1])) - 4, rMax = Math.max(...qs.map((p) => p[1])) + 4;
    for (let q = qMin; q <= qMax; q++) {
      for (let r = rMin; r <= rMax; r++) {
        const [cx, cy] = hexCenter(q, r, R, ox, oy);
        if (pointInPoly(cx, cy, samples) || hexCorners(cx, cy, R).some(([x, y]) => pointInPoly(x, y, samples))) {
          claimed.add(`${q},${r}`);
        }
      }
    }
    // "ready" = the loop is within 40 m of the start for the whole final stretch
    const thresholdUnits = (40 / HEX_RADIUS_M) * R;
    let readyIdx = samples.length - 1;
    for (let i = samples.length - 1; i >= 0; i--) {
      if (Math.hypot(samples[i][0] - samples[0][0], samples[i][1] - samples[0][1]) > thresholdUnits) { readyIdx = i + 1; break; }
    }
    return { crossed, crossedAt, claimed, readyP: cum[Math.min(readyIdx, cum.length - 1)] / cum[cum.length - 1] };
  };

  /** progress (0..1 of arc length) → sample index */
  const indexAtProgress = (curve, p) => {
    const target = p * curve.length;
    let lo = 0, hi = curve.cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (curve.cum[mid] < target) lo = mid + 1; else hi = mid; }
    return lo;
  };

  /* ───────────── Map art (survey-style basemap) ───────────── */
  const drawBasemap = (svg, W, H, seed) => {
    const rnd = rng(seed);
    const g = svgEl('g', { class: 'basemap' }, svg);
    svgEl('rect', { width: W, height: H, fill: '#10140B' }, g);

    // soft parks
    const parks = svgEl('g', { fill: '#152010' }, g);
    for (let i = 0; i < 4; i++) {
      const cx = rnd() * W, cy = rnd() * H, rx = 50 + rnd() * 80, ry = 36 + rnd() * 64;
      let d = '';
      for (let a = 0; a <= 12; a++) {
        const th = (a / 12) * Math.PI * 2, k = 0.82 + rnd() * 0.36;
        d += `${a ? 'L' : 'M'}${(cx + Math.cos(th) * rx * k).toFixed(1)} ${(cy + Math.sin(th) * ry * k).toFixed(1)}`;
      }
      svgEl('path', { d: d + 'Z', 'stroke-linejoin': 'round', stroke: '#152010', 'stroke-width': 18 }, parks);
    }

    // topographic ridges
    const topo = svgEl('g', { fill: 'none', stroke: 'rgba(139,194,74,0.075)', 'stroke-width': 1 }, g);
    const phase = rnd() * 6;
    for (let k = -1; k < Math.ceil(H / 44) + 2; k++) {
      let d = '';
      for (let x = -20; x <= W + 20; x += 16) {
        const y = k * 44 + 26 * Math.sin(x * 0.011 + k * 0.33 + phase) + 12 * Math.sin(x * 0.029 - k * 0.55) + 6 * Math.sin(x * 0.061 + k);
        d += `${x === -20 ? 'M' : 'L'}${x} ${y.toFixed(1)}`;
      }
      svgEl('path', { d }, topo);
    }

    // streets: two crossing families, broken into irregular segments
    const streets = svgEl('g', { fill: 'none', 'stroke-linecap': 'round' }, g);
    const family = (angle, step, jitter) => {
      const grp = svgEl('g', { transform: `rotate(${angle} ${W / 2} ${H / 2})` }, streets);
      const span = Math.hypot(W, H);
      for (let off = -span / 2; off < span / 2; off += step * (0.6 + rnd() * jitter)) {
        const major = rnd() > 0.78;
        let x = -span / 2;
        while (x < span * 1.2) {
          const len = 90 + rnd() * 320;
          svgEl('line', {
            x1: x, y1: H / 2 + off, x2: x + len, y2: H / 2 + off,
            stroke: major ? '#27321B' : '#1A2313', 'stroke-width': major ? 3.6 : 1.7,
          }, grp);
          x += len + 4 + rnd() * 26;
        }
      }
    };
    family(-13, 44, 1.2);
    family(77, 52, 1.4);
    return g;
  };

  /* ───────────── Scene: one run on a lattice (used by hero, phone, card) ───────────── */
  const sizeLabel = (R) => (R * 0.4).toFixed(1);

  const makeScene = (svg, { W, H, s = 1, tx = 0, ty = 0, seed = 1, basemap = true, labels = true, lattice = true }) => {
    const R = HERO_R * s, ox = HERO_OX * s + tx, oy = HERO_OY * s + ty;
    if (basemap) drawBasemap(svg, W, H, seed);
    const cells = lattice ? buildLattice(svg, W, H, R, ox, oy) : new Map();
    const labelsGroup = svgEl('g', {}, svg);   // level numbers sit in a layer above the lattice
    const pts = transformPts(ROUTE, s, tx, ty);
    const curve = buildCurve(pts);
    const claim = computeClaim(curve, R, ox, oy);
    return { svg, W, H, R, ox, oy, s, tx, ty, cells, curve, claim, labelsGroup, labels };
  };

  const setOwner = (scene, cell, owner, level) => {
    const el = cell.el;
    el.classList.remove('is-mine', 'is-rival', 'is-clan');
    if (owner) {
      el.classList.add(`is-${owner}`);
      el.style.setProperty('--fo', (0.18 + 0.7 * ((level - 1) / 9)).toFixed(3));
    } else {
      el.style.removeProperty('--fo');
    }
    if (!scene.labels) return;
    if (!cell.lbl && owner) {
      cell.lbl = svgEl('text', { class: 'lv', x: cell.cx.toFixed(1), y: (cell.cy + 0.5).toFixed(1), 'font-size': sizeLabel(scene.R) }, scene.labelsGroup);
    }
    if (cell.lbl) {
      cell.lbl.textContent = owner ? String(level) : '';
      cell.lbl.classList.toggle('is-on', !!owner);
    }
  };

  const addRouteLayers = (scene, { runner = true, startMarker = true } = {}) => {
    const { svg, curve } = scene;
    const glow = svgEl('path', { class: 'route-glow', d: curve.d }, svg);
    const route = svgEl('path', { class: 'route', d: curve.d }, svg);
    const len = route.getTotalLength();
    [glow, route].forEach((p) => { p.style.strokeDasharray = len; p.style.strokeDashoffset = len; });
    let start = null, halo = null, dot = null;
    if (startMarker) {
      start = svgEl('g', {}, svg);
      svgEl('circle', { class: 'start-ring', cx: curve.samples[0][0], cy: curve.samples[0][1], r: Math.max(5, scene.R * 0.26) }, start);
    }
    if (runner) {
      const g = svgEl('g', {}, svg);
      halo = svgEl('circle', { class: 'runner-halo', r: Math.max(8, scene.R * 0.42) }, g);
      dot = svgEl('circle', { class: 'runner', r: Math.max(4.5, scene.R * 0.2) }, g);
      scene.runnerGroup = g;
    }
    Object.assign(scene, { glow, route, len, halo, dot, start });
    return scene;
  };

  const moveRunner = (scene, p) => {
    const pt = scene.route.getPointAtLength(scene.len * clamp(p, 0, 1));
    [scene.halo, scene.dot].forEach((c) => { c.setAttribute('cx', pt.x.toFixed(1)); c.setAttribute('cy', pt.y.toFixed(1)); });
  };
  const setRouteProgress = (scene, p) => {
    const off = scene.len * (1 - clamp(p, 0, 1));
    scene.route.style.strokeDashoffset = off;
    scene.glow.style.strokeDashoffset = off;
  };

  /* ───────────── Hero ───────────── */
  const initHero = () => {
    const svg = $('#plateMap');
    const plate = $('#plate');
    if (!svg || !plate) return;

    const scene = makeScene(svg, { W: 720, H: 760, seed: 7 });
    const { cells, claim, curve } = scene;
    const startPt = curve.samples[0];

    // neighbours: a rival to the east, a clan to the west (never on top of the claim)
    const rnd = rng(21);
    const inEllipse = (c, cx, cy, rx, ry) => ((c.cx - cx) / rx) ** 2 + ((c.cy - cy) / ry) ** 2 <= 1;
    cells.forEach((c, key) => {
      if (claim.claimed.has(key)) return;
      if (inEllipse(c, 668, 250, 110, 150) || inEllipse(c, 650, 640, 105, 120)) {
        setOwner(scene, c, 'rival', 1 + Math.floor(rnd() * 4)); c.state = -1;
      } else if (inEllipse(c, 92, 430, 62, 118)) {
        setOwner(scene, c, 'clan', 2 + Math.floor(rnd() * 4)); c.state = -2;
      }
    });

    // layers above the lattice
    const routeGroup = svgEl('g', {}, svg);
    scene.svg = routeGroup; // route layers append here so they can fade together
    addRouteLayers(scene);
    routeGroup.appendChild(scene.runnerGroup);
    svgEl('text', { class: 'start-label', x: startPt[0] + 14, y: startPt[1] + 22 }, routeGroup).textContent = 'START';

    // rival strike path (drawn with pathLength=1)
    const strike = buildCurve([[740, 408], [676, 396], [616, 388], [560, 372], [524, 356]], 24);
    const strikePath = svgEl('path', { class: 'route-rival', d: strike.d, pathLength: 1, opacity: 0 }, routeGroup);
    strikePath.style.strokeDashoffset = 1;
    const strikeHexes = [];
    {
      const seen = new Set();
      strike.samples.forEach(([x, y], i) => {
        const [q, r] = pixelToHex(x, y, scene.R, scene.ox, scene.oy);
        const key = `${q},${r}`;
        if (!seen.has(key) && claim.claimed.has(key)) { seen.add(key); strikeHexes.push({ key, at: i / (strike.samples.length - 1) }); }
      });
    }

    // capture order: rippling outward from the start
    const order = [...claim.claimed]
      .filter((k) => cells.has(k))
      .map((k) => ({ k, d: Math.hypot(cells.get(k).cx - startPt[0], cells.get(k).cy - startPt[1]) }))
      .sort((a, b) => a.d - b.d)
      .map((o) => o.k);
    const claimedCount = order.length;

    // DOM refs
    const hud = $('#hud'), hKm = $('#hKm'), hTime = $('#hTime'), hHex = $('#hHex');
    const pill = $('#hPill'), pillText = $('#hPillText');
    const banner = $('#hBanner'), toast = $('#hToast'), claimedOut = $('#hClaimed');

    // timeline (ms)
    const CYCLE = 15500, T_RUN = 6000, T_CLAIM = 6500, STEP = 15, T_TOAST = 7300;
    const T_ATTACK = 9800, T_ATTACK_LEN = 900, T_HUD_OFF = 9600, T_BANNER = 10300, T_FADE = 14600;
    const last = { km: '', time: '', hex: '', ready: null, claimed: '', text: '' };
    const attackedKeys = new Set();

    const render = (t) => {
      // run phase
      const p = t < T_RUN ? easeInOut(t / T_RUN) : 1;
      const idx = indexAtProgress(curve, p);
      setRouteProgress(scene, p);
      moveRunner(scene, p);
      scene.runnerGroup.style.opacity = t < T_RUN + 200 ? 1 : 0;

      const km = (p * RUN_KM).toFixed(2), time = fmtTime(p * RUN_KM * PACE_S), hex = String(claim.crossedAt[idx]);
      if (km !== last.km) { hKm.textContent = km; last.km = km; }
      if (time !== last.time) { hTime.textContent = time; last.time = time; }
      if (hex !== last.hex) { hHex.textContent = hex; last.hex = hex; }

      const ready = p >= claim.readyP;
      if (ready !== last.ready) {
        pill.classList.toggle('is-ready', ready);
        pillText.textContent = ready ? 'Loop closed — stop to claim territory!' : 'Run back toward your start to close the loop';
        pill.querySelector('use').setAttribute('href', ready ? '#i-check' : '#i-link');
        last.ready = ready;
      }

      // capture ripple
      const fading = t >= T_FADE;
      order.forEach((k, i) => {
        const c = cells.get(k);
        const want = !fading && t >= T_CLAIM + i * STEP ? (attackedKeys.has(k) ? 2 : 1) : 0;
        if (want === c.state) return;
        if (want === 0) { setOwner(scene, c, null, 0); }
        else {
          setOwner(scene, c, 'mine', want === 2 ? 1 : 2);
          if (c.state === 0) { c.el.classList.remove('pop'); void c.el.getBoundingClientRect(); c.el.classList.add('pop'); }
          if (c.state === 1 && want === 2) { c.el.classList.remove('hit'); void c.el.getBoundingClientRect(); c.el.classList.add('hit'); }
        }
        c.state = want;
      });

      // rival strike
      const ap = clamp((t - T_ATTACK) / T_ATTACK_LEN, 0, 1);
      strikePath.style.strokeDashoffset = 1 - ap;
      strikePath.style.opacity = t >= T_ATTACK && !fading ? 1 : 0;
      strikeHexes.forEach((h) => {
        if (t >= T_ATTACK && ap >= h.at && !fading) attackedKeys.add(h.key);
        if (t < T_ATTACK - 200 || fading) attackedKeys.delete(h.key);
      });

      // overlays
      hud.classList.toggle('is-off', t >= T_HUD_OFF);
      banner.classList.toggle('is-in', t >= T_BANNER && t < T_FADE);
      toast.classList.toggle('is-in', t >= T_TOAST && t < T_FADE);
      const n = String(Math.round(claimedCount * easeOut((t - T_TOAST) / 900)));
      if (n !== last.claimed) { claimedOut.textContent = n; last.claimed = n; }
      routeGroup.style.opacity = fading ? 1 - (t - T_FADE) / (CYCLE - T_FADE) : 1;
      if (t < 100) routeGroup.style.opacity = 1;
    };

    // ?t=<ms> freezes the animation at that moment (handy for screenshots and the social card)
    const forced = new URLSearchParams(location.search).get('t');
    if (forced !== null) { attackedKeys.clear(); for (let k = 0; k <= Number(forced); k += 100) render(k); render(Number(forced)); return; }
    if (reduceMotion) { render(T_ATTACK - 300); hud.classList.remove('is-off'); return; }

    let elapsed = 0, lastNow = 0, raf = 0, running = false;
    const frame = (now) => {
      elapsed += Math.min(now - lastNow, 50);
      lastNow = now;
      render(elapsed % CYCLE);
      raf = requestAnimationFrame(frame);
    };
    const start = () => { if (running) return; running = true; lastNow = performance.now(); raf = requestAnimationFrame(frame); };
    const stop = () => { running = false; cancelAnimationFrame(raf); };
    render(0);
    new IntersectionObserver(([e]) => (e.isIntersecting ? start() : stop()), { threshold: 0.12 }).observe(plate);
    document.addEventListener('visibilitychange', () => (document.hidden ? stop() : plateVisible() && start()));
    const plateVisible = () => { const r = plate.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; };
  };

  /* ───────────── Phone (How it works) ───────────── */
  const initPhone = () => {
    const phone = $('#phone');
    const mapSvg = $('#phoneMap');
    const cardSvg = $('#cardMap');
    if (!phone || !mapSvg) return;

    const S = 0.82;
    const scene = makeScene(mapSvg, { W: 368, H: 822, s: S, tx: 184 - 405 * S, ty: 478 - 440 * S, seed: 3 });
    addRouteLayers(scene, { startMarker: true });
    const { curve, claim, cells } = scene;
    const startPt = curve.samples[0];
    const order = [...claim.claimed].filter((k) => cells.has(k))
      .map((k) => ({ k, d: Math.hypot(cells.get(k).cx - startPt[0], cells.get(k).cy - startPt[1]) }))
      .sort((a, b) => a.d - b.d).map((o) => o.k);

    // neighbour hexes so the map doesn't look empty
    const rnd = rng(5);
    cells.forEach((c, key) => {
      if (claim.claimed.has(key)) return;
      if (((c.cx - 330) / 70) ** 2 + ((c.cy - 330) / 110) ** 2 < 1) { setOwner(scene, c, 'rival', 1 + Math.floor(rnd() * 3)); }
    });

    // share-card preview
    if (cardSvg) {
      const cs = 0.4, cscene = makeScene(cardSvg, { W: 320, H: 150, s: cs, tx: 160 - 405 * cs, ty: 75 - 440 * cs, basemap: false, labels: false });
      const bg = svgEl('rect', { width: 320, height: 150, fill: '#10140B' });
      cardSvg.insertBefore(bg, cardSvg.firstChild);
      cscene.claim.claimed.forEach((k) => { const c = cscene.cells.get(k); if (c) setOwner(cscene, c, 'mine', 2); });
      const path = svgEl('path', { class: 'route', d: cscene.curve.d, style: 'stroke-width:2' }, cardSvg);
      path.setAttribute('opacity', '0.95');
      const area = claim.claimed.size * HEX_AREA_M2 / 1e6;
      const out = $('#pAreaOut');
      if (out) out.textContent = `${area.toFixed(2)} km²`;
    }

    const refs = {
      km: $('#pKm'), time: $('#pTime'), hex: $('#pHex'), pill: $('#pPill'), pillText: $('#pPillText'),
    };
    const STEP_P = { 1: 0.55, 2: 1, 3: 1 };
    let current = 0, tween = 0;

    const showNumbers = (p) => {
      const idx = indexAtProgress(curve, p);
      refs.km.textContent = (p * RUN_KM).toFixed(2);
      refs.time.textContent = fmtTime(p * RUN_KM * PACE_S);
      refs.hex.textContent = String(claim.crossedAt[idx]);
    };

    const animateTo = (fromP, toP, dur) => {
      cancelAnimationFrame(tween);
      if (reduceMotion || dur === 0) { setRouteProgress(scene, toP); moveRunner(scene, toP); showNumbers(toP); return; }
      const t0 = performance.now();
      const tick = (now) => {
        const k = clamp((now - t0) / dur, 0, 1), p = lerp(fromP, toP, easeInOut(k));
        setRouteProgress(scene, p); moveRunner(scene, p); showNumbers(p);
        if (k < 1) tween = requestAnimationFrame(tick);
      };
      tween = requestAnimationFrame(tick);
    };

    let shownP = 0;
    const setStep = (n, instant = false) => {
      if (n === current) return;
      const prev = current; current = n;
      phone.dataset.step = String(n);

      const toP = STEP_P[n];
      animateTo(shownP, toP, instant ? 0 : 1100);
      shownP = toP;

      const ready = n >= 2;
      refs.pill.classList.toggle('is-ready', ready);
      refs.pillText.textContent = ready ? 'Loop closed — stop to claim territory!' : 'Run back toward your start to close the loop';
      refs.pill.querySelector('use').setAttribute('href', ready ? '#i-check' : '#i-link');

      // claim ripple on step 3, instant reset when leaving it
      const showMine = n === 3;
      order.forEach((k, i) => {
        const c = cells.get(k);
        c.el.style.transitionDelay = showMine && !reduceMotion ? `${0.35 + i * 0.018}s` : '0s';
        if (showMine) setOwner(scene, c, 'mine', 2); else setOwner(scene, c, null, 0);
      });
      scene.runnerGroup.style.opacity = n === 3 ? 0 : 1;

      $$('.how__progress span').forEach((el) => el.classList.toggle('is-on', Number(el.dataset.i) === n));
      $$('.step').forEach((el) => el.classList.toggle('is-active', Number(el.dataset.step) === n));
    };

    // initial paint (step 1)
    current = 0; shownP = STEP_P[1];
    setRouteProgress(scene, STEP_P[1]); moveRunner(scene, STEP_P[1]); showNumbers(STEP_P[1]);
    setStep(1, true);

    // scroll-driven step selection: the step nearest the focus line wins
    const steps = $$('.step');
    let ticking = false;
    const pick = () => {
      ticking = false;
      const narrow = window.matchMedia('(max-width: 960px)').matches;
      const focusY = innerHeight * (narrow ? 0.74 : 0.5);
      let best = 1, bestD = Infinity;
      steps.forEach((el) => {
        const r = el.getBoundingClientRect();
        const d = Math.abs((r.top + r.bottom) / 2 - focusY);
        if (d < bestD) { bestD = d; best = Number(el.dataset.step); }
      });
      setStep(best);
    };
    addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(pick); } }, { passive: true });
    addEventListener('resize', pick);
    pick();
  };

  /* ───────────── Compete board ───────────── */
  const initBoard = () => {
    const svg = $('#boardSvg');
    const sheetEl = $('#hexSheet');
    if (!svg || !sheetEl) return;

    const W = 640, H = 520, R = 37, OX = 52, OY = 42;
    const FORTIFY_COST = { 3: 15, 4: 30, 5: 60, 6: 120, 7: 240, 8: 480, 9: 960, 10: 1920 };
    const MAX_LEVEL = 10, START_COINS = 240, BOUNTY_STEP = 50;
    const fmt = (n) => n.toLocaleString('en-US');

    // authored layout in odd-q offset coordinates
    const LAYOUT = [
      '. . m m . . . c c . .',
      '. m m m . . . c c r .',
      '. m m m m . . . r r r',
      '. . m m m . . . r r r',
      '. . m m . . . . r r .',
      '. . . m . . c c . r .',
      '. . . . . . c c . . .',
      '. . . . . . . . . . .',
    ].map((row) => row.split(' '));
    const MINE_LV = [[2, 3], [3, 3], [4, 5], [2, 2], [5, 5], [3, 4], [2, 2], [3, 3], [4, 4], [2, 3], [1, 2], [3, 3], [2, 2], [2, 4]];
    const RIVAL_LV = [[2, 2], [1, 2], [3, 4], [4, 4], [2, 3], [1, 1], [3, 3], [2, 2], [1, 2], [4, 5], [2, 2]];
    const CLAN_LV = [[3, 4], [4, 5], [3, 3], [5, 5], [4, 4], [3, 4], [2, 3], [4, 4]];

    drawBasemap(svg, W, H, 11);
    const gHex = svgEl('g', {}, svg);
    const hexes = new Map();
    let mi = 0, ri = 0, ci = 0;

    const build = () => {
      hexes.clear();
      gHex.textContent = '';
      mi = ri = ci = 0;
      LAYOUT.forEach((row, rr) => row.forEach((ch, cc) => {
        const q = cc, r = rr - (cc - (cc & 1)) / 2;
        const [cx, cy] = [OX + R * 1.5 * cc, OY + R * SQ3 * (rr + 0.5 * (cc & 1))];
        const key = `${cc},${rr}`;
        const g = svgEl('g', { class: 'hexg', tabindex: cc === 0 && rr === 0 ? 0 : -1, role: 'button' }, gHex);
        const poly = svgEl('polygon', { class: 'hx', points: pointsAttr(hexCorners(cx, cy, R - 1.2)) }, g);
        const lbl = svgEl('text', { class: 'lv', x: cx, y: cy + 0.5, 'font-size': 15 }, g);
        const bty = svgEl('g', { visibility: 'hidden', 'pointer-events': 'none' }, g);
        svgEl('rect', { class: 'bty', x: cx - 24, y: cy + 9, width: 48, height: 17, rx: 4 }, bty);
        const btyT = svgEl('text', { class: 'bty-t', x: cx, y: cy + 18 }, bty);
        const h = { key, cc, rr, q, r, cx, cy, g, poly, lbl, bty, btyT, owner: null, level: 0, max: 0, bounty: 0, mine: 0, label: '' };
        if (ch === 'm') { const [l, m] = MINE_LV[mi++ % MINE_LV.length]; Object.assign(h, { owner: 'mine', level: l, max: m }); }
        if (ch === 'r') { const [l, m] = RIVAL_LV[ri++ % RIVAL_LV.length]; Object.assign(h, { owner: 'rival', level: l, max: m }); }
        if (ch === 'c') { const [l, m] = CLAN_LV[ci++ % CLAN_LV.length]; Object.assign(h, { owner: 'clan', level: l, max: m }); }
        hexes.set(key, h);
        g.addEventListener('click', () => select(h));
        g.addEventListener('keydown', (e) => onHexKey(e, h));
      }));
      // two bounties: one on a level-1 hex (a quick finishing hit), one on a sturdier one
      const rivals = [...hexes.values()].filter((h) => h.owner === 'rival');
      const quick = rivals.find((h) => h.level === 1 && h.max === 2) || rivals[0];
      const tough = rivals.find((h) => h.level >= 3) || rivals[1];
      quick.bounty = 120; tough.bounty = 60;
      hexes.forEach(paint);
    };

    // Roving tabindex: one tab stop for the whole board, arrow keys move between hexes.
    const DIRS = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] };
    const onHexKey = (e, h) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(h); return; }
      const dir = DIRS[e.key];
      if (!dir) return;
      e.preventDefault();
      let best = null, bestScore = Infinity;
      hexes.forEach((o) => {
        if (o === h) return;
        const dx = o.cx - h.cx, dy = o.cy - h.cy, dist = Math.hypot(dx, dy);
        const along = (dx * dir[0] + dy * dir[1]) / dist;
        if (along < 0.5) return;
        const score = dist * (2 - along);
        if (score < bestScore) { best = o; bestScore = score; }
      });
      if (best) {
        hexes.forEach((o) => o.g.setAttribute('tabindex', o === best ? 0 : -1));
        best.g.focus();
      }
    };

    const describe = (h) => {
      const pos = `${String.fromCharCode(65 + h.cc)}${h.rr + 1}`;
      if (!h.owner) return `Hex ${pos}, unoccupied`;
      const who = h.owner === 'mine' ? 'your hex' : h.owner === 'rival' ? 'rival hex' : 'clan hex';
      return `Hex ${pos}, ${who}, defense level ${h.level} of ${MAX_LEVEL}${h.bounty ? `, bounty ${h.bounty} coins` : ''}`;
    };

    function paint(h) {
      const el = h.poly;
      el.classList.remove('is-mine', 'is-rival', 'is-clan');
      if (h.owner) {
        el.classList.add(`is-${h.owner}`);
        el.style.setProperty('--fo', (0.18 + 0.7 * ((h.level - 1) / 9)).toFixed(3));
      } else el.style.removeProperty('--fo');
      h.lbl.textContent = h.owner ? String(h.level) : '';
      h.lbl.classList.toggle('is-on', !!h.owner);
      h.bty.setAttribute('visibility', h.bounty > 0 && h.owner !== 'mine' ? 'visible' : 'hidden');
      h.btyT.textContent = `◎ ${h.bounty}`;
      h.lbl.setAttribute('y', h.bounty > 0 ? h.cy - 5 : h.cy + 0.5);
      h.g.setAttribute('aria-label', describe(h));
      el.classList.toggle('is-sel', selected === h);
    }

    let selected = null;
    let coins = START_COINS;
    let night = false;
    const log = $('#boardLog');
    const coinsOut = $('#coinsOut');
    const actBtn = $('#actRun');
    const actLabel = $('#actRunLabel');

    const say = (html) => { log.innerHTML = html; };
    const setCoins = (n) => { coins = n; coinsOut.textContent = fmt(n); };

    const pips = (h) => {
      let out = '';
      for (let i = 1; i <= MAX_LEVEL; i++) out += `<i class="${i <= h.level ? 'f' : i <= h.max ? 'c' : ''}"></i>`;
      return `<span class="pips" aria-hidden="true">${out}</span>`;
    };
    const icon = (id) => `<svg class="ico" aria-hidden="true"><use href="#i-${id}"/></svg>`;

    const renderSheet = () => {
      const h = selected;
      if (!h) {
        sheetEl.innerHTML = `<div class="hs__head">${icon('hex')}<h3>No hex selected</h3></div>
          <div class="hs__body"><p class="hs__empty">Tap any hex on the board. This panel is the same action sheet the app opens in Compete mode.</p></div>`;
        return;
      }
      const title = !h.owner ? 'Unoccupied hex' : h.owner === 'mine' ? 'Your hex' : h.owner === 'clan' ? 'Clan Night Owls' : 'Hex @mia_runs';
      let body = '';
      if (!h.owner) {
        body = `<p class="hs__empty">This hex is unoccupied. Run across it during a run to capture it.</p>`;
      } else {
        body += h.owner === 'clan' ? `<p class="hs__sub">Last captured by: @theo.r — any clan member can fortify this hex.</p>` : '';
        body += `<div class="hs__level">Defense level ${h.level}/${MAX_LEVEL}${pips(h)}</div>`;
        if (h.bounty > 0 && h.owner !== 'mine') body += `<div class="hs__note">${icon('bounty')}<span>Total bounty on this hex: ${fmt(h.bounty)} coins</span></div>`;
        if (h.owner !== 'mine' && h.mine > 0) body += `<p class="hs__sub">Your bounty share: ${fmt(h.mine)} coins · <button class="textbtn" type="button" id="cancelBounty" style="min-height:0;padding:0;text-transform:none">Cancel</button></p>`;
        body += `<p class="hs__coins">${icon('coin')}${fmt(coins)} coins available</p>`;
        if (h.owner === 'mine') {
          const cost = FORTIFY_COST[h.max + 1];
          body += cost
            ? `<button class="btn btn--primary hs__btn" type="button" id="fortify" ${coins < cost ? 'disabled' : ''}>${icon('shield')}Fortify to level ${h.max + 1} — ${fmt(cost)} coins</button>`
            : `<p class="hs__done">Hex is fully fortified (${MAX_LEVEL}/${MAX_LEVEL})</p>`;
        } else {
          body += `<button class="btn btn--primary hs__btn" type="button" id="setBounty" ${coins < BOUNTY_STEP ? 'disabled' : ''}>${icon('bounty')}Set bounty · ${BOUNTY_STEP} coins</button>`;
        }
      }
      sheetEl.innerHTML = `<div class="hs__head">${icon('hex')}<h3>${title}</h3></div><div class="hs__body">${body}</div>`;

      $('#fortify', sheetEl)?.addEventListener('click', () => {
        const cost = FORTIFY_COST[h.max + 1];
        if (!cost || coins < cost) return;
        setCoins(coins - cost); h.max += 1; h.level = h.max;
        paint(h); pulse(h, 'pop');
        say(`<span class="ok">Fortified.</span> Ceiling raised to <b>${h.max}</b>, healed to full. <span class="gold">−${fmt(cost)} coins.</span>`);
        sync();
      });
      $('#setBounty', sheetEl)?.addEventListener('click', () => {
        if (coins < BOUNTY_STEP) return;
        setCoins(coins - BOUNTY_STEP); h.bounty += BOUNTY_STEP; h.mine += BOUNTY_STEP;
        paint(h);
        say(`Bounty placed. <span class="gold">${fmt(h.bounty)} coins</span> now ride on this hex — paid in full to whoever lands the finishing hit.`);
        sync();
      });
      $('#cancelBounty', sheetEl)?.addEventListener('click', () => {
        setCoins(coins + h.mine); h.bounty -= h.mine;
        say(`Bounty cancelled. <span class="gold">+${fmt(h.mine)} coins</span> refunded.`);
        h.mine = 0; paint(h); sync();
      });
    };

    const pulse = (h, cls) => { h.poly.classList.remove('pop', 'hit'); void h.poly.getBoundingClientRect(); h.poly.classList.add(cls); };

    const syncAction = () => {
      const h = selected;
      actBtn.disabled = !h;
      actLabel.textContent = !h ? 'Run through it' : !h.owner ? 'Run across it' : h.owner === 'mine' ? 'Run back over it' : 'Run through it';
    };
    function sync() { renderSheet(); syncAction(); }

    function select(h) {
      const prev = selected;
      selected = h;
      if (prev) paint(prev);
      paint(h);
      // keep the selected hex on top
      h.g.parentNode.appendChild(h.g);
      if (!h.owner) say(`<b>${describe(h)}.</b> Nobody owns it. Send a run across it to capture it${night ? ' — it\'s night, so it starts at level 3' : ' at level 2'}.`);
      else if (h.owner === 'mine') say(`<b>${describe(h)}.</b> Run back over it to heal it, or fortify it with coins.`);
      else say(`<b>${describe(h)}.</b> Put a bounty on it, or send a run through it.`);
      sync();
    }

    actBtn.addEventListener('click', () => {
      const h = selected;
      if (!h) return;
      if (!h.owner) {
        const lv = night ? 3 : 2;
        Object.assign(h, { owner: 'mine', level: lv, max: lv });
        paint(h); pulse(h, 'pop');
        say(`<span class="ok">Captured.</span> The hex starts at level <b>${lv}</b>${night ? ' — night runs get +1.' : '. Run it at night (21:00–06:00) and it would start at 3.'}`);
      } else if (h.owner === 'mine') {
        if (h.level >= h.max) say(`Already at full defense (${h.level}/${h.max}). Nothing to heal.`);
        else { const from = h.level; h.level = h.max; paint(h); pulse(h, 'pop'); say(`<span class="ok">Healed.</span> Level ${from} → <b>${h.level}</b>, back to this hex's ceiling.`); }
      } else if (h.level > 1) {
        h.level -= 1; paint(h); pulse(h, 'hit');
        say(`<span class="bad">Hit.</span> Knocked down to level <b>${h.level}</b>. Ownership doesn't change until a hex is hit at level 1.`);
      } else {
        const paid = h.bounty, mineShare = h.mine;
        h.owner = null; h.level = 0; h.max = 0; h.bounty = 0; h.mine = 0;
        if (paid) setCoins(coins + paid);
        paint(h); pulse(h, 'pop');
        say(`<span class="ok">Finishing hit.</span> The hex goes <b>neutral</b>${paid ? ` and the escrowed bounty pays out: <span class="gold">+${fmt(paid)} coins</span>${mineShare ? ' (including your own, so you just got it back).' : '.'}` : '. Run across it again to claim it for yourself.'}`);
      }
      sync();
    });

    $('#nightToggle').addEventListener('change', (e) => {
      night = e.target.checked;
      $('#board').classList.toggle('is-night', night);
      say(night ? 'Night run on. Hexes captured from neutral ground now start at <b>level 3</b>.' : 'Day run. New hexes start at level 2.');
    });
    $('#boardReset').addEventListener('click', () => {
      selected = null; night = false; $('#nightToggle').checked = false; $('#board').classList.remove('is-night');
      build(); setCoins(START_COINS); say('Board reset. Pick a hex to start.'); sync();
    });

    build(); setCoins(START_COINS); sync();
  };

  /* ───────────── Heroes ───────────── */
  const initHeroes = () => {
    const roster = $('#roster');
    if (!roster) return;
    const RARITY = {
      common: { label: 'Common', color: '#9BA28A', cost: 30 },
      rare: { label: 'Rare', color: '#5B9FE8', cost: 75 },
      epic: { label: 'Epic', color: '#B35BE8', cost: 150 },
      legendary: { label: 'Legendary', color: '#E8C23C', cost: 300 },
    };
    const HEROES = [
      ['angel', 'Angel', 'common'], ['paladin', 'Paladin', 'common'], ['cherub', 'Cherub', 'common'],
      ['fallen-angel', 'Fallen Angel', 'rare'], ['cleric', 'Cleric', 'common'], ['frost-mage', 'Frost Mage', 'rare'],
      ['sun-king', 'Sun King', 'epic'], ['demon-king', 'Demon King', 'epic'], ['oracle', 'Oracle', 'rare'],
      ['shadow-sovereign', 'Shadow Sovereign', 'epic'], ['enchantress', 'Enchantress', 'rare'], ['grim-reaper', 'Grim Reaper', 'epic'],
      ['guardian-teddy', 'Guardian Teddy', 'common'], ['feral-bear', 'Feral Bear', 'rare'], ['king-slime', 'King Slime', 'common'],
      ['rock-golem', 'Rock Golem', 'rare'], ['kitsune', 'Kitsune', 'epic'], ['fire-dragon', 'Fire Dragon', 'legendary'],
      ['lich-king', 'Lich King', 'epic'], ['pirate-captain', 'Pirate Captain', 'rare'], ['mech', 'Mech', 'epic'],
      ['world-tree', 'World Tree', 'rare'], ['mushroom-king', 'Mushroom King', 'common'], ['phoenix', 'Phoenix', 'legendary'],
      ['sir-whiskers', 'Sir Whiskers', 'rare'],
    ].map(([slug, name, rarity]) => ({ slug, name, rarity }));

    const src = (slug, tier) => `assets/heroes/${slug}/tier-${pad2(tier)}.png`;
    const slider = $('#tier'), tierOut = $('#tierOut'), tierCost = $('#tierCost');
    const stage = $('#stage'), stageArt = $('#stageArt'), stageImg = $('#stageImg');
    let tier = reduceMotion ? 12 : 1;
    let current = HEROES.find((h) => h.slug === 'phoenix');

    const tiles = HEROES.map((h) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'htile'; b.dataset.slug = h.slug;
      b.style.setProperty('--rc', RARITY[h.rarity].color);
      b.setAttribute('aria-pressed', 'false');
      b.setAttribute('aria-label', `${h.name}, ${RARITY[h.rarity].label}`);
      const img = new Image();
      img.alt = ''; img.width = 160; img.height = 160; img.loading = 'lazy'; img.decoding = 'async';
      const label = document.createElement('span'); label.textContent = h.name;
      b.append(img, label);
      b.addEventListener('click', () => { current = h; render(true); });
      roster.appendChild(b);
      return { h, b, img };
    });

    const render = (bump) => {
      const r = RARITY[current.rarity];
      tiles.forEach(({ h, b, img }) => {
        const s = src(h.slug, tier);
        if (img.getAttribute('src') !== s) img.src = s;
        b.setAttribute('aria-pressed', String(h === current));
      });
      stage.style.setProperty('--rc', r.color);
      stageImg.src = src(current.slug, tier);
      stageImg.alt = `${current.name}, form ${tier} of 15`;
      $('#stageName').textContent = current.name;
      $('#stageRarity').textContent = r.label;
      $('#stageUnlock').textContent = `Unlock · ${r.cost} coins`;
      tierOut.textContent = pad2(tier);
      tierCost.textContent = tier < 15 ? `Next form · ${10 + tier * 2} coins` : 'Fully evolved · form 15';
      slider.value = tier;
      slider.style.setProperty('--p', `${((tier - 1) / 14) * 100}%`);
      if (bump) { stageArt.classList.remove('bump'); void stageArt.offsetWidth; stageArt.classList.add('bump'); }
    };

    let userTouched = false;
    slider.addEventListener('input', () => { userTouched = true; tier = Number(slider.value); render(true); });
    render(false);

    // one-time evolution as the section scrolls into view
    if (!reduceMotion) {
      new IntersectionObserver((entries, obs) => {
        if (!entries[0].isIntersecting) return;
        obs.disconnect();
        const t0 = performance.now(), dur = 2800;
        const tick = (now) => {
          if (userTouched) return;
          const k = clamp((now - t0) / dur, 0, 1);
          const next = 1 + Math.round(easeInOut(k) * 14);
          if (next !== tier) { tier = next; render(false); }
          if (k < 1) requestAnimationFrame(tick);
        };
        setTimeout(() => requestAnimationFrame(tick), 350);
      }, { threshold: 0.45 }).observe(stage);
    }
  };

  /* ───────────── Heat calendar ───────────── */
  const initHeat = () => {
    const heat = $('#heat');
    if (!heat) return;
    const rnd = rng(42);
    const weekday = [0.55, 0.32, 0.62, 0.36, 0.26, 0.72, 0.5];           // Mon..Sun
    const total = 52 * 7 + 4;                                           // ends on a Thursday
    const frag = document.createDocumentFragment();
    for (let i = 0; i < total; i++) {
      const wd = i % 7;
      const season = 0.7 + 0.5 * Math.sin((i / total) * Math.PI * 1.15 + 0.2);
      const run = rnd() < weekday[wd] * season;
      let lv = 0;
      if (run) { const x = rnd(); lv = x < 0.3 ? 1 : x < 0.62 ? 2 : x < 0.88 ? 3 : 4; }
      const c = document.createElement('i');
      if (lv) c.className = `l${lv}`;
      frag.appendChild(c);
    }
    heat.appendChild(frag);
  };

  /* ───────────── Misc: header, reveal, stores ───────────── */
  const initHeader = () => {
    const header = $('#siteHeader');
    const onScroll = () => header.classList.toggle('is-scrolled', scrollY > 8);
    addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  };

  const initReveal = () => {
    if (reduceMotion || !('IntersectionObserver' in window)) return;
    const targets = $$('.sec-label, .h2, .lede, .hint, .rule, .feats li, .spec__cell, .stage, .analytics, .roster-wrap, .arena__main, .hexsheet, .cta__inner > *');
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); } });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    targets.forEach((el) => {
      const sibs = el.parentElement ? [...el.parentElement.children].filter((c) => c.matches('.spec__cell, .rule, li')) : [];
      const i = sibs.indexOf(el);
      if (i > 0) el.style.setProperty('--d', `${Math.min(i, 5) * 0.06}s`);
      el.classList.add('reveal');
      io.observe(el);
    });
  };

  const initStores = () => {
    const wire = (el, url, text) => {
      if (!el || !url) return;
      el.href = url; el.target = '_blank'; el.rel = 'noopener';
      el.removeAttribute('aria-disabled'); el.classList.add('is-live');
      el.querySelector('.store__v').textContent = text;
    };
    wire($('#storeIos'), STORE_LINKS.ios, 'Download now');
    wire($('#storeAndroid'), STORE_LINKS.android, 'Download now');
    $$('.store[aria-disabled="true"]').forEach((el) => el.addEventListener('click', (e) => e.preventDefault()));
  };

  /* ───────────── Boot ───────────── */
  const boot = () => {
    if (new URLSearchParams(location.search).has('nosmooth')) document.documentElement.style.scrollBehavior = 'auto';
    // blur filter for the route glow (referenced by CSS)
    const defs = $('svg defs');
    if (defs && !$('#blur6')) {
      const f = svgEl('filter', { id: 'blur6', x: '-20%', y: '-20%', width: '140%', height: '140%' }, defs);
      svgEl('feGaussianBlur', { stdDeviation: 6 }, f);
    }
    initHeader();
    initHero();
    initPhone();
    initBoard();
    initHeroes();
    initHeat();
    initStores();
    initReveal();
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
