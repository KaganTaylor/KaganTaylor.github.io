import { Board, POWER_COLORS } from './render.js';
import * as S from './state.js';
import { parseOrders, parseOrderLine, normalizePower } from './parser.js';
import {
  prov,
  armyAdjacent,
  fleetDestLocs,
  convoyPossible,
  adjudicateMovement,
  adjudicateRetreats,
  adjudicateAdjustments,
} from './adjudicator.js';
import { PROVINCES, POWERS } from './map-data.js';
import { getToken, setToken, publishGame, updatePublished, fetchPublished, extractGistId } from './publish.js';

const $ = (id) => document.getElementById(id);

let board;
let game = null;
let playback = null; // {entry, step, orders, readonly, animating}
let editMode = false;
let editTool = 'A';
let lastParsed = { orders: [], errors: [], byProv: new Map() };
let mobileSheet = null; // null | 'edit' | 'orders' | 'standings' — mobile bottom-sheet state

// Gist viewers drag/click units for ANY power to sketch out what opponents
// might do, but the orders textarea only ever shows the power they're
// playing as. Those other powers' order lines live here instead — a second
// text buffer in the same line format, just never rendered into the box.
let hiddenOrdersText = '';

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

// Of the candidate locations (e.g. spa/nc vs spa/sc), the one whose marker
// is closest to where the pointer was released — dropping a fleet on the
// upper half of Spain lands it on the north coast, no prompt needed.
function nearestLoc(ev, options) {
  if (options.length === 1) return options[0];
  const pt = board.clientToBoard(ev.clientX, ev.clientY);
  let best = options[0];
  let bestD = Infinity;
  for (const o of options) {
    const c = board.center(o);
    const d = Math.hypot(c.x - pt.x, c.y - pt.y);
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
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
    if (g.published) li.className = 'published';
    const load = document.createElement('button');
    load.className = 'load';
    const badge = g.published ? ` <span class="badge published">${g.isOwner ? 'Published' : 'Read only'}</span>` : '';
    load.innerHTML = `${name} <span class="meta">· ${S.phaseLabel(g)}</span>${badge}`;
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
// A published game can only be advanced by the browser that published it
// (holds the token that created its gist). Everyone else gets a live,
// branchable, but non-editable view of the position.
function isReadOnly() {
  return !!(game && game.published && !game.isOwner);
}

// Viewers of a published game pick the country they play; order entry
// (typing and dragging) then works for that power only, and "📋 Copy
// orders" hands them their order block to email to the game master.
// Empty string = spectating / no country chosen.
function myCountry() {
  return (isReadOnly() && game.myCountry) || '';
}

function openGame(g) {
  game = g;
  playback = null;
  S.saveGame(game);
  showScreen('game-screen');
  $('game-name').textContent = game.name;
  mobileSheet = null;
  setEditMode(!isReadOnly() && !!game.sandbox && game.units.length === 0);
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
  const ro = isReadOnly();
  $('readonly-badge').hidden = !ro;
  $('country-row').hidden = !ro;
  if (ro) renderCountrySelect();
  $('orders-text').readOnly = ro && !myCountry();
  $('btn-resolve').hidden = ro;
  $('btn-resolve-final').hidden = ro;
  $('btn-edit').hidden = ro || !game.sandbox;
  const editTab = document.querySelector('#mobile-tabbar .mtab[data-sheet="edit"]');
  if (editTab) editTab.hidden = ro || !game.sandbox;
  $('btn-undo').disabled = ro || !game.history.length;
  $('btn-redo').disabled = ro || !(game.redoStack && game.redoStack.length);
  $('btn-publish').hidden = ro || !!game.published;
  $('btn-update-published').hidden = !(game.published && game.isOwner);
  prefillOrders();
  renderHistorySelect();
  renderStandings();
  onOrdersChanged();
}

function renderCountrySelect() {
  const sel = $('country-select');
  sel.replaceChildren();
  sel.appendChild(new Option('👁 View all countries', ''));
  for (const p of POWERS) {
    if (game.units.some((u) => u.power === p) || Object.values(game.scOwners).includes(p)) {
      sel.appendChild(new Option(`Play as ${cap(p)}`, p));
    }
  }
  sel.value = game.myCountry || '';
}

function prefillOrders() {
  hiddenOrdersText = '';
  const ta = $('orders-text');
  const info = $('phase-info');
  const myC = myCountry();
  if (game.step === 'movement') {
    $('orders-title').textContent = 'Orders — ' + S.phaseLabel(game);
    info.textContent = myC
      ? `Write ${cap(myC)}'s orders (type or drag units), then 📋 copy them for your game master. Branch first to test ideas.`
      : 'Type orders or drag units on the map. Unordered units hold.';
    const lines = [];
    for (const p of POWERS) {
      if (myC && p !== myC) continue;
      if (game.units.some((u) => u.power === p)) lines.push(p.toUpperCase(), '');
    }
    ta.value = lines.join('\n');
  } else if (game.step === 'retreat') {
    $('orders-title').textContent = 'Retreats — ' + S.phaseLabel(game);
    info.textContent = 'Drag a dislodged unit to retreat it, or click it to disband. Unordered units disband.';
    const lines = [];
    for (const d of game.pending.dislodged) {
      if (myC && d.unit.power !== myC) continue;
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
      if (myC && p !== myC) continue;
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
  const own = parseOrders($('orders-text').value, phaseKind());
  const all = hiddenOrdersText
    ? parseOrders($('orders-text').value + '\n' + hiddenOrdersText, phaseKind())
    : own;
  lastParsed = { orders: all.orders, errors: own.errors, byProv: new Map(), illegal: new Map() };
  for (const o of lastParsed.orders) if (o.loc) lastParsed.byProv.set(prov(o.loc), o);
  const warnings = validateOrders(lastParsed.orders);
  const el = $('parse-status');
  const parts = [];
  if (own.errors.length) {
    parts.push(`<span class="err">` +
      own.errors.map((e) => '✕ ' + escapeHtml(e)).join('\n') + '</span>');
  }
  if (warnings.length) {
    parts.push(`<span class="warn">` +
      warnings.map((w) => '⚠ ' + escapeHtml(w)).join('\n') + '</span>');
  }
  if (!parts.length) {
    parts.push(`<span class="ok">${own.orders.length} order${own.orders.length === 1 ? '' : 's'} ✓ (everyone else holds)</span>`);
  }
  el.innerHTML = parts.join('\n');
  drawLive();
  return { orders: own.orders, errors: own.errors };
}

// Dry-run the current orders through the real engine so problems that will
// never work (wrong terrain, not adjacent, unreachable support, bad builds)
// show up while typing, with exactly the resolver's judgement.
function validateOrders(orders) {
  const warnings = [];
  const flag = (o, reason, suffix = '') => {
    warnings.push(`${cap(o.power)}: ${fmtOrder(o)} — ${reason}${suffix}`);
    if (o.loc) lastParsed.illegal.set(prov(o.loc), reason);
  };
  try {
    if (game.step === 'movement') {
      const out = adjudicateMovement(game.units, orders);
      for (const inv of out.invalid) flag(inv.order, inv.reason);
      for (const r of out.results) {
        const o = r.order;
        if (!o.implicit && o.illegal) flag(o, o.illegal, ' (will hold)');
      }
    } else if (game.step === 'retreat') {
      const out = adjudicateRetreats(game.pending.dislodged, game.units, orders);
      for (const r of out.results) {
        if (r.verdict === 'invalid') flag(r.order, r.reason);
        else if (r.reason === 'illegal retreat') flag(r.order, 'not a legal retreat', ' (will disband)');
        else if (r.reason && r.reason.startsWith('retreat clash')) flag(r.order, 'another unit retreats there too — both disband');
      }
    } else {
      const out = adjudicateAdjustments(game.scOwners, game.units, orders);
      for (const r of out.results) {
        if (!r.order.auto && r.verdict === 'fails') flag(r.order, r.reason);
      }
    }
  } catch (e) {
    warnings.push('could not validate: ' + e.message);
  }
  return warnings;
}

function drawLive(excludeProv = null) {
  if (playback || !game) return;
  board.clearOrders();
  for (const o of lastParsed.orders) {
    if (excludeProv && o.loc && prov(o.loc) === excludeProv) continue;
    const reason = o.loc && lastParsed.illegal.get(prov(o.loc));
    // a convoy that cannot exist is a void order (the unit holds) — no
    // arrow at all; the warning below the order box explains why
    if (reason === 'no convoy possible' && o.kind === 'move') continue;
    board.drawOrder(o, reason ? '#e05252' : POWER_COLORS[o.power] || '#888');
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
function locateOrderLine(power, unitProv, sourceText) {
  const lines = sourceText.split('\n');
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

// newText === null removes the unit's order line. Orders for a power other
// than the one the viewer is playing as go into the hidden buffer instead of
// the visible textarea — see hiddenOrdersText above.
function syncOrderLine(power, unitProv, newText) {
  const myC = myCountry();
  const foreign = myC && power !== myC;
  const source = foreign ? hiddenOrdersText : $('orders-text').value;
  const { lines, foundIdx, headerIdx, lastOfSection } = locateOrderLine(power, unitProv, source);
  if (foundIdx >= 0) {
    if (newText === null) lines.splice(foundIdx, 1);
    else lines[foundIdx] = newText;
  } else if (newText !== null) {
    if (headerIdx >= 0) lines.splice(lastOfSection + 1, 0, newText);
    else lines.push('', power.toUpperCase(), newText);
  }
  if (foreign) hiddenOrdersText = lines.join('\n');
  else $('orders-text').value = lines.join('\n');
  onOrdersChanged();
}

function setOrder(u, spec) {
  syncOrderLine(u.power, prov(u.loc), orderTextFor(u, spec));
}

function selectOrderLine(unitProv) {
  const u = unitAt(unitProv);
  if (!u) return;
  const myC = myCountry();
  if (myC && u.power !== myC) return; // foreign order lives in the hidden buffer — nothing to select
  const { lines, foundIdx } = locateOrderLine(u.power, unitProv, $('orders-text').value);
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
      const myC = myCountry();
      if (isReadOnly() && !myC) return null;
      const base = prov(p);
      if (editMode || game.step === 'movement') {
        const u = unitAt(base);
        if (!u) return null;
        return { color: POWER_COLORS[u.power] };
      }
      if (game.step === 'retreat') {
        const d = dislodgedAt(base);
        if (!d) return null;
        return { color: POWER_COLORS[d.unit.power] };
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
      if (playback || !game || (isReadOnly() && !myCountry())) return;
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
      if (!p || !game || !PROVINCES[prov(p)]) {
        $('hover-info').textContent = '';
        return;
      }
      const base = prov(p);
      const u = unitAt(base);
      const owner = game.scOwners[base];
      $('hover-info').textContent =
        `${provName(p)}${PROVINCES[base].sc ? ' ⭐' : ''}` +
        (p.includes('/') ? ` — write "${p}"` : '') +
        (owner ? ` (${cap(owner)})` : '') +
        (u ? ` — ${u.type === 'A' ? 'Army' : 'Fleet'} ${cap(u.power)}` : '');
    },
    onDragStart(p) {
      drawLive(prov(p)); // hide this unit's old arrow while dragging
    },
    onDragEnd() {
      drawLive();
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
    if (!armyAdjacent(from, to)) {
      if (!(PROVINCES[from].type === 'coast' && PROVINCES[to].type === 'coast'))
        return toast(`An army cannot reach ${provName(to)}`);
      // only reachable by convoy: reject outright if no chain of fleets
      // could ever carry it there (same as an unreachable plain move)
      if (!convoyPossible(game.units, from, to))
        return toast(`No convoy to ${provName(to)} is possible — no fleet route`);
    }
    return setOrder(u, { kind: 'move', dest: to });
  }
  const opts = fleetDestLocs(u.loc, to);
  if (!opts.length) return toast(`${provName(to)} is not adjacent for this fleet`);
  setOrder(u, { kind: 'move', dest: nearestLoc(ev, opts) });
}

function retreatDrop(from, to, ev) {
  const d = dislodgedAt(from);
  if (!d) return;
  const opts = d.retreatOptions.filter((l) => prov(l) === to);
  if (!opts.length) return toast(`Cannot retreat to ${provName(to)}`);
  syncOrderLine(d.unit.power, from, orderTextFor(d.unit, { kind: 'retreat', dest: nearestLoc(ev, opts) }));
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
  mobileSheet = on ? 'edit' : (mobileSheet === 'edit' ? null : mobileSheet);
  applyMobileSheetUI();
}

function toggleEditMode() {
  setEditMode(!editMode);
  if (editMode && playback) endPlayback();
}

// ---------------------------------------------------------------------------
// mobile bottom sheet (Edit / Orders+History / Standings tabs)
// ---------------------------------------------------------------------------
function applyMobileSheetUI() {
  const sidebar = $('sidebar');
  sidebar.dataset.sheet = mobileSheet || '';
  sidebar.classList.toggle('sheet-open', !!mobileSheet);
  for (const b of document.querySelectorAll('#mobile-tabbar .mtab')) {
    b.classList.toggle('active', b.dataset.sheet === mobileSheet);
  }
  updateSheetInset();
}

// Reserve the open sheet's height at the bottom of the board pane so the map
// shrinks to the space above it instead of hiding behind it — on mobile the
// board must stay usable while a sheet is open (that's the whole point of the
// Edit sheet). The stylesheet reads this as --sheet-h, and ignores it on
// desktop, where the sidebar sits beside the board.
function updateSheetInset() {
  const h = mobileSheet ? $('sidebar').offsetHeight : 0;
  $('main').style.setProperty('--sheet-h', h + 'px');
}

function selectMobileSheet(kind) {
  if (editMode) toggleEditMode(); // reveals orders/standings by leaving edit mode
  mobileSheet = mobileSheet === kind ? null : kind;
  applyMobileSheetUI();
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
    place(nearestLoc(ev, info.coasts.map((c) => `${to}/${c}`)));
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

// Resolves the phase but skips the order-by-order reveal entirely: shows the
// pre-move position, plays the movement animation straight through, and
// lands on the next phase's order screen. Lets sandbox users blitz through
// several turns without clicking through each one's step-through.
async function resolveAndSkip() {
  const { orders, errors } = onOrdersChanged();
  if (errors.length) return toast('Fix the order problems first');
  const text = $('orders-text').value;
  const entry = S.resolvePhase(game, orders, text);
  S.saveGame(game);
  playback = null;
  $('panel-orders').hidden = true;
  $('panel-edit').hidden = true;
  board.clearOrders();
  board.setPhaseText(entry.label);
  board.setInfluence(entry.scOwnersBefore);
  board.setUnits(entry.unitsBefore, entry.step === 'retreat' ? entry.dislodged : []);
  await board.animateFinal(entry);
  refreshAll();
}

function redoPhase() {
  const entry = S.redoPhase(game);
  if (!entry) return toast('Nothing to redo');
  playback = null;
  S.saveGame(game);
  refreshAll();
  toast(`Redid ${entry.label}`, 'info');
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

// Re-adjudicates using only the orders revealed so far in the step-through
// (every other unit implicitly holds), so arrows already on the board can
// be recolored live as later orders come in — e.g. two moves into the same
// province both show red (bounce) until a support is revealed that lets one
// of them through, at which point it turns back to its faction color.
function partialVerdicts(entry, revealedOrders) {
  const map = new Map();
  let out;
  if (entry.step === 'movement') {
    out = adjudicateMovement(entry.unitsBefore, revealedOrders);
  } else if (entry.step === 'retreat') {
    out = adjudicateRetreats(entry.dislodged, entry.unitsBefore, revealedOrders);
  } else {
    out = adjudicateAdjustments(entry.scOwnersBefore, entry.unitsBefore, revealedOrders);
  }
  for (const r of out.results) {
    if (r.order.implicit) continue;
    map.set(prov(r.order.loc), r.verdict);
  }
  for (const inv of out.invalid || []) map.set(prov(inv.order.loc), inv.verdict);
  return map;
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
    const revealedCount = Math.min(step, orders.length);
    const revealedOrders = orders.slice(0, revealedCount).map((r) => r.order);
    const verdictByProv = revealedCount ? partialVerdicts(entry, revealedOrders) : new Map();
    for (let i = 0; i < revealedCount; i++) {
      const o = orders[i].order;
      const v = verdictByProv.get(prov(o.loc));
      const failed = v === 'fails' || v === 'invalid';
      board.drawOrder(o, failed ? '#e05252' : POWER_COLORS[o.power] || '#888');
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
// publishing (read-only shareable links, backed by a GitHub gist)
// ---------------------------------------------------------------------------
const TOKEN_HELP =
  'Publishing stores the game in a public GitHub gist, which needs a personal access token:\n\n' +
  '1. Open  github.com/settings/tokens/new  (this is a "classic" token — the newer fine-grained tokens cannot access gists)\n' +
  '2. Give it a name, tick ONLY the "gist" scope, and click Generate token\n' +
  '3. Paste the token (starts with ghp_) below\n\n' +
  'It is stored only in this browser and used to publish/update your games.\n' +
  'Clear the box and press OK to forget the current token.';

// Prompts for the token, pre-filled with whatever is stored so a stale one
// can be corrected. Returns the token in use, or '' if it was cleared/cancelled.
function askToken() {
  const answer = prompt(TOKEN_HELP, getToken());
  if (answer === null) return getToken();
  const token = answer.trim();
  setToken(token); // setToken('') removes it
  return token;
}

function doEditToken() {
  const had = !!getToken();
  const token = askToken();
  if (token) toast('GitHub token saved', 'info');
  else if (had) toast('GitHub token cleared', 'info');
}

async function doPublish() {
  if (!getToken() && !askToken()) return;
  try {
    const { id, url } = await publishGame(game);
    game.gistId = id;
    game.gistUrl = url;
    game.published = true;
    game.isOwner = true;
    S.saveGame(game);
    refreshAll();
    const shareLink = `${location.origin}${location.pathname}?gist=${id}`;
    prompt(
      'Published! Send this link to every player. They can watch the game, ' +
      'pick their country to write orders and copy them into an email to you, ' +
      'and branch the position to test ideas. After you resolve a turn, use ' +
      '"☁ Update published" so everyone sees the latest moves at the same link.',
      shareLink
    );
  } catch (e) {
    toast('Publish failed: ' + e.message);
    if (isAuthError(e)) askToken(); // stale/incorrect token — let them fix it now
  }
}

async function doUpdatePublished() {
  try {
    await updatePublished(game);
    toast('Published game updated', 'info');
  } catch (e) {
    toast('Update failed: ' + e.message);
    if (isAuthError(e)) askToken();
  }
}

// GitHub answers a bad or under-scoped token with 401/403
function isAuthError(e) {
  return /\b(401|403)\b/.test(e.message);
}

async function loadPublishedGame(idOrUrl) {
  const id = extractGistId(idOrUrl);
  if (!id) return toast('Could not parse gist link/ID');
  const games = S.listGames();
  const local = Object.values(games).find((g) => g.gistId === id);
  if (local && local.isOwner) return openGame(local);
  try {
    const fetched = await fetchPublished(id);
    const g = S.importGame(JSON.stringify(fetched));
    g.gistId = id;
    g.published = true;
    g.isOwner = false;
    g.name = local ? local.name : uniqueName(g.name || 'Published game');
    g.myCountry = local ? local.myCountry : null; // keep the viewer's chosen country
    openGame(g);
    toast('Loaded published game — pick your country to write orders, or Branch to plan ahead', 'info');
  } catch (e) {
    if (local) {
      openGame(local);
      toast('Offline — showing the last loaded copy', 'info');
    } else {
      toast('Could not load: ' + e.message);
    }
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
  $('btn-edit').onclick = toggleEditMode;

  for (const b of document.querySelectorAll('#mobile-tabbar .mtab')) {
    b.onclick = () => {
      if (b.dataset.sheet === 'edit') toggleEditMode();
      else selectMobileSheet(b.dataset.sheet);
    };
  }
  // the sheet grows and shrinks with its contents (playback list, warnings…),
  // and the board pane's inset has to follow it
  new ResizeObserver(updateSheetInset).observe($('sidebar'));
  addEventListener('resize', updateSheetInset);
  $('topbar-more-btn').onclick = (e) => {
    e.stopPropagation();
    $('topbar-more-menu').classList.toggle('open');
  };
  // picking an action closes the menu (on desktop the menu is always open —
  // its buttons sit inline in the topbar — and the class is simply unused)
  for (const b of $('topbar-more-menu').querySelectorAll('button')) {
    b.addEventListener('click', () => $('topbar-more-menu').classList.remove('open'));
  }
  document.addEventListener('pointerdown', (e) => {
    const menu = $('topbar-more-menu');
    if (menu.classList.contains('open') && !menu.contains(e.target) && e.target !== $('topbar-more-btn')) {
      menu.classList.remove('open');
    }
  });

  $('orders-text').addEventListener('input', onOrdersChanged);
  $('btn-resolve').onclick = resolveCurrent;
  $('btn-resolve-final').onclick = resolveAndSkip;
  $('btn-token').onclick = doEditToken;
  $('btn-publish').onclick = doPublish;
  $('btn-update-published').onclick = doUpdatePublished;
  $('btn-load-gist').onclick = () => loadPublishedGame($('load-gist-input').value);
  $('country-select').onchange = () => {
    game.myCountry = $('country-select').value || null;
    S.saveGame(game);
    refreshAll();
  };
  $('btn-copy-orders').onclick = () => {
    const text = $('orders-text').value.trim();
    if (!text) return toast('No orders to copy yet');
    navigator.clipboard.writeText(text).then(
      () => toast('Orders copied — paste them into your email to the game master', 'info'),
      () => toast('Could not copy')
    );
  };

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
  $('btn-redo').onclick = redoPhase;
  $('btn-branch').onclick = branchCurrent;

  renderHome();
  showScreen('home-screen');
  const gistParam = new URLSearchParams(location.search).get('gist');
  if (gistParam) await loadPublishedGame(gistParam);
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
