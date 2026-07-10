import { Board, POWER_COLORS } from './render.js';
import * as S from './state.js';
import { parseOrders, parseOrderLine, normalizePower } from './parser.js';
import { prov, armyAdjacent, fleetDestLocs } from './adjudicator.js';
import { PROVINCES, POWERS } from './map-data.js';

const $ = (id) => document.getElementById(id);

let board;
let game = null;
let playback = null; // {entry, step, orders, readonly, animating}
let editMode = false;
let editTool = 'A';
let lastParsed = { orders: [], errors: [], byProv: new Map() };

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function provName(p) {
  return PROVINCES[prov(p)] ? PROVINCES[prov(p)].name : p;
}

function fmtLoc(l) {
  const c = l.includes('/') ? `(${l.split('/')[1]})` : '';
  return provName(l) + c;
}

function fmtOrder(o) {
  const t = o.unitType ? o.unitType + ' ' : '';
  const u = `${t}${fmtLoc(o.loc || '')}`;
  switch (o.kind) {
    case 'move': return `${u} → ${fmtLoc(o.dest)}${o.isConvoyMove ? ' ⚓' : ''}`;
    case 'retreat': return `${u} retreats → ${fmtLoc(o.dest)}`;
    case 'hold': return `${u} holds`;
    case 'disband': return `${u} disbands`;
    case 'support':
      return o.target.dest
        ? `${u} S ${fmtLoc(o.target.loc)} → ${fmtLoc(o.target.dest)}`
        : `${u} S ${fmtLoc(o.target.loc)} (hold)`;
    case 'convoy': return `${u} C ${fmtLoc(o.target.loc)} → ${fmtLoc(o.dest)}`;
    case 'build': return `build ${o.unitType} ${fmtLoc(o.loc)}`;
    case 'remove': return `remove ${fmtLoc(o.loc)}`;
    case 'waive': return `waive build`;
  }
  return '?';
}

function phaseKind() {
  return game.step === 'movement' ? 'movement' : game.step === 'retreat' ? 'retreat' : 'adjustment';
}

function unitAt(p) {
  return game.units.find((u) => prov(u.loc) === prov(p));
}

function dislodgedAt(p) {
  return game.pending && game.pending.dislodged.find((d) => prov(d.from) === prov(p));
}

function showScreen(id) {
  $('home-screen').hidden = id !== 'home-screen';
  $('game-screen').hidden = id !== 'game-screen';
}

let toastTimer;
function toast(msg, kind = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = kind;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2800);
}

function pickCoast(x, y, options) {
  return new Promise((resolve) => {
    const el = $('coast-picker');
    el.replaceChildren();
    const close = (val) => {
      el.hidden = true;
      document.removeEventListener('pointerdown', onDoc, true);
      resolve(val);
    };
    for (const o of options) {
      const b = document.createElement('button');
      b.textContent = o.includes('/') ? o.split('/')[1].toUpperCase() : provName(o);
      b.onclick = (e) => {
        e.stopPropagation();
        close(o);
      };
      el.appendChild(b);
    }
    el.style.left = Math.min(x, innerWidth - 160) + 'px';
    el.style.top = Math.min(y + 8, innerHeight - 60) + 'px';
    el.hidden = false;
    const onDoc = (e) => {
      if (!el.contains(e.target)) close(null);
    };
    setTimeout(() => document.addEventListener('pointerdown', onDoc, true));
  });
}

// ---------------------------------------------------------------------------
// home screen
// ---------------------------------------------------------------------------
function renderHome() {
  const list = $('game-list');
  list.replaceChildren();
  const games = S.listGames();
  const names = Object.keys(games).sort();
  if (!names.length) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="meta">No saved games yet</span>';
    list.appendChild(li);
  }
  for (const name of names) {
    const g = games[name];
    const li = document.createElement('li');
    const load = document.createElement('button');
    load.className = 'load';
    load.innerHTML = `${name} <span class="meta">· ${S.phaseLabel(g)}</span>`;
    load.onclick = () => openGame(g);
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '🗑';
    del.title = 'Delete';
    del.onclick = () => {
      if (confirm(`Delete "${name}"?`)) {
        S.deleteGame(name);
        renderHome();
      }
    };
    li.append(load, del);
    list.appendChild(li);
  }
}

