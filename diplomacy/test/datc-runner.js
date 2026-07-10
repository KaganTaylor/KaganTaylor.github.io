// DATC test runner: parses tools/datc_v2.4_06.txt (godip's machine-readable
// copy of the Diplomacy Adjudicator Test Cases) and runs every case through
// the engine. Retreat cases additionally re-run the preceding movement phase
// reconstructed from PRESTATE_RESULTS and check it against the annotations.

import {
  adjudicateMovement,
  adjudicateRetreats,
  adjudicateAdjustments,
  computeRetreatOptions,
  prov,
} from '../js/adjudicator.js';
import { parseOrderLine, normalizePower } from '../js/parser.js';
import { ALIASES, ARMY_ADJ } from '../js/map-data.js';

// ---------------------------------------------------------------------------
// DATC file parsing
// ---------------------------------------------------------------------------
export function parseDatcFile(text) {
  const cases = [];
  let cur = null;
  let section = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split('#')[0].trimEnd();
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('VARIANT_ALL')) continue;
    if (t.startsWith('CASE')) {
      cur = {
        id: t.slice(4).trim(),
        phase: 'movement',
        prestate: [],
        dislodged: [],
        results: [],
        scOwners: [],
        orders: [],
        poststate: [],
        postDislodged: [],
        poststateSame: false,
      };
      cases.push(cur);
      section = null;
      continue;
    }
    if (!cur) continue;
    if (t === 'END') {
      cur = null;
      section = null;
      continue;
    }
    if (t.startsWith('PRESTATE_SETPHASE')) {
      const m = t.match(/,\s*(\w+)\s*$/);
      cur.phase = m ? m[1].toLowerCase() : 'movement';
      if (cur.phase === 'adjustment') cur.phase = 'adjustment';
      continue;
    }
    if (t === 'PRESTATE') { section = 'prestate'; continue; }
    if (t === 'PRESTATE_DISLODGED') { section = 'dislodged'; continue; }
    if (t === 'PRESTATE_RESULTS') { section = 'results'; continue; }
    if (t === 'PRESTATE_SUPPLYCENTER_OWNERS') { section = 'scOwners'; continue; }
    if (t === 'ORDERS') { section = 'orders'; continue; }
    if (t === 'POSTSTATE') { section = 'poststate'; continue; }
    if (t === 'POSTSTATE_DISLODGED') { section = 'postDislodged'; continue; }
    if (t === 'POSTSTATE_SAME') { cur.poststateSame = true; section = null; continue; }
    if (section) cur[section].push(t);
  }
  return cases;
}

// "England: F nth" -> unit
function parseUnitLine(line) {
  // "England: F nth" (colon occasionally missing in the file)
  const m0 = line.match(/^(\w+):?\s+(.*)$/);
  const power = normalizePower(m0 ? m0[1] : '');
  const rest = m0 ? m0[2].trim() : '';
  const m = rest.match(/^([AF])\s+(\S+)$/i);
  if (!power || !m) throw new Error(`bad unit line: "${line}"`);
  const raw = m[2].toLowerCase();
  return { power, type: m[1].toUpperCase(), loc: ALIASES[raw] || raw };
}

// "SUCCESS: England: F nth H" -> {expected, order, unit}
function parseResultLine(line) {
  const m = line.match(/^(SUCCESS|FAILURE):\s*(.*)$/);
  const rest = m ? m[2] : line;
  const parsed = parseOrderLine(rest, 'movement', null);
  if (!parsed || parsed.error) throw new Error(parsed ? parsed.error : `bad result line: ${line}`);
  const o = parsed.order;
  if (!o.unitType) throw new Error(`result line missing unit type: ${line}`);
  return {
    expected: m ? m[1] === 'SUCCESS' : null,
    order: o,
    unit: { power: o.power, type: o.unitType, loc: o.loc },
  };
}

const unitKey = (u) => `${u.power} ${u.type} ${u.loc}`;

function diffUnits(expected, actual) {
  const e = new Set(expected.map(unitKey));
  const a = new Set(actual.map(unitKey));
  const missing = [...e].filter((k) => !a.has(k));
  const extra = [...a].filter((k) => !e.has(k));
  return { ok: missing.length === 0 && extra.length === 0, missing, extra };
}

