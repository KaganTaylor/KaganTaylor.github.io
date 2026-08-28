// Display formatting (js/format.js). fmtOrder in particular is read in four
// places that must agree — the playback step label, the playback order list,
// 📋 Copy results and the live order warnings — so every order kind is pinned
// here rather than checked by eye in one of them.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cap, provName, fmtLoc, fmtOrder,
  fmtCountdown, fmtCountdownDHMS, isoToLocalInput,
  POWER_FLAGS, COAST_NAMES,
} from '../js/format.js';
import { POWERS } from '../js/map-data.js';

test('cap capitalises a power name for display', () => {
  assert.equal(cap('france'), 'France');
  assert.equal(cap('austria'), 'Austria');
  assert.equal(cap(''), '');
});

test('province ids become their real names, coasts included', () => {
  assert.equal(provName('par'), 'Paris');
  assert.equal(provName('mao'), 'Mid-Atlantic Ocean');
  // a coast resolves through its base province
  assert.equal(provName('spa/sc'), 'Spain');
  // an unknown id is passed through rather than blanked
  assert.equal(provName('zzz'), 'zzz');

  assert.equal(fmtLoc('par'), 'Paris');
  assert.equal(fmtLoc('spa/sc'), 'Spain(sc)');
  assert.equal(fmtLoc('stp/nc'), 'St Petersburg(nc)');
});

test('fmtOrder covers every order kind', () => {
  assert.equal(fmtOrder({ kind: 'move', unitType: 'A', loc: 'par', dest: 'bur' }), 'A Paris → Burgundy');
  assert.equal(fmtOrder({ kind: 'hold', unitType: 'A', loc: 'par' }), 'A Paris holds');
  assert.equal(fmtOrder({ kind: 'retreat', unitType: 'A', loc: 'bur', dest: 'gas' }), 'A Burgundy retreats → Gascony');
  assert.equal(fmtOrder({ kind: 'disband', unitType: 'A', loc: 'bur' }), 'A Burgundy disbands');
  assert.equal(
    fmtOrder({ kind: 'support', unitType: 'A', loc: 'mar', target: { loc: 'par', dest: 'bur' } }),
    'A Marseilles S Paris → Burgundy'
  );
  assert.equal(
    fmtOrder({ kind: 'support', unitType: 'A', loc: 'mar', target: { loc: 'par', dest: null } }),
    'A Marseilles S Paris (hold)'
  );
  assert.equal(
    fmtOrder({ kind: 'convoy', unitType: 'F', loc: 'eng', target: { loc: 'lon' }, dest: 'bre' }),
    'F English Channel C London → Brest'
  );
  assert.equal(fmtOrder({ kind: 'build', unitType: 'F', loc: 'lon' }), 'build F London');
  assert.equal(fmtOrder({ kind: 'remove', loc: 'ruh' }), 'remove Ruhr');
  assert.equal(fmtOrder({ kind: 'waive' }), 'waive build');
  assert.equal(fmtOrder({ kind: 'nonsense', loc: 'par' }), '?');
});

test('fmtOrder marks a convoyed move with an anchor', () => {
  const plain = { kind: 'move', unitType: 'A', loc: 'lon', dest: 'bre' };
  assert.equal(fmtOrder(plain), 'A London → Brest');
  assert.equal(fmtOrder({ ...plain, isConvoyMove: true }), 'A London → Brest ⚓');
});

test('fmtOrder survives an order with no unit type or location', () => {
  assert.equal(fmtOrder({ kind: 'hold', loc: 'par' }), 'Paris holds');
  assert.equal(fmtOrder({ kind: 'waive', power: 'france' }), 'waive build');
});

test('the loose countdown drops to the two largest useful units', () => {
  const m = 60000, h = 60 * m, d = 24 * h;
  assert.equal(fmtCountdown(45 * m), '45m');
  assert.equal(fmtCountdown(2 * h + 15 * m), '2h 15m');
  assert.equal(fmtCountdown(3 * d + 4 * h), '3d 4h');
  assert.equal(fmtCountdown(0), '0m');
  assert.equal(fmtCountdown(-5 * h), '0m', 'a passed deadline never counts backwards');
});

test('the topbar countdown is a fixed-width DD:HH:MM:SS', () => {
  const s = 1000, m = 60 * s, h = 60 * m, d = 24 * h;
  assert.equal(fmtCountdownDHMS(0), '00:00:00:00');
  assert.equal(fmtCountdownDHMS(9 * s), '00:00:00:09');
  assert.equal(fmtCountdownDHMS(2 * d + 3 * h + 4 * m + 5 * s), '02:03:04:05');
  assert.equal(fmtCountdownDHMS(-1), '00:00:00:00', 'never negative');
  // the fixed width is the whole point — it must not jump about in the topbar
  for (const ms of [0, 999, 61 * s, 25 * h, 40 * d]) {
    assert.equal(fmtCountdownDHMS(ms).length, 11, `width for ${ms}`);
  }
});

test('isoToLocalInput produces what a datetime-local input accepts', () => {
  // built from a local-time Date so the assertion holds in any timezone
  const d = new Date(2026, 8, 13, 23, 5); // 13 Sep 2026, 23:05 local
  assert.equal(isoToLocalInput(d.toISOString()), '2026-09-13T23:05');
  assert.equal(isoToLocalInput('not a date'), '');
  assert.equal(isoToLocalInput(''), '');
});

test('every power has a flag, and every coast suffix a label', () => {
  for (const p of POWERS) {
    assert.ok(POWER_FLAGS[p], `no flag for ${p}`);
  }
  assert.deepEqual(Object.keys(COAST_NAMES).sort(), ['ec', 'nc', 'sc']);
});
