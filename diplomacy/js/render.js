// Board rendering on top of the jDip standard.svg map.
// Layers (from the SVG): MapLayer (terrain), our InfluenceLayer (ownership
// tint, cloned from MouseLayer shapes), SupplyCenterLayer, OrderLayer
// (Layer2 under Layer1), UnitLayer, DislodgedUnitLayer, MouseLayer (hit test).
//
// Interaction: the host app supplies handlers via board.handlers —
//   canDrag(prov) -> {color} | null   (may the user start a drag here?)
//   onDrop(fromProv, toProv, event)
//   onClick(prov, event)
//   onHover(prov | null)
// Dragging from a non-draggable province pans the (zoomed) board; the mouse
// wheel zooms, double-click resets.

import { PROVINCES, ALIASES } from './map-data.js';
import { prov } from './adjudicator.js';

// the jDip SVG uses a few of its own abbreviations (mid, gol, nat, nrg, tyn);
// normalize everything that leaves the SVG to the engine's canonical ids
function canonLoc(s) {
  const k = s.replace('-', '/');
  return ALIASES[k] || k;
}

const SVGNS = 'http://www.w3.org/2000/svg';
const XLINKNS = 'http://www.w3.org/1999/xlink';

export const POWER_COLORS = {
  austria: '#a33a2a',
  england: 'darkviolet',
  france: 'royalblue',
  germany: '#5a4a38',
  italy: 'forestgreen',
  russia: '#4a5a7a',
  turkey: '#957e00',
};

// ---------------------------------------------------------------------------
// COASTLINE APPEARANCE — change the coastline colour HERE
//
// The sea-facing edges of the split-coast provinces (Spain, St Petersburg,
// Bulgaria) are stroked so it is visually clear that each coast is a separate
// landing spot for a fleet. All of them use one colour:
//
//   COAST_COLOR      the colour of every coastline — edit this one value to
//                    recolour all of them.
//   COAST_COLORS     optional per-coast overrides, keyed by the coast suffix
//                    in a canonical location id ('nc', 'ec', 'sc'). Empty by
//                    default, so every coast uses COAST_COLOR; adding e.g.
//                    { sc: '#9aa0a6' } would tint south coasts differently.
//   COAST_SUFFIXES   which coasts get a coastline at all.
//   COAST_WIDTH      stroke weight, in map units.
//   COAST_OPACITY    stroke opacity, 0–1.
//
// A coastline is a wayfinding hint, not a highlight: keep it muted enough not
// to compete with the ownership tints (POWER_COLORS above) or the hover
// outline (HOVER_COLOR below).
// ---------------------------------------------------------------------------
export const COAST_COLOR = '#6b7280';
export const COAST_COLORS = {};
const COAST_SUFFIXES = ['nc', 'ec', 'sc'];
const COAST_WIDTH = 7;
const COAST_OPACITY = 0.85;
const coastColor = (suffix) => COAST_COLORS[suffix] || COAST_COLOR;

// outline drawn around the province under the pointer — and, on touch, around
// the province last tapped (there is no hover on a touchscreen)
const HOVER_COLOR = '#ffd479';
const HOVER_WIDTH = 4;

const UNIT_W = 40;
const UNIT_H = 26; // symbol viewBox 23x15 scaled to width 40
const ANIM_MS = 950;

export class Board {
  constructor() {
    this.svg = null;
    this.coords = new Map(); // 'par' / 'stp/sc' -> {x, y, dx, dy}
    this.layers = {};
    this.handlers = {};
    this._hovered = null;
  }

