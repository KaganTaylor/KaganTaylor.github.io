import { Board, POWER_COLORS, ARROW_COLORS } from './render.js';
import * as S from './state.js';
import { parseOrders, parseOrderLine, normalizePower } from './parser.js';
import {
  prov,
  armyAdjacent,
  fleetDestLocs,
  convoyPossible,
  convoyRouteHops,
  convoyRoutes,
  fleetWaters,
  seaAdjacent,
  adjudicateMovement,
  adjudicateRetreats,
  adjudicateAdjustments,
} from './adjudicator.js';
import { PROVINCES, POWERS } from './map-data.js';
import {
  getToken, setToken, publishGame, updatePublished, fetchPublished,
  getAuthenticatedLogin, extractGistId,
  listComments, findSubmission, findMyMailbox, createMailbox, rememberMailbox,
  submitOrders, readSealKey, ensureSealKey, unsealComments,
  fetchGist, readMovesFiles, readGameFile, writeMovesFiles, upsertMovesEntry,
  getLastServerDate,
} from './publish.js';

const $ = (id) => document.getElementById(id);

// coast-suffix labels for the hover tooltip on split-coast provinces
// (Spain, St Petersburg, Bulgaria)
const COAST_NAMES = { nc: 'North coast', sc: 'South coast', ec: 'East coast' };

// One real-world flag per power, standing in for its country everywhere a
// player's identity is shown (Play as picker, topbar mode chip, home-screen
// game list). Austria and Turkey have no country of that exact name/borders
// today, so these use the closest modern flag rather than a historical one.
const POWER_FLAGS = {
  england: '🇬🇧', france: '🇫🇷', germany: '🇩🇪', italy: '🇮🇹',
  austria: '🇦🇹', russia: '🇷🇺', turkey: '🇹🇷',
};

let board;
let game = null;
let playback = null; // {entry, step, orders, readonly, animating}
let editMode = false;
let editTool = 'A';
let lastParsed = { orders: [], errors: [], byProv: new Map() };
// strict-convoy route picker: while non-null the board is in route-selection
// mode — { u, from, dest, route: [seaProv…] } (see startConvoyRoute)
let convoyPick = null;
let mobileSheet = null; // null | 'orders' | 'standings' — mobile bottom-sheet state
let orderMode = null; // null | 'support' | 'convoy' — see setOrderMode()

// Gist viewers drag/click units for ANY power to sketch out what opponents
// might do, but the orders textarea only ever shows the power they're
// playing as. Those other powers' order lines live here instead — a second
// text buffer in the same line format, just never rendered into the box.
let hiddenOrdersText = '';

// Live view of a published game's online-play state: everyone's submission
// comments, the published moves-<power>.json files, and this browser's
// GitHub login. Refetched on load and after every submit/publish action.
// Refetched by refreshOnlineStatus() — on game load, on 🔄/Load moves, after a
// submit or publish, and (auto mode, GM only) when a deadline passes. NOT on a
// timer: the 60s tick re-renders from this cache without touching the network.
//
// `sealKey` is the game's shared order-obfuscation key, read straight out of
// the gist (see js/seal.js) — comments arrive sealed and are decrypted once,
// at the edge, so everything below works on cleartext.
let online = { comments: null, moves: null, login: null, restored: false, serverOffset: 0, sealKey: null };

// A game master who has assigned their own GitHub login to a power in 👥 Set
// players can freely switch (⚙ Settings → 🎭 Play as) between running the
// game and genuinely playing that power — see isPlayingAsPlayer() below.
// game.playAs ('gm' | 'player') persists on the game object like any other
// setting, so this is a real, durable mode, not a session-only debug state.

// Gates the order box for a published game's GM: hidden until they explicitly
// ⬇ Load orders, and reset every time a load→resolve→publish cycle finishes
// (or is abandoned by opening a different game). See gmLoadOrders().
let gmOrdersLoaded = false;
// Guards autoPublishIfDue() against overlapping runs from the 60s tick while
// a previous auto-publish is still in flight.
let autoPublishing = false;
// The phase label autoPublishIfDue() has already told the GM it is standing
// down on (nobody submitted anything). One notice per phase, not one a minute.
let autoPublishIdleFor = null;
// Guards ensureMyMailbox() the same way — two refreshes close together (a load
// followed by a 🔄, say) must not race each other into posting a second
// mailbox comment before the first POST returns.
//
// An in-flight guard only: there is deliberately no "already made it this
// session" latch any more. Such a latch made a deleted mailbox invisible until
// the page was reloaded, and the submit path then created one and filled it
// with orders a second later — which is how orders got emailed to the table.
// Whether a mailbox exists is now re-decided from the fetched comment list on
// every refresh; the freshly created comment is folded in via rememberWrite()
// so a list that lags the POST still can't provoke a duplicate.
let creatingMailbox = false;

// A comment this browser has just written, held until a poll comes back
// carrying it. Our own writes are the one thing we know for certain, and the
// UI must never contradict them: "I changed my orders, pressed Resubmit, and
// nothing happened" was this gap — the refresh that follows a submit read a
// cached copy of the comment from before the edit, so the box still looked
// unsubmitted and the button stayed lit. The cache bypass in publish.js
// ghRead() fixes the cause; this makes the display independent of the read
// altogether, which also covers GitHub's own replicas lagging a write.
let justWrote = null;

function rememberWrite(c) {
  if (!c || !c.id) return;
  justWrote = c;
  applyJustWrote();
}

// Folds `justWrote` into online.comments, and lets it go once the server's own
// copy is at least as new — from then on the fetched list is the better truth.
function applyJustWrote() {
  if (!justWrote || !online.comments) return;
  const stamp = (c) => Date.parse((c && c.updated_at) || 0) || 0;
  const i = online.comments.findIndex((c) => String(c.id) === String(justWrote.id));
  if (i >= 0 && stamp(online.comments[i]) >= stamp(justWrote)) {
    justWrote = null;
    return;
  }
  const list = online.comments.slice();
  if (i >= 0) list[i] = justWrote;
  else list.push(justWrote);
  online.comments = list;
}

// The full published game (fetched via refreshOnlineStatus/loadPublishedGame)
// once it has moved on further than this browser's local copy — set only for
// a read-only viewer (player/spectator), never silently applied. Drives the
// ▶ Resolve new orders! button; catchUpNext() steps the local game through
// game.history[game.history.length] .. catchUpTarget.history[last] one phase
// at a time so a returning player is never dropped onto a board they haven't
// seen resolve, see DECISIONS.md.
let catchUpTarget = null;

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
// The saved-game list is split by the same two kinds the game screen uses, and
// each row carries its kind (☁ / 🧪), the role you hold in it and — for online
// games — how long is left on the deadline, so the list answers "where do I
// owe orders?" without opening anything.
function renderHome() {
  const list = $('game-list');
  list.replaceChildren();
  const all = Object.values(S.listGames());
  const byName = (a, b) => a.name.localeCompare(b.name);
  const onlineGames = all.filter((g) => g.published).sort(byName);
  const sandboxes = all.filter((g) => !g.published).sort(byName);
  if (!all.length) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="meta">No saved games yet — start a sandbox, or join an online game.</span>';
    list.appendChild(li);
    return;
  }
  const group = (text) => {
    const li = document.createElement('li');
    li.className = 'group';
    li.textContent = text;
    list.appendChild(li);
  };
  if (onlineGames.length) group('☁ Online games');
  for (const g of onlineGames) list.appendChild(homeRow(g));
  if (sandboxes.length) group('🧪 Sandboxes');
  for (const g of sandboxes) list.appendChild(homeRow(g));
}

