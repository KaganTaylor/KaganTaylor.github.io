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
  const { gistId, gistUrl, published, isOwner, ...rest } = game;
  return rest;
}

async function ghFetch(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).message || msg; } catch { /* ignore */ }
    throw new Error(`${res.status} ${msg}`);
  }
  return res.json();
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

// Overwrites an already-published gist with the game's current state.
export async function updatePublished(game) {
  const token = getToken();
  if (!token) throw new Error('no GitHub token set');
  await ghFetch(`${API}/gists/${game.gistId}`, {
    method: 'PATCH',
    headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json' },
    body: JSON.stringify({
      files: { 'game.json': { content: JSON.stringify(stripForPublish(game), null, 1) } },
    }),
  });
}

// Reads a published game by gist id. No auth needed — gists are public.
export async function fetchPublished(gistId) {
  const json = await ghFetch(`${API}/gists/${gistId}`);
  const file = json.files && json.files['game.json'];
  if (!file) throw new Error('gist has no game.json file');
  const content = file.truncated ? await (await fetch(file.raw_url)).text() : file.content;
  return JSON.parse(content);
}

// Accepts a bare gist id or a full gist URL and returns the id, or null.
export function extractGistId(s) {
  s = (s || '').trim();
  const urlMatch = s.match(/gist\.github\.com\/[^/]+\/([0-9a-f]+)/i);
  if (urlMatch) return urlMatch[1];
  if (/^[0-9a-f]{16,}$/i.test(s)) return s;
  return null;
}
