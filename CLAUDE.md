# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository overview

This repo is Kagan Taylor's personal GitHub Pages site (`index.html` at the root, HTML5 UP "Read Only" template — `assets/`, `images/`, `includes/`, `activity/`, `research/`). It is a static site with no build step; the root site itself rarely needs changes.

The active project is **`diplomacy/`** — a dependency-free, client-side Diplomacy board-game simulator and correspondence-play app. Nearly all engineering work in this repo happens under `diplomacy/`. See `diplomacy/README.md` for full user-facing feature docs and `diplomacy/DECISIONS.md` for the *why* behind non-obvious implementation choices (SVG layer stack, coastline derivation, touch/mobile interaction model, publish/gist architecture) — read `DECISIONS.md` before changing rendering, touch handling, or the publish flow, since it records reasoning that isn't recoverable from the code alone.

## Running and testing

No package manager, no build step, no bundler — plain ES modules loaded directly by the browser (`<script type="module" src="js/app.js">`).

```
python -m http.server 8123
# open http://localhost:8123/diplomacy/
```

Tests, in two tiers:

```
cd diplomacy && node --test
```

runs everything that does not need a browser — the full DATC suite (target **167/167**), both house-rule suites, and the unit suites over the pure modules (`parser`, `orders-text`, `roles`, `online-rules`, `submission-format`, `seal`, `format`). `diplomacy/package.json` exists only to mark `js/` as ES modules for Node: **no dependencies, no lockfile, no install step, no build.** Do not add any.

The browser pages remain, and are the same code: `diplomacy/test/datc.html` (title reports the score, failures listed by case number) and `diplomacy/test/strict.html`. `test/datc-runner.js`'s `runAll(text)` takes the case file when Node passes it and fetches it when the browser doesn't.

There is no lint config. Anything touching the DOM — rendering, the order box, playback, the panels — still has to be verified by loading the page in a browser.

## Workflow

By default, commit and push changes made in this repo (not just `diplomacy/`) so GitHub Pages picks them up and the user can review the live result — don't wait to be asked for the push step specifically. Do this immediately after finishing a change, not batched at the end of a longer session — the user checks results on the live GitHub Pages site, so a change sitting uncommitted/unpushed blocks them from seeing it.

