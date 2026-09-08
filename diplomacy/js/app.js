import { Board, POWER_COLORS, ARROW_COLORS } from './render.js';
import * as S from './state.js';
import { parseOrders } from './parser.js';
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
import * as R from './roles.js';
import * as T from './orders-text.js';
import * as O from './online-rules.js';
import * as A from './analysis.js';
import {
  cap, provName, fmtLoc, fmtOrder, fmtCountdown, fmtCountdownDHMS, fmtWhen,
  isoToLocalInput, COAST_NAMES, POWER_FLAGS,
} from './format.js';
import {
  getToken, setToken, publishGame, updatePublished, fetchPublished,
  getAuthenticatedLogin, extractGistId,
  listComments, findSubmission, findMyMailbox, createMailbox, rememberMailbox,
  submitOrders, readSealKey, ensureSealKey, unsealComments,
  fetchGist, readMovesFiles, readGameFile, writeMovesFiles, upsertMovesEntry,
  getLastServerDate,
} from './publish.js';

const $ = (id) => document.getElementById(id);

let board;
// THE TWO POINTERS. `liveGame` is the real game — the published gist or the
// sandbox — and is the only thing that is ever saved under its own name, the
// only thing the online/publish/deadline code ever touches, and the thing the
// 60s poll reconciles against the gist. `game` is what is ON SCREEN: normally
// liveGame itself, but while a 🌿 analysis line is open it points at that
// line's own game object instead (js/analysis.js lineGame).
//
// That indirection is the whole implementation of analysis. A line IS a game
// object, so every drag, coast picker, retreat, build, board edit, resolve and
// playback below works on one without knowing it exists; only the code that
// must reach the real game — publishing, submitting, deadlines — says
// `liveGame`, and it is all in one contiguous block near the bottom of this
// file. See DECISIONS.md, "A line is a view, not a game".
let liveGame = null;
let game = null;
let playback = null; // {entry, step, orders, readonly, animating}
// The live game's order box, parked while a line is open so a player's
// unsubmitted draft survives a trip into analysis and back. Nothing else
// persists the box (a reload has always started from the blank template), so
// this is a session-lifetime stash, not a new piece of saved state.
let liveDraft = null;
// A tree that validateAnalysis() has just thrown away, waiting to be said out
// loud once the render it interrupted has finished.
let discardedLines = 0;
// Debounces the localStorage write behind order-box edits inside a line: the
// node is updated in memory on every keystroke, the save follows a beat later.
let lineSaveTimer = null;
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
const phaseKindOf = (g) =>
  g.step === 'movement' ? 'movement' : g.step === 'retreat' ? 'retreat' : 'adjustment';

// The phase the ORDER BOX is being parsed for — the line's, when one is open.
function phaseKind() {
  return phaseKindOf(game);
}

