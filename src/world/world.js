// The room: a tile grid, the furniture in it, a clock, and the physical signals
// (light, sound) that the critter's senses read. The world knows nothing about
// any critter in it — it only publishes state — which is what lets more than
// one critter share the same world unmodified.

import { makeObject, useCells, adjacentCells, canOccupyObject, syncObjectFootprint, DEFS } from './objects.js';
import { clamp } from '../core/util.js';

export const COLS = 12, ROWS = 13;
export const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];   // SE, SW, NW, NE on screen

/** Minutes of sim time that pass per real second at 1x speed. */
export const MINUTES_PER_SECOND = 1.6;

/** Where the door sits along the gx=0 wall (grid y). Shared with the renderer
 *  so the drawn doorway always lines up with the tile the door logically owns. */
export const DOOR_GY = 4;

// Three rooms out of one grid, the same trick twice: a solid wall the width
// of the house with one togglable gate in it. Room A (kitchen/dining, gy
// 0-4) — Room B (bedroom/living, gy 6-8) — Room C (game/reading room, gy
// 10-12), each gate independently lockable.
const GATE_GX = 7;
const GATE2_GX = 4;
export const ROOM_SPLIT_GY = 5;
export const ROOM_SPLIT_GY2 = 9;

/** A slow backdrop cycle — every SEASON_LENGTH_DAYS days the season turns
 *  over, tinting the window and nudging weather odds and need decay a touch.
 *  Purely atmospheric; nothing here is punishing. */
export const SEASON_LENGTH_DAYS = 4;
export const SEASONS = ['spring', 'summer', 'autumn', 'winter'];
export const SEASON_TINTS = {
  spring: '#8fd0a0', summer: '#f2d879', autumn: '#e0975a', winter: '#bcd6e8',
};
const WEATHER_ODDS = {
  spring: { clear: 0.5, cloudy: 0.2, rain: 0.3 },
  summer: { clear: 0.75, cloudy: 0.15, rain: 0.1 },
  autumn: { clear: 0.35, cloudy: 0.25, rain: 0.4 },
  winter: { clear: 0.4, cloudy: 0.2, snow: 0.4 },
};

/** Wallpaper/floor presets for the room editor's paint tool. */
export const ROOM_THEMES = {
  cozy:   { label: 'Cozy',   wall: '#5c5779', wallDark: '#4f4a68', floorA: '#9c7a55', floorB: '#916f4c' },
  ocean:  { label: 'Ocean',  wall: '#3d6b7a', wallDark: '#335967', floorA: '#7a9ba8', floorB: '#6e8d99' },
  forest: { label: 'Forest', wall: '#4a6b4a', wallDark: '#3e5a3e', floorA: '#7a8f5c', floorB: '#6e8252' },
  sunset: { label: 'Sunset', wall: '#8a4f5c', wallDark: '#743f4a', floorA: '#c98f6c', floorB: '#bd8260' },
  mono:   { label: 'Mono',   wall: '#4a4a52', wallDark: '#3d3d44', floorA: '#8a8a92', floorB: '#7e7e86' },
  grape:  { label: 'Grape',  wall: '#5c4d7a', wallDark: '#4d4068', floorA: '#8a7aa8', floorB: '#7e6e9c' },
};

