// Game state, phase machine, and persistence.
//
// Phase flow per year:
//   spring movement -> spring retreat (if any dislodged)
//   -> fall movement -> fall retreat (if any) -> [SC update]
//   -> winter adjustment (if any builds/disbands) -> next spring

import { START_UNITS, START_OWNERS, POWERS, HOME_CENTERS } from './map-data.js';
import {
  adjudicateMovement,
  adjudicateRetreats,
  adjudicateAdjustments,
  updateSupplyCenters,
  prov,
} from './adjudicator.js';

const STORE_KEY = 'diplomacysim:games';

export function newGame(name) {
  const units = [];
  for (const [power, us] of Object.entries(START_UNITS)) {
    for (const u of us) units.push({ power, type: u.type, loc: u.loc });
  }
  return {
    name,
    created: new Date().toISOString(),
    season: 'spring',
    year: 1901,
    step: 'movement', // movement | retreat | adjustment
    units,
    scOwners: { ...START_OWNERS },
    pending: null, // retreat context: {dislodged, standoffs}
    history: [],
  };
}

export function sandboxGame(name) {
  const g = newGame(name);
  g.units = [];
  g.sandbox = true;
  return g;
}

export function phaseLabel(g) {
  const season = { spring: 'Spring', fall: 'Fall', winter: 'Winter' }[g.season];
  const step = { movement: 'Movement', retreat: 'Retreats', adjustment: 'Builds' }[g.step];
  return `${season} ${g.year} — ${step}`;
}

// how many builds(+)/disbands(-) each power owes in winter
export function adjustmentCounts(g) {
  const unitCount = {};
  const scCount = {};
  for (const u of g.units) unitCount[u.power] = (unitCount[u.power] || 0) + 1;
  for (const owner of Object.values(g.scOwners)) if (owner) scCount[owner] = (scCount[owner] || 0) + 1;
  const counts = {};
  for (const p of POWERS) {
    const c = (scCount[p] || 0) - (unitCount[p] || 0);
    if ((unitCount[p] || 0) + (scCount[p] || 0) > 0) counts[p] = c;
  }
  return counts;
}

// Resolve the current phase with the given parsed orders.
// Returns the history entry (also appended to g.history), advancing g.
export function resolvePhase(g, orders, ordersText) {
  const entry = {
    label: phaseLabel(g),
    season: g.season,
    year: g.year,
    step: g.step,
    ordersText,
    unitsBefore: structuredClone(g.units),
    scOwnersBefore: structuredClone(g.scOwners),
    pendingBefore: structuredClone(g.pending),
  };

  if (g.step === 'movement') {
    const out = adjudicateMovement(g.units, orders);
    entry.results = out.results.map(stripResult);
    entry.dislodged = out.dislodged;
    entry.standoffs = out.standoffs;
    entry.unitsAfter = out.unitsAfter;
    g.units = out.unitsAfter;
    const canRetreat = out.dislodged.filter((d) => d.retreatOptions.length > 0);
    const destroyed = out.dislodged.filter((d) => d.retreatOptions.length === 0);
    entry.destroyed = destroyed;
    if (canRetreat.length > 0) {
      g.pending = { dislodged: canRetreat, standoffs: out.standoffs };
      g.step = 'retreat';
    } else {
      g.pending = null;
      advanceAfterMovementPhase(g);
    }
  } else if (g.step === 'retreat') {
    const out = adjudicateRetreats(g.pending.dislodged, g.units, orders);
    entry.results = out.results.map(stripResult);
    entry.dislodged = g.pending.dislodged;
    entry.unitsAfter = out.unitsAfter;
    g.units = out.unitsAfter;
    g.pending = null;
    advanceAfterMovementPhase(g);
  } else {
    // adjustment
    const out = adjudicateAdjustments(g.scOwners, g.units, orders);
    entry.results = out.results.map(stripResult);
    entry.unitsAfter = out.unitsAfter;
    g.units = out.unitsAfter;
    g.season = 'spring';
    g.year += 1;
    g.step = 'movement';
  }
  entry.scOwnersAfter = structuredClone(g.scOwners);
  entry.phaseAfter = phaseLabel(g);
  g.history.push(entry);
  return entry;
}

function advanceAfterMovementPhase(g) {
  if (g.season === 'spring') {
    g.season = 'fall';
    g.step = 'movement';
  } else {
    // after fall (and its retreats): capture supply centers
    g.scOwners = updateSupplyCenters(g.scOwners, g.units);
    const counts = adjustmentCounts(g);
    const anyChange = Object.values(counts).some((c) => c !== 0);
    if (anyChange) {
      g.season = 'winter';
      g.step = 'adjustment';
    } else {
      g.season = 'spring';
      g.year += 1;
      g.step = 'movement';
    }
  }
}

// keep history entries serializable and compact
function stripResult(r) {
  const o = r.order;
  return {
    verdict: r.verdict,
    reason: r.reason || null,
    order: {
      power: o.power,
      kind: o.kind,
      loc: o.loc,
      dest: o.dest || null,
      destLoc: o.destLoc || null,
      viaConvoy: !!o.viaConvoy,
      isConvoyMove: !!o.isConvoyMove,
      unitType: o.unit ? o.unit.type : o.unitType || null,
      target: o.target ? { loc: o.target.loc, dest: o.target.dest || null } : null,
      implicit: !!o.implicit,
      illegal: o.illegal || null,
      auto: !!o.auto,
    },
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
export function listGames() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
  } catch {
    return {};
  }
}

export function saveGame(g) {
  const games = listGames();
  games[g.name] = g;
  localStorage.setItem(STORE_KEY, JSON.stringify(games));
}

export function deleteGame(name) {
  const games = listGames();
  delete games[name];
  localStorage.setItem(STORE_KEY, JSON.stringify(games));
}

export function exportGame(g) {
  return JSON.stringify(g, null, 1);
}

export function importGame(json) {
  const g = JSON.parse(json);
  if (!g || !Array.isArray(g.units) || !g.scOwners || !g.year) {
    throw new Error('not a Diplomacy game file');
  }
  g.history = g.history || [];
  return g;
}

export { prov, HOME_CENTERS };
