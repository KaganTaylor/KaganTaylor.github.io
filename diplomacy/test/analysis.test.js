// The analysis tree (js/analysis.js): plans, variations, and the rule that
// decides when the whole thing is thrown away.
//
// Two things here are worth more than the rest. The FIRST is the lifetime
// rule — a tree is rooted at one position and dies with it — because getting
// it wrong in either direction is a real bug: too eager and a player loses an
// evening's planning to a refresh, too lax and they plan against a board
// nobody else can see, which is the exact divergence the whole permission
// model exists to prevent. The SECOND is that editing a plan moves every
// variation under it: that is the feature ("change my move, keep all the
// replies"), and it is the one place where an edit reaches sideways.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  positionKey, positionOf, newTree, rootMatches, isLine,
  addPlan, addVariation, plansAt, variationsOf, variationCount, canAddVariation,
  nodeOrdersText, setNodeOrders, setNodeBefore, recordResolution,
  deleteNode, renameNode, pathTo, lineLabel, firstVariation, ensureEntry,
  lineGame, refocus, positionFor, getNode, MAX_VARIATIONS,
} from '../js/analysis.js';
import { newGame } from '../js/state.js';
import { splitOrdersByPower, mergeBlocks, defaultOrdersText } from '../js/orders-text.js';

const live = () => ({ ...newGame('the real game'), published: true, gistId: 'abc123' });

// A tree with one plan holding France's orders and two replies under it —
// the shape the two-level model exists for.
function seeded(focus = 'france') {
  const g = live();
  const t = newTree(g, focus);
  const plan = addPlan(t, null, 'Burgundy push', 'FRANCE\nA Par - Bur');
  const v1 = addVariation(t, plan.id, 'Germany holds', 'GERMANY\nA Mun H', t.root);
  const v2 = addVariation(t, plan.id, 'Germany contests', 'GERMANY\nA Mun - Bur', t.root);
  return { g, t, plan, v1, v2 };
}

// ---------------------------------------------------------------------------
// the lifetime rule
// ---------------------------------------------------------------------------

test('positionKey ignores the order the arrays happen to be in', () => {
  const a = live();
  const b = live();
  b.units = [...b.units].reverse();
  b.scOwners = Object.fromEntries(Object.entries(b.scOwners).reverse());
  assert.equal(positionKey(a), positionKey(b));
});

test('a tree stays rooted while the board does not move', () => {
  const g = live();
  const t = newTree(g);
  assert.ok(rootMatches(t, g));
  // drafting orders, which never touches the position, is not a move
  g.ordersText = 'FRANCE\nA Par - Bur';
  assert.ok(rootMatches(t, g));
});

test('a tree is void the moment the live position moves', () => {
  const g = live();
  const t = newTree(g);
  g.units.find((u) => u.loc === 'par').loc = 'bur';
  assert.equal(rootMatches(t, g), false);
});

test('a phase change alone voids the tree, units unmoved', () => {
  const g = live();
  const t = newTree(g);
  g.season = 'fall';
  assert.equal(rootMatches(t, g), false);
});

// This is why the catch-up path LOCKS analysis rather than deleting it: a game
// master who undoes a phase and re-resolves it identically lands back on the
// same board, and there is nothing wrong with the lines hanging off it.
test('a position that comes back is still the same root', () => {
  const g = live();
  const t = newTree(g);
  const par = g.units.find((u) => u.loc === 'par');
  par.loc = 'bur';
  assert.equal(rootMatches(t, g), false);
  par.loc = 'par';
  assert.ok(rootMatches(t, g));
});

test('rootMatches is false for a missing tree rather than throwing', () => {
  assert.equal(rootMatches(null, live()), false);
  assert.equal(rootMatches(newTree(live()), null), false);
});

// ---------------------------------------------------------------------------
// the two levels
// ---------------------------------------------------------------------------

test('a variation is its plan orders plus its own', () => {
  const { t, v1 } = seeded();
  const text = nodeOrdersText(t, v1.id);
  assert.match(text, /FRANCE\nA Par - Bur/);
  assert.match(text, /GERMANY\nA Mun H/);
});

test('the order box splits back into the two levels on the focus power', () => {
  const { t, v1, plan } = seeded();
  setNodeOrders(t, v1.id, 'FRANCE\nA Par - Pic\nGERMANY\nA Mun - Ruh', 'france');
  assert.match(plan.mine, /A Par - Pic/);
  assert.equal(/Par/.test(v1.theirs), false);
  assert.match(v1.theirs, /A Mun - Ruh/);
});

test('with no focus power there is no plan level — the variation holds it all', () => {
  const { t, v1, plan } = seeded('');
  setNodeOrders(t, v1.id, 'FRANCE\nA Par - Pic\nGERMANY\nA Mun - Ruh', '');
  assert.equal(plan.mine, '');
  assert.match(v1.theirs, /A Par - Pic/);
  assert.match(v1.theirs, /A Mun - Ruh/);
});

