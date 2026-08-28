// Order sealing (js/seal.js) — AES-GCM-256 under a key kept in the game's own
// gist. The point is not secrecy (everyone who can reach the game can decrypt)
// but that order text never appears in plaintext where a human might read it by
// accident. See DECISIONS.md, "Orders are obfuscated, not secret".
//
// Two properties are load-bearing and tested here:
//   • unseal() NEVER throws — it runs inside the poll that feeds every render,
//     and one bad comment must not blank the board.
//   • the AAD binds gistId|power|year|season|step, so a sealed blob cannot be
//     replayed into another phase or under another power.
//
// Runs under `node --test`: WebCrypto, btoa and atob are all global in Node 18+,
// which is exactly why seal.js works unchanged in the browser and in the Action.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newSealKey, seal, unseal, aadFor } from '../js/seal.js';

const SUB = { power: 'france', year: 1901, season: 'spring', step: 'movement' };
const GIST = 'abc123';
const ORDERS = 'A Par - Bur\nA Mar S A Par - Bur\nF Bre - MAO';

test('newSealKey returns a fresh 256-bit key as base64', () => {
  const a = newSealKey();
  const b = newSealKey();
  assert.notEqual(a, b, 'two keys in a row must not be identical');
  // 32 bytes base64 -> 44 chars with one padding '='
  assert.equal(a.length, 44);
  assert.equal(Buffer.from(a, 'base64').length, 32);
});

test('a sealed blob round-trips back to the same order text', async () => {
  const key = newSealKey();
  const aad = aadFor(GIST, SUB);
  const blob = await seal(key, ORDERS, aad);
  assert.equal(await unseal(key, blob, aad), ORDERS);
});

test('the ciphertext gives nothing away', async () => {
  const key = newSealKey();
  const blob = await seal(key, ORDERS, aadFor(GIST, SUB));
  // no line structure, no province names, no telling an army from a fleet
  assert.ok(!blob.includes('\n'));
  assert.ok(!/par|bur|mao/i.test(Buffer.from(blob, 'base64').toString('latin1')));
  // a fresh IV each time, so identical orders do not produce identical blobs
  const again = await seal(key, ORDERS, aadFor(GIST, SUB));
  assert.notEqual(blob, again);
});

test('unseal returns null rather than throwing, on every kind of failure', async () => {
  const key = newSealKey();
  const aad = aadFor(GIST, SUB);
  const blob = await seal(key, ORDERS, aad);

  assert.equal(await unseal(newSealKey(), blob, aad), null, 'wrong key');
  assert.equal(await unseal(key, 'not base64 at all !!!', aad), null, 'garbage input');
  assert.equal(await unseal(key, '', aad), null, 'empty blob');

  // a tampered blob: flip a character deep in the ciphertext
  const bytes = Buffer.from(blob, 'base64');
  bytes[bytes.length - 3] ^= 0xff;
  assert.equal(await unseal(key, bytes.toString('base64'), aad), null, 'tampered blob');
});

test('the AAD binds a submission to its phase, power and gist', async () => {
  const key = newSealKey();
  const blob = await seal(key, ORDERS, aadFor(GIST, SUB));

  // replayed into the next phase
  assert.equal(await unseal(key, blob, aadFor(GIST, { ...SUB, season: 'fall' })), null);
  assert.equal(await unseal(key, blob, aadFor(GIST, { ...SUB, year: 1902 })), null);
  assert.equal(await unseal(key, blob, aadFor(GIST, { ...SUB, step: 'retreat' })), null);
  // replayed under another power
  assert.equal(await unseal(key, blob, aadFor(GIST, { ...SUB, power: 'germany' })), null);
  // lifted into another game
  assert.equal(await unseal(key, blob, aadFor('different-gist', SUB)), null);
  // and the matching AAD still opens it
  assert.equal(await unseal(key, blob, aadFor(GIST, SUB)), ORDERS);
});

test('aadFor is exactly the fields it claims to bind', () => {
  assert.equal(
    new TextDecoder().decode(aadFor(GIST, SUB)),
    'abc123|france|1901|spring|movement'
  );
});
