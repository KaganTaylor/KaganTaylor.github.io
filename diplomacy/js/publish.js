// Publishing games via GitHub Gists — the only "backend" available to a
// static site. A gist holding game.json is readable by anyone with no auth;
// only the publisher (who holds a personal access token, kept in this
// browser's localStorage) can update it.

import { seal, unseal, aadFor, newSealKey } from './seal.js';

// The wire format itself — markers, payload, which comment counts — lives in
// its own module because tools/publish-moves.js reads the same comments with
// no browser around it. Re-exported here so every existing importer of
// publish.js is unaffected.
import {
  ORDERS_MARKER, MAILBOX_BODY, SEAL_FILE, markerOf, parseSubmission,
  submissionBody, findSubmission, findMyMailbox, upsertMovesEntry,
  movesFileName, extractGistId,
} from './submission-format.js';

export {
  ORDERS_MARKER, MAILBOX_BODY, SEAL_FILE, markerOf, parseSubmission,
  submissionBody, findSubmission, findMyMailbox, upsertMovesEntry,
  movesFileName, extractGistId,
};

const TOKEN_KEY = 'diplomacysim:ghtoken';
const API = 'https://api.github.com';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function setToken(t) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

function stripForPublish(game) {
  // viewer-local fields only — `players` (power → GitHub login) stays in,
  // it is shared state every viewer needs to know their assignment.
  // publishedState is the game master's own bookkeeping of what's already
  // live (see js/app.js boardDirty()) — never itself part of the position.
  // provisionalPhase and playAs are likewise strictly per-browser: the first
  // marks an optimistic local resolve awaiting the game master's real one
  // (app.js resolveRevealedLocally), the second is which hat this browser is
  // wearing. Publishing either hands every viewer a flag about someone else's
  // session — and an inherited provisionalPhase is actively harmful, since
  // syncViewerToGist() treats it as "I am deliberately ahead of the gist" and
  // stops reconciling (it reached the gist once; see DECISIONS.md).
  const {
    gistId, gistUrl, published, isOwner, myCountry, assignedPower, publishedState,
    branchedFrom, sandbox, provisionalPhase, playAs,
    ...rest
  } = game;
  return rest;
}

// GitHub stamps every response with a `Date` header from its own servers —
// a trustworthy wall clock no client can tamper with. We cache the most
// recent one so callers can gate deadline decisions on server time rather
// than the local (spoofable) device clock. See app.js trustedNow().
let lastServerDate = null;
export function getLastServerDate() {
  return lastServerDate;
}

async function ghFetch(url, opts) {
  const res = await fetch(url, opts);
  const d = res.headers.get('Date');
  if (d) lastServerDate = d;
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).message || msg; } catch { /* ignore */ }
    throw new Error(`${res.status} ${msg}`);
  }
  return res.json();
}

// A public read, signed with the stored token when this browser happens to
// have one. Everything read here is public either way — the point is purely
// GitHub's rate limit: anonymous requests get 60/hr shared across everyone
// on the same IP, authenticated ones get 5,000/hr per user. A household or
// office of players shares one anonymous budget and quietly runs dry (and
// refreshOnlineStatus() swallows the failure, leaving a stale board), while
// almost every player already holds a token because submitting requires one.
// Signing costs nothing and must change nothing: a bad, revoked or
// wrong-scope token falls straight back to the anonymous request that would
// have worked anyway, so a spectator with no token — and a player with a
// broken one — always keeps reading.
//
// Never served from the browser's HTTP cache. GitHub stamps every API read
// `Cache-Control: max-age=60`, so by default the browser answers the next
// minute of polls out of its own memory without touching the network — and
// that includes the read taken immediately after this browser wrote something.
// It has already cost us twice: submitOrders() listed the comments, got back a
// snapshot from before its own mailbox existed, concluded it had none and
// POSTed a fresh comment containing the player's orders, which GitHub then
// emailed to the whole table; and refreshOnlineStatus() re-read a just-edited
// submission, saw the old body, and left the UI insisting the orders had not
// been resubmitted. Both look like intermittent bugs because they only occur
// inside the 60-second window. Freshness here is a correctness requirement.
//
// Authenticated reads come back `private`, so this browser's cache is the only
// one holding them: `no-store` skips it outright, and a token buys 5,000
// requests/hour to spend on that. Anonymous reads are `public` and may also sit
// in a shared cache we cannot reach, so they are best-effort regardless — there
// `no-cache` at least forces revalidation, while keeping the 304s that GitHub
// does not charge against the much tighter 60/hour anonymous budget.
async function ghRead(url) {
  const token = getToken();
  if (!token) return ghFetch(url, { cache: 'no-cache' });
  try {
    return await ghFetch(url, {
      cache: 'no-store',
      headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json' },
    });
  } catch (e) {
    if (/\b(401|403)\b/.test(e.message)) return ghFetch(url, { cache: 'no-cache' });
    throw e;
  }
}

