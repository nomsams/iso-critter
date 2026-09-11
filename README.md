# iso-critter

A little isometric pet-sim: one (or a few) critters living in a furnished
apartment, deciding what to do on their own — eat, sleep, use the bathroom,
watch TV, socialize, tidy up — driven by a needs/mood model and either a
hand-written utility-scoring brain or a small neural net trained live from
its own play. Vanilla JavaScript and Canvas2D, no build tool, no runtime
dependencies.

**▶ Play it: https://nomsams.github.io/iso-critter/**

Everything autosaves to your browser's local storage, so it picks up where
you left off.

## What's actually going on

- **Needs & mood.** Hunger, energy, bladder, hygiene, fun, social — each
  decays over time and gets satisfied by the right piece of furniture or
  interaction. Needs and recent events feed a valence/arousal affect model,
  which colors which actions look appealing.
- **Two brains, same body.** The default brain scores every available
  action by hand-tuned utility (need urgency, travel distance, novelty,
  mood). A neural net runs alongside it, trained on imitation (nudged
  toward whatever the utility brain just picked) and reward (nudged toward
  whichever actions actually improved wellbeing) — flip to it from the
  brain inspector (🧠) to watch it fly solo.
- **A real household.** Multiple critters share one world, notice each
  other, and can be individually switched between. Rooms are separated by
  low partition walls and gates; a critter pathfinds around furniture and
  other critters, not just in a straight line.
- **Everything's furniture-driven.** Sitting, lying down, reaching into a
  fridge — a critter's exact seat position and height come from the
  furniture definition itself (`seatX`/`seatY`/`seatH`, `reachH` — see
  `src/world/objects.js`), not a hardcoded animation.

## Running it locally

Static files, no npm install:

```bash
node dev-server.mjs
```

then open `http://localhost:5173`. A plain static file server is enough —
GitHub Pages serves the exact same files with no build step.

`index.html` loads `dist/bundle.js`, which is `src/` bundled into one
classic (non-module) script by `build.mjs` — module scripts can't load over
`file://`, and this keeps the game double-click-able straight off disk with
no dev server at all if you'd rather. **Run `node build.mjs` after editing
anything under `src/`** — the browser never sees `src/` directly.

```bash
node build.mjs      # src/ -> dist/bundle.js, after any src/ edit
node dev-server.mjs [port]   # serve the project root (default port 5173)
```

## Project layout

```
src/
  main.js    entry point — wires DOM controls to the world/critters and runs the loop
  core/      game loop, audio, small shared utilities
  world/     the room: grid, furniture defs, collision, save/restore
  creature/  needs, emotion, memory, the two brains, the per-tick action runner
  render/    isometric projection, sprites, the critter's procedural body
  ui/        HUD wiring
dist/        build.mjs's output; regenerate, don't hand-edit
assets/      Kenney's CC0 Furniture Kit (source .glb models + extracted
             reference sprites) and this project's own exported sprites
tools/
  sprite-forge/   turns a .glb into game-ready isometric PNGs (see below)
```

## Playing & editing

The toolbar along the top covers direct interaction (pet, call, snack,
toggle the TV/lights/door) and simulation speed. The pieces more specific
to this project:

- **🛠 Edit** opens the room editor: a palette to place new furniture, and
  click-to-select on anything already placed. A selected item gets a small
  panel (bottom-right of the room) with **Rotate** and **Move**; the
  palette itself also has rotate/remove/undo for whatever's mid-placement.
  <kbd>R</kbd> rotates the selected item, <kbd>Shift+R</kbd> rotates it the
  other way, <kbd>Ctrl+Z</kbd> undoes the last edit, <kbd>Esc</kbd> cancels
  a placement in progress.
- **Save panel** (right sidebar): `save` forces an immediate save on top of
  the automatic one every 20s; `new critter` wipes local storage and starts
  fresh. **`export layout` / `import layout`** save or load just the
  room — furniture positions, rotations, open/closed state — as a portable
  `.json` file, independent of your critter. Handy for backing up a layout
  you like or trying someone else's room without losing your own critter.
- **🧠** (or <kbd>\`</kbd>) opens the brain inspector: utility vs. neural
  toggle, per-action scores, the live sensory vector, and a cell-by-cell
  collision map (also toggleable on its own with <kbd>G</kbd>).

## sprite-forge: turning a 3D model into game art

`tools/sprite-forge/index.html` (open directly, or via the dev server) is a
small standalone Three.js tool that loads a `.glb`/`.gltf` model and renders
it at this game's *exact* isometric projection — not an approximation, a
camera angle numerically solved to match `src/render/iso.js`'s 2:1 tile
ratio — so the PNGs it exports drop straight into `assets/sprites/` with no
angle correction needed.

Beyond the export itself, it doubles as the tool for figuring out *how a
critter should use* a piece of furniture:

- Drop in one of the bundled Kenney models (or your own `.glb`) and it
  auto-fits to a declared footprint (1×1, 2×1, 2×2, …).
- Preview a critter reference standing, sitting, lying down, or reaching
  for a held item beside the piece — matching how the game itself treats
  occupiable furniture (sit/lie, the critter's own cell) versus
  ring-approached furniture (fridges, bookshelves — used from an adjacent
  cell).
- **Auto-detect** raycasts the model's real geometry to propose where the
  seat actually is, or click-and-drag directly on the model to place it by
  hand. The result reads out as `seatX`/`seatY`/`seatH` (or `reachH`),
  ready to paste into the matching entry in `src/world/objects.js`.
- A preview `tall` cap slider shows exactly how the sprite will look
  squashed to whatever height the furniture def caps it at in-game, since
  `drawSprite()` stretches rather than crops an oversized sprite.

## Assets & credits

Furniture models and reference sprites are Kenney's CC0 [Furniture
Kit](https://kenney.nl/assets/furniture-kit) — free for any use, no
attribution required, credited here anyway because it's good work.
Everything else (code, the critter's own procedural art, the world/brain
simulation) is original to this project.
