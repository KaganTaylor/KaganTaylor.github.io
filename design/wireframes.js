/*
 * Wireframe eye and hand: prototype canvas drawings from the theme exploration (Nov 2026).
 * Dependency-free ES module. Size the <canvas> with CSS; the drawing follows its size and
 * the device pixel ratio.
 *
 *   import { createEye, createHand, drawHandFrame } from './wireframes.js';
 *   const colors = { primary: '#568f26', secondary: '#a8221d', structure: '#7d7d7d' };
 *   const eye = createEye(canvasA, colors, { onSaccade: s => console.log(s.degrees) });
 *   const hand = createHand(canvasB, colors, { onFrame: f => console.log(f.name) });
 *   eye.start(); hand.start();      // later: eye.destroy(); hand.destroy();
 *
 * Colours:
 *   primary   - iris rings, landing point; hand outline and digits
 *   secondary - gaze ray and target reticle; thumb and index fingertips (pinch contact points)
 *   structure - sphere grid and silhouette; palm mesh and bones (drawn at reduced opacity)
 *
 * With prefers-reduced-motion set, start() does nothing and each canvas shows one still frame.
 */

const D2R = Math.PI / 180;
const TAU = Math.PI * 2;
const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- shared canvas plumbing ---------- */

function begin(canvas) {
  const ctx = canvas.getContext('2d');
  const dpr = canvas._dpr || 1;
  const w = canvas.width / dpr, h = canvas.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.lineWidth = 1;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  return { ctx, w, h };
}

// Keeps the backing store matched to CSS size, pauses drawing while off-screen,
// and runs drawFrame(t) every animation frame while started.
function animator(canvas, drawFrame) {
  const reduce = reducedMotion();
  let raf = 0, running = false, visible = true;
  const t0 = performance.now();
  const now = () => (performance.now() - t0) / 1000;

  const ro = new ResizeObserver(() => {
    const r = canvas.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    canvas._dpr = dpr;
    drawFrame(running ? now() : 0);
  });
  ro.observe(canvas);

  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; });
  io.observe(canvas);

  const tick = () => {
    if (visible) drawFrame(now());
    raf = requestAnimationFrame(tick);
  };
  const stop = () => { running = false; cancelAnimationFrame(raf); };

  return {
    start() { if (running || reduce) return; running = true; raf = requestAnimationFrame(tick); },
    stop,
    destroy() { stop(); ro.disconnect(); io.disconnect(); }
  };
}

/* ---------- eye ---------- */
/*
 * A wireframe sphere that looks at a target reticle. The reticle jumps to a new random point
 * every 1.4-2.6 s; the eye follows after a 200 ms latency with a 90 ms saccade.
 * onSaccade({ fixation, degrees, x, y }) fires on each jump (x, y in CSS pixels).
 */

const EYE_RINGS = [30, 50, 70, 90, 110, 130, 150].map(a => ({ polar: a * D2R, iris: false }))
  .concat([{ polar: 11 * D2R, iris: true }, { polar: 22 * D2R, iris: true }]);
const EYE_MERIDIANS = Array.from({ length: 12 }, (_, i) => i * 30 * D2R);
const EYE_SEG = 56;
const SACCADE_LATENCY = 0.2, SACCADE_DURATION = 0.09;

const sphere = (polar, az) => [Math.sin(polar) * Math.cos(az), Math.sin(polar) * Math.sin(az), Math.cos(polar)];
function orient([x, y, z], th, ph) {
  const y1 = y * Math.cos(th) - z * Math.sin(th), z1 = y * Math.sin(th) + z * Math.cos(th);
  return [x * Math.cos(ph) + z1 * Math.sin(ph), y1, -x * Math.sin(ph) + z1 * Math.cos(ph)];
}
function gazeDir(g, cx, cy, R, w, h) {
  const dx = (g.x * w - cx) / R, dy = -(g.y * h - cy) / R, dz = 2.4;
  const n = Math.hypot(dx, dy, dz);
  return [dx / n, dy / n, dz / n];
}