`.claude/` (Claude Code's local project config) is gitignored — never add or commit it.

## Architecture

`diplomacy/js/` — ES modules, no bundler. They are layered, and **dependencies only ever point downward**: the pure domain knows nothing about the DOM, the network or `localStorage`, which is what lets `node --test` drive it.

*Pure domain — no DOM, no IO, all unit-tested:*

- **`map-data.js`** — static data only: `POWERS`, `PROVINCES`, `ARMY_ADJ`/`FLEET_ADJ` adjacency tables, `HOME_CENTERS`, `START_OWNERS`, `START_UNITS`, `ALIASES`. No logic.
- **`adjudicator.js`** — the rules engine: `adjudicateMovement`, `adjudicateRetreats`, `adjudicateAdjustments`, convoy/support legality (`canSupportInto`, `convoyPossible`), `updateSupplyCenters`. Pure functions over plain data (units/orders arrays) — no DOM, no game-object knowledge. This is what DATC tests exercise directly.
- **`parser.js`** — text ⟷ order parsing (`parseOrders`, `parseOrderLine`, `normalizePower`). Order text is tolerant of abbreviations, full names, `via convoy`, per-line `France: A Par - Bur` syntax.
- **`state.js`** — game-object lifecycle: `newGame`/`sandboxGame`, `resolvePhase` (parses + adjudicates + advances phase), `undoLastPhase`/`redoPhase`, `boardSnapshot` (used for publish dirty-checking), `listGames`/`saveGame`/`deleteGame` (localStorage persistence), `exportGame`/`importGame` (JSON serialization). Mostly pure; the `listGames`/`saveGame`/`deleteGame` tail is the one part that touches `localStorage`.
- **`roles.js`** — the permission model: `isOnline`/`isSandbox`/`gameMode`/`isPlayingAsPlayer`/`isReadOnly`/`isOwnerView`/`boardDirty`/`myCountry`/`assignedPower`. Nine pure questions about a game object, and the gate on every control in the app.
- **`orders-text.js`** — the order buffer as text: `splitOrdersByPower`, `setOrderLine`, `orderTextFor`, `splitForFilter` (the visible/hidden split for the power you are playing), `defaultOrdersText`, `normalizeOrders`. Since order text is the one source of truth, these string operations *are* the order model.
- **`online-rules.js`** — deadlines and submissions: who may submit, whose orders are on time, what each viewer may see, which phase a deadline belongs to, and `gatherPhaseBlocks` (the one loop behind every "load the table's moves"). Takes `game` and the fetched `online` snapshot explicitly. **The highest-risk code in the repo** — read `DECISIONS.md` before touching it.
- **`submission-format.js`** — the gist-comment wire format (markers, payload, `findSubmission`/`findMyMailbox`, `upsertMovesEntry`). Shared verbatim with `tools/publish-moves.js`; it must never grow a `fetch` or a `localStorage` call, or Node can no longer read it.
- **`format.js`** — display strings: `fmtOrder`, `provName`, the two countdowns, `POWER_FLAGS`.
- **`seal.js`** — AES-GCM order sealing. Environment-neutral, shared with the Action.

*IO adapters — these touch the DOM, the network or localStorage:*

- **`render.js`** — the `Board` class: loads and re-layers the jDip SVG map at runtime, hit-testing, hover/highlight, drag-to-order, pinch/zoom/pan. Per-instance layer stack documented in `DECISIONS.md` (`MapLayer`, `InfluenceLayer`, `CoastTintLayer`, `HoverLayer`, `SupplyCenterLayer`, `UnitLayer`, `MouseLayer`). All themeable colors (`POWER_COLORS`, `COAST_COLOR`, `COAST_COLORS`, `HOVER_COLOR`) are named constants at the top of this file — that's the one place to edit for map recoloring.
- **`publish.js`** — GitHub Gist-backed online play: `publishGame`/`updatePublished`/`fetchPublished`, gist-comment submissions (`submitOrders`, `listComments`, `findSubmission`, `parseSubmission`, `ORDERS_MARKER`), per-power `moves-<power>.json` file read/write (`readMovesFiles`, `writeMovesFiles`, `upsertMovesEntry`). No server component — all state lives in a public GitHub gist, token kept in `localStorage`, submissions are gist comments (chosen specifically because separate comment objects from different players can't conflict — see `DECISIONS.md`).

*UI:*

- **`app.js`** — the entry point and everything DOM/UI: event wiring, order-box sync (`syncOrderLine()` is the single funnel from board drags/clicks back into order text — the order text is the source-of-truth representation, never a second parallel order-object model), playback/step-through state, mobile bottom-sheet UI (`applyMobileSheetUI()`), GM vs. read-only-viewer control gating (`isOwner`).

`diplomacy/index.html` is the single page (menu screen + game screen), styled by `diplomacy/css/style.css`.

**`app.js` is still the largest file and is mid-refactor.** The pure logic has been lifted out behind thin wrappers that bind the module-level `game`/`online` (`const isReadOnly = () => R.isReadOnly(game);`), so call sites read as they always did. What remains in it is genuinely DOM work plus the network orchestration and GM publish flows; splitting those into `js/ui/` modules is the next planned step. When adding logic, ask whether it is a *rule* (goes in a pure module, with a test) or a *rendering* (stays in app.js).

### Key architectural invariants (see DECISIONS.md for full reasoning)

- **Order text is the one source of truth.** Every drag/click/coast-picker interaction rewrites the order box text and re-parses it — there is no separate order-object model that could drift from what's displayed.
- **Publishing is separate from resolving.** A GM can resolve/undo/redo/edit freely; nothing reaches players until an explicit "Publish changes" action. Dirty-checking compares `state.js`'s `boardSnapshot()` against a snapshot saved at last publish, deliberately excluding the live order box.
- **Deadlines are confirmed, not scheduled.** No server or cron enforces deadlines — every client independently checks GitHub's own comment-edit timestamps against the GM-set deadline in `game.json`. The GitHub Action (`.github/workflows/diplomacy-publish-moves.yml`) is a manual, non-scheduled convenience only.
- **Two publish modes** (GM's Settings choice): *manual* (default, GM reviews before releasing) vs *auto* (revealed to everyone the instant the deadline passes).
- **Only the owning browser can advance a published game** (`isOwner`, tied to the token that published it); everyone else is read-only and can branch a private practice copy.