function uniqueName(base) {
  const games = S.listGames();
  let name = base || 'Game';
  let n = 2;
  while (games[name]) name = `${base} ${n++}`;
  return name;
}

// ---------------------------------------------------------------------------
// game screen
// ---------------------------------------------------------------------------
function openGame(g) {
  game = g;
  playback = null;
  S.saveGame(game);
  showScreen('game-screen');
  $('game-name').textContent = game.name;
  setEditMode(!!game.sandbox && game.units.length === 0);
  refreshAll();
}

function refreshAll() {
  $('phase-label').textContent = S.phaseLabel(game);
  board.setPhaseText(S.phaseLabel(game));
  board.setInfluence(game.scOwners);
  board.setUnits(game.units, game.step === 'retreat' ? game.pending.dislodged : []);
  board.clearOrders();
  $('panel-playback').hidden = true;
  $('panel-orders').hidden = false;
  $('btn-undo').disabled = !game.history.length;
  prefillOrders();
  renderHistorySelect();
  renderStandings();
  onOrdersChanged();
}

function prefillOrders() {
  const ta = $('orders-text');
  const info = $('phase-info');
  if (game.step === 'movement') {
    $('orders-title').textContent = 'Orders — ' + S.phaseLabel(game);
    info.textContent = 'Type orders or drag units on the map. Unordered units hold.';
    const lines = [];
    for (const p of POWERS) {
      if (game.units.some((u) => u.power === p)) lines.push(p.toUpperCase(), '');
    }
    ta.value = lines.join('\n');
  } else if (game.step === 'retreat') {
    $('orders-title').textContent = 'Retreats — ' + S.phaseLabel(game);
    info.textContent = 'Drag a dislodged unit to retreat it, or click it to disband. Unordered units disband.';
    const lines = [];
    for (const d of game.pending.dislodged) {
      lines.push(d.unit.power.toUpperCase());
      lines.push(`${d.unit.type} ${prov(d.from)} disband   # options: ${d.retreatOptions.join(', ') || 'none'}`);
      lines.push('');
    }
    ta.value = lines.join('\n');
  } else {
    $('orders-title').textContent = 'Builds — ' + S.phaseLabel(game);
    const counts = S.adjustmentCounts(game);
    const occupied = new Set(game.units.map((u) => prov(u.loc)));
    const lines = [];
    const infoLines = [];
    for (const [p, c] of Object.entries(counts)) {
      if (c > 0) {
        const free = (S.HOME_CENTERS[p] || []).filter(
          (h) => game.scOwners[h] === p && !occupied.has(h)
        );
        infoLines.push(`${cap(p)}: ${c} build${c > 1 ? 's' : ''} — click a free home center (${free.join(', ') || 'none free'})`);
        lines.push(p.toUpperCase(), `# ${c} build${c > 1 ? 's' : ''}`, '');
      } else if (c < 0) {
        infoLines.push(`${cap(p)}: must disband ${-c} — click units to remove`);
        lines.push(p.toUpperCase(), `# disband ${-c}`, '');
      }
    }
    info.textContent = infoLines.join('\n') || 'No builds or disbands required.';
    ta.value = lines.join('\n');
  }
}

function onOrdersChanged() {
  const { orders, errors } = parseOrders($('orders-text').value, phaseKind());
  lastParsed = { orders, errors, byProv: new Map() };
  for (const o of orders) if (o.loc) lastParsed.byProv.set(prov(o.loc), o);
  const el = $('parse-status');
  if (errors.length) {
    el.innerHTML = `<span class="err">${errors.length} problem${errors.length > 1 ? 's' : ''}:\n` +
      errors.map((e) => '· ' + escapeHtml(e)).join('\n') + '</span>';
  } else {
    el.innerHTML = `<span class="ok">${orders.length} order${orders.length === 1 ? '' : 's'} ✓ (everyone else holds)</span>`;
  }
  drawLive();
  return { orders, errors };
}

