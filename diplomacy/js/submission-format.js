// The gist-comment wire format: how a submission is written, recognised, and
// chosen when a login holds more than one.
//
// Split out of js/publish.js because it has TWO readers — the browser app and
// the unattended Action in tools/publish-moves.js — and they must agree
// exactly. They used to agree by being written twice and DECISIONS.md asking
// them to stay in sync; the rules below are subtle enough (a marker matched as
// a whole line, a mailbox that must not parse as a submission, last-edited
// wins, updated_at never backstopped with created_at) that "asking" was not a
// mechanism. Now there is one copy and one test suite over it.
//
// Pure string and object handling: no fetch, no token, no localStorage — which
// is what lets Node import it as-is.

// ---------------------------------------------------------------------------
// markers
// ---------------------------------------------------------------------------

export const ORDERS_MARKER = 'DIPLOMACY-ORDERS';

// LEGACY v1 — remove once the current game ends.
// Comments written before orders were sealed. Still recognised so that game's
// mailboxes are edited rather than duplicated and its submissions still read;
// nothing writes this marker any more.
const LEGACY_MARKER_V1 = 'DIPLOMACY-ORDERS v1';

// The marker line a comment carries, or null if it is not one of ours. Matched
// as a whole first line, never as a prefix — 'DIPLOMACY-ORDERS v1' starts with
// 'DIPLOMACY-ORDERS' and must not be mistaken for it.
export function markerOf(body) {
  const line = (body || '').split('\n', 1)[0].trim();
  if (line === ORDERS_MARKER) return ORDERS_MARKER;
  if (line === LEGACY_MARKER_V1) return LEGACY_MARKER_V1; // LEGACY v1 — remove once the current game ends
  return null;
}

// The body a mailbox is created with. It deliberately starts with the marker
// (so findMyMailbox recognises it) but omits power/year/season/step (so
// parseSubmission rejects it and it is never mistaken for a submission). It is
// also the one notification the table ever receives about a player, so it
// explains itself.
export const MAILBOX_BODY =
  ORDERS_MARKER + '\n' +
  JSON.stringify({
    mailbox: true,
    note: 'Orders mailbox — edited in place each phase. Edits send no notifications.',
  }, null, 1);

// The file the shared seal key lives in, inside the game's own gist.
export const SEAL_FILE = 'seal-key.json';

export function movesFileName(power) {
  return `moves-${power}.json`;
}

// ---------------------------------------------------------------------------
// the payload
// ---------------------------------------------------------------------------

// A submission comment is the marker line followed by a JSON payload:
//   DIPLOMACY-ORDERS
//   {"power":"france","year":1901,"season":"spring","step":"movement","sealed":"..."}
// Returns the payload, or null if the body is not a well-formed submission.
//
// The phase metadata stays cleartext: renderSubmitStatus, findSubmission and
// the deadline gate all need it, and it gives away nothing GitHub's own comment
// listing doesn't already publish. Only the order text is sealed.
//
// `orders` (cleartext) is accepted alongside `sealed` — that is what LEGACY v1
// comments carry, what a game with no seal key falls back to, and what
// unsealComments() rewrites a sealed body into so everything downstream stays
// synchronous.
export function parseSubmission(body) {
  const marker = markerOf(body);
  if (!marker) return null;
  try {
    const sub = JSON.parse(body.slice(marker.length));
    if (!sub || !sub.power || !sub.year || !sub.season || !sub.step) return null;
    if (typeof sub.orders !== 'string' && typeof sub.sealed !== 'string') return null;
    return sub;
  } catch {
    return null;
  }
}

export function submissionBody(sub) {
  return ORDERS_MARKER + '\n' + JSON.stringify(sub, null, 1);
}

// ---------------------------------------------------------------------------
// choosing between a login's comments
// ---------------------------------------------------------------------------

const mine = (c, login) => !!c.user && c.user.login.toLowerCase() === login.toLowerCase();

