// The 🌿 analysis tree (js/analysis.js) — the pure half of the feature.
//
// Three things are worth a test here and the rest is bookkeeping:
//   1. THE LIFETIME RULE. A tree that outlives the position it hangs off is
//      the exact bug this feature exists to fix, so positionKey has to say
//      "same position" for a board that came back and "different" for one that
//      moved — whatever order the arrays happen to be in.
//   2. THE BRANCH RULE. Sibling-or-child is decided by one comparison, and
//      getting it backwards would file every idea at the wrong level.
//   3. A LINE IS A GAME. Its game object is handed back live, so resolving and
//      undoing in it are the ordinary operations writing to the ordinary place.

import test from 'node:test';
import assert from 'node:assert';
import * as A from '../js/analysis.js';
import { newGame, resolvePhase, undoLastPhase, gameSettings, phaseLabel } from '../js/state.js';
import { parseOrders } from '../js/parser.js';

const live = () => newGame('Live');

// resolve a phase on a game the way app.js does, so tests exercise real history
function play(g, text) {
  const { orders } = parseOrders(text, g.step);
  return resolvePhase(g, orders, text);
}

// ---------------------------------------------------------------------------
// 1. the lifetime rule
// ---------------------------------------------------------------------------

test('a tree matches the position it was rooted at', () => {
  const g = live();
  const t = A.newTree(g);
  assert.equal(A.rootMatches(t, g), true);
});

test('array order does not change a position key', () => {
  const g = live();
  const t = A.newTree(g);
  g.units.reverse();
  g.scOwners = Object.fromEntries(Object.entries(g.scOwners).reverse());
  assert.equal(A.rootMatches(t, g), true, 'a reordered board is the same board');
});

test('moving a unit voids the tree', () => {
  const g = live();
  const t = A.newTree(g);
  g.units[0].loc = 'Ruh';
  assert.equal(A.rootMatches(t, g), false);
});

test('a phase change voids the tree even with the same units', () => {
  const g = live();
  const t = A.newTree(g);
  g.season = 'fall';
  assert.equal(A.rootMatches(t, g), false);
});

test('a position that comes back keeps the tree alive', () => {
  const g = live();
  const t = A.newTree(g);
  play(g, 'FRANCE\nA Par - Bur');
  assert.equal(A.rootMatches(t, g), false, 'moved on');
  undoLastPhase(g);
  assert.equal(A.rootMatches(t, g), true, 'a GM undo brings the tree back');
});

// A tree saved by an EARLIER node model is void even though the position it
// was rooted at has not moved — the bug that shipped once already. Its nodes
// have no `game`, so the panel threw on the first row and came back blank.
test('a tree written by an older node model is void', () => {
  const g = live();
  const t = A.newTree(g);
  const legacy = {
    ...t,
    v: undefined,
    activeId: 'v2',
    nodes: {
      p1: { id: 'p1', seq: 1, kind: 'plan', parent: null, name: 'Plan A', mine: '' },
      v2: { id: 'v2', seq: 2, kind: 'var', parent: 'p1', name: 'Main line', theirs: '' },
    },
  };
  assert.equal(A.rootMatches(legacy, g), false, 'discarded, not carried forward');
  assert.equal(A.lineCount(legacy), 0, 'so the discard notice stays quiet');
  // and if one ever did reach the panel, nothing it holds may reach a renderer
  assert.deepEqual(A.childrenOf(legacy, null), []);
  assert.equal(A.getNode(legacy, 'p1'), null);
  assert.equal(A.getNode(legacy, 'v2'), null);
});

test('a tree of this version survives', () => {
  const g = live();
  const t = A.newTree(g);
  assert.equal(t.v, A.TREE_VERSION);
  assert.equal(A.rootMatches(t, g), true);
});

// ---------------------------------------------------------------------------
// 2. the branch rule
// ---------------------------------------------------------------------------