// Creates a new public gist holding the game. Returns {id, url}.
export async function publishGame(game) {
  const token = getToken();
  if (!token) throw new Error('no GitHub token set');
  const json = await ghFetch(`${API}/gists`, {
    method: 'POST',
    headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json' },
    body: JSON.stringify({
      description: `Diplomacy Simulator — ${game.name}`,
      public: true,
      files: { 'game.json': { content: JSON.stringify(stripForPublish(game), null, 1) } },
    }),
  });
  return { id: json.id, url: json.html_url };
}

// Overwrites an already-published gist with the game's current state. Pass
// `boardOverride` (a board-only snapshot, see state.js boardSnapshot()) to
// push settings only — deadline, publish mode, player assignments — without
// also leaking the game master's in-progress, not-yet-published position.
export async function updatePublished(game, boardOverride) {
  const token = getToken();
  if (!token) throw new Error('no GitHub token set');
  const payload = boardOverride ? { ...stripForPublish(game), ...boardOverride } : stripForPublish(game);
  await ghFetch(`${API}/gists/${game.gistId}`, {
    method: 'PATCH',
    headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json' },
    body: JSON.stringify({
      files: { 'game.json': { content: JSON.stringify(payload, null, 1) } },
    }),
  });
}

// Reads a published game by gist id. No auth needed — gists are public — but
// signed when a token is around, for the rate limit (see ghRead).
// Returns {game, ownerLogin} so callers can tell whether their own token
// belongs to the account that published it.
export async function fetchPublished(gistId) {
  const json = await ghRead(`${API}/gists/${gistId}`);
  const file = json.files && json.files['game.json'];
  if (!file) throw new Error('gist has no game.json file');
  const content = file.truncated ? await (await fetch(file.raw_url)).text() : file.content;
  return { game: JSON.parse(content), ownerLogin: json.owner && json.owner.login };
}

