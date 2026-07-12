// Pure Diplomacy adjudication engine. No DOM, no game state — takes positions
// and orders, returns resolutions. Movement resolution follows Lucas
// Kruijswijk's "The Math of Adjudication" (recursive resolution with guessing;
// Szykman rule for convoy paradoxes, all-succeed for circular movement).

import { PROVINCES, ARMY_ADJ, FLEET_ADJ, HOME_CENTERS } from './map-data.js';

export function prov(loc) {
  return loc.split('/')[0];
}

export function armyAdjacent(fromProv, toProv) {
  return (ARMY_ADJ[fromProv] || []).includes(toProv);
}

export function fleetAdjacent(fromLoc, toLoc) {
  return (FLEET_ADJ[fromLoc] || []).includes(toLoc);
}

// locations (with coast) of destProv reachable by a fleet at fromLoc
export function fleetDestLocs(fromLoc, destProv) {
  return (FLEET_ADJ[fromLoc] || []).filter((l) => prov(l) === destProv);
}

// can `unit` support an action in province `destProv`?
export function canSupportInto(unit, destProv) {
  if (unit.type === 'A') return armyAdjacent(prov(unit.loc), destProv);
  return fleetDestLocs(unit.loc, destProv).length > 0;
}

// could `water` be part of some convoy route from `from` to `dest`, going
// through water provinces only (fleet presence not required)?
function onPossibleWaterRoute(water, from, dest) {
  const isWater = (p) => PROVINCES[p] && PROVINCES[p].type === 'water';
  // waters reachable from `from`
  const reach = new Set();
  const queue = [];
  for (const [w] of Object.entries(PROVINCES)) {
    if (isWater(w) && (FLEET_ADJ[w] || []).some((l) => prov(l) === from)) {
      reach.add(w);
      queue.push(w);
    }
  }
  while (queue.length) {
    const w = queue.shift();
    for (const l of FLEET_ADJ[w] || []) {
      const p = prov(l);
      if (isWater(p) && !reach.has(p)) {
        reach.add(p);
        queue.push(p);
      }
    }
  }
  if (!reach.has(water)) return false;
  // dest reachable from `water` through water
  const seen = new Set([water]);
  const q2 = [water];
  while (q2.length) {
    const w = q2.shift();
    if ((FLEET_ADJ[w] || []).some((l) => prov(l) === dest)) return true;
    for (const l of FLEET_ADJ[w] || []) {
      const p = prov(l);
      if (isWater(p) && !seen.has(p)) {
        seen.add(p);
        q2.push(p);
      }
    }
  }
  return false;
}

// could an army at province `from` be convoyed to province `dest` at all,
// through water provinces that currently contain a fleet (regardless of
// orders)? Used to distinguish a failed convoy (real move order) from a
// void order (treated as hold, DATC 6.D.28-34), and by the UI to reject a
// drag that could never convoy.
export function convoyPossible(units, from, dest) {
  const fleetWaters = new Set();
  for (const u of units) {
    if (u.type === 'F' && PROVINCES[prov(u.loc)].type === 'water')
      fleetWaters.add(prov(u.loc));
  }
  const queue = [];
  const seen = new Set();
  for (const w of fleetWaters) {
    if ((FLEET_ADJ[w] || []).some((l) => prov(l) === from)) {
      queue.push(w);
      seen.add(w);
    }
  }
  while (queue.length) {
    const w = queue.shift();
    const adj = FLEET_ADJ[w] || [];
    if (adj.some((l) => prov(l) === dest)) return true;
    for (const l of adj) {
      const p = prov(l);
      if (fleetWaters.has(p) && !seen.has(p)) {
        seen.add(p);
        queue.push(p);
      }
    }
  }
  return false;
}

const SUCCEEDS = true;
const FAILS = false;

