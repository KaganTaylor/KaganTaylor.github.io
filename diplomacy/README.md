# Diplomacy Simulator

A dependency-free web app for playing and practicing [Diplomacy](https://en.wikipedia.org/wiki/Diplomacy_(game)) by correspondence. Paste each power's weekly orders, step through them **one at a time** — units stay on their starting provinces with arrows showing intent, supports and convoys drawn — then reveal the resolution (bounces ✕, cut supports, dislodged units) and the final board. Covers the whole game: movement, retreats, and winter builds, with supply-center tracking across years.

## Features

- **Two kinds of game, told apart at a glance** — a game is either **☁ online** (a published gist: one real position, run by its game master) or **🧪 a sandbox** (private to your browser, edit and resolve anything, throw it away). Branches and practice games are just sandboxes. Which one you are in is on screen three times over — a chip by the game's name, a coloured stripe along the topbar, and a ring round the board — and the home screen groups your games the same way, with the role you hold and the deadline countdown on each row. See [Game states](#game-states).
- **DATC-validated rules engine** — all 167 [Diplomacy Adjudicator Test Cases](https://webdiplomacy.net/doc/DATC_v3_0.html) pass, including convoy paradoxes (Szykman rule), circular movement, coast edge cases, retreat and build rules. Open `test/datc.html` to run the suite in your browser.
- **Step-through visualization** — click forward/back through each order (or skip to the end), exactly like resolving on a physical board, then watch every unit glide simultaneously to its final position (bounced units lunge and fall back).
- **Drag to order** — drag a unit to its destination, drop it on itself to hold, ⇧-drop on a unit to support it, Ctrl-drop (a fleet at sea, onto a moving army) to convoy. No modifier keys? Turn on the **🤝 Support** or **⚓ Convoy** toggle instead — in the topbar on desktop, floating over the top-right of the map on a phone — and the next drag writes that order; the toggle switches itself off again once it does. A coast picker pops up when a fleet move is ambiguous. Everything is written into the plain-text order box, which stays the source of truth.
- **Board editor** — toggle ✏ Edit board in any sandbox to place/remove armies and fleets, drag units anywhere, and set supply-center owners; scroll to zoom, drag empty space to pan.
- **✋ Arrange (sandboxes)** — **Alt-drag** any piece to somewhere illegal without leaving order entry, or turn on the ✋ toggle and just drag. The board wears an amber ring while it is armed, so you always know whether a drag is writing an order or moving a piece.
- **Works on a phone** — the map fills the screen, with Edit / Orders / Standings as bottom sheets that shrink the board rather than cover it. Tap any province to outline it, drag to pan, pinch to zoom, double-tap to reset.
- **Split coasts are drawn** — Spain, St Petersburg and Bulgaria have their individual coastlines marked along the sea, so it's clear a fleet must pick one. Highlighting still outlines the country as a whole. See [Customising the look](#customising-the-look) to change the coastline colour.
- **Undo** — step back through resolved phases; your order text comes back with each undo.
- **Tolerant order parsing** — `A Par - Bur`, `F ENG S A Bre - Pic`, `via convoy`, full names or abbreviations, all coast notations (`spa/sc`, `Spa(sc)`).
- **Full game loop** — spring/fall movement, retreats, supply-center capture, winter builds & civil-disorder disbands.
- **History & branching** — replay any past turn's step-through; 🌿 branch any position (including a preview's outcome) into a sandbox, which remembers where it came from and offers a way back.
- **Nothing you do to someone else's game can break it** — spectating a game you don't own and aren't assigned to, Resolve becomes **👁 Preview result**: it adjudicates on a throwaway copy, so you can try any orders — including guesses at what the other six powers will do — and the live position is still there when you close the playback. An assigned player submits for real instead (see [Playing online](#playing-online)) — there's nothing to preview.
- **Sharing** — export/import the whole game as a JSON file; state also autosaves in your browser.
- **Online play** — publish a sandbox to turn it into the real game; assigned players submit their orders in-app with their own GitHub token. When the game master's confirmed deadline passes, moves either reveal to everyone instantly (auto publish) or go to the game master first for review (manual publish, the default). See [Playing online](#playing-online).

## Running

It's a static site — host the folder anywhere, or run locally:

```
python -m http.server 8123
# open http://localhost:8123/
```

## Order syntax

```
FRANCE
A Par - Bur
A Mar S A Par - Bur        # support a move
F Bre - MAO
F ENG C A Lon - Bre        # convoy
A Lon - Bre via convoy
A Lon - NTH - Nwy          # convoy naming its sea route (strict-convoy rule)
A Pic H                    # hold (unordered units hold automatically)

# retreats phase
A Bur - Gas                # or: A Bur disband

# builds phase
Build F Lon
Build F Stp/nc
Remove Ruh
Waive
```

Orders can also be written per-line as `France: A Par - Bur` instead of using power headings.

## Game states

Every game is one of two things, and the app never leaves you guessing which:

| | 🧪 **Sandbox** (amber) | ☁ **Online** (blue) |
| --- | --- | --- |
| Where it lives | this browser only | a public GitHub gist |
| Who can move the board | you | the game master, and only by publishing |
| ✏ Edit board, ✋ Arrange | yes | game master only (it asks first) |
| Resolve | resolves, for real | game master resolves; assigned players **submit** instead; spectators **preview** |
| Undo / Redo | yes | game master only |
| Becomes | an online game, if you 📣 Publish it | — |

Branches and practice copies are all just sandboxes. **Publishing a sandbox is what makes it the real game.**

**Telling them apart.** The chip beside the game's name says which (`🧪 Sandbox`, `☁ Live · 👑 Game master`, `☁ Live · 🇫🇷 France`, `☁ Live · 👁 Watching`), a stripe along the top of the topbar carries the same colour, and so does a ring around the board. On the home screen your games are grouped into ☁ Online games and 🧪 Sandboxes, each row showing its role badge (a flag for an assigned power), its deadline countdown, and — for a branch — the game it came from.

**Previewing.** Spectating a game — watching without an assigned power — Resolve reads **👁 Preview result** and adjudicates on a throwaway copy: step through it, play the moves, copy the results, and the published position is untouched when you close it. If the outcome was worth keeping, **🌿 Continue in a sandbox** picks it up from there. An assigned player has no preview — see below.

**Keeping track of what's published (game master).** After you resolve, your browser holds a position the shared link doesn't. A **● Unpublished** pill appears in the topbar — it names the turn your players can still see, and clicking it publishes. ⚙ Settings has the other two halves: **👁 View published state** to see what's actually live, and **⟲ Revert to published** to throw your local changes away and reload it (your draft orders in the box are kept). Editing the official board, undoing an official turn and leaving with an unpublished one all ask for confirmation first.

**Knowing what's submitted (player).** Your order box is a private draft; only 📤 Submit orders sends it — the button reads **🔁 Re-submit orders** once something's already on record for the phase, and greys out whenever the box already matches it (there's nothing to resubmit). If you drag or type anything after submitting, the status line says so — *"the box no longer matches what you submitted"* — instead of a ✓ that refers to orders you've since changed.

## Playing online

A published game (a public GitHub gist) can collect each player's orders directly, replacing the weekly email round.

**Game master**

1. Publish the sandbox you set the game up in (⚙ Settings → 📣 Publish — needs a classic personal access token with only the `gist` scope). It becomes the live game and you become its game master.
2. In **⚙ Settings → 👥 Set players**, enter each power's player as their GitHub username and 💾 Save.
3. Pick the **⚙ publish mode**: **manual** (default) — once the deadline passes, you load and resolve the submissions yourself before anyone sees them; **auto** — the game resolves and publishes itself the moment the deadline passes, no action needed.
4. Confirm the phase's **⏰ deadline**, in the sidebar's Deadline panel: **+1 week** from the previous deadline is the default rhythm for movement, **+24 h** / **+48 h** suit retreats and builds, or pick any date and time. A live `DD:HH:MM:SS` countdown sits in the topbar for everyone (GM and players alike), amber while counting down and red once it's passed, so it's always obvious whether orders are open. **Submissions are closed both before a deadline is ever set and after it passes** — no late entries, and nothing to be "on time" against until you confirm one (a submission comment edited after the deadline is void).
5. Your order box stays out of the way until there's something to resolve. In manual mode, once the deadline passes, **⏰ Deadline → ⬇ Load orders** lights up: it fills the box with every submission and opens it. Resolve steps through the outcome exactly like a player's preview — nothing is published yet — and from there either **📣 Publish results** (plays the moves, commits them for real, and pushes to the link) or **← Back — amend an order** (drops the preview and returns to the still-loaded box, unchanged, to fix an order the table forgives) — no separate publish step, no per-power overrides needed, since whatever's in the box when you publish is the record. Auto mode does this same load → resolve → publish sequence on its own the moment the deadline passes; you'll only see the deadline clear and the phase move on. Either way, the deadline clears once a phase publishes — confirm a fresh one for the next.
6. To skip the game forward without waiting on a deadline (setup, testing, catching up an offline table), clear or never set one, then **⬇ Load orders** opens an empty box you can fill in by hand — resolve and publish repeatedly, editing the board in between as needed. Correcting the board directly (✏ Edit board, outside the load/resolve flow) still uses **☁ Publish changes** — or the **● Unpublished** pill that appears the moment your board moves ahead of the link — to push the edit; **👁 View published state** and **⟲ Revert to published** work the same as ever for checking or discarding local changes.
7. **⚙ Settings → 🔍 Submissions** shows who's submitted and what's published — read-only except for **✖**, which un-publishes a power's already-loaded entry for the phase so they can resubmit, and **🔓**/**🔒**, which specifically authorizes (or revokes) a power submitting or resubmitting past the deadline for the current phase — the normal deadline gate stays in force for everyone else. This is deliberately not a permanent sidebar panel — players never see who's submitted, and neither do you unless you open it.
8. If you've assigned your own GitHub username to a power in **👥 Set players**, **⚙ Settings → Play as** lets you switch between **👑 Game Master** and your power (shown as its flag and name) — genuinely playing your own power, not a simulation: a private draft order box locked to that power, a real 📤 Submit orders posted under your own account, the same deadline rules as anyone else. Your GM controls (including the order box's load/resolve/publish flow above) hide while playing, and switching back to Game Master is just that — a view change, nothing to clean up.
9. **Reverting a published phase.** **⤺ Undo** (History panel) walks the official position back a phase and returns its orders to the box — it only changes what's live once you **☁ Publish changes**, so players keep seeing the old position until then. Nothing is thrown away: the phase you undid stays available to **⤻ Redo**, so if you publish the revert and change your mind before resolving anything new, redoing and publishing again puts the game right back where it was. Only actually resolving a new phase clears that redo history.

**Players**

1. Open the game link and set a GitHub token (🔑 on the home screen — classic token, `gist` scope only).
2. If the GM assigned your GitHub username a power, you're locked to it — you see just your own orders, drawn as a flag and country name rather than a picker. Opening the game (or any device you sign into) loads your currently published orders straight into the box, so it always starts in sync.
3. Write or drag your orders, then press **📤 Submit orders** — enabled once the game master has confirmed a deadline and it hasn't passed yet; the topbar's `DD:HH:MM:SS` countdown (amber while open, red once it's passed) makes it clear at a glance. Resubmit as often as you like before the deadline; the same GitHub account works from any browser or device. Once the deadline passes the button greys out and reads **🔁 Re-submit orders** if you'd already submitted — unless your game master specifically authorizes you to resubmit late (⚙ Settings → 🔍 Submissions), in which case it stays usable for that phase only.
4. If you've dragged or edited the box since submitting, a warning says so and the button highlights. **⬇ Load published moves** throws away local changes and reloads what's actually on record for you — it's greyed out whenever the box already matches, since there's nothing to reset. Once the game master publishes the resolved phase, the new board (and everyone's orders for it) shows up in **History**.
5. Whether other powers have submitted yet is not shown to you — only the game master can check that. **🌿 Branch to sandbox**, at the top of the sidebar, keeps a private copy of the current position to experiment in — nothing you do there reaches the real game until you come back and submit.
6. **History is read-only.** Picking a past phase and pressing **Replay** steps back through it exactly as it happened; the order box disappears entirely while you're looking at it (there's nothing to edit) and returns once you step back to the current turn. Branching and standings stay available throughout.

**No servers, no schedules.** The deadline is enforced by the app itself: submissions are gist comments, GitHub stamps every comment with an edit time, and any client can therefore tell — from public data — which submissions beat the deadline. Nothing needs to run *at* the deadline. An optional GitHub Action (`.github/workflows/diplomacy-publish-moves.yml`, manual `workflow_dispatch` only — it never runs on a schedule) can copy auto-mode games' revealed submissions into per-power `moves-<power>.json` files as a durable record; it needs a repository secret named `DIPLOMACY_GIST_TOKEN` holding the GM's gist-scope token.

**Fair warning:** submissions travel as gist comments, which are public. The app only surfaces moves once published, but a determined player could read the gist's comments early — treat "don't peek" as a house rule, as in any honour-system correspondence game.

## Customising the look

Every colour the app draws on the map is a named constant at the top of **`js/render.js`** — that is the only file to edit.

| What | Constant | Default |
| --- | --- | --- |
| The seven powers (units, ownership tint, order arrows) | `POWER_COLORS` | one per power |
| **Coastlines** on split-coast provinces (Spain, St Petersburg, Bulgaria) | **`COAST_COLOR`** | `#6b7280` (grey) |
| A single coast in a different colour | `COAST_COLORS` | `{}` — empty, so every coast uses `COAST_COLOR`. Add e.g. `{ sc: '#9aa0a6' }` to tint south coasts on their own |
| Coastline thickness / opacity | `COAST_WIDTH`, `COAST_OPACITY` | `7`, `0.85` |
| Outline of the province under the pointer (or last tapped) | `HOVER_COLOR`, `HOVER_WIDTH` | `#ffd479`, `4` |

They are all grouped under a `COASTLINE APPEARANCE` comment block in `js/render.js`; changing `COAST_COLOR` there recolours every coastline at once. Panel and button colours are ordinary CSS in `css/style.css`.

## Rules choices

Where the rulebook is ambiguous the engine follows Kruijswijk's DATC preferences (and the godip test file's choices), notably:

- 4.A.3 (adjacent move with convoy): 1982/2000 "intent" rule — the convoy is taken if the move says `via convoy` or the army's power ordered a *legal* convoying fleet.
- 4.B.1 (missing coast when two are possible): the order is void, the fleet holds.
- Convoy paradoxes: Szykman — the paradoxical convoyed move fails and does not cut support.
- Dislodged units with no legal retreat are destroyed immediately.

### House rules (⚙ Settings → 🎲 Game settings)

Optional, per-game, off by default; a change applies to future resolutions only.

- **Strict support-hold** — support-hold can only be given to units ordered to hold or convoy, and a unit giving support cannot itself receive support.
- **Strict convoy** — a convoyed army must name every sea it is carried through (`A Lon - NTH - Nwy`), and the convoy succeeds only if each named sea has a fleet ordered to convoy it and none is dislodged. There is no automatic route search and no alternate path. Drag an army to a convoy-only province: if only one chain of fleets can carry it there, the route is filled in for you; if several can, an on-map picker opens so you tap the seas in order (only seas that hold a fleet are offered) and then tap the destination. Either way the order arrow bends through the named seas.

## Testing

- `test/datc.html` — the full DATC suite. Serve the folder and open it; the page title reports the score (`DATC 167/167`) and lists any failures by case.
- `test/strict.html` — the house-rule cases (strict support-hold and strict convoy), each run both ways to pin the difference from standard rules.
- `tools/datc_v2.4_06.txt` — the machine-readable test cases the runner parses.

## Design notes

`DECISIONS.md` records why the map is drawn and handled the way it is — the SVG layer stack, how coastlines are found, why highlighting outlines only the province, and the mobile interaction model.

## Credits & license

- Map artwork: the jDip detailed standard map (SVG by Zach DelProposto, background map by J. Fatula III), GPL — from the [jDip](https://jdip.sourceforge.net/) project via [diplomacy/diplomacy](https://github.com/diplomacy/diplomacy).
- Map/adjacency data derived from the dpjudge-format `standard.map`.
- DATC test data: Lucas B. Kruijswijk's Diplomacy Adjudicator Test Cases, machine-readable copy from [zond/godip](https://github.com/zond/godip).
- Adjudication algorithm: Lucas B. Kruijswijk, [*The Math of Adjudication*](https://diplom.org/Zine/S2009M/Kruijswijk/DipMath_Chp1.htm).

This project is licensed under the **GNU General Public License v3.0** (see `LICENSE`), matching the map artwork's license.

Diplomacy is a trademark of its respective owners; this is a fan-made tool for personal use.
