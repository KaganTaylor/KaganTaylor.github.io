#!/usr/bin/env node
// Publishes Diplomacy players' submitted moves after the deadline.
//
// Players submit orders as gist comments (one comment each, edited in place —
// see js/publish.js). This script — run only when the GitHub Action is
// manually dispatched, never on a schedule — copies the valid submission of
// every assigned power into that power's moves-<power>.json file in the game
// gist, but only for games in auto-publish mode (game.json `publishMode`)
// whose deadline has passed (game.json `deadline`, an ISO timestamp the game
// master confirms in the app each phase). It is an optional record-keeping
// step: the app already reveals auto-mode submissions client-side at the
// deadline, and manual-mode games are published by the game master in the
// app after review.
//
// Order text in those comments is sealed (AES-GCM-256) under a key kept in the
// game gist itself as seal-key.json, so this script needs no secret beyond the
// token it already has — that is precisely why the key is shared rather than
// per-player. See diplomacy/js/seal.js and DECISIONS.md. A submission that
// cannot be unsealed is logged and skipped, never published as an empty one.
//
// A power already published for the current phase is skipped, and a comment
// edited after the deadline (GitHub's updated_at stamp) is void — no late
// entries. The game master can authorize a late resubmission from the app
// (⚙ Settings → 🔍 Submissions → 🔒/🔓) to allow a correction.
//
// Environment:
//   DIPLOMACY_GIST_TOKEN  (required) the game master's classic PAT, gist scope
//   GIST_ID               (optional) process only this gist
//   DRY_RUN               (optional) report what would be published, write nothing
//   IGNORE_DEADLINE       (optional) publish even if the deadline is unset/future,
//                         the mode is manual, or a comment was edited late
//
// Node >= 18 (native fetch), no dependencies.

const TOKEN = process.env.DIPLOMACY_GIST_TOKEN;
const ONLY_GIST = process.env.GIST_ID || null;
const DRY_RUN = !!process.env.DRY_RUN;
const IGNORE_DEADLINE = !!process.env.IGNORE_DEADLINE;

const API = 'https://api.github.com';
const ORDERS_MARKER = 'DIPLOMACY-ORDERS';
// LEGACY v1 — remove once the current game ends. Comments written before order
// text was sealed; recognised so the game in progress survives the upgrade,
// never written.
const LEGACY_MARKER_V1 = 'DIPLOMACY-ORDERS v1';
const DESCRIPTION_PREFIX = 'Diplomacy Simulator — ';
const SEAL_FILE = 'seal-key.json';
const IV_BYTES = 12;
const subtle = globalThis.crypto.subtle;

async function gh(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: {
      Authorization: `token ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}`);
  return res.json();
}

