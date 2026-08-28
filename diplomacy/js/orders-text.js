// The order text, as text.
//
// "Order text is the one source of truth" is the app's central invariant (see
// DECISIONS.md): dragging a unit does not create an order object, it rewrites a
// line in the order box, which is then re-parsed and re-adjudicated. There is
// exactly one representation of a turn's orders and it is the text a player
// could paste into an email.
//
// Everything in this module is that text arriving and leaving as a string. No
// DOM, no textarea, no `game` mutation — the UI reads the box, calls in here,
// and writes the result back. That is what makes the awkward parts (header
// tracking, the visible/hidden split for the power you are playing, inserting a
// line into the right section) checkable without a browser.

import { POWERS } from './map-data.js';
import { prov } from './adjudicator.js';
import { normalizePower, parseOrderLine } from './parser.js';
import { adjustmentCounts } from './state.js';

// A line that is a bare power name — "FRANCE", "France:" — and so a heading
// rather than an order. One word, because every real order has at least two.
function headingPower(line) {
  const stripped = line.split('#')[0].trim();
  if (!stripped || stripped.split(/\s+/).length !== 1) return null;
  return normalizePower(stripped.replace(/:$/, ''));
}

// Split a multi-power orders text into per-power blocks (header line plus
// the lines under it), same header-tracking rule locateOrderLine uses.
export function splitOrdersByPower(text) {
  const byPower = new Map();
  let current = null;
  for (const line of text.split('\n')) {
    const p = headingPower(line);
    if (p) {
      current = p;
      if (!byPower.has(p)) byPower.set(p, []);
      byPower.get(p).push(line);
      continue;
    }
    if (current) byPower.get(current).push(line);
  }
  return byPower;
}

// One power's order lines with its heading dropped, or '' if it has no block.
export function blockBody(byPower, power) {
  const block = byPower.get(power);
  return block ? block.slice(1).join('\n').trim() : '';
}

// The heading-plus-orders shape every "load these moves into the box" path
// builds — a GM loading submissions, a spectator loading reveals, a player
// reloading their own record, an auto-publish gathering the table's orders.
export function orderBlock(power, ordersText) {
  return power.toUpperCase() + '\n' + ordersText.trim() + '\n';
}

// Everything drafted, split by whether it belongs in the visible textarea or
// the hidden buffer. A viewer playing one country still drags opponents'
// units to sketch out what they might do; those lines are kept in the same
// line format, just never rendered into the box. `myCountry` empty = show all.
export function splitForFilter(fullText, myCountry) {
  const byPower = splitOrdersByPower(fullText);
  const visible = [];
  const hidden = [];
  for (const p of POWERS) {
    if (!byPower.has(p)) continue;
    const block = byPower.get(p).join('\n');
    if (!myCountry || p === myCountry) visible.push(block);
    else hidden.push(block);
  }
  return { visible: visible.join('\n'), hidden: hidden.join('\n') };
}

// Swaps in a new block for one power, leaving every other power's draft as it
// is (used to restore a player's submitted orders from the gist).
export function replaceBlock(fullText, power, ordersText) {
  const byPower = splitOrdersByPower(fullText);
  byPower.set(power, [power.toUpperCase(), ...ordersText.split('\n'), '']);
  const blocks = [];
  for (const p of POWERS) if (byPower.has(p)) blocks.push(byPower.get(p).join('\n'));
  return blocks.join('\n');
}

// `source` wins where it has a block, `fallback` fills the rest — how a
// preserved buffer keeps every power's drawn orders while a country nobody has
// ordered for yet still gets the blank per-phase template.
export function mergeBlocks(sourceByPower, fallbackByPower) {
  const merged = [];
  for (const p of POWERS) {
    if (sourceByPower.has(p)) merged.push(sourceByPower.get(p).join('\n'));
    else if (fallbackByPower.has(p)) merged.push(fallbackByPower.get(p).join('\n'));
  }
  return merged.join('\n');
}

