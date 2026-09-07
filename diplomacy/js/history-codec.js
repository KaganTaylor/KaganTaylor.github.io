// Packs/unpacks `game.history` (and `redoStack`) for the wire only. The
// in-memory shape produced by state.js's resolvePhase/stripResult never
// changes — see DECISIONS.md and the plan behind this file. Pure, no DOM/IO.

export const HISTORY_FORMAT = 2;

// Keys stripped from result.order when they equal these defaults. `reason`
// lives on the result, not the order (see state.js stripResult), so it is
// not here — packResult/unpackResult handle it separately.
const ORDER_DEFAULTS = {
  viaConvoy: false, isConvoyMove: false, convoyRoute: null,
  target: null, implicit: false, illegal: null, auto: false,
};

const ALWAYS_KEEP = new Set(['power', 'kind', 'loc', 'dest', 'unitType', 'verdict']);

function packOrder(o) {
  const out = {};
  for (const k of Object.keys(o)) {
    if (k === 'destLoc') continue; // handled below
    if (ALWAYS_KEEP.has(k)) { out[k] = o[k]; continue; }
    if (k in ORDER_DEFAULTS && o[k] === ORDER_DEFAULTS[k]) continue;
    out[k] = o[k];
  }
  if (o.destLoc !== o.dest) out.destLoc = o.destLoc;
  return out;
}

function unpackOrder(o) {
  const out = { ...o };
  for (const k of Object.keys(ORDER_DEFAULTS)) {
    if (!(k in out)) out[k] = ORDER_DEFAULTS[k];
  }
  if (!('destLoc' in out)) out.destLoc = out.dest;
  return out;
}

function packResult(r) {
  const out = { verdict: r.verdict, order: packOrder(r.order) };
  if (r.reason) out.reason = r.reason;
  return out;
}

function unpackResult(r) {
  const out = { verdict: r.verdict, reason: r.reason || null, order: unpackOrder(r.order) };
  return out;
}

function packEntry(entry, keepBefore) {
  const {
    unitsBefore, scOwnersBefore, pendingBefore,
    results, dislodged, standoffs, destroyed, pendingAfter,
    ...rest
  } = entry;
  const out = { ...rest };
  if (keepBefore) {
    out.unitsBefore = unitsBefore;
    out.scOwnersBefore = scOwnersBefore;
    out.pendingBefore = pendingBefore;
  }
  if (results) out.results = results.map(packResult);
  if (dislodged && dislodged.length) out.dislodged = dislodged;
  if (standoffs && standoffs.length) out.standoffs = standoffs;
  if (destroyed && destroyed.length) out.destroyed = destroyed;
  if (pendingAfter != null) out.pendingAfter = pendingAfter;
  return out;
}

function unpackEntry(entry, before) {
  const out = { ...entry };
  out.unitsBefore = entry.unitsBefore !== undefined ? entry.unitsBefore : before.units;
  out.scOwnersBefore = entry.scOwnersBefore !== undefined ? entry.scOwnersBefore : before.scOwners;
  out.pendingBefore = entry.pendingBefore !== undefined ? entry.pendingBefore : before.pending;
  if (out.results) out.results = out.results.map(unpackResult);
  out.dislodged = entry.dislodged || [];
  out.standoffs = entry.standoffs || [];
  out.destroyed = entry.destroyed || [];
  out.pendingAfter = entry.pendingAfter != null ? entry.pendingAfter : null;
  return out;
}

// full -> compact. Non-mutating; structuredClone's the input first.
export function packHistory(entries, { chain = true } = {}) {
  return structuredClone(entries).map((entry, i) => packEntry(entry, !chain || i === 0));
}

// compact -> full. Non-mutating.
export function unpackHistory(entries, { chain = true } = {}) {
  const cloned = structuredClone(entries);
  const out = [];
  for (let i = 0; i < cloned.length; i++) {
    const before = chain && i > 0
      ? { units: out[i - 1].unitsAfter, scOwners: out[i - 1].scOwnersAfter, pending: out[i - 1].pendingAfter }
      : { units: undefined, scOwners: undefined, pending: undefined };
    out.push(unpackEntry(cloned[i], before));
  }
  return out;
}
