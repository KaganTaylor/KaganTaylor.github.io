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

## Order arrows aim at the border, not at the symbol

A unit symbol sits wherever the map draws the piece, which is nowhere near where two provinces meet. St Petersburg's symbol is deep in the south of the province; Norway's is in southern Norway; the two only *border* up in the arctic. So `A Stp - Nwy` drawn symbol-to-symbol is a straight line clean across Finland and Sweden — and it reads as an attack on those countries.

Support lines inherited the problem, worse. A support-of-a-move used to end at the midpoint of target→dest, and midpoint(Stp, Nwy) lands on top of Finland's own symbol: `Swe S Stp - Nwy` looked like Sweden supporting Finland, and Finland's own support line collapsed to a stub.

`_moveSegment(fromLoc, destLoc)` in **`js/render.js`** is now the single place that decides where a move arrow runs, and the arrow, the support line drawn onto it and the failure slash all ask it:

- Probe the direct symbol-to-symbol line. If more than a quarter of the probes land outside **both** provinces, the line is crossing somebody else.
- When it is, stop the arrow at the shared border instead — the point on the two outlines' frontier nearest the direct line. The arrow stays **straight**; it is only shortened, so it points at the part of the destination the unit actually enters.
- Ordinary moves (`Par - Bur`, `Ber - Mun`, `Mar - Spa`) run inside their own two provinces the whole way, fall under the threshold, and are drawn exactly as they always were.

The frontier is derived the same way the coastlines are — sample both `#_<prov>` outlines with `getPointAtLength`, keep the sample pairs that all but touch — rather than from a hand-maintained table of border points, which would have to be redrawn for any other map. It is lazy and cached per province pair, so it costs nothing at load and nothing on a redraw.

One related fix rides along: a support order names a *province* (`stp`), but the supported unit may be drawn on a **coast marker** (`stp/nc`), 190 map units away, so the support line used to miss the arrow entirely. `unitLoc()` resolves the province to the marker the unit is really on, via the `data-loc` attribute `_unitNode` already stamps for the drag code.

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

The topbar's actions live behind one ⚙ Settings drop-down at every width (`#settings-wrap`, which must stay `position: relative` for the menu to anchor to the button rather than the page). They used to sit inline on desktop, with `display: contents` dissolving the wrapper; that stopped scaling once the menu held publish, view/revert published, branch, game settings, export, players, submissions and the play-as control.

**⚙ Settings must never be the item pushed off the right-hand edge** — on a published game it is the only way to reach the publish actions, including switching `🎭 Play as` back to `👑 Game Master`. Everything else in the topbar is `flex: none`, so anything added there has to buy its room from something: `#game-name` is the one item allowed to shrink and ellipsise, `#deadline-countdown` drops to an icon, and `#phase-label` is hidden outright on mobile because `Board.setPhaseText()` already prints it into the corner of the map.

---

## The resolution is watched from the map, not from a sheet

The step-through is the one part of the app whose whole point is the map: arrows appear, verdicts land, units slide to their destinations. Its controls, though, lived in the sidebar — which on mobile is a sheet, and an open sheet insets the board (above). So watching a resolution on a phone meant watching it in the letterbox left above the controls driving it.

Three things fix it, all in service of the same rule — **while a resolution plays, the map gets the screen**:

- **`startPlayback()` closes the mobile sheet.** The 📝 Orders tab is one tap away for the full order list, `📋 Copy results` and the rest; nothing is lost, and the map is full-size for the part worth seeing.
- **`#pb-float`: the step controls float over the bottom-right of the map** (⏮ ◀ ▶ ⏭, the current step's text, and whatever the sidebar's primary action is — Continue / Publish results / ✕ back). It is a *mirror*, not a second implementation: `updatePlaybackFloat()` copies the sidebar buttons' labels, hidden and disabled state and shares their click handlers, so the two can never disagree about what stepping is currently allowed. It exists only in the mobile media query, since on desktop the sidebar is already on screen beside the board. It hides itself whenever a sheet is open, because the sidebar's own copy is then visible.
- **The board follows the order being described** (`Board.focusOn()`, called from `renderPlayback()`). A phone is usually zoomed in far enough to read one corner of the map, so an order two provinces away would otherwise be revealed off-screen. `focusOn` eases the viewBox until every province the order touches — mover, destination, supported unit, named convoy seas — is in frame.

`focusOn` is deliberately conservative, because the view belongs to the viewer:

- It **never zooms in**, only pans, and zooms *out* only as far as it takes to fit. A player who has zoomed into the Balkans to watch them keeps that zoom.
- It **does nothing when the locations are already in frame** (inset by a 12% margin so an order hugging the edge still triggers a pan). At the default zoom everything is in frame, so a desktop board never moves and pays nothing.
- **A hand on the map cancels it** — `cancelViewAnim()` on pointerdown, wheel and reset — so an auto-pan can never fight a drag.

At the resolution reveal (and so through the move animation that `Continue` plays) it fits *every* ordered province instead of one, since that step is about the whole board.

Note that the 🤝 Support / ⚓ Convoy toggles are already hidden throughout a playback: `updateOrderModeUI()` gates them on `!playback`, the same condition that stops a drag from writing an order at all. That leaves the map's bottom-right corner free for these controls and its top-right corner empty.

---

## The home button is a home icon

It was a ☰ burger. The button does not open a drawer or expand a menu — it leaves the game and switches to the menu screen — so it is a 🏠. Same button, same behaviour, on desktop and mobile.

---

## There are two kinds of game, and only two

A game is either **☁ online** — a published gist, with one authoritative position and one writer — or **🧪 a sandbox**: private to this browser, freely editable, disposable. "Local game", "practice game", "branch" and "empty-board sandbox" used to be four things; they are all the second one now.

The reason is that the game is only ever really *played* online. Everything local is thinking-out-loud: setting up a position to check a tactic, branching the live game to plan three moves ahead, blitzing a few turns to see where a year goes. Those want the same permissions as each other (edit anything, resolve anything, throw it away), and the *opposite* permissions from the real game. Two kinds, drawn along the line that actually matters — *can what I do here change the real game?* — beat four kinds drawn along how the file happened to be created.

`gameMode()` in `js/app.js` names the four faces of those two kinds: `sandbox`, `gm`, `player` (an assigned power) and `spectator`. It is written to `#game-screen[data-mode]`, so the stylesheet reads the same answer the interaction code does and the two cannot drift apart. It is derived from `isOwnerView()`, not raw `isOwner`, so a game master who has switched `🎭 Play as → 🧑 Player` sees the `player` colours too — see below.

### The state is visible before it is enforced

A rule you can only discover by tripping over it is a bad rule. So the mode is on screen in three places at once, in one colour — amber for sandbox, blue for online:

- a **chip** beside the game's name (`🧪 Sandbox`, `☁ Live · 👑 Game master`, `☁ Live · 🎖 France`, `☁ Live · 👁 Watching`),
- a **stripe** along the top edge of the topbar,
- a **ring** around the board itself.

The home screen carries the same split: online games and sandboxes are separate labelled groups, each row tinted to match, each with its icon, the role you hold, the deadline countdown, and — for a branch — the game it came from.

On a phone the chip keeps its colour and icon and drops its words, and `#phase-label` is hidden outright. The topbar is a row of `flex: none` items and had no give left once the chip and the ● pill joined it; the phase label is the one thing in it that is already on screen twice, since `Board.setPhaseText()` prints the same string into the corner of the map. That protects the rule from the mobile-layout section: ⚙ Settings must never be what gets pushed off the edge.

---

## Publishing

A published game is a public GitHub gist, written with a personal access token the player supplies (classic token, `gist` scope only — fine-grained tokens cannot access gists). The token is kept in `localStorage` and never leaves the browser except to `api.github.com`.

Only the browser holding the publisher's token can advance a published game (`isOwner`). Publishing is also the one-way door out of the sandbox: **a sandbox becomes the real game by being published**, which is why there is no separate "create an online game" path.

### Resolving a game you do not own is a preview, not a resolution

Everyone else opening the link gets a live view — pick a country, write and drag orders, submit them if assigned — but their Resolve is relabelled **👁 Preview result** and adjudicates on a *throwaway clone* of the position (`shadowGame()` / `previewResolve()` in `js/app.js`). The playback panel reads nothing but the history entry it is handed, so the whole step-through, the animation and 📋 Copy results all work unchanged while the stored game is never touched; closing the playback re-renders the live position over the top.

The old behaviour resolved the viewer's own copy, and only after an auto-publish deadline had passed. That had it backwards in both directions. It let a stray click silently walk a player's board a turn ahead of the table's — the divergence that makes someone plan against a position nobody else can see — while *withholding* the harmless and genuinely useful half. Because previewing costs nothing now, it is offered at all times: guess what the other six will do, preview it, and 🌿 **Continue in a sandbox** if the outcome was worth keeping.

A preview keeps `Continue ➜` (relabelled *▶ Play the moves*) so the animation still plays, but it stops on the resulting position instead of advancing a phase — there is no next phase to advance into.

That leaves branching as the single escape hatch from every read-only situation, so it is reachable from everywhere: ⚙ Settings, the History panel, and the preview itself. A branch records where it came from (`branchedFrom`), shows it, and offers **↩ Open source game** to get back.

### The ● pill: saying out loud what boardDirty() already knew

`boardDirty()` and `publishedState` already tracked the game master's position moving on from the shared link, but the only thing they drove was a *disabled button inside a closed menu* — so a resolved-but-unpublished turn looked exactly like a published one. That is half of "losing track of the published state": the fact was computed and then not communicated.

So the same fact gets a **● pill** in the topbar, naming the phase the players are still looking at (`S.phaseLabel(game.publishedState)` — the snapshot carries year/season/step, so no new bookkeeping was needed) and clickable to publish. Alongside it, ⚙ → **⟲ Revert to published** resolves the divergence the other way: refetch the gist and throw the local copy away. It deliberately keeps the order box, since an unsubmitted draft is the one thing here worth more than the position, which can always be re-fetched. ● publish and ⟲ revert are then the two ways out of a divergence — push the local copy to the link, or drop it and take the link's.

A viewer's copy heals itself anyway (their home-screen rows always reload through the gist), which is why the pill is the game master's alone. The confirmations follow the same line: editing the official board, undoing an official turn and walking away from an unpublished one all ask first; nothing in a sandbox ever does.

### Orders are never state, but only the box says so

A drag on the map looks identical whether it is a draft, a submission or the official record, so the order box names which: it is titled *Draft orders* for anyone who does not own the game, and carries a one-line note per role. For an assigned player there is one more distinction worth surfacing — **submitted** and **what is in the box now** are different things the moment they drag anything. So the submission status compares the two (ignoring comments, spacing and case) and says *"the box no longer matches what you submitted"* rather than a ✓ that refers to orders no longer on screen.

---

## Online play: submissions are gist comments

Only a gist's owner can write its files — gists have no collaborators — so players cannot write their moves into the game gist directly. Three transports were weighed:

- **Gist comments (chosen).** Any GitHub account can comment on a public gist with a `gist`-scope token. Each player keeps exactly ONE comment (a marker line + JSON payload, see `ORDERS_MARKER` in `js/publish.js`), created empty and edited in place on every submission — see *A mailbox is created empty* below, which is not an optimisation but the thing keeping orders out of the other players' inboxes. Comments are separate API objects, so simultaneous submissions from different players **cannot conflict** — the deciding property, since everyone submits as the deadline closes in. GitHub stamps each comment with its author's login, so a submission cannot be forged. Multi-device support comes free: the token resolves to a login (`GET /user`), and the comment is found *by login*, not by device or token string.
- **Per-player gists** would also be conflict-free, but every player would have to create an orders gist and get its ID registered with the GM — reintroducing the coordination the feature removes — and unauthenticated polling of N player gists runs into GitHub's 60 req/hr/IP limit.
- **A repo per game** (players as collaborators) matches the naive mental model, but needs broad `repo`-scope tokens, invite acceptance per player, retry logic for the contents API's concurrent-commit 409s, and a second storage backend beside gists.

The published per-power files (`moves-<power>.json`) have a **single writer** — the GM's token, used by the app's publish buttons and by the optional Action — so they cannot conflict either. Each file keeps one entry per year/season/step: history stays as a record, and only the entry matching the game's current phase is ever loaded into the order box. The publish step writes a power's entry only if the phase has none yet, so editing a comment after the deadline is inert; the GM un-publishes (✖) to deliberately reopen a power's window.

### A mailbox is created empty, and only ever edited

**GitHub emails the body of every newly created gist comment to everyone subscribed to the gist** — the owner plus everyone who has already commented, which in a running game is the whole table. So the original design, where a player's first submission *created* a comment containing their orders, mailed those orders to their opponents. Players were finding each other's moves in their inbox, unasked.

There is no way to switch that off from either end. GitHub's notification settings have no gist category, and gists have no Unsubscribe control ([community #60097](https://github.com/orgs/community/discussions/60097)) — so it could never have been fixed by asking players to change a setting. What GitHub *does* offer is an asymmetry: **creating a comment notifies; editing one never does.**