  async load(container) {
    const text = await (await fetch('assets/standard.svg')).text();
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const svg = doc.documentElement;

    // unit coordinates from jdipNS metadata
    for (const p of svg.getElementsByTagName('jdipNS:PROVINCE')) {
      const name = canonLoc(p.getAttribute('name'));
      const unit = p.getElementsByTagName('jdipNS:UNIT')[0];
      const disl = p.getElementsByTagName('jdipNS:DISLODGED_UNIT')[0];
      if (unit) {
        this.coords.set(name, {
          x: parseFloat(unit.getAttribute('x')),
          y: parseFloat(unit.getAttribute('y')),
          dx: disl ? parseFloat(disl.getAttribute('x')) : parseFloat(unit.getAttribute('x')) - 11,
          dy: disl ? parseFloat(disl.getAttribute('y')) : parseFloat(unit.getAttribute('y')) - 10,
        });
      }
    }
    for (const tag of ['jdipNS:DISPLAY', 'jdipNS:ORDERDRAWING', 'jdipNS:PROVINCE_DATA']) {
      for (const n of [...svg.getElementsByTagName(tag)]) n.remove();
    }

    const adopted = document.importNode(svg, true);
    adopted.removeAttribute('width');
    adopted.removeAttribute('height');
    adopted.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    container.appendChild(adopted);
    this.svg = adopted;

    const m = /([\d.-]+)[ ,]+([\d.-]+)[ ,]+([\d.-]+)[ ,]+([\d.-]+)/.exec(
      adopted.getAttribute('viewBox')
    );
    this.vb0 = { x: +m[1], y: +m[2], w: +m[3], h: +m[4] };
    this.vb = { ...this.vb0 };

    const byId = (id) => adopted.querySelector(`#${CSS.escape(id)}`);
    this.layers = {
      map: byId('MapLayer'),
      sc: byId('SupplyCenterLayer'),
      orders1: byId('Layer1'),
      orders2: byId('Layer2'),
      units: byId('UnitLayer'),
      dislodged: byId('DislodgedUnitLayer'),
      mouse: byId('MouseLayer'),
      highest: byId('HighestOrderLayer'),
    };

    // thicker unit outlines so armies/fleets stand out
    for (const r of adopted.querySelectorAll('symbol rect[stroke-width="3%"]')) {
      r.setAttribute('stroke-width', '1.4');
    }

    // ownership tint layer: clone of the id'd MouseLayer shapes
    const influence = this.layers.mouse.cloneNode(true);
    influence.setAttribute('id', 'InfluenceLayer');
    influence.removeAttribute('class');
    influence.setAttribute('pointer-events', 'none');
    for (const el of influence.querySelectorAll('[id]')) {
      el.setAttribute('data-prov', canonLoc(el.id));
      el.removeAttribute('id');
    }
    for (const p of influence.querySelectorAll('path')) {
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', 'none');
    }
    this.layers.map.after(influence);
    this.layers.influence = influence;

    // mark the individual coastlines of split-coast provinces (spa, stp,
    // bul) so it's visually clear they're separate landing spots. Only the
    // stretches of the province outline that actually border a sea space are
    // stroked (never the land borders), in COAST_COLOR — see the COASTLINE
    // APPEARANCE block at the top of this file. The land keeps its ownership
    // color.
    const coastTint = document.createElementNS(SVGNS, 'g');
    coastTint.setAttribute('id', 'CoastTintLayer');
    coastTint.setAttribute('pointer-events', 'none');
    const mouseTransform = this.layers.mouse.getAttribute('transform');
    if (mouseTransform) coastTint.setAttribute('transform', mouseTransform);
    const tm = /translate\(\s*([-\d.]+)[ ,]+([-\d.]+)/.exec(mouseTransform || '');
    const [tx, ty] = tm ? [+tm[1], +tm[2]] : [0, 0];
    const splitBases = new Set();
    for (const loc of this.coords.keys()) {
      if (loc.includes('/')) splitBases.add(loc.split('/')[0]);
    }
    // The MouseLayer hit shapes don't tile exactly, so the water test uses
    // the visible terrain in MapLayer instead: the sea polygons carry
    // class="water" and tile precisely with the land — a probe just past
    // the outline that lands in one is looking at open sea.
    // Each water path is sampled into polygon rings (subpaths split where
    // consecutive samples jump) and probed with an even-odd ray cast. Only
    // sampling APIs are used — the game screen is display:none while the
    // board loads, which makes getBBox()/isPointInFill() unusable here.
    const mapLayer = this.layers.map;
    const seaShapes = [];
    for (const el of mapLayer.querySelectorAll('path.water')) {
      const len = el.getTotalLength();
      const step = Math.max(2.5, len / 600);
      const rings = [];
      let ring = null, last = null;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let s = 0; s <= len; s += step) {
        const p = el.getPointAtLength(Math.min(s, len));
        if (!ring || (last && Math.hypot(p.x - last.x, p.y - last.y) > step * 5)) {
          ring = [];
          rings.push(ring);
        }
        ring.push(p);
        last = p;
        if (p.x < x0) x0 = p.x;
        if (p.y < y0) y0 = p.y;
        if (p.x > x1) x1 = p.x;
        if (p.y > y1) y1 = p.y;
      }
      seaShapes.push({ rings, x0: x0 - 2, y0: y0 - 2, x1: x1 + 2, y1: y1 + 2 });
    }
    const isSea = (x, y) => {
      for (const w of seaShapes) {
        if (x < w.x0 || x > w.x1 || y < w.y0 || y > w.y1) continue;
        let inside = false;
        for (const ring of w.rings) {
          for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const a = ring[i], b = ring[j];
            if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
              inside = !inside;
            }
          }
        }
        if (inside) return true;
      }
      return false;
    };
    for (const base of splitBases) {
      const outline = mapLayer.querySelector(`#${CSS.escape('_' + base)}`);
      if (!outline) continue;
      // this province's coast markers, in the outline's coordinate space
      const coasts = [];
      for (const suffix of COAST_SUFFIXES) {
        if (!this.coords.has(`${base}/${suffix}`)) continue;
        const c = this.center(`${base}/${suffix}`);
        coasts.push({ suffix, x: c.x - tx, y: c.y - ty });
      }
      if (!coasts.length) continue;
      // sample the outline, then test each point: does the sea lie just
      // past it along the outline's normal (either side, two depths)?
      const len = outline.getTotalLength();
      const step = Math.min(3.5, Math.max(2, len / 800));
      const pts = [];
      for (let s = 0; s <= len; s += step) pts.push(outline.getPointAtLength(Math.min(s, len)));
      const n = pts.length;
      const sea = new Array(n).fill(false);
      for (let i = 0; i < n; i++) {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
        const tl = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const nx = -(b.y - a.y) / tl, ny = (b.x - a.x) / tl;
        const p = pts[i];
        for (const d of [2, -2, 4, -4, 8, -8]) {
          if (isSea(p.x + nx * d, p.y + ny * d)) { sea[i] = true; break; }
        }
      }
      // smooth: bridge small land gaps inside a coast (probes miss the sea
      // at the tips of narrow fjords), nudge each stretch one sample
      // outward, then drop lone specks
      for (let i = 0; i < n; ) {
        if (sea[i]) { i++; continue; }
        let j = i;
        while (j < n && !sea[j]) j++;
        if (i > 0 && j < n && j - i <= 3) for (let k = i; k < j; k++) sea[k] = true;
        i = j;
      }
      const seaOrig = sea.slice();
      for (let i = 0; i < n; i++) {
        if (!seaOrig[i] && ((i > 0 && seaOrig[i - 1]) || (i + 1 < n && seaOrig[i + 1]))) sea[i] = true;
      }
      for (let i = 0; i < n; ) {
        if (!sea[i]) { i++; continue; }
        let j = i;
        while (j < n && sea[j]) j++;
        if (j - i < 3) for (let k = i; k < j; k++) sea[k] = false;
        i = j;
      }
      // contiguous water-facing stretches become polylines (broken across
      // subpath jumps). A split province's coasts are always separated by
      // land borders, so each whole stretch belongs to one coast: the one
      // whose unit marker comes nearest to it anywhere along its length.
      // Which coast a stretch belongs to only affects its colour, and every
      // coast shares COAST_COLOR unless COAST_COLORS overrides it.
      const runs = [];
      let run = null;
      const endRun = () => {
        if (run && run.length > 2) runs.push(run);
        run = null;
      };
      for (let i = 0; i < n; i++) {
        if (!sea[i]) { endRun(); continue; }
        const p = pts[i];
        const last = run && run[run.length - 1];
        if (last && Math.hypot(p.x - last.x, p.y - last.y) > step * 4) endRun();
        if (!run) run = [];
        run.push(p);
      }
      endRun();
      for (const r of runs) {
        let best = coasts[0], bd = Infinity;
        for (const c of coasts) {
          for (const p of r) {
            const dd = Math.hypot(c.x - p.x, c.y - p.y);
            if (dd < bd) { bd = dd; best = c; }
          }
        }
        const pl = document.createElementNS(SVGNS, 'polyline');
        pl.setAttribute('points', r.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '));
        pl.setAttribute('fill', 'none');
        pl.setAttribute('stroke', coastColor(best.suffix));
        pl.setAttribute('stroke-width', COAST_WIDTH);
        pl.setAttribute('stroke-opacity', COAST_OPACITY);
        pl.setAttribute('stroke-linecap', 'round');
        pl.setAttribute('stroke-linejoin', 'round');
        coastTint.appendChild(pl);
      }
    }
    influence.after(coastTint);
    this.layers.coastTint = coastTint;

    // the hovered/tapped province's outline lives in its own layer above the
    // coastlines — stroked onto the influence shapes it would be buried under
    // them, and Spain would light up along its land borders only
    const hover = document.createElementNS(SVGNS, 'g');
    hover.setAttribute('id', 'HoverLayer');
    hover.setAttribute('pointer-events', 'none');
    if (mouseTransform) hover.setAttribute('transform', mouseTransform);
    coastTint.after(hover);
    this.layers.hover = hover;

    this._attachPointer();
    window.__board = this; // debug/testing handle
    return this;
  }

  // ---- geometry -------------------------------------------------------------

  clientToBoard(x, y) {
    const pt = new DOMPoint(x, y).matrixTransform(this.svg.getScreenCTM().inverse());
    return { x: pt.x, y: pt.y };
  }

  center(loc) {
    const c = this.coords.get(loc) || this.coords.get(prov(loc));
    if (!c) return { x: 0, y: 0 };
    return { x: c.x + UNIT_W / 2, y: c.y + UNIT_H / 2 };
  }

  setViewBox(x, y, w, h) {
    const { vb0 } = this;
    w = Math.min(vb0.w, Math.max(vb0.w / 8, w));
    h = w * (vb0.h / vb0.w);
    x = Math.min(vb0.x + vb0.w - w, Math.max(vb0.x, x));
    y = Math.min(vb0.y + vb0.h - h, Math.max(vb0.y, y));
    this.vb = { x, y, w, h };
    this.svg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
  }

  resetZoom() {
    this.setViewBox(this.vb0.x, this.vb0.y, this.vb0.w, this.vb0.h);
  }

  // ---- pointer interaction ----------------------------------------------------

  _provinceOf(el) {
    while (el && el !== this.svg) {
      if (el.id && el.parentNode &&
          (el.parentNode === this.layers.mouse || el.parentNode.parentNode === this.layers.mouse)) {
        // <path id="ank"> or <g id="con"><path> children
        const node = el.parentNode === this.layers.mouse ? el : el.parentNode;
        return canonLoc(node.id);
      }
      el = el.parentNode;
    }
    return null;
  }

  _provinceAtClient(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el || !this.layers.mouse.contains(el)) return null;
    return this._provinceOf(el);
  }

  // The MouseLayer sits on top of everything for accurate province hit
  // testing, so units never receive pointer events directly — instead we
  // test the pointer's board-space position against each rendered unit's
  // bounding box. Used only to decide whether a drag may start (dragging
  // must begin exactly on a unit), not for province hit testing in general.
  _unitAtClient(x, y) {
    const pt = this.clientToBoard(x, y);
    const hit = (layer) => {
      for (const use of layer.children) {
        const ux = parseFloat(use.getAttribute('x'));
        const uy = parseFloat(use.getAttribute('y'));
        const uw = parseFloat(use.getAttribute('width'));
        const uh = parseFloat(use.getAttribute('height'));
        if (pt.x >= ux && pt.x <= ux + uw && pt.y >= uy && pt.y <= uy + uh) {
          // full location (with coast) so a drag from a fleet on stp/nc
          // starts its ghost arrow at the coast marker, not the province
          return use.getAttribute('data-loc') || use.getAttribute('data-prov');
        }
      }
      return null;
    };
    return hit(this.layers.dislodged) || hit(this.layers.units);
  }

  _attachPointer() {
    const svg = this.svg;
    let drag = null;
    // multi-touch: a second finger landing cancels any single-finger drag/pan
    // in progress and starts a pinch-to-zoom gesture instead
    const activePointers = new Map(); // pointerId -> {x, y}
    let pinch = null; // {dist}
    let lastTap = null; // {time, x, y} — touch double-tap-to-reset-zoom
    const ptDist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const ptMid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

    svg.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); // no text selection while dragging on the board
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (activePointers.size === 2) {
        if (drag) {
          if (drag.started && this.handlers.onDragEnd) this.handlers.onDragEnd();
          this._removeGhost();
          drag = null;
        }
        const [a, b] = [...activePointers.values()];
        pinch = { dist: ptDist(a, b) || 1 };
        return;
      }
      if (activePointers.size > 2) return; // ignore extra fingers

      if (e.pointerType === 'touch') {
        const now = Date.now();
        if (lastTap && now - lastTap.time < 300 && ptDist(lastTap, { x: e.clientX, y: e.clientY }) < 30) {
          lastTap = null;
          this.resetZoom();
          return;
        }
        lastTap = { time: now, x: e.clientX, y: e.clientY };
      }

      const clickProv = this._provinceAtClient(e.clientX, e.clientY);
      const unitProv = this._unitAtClient(e.clientX, e.clientY);
      const spec = unitProv && this.handlers.canDrag ? this.handlers.canDrag(unitProv) : null;
      drag = {
        from: spec ? unitProv : clickProv,
        spec,
        startX: e.clientX,
        startY: e.clientY,
        panVB: spec ? null : { ...this.vb },
        moved: false,
        started: false,
        threshold: e.pointerType === 'touch' ? 10 : 5,
      };
      try {
        svg.setPointerCapture(e.pointerId);
      } catch {
        // synthetic events (tests) have no active pointer to capture
      }
    });

    svg.addEventListener('pointermove', (e) => {
      if (activePointers.has(e.pointerId)) activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pinch && activePointers.size === 2) {
        const [a, b] = [...activePointers.values()];
        const newDist = ptDist(a, b) || 1;
        const factor = pinch.dist / newDist;
        const mid = ptMid(a, b);
        const pt = this.clientToBoard(mid.x, mid.y);
        this.setViewBox(
          pt.x - (pt.x - this.vb.x) * factor,
          pt.y - (pt.y - this.vb.y) * factor,
          this.vb.w * factor,
          this.vb.h * factor
        );
        pinch.dist = newDist;
        return;
      }

      // a touchscreen has no hover: a finger sliding across the board is
      // panning or dragging a unit, never "pointing at" a province. Tracking
      // it here also left a province highlighted wherever the last finger of
      // a pinch happened to be — taps do the highlighting instead (see finish).
      if (e.pointerType === 'touch' && !drag) return;

      const p = this._provinceAtClient(e.clientX, e.clientY);
      if (!drag) {
        this._setHover(p);
        if (this.handlers.onHover) this.handlers.onHover(p);
        return;
      }
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > drag.threshold) drag.moved = true;
      if (!drag.moved) return;
      if (drag.spec && !drag.started) {
        drag.started = true;
        // let the app hide this unit's existing order arrow while dragging
        if (this.handlers.onDragStart) this.handlers.onDragStart(drag.from);
      }
      if (drag.spec) {
        const a = this.center(drag.from);
        const b = this.clientToBoard(e.clientX, e.clientY);
        this._updateGhost(a, b, drag.spec.color);
        this._setHover(p);
      } else if (drag.panVB) {
        const scale = this.svg.getScreenCTM().a;
        this.setViewBox(
          drag.panVB.x - (e.clientX - drag.startX) / scale,
          drag.panVB.y - (e.clientY - drag.startY) / scale,
          drag.panVB.w,
          drag.panVB.h
        );
      }
    });

    const finish = (e, cancelled) => {
      activePointers.delete(e.pointerId);
      if (pinch && activePointers.size < 2) pinch = null;
      const d = drag;
      drag = null;
      this._removeGhost();
      if (!d) return;
      if (!cancelled && !d.moved) {
        // a tap/click highlights the province it landed on — on touch this is
        // the only way to highlight one
        this._setHover(d.from);
        if (this.handlers.onHover) this.handlers.onHover(d.from);
        if (d.from && this.handlers.onClick) this.handlers.onClick(d.from, e);
      } else if (!cancelled && d.spec) {
        const to = this._provinceAtClient(e.clientX, e.clientY);
        if (to && this.handlers.onDrop) this.handlers.onDrop(d.from, to, e);
      }
      if (d.started && this.handlers.onDragEnd) this.handlers.onDragEnd();
    };
    svg.addEventListener('pointerup', (e) => finish(e, false));
    svg.addEventListener('pointercancel', (e) => finish(e, true));

    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1 / 1.25 : 1.25;
      const pt = this.clientToBoard(e.clientX, e.clientY);
      const w = this.vb.w * factor;
      const h = this.vb.h * factor;
      this.setViewBox(
        pt.x - (pt.x - this.vb.x) * factor,
        pt.y - (pt.y - this.vb.y) * factor,
        w,
        h
      );
    }, { passive: false });

    svg.addEventListener('dblclick', () => this.resetZoom());
  }

  // Outlines the whole province and nothing else. Only the base shape is
  // traced: the MouseLayer also carries a hit shape per coast of a split-coast
  // province (spa-nc, spa-sc, …), and those bulge out into the sea — outlining
  // them too made Spain, St Petersburg and Bulgaria look like three cut-out
  // regions instead of one country. The coastlines already show where each
  // coast lies.
  _setHover(p) {
    if (p === this._hovered) return;
    this._hovered = p;
    this.layers.hover.replaceChildren();
    if (!p) return;
    const pv = prov(p);
    for (const el of this.layers.influence.querySelectorAll('[data-prov]')) {
      const loc = el.getAttribute('data-prov');
      if (loc.includes('/') || prov(loc) !== pv) continue;
      const paths = el.tagName === 'path' ? [el] : [...el.querySelectorAll('path')];
      for (const path of paths) {
        const outline = path.cloneNode(false);
        outline.removeAttribute('data-prov');
        outline.setAttribute('fill', 'none');
        outline.setAttribute('fill-opacity', '0');
        outline.setAttribute('stroke', HOVER_COLOR);
        outline.setAttribute('stroke-width', HOVER_WIDTH);
        this.layers.hover.appendChild(outline);
      }
    }
  }

  _updateGhost(a, b, color) {
    if (!this._ghost) {
      const g = document.createElementNS(SVGNS, 'line');
      g.setAttribute('stroke-width', 7);
      g.setAttribute('stroke-linecap', 'round');
      g.setAttribute('pointer-events', 'none');
      g.setAttribute('opacity', '0.8');
      this.layers.highest.appendChild(g);
      this._ghost = g;
    }
    const g = this._ghost;
    g.setAttribute('x1', a.x);
    g.setAttribute('y1', a.y);
    g.setAttribute('x2', b.x);
    g.setAttribute('y2', b.y);
    g.setAttribute('stroke', color || '#ffd479');
    g.setAttribute('marker-end', this._marker(color || '#ffd479'));
  }

  _removeGhost() {
    if (this._ghost) this._ghost.remove();
    this._ghost = null;
  }

  setPhaseText(s) {
    const t = this.svg.querySelector('#CurrentPhase');
    if (t) {
      t.textContent = s;
      t.setAttribute('x', '1810');
      t.setAttribute('text-anchor', 'end');
    }
  }

  // ---- state rendering ----------------------------------------------------

  setInfluence(scOwners) {
    for (const el of this.layers.influence.querySelectorAll('[data-prov]')) {
      // skip the coast sub-shapes of split provinces (stp/nc, spa/sc, …) —
      // they overlap the base shape, and stacking the translucent fill
      // would render that part of the land darker than the rest
      if (el.getAttribute('data-prov').includes('/')) continue;
      const p = prov(el.getAttribute('data-prov'));
      const owner = scOwners[p];
      const paths = el.tagName === 'path' ? [el] : [...el.querySelectorAll('path')];
      for (const path of paths) {
        if (owner && PROVINCES[p] && PROVINCES[p].type !== 'water') {
          path.setAttribute('fill', POWER_COLORS[owner]);
          path.setAttribute('fill-opacity', '0.35');
        } else {
          path.setAttribute('fill', 'none');
        }
      }
    }
  }

  setUnits(units, dislodged = []) {
    this.layers.units.replaceChildren();
    this.layers.dislodged.replaceChildren();
    for (const u of units) {
      const c = this.coords.get(u.loc) || this.coords.get(prov(u.loc));
      if (!c) continue;
      this.layers.units.appendChild(
        this._unitNode(u.type === 'A' ? 'Army' : 'Fleet', c.x, c.y, u.power, prov(u.loc), u.loc)
      );
    }
    for (const d of dislodged) {
      const c = this.coords.get(d.from) || this.coords.get(prov(d.from));
      if (!c) continue;
      this.layers.dislodged.appendChild(
        this._unitNode(
          d.unit.type === 'A' ? 'DislodgedArmy' : 'DislodgedFleet',
          c.dx,
          c.dy,
          d.unit.power,
          prov(d.from),
          d.from
        )
      );
    }
  }

  _unitNode(symbol, x, y, power, provId, loc) {
    const use = document.createElementNS(SVGNS, 'use');
    use.setAttributeNS(XLINKNS, 'xlink:href', `#${symbol}`);
    use.setAttribute('href', `#${symbol}`);
    use.setAttribute('x', x);
    use.setAttribute('y', y);
    use.setAttribute('width', UNIT_W);
    use.setAttribute('height', UNIT_W);
    use.setAttribute('class', `unit${power}`);
    use.setAttribute('data-prov', provId);
    if (loc) use.setAttribute('data-loc', loc);
    return use;
  }

  // ---- resolution animation --------------------------------------------------
  //
  // Called with the board showing the pre-movement units (and dislodged
  // markers). Successful moves slide to their destination, bounced moves
  // lunge toward it and fall back, failed retreats and removals fade out.
  // Resolves when all animations finish.
  animateFinal(entry) {
    const anims = [];
    const findUnit = (layer, p) =>
      layer.querySelector(`use[data-prov="${prov(p)}"]`);
    const delta = (fromLoc, toLoc) => {
      const a = this.coords.get(fromLoc) || this.coords.get(prov(fromLoc));
      const b = this.coords.get(toLoc) || this.coords.get(prov(toLoc));
      if (!a || !b) return null;
      return { x: b.x - a.x, y: b.y - a.y };
    };
    const ease = 'cubic-bezier(0.45, 0.05, 0.35, 1)';

    for (const r of entry.results || []) {
      const o = r.order;
      if (o.kind === 'move' && entry.step === 'movement') {
        const node = findUnit(this.layers.units, o.loc);
        if (!node) continue;
        const d = delta(o.loc, o.destLoc || o.dest);
        if (!d) continue;
        if (r.verdict === 'succeeds') {
          anims.push(
            node.animate(
              [
                { transform: 'translate(0px, 0px)' },
                { transform: `translate(${d.x}px, ${d.y}px)` },
              ],
              { duration: ANIM_MS, easing: ease, fill: 'forwards' }
            )
          );
        } else if (r.verdict === 'fails' && !o.illegal) {
          // bounce: advance a third of the way, then fall back
          anims.push(
            node.animate(
              [
                { transform: 'translate(0px, 0px)', easing: 'ease-out' },
                {
                  transform: `translate(${d.x * 0.33}px, ${d.y * 0.33}px)`,
                  offset: 0.5,
                  easing: 'ease-in-out',
                },
                { transform: 'translate(0px, 0px)' },
              ],
              { duration: ANIM_MS, easing: 'linear' }
            )
          );
        }
      } else if ((o.kind === 'retreat' || o.kind === 'disband') && entry.step === 'retreat') {
        const node = findUnit(this.layers.dislodged, o.loc);
        if (!node) continue;
        if (o.kind === 'retreat' && r.verdict === 'succeeds') {
          const d = delta(prov(o.loc), o.destLoc || o.dest);
          if (!d) continue;
          anims.push(
            node.animate(
              [
                { transform: 'translate(0px, 0px)' },
                { transform: `translate(${d.x}px, ${d.y}px)` },
              ],
              { duration: ANIM_MS, easing: ease, fill: 'forwards' }
            )
          );
        } else {
          anims.push(
            node.animate([{ opacity: 1 }, { opacity: 0 }], {
              duration: ANIM_MS * 0.7,
              easing: 'ease-in',
              fill: 'forwards',
            })
          );
        }
      } else if (o.kind === 'remove' && r.verdict === 'succeeds') {
        const node = findUnit(this.layers.units, o.loc);
        if (node)
          anims.push(
            node.animate([{ opacity: 1 }, { opacity: 0 }], {
              duration: ANIM_MS * 0.7,
              easing: 'ease-in',
              fill: 'forwards',
            })
          );
      }
    }
    // dislodged units with no legal retreat are destroyed outright (fade)
    if (entry.step === 'movement') {
      for (const d of entry.dislodged || []) {
        if (d.retreatOptions && d.retreatOptions.length) continue;
        const node = findUnit(this.layers.dislodged, d.from);
        if (node)
          anims.push(
            node.animate([{ opacity: 1 }, { opacity: 0 }], {
              duration: ANIM_MS * 0.7,
              easing: 'ease-in',
              fill: 'forwards',
            })
          );
      }
    }
    // unordered dislodged units in a retreat phase also disband (fade)
    if (entry.step === 'retreat') {
      const ordered = new Set(
        (entry.results || []).map((r) => prov(r.order.loc))
      );
      for (const d of entry.dislodged || []) {
        if (ordered.has(prov(d.from))) continue;
        const node = findUnit(this.layers.dislodged, d.from);
        if (node)
          anims.push(
            node.animate([{ opacity: 1 }, { opacity: 0 }], {
              duration: ANIM_MS * 0.7,
              easing: 'ease-in',
              fill: 'forwards',
            })
          );
      }
    }
    if (!anims.length) return Promise.resolve();
    return Promise.allSettled(anims.map((a) => a.finished));
  }

  // ---- order overlays -------------------------------------------------------

  clearOrders() {
    this.layers.orders1.replaceChildren();
    this.layers.orders2.replaceChildren();
    this.layers.highest.replaceChildren();
    this._ghost = null;
  }

  // colored arrowhead markers, created on demand per color
  _marker(color) {
    const id = 'arrow-' + color.replace(/[^\w]/g, '');
    if (!this.svg.querySelector('#' + id)) {
      const base = this.svg.querySelector('#arrow');
      const m = base.cloneNode(true);
      m.setAttribute('id', id);
      m.querySelector('path').setAttribute('fill', color);
      base.parentNode.appendChild(m);
    }
    return `url(#${id})`;
  }

  _line(layer, x1, y1, x2, y2, cls, color, opts = {}) {
    const shadow = document.createElementNS(SVGNS, 'line');
    shadow.setAttribute('x1', x1); shadow.setAttribute('y1', y1);
    shadow.setAttribute('x2', x2); shadow.setAttribute('y2', y2);
    shadow.setAttribute('class', 'shadowdash');
    const line = document.createElementNS(SVGNS, 'line');
    line.setAttribute('x1', x1); line.setAttribute('y1', y1);
    line.setAttribute('x2', x2); line.setAttribute('y2', y2);
    line.setAttribute('class', cls);
    line.setAttribute('stroke', color);
    if (opts.arrow) line.setAttribute('marker-end', this._marker(color));
    if (opts.width) line.setAttribute('stroke-width', opts.width);
    const g = document.createElementNS(SVGNS, 'g');
    g.appendChild(shadow);
    g.appendChild(line);
    layer.appendChild(g);
    return g;
  }

  // shorten a segment so the arrow head stops at the unit edge
  _trim(a, b, delta) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const f = Math.max(0, (len - delta) / len);
    return { x: a.x + dx * f, y: a.y + dy * f };
  }

  drawOrder(order, color) {
    const g = document.createElementNS(SVGNS, 'g');
    g.setAttribute('data-order-overlay', '1');
    const from = this.center(order.unit ? order.unit.loc : order.loc);
    const kind = order.kind;
    if (kind === 'move' || kind === 'retreat') {
      const dest = order.destLoc || order.dest;
      const to = this._trim(from, this.center(dest), 24);
      const el = this._line(this.layers.orders1, from.x, from.y, to.x, to.y, 'varwidthorder', color, { arrow: true, width: 6 });
      el.querySelector('line:last-child').setAttribute('fill', color);
      g.appendChild(el);
      if (order.isConvoyMove || order.viaConvoy) {
        const badge = this._text(from.x + 14, from.y - 14, '⚓', 20);
        g.appendChild(badge);
      }
    } else if (kind === 'support') {
      const target = this.center(order.target.loc);
      if (order.target.dest) {
        const destC = this.center(order.target.dest);
        const mid = { x: (target.x + destC.x) / 2, y: (target.y + destC.y) / 2 };
        g.appendChild(this._line(this.layers.orders2, from.x, from.y, mid.x, mid.y, 'supportorder', color));
      } else {
        const to = this._trim(from, target, 26);
        g.appendChild(this._line(this.layers.orders2, from.x, from.y, to.x, to.y, 'supportorder', color));
        g.appendChild(this._ring(target.x, target.y, 30, color, true));
      }
    } else if (kind === 'convoy') {
      const target = this.center(order.target.loc);
      const destC = this.center(order.dest);
      const mid = { x: (target.x + destC.x) / 2, y: (target.y + destC.y) / 2 };
      g.appendChild(this._line(this.layers.orders2, from.x, from.y, mid.x, mid.y, 'convoyorder', color));
    } else if (kind === 'disband') {
      g.appendChild(this._text(from.x, from.y + 10, '⤫', 40, '#c40000'));
    } else if (kind === 'build') {
      // pending unit: real symbol, marked with a dashed green ring + plus
      const c = this.coords.get(order.loc) || this.coords.get(prov(order.loc));
      if (c) {
        const ghost = this._unitNode(
          order.unitType === 'F' ? 'Fleet' : 'Army',
          c.x, c.y, order.power, prov(order.loc)
        );
        ghost.setAttribute('opacity', '0.9');
        ghost.setAttribute('pointer-events', 'none');
        g.appendChild(ghost);
        g.appendChild(this._ring(c.x + UNIT_W / 2, c.y + UNIT_H / 2, 32, '#2ee06b', true));
        g.appendChild(this._text(c.x + UNIT_W - 2, c.y - 6, '+', 34, '#2ee06b'));
      }
    } else if (kind === 'remove') {
      g.appendChild(this._ring(from.x, from.y, 32, '#e04747', true));
      g.appendChild(this._text(from.x + UNIT_W / 2 + 8, from.y - 18, '✕', 30, '#e04747'));
    } else {
      // hold
      g.appendChild(this._ring(from.x, from.y, 26, color, false));
    }
    this.layers.orders1.appendChild(g);
    return g;
  }

  _ring(cx, cy, r, color, dashed) {
    const c = document.createElementNS(SVGNS, 'circle');
    c.setAttribute('cx', cx);
    c.setAttribute('cy', cy);
    c.setAttribute('r', r);
    c.setAttribute('fill', 'none');
    c.setAttribute('stroke', color);
    c.setAttribute('stroke-width', 5);
    if (dashed) c.setAttribute('stroke-dasharray', '5,5');
    return c;
  }

  _text(x, y, s, size = 30, color = '#c40000') {
    const t = document.createElementNS(SVGNS, 'text');
    t.setAttribute('x', x);
    t.setAttribute('y', y);
    t.setAttribute('font-size', size);
    t.setAttribute('font-weight', 'bold');
    t.setAttribute('fill', color);
    t.setAttribute('stroke', 'white');
    t.setAttribute('stroke-width', 0.8);
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('pointer-events', 'none');
    t.textContent = s;
    return t;
  }

  // resolution marks drawn on top of everything
  markFailure(order, reason) {
    const g = document.createElementNS(SVGNS, 'g');
    g.setAttribute('data-order-overlay', '1');
    const from = this.center(order.unit ? order.unit.loc : order.loc);
    if ((order.kind === 'move' || order.kind === 'retreat') && (order.destLoc || order.dest)) {
      const to = this._trim(from, this.center(order.destLoc || order.dest), 30);
      g.appendChild(this._text(to.x, to.y + 10, '✕', 44));
    } else if (order.kind === 'support' && reason === 'support cut') {
      const target = order.target.dest ? this.center(order.target.dest) : this.center(order.target.loc);
      const mid = { x: (from.x + target.x) / 2, y: (from.y + target.y) / 2 };
      g.appendChild(this._text(mid.x, mid.y + 8, '∕', 46));
      g.appendChild(this._text(mid.x, mid.y - 18, 'cut', 20));
    } else {
      g.appendChild(this._text(from.x + 18, from.y - 12, '✕', 36));
    }
    this.layers.highest.appendChild(g);
    return g;
  }
}
