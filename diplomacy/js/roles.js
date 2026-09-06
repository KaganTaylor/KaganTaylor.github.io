// Who am I in this game, and can what I do here change it?
//
// THERE ARE EXACTLY TWO KINDS OF GAME, and most of the rules below follow:
//
//   ☁ online  — a published gist. One authoritative position, one writer (the
//               game master). Nobody else's board actions can move it, and the
//               GM's only move it once they publish.
//   🧪 sandbox — everything else: private to this browser, freely editable,
//               freely resolvable, disposable. "Practice games", 🧪 Copy to
//               sandbox and the old empty-board sandbox are all just this —
//               there is no third kind, because the game is only ever really
//               played online and everything local is thinking-out-loud.
//
// A 🌿 ANALYSIS LINE IS NOT A THIRD KIND. It is a *view* of an online game —
// one node of the tree hanging off its current position (js/analysis.js) —
// wearing an ordinary game object so that every drag, resolve and board edit
// in app.js works on it unchanged. It is never saved as a game of its own, so
// the two kinds above still describe everything in the saved-games map.
//
// gameMode() names the five faces of that: 'sandbox', 'gm', 'player' (an
// assigned power in an online game), 'spectator' and 'analysis'. It is written
// to #game-screen[data-mode], which drives every piece of state colouring in
// the stylesheet, so the two models cannot drift apart.
//
// Every function here is a pure question about a game object — no DOM, no
// network, no module state — so the whole permission matrix is testable
// without a browser. See DECISIONS.md, "There are two kinds of game, and only
// two", "A line is a view, not a game" and "🎭 Play as".

import { boardSnapshot } from './state.js';

export function isOnline(game) {
  return !!(game && game.published);
}

// A line view (js/analysis.js lineGame) rather than a real game. Checked
// before isSandbox() everywhere, because a line looks exactly like a sandbox
// from the outside — unpublished, freely editable — and must not be granted a
// sandbox's one irreversible power: 📣 Publish would turn a hypothetical into
// the live game.
export function isAnalysisLine(game) {
  return !!(game && game.analysisOf);
}

export function isSandbox(game) {
  return !!game && !isOnline(game) && !isAnalysisLine(game);
}

export function gameMode(game) {
  if (!game) return '';
  if (isAnalysisLine(game)) return 'analysis';
  if (!isOnline(game)) return 'sandbox';
  if (isOwnerView(game)) return 'gm';
  return assignedPower(game) ? 'player' : 'spectator';
}

// True when the game master has switched (🎭 Play as) into playing their own
// assigned power rather than running the game. Requires a genuine self-
// assignment in game.players — see refreshOnlineStatus(), which resolves
// game.assignedPower for the owner exactly like it does for anyone else.
export function isPlayingAsPlayer(game) {
  return !!(game && game.isOwner && game.assignedPower && game.playAs === 'player');
}

// A published game can only be advanced by the browser that published it
// (holds the token that created its gist). Everyone else gets a live,
// previewable, branchable, but never mutable view of the position. A GM
// playing their own assigned power is read-only for the same reason: it's a
// faithful, real player experience — including the fact that resolving is
// only ever a preview and orders only reach the game via 📤 Submit.
export function isReadOnly(game) {
  return !!(game && game.published && (!game.isOwner || isPlayingAsPlayer(game)));
}

// True only for the real game master, and only while running the game rather
// than playing their own power — the gate on every GM-only control (Publish
// changes, Deadline panel, Submissions, Set players, Auto-Publish). Kept
// separate from the raw game.isOwner fact (still used as-is for identity/
// permission purposes, e.g. loadPublishedGame) so Play-as-Player can hide the
// GM's own admin controls without touching who actually owns the game.
export function isOwnerView(game) {
  return !!(game && game.isOwner && !isPlayingAsPlayer(game));
}

// True once the game master's local position (resolves, undos, redos, board
// edits) has moved on from what's actually live at the shared link — the
// gate on the "☁ Publish changes" button. Drafting in the order box never
// counts: that text isn't part of the game object until Resolve runs, so a
// GM can sketch out their own plan without it looking like a change to
// publish. See state.js boardSnapshot().
export function boardDirty(game) {
  if (!game || !game.published || !isOwnerView(game)) return false;
  if (!game.publishedState) return true;
  return JSON.stringify(boardSnapshot(game)) !== JSON.stringify(game.publishedState);
}

// Viewers of a published game pick the country they play; order entry
// (typing and dragging) then works for that power only, and "📋 Copy
// orders" hands them their order block to email to the game master. A GM
// playing as their own power is locked to it the same way a real player
// would be. Empty string = spectating / no country chosen.
export function myCountry(game) {
  return (isReadOnly(game) && game.myCountry) || '';
}

// The power the GM assigned to this browser's GitHub account (game.players
// maps power → login). An assigned player is locked to that power for the
// whole game — on every device, since the token resolves to the same login.
export function assignedPower(game) {
  return (isReadOnly(game) && game.assignedPower) || '';
}