// The feature: one plan, many replies. Editing my own orders is *meant* to
// reach sideways into every variation under the plan.
test('editing the plan invalidates every variation under it', () => {
  const { t, v1, v2 } = seeded();
  v1.after = positionOf(live());
  v2.after = positionOf(live());
  setNodeOrders(t, v1.id, 'FRANCE\nA Par - Pic\nGERMANY\nA Mun H', 'france');
  assert.equal(v1.after, null);
  assert.equal(v2.after, null, 'the sibling reply no longer follows from the new plan');
});

test('editing one variation leaves its siblings alone', () => {
  const { t, v1, v2 } = seeded();
  v1.after = positionOf(live());
  v2.after = positionOf(live());
  setNodeOrders(t, v1.id, 'FRANCE\nA Par - Bur\nGERMANY\nA Mun - Tyr', 'france');
  assert.equal(v1.after, null);
  assert.notEqual(v2.after, null);
});

// The order box is refilled from a blank per-phase template on every render,
// so a node reopened and not touched comes back with extra headings and blank
// lines. Reading that as an edit would throw away a resolved outcome on every
// single re-render.
test('re-storing the same orders with different formatting is not a change', () => {
  const { t, v1 } = seeded();
  const after = positionOf(live());
  v1.after = after;
  const changed = setNodeOrders(
    t, v1.id,
    'FRANCE\n\na par - bur   # the plan\n\nGERMANY\nA Mun H\n\nITALY\n',
    'france'
  );
  assert.equal(changed, false);
  assert.equal(v1.after, after, 'the outcome survives a cosmetic re-store');
});

// The round trip app.js actually performs on every render: the node's orders
// go into the box through prefillOrders() (merged with a blank per-phase
// template) and come straight back out through persistLineOrders(). It has to
// be a fixed point, or simply looking at a variation destroys its outcome and
// everything explored below it.
test('opening a variation and storing it back changes nothing', () => {
  const { g, t, v1 } = seeded();
  const resolvedTo = positionOf({ ...live(), season: 'fall' });
  v1.after = resolvedTo;

  for (let i = 0; i < 3; i++) {
    // prefillOrders(): the node's orders, with the blank template filling in
    // every power that has no block of its own
    const box = mergeBlocks(
      splitOrdersByPower(nodeOrdersText(t, v1.id)),
      splitOrdersByPower(defaultOrdersText(g))
    );
    // persistLineOrders()
    assert.equal(setNodeOrders(t, v1.id, box, t.focus), false, `render ${i + 1} counted as an edit`);
    assert.equal(v1.after, resolvedTo, `render ${i + 1} discarded the outcome`);
  }
  // and the orders themselves survived the trip
  assert.match(nodeOrdersText(t, v1.id), /A Par - Bur/);
  assert.match(nodeOrdersText(t, v1.id), /A Mun H/);
});

// ---------------------------------------------------------------------------
// resolving and re-basing
// ---------------------------------------------------------------------------

test('resolving records the outcome and hands back a variation to continue in', () => {
  const { t, v1 } = seeded();
  const resolved = { ...live(), season: 'fall' };
  const nextId = recordResolution(t, v1.id, resolved);
  const next = getNode(t, nextId);
  assert.equal(next.kind, 'var');
  assert.equal(v1.after.season, 'fall');
  assert.equal(getNode(t, next.parent).parent, v1.id, 'the continuation hangs off the resolved variation');
  assert.equal(positionKey(next.before), positionKey(resolved));
});

test('re-resolving re-bases what was already explored underneath', () => {
  const { t, v1 } = seeded();
  const first = { ...live(), season: 'fall' };
  const childId = recordResolution(t, v1.id, first);
  const child = getNode(t, childId);
  child.theirs = 'GERMANY\nA Ruh - Bel';
  child.after = positionOf(live());

  const second = { ...live(), season: 'fall', year: 1902 };
  const againId = recordResolution(t, v1.id, second);
  assert.equal(againId, childId, 'the same continuation is reused, not duplicated');
  assert.equal(child.before.year, 1902, 'it now starts from the new outcome');
  assert.equal(child.after, null, 'and must be resolved again');
  assert.equal(child.theirs, 'GERMANY\nA Ruh - Bel', 'but the orders written in it are kept');
});

test('an invalidated variation marks everything below it stale rather than deleting it', () => {
  const { t, v1 } = seeded();
  const childId = recordResolution(t, v1.id, { ...live(), season: 'fall' });
  const grandId = recordResolution(t, childId, { ...live(), season: 'fall', year: 1902 });
  setNodeOrders(t, v1.id, 'FRANCE\nA Par - Pic\nGERMANY\nA Mun H', 'france');
  assert.equal(getNode(t, childId).stale, true);
  assert.equal(getNode(t, grandId).stale, true);
  assert.ok(getNode(t, grandId), 'the work is flagged, never thrown away');
});

test('a board edit inside a line moves that variation and invalidates its outcome', () => {
  const { t, v1 } = seeded();
  v1.after = positionOf(live());
  const edited = live();
  edited.units.push({ power: 'france', type: 'A', loc: 'bur' });
  assert.equal(setNodeBefore(t, v1.id, edited), true);
  assert.equal(v1.after, null);
  assert.equal(setNodeBefore(t, v1.id, edited), false, 'an edit that changes nothing is not a change');
});

