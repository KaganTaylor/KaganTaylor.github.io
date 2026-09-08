// The analysis tree: lines, folders, and where each line branched off.
//
// A LINE IS NOT A GAME. It is a view of the live game's current position — the
// 👁 Preview (app.js shadowGame/previewResolve), made persistent and nestable.
// Nothing here is ever written into the saved-games map: the whole tree hangs
// off `liveGame.analysis`, lives and dies with the position it is rooted at,
// and never appears on the home screen. That is the entire fix for "a branch
// goes stale the moment the live game moves on" — a branch used to be a peer
// game with its own identity, so nothing could keep it attached.
//
// A LINE IS AN ORDINARY GAME OBJECT (state.js branchGame), stored on its node.
// That one decision is what makes a line feel like the game rather than like a
// form: resolving inside it is S.resolvePhase, stepping back is S.undoLastPhase,
// looking at an earlier turn is the same history select, and every drag, coast
// picker, retreat, build and board edit in app.js works on it unchanged. A line
// runs as many phases forward as you like and stays ONE line — it is not chopped
// into a node per phase, because the phases of a plan are the plan.
//
// TWO KINDS OF NODE, and only one of them is a position:
//
//   🔀 line    a game of its own: a starting position and every phase since
//   📁 folder  organisation, nothing else — drag lines into it, collapse it
//
// BRANCHING IS EXPLICIT, and where the new line lands is decided by ONE rule:
// the phase you are looking at when you press ⑂ Branch.
//
//   at the line's own starting phase  →  a sibling, beside the line you are in
//   at any later phase of it          →  a child, nested beneath that line
//
// which is exactly what those two mean — "another idea from the same place" and
// "an idea that only exists because this line got us here". Nesting therefore
// records real dependency rather than the order you happened to click in, and
// two children branched from the same phase come out parallel to each other.
//
// Every function is pure: plain data in, plain data out, no DOM, no storage,
// no `game` module state. See DECISIONS.md, "A line is a view, not a game".

import { branchGame, gameSettings, phaseLabel } from './state.js';

// localStorage holds every saved game in one JSON blob that is rewritten on
// each save, so a tree is capped rather than allowed to grow without limit.
// A line carries a full game object, so it costs more than the old two-position
// variation did — a few KB, plus a few more for each phase resolved in it, plus
// (since branchFrom copies the source's history up to the cut point, so a
// branch's own History dropdown and Undo work from the moment it exists) the
// history it inherited — a chain of branches-of-branches duplicates that
// history at every link, so a deep chain costs more than a wide tree of the
// same line count.
export const MAX_LINES = 30;

// The SHAPE of the tree, not the position it hangs off. A tree is saved inside
// the game in localStorage, so a released change to the node model meets trees
// written by the previous one — and rootMatches() alone will not notice,
// because the position it was rooted at is exactly the position still on the
// board. The nodes then reach the panel with fields the renderer requires and
// they do not have (a plan node has no `game`), the render throws, and the
// panel comes back empty.
//
// So bump this whenever a node's shape changes. An unversioned or mismatched
// tree is void, exactly like one whose position moved, and the same single
// check throws it away (app.js validateAnalysis) — silently, since it holds no
// lines as this version counts them.
export const TREE_VERSION = 2;

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// ---------------------------------------------------------------------------
// positions
// ---------------------------------------------------------------------------

// The board itself, with nothing of the game around it: what a tree is rooted
// at, and what a new line is started from. Deliberately not state.js's
// boardSnapshot() — that carries history and redoStack, which are the live
// game's bookkeeping and say nothing about where the pieces are.
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

// The position a game was at N resolved phases in — `i === history.length` is
// where it stands now. This is what "branch at the phase I am looking at"
// resolves to, and what tells a child line whether the line above it still
// arrives at the position the child was cut from (isStale).
export function positionAt(g, i) {
  if (i >= g.history.length) return positionOf(g);
  const h = g.history[i];
  return structuredClone({
    year: h.year,
    season: h.season,
    step: h.step,
    units: h.unitsBefore,
    scOwners: h.scOwnersBefore,
    pending: h.pendingBefore || null,
  });
}