That is the whole mechanism. Each player's comment — their **mailbox** — is created with `MAILBOX_BODY`, a placeholder holding no orders, and every submission thereafter is a `PATCH`. Nothing in the app may ever create a comment carrying *readable* order text.

The mailbox is created **when the player opens the game**, not when they first submit — `ensureMyMailbox()` on the `refreshOnlineStatus` path. Both would keep orders out of the mail, but creating it at submit time would still fire the one "X commented" notification at the moment they submitted, leaking the timing. Created on load, that single notification lands hours or days earlier and says nothing. It is also free: `refreshOnlineStatus()` has already fetched every comment, so "do I have a mailbox?" is a lookup in memory, and the POST happens at most once per player per game.

**Nothing polls the network on a timer**, and it is worth being precise about that, because both the comment list and the mailbox check hang off it. `refreshOnlineStatus()` runs on game load, on 🔄/⬇ Load moves, after a submit or a publish, when the submissions modal opens, and — in the GM's browser, in auto mode, once a deadline has passed — from `autoPublishIfDue()`. The 60 s `setInterval` calls `renderOnlineUI()`, which re-renders from the cached `online` object and touches nothing; the 1 s interval ticks the countdown chip alone. Both would be *cheaper* still if they did less, but neither is a network cost. What that buys is the 60 req/hr anonymous rate limit staying comfortable for a household sharing an IP, and what it costs is that a player only learns their opponents have submitted when they ask — a deliberate trade, since correspondence Diplomacy has no reason to be live.

Two consequences worth holding onto:

- **`created_at` no longer approximates a submission time** — it is when the mailbox was made, possibly days earlier. `updated_at` still means exactly "last submitted", which is what the deadline rule below actually reads. `findSubmission()` (`js/submission-format.js`, imported by both the app and the Action) does not backstop `updated_at` with `created_at`: an absent edit stamp must read as *unknown*, resolved in the player's favour deliberately by `submissionOnTime()`, not silently by a stale date.
- **A mailbox must never parse as a submission.** `MAILBOX_BODY` starts with `ORDERS_MARKER` so `findMyMailbox()` recognises it, but omits `power`/`year`/`season`/`step` so `parseSubmission()` rejects it — an empty mailbox reads as "— waiting", never as a submission of no orders. `findMyMailbox()` also prefers a real submission over a bare placeholder, and ignores comments without the marker, so an ordinary chat comment on the gist is never overwritten.

#### How GitHub's notification mail actually works, and why an empty POST buys nothing

Everything above assumes the notification GitHub sends on creation reflects the comment *as created*. **It does not**, and getting this right is what the rest of the design turns on.

**Notification mail is queued, and the body is composed when the job runs — not when the comment is posted.** GitHub's own [February 2025 availability report](https://github.blog/news-insights/company-news/github-availability-report-february-2025/) describes notifications as worker pools draining a queue: during a 2h19m incident on 25 February 2025, "~10% of all notifications [took] over 10 minutes to be delivered, with the remaining ~90% being delivered within 5-10 minutes", caused by "worker pools running too close to capacity". Healthy baseline is faster than that, but it is still *a queue*, measured in seconds and minutes rather than milliseconds. Nothing about the latency is documented or promised.

That the body is composed at dequeue rather than capture is visible from both sides:

- **From this game's gist.** A comment created at `20:40:39` and edited at `20:40:40` — one second — was mailed out **carrying the orders**. Eleven minutes earlier in the same gist, a mailbox created at `19:35:09` and first written at `19:38:43` — 3m34s — mailed only the placeholder. Same code, same evening; the only variable was the gap.
- **From everyone else's complaints.** The standing community request for a [send delay](https://github.com/orgs/community/discussions/131581) exists precisely because a comment fixed *shortly* after posting still reaches inboxes in its original form, while GitHub [never notifies on an edit at all](https://github.com/isaacs/github/issues/310). Both fit one model: the mail carries whatever the comment said when the worker got to it, and after that nothing updates it.

**So a POST-then-PATCH pair is a race against a queue you cannot see, and a one-second gap loses it almost every time.** Three consequences:

- **Create the mailbox as early as possible, and prefer that path exclusively.** A gap of minutes-to-days beats the queue with room to spare; a gap of seconds does not. That is the entire value of `ensureMyMailbox()` running at game load, and it is a *probabilistic* defence, not a guarantee — which is why order text is sealed as well.
- **Do not post an empty comment merely to edit it a moment later.** It costs an extra request to buy a sliver of a chance the worker happens to run inside that one second. When the submit path has to create a comment (`createSubmission()`, `js/publish.js`), it posts the sealed submission outright: the mail carries ciphertext whenever it is composed, so there is nothing left for the split to protect. The single exception is a game with **no seal key**, where the body would be readable and the sliver is the only thing on offer — that path still posts empty and edits, and is flagged in the UI as the stopgap it is.
- **A fixed waiting period before a first submission was considered and rejected.** It would have imposed a real, visible cost on every player in exchange for a guarantee it could not make: pick ten minutes and a queue backed up past ten minutes still leaks. Encrypting the body removes the race instead of betting on it.
- **Never decide "do I have a mailbox?" from anything but a freshly fetched comment list.** A remembered `localStorage` id (added to make resubmits read-free) was consulted *first* and never verified, so after a player deleted their comment the load-time creator concluded there was nothing to do — and the submit path did the creating, POST and PATCH one second apart. Finding a mailbox in the fetched list is what *records* the id; the id is only ever a PATCH target, never evidence of existence. The freshly created comment is folded into `online.comments` via `rememberWrite()` so a lagging list cannot provoke a duplicate, and there is deliberately no "made one this session" latch — a mailbox deleted mid-session must be remade the next time anything refreshes.
- **The submit path may create, as a last resort.** If a player reaches Submit with no mailbox — creation at load failed, or their comment was deleted since — `createSubmission()` writes it there and then rather than making them press the button twice. See the queue discussion above for why that is one POST and not two.

#### Never read a stale comment list

The rule above is only as good as the answer to "do I already have a mailbox?" — because the one action taken when the answer is *no* is a POST, and a POST is what mails orders to the table. The first implementation asked GitHub that question over `listComments()` on the submit path, and got it wrong often enough to leak orders three times in one evening.

The culprit was the browser's own HTTP cache. GitHub stamps API reads `Cache-Control: max-age=60`, so for a minute after any read the browser answers the next one out of memory without touching the network. A player whose mailbox was created when they opened the game and who submitted 41 seconds later got a cached list from *before* their mailbox existed, concluded they had none, and created a second comment — with their orders in it. The same window made rapid resubmits create a comment per click. It presents as an intermittent bug, because it only happens inside the 60 seconds.

Two changes, because one is not enough:

- **`ghRead()` bypasses the cache.** Authenticated reads come back `private`, so this browser's cache is the only copy: `no-store` skips it, and a token buys 5,000 requests/hour. Anonymous reads are `public` and may sit in a shared cache we cannot reach, so they use `no-cache` — revalidation, which keeps the 304s GitHub does not charge against the far tighter 60/hour anonymous budget.
- **The mailbox's comment id is remembered in `localStorage`.** Knowing it, `submitOrders()` never asks the question at all: it PATCHes that id directly, with no read in front of it. Only a 404 (the comment was deleted) may fall back to the listing path — auth failures, rate limits and network errors surface as failures, because retrying those down a route that can POST is exactly how orders get mailed. Freshness protects the general case; not needing to ask removes it.

The same staleness had a second, visible symptom: the refresh that follows a submit read a cached copy of the just-edited comment, saw the old body, and left the UI insisting the orders had not been resubmitted. So `app.js` also holds the comment GitHub returns from its own write (`justWrote`) and folds it into `online.comments` until a poll comes back carrying it. Our own writes are the one thing we know for certain, and the display must never contradict them — which covers GitHub's replicas lagging a write as well as the cache.

Finally, **where duplicates already exist, the most recently edited comment wins** — `findSubmission()` and `findMyMailbox()` both rank that way, and must keep agreeing, or a resubmit would edit one comment while the UI read another. Games played before the fix carry duplicates, and preferring the older one is wrong twice: it shows superseded orders, and it would let a player submit on time, edit a duplicate after the deadline, and be judged by whichever stamp suited them.

### One wire format, two readers

The comment format — the marker, the payload, `findSubmission`/`findMyMailbox`, `upsertMovesEntry` — has always had two readers: the browser app and the unattended Action in `tools/publish-moves.js`. For a long time that meant two hand-kept copies, and this document asking them to stay in step. That is not a mechanism, and the rules are exactly subtle enough to drift: a marker matched as a whole line rather than a prefix, a mailbox that must *not* parse as a submission, last-edited-wins, `updated_at` never backstopped.

So the format lives in **`js/submission-format.js`**, which imports nothing but itself — no `fetch`, no token, no `localStorage` — and both readers import it. `js/publish.js` re-exports every name so its own importers were unaffected; `tools/publish-moves.js` lost ~120 lines and now shares `js/seal.js` for unsealing too. `diplomacy/package.json` (`"type": "module"`, no dependencies) is what lets Node read the app's modules as the ES modules the browser already loads directly.

The practical gain is that `test/submission-format.test.js` now covers the Action's behaviour as well as the app's — the Action previously had no tests at all, and it is the thing that writes to a live game unattended.

### Orders are obfuscated, not secret

Order text is encrypted with AES-GCM-256 (`js/seal.js`) under a key kept in the game's own gist, as `seal-key.json`. **Everyone who can reach the game can therefore decrypt** — that is the design, not an oversight.

The threat being addressed is *accidental* reading, and it is the only one that has ever actually happened: orders arriving in a player's inbox unasked, or sitting in plain sight on a gist page someone opens for another reason. Ciphertext defeats that completely, whenever the leak occurs — which is the property the timing mitigation above could never offer. What it does not defeat is a player who decides to decrypt: the key is right there. Among friends that line — *you would have to mean it* — is the one worth drawing, and it costs nothing else.

Everything else follows from putting the key in the gist:

- **No ceremony, nothing to lose.** No key exchange, no per-player setup, no recovery story when someone reinstalls their browser. The GM's first load of a game with no key writes one; every other client reads it out of the gist it was already fetching, so sealing costs **zero extra requests**.
- **The unattended Action still works.** `tools/publish-moves.js` reads the same file and unseals with Node's WebCrypto. A per-player scheme would have required a key the Action could not have.
- **Decrypt once, at the edge.** `unsealComments()` (`js/publish.js`) rewrites each sealed comment into its cleartext equivalent — same id, author and timestamps — right after `listComments()` in `refreshOnlineStatus()`. Everything downstream (`parseSubmission`, `findSubmission`, `powerOnlineStatus`, `revealedEntry`, `gmLoadOrders`, `autoPublishIfDue`) keeps working on plain synchronous strings and knows nothing about sealing. That is what kept the change small.
- **Phase metadata stays cleartext.** `power`/`year`/`season`/`step`/`submittedAt` are needed by the status line, the deadline gate and `findSubmission`, and they give away nothing GitHub's own comment listing doesn't already publish. Only the order text is sealed, with `gistId|power|year|season|step` bound as AES-GCM `additionalData` so a blob cannot be replayed into another phase or under another power.
- **A submission that won't open is treated as absent**, never as a power that ordered nothing — visibly "waiting" in the app, explicitly skipped with a log line by the Action.
- **AES-GCM rather than something home-made.** WebCrypto is in both the browser and Node, so it costs no dependency and *less* code than a hand-rolled cipher, and its output is indistinguishable from random — no line structure, no repeated blocks, no telling an army from a fleet by shape. A XOR pad or simple substitution would have leaked exactly the patterns worth hiding.
- **Falling back to cleartext is allowed, but never silent.** A game with no key (one published before this shipped, whose GM hasn't reopened it) still submits, and the status line says `unencrypted` outright.

Genuine secrecy — orders hidden from other players *and* from the GM until the reveal — is a different and much larger design, written up in [`proposals/sealed-orders.md`](proposals/sealed-orders.md) and deliberately not built: it needs per-player ECDH keys, a wrapped GM key, a rotation story, and it takes the Action's ability to publish away with it.

**A note for future games: `LEGACY_MARKER_V1` is temporary.** The wire marker is now the unversioned `DIPLOMACY-ORDERS`; `DIPLOMACY-ORDERS v1` is still *recognised* (never written) purely so the game that was in progress when sealing shipped kept its mailboxes and its already-submitted orders. Every such branch is tagged `// LEGACY v1 — remove once the current game ends` in `js/submission-format.js` — `grep -rn "LEGACY v1"` finds them all, and deleting them once a fresh game starts is expected, not a regression.

**Deadlines are confirmed, not scheduled — and enforced by the reader, not a runner.** Only the GM writes the `deadline` timestamp in game.json, confirming each phase's deadline in the app (+1 week is the default rhythm; +24/48 h fit retreats and builds). Nothing runs *at* the deadline: GitHub Actions has no "run once at time X" primitive, and the hourly-polling cron that first papered over that was dropped as waste. Instead the deadline is a property any client can check against public data — GitHub stamps every comment with an author login (identity) and an `updated_at` (edit time), so every viewer independently agrees on which submissions beat the deadline. A comment edited after the deadline is void: no late entries, and no window where a runner has seen the moves but a player can still change them.

**Two publish modes**, the ⚡ Auto-Publish switch at the top of the ⏰ Deadline panel. *Manual* (default): the GM's order box (`panel-orders`) is hidden while a deadline is open — `gmOrdersLoaded` in `app.js` — and only appears once they deliberately ⬇ Load orders, which is itself disabled until `!ordersOpen()` (deadline passed, or none set at all). Loading fills the box and hands it to the normal Resolve flow, routed through the same throwaway-preview path (`previewResolve`'s `gmPublish` flag) a read-only viewer's preview already used — so a typo caught mid-review just means ← Back to the still-loaded box, never a committed-then-undone phase. 📣 Publish results (`gmPublishPreview`) is the only thing that touches the real game: it resolves for real with the exact orders the preview used, writes each power's `moves-<power>.json` entry, and pushes. *Auto*: `autoPublishIfDue()`, polled from the GM's own browser on the existing 60s tick, does that same load → resolve → publish sequence itself the instant the deadline passes — no GM action, and nothing fires on a merely-*cleared* deadline, since `deadlinePassed()` is false whenever `game.deadline` is null. Manual is the default because a typo caught before publishing costs nothing, while one caught after has already leaked information.