function homeRow(g) {
  const kind = g.published ? (g.isOwner ? 'gm' : g.assignedPower ? 'player' : 'spectator') : 'sandbox';
  const li = document.createElement('li');
  li.className = 'game-row ' + kind;
  const load = document.createElement('button');
  load.className = 'load';
  const bits = [
    `<span class="gicon">${g.published ? '☁' : '🧪'}</span>`,
    `<span class="gname">${escapeHtml(g.name)}</span>`,
    `<span class="meta">${S.phaseLabel(g)}</span>`,
  ];
  if (kind === 'gm') bits.push('<span class="badge role-gm">👑 Game master</span>');
  if (kind === 'player') bits.push(`<span class="badge role-player">${POWER_FLAGS[g.assignedPower] || ''} ${cap(g.assignedPower)}</span>`);
  if (kind === 'spectator') bits.push('<span class="badge role-spectator">👁 Watching</span>');
  const d = g.deadline && new Date(g.deadline);
  if (d && !isNaN(d)) {
    const left = d - Date.now();
    bits.push(`<span class="badge deadline${left > 0 ? '' : ' past'}">⏰ ${left > 0 ? 'in ' + fmtCountdown(left) : 'passed'}</span>`);
  }
  if (g.branchedFrom) {
    bits.push(`<span class="meta from">🌿 from ${escapeHtml(g.branchedFrom.name)}` +
      `${g.branchedFrom.label ? ' · ' + escapeHtml(g.branchedFrom.label) : ''}</span>`);
  }
  load.innerHTML = bits.join(' ');
  // someone else's published game may have moved on since we last saw it —
  // reload it through the gist (falls back to the local copy when offline)
  load.onclick = () => (g.published && !g.isOwner && g.gistId ? loadPublishedGame(g.gistId) : openGame(g));
  const del = document.createElement('button');
  del.className = 'del';
  del.textContent = '🗑';
  del.title = g.published && g.isOwner
    ? 'Remove from this browser — the published gist itself is not deleted'
    : 'Delete';
  del.onclick = () => {
    const warn = g.published && g.isOwner
      ? `Remove "${g.name}" from this browser?\n\nThe published gist stays online, but only a browser holding your GitHub token can pick it up again.`
      : `Delete "${g.name}"?`;
    if (confirm(warn)) {
      S.deleteGame(g.name);
      renderHome();
    }
  };
  li.append(load, del);
  return li;
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
// THERE ARE EXACTLY TWO KINDS OF GAME, and most of the rules below follow:
//
//   ☁ online  — a published gist. One authoritative position, one writer (the
//               game master). Nobody else's board actions can move it, and the
//               GM's only move it once they publish.
//   🧪 sandbox — everything else: private to this browser, freely editable,
//               freely resolvable, disposable. Branches, "practice games" and
//               the old empty-board sandbox are all just this — there is no
//               third kind, because the game is only ever really played
//               online and everything local is thinking-out-loud.
//
// gameMode() names the four faces of that: 'sandbox', 'gm', 'player' (an
// assigned power in an online game) and 'spectator'. It is written to
// #game-screen[data-mode], which drives every piece of state colouring in the
// stylesheet, so the two models cannot drift apart.
function isOnline() {
  return !!(game && game.published);
}

function isSandbox() {
  return !!game && !isOnline();
}

function gameMode() {
  if (!game) return '';
  if (!isOnline()) return 'sandbox';
  if (isOwnerView()) return 'gm';
  return assignedPower() ? 'player' : 'spectator';
}

// True when the game master has switched (🎭 Play as) into playing their own
// assigned power rather than running the game. Requires a genuine self-
// assignment in game.players — see refreshOnlineStatus(), which resolves
// game.assignedPower for the owner exactly like it does for anyone else.
function isPlayingAsPlayer() {
  return !!(game && game.isOwner && game.assignedPower && game.playAs === 'player');
}

// A published game can only be advanced by the browser that published it
// (holds the token that created its gist). Everyone else gets a live,
// previewable, branchable, but never mutable view of the position. A GM
// playing their own assigned power is read-only for the same reason: it's a
// faithful, real player experience — including the fact that resolving is
// only ever a preview and orders only reach the game via 📤 Submit.
function isReadOnly() {
  return !!(game && game.published && (!game.isOwner || isPlayingAsPlayer()));
}

// True only for the real game master, and only while running the game rather
// than playing their own power — the gate on every GM-only control (Publish
// changes, Deadline panel, Submissions, Set players, Auto-Publish). Kept
// separate from the raw game.isOwner fact (still used as-is for identity/
// permission purposes, e.g. loadPublishedGame) so Play-as-Player can hide the
// GM's own admin controls without touching who actually owns the game.
function isOwnerView() {
  return !!(game && game.isOwner && !isPlayingAsPlayer());
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
// playing as their own power is locked to it the same way a real player
// would be. Empty string = spectating / no country chosen.
function myCountry() {
  return (isReadOnly() && game.myCountry) || '';
}

// The power the GM assigned to this browser's GitHub account (game.players
// maps power → login). An assigned player is locked to that power for the
// whole game — on every device, since the token resolves to the same login.
function assignedPower() {
  return (isReadOnly() && game.assignedPower) || '';
}

// Does a submission/published entry belong to the phase on the table now?
function matchesPhase(s) {
  return s && s.year === game.year && s.season === game.season && s.step === game.step;
}

function openGame(g) {
  game = g;
  g.settings = S.gameSettings(g); // fill defaults for games saved before settings existed
  playback = null;
  gmOrdersLoaded = false;
  catchUpTarget = null; // re-established below/by refreshOnlineStatus() for THIS game, not whatever was last open
  online = { comments: null, moves: null, login: null, restored: false, serverOffset: 0, sealKey: null };
  justWrote = null; // belongs to whichever game we just left
  S.saveGame(game);
  showScreen('game-screen');
  $('game-name').textContent = game.name;
  mobileSheet = null;
  setEditMode(isSandbox() && game.units.length === 0);
  // A real player's order box is a second thing to check, not the reason
  // they opened the game — collapsed by default so the panel opens onto the
  // history/catch-up controls instead. Everyone else still wants it open.
  $('orders-box').open = gameMode() !== 'player';
  refreshAll();
  if (game.published && game.gistId) refreshOnlineStatus();
}

function refreshAll() {
  $('game-screen').dataset.mode = gameMode();
  $('phase-label').textContent = S.phaseLabel(game);
  board.setPhaseText(S.phaseLabel(game));
  board.setInfluence(game.scOwners);
  board.setUnits(game.units, game.step === 'retreat' ? game.pending.dislodged : []);
  board.clearOrders();
  $('panel-playback').hidden = true;
  // The GM's order box stays out of the way until they deliberately ⬇ Load
  // orders (⏰ Deadline panel) — see gmLoadOrders()/gmOrdersLoaded. Everyone
  // else (sandboxes, players, spectators) sees it as before.
  const gmGated = isOwnerView() && game.published && !gmOrdersLoaded;
  $('panel-orders').hidden = gmGated;
  const ro = isReadOnly();
  // An assigned player is always drafting their own power, so there is
  // nothing to pick — the selector is only for a spectator choosing which
  // country to sketch orders for.
  const isPlayer = gameMode() === 'player';
  $('country-row').hidden = !ro || isPlayer;
  if (ro) renderCountrySelect();
  $('orders-text').readOnly = false;

  // Resolving a published game you do not own must not move it, so a
  // spectator's two Resolve buttons become a PREVIEW: the phase is
  // adjudicated on a throwaway copy and the real board comes back untouched
  // when the playback closes (previewResolve). An assigned player submits
  // orders instead (📤 Submit orders) — previewing their own game is not a
  // real action, so Resolve/Resolve to final are hidden outright for them.
  $('btn-resolve').hidden = isPlayer;
  $('btn-resolve-final').hidden = isPlayer;
  if (!isPlayer) {
    $('btn-resolve').textContent = ro ? '👁 Preview result' : 'Resolve';
    $('btn-resolve').title = ro
      ? 'Adjudicate the orders in the box on a throwaway copy — the published position is not touched'
      : 'Resolve this phase and step through the results';
    $('btn-resolve-final').textContent = ro ? '⏭ Preview to final' : '⏭ Resolve to final';
    $('btn-resolve').classList.toggle('primary', !ro);
  }

  // Every sandbox gets the board editor, not just an empty one — a branched
  // position is exactly where you want to add a hypothetical fleet. The game
  // master keeps it too (correcting the official board by hand beats replaying
  // a year), behind a confirmation; see toggleEditMode(). Players never edit
  // the official board, so the whole section (heading included) disappears
  // rather than leaving an empty "Edit board" label in the History panel.
  $('btn-edit').hidden = ro;
  $('edit-board-section').hidden = ro;
  // a viewer's local copy is never allowed to move, so there is nothing to
  // undo there — and never anything to publish either — so the buttons
  // disappear entirely rather than sitting there disabled; 🌿 Branch is the
  // way to explore instead
  $('btn-undo').hidden = ro;
  $('btn-redo').hidden = ro;
  $('btn-undo').disabled = !game.history.length;
  $('btn-redo').disabled = !(game.redoStack && game.redoStack.length);
  $('btn-publish').hidden = ro || !!game.published;
  $('btn-update-published').hidden = !(game.published && isOwnerView());
  $('btn-update-published').disabled = !boardDirty();
  $('panel-deadline').hidden = !(game.published && isOwnerView());
  if (game.published && isOwnerView()) {
    const input = $('deadline-input');
    if (document.activeElement !== input) input.value = game.deadline ? isoToLocalInput(game.deadline) : '';
  }
  $('btn-set-players').hidden = !(game.published && isOwnerView());
  $('btn-submissions').hidden = !(game.published && isOwnerView());
  $('autopublish-row').hidden = !(game.published && isOwnerView());
  $('btn-revert-published').hidden = !isOnline();
  $('btn-open-source').hidden = !game.branchedFrom;
  renderModeChip();
  renderBranchNote();
  renderDraftNote();
  renderPlayAsControls();
  renderOnlineUI();
  setOrderMode(null);
  prefillOrders();
  renderHistorySelect();
  renderStandings();
  onOrdersChanged();
  updateSyncPill();
}

// ---------------------------------------------------------------------------
// game-state identity: which game am I in, and can I break it?
// ---------------------------------------------------------------------------
const MODE_CHIP = {
  sandbox: ['🧪', 'Sandbox',
    'Private to this browser. Edit the board, resolve turns and branch freely — nothing here is published.'],
  gm: ['☁', 'Live · 👑 Game master',
    'You run this published game. What you resolve here becomes the official position the moment you ☁ Publish changes.'],
  spectator: ['☁', 'Live · 👁 Watching',
    'A live view of a published game. Nothing you type, drag or resolve here can change it.'],
};

function renderModeChip() {
  const el = $('mode-chip');
  const mode = gameMode();
  let icon, text, title;
  if (mode === 'player') {
    const power = assignedPower();
    [icon, text, title] = ['☁', `Live · ${POWER_FLAGS[power] || ''} ${cap(power)}`,
      `You are playing ${cap(power)} in a published game. Orders here are a private draft until you 📤 Submit them; the board itself is the game master's to move.`];
  } else {
    [icon, text, title] = MODE_CHIP[mode] || ['', '', ''];
  }
  el.hidden = !text;
  el.title = title;
  el.querySelector('.mc-icon').textContent = icon;
  el.querySelector('.mc-text').textContent = text;
}

// boardDirty() already knows the game master's position has moved on from the
// shared link, but the only thing it drove was a disabled button inside a
// closed ⚙ menu — so a resolved-but-unpublished turn looked exactly like a
// published one. This is that same fact, said out loud in the topbar, naming
// the phase the players are still looking at, and clickable to fix it.
function updateSyncPill() {
  const pill = $('btn-sync');
  const dirty = boardDirty();
  pill.hidden = !dirty;
  if (dirty) {
    const live = game.publishedState ? S.phaseLabel(game.publishedState) : null;
    pill.querySelector('.sp-text').textContent = live
      ? `Unpublished — players still see ${live}`
      : 'Unpublished changes';
    pill.title = 'This browser holds a position the shared link does not. Click to publish it.';
  }
}

function renderBranchNote() {
  const el = $('branch-note');
  const b = game.branchedFrom;
  el.hidden = !b;
  if (!b) return;
  el.textContent = `🌿 Branched from “${b.name}”${b.label ? ' at ' + b.label : ''}` +
    (b.gistId ? ' — ↩ Open source game in ⚙ Settings to go back to the live game.' : '.');
}

// What the order box actually is, in this game. Orders are never state, but in
// an online game that is easy to forget — a drag on the map looks identical
// whether it is a draft, a submission or the official record.
function renderDraftNote() {
  const el = $('draft-note');
  const mode = gameMode();
  if (mode === 'sandbox' || mode === 'player') {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  if (mode === 'gm') {
    el.textContent = '👑 These are the official orders. Resolve them, then ☁ Publish changes so every player sees the new board.';
  } else {
    el.textContent = '✎ Private scratch pad. Nothing you write, drag or preview here reaches the published game.';
  }
}

// Spectator-only (an assigned player is locked to their own power without
// any picker — see refreshOnlineStatus(), which sets game.myCountry to the
// assignment directly — and country-row is hidden for them entirely).
function renderCountrySelect() {
  const sel = $('country-select');
  sel.replaceChildren();
  if (assignedPower()) return;
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
  // the current phase is already shown in the topbar, so the heading itself
  // stays a plain, constant label
  const title = (base) => base;
  if (game.step === 'movement') {
    $('orders-title').textContent = title('Orders');
    info.textContent = myC
      ? gameMode() === 'player'
        ? `Write ${cap(myC)}'s orders (type or drag units), then 📤 Submit orders.`
        : `Write ${cap(myC)}'s orders (type or drag units). 👁 Preview result tries them out safely; 🌿 Branch keeps the ideas.`
      : 'Type orders or drag units on the map. Unordered units hold.';
  } else if (game.step === 'retreat') {
    $('orders-title').textContent = title('Retreats');
    info.textContent = 'Drag a dislodged unit to retreat it, or click it to disband. Unordered units disband.';
  } else {
    $('orders-title').textContent = title('Builds');
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
  // "submitted" vs "submitted, then edited" has to track the box keystroke by
  // keystroke, or it is reporting the state from the last network refresh
  if (game && assignedPower()) renderSubmitStatus();
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
      const out = adjudicateMovement(game.units, orders, S.movementOpts(game));
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
  // while the convoy-route picker is open, hide the picked unit's own placed
  // arrow — the picker draws its live preview in its place (else the old
  // straight arrow reappears behind the bent preview)
  const skip = excludeProv || (convoyPick ? prov(convoyPick.u.loc) : null);
  for (const o of lastParsed.orders) {
    if (!o.loc) continue; // a waive has no location — nothing to draw
    if (skip && prov(o.loc) === skip) continue;
    const reason = o.loc && lastParsed.illegal.get(prov(o.loc));
    // a convoy that cannot exist is a void order (the unit holds) — no
    // arrow at all; the warning below the order box explains why
    if (reason === 'no convoy possible' && o.kind === 'move') continue;
    board.drawOrder(o, reason ? '#e05252' : ARROW_COLORS[o.power] || '#888');
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
    case 'move': {
      const route = spec.route && spec.route.length ? spec.route.join(' - ') + ' - ' : '';
      return `${unitToken(u)} - ${route}${spec.dest}${spec.via ? ' via convoy' : ''}`;
    }
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
    canDrag(p, ev) {
      if (convoyPick || playback || !game) return null;
      const base = prov(p);
      if (editMode || game.step === 'movement') {
        const u = unitAt(base);
        if (u) return { color: ARROW_COLORS[u.power] };
      }
      if (game.step === 'retreat') {
        const d = dislodgedAt(base);
        if (!d) return null;
        return { color: ARROW_COLORS[d.unit.power] };
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
      if (convoyPick) return convoyRouteClick(prov(p), ev);
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

// The support/convoy toggles only make sense where a drag writes a movement
// order at all — the same condition canDrag() uses — so they are hidden during
// edit mode, playback and the retreat/build phases.
function updateOrderModeUI() {
  const live = !!game && !playback && !editMode;
  const movement = live && game.step === 'movement';
  if (!movement) orderMode = null;
  $('order-modes').hidden = !movement;
  $('btn-mode-support').hidden = !movement;
  $('btn-mode-convoy').hidden = !movement;
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
    const needsConvoy = !armyAdjacent(from, to);
    if (needsConvoy) {
      if (!(PROVINCES[from].type === 'coast' && PROVINCES[to].type === 'coast'))
        return toast(`An army cannot reach ${provName(to)}`);
      if (strictConvoyOn()) {
        // strict convoy: the route must be named. Auto-pick it when only one
        // chain of fleets can carry the army there; if several routes exist,
        // open the picker so the player chooses; if none, reject the drop.
        const routes = convoyRoutes(game.units, from, to);
        if (!routes.length)
          return toast(`No convoy to ${provName(to)} is possible — no fleet route`);
        if (routes.length === 1)
          return setOrder(u, { kind: 'move', dest: to, route: routes[0] });
        return startConvoyRoute(u, from, to);
      }
      // standard convoy: reject outright if no chain of fleets could ever
      // carry it there (same as an unreachable plain move)
      if (!convoyPossible(game.units, from, to))
        return toast(`No convoy to ${provName(to)} is possible — no fleet route`);
    }
    return setOrder(u, { kind: 'move', dest: to });
  }
  const opts = fleetDestLocs(u.loc, to);
  if (!opts.length) return toast(`${provName(to)} is not adjacent for this fleet`);
  setOrder(u, { kind: 'move', dest: nearestLoc(ev, opts) });
}

// ---------------------------------------------------------------------------
// strict-convoy route picker
// ---------------------------------------------------------------------------
// Under the strict-convoy house rule a convoyed army must name every sea it is
// carried through. Dragging an army to a convoy-only province opens this
// picker: the player taps the sea provinces of the route one at a time (each
// candidate sea is highlighted), then taps the destination to commit. The
// order line written is "A From - Sea1 - Sea2 - Dest".
function strictConvoyOn() {
  return !!game && S.gameSettings(game).convoyRule === 'strict';
}

function startConvoyRoute(u, from, dest) {
  convoyPick = { u, from, dest, route: [] };
  renderConvoyPicker();
  $('convoy-route-bar').hidden = false;
  toast('Convoy route: tap each sea in order, then tap the destination', 'info');
}

// The seas the route may extend to next, given what's chosen so far — limited
// to seas that actually hold a fleet (only those can convoy).
function convoyCandidates() {
  return convoyRouteHops(
    convoyPick.from, convoyPick.dest, convoyPick.route, fleetWaters(game.units)
  );
}

function renderConvoyPicker() {
  if (!convoyPick) return;
  const { u, from, dest, route } = convoyPick;
  board.showConvoyPicker({
    fromLoc: u.loc,
    route,
    dest,
    candidates: convoyCandidates(),
    color: ARROW_COLORS[u.power],
  });
  const end = route.length ? route[route.length - 1] : from;
  const canFinish = seaAdjacent(end, dest);
  const bar = $('convoy-route-bar');
  const chosen = route.length ? route.map(provName).join(' → ') : '(none yet)';
  $('convoy-route-status').textContent =
    `${provName(from)} → ${chosen} → ${provName(dest)}` +
    (canFinish ? ' — tap the destination to finish' : '');
  $('convoy-route-undo').disabled = !route.length;
  bar.hidden = false;
}

// A board tap while the picker is open: extend the route, finish, or reject.
function convoyRouteClick(p, _ev) {
  const { from, dest, route } = convoyPick;
  const end = route.length ? route[route.length - 1] : from;
  if (p === dest) {
    if (route.length && seaAdjacent(end, dest)) return finishConvoyRoute();
    return toast('Pick the sea(s) leading to the destination first');
  }
  if (route.includes(p)) return toast('That sea is already in the route');
  if (!convoyCandidates().includes(p))
    return toast('Pick a highlighted sea adjacent to the route');
  route.push(p);
  renderConvoyPicker();
}

function finishConvoyRoute() {
  const { u, dest, route } = convoyPick;
  cancelConvoyRoute(); // tears down the overlay before the order redraws
  // setOrder → onOrdersChanged dry-runs the engine, so a route with no fleet
  // convoying it yet surfaces as "convoy disrupted" in the parse-status line.
  setOrder(u, { kind: 'move', dest, route });
}

function cancelConvoyRoute() {
  convoyPick = null;
  board.clearConvoyPicker();
  $('convoy-route-bar').hidden = true;
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
  applyMobileSheetUI();
  updateOrderModeUI();
}

// A game master editing a published board is editing the official position —
// legitimate (correcting a mis-entered order beats replaying the year) but
// never something to fall into by accident, so it asks first and points at
// the sandbox as the alternative.
function toggleEditMode() {
  if (!editMode && game.published && isOwnerView() && !confirm(
    'Edit the official board?\n\n' +
    'You are about to change the published game\'s position by hand. ' +
    'Players see nothing until you ☁ Publish changes.\n\n' +
    'To try ideas out instead, cancel and use 🌿 Branch.'
  )) return;
  setEditMode(!editMode);
  if (editMode && playback) endPlayback();
}

// ---------------------------------------------------------------------------
// mobile bottom sheet (Orders+History / Standings tabs)
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
// board must stay usable while a sheet is open (editing units means tapping
// the map itself). The stylesheet reads this as --sheet-h, and ignores it on
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
  updateSyncPill();
}

function editClick(p, ev) {
  const info = PROVINCES[p];
  if (!info) return;
  const power = $('edit-power').value;
  const at = game.units.findIndex((x) => prov(x.loc) === p);
  if (editTool === 'move') {
    return; // Move repositions by dragging; a plain click does nothing
  } else if (editTool === 'erase') {
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
  updateSyncPill();
}

// ---------------------------------------------------------------------------
// preview: resolving a game you do not own
// ---------------------------------------------------------------------------
// The published position is the only real one, so a viewer's Resolve must not
// move their copy of it — that divergence is exactly how a player ends up
// staring at a board the rest of the table cannot see. Instead the phase is
// adjudicated on a throwaway clone. The playback panel reads nothing but the
// history entry it is handed (unitsBefore/unitsAfter/scOwners…), so the whole
// step-through, animation and result copy work unchanged while `game` is never
// touched; closing the playback re-renders the live position over the top.
//
// The upside is bigger than the safety: because previewing is free it is
// offered at all times, not just after an auto-publish deadline. Guess the
// other six powers' orders, preview, and 🌿 keep the outcome as a sandbox if
// it was interesting.
function shadowGame() {
  return {
    season: game.season,
    year: game.year,
    step: game.step,
    settings: S.gameSettings(game), // the same house rules, or it isn't a preview
    units: structuredClone(game.units),
    scOwners: structuredClone(game.scOwners),
    pending: structuredClone(game.pending),
    history: [],
    redoStack: [],
  };
}

// `gmPublish` marks this preview as the game master's real resolution-in-
// waiting for a published game: the shadow game it resolves onto is a
// throwaway exactly like any other preview, but startPlayback() remembers the
// orders/text that produced it (playback.pendingOrders/pendingText) so
// gmPublishPreview() can commit the identical resolution for real once the
// GM is happy with it, instead of re-deriving from a possibly-since-edited box.
function previewResolve(toFinal, gmPublish = false) {
  const { orders, errors } = onOrdersChanged();
  if (errors.length) return toast('Fix the order problems first');
  const shadow = shadowGame();
  const text = $('orders-text').value;
  const entry = S.resolvePhase(shadow, orders, text);
  startPlayback(entry, true, shadow, gmPublish ? { orders, text } : null);
  if (toFinal) continuePlayback();
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
  if (boardDirty()) toast('Resolved locally — ☁ Publish changes to show the players', 'info');
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
    out = adjudicateMovement(entry.unitsBefore, revealedOrders, S.movementOpts(game));
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

// ▶ Resolve new orders! — plays the next not-yet-seen phase from
// catchUpTarget.history (already fully resolved and fetched from the gist)
// onto the real, local game, exactly like a live resolve does (see
// resolveCurrent): the game object is advanced first, then startPlayback()
// just shows it happening. endPlayback() chains straight into the next one
// while any remain, so a player who missed several phases steps through each
// in turn instead of being dropped on a board they never saw resolve.
function catchUpNext() {
  if (!catchUpTarget || playback) return;
  const raw = catchUpTarget.history[game.history.length];
  if (!raw) { catchUpTarget = null; refreshAll(); return; }
  const entry = structuredClone(raw);
  game.units = structuredClone(entry.unitsAfter);
  game.scOwners = structuredClone(entry.scOwnersAfter);
  game.pending = structuredClone(entry.pendingAfter) || null;
  game.season = entry.seasonAfter;
  game.year = entry.yearAfter;
  game.step = entry.stepAfter;
  game.history.push(entry);
  game.redoStack = [];
  S.saveGame(game);
  startPlayback(entry, false);
  playback.catchUp = true;
}

// Auto mode, deadline passed: a player can resolve the phase locally from the
// revealed on-time submissions the instant the deadline hits, without waiting
// for the GM to publish — the whole point of "auto" when the GM is asleep.
// Only offered when the gist hasn't already advanced past us (that case is the
// gist-driven catchUpTarget path instead) and we haven't already provisionally
// resolved this phase.
function localAutoResolveAvailable() {
  if (!game || !game.published || playback || catchUpTarget) return false;
  // owner drives the real resolution (manual publish / autoPublishIfDue) — this
  // optimistic local advance is for read-only players/spectators only.
  if (!isReadOnly()) return false;
  if (publishMode() !== 'auto' || !deadlinePassed()) return false;
  if (game.provisionalPhase && matchesPhase(game.provisionalPhase)) return false;
  return activePowers().some((p) => revealedEntry(p));
}

// Resolves the current phase locally from the revealed on-time submissions and
// plays it out — the player's optimistic advance ahead of the GM's real
// publish. Marked provisional (game.provisionalPhase) so reconcileProvisional-
// Phase() can defer to the gist once the GM's version lands. No gist writes.
function resolveRevealedLocally() {
  if (!localAutoResolveAvailable()) return;
  const phase = { year: game.year, season: game.season, step: game.step };
  const blocks = [];
  for (const p of activePowers()) {
    const found = phaseSubmission(p);
    const s = found && submissionOnTime(found) ? found.submission : null;
    if (s && s.orders.trim()) blocks.push(p.toUpperCase() + '\n' + s.orders.trim() + '\n');
  }
  const text = blocks.join('\n');
  const parsed = parseOrders(text, phaseKind());
  const entry = S.resolvePhase(game, parsed.orders, text);
  game.provisionalPhase = phase;
  S.saveGame(game);
  startPlayback(entry, false);
  playback.catchUp = true;
}

// Once the GM publishes the phase we optimistically resolved, defer to the
// gist. Identical outcome → just clear the provisional flag. Divergent outcome
// (GM used late-resubmit or amended) → roll our provisional phase back so the
// catch-up path replays the GM's authoritative version.
function reconcileProvisionalPhase(g, fresh) {
  if (!g.provisionalPhase) return;
  const idx = g.history.length - 1;
  if (idx < 0) return;
  const ours = g.history[idx];
  const theirs = fresh.history[idx];
  // The gist hasn't reached our provisional phase yet — nothing to reconcile.
  if (!ours || !theirs) return;
  const same = JSON.stringify(ours.unitsAfter) === JSON.stringify(theirs.unitsAfter)
    && JSON.stringify(ours.scOwnersAfter) === JSON.stringify(theirs.scOwnersAfter);
  if (same) {
    g.provisionalPhase = null;
    return;
  }
  // Divergent: undo our provisional phase and let catch-up replay the GM's.
  S.undoLastPhase(g);
  g.redoStack = [];
  g.provisionalPhase = null;
  S.saveGame(g);
}

function renderCatchUpButton() {
  const btn = $('btn-catch-up');
  if (catchUpTarget) {
    btn.hidden = false;
    const n = catchUpTarget.history.length - game.history.length;
    btn.textContent = `▶ Resolve new orders! (${n} phase${n === 1 ? '' : 's'})`;
    btn.onclick = catchUpNext;
    return;
  }
  if (localAutoResolveAvailable()) {
    btn.hidden = false;
    btn.textContent = '▶ Resolve new orders!';
    btn.onclick = resolveRevealedLocally;
    return;
  }
  btn.hidden = true;
}

// `preview` is the throwaway game the entry was resolved on (previewResolve);
// null for a real resolution or a replay of a past turn. `gmPending`, when
// set, marks this as the game master's real resolution-in-waiting for a
// published game — {orders, text} it was resolved from, for gmPublishPreview()
// to commit verbatim.
function startPlayback(entry, readonly, preview = null, gmPending = null) {
  playback = {
    entry, readonly, preview, orders: playbackOrders(entry), step: 0, animating: false,
    gmPublish: !!gmPending,
    pendingOrders: gmPending ? gmPending.orders : null,
    pendingText: gmPending ? gmPending.text : null,
  };
  setOrderMode(null);
  $('panel-orders').hidden = true;
  $('panel-edit').hidden = true;
  $('panel-playback').hidden = false;
  $('panel-playback').classList.toggle('preview', !!preview);
  $('playback-title').textContent = (preview ? '👁 Preview · ' : '') + entry.label;
  // A preview still gets to watch the moves play out — it just lands on the
  // final position instead of advancing the game (see continuePlayback).
  $('pb-continue').hidden = readonly && !preview;
  $('pb-continue').textContent = preview ? '▶ Play the moves' : 'Continue ➜';
  $('pb-branch').hidden = !preview;
  $('pb-back-current').hidden = !readonly;
  $('pb-back-current').textContent = preview ? '← Back to the live position' : 'Back to current turn';
  // The game master's real resolution-in-waiting: no sandbox branch (this
  // isn't a throwaway to keep, it's the actual next phase), Publish commits
  // it, and "back" returns to the still-loaded, still-editable order box
  // instead of the read-only "live position" a plain preview backs out to.
  if (playback.gmPublish) {
    $('pb-continue').hidden = false;
    $('pb-continue').textContent = '📣 Publish results';
    $('pb-branch').hidden = true;
    $('pb-back-current').hidden = false;
    $('pb-back-current').textContent = '← Back — amend an order';
  }
  const list = $('pb-order-list');
  list.replaceChildren();
  playback.orders.forEach((r, i) => {
    const li = document.createElement('li');
    li.textContent = `${cap(r.order.power)}: ${fmtOrder(r.order)}`;
    li.style.listStyle = 'none';
    li.style.borderLeft = `4px solid ${ARROW_COLORS[r.order.power] || '#888'}`;
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
    // A convoyed move's success depends on its carrying fleets, which may be
    // revealed on a later step; judging it against the partial prefix would
    // paint a successful convoy red until its convoyers appear. Colour those
    // moves by their final resolved verdict instead.
    const finalV = new Map();
    for (const r of entry.results || []) if (!r.order.implicit) finalV.set(prov(r.order.loc), r.verdict);
    const isConvoyed = (o) =>
      o.kind === 'move' && (o.destLoc || o.dest) &&
      !armyAdjacent(prov(o.loc), prov(o.destLoc || o.dest));
    for (let i = 0; i < revealedCount; i++) {
      const o = orders[i].order;
      const v = isConvoyed(o) ? finalV.get(prov(o.loc)) : verdictByProv.get(prov(o.loc));
      const failed = v === 'fails' || v === 'invalid';
      board.drawOrder(o, failed ? '#e05252' : ARROW_COLORS[o.power] || '#888');
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
  // Forward stepping stops at the resolution reveal (outcomeStep) — the final
  // move animation is played only by "Continue", never by stepping.
  $('pb-next').disabled = step >= outcomeStep();
}

function stepPlayback(delta) {
  if (!playback || playback.animating) return;
  // clamp to [0, outcomeStep]: the reveal is as far as stepping goes.
  const target = Math.max(0, Math.min(outcomeStep(), playback.step + delta));
  if (target === playback.step) return;
  playback.step = target;
  renderPlayback();
}

function endPlayback() {
  const wasPreview = !!(playback && playback.preview);
  const wasCatchUp = !!(playback && playback.catchUp);
  playback = null;
  // More phases to see before this browser matches the published game —
  // step straight into the next one instead of dropping back to the order
  // box in between (see catchUpNext()).
  if (wasCatchUp && catchUpTarget && game.history.length < catchUpTarget.history.length) {
    catchUpNext();
    return;
  }
  if (wasCatchUp) {
    catchUpTarget = null;
    game.publishedState = S.boardSnapshot(game);
    S.saveGame(game);
  }
  refreshAll(); // re-renders the real position over whatever the playback drew
  // a resolved-but-unpublished turn is invisible to the table, so say so once,
  // right after the moment it happens (the ● pill keeps saying it afterwards)
  if (!wasPreview && boardDirty()) {
    toast('Resolved locally — ☁ Publish changes to show the players', 'info');
  }
}

// "Continue ➜" is the only control that plays the move animation: stepping
// (▶ / → / ⏭ Skip to final order) stops at the resolution reveal. Continue
// plays every unit's move to its destination, then advances to the next phase.
function continuePlayback() {
  if (!playback || playback.animating) return;
  const pb = playback;
  pb.animating = true;
  pb.step = outcomeStep();
  renderPlayback();
  board.clearOrders(); // arrows disappear as the moves execute
  $('pb-step-label').textContent = 'Executing moves…';
  $('pb-next').disabled = true;
  board.animateFinal(pb.entry).then(() => {
    if (playback !== pb) return;
    // a preview has no next phase to advance into — it stops on the position
    // the orders would have produced, with 🌿 on hand to keep it
    if (pb.preview) {
      pb.animating = false;
      pb.step = finalStep();
      renderPlayback();
      return;
    }
    endPlayback();
  });
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
  const s = S.gameSettings(game);
  const th = $('win-thresholds');
  if (th) {
    th.textContent =
      s.soloWin === s.coalitionWin
        ? `🏆 Win: ${s.soloWin} SCs (solo & coalition)`
        : `🏆 Solo win: ${s.soloWin} SCs · Coalition win: ${s.coalitionWin} SCs`;
  }
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
// 🎲 game settings dialog (win thresholds + support house-rule)
// ---------------------------------------------------------------------------
const clampInt = (v, lo, hi, def) => {
  const n = Math.round(+v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};

function openGameSettings() {
  if (!game) return;
  const s = S.gameSettings(game);
  $('set-solo-win').value = s.soloWin;
  $('set-coalition-win').value = s.coalitionWin;
  $('set-support-rule').value = s.supportRule;
  $('set-convoy-rule').value = s.convoyRule;
  // players (read-only viewers) may inspect the rules but not change them
  const ro = isReadOnly();
  for (const id of ['set-solo-win', 'set-coalition-win', 'set-support-rule', 'set-convoy-rule'])
    $(id).disabled = ro;
  $('set-save').hidden = ro;
  $('set-cancel').textContent = ro ? 'Close' : 'Cancel';
  $('set-support-explain').hidden = true;
  $('set-convoy-explain').hidden = true;
  $('game-settings-dialog').showModal();
}

async function saveGameSettings() {
  const prev = S.gameSettings(game);
  game.settings = {
    soloWin: clampInt($('set-solo-win').value, 1, 34, 18),
    coalitionWin: clampInt($('set-coalition-win').value, 1, 34, 18),
    supportRule: $('set-support-rule').value === 'strict' ? 'strict' : 'standard',
    convoyRule: $('set-convoy-rule').value === 'strict' ? 'strict' : 'standard',
  };
  S.saveGame(game);
  $('game-settings-dialog').close();
  renderStandings();
  onOrdersChanged(); // re-validate: a rule change can flip which orders work
  const ruleChanged =
    prev.supportRule !== game.settings.supportRule ||
    prev.convoyRule !== game.settings.convoyRule;
  if (ruleChanged && game.history.length)
    toast('House rule changed — it applies to future resolutions only', 'info');
  else toast('Game settings saved', 'info');
  // push to the published gist so every player sees the same rules; the
  // board override keeps the GM's in-progress position out of it
  if (game.published && game.isOwner) {
    try {
      await updatePublished(game, game.publishedState);
    } catch (e) {
      toast('Saved locally, but could not publish the change: ' + e.message);
      if (isAuthError(e)) askToken();
    }
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
  // undoing a published turn walks the official position backwards — fine (it
  // is how a GM fixes a mis-entered order) but worth being deliberate about
  if (isOwnerView() && game.published && game.history.length && !confirm(
    `Undo ${game.history[game.history.length - 1].label} on the official game?\n\n` +
    'The board goes back a phase and your orders return to the box. ' +
    'Players keep seeing the published position until you ☁ Publish changes again.'
  )) return;
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

// ---------------------------------------------------------------------------
// branching — the one escape hatch from every read-only situation
// ---------------------------------------------------------------------------
// `src` is any position: the live game, or the throwaway one a preview
// resolved into ("keep this outcome"). What comes back is always a plain
// sandbox, with a note saying where it came from so it can be found again.
function branchFrom(src, atLabel) {
  const name = prompt('Name for the sandbox:', uniqueName(`${game.name} sandbox`));
  if (!name) return;
  const g = S.branchGame(src, uniqueName(name), {
    name: game.name,
    gistId: isOnline() ? game.gistId : null,
    label: atLabel,
    at: new Date().toISOString(),
  });
  openGame(g);
  toast('🧪 Sandbox created — rearrange, resolve and try anything', 'info');
}

function branchCurrent() {
  if (playback && playback.preview) {
    return branchFrom(playback.preview, `after ${playback.entry.label}`);
  }
  branchFrom(game, S.phaseLabel(game));
}

// ⚙ → ↩ Open source game. A sandbox branched off an online game should not
// need a trip through the home screen to get back to the real one.
function openBranchSource() {
  const b = game.branchedFrom;
  if (!b) return;
  if (b.gistId) return loadPublishedGame(b.gistId);
  const src = S.listGames()[b.name];
  if (src) return openGame(src);
  toast(`“${b.name}” is no longer saved in this browser`);
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

// Trusted wall clock: the local device time corrected by the offset to
// GitHub's server `Date` header (captured on every gist read). A player can
// spoof Date.now() to peek at auto-mode orders early; they cannot spoof
// GitHub's server clock. Falls back to the raw local clock until the first
// server date is seen (offline/first paint) — the safe direction, since a
// player with no network simply can't reveal yet.
function trustedNow() {
  return Date.now() + (online.serverOffset || 0);
}

function deadlinePassed() {
  const d = deadlineDate();
  return !!d && d.getTime() <= trustedNow();
}

// A deadline is confirmed for one specific phase (game.deadlineFor, stamped by
// setDeadline) — "orders for Spring 1901 are due at 11pm", never a bare
// timestamp floating free of what it was due for. Once the board moves on, the
// old timestamp is stale and must not gate anything again.
//
// This exists because it didn't, once. A game master playing their own power
// (🎭 Play as) used the player-side ▶ Resolve new orders! button, which
// advances the board optimistically and — correctly, for a player — neither
// clears the deadline nor writes anything. autoPublishIfDue() then woke up,
// saw only "deadline in the past", and published the NEXT phase, for which
// nobody had submitted anything, as an all-hold. Asking "in the past?" without
// also asking "for this phase?" lets one expired deadline consume every phase
// it is carried into.
//
// Deliberately lenient about a missing stamp: games published before this
// existed carry a deadline and no deadlineFor, and must keep resolving. The
// guards in autoPublishIfDue() cover that case from the other side.
function deadlineIsForCurrentPhase() {
  if (!game || !game.deadline) return false;
  if (!game.deadlineFor) return true;
  return matchesPhase(game.deadlineFor);
}

// Orders can only be submitted while a deadline is set and hasn't passed yet
// — with no deadline at all there is nothing to be "on time" against.
function ordersOpen() {
  return !!game.deadline && !deadlinePassed();
}

// Has the game master specifically authorized `p` to (re)submit after the
// deadline for the phase on the table right now? Keyed to the exact phase
// so an authorization never silently carries over once the game moves on.
function lateResubmitAllowed(p) {
  const m = game.lateResubmit && game.lateResubmit[p];
  return !!(m && matchesPhase(m));
}

// Whether `p` may (re)submit at all: the normal deadline window, or a GM's
// explicit late-resubmit authorization for this exact phase.
function isSubmitAllowed(p) {
  return ordersOpen() || lateResubmitAllowed(p);
}

// In auto mode a comment edited after the deadline is void — judged by
// GitHub's own updated_at stamp, never the client-claimed submittedAt.
function submissionOnTime(found) {
  const d = deadlineDate();
  return !d || !found.updatedAt || new Date(found.updatedAt) <= d;
}

// Submissions reach us sealed and are decrypted in refreshOnlineStatus, so by
// the time anything here looks at one it holds cleartext `orders`. One that
// still doesn't (no key on this browser, or a blob that won't open) is treated
// as no submission at all — visibly "waiting", rather than quietly resolved or
// published as a power that ordered nothing.
const readable = (s) => !!s && typeof s.orders === 'string';

// The power's valid submission comment for the current phase, or null.
function phaseSubmission(p) {
  const login = (game.players || {})[p];
  const found = login && online.comments && findSubmission(online.comments, login);
  if (found && readable(found.submission) && matchesPhase(found.submission) && found.submission.power === p) return found;
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
  $('btn-submit-moves').hidden = !assignedPower();
  $('submit-status').hidden = !assignedPower();
  $('online-row').hidden = !hasPlayers;
  renderCatchUpButton();
  const loadMovesBtn = $('btn-load-moves');
  if (assignedPower()) {
    loadMovesBtn.title = 'Replace the box with your currently published orders, discarding local changes';
    // disabled state (greyed out once the box already matches) is kept in
    // step with every keystroke by renderSubmitStatus(), not here
  } else {
    loadMovesBtn.disabled = false;
    loadMovesBtn.title = "Fill the order box with every power's submitted moves for the current phase";
  }
  if (game.published && isOwnerView()) {
    const loadBtn = $('deadline-load-btn');
    loadBtn.disabled = ordersOpen() || gmOrdersLoaded;
    loadBtn.title = gmOrdersLoaded
      ? 'Already loaded — resolve or publish below'
      : ordersOpen()
        ? 'Available once the deadline passes (or clear it to load and skip forward now)'
        : "Loads submitted orders once the deadline passes — or, with no deadline set, opens an empty box so you can skip the game forward";
  }
  renderSubmitStatus();
  updateDeadlineCountdown();
  if (hasPlayers) renderDeadlineInfo();
  // only re-render the submissions modal's contents while it's actually open —
  // it's no longer part of the always-visible sidebar, so there's no need to
  // keep it in step on every poll otherwise
  if (game.published && isOwnerView() && !$('submissions-modal').hidden) renderSubmissionsModal();
}

// Order text reduced to what the game actually cares about, so "have I changed
// my orders since I submitted them?" ignores comments, spacing and case.
function normalizeOrders(text) {
  return (text || '')
    .split('\n')
    .map((l) => l.split('#')[0].trim().toLowerCase().replace(/\s+/g, ' '))
    .filter(Boolean)
    .join('\n');
}

// My own submission comment for the current phase, or null — the "currently
// published" record a player's box is compared against and can reload from.
function mySubmission() {
  const p = assignedPower();
  if (!p) return null;
  const found = online.comments && online.login && findSubmission(online.comments, online.login);
  const s = found && found.submission;
  return readable(s) && matchesPhase(s) && s.power === p ? s : null;
}

function renderSubmitStatus() {
  const p = assignedPower();
  if (!p) return;
  const el = $('submit-status');
  const btn = $('btn-submit-moves');
  const loadBtn = $('btn-load-moves');
  const status = powerOnlineStatus(p);
  const s = mySubmission();
  // "Load published moves" resets the box back to what's on record for me —
  // there is nothing to reset once the box already matches it.
  const matchesRecord = s && normalizeOrders(powerBlockText(p)) === normalizeOrders(s.orders);
  loadBtn.disabled = !s || matchesRecord;
  el.classList.remove('drift');
  btn.classList.remove('primary');
  // Label reflects whether *anything* has been submitted for this phase yet,
  // independent of whether the button is currently enabled.
  btn.textContent = s ? '🔁 Re-submit orders' : '📤 Submit orders';
  el.classList.toggle('done', status === 'published' || status === 'revealed' || status === 'submitted');
  const allowed = isSubmitAllowed(p);
  if (status === 'published') {
    btn.disabled = true;
    el.textContent = '✓ Published — your moves are locked in for this phase';
    return;
  }
  if (status === 'revealed') {
    btn.disabled = true;
    el.textContent = '✓ Revealed — the deadline passed and everyone can see your moves';
    return;
  }
  if (status === 'late') {
    btn.disabled = !allowed;
    el.textContent = allowed
      ? '⚠ Edited after the deadline — your game master has allowed you to resubmit'
      : '⚠ Edited after the deadline — this submission is void';
    return;
  }
  if (!allowed) {
    btn.disabled = true;
    el.textContent = deadlinePassed()
      ? 'Deadline passed — submissions are closed'
      : "No deadline set yet — ask your game master, then you can submit";
    return;
  }
  if (s) {
    // Dragging a unit rewrites the order box, and that is indistinguishable
    // from dragging one *before* submitting — so say outright when the box and
    // the submission have parted company. Otherwise "✓ Submitted" quietly
    // refers to orders that are no longer the ones on screen.
    if (!matchesRecord) {
      btn.disabled = false;
      el.classList.remove('done');
      el.classList.add('drift');
      el.textContent = '✎ The box no longer matches what you submitted — 🔁 Re-submit to update it';
      btn.classList.add('primary');
      return;
    }
    btn.disabled = true;
    const when = s.submittedAt ? ' · ' + new Date(s.submittedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '';
    // Say which it was. Falling back to cleartext when the gist has no key
    // keeps the game playable, but a player should never have to guess whether
    // their orders are sitting in public view.
    el.textContent = online.sealKey
      ? `🔒 Submitted${when}`
      : `✓ Submitted${when} · unencrypted (this game has no key)`;
  } else {
    btn.disabled = false;
    el.textContent = 'Not submitted for this phase yet';
    el.classList.remove('done');
    btn.classList.add('primary');
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
    // This element sits in the (player/spectator-only, once a GM has loaded
    // orders it's the GM's too) online-row — the game master's own copy stays
    // hidden behind gmGated until they ⬇ Load orders, so the isOwnerView()
    // case here only ever shows to the GM in the brief window after loading.
    el.textContent =
      publishMode() === 'auto'
        ? `⏰ Deadline passed (${when}) — all submissions are revealed. ⬇ Load them, then Resolve to preview the result`
        : isOwnerView()
          ? `⏰ Deadline passed (${when}) — ⬇ Load orders in the ⏰ Deadline panel, resolve, then publish`
          : `⏰ Deadline passed (${when}) — the game master is resolving the results`;
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
  // Stamp the phase this deadline is for, so it can never outlive it — see
  // deadlineIsForCurrentPhase().
  game.deadlineFor = date ? { year: game.year, season: game.season, step: game.step } : null;
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

// GM: how the deadline resolves — auto-resolve on its own, or load and
// resolve it yourself.
async function setPublishMode(mode) {
  game.publishMode = mode;
  S.saveGame(game);
  renderOnlineUI();
  try {
    await updatePublished(game, game.publishedState);
    toast(
      mode === 'auto'
        ? 'Auto publish: the phase resolves and publishes itself the moment the deadline passes'
        : 'Manual publish: after the deadline, ⬇ Load orders and resolve/publish it yourself',
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
      lateResubmitAllowed(p)
        ? mk('🔓', `${cap(p)} may resubmit past the deadline for this phase — click to revoke`, () => setLateResubmit(p, false))
        : mk('🔒', `Locked to the normal deadline — click to let ${cap(p)} (re)submit past it for this phase`, () => setLateResubmit(p, true)),
    );
    rows.appendChild(row);
  }
}

// GM: authorize (or revoke authorization for) a power to submit/resubmit
// orders after the deadline has passed, for the phase on the table right
// now only — see lateResubmitAllowed().
async function setLateResubmit(power, allow) {
  game.lateResubmit = { ...(game.lateResubmit || {}) };
  if (allow) game.lateResubmit[power] = { year: game.year, season: game.season, step: game.step };
  else delete game.lateResubmit[power];
  S.saveGame(game);
  renderSubmissionsModal();
  try {
    await updatePublished(game, game.publishedState);
    toast(allow ? `${cap(power)} may resubmit past the deadline for this phase` : `Late resubmission revoked for ${cap(power)}`, 'info');
    await refreshOnlineStatus();
  } catch (e) {
    toast('Could not save the authorization: ' + e.message);
    if (isAuthError(e)) askToken();
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

// ---- 🎭 play as (game master / own assigned power) -------------------------
// When the game master has assigned their own GitHub login to a power in 👥
// Set players, this lets them switch between running the game and genuinely
// playing that power — real private drafts, a real 📤 Submit that posts a
// real gist comment under their own login, the same deadline rules as any
// other player. Switching back to Game Master never touches or reverts a
// submission; it's purely a change of which UI this browser shows.

// Populates and shows/hides the Settings-menu "Play as" picker. Called from
// refreshAll() so it stays in sync with published state and player
// assignments (game.assignedPower is refreshed by refreshOnlineStatus()).
function renderPlayAsControls() {
  const row = $('play-as-row');
  const canPlay = !!(game && game.published && game.isOwner && game.assignedPower);
  row.hidden = !canPlay;
  if (!canPlay) return;
  const sel = $('play-as-select');
  sel.options[1].textContent = `${POWER_FLAGS[game.assignedPower] || ''} ${cap(game.assignedPower)}`;
  sel.value = isPlayingAsPlayer() ? 'player' : 'gm';
}

function setPlayAs(mode) {
  if (!game) return;
  const toPlayer = mode === 'player';
  game.playAs = toPlayer ? 'player' : 'gm';
  S.saveGame(game);
  refreshAll();
  // Switching into playing your own power should surface your submitted
  // orders the same way opening the game on a second device does. refreshAll()
  // has just reset the box to the blank template, so re-arm the one-shot
  // restore (an earlier GM-view poll never consumed it — assignedPower() was
  // empty then) and fill the box from this phase's submission comment now,
  // rather than leaving it blank until the next background poll.
  if (toPlayer) {
    online.restored = false;
    maybeRestoreSubmission();
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

// The published position as a viewer should see it. Deliberately NOT
// state.js's boardSnapshot(): that includes redoStack, which is the game
// master's private undo bookkeeping. A viewer who catches up clears their own
// (catchUpNext) while the gist may still carry the GM's, and that difference
// is not a divergence — comparing it would reload the board on every refresh.
function viewerPosition(g) {
  return JSON.stringify({
    year: g.year,
    season: g.season,
    step: g.step,
    units: g.units,
    scOwners: g.scOwners,
    pending: g.pending || null,
    history: g.history || [],
  });
}

// True when the gist is simply further along the same road: every phase we
// have seen is still there, unchanged, with more on the end.
function extendsOurHistory(g, fresh) {
  const ours = g.history || [];
  if (fresh.history.length <= ours.length) return false;
  return JSON.stringify(fresh.history.slice(0, ours.length)) === JSON.stringify(ours);
}

// Take the gist's position in place of ours. Mutates `g` rather than replacing
// the game object (revertToPublished() can reassign `game`; this runs inside
// refreshOnlineStatus(), which holds its own reference and would lose it), and
// touches the position only — name, gist identity, country and play-as choice
// are the viewer's, not the gist's. The order box is left alone on purpose,
// exactly as in revertToPublished(): an unsubmitted draft is worth more than a
// position that can always be re-fetched.
function adoptPublishedPosition(g, fresh) {
  playback = null;
  catchUpTarget = null;
  g.year = fresh.year;
  g.season = fresh.season;
  g.step = fresh.step;
  g.units = structuredClone(fresh.units);
  g.scOwners = structuredClone(fresh.scOwners);
  g.pending = structuredClone(fresh.pending) || null;
  g.history = structuredClone(fresh.history || []);
  g.redoStack = structuredClone(fresh.redoStack || []);
  g.publishedState = S.boardSnapshot(g);
  S.saveGame(g);
  refreshAll();
}

// A read-only viewer's local board, reconciled against the gist on every
// refresh. Three outcomes:
//   • The gist has phases we haven't seen, on top of the ones we have — the
//     normal case. Flag it so ▶ Resolve new orders! walks the viewer through
//     each one rather than teleporting them (see catchUpNext).
//   • The gist's position is no longer one our history leads to: the game
//     master undid a phase, or edited the board. Ours is then a position that
//     does not exist anymore, and there is nothing to step *through* — so take
//     theirs and say so. Previously this case was simply not detected (the
//     check was `fresh.history.length > g.history.length`), which left a
//     viewer parked on a retracted phase indefinitely, still able to replay
//     orders the game master had since pulled back. Comparing the position
//     rather than the history length also catches ✏ Edit board changes, which
//     never touch history at all.
//   • Identical — nothing to do.
function syncViewerToGist(g, fresh) {
  catchUpTarget = null;
  // An optimistic local resolve is *meant* to sit ahead of the gist until the
  // GM publishes; reconcileProvisionalPhase() owns that comparison.
  if (g.provisionalPhase) return;
  if (viewerPosition(g) === viewerPosition(fresh)) return;
  if (extendsOurHistory(g, fresh)) {
    catchUpTarget = fresh;
    return;
  }
  // isReadOnly() is also true for the game master while 🎭 Playing as their own
  // power — but that is still the GM's own authoritative copy, possibly holding
  // unpublished work. Never overwrite it; ⟲ Revert to published is their door.
  if (g.isOwner) return;
  adoptPublishedPosition(g, fresh);
  toast('The game master changed the board — reloaded the published position', 'info');
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
    // The seal key rides along in the gist we just fetched, so reading it costs
    // nothing. The owner writes one on the first load of a game that has none,
    // which is how games published before sealing existed pick it up.
    let sealKey = await readSealKey(gistJson);
    if (!sealKey && g.isOwner && getToken()) {
      try { sealKey = await ensureSealKey(g.gistId, gistJson); } catch { /* next poll */ }
    }
    const comments = await unsealComments(await listComments(g.gistId), sealKey, g.gistId);
    const token = getToken();
    const login = token ? await getAuthenticatedLogin(token) : null;
    if (game !== g) return; // user switched games while we were fetching
    if (fresh && fresh.players) g.players = fresh.players;
    if (fresh) {
      // deadline/publishMode/settings are pushed to the gist immediately by
      // their own setters (setDeadline, setPublishMode), never batched with
      // a board publish — so the gist is authoritative for them even on an
      // owner's OWN device: opening the game on a second device (or a stale
      // tab) must not keep showing whatever deadline happened to be cached
      // locally at last load. Only board state (units/scOwners/pending/
      // history) stays local-authoritative for the owner, since that's the
      // GM's possibly-unpublished in-progress position.
      g.deadline = fresh.deadline || null;
      g.deadlineFor = fresh.deadlineFor || null; // travels with it, always
      g.publishMode = fresh.publishMode || null;
      // the GM owns the rules — pick up any change so every player's board,
      // standings reminder, and local previews match the GM's resolution
      if (fresh.settings) g.settings = { ...S.DEFAULT_SETTINGS, ...fresh.settings };
      renderStandings();
    }
    online.moves = moves;
    online.sealKey = sealKey;
    online.comments = comments;
    applyJustWrote(); // a submit of ours the fetched list may not show yet
    online.login = login;
    // Correct our clock against GitHub's server time so the deadline gate
    // (deadlinePassed → trustedNow) can't be beaten by a spoofed device clock.
    const serverDate = getLastServerDate();
    if (serverDate) {
      const parsed = Date.parse(serverDate);
      if (!isNaN(parsed)) online.serverOffset = parsed - Date.now();
    }
    // Resolved for the owner too — that's what lets a GM who assigned
    // themselves a power in 👥 Set players genuinely 🎭 Play as that power.
    let assigned = null;
    if (login && g.players) {
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
    // If this browser optimistically resolved a phase locally (auto mode, see
    // resolveRevealedLocally) and the GM has since published that same phase,
    // reconcile: the gist is authoritative. When the GM's published outcome
    // matches ours (the common case — same adjudicator, same on-time orders),
    // just confirm it. When it diverges (GM used late-resubmit or amended),
    // roll our provisional phase back so the catch-up path below replays the
    // GM's real version.
    if (fresh && Array.isArray(fresh.history)) reconcileProvisionalPhase(g, fresh);
    if (fresh && isReadOnly() && Array.isArray(fresh.history)) syncViewerToGist(g, fresh);
    if (changed) {
      renderCountrySelect();
      prefillOrders(true);
      onOrdersChanged();
    }
    maybeRestoreSubmission();
    renderOnlineUI();
    renderPlayAsControls();
    ensureMyMailbox(g); // fire-and-forget; see below
  } catch {
    // offline or rate-limited — keep whatever state we already had
  }
}

// Makes sure this player already has an (empty) mailbox comment on the gist,
// long before they submit anything into it.
//
// GitHub emails the body of a newly created gist comment to everyone
// subscribed to the gist — the whole table — and sends nothing at all when one
// is edited. So the mailbox is created here, on load, rather than at submit
// time: the single "X commented" notification it produces then lands when the
// player opens the game, carrying neither orders nor any hint of when they
// wrote them. Every actual submission afterwards is a silent edit.
//
// The gap matters, and cannot be measured. GitHub renders a notification's
// body when its mailer runs rather than capturing it at creation, and that
// delay is undocumented and unbounded — a mailbox created empty and filled one
// second later was mailed out complete with the orders. So creating it here,
// at load, is not a tidiness preference: it is the only way to make the gap
// large (minutes to days) instead of accidental. It is still not a guarantee,
// which is why the orders are sealed as well (js/seal.js).
//
// This is where a comment is created in normal play, and it decides from
// online.comments — the list refreshOnlineStatus() has just fetched, i.e.
// server truth. Never from a remembered id: that is what made a deleted
// mailbox invisible. Finding one still records its id, because a remembered id
// is what lets submitOrders() PATCH with no read in front of it. (submitOrders
// can create too, but only as a last resort, and only sealed — see
// createSubmission in publish.js.)
//
// It costs no extra request: refreshOnlineStatus() has already fetched every
// comment, so "do I have one?" is a lookup in memory. It re-decides on every
// refresh rather than latching, so a deleted mailbox is remade the next time
// anything refreshes — a reload, a 🔄, opening the game again. Nothing polls
// the network on a timer (see the 60s tick in init) and nothing should: the
// point is that the mailbox exists from the moment the player opens the game.
async function ensureMyMailbox(g) {
  if (creatingMailbox) return;
  if (!g.published || !g.gistId || !online.comments || !online.login) return;
  if (!g.assignedPower || !getToken()) return;
  const existing = findMyMailbox(online.comments, online.login);
  if (existing) {
    rememberMailbox(g.gistId, online.login, existing.id);
    return;
  }
  creatingMailbox = true;
  try {
    // Folded into online.comments immediately: the next poll's list may have
    // been fetched before this POST landed, and without this we would read it
    // as "still no mailbox" and post a second one.
    rememberWrite(await createMailbox(g.gistId, online.login));
  } catch {
    // transient — the next poll tries again
  } finally {
    creatingMailbox = false;
  }
}

// Whenever a player opens the game, put their currently published orders
// back into the box (multi-device continuity) — unless they have already
// started drafting this session.
function maybeRestoreSubmission() {
  if (online.restored) return;
  const p = assignedPower();
  if (!p || !online.comments || !online.login) return;
  const s = mySubmission();
  if (!s) return;
  online.restored = true;
  if (parseOrders(powerBlockText(p), phaseKind()).orders.length) return;
  replacePowerBlock(p, s.orders);
  toast('Loaded your published orders', 'info');
}

async function doSubmitMoves() {
  const power = assignedPower();
  if (!power) return;
  if (!isSubmitAllowed(power)) {
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
    const { comment, sealed } = await submitOrders(game.gistId, {
      power, year: game.year, season: game.season, step: game.step,
      orders: block,
    }, online.sealKey);
    online.restored = true; // what's in the box IS the submission now
    rememberWrite(comment); // the cleartext copy — see submitOrders
    renderSubmitStatus(); // reflect the submit at once, off our own write
    toast(`Orders submitted for ${cap(power)}${sealed ? '' : ' (unencrypted)'}`, 'info');
    await refreshOnlineStatus();
  } catch (e) {
    toast('Submit failed: ' + e.message);
    if (isAuthError(e)) askToken();
  } finally {
    renderSubmitStatus();
  }
}

// An assigned player: replaces just their own block with what's currently on
// record for them (their latest submission comment), discarding local edits.
// Everyone else (spectators, or the GM previewing before a resolve): fills
// the box with every power's revealed moves for the current phase —
// published file entries, plus (auto mode, past deadline) on-time
// submissions straight from the comments.
async function doLoadPublishedMoves() {
  const btn = $('btn-load-moves');
  btn.disabled = true;
  try {
    // no dedicated refresh button — this is also how a viewer re-checks for
    // new submissions/published moves
    await refreshOnlineStatus();
    const power = assignedPower();
    if (power) {
      const s = mySubmission();
      if (!s) return toast('Nothing published for you yet this phase');
      replacePowerBlock(power, s.orders);
      toast('Reloaded your published orders', 'info');
      return;
    }
    const blocks = [];
    for (const p of POWERS) {
      const entry = revealedEntry(p);
      if (entry && entry.orders.trim()) blocks.push(p.toUpperCase() + '\n' + entry.orders.trim() + '\n');
    }
    if (!blocks.length) return toast('No published moves for this phase yet');
    applyOrdersText(blocks.join('\n'));
    toast(`Loaded moves for ${blocks.length} power${blocks.length === 1 ? '' : 's'}`, 'info');
  } finally {
    renderSubmitStatus();
    if (!assignedPower()) btn.disabled = false;
  }
}

// GM: fills the order box with every power's submitted comment for the
// current phase and opens it (gmOrdersLoaded), the one on-ramp into the
// resolve → publish flow. Gated on !ordersOpen(): either the deadline has
// passed (the normal case), or none was ever set — the deliberate escape
// hatch that lets the GM skip the game forward on an empty box and type
// orders in by hand. Loading never publishes anything by itself.
async function gmLoadOrders() {
  if (ordersOpen()) return toast('Wait for the deadline before loading orders');
  try {
    if (!online.comments) await refreshOnlineStatus();
    // Every active power gets a header — submitted powers get their orders,
    // everyone else gets the blank per-phase template — so the box always
    // shows the full roster to fill in by hand, submissions or not.
    const defaultByPower = splitOrdersByPower(defaultOrdersText());
    const blocks = [];
    let submitted = 0;
    for (const p of activePowers()) {
      const found = phaseSubmission(p);
      const s = found && found.submission;
      if (s && s.orders.trim()) {
        blocks.push(p.toUpperCase() + '\n' + s.orders.trim() + '\n');
        submitted++;
      } else if (defaultByPower.has(p)) {
        blocks.push(defaultByPower.get(p).join('\n'));
      }
    }
    applyOrdersText(blocks.join('\n'));
    gmOrdersLoaded = true;
    refreshAll();
    toast(
      submitted
        ? `Loaded ${submitted} submission${submitted === 1 ? '' : 's'} — resolve when ready`
        : 'No submissions yet — order box is open for you to fill in',
      'info'
    );
  } catch (e) {
    toast('Could not load orders: ' + e.message);
  }
}

// Writes one moves-<power>.json entry per power that had orders in `text`
// (the box the GM just resolved from) — a durable record of what was
// actually published, same shape as a normal submission but `publishedBy:
// 'gm'`. Always overwrites any existing entry for this phase: whatever was
// in the box when Publish was clicked is the record, including any manual
// edit the GM made — there is no separate "force" path anymore.
async function gmWriteLoadedMovesFiles(text) {
  const byPower = splitOrdersByPower(text);
  if (!byPower.size) return;
  const moves = await readMovesFiles(await fetchGist(game.gistId));
  const updates = {};
  for (const [p, lines] of byPower) {
    const ordersText = lines.slice(1).join('\n').trim();
    if (!ordersText) continue;
    updates[p] = upsertMovesEntry(moves[p], p, {
      year: game.year, season: game.season, step: game.step, orders: ordersText,
      by: online.login || 'game master', submittedAt: null,
      publishedAt: new Date().toISOString(), publishedBy: 'gm',
    });
  }
  if (Object.keys(updates).length) await writeMovesFiles(game.gistId, updates);
}

// GM: commits the previewed resolution for real and pushes it to the table —
// the "📣 Publish results" button on a gmPublish preview (see previewResolve/
// startPlayback). Plays the same move animation a normal Continue does, then
// resolves the REAL game with the exact orders/text the preview used
// (playback.pendingOrders/pendingText), records each power's published
// moves, and pushes the new position. The deadline is cleared afterward so
// a stale "already passed" timestamp can never carry over and auto-publish
// the next phase on an empty box — the GM confirms a fresh one every phase.
async function gmPublishPreview() {
  if (!playback || !playback.gmPublish || playback.animating) return;
  const pb = playback;
  pb.animating = true;
  pb.step = outcomeStep();
  renderPlayback();
  board.clearOrders();
  $('pb-step-label').textContent = 'Executing moves…';
  $('pb-next').disabled = true;
  await board.animateFinal(pb.entry);
  if (playback !== pb) return;
  try {
    const entry = S.resolvePhase(game, pb.pendingOrders, pb.pendingText);
    S.saveGame(game);
    await gmWriteLoadedMovesFiles(pb.pendingText);
    game.deadline = null;
    game.deadlineFor = null;
    await updatePublished(game);
    game.publishedState = S.boardSnapshot(game);
    S.saveGame(game);
    gmOrdersLoaded = false;
    playback = null;
    refreshAll();
    toast(`Published ${entry.label} — confirm the next deadline in ⏰ Deadline`, 'info');
  } catch (e) {
    pb.animating = false;
    toast('Publish failed: ' + e.message);
    if (isAuthError(e)) askToken();
  }
}

// Auto-publish mode's whole point: no GM action required. Runs off the 60s
// online-status tick (only in the GM's own browser — only it can advance the
// game) and, once the deadline for the phase on the table has passed, loads
// on-time submissions, resolves and publishes exactly like gmPublishPreview()
// would, skipping the step-through UI entirely.
//
// Gated on isOwnerView(), so it stands down entirely while the GM is 🎭
// Playing as their own power. This was once the raw game.isOwner fact, on the
// reasoning that play-as is a view change rather than a different browser and
// auto-publish should not care — but in that mode the GM is *also* offered the
// player-side ▶ Resolve new orders! button, and the two paths ran into each
// other: the button advanced the board optimistically (no gist write, deadline
// untouched, by design) and this function then published the following phase
// off the same expired deadline, all-hold, with nobody having ordered. The two
// cannot share a browser, so the view decides which one is live: playing your
// power gives you the player's optimistic resolve, running the game gives you
// auto-publish. Switch back to the GM view (⚙ Settings → 🎭 Play as) and the
// next tick publishes as normal.
//
// It also stands down while a preview is open (`playback`), so it never yanks
// the board out from under one.
async function autoPublishIfDue() {
  if (!game || !game.published || !isOwnerView() || playback || autoPublishing) return;
  if (publishMode() !== 'auto') return;
  if (!deadlineIsForCurrentPhase() || !deadlinePassed()) return;
  // The board came from an optimistic local resolve that no GM has confirmed
  // (a play-as session earlier in this browser). Its phase is not ours to
  // publish — belt and braces for games too old to carry a deadlineFor stamp.
  if (game.provisionalPhase) return;
  autoPublishing = true;
  try {
    await refreshOnlineStatus();
    // refreshOnlineStatus() re-reads deadline/deadlineFor/publishMode from the
    // gist (it is authoritative for all three), so re-test before committing
    // to a resolution — the GM may have moved the deadline from another device
    // in the moments since the gate above.
    if (publishMode() !== 'auto' || !deadlineIsForCurrentPhase() || !deadlinePassed()) return;
    const blocks = [];
    for (const p of activePowers()) {
      const found = phaseSubmission(p);
      const s = found && submissionOnTime(found) ? found.submission : null;
      if (s && s.orders.trim()) blocks.push(p.toUpperCase() + '\n' + s.orders.trim() + '\n');
    }
    // Not one power submitted anything readable and on time. Resolving that is
    // a whole-board all-hold nobody asked for — never a result worth committing
    // unattended, and the shape every "the deadline outlived its phase" bug
    // takes. Stand down and leave it to the GM. Note this counts *submissions*,
    // not orders: a power that deliberately submits nothing but holds has a
    // non-empty block and counts, which is the (rare, legal) all-hold phase
    // players actually chose.
    if (!blocks.length) {
      const label = S.phaseLabel(game);
      if (autoPublishIdleFor !== label) {
        autoPublishIdleFor = label;
        toast(
          `Auto-publish paused — no orders were submitted for ${label}. ` +
          'Resolve it yourself in ⏰ Deadline, or confirm a new deadline to re-open submissions.'
        );
      }
      return;
    }
    const text = blocks.join('\n');
    const parsed = parseOrders(text, phaseKind());
    const entry = S.resolvePhase(game, parsed.orders, text);
    S.saveGame(game);
    await gmWriteLoadedMovesFiles(text);
    game.deadline = null;
    game.deadlineFor = null;
    await updatePublished(game);
    game.publishedState = S.boardSnapshot(game);
    S.saveGame(game);
    autoPublishIdleFor = null;
    refreshAll();
    toast(`Auto-published ${entry.label} — confirm the next deadline`, 'info');
  } catch (e) {
    toast('Auto-publish failed: ' + e.message);
  } finally {
    autoPublishing = false;
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
    delete game.branchedFrom; // it is its own game now, not a copy of one
    game.publishedState = S.boardSnapshot(game);
    S.saveGame(game);
    refreshAll();
    const shareLink = `${location.origin}${location.pathname}?gist=${id}`;
    prompt(
      'Published — this sandbox is now the live game, and you are its game master. ' +
      'Send this link to every player: they get the position live, can pick their ' +
      'country to draft orders, and can preview or branch freely without ever ' +
      'touching it. Assign their GitHub usernames in 👥 Set players so they can ' +
      'submit in-app. After you resolve a turn, "☁ Publish changes" is what the ' +
      'table sees.',
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
  try {
    await updatePublished(game);
    game.publishedState = S.boardSnapshot(game);
    S.saveGame(game);
    $('btn-update-published').disabled = !boardDirty();
    updateSyncPill();
    const d = deadlineDate();
    const hasPlayers = game.players && Object.values(game.players).some(Boolean);
    if (hasPlayers && (!d || d.getTime() <= Date.now())) {
      toast(`Published ${S.phaseLabel(game)} — now confirm the next deadline in ⏰ Deadline`, 'info');
    } else {
      toast(`Published — every player now sees ${S.phaseLabel(game)}`, 'info');
    }
  } catch (e) {
    toast('Publish failed: ' + e.message);
    if (isAuthError(e)) askToken();
  }
}

// The way back from any accident on a published game: throw the local copy
// away and take the gist's again — the button that resolves a divergence the
// other way from ☁ Publish changes. The order box is deliberately left alone —
// an unsubmitted draft is the one thing here worth more than the position,
// which can always be re-fetched.
async function revertToPublished() {
  if (!isOnline() || !game.gistId) return;
  if (!confirm(
    'Reload the published position?\n\n' +
    'Every local change to this game\'s board, phase and history is thrown away ' +
    'and replaced with what is on the shared link. Your draft orders stay in the box.'
  )) return;
  try {
    const { game: fresh } = await fetchPublished(game.gistId);
    const keep = {
      name: game.name,
      gistId: game.gistId,
      gistUrl: game.gistUrl,
      published: true,
      isOwner: game.isOwner,
      myCountry: game.myCountry,
      assignedPower: game.assignedPower,
      playAs: game.playAs,
    };
    playback = null;
    game = Object.assign(S.importGame(JSON.stringify(fresh)), keep);
    game.settings = S.gameSettings(game);
    game.publishedState = S.boardSnapshot(game);
    S.saveGame(game);
    refreshAll();
    toast('Reloaded the published position', 'info');
    refreshOnlineStatus();
  } catch (e) {
    toast('Could not reload: ' + e.message);
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
    // A returning read-only viewer keeps the board they last saw — jumping
    // straight to whatever the gist now holds would drop them onto a new
    // position without ever showing them how it got there. Instead open the
    // local copy as-is and let ▶ Resolve new orders! (see catchUpNext()) walk
    // them through anything published since.
    if (!isOwner && local) {
      openGame(local);
      if (Array.isArray(fetched.history) && fetched.history.length > local.history.length) {
        catchUpTarget = fetched;
        renderCatchUpButton();
      }
      return;
    }
    const g = S.importGame(JSON.stringify(fetched));
    g.gistId = id;
    g.published = true;
    g.isOwner = isOwner;
    g.name = uniqueName(g.name || 'Published game');
    g.myCountry = null;
    g.assignedPower = null;
    g.playAs = null;
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
  $('import-file').onchange = (e) => e.target.files[0] && importFile(e.target.files[0]);
  $('btn-home').onclick = () => {
    // a GM walking away from an unpublished turn is the one exit worth
    // catching: the table is still waiting on a board only this browser has
    if (boardDirty() && !confirm(
      'This game has changes that are not published yet.\n\n' +
      'Leave anyway? They stay saved here — ☁ Publish changes when you come back.'
    )) return;
    playback = null;
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
    b.onclick = () => selectMobileSheet(b.dataset.sheet);
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
  // on a game you do not own, resolving is a preview and never moves the board
  // A published game's owner resolves through the same throwaway-preview path
  // as a read-only viewer — see previewResolve()'s gmPublish flag — so a typo
  // caught after resolving can be backed out and fixed instead of already
  // being committed to game.history. Only a sandbox (or a debug "view as
  // player") ever mutates the real game directly on Resolve.
  const gmPublishFlow = () => isOwnerView() && game.published;
  $('btn-resolve').onclick = () => (isReadOnly() || gmPublishFlow() ? previewResolve(false, gmPublishFlow()) : resolveCurrent());
  $('btn-resolve-final').onclick = () => (isReadOnly() || gmPublishFlow() ? previewResolve(true, gmPublishFlow()) : resolveAndSkip());
  $('btn-token').onclick = doEditToken;
  $('btn-publish').onclick = doPublish;
  $('btn-update-published').onclick = doUpdatePublished;
  $('btn-revert-published').onclick = revertToPublished;
  $('btn-open-source').onclick = openBranchSource;
  $('btn-sync').onclick = doUpdatePublished;
  $('country-select').onchange = () => {
    game.myCountry = $('country-select').value || null;
    S.saveGame(game);
    prefillOrders(true);
    onOrdersChanged();
  };
  $('btn-submit-moves').onclick = doSubmitMoves;
  $('btn-load-moves').onclick = doLoadPublishedMoves;
  // btn-catch-up's onclick is set per-render by renderCatchUpButton() — it
  // toggles between the gist-driven catchUpNext and the local auto-resolve.
  $('btn-set-players').onclick = openPlayersModal;
  $('players-save').onclick = savePlayers;
  $('players-modal-close').onclick = closePlayersModal;
  $('players-modal').addEventListener('pointerdown', (e) => {
    if (e.target === $('players-modal')) closePlayersModal();
  });
  $('btn-submissions').onclick = openSubmissionsModal;
  $('deadline-load-btn').onclick = gmLoadOrders;
  $('play-as-select').onchange = (e) => setPlayAs(e.target.value);
  $('submissions-modal-close').onclick = closeSubmissionsModal;
  $('submissions-modal').addEventListener('pointerdown', (e) => {
    if (e.target === $('submissions-modal')) closeSubmissionsModal();
  });
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
  $('pb-continue').onclick = () => (playback && playback.gmPublish ? gmPublishPreview() : continuePlayback());
  $('pb-back-current').onclick = endPlayback;
  $('pb-copy').onclick = copyResults;
  $('pb-branch').onclick = branchCurrent;
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

  $('btn-game-settings').onclick = openGameSettings;
  $('set-cancel').onclick = () => $('game-settings-dialog').close();
  $('game-settings-form').onsubmit = (e) => { e.preventDefault(); saveGameSettings(); };
  $('set-support-help').onclick = () => {
    const el = $('set-support-explain');
    el.hidden = !el.hidden;
  };
  $('set-convoy-help').onclick = () => {
    const el = $('set-convoy-explain');
    el.hidden = !el.hidden;
  };

  $('convoy-route-cancel').onclick = () => {
    cancelConvoyRoute();
    toast('Convoy route cancelled', 'info');
  };
  $('convoy-route-undo').onclick = () => {
    if (!convoyPick || !convoyPick.route.length) return;
    convoyPick.route.pop();
    renderConvoyPicker();
  };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && convoyPick) {
      cancelConvoyRoute();
      toast('Convoy route cancelled', 'info');
    }
  });

  // tick the deadline countdown while a published game sits open. Render-only
  // for everyone except the game master's own browser in Auto-Publish mode,
  // where autoPublishIfDue() is the one place outside explicit buttons/🔄 the
  // network gets touched — deliberately, since auto-publish means no one has
  // to be watching for the deadline to pass.
  setInterval(() => {
    if (game && game.published && !playback) {
      renderOnlineUI();
      if (game.isOwner) autoPublishIfDue();
    }
  }, 60000);

  // the topbar countdown chip ticks every second on its own — far cheaper
  // than a full renderOnlineUI(), and it's the one place a second matters
  setInterval(() => {
    if (game && game.published && !playback) updateDeadlineCountdown();
  }, 1000);

  renderHome();
  showScreen('home-screen');
  const gistParam = new URLSearchParams(location.search).get('gist');
  if (gistParam) {
    $('home-loading').hidden = false;
    try {
      await loadPublishedGame(gistParam);
    } finally {
      $('home-loading').hidden = true;
    }
  }
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