export function createEye(canvas, colors, { onSaccade } = {}) {
  // Target positions are normalised to the canvas; the eye sits at 36% across.
  const randTarget = () => ({ x: 0.68 + Math.random() * 0.24, y: 0.2 + Math.random() * 0.6 });
  const e = { from: { x: 0.8, y: 0.5 }, to: { x: 0.8, y: 0.5 }, jump: -10, fixation: 1, next: 1.2 };

  const gazePoint = t => {
    const k = Math.min(1, Math.max(0, (t - e.jump - SACCADE_LATENCY) / SACCADE_DURATION));
    const s = k * k * (3 - 2 * k);
    return { x: e.from.x + (e.to.x - e.from.x) * s, y: e.from.y + (e.to.y - e.from.y) * s };
  };

  function draw(t) {
    const { ctx, w, h } = begin(canvas);
    if (!w || !h) return;
    const cx = w * 0.36, cy = h * 0.5, R = Math.min(w * 0.3, h * 0.32);

    if (t > e.next) {
      e.from = gazePoint(t); e.to = randTarget(); e.jump = t; e.fixation++;
      e.next = t + 1.4 + Math.random() * 1.2;
      const a = gazeDir(e.from, cx, cy, R, w, h), b = gazeDir(e.to, cx, cy, R, w, h);
      const degrees = Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) / D2R;
      onSaccade && onSaccade({ fixation: e.fixation, degrees, x: e.to.x * w, y: e.to.y * h });
    }

    const g = gazePoint(t);
    const [dx, dy, dz] = gazeDir(g, cx, cy, R, w, h);
    const th = -Math.asin(dy), ph = Math.atan2(dx, dz);
    const S = v => [cx + v[0] * R, cy - v[1] * R, v[2]];

    // silhouette
    ctx.strokeStyle = colors.structure; ctx.globalAlpha = 0.55;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.stroke();

    // sphere grid: back half faint, front half stronger
    const polyline = (pts, front) => {
      for (let k = 0; k < pts.length - 1; k++) {
        const a = pts[k], b = pts[k + 1];
        if ((a[2] + b[2] > 0) !== front) continue;
        ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
      }
    };
    const ringPts = r => Array.from({ length: EYE_SEG + 1 }, (_, k) => S(orient(sphere(r.polar, k / EYE_SEG * TAU), th, ph)));
    const merPts = az => Array.from({ length: EYE_SEG / 2 + 1 },
      (_, k) => S(orient(sphere(22 * D2R + k / (EYE_SEG / 2) * (158 * D2R), az), th, ph)));
    const grid = EYE_RINGS.filter(r => !r.iris).map(ringPts).concat(EYE_MERIDIANS.map(merPts));
    [[false, 0.13], [true, 0.5]].forEach(([front, alpha]) => {
      ctx.strokeStyle = colors.structure; ctx.globalAlpha = alpha; ctx.beginPath();
      grid.forEach(pts => polyline(pts, front)); ctx.stroke();
    });

    // iris
    ctx.strokeStyle = colors.primary; ctx.globalAlpha = 1; ctx.beginPath();
    EYE_RINGS.filter(r => r.iris).map(ringPts).forEach(pts => polyline(pts, true)); ctx.stroke();

    // gaze ray
    const pupil = S(orient([0, 0, 1], th, ph));
    const gx = g.x * w, gy = g.y * h;
    ctx.strokeStyle = colors.secondary; ctx.globalAlpha = 0.85; ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.moveTo(pupil[0], pupil[1]); ctx.lineTo(gx, gy); ctx.stroke();
    ctx.setLineDash([]);

    // target reticle
    const tx = e.to.x * w, ty = e.to.y * h;
    ctx.globalAlpha = 1; ctx.strokeStyle = colors.secondary; ctx.beginPath();
    ctx.arc(tx, ty, 9, 0, TAU);
    [[-16, -12], [12, 16]].forEach(([a, b]) => {
      ctx.moveTo(tx + a, ty); ctx.lineTo(tx + b, ty);
      ctx.moveTo(tx, ty + a); ctx.lineTo(tx, ty + b);
    });
    ctx.stroke();

    // landing point
    ctx.strokeStyle = colors.primary; ctx.beginPath(); ctx.arc(gx, gy, 2.5, 0, TAU); ctx.stroke();
    ctx.globalAlpha = 1;
  }

  return animator(canvas, draw);
}