// ---------------------------------------------------------------------------
// Movement adjudication
//
// units:  [{power, type: 'A'|'F', loc}]   (one unit per province)
// orders: [{power, kind: 'hold'|'move'|'support'|'convoy', loc,
//           dest?, viaConvoy?, target?: {loc, dest?}}]
//   support: target.loc = supported unit's location, target.dest = null for
//            support-hold, else destination of supported move
//   convoy:  target.loc = convoyed army's location, dest = its destination
//
// Returns {results, dislodged, standoffs, unitsAfter}
// ---------------------------------------------------------------------------
export function adjudicateMovement(units, orders) {
  const board = new Map(); // province -> unit
  for (const u of units) board.set(prov(u.loc), u);

  // -- normalize: one internal order per unit ------------------------------
  // Later orders for the same unit replace earlier ones. Orders for units
  // that don't exist or belong to another power are reported invalid.
  const internal = new Map(); // province -> internal order
  const invalid = [];
  for (const o of orders) {
    const p = prov(o.loc);
    const u = board.get(p);
    if (!u || u.power !== o.power) {
      invalid.push({ order: o, verdict: 'invalid', reason: 'no such unit' });
      continue;
    }
    internal.set(p, { ...o, unit: u, origin: p });
  }
  for (const u of units) {
    const p = prov(u.loc);
    if (!internal.has(p)) {
      internal.set(p, { power: u.power, kind: 'hold', loc: u.loc, unit: u, origin: p, implicit: true });
    }
  }

  const all = [...internal.values()];

  // -- legality ------------------------------------------------------------
  for (const o of all) {
    o.illegal = null;
    if (o.kind === 'move') {
      const from = o.unit.loc;
      const destProv = prov(o.dest);
      if (!PROVINCES[destProv]) {
        o.illegal = 'unknown destination';
      } else if (destProv === o.origin) {
        o.illegal = 'cannot move to own province';
      } else if (o.unit.type === 'A') {
        o.destLoc = destProv;
        if (armyAdjacent(o.origin, destProv)) {
          o.adjacentMove = true;
        } else if (PROVINCES[o.origin].type === 'coast' && PROVINCES[destProv].type === 'coast') {
          o.mustConvoy = true; // route checked below (DATC 6.D.32: a move with
          // no fleet anywhere that could convoy is void, not merely failed)
        } else {
          o.illegal = 'not adjacent';
        }
      } else {
        // fleet: resolve destination coast
        const destInfo = PROVINCES[destProv];
        if (destInfo.type === 'land') {
          o.illegal = 'fleet cannot move inland';
        } else if (o.dest.includes('/')) {
          if (fleetAdjacent(from, o.dest)) {
            o.destLoc = o.dest;
            o.adjacentMove = true;
          } else o.illegal = 'not adjacent';
        } else {
          const opts = fleetDestLocs(from, destProv);
          if (opts.length === 1) {
            o.destLoc = opts[0];
            o.adjacentMove = true;
          } else if (opts.length > 1) {
            // ambiguous coast not specified (DATC 4.B.1 preference: fails)
            o.illegal = 'coast must be specified';
          } else o.illegal = 'not adjacent';
        }
      }
      if (!o.illegal) o.destProv = prov(o.destLoc);
    } else if (o.kind === 'support') {
      const targetProv = prov(o.target.loc);
      const intoProv = o.target.dest ? prov(o.target.dest) : targetProv;
      o.targetProv = targetProv;
      o.intoProv = intoProv;
      const supported = board.get(targetProv);
      if (!supported) o.illegal = 'no unit to support';
      else if (!canSupportInto(o.unit, intoProv)) o.illegal = 'cannot reach supported province';
      else if (targetProv === o.origin) o.illegal = 'cannot support self';
    } else if (o.kind === 'convoy') {
      const targetProv = prov(o.target.loc);
      o.targetProv = targetProv;
      o.destProv = prov(o.dest);
      const carried = board.get(targetProv);
      if (PROVINCES[o.origin].type !== 'water') o.illegal = 'convoy only from open sea';
      else if (o.unit.type !== 'F') o.illegal = 'only fleets convoy';
      else if (!carried || carried.type !== 'A') o.illegal = 'no army to convoy';
      else if (!onPossibleWaterRoute(o.origin, targetProv, o.destProv))
        o.illegal = 'convoy impossible from here'; // DATC 4.E.1 / 6.G.7
    }
    if (o.illegal) {
      // illegal orders act as holds
      o.effKind = 'hold';
    } else {
      o.effKind = o.kind;
    }
  }

  // -- convoy route legality for moves -------------------------------------
  // A convoying fleet counts for a move if it is legally ordered to convoy
  // exactly that move (army origin + destination match).
  const convoyersFor = (o) =>
    all.filter(
      (c) =>
        c.effKind === 'convoy' &&
        c.targetProv === o.origin &&
        c.destProv === o.destProv
    );

  // is there a chain of convoyers (subset allowed to be `pred`-filtered)
  // linking origin coast to destination coast?
  function convoyPath(o, fleetOk) {
    const fleets = convoyersFor(o).filter(fleetOk);
    if (!fleets.length) return false;
    const fleetAt = new Map(fleets.map((f) => [f.origin, f]));
    // start: water provinces with convoyer adjacent to the army's province
    const queue = [];
    const seen = new Set();
    for (const f of fleets) {
      const adj = FLEET_ADJ[f.origin] || [];
      if (adj.some((l) => prov(l) === o.origin)) {
        queue.push(f.origin);
        seen.add(f.origin);
      }
    }
    while (queue.length) {
      const w = queue.shift();
      const adj = FLEET_ADJ[w] || [];
      if (adj.some((l) => prov(l) === o.destProv)) return true;
      for (const l of adj) {
        const p = prov(l);
        if (fleetAt.has(p) && !seen.has(p)) {
          seen.add(p);
          queue.push(p);
        }
      }
    }
    return false;
  }

  // could a convoy exist at all, through water provinces that contain a
  // fleet (regardless of orders)? Distinguishes a failed convoy (real move
  // order) from a void order (treated as hold, DATC 6.D.28-34)
  const potentialConvoyPath = (o) => convoyPossible(units, o.origin, o.destProv);

  for (const o of all) {
    if (o.effKind !== 'move') continue;
    const anyRoute = o.unit.type === 'A' && convoyPath(o, () => true);
    if (o.mustConvoy) {
      if (anyRoute) {
        o.isConvoyMove = true;
      } else if (potentialConvoyPath(o)) {
        // fleets are there but not (all) ordered to convoy: a real move
        // order whose path simply fails
        o.isConvoyMove = true;
      } else {
        o.illegal = 'no convoy possible';
        o.effKind = 'hold';
      }
    } else if (o.unit.type === 'A' && anyRoute) {
      // adjacent move with an ordered convoy route: takes the convoy when
      // explicitly "via convoy", or when the army's own power expressed
      // intent with a (legal) convoy order (DATC 4.A.3 choice d — the
      // 1982/2000 rulebook; illegal convoy orders show no intent, 6.G.7)
      if (o.viaConvoy || convoyersFor(o).some((c) => c.power === o.power)) {
        o.isConvoyMove = true;
      }
    }
  }

  // -- indexes ---------------------------------------------------------------
  const movesTo = new Map(); // province -> [move orders]
  for (const o of all) {
    if (o.effKind !== 'move') continue;
    if (!movesTo.has(o.destProv)) movesTo.set(o.destProv, []);
    movesTo.get(o.destProv).push(o);
  }
  const supportsFor = (m) =>
    all.filter((s) => {
      if (s.effKind !== 'support' || s.targetProv !== m.origin) return false;
      if (m.effKind === 'move') {
        if (!s.target.dest || s.intoProv !== m.destProv) return false;
        // a support naming an explicit coast only matches a move to it
        if (s.target.dest.includes('/') && s.target.dest !== m.destLoc) return false;
        return true;
      }
      // hold support: any unit not (effectively) ordered to move can receive
      // it — void move orders count as holds (DATC 6.D.28-32)
      return !s.target.dest;
    });

  all.forEach((o, i) => (o.idx = i));

  // -- resolution engine (Kruijswijk) ---------------------------------------
  const UNRESOLVED = 0, GUESSING = 1, RESOLVED = 2;
  const state = new Array(all.length).fill(UNRESOLVED);
  const resolution = new Array(all.length).fill(FAILS);
  let depList = [];
  let guessReads = 0; // counts every read of a GUESSING value

  // Port of the resolve() from Kruijswijk, "The Math of Adjudication",
  // chapter 6 — with one strengthening: an adjudication that read any
  // guessed value (even one already on the dependency list) is treated as
  // guess-dependent and stays GUESSING, instead of being resolved.
  function resolve(i) {
    if (state[i] === RESOLVED) return resolution[i];
    if (state[i] === GUESSING) {
      guessReads++;
      if (!depList.includes(i)) depList.push(i);
      return resolution[i];
    }
    const oldLen = depList.length;
    const oldReads = guessReads;
    resolution[i] = FAILS;
    state[i] = GUESSING;
    const first = adjudicate(i);
    if (guessReads === oldReads) {
      // result does not depend on any guess
      if (state[i] !== RESOLVED) {
        resolution[i] = first;
        state[i] = RESOLVED;
      }
      return first;
    }
    if (depList[oldLen] !== i) {
      // depends on someone else's guess: join the cycle's dependency list,
      // stay in guessing state with the tentative result
      if (!depList.includes(i)) depList.push(i);
      resolution[i] = first;
      return first;
    }
    // depends on our own guess: try the other one
    while (depList.length > oldLen) state[depList.pop()] = UNRESOLVED;
    resolution[i] = SUCCEEDS;
    state[i] = GUESSING;
    const second = adjudicate(i);
    if (first === second) {
      while (depList.length > oldLen) state[depList.pop()] = UNRESOLVED;
      resolution[i] = first;
      state[i] = RESOLVED;
      return first;
    }
    backupRule(oldLen);
    return resolve(i);
  }

  function backupRule(oldLen) {
    const segment = depList.slice(oldLen);
    depList.length = oldLen;
    // A convoy ORDER in the cycle means the paradox core (a convoying
    // fleet's fate depends on the moves): apply the Szykman rule. A cycle of
    // moves only — even convoyed ones — is circular movement.
    const paradox = segment.some((j) => all[j].effKind === 'convoy');
    if (paradox) {
      const convoysInCycle = segment
        .map((j) => all[j])
        .filter((o) => o.effKind === 'convoy');
      let failedAny = false;
      for (const [j, o] of all.entries()) {
        if (o.effKind !== 'move' || !o.isConvoyMove) continue;
        const involved =
          segment.includes(j) ||
          convoysInCycle.some(
            (c) => c.targetProv === o.origin && c.destProv === o.destProv
          );
        if (involved) {
          o.pathForcedFail = true; // Szykman: as if the army never moved
          state[j] = RESOLVED;
          resolution[j] = FAILS;
          failedAny = true;
        }
      }
      for (const j of segment) {
        if (state[j] !== RESOLVED) state[j] = UNRESOLVED;
      }
      if (!failedAny) {
        // shouldn't happen with standard rules; fail the cycle's moves to
        // guarantee termination
        for (const j of segment) {
          if (all[j].effKind === 'move') {
            state[j] = RESOLVED;
            resolution[j] = FAILS;
          }
        }
      }
    } else {
      // circular movement: all moves succeed
      for (const j of segment) {
        if (all[j].effKind === 'move') {
          state[j] = RESOLVED;
          resolution[j] = SUCCEEDS;
        } else {
          state[j] = UNRESOLVED;
        }
      }
    }
  }

  // path(): for convoyed moves, needs a route of convoyers that are not
  // dislodged (their convoy order "succeeds")
  function path(m) {
    if (!m.isConvoyMove) return true;
    if (m.pathForcedFail) return false; // Szykman rule applied
    return convoyPath(m, (f) => resolve(f.idx));
  }

  const orderAt = (p) => internal.get(p);

  function headToHead(m) {
    if (m.isConvoyMove) return null;
    const opp = orderAt(m.destProv);
    if (
      opp &&
      opp.effKind === 'move' &&
      !opp.isConvoyMove &&
      opp.destProv === m.origin
    )
      return opp;
    return null;
  }

  function supportCount(m, excludePower) {
    let n = 0;
    for (const s of supportsFor(m)) {
      if (excludePower && s.power === excludePower) continue;
      if (resolve(s.idx)) n++;
    }
    return n;
  }

  function attackStrength(m) {
    if (!path(m)) return 0;
    const occupant = board.get(m.destProv);
    let movesAway = false;
    if (occupant) {
      const oo = orderAt(m.destProv);
      movesAway =
        oo.effKind === 'move' && !headToHead(m) && resolve(oo.idx);
    }
    if (!occupant || movesAway) return 1 + supportCount(m, null);
    if (occupant.power === m.power) return 0;
    return 1 + supportCount(m, occupant.power);
  }

  function defendStrength(m) {
    return 1 + supportCount(m, null);
  }

  function preventStrength(m) {
    if (!path(m)) return 0;
    const opp = headToHead(m);
    if (opp && resolve(opp.idx)) return 0;
    return 1 + supportCount(m, null);
  }

  function holdStrength(p) {
    const u = board.get(p);
    if (!u) return 0;
    const o = orderAt(p);
    if (o.effKind === 'move') return resolve(o.idx) ? 0 : 1;
    let n = 1;
    for (const s of supportsFor(o)) if (resolve(s.idx)) n++;
    return n;
  }

  function adjudicate(i) {
    const o = all[i];
    switch (o.effKind) {
      case 'move': {
        const atk = attackStrength(o);
        const opp = headToHead(o);
        const counter = opp ? defendStrength(opp) : holdStrength(o.destProv);
        if (atk <= counter) return FAILS;
        for (const m of movesTo.get(o.destProv)) {
          if (m === o) continue;
          if (atk <= preventStrength(m)) return FAILS;
        }
        return SUCCEEDS;
      }
      case 'support': {
        // cut if attacked from any province other than the one the support is
        // directed into (by another power), or dislodged at all
        for (const [dest, moves] of movesTo) {
          if (dest !== o.origin) continue;
          for (const m of moves) {
            if (m.power === o.power) continue;
            if (m.origin === o.intoProv) {
              // only an actual dislodgement from the into-province cuts
              if (resolve(m.idx)) return FAILS;
            } else if (m.isConvoyMove) {
              if (path(m)) return FAILS;
            } else {
              return FAILS;
            }
          }
        }
        return SUCCEEDS;
      }
      case 'convoy':
      case 'hold': {
        // succeeds iff not dislodged
        for (const m of movesTo.get(o.origin) || []) {
          if (resolve(m.idx)) return FAILS;
        }
        return SUCCEEDS;
      }
    }
    throw new Error('unknown order kind');
  }

  // resolve everything
  all.forEach((o, i) => resolve(i));

  // -- outcomes --------------------------------------------------------------
  const unitsAfter = [];
  const dislodged = [];
  for (const u of units) {
    const p = prov(u.loc);
    const o = internal.get(p);
    const moved = o.effKind === 'move' && resolution[o.idx];
    // dislodged? a successful foreign move into p while this unit stays
    let attacker = null;
    if (!moved) {
      for (const m of movesTo.get(p) || []) {
        if (resolution[m.idx]) attacker = m;
      }
    }
    if (attacker) {
      dislodged.push({
        unit: u,
        from: u.loc,
        attackerOrigin: attacker.origin,
        attackerViaConvoy: !!attacker.isConvoyMove,
      });
    } else if (moved) {
      unitsAfter.push({ ...u, loc: o.destLoc });
    } else {
      unitsAfter.push(u);
    }
  }

  // standoffs: empty provinces where two or more valid moves bounced
  const occupiedAfter = new Set(unitsAfter.map((u) => prov(u.loc)));
  const standoffs = [];
  for (const [dest, moves] of movesTo) {
    if (occupiedAfter.has(dest)) continue;
    const bounced = moves.filter((m) => {
      if (resolution[m.idx]) return false;
      if (m.isConvoyMove && !path(m)) return false;
      const opp = headToHead(m);
      if (opp && resolution[opp.idx]) return false; // lost head-to-head
      return true;
    });
    if (bounced.length >= 2) standoffs.push(dest);
  }

  // retreat options
  const afterBoard = new Set(unitsAfter.map((u) => prov(u.loc)));
  for (const d of dislodged) {
    d.retreatOptions = computeRetreatOptions(d, afterBoard, standoffs);
  }

  const results = all.map((o) => ({
    order: o,
    verdict: o.illegal
      ? 'invalid'
      : resolution[o.idx]
        ? 'succeeds'
        : 'fails',
    reason: o.illegal || failureReason(o),
  }));

  function failureReason(o) {
    if (resolution[o.idx]) return null;
    if (o.effKind === 'move') {
      if (o.isConvoyMove && !path(o)) return 'convoy disrupted';
      return 'bounced';
    }
    if (o.effKind === 'support') {
      const attacked = (movesTo.get(o.origin) || []).some(
        (m) => m.power !== o.power
      );
      return attacked ? 'support cut' : 'failed';
    }
    return 'dislodged';
  }

  return {
    results,
    invalid,
    dislodged,
    standoffs,
    unitsAfter,
  };
}

