// The order buffer as text (js/orders-text.js).
//
// "Order text is the one source of truth" means these string operations ARE
// the order model — a bug here is a player's dragged order landing in another
// power's block, or a submitted order quietly not matching the box. All of it
// was previously reachable only by dragging units in a browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  splitOrdersByPower, blockBody, orderBlock, splitForFilter, replaceBlock,
  mergeBlocks, defaultOrdersText, normalizeOrders,
  unitToken, orderTextFor, locateOrderLine, setOrderLine, lineRange,
} from '../js/orders-text.js';
import { newGame } from '../js/state.js';
import { parseOrders } from '../js/parser.js';

const TEXT = [
  'FRANCE',
  'A Par - Bur',
  'F Bre - MAO',
  '',
  'ENGLAND',
  'F Lon - ENG',
  '',
].join('\n');

// ---------------------------------------------------------------------------
// splitting a multi-power text
// ---------------------------------------------------------------------------

test('splitOrdersByPower keeps each power’s heading with its lines', () => {
  const by = splitOrdersByPower(TEXT);
  assert.deepEqual([...by.keys()], ['france', 'england']);
  assert.deepEqual(by.get('france'), ['FRANCE', 'A Par - Bur', 'F Bre - MAO', '']);
  assert.deepEqual(by.get('england'), ['ENGLAND', 'F Lon - ENG', '']);
});

test('lines before any heading belong to nobody', () => {
  const by = splitOrdersByPower(['A Par - Bur', 'FRANCE', 'F Bre - MAO'].join('\n'));
  assert.deepEqual([...by.keys()], ['france']);
  assert.deepEqual(by.get('france'), ['FRANCE', 'F Bre - MAO']);
});

test('a repeated heading appends rather than starting a second block', () => {
  const by = splitOrdersByPower(['FRANCE', 'A Par - Bur', 'FRANCE', 'F Bre - MAO'].join('\n'));
  assert.equal(by.size, 1);
  assert.deepEqual(by.get('france'), ['FRANCE', 'A Par - Bur', 'FRANCE', 'F Bre - MAO']);
});

test('a heading may be written "France:" and may carry a comment', () => {
  const by = splitOrdersByPower(['France:  # my orders', 'A Par - Bur'].join('\n'));
  assert.deepEqual([...by.keys()], ['france']);
  assert.equal(by.get('france').length, 2);
});

test('an order line is never mistaken for a heading', () => {
  // one word, but an order — it must stay inside France's block
  const by = splitOrdersByPower(['FRANCE', 'Waive', 'Waive'].join('\n'));
  assert.deepEqual(by.get('france'), ['FRANCE', 'Waive', 'Waive']);
});

test('blockBody drops the heading and trims', () => {
  const by = splitOrdersByPower(TEXT);
  assert.equal(blockBody(by, 'france'), 'A Par - Bur\nF Bre - MAO');
  assert.equal(blockBody(by, 'england'), 'F Lon - ENG');
  assert.equal(blockBody(by, 'germany'), '', 'a power with no block');
});

test('orderBlock is the shape every load path builds', () => {
  assert.equal(orderBlock('france', '  A Par - Bur\n'), 'FRANCE\nA Par - Bur\n');
  // round-trips back through the splitter
  const by = splitOrdersByPower(orderBlock('france', 'A Par - Bur'));
  assert.equal(blockBody(by, 'france'), 'A Par - Bur');
});

// ---------------------------------------------------------------------------
// the visible / hidden split
// ---------------------------------------------------------------------------

test('with no country chosen everything is visible', () => {
  const { visible, hidden } = splitForFilter(TEXT, '');
  assert.equal(hidden, '');
  // emitted in POWERS order (alphabetical), not the order they were written in
  assert.deepEqual([...splitOrdersByPower(visible).keys()], ['england', 'france']);
});

test('playing one country hides the other powers’ drafts, losing nothing', () => {
  const { visible, hidden } = splitForFilter(TEXT, 'france');
  assert.deepEqual([...splitOrdersByPower(visible).keys()], ['france']);
  assert.deepEqual([...splitOrdersByPower(hidden).keys()], ['england']);

  // sketching opponents' moves survives a switch-country round trip
  const back = splitForFilter(visible + '\n' + hidden, '');
  assert.deepEqual([...splitOrdersByPower(back.visible).keys()], ['england', 'france']);
  assert.equal(blockBody(splitOrdersByPower(back.visible), 'england'), 'F Lon - ENG');
});

test('splitForFilter emits powers in a stable order, not insertion order', () => {
  const scrambled = ['TURKEY', 'A Con - Bul', '', 'FRANCE', 'A Par - Bur'].join('\n');
  const { visible } = splitForFilter(scrambled, '');
  assert.deepEqual([...splitOrdersByPower(visible).keys()], ['france', 'turkey']);
});

