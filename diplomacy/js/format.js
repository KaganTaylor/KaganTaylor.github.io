// Turning game data into the strings a person reads — order lines, province
// names, countdowns, dates. Pure, so the same functions serve the sidebar, the
// playback list, 📋 Copy results and the home screen, and can be tested without
// a DOM. Nothing here decides anything; it only says what is already true.

import { PROVINCES } from './map-data.js';
import { prov } from './adjudicator.js';

export const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// coast-suffix labels for the hover tooltip on split-coast provinces
// (Spain, St Petersburg, Bulgaria)
export const COAST_NAMES = { nc: 'North coast', sc: 'South coast', ec: 'East coast' };

// One real-world flag per power, standing in for its country everywhere a
// player's identity is shown (Play as picker, topbar mode chip, home-screen
// game list). Austria and Turkey have no country of that exact name/borders
// today, so these use the closest modern flag rather than a historical one.
export const POWER_FLAGS = {
  england: '🇬🇧', france: '🇫🇷', germany: '🇩🇪', italy: '🇮🇹',
  austria: '🇦🇹', russia: '🇷🇺', turkey: '🇹🇷',
};

export function provName(p) {
  return PROVINCES[prov(p)] ? PROVINCES[prov(p)].name : p;
}

export function fmtLoc(l) {
  const c = l.includes('/') ? `(${l.split('/')[1]})` : '';
  return provName(l) + c;
}

export function fmtOrder(o) {
  const t = o.unitType ? o.unitType + ' ' : '';
  const u = `${t}${fmtLoc(o.loc || '')}`;
  switch (o.kind) {
    case 'move': return `${u} → ${fmtLoc(o.dest)}${o.isConvoyMove ? ' ⚓' : ''}`;
    case 'retreat': return `${u} retreats → ${fmtLoc(o.dest)}`;
    case 'hold': return `${u} holds`;
    case 'disband': return `${u} disbands`;
    case 'support':
      return o.target.dest
        ? `${u} S ${fmtLoc(o.target.loc)} → ${fmtLoc(o.target.dest)}`
        : `${u} S ${fmtLoc(o.target.loc)} (hold)`;
    case 'convoy': return `${u} C ${fmtLoc(o.target.loc)} → ${fmtLoc(o.dest)}`;
    case 'build': return `build ${o.unitType} ${fmtLoc(o.loc)}`;
    case 'remove': return `remove ${fmtLoc(o.loc)}`;
    case 'waive': return `waive build`;
  }
  return '?';
}

// ---------------------------------------------------------------------------
// time
// ---------------------------------------------------------------------------

// Loose "how long is left" — "3d 4h", "2h 15m", "45m". Used where the number
// is read once, in passing: the home-screen rows and the deadline hint.
export function fmtCountdown(ms) {
  const mins = Math.max(0, Math.round(ms / 60000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// Zero-padded DD:HH:MM:SS — always four segments, unlike the looser
// fmtCountdown() above, so the topbar chip has a fixed width and reads at a
// glance regardless of how much time is left.
export function fmtCountdownDHMS(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const pad = (n) => String(n).padStart(2, '0');
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${pad(d)}:${pad(h)}:${pad(m)}:${pad(s)}`;
}

// "Sat 13 Sep, 00:00" — the date a deadline step would actually set, which is
// what makes "+1 week" confirmable at a glance.
export const fmtWhen = (ms) =>
  new Date(ms).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// datetime-local wants local wall-clock time, not ISO/UTC
export function isoToLocalInput(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