// Legal retreat locations for a dislodged unit.
// occupiedProvs: Set of provinces occupied after movement; standoffs: array.
export function computeRetreatOptions(d, occupiedProvs, standoffs) {
  const opts = [];
  const cands =
    d.unit.type === 'A' ? ARMY_ADJ[prov(d.from)] || [] : FLEET_ADJ[d.from] || [];
  for (const c of cands) {
    const p = prov(c);
    if (occupiedProvs.has(p)) continue;
    if (standoffs.includes(p)) continue;
    if (p === d.attackerOrigin && !d.attackerViaConvoy) continue;
    opts.push(c);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Retreat adjudication
//
// dislodged: output of adjudicateMovement().dislodged
// unitsAfter: units on the board after movement
// orders: [{power, kind: 'retreat'|'disband', loc, dest?}]
// Returns {results, unitsAfter} — unitsAfter now includes surviving retreats.
// ---------------------------------------------------------------------------
export function adjudicateRetreats(dislodged, unitsAfter, orders) {
  const byProv = new Map(dislodged.map((d) => [prov(d.from), d]));
  const results = [];
  const attempts = new Map(); // dislodged entry -> destLoc or null (disband)

  for (const o of orders) {
    const d = byProv.get(prov(o.loc));
    if (!d || d.unit.power !== o.power) {
      results.push({ order: o, verdict: 'invalid', reason: 'no dislodged unit there' });
      continue;
    }
    if (o.kind === 'disband' || o.kind === 'hold') {
      attempts.set(d, null);
      results.push({ order: o, verdict: 'succeeds', reason: null, dislodgee: d });
      continue;
    }
    if (o.kind !== 'retreat' && o.kind !== 'move') {
      // any other order for a dislodged unit is invalid: it disbands
      attempts.set(d, null);
      results.push({ order: o, verdict: 'invalid', reason: 'not a retreat order', dislodgee: d });
      continue;
    }
    // retreat: destination must be a legal retreat option
    const destProv = prov(o.dest);
    let destLoc = null;
    if (d.unit.type === 'A') {
      if (d.retreatOptions.includes(destProv)) destLoc = destProv;
    } else {
      destLoc = d.retreatOptions.find(
        (l) => prov(l) === destProv && (o.dest.includes('/') ? l === o.dest : true)
      );
      // fleet retreat to split-coast province without coast: legal only if
      // unambiguous
      if (
        destLoc &&
        !o.dest.includes('/') &&
        d.retreatOptions.filter((l) => prov(l) === destProv).length > 1
      )
        destLoc = null;
    }
    const res = { order: o, verdict: 'pending', reason: null, dislodgee: d, destLoc };
    if (!destLoc) {
      res.verdict = 'fails';
      res.reason = 'illegal retreat';
      attempts.set(d, null);
    } else {
      attempts.set(d, destLoc);
    }
    results.push(res);
  }

  // units without orders disband
  for (const d of dislodged) if (!attempts.has(d)) attempts.set(d, null);

  // clashes: two retreats to the same province all disband
  const destCount = new Map();
  for (const dest of attempts.values()) {
    if (dest) destCount.set(prov(dest), (destCount.get(prov(dest)) || 0) + 1);
  }
  const after = [...unitsAfter];
  for (const [d, dest] of attempts) {
    const res = results.find((r) => r.dislodgee === d && r.verdict === 'pending');
    if (dest && destCount.get(prov(dest)) === 1) {
      after.push({ ...d.unit, loc: dest });
      if (res) res.verdict = 'succeeds';
    } else if (res) {
      res.verdict = 'fails';
      res.reason = dest ? 'retreat clash — disbanded' : res.reason;
    }
  }
  return { results, unitsAfter: after };
}

// ---------------------------------------------------------------------------
// Adjustment (winter) adjudication
//
// scOwners: {scProvince -> power|null}
// units:  current units
// orders: [{power, kind: 'build'|'remove'|'waive', unitType?, loc?}]
// Returns {results, unitsAfter, counts: {power -> builds(+)/disbands(-)}}
// ---------------------------------------------------------------------------
export function adjudicateAdjustments(scOwners, units, orders) {
  const unitCount = {};
  const scCount = {};
  for (const u of units) unitCount[u.power] = (unitCount[u.power] || 0) + 1;
  for (const owner of Object.values(scOwners))
    if (owner) scCount[owner] = (scCount[owner] || 0) + 1;

  const powers = new Set([...Object.keys(unitCount), ...Object.keys(scCount)]);
  const counts = {};
  for (const p of powers) counts[p] = (scCount[p] || 0) - (unitCount[p] || 0);

  const after = [...units];
  const occupied = new Set(units.map((u) => prov(u.loc)));
  const results = [];
  const done = {}; // power -> builds/removes performed

  for (const o of orders) {
    const res = { order: o, verdict: 'fails', reason: null };
    results.push(res);
    const allowance = counts[o.power] || 0;
    done[o.power] = done[o.power] || 0;
    if (o.kind === 'waive') {
      if (allowance > 0 && done[o.power] < allowance) {
        done[o.power]++;
        res.verdict = 'succeeds';
      } else res.reason = 'no build to waive';
      continue;
    }
    if (o.kind === 'build') {
      const p = prov(o.loc);
      if (allowance <= 0 || done[o.power] >= allowance) {
        res.reason = 'no builds available';
      } else if (!(HOME_CENTERS[o.power] || []).includes(p)) {
        res.reason = 'not a home supply center';
      } else if (scOwners[p] !== o.power) {
        res.reason = 'home center not owned';
      } else if (occupied.has(p)) {
        res.reason = 'province occupied';
      } else if (!buildLocOk(o.unitType, o.loc)) {
        res.reason = 'illegal unit type/coast for province';
      } else {
        after.push({ power: o.power, type: o.unitType, loc: buildLoc(o.unitType, o.loc) });
        occupied.add(p);
        done[o.power]++;
        res.verdict = 'succeeds';
      }
      continue;
    }
    if (o.kind === 'remove') {
      const p = prov(o.loc);
      const idx = after.findIndex((u) => prov(u.loc) === p && u.power === o.power);
      if (allowance >= 0) {
        res.reason = 'no removals required';
      } else if (done[o.power] <= allowance) {
        res.reason = 'already removed enough units';
      } else if (idx === -1) {
        res.reason = 'no such unit';
      } else {
        after.splice(idx, 1);
        occupied.delete(p);
        done[o.power]--;
        res.verdict = 'succeeds';
      }
    }
  }

  // forced disbands for powers that under-ordered (civil disorder rules:
  // farthest from home, fleets first, then alphabetical)
  for (const p of powers) {
    if ((counts[p] || 0) >= 0) continue;
    // done[p] is negative per performed removal
    let remaining = -(counts[p] || 0) + (done[p] || 0);
    while (remaining > 0) {
      const mine = after.filter((u) => u.power === p);
      if (!mine.length) break;
      mine.sort((a, b) => {
        const da = distanceFromHome(a, p);
        const db = distanceFromHome(b, p);
        if (da !== db) return db - da;
        if (a.type !== b.type) return a.type === 'F' ? -1 : 1;
        return prov(a.loc).localeCompare(prov(b.loc));
      });
      const victim = mine[0];
      after.splice(after.indexOf(victim), 1);
      remaining--;
      results.push({
        order: { power: p, kind: 'remove', loc: victim.loc, auto: true },
        verdict: 'succeeds',
        reason: 'civil disorder removal',
      });
    }
  }

  return { results, unitsAfter: after, counts };
}

function buildLocOk(unitType, loc) {
  const p = prov(loc);
  const info = PROVINCES[p];
  if (!info) return false;
  if (unitType === 'A') return info.type !== 'water';
  if (unitType !== 'F') return false;
  if (info.type !== 'coast') return false;
  if (info.coasts.length > 0) return loc.includes('/');
  return true;
}

function buildLoc(unitType, loc) {
  return unitType === 'A' ? prov(loc) : loc;
}

// BFS distance from a power's home centers (army+fleet adjacency union)
function distanceFromHome(unit, power) {
  const homes = new Set(HOME_CENTERS[power] || []);
  const start = prov(unit.loc);
  if (homes.has(start)) return 0;
  const seen = new Set([start]);
  let frontier = [start];
  let d = 0;
  while (frontier.length) {
    d++;
    const next = [];
    for (const p of frontier) {
      const neighbors = new Set([
        ...(ARMY_ADJ[p] || []),
        ...((FLEET_ADJ[p] || []).map(prov)),
      ]);
      for (const cs of PROVINCES[p].coasts || [])
        for (const l of FLEET_ADJ[`${p}/${cs}`] || []) neighbors.add(prov(l));
      for (const n of neighbors) {
        if (homes.has(n)) return d;
        if (!seen.has(n)) {
          seen.add(n);
          next.push(n);
        }
      }
    }
    frontier = next;
  }
  return 99;
}

// SC ownership update after Fall retreats: occupier takes the center
export function updateSupplyCenters(scOwners, units) {
  const owners = { ...scOwners };
  const at = new Map(units.map((u) => [prov(u.loc), u]));
  for (const sc of Object.keys(owners)) {
    const u = at.get(sc);
    if (u) owners[sc] = u.power;
  }
  return owners;
}
