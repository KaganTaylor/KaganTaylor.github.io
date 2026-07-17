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
import {
  getToken, setToken, publishGame, updatePublished, fetchPublished,
  getAuthenticatedLogin, extractGistId,
  listComments, findSubmission, submitOrders, updateCommentBody, deleteComment,
  fetchGist, readMovesFiles, readGameFile, writeMovesFiles, upsertMovesEntry,
} from './publish.js';

const $ = (id) => document.getElementById(id);

// coast-suffix labels for the hover tooltip on split-coast provinces
// (Spain, St Petersburg, Bulgaria)
const COAST_NAMES = { nc: 'North coast', sc: 'South coast', ec: 'East coast' };

let board;
let game = null;
let playback = null; // {entry, step, orders, readonly, animating}
let publishedPreview = null; // board fields of the live published game, while 👁 viewing it
let editMode = false;
let editTool = 'A';
let lastParsed = { orders: [], errors: [], byProv: new Map() };
let mobileSheet = null; // null | 'edit' | 'orders' | 'standings' — mobile bottom-sheet state
let orderMode = null; // null | 'support' | 'convoy' — see setOrderMode()

// Gist viewers drag/click units for ANY power to sketch out what opponents
// might do, but the orders textarea only ever shows the power they're
// playing as. Those other powers' order lines live here instead — a second
// text buffer in the same line format, just never rendered into the box.
let hiddenOrdersText = '';

// Live view of a published game's online-play state: everyone's submission
// comments, the published moves-<power>.json files, and this browser's
// GitHub login. Refetched on load and after every submit/publish action.
let online = { comments: null, moves: null, login: null, restored: false };

// GM-only "view as player" debug mode (⚙ Settings → 🕵 View as). debugPower is
// the power currently being impersonated, or null. debugCapturedComment holds
// the GM's own gist comment exactly as it was before debugging started —
// {commentId, body}, or null if they had none — so exitDebugView() can put it
// back (or delete a comment a debug submit created) without ever touching a
// real player's own comment (submissions are matched by GitHub login, and the
// GM's login is never a real player's login unless the GM is that player too).
let debugPower = null;
let debugCapturedComment = null;

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
    const badge = g.published
      ? ` <span class="badge published">${g.isOwner ? 'Published' : 'Read only'}</span>`
      : g.sandbox ? ' <span class="badge sandbox">Sandbox</span>' : '';
    load.innerHTML = `${name} <span class="meta">· ${S.phaseLabel(g)}</span>${badge}`;
    // someone else's published game may have moved on since we last saw it —
    // reload it through the gist (falls back to the local copy when offline)
    load.onclick = () => (g.published && !g.isOwner && g.gistId ? loadPublishedGame(g.gistId) : openGame(g));
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
// branchable, but non-editable view of the position. A GM in 🕵 debug "view
// as player" mode is deliberately treated as read-only too, for the same
// reason: it's supposed to be a faithful simulation of what that player sees.
function isReadOnly() {
  return !!debugPower || !!(game && game.published && !game.isOwner);
}

// True only for the real game master, and only outside debug view — the gate
// on every GM-only control (Publish changes, Deadline panel, Submissions,
// Set players, Auto-Publish). Kept separate from the raw game.isOwner fact
// (still used as-is for identity/permission purposes, e.g. loadPublishedGame)
// so debug view can hide the GM's own admin controls without touching who
// actually owns the game.
function isOwnerView() {
  return !!(game && game.isOwner && !debugPower);
}

// True once the game master's local position (resolves, undos, redos, board
// edits) has moved on from what's actually live at the shared link — the
// gate on the "☁ Publish changes" button. Drafting in the order box never
// counts: that text isn't part of the game object until Resolve runs, so a
// GM can sketch out their own plan without it looking like a change to
// publish. See state.js boardSnapshot().
function boardDirty() {
  if (!game || !game.published || !isOwnerView()) return false;
  if (!game.publishedState) return true;
  return JSON.stringify(S.boardSnapshot(game)) !== JSON.stringify(game.publishedState);
}

// Viewers of a published game pick the country they play; order entry
// (typing and dragging) then works for that power only, and "📋 Copy
// orders" hands them their order block to email to the game master. A GM
// debugging as a power is locked to it the same way a real player would be.
// Empty string = spectating / no country chosen.
function myCountry() {
  return debugPower || (isReadOnly() && game.myCountry) || '';
}

// The power the GM assigned to this browser's GitHub account (game.players
// maps power → login). An assigned player is locked to that power for the
// whole game — on every device, since the token resolves to the same login.
function assignedPower() {
  return debugPower || (isReadOnly() && game.assignedPower) || '';
}

// Does a submission/published entry belong to the phase on the table now?
function matchesPhase(s) {
  return s && s.year === game.year && s.season === game.season && s.step === game.step;
}

function openGame(g) {
  // best-effort cleanup if a debug session on the PREVIOUS game was left
  // open — normally exitDebugView() already did this before navigating away
  if (debugPower && game && game.gistId) {
    cleanupDebugSubmission(game.gistId, debugCapturedComment).catch(() => {});
  }
  game = g;
  playback = null;
  publishedPreview = null;
  debugPower = null;
  debugCapturedComment = null;
  online = { comments: null, moves: null, login: null, restored: false };
  S.saveGame(game);
  showScreen('game-screen');
  $('game-name').textContent = game.name;
  mobileSheet = null;
  setEditMode(!isReadOnly() && !!game.sandbox && game.units.length === 0);
  refreshAll();
  if (game.published && game.gistId) refreshOnlineStatus();
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
  $('orders-text').readOnly = false;
  // auto-publish games open up local resolution once the deadline reveals
  // everyone's moves — a preview only; the GM's published update stays
  // authoritative and reloads over it
  const localResolve = ro && publishMode() === 'auto' && deadlinePassed();
  $('btn-resolve').hidden = ro && !localResolve;
  $('btn-resolve-final').hidden = ro && !localResolve;
  $('btn-edit').hidden = ro || !game.sandbox;
  const editTab = document.querySelector('#mobile-tabbar .mtab[data-sheet="edit"]');
  if (editTab) editTab.hidden = ro || !game.sandbox;
  $('btn-undo').disabled = (ro && !localResolve) || !game.history.length;
  $('btn-redo').disabled = ro || !(game.redoStack && game.redoStack.length);
  $('btn-publish').hidden = ro || !!game.published;
  $('btn-update-published').hidden = !(game.published && isOwnerView());
  $('btn-update-published').disabled = !boardDirty();
  $('btn-view-published').hidden = !(game.published && isOwnerView());
  $('panel-deadline').hidden = !(game.published && isOwnerView());
  if (game.published && isOwnerView()) {
    const input = $('deadline-input');
    if (document.activeElement !== input) input.value = game.deadline ? isoToLocalInput(game.deadline) : '';
  }
  $('btn-set-players').hidden = !(game.published && isOwnerView());
  $('btn-submissions').hidden = !(game.published && isOwnerView());
  $('autopublish-row').hidden = !(game.published && isOwnerView());
  renderViewAsControls();
  renderOnlineUI();
  setOrderMode(null);
  prefillOrders();
  renderHistorySelect();
  renderStandings();
  onOrdersChanged();
}

