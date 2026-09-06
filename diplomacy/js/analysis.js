// The analysis tree: plans, variations, and the position each one leads to.
//
// A LINE IS NOT A GAME. It is a view of the live game's current position — the
// 👁 Preview (app.js shadowGame/previewResolve), made persistent and nestable.
// Nothing here is ever written into the saved-games map: the whole tree hangs
// off `liveGame.analysis`, lives and dies with the position it is rooted at,
// and never appears on the home screen. That is the entire fix for "a branch
// goes stale the moment the live game moves on" — a branch used to be a peer
// game with its own identity, so nothing could keep it attached.
//
// TWO LEVELS, BECAUSE DIPLOMACY IS SIMULTANEOUS. In chess, moves alternate, so
// a tree of single moves nests my-move/their-move on its own. Here all seven
// powers write orders for the SAME phase, so "my plan" and "their reply to it"
// cannot be parent and child — they are one order set. So a phase splits in
// two instead:
//
//   📋 plan       my power's orders for the phase        (a folder)
//   🔀 variation  what everyone else does, given that plan
//
// Change the plan and every variation under it moves with it — one plan, many
// replies, which is exactly "try my move, then explore all of theirs". A
// variation resolves to a position; the plans under it belong to the next
// phase. With no focus power (a spectator who has not picked a country) the
// plan level is empty and variations are simply full order sets — the flat
// tree, as a degenerate case of the same shape.
//
// Every function is pure: plain data in, plain data out, no DOM, no storage,
// no `game` module state. See DECISIONS.md, "A line is a view, not a game".

import { branchGame, gameSettings, phaseLabel } from './state.js';
import {
  splitForFilter, splitOrdersByPower, blockBody, normalizeOrders,
} from './orders-text.js';

