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
// A power already published for the current phase is skipped, and a comment
// edited after the deadline (GitHub's updated_at stamp) is void — no late
// entries. The game master can un-publish from the app to allow a correction.
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
const ORDERS_MARKER = 'DIPLOMACY-ORDERS v1';
const DESCRIPTION_PREFIX = 'Diplomacy Simulator — ';

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

// same format the app writes: marker line + JSON payload
function parseSubmission(body) {
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

const samePhase = (phase, s) =>
  s && s.year === phase.year && s.season === phase.season && s.step === phase.step;

// first valid submission comment by this login — the app edits that same
// comment in place, so any later duplicates are ignored, matching the app.
// Returns {sub, updatedAt}; updatedAt is GitHub's own edit stamp.
function findSubmission(comments, login) {
  for (const c of comments) {
    if (c.user && c.user.login.toLowerCase() === login.toLowerCase()) {
      const sub = parseSubmission(c.body);
      if (sub) return { sub, updatedAt: c.updated_at || c.created_at || null };
    }
  }
  return null;
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
