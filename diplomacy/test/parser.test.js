// Order parsing — the text notation is the app's one source of truth for a
// turn (see DECISIONS.md, "The order text is the source of truth"), so every
// form a player might type has to survive a round trip through here.
//
// Runs under `node --test`; no browser, no DOM. js/parser.js imports only
// js/map-data.js, which is static data.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseOrderLine, parseOrders, normalizePower } from '../js/parser.js';

// The order out of a single line, asserting it parsed at all.
const one = (line, phase = 'movement', power = 'france') => {
  const res = parseOrderLine(line, phase, power);
  assert.ok(res, `"${line}" parsed to nothing`);
  assert.ok(!res.error, `"${line}" failed: ${res.error}`);
  return res.order;
};

test('normalizePower: full names, abbreviations and prefixes', () => {
  assert.equal(normalizePower('France'), 'france');
  assert.equal(normalizePower('FRANCE'), 'france');
  assert.equal(normalizePower('fra'), 'france');
  assert.equal(normalizePower('eng'), 'england');
  assert.equal(normalizePower('aus'), 'austria');
  assert.equal(normalizePower('turkey'), 'turkey');
  // punctuation is stripped, so a header written "FRANCE:" still resolves
  assert.equal(normalizePower('France:'), 'france');
  assert.equal(normalizePower('Burgundy'), null);
  assert.equal(normalizePower(''), null);
  assert.equal(normalizePower(null), null);
});

test('a move parses from every notation people actually type', () => {
  for (const line of [
    'A Par - Bur',
    'a par-bur',
    'A par - bur',
    'A Paris - Burgundy',
    'A Par to Bur',
    'A Paris moves to Burgundy',
    'A Par moves to Bur',
    'A Par -> Bur',
    'Army Paris - Burgundy',
  ]) {
    const o = one(line);
    assert.equal(o.kind, 'move', line);
    assert.equal(o.loc, 'par', line);
    assert.equal(o.dest, 'bur', line);
  }
});

test('the unit type is optional, and kept when given', () => {
  assert.equal(one('A Par - Bur').unitType, 'A');
  assert.equal(one('F Bre - MAO').unitType, 'F');
  assert.equal(one('Par - Bur').unitType, null);
  assert.equal(one('Par - Bur').dest, 'bur');
});

test('hold is written many ways, and a bare unit holds', () => {
  for (const line of ['A Par H', 'A Par holds', 'A Par hold', 'A Par stands', 'A Par']) {
    const o = one(line);
    assert.equal(o.kind, 'hold', line);
    assert.equal(o.loc, 'par', line);
  }
});

test('support of a move and support of a hold', () => {
  const move = one('A Mar S A Par - Bur');
  assert.equal(move.kind, 'support');
  assert.equal(move.loc, 'mar');
  assert.deepEqual(move.target, { loc: 'par', dest: 'bur' });

  const hold = one('A Mar S A Par');
  assert.equal(hold.kind, 'support');
  assert.deepEqual(hold.target, { loc: 'par', dest: null });

  // an explicit "holds" on the target is the same order as leaving it off
  const explicit = one('A Mar supports A Par holds');
  assert.deepEqual(explicit.target, { loc: 'par', dest: null });

  // the supported unit's type is optional too
  assert.deepEqual(one('A Mar S Par - Bur').target, { loc: 'par', dest: 'bur' });

  // natural-language connectors, as parser.js's own header advertises
  assert.deepEqual(one('F ENG supports A Bre to Pic').target, { loc: 'bre', dest: 'pic' });
  assert.deepEqual(one('A Mar supports A Par moves to Bur').target, { loc: 'par', dest: 'bur' });
});

test('convoy needs a destination', () => {
  const o = one('F ENG C A Lon - Bre');
  assert.equal(o.kind, 'convoy');
  assert.equal(o.loc, 'eng');
  assert.equal(o.dest, 'bre');
  assert.deepEqual(o.target, { loc: 'lon' });

  const bad = parseOrderLine('F ENG C A Lon', 'movement', 'france');
  assert.ok(bad.error, 'a convoy with no destination should not parse');
});

test('via convoy is recorded without changing the destination', () => {
  const o = one('A Lon - Bre via convoy', 'movement', 'england');
  assert.equal(o.kind, 'move');
  assert.equal(o.dest, 'bre');
  assert.equal(o.viaConvoy, true);
  assert.equal(one('A Lon - Bre', 'movement', 'england').viaConvoy, false);
});