function renderCountrySelect() {
  const sel = $('country-select');
  sel.replaceChildren();
  const assigned = assignedPower();
  if (assigned) {
    // assigned players are tied to their power for the whole game — the only
    // other view is "all countries", for reading everyone's published moves
    sel.appendChild(new Option(`Playing as ${cap(assigned)}`, assigned));
    sel.appendChild(new Option('👁 View all countries', ''));
    sel.value = game.myCountry === assigned ? assigned : '';
    return;
  }
  sel.appendChild(new Option('👁 View all countries', ''));
  for (const p of POWERS) {
    if (game.units.some((u) => u.power === p) || Object.values(game.scOwners).includes(p)) {
      sel.appendChild(new Option(`Play as ${cap(p)}`, p));
    }
  }
  sel.value = game.myCountry || '';
}

// Split a multi-power orders text into per-power blocks (header line plus
// the lines under it), same header-tracking rule locateOrderLine uses.
function splitOrdersByPower(text) {
  const byPower = new Map();
  let current = null;
  for (const line of text.split('\n')) {
    const stripped = line.split('#')[0].trim();
    if (stripped && stripped.split(/\s+/).length === 1) {
      const p = normalizePower(stripped.replace(/:$/, ''));
      if (p) {
        current = p;
        if (!byPower.has(p)) byPower.set(p, []);
        byPower.get(p).push(line);
        continue;
      }
    }
    if (current) byPower.get(current).push(line);
  }
  return byPower;
}

// Every power's default (empty) order block for the current phase — used
// both for a fresh phase and to fill in powers a preserved buffer has no
// block for yet (a country nobody has drawn orders for yet).
function defaultOrdersText() {
  const lines = [];
  if (game.step === 'movement') {
    for (const p of POWERS) {
      if (game.units.some((u) => u.power === p)) lines.push(p.toUpperCase(), '');
    }
  } else if (game.step === 'retreat') {
    for (const d of game.pending.dislodged) {
      lines.push(d.unit.power.toUpperCase());
      lines.push(`${d.unit.type} ${prov(d.from)} disband   # options: ${d.retreatOptions.join(', ') || 'none'}`);
      lines.push('');
    }
  } else {
    const counts = S.adjustmentCounts(game);
    for (const [p, c] of Object.entries(counts)) {
      if (c > 0) lines.push(p.toUpperCase(), `# ${c} build${c > 1 ? 's' : ''}`, '');
      else if (c < 0) lines.push(p.toUpperCase(), `# disband ${-c}`, '');
    }
  }
  return lines.join('\n');
}

// Rebuild the visible textarea + hidden buffer for the current myCountry()
// filter. With preserve=true, orders already drawn for every power (visible
// textarea + hidden buffer, i.e. a full switch-country round trip) are kept;
// only powers with no orders at all get the blank per-phase template. With
// preserve=false (a real phase change / game load) everything resets.
function prefillOrders(preserve = false) {
  const ta = $('orders-text');
  const info = $('phase-info');
  const myC = myCountry();
  if (game.step === 'movement') {
    $('orders-title').textContent = 'Orders — ' + S.phaseLabel(game);
    info.textContent = myC
      ? `Write ${cap(myC)}'s orders (type or drag units), then 📋 copy them for your game master. Branch first to test ideas.`
      : 'Type orders or drag units on the map. Unordered units hold.';
  } else if (game.step === 'retreat') {
    $('orders-title').textContent = 'Retreats — ' + S.phaseLabel(game);
    info.textContent = 'Drag a dislodged unit to retreat it, or click it to disband. Unordered units disband.';
  } else {
    $('orders-title').textContent = 'Builds — ' + S.phaseLabel(game);
    const counts = S.adjustmentCounts(game);
    const occupied = new Set(game.units.map((u) => prov(u.loc)));
    const infoLines = [];
    for (const [p, c] of Object.entries(counts)) {
      if (c > 0) {
        const free = (S.HOME_CENTERS[p] || []).filter(
          (h) => game.scOwners[h] === p && !occupied.has(h)
        );
        infoLines.push(`${cap(p)}: ${c} build${c > 1 ? 's' : ''} — click a free home center (${free.join(', ') || 'none free'})`);
      } else if (c < 0) {
        infoLines.push(`${cap(p)}: must disband ${-c} — click units to remove`);
      }
    }
    info.textContent = infoLines.join('\n') || 'No builds or disbands required.';
  }

  const defaultByPower = splitOrdersByPower(defaultOrdersText());
  let sourceByPower;
  if (preserve) {
    const existing = ta.value + (hiddenOrdersText ? '\n' + hiddenOrdersText : '');
    sourceByPower = splitOrdersByPower(existing);
  } else {
    sourceByPower = new Map();
  }
  const merged = [];
  for (const p of POWERS) {
    if (sourceByPower.has(p)) merged.push(sourceByPower.get(p).join('\n'));
    else if (defaultByPower.has(p)) merged.push(defaultByPower.get(p).join('\n'));
  }
  const byPower = splitOrdersByPower(merged.join('\n'));

  const visible = [];
  const hidden = [];
  for (const p of POWERS) {
    if (!byPower.has(p)) continue;
    const block = byPower.get(p).join('\n');
    if (!myC || p === myC) visible.push(block);
    else hidden.push(block);
  }
  ta.value = visible.join('\n');
  hiddenOrdersText = hidden.join('\n');
}

// Everything currently drafted, across the visible textarea and the hidden
// buffer — one multi-power text in the standard order format.
function fullOrdersText() {
  return $('orders-text').value + (hiddenOrdersText ? '\n' + hiddenOrdersText : '');
}

// One power's order lines (header dropped), or '' if it has no block.
function powerBlockText(power) {
  const block = splitOrdersByPower(fullOrdersText()).get(power);
  return block ? block.slice(1).join('\n').trim() : '';
}

// Replaces the whole order text (visible + hidden) with `fullText`, split
// into the textarea / hidden buffer for the current myCountry() filter.
function applyOrdersText(fullText) {
  const byPower = splitOrdersByPower(fullText);
  const myC = myCountry();
  const visible = [];
  const hidden = [];
  for (const p of POWERS) {
    if (!byPower.has(p)) continue;
    const block = byPower.get(p).join('\n');
    if (!myC || p === myC) visible.push(block);
    else hidden.push(block);
  }
  $('orders-text').value = visible.join('\n');
  hiddenOrdersText = hidden.join('\n');
  onOrdersChanged();
}

// Swaps in a new block for one power, leaving every other power's draft as it
// is (used to restore a player's submitted orders from the gist).
function replacePowerBlock(power, ordersText) {
  const byPower = splitOrdersByPower(fullOrdersText());
  byPower.set(power, [power.toUpperCase(), ...ordersText.split('\n'), '']);
  const blocks = [];
  for (const p of POWERS) if (byPower.has(p)) blocks.push(byPower.get(p).join('\n'));
  applyOrdersText(blocks.join('\n'));
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
  if (game && game.step === 'adjustment' && !playback) updateAdjustmentInfo();
  drawLive();
  return { orders: own.orders, errors: own.errors };
}

