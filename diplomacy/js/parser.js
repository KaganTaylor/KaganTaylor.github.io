// Text order parsing. Tolerant of the notation people actually type:
//   A Par - Bur / a par-bur / A Paris moves to Burgundy
//   F ENG S A Bre - Pic / F eng supports a bre to pic
//   F NTH C A Lon - Nwy / f nth convoys a lon-nwy
//   A Mar H / a mar holds
//   A Lon - Bel via convoy
//   Build F Stp/nc, Remove Par, Waive, Disband
// Locations are resolved through the alias table (full names, abbreviations,
// coast notations spa/sc, spa(sc), "spain (south coast)").

import { ALIASES, POWERS } from './map-data.js';

const UNIT_WORDS = { a: 'A', army: 'A', f: 'F', fleet: 'F' };
const MOVE_WORDS = new Set(['-', 'to', 'm', 'move', 'moves', 'r', 'retreat', 'retreats']);
const SUPPORT_WORDS = new Set(['s', 'support', 'supports']);
const CONVOY_WORDS = new Set(['c', 'convoy', 'convoys']);
const HOLD_WORDS = new Set(['h', 'hold', 'holds', 'stand', 'stands']);
const DISBAND_WORDS = new Set(['disband', 'disbands', 'destroy', 'destroys']);
const BUILD_WORDS = new Set(['build', 'builds', 'b']);
const REMOVE_WORDS = new Set(['remove', 'removes', 'd']);
const WAIVE_WORDS = new Set(['waive', 'waives', 'waived']);

export function normalizePower(word) {
  if (!word) return null;
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (POWERS.includes(w)) return w;
  // prefix match ("eng", "aus", and common typos still resolve)
  const hits = POWERS.filter((p) => p.startsWith(w.slice(0, 4)));
  return hits.length === 1 ? hits[0] : null;
}

function tokenize(line) {
  return line
    .toLowerCase()
    .replace(/\bvia\s+convoy\b/g, ' §via§ ')
    .replace(/->|—|–/g, '-')
    .replace(/\s*\)\s*/g, ') ')
    .replace(/-/g, ' - ')
    .split(/[\s,]+/)
    .filter(Boolean);
}

// Greedily match a location starting at tokens[i]; returns [loc, nextIndex]
// or null. Tries the longest span first so "north atlantic ocean" wins over
// province "north", and multi-word coast phrases ("spain (north coast)")
// win over the bare province name.
function matchLocation(tokens, i) {
  for (let span = Math.min(5, tokens.length - i); span >= 1; span--) {
    const candidate = tokens.slice(i, i + span).join(' ').replace(/\)$/, ')');
    const cleaned = candidate.replace(/[.]+$/, '');
    const compact = cleaned.replace(/\s*\(\s*/g, '(').replace(/\s*\)\s*/g, ')');
    for (const key of [candidate, cleaned, compact, compact.replace(/\((\w+)\)/, '/$1')]) {
      if (ALIASES[key]) return [ALIASES[key], i + span];
    }
  }
  return null;
}

// Parses one order line. `phase`: 'movement' | 'retreat' | 'adjustment'.
// `defaultPower`: used when the line has no "Power:" prefix.
// Returns {order} or {error}.
export function parseOrderLine(rawLine, phase, defaultPower) {
  let line = rawLine.split('#')[0].trim();
  if (!line) return null;

  // optional "Power:" prefix
  let power = defaultPower;
  const colon = line.indexOf(':');
  if (colon > 0) {
    const p = normalizePower(line.slice(0, colon));
    if (p) {
      power = p;
      line = line.slice(colon + 1).trim();
    }
  }
  if (!line) return null;
  if (!power) return { error: `no power specified: "${rawLine.trim()}"` };

  const tokens = tokenize(line);
  let i = 0;
  const err = (msg) => ({ error: `${msg}: "${rawLine.trim()}"` });

  // adjustment orders
  if (BUILD_WORDS.has(tokens[i]) || REMOVE_WORDS.has(tokens[i]) || WAIVE_WORDS.has(tokens[i])) {
    const word = tokens[i++];
    if (WAIVE_WORDS.has(word)) return { order: { power, kind: 'waive' } };
    let unitType = null;
    if (UNIT_WORDS[tokens[i]]) unitType = UNIT_WORDS[tokens[i++]];
    const m = matchLocation(tokens, i);
    if (!m) return err('cannot parse province');
    const [loc] = m;
    if (BUILD_WORDS.has(word)) {
      if (!unitType) return err('build needs a unit type (A/F)');
      return { order: { power, kind: 'build', unitType, loc } };
    }
    return { order: { power, kind: 'remove', loc } };
  }

  // unit type (optional)
  let unitType = null;
  if (UNIT_WORDS[tokens[i]] && !matchLocation(tokens, i)) unitType = UNIT_WORDS[tokens[i++]];

  const locM = matchLocation(tokens, i);
  if (!locM) return err('cannot parse unit location');
  const [loc, afterLoc] = locM;
  i = afterLoc;

  if (i >= tokens.length || HOLD_WORDS.has(tokens[i])) {
    return { order: { power, kind: 'hold', loc, unitType } };
  }
  if (DISBAND_WORDS.has(tokens[i])) {
    return { order: { power, kind: 'disband', loc, unitType } };
  }

  if (MOVE_WORDS.has(tokens[i])) {
    i++;
    const destM = matchLocation(tokens, i);
    if (!destM) return err('cannot parse destination');
    const [dest, afterDest] = destM;
    i = afterDest;
    const viaConvoy = tokens[i] === '§via§';
    const kind = phase === 'retreat' ? 'retreat' : 'move';
    return { order: { power, kind, loc, dest, viaConvoy, unitType } };
  }

  if (SUPPORT_WORDS.has(tokens[i]) || CONVOY_WORDS.has(tokens[i])) {
    const isConvoy = CONVOY_WORDS.has(tokens[i]);
    i++;
    if (UNIT_WORDS[tokens[i]] && !matchLocation(tokens, i)) i++; // target unit type
    const tM = matchLocation(tokens, i);
    if (!tM) return err('cannot parse supported/convoyed unit');
    const [tLoc, afterT] = tM;
    i = afterT;
    let tDest = null;
    if (i < tokens.length && MOVE_WORDS.has(tokens[i])) {
      i++;
      const dM = matchLocation(tokens, i);
      if (!dM) return err('cannot parse supported destination');
      tDest = dM[0];
      i = dM[1];
    } else if (i < tokens.length && HOLD_WORDS.has(tokens[i])) {
      i++;
    }
    if (isConvoy) {
      if (!tDest) return err('convoy needs a destination');
      return { order: { power, kind: 'convoy', loc, target: { loc: tLoc }, dest: tDest, unitType } };
    }
    return { order: { power, kind: 'support', loc, target: { loc: tLoc, dest: tDest }, unitType } };
  }

  return err('cannot parse order');
}

// Parses a whole block of text: lines are orders; a line that is just a power
// name ("FRANCE") sets the power for following lines.
export function parseOrders(text, phase) {
  const orders = [];
  const errors = [];
  let currentPower = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    if (line.split(/\s+/).length === 1) {
      const asPower = normalizePower(line.replace(/:$/, ''));
      if (asPower) {
        currentPower = asPower;
        continue;
      }
    }
    const res = parseOrderLine(raw, phase, currentPower);
    if (!res) continue;
    if (res.error) errors.push(res.error);
    else orders.push(res.order);
  }
  return { orders, errors };
}
