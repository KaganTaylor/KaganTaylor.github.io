# Proposal: sealed orders (client-side encryption of submissions)

**Status:** proposed, not implemented. Deferred deliberately — see *Relationship to the mailbox
change* below for what is already done and what this adds.

---

## The problem this solves

Submissions are gist comments in cleartext (`ORDERS_MARKER` + JSON, `js/publish.js`). Two channels
leak them:

1. **Push — GitHub emails every newly created gist comment's body** to everyone subscribed to the
   gist, which is the owner plus everyone who has already commented: the whole table. Players were
   being emailed each other's orders as they submitted.
2. **Pull — the gist page is public.** Anyone with the game link can open the gist and read every
   submission before the deadline.

**The mailbox change (shipped) closes (1) only.** A player's comment is now created empty and every
submission is an edit, and GitHub does not notify on edits — so no email carries orders, and after
the one-time mailbox creation no email is sent for a submission at all. Channel (2) is untouched:
`DECISIONS.md`'s house rule — "don't read the gist comments early", like not reading someone else's
postcard — is still all that protects it.

This proposal closes (2).

## Threat model

The adversary is **a fellow player**: they hold the game link, the gist and all its comments, every
notification email, and the app's source. They must not learn another player's orders before the
reveal. The game master is trusted with the plaintext (they must adjudicate); see *Residual limits*.

---

## Key model

```
GM's PAT ──HKDF-SHA256(salt = gistId)──▶ vault key (AES-GCM-256)
                                            │  wraps
random P-256 ECDH keypair ──────────────────┤
   ├── public  ──▶ game.json  "sealKey"          every player reads it
   └── private ──▶ gist file "seal-key.json"     wrapped; only the token unwraps it
```

Any device holding the GM's token can unwrap the private key straight from the gist. **There is no
backup ceremony and no new secret to lose** — which is the whole reason for this shape. It also
rides the multi-device story that already exists: the GM's token is already what identifies them
(`getAuthenticatedLogin`), already lives in `localStorage`, and already has to be present on every
device they run the game from.

### Why derive from the token rather than a passphrase

A classic PAT is `ghp_` + 36 base62 characters; even discounting the trailing checksum that is
~180 bits of entropy. The wrapped blob sits in a public gist where any player can attack it
offline forever, so the wrapping key must be real key material. A token is. A human passphrase is
not — a weak one would mean no protection at all, which is why the passphrase variant was rejected.

### Why the token can't seed the ECDH key directly

The obvious design — derive the ECDH private key itself from the token — does not survive contact
with WebCrypto: it will not import a raw private scalar without the matching public point, and
computing that point means hand-rolling P-256 scalar multiplication in a project with no
dependencies. Wrapping a normally-generated keypair with a token-derived *symmetric* key gets the
same "your token is your key" property using only `generateKey`, `deriveBits` and `encrypt`.

### Player-side sealing

Ephemeral-static ECDH: generate a throwaway P-256 keypair, ECDH against `sealKey`, HKDF to an
AES-GCM-256 key, encrypt the order text. The comment carries `{epk, iv, ct}` and nothing else
readable. Bind `power|year|season|step` as AES-GCM `additionalData` so a sealed blob cannot be
replayed into a different phase or under a different power.

P-256 / HKDF / AES-GCM only — universally supported, no exotic algorithms. `crypto.subtle` needs a
secure context; GitHub Pages is HTTPS and `localhost` qualifies, so both the live site and
`python -m http.server` work.

### Token rotation

The one real failure mode, handled in three layers:

1. Cache the unwrapped private JWK in `localStorage`, keyed by gist id, on every successful unwrap.
2. If the wrapped blob fails to unwrap but the cached key matches `game.json`'s public key,
   **re-wrap under the current token and push** — a rotated token self-heals the moment the GM
   opens the game on a device that has the key cached.
3. Escape hatch: ⚙ Settings → 🔐 Sealed orders offering *copy recovery key* / *restore from backup*
   / *rotate key*. Rotation asks the table to resubmit — tedious, but never unrecoverable.

---

## Wire format and compatibility

