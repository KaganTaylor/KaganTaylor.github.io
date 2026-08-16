// Obfuscating order text so a leaked comment can't be read at a glance.
//
// THIS IS NOT SECRECY. The key lives in the game's own gist (seal-key.json),
// so everyone who can reach the game can decrypt — that is deliberate: no
// ceremony, no key to lose, and the unattended GitHub Action can still publish
// moves. What it buys is that order text never appears in plaintext anywhere a
// human might read it by accident — GitHub's notification emails, the gist
// page, a shared screen. Turning base64 back into orders takes a script and
// intent, and among friends that line is the one that matters. See
// DECISIONS.md; proposals/sealed-orders.md is the design to reach for if the
// table ever wants orders genuinely hidden from each other.
//
// AES-GCM-256 via WebCrypto, chosen over anything hand-rolled because it is
// built into both the browser and Node (so it costs no dependency and less
// code), and because its output is indistinguishable from random: no
// line structure, no repeated blocks, no telling an army from a fleet.
// crypto.subtle needs a secure context — GitHub Pages is HTTPS and localhost
// qualifies, so `python -m http.server` works too.

const IV_BYTES = 12;

function b64encode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64decode(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// A fresh 256-bit key, base64 — what goes into the gist's seal-key.json.
export function newSealKey() {
  return b64encode(crypto.getRandomValues(new Uint8Array(32)));
}

// importKey costs a call per use otherwise, and every comment on the gist is
// unsealed on every refresh.
const imported = new Map();
function importKey(keyB64) {
  let p = imported.get(keyB64);
  if (!p) {
    p = crypto.subtle.importKey('raw', b64decode(keyB64), 'AES-GCM', false, ['encrypt', 'decrypt']);
    imported.set(keyB64, p);
  }
  return p;
}

// Bound as AES-GCM additionalData, so a sealed blob cannot be lifted into
// another phase or replayed under another power — it simply fails to open.
export function aadFor(gistId, sub) {
  return new TextEncoder().encode(
    `${gistId}|${sub.power}|${sub.year}|${sub.season}|${sub.step}`
  );
}

// base64 of iv(12) || ciphertext.
export async function seal(keyB64, text, aad) {
  const key = await importKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad },
      key,
      new TextEncoder().encode(text)
    )
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64encode(out);
}

// The plaintext, or null on any failure — a wrong key, a tampered blob, a
// mismatched phase, or garbage. Never throws: this runs inside the poll that
// feeds every render, and one bad comment must not blank the board.
export async function unseal(keyB64, blobB64, aad) {
  try {
    const key = await importKey(keyB64);
    const raw = b64decode(blobB64);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: raw.slice(0, IV_BYTES), additionalData: aad },
      key,
      raw.slice(IV_BYTES)
    );
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}