// Live build/disband tally for the winter phase — "France: 1/2 builds" — kept
// in step with the order box so it updates as orders are clicked or typed.
function updateAdjustmentInfo() {
  const counts = S.adjustmentCounts(game);
  const occupied = new Set(game.units.map((u) => prov(u.loc)));
  const lines = [];
  for (const [p, c] of Object.entries(counts)) {
    const used = adjustmentUsed(p);
    if (c > 0) {
      const free = (S.HOME_CENTERS[p] || []).filter(
        (h) => game.scOwners[h] === p && !occupied.has(h)
      );
      lines.push(`${cap(p)}: ${used.builds}/${c} build${c > 1 ? 's' : ''} — click a free home center (${free.join(', ') || 'none free'})`);
    } else if (c < 0) {
      lines.push(`${cap(p)}: ${used.removes}/${-c} disband${-c > 1 ? 's' : ''} — click units to remove`);
    }
  }
  $('phase-info').textContent = lines.join('\n') || 'No builds or disbands required.';
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
    if (!o.loc) continue; // a waive has no location — nothing to draw
    if (excludeProv && prov(o.loc) === excludeProv) continue;
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
      if (playback || publishedPreview || !game) return null;
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
      if (playback || publishedPreview || !game) return;
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
      const coastSuffix = p.includes('/') ? p.split('/')[1] : null;
      const tail = u ? ` - ${u.type === 'A' ? 'Army' : 'Fleet'} ${cap(u.power)}` : (owner ? ` - ${cap(owner)}` : '');
      $('hover-info').textContent =
        provName(p) +
        (coastSuffix ? ` (${COAST_NAMES[coastSuffix] || coastSuffix})` : '') +
        (coastSuffix ? ` "${p}"` : '') +
        (PROVINCES[base].sc ? ' ⭐' : '') +
        tail;
    },
    onDragStart(p) {
      drawLive(prov(p)); // hide this unit's old arrow while dragging
    },
    onDragEnd() {
      drawLive();
    },
  };
}

// ---------------------------------------------------------------------------
// order modes (Support / Convoy)
// ---------------------------------------------------------------------------
// A tappable stand-in for ⇧-drop and Ctrl-drop: with a mode on, the next drag
// is read as a support (or convoy) order instead of a move. Touchscreens have
// no modifier keys, so on mobile this is the only way to write those orders.
// The mode is one-shot — it switches itself off once an order is written —
// because leaving it armed would silently turn the *next* intended move into
// another support. A failed drop (nothing to support there, wrong unit type)
// leaves it on so the drag can simply be retried.
function setOrderMode(mode) {
  orderMode = mode;
  updateOrderModeUI();
}

function toggleOrderMode(mode) {
  setOrderMode(orderMode === mode ? null : mode);
  if (orderMode === 'support') toast('Support: drag a unit onto the one it should support', 'info');
  if (orderMode === 'convoy') toast('Convoy: drag a fleet at sea onto a moving army', 'info');
}

// The toggles only make sense where a drag writes a movement order at all —
// the same condition canDrag() uses — so they are hidden during edit mode,
// playback, and the retreat/build phases.
function updateOrderModeUI() {
  const usable = !!game && !playback && !publishedPreview && !editMode && game.step === 'movement';
  if (!usable && orderMode) orderMode = null;
  $('order-modes').hidden = !usable;
  $('btn-mode-support').setAttribute('aria-pressed', String(orderMode === 'support'));
  $('btn-mode-convoy').setAttribute('aria-pressed', String(orderMode === 'convoy'));
}