The switch and the controls it governs are **in one panel, and only one mode's controls are on screen at a time** (`renderDeadlinePanel()`). Both used to be shown at once, from two places: the switch lived in the ⚙ Settings drop-down while ⬇ Load orders sat in the sidebar, so the setting and its consequences were never legible together — and in auto mode ⬇ Load orders was a *second* way for the GM to resolve the very phase `autoPublishIfDue()` was about to resolve itself. Two mechanisms advancing one board in one browser is the collision described under *A deadline belongs to a phase, not to a clock* below; the panel now hides the manual row entirely in auto mode, and says in words which path is live. The one exception is auto-publish standing down (no on-time submissions, `autoPublishIdleFor`): auto cannot pick that phase up, so the GM is the only way forward and ⬇ Load orders comes back, relabelled to say why.

For the same reason the GM's copy of ⬇ **Load submitted moves** (`btn-load-moves`, the Orders panel's online row) is gone — `loadMovesBtn.hidden = isOwnerView()`. It could only ever appear *after* ⬇ Load orders had already run (the Orders panel is gated on `gmOrdersLoaded`), so it showed the GM what they had just loaded, and in manual mode nothing is published yet, so its only possible answer was "no published moves for this phase". Two buttons for one act, disagreeing about it. It keeps both its other meanings untouched: a player reloading their own submission, a spectator loading the table's revealed moves. Both paths clear `game.deadline` on publish — a stale "already passed" timestamp must never carry over and silently auto-publish the *next* phase off an empty box; the GM (or auto mode, next time someone submits) confirms a fresh deadline every phase. The repo's GitHub Action remains a manually-dispatched convenience for copying reveals into the per-power files as a durable record.

**Auto mode lets players resolve locally at the deadline — the GM need not be awake.** `autoPublishIfDue()` only advances the *official* gist, and only from the GM's own browser, so a midnight deadline with a sleeping GM would otherwise freeze the board for everyone until the GM's tab next ticks. Since every on-time submission is already a public comment, an assigned player (read-only viewer) in auto mode can resolve the phase *locally* the instant the deadline passes: `resolveRevealedLocally()` gathers the on-time reveals — the same order-gather loop `autoPublishIfDue()` uses — runs `resolvePhase()` on the local game only (no gist write), and plays it out through the existing catch-up playback. The advance is marked `game.provisionalPhase`; when the GM's real publish later lands, `reconcileProvisionalPhase()` compares the two outcomes: identical (the common case — same adjudicator, same orders) just clears the flag, divergent (GM used late-resubmit or amended) rolls the provisional phase back via `undoLastPhase()` so the normal gist-driven catch-up replays the authoritative version. The GM still confirms the *next* deadline to move the game forward — the local resolve is a read-ahead, not an unattended runner. This path is gated on `publishMode() === 'auto'` and `isReadOnly()`, so it can never bleed into manual mode or interfere with the GM's own publish flow.

**The deadline gate reads GitHub's clock, not the device's.** `deadlinePassed()` compares against `trustedNow()` — the local clock corrected by an offset to GitHub's server `Date` response header, captured on every gist read (`getLastServerDate()` in `js/publish.js`, `online.serverOffset` in `app.js`). Because auto mode now reveals orders to players purely on a client-side time check, a naive `Date.now()` would let a player set their clock forward to peek early; the server-time correction closes that. It falls back to the raw local clock only until the first server date is seen (offline/first paint), which fails safe — no network means no reveal. Reading the raw gist comments directly through the API remains possible for anyone technical, in either mode — they are sealed, but with a key the gist hands out; that is the obfuscation caveat above, not a regression this introduces.