test('the first line is the Main line and starts at the root', () => {
  const g = live();
  const t = A.newTree(g);
  const n = A.getNode(t, A.ensureEntry(t, gameSettings(g)));
  assert.equal(n.name, 'Main line');
  assert.equal(n.kind, 'line');
  assert.equal(A.positionKey(n.game), t.rootKey);
  assert.equal(n.from, null, 'nothing to be stale against');
});

test('resolving inside a line adds history, not nodes', () => {
  const g = live();
  const t = A.newTree(g);
  const main = A.getNode(t, A.ensureEntry(t, gameSettings(g)));
  play(main.game, 'FRANCE\nA Par - Bur');
  play(main.game, 'FRANCE\nA Bur - Mun');
  assert.equal(A.lineCount(t), 1, 'planning several phases ahead is still one line');
  assert.equal(main.game.history.length, 2);
});

test('branching at the start of a line makes a sibling', () => {
  const g = live();
  const t = A.newTree(g);
  const main = A.getNode(t, A.ensureEntry(t, gameSettings(g)));
  const sib = A.branchFrom(t, main.id, 0, gameSettings(g));
  assert.equal(sib.parent, main.parent, 'same level as the line it came from');
  assert.equal(A.positionKey(sib.game), t.rootKey);
  assert.deepEqual(A.childrenOf(t, null).map((n) => n.id), [main.id, sib.id]);
});

test('branching at a later phase nests beneath that line', () => {
  const g = live();
  const t = A.newTree(g);
  const main = A.getNode(t, A.ensureEntry(t, gameSettings(g)));
  play(main.game, 'FRANCE\nA Par - Bur');
  const child = A.branchFrom(t, main.id, 1, gameSettings(g));
  assert.equal(child.parent, main.id);
  assert.deepEqual(A.childrenOf(t, null).map((n) => n.id), [main.id]);
  assert.deepEqual(A.childrenOf(t, main.id).map((n) => n.id), [child.id]);
});

test('two branches from the same later phase come out parallel', () => {
  const g = live();
  const t = A.newTree(g);
  const main = A.getNode(t, A.ensureEntry(t, gameSettings(g)));
  play(main.game, 'FRANCE\nA Par - Bur');
  const a = A.branchFrom(t, main.id, 1, gameSettings(g));
  // now inside `a`, at ITS starting phase — the sibling rule applies
  const b = A.branchFrom(t, a.id, 0, gameSettings(g));
  assert.equal(b.parent, a.parent);
  assert.deepEqual(A.childrenOf(t, main.id).map((n) => n.id), [a.id, b.id]);
});

test('a branch opens on a copy of the orders it was cut from', () => {
  const g = live();
  const t = A.newTree(g);
  const main = A.getNode(t, A.ensureEntry(t, gameSettings(g)));
  main.game.orders = 'FRANCE\nA Par - Bur';
  const sib = A.branchFrom(t, main.id, 0, gameSettings(g));
  assert.equal(sib.game.orders, 'FRANCE\nA Par - Bur', 'tweak-one-order, not retype-all');
  sib.game.orders = 'FRANCE\nA Par - Pic';
  assert.equal(main.game.orders, 'FRANCE\nA Par - Bur', 'and the copy is a copy');
});

test('a branch starts from the position at the phase it was cut at', () => {
  const g = live();
  const t = A.newTree(g);
  const main = A.getNode(t, A.ensureEntry(t, gameSettings(g)));
  play(main.game, 'FRANCE\nA Par - Bur');
  const before = A.positionKey(A.positionAt(main.game, 1));
  const child = A.branchFrom(t, main.id, 1, gameSettings(g));
  assert.equal(A.positionKey(child.game), before);
  assert.notEqual(A.positionKey(child.game), t.rootKey, 'a phase on, not the root');
});

test('the branch index is clamped to the phases the line actually has', () => {
  const g = live();
  const t = A.newTree(g);
  const main = A.getNode(t, A.ensureEntry(t, gameSettings(g)));
  const n = A.branchFrom(t, main.id, 99, gameSettings(g));
  assert.equal(n.from.index, 0);
  assert.equal(n.parent, main.parent, 'and it is still a sibling');
});