const LAYOUT = [
  // back wall (gy=0), kitchen on the left, bathroom on the right
  ['fridge', 0, 0], ['stove', 1, 0], ['counter', 2, 0], ['sink', 3, 0],
  ['trashcan', 4, 0], ['vent', 4, 0], ['window', 6, 0], ['coffee_machine', 7, 0],
  ['toilet', 9, 0], ['shower', 10, 0],
  // left wall (gx=0): bookshelf up top, door mid-wall (kept clear)
  ['bookshelf', 0, 2],
  // room A interior: dining, a teleporter pad and roller to play with.
  // The teleporter used to sit at (1,4) — right next to the door at
  // (0, DOOR_GY=4). With both a stone's throw from wherever a critter was
  // already standing, use_teleporter and explore_outside routinely scored
  // within a hair of each other (both include a travel(t) term that's
  // near-zero for either target from right there), and the brain re-deciding
  // every think tick could flip between them before either finished —
  // reads as a critter stuck bouncing between the door and the teleporter,
  // even though each action's own destination logic is correct on its own.
  // Moved it two rows clear of the door's row entirely so the two stop
  // being each other's closest-scoring neighbor.
  ['table', 5, 3], ['chair', 5, 4, { state: { face: 3 } }], ['chair', 6, 4, { state: { face: 3 } }],
  ['plant', 3, 2], ['plant', 11, 3],
  ['teleporter', 3, 3, { state: { pairId: 'A' } }], ['roller', 3, 4, { state: { dir: 1 } }],

  // dividing wall #1, one tile at a time, with a gap at GATE_GX
  ...Array.from({ length: COLS }, (_, gx) => gx)
    .filter((gx) => gx !== GATE_GX)
    .map((gx) => ['wall_seg', gx, ROOM_SPLIT_GY]),
  ['gate', GATE_GX, ROOM_SPLIT_GY, { state: { open: true } }],

  // room B: bedroom, bathroom-adjacent tub, and the living/game area
  ['bed', 0, 7], ['lamp', 2, 7], ['bathtub', 3, 6], ['mirror', 0, 6],
  ['sofa', 8, 6], ['rug', 9, 6], ['tv', 11, 6], ['ball', 6, 6], ['jukebox', 6, 8],
  ['teleporter', 10, 8, { state: { pairId: 'A' } }],

  // dividing wall #2, with a gap at GATE2_GX
  ...Array.from({ length: COLS }, (_, gx) => gx)
    .filter((gx) => gx !== GATE2_GX)
    .map((gx) => ['wall_seg', gx, ROOM_SPLIT_GY2]),
  ['gate', GATE2_GX, ROOM_SPLIT_GY2, { state: { open: true } }],

  // room C: a small game & reading room
  ['bookshelf', 0, 10], ['chair', 2, 11], ['toybox', 5, 11], ['dice', 6, 11], ['plant', 10, 11],
  ['fish_tank', 8, 10], ['workbench', 11, 10],
];

const MESS_CAP = 8;

/**
 * A cheap fingerprint of the starting layout. Object ids are assigned purely
 * by array order, so if the layout is ever reordered or extended (which it
 * will be, repeatedly, during development), old saves' per-object state would
 * silently land on the *wrong* objects if we trusted ids blindly. Comparing
 * this against a saved copy lets restore() notice a mismatch and skip the
 * per-object state — everything else in a save (critters, clock, messes)
 * stays layout-independent and safe to keep.
 */
export const LAYOUT_SIGNATURE = LAYOUT.length + ':' + LAYOUT.map(([t, x, y]) => `${t}@${x},${y}`).join('|');