/* ---------- hand ---------- */
/*
 * A vertical open palm that steps to a fist through one transition frame, like a sprite
 * (no tweening). Loop: open 1.1 s, transition 0.16 s, closed 1.1 s, transition 0.16 s.
 * Model space: palm-local units, x right, y up from the wrist, z towards the viewer.
 * onFrame({ index, name }) fires whenever the shown frame changes.
 */

export const HAND_FRAMES = [
  { name: 'open',       flex: [0, 0, 0],     splayK: 1,   thumbPhi: 45,  thumbFlex: [0, 0, 0] },
  { name: 'transition', flex: [40, 50, 30],  splayK: 0.5, thumbPhi: 0,   thumbFlex: [28, -12, -5] },
  { name: 'closed',     flex: [85, 100, 65], splayK: 0,   thumbPhi: -50, thumbFlex: [55, -40, -10] }
];
const HAND_SEQ = [0, 1, 2, 1];
const HAND_DUR = [1.1, 0.16, 1.1, 0.16];
const HAND_CYCLE = HAND_DUR.reduce((a, b) => a + b, 0);

// pinky, ring, middle, index; flex angles are per joint (MCP, PIP, DIP), in degrees
const FINGERS = [
  { x: -0.36, y: 0.90, L: [0.32, 0.20, 0.16], r: 0.085, splay: -10 },
  { x: -0.12, y: 0.98, L: [0.40, 0.26, 0.19], r: 0.095, splay: -3 },
  { x:  0.12, y: 1.00, L: [0.44, 0.29, 0.21], r: 0.095, splay: 2 },
  { x:  0.36, y: 0.96, L: [0.40, 0.25, 0.19], r: 0.09,  splay: 8, contact: true }
];
const THUMB = { x: 0.44, y: 0.26, L: [0.30, 0.25, 0.20], r: 0.1, contact: true };
const PALM = [[-0.38, -0.32], [-0.46, 0.15], [-0.48, 0.70], [-0.46, 0.90], [-0.24, 0.97], [0, 1.0], [0.24, 0.99],
  [0.46, 0.95], [0.50, 0.62], [0.47, 0.36], [0.40, 0.14], [0.36, -0.32]];
const PALM_MESH = [[[-0.46, 0.62], [0.49, 0.56]], [[-0.45, 0.30], [0.44, 0.24]], [[-0.38, -0.12], [0.37, -0.12]]];

// slight three-quarter view so curled fingers show depth
const VIEW_Y = -20 * D2R, VIEW_X = 10 * D2R;
function view([x, y, z]) {
  const x1 = x * Math.cos(VIEW_Y) + z * Math.sin(VIEW_Y), z1 = -x * Math.sin(VIEW_Y) + z * Math.cos(VIEW_Y);
  return [x1, y * Math.cos(VIEW_X) - z1 * Math.sin(VIEW_X), y * Math.sin(VIEW_X) + z1 * Math.cos(VIEW_X)];
}
function chain(x, y, z, phiDeg, flexRel, L) {
  const pts = [[x, y, z]];
  const phi = phiDeg * D2R;
  let a = 0;
  for (let k = 0; k < L.length; k++) {
    a += flexRel[k] * D2R;
    const q = pts[k];
    pts.push([q[0] + L[k] * Math.sin(phi) * Math.cos(a), q[1] + L[k] * Math.cos(phi) * Math.cos(a), q[2] + L[k] * Math.sin(a)]);
  }
  return pts;
}
function handPose(f) {
  return {
    fingers: FINGERS.map(g => ({ ...g, pts: chain(g.x, g.y, 0, g.splay * f.splayK, f.flex, g.L).map(view) })),
    thumb: { ...THUMB, pts: chain(THUMB.x, THUMB.y, 0.04, f.thumbPhi, f.thumbFlex, THUMB.L).map(view) },
    palm: PALM.map(([x, y]) => view([x, y, 0]))
  };
}
const POSES = HAND_FRAMES.map(handPose);

// one scale for every frame, so the fist doesn't zoom
const BOUNDS = (() => {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  POSES.forEach(P => [...P.palm, ...P.thumb.pts, ...P.fingers.flatMap(f => f.pts)].forEach(([x, y]) => {
    x0 = Math.min(x0, x - 0.1); x1 = Math.max(x1, x + 0.1);
    y0 = Math.min(y0, y - 0.1); y1 = Math.max(y1, y + 0.1);
  }));
  return { x0, x1, y0, y1 };
})();