test('a child goes stale when the line above it is undone', () => {
  const g = live();
  const t = A.newTree(g);
  const main = A.getNode(t, A.ensureEntry(t, gameSettings(g)));
  play(main.game, 'FRANCE\nA Par - Bur');
  const child = A.branchFrom(t, main.id, 1, gameSettings(g));
  assert.equal(A.isStale(t, child), false);
  undoLastPhase(main.game);
  assert.equal(A.isStale(t, child), true, 'the phase it was cut from is gone');
  assert.equal(child.game.history.length, 0, 'but the child itself is untouched');
});

test('re-resolving the parent identically un-stales the child', () => {
  const g = live();
  const t = A.newTree(g);
  const main = A.getNode(t, A.ensureEntry(t, gameSettings(g)));
  play(main.game, 'FRANCE\nA Par - Bur');
  const child = A.branchFrom(t, main.id, 1, gameSettings(g));
  undoLastPhase(main.game);
  play(main.game, 'FRANCE\nA Par - Bur');
  assert.equal(A.isStale(t, child), false);
});

test('branching is capped', () => {
  const g = live();
  const t = A.newTree(g);
  const main = A.getNode(t, A.ensureEntry(t, gameSettings(g)));
  while (A.canBranch(t)) A.branchFrom(t, main.id, 0, gameSettings(g));
  assert.equal(A.lineCount(t), A.MAX_LINES);
  assert.equal(A.canBranch(t), false);
});

test('branchParent says where a branch will land before it happens', () => {
  const g = live();
  const t = A.newTree(g);
  const main = A.getNode(t, A.ensureEntry(t, gameSettings(g)));
  assert.equal(A.branchParent(t, main.id, 0), null, 'sibling at the top level');
  assert.equal(A.branchParent(t, main.id, 1), main.id, 'child');
});

// ---------------------------------------------------------------------------
// 3. a line is a game
// ---------------------------------------------------------------------------

test('lineGame hands back the node own game, not a copy', () => {
  const g = live();
  const t = A.newTree(g);
  const id = A.ensureEntry(t, gameSettings(g));
  const view = A.lineGame(t, id, g);
  assert.equal(view, A.getNode(t, id).game, 'so resolving in it writes to the tree');
  assert.equal(A.isLine(view), true);
  assert.equal(A.isLine(g), false);
  assert.equal(view.nodeId, id);
});

test('a line carries the live game house rules', () => {
  const g = live();
  g.settings = { ...gameSettings(g), supportRule: 'strict' };
  const t = A.newTree(g);
  const view = A.lineGame(t, A.ensureEntry(t, gameSettings(g)), g);
  assert.equal(view.settings.supportRule, 'strict', 'or it is not analysis');
});

test('lineGame refuses a folder — activeId always names a line', () => {
  const g = live();
  const t = A.newTree(g);
  A.ensureEntry(t, gameSettings(g));
  const f = A.addFolder(t, null);
  assert.equal(A.lineGame(t, f.id, g), null);
});

test('renaming a line renames its game too', () => {
  const g = live();
  const t = A.newTree(g);
  const id = A.ensureEntry(t, gameSettings(g));
  A.renameNode(t, id, '  Munich gambit  ');
  assert.equal(A.getNode(t, id).name, 'Munich gambit');
  assert.equal(A.getNode(t, id).game.name, 'Munich gambit');
});

// What the tree labels a row with: where the line begins, not where it has got
// to. Resolving inside a line must not rewrite its row.
test('a line is labelled by the phase it starts at, however far it has run', () => {
  const g = live();
  const t = A.newTree(g);
  const main = A.getNode(t, A.ensureEntry(t, gameSettings(g)));
  const start = A.lineStartLabel(main);
  assert.equal(start, 'Spring 1901 — Movement');
  play(main.game, 'FRANCE\nA Par - Bur');
  play(main.game, 'FRANCE\nA Bur - Mun');
  assert.equal(A.lineStartLabel(main), start, 'two phases on, the label has not moved');
  assert.notEqual(phaseLabel(main.game), start, 'though the line itself has');
});