function drawLive() {
  if (playback || !game) return;
  board.clearOrders();
  for (const o of lastParsed.orders) {
    board.drawOrder(o, POWER_COLORS[o.power] || '#888');
  }
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

// ---------------------------------------------------------------------------
// order text syncing (drag/click interactions write into the textarea)
// ---------------------------------------------------------------------------
function unitToken(u) {
  return `${u.type} ${u.type === 'F' ? u.loc : prov(u.loc)}`;
}

function orderTextFor(u, spec) {
  switch (spec.kind) {
    case 'hold': return `${unitToken(u)} H`;
    case 'move': return `${unitToken(u)} - ${spec.dest}${spec.via ? ' via convoy' : ''}`;
    case 'retreat': return `${unitToken(u)} - ${spec.dest}`;
    case 'disband': return `${unitToken(u)} disband`;
    case 'support':
      return `${unitToken(u)} S ${spec.targetType} ${spec.targetLoc}` +
        (spec.targetDest ? ` - ${spec.targetDest}` : '');
    case 'convoy': return `${unitToken(u)} C A ${spec.targetLoc} - ${spec.dest}`;
  }
}

// Scan the textarea for the line holding `power`'s order for the unit in
// `unitProv`. Returns {lines, foundIdx, headerIdx, lastOfSection}.
function locateOrderLine(power, unitProv) {
  const lines = $('orders-text').value.split('\n');
  let current = null;
  let headerIdx = -1, lastOfSection = -1, foundIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].split('#')[0].trim();
    if (!stripped) continue;
    if (stripped.split(/\s+/).length === 1) {
      const p = normalizePower(stripped.replace(/:$/, ''));
      if (p) {
        current = p;
        if (p === power) {
          headerIdx = i;
          lastOfSection = i;
        }
        continue;
      }
    }
    const res = parseOrderLine(lines[i], phaseKind(), current);
    if (res && res.order) {
      if (res.order.power === power) {
        lastOfSection = i;
        if (res.order.loc && prov(res.order.loc) === unitProv) foundIdx = i;
      }
    }
  }
  return { lines, foundIdx, headerIdx, lastOfSection };
}

// newText === null removes the unit's order line
function syncOrderLine(power, unitProv, newText) {
  const { lines, foundIdx, headerIdx, lastOfSection } = locateOrderLine(power, unitProv);
  if (foundIdx >= 0) {
    if (newText === null) lines.splice(foundIdx, 1);
    else lines[foundIdx] = newText;
  } else if (newText !== null) {
    if (headerIdx >= 0) lines.splice(lastOfSection + 1, 0, newText);
    else lines.push('', power.toUpperCase(), newText);
  }
  $('orders-text').value = lines.join('\n');
  onOrdersChanged();
}

function setOrder(u, spec) {
  syncOrderLine(u.power, prov(u.loc), orderTextFor(u, spec));
}

function selectOrderLine(unitProv) {
  const u = unitAt(unitProv);
  if (!u) return;
  const { lines, foundIdx } = locateOrderLine(u.power, unitProv);
  if (foundIdx < 0) return;
  const ta = $('orders-text');
  let start = 0;
  for (let i = 0; i < foundIdx; i++) start += lines[i].length + 1;
  ta.focus();
  ta.setSelectionRange(start, start + lines[foundIdx].length);
}

// ---------------------------------------------------------------------------
// board interaction
// ---------------------------------------------------------------------------
function attachBoardHandlers() {
  board.handlers = {
    canDrag(p) {
      if (playback || !game) return null;
      const base = prov(p);
      if (editMode || game.step === 'movement') {
        const u = unitAt(base);
        return u ? { color: POWER_COLORS[u.power] } : null;
      }
      if (game.step === 'retreat') {
        const d = dislodgedAt(base);
        return d ? { color: POWER_COLORS[d.unit.power] } : null;
      }
      return null;
    },
    onDrop(from, to, ev) {
      from = prov(from);
      const toProv = prov(to);
      if (editMode) return editDrop(from, toProv, ev);
      if (game.step === 'movement') return orderDrop(from, toProv, ev);
      if (game.step === 'retreat') return retreatDrop(from, toProv, ev);
    },
    onClick(p, ev) {
      if (playback || !game) return;
      const base = prov(p);
      if (editMode) return editClick(base, ev);
      if (game.step === 'retreat') {
        const d = dislodgedAt(base);
        if (d) syncOrderLine(d.unit.power, base, orderTextFor(d.unit, { kind: 'disband' }));
        return;
      }
      if (game.step === 'adjustment') return adjustmentClick(base, ev);
      if (unitAt(base)) selectOrderLine(base);
    },
    onHover(p) {
      if (!p || !game) {
        $('hover-info').textContent = '';
        return;
      }
      const base = prov(p);
      const u = unitAt(base);
      const owner = game.scOwners[base];
      $('hover-info').textContent =
        `${provName(p)}${PROVINCES[base].sc ? ' ⭐' : ''}` +
        (owner ? ` (${cap(owner)})` : '') +
        (u ? ` — ${u.type === 'A' ? 'Army' : 'Fleet'} ${cap(u.power)}` : '');
    },
  };
}

