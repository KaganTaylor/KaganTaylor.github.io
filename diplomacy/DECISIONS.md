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

The topbar's actions live behind one ⚙ Settings drop-down at every width (`#settings-wrap`, which must stay `position: relative` for the menu to anchor to the button rather than the page). They used to sit inline on desktop, with `display: contents` dissolving the wrapper; that stopped scaling once the menu held publish, view/revert published, branch, game settings, export, players, submissions and the play-as control.

**⚙ Settings must never be the item pushed off the right-hand edge** — on a published game it is the only way to reach the publish actions, including switching `🎭 Play as` back to `👑 Game Master`. Everything else in the topbar is `flex: none`, so anything added there has to buy its room from something: `#game-name` is the one item allowed to shrink and ellipsise, `#deadline-countdown` drops to an icon, and `#phase-label` is hidden outright on mobile because `Board.setPhaseText()` already prints it into the corner of the map.

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

- **Gist comments (chosen).** Any GitHub account can comment on a public gist with a `gist`-scope token. Each player keeps exactly ONE comment (a marker line + JSON payload, see `ORDERS_MARKER` in `js/publish.js`) and edits it in place to resubmit. Comments are separate API objects, so simultaneous submissions from different players **cannot conflict** — the deciding property, since everyone submits as the deadline closes in. GitHub stamps each comment with its author's login, so a submission cannot be forged. Multi-device support comes free: the token resolves to a login (`GET /user`), and the comment is found *by login*, not by device or token string.
- **Per-player gists** would also be conflict-free, but every player would have to create an orders gist and get its ID registered with the GM — reintroducing the coordination the feature removes — and unauthenticated polling of N player gists runs into GitHub's 60 req/hr/IP limit.
- **A repo per game** (players as collaborators) matches the naive mental model, but needs broad `repo`-scope tokens, invite acceptance per player, retry logic for the contents API's concurrent-commit 409s, and a second storage backend beside gists.

The published per-power files (`moves-<power>.json`) have a **single writer** — the GM's token, used by the app's publish buttons and by the optional Action — so they cannot conflict either. Each file keeps one entry per year/season/step: history stays as a record, and only the entry matching the game's current phase is ever loaded into the order box. The publish step writes a power's entry only if the phase has none yet, so editing a comment after the deadline is inert; the GM un-publishes (✖) to deliberately reopen a power's window.

Submissions are cleartext. Real pre-deadline secrecy on public infrastructure would need client-side encryption (considered, deferred); "don't read the gist comments early" is a house rule, like not reading someone else's postcard.

**Deadlines are confirmed, not scheduled — and enforced by the reader, not a runner.** Only the GM writes the `deadline` timestamp in game.json, confirming each phase's deadline in the app (+1 week is the default rhythm; +24/48 h fit retreats and builds). Nothing runs *at* the deadline: GitHub Actions has no "run once at time X" primitive, and the hourly-polling cron that first papered over that was dropped as waste. Instead the deadline is a property any client can check against public data — GitHub stamps every comment with an author login (identity) and an `updated_at` (edit time), so every viewer independently agrees on which submissions beat the deadline. A comment edited after the deadline is void: no late entries, and no window where a runner has seen the moves but a player can still change them.

