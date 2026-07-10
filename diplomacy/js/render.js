// Board rendering on top of the jDip standard.svg map.
// Layers (from the SVG): MapLayer (terrain), our InfluenceLayer (ownership
// tint, cloned from MouseLayer shapes), SupplyCenterLayer, OrderLayer
// (Layer2 under Layer1), UnitLayer, DislodgedUnitLayer, MouseLayer (hit test).

import { PROVINCES } from './map-data.js';
import { prov } from './adjudicator.js';

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

const UNIT_W = 40;
const UNIT_H = 26; // symbol viewBox 23x15 scaled to width 40

export class Board {
  constructor() {
    this.svg = null;
    this.coords = new Map(); // 'par' / 'stp/sc' -> {x, y, dx, dy}
    this.layers = {};
    this.onProvinceClick = null;
    this.onProvinceHover = null;
  }

  async load(container) {
    const text = await (await fetch('assets/standard.svg')).text();
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const svg = doc.documentElement;

    // unit coordinates from jdipNS metadata
    for (const p of svg.getElementsByTagName('jdipNS:PROVINCE')) {
      const name = p.getAttribute('name').replace('-', '/');
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

    // ownership tint layer: clone of the id'd MouseLayer shapes
    const influence = this.layers.mouse.cloneNode(true);
    influence.setAttribute('id', 'InfluenceLayer');
    influence.removeAttribute('class');
    influence.setAttribute('pointer-events', 'none');
    for (const el of influence.querySelectorAll('[id]')) {
      el.setAttribute('data-prov', el.id.replace('-', '/'));
      el.removeAttribute('id');
    }
    for (const p of influence.querySelectorAll('path')) {
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', 'none');
    }
    this.layers.map.after(influence);
    this.layers.influence = influence;

    // hit-testing + hover
    this.layers.mouse.addEventListener('click', (e) => {
      const p = this._provinceOf(e.target);
      if (p && this.onProvinceClick) this.onProvinceClick(p, e);
    });
    this.layers.mouse.addEventListener('mousemove', (e) => {
      const p = this._provinceOf(e.target);
      if (this.onProvinceHover) this.onProvinceHover(p, e);
    });
    return this;
  }

  setPhaseText(s) {
    const t = this.svg.querySelector('#CurrentPhase');
    if (t) {
      t.textContent = s;
      t.setAttribute('x', '1810');
      t.setAttribute('text-anchor', 'end');
    }
  }

  _provinceOf(el) {
    while (el && el !== this.layers.mouse) {
      if (el.id) return el.id.replace('-', '/');
      el = el.parentNode;
    }
    return null;
  }

  center(loc) {
    const c = this.coords.get(loc) || this.coords.get(prov(loc));
    if (!c) return { x: 0, y: 0 };
    return { x: c.x + UNIT_W / 2, y: c.y + UNIT_H / 2 };
  }

  // ---- state rendering ----------------------------------------------------

  setInfluence(scOwners) {
    for (const el of this.layers.influence.querySelectorAll('[data-prov]')) {
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
        this._unitNode(u.type === 'A' ? 'Army' : 'Fleet', c.x, c.y, u.power, prov(u.loc))
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
          prov(d.from)
        )
      );
    }
  }

  _unitNode(symbol, x, y, power, provId) {
    const use = document.createElementNS(SVGNS, 'use');
    use.setAttributeNS(XLINKNS, 'xlink:href', `#${symbol}`);
    use.setAttribute('href', `#${symbol}`);
    use.setAttribute('x', x);
    use.setAttribute('y', y);
    use.setAttribute('width', UNIT_W);
    use.setAttribute('height', UNIT_W);
    use.setAttribute('class', `unit${power}`);
    use.setAttribute('data-prov', provId);
    return use;
  }

  // ---- order overlays -------------------------------------------------------

  clearOrders() {
    this.layers.orders1.replaceChildren();
    this.layers.orders2.replaceChildren();
    this.layers.highest.replaceChildren();
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
      if (order.isConvoyMove) {
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
    } else if (order.kind === 'convoy' || order.kind === 'hold') {
      g.appendChild(this._text(from.x + 18, from.y - 12, '✕', 36));
    } else {
      g.appendChild(this._text(from.x + 18, from.y - 12, '✕', 36));
    }
    this.layers.highest.appendChild(g);
    return g;
  }
}