function orderDrop(from, to, ev) {
  const u = unitAt(from);
  if (!u) return;
  if (from === to) return setOrder(u, { kind: 'hold' });

  const targetUnit = unitAt(to);
  const targetOrder = lastParsed.byProv.get(to);

  if (ev.shiftKey) {
    // support: the target unit's move if it has one, else its hold; on an
    // empty province, support whichever unit is ordered to move there
    let tLoc = null, tDest = null;
    if (targetUnit) {
      tLoc = to;
      tDest = targetOrder && targetOrder.kind === 'move' ? prov(targetOrder.dest) : null;
    } else {
      const mover = lastParsed.orders.find(
        (o) => o.kind === 'move' && prov(o.dest) === to && prov(o.loc) !== from
      );
      if (mover) {
        tLoc = prov(mover.loc);
        tDest = to;
      }
    }
    if (!tLoc) return toast('Nothing there to support');
    const tu = unitAt(tLoc);
    return setOrder(u, {
      kind: 'support',
      targetType: tu.type,
      targetLoc: tLoc,
      targetDest: tDest,
    });
  }

  if (ev.ctrlKey || ev.metaKey) {
    if (u.type !== 'F' || PROVINCES[from].type !== 'water')
      return toast('Only a fleet in open sea can convoy');
    if (!targetUnit || targetUnit.type !== 'A' || !targetOrder || targetOrder.kind !== 'move')
      return toast('Ctrl-drop onto an army that already has a move order');
    return setOrder(u, { kind: 'convoy', targetLoc: to, dest: prov(targetOrder.dest) });
  }

  // plain move
  if (u.type === 'A') {
    if (!armyAdjacent(from, to) &&
        !(PROVINCES[from].type === 'coast' && PROVINCES[to].type === 'coast'))
      return toast(`An army cannot reach ${provName(to)}`);
    return setOrder(u, { kind: 'move', dest: to });
  }
  const opts = fleetDestLocs(u.loc, to);
  if (!opts.length) return toast(`${provName(to)} is not adjacent for this fleet`);
  if (opts.length === 1) return setOrder(u, { kind: 'move', dest: opts[0] });
  pickCoast(ev.clientX, ev.clientY, opts).then((dest) => {
    if (dest) setOrder(u, { kind: 'move', dest });
  });
}

function retreatDrop(from, to, ev) {
  const d = dislodgedAt(from);
  if (!d) return;
  const opts = d.retreatOptions.filter((l) => prov(l) === to);
  if (!opts.length) return toast(`Cannot retreat to ${provName(to)}`);
  const write = (dest) =>
    syncOrderLine(d.unit.power, from, orderTextFor(d.unit, { kind: 'retreat', dest }));
  if (opts.length === 1) return write(opts[0]);
  pickCoast(ev.clientX, ev.clientY, opts).then((dest) => dest && write(dest));
}

function adjustmentClick(p, ev) {
  const counts = S.adjustmentCounts(game);
  const u = unitAt(p);
  if (u && (counts[u.power] || 0) < 0) {
    // toggle removal
    const existing = lastParsed.orders.find((o) => o.kind === 'remove' && prov(o.loc) === p);
    syncOrderLine(u.power, p, existing ? null : `remove ${p}`);
    return;
  }
  const owner = game.scOwners[p];
  if (owner && (counts[owner] || 0) > 0 && !u && (S.HOME_CENTERS[owner] || []).includes(p)) {
    // cycle build: none -> A -> F -> none
    const existing = lastParsed.orders.find((o) => o.kind === 'build' && prov(o.loc) === p);
    const info = PROVINCES[p];
    if (!existing) return syncOrderLine(owner, p, `build A ${p}`);
    if (existing.unitType === 'A' && info.type === 'coast') {
      if (info.coasts.length) {
        return pickCoast(ev.clientX, ev.clientY, info.coasts.map((c) => `${p}/${c}`)).then(
          (loc) => loc && syncOrderLine(owner, p, `build F ${loc}`)
        );
      }
      return syncOrderLine(owner, p, `build F ${p}`);
    }
    return syncOrderLine(owner, p, null);
  }
  if (u && (counts[u.power] || 0) >= 0) toast(`${cap(u.power)} has no disbands to make`);
}

