# Design decisions

Why the simulator is built the way it is. The rules-engine choices (DATC preferences, Szykman, etc.) live in the README under *Rules choices*; this file covers the map, the rendering and the interaction model.

---

## The order text is the source of truth

Dragging a unit on the board does not create an order object — it rewrites the corresponding line in the order box, which is then re-parsed and re-adjudicated. There is exactly one representation of a turn's orders, and it is the text a player can paste into an email. Every drag, click and coast picker funnels through `syncOrderLine()` in `js/app.js`.

**Consequence:** anything the board can express, the text can express, and the live warnings under the box are produced by dry-running the *real* engine over the parsed text — never a second, approximate validator.

---

## The SVG layer stack

The board is the jDip `standard.svg` map, loaded and re-layered at runtime (`Board.load()` in `js/render.js`). Bottom to top:

| Layer | Origin | Purpose |
| --- | --- | --- |
| `MapLayer` | in the SVG | painted terrain; sea polygons carry `class="water"` |
| `InfluenceLayer` | ours — a clone of `MouseLayer` | ownership tint (translucent power colour) |
| `CoastTintLayer` | ours | the coastlines of split-coast provinces |
| `HoverLayer` | ours | outline of the hovered / tapped province |
| `SupplyCenterLayer`, order layers, `UnitLayer`, `DislodgedUnitLayer` | in the SVG | pieces and arrows |
| `MouseLayer` | in the SVG | invisible hit-test shapes, on top so hit testing is exact |

Because `MouseLayer` sits above everything, units never receive pointer events. A drag may only start on a unit, so `_unitAtClient()` hit-tests the pointer against the rendered units' bounding boxes instead; ordinary province hit testing goes through `MouseLayer` as normal.

The influence tint is a *clone* of the hit shapes rather than the painted terrain because the terrain paths are not addressable per province — the hit shapes are (`id="par"`, `id="spa-nc"`, …). Their ids are normalised to the engine's canonical location ids (`spa/nc`) and stored as `data-prov`.

---

## Split coasts: outline the country, mark the coasts

Spain, St Petersburg and Bulgaria each have one land shape plus **one extra hit shape per coast** (`spa`, `spa-nc`, `spa-sc`). The coast shapes bulge out into the sea and overlap the land.

Two decisions follow from that:

1. **Highlighting outlines the base shape only.** Outlining the coast shapes as well made those three countries look like three separate cut-out regions floating in the sea, rather than one country. `_setHover()` therefore skips any shape whose `data-prov` contains a `/`. The same reason keeps `setInfluence()` from filling the coast shapes: stacked translucent fills would render that part of the land darker than the rest.

2. **The coasts are shown by drawing the coastlines instead.** `CoastTintLayer` strokes the stretches of each split province's outline that actually border a sea space — never its land borders — so you can see at a glance that a fleet has to choose one. That replaces the information the old three-region highlight was carrying, without pretending the country is divided.

The highlight lives in its own `HoverLayer` **above** the coastlines. Stroked onto the influence shapes it was buried under the thicker coastline stroke, and Spain would light up along its land borders only.

### Finding the coastlines

There is no "this edge is coastal" data in the map, so it is derived at load time:

- Each `path.water` in `MapLayer` is sampled into polygon rings and used as a point-in-sea test (an even-odd ray cast). The sea polygons tile precisely with the land, so a probe just past a province's outline that lands in one is looking at open sea. The `MouseLayer` hit shapes do *not* tile exactly, which is why the terrain is used instead.
- The province outline is sampled, and each sample is kept if the sea lies within a few units of it along either normal.
- The kept samples are smoothed (bridge small gaps, drop lone specks) and grouped into contiguous runs, which become polylines.

Only sampling APIs are used — `getBBox()` and `isPointInFill()` are unusable here because the game screen is `display: none` while the board loads.

**Cost:** this runs once, at load. It is deliberately geometric rather than a hand-maintained table of coastal edges, which would have to be re-derived for any other map.

### Where to change the coastline colour

All of it is in the `COASTLINE APPEARANCE` block at the top of **`js/render.js`**:

```js
export const COAST_COLOR = '#6b7280';   // ← every coastline. Change this one value.
export const COAST_COLORS = {};         // per-coast overrides, e.g. { sc: '#9aa0a6' }
const COAST_SUFFIXES = ['nc', 'ec', 'sc'];
const COAST_WIDTH = 7;
const COAST_OPACITY = 0.85;
```

