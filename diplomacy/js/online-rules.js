// Deadlines and submissions: the rules that decide who may submit, whose
// orders are on time, what everyone is allowed to see, and which phase a
// deadline belongs to.
//
// These are the highest-stakes decisions in the app and the ones with the
// worst incident history — a Spring 1901 deadline outliving its own phase and
// auto-publishing an all-hold Fall 1901 nobody had ordered in; a comment edited
// after the deadline being judged by whichever timestamp suited it. DECISIONS.md
// records why each guard exists ("A deadline belongs to a phase, not to a
// clock", "Deadlines are confirmed, not scheduled").
//
// Every function takes the state it reads — `game` and the fetched `online`
// snapshot ({comments, moves, login, serverOffset, sealKey}) — rather than
// reaching for a module global, so the whole rule set can be exercised against
// a hand-built phase without a browser, a gist or a clock.

import { POWERS } from './map-data.js';
import { findSubmission } from './submission-format.js';
import { orderBlock } from './orders-text.js';

// ---------------------------------------------------------------------------
// the phase on the table
// ---------------------------------------------------------------------------

// Does a submission/published entry belong to the phase on the table now?
export function matchesPhase(game, s) {
  return !!s && s.year === game.year && s.season === game.season && s.step === game.step;
}

// The phase itself, as the stamp written onto a deadline or an authorization.
export function currentPhase(game) {
  return { year: game.year, season: game.season, step: game.step };
}

export function activePowers(game) {
  return POWERS.filter(
    (p) => game.units.some((u) => u.power === p) || Object.values(game.scOwners).includes(p)
  );
}

// Has the game master assigned anyone at all? The gate on every piece of
// online-play UI — with no players there is nothing to be waiting for.
export function hasAssignedPlayers(game) {
  return !!(game && game.published && game.players && Object.values(game.players).some(Boolean));
}

// How the deadline is handled — the GM picks this in ⚙ Settings.
// 'manual' (default): after the deadline only the GM sees submissions, until
// they review and 📣 Publish results (or re-open with a new deadline).
// 'auto': the moment the deadline passes, every viewer reveals all
// submissions straight from the comments — no publish step needed.
export function publishMode(game) {
  return game && game.publishMode === 'auto' ? 'auto' : 'manual';
}

// ---------------------------------------------------------------------------
// the clock
// ---------------------------------------------------------------------------

// Trusted wall clock: the local device time corrected by the offset to
// GitHub's server `Date` header (captured on every gist read). A player can
// spoof Date.now() to peek at auto-mode orders early; they cannot spoof
// GitHub's server clock. Falls back to the raw local clock until the first
// server date is seen (offline/first paint) — the safe direction, since a
// player with no network simply can't reveal yet.
//
// EVERY deadline comparison in the app goes through this, display included.
// The countdown chip and the submit gate reading two different clocks is how
// the page ends up saying "orders open" over a closed one.
export function trustedNow(online) {
  return Date.now() + ((online && online.serverOffset) || 0);
}

export function deadlineDate(game) {
  if (!game || !game.deadline) return null;
  const d = new Date(game.deadline);
  return isNaN(d) ? null : d;
}

export function deadlinePassed(game, online) {
  const d = deadlineDate(game);
  return !!d && d.getTime() <= trustedNow(online);
}

// 'none' (no deadline set), 'warn' (counting down) or 'danger' (passed) — the
// single source of truth behind every red/yellow deadline indicator: the
// topbar countdown chip, the sidebar #panel-deadline box, and the Orders
// panel's #deadline-info hint.
export function deadlineUrgency(game, online) {
  const d = deadlineDate(game);
  if (!d) return 'none';
  return deadlinePassed(game, online) ? 'danger' : 'warn';
}

