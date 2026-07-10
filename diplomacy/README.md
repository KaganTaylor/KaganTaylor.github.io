# Diplomacy Simulator

A dependency-free web app for playing and practicing [Diplomacy](https://en.wikipedia.org/wiki/Diplomacy_(game)) by correspondence. Paste each power's weekly orders, step through them **one at a time** — units stay on their starting provinces with arrows showing intent, supports and convoys drawn — then reveal the resolution (bounces ✕, cut supports, dislodged units) and the final board. Covers the whole game: movement, retreats, and winter builds, with supply-center tracking across years.

## Features

- **DATC-validated rules engine** — all 167 [Diplomacy Adjudicator Test Cases](https://webdiplomacy.net/doc/DATC_v3_0.html) pass, including convoy paradoxes (Szykman rule), circular movement, coast edge cases, retreat and build rules. Open `test/datc.html` to run the suite in your browser.
- **Step-through visualization** — click forward/back through each order (or skip to the end), exactly like resolving on a physical board, then watch every unit glide simultaneously to its final position (bounced units lunge and fall back).
- **Drag to order** — drag a unit to its destination, drop it on itself to hold, ⇧-drop on a unit to support it, Ctrl-drop (a fleet at sea, onto a moving army) to convoy. A coast picker pops up when a fleet move is ambiguous. Everything is written into the plain-text order box, which stays the source of truth.
- **Board editor** — toggle ✏ Edit board to place/remove armies and fleets, drag units anywhere, and set supply-center owners; scroll to zoom, drag empty space to pan.
- **Undo** — step back through resolved phases; your order text comes back with each undo.
- **Tolerant order parsing** — `A Par - Bur`, `F ENG S A Bre - Pic`, `via convoy`, full names or abbreviations, all coast notations (`spa/sc`, `Spa(sc)`).
- **Full game loop** — spring/fall movement, retreats, supply-center capture, winter builds & civil-disorder disbands.
- **History & branching** — replay any past turn's step-through; branch a practice copy from any point to test future moves.
- **Sharing** — export/import the whole game as a JSON file; state also autosaves in your browser.
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

## Rules choices

Where the rulebook is ambiguous the engine follows Kruijswijk's DATC preferences (and the godip test file's choices), notably:

- 4.A.3 (adjacent move with convoy): 1982/2000 "intent" rule — the convoy is taken if the move says `via convoy` or the army's power ordered a *legal* convoying fleet.
- 4.B.1 (missing coast when two are possible): the order is void, the fleet holds.
- Convoy paradoxes: Szykman — the paradoxical convoyed move fails and does not cut support.
- Dislodged units with no legal retreat are destroyed immediately.

## Testing

- `test/datc.html` — full DATC suite in the browser (or headless: `tools/run-datc.ps1`).
- `tools/e2e.py` — Selenium end-to-end drive of a full game year.

## Credits & license

- Map artwork: the jDip detailed standard map (SVG by Zach DelProposto, background map by J. Fatula III), GPL — from the [jDip](https://jdip.sourceforge.net/) project via [diplomacy/diplomacy](https://github.com/diplomacy/diplomacy).
- Map/adjacency data derived from the dpjudge-format `standard.map`.
- DATC test data: Lucas B. Kruijswijk's Diplomacy Adjudicator Test Cases, machine-readable copy from [zond/godip](https://github.com/zond/godip).
- Adjudication algorithm: Lucas B. Kruijswijk, [*The Math of Adjudication*](https://diplom.org/Zine/S2009M/Kruijswijk/DipMath_Chp1.htm).

This project is licensed under the **GNU General Public License v3.0** (see `LICENSE`), matching the map artwork's license.

Diplomacy is a trademark of its respective owners; this is a fan-made tool for personal use.