All coasts share one colour on purpose: the coastline says *"a fleet must pick a coast here"*, and colour-coding the individual coasts implied a distinction between them that the rules do not make. `COAST_COLORS` is left in place so a single coast can be picked out again without touching the drawing code.

A coastline is a wayfinding hint, not a highlight — keep it muted enough that it does not compete with `POWER_COLORS` (ownership) or `HOVER_COLOR` (the outline).

---

## Touch is not hover

A finger sliding across the board is panning or dragging a unit; it is never "pointing at" a province. Treating `pointermove` as hover on a touchscreen meant the only way to highlight a province was to drag a unit onto it — and it left a province highlighted wherever the last finger of a pinch happened to lift.

So on touch there is no hover: **a tap highlights the province it lands on** (`finish()` in `js/render.js` sets the highlight for any tap, mouse or finger). Hover on a mouse behaves as before.

The rest of the touch model:

- one finger on empty space or a non-draggable province → pan; on your own unit → drag an order
- two fingers → pinch to zoom (a second finger cancels any drag in progress)
- double-tap / double-click → reset zoom
- a drag needs 10px of movement on touch (5px with a mouse) before it counts as a drag rather than a tap

---

## Mobile layout: sheets shrink the board, they don't cover it

The sidebar becomes a bottom sheet with an Edit / Orders / Standings tab bar. Two rules make it usable:

- **An open sheet insets the board** rather than overlaying it. `applyMobileSheetUI()` measures the sheet and publishes its height as `--sheet-h`; the board pane reserves that much padding, so the whole map stays visible and tappable above the sheet. A `ResizeObserver` keeps the two in sync as the sheet's contents grow. Overlaying the sheet instead left the map centred *behind* it — with the Edit sheet open you could see northern Europe and nothing else, which made the board editor unusable: you cannot place a unit on a province the sheet is sitting on top of.
- **The Edit sheet shows only the edit tools.** It used to carry the order box as well, which filled the sheet and pushed the map off screen. The Orders tab is one tap away.

The tab bar is `position: fixed`, so `#main` has to reserve its height explicitly or the board runs underneath it.

The topbar's overflow (`⋮`) menu only exists on mobile: on desktop its wrapper is `display: contents`, which dissolves it and lets Publish/Export sit inline in the topbar. That is also why the wrapper has to be restored to a real box in the mobile media query — `display: contents` cancels `position: relative`, so the absolutely-positioned menu was anchoring to the page instead of to the button, and opened below the bottom of the viewport (it looked like the button did nothing).

---

## The home button is a home icon

It was a ☰ burger. The button does not open a drawer or expand a menu — it leaves the game and switches to the menu screen — so it is a 🏠. Same button, same behaviour, on desktop and mobile.

---

## Publishing

A published game is a public GitHub gist, written with a personal access token the player supplies (classic token, `gist` scope only — fine-grained tokens cannot access gists). The token is kept in `localStorage` and never leaves the browser except to `api.github.com`.

Only the browser that published a game can advance it (`isOwner`). Everyone else opening the link gets a live, read-only view: they may pick their country, write and copy their own orders, and branch the position into a private practice game, but not resolve the real one. That keeps the game master authoritative without needing a server.

---

## Online play: submissions are gist comments

Only a gist's owner can write its files — gists have no collaborators — so players cannot write their moves into the game gist directly. Three transports were weighed:

- **Gist comments (chosen).** Any GitHub account can comment on a public gist with a `gist`-scope token. Each player keeps exactly ONE comment (a marker line + JSON payload, see `ORDERS_MARKER` in `js/publish.js`) and edits it in place to resubmit. Comments are separate API objects, so simultaneous submissions from different players **cannot conflict** — the deciding property, since everyone submits as the deadline closes in. GitHub stamps each comment with its author's login, so a submission cannot be forged. Multi-device support comes free: the token resolves to a login (`GET /user`), and the comment is found *by login*, not by device or token string.
- **Per-player gists** would also be conflict-free, but every player would have to create an orders gist and get its ID registered with the GM — reintroducing the coordination the feature removes — and unauthenticated polling of N player gists runs into GitHub's 60 req/hr/IP limit.
- **A repo per game** (players as collaborators) matches the naive mental model, but needs broad `repo`-scope tokens, invite acceptance per player, retry logic for the contents API's concurrent-commit 409s, and a second storage backend beside gists.