test('a branch is labelled by the phase it was cut at', () => {
  const g = live();
  const t = A.newTree(g);
  const main = A.getNode(t, A.ensureEntry(t, gameSettings(g)));
  play(main.game, 'FRANCE\nA Par - Bur');
  const child = A.branchFrom(t, main.id, 1, gameSettings(g));
  assert.equal(A.lineStartLabel(child), child.from.label);
  assert.notEqual(A.lineStartLabel(child), A.lineStartLabel(main));
  play(child.game, 'FRANCE\nA Bur - Mun');
  assert.equal(A.lineStartLabel(child), child.from.label, 'still, after resolving in it');
});

test('positionAt and ordersAt read a line at any phase it has played', () => {
  const g = live();
  const t = A.newTree(g);
  const main = A.getNode(t, A.ensureEntry(t, gameSettings(g)));
  play(main.game, 'FRANCE\nA Par - Bur');
  main.game.orders = 'FRANCE\nA Bur - Mun';
  assert.equal(A.ordersAt(main.game, 0), 'FRANCE\nA Par - Bur', 'what was played');
  assert.equal(A.ordersAt(main.game, 1), 'FRANCE\nA Bur - Mun', 'the live draft');
  assert.equal(A.positionKey(A.positionAt(main.game, 0)), t.rootKey);
  assert.equal(A.positionKey(A.positionAt(main.game, 1)), A.positionKey(main.game));
});

// ---------------------------------------------------------------------------
// folders and placement
// ---------------------------------------------------------------------------

test('a folder swallows the level it was made at', () => {
  const g = live();
  const t = A.newTree(g);
  const main = A.getNode(t, A.ensureEntry(t, gameSettings(g)));
  const b = A.branchFrom(t, main.id, 0, gameSettings(g));
  const f = A.groupSiblings(t, main.id, 'Plan A');
  assert.deepEqual(A.childrenOf(t, null).map((n) => n.id), [f.id]);
  assert.deepEqual(A.childrenOf(t, f.id).map((n) => n.id), [main.id, b.id]);
});

test('a folder keeps the children of what it swallowed', () => {
  const g = live();
  const t = A.newTree(g);
  const main = A.getNode(t, A.ensureEntry(t, gameSettings(g)));
  play(main.game, 'FRANCE\nA Par - Bur');
  const child = A.branchFrom(t, main.id, 1, gameSettings(g));
  const f = A.groupSiblings(t, main.id);
  assert.equal(A.getNode(t, child.id).parent, main.id, 'the nesting is unchanged');
  assert.equal(A.descendantIds(t, f.id).size, 2);
});

// A row dragged out of a nesting has to be able to go back into one, and into
// a LINE, not only into a folder — the first cut could only insert before.
test('drag and drop nests a line under another line, and back out', () => {
  const g = live();
  const t = A.newTree(g);
  const main = A.getNode(t, A.ensureEntry(t, gameSettings(g)));
  const b = A.branchFrom(t, main.id, 0, gameSettings(g));
  assert.equal(b.parent, null, 'a sibling, to start with');
  assert.equal(A.moveNode(t, b.id, main.id, null), true);
  assert.deepEqual(A.childrenOf(t, main.id).map((n) => n.id), [b.id], 'nested by hand');
  assert.equal(A.moveNode(t, b.id, null, null), true);
  assert.deepEqual(A.childrenOf(t, null).map((n) => n.id), [main.id, b.id], 'and out again');
});

test('a line dragged under another keeps saying what it was really cut from', () => {
  const g = live();
  const t = A.newTree(g);
  const main = A.getNode(t, A.ensureEntry(t, gameSettings(g)));
  const b = A.branchFrom(t, main.id, 0, gameSettings(g));
  A.moveNode(t, b.id, main.id, null);
  assert.equal(b.from.index, 0, 'placement moved; origin did not');
  assert.equal(A.isStale(t, b), false);
  play(main.game, 'FRANCE\nA Par - Bur');
  assert.equal(A.isStale(t, b), false, 'and resolving its new parent does not stale it');
});