**Publishing the board is a separate, explicit act from resolving it.** The GM can resolve, undo, redo and edit the board freely after publishing — none of it reaches players until ☁ Publish changes is clicked. That button is disabled whenever the local position already matches what's live, computed by comparing `state.js`'s `boardSnapshot()` (year/season/step/units/scOwners/pending/history/redoStack) against a copy saved at the last successful publish (`game.publishedState`, itself stripped back out before anything is sent to the gist — it's local bookkeeping, not part of the position). Deliberately excluded from that comparison: the order box. Orders typed or dragged onto the board never touch the game object until `resolvePhase()` runs, so a GM can sketch out arrows to plan their own move without the app ever thinking there's something new to publish. Settings changes (deadline, publish mode, player assignments) still write to the same `game.json`, but they pass the last-published board snapshot as an override rather than whatever the GM's board currently looks like — otherwise confirming a deadline while mid-resolve would silently leak the new position as a side effect, defeating the point of the dirty check.

**A viewer's board follows the gist forwards by stepping, backwards by reloading.** Those are different situations and want different handling. When the gist has phases a viewer hasn't seen *on top of the ones they have*, they are flagged for ▶ Resolve new orders! (`catchUpTarget`) so each one plays out — dropping someone onto a new position without showing them how it got there is the thing catch-up exists to prevent. But when the gist's position is not one the viewer's history leads to — the GM undid a phase, or corrected the board in ✏ Edit board — there is nothing to step *through*: their copy is of a position that no longer exists. `syncViewerToGist()` in `app.js` takes the gist's position in that case and toasts to say why. The check compares the *position* (`viewerPosition()` — year/season/step/units/scOwners/pending/history), not the history length: an earlier length-only test could see forward motion and nothing else, so an undone phase left the viewer parked on it indefinitely, still able to replay orders the GM had since retracted, while a board edit — which never touches history at all — was invisible. `redoStack` is deliberately excluded from the comparison: it's the GM's private undo bookkeeping, and a viewer who caught up has cleared their own while the gist may still carry the GM's, which is not a divergence. Two copies are never taken this way: a browser holding a `provisionalPhase` (auto mode's optimistic local resolve) is *meant* to sit ahead of the gist, and `reconcileProvisionalPhase()` already owns that comparison; and the GM's own copy is never overwritten even while 🎭 Playing as their own power, since it may hold unpublished work — ⟲ Revert to published is their door.

Note that undoing a published phase does not retract it. Gist revisions are public and immutable, so every version ever pushed stays readable through the API; the undone phase also travels *in* `game.json`, since `redoStack` is published so redo survives moving browsers. Both are accepted for the same reason as cleartext submissions above — the gist is public and always was. What the reload fixes is narrower and real: a viewer's board silently disagreeing with the official one.

**Reads are anonymous-capable but authenticated when possible.** Everything a viewer reads — `game.json`, the `moves-<power>.json` files, the submission comments — is public, and reading must keep working with no token at all: a spectator handed a share link has no GitHub account, and that is the common case the feature is for. So no read *requires* auth. But GitHub's rate limit is 60 requests/hour shared across an IP anonymously versus 5,000/hour per user authenticated, and `refreshOnlineStatus()` spends two or three calls per refresh — so a household or classroom of players sharing one NAT exhausts the anonymous budget quickly, and the failure is invisible (that read path swallows errors to survive being offline, which leaves a stale board rendered as though it were current). Meanwhile nearly every *player* already holds a token, because submitting requires one. `ghRead()` in `js/publish.js` therefore signs a read whenever `getToken()` returns something and falls back to the anonymous request on 401/403, so a stale, revoked or wrong-scope token can never turn a working reader into a broken one. It buys headroom only — no polling was added on the strength of it, and the data returned is identical either way.

---

## Support and convoy without a keyboard

⇧-drop and Ctrl-drop are the fast way to write a support or a convoy, but a touchscreen has no modifier keys — on a phone those two orders could only be typed. So the same two orders get a pair of toggles, `🤝 Support` and `⚓ Convoy`, which arm the next drag: with one on, dropping a unit onto another writes a support (or convoy) instead of a move. The modifier keys still work and are unchanged; the toggles are an equivalent, not a replacement.

Where they live differs by size, because the constraints differ. On desktop they are ordinary topbar buttons next to ✏ Edit board. On mobile the topbar has no room and, more importantly, the toggle has to be reachable *while the map is being used* — so they are lifted out of the flow and floated over the map's top-right corner as two thumb-sized targets, below the ⋮ button and clear of it (`--topbar-h`, measured in `app.js`, keeps them under a topbar whose height depends on the phone).

They are **one-shot**: a mode switches itself off as soon as an order is written. Leaving it armed would silently turn the *next* intended move into another support, which is the kind of thing you only notice after resolving. A *failed* drop (nothing there to support, dropping onto a non-fleet) leaves the mode on, so the drag can just be retried. The toggles are hidden outside movement orders — during edit mode, playback, retreats, builds, and for read-only spectators — where they would mean nothing.

---

## Strict convoy: the route lives in the order text, picked on the map

The strict-convoy house rule (Game settings → Convoy house-rule) makes a convoyed army name every sea it is carried through, and succeed only if each named sea has a fleet ordered to convoy it and none is dislodged — no automatic best-route search, no alternate paths. Two design choices follow from the "order text is the one source of truth" invariant.

**The route is spelled into the move line, not a side-model.** A strict convoy is written `A Lon - NTH - Nwy`: the trailing province is the destination, the earlier ones are the sea route. `parser.js` already walked a chain of `- prov` hops for this; the only new output is `order.convoyRoute` (the intermediate seas) when there is more than one hop. Standard rules simply ignore that field — the engine still searches for any route — so the notation is safe to leave in an order under either ruleset, which is what lets the DATC suite and both test modes share one order set. The adjudicator's strict path check replaces the breadth-first "any undisrupted chain" search with a walk of exactly the named seas (`strictConvoyPath`), and a convoyed move that named *no* route is illegal and holds (you must spell it out). All of this is gated on `opts.strictConvoy`, so standard adjudication — and DATC 167/167 — is untouched.

**Auto-pick when the route is forced; ask only when it's a real choice.** Dragging an army to a convoy-only province under the rule looks at `convoyRoutes(units, from, dest)` — every simple chain of *fleet-occupied* seas that links origin to destination. No such chain → the drop is rejected with the same "no convoy possible" toast a plainly-unreachable move gets. Exactly one chain → that route is written straight away (`setOrder(... { route })`), because there was nothing to choose. More than one → the on-map picker opens so the player says which. The point of the rule is strategic control of the path, so any genuine ambiguity (two seas of equal length, or a longer detour) is offered rather than silently resolved; only a forced route is auto-filled.

**The picker builds a route the way a drag feels, and writes the same text a person would type.** The picker (`convoyPick` in `app.js`) outlines the candidate seas, and its arrow is drawn like a live drag: from the army through the seas chosen so far, ending in an arrowhead that follows the pointer, so the base advances sea by sea and the full route only reads as complete once it reaches the destination. Tapping the destination commits the same `A Lon - NTH - Nwy` line, re-parsed like any other — there is no parallel order object. Candidate seas come from `convoyRouteHops` restricted to `fleetWaters(units)`: a sea with no fleet can carry nothing, so offering it would only let the player build a route that must fail. (This is the one place the strict picker is *more* restrictive than the adjudicator, which still lets an ally's not-yet-visible fleet complete a named route; the picker is a construction aid, and building on empty water is never what the player means.)

**Two overlay layers because the outlines and the arrow live in different coordinate spaces.** The candidate/destination outlines are clones of the influence shapes, which sit under the `MouseLayer` transform, so they must be drawn into a layer that carries that same transform (`PickerHighlightLayer`, a sibling of the hover layer) — drawing them into an untransformed layer is exactly what made the highlights appear shifted off their provinces. The route arrow, by contrast, is built from `center()` coordinates in the same untransformed space as the placed order arrows, and goes into `PickerArrowLayer`, inserted *directly beneath the unit symbols* so the preview layers like a real move arrow (the old picker drew over the units). A placed strict-convoy arrow bends through its seas via `_polyArrow`; `stripResult` (`state.js`) keeps `convoyRoute` in the compacted history entry so the resolution arrow bends and the move animation slides along the route (`_convoyMoveFrames`) instead of straight across the map.

---

## Submissions are hidden by default, not just gated

Who's submitted, and their actual order text, used to live in a permanent sidebar section (`#panel-players`) and a small status table every player could see in the Orders panel. Both are gone. The status table was visible to *everyone*, not just the GM — a real privacy leak, since a game where players can see their opponents' submission timing is a worse game (it turns "did they submit yet" into a signal). And the GM's own review tools sat open on the main screen at all times, whether or not there was anything to review.

Both now live behind one shared `#submissions-modal`, reachable from **⚙ Settings → 🔍 Submissions**, GM-only and ungated by the deadline (the "something's wrong, check one player's order" case a GM occasionally needs regardless of where the clock stands). It is status-only bar one exception: **✖** un-publishes a power for the phase so they can resubmit even past the deadline — the one thing the load→resolve→publish flow itself can't do, since that flow works on the whole table's box at once. The per-power force-publish (📥) and box-override (📝) actions this modal used to carry are gone: the GM now makes every adjustment — a late grace, a corrected typo — directly in the loaded order box before publishing (see "Two publish modes" above), so a second, parallel place to publish from would just be a second way for the box and the record to disagree. Neither the modal nor the order box is shown unless the GM deliberately opens/loads it — the point isn't just *who* can see it, but that a GM who doesn't want to know isn't confronted with it by default either. `renderSubmissionsModal()` only runs while the modal is actually open (checked in `renderOnlineUI()`), rather than on every render pass, since it's no longer part of the always-visible page.

---

## The deadline countdown is one urgency value, read in three places

`deadlineUrgency()` (`js/app.js`) is the single `'none' | 'warn' | 'danger'` classification — no deadline set, counting down, or passed — behind every place the app signals it: the topbar's always-visible `DD:HH:MM:SS` chip (ticking on its own 1 s interval, deliberately separate from the 60 s online-status tick — that tick is a re-render from cache, not a network read, the one exception being the GM's own browser in Auto-Publish mode, where it is also `autoPublishIfDue()`'s clock), the sidebar's `#panel-deadline` box (a subtle background/border tint), and the Orders panel's `#deadline-info` hint text. Three call sites reading one function, rather than three places independently comparing `Date.now()` against the deadline, is what keeps "orders are open" from ever disagreeing with itself across the page.

The same 1 s tick also re-gates the ⏰ Deadline panel's **+1 week / +48 h / +24 h** steps (`renderDeadlineButtons()`), for the same reason and at the same cost: whether "the previous deadline + 24 h" has slipped into the past is a per-second fact about the deadline, and it is attribute-only work on three buttons. See *A deadline chains from the last one, not from the clock*.

The countdown lives in the topbar — not just the sidebar, where the old deadline text was easy to miss — because it has to be legible to every viewer, GM or player, on both mobile and desktop, and it's the one piece of state that changes every second regardless of anyone's actions. Orders are treated as closed both before any deadline is ever set and after one passes: with no deadline there is nothing to have been "on time" against, so leaving submission open in that state was really just a confusing default, not a real allowance.

---

## 🎭 Play as: a GM's own player position is real, not simulated

`⚙ Settings → 🎭 Play as` only appears once the GM has assigned their own GitHub login to a power in `👥 Set players` — at that point `game.assignedPower` resolves for the owner exactly like it does for anyone else (`refreshOnlineStatus()` no longer excludes owners from that lookup). Switching to `🧑 Player` sets `game.playAs = 'player'`, a durable field on the game object saved like any other setting, not session-only state — closing the tab and coming back leaves the GM exactly where they left off.

`isPlayingAsPlayer()` (`js/app.js`) is the one predicate this depends on: `game.isOwner && game.assignedPower && game.playAs === 'player'`. `isReadOnly()` and `isOwnerView()` both fold it in, so once it's true the GM's browser runs through the *exact same code paths* a real player's browser does — private draft orders, a real `📤 Submit moves` that posts a real gist comment under their own login, deadline enforcement, preview-only resolve. There is no separate debug flow to keep in sync and nothing to clean up on the way out: switching back to `👑 Game Master` only changes `game.playAs` back, it never touches a submission, because the submission they made while playing was always a genuine one.

`gameMode()` is unaffected by any of this — it already derives from `isOwnerView()`, not raw `isOwner`, so it naturally reports `player` while `isPlayingAsPlayer()` is true and `gm` otherwise.

The one thing that genuinely *is* suspended while playing as a player is auto-publish — see "A deadline belongs to a phase, not to a clock" below for why running the game and playing in it cannot both be live in one browser.

---

## Repositioning a piece lives in ✏ Edit board, as a `Move` tool

A sandbox exists to think in, and thinking is "what if that army were over *here*?" at least as often as "what if it moved there?". That free repositioning used to be a separate `✋ Arrange` toggle (Alt-drag / a sticky mode) available in any sandbox phase. It was removed: it duplicated what the board editor already does, and a sticky mode that silently teleported pieces was exactly the kind of foot-gun the editor's explicit on/off avoids.

Instead it is folded into ✏ Edit board as the **`Move` tool**, sitting beside Army / Fleet / SC owner / Erase. In edit mode a drag repositions the dragged unit (`editDrop`) regardless of which tool is selected — ignoring adjacency, unit-type routing and whose phase it is — so `Move` isn't the default (Army stays default, keeping the empty-sandbox "click to place your first units" flow intact). What `Move` adds is a *click*-that-does-nothing mode, so an existing board can be dragged and panned without a stray tap placing or erasing anything. Being inside the editor is the loud, deliberate signal that a drag now moves pieces rather than writing orders — replacing the old amber ring.

The full ✏ Edit board (move, place, erase, set supply-center owners, reset to 1901) is available in *every* sandbox rather than only an empty one — a branched position is exactly where you want to add a hypothetical fleet. On a published game it stays available to the game master, who occasionally has to correct the official board by hand, but asks first and points at branching as the alternative.

---

## A deadline belongs to a phase, not to a clock

`game.deadline` is an instant, and for a long time that was all it was — every gate in the app asked only "is it in the past?". That question is incomplete, and a live game paid for it: a Spring 1901 deadline outlived its own phase and auto-published an all-hold Fall 1901 that no player had ordered a single move in.

The route there took three separate weaknesses, and the fix closes all three, because any one of them alone will eventually find another route:

**The deadline is stamped with its phase.** `setDeadline()` writes `game.deadlineFor = {year, season, step}` alongside the timestamp, and `deadlineIsForCurrentPhase()` is what `autoPublishIfDue()` gates on. A deadline is a promise about one specific set of orders — "Spring 1901 is due at 11pm" — and the moment the board moves past that phase the promise is spent, whatever the clock says. It is deliberately lenient about a *missing* stamp so games published before this keep resolving; the other two guards cover that case. The stamp travels with the deadline everywhere the deadline does: `refreshOnlineStatus()` re-reads it from the gist (authoritative for both), and every path that clears `game.deadline` clears it too.

**A phase nobody submitted for is never auto-published.** `autoPublishIfDue()` stands down when *no* power has a readable, on-time submission, and says so once. An unattended whole-board all-hold is not a plausible turn — it is what this class of bug looks like on the way out, and it is worth refusing on its own merits even when the cause is innocent (everyone genuinely forgot). Note the test counts submissions, not moves: a power that submits nothing but holds has said something, and a phase where every power chose that resolves normally.

**Running the game and playing in it cannot both be live in one browser.** `autoPublishIfDue()` was gated on the raw `game.isOwner` fact rather than `isOwnerView()`, reasoning that 🎭 Play as is a view change, not a different browser, and the GM's duty to publish shouldn't lapse because of where they're looking. But in that mode the GM is also offered the player-side **▶ Resolve new orders!** button (`resolveRevealedLocally()`), which advances the board optimistically, writes nothing, and — correctly, for a player — leaves the deadline alone. One GM click, one 60-second tick, and auto-publish woke up behind an already-advanced board holding an already-spent deadline. Two mechanisms for advancing the same board, one authoritative and one optimistic, cannot run in the same browser; `isOwnerView()` makes the view the switch between them. The cost is real and accepted: a GM who leaves their browser in 🧑 Player never auto-publishes. That is the safe direction — nothing is published that the GM didn't ask for — and it matches what play-as already promises everywhere else, that the GM's browser runs the player's code paths and no others.

### Known limitation: a GM parked in Player view never auto-publishes

This is the one consequence of the fix above worth stating plainly, because it is a real regression in capability and it is **not** the intended end state.

A game master who leaves their browser in 🧑 Player mode gets no auto-publish at all. The deadline passes, their own ▶ Resolve new orders! shows them the outcome locally, and the gist simply stays where it is until they switch to 👑 Game Master (next tick publishes) or push it themselves with ☁ Publish changes. Nothing is lost or corrupted — the deadline and its `deadlineFor` stamp stay put, `provisionalPhase` marks the local resolve as unconfirmed, and `reconcileProvisionalPhase()` clears that flag once the gist catches up — but a GM who assigned themselves a power, which is the common case, has to remember to change hats. That is a worse deal than they had before, traded for never publishing a turn nobody ordered.

The right fix is not to re-widen the gate back to raw `isOwner` — that is exactly the collision described above. It is to make the authoritative publish independent of which view the browser is showing, so it can run from Player view without the optimistic path being able to feed it a board it has already advanced. Roughly, in rough order of appeal:

- Have the optimistic resolve and the authoritative publish be the *same* act for an owner: `resolveRevealedLocally()` in a GM's browser could confirm and publish what it just resolved (it already resolves from the same on-time submissions `autoPublishIfDue()` would use, so the outcome is identical) rather than leaving a provisional phase for something else to find.
- Or make `autoPublishIfDue()` publish the phase named by `deadlineFor` rather than "whatever phase is on the table now" — it would then be indifferent to a board that has moved on optimistically, and could safely run in any view.

Either way the invariant to keep is the one the incident violated: **the phase that gets published is the phase the deadline was confirmed for, resolved from that phase's submissions.** Any future change here should be checked against that sentence first.

One related leak the same incident exposed: `stripForPublish()` now drops `provisionalPhase` and `playAs`. Both are per-browser session facts, and a published `provisionalPhase` is worse than noise — a viewer who inherits one is treated by `syncViewerToGist()` as deliberately ahead of the gist, and quietly stops reconciling with it.

---

## A deadline chains from the last one, not from the clock

**+1 week** means *one week after the deadline this one follows* — not one week after the press. A GM who confirms Saturday's midnight deadline on Sunday afternoon still gets midnight the following Saturday, so the table's rhythm is a property of the game rather than of when the GM happened to be at a keyboard. `deadlineChainBase()` is that base, and `bumpDeadline()` uses nothing else; only a game that has never had a deadline at all counts from the clock.

That needs one piece of state, because **publishing a phase clears `game.deadline`** (it must — see the same paragraph above: a spent timestamp carried into the next phase is what auto-published an all-hold Fall 1901). Without somewhere to keep it, the chain would break at exactly the press that matters: confirm the next phase's deadline right after publishing and there is no previous deadline left to chain from. So `clearDeadline()` — the *one* place a deadline is taken away, called by ✖ Clear, `gmPublishPreview()` and `autoPublishIfDue()` alike — stashes it as `game.lastDeadline` on the way out. It travels in `game.json` like the deadline itself (`stripForPublish()` only removes named fields), so a GM who moves browsers keeps the rhythm.

**A step whose window has gone by is greyed out and says so.** Chaining makes it possible for +24 h to land in the past — press it two days after the deadline it counts from and you would be confirming a deadline that has already expired, re-closing submissions the instant they opened. `bumpUnavailableReason()` is the single test (`base + hours <= trustedNow()`, GitHub's clock, matching `deadlinePassed()`), read both by `renderDeadlineButtons()` to gate the button and by `bumpDeadline()` to refuse the press — the gate is the UI, the guard is the invariant, and both quote the same sentence naming both dates. The gating runs on `updateDeadlineCountdown()`'s existing 1 s tick, because "has this window closed?" is the same per-second urgency question the countdown chip already asks. The enabled buttons carry the resulting date in their `title`, which turns out to be worth having on its own: *+1 week* is much easier to confirm when it reads *Sets the deadline to Sat 13 Sep, 00:00*.

---

## A greyed-out button must be able to say why

A natively `disabled` button fires no click event at all — not on itself, not on any ancestor. So the app's answer to *"why can't I submit?"* was a `title` tooltip, which does not exist on a touchscreen, on the one control most likely to be pressed by someone confused on a phone.

`setGated(btn, reason, enabledTitle)` marks a button unavailable with `aria-disabled="true"` plus a `data-gated-reason`, and **leaves it clickable**; a single capture-phase listener on `document` swallows the click and toasts the reason instead of letting the handler run. One listener, so no button has to opt into the behaviour beyond being gated this way, and the CSS mirrors `button:disabled` exactly (`opacity: .45`) with `cursor: help` as the only tell.

Two rules keep it honest:

- **The reason is the same sentence the page already gives.** Every gated site reuses the string its visible status line uses for that state (`#submit-status`, `#deadline-info`, the load button's title), so the toast and the page can never offer two different explanations of one fact.
- **Transient in-flight guards stay natively `disabled`.** `btn.disabled = true … finally { btn.disabled = false }` around an in-progress request wants *real* inertness — a second click must do nothing at all, and there is nothing to explain about a button that is busy for 400 ms.
