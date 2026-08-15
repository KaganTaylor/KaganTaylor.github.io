// Publishing games via GitHub Gists — the only "backend" available to a
// static site. A gist holding game.json is readable by anyone with no auth;
// only the publisher (who holds a personal access token, kept in this
// browser's localStorage) can update it.

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
  const {
    gistId, gistUrl, published, isOwner, myCountry, assignedPower, publishedState,
    branchedFrom, sandbox,
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
// ---------------------------------------------------------------------------

export const ORDERS_MARKER = 'DIPLOMACY-ORDERS v1';

// The body a mailbox is created with. It deliberately starts with the marker
// (so findMyComment recognises it) but omits power/year/season/step (so
// parseSubmission rejects it and it is never mistaken for a submission). It is
// also the one notification the table ever receives about a player, so it
// explains itself.
export const MAILBOX_BODY =
  ORDERS_MARKER + '\n' +
  JSON.stringify({
    mailbox: true,
    note: 'Orders mailbox — edited in place each phase. Edits send no notifications.',
  }, null, 1);

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

// A submission comment is the marker line followed by a JSON payload:
//   DIPLOMACY-ORDERS v1
//   {"power":"france","year":1901,"season":"spring","step":"movement","orders":"..."}
// Returns the payload, or null if the body is not a well-formed submission.
export function parseSubmission(body) {
  if (!body || !body.startsWith(ORDERS_MARKER)) return null;
  try {
    const sub = JSON.parse(body.slice(ORDERS_MARKER.length));
    if (!sub || !sub.power || !sub.year || !sub.season || !sub.step) return null;
    if (typeof sub.orders !== 'string') return null;
    return sub;
  } catch {
    return null;
  }
}

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

// The caller's mailbox comment id, whatever its body currently holds — a real
// submission, or the empty placeholder it was created as. A comment must carry
// the marker to qualify, so an ordinary chat comment on the gist is never
// overwritten. A real submission wins over a bare placeholder, so a player
// holding both always gets the submission patched; among equals the most
// recently edited wins, exactly as in findSubmission — the two MUST agree, or a
// resubmit would edit one comment while the UI went on reading another.
export function findMyComment(comments, login) {
  if (!login) return null;
  let submission = null;
  let placeholder = null;
  for (const c of comments) {
    if (!mine(c, login)) continue;
    if (!c.body || !c.body.startsWith(ORDERS_MARKER)) continue;
    if (parseSubmission(c.body)) submission = laterOf(submission, c);
    else placeholder = laterOf(placeholder, c);
  }
  const pick = submission || placeholder;
  return pick ? pick.id : null;
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

function rememberMailbox(gistId, login, id) {
  try { localStorage.setItem(mailboxKey(gistId, login), String(id)); } catch { /* private mode */ }
}

function forgetMailbox(gistId, login) {
  try { localStorage.removeItem(mailboxKey(gistId, login)); } catch { /* private mode */ }
}

// Creates the caller's mailbox if they have none yet, and returns its id.
// Takes an already-fetched comment list (refreshOnlineStatus has one on every
// poll) so the common "already have one" case costs no request at all.
export async function ensureMailbox(gistId, comments, login) {
  const remembered = rememberedMailbox(gistId, login);
  if (remembered) return remembered;
  const existing = findMyComment(comments, login);
  if (existing) {
    rememberMailbox(gistId, login, existing);
    return existing;
  }
  const token = getToken();
  if (!token) throw new Error('no GitHub token set');
  const json = await ghFetch(`${API}/gists/${gistId}/comments`, {
    method: 'POST',
    headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json' },
    body: JSON.stringify({ body: MAILBOX_BODY }),
  });
  rememberMailbox(gistId, login, json.id);
  return json.id;
}

function patchComment(gistId, commentId, body) {
  return ghFetch(`${API}/gists/${gistId}/comments/${commentId}`, {
    method: 'PATCH',
    headers: { Authorization: `token ${getToken()}`, Accept: 'application/vnd.github+json' },
    body: JSON.stringify({ body }),
  });
}

// Writes the caller's orders into their mailbox. `payload` carries
// {power, year, season, step, orders}; submittedAt is stamped here.
// Returns {login, submission, comment} — `comment` is GitHub's own copy of the
// edited comment, which the caller folds straight into its cached list so the
// UI updates from the write itself rather than from a later poll.
//
// This ALWAYS edits, never creates-with-content: a mailbox is created empty
// first (normally long before, when the player opened the game) precisely so
// that the notification GitHub sends on creation carries no orders. Keep it
// that way — a POST with a filled-in body here would email every player's
// moves to the whole table.
export async function submitOrders(gistId, payload) {
  const token = getToken();
  if (!token) throw new Error('no GitHub token set');
  const login = await getAuthenticatedLogin(token);
  if (!login) throw new Error('token was not accepted by GitHub');
  const submission = { ...payload, submittedAt: new Date().toISOString() };
  const body = ORDERS_MARKER + '\n' + JSON.stringify(submission, null, 1);

  // Fast path: our comment id is already known, so this is a single PATCH with
  // no read in front of it — nothing that can go stale, nothing that can decide
  // to create a comment.
  const remembered = rememberedMailbox(gistId, login);
  if (remembered) {
    try {
      return { login, submission, comment: await patchComment(gistId, remembered, body) };
    } catch (e) {
      // Only a 404 (the comment was deleted) may fall through to the slow path.
      // Auth failures, rate limits and network errors must surface as failures:
      // retrying them down a route that can POST is how orders get mailed out.
      if (!/\b404\b/.test(e.message)) throw e;
      forgetMailbox(gistId, login);
    }
  }
  const commentId = await ensureMailbox(gistId, await listComments(gistId), login);
  return { login, submission, comment: await patchComment(gistId, commentId, body) };
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

export function movesFileName(power) {
  return `moves-${power}.json`;
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

// Accepts a bare gist id or a full gist URL and returns the id, or null.
export function extractGistId(s) {
  s = (s || '').trim();
  const urlMatch = s.match(/gist\.github\.com\/[^/]+\/([0-9a-f]+)/i);
  if (urlMatch) return urlMatch[1];
  if (/^[0-9a-f]{16,}$/i.test(s)) return s;
  return null;
}