Bump the marker to `DIPLOMACY-ORDERS v2` for sealed comments; `parseSubmission` accepts both v1
(legacy cleartext `orders`) and v2 (`sealed` blob, no `orders`).

**Bumping rather than reusing v1 is the load-bearing part.** An old cached client that meets a v2
comment must read it as *no submission*. If sealed comments were smuggled into v1 with an empty
`orders` string, an old GM client could load a table of blank orders and resolve on them.

Metadata — `power`, `year`, `season`, `step`, `submittedAt` — stays cleartext. The submitting
player cannot decrypt their own comment (it is sealed to the GM), and `renderSubmitStatus` needs
those fields to report their own status honestly. It leaks nothing: GitHub already publishes each
comment's author and timestamps.

---

## Integration

**Decrypt once, in `refreshOnlineStatus`.** After `listComments`, an `unsealComments()` pass
attaches `.orders` to every submission the GM can decrypt. Everything downstream —
`phaseSubmission`, `powerOnlineStatus`, `gmLoadOrders`, `autoPublishIfDue`, `revealedEntry` — keeps
seeing today's shape and needs no rework. That is what keeps this change small.

Sketch of the work:

- **New `js/seal.js`** (~120 lines, WebCrypto only): `deriveVaultKey(token, gistId)`,
  `createSealKeypair()`, `wrapPrivate`/`unwrapPrivate`, `seal(publicB64, text, aad)`,
  `unseal(privateKey, sealed, aad)`.
- **`js/publish.js`**: marker bump and dual-format `parseSubmission`; `readSealFile`/`writeSealFile`
  for `seal-key.json` (a gist PATCH with a named files map leaves other files alone — the same
  mechanism `writeMovesFiles` already relies on).
- **`js/app.js`**: `ensureSealKey()` for the GM on load of an owned published game, publishing the
  public half via `updatePublished(game, game.publishedState)` — the board-override form, so
  enabling sealing cannot leak an in-progress position. Copy `fresh.sealKey` in
  `refreshOnlineStatus` alongside `players`/`deadline`/`publishMode`/`settings` so players pick up
  the key when the GM enables it mid-game. Seal in `doSubmitMoves`, stashing the plaintext locally
  so the order box still restores on that device; on a *different* device report "submitted
  (sealed)" and leave the box empty rather than lying about it. Add a `🔒 Sealed` status wording so
  players can see the protection, and the 🔐 Sealed orders dialog.
- **`revealedEntry`**: in auto mode, drop the fallback that reveals straight from comments — non-GM
  clients can no longer read them. No real loss: `autoPublishIfDue` only runs in the GM's browser
  anyway, so auto mode already depends on it being open, and it writes `moves-<power>.json` in the
  same tick.
- **`tools/publish-moves.js`**: has no key, so it must skip v2 submissions with an explicit log line
  rather than treating them as missing.

---

## Residual limits

Both are properties of gist comments as a transport, not of the crypto:

- **Submission timing stays public.** GitHub stamps every comment with its author and its
  `created_at`/`updated_at`. Sealing hides content, never the fact that someone submitted. (The
  mailbox change does at least stop anyone being *told*.)
- **The GM holds the key.** The app will not show them submissions before the deadline —
  `gmLoadOrders` is already gated on `!ordersOpen()` — and their inbox carries ciphertext instead of
  plaintext, which is strictly better than today. But a determined GM can decrypt by hand, and in
  the current game the GM also plays a power. Say it to the table rather than imply otherwise.

Removing either needs a real backend (a Cloudflare Worker or Firestore with security rules that
refuse to serve submissions until the deadline), which would break the project's founding no-server
constraint. Out of scope here.

## Optional extra: public tamper-evidence

Today's cleartext comments are publicly checkable — anyone can confirm the GM published what a
player actually submitted. Sealing removes that. It can be restored cheaply: include
`commitment = SHA-256(normalized orders + salt)` in the cleartext part of each submission, and
publish the salt alongside the revealed orders in `moves-<power>.json`. Any player can then verify
after the fact that the reveal matches the sealed commitment.