// The phase a line BEGINS at — what the tree names it by. Its current phase
// changes every time you resolve inside it, so labelling rows with that made
// the tree restless and answered a question the board already answers; where a
// line branches off is the fixed thing about it, and what tells two rows apart.
// A branched line carries its source's history (branchFrom), so history[0] is
// no longer necessarily this line's own start — `from.label` names that
// directly when the line has one. The first line (branched from nothing) has
// no `from`, so it falls back to its own history[0]/current phase.
export function lineStartLabel(node) {
  const g = node && node.game;
  if (!g) return '';
  if (node.from) return node.from.label;
  return g.history.length ? g.history[0].label : phaseLabel(g);
}

// How many phases a line has resolved ITSELF, as opposed to inherited from
// the line it was cut from (branchFrom copies history up to the cut point so
// the History dropdown and Undo have it). g.history.length alone would count
// those inherited phases too, which is wrong for "has this line moved on from
// its own start" and "how many phases has this line played" — both mean
// phases since the cut, not since the root.
export function ownPhaseCount(node) {
  const g = node && node.game;
  if (!g) return 0;
  return g.history.length - (node.from ? node.from.index : 0);
}

// The orders written at that phase — so a branch opens on a copy of what was
// tried, and exploring "what else?" is tweak-one-order rather than retype-all.
export function ordersAt(g, i) {
  if (i >= g.history.length) return g.orders || '';
  return g.history[i].ordersText || '';
}

// ---------------------------------------------------------------------------
// the tree
// ---------------------------------------------------------------------------

