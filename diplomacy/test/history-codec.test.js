// js/history-codec.js — packs/unpacks game.history for the wire only.
// Round-trip must be the identity: pack then unpack gives back exactly what
// state.js produced, for every consumer (app.js playback, render.js, analysis.js).

import test from 'node:test';
import assert from 'node:assert/strict';

import { packHistory, unpackHistory } from '../js/history-codec.js';
import { newGame, resolvePhase } from '../js/state.js';
import { parseOrders } from '../js/parser.js';

function play(g, text) {
  const { orders } = parseOrders(text, g.step);
  return resolvePhase(g, orders, text);
}

// Builds a game with a movement phase that dislodges a unit (forcing a
// retreat phase) followed by a winter adjustment, so dislodged/standoffs/
// destroyed/pending are all exercised.
function multiPhaseGame() {
  const g = newGame('codec test');
  play(g, `
    AUSTRIA: A Vie - Gal
    RUSSIA: A War - Gal
    RUSSIA: A Mos - War
  `);
  // Vie and War bounce into Gal (standoff); no dislodgement there, so force one directly.
  return g;
}

function dislodgingGame() {
  const g = newGame('codec test 2');
  play(g, `
    GERMANY: A Ber - Kie
    GERMANY: F Kie - Hol
    GERMANY: A Mun S A Ber - Kie
  `);
  play(g, `
    GERMANY: A Kie H
    RUSSIA: F Bal - Kie
  `);
  return g;
}

test('round-trip is the identity for a multi-phase game', () => {
  const g = dislodgingGame();
  const g2 = multiPhaseGame();
  for (const game of [g, g2]) {
    const roundTripped = unpackHistory(packHistory(game.history));
    assert.deepEqual(roundTripped, game.history);
  }
});

test('packHistory does not mutate its input', () => {
  const g = dislodgingGame();
  const before = JSON.stringify(g.history);
  packHistory(g.history);
  assert.equal(JSON.stringify(g.history), before);
});

test('a legacy (already-unpacked) history round-trips cleanly', () => {
  const g = dislodgingGame();
  const legacy = g.history; // full shape, as if read from a pre-format gist
  const roundTripped = unpackHistory(packHistory(legacy));
  assert.deepEqual(roundTripped, legacy);
});

test('packing shrinks a multi-phase history by a meaningful margin', () => {
  const g = dislodgingGame();
  const raw = JSON.stringify(g.history).length;
  const packed = JSON.stringify(packHistory(g.history)).length;
  assert.ok(packed < raw * 0.65, `expected packed (${packed}) < 65% of raw (${raw})`);
});

test('chain: false round-trips a standalone entry, keeping its *Before', () => {
  const g = dislodgingGame();
  const standalone = [g.history[1]]; // an entry with no predecessor in this array
  const packed = packHistory(standalone, { chain: false });
  assert.ok('unitsBefore' in packed[0], 'a non-chained entry must keep its own unitsBefore');
  const roundTripped = unpackHistory(packed, { chain: false });
  assert.deepEqual(roundTripped, standalone);
});