// The phase the live game is on, whatever is on screen. Everything that parses
// submitted orders is talking about the real game, never about a line.
function livePhaseKind() {
  return phaseKindOf(liveGame);
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

// A natively `disabled` button swallows its own click, so it can never say why
// it is greyed out — and a `title` tooltip, the only explanation this app had,
// does not exist on a touchscreen. setGated() marks a button unavailable the
// ARIA way and leaves it clickable; the capture-phase listener installed in
// init() eats the click and toasts `reason` instead of letting the handler run.
//
// `reason` is the same sentence any visible status line gives for the same
// state — the toast and the page must never offer two different explanations.
// Transient in-flight guards (btn.disabled = true … finally) keep using the
// native property: those want real inertness and have nothing to explain.
function setGated(btn, reason, enabledTitle) {
  if (!btn) return;
  btn.disabled = false;
  if (reason) {
    btn.setAttribute('aria-disabled', 'true');
    btn.dataset.gatedReason = reason;
    btn.title = reason;
  } else {
    btn.removeAttribute('aria-disabled');
    delete btn.dataset.gatedReason;
    if (enabledTitle !== undefined) btn.title = enabledTitle;
  }
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
    `<span class="gname">${escapeText(g.name)}</span>`,
    `<span class="meta">${S.phaseLabel(g)}</span>`,
  ];
  if (kind === 'gm') bits.push('<span class="badge role-gm">👑 Game master</span>');
  if (kind === 'player') bits.push(`<span class="badge role-player">${POWER_FLAGS[g.assignedPower] || ''} ${cap(g.assignedPower)}</span>`);
  if (kind === 'spectator') bits.push('<span class="badge role-spectator">👁 Watching</span>');
  const d = g.deadline && new Date(g.deadline);
  if (d && !isNaN(d)) {
    const left = d - trustedNow();
    bits.push(`<span class="badge deadline${left > 0 ? '' : ' past'}">⏰ ${left > 0 ? 'in ' + fmtCountdown(left) : 'passed'}</span>`);
  }
  if (g.branchedFrom) {
    bits.push(`<span class="meta from">🧪 from ${escapeText(g.branchedFrom.name)}` +
      `${g.branchedFrom.label ? ' · ' + escapeText(g.branchedFrom.label) : ''}</span>`);
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
// Which of the two kinds of game am I in, and what may I do to it? The whole
// permission model is nine pure questions about the game object, and it lives
// in js/roles.js so it can be tested without a browser — the doc comments that
// used to sit here went with it. These wrappers bind the module-level `game`,
// so every call site below reads exactly as it always has.
// These all ask about MY ROLE IN THE REAL GAME, so they read `liveGame` and
// keep their answer while a line is open — an analysis line does not make a
// spectator into a game master, and stepping into one must not make the
// deadline, the submission status or the ● pill forget who I am. The one that
// is deliberately about the VIEW is gameMode(), which is what colours the
// screen: it reads `game`, so it says 'analysis' the moment a line is open.
const isOnline = () => R.isOnline(liveGame);
const isSandbox = () => R.isSandbox(liveGame);
const gameMode = () => R.gameMode(game);
const isPlayingAsPlayer = () => R.isPlayingAsPlayer(liveGame);
const isReadOnly = () => R.isReadOnly(liveGame);
const isOwnerView = () => R.isOwnerView(liveGame);
const boardDirty = () => R.boardDirty(liveGame);
const assignedPower = () => R.assignedPower(liveGame);

// Am I looking at an analysis line rather than the game itself?
const inAnalysis = () => A.isLine(game);
// The open game's analysis tree, or null. Always the LIVE game's — a line
// never carries one; it is one.
const tree = () => (liveGame && liveGame.analysis) || null;

// Which power's orders the visible textarea shows, everything else going to
// the hidden buffer. A line shows every power at once, with no filter and no
// hidden buffer: exploring what the other six might do is the entire point,
// and the line's draft is the whole box (persistLineOrders).
const myCountry = () => (inAnalysis() ? '' : R.myCountry(liveGame));

function openGame(g) {
  liveGame = g;
  game = g;
  g.settings = S.gameSettings(g); // fill defaults for games saved before settings existed
  playback = null;
  gmOrdersLoaded = false;
  liveDraft = null;
  catchUpTarget = null; // re-established below/by refreshOnlineStatus() for THIS game, not whatever was last open
  online = { comments: null, moves: null, login: null, restored: false, serverOffset: 0, sealKey: null };
  justWrote = null; // belongs to whichever game we just left
  S.saveGame(game);
  showScreen('game-screen');
  mobileSheet = null;
  setEditMode(isSandbox() && game.units.length === 0);
  // Typing into the order box is a niche path — dragging on the map is the
  // normal one — so it starts collapsed for everyone; the per-power tally in
  // #phase-info is what stays visible instead. See renderPhaseInfo().
  $('orders-box').open = false;
  refreshAll();
  if (game.published && game.gistId) refreshOnlineStatus();
}

function refreshAll() {
  // ONE CHOKE POINT for the analysis lifetime rule. Every state change in the
  // app comes back through refreshAll(), so checking here covers the paths
  // that move the live position — a GM publish, a catch-up, an undo, an
  // ✏ Edit board — without any of them having to know analysis exists.
  validateAnalysis();
  const an = inAnalysis();
  $('game-screen').dataset.mode = gameMode();
  // The topbar always names the REAL game, whichever line is open; which line
  // that is belongs to the mode chip, not to the game's identity.
  $('game-name').textContent = liveGame ? liveGame.name : '';
  fitTopbar();
  $('phase-label').textContent = S.phaseLabel(game);
  board.setPhaseText(S.phaseLabel(game));
  board.setInfluence(game.scOwners);
  board.setUnits(game.units, game.step === 'retreat' ? game.pending.dislodged : []);
  board.clearOrders();
  $('panel-playback').hidden = true;
  updatePlaybackFloat();
  // The GM's order box stays out of the way until they deliberately ⬇ Load
  // orders (⏰ Deadline panel) — see gmLoadOrders()/gmOrdersLoaded. Everyone
  // else (sandboxes, players, spectators) sees it as before. A line has its
  // own orders and is never gated on the live game's publish flow.
  const gmGated = !an && isOwnerView() && liveGame.published && !gmOrdersLoaded;
  $('panel-orders').hidden = gmGated;
  // Nothing done inside a line can reach the real game, so a line is never
  // read-only however read-only the game around it is — that is the whole
  // point of it, and the reason branching was the escape hatch from every
  // read-only situation in the first place.
  const ro = !an && isReadOnly();
  // An assigned player is always drafting their own power, so there is
  // nothing to pick — the selector is only for a spectator choosing which
  // country to sketch orders for.
  const isPlayer = gameMode() === 'player';
  $('country-row').hidden = an || !ro || isPlayer;
  if (ro) renderCountrySelect();
  $('orders-text').readOnly = false;

  // Resolving a published game you do not own must not move it, so a
  // spectator's two Resolve buttons become a PREVIEW: the phase is
  // adjudicated on a throwaway copy and the real board comes back untouched
  // when the playback closes (previewResolve). An assigned player submits
  // orders instead (📤 Submit orders) — previewing their own game is not a
  // real action, so Resolve/Resolve to final are hidden outright for them.
  $('btn-resolve').hidden = isPlayer && !an;
  $('btn-resolve-final').hidden = isPlayer && !an;
  if (!isPlayer || an) {
    $('btn-resolve').textContent = an ? 'Resolve this line' : ro ? '👁 Preview result' : 'Resolve';
    $('btn-resolve').title = an
      ? 'Play these orders out and continue the line from the position they produce'
      : ro
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
  // disappear entirely rather than sitting there disabled; 🌿 Analysis is the
  // way to explore instead. A LINE always keeps them: it is a game of its own,
  // and running phases forward and stepping back through them is the whole
  // point of one — which is also how you get back to a phase worth branching at.
  $('btn-undo').hidden = ro && !an;
  $('btn-redo').hidden = ro && !an;
  setGated($('btn-undo'), game.history.length ? null : 'Nothing to undo — no phase has been resolved yet',
    'Undo the most recent phase — the board goes back and your orders return to the box');
  setGated($('btn-redo'), (game.redoStack && game.redoStack.length) ? null : 'Nothing to redo — undo a phase first',
    'Redo the last undone phase');
  // Every control that can reach the real game is gone while a line is open.
  // Nothing here is merely disabled: a line is a different place, and the
  // controls that belong to the live game belong to the live game.
  $('btn-publish').hidden = an || ro || !!liveGame.published;
  $('btn-update-published').hidden = an || !(liveGame.published && isOwnerView());
  setGated($('btn-update-published'),
    boardDirty() ? null : 'Nothing to publish — the shared link already shows this position',
    'Push your position to the published link, so every player sees it');
  $('panel-deadline').hidden = an || !(liveGame.published && isOwnerView());
  if (!an && liveGame.published && isOwnerView()) {
    const input = $('deadline-input');
    if (document.activeElement !== input) input.value = liveGame.deadline ? isoToLocalInput(liveGame.deadline) : '';
  }
  $('btn-set-players').hidden = an || !(liveGame.published && isOwnerView());
  $('btn-submissions').hidden = an || !(liveGame.published && isOwnerView());
  $('btn-revert-published').hidden = an || !isOnline();
  $('btn-open-source').hidden = an || !liveGame.branchedFrom;
  $('btn-copy-sandbox').hidden = an;
  renderModeChip();
  renderBranchNote();
  renderDraftNote();
  renderPlayAsControls();
  if (an) hideOnlineUI();
  else renderOnlineUI();
  setOrderMode(null);
  prefillOrders();
  // Coming back out of a line: the live game's draft orders were parked when
  // we went in (enterAnalysis), and prefillOrders() has just reset the box to
  // the blank template, so put them back. Also covers the forced exit above,
  // where validateAnalysis() threw the tree away mid-render.
  if (liveDraft !== null && !an) {
    applyOrdersText(liveDraft);
    liveDraft = null;
  }
  renderHistorySelect();
  renderStandings();
  renderAnalysisUI();
  onOrdersChanged();
  updateSyncPill();
  if (discardedLines) {
    const n = discardedLines;
    discardedLines = 0;
    toast(`The live game moved on — ${n} analysis line${n === 1 ? '' : 's'} cleared. 🌿 Analysis starts again from the new position.`);
  }
}

// ---------------------------------------------------------------------------
// game-state identity: which game am I in, and can I break it?
// ---------------------------------------------------------------------------
// Text for the ☁ Live side of the mode switch — what used to live in a
// separate chip beside it. Keyed by R.gameMode(liveGame), which is never
// 'analysis' (a line is never the live game itself).
const LIVE_MODE_LABEL = {
  gm: ['Live · 👑 GM',
    "You run this published game. What you resolve here becomes the official position the moment you ☁ Publish changes."],
  spectator: ['Live · 👁 Watching',
    'A live view of a published game. Nothing you type, drag or resolve here can change it.'],
};

// A sandbox has no ☁/🌿 switch (there is nothing to publish and nowhere for
// a line to hang off), so it gets a plain, non-interactive label instead —
// the same spot the switch occupies for an online game.
function renderModeChip() {
  const label = $('sandbox-label');
  label.hidden = !isSandbox();
  if (isSandbox()) {
    label.title = 'Private to this browser. Edit the board, resolve turns and copy it freely — nothing here is published.';
    return;
  }
  const liveMode = R.gameMode(liveGame);
  const liveLabel = $('ms-live').querySelector('.ms-label');
  if (liveMode === 'player') {
    const power = assignedPower();
    liveLabel.textContent = `Live · ${POWER_FLAGS[power] || ''} ${cap(power)}`;
    $('ms-live').title = `You are playing ${cap(power)} in a published game. Orders here are a private draft until you 📤 Submit them; the board itself is the game master's to move.`;
  } else {
    const [text, title] = LIVE_MODE_LABEL[liveMode] || ['Live', 'The live game — the real position, orders and deadline'];
    liveLabel.textContent = text;
    $('ms-live').title = title;
  }
}

// boardDirty() already knows the game master's position has moved on from the
// shared link, but the only thing it drove was a disabled button inside a
// closed ⚙ menu — so a resolved-but-unpublished turn looked exactly like a
// published one. This is that same fact, said out loud in the topbar, naming
// the phase the players are still looking at, and clickable to fix it.
function updateSyncPill() {
  const pill = $('btn-sync');
  const dirty = boardDirty() && !inAnalysis();
  pill.hidden = !dirty;
  if (dirty) {
    const live = liveGame.publishedState ? S.phaseLabel(liveGame.publishedState) : null;
    pill.querySelector('.sp-text').textContent = live
      ? `Unpublished — players still see ${live}`
      : 'Unpublished changes';
    pill.title = 'This browser holds a position the shared link does not. Click to publish it.';
  }
}

function renderBranchNote() {
  const el = $('branch-note');
  const b = !inAnalysis() && liveGame.branchedFrom;
  el.hidden = !b;
  if (!b) return;
  el.textContent = `🧪 Copied from “${b.name}”${b.label ? ' at ' + b.label : ''}` +
    (b.gistId ? ' — ↩ Open source game in ⚙ Settings to go back to the live game.' : '.');
}

// What the order box actually is, in this game. Orders are never state, but in
// an online game that is easy to forget — a drag on the map looks identical
// whether it is a draft, a submission or the official record.
function renderDraftNote() {
  const el = $('draft-note');
  const mode = gameMode();
  if (mode === 'analysis' || mode === 'sandbox' || mode === 'player') {
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
  for (const p of activePowers()) sel.appendChild(new Option(`Play as ${cap(p)}`, p));
  sel.value = liveGame.myCountry || '';
}

const defaultOrdersText = () => T.defaultOrdersText(game);

// Rebuild the visible textarea + hidden buffer for the current myCountry()
// filter. With preserve=true, orders already drawn for every power (visible
// textarea + hidden buffer, i.e. a full switch-country round trip) are kept;
// only powers with no orders at all get the blank per-phase template. With
// preserve=false (a real phase change / game load) everything resets.
function prefillOrders(preserve = false) {
  const ta = $('orders-text');
  const myC = myCountry();
  // the current phase is already shown in the topbar, so the heading itself
  // stays a plain, constant label
  const title = (base) => base;
  if (game.step === 'movement') {
    $('orders-title').textContent = title('Orders');
  } else if (game.step === 'retreat') {
    $('orders-title').textContent = title('Retreats');
    $('phase-info').textContent = 'Drag a dislodged unit to retreat it, or click it to disband. Unordered units disband.';
  } else {
    $('orders-title').textContent = title('Builds');
  }
  // Movement and adjustment get their per-power tally from renderPhaseInfo(),
  // called by the onOrdersChanged() every caller of prefillOrders() runs right
  // after it — see that function for why setting it here would just be
  // overwritten a moment later.

  // A line's box starts from the draft stored on the line's own game rather
  // than from a blank template — reopening a line must show the moves that
  // make it that line. Powers with no block yet still get the template.
  const stored = inAnalysis() ? (game.orders || '') : '';
  const merged = T.mergeBlocks(
    T.splitOrdersByPower(preserve ? fullOrdersText() : stored),
    T.splitOrdersByPower(defaultOrdersText())
  );
  const { visible, hidden } = T.splitForFilter(merged, myC);
  ta.value = visible;
  hiddenOrdersText = hidden;
}

// Everything currently drafted, across the visible textarea and the hidden
// buffer — one multi-power text in the standard order format.
function fullOrdersText() {
  return $('orders-text').value + (hiddenOrdersText ? '\n' + hiddenOrdersText : '');
}

// One power's order lines (header dropped), or '' if it has no block.
function powerBlockText(power) {
  return T.blockBody(T.splitOrdersByPower(fullOrdersText()), power);
}

// Replaces the whole order text (visible + hidden) with `fullText`, split
// into the textarea / hidden buffer for the current myCountry() filter.
function applyOrdersText(fullText) {
  const { visible, hidden } = T.splitForFilter(fullText, myCountry());
  $('orders-text').value = visible;
  hiddenOrdersText = hidden;
  onOrdersChanged();
}

// Swaps in a new block for one power, leaving every other power's draft as it
// is (used to restore a player's submitted orders from the gist).
function replacePowerBlock(power, ordersText) {
  applyOrdersText(T.replaceBlock(fullOrdersText(), power, ordersText));
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
      own.errors.map((e) => '✕ ' + escapeText(e)).join('\n') + '</span>');
  }
  if (warnings.length) {
    parts.push(`<span class="warn">` +
      warnings.map((w) => '⚠ ' + escapeText(w)).join('\n') + '</span>');
  }
  if (!parts.length) {
    const myC = myCountry();
    let total;
    if (game.step === 'retreat') {
      const dislodged = game.pending ? game.pending.dislodged : [];
      total = myC ? dislodged.filter((d) => d.unit.power === myC).length : dislodged.length;
    } else if (game.step === 'adjustment') {
      const counts = S.adjustmentCounts(game);
      total = myC
        ? Math.abs(counts[myC] || 0)
        : Object.values(counts).reduce((sum, c) => sum + Math.abs(c), 0);
    } else {
      total = myC ? game.units.filter((u) => u.power === myC).length : game.units.length;
    }
    parts.push(`<span class="ok">${own.orders.length}/${total} order${total === 1 ? '' : 's'} ✓</span>`);
  }
  el.innerHTML = parts.join('\n');
  if (game && game.step !== 'retreat' && !playback) renderPhaseInfo();
  // "submitted" vs "submitted, then edited" has to track the box keystroke by
  // keystroke, or it is reporting the state from the last network refresh
  if (game && !inAnalysis() && assignedPower()) renderSubmitStatus();
  // The order box IS the line, exactly as it is the game everywhere else, so
  // every keystroke and every drag writes straight through onto the line's own
  // game object. The localStorage write behind it is debounced
  // (scheduleLineSave); the draft itself is updated immediately, so nothing can
  // be lost by navigating away.
  if (game && inAnalysis() && !playback) persistLineOrders();
  drawLive();
  return { orders: own.orders, errors: own.errors };
}

// The order box collapses by default — typing orders is the niche path — so
// this is what stays on screen: a per-power tally of what's left to write,
// short enough to read at a glance ("Austria: 1/1 build"). Movement and
// adjustment both live-update as orders are clicked or typed; retreat's
// instruction line is set once in prefillOrders() and never changes.
function renderPhaseInfo() {
  const info = $('phase-info');
  if (game.step === 'movement') {
    const lines = [];
    for (const p of POWERS) {
      const total = game.units.filter((u) => u.power === p).length;
      if (!total) continue;
      const used = lastParsed.orders.filter((o) => o.power === p).length;
      lines.push(`${cap(p)}: ${used}/${total} order${total === 1 ? '' : 's'}`);
    }
    info.textContent = lines.join('\n') || 'No units to order.';
  } else if (game.step === 'adjustment') {
    const counts = S.adjustmentCounts(game);
    const lines = [];
    for (const [p, c] of Object.entries(counts)) {
      const used = adjustmentUsed(p);
      if (c > 0) lines.push(`${cap(p)}: ${used.builds}/${c} build${c > 1 ? 's' : ''}`);
      else if (c < 0) lines.push(`${cap(p)}: ${used.removes}/${-c} disband${-c > 1 ? 's' : ''}`);
    }
    info.textContent = lines.join('\n') || 'No builds or disbands required.';
  }
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

// Escapes for TEXT content only — & and < are enough there, and every call
// site interpolates into an element body. It is NOT safe for an attribute
// value (no quote escaping); use textContent or setAttribute for those.
function escapeText(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

// ---------------------------------------------------------------------------
// order text syncing (drag/click interactions write into the textarea)
// ---------------------------------------------------------------------------
// newText === null removes the unit's order line. Orders for a power other
// than the one the viewer is playing as go into the hidden buffer instead of
// the visible textarea — see hiddenOrdersText above. The text surgery itself
// lives in js/orders-text.js; this only picks the buffer and writes back.
function syncOrderLine(power, unitProv, newText) {
  const myC = myCountry();
  const foreign = myC && power !== myC;
  const source = foreign ? hiddenOrdersText : $('orders-text').value;
  const out = T.setOrderLine(source, power, unitProv, newText, phaseKind());
  if (foreign) hiddenOrdersText = out;
  else $('orders-text').value = out;
  onOrdersChanged();
}

function setOrder(u, spec) {
  syncOrderLine(u.power, prov(u.loc), T.orderTextFor(u, spec));
}

function selectOrderLine(unitProv) {
  const u = unitAt(unitProv);
  if (!u) return;
  const myC = myCountry();
  if (myC && u.power !== myC) return; // foreign order lives in the hidden buffer — nothing to select
  const ta = $('orders-text');
  const { lines, foundIdx } = T.locateOrderLine(u.power, unitProv, ta.value, phaseKind());
  if (foundIdx < 0) return;
  ta.focus();
  ta.setSelectionRange(...T.lineRange(lines, foundIdx));
}

// ---------------------------------------------------------------------------
// board interaction
// ---------------------------------------------------------------------------
// On a narrow screen the topbar can't fit everything at once: the hovered
// location's name, the game's name, and ⚙ Settings all compete for the same
// row, and ⚙ Settings must never be the one that loses — it would be pushed
// off-screen and become unreachable. So when space is short, give things up
// in priority order: the extra location detail (coast/star/occupant) goes
// first, then the game's name entirely, while the location's base name and
// ⚙ Settings itself are never touched.
function fitTopbar() {
  const topbar = $('topbar');
  const gameName = $('game-name');
  const extra = $('hover-info-extra');
  if (!topbar || !gameName || !extra) return;
  gameName.hidden = false;
  extra.hidden = false;
  if (!matchMedia('(max-width: 820px)').matches) return;
  if (topbar.scrollWidth <= topbar.clientWidth) return;
  extra.hidden = true;
  if (topbar.scrollWidth <= topbar.clientWidth) return;
  gameName.hidden = true;
}

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
        if (d) syncOrderLine(d.unit.power, base, T.orderTextFor(d.unit, { kind: 'disband' }));
        return;
      }
      if (game.step === 'adjustment') return adjustmentClick(base, ev);
      if (unitAt(base)) selectOrderLine(base);
    },
    onHover(p) {
      if (!p || !game || !PROVINCES[prov(p)]) {
        $('hover-info-base').textContent = '';
        $('hover-info-extra').textContent = '';
        fitTopbar();
        return;
      }
      const base = prov(p);
      const u = unitAt(base);
      const owner = game.scOwners[base];
      const coastSuffix = p.includes('/') ? p.split('/')[1] : null;
      const tail = u ? ` - ${u.type === 'A' ? 'Army' : 'Fleet'} ${cap(u.power)}` : (owner ? ` - ${cap(owner)}` : '');
      $('hover-info-base').textContent = provName(p);
      $('hover-info-extra').textContent =
        (coastSuffix ? ` (${COAST_NAMES[coastSuffix] || coastSuffix})` : '') +
        (coastSuffix ? ` "${p}"` : '') +
        (PROVINCES[base].sc ? ' ⭐' : '') +
        tail;
      fitTopbar();
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
  syncOrderLine(d.unit.power, from, T.orderTextFor(d.unit, { kind: 'retreat', dest: nearestLoc(ev, opts) }));
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
  if (!editMode && !inAnalysis() && liveGame.published && isOwnerView() && !confirm(
    'Edit the official board?\n\n' +
    'You are about to change the published game\'s position by hand. ' +
    'Players see nothing until you ☁ Publish changes.\n\n' +
    'To try ideas out instead, cancel and use 🌿 Analysis.'
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
  updatePlaybackFloat(); // the on-map controls stand down while a sheet is up
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
  saveCurrent();
  board.setInfluence(game.scOwners);
  board.setUnits(game.units, game.step === 'retreat' && game.pending ? game.pending.dislodged : []);
  renderStandings();
  onOrdersChanged();
  if (!inAnalysis() && liveGame.published && isOwnerView()) $('btn-update-published').disabled = !boardDirty();
  updateSyncPill();
  // an edited board is a different phase label, and may have orphaned a
  // branch cut from this line (analysis.js isStale)
  if (inAnalysis()) renderAnalysisTree();
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
// Resolving a line is resolving a game — the same call, on the line's own game
// object, saved through saveCurrent(). What a line needs is not a second
// resolve path but a way past previewResolve(), which exists because a
// SPECTATOR must not move the published position; inside a line there is
// nothing published to protect.
function resolveCurrent() {
  const { orders, errors } = onOrdersChanged();
  if (errors.length) return toast('Fix the order problems first');
  const text = $('orders-text').value;
  const entry = S.resolvePhase(game, orders, text);
  // A line's draft lives on its game object, so the phase it belonged to
  // taking it into history is also the moment to clear it — otherwise the next
  // phase opens on the last one's orders.
  if (inAnalysis()) game.orders = '';
  saveCurrent();
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
  if (inAnalysis()) return toFinal ? resolveAndSkip() : resolveCurrent();
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
  if (inAnalysis()) game.orders = '';
  saveCurrent();
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

function doRedoPhase() {
  const entry = S.redoPhase(game);
  if (!entry) return toast('Nothing to redo');
  playback = null;
  if (inAnalysis()) game.orders = '';
  saveCurrent();
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
  const raw = catchUpTarget.history[liveGame.history.length];
  if (!raw) { catchUpTarget = null; refreshAll(); return; }
  const entry = structuredClone(raw);
  liveGame.units = structuredClone(entry.unitsAfter);
  liveGame.scOwners = structuredClone(entry.scOwnersAfter);
  liveGame.pending = structuredClone(entry.pendingAfter) || null;
  liveGame.season = entry.seasonAfter;
  liveGame.year = entry.yearAfter;
  liveGame.step = entry.stepAfter;
  liveGame.history.push(entry);
  liveGame.redoStack = [];
  S.saveGame(liveGame);
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
  if (!liveGame || !liveGame.published || playback || catchUpTarget) return false;
  // owner drives the real resolution (manual publish / autoPublishIfDue) — this
  // optimistic local advance is for read-only players/spectators only.
  if (!isReadOnly()) return false;
  if (publishMode() !== 'auto' || !deadlinePassed()) return false;
  if (liveGame.provisionalPhase && matchesPhase(liveGame.provisionalPhase)) return false;
  return activePowers().some((p) => revealedEntry(p));
}

// Resolves the current phase locally from the revealed on-time submissions and
// plays it out — the player's optimistic advance ahead of the GM's real
// publish. Marked provisional (game.provisionalPhase) so reconcileProvisional-
// Phase() can defer to the gist once the GM's version lands. No gist writes.
function resolveRevealedLocally() {
  if (!localAutoResolveAvailable()) return;
  const phase = O.currentPhase(liveGame);
  const { text } = O.gatherPhaseBlocks(liveGame, online, 'ontime');
  const parsed = parseOrders(text, livePhaseKind());
  const entry = S.resolvePhase(liveGame, parsed.orders, text);
  liveGame.provisionalPhase = phase;
  S.saveGame(liveGame);
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
    const n = catchUpTarget.history.length - liveGame.history.length;
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
  // On mobile an open sheet shrinks the map to a strip (updateSheetInset), so
  // a resolution started from the Orders tab would play out in a letterbox.
  // Close it: the floating controls (#pb-float) drive the step-through from
  // the map itself, and the tab is one tap away for the full order list.
  mobileSheet = null;
  applyMobileSheetUI();
  $('panel-orders').hidden = true;
  $('panel-edit').hidden = true;
  $('panel-playback').hidden = false;
  $('panel-playback').classList.toggle('preview', !!preview);
  $('playback-title').textContent =
    (preview ? '👁 Preview · ' : inAnalysis() ? '🌿 Analysis · ' : '') + entry.label;
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
  // Replaying a past phase of a line moves the branch point (viewedIndex), and
  // nothing else on this path calls refreshAll — so the panel would otherwise
  // go on offering to branch from the position you just stepped away from.
  if (inAnalysis()) renderAnalysisUI();
}

const outcomeStep = () => playback.orders.length;
const finalStep = () => playback.orders.length + 1;

// Every province an order touches — what has to be on screen for the step to
// read as anything: the mover and where it is going, a supporter and what it
// is supporting, the sea provinces a convoy is routed through.
function orderFocusLocs(o) {
  const locs = [o.loc, o.destLoc || o.dest];
  if (o.target) locs.push(o.target.loc, o.target.dest);
  if (o.convoyRoute) locs.push(...o.convoyRoute);
  return locs.filter(Boolean);
}

// Mirrors the sidebar's playback controls onto the floating on-map set. On
// mobile the sidebar is a sheet, and a sheet open over the map is exactly what
// makes a resolution unwatchable there — so while a playback runs the sheet is
// closed (startPlayback) and these take over. Hidden the moment the viewer
// opens a sheet themselves, since the sidebar's own copy is then on screen.
function updatePlaybackFloat() {
  const float = $('pb-float');
  if (!playback || mobileSheet) {
    float.hidden = true;
    return;
  }
  float.hidden = false;
  const n = playback.orders.length;
  // only while a single order is being shown — the reveal and the animation
  // are about the whole board, not one numbered step of it
  const showing = playback.step > 0 && playback.step < n && !playback.animating;
  $('pbf-label').textContent =
    (showing ? `${playback.step}/${n} · ` : '') + $('pb-step-label').textContent;
  $('pbf-prev').disabled = $('pb-prev').disabled;
  $('pbf-start').disabled = $('pb-prev').disabled;
  $('pbf-next').disabled = $('pb-next').disabled;
  $('pbf-end').disabled = $('pb-next').disabled;
  const cont = $('pb-continue');
  $('pbf-continue').hidden = cont.hidden;
  $('pbf-continue').textContent = cont.textContent;
  $('pbf-continue').disabled = playback.animating;
  // ✕ is the sidebar's "Back to current turn"/"Back — amend an order", and
  // exists on the float only when there is one: a live resolve has no way out
  // but forward, and offering a dead ✕ there would suggest otherwise.
  $('pbf-back').hidden = $('pb-back-current').hidden;
  $('pbf-back').disabled = playback.animating;
  $('pbf-actions').hidden = $('pbf-continue').hidden && $('pbf-back').hidden;
}

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
      // the verdicts are spread over the whole board, and the move animation
      // that follows is too — pull back far enough to take all of it in
      board.focusOn(orders.flatMap((r) => orderFocusLocs(r.order)));
    } else {
      const r = orders[step - 1];
      $('pb-step-label').textContent = step === 0
        ? 'Board before orders — step through with ▶'
        : `${cap(r.order.power)}: ${fmtOrder(r.order)}`;
      // A zoomed-in map (the normal state of a phone) would otherwise reveal
      // orders happening off-screen. Panning to the order being described is
      // what makes the step-through watchable from the map alone.
      if (step > 0) board.focusOn(orderFocusLocs(r.order));
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
  updatePlaybackFloat();
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
  if (wasCatchUp && catchUpTarget && liveGame.history.length < catchUpTarget.history.length) {
    catchUpNext();
    return;
  }
  if (wasCatchUp) {
    catchUpTarget = null;
    liveGame.publishedState = S.boardSnapshot(liveGame);
    S.saveGame(liveGame);
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
  updatePlaybackFloat();
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

// House rules belong to the game, not to a view of it, so this reads and
// writes liveGame even while a line is open — and lineGame() copies the result
// onto every line, or a line would not be adjudicating the same game.
function openGameSettings() {
  if (!liveGame) return;
  const s = S.gameSettings(liveGame);
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
  const prev = S.gameSettings(liveGame);
  liveGame.settings = {
    soloWin: clampInt($('set-solo-win').value, 1, 34, 18),
    coalitionWin: clampInt($('set-coalition-win').value, 1, 34, 18),
    supportRule: $('set-support-rule').value === 'strict' ? 'strict' : 'standard',
    convoyRule: $('set-convoy-rule').value === 'strict' ? 'strict' : 'standard',
  };
  S.saveGame(liveGame);
  if (inAnalysis()) game.settings = { ...liveGame.settings }; // the open line adjudicates by them too
  $('game-settings-dialog').close();
  renderStandings();
  onOrdersChanged(); // re-validate: a rule change can flip which orders work
  const ruleChanged =
    prev.supportRule !== liveGame.settings.supportRule ||
    prev.convoyRule !== liveGame.settings.convoyRule;
  if (ruleChanged && liveGame.history.length)
    toast('House rule changed — it applies to future resolutions only', 'info');
  else toast('Game settings saved', 'info');
  // push to the published gist so every player sees the same rules; the
  // board override keeps the GM's in-progress position out of it
  if (liveGame.published && liveGame.isOwner) {
    await pushSettings(null, 'Saved locally, but could not publish the change');
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
  // Inside a line, undo is just undo: the line is a game of its own, nobody
  // else can see it, and stepping a phase back is how you get to the position
  // you want to try something else from.
  if (inAnalysis()) {
    const entry = S.undoLastPhase(game);
    if (!entry) return toast('Nothing to undo — this line has not resolved a phase yet');
    playback = null;
    game.orders = entry.ordersText || '';
    flushLineSave();
    refreshAll();
    return toast(`Undid ${entry.label} — orders restored below`, 'info');
  }
  // undoing a published turn walks the official position backwards — fine (it
  // is how a GM fixes a mis-entered order) but worth being deliberate about
  if (isOwnerView() && liveGame.published && liveGame.history.length && !confirm(
    `Undo ${liveGame.history[liveGame.history.length - 1].label} on the official game?\n\n` +
    'The board goes back a phase and your orders return to the box. ' +
    'Players keep seeing the published position until you ☁ Publish changes again.'
  )) return;
  const entry = S.undoLastPhase(liveGame);
  if (!entry) return toast('Nothing to undo');
  playback = null;
  S.saveGame(liveGame);
  refreshAll();
  if (entry.ordersText) {
    $('orders-text').value = entry.ordersText;
    onOrdersChanged();
  }
  toast(`Undid ${entry.label} — orders restored below`, 'info');
}

// ---------------------------------------------------------------------------
// 🌿 analysis — a tree of lines hanging off the live position
// ---------------------------------------------------------------------------
// The model and every operation on the tree are in js/analysis.js; what is
// here is the switching, the persistence and the panel. Three rules hold the
// whole thing together:
//
//   1. A line is never a saved game (saveCurrent below), so the home screen
//      never grows a copy to keep in step by hand — the complaint that made
//      the old snapshot-branch useless.
//   2. The tree is rooted at one position and dies with it (validateAnalysis).
//   3. Everything that could reach the real game is gone while a line is open
//      (refreshAll), and what mode you are in is said in four places at once.

// Persist whatever is on screen. A line goes back into its node on the live
// game; anything else is an ordinary saved game. Replaces the bare
// S.saveGame(game) at every call site that a line can reach.
function saveCurrent() {
  // A line's game object IS the node's game object, so there is nothing to
  // copy across — resolving, undoing and ✏ Edit board have already written to
  // the tree, and all that is left is to put the live game in the store.
  if (inAnalysis()) return flushLineSave();
  S.saveGame(game);
}

function saveLive() {
  if (liveGame) S.saveGame(liveGame);
}

// Order-box edits update the node immediately and the store a beat later:
// saveGame() rewrites every saved game as one JSON blob, which is not a
// per-keystroke operation. Nothing is at risk in the gap — the node is already
// updated, and every navigation flushes.
function scheduleLineSave() {
  clearTimeout(lineSaveTimer);
  lineSaveTimer = setTimeout(() => {
    lineSaveTimer = null;
    saveLive();
  }, 1200);
}

function flushLineSave() {
  clearTimeout(lineSaveTimer);
  lineSaveTimer = null;
  saveLive();
}

function persistLineOrders() {
  if (!tree() || !inAnalysis()) return;
  game.orders = fullOrdersText();
  scheduleLineSave();
}

// THE LIFETIME RULE, enforced. Called at the top of refreshAll() and nowhere
// else: every path that can move the live position ends in a refreshAll(), so
// this one check covers a GM publish, a catch-up, an undo, a revert and an
// ✏ Edit board without any of them naming analysis.
//
// It compares the POSITION, not the history — so a GM who undoes a phase and
// re-resolves it identically comes back to the same board and the tree
// survives, which is why the catch-up path locks the button (see
// analysisUnavailableReason) instead of deleting on sight.
function validateAnalysis() {
  const t = tree();
  if (!t || A.rootMatches(t, liveGame)) return;
  discardedLines = A.lineCount(t);
  liveGame.analysis = null;
  if (inAnalysis()) {
    game = liveGame;
    if (editMode) setEditMode(false); // never carry a line's edit mode onto the real board
  }
  S.saveGame(liveGame);
}

// Why 🌿 Analysis is not available right now, or null. Said out loud by the
// gated button rather than left to be discovered (DECISIONS.md, "A greyed-out
// button must be able to say why").
function analysisUnavailableReason() {
  if (!liveGame) return 'No game is open';
  if (!R.isOnline(liveGame)) {
    return 'Analysis belongs to a live game — a sandbox is already yours to edit, resolve and undo freely';
  }
  if (catchUpTarget) {
    const n = catchUpTarget.history.length - liveGame.history.length;
    return `${n} new phase${n === 1 ? '' : 's'} to resolve first — ▶ Resolve new orders!, and analysis reopens from the new position`;
  }
  if (localAutoResolveAvailable()) {
    return 'New orders are ready to resolve — ▶ Resolve new orders! first, and analysis reopens from the new position';
  }
  return null;
}

function enterAnalysis() {
  const why = analysisUnavailableReason();
  if (why) return toast(why);
  if (inAnalysis()) return;
  playback = null;
  setEditMode(false);
  if (!A.rootMatches(liveGame.analysis, liveGame)) liveGame.analysis = A.newTree(liveGame);
  // The live game's draft is parked, not thrown away: for an assigned player
  // it is the one thing on this screen worth more than the position.
  liveDraft = fullOrdersText();
  openNode(A.ensureEntry(liveGame.analysis, S.gameSettings(liveGame)));
  toast('🌿 Analysis — resolve as far ahead as you like; nothing here reaches the live game', 'info');
}

function exitAnalysis() {
  if (!inAnalysis()) return;
  persistLineOrders();
  flushLineSave();
  playback = null;
  setEditMode(false);
  game = liveGame;
  refreshAll(); // puts the parked draft back — see the liveDraft branch there
}

// Put a line on the board. `activeId` always names a LINE — a folder is
// organisation, never a position to render.
function openNode(id) {
  const t = tree();
  const n = A.getNode(t, id);
  if (!n || n.kind !== 'line') return;
  if (inAnalysis() && game.nodeId !== id) persistLineOrders();
  playback = null;
  setEditMode(false);
  t.activeId = id;
  t.selectedId = id;
  // A line hidden inside a collapsed folder would be on the board with nothing
  // in the tree pointing at it, so opening one opens the way to it.
  for (const a of A.pathTo(t, id)) if (a.kind === 'folder') a.collapsed = false;
  game = A.lineGame(t, id, liveGame);
  flushLineSave();
  refreshAll();
}

// Which phase of the open line is being looked at — the branch point, and the
// only input to where ⑂ Branch puts the new line. It is the line's current
// position unless a past phase of it is being replayed, which is what "click
// in the history bar and view the previous phase" leaves on screen.
function viewedIndex() {
  if (!inAnalysis()) return 0;
  if (playback && !playback.preview) {
    const i = game.history.indexOf(playback.entry);
    if (i >= 0) return i;
  }
  return game.history.length;
}

const selectedNode = () => {
  const t = tree();
  return A.getNode(t, t.selectedId) || A.getNode(t, t.activeId);
};

function selectNode(id) {
  const t = tree();
  if (!A.getNode(t, id)) return;
  t.selectedId = id;
  renderAnalysisUI();
}

// ⑂ Branch. Everything about where the new line lands comes from the phase on
// screen (viewedIndex) — see analysis.js branchParent for the rule and why it
// is the one worth having.
function branchLine() {
  const t = tree();
  const src = A.getNode(t, t.activeId);
  if (!src) return;
  if (!A.canBranch(t)) {
    return toast(`That is ${A.MAX_LINES} lines — delete one before branching again`);
  }
  persistLineOrders();
  const i = viewedIndex();
  const node = A.branchFrom(t, src.id, i, S.gameSettings(liveGame));
  if (!node) return;
  flushLineSave();
  openNode(node.id);
  toast(i > 0
    ? `⑂ ${node.name} — nested under “${src.name}”, from ${node.from.label}`
    : `⑂ ${node.name} — beside “${src.name}”, from ${node.from.label}`, 'info');
}

// 📁 Folder. Takes the selected row's whole level with it (analysis.js
// groupSiblings) — a folder that starts empty would be a folder that starts by
// doing nothing.
function newFolder() {
  const t = tree();
  const sel = selectedNode();
  if (!sel) return;
  const f = A.groupSiblings(t, sel.id);
  if (!f) return;
  t.selectedId = f.id;
  flushLineSave();
  renderAnalysisUI();
  toast(`📁 ${f.name} — the lines at that level are now inside it. Drag any row in or out.`, 'info');
}

// ---- the 🌿 Analysis panel -------------------------------------------------

function renderAnalysisUI() {
  const an = inAnalysis();
  const available = R.isOnline(liveGame);
  const why = analysisUnavailableReason();
  const t = tree();
  const active = an ? A.getNode(t, game.nodeId) : null;
  // The switch is a two-state segmented control rather than a button, so it
  // says which side you are on as well as offering the other — the single
  // strongest thing on the page against thinking a line is the real game. It
  // also carries the open line's NAME, which is why there is no analysis mode
  // chip and no breadcrumb beside it: one control, saying both facts once.
  $('mode-switch').hidden = !available;
  $('ms-live').classList.toggle('on', !an);
  $('ms-analysis').classList.toggle('on', an);
  $('ms-live').setAttribute('aria-pressed', String(!an));
  $('ms-analysis').setAttribute('aria-pressed', String(an));
  $('ms-analysis').querySelector('.ms-label').textContent = active ? active.name : 'Analysis';
  setGated($('ms-analysis'), an ? null : why, active
    ? `${A.lineLabel(t, active.id)} — a private line off ${liveGame.name}, rooted at ${t.rootLabel}. ` +
      'Nothing here reaches the live game, and the whole tree is cleared when the live position moves on.'
    : 'Open a private tree of lines off this position');
  // Only present on the mobile tab bar while a line is actually open — the
  // rest of the time it would be a tab into an empty panel.
  $('mtab-analysis').hidden = !an;
  // Cleared on the way out as well as set on the way in: setGated leaves an
  // aria-disabled attribute behind, and a Resolve left gated by a stale line
  // would refuse to resolve the real game.
  const locked = an ? why : null;
  setGated($('btn-resolve'), locked, $('btn-resolve').title);
  setGated($('btn-resolve-final'), locked, $('btn-resolve-final').title);

  $('panel-analysis').hidden = !an;
  if (!an) return;
  // The open line is gone from under us — a node the tree no longer has, or one
  // this version cannot read. Reopening the entry line is the recovery; simply
  // returning here would leave the panel on screen with an empty tree and no
  // way back, which is exactly what a stale tree used to do.
  if (!active) {
    const id = A.ensureEntry(t, S.gameSettings(liveGame));
    // and if even that is not openable, leave rather than recurse
    return id !== game.nodeId ? openNode(id) : exitAnalysis();
  }
  $('analysis-root').textContent =
    `Rooted at ${t.rootLabel}. All analyses are cleared when the live game moves forward.`;
  // The live game moved on while we were in here. The board keeps showing what
  // it was showing — yanking it out mid-thought is worse than saying so — but
  // the line can no longer be resolved or extended, and going back to ☁ Live
  // (where the new phase is waiting) is what clears it.
  $('analysis-locked').hidden = !locked;
  if (locked) {
    $('analysis-locked').textContent =
      `⚠ ${locked}. This line is out of date and can no longer be resolved.`;
  }
  renderAnalysisTree();

  // Where ⑂ Branch would put a line RIGHT NOW, said before the click rather
  // than discovered after it. The rule is one comparison (analysis.js
  // branchParent) but it is invisible from the button alone, and a line that
  // silently landed at the wrong level would be the whole feature misfiring.
  const i = viewedIndex();
  const at = S.phaseLabel(A.positionAt(active.game, i));
  const nested = i > 0;
  $('an-branch').textContent = nested ? '⑂ Branch here' : '⑂ Branch';
  const branchNote = nested
    ? `⑂ Branch starts a line at ${at}, nested under “${active.name}” — that phase only exists because this line produced it.`
    : `⑂ Branch starts a line at ${at}, beside “${active.name}” — a different idea from the same position. Resolve or step forward first to nest one instead.`;
  const full = A.canBranch(t) ? null : `That is ${A.MAX_LINES} lines — delete one before branching again`;
  setGated($('an-branch'), locked || full, branchNote);

  const sel = selectedNode();
  setGated($('an-new-folder'), sel ? null : 'Pick a line or folder first',
    sel ? `Group “${sel.name}” and everything beside it into a folder` : 'Group this level into a folder');
  $('an-rename').title = sel ? `Rename “${sel.name}”` : 'Rename';
  setGated($('an-delete'),
    A.lineCount(t) > 1 ? null : 'This is the only line in the tree — leave analysis instead',
    sel ? `Delete “${sel.name}” and everything inside it` : 'Delete the selected row');

  // ↥ Use these orders live only makes sense while the line is still standing
  // on the live game's own phase — orders written three phases into a
  // hypothetical are not orders for the turn the table is actually playing.
  const power = assignedPower() || R.myCountry(liveGame);
  setGated($('an-use-orders'),
    !power ? 'Pick a country to play as first — there are no orders of your own to take across'
      : A.ownPhaseCount(active)
        ? `This line has moved on to ${S.phaseLabel(active.game)} — the live game is still at ${t.rootLabel}. ⤺ Undo back to the start of the line to take its orders across.`
        : null,
    power ? `Copy ${cap(power)}'s orders from this line into the live game's order box` : '');
}

// The tree itself: folders and the lines inside them, indented, with the open
// line marked and the selected row (which may be a folder) outlined.
//
// Every row is draggable and every row is a drop target with THREE zones, so
// dragging can build any shape the tree can hold rather than only the ones
// ⑂ Branch produces: the top edge inserts before the row, the bottom edge
// after it, and the whole middle drops INSIDE it — under a line as readily as
// into a folder. The first cut only had "before" for lines, which meant a row
// dragged out of a nesting could never be put back into one.
let dragNodeId = null;

// Which of the three a pointer is over. Fixed pixel edges rather than a
// fraction of the row: rows are ~26px, so a percentage band would be three or
// four pixels wide and the middle would swallow everything on a touch device.
function dropZone(ev, row) {
  const r = row.getBoundingClientRect();
  const edge = Math.max(4, Math.min(8, r.height / 3));
  const y = ev.clientY - r.top;
  if (y < edge) return 'before';
  if (y > r.height - edge) return 'after';
  return 'into';
}

function renderAnalysisTree() {
  const t = tree();
  const host = $('analysis-tree');
  if (!t || !host) return;
  const clearMarks = () => {
    for (const el of host.querySelectorAll('.drop-into,.drop-before,.drop-after')) {
      el.classList.remove('drop-into', 'drop-before', 'drop-after');
    }
  };
  const applyMove = (id, parentId, beforeId) => {
    clearMarks();
    if (!id) return;
    if (!A.moveNode(t, id, parentId, beforeId)) return toast('A folder cannot be moved inside itself');
    flushLineSave();
    renderAnalysisUI();
  };
  host.replaceChildren();
  host.ondragover = (e) => { if (dragNodeId) e.preventDefault(); };
  host.ondrop = (e) => {
    e.preventDefault();
    applyMove(dragNodeId, null, null);
  };

  const addRow = (n, depth) => {
    const isFolder = n.kind === 'folder';
    const row = document.createElement('div');
    row.className = 'an-row an-' + n.kind;
    row.style.paddingLeft = 4 + depth * 14 + 'px';
    row.draggable = true;
    if (!isFolder && n.id === t.activeId) row.classList.add('active');
    if (n.id === t.selectedId) row.classList.add('selected');

    const chev = document.createElement('button');
    chev.className = 'an-chev';
    chev.textContent = isFolder ? (n.collapsed ? '▸' : '▾') : '';
    chev.tabIndex = isFolder ? 0 : -1;
    chev.title = isFolder ? (n.collapsed ? 'Expand' : 'Collapse') : '';
    chev.onclick = (e) => {
      e.stopPropagation();
      if (!isFolder) return;
      A.toggleCollapsed(t, n.id);
      flushLineSave();
      renderAnalysisTree();
    };
    row.appendChild(chev);

    const main = document.createElement('button');
    main.className = 'an-main';
    const bits = [`<span class="an-icon">${isFolder ? '📁' : '🔀'}</span>`,
      `<span class="an-name">${escapeText(n.name)}</span>`];
    if (isFolder) {
      const inside = A.descendantIds(t, n.id).size;
      bits.push(`<span class="an-meta">${inside} inside</span>`);
      main.title = `Select this folder — ✎ renames it, 🗑 deletes it and everything in it`;
    } else {
      // The phase the line STARTS at, which is the fixed thing about it. Its
      // current phase moves every time you resolve inside it, and the board
      // and the topbar are already saying that.
      if (A.isStale(t, n)) bits.push('<span class="an-meta warn">⚠ the line it came from changed</span>');
      else bits.push(`<span class="an-meta">from ${escapeText(A.lineStartLabel(n))}</span>`);
      const played = A.ownPhaseCount(n);
      main.title = `Open “${n.name}” — starts at ${A.lineStartLabel(n)}, ` +
        (played
          ? `${played} phase${played === 1 ? '' : 's'} played, now at ${S.phaseLabel(n.game)}`
          : 'nothing resolved in it yet');
    }
    main.innerHTML = bits.join(' ');
    main.onclick = () => (isFolder ? selectNode(n.id) : openNode(n.id));
    row.appendChild(main);

    row.ondragstart = (e) => {
      dragNodeId = n.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', n.id);
    };
    row.ondragend = () => { dragNodeId = null; clearMarks(); };
    row.ondragover = (e) => {
      if (!dragNodeId || dragNodeId === n.id) return;
      e.preventDefault();
      clearMarks();
      row.classList.add('drop-' + dropZone(e, row));
    };
    row.ondragleave = () => row.classList.remove('drop-into', 'drop-before', 'drop-after');
    row.ondrop = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = dragNodeId;
      // dropped on itself — the host's dragover let the event through, so this
      // is the one place that has to say "nothing happened"
      if (!id || id === n.id) return clearMarks();
      const zone = dropZone(e, row);
      if (zone === 'into') return applyMove(id, n.id, null);
      // …otherwise it joins this row's own level. "After" is expressed as
      // "before the next one along", since that is the one thing moveNode
      // takes — and as an append when there is no next one.
      const sibs = A.childrenOf(t, n.parent || null).filter((s) => s.id !== id);
      const at = sibs.findIndex((s) => s.id === n.id);
      const next = zone === 'after' ? sibs[at + 1] : sibs[at];
      applyMove(id, n.parent || null, next ? next.id : null);
    };
    host.appendChild(row);
  };

  const walk = (parentId, depth) => {
    for (const n of A.childrenOf(t, parentId)) {
      addRow(n, depth);
      if (n.kind === 'folder' && n.collapsed) continue;
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
}

function renameSelected() {
  const t = tree();
  const n = selectedNode();
  if (!n) return;
  const name = prompt(n.kind === 'folder' ? 'Name for this folder:' : 'Name for this line:', n.name);
  if (!name) return;
  A.renameNode(t, n.id, name);
  flushLineSave();
  renderAnalysisUI();
}

function deleteSelected() {
  const t = tree();
  const n = selectedNode();
  if (!n) return;
  const inside = A.descendantIds(t, n.id);
  const goingLines = [...inside].filter((id) => A.getNode(t, id).kind === 'line').length +
    (n.kind === 'line' ? 1 : 0);
  if (A.lineCount(t) - goingLines < 1) {
    return toast('That would leave no lines at all — leave analysis instead');
  }
  if (!confirm(`Delete “${n.name}”${inside.size
    ? ` and the ${inside.size} row${inside.size === 1 ? '' : 's'} inside it`
    : ''}?`)) return;
  A.deleteNode(t, n.id);
  flushLineSave();
  openNode(A.ensureEntry(t, S.gameSettings(liveGame)));
}

// The one sanctioned bridge from a line back to the real game. Without it the
// way to act on what you worked out is to retype it, which is exactly where
// the mistakes are — but it moves ONLY your own orders, and only into the
// draft box, never into a submission.
function useLineOrdersLive() {
  const power = assignedPower() || R.myCountry(liveGame);
  if (!power) return;
  const node = A.getNode(tree(), game.nodeId);
  if (A.ownPhaseCount(node)) return toast('Step this line back to its first phase first — ⤺ Undo');
  persistLineOrders();
  const mine = powerBlockText(power);
  if (!mine.trim()) return toast(`No ${cap(power)} orders in this line yet`);
  const name = (node || {}).name || 'this line';
  exitAnalysis();
  replacePowerBlock(power, mine);
  toast(`${cap(power)}'s orders from “${name}” are in the live order box — nothing is submitted yet`, 'info');
}

// ---------------------------------------------------------------------------
// 🧪 copy to sandbox — the durable, throw-nothing-away escape hatch
// ---------------------------------------------------------------------------
// Analysis is deliberately temporary: it dies with the position it is rooted
// at. This is the other half — a real, permanent, freely editable game of your
// own, which is what you want for a position worth keeping past the next
// publish (and what the discard notice points at).
//
// `src` is any position: the live game, the open line, or the throwaway one a
// preview resolved into ("keep this outcome").
function copyToSandbox(src, atLabel) {
  const name = prompt('Name for the sandbox:', uniqueName(`${liveGame.name} sandbox`));
  if (!name) return;
  const g = S.branchGame(src, uniqueName(name), {
    name: liveGame.name,
    gistId: isOnline() ? liveGame.gistId : null,
    label: atLabel,
    at: new Date().toISOString(),
  });
  openGame(g);
  toast('🧪 Sandbox created — rearrange, resolve and try anything', 'info');
}

function copyCurrentToSandbox() {
  if (playback && playback.preview) {
    return copyToSandbox(playback.preview, `after ${playback.entry.label}`);
  }
  copyToSandbox(game, inAnalysis()
    ? `${A.lineLabel(tree(), game.nodeId)} · ${S.phaseLabel(game)}`
    : S.phaseLabel(game));
}

// ⚙ → ↩ Open source game. A sandbox copied off an online game should not
// need a trip through the home screen to get back to the real one.
function openBranchSource() {
  const b = liveGame.branchedFrom;
  if (!b) return;
  if (b.gistId) return loadPublishedGame(b.gistId);
  const src = S.listGames()[b.name];
  if (src) return openGame(src);
  toast(`“${b.name}” is no longer saved in this browser`);
}

// ---------------------------------------------------------------------------
// import/export
// ---------------------------------------------------------------------------
// Always the real game (analysis lines ride along inside it) — a line on its
// own is not a game file, and importing one would produce a game with a node
// id and no tree to look it up in.
function exportCurrent() {
  const blob = new Blob([S.exportGame(liveGame)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${liveGame.name.replace(/[^\w-]+/g, '_')}.json`;
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
// The rules themselves — who may submit, whose orders are on time, what may be
// seen, which phase a deadline belongs to — live in js/online-rules.js, taking
// `game` and the fetched `online` snapshot explicitly so they can be tested
// against a hand-built phase. These wrappers bind those two.
const activePowers = () => O.activePowers(liveGame);
const hasAssignedPlayers = () => O.hasAssignedPlayers(liveGame);
const publishMode = () => O.publishMode(liveGame);
const trustedNow = () => O.trustedNow(online);
const deadlineDate = () => O.deadlineDate(liveGame);
const deadlinePassed = () => O.deadlinePassed(liveGame, online);
const deadlineUrgency = () => O.deadlineUrgency(liveGame, online);
const deadlineIsForCurrentPhase = () => O.deadlineIsForCurrentPhase(liveGame);
const ordersOpen = () => O.ordersOpen(liveGame, online);
const lateResubmitAllowed = (p) => O.lateResubmitAllowed(liveGame, p);
const isSubmitAllowed = (p) => O.isSubmitAllowed(liveGame, online, p);
const submissionOnTime = (found) => O.submissionOnTime(liveGame, found);
const phaseSubmission = (p) => O.phaseSubmission(liveGame, online, p);
const revealedEntry = (p) => O.revealedEntry(liveGame, online, p);
const powerOnlineStatus = (p) => O.powerOnlineStatus(liveGame, online, p);
const mySubmission = () => O.mySubmission(liveGame, online, assignedPower());
const matchesPhase = (x) => O.matchesPhase(liveGame, x);
const deadlineChainBase = () => O.deadlineChainBase(liveGame);
const bumpUnavailableReason = (hours, label) =>
  O.bumpUnavailableReason(liveGame, online, hours, label, fmtWhen);

const STATUS_ICON = {
  published: '✓', revealed: '✓', late: '⚠', submitted: '📨', none: '—', unknown: '…',
};

const STATUS_BADGE = {
  published: ['✓ published', 'st-published'],
  revealed: ['✓ revealed', 'st-published'],
  late: ['⚠ late edit — void', 'st-none'],
  submitted: ['📨 submitted', 'st-submitted'],
  none: ['— waiting', 'st-none'],
  unknown: ['…', 'st-none'],
};

// While a line is open the live game's online controls are not merely
// disabled, they are gone: submitting, reloading the table's moves and the
// deadline countdown all belong to the game, and a line is not it. The state
// behind them keeps refreshing in the background (refreshOnlineStatus), which
// is what lets a publish arriving mid-analysis void the tree straight away.
function hideOnlineUI() {
  for (const id of ['online-row', 'btn-submit-moves', 'submit-status', 'btn-catch-up',
    'deadline-countdown']) $(id).hidden = true;
}

function renderOnlineUI() {
  if (!liveGame || inAnalysis()) return;
  const hasPlayers = hasAssignedPlayers();
  if (document.activeElement !== $('autopublish-toggle')) {
    $('autopublish-toggle').checked = publishMode() === 'auto';
  }
  $('btn-submit-moves').hidden = !assignedPower();
  $('submit-status').hidden = !assignedPower();
  $('online-row').hidden = !hasPlayers;
  renderCatchUpButton();
  const loadMovesBtn = $('btn-load-moves');
  // The game master's one on-ramp into the resolve → publish flow is
  // ⏰ Deadline → ⬇ Load orders. This button only ever appeared for them AFTER
  // that (the Orders panel is gated on gmOrdersLoaded), so it could only show
  // them what they had already loaded — and in manual mode nothing is published
  // yet, so it could only ever say "no published moves for this phase". Two
  // buttons for one act, disagreeing about it. It keeps both its other
  // meanings: a player reloading their own submission, a spectator loading the
  // table's revealed moves.
  loadMovesBtn.hidden = isOwnerView();
  if (assignedPower()) {
    loadMovesBtn.title = 'Replace the box with your currently published orders, discarding local changes';
    // gated state (greyed out once the box already matches) is kept in
    // step with every keystroke by renderSubmitStatus(), not here
  } else {
    setGated(loadMovesBtn, null, "Fill the order box with every power's submitted moves for the current phase");
  }
  renderDeadlinePanel();
  renderSubmitStatus();
  updateDeadlineCountdown();
  if (hasPlayers) renderDeadlineInfo();
  // only re-render the submissions modal's contents while it's actually open —
  // it's no longer part of the always-visible sidebar, so there's no need to
  // keep it in step on every poll otherwise
  if (liveGame.published && isOwnerView() && !$('submissions-modal').hidden) renderSubmissionsModal();
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
  const matchesRecord = s && T.normalizeOrders(powerBlockText(p)) === T.normalizeOrders(s.orders);
  setGated(
    loadBtn,
    !s
      ? 'Nothing on record for you this phase yet — there is nothing to reload'
      : matchesRecord
        ? 'The box already matches what you submitted — nothing to reload'
        : null,
    'Replace the box with your currently published orders, discarding local changes',
  );
  el.classList.remove('drift');
  btn.classList.remove('primary');
  // Label reflects whether *anything* has been submitted for this phase yet,
  // independent of whether the button is currently enabled.
  btn.textContent = s ? '🔁 Re-submit orders' : '📤 Submit orders';
  el.classList.toggle('done', status === 'published' || status === 'revealed' || status === 'submitted');
  const allowed = isSubmitAllowed(p);
  if (status === 'published') {
    el.textContent = '✓ Published — your moves are locked in for this phase';
    setGated(btn, 'Your moves are published and locked in for this phase — nothing left to submit');
    return;
  }
  if (status === 'revealed') {
    el.textContent = '✓ Revealed — the deadline passed and everyone can see your moves';
    setGated(btn, 'The deadline has passed and your moves are revealed — they can no longer be changed');
    return;
  }
  if (status === 'late') {
    el.textContent = allowed
      ? '⚠ Edited after the deadline — your game master has allowed you to resubmit'
      : '⚠ Edited after the deadline — this submission is void';
    setGated(btn, allowed ? null : 'You edited this submission after the deadline, so it is void — ask your game master to re-open your window');
    return;
  }
  if (!allowed) {
    const why = deadlinePassed()
      ? 'The deadline has passed — submissions are closed until your game master confirms a new one'
      : 'No deadline is set yet — submissions open once your game master confirms one';
    el.textContent = deadlinePassed()
      ? 'Deadline passed — submissions are closed'
      : "No deadline set yet — ask your game master, then you can submit";
    setGated(btn, why);
    return;
  }
  if (s) {
    // Dragging a unit rewrites the order box, and that is indistinguishable
    // from dragging one *before* submitting — so say outright when the box and
    // the submission have parted company. Otherwise "✓ Submitted" quietly
    // refers to orders that are no longer the ones on screen.
    if (!matchesRecord) {
      setGated(btn, null, 'Submit your orders to the game');
      el.classList.remove('done');
      el.classList.add('drift');
      el.textContent = '✎ The box no longer matches what you submitted — 🔁 Re-submit to update it';
      btn.classList.add('primary');
      return;
    }
    setGated(btn, 'Already submitted, and the box still matches — change an order to re-submit');
    const when = s.submittedAt ? ' · ' + new Date(s.submittedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '';
    // Say which it was. Falling back to cleartext when the gist has no key
    // keeps the game playable, but a player should never have to guess whether
    // their orders are sitting in public view.
    el.textContent = online.sealKey
      ? `🔒 Submitted${when}`
      : `✓ Submitted${when} · unencrypted (this game has no key)`;
  } else {
    el.textContent = 'Not submitted for this phase yet';
    el.classList.remove('done');
    setGated(btn, null, 'Submit your orders to the game');
    btn.classList.add('primary');
  }
}

// ---- deadlines -------------------------------------------------------------
// The GM confirms every deadline (game.deadline, an ISO timestamp in
// game.json). When it passes, submissions close; what happens next depends
// on publishMode() — instant reveal, or GM review first.
// The ⏰ Deadline panel is the game master's entire publish flow, and the two
// modes want different controls in it. In auto mode autoPublishIfDue() resolves
// and publishes the phase on its own; leaving ⬇ Load orders on screen beside it
// offered a second, competing way to advance the same board from the same
// browser — the exact shape of the collision DECISIONS.md records under "A
// deadline belongs to a phase, not to a clock". So only one of the two paths is
// ever shown, and the panel says in words which one is live.
//
// Auto mode gets ⬇ Load orders back in the one case where auto-publish has
// stood down and cannot pick the phase up: nobody submitted (autoPublishIdleFor).
// Then the game master is the only way forward, and the button is the way.
function renderDeadlinePanel() {
  const panel = $('panel-deadline');
  if (panel.hidden) return;
  const auto = publishMode() === 'auto';
  const stoodDown = auto && autoPublishIdleFor === S.phaseLabel(liveGame);

  const status = $('deadline-auto-status');
  // Manual mode gets the one line worth surfacing outside auto-publish too:
  // once a deadline is set and hasn't passed, there is genuinely nothing to
  // do but wait for it.
  const manualWaiting = !auto && !!liveGame.deadline && !deadlinePassed();
  status.hidden = !(auto || manualWaiting);
  status.classList.toggle('past', stoodDown);
  if (auto) {
    status.textContent = stoodDown
      ? `⚠ Nobody submitted for ${S.phaseLabel(liveGame)} — auto-publish stood down. Load the orders yourself below, or confirm a new deadline to re-open submissions.`
      : autoPublishing
        ? '⚙ Publishing…'
        : !liveGame.deadline
          ? '⏳ No deadline set — nothing publishes until you confirm one.'
          : deadlinePassed()
            ? '⏳ Deadline passed — publishing on the next check, within a minute.'
            : '⏳ Waiting for the deadline.';
  } else if (manualWaiting) {
    status.textContent = '⏳ Waiting for the deadline.';
  }

  $('deadline-manual-row').hidden = auto && !stoodDown;
  const loadBtn = $('deadline-load-btn');
  loadBtn.textContent = stoodDown ? '⬇ Load orders (auto-publish stood down)' : '⬇ Load orders';
  const d = deadlineDate();
  setGated(
    loadBtn,
    gmOrdersLoaded
      ? 'Orders are already loaded — resolve them in the Orders panel below.'
      : ordersOpen()
        ? `Submissions are open until ${fmtWhen(d.getTime())}. Wait for the deadline, or ✖ Clear it to load now and skip the phase forward.`
        : null,
    "Loads submitted orders once the deadline passes — or, with no deadline set, opens an empty box so you can skip the game forward",
  );
  setGated($('deadline-clear'),
    liveGame.deadline ? null : 'No deadline is set — there is nothing to clear',
    'Remove the deadline — submissions stay closed until you confirm a new one');
  renderDeadlineButtons();
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
    el.textContent = `⏰ Deadline: ${when} (in ${fmtCountdown(d - trustedNow())})`;
    el.classList.add('warn');
  } else {
    // This element sits in the (player/spectator-only, once a GM has loaded
    // orders it's the GM's too) online-row — the game master's own copy stays
    // hidden behind gmGated until they ⬇ Load orders, so the isOwnerView()
    // case here only ever shows to the GM in the brief window after loading.
    // A game master sitting in 🧑 Player view sees this line and not the
    // ⏰ Deadline panel (which is gated on isOwnerView()), so it is the only
    // place their own suspended auto-publish can be said out loud — see
    // autoPublishIfDue()'s known limitation.
    el.textContent =
      isPlayingAsPlayer() && publishMode() === 'auto'
        ? `⏰ Deadline passed (${when}) — ⚡ auto-publish is paused while you're in 🧑 Player view. Switch to 👑 Game Master (⚙ Settings → 🎭 Play as) to publish.`
        : publishMode() === 'auto'
          ? `⏰ Deadline passed (${when}) — all submissions are revealed. ⬇ Load them, then Resolve to preview the result`
          : isOwnerView()
            ? `⏰ Deadline passed (${when}) — ⬇ Load orders in the ⏰ Deadline panel, resolve, then publish`
            : `⏰ Deadline passed (${when}) — the game master is resolving the results`;
    el.classList.add('past');
  }
}

// Ticks the topbar countdown chip — visible to every viewer (GM and players
// alike) of a published game with players assigned, so it's always clear
// whether orders are open, closing soon, or closed. Cheap text/class update
// only; called from a 1s interval plus on-demand from refreshAll()/renderOnlineUI().
function updateDeadlineCountdown() {
  const chip = $('deadline-countdown');
  const panel = $('panel-deadline');
  const hasPlayers = hasAssignedPlayers();
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
    chip.textContent = `⏰ ${fmtCountdownDHMS(d.getTime() - trustedNow())}`;
    chip.title = `Orders open — deadline: ${d.toLocaleString()}`;
    chip.classList.add('warn');
    panel.classList.add('deadline-warn');
  } else {
    chip.textContent = '⏰ Orders closed';
    chip.title = 'The deadline has passed — submissions are closed until the game master confirms a new one';
    chip.classList.add('danger');
    panel.classList.add('deadline-danger');
  }
  // A step expires the moment "previous deadline + 24 h" slips into the past,
  // which is a per-second fact like the countdown itself — same urgency
  // question, same tick, and attribute-only work on three buttons.
  if (!panel.hidden) renderDeadlineButtons();
}

// The one place a deadline is taken away — ✖ Clear and both publish paths.
// The instant it goes, its time is kept as game.lastDeadline: publishing a
// phase clears the deadline, so without this "+1 week" would have nothing left
// to chain from at exactly the press that matters, and would silently fall
// back to now + 1 week. The rhythm outlives the deadline that set it.
function clearDeadline(g) {
  if (g.deadline) g.lastDeadline = g.deadline;
  g.deadline = null;
  g.deadlineFor = null;
}

async function setDeadline(date) {
  if (!date) clearDeadline(liveGame);
  else {
    liveGame.deadline = date.toISOString();
    // Stamp the phase this deadline is for, so it can never outlive it — see
    // deadlineIsForCurrentPhase().
    liveGame.deadlineFor = O.currentPhase(liveGame);
  }
  S.saveGame(liveGame);
  renderDeadlineInfo();
  await pushSettings(
    date
      ? `Deadline confirmed: ${date.toLocaleString()}`
      : 'Deadline cleared — submissions stay closed until you confirm a new one',
    'Could not save the deadline'
  );
}

// GM: how the deadline resolves — auto-resolve on its own, or load and
// resolve it yourself.
async function setPublishMode(mode) {
  liveGame.publishMode = mode;
  S.saveGame(liveGame);
  renderOnlineUI();
  await pushSettings(
    mode === 'auto'
      ? 'Auto publish: the phase resolves and publishes itself the moment the deadline passes'
      : 'Manual publish: after the deadline, ⬇ Load orders and resolve/publish it yourself',
    'Could not save the setting'
  );
}

const BUMP_STEPS = [
  ['deadline-plus-week', 7 * 24, '+1 week'],
  ['deadline-plus-2day', 48, '+48 h'],
  ['deadline-plus-day', 24, '+24 h'],
];

function bumpDeadline(hours, label) {
  const reason = bumpUnavailableReason(hours, label);
  if (reason) return toast(reason);
  setDeadline(new Date(O.bumpTarget(liveGame, online, hours)));
}

// Greys out the steps whose window has closed and, for the rest, names the
// exact date the press would set — "+1 week" is far more useful when you can
// see it means Saturday. Driven from updateDeadlineCountdown()'s 1s tick, so a
// step disables itself the moment it expires; attribute-only work on three
// buttons.
function renderDeadlineButtons() {
  for (const [id, hours, label] of BUMP_STEPS) {
    const reason = bumpUnavailableReason(hours, label);
    const when = fmtWhen(O.bumpTarget(liveGame, online, hours));
    setGated($(id), reason, `Sets the deadline to ${when} — ${label} from the previous one`);
  }
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
    login.textContent = (liveGame.players || {})[p] ? '@' + (liveGame.players || {})[p] : '—';
    const st = powerOnlineStatus(p);
    const status = document.createElement('span');
    status.className = 'pstatus ' + STATUS_BADGE[st][1];
    status.textContent = STATUS_ICON[st];
    status.title = STATUS_BADGE[st][0];
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
  liveGame.lateResubmit = { ...(liveGame.lateResubmit || {}) };
  if (allow) liveGame.lateResubmit[power] = O.currentPhase(liveGame);
  else delete liveGame.lateResubmit[power];
  S.saveGame(liveGame);
  renderSubmissionsModal();
  const ok = await pushSettings(
    allow
      ? `${cap(power)} may resubmit past the deadline for this phase`
      : `Late resubmission revoked for ${cap(power)}`,
    'Could not save the authorization'
  );
  if (ok) await refreshOnlineStatus();
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
  const canPlay = !!(liveGame && liveGame.published && liveGame.isOwner && liveGame.assignedPower);
  row.hidden = !canPlay;
  if (!canPlay) return;
  const sel = $('play-as-select');
  sel.options[1].textContent = `${POWER_FLAGS[liveGame.assignedPower] || ''} ${cap(liveGame.assignedPower)}`;
  sel.value = isPlayingAsPlayer() ? 'player' : 'gm';
}

function setPlayAs(mode) {
  if (!liveGame) return;
  const toPlayer = mode === 'player';
  liveGame.playAs = toPlayer ? 'player' : 'gm';
  S.saveGame(liveGame);
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
    input.value = (liveGame.players || {})[p] || '';
    input.dataset.power = p;
    row.append(name, input);
    rows.appendChild(row);
  }
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
  if (O.viewerPosition(g) === O.viewerPosition(fresh)) return;
  if (O.extendsOurHistory(g, fresh)) {
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
  const g = liveGame;
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
    if (liveGame !== g) return; // user switched games while we were fetching
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
      g.lastDeadline = fresh.lastDeadline || g.lastDeadline || null; // the bump buttons' chain base
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
    // The order box belongs to whatever is on screen, so while a line is open
    // nothing here may touch it — refilling it from the live game's phase, or
    // dropping the player's submitted orders into it, would quietly rewrite
    // the line they are working on. The fetch itself still ran, which is
    // the point: this is how a publish arriving mid-analysis is noticed.
    const boxIsLive = !inAnalysis();
    if (changed && boxIsLive) {
      renderCountrySelect();
      prefillOrders(true);
      onOrdersChanged();
    }
    if (boxIsLive) maybeRestoreSubmission();
    renderOnlineUI();
    renderPlayAsControls();
    // A line rooted at a position the gist has now moved past is void. Say so
    // where the person actually is — inside the line — rather than waiting for
    // them to come back out and find it gone.
    renderAnalysisUI();
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
  if (parseOrders(powerBlockText(p), livePhaseKind()).orders.length) return;
  replacePowerBlock(p, s.orders);
  toast('Loaded your published orders', 'info');
}

async function doSubmitMoves() {
  const power = assignedPower();
  if (!power) return;
  if (!isSubmitAllowed(power)) {
    return toast(
      liveGame.deadline
        ? 'The deadline has passed — ask your game master to re-open with a new deadline'
        : "Your game master hasn't set a deadline yet — submissions open once they confirm one"
    );
  }
  if (!getToken() && !askToken()) return;
  // only this player's block is submitted, whatever view the box is in
  const block = powerBlockText(power);
  const parsed = parseOrders(power.toUpperCase() + '\n' + block, livePhaseKind());
  if (parsed.errors.length) return toast('Fix the order problems first');
  if (!parsed.orders.length) return toast(`Write some ${cap(power)} orders first`);
  const btn = $('btn-submit-moves');
  btn.disabled = true;
  try {
    const { comment, sealed } = await submitOrders(liveGame.gistId, {
      power, year: liveGame.year, season: liveGame.season, step: liveGame.step,
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
    const { text, submitted } = O.gatherPhaseBlocks(liveGame, online, 'revealed');
    if (!submitted) return toast('No published moves for this phase yet');
    applyOrdersText(text);
    toast(`Loaded moves for ${submitted} power${submitted === 1 ? '' : 's'}`, 'info');
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
  if (ordersOpen()) return toast('Submissions are still open — wait for the deadline, or ✖ Clear it to load now and skip the phase forward');
  try {
    if (!online.comments) await refreshOnlineStatus();
    // Every active power gets a header — submitted powers get their orders,
    // everyone else gets the blank per-phase template — so the box always
    // shows the full roster to fill in by hand, submissions or not.
    const blanks = T.splitOrdersByPower(defaultOrdersText());
    const { text, submitted } = O.gatherPhaseBlocks(liveGame, online, 'gm', blanks);
    applyOrdersText(text);
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
//
// `phase` is the phase the orders BELONG to (the entry returned by
// S.resolvePhase carries it), never game.year/season/step — by the time this
// runs the game has already been advanced to the next phase, and stamping the
// record with that would make every power look already-published for a phase
// nobody has ordered in yet, locking them all out of submitting.
async function gmWriteLoadedMovesFiles(text, phase) {
  const byPower = T.splitOrdersByPower(text);
  if (!byPower.size) return;
  const moves = await readMovesFiles(await fetchGist(liveGame.gistId));
  const updates = {};
  for (const [p, lines] of byPower) {
    const ordersText = lines.slice(1).join('\n').trim();
    if (!ordersText) continue;
    updates[p] = upsertMovesEntry(moves[p], p, {
      year: phase.year, season: phase.season, step: phase.step, orders: ordersText,
      by: online.login || 'game master', submittedAt: null,
      publishedAt: new Date().toISOString(), publishedBy: 'gm',
    });
  }
  if (Object.keys(updates).length) await writeMovesFiles(liveGame.gistId, updates);
}

// A GM setting — the deadline, the publish mode, player assignments, a late
// grace, the house rules — pushed to the gist and reported. Five callers used
// to spell this out, each with its own wording for the same failure.
//
// It passes game.publishedState as the board override, which is the point:
// these writes go into the same game.json as the position, and without it
// confirming a deadline mid-resolve would silently leak the GM's unpublished
// board as a side effect, defeating the dirty check. See DECISIONS.md,
// "Publishing the board is a separate, explicit act from resolving it".
//
// Returns true when the push landed, so a caller can close its modal or
// refresh only on success.
async function pushSettings(okMsg, failMsg) {
  try {
    await updatePublished(liveGame, liveGame.publishedState);
    if (okMsg) toast(okMsg, 'info');
    return true;
  } catch (e) {
    toast(failMsg + ': ' + e.message);
    if (isAuthError(e)) askToken();
    return false;
  }
}

// The authoritative publish, shared by the game master's 📣 Publish results and
// by auto-publish. Resolving for real and pushing are one act with a fixed
// order, and the two callers used to spell it out separately — which is how
// they came to differ by accident.
//
// The deadline is cleared as part of it, deliberately: a stale "already passed"
// timestamp carried into the next phase is exactly what auto-published an
// all-hold Fall 1901 nobody had ordered in. The GM confirms a fresh one each
// phase. Returns the history entry, whose phase stamp is the one the orders
// belong to — never game.year/season/step, which has already advanced by then.
async function publishResolvedPhase(orders, text) {
  const entry = S.resolvePhase(liveGame, orders, text);
  S.saveGame(liveGame);
  await gmWriteLoadedMovesFiles(text, entry);
  clearDeadline(liveGame);
  await updatePublished(liveGame);
  liveGame.publishedState = S.boardSnapshot(liveGame);
  S.saveGame(liveGame);
  return entry;
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
  updatePlaybackFloat();
  await board.animateFinal(pb.entry);
  if (playback !== pb) return;
  try {
    const entry = await publishResolvedPhase(pb.pendingOrders, pb.pendingText);
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
// KNOWN LIMITATION, deliberately accepted for now: a GM who leaves their
// browser in 🧑 Player mode therefore never auto-publishes at all, and has to
// change hats (or ☁ Publish changes) when a deadline falls due. Nothing is
// lost when they don't — the deadline and its stamp stay put — but for a GM
// playing their own power, which is the common case, this is a worse deal than
// before. Publishing without ever entering the GM view is expected to come
// back; the fix is NOT to re-widen this gate to raw game.isOwner (that is the
// collision described above) but to make the authoritative publish resolve the
// phase named by deadlineFor rather than whatever phase is on the table, or to
// let a GM's own resolveRevealedLocally() confirm and publish what it resolved.
// See DECISIONS.md, "A deadline belongs to a phase, not to a clock".
//
// It also stands down while a preview is open (`playback`), so it never yanks
// the board out from under one.
async function autoPublishIfDue() {
  if (!liveGame || !liveGame.published || !isOwnerView() || playback || autoPublishing) return;
  if (publishMode() !== 'auto') return;
  if (!deadlineIsForCurrentPhase() || !deadlinePassed()) return;
  // The board came from an optimistic local resolve that no GM has confirmed
  // (a play-as session earlier in this browser). Its phase is not ours to
  // publish — belt and braces for games too old to carry a deadlineFor stamp.
  if (liveGame.provisionalPhase) return;
  autoPublishing = true;
  try {
    await refreshOnlineStatus();
    // refreshOnlineStatus() re-reads deadline/deadlineFor/publishMode from the
    // gist (it is authoritative for all three), so re-test before committing
    // to a resolution — the GM may have moved the deadline from another device
    // in the moments since the gate above.
    if (publishMode() !== 'auto' || !deadlineIsForCurrentPhase() || !deadlinePassed()) return;
    const { text, submitted } = O.gatherPhaseBlocks(liveGame, online, 'ontime');
    // Not one power submitted anything readable and on time. Resolving that is
    // a whole-board all-hold nobody asked for — never a result worth committing
    // unattended, and the shape every "the deadline outlived its phase" bug
    // takes. Stand down and leave it to the GM. Note this counts *submissions*,
    // not orders: a power that deliberately submits nothing but holds has a
    // non-empty block and counts, which is the (rare, legal) all-hold phase
    // players actually chose.
    if (!submitted) {
      const label = S.phaseLabel(liveGame);
      if (autoPublishIdleFor !== label) {
        autoPublishIdleFor = label;
        toast(
          `Auto-publish paused — no orders were submitted for ${label}. ` +
          'Resolve it yourself in ⏰ Deadline, or confirm a new deadline to re-open submissions.'
        );
      }
      return;
    }
    const parsed = parseOrders(text, livePhaseKind());
    const entry = await publishResolvedPhase(parsed.orders, text);
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
  liveGame.players = players;
  S.saveGame(liveGame);
  if (await pushSettings('Player assignments saved to the published game', 'Save failed')) {
    closePlayersModal();
    await refreshOnlineStatus();
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
    const { id, url } = await publishGame(liveGame);
    liveGame.gistId = id;
    liveGame.gistUrl = url;
    liveGame.published = true;
    liveGame.isOwner = true;
    delete liveGame.branchedFrom; // it is its own game now, not a copy of one
    liveGame.publishedState = S.boardSnapshot(liveGame);
    S.saveGame(liveGame);
    refreshAll();
    const shareLink = `${location.origin}${location.pathname}?gist=${id}`;
    prompt(
      'Published — this sandbox is now the live game, and you are its game master. ' +
      'Send this link to every player: they get the position live, can pick their ' +
      'country to draft orders, and can preview or analyse freely without ever ' +
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
    await updatePublished(liveGame);
    liveGame.publishedState = S.boardSnapshot(liveGame);
    S.saveGame(liveGame);
    $('btn-update-published').disabled = !boardDirty();
    updateSyncPill();
    const hasPlayers = hasAssignedPlayers();
    if (hasPlayers && !ordersOpen()) {
      toast(`Published ${S.phaseLabel(liveGame)} — now confirm the next deadline in ⏰ Deadline`, 'info');
    } else {
      toast(`Published — every player now sees ${S.phaseLabel(liveGame)}`, 'info');
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
  if (!isOnline() || !liveGame.gistId) return;
  if (!confirm(
    'Reload the published position?\n\n' +
    'Every local change to this game\'s board, phase and history is thrown away ' +
    'and replaced with what is on the shared link. Your draft orders stay in the box.'
  )) return;
  try {
    const { game: fresh } = await fetchPublished(liveGame.gistId);
    const keep = {
      name: liveGame.name,
      gistId: liveGame.gistId,
      gistUrl: liveGame.gistUrl,
      published: true,
      isOwner: liveGame.isOwner,
      myCountry: liveGame.myCountry,
      assignedPower: liveGame.assignedPower,
      playAs: liveGame.playAs,
    };
    playback = null;
    // The game object itself is replaced, so the analysis tree that hung off
    // the old one goes with it — which is right: this is the position moving.
    liveGame = game = Object.assign(S.importGame(JSON.stringify(fresh)), keep);
    liveGame.settings = S.gameSettings(liveGame);
    liveGame.publishedState = S.boardSnapshot(liveGame);
    liveDraft = null;
    S.saveGame(liveGame);
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
        : 'Loaded published game — pick your country to write orders, or 🌿 Analysis to plan ahead',
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
    if (!inAnalysis() && boardDirty() && !confirm(
      'This game has changes that are not published yet.\n\n' +
      'Leave anyway? They stay saved here — ☁ Publish changes when you come back.'
    )) return;
    if (inAnalysis()) {
      persistLineOrders();
      flushLineSave();
      game = liveGame; // the tree stays on the game, ready for next time
    }
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
  new ResizeObserver(() => { topbarH(); fitTopbar(); }).observe($('topbar'));
  topbarH();
  fitTopbar();

  for (const b of document.querySelectorAll('#mobile-tabbar .mtab')) {
    b.onclick = () => selectMobileSheet(b.dataset.sheet);
  }
  // the sheet grows and shrinks with its contents (playback list, warnings…),
  // and the board pane's inset has to follow it
  new ResizeObserver(updateSheetInset).observe($('sidebar'));
  addEventListener('resize', updateSheetInset);

  // On a phone the Orders sheet opens onto three collapsible panels at once
  // (History, Edit board, Builds/Orders) — closed by default so the sheet
  // isn't a wall of headings the first time it's opened. This runs once, at
  // load: a <details> keeps its own open/closed state after that exactly as
  // it always has, so an option the user has expanded stays expanded.
  if (matchMedia('(max-width: 820px)').matches) {
    for (const id of ['panel-history', 'edit-board-section', 'panel-orders']) {
      $(id).open = false;
    }
  }

  // (?) buttons: click reveals the paragraph beside them, click again hides
  // it. Both sit inside a <summary> — without preventDefault the click would
  // also toggle the panel itself open/closed, since that is <summary>'s own
  // default action for any click landing inside it.
  $('an-help').onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    $('analysis-help').hidden = !$('analysis-help').hidden;
  };
  $('orders-help').onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    $('orders-help-text').hidden = !$('orders-help-text').hidden;
  };
  // autopublish-help sits inside the <label> that toggles ⚡ Auto-Publish
  // itself — without stopPropagation a click here would also flip the switch,
  // since the browser forwards an unhandled click on any control inside a
  // <label> to the label's own associated input.
  $('autopublish-help').onclick = (e) => {
    e.stopPropagation();
    $('autopublish-explain').hidden = !$('autopublish-explain').hidden;
  };
  // A gated button (setGated) is deliberately still clickable so it can explain
  // itself. Capture phase, so the button's own onclick never runs.
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[aria-disabled="true"]');
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    if (b.dataset.gatedReason) toast(b.dataset.gatedReason);
  }, true);

  $('settings-btn').onclick = (e) => {
    e.stopPropagation();
    $('settings-menu').classList.toggle('open');
  };
  // picking an action closes the menu; the 🎭 Play as row is a <select>, not a
  // <button>, so changing it leaves the menu open
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
  const gmPublishFlow = () => isOwnerView() && liveGame.published;
  $('btn-resolve').onclick = () => (isReadOnly() || gmPublishFlow() ? previewResolve(false, gmPublishFlow()) : resolveCurrent());
  $('btn-resolve-final').onclick = () => (isReadOnly() || gmPublishFlow() ? previewResolve(true, gmPublishFlow()) : resolveAndSkip());
  $('btn-token').onclick = doEditToken;
  $('btn-publish').onclick = doPublish;
  $('btn-update-published').onclick = doUpdatePublished;
  $('btn-revert-published').onclick = revertToPublished;
  $('btn-open-source').onclick = openBranchSource;
  $('btn-sync').onclick = doUpdatePublished;
  $('country-select').onchange = () => {
    liveGame.myCountry = $('country-select').value || null;
    S.saveGame(liveGame);
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
  for (const [id, hours, label] of BUMP_STEPS) $(id).onclick = () => bumpDeadline(hours, label);
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
    saveCurrent();
    refreshAll();
  };
  $('edit-1901').onclick = () => {
    if (!confirm('Reset the board to the 1901 starting position?')) return;
    const fresh = S.newGame('x');
    game.units = fresh.units;
    game.scOwners = fresh.scOwners;
    game.pending = null;
    saveCurrent();
    refreshAll();
  };
  $('edit-clear').onclick = () => {
    if (!confirm('Remove all units and set every supply center neutral?')) return;
    game.units = [];
    for (const k of Object.keys(game.scOwners)) game.scOwners[k] = null;
    game.pending = null;
    saveCurrent();
    refreshAll();
  };

  $('pb-next').onclick = () => stepPlayback(1);
  $('pb-prev').onclick = () => stepPlayback(-1);
  $('pb-start').onclick = () => stepPlayback(-999);
  $('pb-end').onclick = () => stepPlayback(999);
  const pbContinue = () => (playback && playback.gmPublish ? gmPublishPreview() : continuePlayback());
  $('pb-continue').onclick = pbContinue;
  $('pb-back-current').onclick = endPlayback;
  $('pb-copy').onclick = copyResults;
  $('pb-branch').onclick = copyCurrentToSandbox;
  // the floating on-map set drives the same playback as the sidebar's
  $('pbf-next').onclick = () => stepPlayback(1);
  $('pbf-prev').onclick = () => stepPlayback(-1);
  $('pbf-start').onclick = () => stepPlayback(-999);
  $('pbf-end').onclick = () => stepPlayback(999);
  $('pbf-continue').onclick = pbContinue;
  $('pbf-back').onclick = endPlayback;
  document.addEventListener('keydown', (e) => {
    if (playback && !$('panel-playback').hidden && document.activeElement.tagName !== 'TEXTAREA') {
      if (e.key === 'ArrowRight') stepPlayback(1);
      if (e.key === 'ArrowLeft') stepPlayback(-1);
    }
  });

  $('btn-replay').onclick = replaySelected;
  $('btn-undo').onclick = undoPhase;
  $('btn-redo').onclick = doRedoPhase;
  $('btn-copy-sandbox').onclick = copyCurrentToSandbox;

  // 🌿 analysis
  $('ms-live').onclick = exitAnalysis;
  $('ms-analysis').onclick = enterAnalysis;
  $('an-new-folder').onclick = newFolder;
  $('an-branch').onclick = branchLine;
  $('an-rename').onclick = renameSelected;
  $('an-delete').onclick = deleteSelected;
  $('an-use-orders').onclick = useLineOrdersLive;

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
  // Both ticks watch the LIVE game, whichever line is on screen: a line is
  // exactly when a player is least likely to notice the deadline passing or
  // the table's next phase landing, so the poll that notices it for them must
  // not stand down just because the board shows a hypothetical.
  setInterval(() => {
    if (liveGame && liveGame.published && !playback) {
      if (inAnalysis()) renderAnalysisUI();
      else renderOnlineUI();
      // Deliberately runs during analysis too: the table is waiting on this
      // browser, and a line is a private aside. Publishing moves the live
      // position, so validateAnalysis() then clears the tree and says so —
      // being pulled out of a hypothetical beats a phase never publishing.
      if (liveGame.isOwner) autoPublishIfDue();
    }
  }, 60000);

  // the topbar countdown chip ticks every second on its own — far cheaper
  // than a full renderOnlineUI(), and it's the one place a second matters
  setInterval(() => {
    if (liveGame && liveGame.published && !playback && !inAnalysis()) updateDeadlineCountdown();
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
    stepPlayback(999);
    stepPlayback(-1);
  } else if (stage === 'final') {
    stepPlayback(999);
  }
  done();
  function done() {
    document.body.dataset.autotestDone = '1';
  }
}

// top-level await: the page's load event (and headless screenshots) wait for
// the board to be ready
await init();