// A deadline is confirmed for one specific phase (game.deadlineFor, stamped by
// setDeadline) — "orders for Spring 1901 are due at 11pm", never a bare
// timestamp floating free of what it was due for. Once the board moves on, the
// old timestamp is stale and must not gate anything again.
//
// This exists because it didn't, once. A game master playing their own power
// (🎭 Play as) used the player-side ▶ Resolve new orders! button, which
// advances the board optimistically and — correctly, for a player — neither
// clears the deadline nor writes anything. autoPublishIfDue() then woke up,
// saw only "deadline in the past", and published the NEXT phase, for which
// nobody had submitted anything, as an all-hold. Asking "in the past?" without
// also asking "for this phase?" lets one expired deadline consume every phase
// it is carried into.
//
// Deliberately lenient about a missing stamp: games published before this
// existed carry a deadline and no deadlineFor, and must keep resolving. The
// guards in autoPublishIfDue() cover that case from the other side.
export function deadlineIsForCurrentPhase(game) {
  if (!game || !game.deadline) return false;
  if (!game.deadlineFor) return true;
  return matchesPhase(game, game.deadlineFor);
}

// ---------------------------------------------------------------------------
// who may submit
// ---------------------------------------------------------------------------

// Orders can only be submitted while a deadline is set and hasn't passed yet
// — with no deadline at all there is nothing to be "on time" against.
export function ordersOpen(game, online) {
  return !!game.deadline && !deadlinePassed(game, online);
}

// Has the game master specifically authorized `p` to (re)submit after the
// deadline for the phase on the table right now? Keyed to the exact phase
// so an authorization never silently carries over once the game moves on.
export function lateResubmitAllowed(game, p) {
  const m = game.lateResubmit && game.lateResubmit[p];
  return !!(m && matchesPhase(game, m));
}

// Whether `p` may (re)submit at all: the normal deadline window, or a GM's
// explicit late-resubmit authorization for this exact phase.
export function isSubmitAllowed(game, online, p) {
  return ordersOpen(game, online) || lateResubmitAllowed(game, p);
}

// In auto mode a comment edited after the deadline is void — judged by
// GitHub's own updated_at stamp, never the client-claimed submittedAt.
// An absent stamp means "unknown", resolved in the player's favour here
// deliberately rather than by silently falling back to created_at.
export function submissionOnTime(game, found) {
  const d = deadlineDate(game);
  return !d || !found.updatedAt || new Date(found.updatedAt) <= d;
}

// ---------------------------------------------------------------------------
// what is known, and what may be seen
// ---------------------------------------------------------------------------

// Submissions reach us sealed and are decrypted in refreshOnlineStatus, so by
// the time anything here looks at one it holds cleartext `orders`. One that
// still doesn't (no key on this browser, or a blob that won't open) is treated
// as no submission at all — visibly "waiting", rather than quietly resolved or
// published as a power that ordered nothing.
export const readable = (s) => !!s && typeof s.orders === 'string';

// The power's valid submission comment for the current phase, or null.
export function phaseSubmission(game, online, p) {
  const login = (game.players || {})[p];
  const found = login && online.comments && findSubmission(online.comments, login);
  if (found && readable(found.submission) && matchesPhase(game, found.submission) &&
      found.submission.power === p) return found;
  return null;
}

// My own submission comment for the current phase, or null — the "currently
// published" record a player's box is compared against and can reload from.
export function mySubmission(game, online, myPower) {
  if (!myPower) return null;
  const found = online.comments && online.login && findSubmission(online.comments, online.login);
  const s = found && found.submission;
  return readable(s) && matchesPhase(game, s) && s.power === myPower ? s : null;
}

// What everyone may see for a power this phase: its published file entry, or
// — in auto mode once the deadline has passed — the on-time submission
// comment itself (the files are then just a durable record).
export function revealedEntry(game, online, p) {
  const doc = online.moves && online.moves[p];
  const entry = doc && doc.history.find((h) => matchesPhase(game, h));
  if (entry) return entry;
  if (publishMode(game) !== 'auto' || !deadlinePassed(game, online)) return null;
  const found = phaseSubmission(game, online, p);
  return found && submissionOnTime(game, found) ? found.submission : null;
}

// What the current phase knows about a power: 'published' (its moves file has
// an entry for this phase), 'revealed'/'late' (auto mode, deadline passed),
// 'submitted' (a valid comment is waiting), 'none', or 'unknown' (comments
// not fetched yet / offline).
export function powerOnlineStatus(game, online, p) {
  const doc = online.moves && online.moves[p];
  if (doc && doc.history.some((h) => matchesPhase(game, h))) return 'published';
  if (!online.comments) return 'unknown';
  const found = phaseSubmission(game, online, p);
  if (found) {
    if (publishMode(game) === 'auto' && deadlinePassed(game, online))
      return submissionOnTime(game, found) ? 'revealed' : 'late';
    return 'submitted';
  }
  return 'none';
}