// ---------------------------------------------------------------------------
// replacing and merging blocks
// ---------------------------------------------------------------------------

test('replaceBlock swaps one power and leaves every other draft alone', () => {
  const out = replaceBlock(TEXT, 'france', 'A Par H\nF Bre H');
  const by = splitOrdersByPower(out);
  assert.equal(blockBody(by, 'france'), 'A Par H\nF Bre H');
  assert.equal(blockBody(by, 'england'), 'F Lon - ENG', 'untouched');
});

test('replaceBlock adds a power that had no block yet', () => {
  const out = replaceBlock(TEXT, 'germany', 'A Mun - Bur');
  const by = splitOrdersByPower(out);
  assert.equal(blockBody(by, 'germany'), 'A Mun - Bur');
  assert.equal(blockBody(by, 'france'), 'A Par - Bur\nF Bre - MAO');
});

test('mergeBlocks prefers what is drafted and fills the rest from the template', () => {
  const drafted = splitOrdersByPower(['FRANCE', 'A Par - Bur'].join('\n'));
  const template = splitOrdersByPower(['FRANCE', '', 'ENGLAND', '', 'GERMANY', ''].join('\n'));
  const by = splitOrdersByPower(mergeBlocks(drafted, template));

  assert.equal(blockBody(by, 'france'), 'A Par - Bur', 'the draft wins');
  assert.ok(by.has('england'), 'a power with nothing drawn still gets its heading');
  assert.ok(by.has('germany'));
});

// ---------------------------------------------------------------------------
// the per-phase template
// ---------------------------------------------------------------------------

test('a movement template gives every power on the board a heading', () => {
  const by = splitOrdersByPower(defaultOrdersText(newGame('g')));
  assert.equal(by.size, 7);
  for (const p of by.keys()) assert.equal(blockBody(by, p), '', 'headings only, no orders');
});

