// The wire format has ONE writer (js/publish.js wirePayload) and TWO readers
// (fetchPublished on game load, readGameFile on every online refresh), and the
// readers have to hand back the same in-memory shape — the shape state.js's
// resolvePhase produces — or the app compares a packed history against an
// unpacked one and concludes the board has changed when nothing has.
//
// That happened: readGameFile skipped the unpack, so every viewer's first
// poll after a phase had been resolved saw a "different" position, was told
// the game master had changed the board, and had their history overwritten
// with entries missing unitsBefore. This suite pins the readers to the writer.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { wirePayload, readGameFile, decodeGameJson } from '../js/publish.js';
import { newGame, resolvePhase, boardSnapshot } from '../js/state.js';
import { parseOrders } from '../js/parser.js';
import { viewerPosition, extendsOurHistory } from '../js/online-rules.js';

function play(g, text) {
  const { orders } = parseOrders(text, g.step);
  return resolvePhase(g, orders, text);
}

// A game two phases in, so the chain-dropped *Before snapshots are exercised
// (the first entry keeps them; the second must rebuild them from the first).
function gameWithHistory() {
  const g = newGame('wire');
  play(g, 'FRANCE\nA Par - Bur\nGERMANY\nA Mun - Bur');
  play(g, 'FRANCE\nA Bur - Mun\nGERMANY\nA Mun H');
  return g;
}

// What GitHub hands back for the file: the JSON text, not truncated.
const gistWith = (game) => ({
  files: { 'game.json': { content: JSON.stringify(wirePayload(game)), truncated: false } },
});

test('readGameFile decodes the wire format back to the in-memory history', async () => {
  const g = gameWithHistory();
  const fresh = await readGameFile(gistWith(g));
  assert.deepEqual(fresh.history, g.history);
  assert.deepEqual(fresh.redoStack, g.redoStack);
  assert.equal('historyFormat' in fresh, false, 'the marker is wire-only');
});

test('a viewer polling an unchanged gist sees the same position', async () => {
  const g = gameWithHistory();
  const fresh = await readGameFile(gistWith(g));
  assert.equal(viewerPosition(fresh), viewerPosition(g));
});

test('a gist one phase ahead reads as extending the history, not replacing it', async () => {
  const ours = gameWithHistory();
  const theirs = gameWithHistory();
  play(theirs, 'FRANCE\nA Mun H');
  const fresh = await readGameFile(gistWith(theirs));
  assert.equal(extendsOurHistory(ours, fresh), true);
  assert.deepEqual(fresh.history[2], theirs.history[2], 'and the new phase is fully unpacked');
  assert.ok(fresh.history[2].unitsBefore, 'catch-up playback needs the pre-move board');
});

// Retreat and winter entries carry a different set of keys from movement ones
// (no standoffs, no destroyed), and the decoder fills the gaps with empties.
// The comparison has to see through that too, or a viewer whose history holds
// one of each is reloaded and told the board changed on every poll.
test('a history spanning movement, retreat and winter still reads as the same one', async () => {
  const g = newGame('seasons');
  play(g, 'FRANCE\nA Par - Bur\nITALY\nA Ven - Tyr');
  play(g, 'FRANCE\nA Bur - Mun\nITALY\nA Tyr S A Bur - Mun\nGERMANY\nA Mun H');
  assert.equal(g.step, 'retreat');
  play(g, 'GERMANY\nA Mun - Boh');
  assert.equal(g.step, 'adjustment');
  play(g, 'FRANCE\nBuild A Par\nGERMANY\nRemove Kie');
  assert.equal(g.year, 1902);
  const fresh = await readGameFile(gistWith(g));
  assert.equal(viewerPosition(fresh), viewerPosition(g));
  const behind = { ...g, history: g.history.slice(0, 2) };
  assert.equal(extendsOurHistory(behind, fresh), true);
});

test('decodeGameJson still reads a pre-format gist unchanged', () => {
  const g = gameWithHistory();
  const legacy = JSON.stringify({ ...boardSnapshot(g), name: g.name });
  const fresh = decodeGameJson(legacy);
  assert.deepEqual(fresh.history, g.history);
});