// ---------------------------------------------------------------------------
// the shape of the tree
// ---------------------------------------------------------------------------

test('plans and variations nest, and deleting takes the subtree with it', () => {
  const { t, plan, v1, v2 } = seeded();
  const childId = recordResolution(t, v1.id, { ...live(), season: 'fall' });
  assert.equal(plansAt(t, null).length, 1);
  assert.equal(variationsOf(t, plan.id).length, 2);
  assert.equal(plansAt(t, v1.id).length, 1, 'the continuation is a plan at the new position');

  deleteNode(t, v1.id);
  assert.equal(getNode(t, childId), null);
  assert.equal(getNode(t, v2.id), v2, 'the sibling reply is untouched');
});

test('deleting the open variation clears activeId so nothing dangles', () => {
  const { t, v1 } = seeded();
  t.activeId = v1.id;
  deleteNode(t, v1.id);
  assert.equal(t.activeId, null);
});

test('the path names the line, plan by variation', () => {
  const { t, v1 } = seeded();
  assert.deepEqual(pathTo(t, v1.id).map((n) => n.name), ['Burgundy push', 'Germany holds']);
  assert.equal(lineLabel(t, v1.id), 'Burgundy push ▸ Germany holds');
  renameNode(t, v1.id, 'Germany sits still');
  assert.equal(lineLabel(t, v1.id), 'Burgundy push ▸ Germany sits still');
  renameNode(t, v1.id, '   ');
  assert.equal(lineLabel(t, v1.id), 'Burgundy push ▸ Germany sits still', 'a blank rename is ignored');
});

test('an empty tree opens on a fresh plan and variation at the root', () => {
  const g = live();
  const t = newTree(g);
  assert.equal(firstVariation(t), null);
  const id = ensureEntry(t);
  const v = getNode(t, id);
  assert.equal(v.kind, 'var');
  assert.equal(t.activeId, id);
  assert.equal(positionKey(v.before), positionKey(g));
  assert.equal(ensureEntry(t), id, 'and re-entering comes back to the same one');
});

test('ensureEntry recovers from an activeId that names a plan or nothing', () => {
  const { t, plan, v1 } = seeded();
  t.activeId = plan.id;
  assert.equal(ensureEntry(t), v1.id);
  t.activeId = 'gone';
  assert.equal(ensureEntry(t), v1.id);
});

test('positionFor is the root for a top-level plan and the outcome above otherwise', () => {
  const { t, plan, v1 } = seeded();
  assert.equal(positionKey(positionFor(t, plan.id)), positionKey(t.root));
  const childId = recordResolution(t, v1.id, { ...live(), season: 'fall' });
  const childPlan = getNode(t, getNode(t, childId).parent);
  assert.equal(positionFor(t, childPlan.id).season, 'fall');
});

test('the tree is capped, and says so before it is full', () => {
  const { t, plan } = seeded();
  assert.ok(canAddVariation(t));
  while (variationCount(t) < MAX_VARIATIONS) addVariation(t, plan.id, null, '', t.root);
  assert.equal(canAddVariation(t), false);
});

// ---------------------------------------------------------------------------
// the line as a game object
// ---------------------------------------------------------------------------

test('a line is a real game object, marked as a view rather than a game', () => {
  const { g, t, v1 } = seeded();
  g.settings = { ...g.settings, convoyRule: 'strict' };
  const l = lineGame(t, v1.id, g);
  assert.ok(isLine(l), 'app.js keys every analysis rule off this');
  assert.equal(isLine(g), false);
  assert.equal(l.nodeId, v1.id);
  assert.equal(l.analysisOf.gistId, 'abc123');
  assert.equal(l.settings.convoyRule, 'strict', 'a line adjudicates by the live game’s house rules');
  assert.equal(l.published, undefined, 'and can never be mistaken for the published game');
  assert.equal(positionKey(l), positionKey(v1.before));
});

test('refocusing moves orders between the plan and variation levels', () => {
  const { t, plan, v1, v2 } = seeded();
  assert.equal(refocus(t, 'germany'), true);
  assert.match(plan.mine, /A Mun H/, 'the first variation’s German orders become the shared plan');
  assert.match(v1.theirs, /A Par - Bur/, 'and France drops to the variation level');
  assert.equal(refocus(t, 'germany'), false, 'refocusing to the same power does nothing');
});

// The two replies disagreed about Germany, which is what makes them two
// German plans once Germany is the focus. Folding them into one would throw
// half the user's work away silently.
test('refocusing splits variations that disagree about the new focus power', () => {
  const { t, plan, v1, v2 } = seeded();
  refocus(t, 'germany');
  assert.notEqual(v2.parent, plan.id, 'the second reply gets a plan of its own');
  const other = getNode(t, v2.parent);
  assert.match(other.mine, /A Mun - Bur/, 'carrying its own German orders');
  assert.match(v2.theirs, /A Par - Bur/);
  assert.equal(plansAt(t, null).length, 2);
});