export function newTree(liveGame) {
  return {
    v: TREE_VERSION,
    root: positionOf(liveGame),
    rootKey: positionKey(liveGame),
    rootLabel: phaseLabel(liveGame),
    activeId: null,   // the line on the board
    selectedId: null, // the node ✎ and 🗑 act on — a line OR a folder
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
  if (!tree || !liveGame) return false;
  if (tree.v !== TREE_VERSION) return false; // written by an older node model
  return tree.rootKey === positionKey(liveGame);
}

// Is this game object one of our line views rather than a real game? The one
// fact every permission question about analysis is derived from (roles.js).
export function isLine(g) {
  return !!(g && g.analysisOf);
}

export function getNode(tree, id) {
  const n = (tree && tree.nodes && id && tree.nodes[id]) || null;
  if (!n) return null;
  if (n.kind === 'line') return n.game ? n : null;
  return n.kind === 'folder' ? n : null;
}

// Only nodes this version understands. The version guard above is what keeps a
// foreign tree out in the first place; this is the belt to its braces, so a
// single malformed node can never blank the whole panel by throwing mid-render.
export function allNodes(tree) {
  if (!tree || !tree.nodes) return [];
  return Object.values(tree.nodes)
    .filter((n) => n && (n.kind === 'line' ? !!n.game : n.kind === 'folder'));
}

export function lines(tree) {
  return allNodes(tree).filter((n) => n.kind === 'line');
}

export function lineCount(tree) {
  return lines(tree).length;
}

export function canBranch(tree) {
  return lineCount(tree) < MAX_LINES;
}

// Children of a node (or of the top level, with `parentId` null), in the order
// they are shown. `pos` is what drag-and-drop rewrites; `seq` only breaks ties.
export function childrenOf(tree, parentId = null) {
  return allNodes(tree)
    .filter((n) => (n.parent || null) === (parentId || null))
    .sort((a, b) => ((a.pos || 0) - (b.pos || 0)) || (a.seq - b.seq));
}

function nextPos(tree, parentId) {
  let max = -1;
  for (const s of childrenOf(tree, parentId)) {
    if (Number.isFinite(s.pos) && s.pos > max) max = s.pos;
  }
  return max + 1;
}

export function descendantIds(tree, id) {
  const out = new Set();
  const walk = (pid) => {
    for (const c of childrenOf(tree, pid)) {
      out.add(c.id);
      walk(c.id);
    }
  };
  walk(id);
  return out;
}

export function defaultLineName(tree) {
  const n = lineCount(tree);
  return n === 0 ? 'Main line' : `Variation ${n + 1}`;
}

export function defaultFolderName(tree) {
  const n = allNodes(tree).filter((x) => x.kind === 'folder').length;
  return `Plan ${LETTERS[n] || n + 1}`;
}

// A new line. `position` is where it starts, `orders` the draft it opens on,
// `from` how it relates to the line it was cut from (null for the first line):
// {lineId, index, key, label}. `from.lineId` is the ORIGIN, which is not always
// the tree parent — a sibling branch shares its origin's parent — so staleness
// and placement stay independent facts. `history` (optional) is the source
// line's own history up to the cut point, carried into the new line so its
// History dropdown and Undo see the phases that led here, not just the phases
// it resolves itself — see branchFrom.
export function addLine(tree, opts = {}) {
  const seq = ++tree.seq;
  const id = `l${seq}`;
  const name = opts.name || defaultLineName(tree);
  const g = branchGame(opts.position || tree.root, name, null, opts.history || null);
  if (opts.settings) g.settings = { ...opts.settings };
  g.orders = opts.orders || '';
  tree.nodes[id] = {
    id, seq, kind: 'line',
    parent: opts.parent || null,
    pos: nextPos(tree, opts.parent || null),
    name,
    game: g,
    from: opts.from || null,
  };
  return tree.nodes[id];
}

export function addFolder(tree, parentId = null, name = null) {
  const seq = ++tree.seq;
  const id = `f${seq}`;
  tree.nodes[id] = {
    id, seq, kind: 'folder',
    parent: parentId || null,
    pos: nextPos(tree, parentId || null),
    name: name || defaultFolderName(tree),
    collapsed: false,
  };
  return tree.nodes[id];
}

// 📁 Folder: a folder appears WHERE THE SELECTED NODE IS and swallows that
// node and everything parallel to it. Making it empty and asking the user to
// drag things in would be a folder that starts by doing nothing; grouping the
// siblings is what "these parallel ideas are one plan" actually means, and
// dragging back out is the cheap direction.
export function groupSiblings(tree, id, name = null) {
  const n = getNode(tree, id);
  if (!n) return null;
  const parentId = n.parent || null;
  const sibs = childrenOf(tree, parentId);
  const folder = addFolder(tree, parentId, name);
  sibs.forEach((s, i) => {
    s.parent = folder.id;
    s.pos = i;
  });
  folder.pos = 0;
  return folder;
}

// Drag-and-drop, and the only thing that changes a node's placement after it is
// created. `parentId` may be a folder, a LINE, or null for the top level —
// dragging is deliberately not restricted to the placements ⑂ Branch produces,
// because organising by hand is the whole reason it exists, and `from` (what a
// line was cut from, and so whether it is stale) is stored separately from
// `parent` precisely so moving a row cannot lie about its origin.
//
// `beforeId` names a sibling to insert in front of; null appends. Moving a node
// into its own subtree would orphan the whole branch, so it is refused rather
// than silently repaired.
export function moveNode(tree, id, parentId, beforeId = null) {
  const n = getNode(tree, id);
  if (!n || id === parentId) return false;
  if (parentId && descendantIds(tree, id).has(parentId)) return false;
  const target = parentId || null;
  const sibs = childrenOf(tree, target).filter((s) => s.id !== id);
  const at = beforeId ? sibs.findIndex((s) => s.id === beforeId) : -1;
  const list = at < 0 ? [...sibs, n] : [...sibs.slice(0, at), n, ...sibs.slice(at)];
  n.parent = target;
  list.forEach((s, i) => { s.pos = i; });
  return true;
}

export function renameNode(tree, id, name) {
  const n = getNode(tree, id);
  if (!n || !name || !name.trim()) return;
  n.name = name.trim();
  if (n.game) n.game.name = n.name;
}

export function toggleCollapsed(tree, id) {
  const n = getNode(tree, id);
  if (n && n.kind === 'folder') n.collapsed = !n.collapsed;
}

export function deleteNode(tree, id) {
  const n = getNode(tree, id);
  if (!n) return;
  const doomed = descendantIds(tree, id);
  doomed.add(id);
  for (const d of doomed) delete tree.nodes[d];
  if (doomed.has(tree.activeId)) tree.activeId = null;
  if (doomed.has(tree.selectedId)) tree.selectedId = null;
}

// ---------------------------------------------------------------------------
// branching
// ---------------------------------------------------------------------------

// Where ⑂ Branch puts the new line, given the phase being looked at. The whole
// nesting rule, in one expression, so the panel can say it out loud before the
// click as well as act on it after (app.js renderAnalysisUI).
//
//   index 0  →  the line's own starting phase: a sibling
//   index >0 →  a phase this line produced: a child of it
export function branchParent(tree, srcId, index) {
  const src = getNode(tree, srcId);
  if (!src) return null;
  return index > 0 ? src.id : (src.parent || null);
}

// Cut a new line off `srcId` at the phase `index` phases into it. The new
// line inherits src's history up to that point — it is where the new idea
// actually came from — so its own History dropdown and Undo see those phases
// from the moment it exists, rather than showing nothing until it resolves a
// phase of its own.
export function branchFrom(tree, srcId, index, settings) {
  const src = getNode(tree, srcId);
  if (!src || src.kind !== 'line') return null;
  const i = Math.max(0, Math.min(index, src.game.history.length));
  const position = positionAt(src.game, i);
  return addLine(tree, {
    parent: branchParent(tree, srcId, i),
    position,
    orders: ordersAt(src.game, i),
    settings,
    history: src.game.history.slice(0, i),
    from: {
      lineId: src.id,
      index: i,
      key: positionKey(position),
      label: phaseLabel(position),
    },
  });
}

// Does the line this one was cut from still arrive at the position it was cut
// from? Undo a phase in the parent, or resolve it differently, and the child no
// longer follows from it. The child is still perfectly explorable — it is a
// self-contained game — so this is a flag, never a deletion.
export function isStale(tree, node) {
  const f = node && node.from;
  if (!f) return false;
  const src = getNode(tree, f.lineId);
  if (!src || src.kind !== 'line') return false;
  if (f.index > src.game.history.length) return true;
  return positionKey(positionAt(src.game, f.index)) !== f.key;
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

// "Plan A ▸ Munich gambit" — the full placement of a line, for the one place
// that wants it spelled out (the switch's tooltip).
export function lineLabel(tree, id) {
  return pathTo(tree, id).map((n) => n.name).join(' ▸ ');
}

// The first line in display order, wherever it sits in the folders.
export function firstLine(tree) {
  const walk = (parentId) => {
    for (const c of childrenOf(tree, parentId)) {
      if (c.kind === 'line') return c;
      const inside = walk(c.id);
      if (inside) return inside;
    }
    return null;
  };
  return walk(null);
}

// The line to open when entering analysis: the one left open last time, else
// the first in the tree, else a fresh Main line at the root. `activeId` always
// names a LINE — a folder is organisation, never a position to put on a board.
export function ensureEntry(tree, settings) {
  let n = getNode(tree, tree.activeId);
  if (!n || n.kind !== 'line') n = firstLine(tree);
  if (!n) n = addLine(tree, { position: tree.root, name: 'Main line', settings });
  tree.activeId = n.id;
  if (!getNode(tree, tree.selectedId)) tree.selectedId = n.id;
  return n.id;
}

// The game object the app points at while a line is open — the node's OWN game,
// handed back live rather than rebuilt, so resolving, undoing and editing the
// board inside a line are the ordinary operations writing to the ordinary
// place. `analysisOf` is what marks it as a view rather than a game (isLine).
export function lineGame(tree, id, liveGame) {
  const n = getNode(tree, id);
  if (!n || n.kind !== 'line') return null;
  const g = n.game;
  g.name = n.name;
  g.settings = { ...gameSettings(liveGame) }; // the live game's house rules, or it isn't analysis
  g.analysisOf = { name: liveGame.name, gistId: liveGame.gistId || null };
  g.nodeId = id;
  if (!g.redoStack) g.redoStack = [];
  return g;
}

export { phaseLabel };