// Every power's default (empty) order block for the given phase — used
// both for a fresh phase and to fill in powers a preserved buffer has no
// block for yet (a country nobody has drawn orders for yet).
export function defaultOrdersText(game) {
  const lines = [];
  if (game.step === 'movement') {
    for (const p of POWERS) {
      if (game.units.some((u) => u.power === p)) lines.push(p.toUpperCase(), '');
    }
  } else if (game.step === 'retreat') {
    for (const d of game.pending.dislodged) {
      lines.push(d.unit.power.toUpperCase());
      lines.push(`${d.unit.type} ${prov(d.from)} disband   # options: ${d.retreatOptions.join(', ') || 'none'}`);
      lines.push('');
    }
  } else {
    const counts = adjustmentCounts(game);
    for (const [p, c] of Object.entries(counts)) {
      if (c > 0) lines.push(p.toUpperCase(), `# ${c} build${c > 1 ? 's' : ''}`, '');
      else if (c < 0) lines.push(p.toUpperCase(), `# disband ${-c}`, '');
    }
  }
  return lines.join('\n');
}

// Order text reduced to what the game actually cares about, so "have I changed
// my orders since I submitted them?" ignores comments, spacing and case.
export function normalizeOrders(text) {
  return (text || '')
    .split('\n')
    .map((l) => l.split('#')[0].trim().toLowerCase().replace(/\s+/g, ' '))
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------
// writing one unit's order line (what every drag, click and coast pick does)
// ---------------------------------------------------------------------------

export function unitToken(u) {
  return `${u.type} ${u.type === 'F' ? u.loc : prov(u.loc)}`;
}

export function orderTextFor(u, spec) {
  switch (spec.kind) {
    case 'hold': return `${unitToken(u)} H`;
    case 'move': {
      const route = spec.route && spec.route.length ? spec.route.join(' - ') + ' - ' : '';
      return `${unitToken(u)} - ${route}${spec.dest}${spec.via ? ' via convoy' : ''}`;
    }
    case 'retreat': return `${unitToken(u)} - ${spec.dest}`;
    case 'disband': return `${unitToken(u)} disband`;
    case 'support':
      return `${unitToken(u)} S ${spec.targetType} ${spec.targetLoc}` +
        (spec.targetDest ? ` - ${spec.targetDest}` : '');
    case 'convoy': return `${unitToken(u)} C A ${spec.targetLoc} - ${spec.dest}`;
  }
}

// Scan `sourceText` for the line holding `power`'s order for the unit in
// `unitProv`. Returns {lines, foundIdx, headerIdx, lastOfSection} — the
// caller needs all four to know where to insert when there is no line yet.
export function locateOrderLine(power, unitProv, sourceText, phase) {
  const lines = sourceText.split('\n');
  let current = null;
  let headerIdx = -1, lastOfSection = -1, foundIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].split('#')[0].trim()) continue;
    const p = headingPower(lines[i]);
    if (p) {
      current = p;
      if (p === power) {
        headerIdx = i;
        lastOfSection = i;
      }
      continue;
    }
    const res = parseOrderLine(lines[i], phase, current);
    if (res && res.order) {
      if (res.order.power === power) {
        lastOfSection = i;
        if (res.order.loc && prov(res.order.loc) === unitProv) foundIdx = i;
      }
    }
  }
  return { lines, foundIdx, headerIdx, lastOfSection };
}

// `sourceText` with the unit's order line replaced by `newText`, or removed
// when `newText` is null. A power with no section yet gets one appended.
// Returns the new text; the caller decides which buffer it belongs in.
export function setOrderLine(sourceText, power, unitProv, newText, phase) {
  const { lines, foundIdx, headerIdx, lastOfSection } =
    locateOrderLine(power, unitProv, sourceText, phase);
  if (foundIdx >= 0) {
    if (newText === null) lines.splice(foundIdx, 1);
    else lines[foundIdx] = newText;
  } else if (newText !== null) {
    if (headerIdx >= 0) lines.splice(lastOfSection + 1, 0, newText);
    else lines.push('', power.toUpperCase(), newText);
  }
  return lines.join('\n');
}

// Where a line sits in the text, as a [start, end] character range — what the
// textarea needs to select it when a unit is clicked.
export function lineRange(lines, idx) {
  let start = 0;
  for (let i = 0; i < idx; i++) start += lines[i].length + 1;
  return [start, start + lines[idx].length];
}