// Ordering for "which of my comments is the current one". created_at is a
// legitimate tie-breaker HERE — this only ranks comments against each other,
// and never leaves as a submission time (see findSubmission).
const editedAt = (c) => Date.parse(c.updated_at || c.created_at || 0) || 0;

// The later of two comments: last edited wins, and on a tie the higher id,
// since GitHub hands them out in creation order.
function laterOf(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (editedAt(a) !== editedAt(b)) return editedAt(b) > editedAt(a) ? b : a;
  return Number(b.id) > Number(a.id) ? b : a;
}

// The submission comment a given GitHub account holds on this gist.
// Returns {commentId, submission, updatedAt} or null — updatedAt is GitHub's
// own edit stamp, the arbiter of whether a submission beat the deadline.
//
// If a login somehow holds SEVERAL parseable submissions, the most recently
// edited one wins rather than the first encountered (comments arrive
// oldest-first). Duplicates should no longer arise — submitOrders only ever
// edits one comment — but they exist on games played before that was true, and
// picking the older comment would be wrong twice over: it shows the player's
// superseded orders, and it lets someone submit on time, edit a duplicate after
// the deadline, and still be judged by the stamp that suits them.
//
// updated_at is NOT backstopped with created_at: a mailbox is created when the
// player first opens the game, so created_at can predate the submission by
// days, and treating it as a submission time would wave a late edit through as
// on time. An absent updated_at means "unknown", which submissionOnTime()
// resolves in the player's favour deliberately rather than by accident.
export function findSubmission(comments, login) {
  if (!login) return null;
  let best = null;
  for (const c of comments) {
    if (mine(c, login) && parseSubmission(c.body)) best = laterOf(best, c);
  }
  if (!best) return null;
  return { commentId: best.id, submission: parseSubmission(best.body), updatedAt: best.updated_at || null };
}

// The caller's mailbox comment, whatever its body currently holds — a real
// submission, or the empty placeholder it was created as. A comment must carry
// the marker to qualify, so an ordinary chat comment on the gist is never
// overwritten. A real submission wins over a bare placeholder, so a player
// holding both always gets the submission patched; among equals the most
// recently edited wins, exactly as in findSubmission — the two MUST agree, or a
// resubmit would edit one comment while the UI went on reading another.
//
// Returns the comment object, not just the id: the caller deciding whether to
// create one is looking at server truth and may want the rest of it.
export function findMyMailbox(comments, login) {
  if (!login) return null;
  let submission = null;
  let placeholder = null;
  for (const c of comments) {
    if (!mine(c, login) || !markerOf(c.body)) continue;
    if (parseSubmission(c.body)) submission = laterOf(submission, c);
    else placeholder = laterOf(placeholder, c);
  }
  return submission || placeholder || null;
}

// ---------------------------------------------------------------------------
// the published per-power record
// ---------------------------------------------------------------------------

// Replaces any existing entry for the entry's phase, then appends — each
// power's file keeps one entry per year/season/step, newest last.
export function upsertMovesEntry(doc, power, entry) {
  const out = doc && Array.isArray(doc.history) ? doc : { power, history: [] };
  out.power = power;
  out.history = out.history.filter(
    (h) => !(h.year === entry.year && h.season === entry.season && h.step === entry.step)
  );
  out.history.push(entry);
  return out;
}

// Does a submission or published entry belong to the given phase?
export const samePhase = (phase, s) =>
  !!s && s.year === phase.year && s.season === phase.season && s.step === phase.step;

// ---------------------------------------------------------------------------
// gist links
// ---------------------------------------------------------------------------

// Accepts a bare gist id or a full gist URL and returns the id, or null.
export function extractGistId(s) {
  s = (s || '').trim();
  const urlMatch = s.match(/gist\.github\.com\/[^/]+\/([0-9a-f]+)/i);
  if (urlMatch) return urlMatch[1];
  if (/^[0-9a-f]{16,}$/i.test(s)) return s;
  return null;
}