function handFrameAt(t) {
  let u = ((t % HAND_CYCLE) + HAND_CYCLE) % HAND_CYCLE;
  for (let i = 0; i < HAND_SEQ.length; i++) {
    if (u < HAND_DUR[i]) return HAND_SEQ[i];
    u -= HAND_DUR[i];
  }
  return 0;
}

/** Draws one still frame (0 open, 1 transition, 2 closed). pad is the share of the canvas the hand fills. */
export function drawHandFrame(canvas, index, colors, pad = 0.76) {
  const { ctx, w, h } = begin(canvas);
  if (!w || !h) return;
  const B = BOUNDS;
  const s = Math.min(w * pad / (B.x1 - B.x0), h * pad / (B.y1 - B.y0));
  const ox = w / 2 - (B.x0 + B.x1) / 2 * s, oy = h / 2 + (B.y0 + B.y1) / 2 * s;
  const S = ([x, y]) => [ox + x * s, oy - y * s];
  const P = POSES[index];

  // palm mesh: metacarpals and creases
  ctx.strokeStyle = colors.structure; ctx.globalAlpha = 0.4; ctx.beginPath();
  FINGERS.forEach(g => {
    ctx.moveTo(...S(view([g.x, g.y - 0.04, 0])));
    ctx.lineTo(...S(view([g.x * 0.7, 0.05, 0])));
  });
  PALM_MESH.forEach(([a, b]) => { ctx.moveTo(...S(view([...a, 0]))); ctx.lineTo(...S(view([...b, 0]))); });
  ctx.stroke();

  // palm outline
  ctx.strokeStyle = colors.primary; ctx.globalAlpha = 0.9; ctx.beginPath();
  P.palm.map(S).forEach((q, i) => (i ? ctx.lineTo(...q) : ctx.moveTo(...q)));
  ctx.stroke();

  // digits, far to near
  [...P.fingers, P.thumb].sort((a, b) => a.pts.at(-1)[2] - b.pts.at(-1)[2]).forEach(d => {
    const sp = d.pts.map(S), r = d.r * s;

    ctx.strokeStyle = colors.structure; ctx.globalAlpha = 0.35; ctx.beginPath();
    sp.forEach((q, i) => (i ? ctx.lineTo(...q) : ctx.moveTo(...q)));
    ctx.stroke();

    // capsule sides; segments pointing at the viewer are left to the joint rings
    ctx.strokeStyle = colors.primary; ctx.globalAlpha = 0.9; ctx.beginPath();
    for (let k = 0; k < sp.length - 1; k++) {
      const A = sp[k], Bp = sp[k + 1], dx = Bp[0] - A[0], dy = Bp[1] - A[1], len = Math.hypot(dx, dy);
      if (len < r * 0.6) continue;
      const nx = -dy / len * r, ny = dx / len * r;
      ctx.moveTo(A[0] + nx, A[1] + ny); ctx.lineTo(Bp[0] + nx, Bp[1] + ny);
      ctx.moveTo(A[0] - nx, A[1] - ny); ctx.lineTo(Bp[0] - nx, Bp[1] - ny);
    }
    ctx.stroke();

    ctx.globalAlpha = 0.5; ctx.beginPath();
    sp.slice(0, -1).forEach(q => { ctx.moveTo(q[0] + r, q[1]); ctx.arc(q[0], q[1], r, 0, TAU); });
    ctx.stroke();

    const tip = sp.at(-1);
    ctx.strokeStyle = d.contact ? colors.secondary : colors.primary; ctx.globalAlpha = 1; ctx.beginPath();
    ctx.arc(tip[0], tip[1], r, 0, TAU); ctx.stroke();
  });
  ctx.globalAlpha = 1;
}

export function createHand(canvas, colors, { onFrame, pad } = {}) {
  let last = -1;
  return animator(canvas, t => {
    const index = handFrameAt(t);
    if (index !== last) {
      last = index;
      onFrame && onFrame({ index, name: HAND_FRAMES[index].name });
    }
    drawHandFrame(canvas, index, colors, pad);
  });
}