export function createWorld() {
  const objects = LAYOUT.map(([type, gx, gy, opts]) => makeObject(type, gx, gy, opts));

  const world = {
    cols: COLS, rows: ROWS,
    objects,
    minutes: 8 * 60,          // start at 08:00
    day: 0,
    sounds: [],               // transient { gx, gy, loud, tag, life } — for critter hearing
    audioQueue: [],           // one-shot { tag, loud } — for actual playback, drained every frame
    messes: [],               // { gx, gy, kind, amount, blobs }
    lightsForced: null,       // user override for the lamp
    doorLocked: true,
    coins: 60,   // shared household purse — spent in the room editor's shop
    materials: 0,   // shared crafting resource, brought back from trips outside
    weather: 'clear',   // 'clear' | 'cloudy' | 'rain' | 'snow', re-rolled once a day

    season() { return SEASONS[Math.floor(world.day / SEASON_LENGTH_DAYS) % 4]; },

    _rollWeather() {
      const odds = WEATHER_ODDS[world.season()];
      let roll = Math.random(), acc = 0;
      for (const [k, p] of Object.entries(odds)) { acc += p; if (roll <= acc) { world.weather = k; return; } }
      world.weather = 'clear';
    },
    decor: { A: 'cozy', B: 'cozy', C: 'cozy' },   // theme id per room, from ROOM_THEMES

    /** 'A' (kitchen/dining), 'B' (bedroom/living), or 'C' (game/reading), by gy band. */
    roomAt(gx, gy) { return gy < ROOM_SPLIT_GY ? 'A' : gy < ROOM_SPLIT_GY2 ? 'B' : 'C'; },
    themeFor(room) { return ROOM_THEMES[world.decor[room]] || ROOM_THEMES.cozy; },
    _blocked: new Uint8Array(COLS * ROWS),
    _region: new Int16Array(COLS * ROWS).fill(-1),
    // Cells physically entered to use an item (chairs, beds, sofas, baths,
    // showers and pads). They are valid explicit destinations, never routes.
    _sitCells: new Set(),
    // Cells findPath may use only as an explicit destination (the room rim
    // and occupiable item footprints). This prevents a sofa becoming a handy
    // shortcut while still allowing "flop on sofa" to enter its cushion.
    _noTransit: new Set(),
    // A partition wall or gate is a thin line drawn along ONE edge of its
    // cell — not a floor-to-ceiling block filling the whole tile — but it
    // used to be collision-blocked as a full cell anyway, for every gx along
    // the dividing row. That made the entire row impassable while only a
    // sliver of it was ever drawn as "wall", so most of what looked like
    // ordinary open floor silently refused entry, and a room lost a full row
    // of usable space it visually appeared to have. Blocking the specific
    // crossing a wall/gate actually sits on — instead of the cell it
    // happens to be filed under — is what a low partition or a door should
    // do: stand right next to it from either side, only the step across it
    // is disallowed (and only while a gate is shut). Keyed by
    // edgeKey(ax,ay,bx,by), direction-independent.
    _blockedEdges: new Set(),

    inBounds: (x, y) => x >= 0 && y >= 0 && x < COLS && y < ROWS,

    /** Direction-independent key for the edge between two adjacent cells. */
    edgeKey(ax, ay, bx, by) {
      return (ay < by || (ay === by && ax < bx)) ? `${ax},${ay}|${bx},${by}` : `${bx},${by}|${ax},${ay}`;
    },
    /** Is stepping directly between these two (adjacent) cells disallowed? */
    edgeBlocked(ax, ay, bx, by) {
      return world._blockedEdges.has(world.edgeKey(ax, ay, bx, by));
    },

    // The outermost ring of cells sits flush against the room's true bounds.
    // Camera rotation decides which two walls are "far" (drawn solid) and
    // which two are "near" (culled so you can see into the room) — over a
    // full rotation every wall takes a turn being the hidden one, and on
    // that side there's nothing behind the last row of tiles but void. A
    // critter's round silhouette is wider than a half-tile, so standing
    // exactly on that ring visibly pokes past the floor's edge no matter
    // which side is currently open. Keeping free-roam idling one cell in
    // from every edge sidesteps it without touching rendering.
    isPerimeter: (x, y) => x === 0 || y === 0 || x === COLS - 1 || y === ROWS - 1,

    isWalkable(x, y, ignoreObject = null) {
      if (!world.inBounds(x, y)) return false;
      if (world._blocked[y * COLS + x] !== 0) return false;
      // Mobile toys cannot live in the static collision bitmap because their
      // position changes continuously, but their current cell still belongs
      // to them and must not be selected as a critter path cell — while
      // they're actually in motion. A toy that's rolled to a stop is just a
      // small prop sitting on the floor, no different from anything else
      // non-solid; blocking its cell even at rest let a ball that happened
      // to settle in a doorway-width gap seal off everyone on one side with
      // no way through until something moved it again (rollMobile uses this
      // same 0.04 speed floor to decide a roll has finished).
      return !objects.some((o) => o !== ignoreObject && o.def.mobile
        && (o.hop > 0 || Math.hypot(o.vx, o.vy) > 0.04)
        && Math.round(o.fx) === x && Math.round(o.fy) === y);
    },

    /** Prefer the nearest usable cushion when an occupiable item exposes more
     *  than one destination cell. These cells are never through-routes. */
    stepCost(x, y) {
      const o = world.objectAt(x, y);
      return o && (o.def.sit || o.def.standOn) ? 2.5 : 1;
    },

    /** The push vector a roller at this cell applies, or null. The world
     *  stays passive here too — it just answers the question; creature.js
     *  decides whether and how to act on it. */
    rollerAt(x, y) {
      const o = objects.find((r) => r.type === 'roller' && r.gx === x && r.gy === y);
      if (!o) return null;
      return DIRS[o.state.dir ?? 0];
    },

    objectAt(x, y) {
      for (const o of objects) {
        if (x >= o.gx && x < o.gx + o.w && y >= o.gy && y < o.gy + o.h && !o.def.flat) return o;
      }
      return null;
    },

    /** The item a player means when selecting a cell. Physical collision
     *  intentionally ignores rugs, pads and other flat items; selection must
     *  not. Prefer a non-flat piece when both share the same tile, then the
     *  most recently added flat piece. */
    selectableAt(x, y) {
      const physical = world.objectAt(x, y);
      if (physical) return physical;
      for (let i = objects.length - 1; i >= 0; i--) {
        const o = objects[i];
        if (x >= o.gx && x < o.gx + o.w && y >= o.gy && y < o.gy + o.h) return o;
      }
      return null;
    },

    byType: (type) => objects.filter((o) => o.type === type),
    first: (type) => objects.find((o) => o.type === type) || null,
    byId: (id) => objects.find((o) => o.id === id) || null,

    /** Objects offering a given affordance, e.g. 'sleep'. */
    offering(act) { return objects.filter((o) => o.def.acts.includes(act)); },

    /**
     * Walkable cells from which `o` can be used. Cells already occupied by a
     * *different* object are excluded — otherwise "use the toilet" could mean
     * standing inside the shower next door, and "open the fridge" could be
     * blocked by whatever happens to be one tile over.
     */
    _validApproachCells(o, cells) {
      const usable = cells.filter(([x, y]) => {
        if (!world.inBounds(x, y) || !world.isWalkable(x, y)) return false;
        const occupying = world.objectAt(x, y);
        return !occupying || (occupying === o && canOccupyObject(o));
      });
      // Stand inside the room to use something whenever there's the option.
      // A piece pushed up against an edge can otherwise be worked from the
      // rim tile beside it, which puts the critter out on the brink — the
      // one place the perimeter rule can't stop them, since a destination is
      // always allowed. Only fall back to the rim if it's the sole way in.
      // That reasoning is about loitering at the map's edge to reach
      // something merely NEARBY, though — it has no business vetoing an
      // occupiable item's own footprint cells. The bed against the west
      // wall has two of its four tiles sitting on that same rim column;
      // those aren't a critter idling at the edge, they're literally the
      // bed, and excluding them left it enterable from only half of itself.
      const own = usable.filter(([x, y]) => world.objectAt(x, y) === o);
      const ring = usable.filter(([x, y]) => world.objectAt(x, y) !== o);
      const innerRing = ring.filter(([x, y]) => !world.isPerimeter(x, y));
      return own.concat(innerRing.length ? innerRing : ring);
    },

    approachCells(o) {
      return world._validApproachCells(o, useCells(o));
    },

    /** Explicit alias used by observation actions. All interactions now use
     *  exterior cells, so this intentionally matches approachCells(). */
    exteriorApproachCells(o) {
      return world._validApproachCells(o, adjacentCells(o));
    },

    center(o) { return { gx: o.gx + o.w / 2, gy: o.gy + o.h / 2 }; },

    rebuildCollision() {
      world._blocked.fill(0);
      world._sitCells.clear();
      world._blockedEdges.clear();
      // The rim of the grid runs flush against the room's edge, and on
      // whichever two sides the camera has opened up there is nothing beyond
      // it but void — critters strolling along it look like they're walking
      // on the wall. Bar it as a through route but retain it as an explicit
      // destination so the door and wall-adjacent interactions stay reachable.
      world._noTransit.clear();
      for (let x = 0; x < COLS; x++) {
        for (let y = 0; y < ROWS; y++) {
          if (world.isPerimeter(x, y)) world._noTransit.add(x + ',' + y);
        }
      }
      for (const o of objects) {
        if (canOccupyObject(o)) {
          for (let x = o.gx; x < o.gx + o.w; x++) {
            for (let y = o.gy; y < o.gy + o.h; y++) {
              if (world.inBounds(x, y)) {
                world._sitCells.add(x + ',' + y);
                world._noTransit.add(x + ',' + y);
              }
            }
          }
        }
        // A partition wall or gate: block the specific crossing it's drawn
        // on, not the tile it's filed under — see the _blockedEdges comment
        // above. Its own cell stays ordinary floor.
        if (o.def.edgeBlock) {
          if (o.type === 'gate' && o.state.open) continue;   // an open gate lets you through
          for (let x = o.gx; x < o.gx + o.w; x++) {
            for (let y = o.gy; y < o.gy + o.h; y++) {
              const ny = o.def.edgeBlock === 'N' ? y - 1 : y + 1;
              world._blockedEdges.add(world.edgeKey(x, y, x, ny));
            }
          }
          continue;
        }
        // Ordinary stationary pieces own their whole footprint. Occupiable
        // items are represented by destination-only cells above instead: a
        // critter may enter the exact item it was assigned, but A* cannot use
        // that item (or any other chair/bed/etc.) as a through route.
        if (o.def.flat || o.def.mobile || canOccupyObject(o)) continue;
        for (let x = o.gx; x < o.gx + o.w; x++) {
          for (let y = o.gy; y < o.gy + o.h; y++) {
            if (world.inBounds(x, y)) world._blocked[y * COLS + x] = 1;
          }
        }
      }
      world._rebuildRegions();
    },

    /**
     * Connected-component id per through-walkable cell (-1 if blocked,
     * destination-only, or out of bounds),
     * recomputed whenever collision changes — i.e. whenever a gate is
     * toggled or the editor adds/moves/removes furniture. This is what lets
     * a "is X actually reachable from here" check be an O(1) lookup instead
     * of a full pathfind: with a closed gate, a critter can plan all it
     * likes toward something on the far side of it and it'll just fail the
     * same way every time, uselessly. Knowing up front that two cells are
     * in different regions lets an action rule itself out before ever
     * committing to a doomed walk. Destination-only cells are related to
     * these components by regionsTouching() below.
     */
    _rebuildRegions() {
      world._region.fill(-1);
      let next = 0;
      const stack = [];
      for (let y = 0; y < ROWS; y++) {
        for (let x = 0; x < COLS; x++) {
          const i0 = y * COLS + x;
          // Destination-only cells (rim and occupiable items) are endpoints,
          // not connective floor. Letting this flood pass through them while
          // A* refuses to do so makes the cheap reachability check lie about
          // beds/benches that plug a narrow passage.
          if (world._blocked[i0] || world._noTransit.has(x + ',' + y)
            || world._region[i0] !== -1) continue;
          world._region[i0] = next;
          stack.push(x, y);
          while (stack.length) {
            const cy = stack.pop(), cx = stack.pop();
            for (const [dx, dy] of DIRS) {
              const nx = cx + dx, ny = cy + dy;
              if (!world.inBounds(nx, ny)) continue;
              const ni = ny * COLS + nx;
              if (world._blocked[ni] || world._noTransit.has(nx + ',' + ny)
                || world._region[ni] !== -1) continue;
              if (world.edgeBlocked(cx, cy, nx, ny)) continue;
              world._region[ni] = next;
              stack.push(nx, ny);
            }
          }
          next++;
        }
      }
    },

    regionOf(gx, gy) {
      if (!world.inBounds(gx, gy)) return -1;
      return world._region[Math.round(gy) * COLS + Math.round(gx)];
    },

    /** Transit components directly reachable from a cell. For ordinary floor
     *  this is its own component; for a destination-only cell it is whichever
     *  component(s) touch it across an open cardinal edge. Keeping the set is
     *  important: one seat is allowed to be approachable from two rooms, but
     *  it must never merge those rooms into one traversable component. */
    regionsTouching(gx, gy) {
      const x = Math.round(gx), y = Math.round(gy);
      const regions = new Set();
      const own = world.regionOf(x, y);
      if (own !== -1) regions.add(own);
      for (const [dx, dy] of DIRS) {
        const nx = x + dx, ny = y + dy;
        if (!world.inBounds(nx, ny) || world.edgeBlocked(x, y, nx, ny)) continue;
        const region = world.regionOf(nx, ny);
        if (region !== -1) regions.add(region);
      }
      return regions;
    },

    /** Can you actually walk from (ax,ay) to (bx,by) — not just is (bx,by)
     *  itself unblocked, but is there a connected path at all? */
    sameRegion(ax, ay, bx, by) {
      if (Math.round(ax) === Math.round(bx) && Math.round(ay) === Math.round(by)) return true;
      const from = world.regionsTouching(ax, ay);
      for (const region of world.regionsTouching(bx, by)) if (from.has(region)) return true;
      return false;
    },

    /** approachCells(o), filtered to only the cells actually reachable from
     *  (fromGx,fromGy) right now — the reachability-aware version most
     *  actions should use when picking a target to walk to. */
    reachableApproachCells(o, fromGx, fromGy) {
      const fromRegions = world.regionsTouching(fromGx, fromGy);
      return world.approachCells(o).filter(([x, y]) => {
        if (x === Math.round(fromGx) && y === Math.round(fromGy)) return true;
        for (const region of world.regionsTouching(x, y)) if (fromRegions.has(region)) return true;
        return false;
      });
    },

    /** Does the straight line a->b pass through something tall? Bresenham-ish. */
    lineOfSight(ax, ay, bx, by) {
      const steps = Math.max(Math.abs(bx - ax), Math.abs(by - ay)) * 2;
      if (steps === 0) return true;
      for (let i = 1; i < steps; i++) {
        const t = i / steps;
        const x = Math.round(ax + (bx - ax) * t);
        const y = Math.round(ay + (by - ay) * t);
        if (x === bx && y === by) break;
        const o = world.objectAt(x, y);
        // A gate's def can't just carry blocksSight:true the way a solid
        // wall does — it swings between blocking and not, same as it
        // already does for collision. Without this a closed gate still lets
        // a critter "see" (and so perceive/pathfind toward) whatever is on
        // the far side, even though it physically can't get there.
        if (o && (o.def.blocksSight || (o.type === 'gate' && !o.state.open))) return false;
      }
      return true;
    },

    // -------------------------------------------------------------- editor

    earnCoins(amount) { world.coins += amount; },
    earnMaterials(amount) { world.materials += amount; },
    spendMaterials(amount) {
      if (world.materials < amount) return false;
      world.materials -= amount;
      return true;
    },

    /** True and deducted if there's enough; false and untouched otherwise. */
    spendCoins(amount) {
      if (world.coins < amount) return false;
      world.coins -= amount;
      return true;
    },

    /** Would `type` fit at (gx,gy)? Used to preview furniture placement. */
    canPlace(type, gx, gy) {
      const def = DEFS[type];
      if (!def) return false;
      for (let x = gx; x < gx + def.w; x++) {
        for (let y = gy; y < gy + def.h; y++) {
          if (!world.inBounds(x, y)) return false;
          if (!def.flat && world.objectAt(x, y)) return false;
          // The door cell has no gate of its own to open — it's the one
          // permanently-clear way out. A solid piece parked there blocks
          // isWalkable for good, and nothing else in the game ever offers a
          // way to undo that (explore_outside would just quietly stop
          // being pickable, forever, with no obvious cause).
          if (!def.flat && x === 0 && y === DOOR_GY) return false;
        }
      }
      return true;
    },

    /** Add a new piece of furniture. Returns the created object, or null if
     *  the cell is already taken (used by the room-editor placement tool). */
    addObject(type, gx, gy, opts) {
      if (!world.canPlace(type, gx, gy)) return null;
      const o = makeObject(type, gx, gy, opts);
      objects.push(o);
      world.rebuildCollision();
      return o;
    },

    removeObject(id) {
      const i = objects.findIndex((o) => o.id === id);
      if (i < 0) return false;
      objects.splice(i, 1);
      world.rebuildCollision();
      return true;
    },

    /** Move existing furniture to a new cell, if it's free. */
    moveObject(id, gx, gy) {
      const o = world.byId(id);
      if (!o) return false;
      for (let x = gx; x < gx + o.w; x++) {
        for (let y = gy; y < gy + o.h; y++) {
          if (!world.inBounds(x, y)) return false;
          const occ = world.objectAt(x, y);
          if (!o.def.flat && occ && occ !== o) return false;
          if (!o.def.flat && x === 0 && y === DOOR_GY) return false;
        }
      }
      o.gx = gx; o.gy = gy;
      if (o.def.mobile) { o.fx = gx; o.fy = gy; }
      world.rebuildCollision();
      return true;
    },

    /** Turn a piece in place. Directional items get four real facings and a
     *  rectangular piece swaps its live collision footprint on quarter turns.
     *  Simpler hand-drawn decorations retain the old two-way mirror fallback. */
    rotateObject(id, direction = 1) {
      const o = world.byId(id);
      if (!o || o.def.structural) return false;
      if (o.type === 'chair') {
        o.state.face = ((o.state.face ?? 1) + direction + 4) % 4;
      } else if (o.def.directional) {
        const nextRotation = ((o.state.rotation ?? 0) + direction + 4) % 4;
        const nextW = o.def.rotatesFootprint && (nextRotation & 1) ? o.def.h : o.def.w;
        const nextH = o.def.rotatesFootprint && (nextRotation & 1) ? o.def.w : o.def.h;

        // A 2x1 sofa/table/desk can only turn if the new 1x2 footprint also
        // fits. Failed turns leave both its art and collision map untouched.
        for (let x = o.gx; x < o.gx + nextW; x++) {
          for (let y = o.gy; y < o.gy + nextH; y++) {
            if (!world.inBounds(x, y)) return false;
            const occ = world.objectAt(x, y);
            if (!o.def.flat && occ && occ !== o) return false;
            if (!o.def.flat && x === 0 && y === DOOR_GY) return false;
          }
        }
        o.state.rotation = nextRotation;
        syncObjectFootprint(o);
        world.rebuildCollision();
      } else {
        o.state.flip = !o.state.flip;
      }
      return true;
    },

    // ---------------------------------------------------------------- mess

    /** Drop a bit of mess on the floor near (gx,gy). Merges with what's there. */
    addMess(gx, gy, kind = 'crumbs') {
      let x = gx, y = gy;
      if (!world.isWalkable(x, y)) {
        const spot = DIRS.map(([dx, dy]) => [x + dx, y + dy]).find(([a, b]) => world.isWalkable(a, b));
        if (!spot) return null;
        [x, y] = spot;
      }
      const existing = world.messes.find((m) => m.gx === x && m.gy === y);
      if (existing) { existing.amount = clamp(existing.amount + 0.35); return existing; }
      if (world.messes.length >= MESS_CAP) return null;
      const blobs = [];
      for (let i = 0; i < 3; i++) {
        blobs.push([(Math.random() - 0.5) * 14, (Math.random() - 0.5) * 7, 1.6 + Math.random() * 2.4]);
      }
      const m = { gx: x, gy: y, kind, amount: 0.45, blobs };
      world.messes.push(m);
      return m;
    },

    removeMess(m) {
      const i = world.messes.indexOf(m);
      if (i >= 0) world.messes.splice(i, 1);
    },

    messNear(gx, gy) {
      let best = null, bestD = Infinity;
      for (const m of world.messes) {
        const d = Math.abs(m.gx - gx) + Math.abs(m.gy - gy);
        if (d < bestD) { bestD = d; best = m; }
      }
      return best ? { mess: best, dist: bestD } : null;
    },

    /** Send the ball rolling away from (fromX,fromY). */
    kick(o, fromX, fromY, power = 5) {
      const dx = o.fx - fromX, dy = o.fy - fromY;
      const d = Math.hypot(dx, dy) || 1;
      const spread = (Math.random() - 0.5) * 0.8;
      o.vx = ((dx / d) * Math.cos(spread) - (dy / d) * Math.sin(spread)) * power;
      o.vy = ((dx / d) * Math.sin(spread) + (dy / d) * Math.cos(spread)) * power;
      o.hop = 3;
      world.emitSound(o.gx, o.gy, 0.4, 'thud');
    },

    /** Send the ball rolling from its own position toward (toX,toY) — a deliberate pass, not a random kick-away. */
    kickToward(o, toX, toY, power = 5) {
      const dx = toX - o.fx, dy = toY - o.fy;
      const d = Math.hypot(dx, dy) || 1;
      const spread = (Math.random() - 0.5) * 0.3;
      o.vx = ((dx / d) * Math.cos(spread) - (dy / d) * Math.sin(spread)) * power;
      o.vy = ((dx / d) * Math.sin(spread) + (dy / d) * Math.cos(spread)) * power;
      o.hop = 3;
      world.emitSound(o.gx, o.gy, 0.4, 'thud');
    },

    emitSound(gx, gy, loud, tag) {
      world.sounds.push({ gx, gy, loud, tag, life: 1.2 });
      if (world.sounds.length > 24) world.sounds.shift();
      world.audioQueue.push({ tag, loud });   // drained once per frame by main.js for actual playback
    },

    /** Empties and returns the pending one-shot sound events for this frame. */
    drainAudioQueue() {
      const q = world.audioQueue;
      world.audioQueue = [];
      return q;
    },

    /** 0..1 daylight through the window. */
    daylight() {
      const h = world.minutes / 60;
      if (h < 5 || h > 21) return 0.03;
      if (h < 7) return (h - 5) / 2 * 0.9;
      if (h > 19) return (21 - h) / 2 * 0.9;
      return 0.92;
    },

    /** Combined illumination 0..1 — drives the render tint and the light sense. */
    lightLevel() {
      let l = world.daylight();
      for (const o of objects) {
        if (o.state.on && o.def.emitsWhenOn) l = Math.max(l, o.def.emitsWhenOn.light);
      }
      return clamp(l);
    },

    /** Continuous + transient loudness at a point, 0..1. */
    soundAt(gx, gy) {
      let s = 0;
      for (const o of objects) {
        if (!o.state.on || !o.def.emitsWhenOn || !o.def.emitsWhenOn.sound) continue;
        const c = world.center(o);
        const d = Math.hypot(c.gx - gx, c.gy - gy);
        s = Math.max(s, o.def.emitsWhenOn.sound * Math.exp(-d / 5));
      }
      for (const ev of world.sounds) {
        const d = Math.hypot(ev.gx - gx, ev.gy - gy);
        s = Math.max(s, ev.loud * Math.exp(-d / 6) * clamp(ev.life));
      }
      return clamp(s);
    },

    tick(dt) {
      world.minutes += dt * MINUTES_PER_SECOND;
      while (world.minutes >= 1440) {
        world.minutes -= 1440; world.day++;
        world._rollWeather();
      }

      for (let i = world.sounds.length - 1; i >= 0; i--) {
        world.sounds[i].life -= dt;
        if (world.sounds[i].life <= 0) world.sounds.splice(i, 1);
      }

      // Lamps follow the daylight unless the user has flipped the switch.
      const lamp = world.first('lamp');
      if (lamp) {
        const wantLight = world.daylight() < 0.35;
        lamp.state.on = world.lightsForced === null ? wantLight : world.lightsForced;
      }

      const hours = (dt * MINUTES_PER_SECOND) / 60;

      for (const o of objects) {
        if (o.type === 'stove' && o.state.on) {
          o.state.cookT = (o.state.cookT || 0) + dt;
          if ((o.state.cookT * MINUTES_PER_SECOND) % 4 < dt * MINUTES_PER_SECOND) {
            world.emitSound(o.gx, o.gy, 0.35, 'sizzle');
          }
        }
        if (o.def.thirsty) {
          o.state.thirst = clamp((o.state.thirst || 0) + hours * 0.055);
        }
        if (o.def.hungry) {
          o.state.hunger = clamp((o.state.hunger || 0) + hours * 0.045);
        }
        if (o.type === 'trashcan') {
          o.state.level = clamp((o.state.level || 0) + hours * 0.012);
        }
        if (o.def.mobile) rollMobile(o, dt);
      }
    },

    serialize() {
      return {
        layoutSignature: LAYOUT_SIGNATURE,
        minutes: world.minutes, day: world.day, lightsForced: world.lightsForced,
        doorLocked: world.doorLocked, coins: world.coins, decor: world.decor,
        materials: world.materials, weather: world.weather,
        messes: world.messes,
        objects: objects.map((o) => ({
          id: o.id, type: o.type, gx: o.gx, gy: o.gy, state: o.state, fx: o.fx, fy: o.fy,
        })),
      };
    },

    restore(data) {
      if (!data) return;
      world.minutes = data.minutes ?? world.minutes;
      world.day = data.day ?? 0;
      world.lightsForced = data.lightsForced ?? null;
      world.doorLocked = data.doorLocked ?? true;
      world.coins = data.coins ?? world.coins;
      world.materials = data.materials ?? world.materials;
      world.weather = data.weather ?? world.weather;
      if (data.decor) Object.assign(world.decor, data.decor);
      world.messes = (data.messes || []).filter((m) => m && m.blobs);

      if (data.layoutSignature !== LAYOUT_SIGNATURE) {
        // The starting layout changed since this save was written — ids no
        // longer line up with the same furniture, so leave every object at
        // its fresh default state rather than risk assigning, say, a closed
        // gate's state onto what is now a lamp.
        console.warn('iso-critter: room layout changed since last save — furniture state reset, everything else kept.');
        return;
      }

      // Default-layout furniture always exists at this point — createWorld()
      // rebuilds the full shipped set before restore() ever runs — but the
      // player may have deleted some of it last session. Ids 1..LAYOUT.length
      // are exactly the default set (assigned in that order, once, at module
      // load), so anything in that range missing from the save was deleted
      // and belongs gone, not silently reappearing on every reload.
      const savedIds = new Set((data.objects || []).map((r) => r.id));
      for (let i = objects.length - 1; i >= 0; i--) {
        const o = objects[i];
        if (o.id <= LAYOUT.length && !savedIds.has(o.id)) objects.splice(i, 1);
      }

      for (const rec of data.objects || []) {
        const o = objects.find((x) => x.id === rec.id);
        if (o) {
          Object.assign(o.state, rec.state);
          syncObjectFootprint(o);
          if (o.def.mobile && typeof rec.fx === 'number') {
            o.fx = rec.fx; o.fy = rec.fy;
            o.gx = Math.round(o.fx); o.gy = Math.round(o.fy);
          } else if (typeof rec.gx === 'number' && typeof rec.gy === 'number'
            && world.inBounds(rec.gx, rec.gy)) {
            // Only `state` (on/off, plate, borrowed book...) used to survive
            // a reload — a table dragged across the room in the editor
            // snapped straight back to its shipped position every time,
            // silently, because position was saved but never applied back.
            o.gx = rec.gx; o.gy = rec.gy;
          }
          continue;
        }
        // An object saved from a room the editor had extended — recreate it,
        // but only where it actually still fits; a stale save shouldn't be
        // able to drop furniture on top of whatever occupies that cell now.
        if (DEFS[rec.type] && world.canPlace(rec.type, rec.gx, rec.gy)) {
          const fresh = makeObject(rec.type, rec.gx, rec.gy, { state: rec.state });
          objects.push(fresh);
        }
      }
      world.rebuildCollision();
    },
  };

  function rollMobile(o, dt) {
    if (o.hop > 0) o.hop = Math.max(0, o.hop - dt * 12);
    const speed = Math.hypot(o.vx, o.vy);
    if (speed < 0.04) { o.vx = 0; o.vy = 0; return; }

    o.spin += speed * dt * 4;
    const nx = o.fx + o.vx * dt, ny = o.fy + o.vy * dt;
    const free = (x, y) => world.isWalkable(Math.round(x), Math.round(y), o);

    if (free(nx, o.fy)) o.fx = nx;
    else { o.vx = -o.vx * 0.55; world.emitSound(o.gx, o.gy, 0.3, 'bounce'); }
    if (free(o.fx, ny)) o.fy = ny;
    else { o.vy = -o.vy * 0.55; world.emitSound(o.gx, o.gy, 0.3, 'bounce'); }

    o.fx = Math.max(0, Math.min(COLS - 1, o.fx));
    o.fy = Math.max(0, Math.min(ROWS - 1, o.fy));
    o.gx = Math.round(o.fx); o.gy = Math.round(o.fy);

    const drag = Math.exp(-1.9 * dt);
    o.vx *= drag; o.vy *= drag;
  }

  world.rebuildCollision();
  world._rollWeather();
  return world;
}