// ---------------------------------------------------------------------------
// board editor
// ---------------------------------------------------------------------------
function setEditMode(on) {
  editMode = on;
  $('btn-edit').classList.toggle('active', on);
  $('panel-edit').hidden = !on;
}

function editApply() {
  S.saveGame(game);
  board.setInfluence(game.scOwners);
  board.setUnits(game.units, game.step === 'retreat' && game.pending ? game.pending.dislodged : []);
  renderStandings();
  onOrdersChanged();
}

function editClick(p, ev) {
  const info = PROVINCES[p];
  if (!info) return;
  const power = $('edit-power').value;
  const at = game.units.findIndex((x) => prov(x.loc) === p);
  if (editTool === 'erase') {
    if (at >= 0) game.units.splice(at, 1);
  } else if (editTool === 'A') {
    if (info.type === 'water') return toast('Armies cannot be placed at sea');
    if (at >= 0) game.units.splice(at, 1);
    game.units.push({ power, type: 'A', loc: p });
  } else if (editTool === 'F') {
    if (info.type === 'land') return toast('Fleets cannot be placed inland');
    let loc = p;
    if (info.coasts.length) {
      const seq = info.coasts.map((c) => `${p}/${c}`);
      const existing = at >= 0 ? game.units[at] : null;
      if (existing && existing.type === 'F' && existing.power === power) {
        loc = seq[(seq.indexOf(existing.loc) + 1) % seq.length];
      } else loc = seq[0];
    }
    if (at >= 0) game.units.splice(at, 1);
    game.units.push({ power, type: 'F', loc });
  } else if (editTool === 'sc') {
    if (!info.sc) return toast(`${provName(p)} is not a supply center`);
    game.scOwners[p] = game.scOwners[p] === power ? null : power;
  }
  editApply();
}

function editDrop(from, to, ev) {
  const u = unitAt(from);
  if (!u || from === to) return;
  const info = PROVINCES[to];
  if (u.type === 'A' && info.type === 'water') return toast('Armies cannot go to sea');
  if (u.type === 'F' && info.type === 'land') return toast('Fleets cannot go inland');
  const place = (loc) => {
    const at = game.units.findIndex((x) => prov(x.loc) === to);
    if (at >= 0) game.units.splice(at, 1);
    u.loc = loc;
    editApply();
  };
  if (u.type === 'F' && info.coasts.length) {
    pickCoast(ev.clientX, ev.clientY, info.coasts.map((c) => `${to}/${c}`)).then(
      (loc) => loc && place(loc)
    );
  } else place(u.type === 'F' ? to : prov(to));
}

// ---------------------------------------------------------------------------
// resolve + playback
// ---------------------------------------------------------------------------
function resolveCurrent() {
  const { orders, errors } = onOrdersChanged();
  if (errors.length) return toast('Fix the order problems first');
  const text = $('orders-text').value;
  const entry = S.resolvePhase(game, orders, text);
  S.saveGame(game);
  startPlayback(entry, false);
}

function playbackOrders(entry) {
  const res = entry.results.filter((r) => !r.order.implicit);
  const byPower = new Map();
  for (const r of res) {
    if (!byPower.has(r.order.power)) byPower.set(r.order.power, []);
    byPower.get(r.order.power).push(r);
  }
  return [...byPower.values()].flat();
}

function startPlayback(entry, readonly) {
  playback = { entry, readonly, orders: playbackOrders(entry), step: 0, animating: false };
  $('panel-orders').hidden = true;
  $('panel-edit').hidden = true;
  $('panel-playback').hidden = false;
  $('playback-title').textContent = entry.label;
  $('pb-continue').hidden = readonly;
  $('pb-back-current').hidden = !readonly;
  const list = $('pb-order-list');
  list.replaceChildren();
  playback.orders.forEach((r, i) => {
    const li = document.createElement('li');
    li.textContent = `${cap(r.order.power)}: ${fmtOrder(r.order)}`;
    li.style.listStyle = 'none';
    li.style.borderLeft = `4px solid ${POWER_COLORS[r.order.power] || '#888'}`;
    li.style.paddingLeft = '6px';
    li.style.cursor = 'pointer';
    li.title = 'Jump to this order';
    li.onclick = () => {
      if (playback && !playback.animating) {
        playback.step = i + 1;
        renderPlayback();
      }
    };
    list.appendChild(li);
  });
  playback.step = playback.orders.length ? 0 : outcomeStep();
  renderPlayback();
}

