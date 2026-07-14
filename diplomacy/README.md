# Diplomacy Simulator

A dependency-free web app for playing and practicing [Diplomacy](https://en.wikipedia.org/wiki/Diplomacy_(game)) by correspondence. Paste each power's weekly orders, step through them **one at a time** — units stay on their starting provinces with arrows showing intent, supports and convoys drawn — then reveal the resolution (bounces ✕, cut supports, dislodged units) and the final board. Covers the whole game: movement, retreats, and winter builds, with supply-center tracking across years.

## Features

- **DATC-validated rules engine** — all 167 [Diplomacy Adjudicator Test Cases](https://webdiplomacy.net/doc/DATC_v3_0.html) pass, including convoy paradoxes (Szykman rule), circular movement, coast edge cases, retreat and build rules. Open `test/datc.html` to run the suite in your browser.
- **Step-through visualization** — click forward/back through each order (or skip to the end), exactly like resolving on a physical board, then watch every unit glide simultaneously to its final position (bounced units lunge and fall back).
- **Drag to order** — drag a unit to its destination, drop it on itself to hold, ⇧-drop on a unit to support it, Ctrl-drop (a fleet at sea, onto a moving army) to convoy. No modifier keys? Turn on the **🤝 Support** or **⚓ Convoy** toggle instead — in the topbar on desktop, floating over the top-right of the map on a phone — and the next drag writes that order; the toggle switches itself off again once it does. A coast picker pops up when a fleet move is ambiguous. Everything is written into the plain-text order box, which stays the source of truth.
- **Board editor** — toggle ✏ Edit board to place/remove armies and fleets, drag units anywhere, and set supply-center owners; scroll to zoom, drag empty space to pan.
- **Works on a phone** — the map fills the screen, with Edit / Orders / Standings as bottom sheets that shrink the board rather than cover it. Tap any province to outline it, drag to pan, pinch to zoom, double-tap to reset.
- **Split coasts are drawn** — Spain, St Petersburg and Bulgaria have their individual coastlines marked along the sea, so it's clear a fleet must pick one. Highlighting still outlines the country as a whole. See [Customising the look](#customising-the-look) to change the coastline colour.
- **Undo** — step back through resolved phases; your order text comes back with each undo.
- **Tolerant order parsing** — `A Par - Bur`, `F ENG S A Bre - Pic`, `via convoy`, full names or abbreviations, all coast notations (`spa/sc`, `Spa(sc)`).
- **Full game loop** — spring/fall movement, retreats, supply-center capture, winter builds & civil-disorder disbands.
- **History & branching** — replay any past turn's step-through; branch a practice copy from any point to test future moves.
- **Sharing** — export/import the whole game as a JSON file; state also autosaves in your browser.
- **Online play** — publish a game as a GitHub gist link; assigned players submit their orders in-app with their own GitHub token. When the game master's confirmed deadline passes, moves either reveal to everyone instantly (auto publish) or go to the game master first for review (manual publish, the default). See [Playing online](#playing-online).
- **Sandbox** — set up any position (units, coasts, supply centers) and try things.

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

## Playing online

A published game (a public GitHub gist) can collect each player's orders directly, replacing the weekly email round.

**Game master**

1. Publish the game (📣 Publish — needs a classic personal access token with only the `gist` scope).
2. In the **👥 Players** panel, enter each power's player as their GitHub username and 💾 Save.
3. Pick the **⚙ publish mode**: **manual** (default) — when the deadline passes, submissions lock and only you see them until you release the results; **auto** — everyone sees all moves the moment the deadline passes.
4. Confirm the phase's **⏰ deadline**: **+1 week** from the previous deadline is the default rhythm for movement, **+24 h** / **+48 h** suit retreats and builds, or pick any date and time. Submissions close when it passes — no late entries (a submission comment edited after the deadline is void).
5. After the deadline — in manual mode — **🔍 Review submissions** fills the order box with everyone's moves, for your eyes only. If something's wrong, re-open by confirming a new deadline (players keep their submitted orders unless they resubmit). If it all looks right, **📣 Publish results** releases the moves to every player.
6. Then Resolve, ☁ Update published, and confirm the next deadline.
7. Grace and overrides: **✖** un-publishes a power for the phase so they can resubmit; **📥** force-publishes one power's submission (even a late edit); **📝** publishes whatever the order box holds for a power (the "fix the typo the table forgave" path). The GM can always still type and resolve anything by hand.

**Players**

1. Open the game link and set a GitHub token (🔑 on the home screen — classic token, `gist` scope only).
2. If the GM assigned your GitHub username a power, you're locked to it. Write or drag your orders, then press **📤 Submit moves**.
3. Resubmit as often as you like before the deadline. The same GitHub account works from any browser or device — your submitted orders come back with you.
4. After the deadline: in auto-publish games, **⬇ Load published moves** immediately shows what everyone ordered, and Resolve previews the new board (a local preview — the game master's published update remains the official position). In manual-publish games the moves appear once the game master has reviewed and published the results.

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

## Testing

- `test/datc.html` — the full DATC suite. Serve the folder and open it; the page title reports the score (`DATC 167/167`) and lists any failures by case.
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