// Resolves the GitHub login a token belongs to, so it can be compared
// against a gist's owner — any browser holding the publisher's token
// should be recognized as able to publish, not just the one that first
// created the gist. Cached per-token since it's called on every load.
let cachedToken = null;
let cachedLogin = null;
export async function getAuthenticatedLogin(token) {
  if (!token) return null;
  if (token === cachedToken) return cachedLogin;
  try {
    const json = await ghFetch(`${API}/user`, {
      headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json' },
    });
    cachedToken = token;
    cachedLogin = json.login;
    return cachedLogin;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Online move submission.
//
// Players cannot write files into the GM's gist (gists have no collaborators),
// so each player instead maintains ONE gist comment — their "mailbox" — posted
// with their own token and edited in place on every submit. Comments are
// separate API objects, so simultaneous submissions from different players can
// never conflict; GitHub stamps each comment with the author's login (identity)
// and updated_at (late-edit detection), so a submission cannot be forged or
// quietly changed after the deadline. Once the deadline passes the game
// either reveals the comments to everyone directly (auto publish) or waits
// for the GM to review and copy them into per-power files —
// moves-<power>.json — written with the GM's token, the files' only writer.
//
// A mailbox is CREATED EMPTY and only ever edited, because GitHub emails the
// body of every newly created gist comment to everyone subscribed to the gist
// — the whole table — and does not notify on edits. Creating a comment that
// already held orders mailed those orders to the player's opponents. Nothing
// here may ever POST order text; see DECISIONS.md.
//
// That asymmetry is necessary but NOT sufficient: GitHub renders a
// notification's body when its mailer runs, not when the comment is created,
// so a comment created empty and edited moments later can still be mailed out
// holding the orders. Order text is therefore also sealed (js/seal.js) — the
// only thing that makes a leak harmless whenever it happens.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The shared seal key, kept in the gist itself (see js/seal.js for why that is
// deliberate). Any viewer can read it, so decryption needs no coordination and
// the unattended Action can still publish moves.
// ---------------------------------------------------------------------------

// The gist's seal key, or null if this game has none (older games, or a gist
// whose owner hasn't opened it since sealing shipped).
export async function readSealKey(gistJson) {
  try {
    const content = await gistFileContent((gistJson.files || {})[SEAL_FILE]);
    const doc = content ? JSON.parse(content) : null;
    return doc && typeof doc.key === 'string' ? doc.key : null;
  } catch {
    return null;
  }
}

// Owner-only: writes a seal key into the gist if it has none, and returns the
// key either way. A named-files PATCH leaves every other file alone, the same
// mechanism writeMovesFiles relies on.
export async function ensureSealKey(gistId, gistJson) {
  const existing = await readSealKey(gistJson);
  if (existing) return existing;
  const token = getToken();
  if (!token) return null;
  const key = newSealKey();
  await ghFetch(`${API}/gists/${gistId}`, {
    method: 'PATCH',
    headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json' },
    body: JSON.stringify({
      files: {
        [SEAL_FILE]: {
          content: JSON.stringify({
            v: 1,
            alg: 'AES-GCM',
            key,
            note:
              'Shared key for this game\'s order comments. Public on purpose: it stops orders ' +
              'being readable by accident (in notification emails, or by glancing at this gist), ' +
              'not by anyone determined to decrypt them.',
          }, null, 1),
        },
      },
    }),
  });
  return key;
}

// Reads every comment on the gist. Public data — no auth needed, signed when
// available (see ghRead). This is the heaviest read: one call per 100 comments.
export async function listComments(gistId) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await ghRead(`${API}/gists/${gistId}/comments?per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

// Decrypt once, at the edge. Every sealed comment in a freshly fetched list is
// replaced by an equivalent CLEARTEXT one — same id, author and timestamps,
// only the body rewritten — so the whole app downstream (parseSubmission,
// findSubmission, phaseSubmission, powerOnlineStatus, revealedEntry,
// gmLoadOrders, autoPublishIfDue) keeps working on plain synchronous strings
// and knows nothing about sealing. That is what keeps sealing a small change.
//
// A comment that won't open (no key, wrong key, tampered blob, replayed into
// another phase) is left exactly as it is: it still parses as a submission,
// just one with no readable orders, which reads as "submitted" in the UI and
// is skipped rather than silently treated as empty when publishing.
export async function unsealComments(comments, sealKey, gistId) {
  if (!sealKey) return comments;
  return Promise.all(comments.map(async (c) => {
    const sub = parseSubmission(c.body);
    if (!sub || typeof sub.sealed !== 'string') return c;
    const orders = await unseal(sealKey, sub.sealed, aadFor(gistId, sub));
    if (orders === null) return c;
    const { sealed, ...rest } = sub;
    return { ...c, body: submissionBody({ ...rest, orders }) };
  }));
}

// ---------------------------------------------------------------------------
// Which comment is mine, remembered locally.
//
// This is what makes a resubmit a guaranteed edit. Knowing the id outright,
// submitOrders never has to ask GitHub "do I have a comment yet?" — and that
// question is the dangerous one, because a stale or lagging answer of "no"
// makes it create a comment full of orders and mail them to the table. A cache
// bypass (see ghRead) closes the common case; not needing to ask closes it
// outright. Purely a cache of something GitHub already knows, so clearing it,
// or opening the game in another browser, costs one extra list and nothing else.
// ---------------------------------------------------------------------------

const mailboxKey = (gistId, login) => `diplomacysim:mailbox:${gistId}:${(login || '').toLowerCase()}`;

function rememberedMailbox(gistId, login) {
  try { return localStorage.getItem(mailboxKey(gistId, login)) || null; } catch { return null; }
}

export function rememberMailbox(gistId, login, id) {
  try { localStorage.setItem(mailboxKey(gistId, login), String(id)); } catch { /* private mode */ }
}

function forgetMailbox(gistId, login) {
  try { localStorage.removeItem(mailboxKey(gistId, login)); } catch { /* private mode */ }
}

// Posts an empty mailbox and returns GitHub's copy of the new comment.
//
// It creates unconditionally — it never decides WHETHER one is needed. That
// judgement belongs to the single caller that holds a freshly fetched comment
// list (ensureMyMailbox in app.js), because deciding it from a remembered id
// is exactly how a deleted mailbox went unnoticed and the submit path ended up
// creating a comment one second before filling it with orders.
export async function createMailbox(gistId, login) {
  const token = getToken();
  if (!token) throw new Error('no GitHub token set');
  const json = await ghFetch(`${API}/gists/${gistId}/comments`, {
    method: 'POST',
    headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json' },
    body: JSON.stringify({ body: MAILBOX_BODY }),
  });
  rememberMailbox(gistId, login, json.id);
  return json;
}

// The fallback when a player reaches Submit with no mailbox at all — creation
// at game load failed, or their comment was deleted since. Rare, and not worth
// making the player press the button twice for.
//
// ONE POST, NOT TWO. Posting an empty comment and editing it a moment later
// looks safer and isn't. GitHub's notification mail is a queue — worker pools
// draining a backlog, minutes at the ninetieth percentile during their own
// February 2025 incident — and the body is composed when the job RUNS, not
// when the comment is created: that is why a comment created at 20:40:39 and
// edited at 20:40:40 was mailed out complete with the orders. An empty POST
// followed immediately by a PATCH is a bet that a worker fires inside that one
// second. It almost never does, and the bet costs a request.
//
// What actually protects the orders is that they are sealed: the mail carries
// ciphertext whenever it is composed. The mailbox created at game load matters
// for the same reason in reverse — minutes-to-days beats the queue easily,
// where seconds do not. See DECISIONS.md.
//
// UNSEALED (a game whose GM has not opened it since sealing shipped, so the
// gist has no key): never POST readable order text. Here the empty-then-edit
// split IS the only thing on offer, sliver of a chance though it is, so this
// path keeps it. The status line tells the player their orders went out
// unencrypted; the real fix is the GM opening the game once so a key exists.
async function createSubmission(gistId, login, body, sealed) {
  const token = getToken();
  const headers = { Authorization: `token ${token}`, Accept: 'application/vnd.github+json' };
  const url = `${API}/gists/${gistId}/comments`;
  if (sealed) {
    const json = await ghFetch(url, { method: 'POST', headers, body: JSON.stringify({ body }) });
    rememberMailbox(gistId, login, json.id);
    return json;
  }
  const json = await ghFetch(url, { method: 'POST', headers, body: JSON.stringify({ body: MAILBOX_BODY }) });
  rememberMailbox(gistId, login, json.id);
  return patchComment(gistId, json.id, body);
}

function patchComment(gistId, commentId, body) {
  return ghFetch(`${API}/gists/${gistId}/comments/${commentId}`, {
    method: 'PATCH',
    headers: { Authorization: `token ${getToken()}`, Accept: 'application/vnd.github+json' },
    body: JSON.stringify({ body }),
  });
}

// Writes the caller's orders into their mailbox. `payload` carries
// {power, year, season, step, orders}; submittedAt is stamped here, and the
// order text is sealed under `sealKey` before it goes anywhere near GitHub.
// Returns {login, submission, comment, sealed} — `submission` is the CLEARTEXT
// payload, and `comment` GitHub's own copy of the edited comment with its body
// swapped back to that cleartext form, so the caller can fold it straight into
// its cached list and have the UI update from the write rather than a later
// poll (see rememberWrite in app.js).
//
// Normally this only ever EDITS: the mailbox was created empty when the player
// opened the game, so GitHub's one notification went out long before there were
// orders to leak. If somehow there is no mailbox, this posts the submission
// itself rather than bouncing the player back to press the button again —
// see createSubmission() for why that is now the safe way round.
export async function submitOrders(gistId, payload, sealKey) {
  const token = getToken();
  if (!token) throw new Error('no GitHub token set');
  const login = await getAuthenticatedLogin(token);
  if (!login) throw new Error('token was not accepted by GitHub');
  const submission = { ...payload, submittedAt: new Date().toISOString() };
  // No key on this gist (an older game, or the GM hasn't reopened it since
  // sealing shipped) — write cleartext rather than refusing to play. The UI
  // says so outright; a silent downgrade would be worse than none.
  let wire = submission;
  if (sealKey) {
    const { orders, ...rest } = submission;
    wire = { ...rest, sealed: await seal(sealKey, orders, aadFor(gistId, submission)) };
  }
  const body = submissionBody(wire);
  const plain = submissionBody(submission);

  // Fast path: our comment id is already known, so this is a single PATCH with
  // no read in front of it — nothing that can go stale, nothing that can decide
  // to create a comment.
  const remembered = rememberedMailbox(gistId, login);
  if (remembered) {
    try {
      const c = await patchComment(gistId, remembered, body);
      return { login, submission, comment: { ...c, body: plain }, sealed: !!sealKey };
    } catch (e) {
      // Only a 404 (the comment was deleted) may fall through to the slow path.
      // Auth failures, rate limits and network errors must surface as failures:
      // retrying them down a route that reads and re-decides is how a stale
      // answer turns into a second comment.
      if (!/\b404\b/.test(e.message)) throw e;
      forgetMailbox(gistId, login);
    }
  }
  const mailbox = findMyMailbox(await listComments(gistId), login);
  if (!mailbox) {
    const created = await createSubmission(gistId, login, body, !!sealKey);
    return { login, submission, comment: { ...created, body: plain }, sealed: !!sealKey };
  }
  rememberMailbox(gistId, login, mailbox.id);
  const c = await patchComment(gistId, mailbox.id, body);
  return { login, submission, comment: { ...c, body: plain }, sealed: !!sealKey };
}

// Full gist JSON (files + metadata). Public — no auth needed, signed when
// available (see ghRead).
export function fetchGist(gistId) {
  return ghRead(`${API}/gists/${gistId}`);
}

// The truncated-file fallback stays a plain anonymous fetch on purpose:
// raw.githubusercontent.com is not the REST API, so it neither accepts the
// token nor draws on the rate limit ghRead() exists to protect.
async function gistFileContent(file) {
  if (!file) return null;
  return file.truncated ? await (await fetch(file.raw_url)).text() : file.content;
}

// Extracts every moves-<power>.json from a fetched gist.
// Returns { france: {power, history: [...]}, ... } (malformed files skipped).
export async function readMovesFiles(gistJson) {
  const out = {};
  for (const [name, file] of Object.entries(gistJson.files || {})) {
    const m = name.match(/^moves-([a-z]+)\.json$/);
    if (!m) continue;
    try {
      const doc = JSON.parse(await gistFileContent(file));
      if (doc && Array.isArray(doc.history)) out[m[1]] = doc;
    } catch { /* ignore a malformed file */ }
  }
  return out;
}

// The (fresh) game.json out of a fetched gist, or null.
export async function readGameFile(gistJson) {
  try {
    const content = await gistFileContent((gistJson.files || {})['game.json']);
    return content ? JSON.parse(content) : null;
  } catch {
    return null;
  }
}

// Writes the given per-power documents into the gist (owner token only).
// `byPower` is { france: movesDoc, ... }; other gist files are untouched.
export async function writeMovesFiles(gistId, byPower) {
  const token = getToken();
  if (!token) throw new Error('no GitHub token set');
  const files = {};
  for (const [power, doc] of Object.entries(byPower)) {
    files[movesFileName(power)] = { content: JSON.stringify(doc, null, 1) };
  }
  await ghFetch(`${API}/gists/${gistId}`, {
    method: 'PATCH',
    headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json' },
    body: JSON.stringify({ files }),
  });
}