// localStorage holds every saved game in one JSON blob that is rewritten on
// each save, so a tree is capped rather than allowed to grow without limit.
// A variation is ~2 KB (two positions plus its order text).
export const MAX_VARIATIONS = 60;

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// What a block of order text actually SAYS: per power, its orders, normalized
// and with empty blocks dropped entirely.
//
// normalizeOrders() alone is not enough here. The order box is refilled from a
// blank per-phase template on every render, so a variation reopened and left
// untouched comes back carrying a bare "ITALY" heading it did not have before
// — which normalizeOrders keeps, being a line with content. Comparing that
// would read every re-render as an edit and wipe the outcome underneath it.
function orderContent(text) {
  const byPower = splitOrdersByPower(text || '');
  const parts = [];
  for (const p of [...byPower.keys()].sort()) {
    const body = normalizeOrders(blockBody(byPower, p));
    if (body) parts.push(p + '\n' + body);
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// positions
// ---------------------------------------------------------------------------

// The board itself, with nothing of the game around it: what a tree is rooted
// at, and what every variation stores as its starting point. Deliberately not
// state.js's boardSnapshot() — that carries history and redoStack, which are
// the live game's bookkeeping and say nothing about where the pieces are.
export function positionOf(g) {
  return structuredClone({
    year: g.year,
    season: g.season,
    step: g.step,
    units: g.units,
    scOwners: g.scOwners,
    pending: g.pending || null,
  });
}

// A position's identity, independent of how the arrays happen to be ordered.
// The adjudicator rebuilds `units` every phase and the board editor splices it,
// so two identical boards routinely differ in array order; comparing the raw
// JSON would then throw a tree away for nothing. Sorting is what makes "the
// live game came back to the same position" (a GM undo followed by an
// identical re-resolve) keep the analysis alive instead of discarding it.
export function positionKey(g) {
  const units = g.units
    .map((u) => `${u.power} ${u.type} ${u.loc}`).sort().join('|');
  const scs = Object.keys(g.scOwners).sort()
    .map((k) => `${k}:${g.scOwners[k] || ''}`).join('|');
  const dislodged = ((g.pending && g.pending.dislodged) || [])
    .map((d) => `${d.unit.power} ${d.unit.type} ${d.from}`).sort().join('|');
  return `${g.year}/${g.season}/${g.step}\n${units}\n${scs}\n${dislodged}`;
}

// ---------------------------------------------------------------------------
// the tree
// ---------------------------------------------------------------------------

export function newTree(liveGame, focus = '') {
  return {
    root: positionOf(liveGame),
    rootKey: positionKey(liveGame),
    rootLabel: phaseLabel(liveGame),
    focus: focus || '',
    activeId: null,
    seq: 0,
    nodes: {},
  };
}

// THE LIFETIME RULE: a tree is rooted at exactly one position, and if the live
// game is no longer at that position the whole tree is void. Checked from one
// place only (app.js validateAnalysis, called at the top of refreshAll), so
// every path that can move the board — a GM publish, a catch-up, an undo, an
// ✏ Edit board that touches no history at all — is covered without having to
// be enumerated.
export function rootMatches(tree, liveGame) {
  return !!tree && !!liveGame && tree.rootKey === positionKey(liveGame);
}

// Is this game object one of our line views rather than a real game? The one
// fact every permission question about analysis is derived from (roles.js).
export function isLine(g) {
  return !!(g && g.analysisOf);
}

export function getNode(tree, id) {
  return (tree && id && tree.nodes[id]) || null;
}

const bySeq = (a, b) => a.seq - b.seq;

// Plans written at a given position: `parentVarId` null means the root.
export function plansAt(tree, parentVarId = null) {
  return Object.values(tree.nodes)
    .filter((n) => n.kind === 'plan' && (n.parent || null) === (parentVarId || null))
    .sort(bySeq);
}

export function variationsOf(tree, planId) {
  return Object.values(tree.nodes)
    .filter((n) => n.kind === 'var' && n.parent === planId)
    .sort(bySeq);
}

export function variationCount(tree) {
  return tree ? Object.values(tree.nodes).filter((n) => n.kind === 'var').length : 0;
}

export function canAddVariation(tree) {
  return variationCount(tree) < MAX_VARIATIONS;
}

// Where a plan's orders are written: the outcome of the variation above it, or
// the root for a top-level plan.
export function positionFor(tree, planId) {
  const plan = getNode(tree, planId);
  if (!plan) return tree.root;
  const parent = getNode(tree, plan.parent);
  return (parent && parent.after) || tree.root;
}

export function defaultPlanName(tree, parentVarId) {
  const n = plansAt(tree, parentVarId).length;
  return `Plan ${LETTERS[n] || n + 1}`;
}

export function defaultVariationName(tree, planId) {
  const n = variationsOf(tree, planId).length;
  return n === 0 ? 'Main line' : `Variation ${n + 1}`;
}

export function addPlan(tree, parentVarId, name = null, mine = '') {
  const seq = ++tree.seq;
  const id = `p${seq}`;
  tree.nodes[id] = {
    id, seq, kind: 'plan',
    parent: parentVarId || null,
    name: name || defaultPlanName(tree, parentVarId),
    mine,
  };
  return tree.nodes[id];
}

export function addVariation(tree, planId, name = null, theirs = '', before = null) {
  const seq = ++tree.seq;
  const id = `v${seq}`;
  tree.nodes[id] = {
    id, seq, kind: 'var',
    parent: planId,
    name: name || defaultVariationName(tree, planId),
    theirs,
    before: structuredClone(before || positionFor(tree, planId)),
    after: null,
    stale: false,
  };
  return tree.nodes[id];
}

export function renameNode(tree, id, name) {
  const n = getNode(tree, id);
  if (n && name && name.trim()) n.name = name.trim();
}

export function deleteNode(tree, id) {
  const n = getNode(tree, id);
  if (!n) return;
  const doomed = new Set();
  const walkVar = (vid) => {
    doomed.add(vid);
    for (const p of plansAt(tree, vid)) walkPlan(p.id);
  };
  const walkPlan = (pid) => {
    doomed.add(pid);
    for (const v of variationsOf(tree, pid)) walkVar(v.id);
  };
  if (n.kind === 'plan') walkPlan(id);
  else walkVar(id);
  for (const d of doomed) delete tree.nodes[d];
  if (doomed.has(tree.activeId)) tree.activeId = null;
}

// ---------------------------------------------------------------------------
// orders
// ---------------------------------------------------------------------------

// The full order set a variation stands for: its plan's orders plus its own.
export function nodeOrdersText(tree, varId) {
  const v = getNode(tree, varId);
  if (!v) return '';
  const plan = getNode(tree, v.parent);
  return [plan ? plan.mine : '', v.theirs]
    .filter((s) => s && s.trim()).join('\n');
}

// Split the order box back into the two levels and store it. The focus power's
// block belongs to the PLAN — shared with every sibling variation, which is
// the point of the split — and everything else to this variation alone. With
// no focus power the plan holds nothing and the variation holds it all.
//
// Anything that changes invalidates the outcome it used to produce: a plan
// edit invalidates every variation under it, a variation edit only itself.
//
// "Changed" means the ORDERS changed, not the text — the box is refilled from
// a blank per-phase template on every render, so a node reopened and not
// touched comes back carrying extra headings and blank lines. Comparing raw
// text would read that as an edit and throw away a resolved outcome on every
// single re-render.
export function setNodeOrders(tree, varId, fullText, focus) {
  const v = getNode(tree, varId);
  if (!v) return false;
  const plan = getNode(tree, v.parent);
  const { visible, hidden } = splitForFilter(fullText, focus || '');
  const mine = focus ? visible : '';
  const theirs = focus ? hidden : visible;
  let changed = false;
  if (plan) {
    const planChanged = orderContent(plan.mine) !== orderContent(mine);
    plan.mine = mine;
    if (planChanged) {
      changed = true;
      for (const sib of variationsOf(tree, plan.id)) invalidate(tree, sib.id);
    }
  }
  const varChanged = orderContent(v.theirs) !== orderContent(theirs);
  v.theirs = theirs;
  if (varChanged) {
    changed = true;
    invalidate(tree, v.id);
  }
  return changed;
}

// ✏ Edit board inside a line: the variation's starting position moves, so
// whatever it used to resolve to no longer follows from it.
export function setNodeBefore(tree, varId, g) {
  const v = getNode(tree, varId);
  if (!v) return false;
  const next = positionOf(g);
  if (positionKey(next) === positionKey(v.before)) return false;
  v.before = next;
  invalidate(tree, varId);
  return true;
}

function invalidate(tree, varId) {
  const v = getNode(tree, varId);
  if (!v) return;
  v.after = null;
  markStale(tree, varId);
}

// Everything below an invalidated variation is still explorable — its orders
// are the user's work — but it no longer follows from what is above it, so it
// is flagged rather than deleted. Re-resolving the parent re-bases it.
function markStale(tree, varId) {
  for (const plan of plansAt(tree, varId)) {
    for (const child of variationsOf(tree, plan.id)) {
      child.stale = true;
      child.after = null;
      markStale(tree, child.id);
    }
  }
}

// A variation has been resolved: record where it lands, re-base anything
// already explored underneath onto the new outcome (their orders are kept,
// their results are not), and hand back the variation to continue in.
export function recordResolution(tree, varId, resolved) {
  const v = getNode(tree, varId);
  if (!v) return null;
  v.after = positionOf(resolved);
  v.stale = false;
  for (const plan of plansAt(tree, varId)) {
    for (const child of variationsOf(tree, plan.id)) {
      child.before = structuredClone(v.after);
      child.after = null;
      child.stale = false;
      markStale(tree, child.id);
    }
  }
  let plan = plansAt(tree, varId)[0];
  if (!plan) plan = addPlan(tree, varId);
  let next = variationsOf(tree, plan.id)[0];
  if (!next) next = addVariation(tree, plan.id, null, '', v.after);
  return next.id;
}

// ---------------------------------------------------------------------------
// navigating
// ---------------------------------------------------------------------------

export function pathTo(tree, id) {
  const out = [];
  let n = getNode(tree, id);
  while (n) {
    out.unshift(n);
    n = getNode(tree, n.parent);
  }
  return out;
}

// "Munich gambit ▸ Russia holds" — what the mode chip says out loud, so the
// line you are in is never a guess.
export function lineLabel(tree, id) {
  return pathTo(tree, id).map((n) => n.name).join(' ▸ ');
}

export function firstVariation(tree) {
  for (const p of plansAt(tree, null)) {
    const v = variationsOf(tree, p.id)[0];
    if (v) return v.id;
  }
  return null;
}

// The variation to open when entering analysis: the one left open last time,
// else the first in the tree, else a fresh plan-and-variation at the root.
// `activeId` always names a VARIATION — a plan is a folder holding one power's
// orders, never a full position to put on the board.
export function ensureEntry(tree) {
  const open = getNode(tree, tree.activeId);
  let id = open && open.kind === 'var' ? open.id : null;
  if (!id) id = firstVariation(tree);
  if (!id) {
    const plan = addPlan(tree, null);
    id = addVariation(tree, plan.id, null, '', tree.root).id;
  }
  tree.activeId = id;
  return id;
}

// The game object the app points at while a line is open. It is a real,
// ordinary game object (state.js branchGame) holding nothing but the position
// the variation starts from — which is what lets every drag, coast picker,
// retreat, build, board edit and playback in app.js work on a line unchanged.
// `analysisOf` is what marks it as a view rather than a game (isLine).
export function lineGame(tree, varId, liveGame) {
  const v = getNode(tree, varId);
  if (!v) return null;
  const g = branchGame(v.before, lineLabel(tree, varId));
  g.settings = { ...gameSettings(liveGame) }; // the live game's house rules, or it isn't analysis
  g.analysisOf = { name: liveGame.name, gistId: liveGame.gistId || null };
  g.nodeId = varId;
  g.focus = tree.focus || '';
  return g;
}

// Which power's orders are the shared "plan" level. Changing it re-splits
// every node: each variation's full order set is recombined and split again
// along the new line.
//
// The awkward case is sibling variations that disagree about the NEW focus
// power's orders — which is the normal case, since until now those orders were
// variation-local. A plan is shared by definition, so they cannot all sit
// under one; the first set keeps the plan and each distinct other set gets a
// plan of its own. Nothing is discarded, and the result is exactly right:
// "these two replies were really two different German plans all along".
export function refocus(tree, focus) {
  const next = focus || '';
  if (next === (tree.focus || '')) return false;
  for (const plan of Object.values(tree.nodes).filter((n) => n.kind === 'plan')) {
    const groups = new Map(); // order content -> { mine, vars }
    for (const v of variationsOf(tree, plan.id)) {
      const full = [plan.mine, v.theirs].filter((s) => s && s.trim()).join('\n');
      const { visible, hidden } = splitForFilter(full, next);
      const mine = next ? visible : '';
      v.theirs = next ? hidden : visible;
      v.after = null;
      v.stale = false;
      const key = orderContent(mine);
      if (!groups.has(key)) groups.set(key, { mine, vars: [] });
      groups.get(key).vars.push(v);
    }
    const sets = [...groups.values()];
    plan.mine = sets.length ? sets[0].mine : '';
    for (const extra of sets.slice(1)) {
      const p = addPlan(tree, plan.parent, null, extra.mine);
      for (const v of extra.vars) v.parent = p.id;
    }
  }
  tree.focus = next;
  return true;
}

export { phaseLabel };