The published per-power files (`moves-<power>.json`) have a **single writer** — the GM's token, used by the app's publish buttons and by the optional Action — so they cannot conflict either. Each file keeps one entry per year/season/step: history stays as a record, and only the entry matching the game's current phase is ever loaded into the order box. The publish step writes a power's entry only if the phase has none yet, so editing a comment after the deadline is inert; the GM un-publishes (✖) to deliberately reopen a power's window.

Submissions are cleartext. Real pre-deadline secrecy on public infrastructure would need client-side encryption (considered, deferred); "don't read the gist comments early" is a house rule, like not reading someone else's postcard.

**Deadlines are confirmed, not scheduled — and enforced by the reader, not a runner.** Only the GM writes the `deadline` timestamp in game.json, confirming each phase's deadline in the app (+1 week is the default rhythm; +24/48 h fit retreats and builds). Nothing runs *at* the deadline: GitHub Actions has no "run once at time X" primitive, and the hourly-polling cron that first papered over that was dropped as waste. Instead the deadline is a property any client can check against public data — GitHub stamps every comment with an author login (identity) and an `updated_at` (edit time), so every viewer independently agrees on which submissions beat the deadline. A comment edited after the deadline is void: no late entries, and no window where a runner has seen the moves but a player can still change them.

**Two publish modes**, the GM's ⚙ Settings choice. *Manual* (default): after the deadline, submissions lock and stay GM-only; the GM reviews them in the order box (🔍, no writes — and, like 📣 Publish results, disabled until the deadline actually passes, so nothing about the review step offers a shortcut to see moves early), then either re-opens by confirming a new deadline — players keep their submitted orders unless they resubmit — or releases them with 📣 Publish results. *Auto*: every client reveals all on-time submissions the moment the deadline passes, straight from the comments, and read-only viewers may resolve locally to preview the new board (the GM's published update remains authoritative); there is no review step to skip past — the deadline itself is the reveal. Manual is the default because a typo caught before the reveal costs nothing, while one caught after has already leaked information. The repo's GitHub Action is now only a manually-dispatched convenience that copies auto-mode reveals into the per-power files as a durable record; no deadline (or manual mode) means it writes nothing, which fails safe.