function orderDrop(from, to, ev) {
  const u = unitAt(from);
  if (!u) return;
  const wantSupport = ev.shiftKey || orderMode === 'support';
  const wantConvoy = ev.ctrlKey || ev.metaKey || orderMode === 'convoy';
  if (from === to) {
    if (wantSupport) return toast('Drop onto the unit you want to support');
    if (wantConvoy) return toast('Drop onto the army you want to convoy');
    return setOrder(u, { kind: 'hold' });
  }

  const targetUnit = unitAt(to);
  const targetOrder = lastParsed.byProv.get(to);

  if (wantSupport) {
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
    setOrder(u, {
      kind: 'support',
      targetType: tu.type,
      targetLoc: tLoc,
      targetDest: tDest,
    });
    return setOrderMode(null);
  }

  if (wantConvoy) {
    if (u.type !== 'F' || PROVINCES[from].type !== 'water')
      return toast('Only a fleet in open sea can convoy');
    if (!targetUnit || targetUnit.type !== 'A' || !targetOrder || targetOrder.kind !== 'move')
      return toast('Drop onto an army that already has a move order');
    setOrder(u, { kind: 'convoy', targetLoc: to, dest: prov(targetOrder.dest) });
    return setOrderMode(null);
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

// How many of a power's builds (+ waives) and removals are already written in
// the order box — the click handlers refuse to go past the phase's allowance.
function adjustmentUsed(power) {
  let builds = 0;
  let removes = 0;
  for (const o of lastParsed.orders) {
    if (o.power !== power) continue;
    if (o.kind === 'build' || o.kind === 'waive') builds++;
    else if (o.kind === 'remove') removes++;
  }
  return { builds, removes };
}

function adjustmentClick(p, ev) {
  const counts = S.adjustmentCounts(game);
  const u = unitAt(p);
  if (u && (counts[u.power] || 0) < 0) {
    // toggle removal
    const existing = lastParsed.orders.find((o) => o.kind === 'remove' && prov(o.loc) === p);
    const owed = -counts[u.power];
    if (!existing && adjustmentUsed(u.power).removes >= owed) {
      return toast(`${cap(u.power)}: only ${owed} disband${owed > 1 ? 's' : ''} required — click an ordered unit to keep it instead`);
    }
    syncOrderLine(u.power, p, existing ? null : `remove ${p}`);
    return;
  }
  const owner = game.scOwners[p];
  if (owner && (counts[owner] || 0) > 0 && !u && (S.HOME_CENTERS[owner] || []).includes(p)) {
    // cycle build: none -> A -> F -> none
    const existing = lastParsed.orders.find((o) => o.kind === 'build' && prov(o.loc) === p);
    if (!existing && adjustmentUsed(owner).builds >= counts[owner]) {
      return toast(`${cap(owner)}: all ${counts[owner]} build${counts[owner] > 1 ? 's' : ''} used — remove one first`);
    }
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
  updateOrderModeUI();
}

function toggleEditMode() {
  if (publishedPreview) exitPublishedPreview();
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
  if (game.published && isOwnerView()) $('btn-update-published').disabled = !boardDirty();
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
  if (isReadOnly()) toast('Local preview — the game master’s published update stays the official position', 'info');
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
  mobileSheet = null;
  applyMobileSheetUI();
  board.clearOrders();
  board.setPhaseText(entry.label);
  board.setInfluence(entry.scOwnersBefore);
  board.setUnits(entry.unitsBefore, entry.step === 'retreat' ? entry.dislodged : []);
  await board.animateFinal(entry);
  refreshAll();
  if (isReadOnly()) toast('Local preview — the game master’s published update stays the official position', 'info');
}

function redoPhase() {
  if (publishedPreview) exitPublishedPreview();
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
  setOrderMode(null);
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
  const crossingFromFinal = delta < 0 && playback.step >= finalStep() && target <= outcomeStep();
  if (crossingFromFinal && !opts.noAnim) return animateFromFinal();
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

// Undoing the final confirmation step: play the same animation backwards
// instead of snapping units straight back to their pre-move positions.
// renderPlayback() for the outcome step already lays the board out exactly
// as animateToFinal() found it before playing forward (units at their
// pre-move locations, dislodged units in the dislodged layer) — reusing it
// here means the reverse tween starts from the same DOM state the forward
// one did, just interpolating the opposite way.
function animateFromFinal() {
  const pb = playback;
  pb.animating = true;
  pb.step = outcomeStep();
  renderPlayback();
  board.clearOrders();
  $('pb-step-label').textContent = 'Undoing moves…';
  $('pb-prev').disabled = true;
  $('pb-next').disabled = true;
  board.animateFinal(pb.entry, { reverse: true }).then(() => {
    if (playback !== pb) return;
    pb.animating = false;
    pb.step = outcomeStep();
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
  if (publishedPreview) exitPublishedPreview();
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
// online play (players submit moves as gist comments; at the deadline the
// game either reveals them to everyone directly — auto publish — or waits
// for the GM to review and publish per-power moves-<power>.json files)
// ---------------------------------------------------------------------------
function activePowers() {
  return POWERS.filter(
    (p) => game.units.some((u) => u.power === p) || Object.values(game.scOwners).includes(p)
  );
}

// How the deadline is handled — the GM picks this in ⚙ Settings.
// 'manual' (default): after the deadline only the GM sees submissions, until
// they review and 📣 Publish results (or re-open with a new deadline).
// 'auto': the moment the deadline passes, every viewer reveals all
// submissions straight from the comments — no publish step needed.
function publishMode() {
  return game && game.publishMode === 'auto' ? 'auto' : 'manual';
}

function deadlinePassed() {
  const d = deadlineDate();
  return !!d && d.getTime() <= Date.now();
}

// Orders can only be submitted while a deadline is set and hasn't passed yet
// — with no deadline at all there is nothing to be "on time" against.
function ordersOpen() {
  return !!game.deadline && !deadlinePassed();
}

// In auto mode a comment edited after the deadline is void — judged by
// GitHub's own updated_at stamp, never the client-claimed submittedAt.
function submissionOnTime(found) {
  const d = deadlineDate();
  return !d || !found.updatedAt || new Date(found.updatedAt) <= d;
}

// The power's valid submission comment for the current phase, or null.
function phaseSubmission(p) {
  const login = (game.players || {})[p];
  const found = login && online.comments && findSubmission(online.comments, login);
  if (found && matchesPhase(found.submission) && found.submission.power === p) return found;
  return null;
}

// What everyone may see for a power this phase: its published file entry, or
// — in auto mode once the deadline has passed — the on-time submission
// comment itself (the files are then just a durable record).
function revealedEntry(p) {
  const doc = online.moves && online.moves[p];
  const entry = doc && doc.history.find(matchesPhase);
  if (entry) return entry;
  if (publishMode() !== 'auto' || !deadlinePassed()) return null;
  const found = phaseSubmission(p);
  return found && submissionOnTime(found) ? found.submission : null;
}

// What the current phase knows about a power: 'published' (its moves file has
// an entry for this phase), 'revealed'/'late' (auto mode, deadline passed),
// 'submitted' (a valid comment is waiting), 'none', or 'unknown' (comments
// not fetched yet / offline).
function powerOnlineStatus(p) {
  const doc = online.moves && online.moves[p];
  if (doc && doc.history.some(matchesPhase)) return 'published';
  if (!online.comments) return 'unknown';
  const found = phaseSubmission(p);
  if (found) {
    if (publishMode() === 'auto' && deadlinePassed())
      return submissionOnTime(found) ? 'revealed' : 'late';
    return 'submitted';
  }
  return 'none';
}

const STATUS_BADGE = {
  published: ['✓ published', 'st-published'],
  revealed: ['✓ revealed', 'st-published'],
  late: ['⚠ late edit — void', 'st-none'],
  submitted: ['📨 submitted', 'st-submitted'],
  none: ['— waiting', 'st-none'],
  unknown: ['…', 'st-none'],
};

function renderOnlineUI() {
  if (!game) return;
  const hasPlayers = !!(game.published && game.players && Object.values(game.players).some(Boolean));
  if (document.activeElement !== $('autopublish-toggle')) {
    $('autopublish-toggle').checked = publishMode() === 'auto';
  }
  $('submit-row').hidden = !assignedPower();
  $('btn-submit-moves').disabled = !ordersOpen();
  $('online-row').hidden = !hasPlayers;
  if (isReadOnly() && !playback) {
    // keep the local-preview Resolve in step with the deadline ticking over
    const localResolve = publishMode() === 'auto' && deadlinePassed();
    $('btn-resolve').hidden = !localResolve;
    $('btn-resolve-final').hidden = !localResolve;
  }
  renderSubmitStatus();
  updateDeadlineCountdown();
  if (hasPlayers) renderDeadlineInfo();
  // only re-render the submissions modal's contents while it's actually open —
  // it's no longer part of the always-visible sidebar, so there's no need to
  // keep it in step on every poll otherwise
  if (game.published && isOwnerView() && !$('submissions-modal').hidden) renderSubmissionsModal();
}

function renderSubmitStatus() {
  const p = assignedPower();
  if (!p) return;
  const el = $('submit-status');
  const status = powerOnlineStatus(p);
  el.classList.toggle('done', status === 'published' || status === 'revealed' || status === 'submitted');
  if (status === 'published') {
    el.textContent = '✓ Published — your moves are locked in for this phase';
    return;
  }
  if (status === 'revealed') {
    el.textContent = '✓ Revealed — the deadline passed and everyone can see your moves';
    return;
  }
  if (status === 'late') {
    el.textContent = '⚠ Edited after the deadline — this submission is void';
    return;
  }
  if (deadlinePassed()) {
    el.textContent = 'Deadline passed — submissions are closed';
    return;
  }
  if (!game.deadline) {
    el.textContent = "No deadline set yet — ask your game master, then you can submit";
    return;
  }
  const found = online.comments && online.login && findSubmission(online.comments, online.login);
  const s = found && found.submission;
  if (s && matchesPhase(s) && s.power === p) {
    const when = s.submittedAt ? ' · ' + new Date(s.submittedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '';
    el.textContent = `✓ Submitted${when} — resubmit any time before the deadline`;
  } else {
    el.textContent = 'Not submitted for this phase yet';
    el.classList.remove('done');
  }
}

// ---- deadlines -------------------------------------------------------------
// The GM confirms every deadline (game.deadline, an ISO timestamp in
// game.json). When it passes, submissions close; what happens next depends
// on publishMode() — instant reveal, or GM review first.
function deadlineDate() {
  if (!game || !game.deadline) return null;
  const d = new Date(game.deadline);
  return isNaN(d) ? null : d;
}

function fmtCountdown(ms) {
  const mins = Math.max(0, Math.round(ms / 60000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// 'none' (no deadline set), 'warn' (counting down) or 'danger' (passed) — the
// single source of truth behind every red/yellow deadline indicator: the
// topbar countdown chip, this panel, and the sidebar #panel-deadline box.
function deadlineUrgency() {
  const d = deadlineDate();
  if (!d) return 'none';
  return d.getTime() - Date.now() > 0 ? 'warn' : 'danger';
}

function renderDeadlineInfo() {
  const el = $('deadline-info');
  const d = deadlineDate();
  const urgency = deadlineUrgency();
  el.classList.remove('past', 'warn');
  if (!d) {
    el.textContent = isOwnerView()
      ? '⏰ No deadline set — submissions stay closed until you confirm one below'
      : '⏰ No deadline set yet — ask your game master; submissions are closed until then';
    return;
  }
  const when = d.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  if (urgency === 'warn') {
    el.textContent = `⏰ Deadline: ${when} (in ${fmtCountdown(d - Date.now())})`;
    el.classList.add('warn');
  } else {
    el.textContent =
      publishMode() === 'auto'
        ? `⏰ Deadline passed (${when}) — all submissions are revealed. ⬇ Load them, then Resolve to preview the result`
        : isOwnerView()
          ? `⏰ Deadline passed (${when}) — 🔍 review the submissions, then 📣 publish results or re-open with a new deadline`
          : `⏰ Deadline passed (${when}) — the game master is reviewing the results`;
    el.classList.add('past');
  }
}

// Zero-padded DD:HH:MM:SS — always four segments, unlike the looser
// fmtCountdown() above, so the topbar chip has a fixed width and reads at a
// glance regardless of how much time is left.
function fmtCountdownDHMS(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const pad = (n) => String(n).padStart(2, '0');
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${pad(d)}:${pad(h)}:${pad(m)}:${pad(s)}`;
}

// Ticks the topbar countdown chip — visible to every viewer (GM and players
// alike) of a published game with players assigned, so it's always clear
// whether orders are open, closing soon, or closed. Cheap text/class update
// only; called from a 1s interval plus on-demand from refreshAll()/renderOnlineUI().
function updateDeadlineCountdown() {
  const chip = $('deadline-countdown');
  const panel = $('panel-deadline');
  const hasPlayers = !!(game && game.published && game.players && Object.values(game.players).some(Boolean));
  panel.classList.remove('deadline-warn', 'deadline-danger');
  if (!hasPlayers) {
    chip.hidden = true;
    return;
  }
  chip.hidden = false;
  chip.classList.remove('neutral', 'warn', 'danger');
  const urgency = deadlineUrgency();
  // Kept short (esp. the none/danger text) so it never wraps or overflows
  // the topbar on a narrow phone screen — the full explanation is one tap/
  // hover away in the title attribute.
  if (urgency === 'none') {
    chip.textContent = '⏳ Orders closed';
    chip.title = "Your game master hasn't confirmed a deadline yet — submissions open once they do";
    chip.classList.add('neutral');
  } else if (urgency === 'warn') {
    const d = deadlineDate();
    chip.textContent = `⏰ ${fmtCountdownDHMS(d.getTime() - Date.now())}`;
    chip.title = `Orders open — deadline: ${d.toLocaleString()}`;
    chip.classList.add('warn');
    panel.classList.add('deadline-warn');
  } else {
    chip.textContent = '⏰ Orders closed';
    chip.title = 'The deadline has passed — submissions are closed until the game master confirms a new one';
    chip.classList.add('danger');
    panel.classList.add('deadline-danger');
  }
}

// datetime-local wants local wall-clock time, not ISO/UTC
function isoToLocalInput(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function setDeadline(date) {
  game.deadline = date ? date.toISOString() : null;
  S.saveGame(game);
  renderDeadlineInfo();
  try {
    await updatePublished(game, game.publishedState);
    toast(date ? `Deadline confirmed: ${date.toLocaleString()}` : 'Deadline cleared — submissions stay open', 'info');
  } catch (e) {
    toast('Could not save the deadline: ' + e.message);
    if (isAuthError(e)) askToken();
  }
}

// GM: how the deadline resolves — instant reveal, or review first.
async function setPublishMode(mode) {
  game.publishMode = mode;
  S.saveGame(game);
  renderOnlineUI();
  try {
    await updatePublished(game, game.publishedState);
    toast(
      mode === 'auto'
        ? 'Auto publish: everyone sees all moves the moment the deadline passes'
        : 'Manual publish: after the deadline you review the submissions before releasing them',
      'info'
    );
  } catch (e) {
    toast('Could not save the setting: ' + e.message);
    if (isAuthError(e)) askToken();
  }
}

// Quick-set: previous deadline + `hours` — the weekly rhythm — falling back
// to now + `hours` when no deadline exists (or the old one is long gone).
function bumpDeadline(hours) {
  const prev = deadlineDate();
  const base = prev && prev.getTime() > Date.now() - 7 * 86400000 ? prev.getTime() : Date.now();
  setDeadline(new Date(base + hours * 3600000));
}

// ---- player assignments ----------------------------------------------------
function renderSubmissionsModal() {
  // 🔍 Review is a manual-mode-only step, and only once the deadline has
  // passed — before that, submissions can still change, and auto mode skips
  // the review step entirely (the deadline reveals everything on its own).
  const reviewBtn = $('submissions-review');
  reviewBtn.hidden = publishMode() === 'auto';
  reviewBtn.disabled = !deadlinePassed();
  reviewBtn.title = deadlinePassed()
    ? 'Fill the order box with every submission — for your eyes only, nothing is published'
    : 'Available once the deadline passes';
  $('submissions-publish-all').disabled = !deadlinePassed();
  const rows = $('submissions-rows');
  rows.replaceChildren();
  for (const p of activePowers()) {
    const row = document.createElement('div');
    row.className = 'player-row';
    const name = document.createElement('span');
    name.className = 'pname';
    name.innerHTML = `<span class="chip" style="background:${POWER_COLORS[p]}"></span>${cap(p)}`;
    const login = document.createElement('span');
    login.className = 'login';
    login.textContent = (game.players || {})[p] ? '@' + (game.players || {})[p] : '—';
    const status = document.createElement('span');
    status.className = 'pstatus ' + STATUS_BADGE[powerOnlineStatus(p)][1];
    status.textContent = { published: '✓', revealed: '✓', late: '⚠', submitted: '📨', none: '—', unknown: '…' }[powerOnlineStatus(p)];
    status.title = STATUS_BADGE[powerOnlineStatus(p)][0];
    const mk = (txt, title, fn) => {
      const b = document.createElement('button');
      b.textContent = txt;
      b.title = title;
      b.onclick = fn;
      return b;
    };
    row.append(
      name, login, status,
      mk('📥', `Publish ${cap(p)}'s submitted moves for this phase (overwrites what's published)`,
        () => gmPublishFromComments([p], { force: true })),
      mk('📝', `Publish the order box's ${cap(p)} block for this phase (manual override)`,
        () => gmPublishFromBox(p)),
      mk('✖', `Un-publish ${cap(p)} for this phase so they can resubmit`,
        () => gmUnpublish(p)),
    );
    rows.appendChild(row);
  }
}

// Submissions modal (⚙ Settings → 🔍 Submissions, or ⏰ Deadline → 🔍 Review
// submitted orders) — who's submitted and what's published, game-master only.
// Deliberately not part of the always-visible sidebar: players never see it,
// and the GM only sees it when they deliberately open it.
function openSubmissionsModal() {
  renderSubmissionsModal(); // show what we already have immediately...
  $('submissions-modal').hidden = false;
  refreshOnlineStatus(); // ...then refresh; its renderOnlineUI() re-renders the modal since it's now open
}

function closeSubmissionsModal() {
  $('submissions-modal').hidden = true;
}

// ---- 🕵 view as player (GM debug mode) -------------------------------------
// Lets the GM preview and exercise the game exactly as one assigned player
// would — including a real 📤 Submit moves — without a second GitHub account.
// Safe by construction: submissions are matched by GitHub login
// (findSubmission), so a debug submission (posted under the GM's own login)
// can never overwrite a different real player's comment. The only comment it
// can touch is the GM's own — captured verbatim before debugging starts and
// restored (or deleted, if none existed) in exitDebugView().

// Populates and shows/hides the Settings-menu "View as" picker / "Exit debug
// view" button. Called from refreshAll() so it stays in sync with published
// state and player assignments.
function renderViewAsControls() {
  const row = $('view-as-row');
  const exitBtn = $('btn-exit-debug-view');
  const banner = $('debug-view-banner');
  const assignedPowers = activePowers().filter((p) => (game.players || {})[p]);
  const canDebug = !!(game && game.published && game.isOwner && assignedPowers.length);
  row.hidden = !canDebug || !!debugPower;
  if (!row.hidden) {
    const sel = $('debug-power-select');
    const prev = sel.value;
    sel.replaceChildren(new Option('— pick a power —', ''));
    for (const p of assignedPowers) sel.appendChild(new Option(cap(p), p));
    sel.value = assignedPowers.includes(prev) ? prev : '';
  }
  exitBtn.hidden = !debugPower;
  exitBtn.textContent = debugPower ? `🕵 Exit debug view (${cap(debugPower)})` : '🕵 Exit debug view';
  banner.hidden = !debugPower;
  if (debugPower) {
    $('debug-view-power').textContent = cap(debugPower);
    banner.title = `Game master debug view — simulating ${cap(debugPower)}. Exit from ⚙ Settings.`;
  }
}

async function enterDebugView(power) {
  if (!power || !game || !game.isOwner || !game.gistId) return;
  try {
    const comments = await listComments(game.gistId);
    const login = await getAuthenticatedLogin(getToken());
    const mine = login && comments.find((c) => c.user && c.user.login.toLowerCase() === login.toLowerCase());
    debugCapturedComment = mine ? { commentId: mine.id, body: mine.body } : null;
    debugPower = power;
    game.myCountry = power; // locks the country-select / order box to this power, like a real assigned player
    toast(`🕵 Viewing as ${cap(power)} — a real 📤 Submit will post for real, then be cleaned up on exit`, 'info');
    refreshAll(); // also re-runs prefillOrders(), which locks the box to this power via myCountry()
  } catch (e) {
    toast('Could not enter debug view: ' + e.message);
  }
}

// Restores the GM's own comment to what it was before debugging (or deletes
// it if it didn't exist), against whichever gist/captured-state is passed in
// — a pure network op, independent of the current `game`/`debugPower`
// globals, so it can also run as a fire-and-forget safety net when the GM
// navigates away from a debug session without explicitly exiting it first
// (see openGame() and 🏠 Home).
async function cleanupDebugSubmission(gistId, captured) {
  const comments = await listComments(gistId);
  const login = await getAuthenticatedLogin(getToken());
  const mine = login && comments.find((c) => c.user && c.user.login.toLowerCase() === login.toLowerCase());
  if (captured) {
    if (mine && mine.id === captured.commentId && mine.body !== captured.body) {
      await updateCommentBody(gistId, mine.id, captured.body);
    }
  } else if (mine) {
    await deleteComment(gistId, mine.id);
  }
}

async function exitDebugView() {
  const power = debugPower;
  if (!power) return;
  try {
    await cleanupDebugSubmission(game.gistId, debugCapturedComment);
    toast(`Exited debug view (${cap(power)}) — any test submission was cleaned up`, 'info');
  } catch (e) {
    toast(`Exited debug view, but cleanup failed (${e.message}) — check the gist's comments manually`);
  } finally {
    debugPower = null;
    debugCapturedComment = null;
    refreshAll();
    refreshOnlineStatus();
  }
}

// "Set players" modal (⚙ Settings) — assigns the GitHub username for each
// power. Kept separate from the review rows above, which are status/action
// only; this is the only place the username itself is edited.
function openPlayersModal() {
  renderPlayersAssignRows();
  $('players-modal').hidden = false;
}

function closePlayersModal() {
  $('players-modal').hidden = true;
}

function renderPlayersAssignRows() {
  const rows = $('players-assign-rows');
  rows.replaceChildren();
  for (const p of activePowers()) {
    const row = document.createElement('div');
    row.className = 'player-row';
    const name = document.createElement('span');
    name.className = 'pname';
    name.innerHTML = `<span class="chip" style="background:${POWER_COLORS[p]}"></span>${cap(p)}`;
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'GitHub username';
    input.value = (game.players || {})[p] || '';
    input.dataset.power = p;
    row.append(name, input);
    rows.appendChild(row);
  }
}

// Re-reads the gist's game.json (for fresh player assignments), the published
// moves files, everyone's submission comments, and this browser's login —
// then re-renders all online UI. Safe to call often; all reads are public.
async function refreshOnlineStatus() {
  const g = game;
  if (!g || !g.published || !g.gistId) return;
  try {
    const gistJson = await fetchGist(g.gistId);
    const fresh = await readGameFile(gistJson);
    const moves = await readMovesFiles(gistJson);
    const comments = await listComments(g.gistId);
    const token = getToken();
    const login = token ? await getAuthenticatedLogin(token) : null;
    if (game !== g) return; // user switched games while we were fetching
    if (fresh && fresh.players) g.players = fresh.players;
    if (fresh && !g.isOwner) {
      g.deadline = fresh.deadline || null;
      g.publishMode = fresh.publishMode || null;
    }
    online.moves = moves;
    online.comments = comments;
    online.login = login;
    let assigned = null;
    if (!g.isOwner && login && g.players) {
      for (const [p, l] of Object.entries(g.players)) {
        if (l && l.toLowerCase() === login.toLowerCase()) { assigned = p; break; }
      }
    }
    const changed = (g.assignedPower || null) !== assigned;
    g.assignedPower = assigned;
    // snap to the assigned power on a NEW assignment only — after that the
    // player may deliberately switch to the all-countries view
    if (assigned && changed) g.myCountry = assigned;
    S.saveGame(g);
    if (changed) {
      renderCountrySelect();
      prefillOrders(true);
      onOrdersChanged();
    }
    maybeRestoreSubmission();
    renderOnlineUI();
  } catch {
    // offline or rate-limited — keep whatever state we already had
  }
}

// On first load, put the player's already-submitted orders back into the box
// (multi-device continuity) — unless they have started drafting this session.
function maybeRestoreSubmission() {
  if (online.restored) return;
  const p = assignedPower();
  if (!p || !online.comments || !online.login) return;
  const found = findSubmission(online.comments, online.login);
  const s = found && found.submission;
  if (!s || !matchesPhase(s) || s.power !== p) return;
  online.restored = true;
  if (parseOrders(powerBlockText(p), phaseKind()).orders.length) return;
  replacePowerBlock(p, s.orders);
  toast('Restored the orders you already submitted', 'info');
}

async function doSubmitMoves() {
  const power = assignedPower();
  if (!power) return;
  if (!ordersOpen()) {
    return toast(
      game.deadline
        ? 'The deadline has passed — ask your game master to re-open with a new deadline'
        : "Your game master hasn't set a deadline yet — submissions open once they confirm one"
    );
  }
  if (!getToken() && !askToken()) return;
  // only this player's block is submitted, whatever view the box is in
  const block = powerBlockText(power);
  const parsed = parseOrders(power.toUpperCase() + '\n' + block, phaseKind());
  if (parsed.errors.length) return toast('Fix the order problems first');
  if (!parsed.orders.length) return toast(`Write some ${cap(power)} orders first`);
  const btn = $('btn-submit-moves');
  btn.disabled = true;
  try {
    await submitOrders(game.gistId, {
      power, year: game.year, season: game.season, step: game.step,
      orders: block,
    });
    online.restored = true; // what's in the box IS the submission now
    toast(`Orders submitted for ${cap(power)} — resubmit any time before the deadline`, 'info');
    await refreshOnlineStatus();
  } catch (e) {
    toast('Submit failed: ' + e.message);
    if (isAuthError(e)) askToken();
  } finally {
    btn.disabled = !ordersOpen();
  }
}

// Fills the order box with every power's revealed moves for the current
// phase — published file entries, plus (auto mode, past deadline) on-time
// submissions straight from the comments. The reveal for players, the
// pre-resolve step for the GM.
async function doLoadPublishedMoves() {
  const btn = $('btn-load-moves');
  btn.disabled = true;
  try {
    if (!online.moves) await refreshOnlineStatus();
    const blocks = [];
    for (const p of POWERS) {
      const entry = revealedEntry(p);
      if (entry && entry.orders.trim()) blocks.push(p.toUpperCase() + '\n' + entry.orders.trim() + '\n');
    }
    if (!blocks.length) return toast('No published moves for this phase yet');
    applyOrdersText(blocks.join('\n'));
    toast(`Loaded moves for ${blocks.length} power${blocks.length === 1 ? '' : 's'}`, 'info');
  } finally {
    btn.disabled = false;
  }
}

// GM: load everyone's submitted comments into the order box WITHOUT
// publishing anything — the manual-mode review step after the deadline.
// Gated on the deadline: before it, submissions can still change, and no
// one — including the GM — gets a shortcut to see them early.
async function gmReviewSubmissions() {
  if (!deadlinePassed()) return toast('Wait for the deadline before reviewing submissions');
  try {
    if (!online.comments) await refreshOnlineStatus();
    const blocks = [];
    for (const p of activePowers()) {
      const found = phaseSubmission(p);
      const s = found && found.submission;
      if (s && s.orders.trim()) blocks.push(p.toUpperCase() + '\n' + s.orders.trim() + '\n');
    }
    if (!blocks.length) return toast('No submissions for this phase yet');
    applyOrdersText(blocks.join('\n'));
    closeSubmissionsModal(); // get out of the way so the GM can see/edit the order box
    toast(`Loaded ${blocks.length} submission${blocks.length === 1 ? '' : 's'} for review — nothing is published yet`, 'info');
  } catch (e) {
    toast('Could not load submissions: ' + e.message);
  }
}

// GM: copy submitted comments into the per-power files — 📣 Publish results.
// Without `force`, this waits for the deadline (results reveal what everyone
// ordered, so releasing them early would leak the position to whoever's
// already submitted while others are still deciding), skips powers already
// published for this phase, and skips comments edited after the deadline;
// the per-power 📥 button forces through all three (the deliberate grace
// path for one power at a time).
async function gmPublishFromComments(powers, { force = false } = {}) {
  if (!force && !deadlinePassed()) return toast('Wait for the deadline before publishing results');
  try {
    const gistJson = await fetchGist(game.gistId);
    const moves = await readMovesFiles(gistJson);
    const comments = await listComments(game.gistId);
    const updates = {};
    const done = [];
    const skipped = [];
    for (const p of powers) {
      const login = (game.players || {})[p];
      if (!login) continue;
      if (!force && moves[p] && moves[p].history.some(matchesPhase)) {
        skipped.push(`${cap(p)}: already published`);
        continue;
      }
      const found = findSubmission(comments, login);
      const s = found && found.submission;
      if (!s || !matchesPhase(s) || s.power !== p) {
        skipped.push(`${cap(p)}: no submission for this phase`);
        continue;
      }
      if (!force && deadlinePassed() && !submissionOnTime(found)) {
        skipped.push(`${cap(p)}: edited after the deadline (📥 to allow it)`);
        continue;
      }
      updates[p] = upsertMovesEntry(moves[p], p, {
        year: s.year, season: s.season, step: s.step, orders: s.orders,
        by: login, submittedAt: s.submittedAt || null,
        publishedAt: new Date().toISOString(), publishedBy: 'gm',
      });
      done.push(cap(p));
    }
    if (done.length) await writeMovesFiles(game.gistId, updates);
    const msg = done.length ? `Published: ${done.join(', ')}` : 'Nothing published';
    toast(skipped.length ? `${msg} · ${skipped.join(' · ')}` : msg, done.length ? 'info' : '');
    await refreshOnlineStatus();
  } catch (e) {
    toast('Publish failed: ' + e.message);
    if (isAuthError(e)) askToken();
  }
}

// GM: publish whatever the order box holds for one power — the grace path
// when a player's submission has a typo the table forgives.
async function gmPublishFromBox(power) {
  const orders = powerBlockText(power);
  if (!orders) return toast(`No ${cap(power)} orders in the box`);
  try {
    const moves = await readMovesFiles(await fetchGist(game.gistId));
    const doc = upsertMovesEntry(moves[power], power, {
      year: game.year, season: game.season, step: game.step, orders,
      by: online.login || 'game master', submittedAt: null,
      publishedAt: new Date().toISOString(), publishedBy: 'gm-override',
    });
    await writeMovesFiles(game.gistId, { [power]: doc });
    toast(`Published ${cap(power)} from the order box`, 'info');
    await refreshOnlineStatus();
  } catch (e) {
    toast('Publish failed: ' + e.message);
    if (isAuthError(e)) askToken();
  }
}

// GM: drop a power's published entry for the current phase, reopening its
// submission window (the player can edit their comment and republish).
async function gmUnpublish(power) {
  try {
    const moves = await readMovesFiles(await fetchGist(game.gistId));
    const doc = moves[power];
    if (!doc || !doc.history.some(matchesPhase))
      return toast(`${cap(power)} has nothing published for this phase`);
    doc.history = doc.history.filter((h) => !matchesPhase(h));
    await writeMovesFiles(game.gistId, { [power]: doc });
    toast(`Un-published ${cap(power)} for this phase — they can resubmit`, 'info');
    await refreshOnlineStatus();
  } catch (e) {
    toast('Un-publish failed: ' + e.message);
    if (isAuthError(e)) askToken();
  }
}

async function savePlayers() {
  const players = {};
  for (const input of $('players-assign-rows').querySelectorAll('input')) {
    const v = input.value.trim().replace(/^@/, '');
    if (v) players[input.dataset.power] = v;
  }
  game.players = players;
  S.saveGame(game);
  try {
    await updatePublished(game, game.publishedState);
    toast('Player assignments saved to the published game', 'info');
    closePlayersModal();
    await refreshOnlineStatus();
  } catch (e) {
    toast('Save failed: ' + e.message);
    if (isAuthError(e)) askToken();
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
    game.publishedState = S.boardSnapshot(game);
    S.saveGame(game);
    refreshAll();
    const shareLink = `${location.origin}${location.pathname}?gist=${id}`;
    prompt(
      'Published! Send this link to every player. They can watch the game, ' +
      'pick their country to write orders and copy them into an email to you, ' +
      'and branch the position to test ideas. After you resolve a turn, use ' +
      '"☁ Publish changes" so everyone sees the latest position at the same link.',
      shareLink
    );
  } catch (e) {
    toast('Publish failed: ' + e.message);
    if (isAuthError(e)) askToken(); // stale/incorrect token — let them fix it now
  }
}

// The dedicated "publish a new game state" action — distinct from 📤 Submit
// moves (the GM playing their own power) and from 📣 Publish results (the
// order-reveal flow). Only enabled while boardDirty() — see refreshAll().
async function doUpdatePublished() {
  if (publishedPreview) exitPublishedPreview();
  try {
    await updatePublished(game);
    game.publishedState = S.boardSnapshot(game);
    S.saveGame(game);
    $('btn-update-published').disabled = !boardDirty();
    const d = deadlineDate();
    const hasPlayers = game.players && Object.values(game.players).some(Boolean);
    if (hasPlayers && (!d || d.getTime() <= Date.now())) {
      toast('Changes published — now confirm the next deadline in 👥 Players', 'info');
    } else {
      toast('Changes published', 'info');
    }
  } catch (e) {
    toast('Publish failed: ' + e.message);
    if (isAuthError(e)) askToken();
  }
}

// GM: read the shared link's actual game.json and show it on the board —
// without touching the local game object, so it's safe to check the live
// position mid-plan. Anything that would move the real position (resolve,
// undo, redo, board edits) exits the preview first.
async function doViewPublished() {
  if (!game || !game.gistId) return;
  const btn = $('btn-view-published');
  btn.disabled = true;
  try {
    const fresh = await readGameFile(await fetchGist(game.gistId));
    if (!fresh) return toast('Could not read the published game');
    if (playback) endPlayback();
    if (editMode) setEditMode(false);
    publishedPreview = {
      year: fresh.year, season: fresh.season, step: fresh.step,
      units: fresh.units, scOwners: fresh.scOwners, pending: fresh.pending,
    };
    renderPublishedPreview();
  } catch (e) {
    toast('Could not load the published game: ' + e.message);
  } finally {
    btn.disabled = false;
  }
}

function renderPublishedPreview() {
  const p = publishedPreview;
  $('panel-orders').hidden = true;
  $('panel-edit').hidden = true;
  $('panel-playback').hidden = true;
  $('published-preview-banner').hidden = false;
  $('btn-exit-preview').hidden = false;
  board.clearOrders();
  board.setPhaseText(S.phaseLabel(p) + ' — published');
  board.setInfluence(p.scOwners);
  board.setUnits(p.units, p.step === 'retreat' && p.pending ? p.pending.dislodged : []);
  updateOrderModeUI();
}

function exitPublishedPreview() {
  publishedPreview = null;
  $('published-preview-banner').hidden = true;
  $('btn-exit-preview').hidden = true;
  refreshAll();
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
    const { game: fetched, ownerLogin } = await fetchPublished(id);
    const token = getToken();
    const myLogin = token ? await getAuthenticatedLogin(token) : null;
    // Any browser holding the publisher's token counts as the owner — not
    // just the one that originally ran "Publish".
    const isOwner = !!(myLogin && ownerLogin && myLogin === ownerLogin);
    if (isOwner && local) {
      local.isOwner = true;
      S.saveGame(local);
      return openGame(local);
    }
    const g = S.importGame(JSON.stringify(fetched));
    g.gistId = id;
    g.published = true;
    g.isOwner = isOwner;
    g.name = local ? local.name : uniqueName(g.name || 'Published game');
    g.myCountry = local ? local.myCountry : null; // keep the viewer's chosen country
    // keep the known assignment so the power lock renders immediately;
    // refreshOnlineStatus() re-verifies it against the token's login
    g.assignedPower = local ? local.assignedPower : null;
    if (g.assignedPower) g.myCountry = g.assignedPower;
    // this position was just fetched from the published gist, so it *is*
    // the published state — without this, boardDirty() sees no
    // publishedState and reports dirty even though nothing has changed yet
    g.publishedState = S.boardSnapshot(g);
    openGame(g);
    toast(
      isOwner
        ? 'Loaded published game — you can publish updates from this browser too'
        : 'Loaded published game — pick your country to write orders, or Branch to plan ahead',
      'info'
    );
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
    if (debugPower && game && game.gistId) {
      cleanupDebugSubmission(game.gistId, debugCapturedComment).catch(() => {});
      debugPower = null;
      debugCapturedComment = null;
    }
    playback = null;
    publishedPreview = null;
    renderHome();
    showScreen('home-screen');
  };
  $('btn-export').onclick = exportCurrent;
  $('btn-edit').onclick = toggleEditMode;
  $('btn-mode-support').onclick = () => toggleOrderMode('support');
  $('btn-mode-convoy').onclick = () => toggleOrderMode('convoy');
  // on mobile the toggles float just below the topbar, whose height depends on
  // the phone's font size and on whether the phase label wraps
  const topbarH = () =>
    document.documentElement.style.setProperty('--topbar-h', $('topbar').offsetHeight + 'px');
  new ResizeObserver(topbarH).observe($('topbar'));
  topbarH();

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
  $('settings-btn').onclick = (e) => {
    e.stopPropagation();
    $('settings-menu').classList.toggle('open');
  };
  // picking an action closes the menu; the autopublish toggle row is a
  // <label>, not a <button>, so flipping it leaves the menu open
  for (const b of $('settings-menu').querySelectorAll('button')) {
    b.addEventListener('click', () => $('settings-menu').classList.remove('open'));
  }
  document.addEventListener('pointerdown', (e) => {
    const menu = $('settings-menu');
    const btn = $('settings-btn');
    if (menu.classList.contains('open') && !menu.contains(e.target) && !btn.contains(e.target)) {
      menu.classList.remove('open');
    }
  });

  $('orders-text').addEventListener('input', onOrdersChanged);
  $('btn-resolve').onclick = resolveCurrent;
  $('btn-resolve-final').onclick = resolveAndSkip;
  $('btn-token').onclick = doEditToken;
  $('btn-publish').onclick = doPublish;
  $('btn-update-published').onclick = doUpdatePublished;
  $('btn-view-published').onclick = doViewPublished;
  $('btn-exit-preview').onclick = exitPublishedPreview;
  $('btn-load-gist').onclick = () => loadPublishedGame($('load-gist-input').value);
  $('country-select').onchange = () => {
    game.myCountry = $('country-select').value || null;
    S.saveGame(game);
    prefillOrders(true);
    onOrdersChanged();
  };
  $('btn-submit-moves').onclick = doSubmitMoves;
  $('btn-load-moves').onclick = doLoadPublishedMoves;
  $('btn-refresh-online').onclick = () => refreshOnlineStatus();
  $('btn-set-players').onclick = openPlayersModal;
  $('players-save').onclick = savePlayers;
  $('players-modal-close').onclick = closePlayersModal;
  $('players-modal').addEventListener('pointerdown', (e) => {
    if (e.target === $('players-modal')) closePlayersModal();
  });
  $('btn-submissions').onclick = openSubmissionsModal;
  $('deadline-review-btn').onclick = openSubmissionsModal;
  $('debug-power-select').onchange = (e) => {
    const power = e.target.value;
    e.target.value = '';
    if (power) enterDebugView(power);
  };
  $('btn-exit-debug-view').onclick = exitDebugView;
  $('submissions-modal-close').onclick = closeSubmissionsModal;
  $('submissions-modal').addEventListener('pointerdown', (e) => {
    if (e.target === $('submissions-modal')) closeSubmissionsModal();
  });
  $('submissions-review').onclick = gmReviewSubmissions;
  $('submissions-publish-all').onclick = () => gmPublishFromComments(activePowers());
  $('autopublish-toggle').onchange = (e) => setPublishMode(e.target.checked ? 'auto' : 'manual');
  $('deadline-plus-week').onclick = () => bumpDeadline(7 * 24);
  $('deadline-plus-2day').onclick = () => bumpDeadline(48);
  $('deadline-plus-day').onclick = () => bumpDeadline(24);
  $('deadline-clear').onclick = () => setDeadline(null);
  $('deadline-set').onclick = () => {
    const v = $('deadline-input').value;
    const d = v && new Date(v);
    if (!d || isNaN(d)) return toast('Pick a date and time first');
    setDeadline(d);
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

  // tick the deadline countdown — and, in auto-publish games, flip the UI
  // over to the reveal — while a published game sits open. Render-only; the
  // network is touched only by the 🔄 button and explicit actions.
  setInterval(() => {
    if (game && game.published && !playback) renderOnlineUI();
  }, 60000);

  // the topbar countdown chip ticks every second on its own — far cheaper
  // than a full renderOnlineUI(), and it's the one place a second matters
  setInterval(() => {
    if (game && game.published && !playback) updateDeadlineCountdown();
  }, 1000);

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
  if (stage === 'builds') {
    // a winter with France owed 2 builds (bel captured, A Par removed), so
    // the live build counter and its limits can be screenshot-checked
    game.scOwners.bel = 'france';
    game.units = game.units.filter((u) => !(u.power === 'france' && prov(u.loc) === 'par'));
    game.season = 'winter';
    game.step = 'adjustment';
    refreshAll();
    $('orders-text').value = 'FRANCE\nBuild A Par\nWaive';
    onOrdersChanged();
    return done();
  }
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