test('dropping after the last row appends to that level', () => {
  const g = live();
  const t = A.newTree(g);
  const main = A.getNode(t, A.ensureEntry(t, gameSettings(g)));
  const b = A.branchFrom(t, main.id, 0, gameSettings(g));
  const c = A.branchFrom(t, main.id, 0, gameSettings(g));
  // "after the last" is expressed as an append (app.js passes beforeId null)
  assert.equal(A.moveNode(t, b.id, null, null), true);
  assert.deepEqual(A.childrenOf(t, null).map((n) => n.id), [main.id, c.id, b.id]);
});

test('drag and drop files a line into a folder and back out', () => {
  const g = live();
  const t = A.newTree(g);
  const main = A.getNode(t, A.ensureEntry(t, gameSettings(g)));
  const b = A.branchFrom(t, main.id, 0, gameSettings(g));
  const f = A.addFolder(t, null, 'Plan A');
  assert.equal(A.moveNode(t, b.id, f.id, null), true);
  assert.deepEqual(A.childrenOf(t, f.id).map((n) => n.id), [b.id]);
  assert.equal(A.moveNode(t, b.id, null, main.id), true);
  assert.deepEqual(A.childrenOf(t, null).map((n) => n.id), [b.id, main.id, f.id],
    'dropping on a row inserts in front of it');
});

test('a folder cannot be dropped inside itself', () => {
  const g = live();
  const t = A.newTree(g);
  A.ensureEntry(t, gameSettings(g));
  const outer = A.addFolder(t, null);
  const inner = A.addFolder(t, outer.id);
  assert.equal(A.moveNode(t, outer.id, inner.id, null), false);
  assert.equal(A.moveNode(t, outer.id, outer.id, null), false);
  assert.equal(A.getNode(t, inner.id).parent, outer.id, 'nothing was orphaned');
});

test('deleting a folder takes everything inside it', () => {
  const g = live();
  const t = A.newTree(g);
  const main = A.getNode(t, A.ensureEntry(t, gameSettings(g)));
  A.branchFrom(t, main.id, 0, gameSettings(g));
  const f = A.groupSiblings(t, main.id); // both lines
  const keep = A.addLine(t, { position: t.root, name: 'Kept', settings: gameSettings(g) });
  A.deleteNode(t, f.id);
  assert.deepEqual(Object.keys(t.nodes), [keep.id]);
  assert.equal(t.activeId, null, 'the open line went with it');
});

test('ensureEntry reopens the line left open, and rebuilds one if there is none', () => {
  const g = live();
  const t = A.newTree(g);
  const first = A.ensureEntry(t, gameSettings(g));
  assert.equal(A.ensureEntry(t, gameSettings(g)), first, 'idempotent');
  A.deleteNode(t, first);
  const fresh = A.ensureEntry(t, gameSettings(g));
  assert.notEqual(fresh, first);
  assert.equal(A.getNode(t, fresh).name, 'Main line');
});

test('the entry line is the first one in display order, folders and all', () => {
  const g = live();
  const t = A.newTree(g);
  const main = A.getNode(t, A.ensureEntry(t, gameSettings(g)));
  A.branchFrom(t, main.id, 0, gameSettings(g));
  A.groupSiblings(t, main.id);
  t.activeId = null;
  assert.equal(A.ensureEntry(t, gameSettings(g)), main.id);
  assert.equal(A.firstLine(t).id, main.id);
});

test('lineLabel spells out the whole placement', () => {
  const g = live();
  const t = A.newTree(g);
  const main = A.getNode(t, A.ensureEntry(t, gameSettings(g)));
  const f = A.groupSiblings(t, main.id, 'Plan A');
  assert.equal(A.lineLabel(t, main.id), 'Plan A ▸ Main line');
  assert.equal(A.pathTo(t, main.id).map((n) => n.id).join(','), `${f.id},${main.id}`);
});
