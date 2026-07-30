// Tests for the "strict convoy" house rule (Game settings → Convoy house-rule).
// Under the rule a convoyed army must name every sea it is carried through
// (e.g. "A Lon - NTH - Nwy"); the convoy succeeds only if each named sea holds
// a fleet ordered to convoy that exact move and none is dislodged — there is no
// automatic best-route search and no alternate route. A convoyed move with no
// named route is illegal and holds. Each case is run BOTH ways to pin the
// difference down; route notation is harmless under standard rules (the engine
// just ignores it and searches normally), so one order set serves both modes.
//
// Runs in the browser (strict.html) and under Node (`node test/strict-convoy.js`).

import { adjudicateMovement } from '../js/adjudicator.js';
import { parseOrderLine } from '../js/parser.js';
import { ALIASES } from '../js/map-data.js';

function parseUnit(line) {
  const m = line.trim().match(/^(\w+)\s+([AF])\s+(\S+)$/i);
  if (!m) throw new Error(`bad unit: "${line}"`);
  return { power: m[1].toLowerCase(), type: m[2].toUpperCase(), loc: ALIASES[m[3].toLowerCase()] || m[3].toLowerCase() };
}

function parseOrders(lines) {
  return lines.map((l) => {
    const r = parseOrderLine(l, 'movement', null);
    if (!r || r.error) throw new Error(r ? r.error : `unparsed: ${l}`);
    return r.order;
  });
}

const key = (u) => `${u.power} ${u.type} ${u.loc}`;
const setEq = (a, b) => {
  const A = new Set(a), B = new Set(b);
  return A.size === B.size && [...A].every((x) => B.has(x));
};

const CASES = [
  {
    id: 'named single-sea route with a convoying fleet — reaches (both)',
    units: ['ENGLAND A Lon', 'ENGLAND F NTH'],
    orders: ['ENGLAND: A Lon - NTH - Nwy', 'ENGLAND: F NTH C A Lon - Nwy'],
    standard: { survivors: ['england A nwy', 'england F nth'] },
    strict: { survivors: ['england A nwy', 'england F nth'] },
  },
  {
    id: 'no route named — standard convoys, strict holds (route required)',
    units: ['ENGLAND A Lon', 'ENGLAND F NTH'],
    orders: ['ENGLAND: A Lon - Nwy', 'ENGLAND: F NTH C A Lon - Nwy'],
    standard: { survivors: ['england A nwy', 'england F nth'] },
    strict: { survivors: ['england A lon', 'england F nth'] },
  },
  {
    id: 'alternate route exists but is not the named one — standard convoys, strict holds',
    units: ['ENGLAND A Lon', 'ENGLAND F NTH', 'ENGLAND F ENG'],
    orders: [
      'ENGLAND: A Lon - NTH - Bel', // names NTH...
      'ENGLAND: F NTH H',           // ...but NTH is not convoying
      'ENGLAND: F ENG C A Lon - Bel', // a different route is available
    ],
    standard: { survivors: ['england A bel', 'england F nth', 'england F eng'] },
    strict: { survivors: ['england A lon', 'england F nth', 'england F eng'] },
  },
  {
    id: 'named two-sea route with both fleets convoying — reaches (both)',
    units: ['ENGLAND A Lon', 'ENGLAND F NTH', 'ENGLAND F SKA'],
    orders: [
      'ENGLAND: A Lon - NTH - SKA - Swe',
      'ENGLAND: F NTH C A Lon - Swe',
      'ENGLAND: F SKA C A Lon - Swe',
    ],
    standard: { survivors: ['england A swe', 'england F nth', 'england F ska'] },
    strict: { survivors: ['england A swe', 'england F nth', 'england F ska'] },
  },
  {
    id: 'named two-sea route missing the second convoy — fails both ways',
    units: ['ENGLAND A Lon', 'ENGLAND F NTH'],
    orders: ['ENGLAND: A Lon - NTH - SKA - Swe', 'ENGLAND: F NTH C A Lon - Swe'],
    standard: { survivors: ['england A lon', 'england F nth'] },
    strict: { survivors: ['england A lon', 'england F nth'] },
  },
];

export function runStrictConvoyTests() {
  const failures = [];
  let total = 0;
  for (const c of CASES) {
    const units = c.units.map(parseUnit);
    const orders = parseOrders(c.orders);
    for (const mode of ['standard', 'strict']) {
      total++;
      const out = adjudicateMovement(units, orders, { strictConvoy: mode === 'strict' });
      const survivors = out.unitsAfter.map(key);
      const exp = c[mode];
      if (!setEq(survivors, exp.survivors))
        failures.push({
          id: `${c.id} [${mode}]`,
          notes: [`survivors: got [${survivors.sort()}] want [${[...exp.survivors].sort()}]`],
        });
    }
  }
  return { total, pass: total - failures.length, failures };
}

if (typeof process !== 'undefined' && process.argv && process.argv[1] && process.argv[1].endsWith('strict-convoy.js')) {
  const { total, pass, failures } = runStrictConvoyTests();
  console.log(`strict convoy: ${pass}/${total} passed`);
  for (const f of failures) {
    console.log(`FAIL ${f.id}`);
    for (const n of f.notes) console.log(`   ${n}`);
  }
  process.exit(failures.length ? 1 : 0);
}