// ---------------------------------------------------------------------------
// Running one case
// ---------------------------------------------------------------------------
export function runCase(c) {
  const notes = [];
  try {
    if (c.phase === 'movement') {
      const units = c.prestate.map(parseUnitLine);
      const orders = c.orders.map((l) => {
        const r = parseOrderLine(l, 'movement', null);
        if (!r || r.error) throw new Error(r ? r.error : `unparsed: ${l}`);
        return r.order;
      });
      const out = adjudicateMovement(units, orders);
      const survivors = out.unitsAfter;
      const expectedUnits = c.poststateSame ? units : c.poststate.map(parseUnitLine);
      const d1 = diffUnits(expectedUnits, survivors);
      const expectedDisl = c.postDislodged.map(parseUnitLine);
      // file convention: dislodged units with no legal retreat are destroyed
      // and not listed in POSTSTATE_DISLODGED
      const d2 = diffUnits(
        expectedDisl,
        out.dislodged
          .filter((d) => d.retreatOptions.length > 0)
          .map((d) => ({ ...d.unit, loc: d.from }))
      );
      if (!d1.ok) notes.push(`units: missing [${d1.missing}] extra [${d1.extra}]`);
      if (!d2.ok) notes.push(`dislodged: missing [${d2.missing}] extra [${d2.extra}]`);
      return { pass: notes.length === 0, notes };
    }

    if (c.phase === 'retreat') {
      // Build retreat inputs from the file's own annotations (as godip does):
      // PRESTATE is the post-movement board, PRESTATE_RESULTS tells us who
      // attacked where and which provinces bounced.
      const results = c.results.map(parseResultLine);
      const unitsAfter = c.prestate.map(parseUnitLine);
      const occupied = new Set(unitsAfter.map((u) => prov(u.loc)));

      const successMoveInto = new Map(); // province -> order
      const failedMovesInto = new Map(); // province -> count
      for (const r of results) {
        if (r.order.kind !== 'move') continue;
        const dp = prov(r.order.dest);
        if (r.expected) successMoveInto.set(dp, r.order);
        else failedMovesInto.set(dp, (failedMovesInto.get(dp) || 0) + 1);
      }
      // dislodged units: from PRESTATE_DISLODGED, or derived from results
      // (a non-moving/failed unit whose province was successfully entered)
      let dislodgedUnits;
      if (c.dislodged.length) {
        dislodgedUnits = c.dislodged.map(parseUnitLine);
      } else {
        dislodgedUnits = results
          .filter(
            (r) =>
              (r.order.kind !== 'move' || !r.expected) &&
              successMoveInto.has(prov(r.order.loc))
          )
          .map((r) => r.unit);
      }
      // two or more bounced moves into an empty province = standoff
      const standoffs = [...failedMovesInto.entries()]
        .filter(([p, n]) => n >= 2 && !occupied.has(p) && !dislodgedUnits.some((u) => prov(u.loc) === p))
        .map(([p]) => p);
      const dislodged = dislodgedUnits.map((u) => {
        const attack = successMoveInto.get(prov(u.loc));
        const viaConvoy =
          !!attack &&
          (attack.viaConvoy ||
            (attack.unitType === 'A' &&
              !(ARMY_ADJ[prov(attack.loc)] || []).includes(prov(attack.dest))));
        const d = {
          unit: u,
          from: u.loc,
          attackerOrigin: attack ? prov(attack.loc) : null,
          attackerViaConvoy: viaConvoy,
        };
        d.retreatOptions = computeRetreatOptions(d, occupied, standoffs);
        return d;
      });

      const orders = c.orders.map((l) => {
        const r = parseOrderLine(l, 'retreat', null);
        if (!r || r.error) throw new Error(r ? r.error : `unparsed: ${l}`);
        return r.order;
      });
      const out = adjudicateRetreats(dislodged, unitsAfter, orders);
      const d = diffUnits(c.poststate.map(parseUnitLine), out.unitsAfter);
      if (!d.ok) notes.push(`units: missing [${d.missing}] extra [${d.extra}]`);
      return { pass: notes.length === 0, notes };
    }

    if (c.phase === 'adjustment') {
      const units = c.prestate.map(parseUnitLine);
      const scOwners = {};
      for (const line of c.scOwners) {
        const u = parseUnitLine(line);
        scOwners[prov(u.loc)] = u.power;
      }
      const orders = c.orders.map((l) => {
        const r = parseOrderLine(l, 'adjustment', null);
        if (!r || r.error) throw new Error(r ? r.error : `unparsed: ${l}`);
        return r.order;
      });
      const out = adjudicateAdjustments(scOwners, units, orders);
      const d = diffUnits(c.poststate.map(parseUnitLine), out.unitsAfter);
      if (!d.ok) notes.push(`units: missing [${d.missing}] extra [${d.extra}]`);
      return { pass: notes.length === 0, notes };
    }

    return { pass: false, notes: [`unknown phase ${c.phase}`] };
  } catch (e) {
    return { pass: false, notes: [`ERROR: ${e.message}`] };
  }
}

export async function runAll() {
  const text = await (await fetch('../tools/datc_v2.4_06.txt')).text();
  const cases = parseDatcFile(text);
  const bySection = {};
  const failures = [];
  for (const c of cases) {
    const section = (c.id.match(/^6\.[A-Z]/) || ['other'])[0];
    bySection[section] = bySection[section] || { pass: 0, total: 0 };
    bySection[section].total++;
    const r = runCase(c);
    if (r.pass) bySection[section].pass++;
    else failures.push({ id: c.id, phase: c.phase, notes: r.notes });
  }
  const totalPass = Object.values(bySection).reduce((s, x) => s + x.pass, 0);
  const total = cases.length;
  return { bySection, failures, totalPass, total };
}
