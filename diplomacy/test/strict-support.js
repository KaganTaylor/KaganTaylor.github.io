// Tests for the "strict support-hold" house rule (Game settings → Support
// house-rule). Under the rule a unit that is itself giving support cannot
// receive support-hold — "you cannot receive support while giving support" —
// so a supported supporter is easier to dislodge. Only hold support is
// affected; support for a move, and hold support to holding/convoying units,
// are unchanged. Each case is run BOTH ways to pin the difference down.
//
// Runs in the browser (strict.html) and under Node (`node test/strict-support.js`).

import { adjudicateMovement, prov } from '../js/adjudicator.js';
import { parseOrderLine } from '../js/parser.js';
import { ALIASES } from '../js/map-data.js';

// "FRANCE A Mar" / "GERMANY A Mun"
function parseUnit(line) {
  const m = line.trim().match(/^(\w+)\s+([AF])\s+(\S+)$/i);
  if (!m) throw new Error(`bad unit: "${line}"`);
  const power = m[1].toLowerCase();
  const raw = m[3].toLowerCase();
  return { power, type: m[2].toUpperCase(), loc: ALIASES[raw] || raw };
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

// A case: units, orders, and — for each mode — the expected surviving units and
// the expected dislodged units (given as "power A loc").
const CASES = [
  {
    id: 'supporter cannot be supported (strict) — dislodged',
    units: ['FRANCE A Mar', 'FRANCE A Bur', 'FRANCE A Pic', 'GERMANY A Mun', 'GERMANY A Ruh'],
    orders: [
      'FRANCE: A Mar - Gas',
      'FRANCE: A Bur S A Mar - Gas',  // Bur is a SUPPORTING unit
      'FRANCE: A Pic S A Bur',        // support-hold to the supporter
      'GERMANY: A Mun - Bur',
      'GERMANY: A Ruh S A Mun - Bur', // attack strength 2
    ],
    standard: {
      survivors: ['france A gas', 'france A bur', 'france A pic', 'germany A mun', 'germany A ruh'],
      dislodged: [],
    },
    strict: {
      // Pic's support-hold to Bur is void → Bur holds at strength 1, loses to 2
      survivors: ['france A gas', 'france A pic', 'germany A bur', 'germany A ruh'],
      dislodged: ['france A bur'],
    },
  },
  {
    id: 'hold support to a plain holding unit still counts (strict)',
    units: ['FRANCE A Bur', 'FRANCE A Pic', 'GERMANY A Mun', 'GERMANY A Ruh'],
    orders: [
      'FRANCE: A Bur H',
      'FRANCE: A Pic S A Bur',
      'GERMANY: A Mun - Bur',
      'GERMANY: A Ruh S A Mun - Bur',
    ],
    // identical both ways: Bur holds at strength 2 vs attack 2
    standard: {
      survivors: ['france A bur', 'france A pic', 'germany A mun', 'germany A ruh'],
      dislodged: [],
    },
    strict: {
      survivors: ['france A bur', 'france A pic', 'germany A mun', 'germany A ruh'],
      dislodged: [],
    },
  },
  {
    id: 'void/failed move cannot receive support-hold (strict) — dislodged',
    units: ['FRANCE A Bur', 'FRANCE A Pic', 'GERMANY A Mun', 'GERMANY A Ruh'],
    orders: [
      'FRANCE: A Bur - Lon',          // illegal (not adjacent, no convoy) → holds
      'FRANCE: A Pic S A Bur',        // support-hold to the would-be mover
      'GERMANY: A Mun - Bur',
      'GERMANY: A Ruh S A Mun - Bur', // attack strength 2
    ],
    standard: {
      // void move counts as a hold and takes Pic's support → holds, str 2 v 2
      survivors: ['france A bur', 'france A pic', 'germany A mun', 'germany A ruh'],
      dislodged: [],
    },
    strict: {
      // ordered to move → Pic's support-hold is void → Bur holds at strength 1
      survivors: ['france A pic', 'germany A bur', 'germany A ruh'],
      dislodged: ['france A bur'],
    },
  },
  {
    id: 'convoying fleet can still receive support-hold (strict)',
    units: [
      'ENGLAND F ENG', 'ENGLAND F IRI', 'ENGLAND A WAL',
      'FRANCE F MAO', 'FRANCE F NAO',
    ],
    orders: [
      'ENGLAND: F ENG C A Wal - Bre',
      'ENGLAND: A Wal - Bre',
      'ENGLAND: F IRI S F ENG',        // support-hold to the CONVOYING fleet
      'FRANCE: F MAO - ENG',
      'FRANCE: F NAO S F MAO - ENG',   // attack strength 2 on the convoyer
    ],
    // Both ways: convoy is not "support", so its support-hold counts → the
    // convoyer holds (strength 2 vs 2) and the army reaches Bre.
    standard: {
      survivors: ['england F eng', 'england F iri', 'england A bre', 'france F mao', 'france F nao'],
      dislodged: [],
    },
    strict: {
      survivors: ['england F eng', 'england F iri', 'england A bre', 'france F mao', 'france F nao'],
      dislodged: [],
    },
  },
];

export function runStrictTests() {
  const failures = [];
  let total = 0;
  for (const c of CASES) {
    const units = c.units.map(parseUnit);
    const orders = parseOrders(c.orders);
    for (const mode of ['standard', 'strict']) {
      total++;
      const out = adjudicateMovement(units, orders, { strictSupportHold: mode === 'strict' });
      const survivors = out.unitsAfter.map(key);
      const dislodged = out.dislodged.map((d) => key(d.unit));
      const exp = c[mode];
      const notes = [];
      if (!setEq(survivors, exp.survivors))
        notes.push(`survivors: got [${survivors.sort()}] want [${[...exp.survivors].sort()}]`);
      if (!setEq(dislodged, exp.dislodged))
        notes.push(`dislodged: got [${dislodged.sort()}] want [${[...exp.dislodged].sort()}]`);
      if (notes.length) failures.push({ id: `${c.id} [${mode}]`, notes });
    }
  }
  return { total, pass: total - failures.length, failures };
}

// Node entry point
if (typeof process !== 'undefined' && process.argv && process.argv[1] && process.argv[1].endsWith('strict-support.js')) {
  const { total, pass, failures } = runStrictTests();
  console.log(`strict support-hold: ${pass}/${total} passed`);
  for (const f of failures) {
    console.log(`FAIL ${f.id}`);
    for (const n of f.notes) console.log(`   ${n}`);
  }
  process.exit(failures.length ? 1 : 0);
}