async function paged(path) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await gh(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

// gist file content, following raw_url when the API truncated it
async function fileContent(file) {
  if (!file) return null;
  if (!file.truncated) return file.content;
  const res = await fetch(file.raw_url);
  if (!res.ok) throw new Error(`${res.status} fetching ${file.raw_url}`);
  return res.text();
}

// Matched as a whole first line, never as a prefix — 'DIPLOMACY-ORDERS v1'
// starts with 'DIPLOMACY-ORDERS' and must not be taken for it.
function markerOf(body) {
  const line = (body || '').split('\n', 1)[0].trim();
  if (line === ORDERS_MARKER) return ORDERS_MARKER;
  if (line === LEGACY_MARKER_V1) return LEGACY_MARKER_V1; // LEGACY v1 — remove once the current game ends
  return null;
}

// same format the app writes: marker line + JSON payload. Order text arrives
// as a `sealed` blob; `orders` is cleartext, which is what LEGACY v1 comments
// carry, what a game with no seal key falls back to, and what unsealComments
// rewrites a sealed payload into.
function parseSubmission(body) {
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

// ---------------------------------------------------------------------------
// Unsealing. Order text is encrypted with a key kept in the gist itself, so
// this script needs no secret beyond the token it already has — that is the
// whole reason the key is shared rather than per-player (see js/seal.js).
// AES-GCM-256, iv(12) || ciphertext, base64; phase and power are bound as
// additionalData so a blob can't be replayed under another power.
// ---------------------------------------------------------------------------

async function readSealKey(gist) {
  const file = gist.files && gist.files[SEAL_FILE];
  if (!file) return null;
  try {
    const doc = JSON.parse(await fileContent(file));
    return doc && typeof doc.key === 'string' ? doc.key : null;
  } catch {
    return null;
  }
}

async function unsealOrders(keyB64, sub, gistId) {
  try {
    const key = await subtle.importKey(
      'raw', Buffer.from(keyB64, 'base64'), 'AES-GCM', false, ['decrypt']
    );
    const raw = Buffer.from(sub.sealed, 'base64');
    const aad = Buffer.from(
      `${gistId}|${sub.power}|${sub.year}|${sub.season}|${sub.step}`
    );
    const pt = await subtle.decrypt(
      { name: 'AES-GCM', iv: raw.subarray(0, IV_BYTES), additionalData: aad },
      key,
      raw.subarray(IV_BYTES)
    );
    return Buffer.from(pt).toString('utf8');
  } catch {
    return null;
  }
}

const samePhase = (phase, s) =>
  s && s.year === phase.year && s.season === phase.season && s.step === phase.step;

// The submission comment by this login, matching the app's rule in
// js/publish.js exactly — keep the two in step. Returns {sub, updatedAt};
// updatedAt is GitHub's own edit stamp.
//
// The MOST RECENTLY EDITED submission wins, not the first found (comments
// arrive oldest-first). The app now only ever edits one comment per player, but
// duplicates exist on games played before that was true, and preferring an
// older one would both publish superseded orders and let a player submit on
// time, edit a duplicate after the deadline, and pick their stamp.
//
// updated_at is not backstopped with created_at (and neither is the app's
// copy): the comment is created empty when the player first opens the game, so
// created_at can predate the submission by days and would wave a late edit
// through as on time.
function findSubmission(comments, login) {
  const editedAt = (c) => Date.parse(c.updated_at || c.created_at || 0) || 0;
  let best = null;
  for (const c of comments) {
    if (!c.user || c.user.login.toLowerCase() !== login.toLowerCase()) continue;
    if (!parseSubmission(c.body)) continue;
    if (!best || editedAt(c) > editedAt(best) || (editedAt(c) === editedAt(best) && Number(c.id) > Number(best.id))) {
      best = c;
    }
  }
  return best ? { sub: parseSubmission(best.body), updatedAt: best.updated_at || null } : null;
}

async function processGame(gistId, description) {
  const gist = await gh(`/gists/${gistId}`);
  const game = JSON.parse(await fileContent(gist.files['game.json']));
  const players = game.players || {};
  if (!Object.values(players).some(Boolean)) {
    console.log(`  no players assigned — skipping`);
    return;
  }
  // the game master confirms every deadline in the app; without one (or
  // before it) this game is left alone. Manual-mode games are the GM's to
  // publish from the app after review — never this script's.
  let deadline = null;
  if (!IGNORE_DEADLINE) {
    if ((game.publishMode || 'manual') !== 'auto') {
      console.log('  manual publish mode — the game master publishes from the app; skipping');
      return;
    }
    deadline = game.deadline ? new Date(game.deadline) : null;
    if (!deadline || isNaN(deadline)) {
      console.log('  no deadline set — skipping');
      return;
    }
    if (deadline.getTime() > Date.now()) {
      console.log(`  deadline not reached (${deadline.toISOString()}) — skipping`);
      return;
    }
    console.log(`  deadline passed (${deadline.toISOString()})`);
  }
  const phase = { year: game.year, season: game.season, step: game.step };
  console.log(`  phase: ${phase.season} ${phase.year} ${phase.step}`);

  const moves = {};
  for (const [name, file] of Object.entries(gist.files)) {
    const m = name.match(/^moves-([a-z]+)\.json$/);
    if (!m) continue;
    try {
      const doc = JSON.parse(await fileContent(file));
      if (doc && Array.isArray(doc.history)) moves[m[1]] = doc;
    } catch { /* malformed file — treated as absent */ }
  }

  const comments = await paged(`/gists/${gistId}/comments`);
  const sealKey = await readSealKey(gist);
  const updates = {};
  for (const [power, login] of Object.entries(players)) {
    if (!login) continue;
    const doc = moves[power];
    if (doc && doc.history.some((h) => samePhase(phase, h))) {
      console.log(`  ${power}: already published`);
      continue;
    }
    const found = findSubmission(comments, login);
    const sub = found && found.sub;
    if (!sub || !samePhase(phase, sub) || sub.power !== power) {
      console.log(`  ${power}: no submission for this phase (@${login})`);
      continue;
    }
    if (typeof sub.orders !== 'string') {
      // sealed — decrypt with the gist's own key
      const orders = sealKey ? await unsealOrders(sealKey, sub, gistId) : null;
      if (orders === null) {
        // Never fall through as "nothing submitted": that would publish this
        // power as having ordered nothing when they in fact ordered something
        // we merely couldn't read.
        console.log(`  ${power}: submission could not be unsealed — skipping (@${login})`);
        continue;
      }
      sub.orders = orders;
    }
    if (deadline && found.updatedAt && new Date(found.updatedAt) > deadline) {
      console.log(`  ${power}: comment edited after the deadline (${found.updatedAt}) — void`);
      continue;
    }
    const out = doc || { power, history: [] };
    out.history = out.history.filter((h) => !samePhase(phase, h));
    out.history.push({
      year: sub.year,
      season: sub.season,
      step: sub.step,
      orders: sub.orders,
      by: login,
      submittedAt: sub.submittedAt || null,
      publishedAt: new Date().toISOString(),
      publishedBy: 'action',
    });
    updates[`moves-${power}.json`] = { content: JSON.stringify(out, null, 1) };
    console.log(`  ${power}: publishing submission from @${login}`);
  }

  if (!Object.keys(updates).length) {
    console.log('  nothing to publish');
    return;
  }
  if (DRY_RUN) {
    console.log(`  DRY_RUN — would update: ${Object.keys(updates).join(', ')}`);
    return;
  }
  await gh(`/gists/${gistId}`, { method: 'PATCH', body: JSON.stringify({ files: updates }) });
  console.log(`  updated: ${Object.keys(updates).join(', ')}`);
}

async function main() {
  if (!TOKEN) {
    console.error('DIPLOMACY_GIST_TOKEN is not set');
    process.exitCode = 1;
    return;
  }
  const gists = await paged('/gists');
  const games = gists.filter(
    (g) =>
      (g.description || '').startsWith(DESCRIPTION_PREFIX) &&
      g.files && g.files['game.json'] &&
      (!ONLY_GIST || g.id === ONLY_GIST)
  );
  if (!games.length) {
    console.log('no published Diplomacy games found for this account');
    return;
  }
  let failures = 0;
  for (const g of games) {
    console.log(`${g.id} — ${g.description}`);
    try {
      await processGame(g.id, g.description);
    } catch (e) {
      failures++;
      console.error(`  FAILED: ${e.message}`);
    }
  }
  if (failures) process.exitCode = 1;
}

main();