const outcomeStep = () => playback.orders.length;
const finalStep = () => playback.orders.length + 1;

function renderPlayback() {
  const { entry, step, orders } = playback;
  const isAdjustment = entry.step === 'adjustment';
  board.clearOrders();
  board.setPhaseText(entry.label);

  if (step >= finalStep()) {
    board.setInfluence(entry.scOwnersAfter);
    board.setUnits(entry.unitsAfter, entry.dislodged && entry.step === 'movement'
      ? entry.dislodged.filter((d) => d.retreatOptions && d.retreatOptions.length)
      : []);
    $('pb-step-label').textContent = `Final positions → ${entry.phaseAfter}`;
  } else {
    board.setInfluence(entry.scOwnersBefore);
    board.setUnits(entry.unitsBefore, entry.step === 'retreat' ? entry.dislodged : []);
    for (let i = 0; i < Math.min(step, orders.length); i++) {
      board.drawOrder(orders[i].order, POWER_COLORS[orders[i].order.power] || '#888');
    }
    if (step >= outcomeStep()) {
      for (const r of entry.results) {
        if (r.order.implicit) continue;
        if (r.verdict === 'fails' || r.verdict === 'invalid') {
          board.markFailure(r.order, r.reason);
        }
      }
      if (entry.step === 'movement' && entry.dislodged) {
        board.setUnits(entry.unitsBefore.filter(
          (u) => !entry.dislodged.some((d) => prov(d.from) === prov(u.loc) && d.unit.power === u.power)
        ), entry.dislodged);
      }
      $('pb-step-label').textContent = 'Resolution! ✓ = success, ✕ = failed — ▶ to watch the moves';
    } else {
      const r = orders[step - 1];
      $('pb-step-label').textContent = step === 0
        ? 'Board before orders — step through with ▶'
        : `${cap(r.order.power)}: ${fmtOrder(r.order)}`;
    }
  }

  const items = $('pb-order-list').children;
  for (let i = 0; i < items.length; i++) {
    const r = orders[i];
    items[i].className = '';
    if (i < step) items[i].classList.add('shown');
    if (i === step - 1 && step <= outcomeStep()) items[i].classList.add('current');
    if (step >= outcomeStep()) {
      items[i].classList.add(
        r.verdict === 'succeeds' ? 'ok' : r.verdict === 'invalid' ? 'invalid' : 'fail'
      );
      items[i].title = r.reason || '';
    }
  }
  $('pb-prev').disabled = step === 0;
  $('pb-next').disabled = step >= finalStep();
}

function stepPlayback(delta, opts = {}) {
  if (!playback || playback.animating) return;
  const target = Math.max(0, Math.min(finalStep(), playback.step + delta));
  if (target === playback.step) return;
  const crossingToFinal = delta > 0 && playback.step <= outcomeStep() && target >= finalStep();
  if (crossingToFinal && !opts.noAnim) return animateToFinal();
  playback.step = target;
  renderPlayback();
}

// Show the outcome briefly, then let every unit glide to its destination
// (simultaneous movement — bounced units lunge and fall back).
function animateToFinal() {
  const pb = playback;
  pb.animating = true;
  pb.step = outcomeStep();
  renderPlayback();
  board.clearOrders(); // arrows disappear as the moves execute
  $('pb-step-label').textContent = 'Executing moves…';
  $('pb-next').disabled = true;
  board.animateFinal(pb.entry).then(() => {
    if (playback !== pb) return;
    pb.animating = false;
    pb.step = finalStep();
    renderPlayback();
  });
}

function endPlayback() {
  playback = null;
  refreshAll();
}