// Gathers the phase's orders into one multi-power text — the single loop
// behind every "load the table's moves" path, which previously existed four
// times over with subtly different sources:
//
//   'ontime'   the on-time submission comments. What is actually resolved and
//              published, by the GM's auto-publish and by a player's optimistic
//              local resolve. Late edits are excluded.
//   'revealed' whatever a viewer is allowed to see — published file entries,
//              plus (auto mode, past deadline) the on-time comments. What
//              ⬇ Load submitted moves fills a spectator's box with.
//   'gm'       every submission the GM can see, on time or not, with a blank
//              per-phase template for the powers that did not submit, so the
//              box always shows the full roster to fill in by hand.
//
// `blanks` supplies that template, as power -> lines (see splitOrdersByPower).
export function gatherPhaseBlocks(game, online, source, blanks = null) {
  const blocks = [];
  let submitted = 0;
  for (const p of activePowers(game)) {
    let orders = null;
    if (source === 'revealed') {
      const entry = revealedEntry(game, online, p);
      orders = entry && entry.orders;
    } else {
      const found = phaseSubmission(game, online, p);
      const ok = found && (source === 'gm' || submissionOnTime(game, found));
      orders = ok ? found.submission.orders : null;
    }
    if (orders && orders.trim()) {
      blocks.push(orderBlock(p, orders));
      submitted++;
    } else if (blanks && blanks.has(p)) {
      blocks.push(blanks.get(p).join('\n'));
    }
  }
  return { text: blocks.join('\n'), submitted };
}

// ---------------------------------------------------------------------------
// chaining the next deadline
// ---------------------------------------------------------------------------

// The quick-set steps count from the deadline this one FOLLOWS — the live one,
// or the last one that was cleared (clearDeadline) — never from the moment of
// the click. Press +1 week on Sunday afternoon and a midnight-Saturday deadline
// still lands on the following midnight Saturday. Only a game that has never
// had a deadline at all starts from the clock.
export function deadlineChainBase(game) {
  const d = deadlineDate(game);
  if (d) return d.getTime();
  const last = game && game.lastDeadline && new Date(game.lastDeadline);
  return last && !isNaN(last) ? last.getTime() : null;
}

// Why a step is unavailable, or null when it isn't. A step is unavailable when
// chaining it off the previous deadline lands in the past — pressing +24 h two
// days late must not quietly confirm a deadline that has already expired.
// Read twice: by the UI to grey the button, and by the press itself to refuse.
export function bumpUnavailableReason(game, online, hours, label, fmtWhen) {
  const base = deadlineChainBase(game);
  if (base === null) return null; // no previous deadline: counts from now, always valid
  const next = base + hours * 3600000;
  if (next > trustedNow(online)) return null;
  return `${label} from the previous deadline (${fmtWhen(base)}) is ${fmtWhen(next)} — already past. ` +
    'Use a longer step, or pick a date and time below.';
}

// What a step would set, given the chain base (or the clock, first time).
export function bumpTarget(game, online, hours) {
  const base = deadlineChainBase(game);
  return (base === null ? trustedNow(online) : base) + hours * 3600000;
}

// ---------------------------------------------------------------------------
// a viewer's board against the gist
// ---------------------------------------------------------------------------

// The published position as a viewer should see it. Deliberately NOT
// state.js's boardSnapshot(): that includes redoStack, which is the game
// master's private undo bookkeeping. A viewer who catches up clears their own
// (catchUpNext) while the gist may still carry the GM's, and that difference
// is not a divergence — comparing it would reload the board on every refresh.
export function viewerPosition(g) {
  return JSON.stringify({
    year: g.year,
    season: g.season,
    step: g.step,
    units: g.units,
    scOwners: g.scOwners,
    pending: g.pending || null,
    history: g.history || [],
  });
}

// True when the gist is simply further along the same road: every phase we
// have seen is still there, unchanged, with more on the end.
export function extendsOurHistory(g, fresh) {
  const ours = g.history || [];
  if (fresh.history.length <= ours.length) return false;
  return JSON.stringify(fresh.history.slice(0, ours.length)) === JSON.stringify(ours);
}