**Publishing the board is a separate, explicit act from resolving it.** The GM can resolve, undo, redo and edit the board freely after publishing — none of it reaches players until ☁ Publish changes is clicked. That button is disabled whenever the local position already matches what's live, computed by comparing `state.js`'s `boardSnapshot()` (year/season/step/units/scOwners/pending/history/redoStack) against a copy saved at the last successful publish (`game.publishedState`, itself stripped back out before anything is sent to the gist — it's local bookkeeping, not part of the position). Deliberately excluded from that comparison: the order box. Orders typed or dragged onto the board never touch the game object until `resolvePhase()` runs, so a GM can sketch out arrows to plan their own move without the app ever thinking there's something new to publish. 👁 View published state reads the gist's actual `game.json` and shows it on the board without loading it into the live game — the GM's in-progress work is never at risk just from looking. Settings changes (deadline, publish mode, player assignments) still write to the same `game.json`, but they pass the last-published board snapshot as an override rather than whatever the GM's board currently looks like — otherwise confirming a deadline while mid-resolve would silently leak the new position as a side effect, defeating the point of the dirty check.

---

## Support and convoy without a keyboard

⇧-drop and Ctrl-drop are the fast way to write a support or a convoy, but a touchscreen has no modifier keys — on a phone those two orders could only be typed. So the same two orders get a pair of toggles, `🤝 Support` and `⚓ Convoy`, which arm the next drag: with one on, dropping a unit onto another writes a support (or convoy) instead of a move. The modifier keys still work and are unchanged; the toggles are an equivalent, not a replacement.

Where they live differs by size, because the constraints differ. On desktop they are ordinary topbar buttons next to ✏ Edit board. On mobile the topbar has no room and, more importantly, the toggle has to be reachable *while the map is being used* — so they are lifted out of the flow and floated over the map's top-right corner as two thumb-sized targets, below the ⋮ button and clear of it (`--topbar-h`, measured in `app.js`, keeps them under a topbar whose height depends on the phone).

They are **one-shot**: a mode switches itself off as soon as an order is written. Leaving it armed would silently turn the *next* intended move into another support, which is the kind of thing you only notice after resolving. A *failed* drop (nothing there to support, dropping onto a non-fleet) leaves the mode on, so the drag can just be retried. The toggles are hidden outside movement orders — during edit mode, playback, retreats, builds, and for read-only spectators — where they would mean nothing.

---

## Submissions are hidden by default, not just gated

Who's submitted, and their actual order text, used to live in a permanent sidebar section (`#panel-players`) and a small status table every player could see in the Orders panel. Both are gone. The status table was visible to *everyone*, not just the GM — a real privacy leak, since a game where players can see their opponents' submission timing is a worse game (it turns "did they submit yet" into a signal). And the GM's own review tools sat open on the main screen at all times, whether or not there was anything to review.

Both now live behind one shared `#submissions-modal`, reachable two ways, both GM-only: **⏰ Deadline → 🔍 Review submitted orders** (the expected per-phase step — only really useful once there's something to review) and **⚙ Settings → 🔍 Submissions** (ungated by the deadline, for the "something's wrong, check one player's order" case a GM occasionally needs regardless of where the clock stands). Neither is shown unless the GM deliberately opens it — the point isn't just *who* can see it, but that a GM who doesn't want to know isn't confronted with it by default either. `renderSubmissionsModal()` only runs while the modal is actually open (checked in `renderOnlineUI()`), rather than on every render pass, since it's no longer part of the always-visible page.

---

## The deadline countdown is one urgency value, read in three places

`deadlineUrgency()` (`js/app.js`) is the single `'none' | 'warn' | 'danger'` classification — no deadline set, counting down, or passed — behind every place the app signals it: the topbar's always-visible `DD:HH:MM:SS` chip (ticking on its own 1 s interval, deliberately separate from the existing 60 s online-status poll so a per-second update doesn't imply a per-second network check), the sidebar's `#panel-deadline` box (a subtle background/border tint), and the Orders panel's `#deadline-info` hint text. Three call sites reading one function, rather than three places independently comparing `Date.now()` against the deadline, is what keeps "orders are open" from ever disagreeing with itself across the page.

The countdown lives in the topbar — not just the sidebar, where the old deadline text was easy to miss — because it has to be legible to every viewer, GM or player, on both mobile and desktop, and it's the one piece of state that changes every second regardless of anyone's actions. Orders are treated as closed both before any deadline is ever set and after one passes: with no deadline there is nothing to have been "on time" against, so leaving submission open in that state was really just a confusing default, not a real allowance.

---

## Debug "view as player" is safe because submissions are keyed by login, not by claim

`⚙ Settings → 🕵 View as` lets the GM preview and test the game exactly as one assigned player would, including a real `📤 Submit moves` — without a second GitHub account. That only works safely because of a property the online-play design already had: a submission comment is found by the *submitter's actual GitHub login* (`findSubmission`, `js/publish.js`), never by the `power` field inside its payload. A GM debug-testing as France still submits under their own login, which is necessarily a different comment object than the real France player's — so a debug submission can never overwrite, shadow, or be mistaken for a real player's comment, no matter which power the GM claims to be. If claim-based lookup were used instead (trust the `power` field in the payload), debug submissions would be indistinguishable from real ones and this feature would be unsafe to build at all.

The one comment a debug session *can* touch is the GM's own — if they happen to also be a real assigned player elsewhere, or from a previous test — so `enterDebugView()` captures it byte-for-byte (`{commentId, body}`) before doing anything, and `exitDebugView()` either restores that exact body or, if none existed, deletes whatever a debug submit created. This is deliberately implemented as a real GitHub comment (through the same `submitOrders()` path a real player uses) rather than a mocked/local-only submission, specifically so the GM is testing the real network path, not a simulation of it — the entire point of the feature is to catch bugs in the actual submit flow.

Because leaving a debug session open by navigating away (🏠 Home, or opening a different game) would otherwise strand a stray comment on the old game's gist, both paths run the same restore-or-delete cleanup (`cleanupDebugSubmission()`) as a best-effort safety net, independent of `exitDebugView()`'s own toast/UI handling — cleanup is a pure network operation against whichever gist/captured-state is passed in, not tied to whatever `game` happens to be current when it runs.
