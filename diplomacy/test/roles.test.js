// The permission model (js/roles.js): which of the two kinds of game am I in,
// and can what I do here change it?
//
// This matrix is what stops a spectator's stray click walking their board a
// turn ahead of the table's, and what makes 🎭 Play as a real player position
// rather than a simulation. It used to be nine functions reading a module
// global inside a 3,800-line file; every case below was previously only
// checkable by clicking.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isOnline, isSandbox, gameMode, isPlayingAsPlayer,
  isReadOnly, isOwnerView, boardDirty, myCountry, assignedPower,
} from '../js/roles.js';
import { newGame, boardSnapshot } from '../js/state.js';

const sandbox = () => newGame('practice');

const online = (over = {}) => ({
  ...newGame('the real game'),
  published: true,
  gistId: 'abc123',
  isOwner: false,
  ...over,
});

const gm = (over = {}) => online({ isOwner: true, ...over });

// ---------------------------------------------------------------------------
// the two kinds
// ---------------------------------------------------------------------------

test('a game is online or a sandbox, and nothing else', () => {
  assert.equal(isOnline(sandbox()), false);
  assert.equal(isSandbox(sandbox()), true);

  assert.equal(isOnline(online()), true);
  assert.equal(isSandbox(online()), false);

  // a branch is just a sandbox, however it was made
  const branch = { ...sandbox(), branchedFrom: { name: 'the real game', gistId: 'abc123' } };
  assert.equal(isSandbox(branch), true);
  assert.equal(gameMode(branch), 'sandbox');
});

test('no game at all is not a mode', () => {
  for (const nothing of [null, undefined]) {
    assert.equal(gameMode(nothing), '');
    assert.equal(isOnline(nothing), false);
    assert.equal(isSandbox(nothing), false);
    assert.equal(isReadOnly(nothing), false);
    assert.equal(isOwnerView(nothing), false);
    assert.equal(boardDirty(nothing), false);
  }
});

// ---------------------------------------------------------------------------
// the four faces
// ---------------------------------------------------------------------------

test('gameMode names all four faces', () => {
  assert.equal(gameMode(sandbox()), 'sandbox');
  assert.equal(gameMode(gm()), 'gm');
  assert.equal(gameMode(online()), 'spectator', 'no assignment = watching');
  assert.equal(
    gameMode(online({ assignedPower: 'france' })),
    'player',
    'an assigned power is a player'
  );
});

test('a sandbox is writable; a published game you do not own is not', () => {
  assert.equal(isReadOnly(sandbox()), false);
  assert.equal(isReadOnly(gm()), false);
  assert.equal(isReadOnly(online()), true);
  assert.equal(isReadOnly(online({ assignedPower: 'france' })), true);
});

// ---------------------------------------------------------------------------
// 🎭 Play as — a GM's own player position is real, not simulated
// ---------------------------------------------------------------------------

test('play-as needs a genuine self-assignment, not just the flag', () => {
  // the flag alone, with no power assigned, must not change anything
  assert.equal(isPlayingAsPlayer(gm({ playAs: 'player' })), false);
  // an assignment alone, still wearing the GM hat
  assert.equal(isPlayingAsPlayer(gm({ assignedPower: 'france' })), false);
  // both
  assert.equal(isPlayingAsPlayer(gm({ assignedPower: 'france', playAs: 'player' })), true);
  // a non-owner can never be "playing as" — they simply are a player
  assert.equal(isPlayingAsPlayer(online({ assignedPower: 'france', playAs: 'player' })), false);
});

test('a GM in player view runs the player’s code paths, not the GM’s', () => {
  const playing = gm({ assignedPower: 'france', playAs: 'player' });

  assert.equal(gameMode(playing), 'player', 'the stylesheet must colour it as a player');
  assert.equal(isOwnerView(playing), false, 'every GM-only control is gated on this');
  assert.equal(isReadOnly(playing), true, 'resolving is a preview; orders go via 📤 Submit');
  assert.equal(assignedPower(playing), 'france');

  // ...and switching the hat back restores the GM, touching nothing else
  const running = { ...playing, playAs: 'gm' };
  assert.equal(gameMode(running), 'gm');
  assert.equal(isOwnerView(running), true);
  assert.equal(isReadOnly(running), false);
  assert.equal(running.assignedPower, 'france', 'the assignment itself is untouched');
});

test('isOwnerView is not raw isOwner — that difference is load-bearing', () => {
  // auto-publish is gated on isOwnerView precisely so that running the game
  // and playing in it cannot both be live in one browser. See DECISIONS.md,
  // "A deadline belongs to a phase, not to a clock".
  const playing = gm({ assignedPower: 'france', playAs: 'player' });
  assert.equal(playing.isOwner, true);
  assert.equal(isOwnerView(playing), false);
});

// ---------------------------------------------------------------------------
// which power's orders am I writing?
// ---------------------------------------------------------------------------

test('myCountry only applies to a read-only viewer', () => {
  // a sandbox writes every power's orders, so there is no "my" country
  assert.equal(myCountry({ ...sandbox(), myCountry: 'france' }), '');
  // nor does a GM running the game — they hold the whole table's orders
  assert.equal(myCountry(gm({ myCountry: 'france' })), '');
  // a spectator who picked one, and a GM playing their power, do
  assert.equal(myCountry(online({ myCountry: 'france' })), 'france');
  assert.equal(
    myCountry(gm({ assignedPower: 'france', playAs: 'player', myCountry: 'france' })),
    'france'
  );
  assert.equal(myCountry(online()), '', 'spectating everything');
});

test('assignedPower is empty for anyone who is not a player', () => {
  assert.equal(assignedPower(sandbox()), '');
  assert.equal(assignedPower(gm({ assignedPower: 'france' })), '', 'GM view holds the whole table');
  assert.equal(assignedPower(online({ assignedPower: 'france' })), 'france');
});

// ---------------------------------------------------------------------------
// boardDirty — the ● pill and the ☁ Publish changes gate
// ---------------------------------------------------------------------------

test('only a game master can have unpublished changes', () => {
  assert.equal(boardDirty(sandbox()), false, 'a sandbox has nowhere to publish to');
  assert.equal(boardDirty(online()), false, 'a viewer never publishes');
  assert.equal(
    boardDirty(gm({ assignedPower: 'france', playAs: 'player' })),
    false,
    'the GM in player view is shown the player’s UI, pill included'
  );
});

test('boardDirty compares the position against what was last published', () => {
  const g = gm();
  assert.equal(boardDirty(g), true, 'never published = nothing on record to match');

  g.publishedState = boardSnapshot(g);
  assert.equal(boardDirty(g), false, 'just published');

  g.units = g.units.filter((u) => u.power !== 'france');
  assert.equal(boardDirty(g), true, 'the board moved on');

  g.publishedState = boardSnapshot(g);
  assert.equal(boardDirty(g), false);
});

test('drafting orders is never a change to publish', () => {
  // The order box does not touch the game object until resolvePhase() runs, so
  // a GM sketching arrows to plan their own move must not look dirty. This is
  // the reason boardSnapshot() exists as its own thing.
  const g = gm();
  g.publishedState = boardSnapshot(g);
  const before = JSON.stringify(g.publishedState);

  // anything that is not board state
  g.name = 'renamed';
  g.deadline = '2026-09-01T23:00:00Z';
  g.players = { france: 'someone' };
  g.myCountry = 'france';

  assert.equal(boardDirty(g), false);
  assert.equal(JSON.stringify(g.publishedState), before);
});
