// What actually reaches the gist (js/publish.js stripForPublish).
//
// game.json is PUBLIC — anyone with the link reads it, which in a running game
// means every opponent at the table. stripForPublish is a drop list, not a
// keep list, so a field added to the game object is published unless somebody
// remembers to think about it. This suite is that reminder: it asserts the
// exact key set of the payload, so a new field on a game fails the build until
// it has been classified as shared or private.
//
// The field that made this worth writing is `analysis` — the tree of plans and
// variations this browser is working out against the other six powers
// (js/analysis.js). Publishing it would hand every player their opponent's
// notes, and nothing in the app would have looked wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stripForPublish } from '../js/publish.js';
import { newGame, boardSnapshot } from '../js/state.js';
import { newTree, addLine, renameNode } from '../js/analysis.js';

// Everything the app ever writes onto a game object, private half included —
// see openGame/loadPublishedGame/doPublish/refreshOnlineStatus in js/app.js.
function fullyLoadedGame() {
  const g = newGame('the real game');
  // shared: the table needs all of this
  g.deadline = '2026-09-13T22:00:00.000Z';
  g.deadlineFor = { year: 1901, season: 'spring', step: 'movement' };
  g.lastDeadline = '2026-09-06T22:00:00.000Z';
  g.publishMode = 'auto';
  g.players = { france: 'someone', germany: 'someone-else' };
  g.lateResubmit = { italy: { year: 1901, season: 'spring', step: 'movement' } };
  // private: this browser's own session, role and secrets
  g.gistId = 'abc123';
  g.gistUrl = 'https://gist.github.com/abc123';
  g.published = true;
  g.isOwner = true;
  g.myCountry = 'france';
  g.assignedPower = 'france';
  g.playAs = 'player';
  g.publishedState = boardSnapshot(g);
  g.provisionalPhase = { year: 1901, season: 'spring', step: 'movement' };
  g.branchedFrom = { name: 'somewhere', gistId: null, label: 'Spring 1901' };
  g.sandbox = true;
  g.analysis = newTree(g);
  const line = addLine(g.analysis, { position: g.analysis.root });
  renameNode(g.analysis, line.id, 'Attack Munich in the spring');
  line.game.orders = 'FRANCE\nA Par - Bur';
  return g;
}

// Adding a field to a game means deciding, here, whether the table may see it.
const PUBLISHED_KEYS = [
  'name', 'created', 'season', 'year', 'step', 'settings', 'units', 'scOwners',
  'pending', 'history', 'redoStack',
  'deadline', 'deadlineFor', 'lastDeadline', 'publishMode', 'players', 'lateResubmit',
];

const PRIVATE_KEYS = [
  'gistId', 'gistUrl', 'published', 'isOwner', 'myCountry', 'assignedPower',
  'publishedState', 'branchedFrom', 'sandbox', 'provisionalPhase', 'playAs',
  'analysis',
];

test('the published payload is exactly the shared fields, and no others', () => {
  const keys = Object.keys(stripForPublish(fullyLoadedGame())).sort();
  assert.deepEqual(keys, [...PUBLISHED_KEYS].sort(),
    'a new game field must be classified in stripForPublish before it can ship');
});

test('every viewer-local field is dropped', () => {
  const payload = stripForPublish(fullyLoadedGame());
  for (const k of PRIVATE_KEYS) {
    assert.equal(k in payload, false, `${k} must never reach the gist`);
  }
});

// The one that is not merely untidy but a leak: an analysis tree is a player's
// plans against the other six, and game.json is world-readable.
test('the analysis tree never reaches the gist, in any form', () => {
  const g = fullyLoadedGame();
  const json = JSON.stringify(stripForPublish(g));
  assert.equal(json.includes('Attack Munich in the spring'), false);
  assert.equal(json.includes('A Par - Bur'), false);
  assert.equal(json.includes('analysis'), false);
});

test('a game with none of the private fields set publishes unchanged', () => {
  const plain = newGame('fresh');
  assert.deepEqual(Object.keys(stripForPublish(plain)), Object.keys(plain));
});