test('a retreat template pre-writes a disband and lists the options', () => {
  const g = newGame('g');
  g.step = 'retreat';
  g.pending = {
    dislodged: [{ unit: { power: 'france', type: 'A' }, from: 'bur', retreatOptions: ['gas', 'pic'] }],
    standoffs: [],
  };
  const text = defaultOrdersText(g);
  assert.match(text, /FRANCE/);
  assert.match(text, /A bur disband/);
  assert.match(text, /# options: gas, pic/);
  // unordered units disband anyway, so the template must parse as written
  assert.deepEqual(parseOrders(text, 'retreat').errors, []);
});

test('an adjustment template says how many builds or disbands are owed', () => {
  const g = newGame('g');
  g.step = 'adjustment';
  g.season = 'winter';
  g.scOwners.bel = 'france'; // France: 4 centres, 3 units -> owes 1 build
  // England keeps its three units but loses every centre -> owes 3 disbands
  for (const [c, owner] of Object.entries(g.scOwners)) {
    if (owner === 'england') g.scOwners[c] = null;
  }
  const text = defaultOrdersText(g);
  assert.match(text, /FRANCE\n# 1 build/);
  assert.match(text, /ENGLAND\n# disband 3/);
});

// ---------------------------------------------------------------------------
// normalizeOrders — "does the box still match what I submitted?"
// ---------------------------------------------------------------------------

test('normalizeOrders ignores comments, spacing, case and blank lines', () => {
  const a = 'A Par - Bur\nF Bre - MAO';
  const b = '  a  par  -  bur   # planned all week\n\n\nF BRE - mao  \n';
  assert.equal(normalizeOrders(a), normalizeOrders(b));
});

test('normalizeOrders still notices a real change', () => {
  assert.notEqual(normalizeOrders('A Par - Bur'), normalizeOrders('A Par - Gas'));
  assert.notEqual(normalizeOrders('A Par - Bur'), normalizeOrders('A Par - Bur\nF Bre H'));
  assert.equal(normalizeOrders(''), '');
  assert.equal(normalizeOrders(null), '');
});

// ---------------------------------------------------------------------------
// writing one unit's line — what every drag and click does
// ---------------------------------------------------------------------------

test('unitToken keeps a fleet’s coast and drops an army’s', () => {
  assert.equal(unitToken({ type: 'A', loc: 'par' }), 'A par');
  assert.equal(unitToken({ type: 'F', loc: 'spa/sc' }), 'F spa/sc');
  assert.equal(unitToken({ type: 'A', loc: 'spa/sc' }), 'A spa', 'armies have no coast');
});

test('orderTextFor writes what the parser reads back', () => {
  const A = { type: 'A', loc: 'par' };
  const F = { type: 'F', loc: 'eng' };
  const cases = [
    [A, { kind: 'hold' }, 'A par H'],
    [A, { kind: 'move', dest: 'bur' }, 'A par - bur'],
    [A, { kind: 'move', dest: 'bre', via: true }, 'A par - bre via convoy'],
    [A, { kind: 'move', dest: 'nwy', route: ['nth'] }, 'A par - nth - nwy'],
    [A, { kind: 'retreat', dest: 'gas' }, 'A par - gas'],
    [A, { kind: 'disband' }, 'A par disband'],
    [A, { kind: 'support', targetType: 'A', targetLoc: 'mar', targetDest: 'bur' }, 'A par S A mar - bur'],
    [A, { kind: 'support', targetType: 'A', targetLoc: 'mar', targetDest: null }, 'A par S A mar'],
    [F, { kind: 'convoy', targetLoc: 'lon', dest: 'bre' }, 'F eng C A lon - bre'],
  ];
  for (const [u, spec, want] of cases) {
    assert.equal(orderTextFor(u, spec), want, spec.kind);
    // and it must survive the round trip back through the parser
    const phase = spec.kind === 'retreat' || spec.kind === 'disband' ? 'retreat' : 'movement';
    const { orders, errors } = parseOrders('FRANCE\n' + want, phase);
    assert.deepEqual(errors, [], want);
    assert.equal(orders.length, 1, want);
  }
});

test('a multi-hop route round-trips through the text and back', () => {
  const line = orderTextFor({ type: 'A', loc: 'lon' }, { kind: 'move', dest: 'nwy', route: ['nth'] });
  const { orders } = parseOrders('ENGLAND\n' + line, 'movement');
  assert.equal(orders[0].dest, 'nwy');
  assert.deepEqual(orders[0].convoyRoute, ['nth']);
});

// ---------------------------------------------------------------------------
// setOrderLine — where a dragged order lands in the text
// ---------------------------------------------------------------------------

test('setOrderLine replaces the unit’s existing line in place', () => {
  const out = setOrderLine(TEXT, 'france', 'par', 'A par H', 'movement');
  const by = splitOrdersByPower(out);
  assert.equal(blockBody(by, 'france'), 'A par H\nF Bre - MAO', 'order preserved');
  assert.equal(blockBody(by, 'england'), 'F Lon - ENG', 'untouched');
});

test('setOrderLine finds the unit by province, whatever the notation', () => {
  const text = 'FRANCE\nA Paris moves to Burgundy';
  const out = setOrderLine(text, 'france', 'par', 'A par H', 'movement');
  assert.equal(blockBody(splitOrdersByPower(out), 'france'), 'A par H');
});

test('a null newText removes the line — the build/remove toggle', () => {
  const out = setOrderLine(TEXT, 'france', 'par', null, 'movement');
  assert.equal(blockBody(splitOrdersByPower(out), 'france'), 'F Bre - MAO');
});

test('a new order joins the end of its own power’s section', () => {
  const out = setOrderLine(TEXT, 'france', 'mar', 'A mar - spa', 'movement');
  const by = splitOrdersByPower(out);
  assert.equal(blockBody(by, 'france'), 'A Par - Bur\nF Bre - MAO\nA mar - spa');
  assert.equal(blockBody(by, 'england'), 'F Lon - ENG', 'not appended to the wrong power');
});

test('a power with no section yet gets one', () => {
  const out = setOrderLine(TEXT, 'germany', 'mun', 'A mun - bur', 'movement');
  const by = splitOrdersByPower(out);
  assert.equal(blockBody(by, 'germany'), 'A mun - bur');
  assert.equal(blockBody(by, 'france'), 'A Par - Bur\nF Bre - MAO');
});

test('removing an order for a unit that has none is a no-op', () => {
  assert.equal(setOrderLine(TEXT, 'france', 'mar', null, 'movement'), TEXT);
});

test('a fleet’s coast does not stop its line being found', () => {
  const text = 'FRANCE\nF spa/sc - mao';
  const out = setOrderLine(text, 'france', 'spa', 'F spa/sc H', 'movement');
  assert.equal(blockBody(splitOrdersByPower(out), 'france'), 'F spa/sc H');
});

test('lineRange points at the line the textarea should select', () => {
  const lines = TEXT.split('\n');
  const [start, end] = lineRange(lines, 1);
  assert.equal(TEXT.slice(start, end), 'A Par - Bur');

  const [s0, e0] = lineRange(lines, 0);
  assert.equal(TEXT.slice(s0, e0), 'FRANCE');
});

test('locateOrderLine reports where a section starts and ends', () => {
  const { foundIdx, headerIdx, lastOfSection } =
    locateOrderLine('france', 'par', TEXT, 'movement');
  assert.equal(headerIdx, 0);
  assert.equal(foundIdx, 1);
  assert.equal(lastOfSection, 2, 'the last France order, not the blank line after it');

  const missing = locateOrderLine('france', 'mar', TEXT, 'movement');
  assert.equal(missing.foundIdx, -1);
  assert.equal(missing.lastOfSection, 2, 'so a new order lands here');

  const noSection = locateOrderLine('germany', 'mun', TEXT, 'movement');
  assert.equal(noSection.headerIdx, -1);
});
