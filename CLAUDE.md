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

Tests: `diplomacy/test/datc.html` runs the full DATC (Diplomacy Adjudicator Test Cases) suite in-browser against `diplomacy/js/adjudicator.js`, driven by `diplomacy/test/datc-runner.js` parsing `diplomacy/tools/datc_v2.4_06.txt`. Serve the folder and open `test/datc.html`; the page title reports the score (target `DATC 167/167`) and lists failures by case number. There is no CLI test runner or lint config — verify changes by loading the page in a browser.

## Workflow

By default, commit and push changes made in this repo (not just `diplomacy/`) so GitHub Pages picks them up and the user can review the live result — don't wait to be asked for the push step specifically.

## Architecture

`diplomacy/js/` — seven ES modules, each `import`/`export`-based with no bundler:

- **`map-data.js`** — static data only: `POWERS`, `PROVINCES`, `ARMY_ADJ`/`FLEET_ADJ` adjacency tables, `HOME_CENTERS`, `START_OWNERS`, `START_UNITS`, `ALIASES`. No logic.
- **`adjudicator.js`** — the rules engine: `adjudicateMovement`, `adjudicateRetreats`, `adjudicateAdjustments`, convoy/support legality (`canSupportInto`, `convoyPossible`), `updateSupplyCenters`. Pure functions over plain data (units/orders arrays) — no DOM, no game-object knowledge. This is what DATC tests exercise directly.
- **`parser.js`** — text ⟷ order parsing (`parseOrders`, `parseOrderLine`, `normalizePower`). Order text is tolerant of abbreviations, full names, `via convoy`, per-line `France: A Par - Bur` syntax.
- **`state.js`** — game-object lifecycle: `newGame`/`sandboxGame`, `resolvePhase` (parses + adjudicates + advances phase), `undoLastPhase`/`redoPhase`, `boardSnapshot` (used for publish dirty-checking), `listGames`/`saveGame`/`deleteGame` (localStorage persistence), `exportGame`/`importGame` (JSON serialization).
- **`render.js`** — the `Board` class: loads and re-layers the jDip SVG map at runtime, hit-testing, hover/highlight, drag-to-order, pinch/zoom/pan. Per-instance layer stack documented in `DECISIONS.md` (`MapLayer`, `InfluenceLayer`, `CoastTintLayer`, `HoverLayer`, `SupplyCenterLayer`, `UnitLayer`, `MouseLayer`). All themeable colors (`POWER_COLORS`, `COAST_COLOR`, `COAST_COLORS`, `HOVER_COLOR`) are named constants at the top of this file — that's the one place to edit for map recoloring.
- **`publish.js`** — GitHub Gist-backed online play: `publishGame`/`updatePublished`/`fetchPublished`, gist-comment submissions (`submitOrders`, `listComments`, `findSubmission`, `parseSubmission`, `ORDERS_MARKER`), per-power `moves-<power>.json` file read/write (`readMovesFiles`, `writeMovesFiles`, `upsertMovesEntry`). No server component — all state lives in a public GitHub gist, token kept in `localStorage`, submissions are gist comments (chosen specifically because separate comment objects from different players can't conflict — see `DECISIONS.md`).
- **`app.js`** — the entry point and everything DOM/UI: event wiring, order-box sync (`syncOrderLine()` is the single funnel from board drags/clicks back into order text — the order text is the source-of-truth representation, never a second parallel order-object model), playback/step-through state, mobile bottom-sheet UI (`applyMobileSheetUI()`), GM vs. read-only-viewer control gating (`isOwner`).

`diplomacy/index.html` is the single page (menu screen + game screen), styled by `diplomacy/css/style.css`.

### Key architectural invariants (see DECISIONS.md for full reasoning)

- **Order text is the one source of truth.** Every drag/click/coast-picker interaction rewrites the order box text and re-parses it — there is no separate order-object model that could drift from what's displayed.
- **Publishing is separate from resolving.** A GM can resolve/undo/redo/edit freely; nothing reaches players until an explicit "Publish changes" action. Dirty-checking compares `state.js`'s `boardSnapshot()` against a snapshot saved at last publish, deliberately excluding the live order box.
- **Deadlines are confirmed, not scheduled.** No server or cron enforces deadlines — every client independently checks GitHub's own comment-edit timestamps against the GM-set deadline in `game.json`. The GitHub Action (`.github/workflows/diplomacy-publish-moves.yml`) is a manual, non-scheduled convenience only.
- **Two publish modes** (GM's Settings choice): *manual* (default, GM reviews before releasing) vs *auto* (revealed to everyone the instant the deadline passes).
- **Only the owning browser can advance a published game** (`isOwner`, tied to the token that published it); everyone else is read-only and can branch a private practice copy.