test('a multi-hop move names a convoy route (strict-convoy notation)', () => {
  // "A Lon - NTH - Nwy": the trailing location is the destination, the
  // earlier ones are the seas the army is carried through.
  const o = one('A Lon - NTH - Nwy', 'movement', 'england');
  assert.equal(o.kind, 'move');
  assert.equal(o.loc, 'lon');
  assert.equal(o.dest, 'nwy');
  assert.deepEqual(o.convoyRoute, ['nth']);

  const longer = one('A Tun - ION - AEG - Bul', 'movement', 'italy');
  assert.equal(longer.dest, 'bul');
  assert.deepEqual(longer.convoyRoute, ['ion', 'aeg']);

  // a single hop is an ordinary move and carries no route
  assert.equal(one('A Par - Bur').convoyRoute, undefined);
});

test('all coast notations resolve to the same canonical location', () => {
  for (const line of ['F Spa/sc - MAO', 'F Spa(sc) - MAO', 'F spain (south coast) - MAO']) {
    assert.equal(one(line).loc, 'spa/sc', line);
  }
  assert.equal(one('F Stp/nc - Bar', 'movement', 'russia').loc, 'stp/nc');
  assert.equal(one('Build F Stp/nc', 'adjustment', 'russia').loc, 'stp/nc');
});

test('the longest location name wins over a shorter prefix of it', () => {
  // "north atlantic ocean" must not be read as some shorter province
  assert.equal(one('F North Atlantic Ocean - Nwy', 'movement', 'england').loc, 'nao');
});

test('retreat phase turns a move into a retreat, and disband parses', () => {
  const r = one('A Bur - Gas', 'retreat');
  assert.equal(r.kind, 'retreat');
  assert.equal(r.dest, 'gas');

  for (const line of ['A Bur disband', 'A Bur disbands', 'A Bur destroy']) {
    assert.equal(one(line, 'retreat').kind, 'disband', line);
  }
});

test('adjustment orders: build, remove and waive', () => {
  const b = one('Build F Lon', 'adjustment', 'england');
  assert.equal(b.kind, 'build');
  assert.equal(b.unitType, 'F');
  assert.equal(b.loc, 'lon');

  const r = one('Remove Ruh', 'adjustment', 'germany');
  assert.equal(r.kind, 'remove');
  assert.equal(r.loc, 'ruh');

  const w = one('Waive', 'adjustment');
  assert.equal(w.kind, 'waive');
  assert.equal(w.loc, undefined);

  // a build with no unit type is ambiguous and must be rejected
  assert.ok(parseOrderLine('Build Lon', 'adjustment', 'england').error);
});

test('comments and blank lines are ignored', () => {
  assert.equal(parseOrderLine('# just a note', 'movement', 'france'), null);
  assert.equal(parseOrderLine('   ', 'movement', 'france'), null);
  const o = one('A Par - Bur   # the classic opening');
  assert.equal(o.dest, 'bur');
});

test('an order with no power at all is an error, not a silent drop', () => {
  const res = parseOrderLine('A Par - Bur', 'movement', null);
  assert.ok(res.error);
  assert.match(res.error, /no power specified/);
});

test('parseOrders: a power heading sets the power for the lines under it', () => {
  const { orders, errors } = parseOrders(
    ['FRANCE', 'A Par - Bur', 'F Bre - MAO', '', 'ENGLAND', 'F Lon - ENG'].join('\n'),
    'movement'
  );
  assert.deepEqual(errors, []);
  assert.equal(orders.length, 3);
  assert.deepEqual(orders.map((o) => o.power), ['france', 'france', 'england']);
  assert.deepEqual(orders.map((o) => o.loc), ['par', 'bre', 'lon']);
});

test('parseOrders: the per-line "France:" form needs no heading', () => {
  const { orders, errors } = parseOrders(
    ['France: A Par - Bur', 'England: F Lon - ENG'].join('\n'),
    'movement'
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(orders.map((o) => o.power), ['france', 'england']);
});

test('parseOrders: a per-line prefix overrides the heading above it', () => {
  const { orders } = parseOrders(
    ['FRANCE', 'A Par - Bur', 'England: F Lon - ENG', 'F Bre - MAO'].join('\n'),
    'movement'
  );
  assert.deepEqual(orders.map((o) => o.power), ['france', 'england', 'france']);
});

test('parseOrders: bad lines become errors without losing the good ones', () => {
  const { orders, errors } = parseOrders(
    ['FRANCE', 'A Par - Bur', 'A Nowhere - Bur', 'F Bre - MAO'].join('\n'),
    'movement'
  );
  assert.equal(orders.length, 2);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /cannot parse/);
});

test('parseOrders: a one-word order is not mistaken for a power heading', () => {
  // "Waive" is a single word but is an order, not a heading
  const { orders, errors } = parseOrders(['FRANCE', 'Waive', 'Waive'].join('\n'), 'adjustment');
  assert.deepEqual(errors, []);
  assert.equal(orders.length, 2);
  assert.ok(orders.every((o) => o.kind === 'waive' && o.power === 'france'));
});