function copyResults() {
  const entry = playback ? playback.entry : null;
  if (!entry) return;
  const lines = [`${entry.label} — results`];
  for (const r of entry.results) {
    if (r.order.implicit && r.verdict === 'succeeds') continue;
    const mark = r.verdict === 'succeeds' ? '✓' : '✕';
    const why = r.verdict !== 'succeeds' && r.reason ? ` (${r.reason})` : '';
    lines.push(`${cap(r.order.power)}: ${fmtOrder(r.order)} ${mark}${why}`);
  }
  if (entry.step === 'movement' && entry.dislodged) {
    for (const d of entry.dislodged) {
      const opts = d.retreatOptions || [];
      lines.push(
        opts.length
          ? `Must retreat: ${cap(d.unit.power)} ${d.unit.type} ${fmtLoc(prov(d.from))} (options: ${opts.join(', ')})`
          : `Destroyed: ${cap(d.unit.power)} ${d.unit.type} ${fmtLoc(prov(d.from))}`
      );
    }
  }
  lines.push(`Next: ${entry.phaseAfter}`);
  navigator.clipboard.writeText(lines.join('\n')).then(
    () => toast('Results copied — paste into your group chat', 'info'),
    () => toast('Could not copy')
  );
}

// ---------------------------------------------------------------------------
// standings
// ---------------------------------------------------------------------------
function renderStandings() {
  const table = $('standings');
  table.replaceChildren();
  const sc = {}, un = {};
  for (const o of Object.values(game.scOwners)) if (o) sc[o] = (sc[o] || 0) + 1;
  for (const u of game.units) un[u.power] = (un[u.power] || 0) + 1;
  const head = document.createElement('tr');
  head.className = 'head';
  head.innerHTML = '<td></td><td class="num">SCs</td><td class="num">Units</td>';
  table.appendChild(head);
  const powers = POWERS.filter((p) => (sc[p] || 0) + (un[p] || 0) > 0)
    .sort((a, b) => (sc[b] || 0) - (sc[a] || 0));
  for (const p of powers) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td><span class="chip" style="background:${POWER_COLORS[p]}"></span>${cap(p)}</td>` +
      `<td class="num">${sc[p] || 0}</td><td class="num">${un[p] || 0}</td>`;
    table.appendChild(tr);
  }
}

// ---------------------------------------------------------------------------
// history / undo / branch
// ---------------------------------------------------------------------------
function renderHistorySelect() {
  const sel = $('history-select');
  sel.replaceChildren();
  if (!game.history.length) {
    const opt = document.createElement('option');
    opt.textContent = '(no resolved turns yet)';
    sel.appendChild(opt);
    sel.disabled = true;
    $('btn-replay').disabled = true;
    return;
  }
  sel.disabled = false;
  $('btn-replay').disabled = false;
  game.history.forEach((h, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = h.label;
    sel.appendChild(opt);
  });
  sel.selectedIndex = game.history.length - 1;
}

function replaySelected() {
  const entry = game.history[+$('history-select').value];
  if (entry) startPlayback(entry, true);
}

function undoPhase() {
  const entry = S.undoLastPhase(game);
  if (!entry) return toast('Nothing to undo');
  playback = null;
  S.saveGame(game);
  refreshAll();
  if (entry.ordersText) {
    $('orders-text').value = entry.ordersText;
    onOrdersChanged();
  }
  toast(`Undid ${entry.label} — orders restored below`, 'info');
}

function branchCurrent() {
  const name = prompt('Name for the practice branch:', uniqueName(`${game.name} practice`));
  if (!name) return;
  const g = {
    ...S.newGame(uniqueName(name)),
    season: game.season,
    year: game.year,
    step: game.step,
    units: structuredClone(game.units),
    scOwners: structuredClone(game.scOwners),
    pending: structuredClone(game.pending),
    sandbox: true,
  };
  g.name = uniqueName(name);
  g.history = [];
  openGame(g);
  toast('Practice branch created — experiment freely', 'info');
}

// ---------------------------------------------------------------------------
// import/export
// ---------------------------------------------------------------------------
function exportCurrent() {
  const blob = new Blob([S.exportGame(game)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${game.name.replace(/[^\w-]+/g, '_')}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importFile(file) {
  try {
    const g = S.importGame(await file.text());
    g.name = uniqueName(g.name || 'Imported game');
    openGame(g);
  } catch (e) {
    alert('Could not import: ' + e.message);
  }
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
async function init() {
  board = await new Board().load($('board'));
  attachBoardHandlers();

  for (const p of POWERS) {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = cap(p);
    $('edit-power').appendChild(opt);
  }

  $('btn-new').onclick = () => openGame(S.newGame(uniqueName($('new-name').value.trim() || 'Game')));
  $('btn-sandbox').onclick = () => openGame(S.sandboxGame(uniqueName(($('new-name').value.trim() || 'Sandbox'))));
  $('import-file').onchange = (e) => e.target.files[0] && importFile(e.target.files[0]);
  $('btn-home').onclick = () => {
    playback = null;
    renderHome();
    showScreen('home-screen');
  };
  $('btn-export').onclick = exportCurrent;
  $('btn-edit').onclick = () => {
    setEditMode(!editMode);
    if (editMode && playback) endPlayback();
  };

  $('orders-text').addEventListener('input', onOrdersChanged);
  $('btn-resolve').onclick = resolveCurrent;

  for (const b of $('edit-tools').querySelectorAll('.tool')) {
    b.onclick = () => {
      editTool = b.dataset.tool;
      for (const x of $('edit-tools').querySelectorAll('.tool')) x.classList.toggle('active', x === b);
    };
  }
  $('edit-apply').onclick = () => {
    game.season = $('edit-season').value;
    game.year = +$('edit-year').value || 1901;
    game.step = 'movement';
    game.pending = null;
    S.saveGame(game);
    refreshAll();
  };
  $('edit-1901').onclick = () => {
    if (!confirm('Reset the board to the 1901 starting position?')) return;
    const fresh = S.newGame('x');
    game.units = fresh.units;
    game.scOwners = fresh.scOwners;
    game.pending = null;
    S.saveGame(game);
    refreshAll();
  };
  $('edit-clear').onclick = () => {
    if (!confirm('Remove all units and set every supply center neutral?')) return;
    game.units = [];
    for (const k of Object.keys(game.scOwners)) game.scOwners[k] = null;
    game.pending = null;
    S.saveGame(game);
    refreshAll();
  };

  $('pb-next').onclick = () => stepPlayback(1);
  $('pb-prev').onclick = () => stepPlayback(-1);
  $('pb-start').onclick = () => stepPlayback(-999);
  $('pb-end').onclick = () => stepPlayback(999);
  $('pb-continue').onclick = endPlayback;
  $('pb-back-current').onclick = endPlayback;
  $('pb-copy').onclick = copyResults;
  document.addEventListener('keydown', (e) => {
    if (playback && !$('panel-playback').hidden && document.activeElement.tagName !== 'TEXTAREA') {
      if (e.key === 'ArrowRight') stepPlayback(1);
      if (e.key === 'ArrowLeft') stepPlayback(-1);
    }
  });

  $('btn-replay').onclick = replaySelected;
  $('btn-undo').onclick = undoPhase;
  $('btn-branch').onclick = branchCurrent;

  renderHome();
  showScreen('home-screen');
  autotest();
}

// Scripted flow for headless screenshot checks: index.html?autotest=<stage>
// stages: board | preview | mid | outcome | final
function autotest() {
  const stage = new URLSearchParams(location.search).get('autotest');
  if (!stage) return;
  localStorage.clear();
  openGame(S.newGame('Autotest'));
  const orders = [
    'ENGLAND', 'F lon - eng', 'A lvp - yor', 'F edi - nth', '',
    'FRANCE', 'A par - bur', 'A mar S A par - bur', 'F bre - mao', '',
    'GERMANY', 'A mun - bur', 'A ber - kie', 'F kie - den', '',
    'RUSSIA', 'A mos - ukr', 'F sev - bla', 'A war - gal', 'F stp/sc - bot', '',
    'TURKEY', 'F ank - bla', 'A con - bul', 'A smy - con', '',
    'AUSTRIA', 'A vie - gal', 'A bud - ser', 'F tri - alb', '',
    'ITALY', 'A ven - pie', 'A rom - ven', 'F nap - ion',
  ].join('\n');
  if (stage === 'board') return done();
  $('orders-text').value = orders;
  onOrdersChanged();
  if (stage === 'preview') return done();
  resolveCurrent();
  if (stage === 'mid') {
    stepPlayback(1); stepPlayback(1); stepPlayback(1); stepPlayback(1); stepPlayback(1);
  } else if (stage === 'outcome') {
    stepPlayback(999, { noAnim: true });
    stepPlayback(-1);
  } else if (stage === 'final') {
    stepPlayback(999, { noAnim: true });
  }
  done();
  function done() {
    document.body.dataset.autotestDone = '1';
  }
}

// top-level await: the page's load event (and headless screenshots) wait for
// the board to be ready
await init();