**Two publish modes**, the GM's ⚙ Settings choice. *Manual* (default): the GM's order box (`panel-orders`) is hidden while a deadline is open — `gmOrdersLoaded` in `app.js` — and only appears once they deliberately ⬇ Load orders, which is itself disabled until `!ordersOpen()` (deadline passed, or none set at all). Loading fills the box and hands it to the normal Resolve flow, routed through the same throwaway-preview path (`previewResolve`'s `gmPublish` flag) a read-only viewer's preview already used — so a typo caught mid-review just means ← Back to the still-loaded box, never a committed-then-undone phase. 📣 Publish results (`gmPublishPreview`) is the only thing that touches the real game: it resolves for real with the exact orders the preview used, writes each power's `moves-<power>.json` entry, and pushes. *Auto*: `autoPublishIfDue()`, polled from the GM's own browser on the existing 60s tick, does that same load → resolve → publish sequence itself the instant the deadline passes — no GM action, and nothing fires on a merely-*cleared* deadline, since `deadlinePassed()` is false whenever `game.deadline` is null. Manual is the default because a typo caught before publishing costs nothing, while one caught after has already leaked information. Both paths clear `game.deadline` on publish — a stale "already passed" timestamp must never carry over and silently auto-publish the *next* phase off an empty box; the GM (or auto mode, next time someone submits) confirms a fresh deadline every phase. The repo's GitHub Action remains a manually-dispatched convenience for copying reveals into the per-power files as a durable record.

**Auto mode lets players resolve locally at the deadline — the GM need not be awake.** `autoPublishIfDue()` only advances the *official* gist, and only from the GM's own browser, so a midnight deadline with a sleeping GM would otherwise freeze the board for everyone until the GM's tab next ticks. Since every on-time submission is already a public comment, an assigned player (read-only viewer) in auto mode can resolve the phase *locally* the instant the deadline passes: `resolveRevealedLocally()` gathers the on-time reveals — the same order-gather loop `autoPublishIfDue()` uses — runs `resolvePhase()` on the local game only (no gist write), and plays it out through the existing catch-up playback. The advance is marked `game.provisionalPhase`; when the GM's real publish later lands, `reconcileProvisionalPhase()` compares the two outcomes: identical (the common case — same adjudicator, same orders) just clears the flag, divergent (GM used late-resubmit or amended) rolls the provisional phase back via `undoLastPhase()` so the normal gist-driven catch-up replays the authoritative version. The GM still confirms the *next* deadline to move the game forward — the local resolve is a read-ahead, not an unattended runner. This path is gated on `publishMode() === 'auto'` and `isReadOnly()`, so it can never bleed into manual mode or interfere with the GM's own publish flow.

**The deadline gate reads GitHub's clock, not the device's.** `deadlinePassed()` compares against `trustedNow()` — the local clock corrected by an offset to GitHub's server `Date` response header, captured on every gist read (`getLastServerDate()` in `js/publish.js`, `online.serverOffset` in `app.js`). Because auto mode now reveals orders to players purely on a client-side time check, a naive `Date.now()` would let a player set their clock forward to peek early; the server-time correction closes that. It falls back to the raw local clock only until the first server date is seen (offline/first paint), which fails safe — no network means no reveal. Reading the raw gist comments directly through the API remains possible for anyone technical, in either mode; that is the unencrypted-gist caveat above, not a regression this introduces.

**Publishing the board is a separate, explicit act from resolving it.** The GM can resolve, undo, redo and edit the board freely after publishing — none of it reaches players until ☁ Publish changes is clicked. That button is disabled whenever the local position already matches what's live, computed by comparing `state.js`'s `boardSnapshot()` (year/season/step/units/scOwners/pending/history/redoStack) against a copy saved at the last successful publish (`game.publishedState`, itself stripped back out before anything is sent to the gist — it's local bookkeeping, not part of the position). Deliberately excluded from that comparison: the order box. Orders typed or dragged onto the board never touch the game object until `resolvePhase()` runs, so a GM can sketch out arrows to plan their own move without the app ever thinking there's something new to publish. Settings changes (deadline, publish mode, player assignments) still write to the same `game.json`, but they pass the last-published board snapshot as an override rather than whatever the GM's board currently looks like — otherwise confirming a deadline while mid-resolve would silently leak the new position as a side effect, defeating the point of the dirty check.

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

`deadlineUrgency()` (`js/app.js`) is the single `'none' | 'warn' | 'danger'` classification — no deadline set, counting down, or passed — behind every place the app signals it: the topbar's always-visible `DD:HH:MM:SS` chip (ticking on its own 1 s interval, deliberately separate from the existing 60 s online-status poll so a per-second update doesn't imply a per-second network check — the one exception being the GM's own browser in Auto-Publish mode, where that 60 s tick is also `autoPublishIfDue()`'s clock), the sidebar's `#panel-deadline` box (a subtle background/border tint), and the Orders panel's `#deadline-info` hint text. Three call sites reading one function, rather than three places independently comparing `Date.now()` against the deadline, is what keeps "orders are open" from ever disagreeing with itself across the page.

The countdown lives in the topbar — not just the sidebar, where the old deadline text was easy to miss — because it has to be legible to every viewer, GM or player, on both mobile and desktop, and it's the one piece of state that changes every second regardless of anyone's actions. Orders are treated as closed both before any deadline is ever set and after one passes: with no deadline there is nothing to have been "on time" against, so leaving submission open in that state was really just a confusing default, not a real allowance.

---

## 🎭 Play as: a GM's own player position is real, not simulated

`⚙ Settings → 🎭 Play as` only appears once the GM has assigned their own GitHub login to a power in `👥 Set players` — at that point `game.assignedPower` resolves for the owner exactly like it does for anyone else (`refreshOnlineStatus()` no longer excludes owners from that lookup). Switching to `🧑 Player` sets `game.playAs = 'player'`, a durable field on the game object saved like any other setting, not session-only state — closing the tab and coming back leaves the GM exactly where they left off.

`isPlayingAsPlayer()` (`js/app.js`) is the one predicate this depends on: `game.isOwner && game.assignedPower && game.playAs === 'player'`. `isReadOnly()` and `isOwnerView()` both fold it in, so once it's true the GM's browser runs through the *exact same code paths* a real player's browser does — private draft orders, a real `📤 Submit moves` that posts a real gist comment under their own login, deadline enforcement, preview-only resolve. There is no separate debug flow to keep in sync and nothing to clean up on the way out: switching back to `👑 Game Master` only changes `game.playAs` back, it never touches a submission, because the submission they made while playing was always a genuine one.

`gameMode()` is unaffected by any of this — it already derives from `isOwnerView()`, not raw `isOwner`, so it naturally reports `player` while `isPlayingAsPlayer()` is true and `gm` otherwise.

---

## Repositioning a piece lives in ✏ Edit board, as a `Move` tool

A sandbox exists to think in, and thinking is "what if that army were over *here*?" at least as often as "what if it moved there?". That free repositioning used to be a separate `✋ Arrange` toggle (Alt-drag / a sticky mode) available in any sandbox phase. It was removed: it duplicated what the board editor already does, and a sticky mode that silently teleported pieces was exactly the kind of foot-gun the editor's explicit on/off avoids.

Instead it is folded into ✏ Edit board as the **`Move` tool**, sitting beside Army / Fleet / SC owner / Erase. In edit mode a drag repositions the dragged unit (`editDrop`) regardless of which tool is selected — ignoring adjacency, unit-type routing and whose phase it is — so `Move` isn't the default (Army stays default, keeping the empty-sandbox "click to place your first units" flow intact). What `Move` adds is a *click*-that-does-nothing mode, so an existing board can be dragged and panned without a stray tap placing or erasing anything. Being inside the editor is the loud, deliberate signal that a drag now moves pieces rather than writing orders — replacing the old amber ring.

The full ✏ Edit board (move, place, erase, set supply-center owners, reset to 1901) is available in *every* sandbox rather than only an empty one — a branched position is exactly where you want to add a hypothetical fleet. On a published game it stays available to the game master, who occasionally has to correct the official board by hand, but asks first and points at branching as the alternative.
