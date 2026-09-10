(function () {
"use strict";
// ---- src/core/loop.js ----
// Fixed-timestep simulation with an uncapped render pass.
// The brain must see a stable dt or utility scores jitter, so sim steps are
// always exactly STEP seconds no matter what the display does.

const STEP = 1 / 30;

function startLoop({ update, render, maxCatchUp = 8 }) {
  let acc = 0, last = performance.now(), raf = 0;
  const state = { speed: 1, running: true, fps: 0 };
  let frames = 0, fpsT = 0;

  function frame(now) {
    raf = requestAnimationFrame(frame);
    let elapsed = (now - last) / 1000;
    last = now;
    if (elapsed > 0.25) elapsed = 0.25;      // tab was hidden — don't fast-forward a week

    if (state.running) {
      acc += elapsed * state.speed;
      let steps = 0;
      while (acc >= STEP && steps < maxCatchUp * state.speed) { update(STEP); acc -= STEP; steps++; }
      if (acc > STEP * 4) acc = 0;
    }

    frames++; fpsT += elapsed;
    if (fpsT >= 0.5) { state.fps = Math.round(frames / fpsT); frames = 0; fpsT = 0; }
    render(elapsed);
  }
  raf = requestAnimationFrame(frame);
  state.stop = () => cancelAnimationFrame(raf);
  return state;
}


// ---- src/core/audio.js ----
// Tiny synthesized sound effects — no audio files, just oscillators and noise
// bursts. The world already calls `emitSound(gx,gy,loud,tag)` everywhere
// something audible happens (a flush, a fridge door, a chime) as part of the
// critter's *hearing*; this module just also turns those same tags into
// actual sound, so nothing upstream needs to change to get audio.

let ctx = null;
let muted = false;
let musicNodes = null;

function ensureCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone(freq, dur, { type = 'sine', gain = 0.15, glideTo = null, delay = 0 } = {}) {
  const c = ensureCtx();
  const t0 = c.currentTime + delay;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t0 + dur);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.connect(g); g.connect(c.destination);
  osc.start(t0); osc.stop(t0 + dur + 0.02);
}

function noise(dur, { gain = 0.1, filterFreq = 1200, delay = 0 } = {}) {
  const c = ensureCtx();
  const t0 = c.currentTime + delay;
  const n = c.createBufferSource();
  const buf = c.createBuffer(1, c.sampleRate * dur, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  n.buffer = buf;
  const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = filterFreq;
  const g = c.createGain(); g.gain.setValueAtTime(gain, t0); g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  n.connect(f); f.connect(g); g.connect(c.destination);
  n.start(t0); n.stop(t0 + dur);
}

// tag -> a little synth patch. `loud` (0..1, from world.emitSound) scales gain.
const PATCHES = {
  fridge:  (l) => tone(180, 0.18, { type: 'square', gain: 0.06 * l }),
  flush:   (l) => noise(0.5, { gain: 0.12 * l, filterFreq: 900 }),
  water:   (l) => noise(0.6, { gain: 0.08 * l, filterFreq: 2200 }),
  sizzle:  (l) => noise(0.15, { gain: 0.05 * l, filterFreq: 3000 }),
  tv:      (l) => tone(440, 0.1, { type: 'triangle', gain: 0.05 * l }),
  'tv on': (l) => tone(300, 0.15, { type: 'triangle', gain: 0.08 * l, glideTo: 500 }),
  click:   (l) => tone(700, 0.05, { type: 'square', gain: 0.05 * l }),
  chute:   (l) => tone(220, 0.2, { type: 'sawtooth', gain: 0.06 * l, glideTo: 90 }),
  thud:    (l) => tone(90, 0.12, { type: 'sine', gain: 0.1 * l }),
  bounce:  (l) => tone(180, 0.08, { type: 'sine', gain: 0.06 * l }),
  tap:     (l) => tone(900, 0.06, { type: 'sine', gain: 0.05 * l }),
  zap:     (l) => { tone(600, 0.15, { type: 'sawtooth', gain: 0.08 * l, glideTo: 1400 }); tone(1400, 0.1, { gain: 0.05 * l, delay: 0.05 }); },
  gate:    (l) => tone(140, 0.25, { type: 'square', gain: 0.05 * l, glideTo: 100 }),
  chime:   (l) => { tone(660, 0.2, { gain: 0.08 * l }); tone(880, 0.25, { gain: 0.07 * l, delay: 0.08 }); },
  buzz:    (l) => tone(120, 0.25, { type: 'sawtooth', gain: 0.08 * l }),
  coin:    (l) => { tone(988, 0.08, { gain: 0.08 * l }); tone(1319, 0.12, { gain: 0.07 * l, delay: 0.06 }); },
  'music on': (l) => tone(392, 0.2, { gain: 0.06 * l, glideTo: 523 }),
  birthday: (l) => {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.22, { type: 'triangle', gain: 0.09 * l, delay: i * 0.1 }));
  },
};

function createAudio() {
  return {
    get muted() { return muted; },
    set muted(v) { muted = v; if (v) stopMusic(); },

    /** Called once from a real user gesture (a click) to satisfy autoplay policy. */
    unlock() { try { ensureCtx(); } catch { /* no Web Audio available — silently skip */ } },

    play(tag, loud = 0.5) {
      if (muted) return;
      const patch = PATCHES[tag];
      if (!patch) return;
      try { patch(Math.max(0.15, Math.min(1, loud))); } catch { /* ignore */ }
    },

    /** A tiny looping four-note phrase for the jukebox — not music, but the idea of it. */
    startMusic() {
      if (muted || musicNodes) return;
      try {
        const c = ensureCtx();
        const notes = [392, 440, 523, 440];
        let i = 0;
        const id = setInterval(() => {
          if (muted) return;
          tone(notes[i % notes.length], 0.35, { type: 'triangle', gain: 0.05 });
          i++;
        }, 420);
        musicNodes = { id };
      } catch { /* ignore */ }
    },
    stopMusic,
  };
}

function stopMusic() {
  if (musicNodes) { clearInterval(musicNodes.id); musicNodes = null; }
}


// ---- src/render/iso.js ----
// Isometric projection. One grid cell is a 32x16 diamond — the classic 2:1 ratio
// that keeps every edge on a clean pixel step.

const TILE_W = 32, TILE_H = 16;
const HW = TILE_W / 2, HH = TILE_H / 2;
const WALL_H = 30;

/** Grid (float tile coords) -> screen pixels. Returns the cell's north corner. */
function toScreen(gx, gy) {
  return { x: (gx - gy) * HW, y: (gx + gy) * HH };
}

/** Centre of a cell (or of a w*h footprint anchored at gx,gy). */
function cellCenter(gx, gy, w = 1, h = 1) {
  return toScreen(gx + w / 2, gy + h / 2);
}

/** Screen pixels -> fractional grid coords. Inverse of toScreen. */
function toGrid(sx, sy) {
  return { gx: (sy / HH + sx / HW) / 2, gy: (sy / HH - sx / HW) / 2 };
}

/** Painter's-algorithm depth key. Bigger = nearer the camera = drawn later. */
const depthOf = (gx, gy, w = 1, h = 1, bias = 0) => (gx + w) + (gy + h) + bias;

/** Fill the diamond of one cell. */
function tilePath(ctx, x, y) {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + HW, y + HH);
  ctx.lineTo(x, y + TILE_H);
  ctx.lineTo(x - HW, y + HH);
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// Furniture is drawn with local "+w" and "+h" extents (isoBox/isoPlate/
// boxFace below) rather than raw screen deltas, so that when the camera spins
// 90° the renderer can repoint what "+w" and "+h" mean on screen and every
// piece of furniture rotates along with the room, without each of the ~25
// draw() functions needing to know rotation exists. At rotation 0 these
// basis vectors are exactly the (HW,HH)/(-HW,HH) deltas the shapes always
// used; the renderer calls setRotation() once per frame to repoint them.
let rotation = 0;
const BASIS = {
  0: { w: [HW, HH], h: [-HW, HH] },
  1: { w: [-HW, HH], h: [-HW, -HH] },
  2: { w: [-HW, -HH], h: [HW, -HH] },
  3: { w: [HW, -HH], h: [HW, HH] },
};
function setRotation(r) { rotation = r & 3; }
const basis = () => BASIS[rotation];

/** Rotation-aware local "+w,+h" offset in screen pixels, for the odd piece of
 *  furniture (the chair's legs) that draws itself by hand instead of going
 *  through isoBox/isoPlate/boxFace. */
function localOffset(w, h) {
  const { w: W, h: H } = basis();
  return [w * W[0] + h * H[0], w * W[1] + h * H[1]];
}

/**
 * Draw an axis-aligned cuboid sitting on cells (0,0)..(w,h) relative to the
 * north corner at (x,y). Only the three camera-facing sides exist.
 */
function isoBox(ctx, x, y, w, h, ht, top, right, left) {
  const { w: W, h: H } = basis();
  const ax = x, ay = y;
  const bx = x + w * W[0], by = y + w * W[1];
  const dx = x + h * H[0], dy = y + h * H[1];
  const cx = bx + h * H[0], cy = by + h * H[1];

  if (right) { // +w face
    ctx.fillStyle = right;
    ctx.beginPath();
    ctx.moveTo(bx, by - ht); ctx.lineTo(cx, cy - ht); ctx.lineTo(cx, cy); ctx.lineTo(bx, by);
    ctx.closePath(); ctx.fill();
  }
  if (left) { // +h face
    ctx.fillStyle = left;
    ctx.beginPath();
    ctx.moveTo(cx, cy - ht); ctx.lineTo(dx, dy - ht); ctx.lineTo(dx, dy); ctx.lineTo(cx, cy);
    ctx.closePath(); ctx.fill();
  }
  if (top) {
    ctx.fillStyle = top;
    ctx.beginPath();
    ctx.moveTo(ax, ay - ht); ctx.lineTo(bx, by - ht); ctx.lineTo(cx, cy - ht); ctx.lineTo(dx, dy - ht);
    ctx.closePath(); ctx.fill();
  }
}

/** Flat diamond at an arbitrary height — table tops, rugs, puddles. */
function isoPlate(ctx, x, y, w, h, ht, color) {
  const { w: W, h: H } = basis();
  const bx = x + w * W[0], by = y + w * W[1];
  const dx = x + h * H[0], dy = y + h * H[1];
  const cx = bx + h * H[0], cy = by + h * H[1];
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y - ht);
  ctx.lineTo(bx, by - ht);
  ctx.lineTo(cx, cy - ht);
  ctx.lineTo(dx, dy - ht);
  ctx.closePath(); ctx.fill();
}

/**
 * A rectangle painted onto one visible face of an isoBox — door seams, handles,
 * oven windows. `u` runs 0..1 along the face; `h0`/`h1` are heights off the floor.
 * `side` is 'right' (+w face) or 'left' (+h face).
 */
function boxFace(ctx, x, y, w, h, side, u0, u1, h0, h1, color) {
  const { w: W, h: H } = basis();
  const bx = x + w * W[0], by = y + w * W[1];
  const dx = x + h * H[0], dy = y + h * H[1];
  const cx = bx + h * H[0], cy = by + h * H[1];
  const B = [bx, by], C = [cx, cy], D = [dx, dy];
  const [p, q] = side === 'right' ? [B, C] : [C, D];
  const at = (u, hh) => [p[0] + (q[0] - p[0]) * u, p[1] + (q[1] - p[1]) * u - hh];
  const a = at(u0, h1), b = at(u1, h1), c = at(u1, h0), d = at(u0, h0);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
  ctx.lineTo(c[0], c[1]); ctx.lineTo(d[0], d[1]);
  ctx.closePath(); ctx.fill();
}


// ---- src/render/palette.js ----
// One small, deliberately limited palette. Everything on screen is mixed from
// these so the room reads as a single illustration instead of a pile of assets.
const PAL = {
  floorA:   '#9c7a55', floorB:   '#916f4c', floorEdge:'#7a5c3e',
  wallL:    '#4f4a68', wallR:    '#5c5779', wallTop:  '#6d6889', wallTrim:'#3c3853',
  shadow:   'rgba(20,14,34,0.30)',

  wood:     '#8a5f3c', woodD:    '#6d4a2e', woodL:    '#a8794f',
  white:    '#e8e4f0', whiteD:   '#c4bed6', whiteS:   '#a49dbb',
  steel:    '#9aa3b8', steelD:   '#77808f', steelL:   '#bfc7d8',
  fabric:   '#3f7d84', fabricD:  '#2f6068', fabricL:  '#57a0a4',
  warm:     '#e0a05a', warmD:    '#c07f42',
  green:    '#5aa363', greenD:   '#3f7a4a',
  screen:   '#171a2c', screenOn: '#8fd8e8',
  glass:    '#7fb6c9', night:    '#2b3057',
  red:      '#d9625c', pink:     '#e79bb0',
  black:    '#241d33', ink:      '#2c2340',

  body:     '#f0c98a', bodyD:    '#d5a86a', bodyL:    '#fbe3b4',
  belly:    '#fdf1d8', blush:    '#f0918e',
};

/** Slightly darken/lighten a hex colour — used for dynamic lighting. */
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, ((n >> 16) & 255) + amt));
  const g = Math.max(0, Math.min(255, ((n >> 8) & 255) + amt));
  const b = Math.max(0, Math.min(255, (n & 255) + amt));
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}


// ---- src/render/sprites.js ----
// Pre-rendered isometric sprites (Kenney's CC0 "Furniture Kit", isometric PNG
// export) drawn alongside the procedurally-shaped furniture.
//
// Kenney's camera is NOT the same projection as ours. Ours is the classic
// 2:1 pixel-art dimetric (a tile's footprint diamond is exactly twice as
// wide as it is tall — HW:HH = 16:8). Measured directly off their floor
// tile sprite (floorFull_SW.png, 207x152px) by scanning its alpha channel
// for the diamond's actual corners: apex at (102,0), side corners at
// (0,73) and (206,72) — a half-width:half-height ratio of ~103:73, i.e.
// their diamond is visibly "taller" per unit of width than ours. Dropping
// their pixels straight in at one uniform scale is what made everything
// look skewed/misaligned against our grid.
//
// The angle is fixed by locking every sprite's drawn WIDTH to its actual
// grid footprint — (w+h)*HW, the exact width our own isoBox math gives a
// w×h procedural box — rather than trusting Kenney's raw pixel size to
// already match the footprint we assigned it (it doesn't always: a 2x2 bed
// isn't modeled at exactly "2x2 tiles" worth of their own floor-tile scale,
// so scaling its raw pixels landed it at roughly one tile wide). Height
// then follows the sprite's own aspect ratio (so nothing looks stretched)
// times ANGLE_CORRECTION, the one fixed ratio that converts a vertical
// Kenney pixel into a vertical pixel of ours.

const KENNEY_HALF_W = 103;   // floorFull_SW.png: (206-0)/2
const KENNEY_HALF_H = 73;    // floorFull_SW.png: side-corner y minus apex y

const ANGLE_CORRECTION = (HH / KENNEY_HALF_H) / (HW / KENNEY_HALF_W);

// Which compass file matches each of our 4 camera states, derived from
// FAR_EDGES in renderer.js (which two walls are "far"/solid at each
// rotation tells you where the camera itself must be standing):
// rotation 0 -> far walls N,W -> camera at SE, looking toward NW
// rotation 1 -> far walls S,W -> camera at NE
// rotation 2 -> far walls S,E -> camera at NW
// rotation 3 -> far walls N,E -> camera at SW
// The previous guess (['SW','NW','NE','SE']) was the exact reverse of this
// — off by a flipped rotation direction, which is what made a sprite's
// facing sit 90° off from where its cell highlight said it was.
const ROT_FILES = ['SE', 'NE', 'NW', 'SW'];

const cache = new Map();

function getImage(src) {
  let img = cache.get(src);
  if (!img) {
    img = new Image();
    img.src = src;
    cache.set(src, img);
  }
  return img;
}

/** Preload every rotation of every sprite up front so the first frame that
 *  needs one doesn't flash empty while it fetches. */
function preloadSprites(names) {
  for (const name of names) {
    for (const rot of ROT_FILES) getImage(`assets/sprites/${name}_${rot}.png`);
  }
}

let spriteRotation = 0;
function setSpriteRotation(r) { spriteRotation = r & 3; }

/**
 * Draw a 1x1-footprint sprite centered on the tile at local (x,y) — the
 * furniture draw() convention's north-corner screen position, same as every
 * isoBox/isoPlate call. `w,h` let a wider/deeper piece still center
 * correctly on its full footprint.
 *
 * `tall`, when given, is a CEILING in pixels, not a fixed height — the
 * aspect-ratio-derived height still wins whenever it's already under that
 * ceiling (which is most furniture; forcing an unrelated fixed number is
 * what made everything look squashed). It only steps in for a piece whose
 * natural proportions would otherwise run taller than the ceiling, e.g. the
 * bookshelf: its aspect ratio wants it ~47px tall, well above the ~30px
 * back wall, so it needed capping — most pieces never hit their ceiling.
 */
function drawSprite(ctx, x, y, name, opts = {}) {
  const {
    w = 1, h = 1, flip = false, angleOffset = 0, scale = 1, tall = null,
    anchorW = w, anchorH = h,   // where it sits within the tile, if not centered on the full footprint (a wall-mounted shelf sitting at the back half, say)
  } = opts;
  const img = getImage(`assets/sprites/${name}_${ROT_FILES[(spriteRotation + angleOffset) & 3]}.png`);
  if (!img.complete || !img.naturalWidth) return false;
  // Horizontal center comes from the footprint's middle, same as any
  // procedural piece — but the GROUND anchor has to be the footprint's
  // frontmost (nearest-camera) corner, not its center. A diamond's center
  // sits well back of its own front vertex, so anchoring the sprite's base
  // there left every piece visually floating above the tile it stands on —
  // worse the deeper the footprint (the sofa's h=2 made it obvious). Check
  // all 4 corners rather than a rotation-indexed table so it keeps working
  // at every camera angle.
  const [cx] = localOffset(anchorW / 2, anchorH / 2);
  let frontY = -Infinity;
  for (const [lw, lh] of [[0, 0], [anchorW, 0], [0, anchorH], [anchorW, anchorH]]) {
    const [, cy] = localOffset(lw, lh);
    if (cy > frontY) frontY = cy;
  }
  const px = x + cx, py = y + frontY;
  const dw = (w + h) * HW * scale;
  const naturalDh = (img.naturalHeight / img.naturalWidth) * dw * ANGLE_CORRECTION;
  const dh = tall != null ? Math.min(naturalDh, tall) : naturalDh;
  ctx.save();
  if (flip) { ctx.translate(px, 0); ctx.scale(-1, 1); ctx.translate(-px, 0); }
  ctx.drawImage(img, px - dw / 2, py - dh, dw, dh);
  ctx.restore();
  return true;
}


// ---- src/world/objects.js ----
// Furniture definitions: footprint, physical properties, what the critter can do
// with them (affordances) and how they are drawn.
//
// Adding a new piece of furniture is meant to be a single entry here plus one
// action in creature/actions.js — nothing else in the codebase needs to change.


const rect = (ctx, x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); };

/** A catalog item backed by one of Kenney's four isometric sprite views.
 *  The room camera is fixed, so `state.rotation` chooses which compass view
 *  to draw and, for rectangular pieces, which way its collision footprint
 *  runs across the floor. */
function kenneyItem(label, sprite, opts = {}) {
  const {
    w = 1, h = 1, tall = 20, solid = true, acts = [],
    sit = false, lie = false, occupiable = false, seatH = 6, surface = false,
    blocksSight = false, thirsty = false,
  } = opts;
  return {
    label, w, h, tall, solid, acts, sit, lie, occupiable, seatH, surface,
    blocksSight, thirsty,
    rotatable: true,
    directional: true,
    rotatesFootprint: w !== h,
    draw(ctx, x, y, o) {
      if (drawSprite(ctx, x, y, sprite, {
        w: o.w, h: o.h, angleOffset: o.state.rotation ?? 0,
      })) return;
      // Assets are preloaded, but retain a small physical placeholder for the
      // very first frame on a slow disk rather than letting the piece vanish.
      isoBox(ctx, x, y, o.w, o.h, Math.min(tall, 14), PAL.woodL, PAL.wood, PAL.woodD);
    },
  };
}

/** Recompute an object's live footprint from its base definition and facing.
 *  Exported for save restore, where state is applied after construction. */
function syncObjectFootprint(o) {
  const quarterTurn = o.def.rotatesFootprint && ((o.state.rotation ?? 0) & 1);
  o.w = quarterTurn ? o.def.h : o.def.w;
  o.h = quarterTurn ? o.def.w : o.def.h;
  return o;
}

const DEFS = {

  // A wall feature rather than furniture — the renderer paints it directly
  // onto the wall it sits against, but it still needs to exist as an object
  // so the critter can perceive it and stand at it.
  window: {
    label: 'window', w: 1, h: 1, tall: 0, solid: false, flat: true, standOn: true,
    acts: ['gaze'], faceDir: 3,
    draw() { /* painted onto the wall by the renderer */ },
  },

  fridge: {
    label: 'fridge', w: 1, h: 1, tall: 30, solid: true, blocksSight: true,
    acts: ['fetch_food'], frontDir: 1,   // door swings open toward +gy, into the room
    draw(ctx, x, y, o) {
      isoBox(ctx, x, y, 1, 1, 30, PAL.whiteD, PAL.white, PAL.whiteS);
      boxFace(ctx, x, y, 1, 1, 'right', 0.08, 0.92, 1, 17, '#d9d3e6');       // lower door
      boxFace(ctx, x, y, 1, 1, 'right', 0.08, 0.92, 19, 29, '#d9d3e6');      // freezer
      boxFace(ctx, x, y, 1, 1, 'right', 0.14, 0.22, 4, 15, PAL.steel);       // handles
      boxFace(ctx, x, y, 1, 1, 'right', 0.14, 0.22, 21, 27, PAL.steel);
      boxFace(ctx, x, y, 1, 1, 'left', 0.08, 0.92, 1, 29, '#c0b9d2');
      if (o.state.open) boxFace(ctx, x, y, 1, 1, 'right', 0.08, 0.92, 1, 17, '#cfe9f2');
    },
  },

  stove: {
    label: 'stove', w: 1, h: 1, tall: 18, solid: true,
    acts: ['cook'],
    draw(ctx, x, y, o, t) {
      isoBox(ctx, x, y, 1, 1, 18, PAL.steelL, PAL.steel, PAL.steelD);
      isoPlate(ctx, x + 4, y + 2, 0.42, 0.42, 18, PAL.black);
      isoPlate(ctx, x - 6, y + 8, 0.42, 0.42, 18, PAL.black);
      boxFace(ctx, x, y, 1, 1, 'right', 0.15, 0.85, 3, 14, '#4b5262');
      if (o.state.on) {
        const f = 0.5 + 0.5 * Math.sin(t * 9);
        ctx.globalAlpha = 0.55 + 0.45 * f;
        isoPlate(ctx, x + 4, y + 2, 0.42, 0.42, 18, '#ff7a3d');
        ctx.globalAlpha = 1;
        boxFace(ctx, x, y, 1, 1, 'right', 0.18, 0.82, 4, 13,
          'rgba(255,140,60,' + (0.35 + 0.3 * f).toFixed(2) + ')');
      }
    },
  },

  counter: {
    label: 'counter', w: 1, h: 1, tall: 17, solid: true,
    acts: [],
    draw(ctx, x, y) {
      isoBox(ctx, x, y, 1, 1, 15, PAL.woodD, PAL.wood, '#5d3f27');
      isoPlate(ctx, x, y, 1, 1, 17, PAL.steelL);
      boxFace(ctx, x, y, 1, 1, 'right', 0.06, 0.94, 3, 13, '#7a5335');
      boxFace(ctx, x, y, 1, 1, 'right', 0.44, 0.56, 3, 13, PAL.woodD);
    },
  },

  sink: {
    label: 'sink', w: 1, h: 1, tall: 17, solid: true,
    acts: ['wash', 'fill_can'],
    draw(ctx, x, y, o, t) {
      isoBox(ctx, x, y, 1, 1, 15, PAL.whiteS, PAL.white, PAL.whiteD);
      isoPlate(ctx, x, y, 1, 1, 17, PAL.steelL);
      isoPlate(ctx, x + 1, y + 2, 0.66, 0.66, 16.4, PAL.steelD);
      rect(ctx, x - 1, y - 4, 2, 5, PAL.steel);
      rect(ctx, x - 1, y - 5, 5, 2, PAL.steel);
      if (o.state.on) rect(ctx, x + 2, y - 3, 1, 6 + ((t * 40) % 3), PAL.glass);
    },
  },

  table: {
    label: 'table', w: 2, h: 1, tall: 15, solid: true, surface: true,
    rotatable: true, directional: true, rotatesFootprint: true,
    acts: ['eat_at'],
    draw(ctx, x, y, o) {
      const w = o.w, h = o.h;
      for (const [lx, ly] of [[0.18, 0.18], [w - 0.18, 0.18], [0.18, h - 0.18], [w - 0.18, h - 0.18]]) {
        const px = x + (lx - ly) * HW, py = y + (lx + ly) * HH;
        rect(ctx, px - 1, py - 15, 2, 15, PAL.woodD);
      }
      isoPlate(ctx, x, y, w, h, 15, PAL.woodL);
      ctx.globalAlpha = 0.22;
      isoPlate(ctx, x + 1, y + 1, Math.max(0.4, w - 0.14), Math.max(0.4, h - 0.12), 15, PAL.woodD);
      ctx.globalAlpha = 1;
      if (o.state.plate) {
        isoPlate(ctx, x + 5, y + 2, 0.5, 0.5, 15.5, PAL.white);
        if (o.state.plate === 'meal') {
          rect(ctx, x + 3, y + 1, 4, 3, PAL.warm);
          rect(ctx, x + 4, y - 1, 2, 2, PAL.red);
        } else {
          rect(ctx, x + 3, y + 2, 4, 2, '#b96f5a');
        }
      }
    },
  },

  chair: {
    label: 'chair', w: 1, h: 1, tall: 10, solid: false, sit: true, seatH: 6,
    rotatable: true, directional: true,
    acts: ['lounge'],
    // state.face is which way the seat opens: 0=+gx 1=+gy(default) 2=-gx 3=-gy.
    // A chair pulled up to a table needs its back to the room and its seat
    // open toward whatever it's pulled up to, not just one fixed orientation.
    draw(ctx, x, y, o) {
      const face = o.state.face ?? 1;
      if (drawSprite(ctx, x, y, 'chairRounded', { w: 1, h: 1, angleOffset: face })) return;
      const ox = x, oy = y + 3;                       // seat inset into the cell
      const shift = localOffset;                       // rotation-aware, so legs track the seat when the camera spins
      const CORNERS = { n: [0, 0], e: [0.72, 0], s: [0, 0.72], f: [0.72, 0.72] };
      // [backrest anchor local (gx,gy), backrest (w,h), hidden corner key]
      const FACES = {
        0: [[0, 0], [0.14, 0.72], 'n'],
        1: [[0, 0], [0.72, 0.14], 'n'],
        2: [[0.58, 0], [0.14, 0.72], 'e'],
        3: [[0, 0.58], [0.72, 0.14], 's'],
      };
      const [anchor, dims, hidden] = FACES[face] ?? FACES[1];
      const [bx, by] = shift(anchor[0], anchor[1]);
      isoBox(ctx, ox + bx, oy + by, dims[0], dims[1], 21, PAL.wood, PAL.woodD, '#5d3f27');

      for (const key of Object.keys(CORNERS)) {
        if (key === hidden) continue;
        const [dgx, dgy] = CORNERS[key];
        const [dx, dy] = shift(dgx, dgy);
        rect(ctx, ox + dx - 1, oy + dy - 10, 2, 10, PAL.woodD);
      }
      isoPlate(ctx, ox, oy, 0.72, 0.72, 10, PAL.wood);
    },
  },

  toilet: {
    // Sat on, not approached — a stand-beside-and-use toilet always looked
    // wrong next to a bathtub/shower that are properly entered. Joining the
    // same occupiable category (footprint becomes the destination, not a
    // ring around it) fixes both the pose and the position at once.
    label: 'toilet', w: 1, h: 1, tall: 16, solid: false, sit: true, seatH: 6, faceDir: 1,
    acts: ['relieve'],
    draw(ctx, x, y) {
      isoBox(ctx, x + 3, y + 4, 0.5, 0.5, 8, PAL.white, PAL.whiteD, PAL.whiteS);
      isoPlate(ctx, x + 3, y + 3, 0.58, 0.58, 9, PAL.whiteS);
      isoPlate(ctx, x + 3, y + 3, 0.36, 0.36, 9.3, '#a9c6d6');
      isoBox(ctx, x - 4, y - 3, 0.5, 0.5, 16, PAL.white, PAL.whiteD, PAL.whiteS);
    },
  },

  shower: {
    label: 'shower', w: 1, h: 1, tall: 4, solid: false, sit: true,
    acts: ['bathe'],
    draw(ctx, x, y, o, t) {
      isoPlate(ctx, x, y, 1, 1, 0.5, '#93a1ad');
      isoPlate(ctx, x, y, 1, 1, 2, '#cdd8e0');
      rect(ctx, x - 1, y - 24, 2, 9, PAL.steel);
      rect(ctx, x - 4, y - 17, 7, 2, PAL.steelL);
      if (o.state.on) {
        ctx.fillStyle = 'rgba(160,215,235,0.5)';
        for (let i = 0; i < 18; i++) {
          const p = (t * 26 + i * 3.1) % 15;
          ctx.fillRect(x - 4 + (i % 7), y - 14 + p, 1, 2);
        }
      }
    },
  },

  bed: {
    label: 'bed', w: 2, h: 2, tall: 15, solid: false, sit: true, lie: true, seatH: 6,
    rotatable: true, directional: true,
    acts: ['sleep'],
    draw(ctx, x, y, o) {
      if (drawSprite(ctx, x, y, 'bedDouble', {
        w: 2, h: 2, tall: 34, angleOffset: o.state.rotation ?? 0,
      })) return;
      isoBox(ctx, x, y, 2, 2, 6, PAL.woodD, PAL.wood, '#5d3f27');
      isoPlate(ctx, x, y, 2, 2, 9, '#6f7fb5');
      isoPlate(ctx, x, y, 2, 1.2, 9.4, '#8b9ad0');
      isoPlate(ctx, x + 2, y + 2, 0.8, 0.55, 10, PAL.white);
    },
  },

  sofa: {
    label: 'sofa', w: 1, h: 2, tall: 20, solid: false, sit: true, seatH: 8,
    rotatable: true, directional: true, rotatesFootprint: true,
    acts: ['lounge'],
    draw(ctx, x, y, o) {
      if (drawSprite(ctx, x, y, 'loungeSofa', {
        w: o.w, h: o.h, angleOffset: o.state.rotation ?? 0,
      })) return;
      isoBox(ctx, x, y, Math.min(0.32, o.w), o.h, 20, PAL.fabricL, PAL.fabric, PAL.fabricD);   // backrest
      isoBox(ctx, x, y, o.w, o.h, 8, PAL.fabricL, PAL.fabric, PAL.fabricD);       // seat
      isoBox(ctx, x, y, 1, 0.26, 13, PAL.fabricL, PAL.fabric, PAL.fabricD);   // near armrest
      isoBox(ctx, x - 1.74 * HW, y + 1.74 * HH, 1, 0.26, 13,
        PAL.fabricL, PAL.fabric, PAL.fabricD);                                // far armrest
      isoPlate(ctx, x - 6, y + 12, 0.5, 0.5, 8.6, '#6fb8bb');                 // cushion
    },
  },

  tv: {
    label: 'TV', w: 1, h: 1, tall: 28, solid: true, blocksSight: true,
    acts: ['watch_tv'], emitsWhenOn: { light: 0.45, sound: 0.85 }, backDir: 0,   // screen faces away from +gx
    draw(ctx, x, y, o, t) {
      isoBox(ctx, x, y + 3, 0.62, 0.62, 4, '#4a4468', '#39344f', '#2e2a42');   // foot
      rect(ctx, x - 2, y - 4, 5, 12, '#39344f');                               // neck
      const sy = y - 18;
      rect(ctx, x - 10, sy - 1, 20, 16, '#39344f');                            // bezel
      rect(ctx, x - 9, sy, 18, 14, o.state.on ? PAL.screenOn : PAL.screen);
      if (o.state.on) {
        for (let i = 0; i < 6; i++) {
          const b = Math.sin(t * 4 + i * 1.7) * 0.5 + 0.5;
          rect(ctx, x - 8 + i * 3, sy + 1 + Math.floor(b * 8), 2, 3 + Math.floor(b * 3),
            i % 2 ? '#5fb6d8' : '#e8f6ff');
        }
      } else {
        rect(ctx, x - 9, sy, 18, 4, '#1e2136');
      }
    },
  },

  rug: {
    label: 'rug', w: 2, h: 2, tall: 0, solid: false, flat: true,
    acts: [],
    draw(ctx, x, y) {
      isoPlate(ctx, x, y, 2, 2, 0.3, '#8a5566');
      isoPlate(ctx, x, y + 2, 1.75, 1.75, 0.4, '#a06a7a');
      isoPlate(ctx, x, y + 4, 1.3, 1.3, 0.5, '#8a5566');
    },
  },

  lamp: {
    label: 'lamp', w: 1, h: 1, tall: 36, solid: true,
    acts: ['toggle_light'], emitsWhenOn: { light: 0.95, sound: 0 },
    draw(ctx, x, y, o) {
      if (o.state.on) {
        ctx.fillStyle = 'rgba(255,222,150,0.09)';
        ctx.beginPath(); ctx.ellipse(x, y + 6, 30, 18, 0, 0, 7); ctx.fill();
      }
      isoPlate(ctx, x, y + 2, 0.55, 0.55, 1, PAL.woodD);
      rect(ctx, x - 1, y - 26, 2, 30, PAL.woodD);
      ctx.fillStyle = o.state.on ? '#ffe6a8' : '#bdb4a0';
      ctx.beginPath();
      ctx.moveTo(x - 8, y - 26); ctx.lineTo(x + 8, y - 26);
      ctx.lineTo(x + 5, y - 37); ctx.lineTo(x - 5, y - 37);
      ctx.closePath(); ctx.fill();
      if (o.state.on) rect(ctx, x - 7, y - 27, 14, 2, '#fff4d0');
    },
  },

  plant: {
    label: 'plant', w: 1, h: 1, tall: 28, solid: true,
    acts: ['sniff', 'water'], thirsty: true,
    draw(ctx, x, y, o, t) {
      isoBox(ctx, x + 2, y + 5, 0.5, 0.5, 9, '#b5714e', '#9a5c3d', '#844d32');
      const thirst = o.state.thirst || 0;
      const sway = Math.sin(t * 1.1 + o.gx) * 1.3 * (1 - thirst * 0.7);
      const droop = thirst * 4;
      const mix = (a, b) => {
        const p = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
        const [r1, g1, b1] = p(a), [r2, g2, b2] = p(b);
        const f = thirst;
        return `rgb(${r1 + (r2 - r1) * f | 0},${g1 + (g2 - g1) * f | 0},${b1 + (b2 - b1) * f | 0})`;
      };
      ctx.fillStyle = mix(PAL.greenD, '#8a6b35');
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        ctx.beginPath();
        ctx.ellipse(x + Math.cos(a) * 5 + sway, y - 5 + droop + Math.sin(a) * 3, 4, 6, a + droop * 0.1, 0, 7);
        ctx.fill();
      }
      ctx.fillStyle = mix(PAL.green, '#a68b46');
      ctx.beginPath(); ctx.ellipse(x + sway, y - 12 + droop, 5, 7 - thirst * 2, 0, 0, 7); ctx.fill();
      if (thirst > 0.65) {
        ctx.fillStyle = 'rgba(200,170,110,0.9)';
        ctx.fillRect(x + 5, y - 2 + droop, 2, 1);
        ctx.fillRect(x - 7, y + 1 + droop, 2, 1);
      }
    },
  },

  ball: {
    label: 'ball', w: 1, h: 1, tall: 8, solid: false, mobile: true,
    acts: ['kick'],
    draw(ctx, x, y, o) {
      const cx = x, cy = y + 8 - 4 - (o.hop || 0);
      ctx.fillStyle = PAL.shadow;
      ctx.beginPath(); ctx.ellipse(x, y + 8, 4.5, 2.2, 0, 0, 7); ctx.fill();
      ctx.fillStyle = '#e8635e';
      ctx.beginPath(); ctx.arc(cx, cy, 4.5, 0, 7); ctx.fill();
      ctx.fillStyle = '#f2f0f8';
      ctx.beginPath();
      ctx.ellipse(cx, cy, 4.5, 1.6, Math.sin((o.spin || 0)) * 0.9, 0, 7);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.beginPath(); ctx.arc(cx - 1.6, cy - 1.8, 1.2, 0, 7); ctx.fill();
    },
  },

  toybox: {
    label: 'toy box', w: 1, h: 1, tall: 13, solid: true,
    acts: ['play'],
    draw(ctx, x, y) {
      isoBox(ctx, x, y, 1, 1, 11, '#c4643f', '#a94f30', '#8c4027');
      isoPlate(ctx, x, y, 1, 1, 12, '#d97b52');
      rect(ctx, x + 2, y + 3, 3, 3, PAL.warm);
      rect(ctx, x - 6, y + 6, 3, 3, PAL.fabricL);
      rect(ctx, x - 1, y + 1, 3, 3, PAL.pink);
    },
  },

  bookshelf: {
    label: 'shelf', w: 1, h: 1, tall: 34, solid: true, blocksSight: true,
    acts: ['read'], frontDir: 0,   // a shallow box set back against the wall; only readable from +gx
    draw(ctx, x, y, o) {
      // The shelf is a shallow box (h=0.5) set back against the wall; every
      // book sits on the FRONT face of that box via boxFace so they scale and
      // shear with perspective the same way the rest of the furniture does.
      isoBox(ctx, x, y, 1, 0.5, 34, PAL.woodD, PAL.wood, '#5d3f27');
      const cols = ['#c4643f', '#5aa363', '#e0a05a', '#7f8fd0', '#d9625c', '#e8e4f0'];
      const held = o.state.borrowed;
      for (let shelf = 0; shelf < 3; shelf++) {
        const h0 = 8 + shelf * 9, h1 = h0 + 7;
        let n = 0;
        for (let i = 0; i < 6; i++) {
          if (held === shelf * 6 + i) continue;          // that one is out being read
          const u0 = 0.06 + n * 0.15, u1 = u0 + 0.12;
          boxFace(ctx, x, y, 1, 0.5, 'right', u0, u1, h0 + (i % 3) * 0.6, h1, cols[(i + shelf) % 6]);
          n++;
        }
        boxFace(ctx, x, y, 1, 0.5, 'right', 0.02, 0.98, h0 - 1.4, h0 - 0.6, PAL.woodD);
      }
    },
  },

  trashcan: {
    label: 'trash can', w: 1, h: 1, tall: 14, solid: true,
    acts: ['take_out_trash'],
    draw(ctx, x, y, o) {
      const level = o.state.level || 0;
      isoBox(ctx, x, y, 0.62, 0.62, 13, '#7a8090', '#626775', '#4f5460');
      isoPlate(ctx, x, y, 0.62, 0.62, 13, '#8b91a0');
      if (level > 0.15) {
        boxFace(ctx, x, y, 0.62, 0.62, 'right', 0.1, 0.9, 13 - level * 8, 12, '#5a6048');
      }
      if (level > 0.75) {
        ctx.fillStyle = '#c9c2d8';
        rect(ctx, x - 1, y - 15, 2, 3, '#c9c2d8');
      }
    },
  },

  vent: {
    label: 'trash chute', w: 1, h: 1, tall: 0, solid: false, flat: true,
    acts: ['dump_trash'],
    draw(ctx, x, y) {
      // Painted directly onto the wall above wherever it's placed.
      const gx = x, gy = y - 22;
      rect(ctx, gx - 6, gy, 12, 10, '#3a3550');
      rect(ctx, gx - 5, gy + 1, 10, 8, '#242034');
      for (let i = 0; i < 4; i++) rect(ctx, gx - 5, gy + 1.5 + i * 2, 10, 0.8, '#4a4468');
    },
  },

  // ---------------------------------------------------------------------
  // A handful of pieces inspired by classic Habbo Hotel furni: a coffee
  // machine, a pair of linked teleporters, a rollable die, a one-way floor
  // roller, and a togglable gate. Same contract as everything else — a
  // footprint, some acts, a draw() — so they slot into the room editor and
  // the action library exactly like the rest of the catalog.
  // ---------------------------------------------------------------------

  coffee_machine: {
    label: 'coffee machine', w: 1, h: 1, tall: 20, solid: true,
    acts: ['brew_coffee'],
    draw(ctx, x, y, o, t) {
      isoBox(ctx, x, y, 0.7, 0.7, 20, '#4a4468', '#39344f', '#2e2a42');
      isoPlate(ctx, x, y, 0.7, 0.7, 20, '#5c5779');
      rect(ctx, x - 4, y - 26, 8, 8, '#241d33');            // reservoir
      rect(ctx, x - 3, y - 24, 6, 4, '#8a5f3c');             // coffee level
      rect(ctx, x - 1, y - 10, 2, 6, '#2e2a42');             // spout
      if (o.state.on) {
        ctx.fillStyle = 'rgba(230,230,240,0.5)';
        for (let i = 0; i < 3; i++) {
          const p = (t * 20 + i * 6) % 12;
          ctx.fillRect(x - 1 + Math.sin(t * 3 + i) * 1.5, y - 12 - p, 1, 2);
        }
      }
    },
  },

  teleporter: {
    label: 'teleporter', w: 1, h: 1, tall: 2, solid: false, flat: true,
    acts: ['teleport'], occupiable: true,
    draw(ctx, x, y, o, t) {
      // Colour-code by id parity so the two ends of a pair read as visually
      // linked-but-distinct, without needing a second "which end" flag.
      const col = o.id % 2 === 0 ? '#7fd0c4' : '#e79bb0';
      const pulse = 0.5 + 0.5 * Math.sin(t * 3);
      isoPlate(ctx, x, y, 1, 1, 0.4, '#2b2740');
      isoPlate(ctx, x, y, 0.8, 0.8, 0.8 + pulse * 1.5, col);
      isoPlate(ctx, x, y, 0.45, 0.45, 1.4 + pulse * 2, '#171426');
      ctx.strokeStyle = col; ctx.globalAlpha = 0.5 + pulse * 0.4; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.ellipse(x, y - 2 - pulse * 3, 8, 4, 0, 0, 7); ctx.stroke();
      ctx.globalAlpha = 1;
    },
  },

  dice: {
    label: 'dice', w: 1, h: 1, tall: 8, solid: true,
    acts: ['roll_dice'],
    draw(ctx, x, y, o) {
      isoBox(ctx, x, y, 0.5, 0.5, 8, PAL.whiteD, PAL.white, PAL.whiteS);
      isoPlate(ctx, x, y, 0.5, 0.5, 8, PAL.white);
      const face = o.state.face || 1;
      const pip = (dx, dy) => { ctx.fillStyle = PAL.ink; ctx.beginPath(); ctx.arc(x + dx, y - 4 + dy, 0.7, 0, 7); ctx.fill(); };
      const layouts = {
        1: [[0, 0]],
        2: [[-2, -1.5], [2, 1.5]],
        3: [[-2, -1.5], [0, 0], [2, 1.5]],
        4: [[-2, -1.5], [2, -1.5], [-2, 1.5], [2, 1.5]],
        5: [[-2, -1.5], [2, -1.5], [0, 0], [-2, 1.5], [2, 1.5]],
        6: [[-2, -2], [2, -2], [-2, 0], [2, 0], [-2, 2], [2, 2]],
      };
      for (const [dx, dy] of layouts[face] || layouts[1]) pip(dx, dy);
    },
  },

  present: {
    label: 'present', w: 1, h: 1, tall: 9, solid: true,
    acts: ['open_present'],
    draw(ctx, x, y) {
      isoBox(ctx, x, y, 0.6, 0.6, 9, '#d9645a', '#c14f46', '#a33f37');
      isoPlate(ctx, x, y, 0.6, 0.6, 9, '#e87a70');
      boxFace(ctx, x, y, 0.6, 0.6, 'right', 0.42, 0.58, 0, 9, '#f2d879');
      boxFace(ctx, x, y, 0.6, 0.6, 'left', 0.42, 0.58, 0, 9, '#f2d879');
      ctx.fillStyle = '#f2d879';
      ctx.beginPath(); ctx.ellipse(x - 2.5, y - 10, 2, 1.4, 0.4, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.ellipse(x + 2.5, y - 10, 2, 1.4, -0.4, 0, 7); ctx.fill();
    },
  },

  wheel: {
    label: 'wheel of fortune', w: 1, h: 1, tall: 22, solid: true,
    acts: ['spin_wheel'],
    draw(ctx, x, y, o, t) {
      isoBox(ctx, x, y, 0.24, 0.24, 14, '#6d5a42', '#584735', '#4a3b2b');
      const segColors = ['#e0675f', '#f2b46b', '#e8c65a', '#79c97f', '#7fd0c4', '#7f8fd0'];
      const spin = o.state.on ? t * 6 : 0;
      ctx.save();
      ctx.translate(x, y - 18);
      ctx.rotate(spin);
      for (let i = 0; i < 6; i++) {
        ctx.fillStyle = segColors[i];
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, 9, (i / 6) * Math.PI * 2, ((i + 1) / 6) * Math.PI * 2);
        ctx.closePath(); ctx.fill();
      }
      ctx.restore();
      ctx.strokeStyle = '#2c2840'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, y - 18, 9, 0, 7); ctx.stroke();
      ctx.fillStyle = '#f2d879';
      ctx.beginPath(); ctx.moveTo(x, y - 30); ctx.lineTo(x - 2, y - 26); ctx.lineTo(x + 2, y - 26); ctx.closePath(); ctx.fill();
    },
  },

  vending: {
    label: 'vending machine', w: 1, h: 1, tall: 22, solid: true,
    acts: ['use_vending'],
    draw(ctx, x, y, o) {
      isoBox(ctx, x, y, 0.8, 0.8, 22, '#5c5779', '#4a4468', '#39344f');
      isoPlate(ctx, x, y, 0.8, 0.8, 22, '#6d6889');
      boxFace(ctx, x, y, 0.8, 0.8, 'right', 0.1, 0.9, 6, 19, '#241d33');
      const snackColors = ['#e8c65a', '#e0675f', '#79c97f', '#f2b46b'];
      for (let row = 0; row < 2; row++) {
        for (let col = 0; col < 2; col++) {
          boxFace(ctx, x, y, 0.8, 0.8, 'right', 0.16 + col * 0.34, 0.32 + col * 0.34,
            8 + row * 5.5, 12 + row * 5.5, snackColors[row * 2 + col]);
        }
      }
      if (o.state.on) {
        ctx.fillStyle = 'rgba(255,214,110,0.9)';
        ctx.fillRect(x + 6, y - 20, 1, 1);
      }
    },
  },

  totem: {
    label: 'totem', w: 1, h: 1, tall: 30, solid: true, blocksSight: true,
    acts: ['totem_charge'],
    draw(ctx, x, y) {
      const bands = [
        ['#c14f46', '#a33f37', '#8a352e'],
        ['#e8c65a', '#c9a847', '#a88a3a'],
        ['#79c97f', '#5fa864', '#4d8a52'],
        ['#7f8fd0', '#6572ad', '#525d8f'],
      ];
      for (let i = 0; i < 4; i++) {
        const [top, right, left] = bands[i];
        isoBox(ctx, x, y - i * 7, 0.5, 0.5, 7, top, right, left);
      }
      ctx.fillStyle = '#2c2840';
      ctx.beginPath(); ctx.arc(x - 2, y - 26, 1, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.arc(x + 2, y - 26, 1, 0, 7); ctx.fill();
      ctx.fillRect(x - 2, y - 23, 4, 1);
    },
  },

  roller: {
    label: 'roller', w: 1, h: 1, tall: 0, solid: false, flat: true, rollDir: 0,
    acts: [],
    draw(ctx, x, y, o, t) {
      isoPlate(ctx, x, y, 1, 1, 0.3, '#4a5a4a');
      ctx.strokeStyle = '#8fd08a'; ctx.lineWidth = 1; ctx.globalAlpha = 0.7;
      const dir = o.state.dir ?? 0;
      const [dx, dy] = [[1, 0], [0, 1], [-1, 0], [0, -1]][dir];
      for (let i = 0; i < 3; i++) {
        const p = ((t * 0.6 + i / 3) % 1);
        const cx = x + (dx - dy) * HW * (p - 0.5) * 0.7, cy = y + (dx + dy) * HH * (p - 0.5) * 0.7 + HH * 0.5;
        ctx.beginPath(); ctx.moveTo(cx - 2, cy - 2); ctx.lineTo(cx + 2, cy); ctx.lineTo(cx - 2, cy + 2); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    },
  },

  gate: {
    // Blocks the crossing at its own N edge (the boundary with the row
    // behind it), not its whole cell — see the _blockedEdges comment in
    // world.js. Its own tile stays walkable on both sides regardless of
    // open/closed, exactly like standing right next to a real door.
    label: 'gate', w: 1, h: 1, tall: 22, edgeBlock: 'N', structural: true,
    acts: ['toggle_gate'],
    draw(ctx, x, y, o) {
      const open = o.state.open;
      ctx.globalAlpha = open ? 0.35 : 1;
      isoBox(ctx, x, y, 0.12, 1, 22, '#8a7355', '#6d5a42', '#584735');   // near post
      isoBox(ctx, x, y, 1, 0.12, 22, '#8a7355', '#6d5a42', '#584735');   // far post
      for (let i = 0; i < 4; i++) {
        boxFace(ctx, x, y, 1, 1, 'left', 0.14, 0.94, 4 + i * 5, 7 + i * 5, '#6d5a42');   // rails
      }
      ctx.globalAlpha = 1;
      if (!open) {
        ctx.fillStyle = '#e8c65a';
        ctx.fillRect(x - 1, y - 12, 2, 2);   // latch light
      }
    },
  },

  // An interior partition wall, built one tile at a time out of ordinary
  // solid furniture — no changes needed anywhere else in the renderer or
  // collision system to get a second "room" out of it.
  wall_seg: {
    // A low, half-height partition — one straight panel per tile, Habbo-style,
    // rather than a floor-to-ceiling block. Every wall_seg in the layout is
    // laid out as a row of constant gy (varying gx), so only the panel running
    // along the "+w" (grid-x) direction is ever needed; drawing a second one
    // along "+h" at every tile used to give each segment a spurious corner,
    // making a straight run of wall look like a zigzag of little L-pieces.
    // Collision-wise it blocks only the N edge crossing it's actually drawn
    // on (see world.js's _blockedEdges) — its own cell is normal floor, not
    // a whole extra row of the room quietly eaten by a sliver of art.
    label: 'wall', w: 1, h: 1, tall: 13, edgeBlock: 'N', blocksSight: true, structural: true,
    // The panel really occupies only this thin north edge. The painter must
    // sort it at that edge as well; using the full 1x1 filing tile makes the
    // translucent panel jump in front of a critter on the camera-near side.
    depthW: 1, depthH: 0.14,
    acts: [],
    draw(ctx, x, y) {
      ctx.save();
      ctx.globalAlpha = 0.7;
      isoBox(ctx, x, y, 1, 0.14, 13, PAL.wallTop, PAL.wallR, PAL.wallTrim);
      ctx.restore();
    },
  },

  bathtub: {
    label: 'bathtub', w: 1, h: 2, tall: 12, solid: false, sit: true, seatH: 4,
    acts: ['soak'],
    draw(ctx, x, y, o, t) {
      isoBox(ctx, x, y, 1, 2, 10, PAL.whiteS, PAL.white, PAL.whiteD);
      isoPlate(ctx, x, y, 0.82, 1.7, 12, '#a9c6d6');
      if (o.state.on) {
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        for (let i = 0; i < 4; i++) {
          const p = (t * 1.5 + i / 4) % 1;
          const cx = x + Math.sin(i * 2) * 4, cy = y + 6 - p * 8;
          ctx.beginPath(); ctx.arc(cx, cy, 1.2 - p * 0.6, 0, 7); ctx.fill();
        }
      }
    },
  },

  mirror: {
    label: 'mirror', w: 1, h: 1, tall: 26, solid: false, flat: true, standOn: true,
    acts: ['primp'], faceDir: 2,
    draw(ctx, x, y) {
      // Painted onto whichever wall it's placed against, like the window.
      const gy = y - 30;
      ctx.fillStyle = '#6d5a42'; ctx.fillRect(x - 6, gy, 12, 20);
      ctx.fillStyle = '#cfe0ea'; ctx.fillRect(x - 4, gy + 2, 8, 16);
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath(); ctx.moveTo(x - 3, gy + 3); ctx.lineTo(x - 1, gy + 3); ctx.lineTo(x - 3, gy + 15); ctx.closePath(); ctx.fill();
    },
  },

  jukebox: {
    label: 'jukebox', w: 1, h: 1, tall: 26, solid: true, blocksSight: true,
    acts: ['dance'], emitsWhenOn: { light: 0.3, sound: 0.9 },
    draw(ctx, x, y, o, t) {
      isoBox(ctx, x, y, 0.7, 0.7, 26, '#c4643f', '#a94f30', '#8c4027');
      isoPlate(ctx, x, y, 0.7, 0.7, 26, '#d97b52');
      const glow = o.state.on ? (0.5 + 0.5 * Math.sin(t * 6)) : 0;
      ctx.fillStyle = `rgba(255,214,110,${0.4 + glow * 0.5})`;
      ctx.beginPath(); ctx.arc(x, y - 15, 4, 0, 7); ctx.fill();
      ctx.strokeStyle = '#3a2a1e'; ctx.lineWidth = 1;
      for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.arc(x, y - 15, 2 + i * 2.2, 0, 7); ctx.stroke(); }
      if (o.state.on) {
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        for (let i = 0; i < 3; i++) {
          const bar = 3 + Math.abs(Math.sin(t * 5 + i * 2)) * 6;
          ctx.fillRect(x - 6 + i * 5, y - 4 - bar, 2, bar);
        }
      }
    },
  },

  fish_tank: {
    label: 'fish tank', w: 1, h: 1, tall: 18, solid: true, hungry: true,
    acts: ['gaze_fish', 'feed_fish'],
    draw(ctx, x, y, o, t) {
      // wooden stand, then a dark opaque back so the fish reads clearly
      // against it, then a translucent glass shell drawn back OVER the fish —
      // three stacked isoBoxes, no flat screen-rect anywhere, so it stays a
      // proper 3D tank instead of a flat blue square glued onto the room.
      isoBox(ctx, x, y, 0.86, 0.86, 4, '#6d5a42', '#584735', '#4a3b2b');
      isoBox(ctx, x, y - 4, 0.7, 0.7, 13, '#2c3550', '#232a42', '#1c2236');

      const hunger = o.state.hunger || 0;
      const swim = Math.sin(t * 1.8 + o.gx * 2) * 4;
      const bob = Math.sin(t * 1.3) * 1.2;
      const sad = hunger > 0.6;
      ctx.save();
      ctx.translate(x + swim, y - 10 + bob);
      if (swim < 0) ctx.scale(-1, 1);
      ctx.fillStyle = sad ? '#8a7a5a' : '#f2a94e';
      ctx.beginPath(); ctx.ellipse(0, 0, 3.6, 2.2, 0, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-3.4, 0); ctx.lineTo(-6.4, -2.2); ctx.lineTo(-6.4, 2.2); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#2c2840';
      ctx.beginPath(); ctx.arc(1.7, -0.3, 0.5, 0, 7); ctx.fill();
      ctx.restore();

      isoBox(ctx, x, y - 4, 0.7, 0.7, 13,
        'rgba(150,210,230,0.3)', 'rgba(120,190,220,0.4)', 'rgba(90,160,200,0.4)');
      isoPlate(ctx, x, y - 16.5, 0.62, 0.62, 0.6, 'rgba(205,238,247,0.55)');

      if (hunger > 0.6) {
        ctx.fillStyle = 'rgba(210,200,160,0.9)';
        ctx.fillRect(x + 3, y - 15, 1, 1);
        ctx.fillRect(x + 5, y - 12, 1, 1);
      }
    },
  },

  // -------------------------------------------------------------------
  // Extra CC0 pieces from Kenney's Furniture Kit. These deliberately share
  // the same object contract as the hand-drawn catalog, so selection,
  // movement, collision, saving and the critter's existing affordances all
  // work without a parallel "asset furniture" system.
  armchair: kenneyItem('armchair', 'loungeChairRelax', {
    tall: 24, solid: false, sit: true, seatH: 7, acts: ['lounge'],
  }),
  bench: kenneyItem('cushioned bench', 'benchCushion', {
    w: 2, h: 1, tall: 20, solid: false, sit: true, seatH: 7, acts: ['lounge'],
  }),
  coffee_table: kenneyItem('coffee table', 'tableCoffee', {
    w: 2, h: 1, tall: 20, surface: true, acts: ['eat_at'],
  }),
  desk: kenneyItem('desk', 'desk', {
    w: 2, h: 1, tall: 24, surface: true,
  }),
  office_chair: kenneyItem('desk chair', 'chairDesk', {
    tall: 23, solid: false, sit: true, seatH: 7, acts: ['lounge'],
  }),
  side_table: kenneyItem('drawer side table', 'sideTableDrawers', {
    tall: 21, surface: true,
  }),
  small_plant: kenneyItem('small plant', 'plantSmall1', {
    tall: 18, acts: ['sniff', 'water'], thirsty: true,
  }),
  radio: kenneyItem('radio', 'radio', {
    tall: 13,
  }),
  storage_box: kenneyItem('storage box', 'cardboardBoxClosed', {
    tall: 16,
  }),
  bar_stool: kenneyItem('bar stool', 'stoolBar', {
    tall: 20, solid: false, sit: true, seatH: 10, acts: ['lounge'],
  }),
  storage_cabinet: kenneyItem('storage cabinet', 'bookcaseClosedDoors', {
    tall: 31, blocksSight: true,
  }),

  workbench: {
    label: 'workbench', w: 1, h: 1, tall: 15, solid: true,
    acts: ['craft'],
    draw(ctx, x, y) {
      isoBox(ctx, x, y, 1, 1, 13, PAL.woodD, PAL.wood, '#5d3f27');
      isoPlate(ctx, x, y, 1, 1, 15, '#8a6a45');
      boxFace(ctx, x, y, 1, 1, 'right', 0.1, 0.9, 2, 11, '#5d3f27');
      // a little pile of scrap and a saw laid across the top
      isoPlate(ctx, x - 5, y + 3, 0.24, 0.24, 15.4, '#8a8a94');
      isoPlate(ctx, x - 3, y + 5, 0.2, 0.2, 15.4, '#6d6d78');
      ctx.strokeStyle = '#c8c8d4'; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(x + 1, y - 1); ctx.lineTo(x + 7, y + 3); ctx.stroke();
      ctx.fillStyle = '#8a6a45';
      ctx.beginPath(); ctx.ellipse(x + 1, y - 1, 1.6, 1, 0.5, 0, 7); ctx.fill();
    },
  },
};

let nextId = 1;

function makeObject(type, gx, gy, opts = {}) {
  const def = DEFS[type];
  if (!def) throw new Error('unknown object type: ' + type);
  const state = Object.assign(
    {
      on: false, open: false, plate: null, dirty: 0, level: 0, thirst: 0, hunger: 0, borrowed: null, flip: false,
      face: type === 'dice' ? (1 + Math.floor(Math.random() * 6)) : 1,
      rotation: 0,
      pairId: null, dir: 0,
    },
    opts.state,
  );
  const o = {
    id: nextId++, type, def,
    gx, gy, w: def.w, h: def.h,
    // mobile objects (the ball) keep a float position and get pushed around
    fx: gx, fy: gy, vx: 0, vy: 0, hop: 0, spin: 0,
    label: opts.label || def.label,
    use: opts.use || null,            // explicit interaction cells [[gx,gy],...]
    state,
  };
  return syncObjectFootprint(o);
}

/** True when using the item means physically occupying its footprint rather
 *  than stopping beside it. This is deliberately narrower than `standOn`:
 *  wall mirrors/windows are observed from the floor in front of them. */
function canOccupyObject(o) {
  return !!(o?.def && (o.def.occupiable || o.def.sit || o.def.lie));
}

/** Every grid cell covered by an object's live, rotation-aware footprint. */
function footprintCells(o) {
  const cells = [];
  for (let x = 0; x < o.w; x++) {
    for (let y = 0; y < o.h; y++) cells.push([o.gx + x, o.gy + y]);
  }
  return cells;
}

/** Cells the critter may stand on to interact with `o`. Seating, beds,
 *  showers, baths and pads are entered; ordinary furniture is used from its
 *  orthogonal outside ring. Collision/pathfinding still decide whether a
 *  particular candidate is currently reachable. */
function useCells(o) {
  if (o.use) return o.use;
  return canOccupyObject(o) ? footprintCells(o) : adjacentCells(o);
}

// Same 4-direction indexing as world.js's DIRS and a critter's own `dir` —
// 0:+gx  1:+gy  2:-gx  3:-gy. Duplicated locally (rather than imported) so
// this module, which world.js itself imports from, never has to import
// world.js back.
const RING_DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];

/** Every cell along one side of a w×h footprint, in ring direction `dir`. */
function ringSide(o, dir) {
  const [dx, dy] = RING_DIRS[dir];
  const cells = [];
  if (dx !== 0) {
    const x = dx > 0 ? o.gx + o.w : o.gx - 1;
    for (let y = o.gy; y < o.gy + o.h; y++) cells.push([x, y]);
  } else {
    const y = dy > 0 ? o.gy + o.h : o.gy - 1;
    for (let x = o.gx; x < o.gx + o.w; x++) cells.push([x, y]);
  }
  return cells;
}

/** Orthogonal ring outside an object's footprint — restricted to whichever
 *  side(s) actually make sense to use it from. Most furniture has no
 *  preferred side (a lamp, a fish tank, a workbench, a plant: reach it from
 *  wherever), so the ring is the full 4-neighbour set by default. A handful
 *  of pieces care: `def.frontDir` limits use to exactly one side (a fridge
 *  only opens into the room, a bookshelf is only ever read from the front —
 *  you cannot open a door or a page through the back panel), and
 *  `def.backDir` excludes exactly one (a TV can be watched from either
 *  flank or the front, just not through its own screen from behind). Both
 *  are RING_DIRS indices, fixed at the piece's shipped orientation — same
 *  simplification the existing `faceDir` (window/mirror) already makes. */
function adjacentCells(o) {
  if (o.def.frontDir != null) return ringSide(o, o.def.frontDir);
  const sides = o.def.backDir != null
    ? [0, 1, 2, 3].filter((d) => d !== o.def.backDir)
    : [0, 1, 2, 3];
  return sides.flatMap((d) => ringSide(o, d));
}

/** What a piece of furniture costs in the room editor's shop. Anything not
 *  listed here (the two fixed exterior features, wall segments) isn't sold. */
const PRICES = {
  chair: 15, table: 45, sofa: 65, tv: 85, lamp: 20, plant: 12, rug: 25,
  toybox: 30, bookshelf: 35, trashcan: 20, ball: 10,
  coffee_machine: 55, dice: 10, teleporter: 90, roller: 35, gate: 30,
  bathtub: 70, mirror: 25, jukebox: 95, fish_tank: 50, workbench: 60,
  present: 20, wheel: 80, vending: 65, totem: 40,
  armchair: 40, bench: 35, coffee_table: 30, desk: 50, office_chair: 25,
  side_table: 20, small_plant: 10, radio: 25, storage_box: 8,
  bar_stool: 18, storage_cabinet: 40,
};


// ---- src/core/util.js ----
// Small math / helper toolbox shared by every subsystem.

const clamp = (v, lo = 0, hi = 1) => v < lo ? lo : v > hi ? hi : v;
const lerp = (a, b, t) => a + (b - a) * t;
const inv = (v) => 1 - v;
const smooth = (t) => t * t * (3 - 2 * t);
const dist2 = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
const manhattan = (ax, ay, bx, by) => Math.abs(ax - bx) + Math.abs(ay - by);

/** Approach `target` at `rate` per second, frame-rate independent. */
const approach = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

/** Deterministic little PRNG so a saved critter keeps its personality. */
function makeRng(seed = Date.now() >>> 0) {
  let s = seed >>> 0 || 1;
  const r = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  r.seed = seed;
  r.range = (a, b) => a + r() * (b - a);
  r.int = (a, b) => Math.floor(r.range(a, b + 1));
  r.pick = (arr) => arr[Math.floor(r() * arr.length)];
  r.chance = (p) => r() < p;
  return r;
}

function choose(list, scoreFn) {
  let best = null, bestScore = -Infinity;
  for (const item of list) {
    const s = scoreFn(item);
    if (s > bestScore) { bestScore = s; best = item; }
  }
  return { item: best, score: bestScore };
}

const softmax = (arr, temp = 1) => {
  const m = Math.max(...arr);
  const e = arr.map((v) => Math.exp((v - m) / temp));
  const sum = e.reduce((a, b) => a + b, 0) || 1;
  return e.map((v) => v / sum);
};

/** 24h clock formatting from sim minutes-of-day. */
const hhmm = (minutes) => {
  const m = ((minutes % 1440) + 1440) % 1440;
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(Math.floor(m % 60)).padStart(2, '0');
};


// ---- src/world/world.js ----
// The room: a tile grid, the furniture in it, a clock, and the physical signals
// (light, sound) that the critter's senses read. The world knows nothing about
// any critter in it — it only publishes state — which is what lets more than
// one critter share the same world unmodified.


const COLS = 12, ROWS = 13;
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];   // SE, SW, NW, NE on screen

/** Minutes of sim time that pass per real second at 1x speed. */
const MINUTES_PER_SECOND = 1.6;

/** Where the door sits along the gx=0 wall (grid y). Shared with the renderer
 *  so the drawn doorway always lines up with the tile the door logically owns. */
const DOOR_GY = 4;

// Three rooms out of one grid, the same trick twice: a solid wall the width
// of the house with one togglable gate in it. Room A (kitchen/dining, gy
// 0-4) — Room B (bedroom/living, gy 6-8) — Room C (game/reading room, gy
// 10-12), each gate independently lockable.
const GATE_GX = 7;
const GATE2_GX = 4;
const ROOM_SPLIT_GY = 5;
const ROOM_SPLIT_GY2 = 9;

/** A slow backdrop cycle — every SEASON_LENGTH_DAYS days the season turns
 *  over, tinting the window and nudging weather odds and need decay a touch.
 *  Purely atmospheric; nothing here is punishing. */
const SEASON_LENGTH_DAYS = 4;
const SEASONS = ['spring', 'summer', 'autumn', 'winter'];
const SEASON_TINTS = {
  spring: '#8fd0a0', summer: '#f2d879', autumn: '#e0975a', winter: '#bcd6e8',
};
const WEATHER_ODDS = {
  spring: { clear: 0.5, cloudy: 0.2, rain: 0.3 },
  summer: { clear: 0.75, cloudy: 0.15, rain: 0.1 },
  autumn: { clear: 0.35, cloudy: 0.25, rain: 0.4 },
  winter: { clear: 0.4, cloudy: 0.2, snow: 0.4 },
};

/** Wallpaper/floor presets for the room editor's paint tool. */
const ROOM_THEMES = {
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
const LAYOUT_SIGNATURE = LAYOUT.length + ':' + LAYOUT.map(([t, x, y]) => `${t}@${x},${y}`).join('|');

function createWorld() {
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
      // to them and must not be selected as a critter path cell.
      return !objects.some((o) => o !== ignoreObject && o.def.mobile
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


// ---- src/creature/needs.js ----
// Homeostatic drives. Everything the critter does is ultimately an attempt to
// push one of these back toward 1. They are the only "hard" motivation in the
// system — moods and habits modulate them, they never replace them.


const NEEDS = [
  { key: 'hunger',  label: 'fullness', decay: 0.058, weight: 1.25, colour: '#e0a05a' },
  { key: 'energy',  label: 'energy',   decay: 0.044, weight: 1.15, colour: '#7f8fd0' },
  { key: 'bladder', label: 'bladder',  decay: 0.090, weight: 1.40, colour: '#7fd0c4' },
  { key: 'hygiene', label: 'hygiene',  decay: 0.030, weight: 0.70, colour: '#9ad0e8' },
  { key: 'fun',     label: 'fun',      decay: 0.088, weight: 0.85, colour: '#e79bb0' },
  { key: 'social',  label: 'company',  decay: 0.048, weight: 0.80, colour: '#f2b46b' },
];

const NEED_KEYS = NEEDS.map((n) => n.key);

function createNeeds(init) {
  const v = {};
  for (const n of NEEDS) v[n.key] = init?.[n.key] ?? 0.75 + Math.random() * 0.2;

  return {
    v,

    get(k) { return v[k]; },

    /** Non-linear pressure: a need at 0.3 hurts far more than twice as much as 0.65. */
    urgency(k) {
      const meta = NEEDS.find((n) => n.key === k);
      // Slightly super-linear: a half-empty need bites more than half as much,
      // but not so much that moderate boredom becomes invisible.
      return Math.pow(1 - v[k], 1.6) * meta.weight;
    },

    worst() {
      let key = NEED_KEYS[0], best = -1;
      for (const k of NEED_KEYS) {
        const u = this.urgency(k);
        if (u > best) { best = u; key = k; }
      }
      return { key, urgency: best };
    },

    /** Weighted wellbeing 0..1 — the main input to emotional valence. */
    wellbeing() {
      let sum = 0, wsum = 0;
      for (const n of NEEDS) { sum += v[n.key] * n.weight; wsum += n.weight; }
      return sum / wsum;
    },

    satisfy(k, amount) { v[k] = clamp(v[k] + amount); },
    drain(k, amount) { v[k] = clamp(v[k] - amount); },

    /**
     * @param hours  sim hours elapsed
     * @param mods   per-need multipliers, e.g. { energy: 0.1 } while asleep
     */
    update(hours, mods = {}) {
      for (const n of NEEDS) {
        const m = mods[n.key] ?? 1;
        v[n.key] = clamp(v[n.key] - n.decay * hours * m);
      }
    },

    serialize: () => ({ ...v }),
  };
}


// ---- src/creature/emotion.js ----
// Affect is modelled as a point drifting in valence/arousal space.
//
//   valence  -1 miserable .. +1 delighted   — mostly "are my needs met?"
//   arousal  -1 dozy      .. +1 wired       — urgency, novelty, stimulation
//
// Discrete emotions are just labelled regions of that plane, which keeps the
// face and the behaviour driven by one continuous signal instead of a switch.


const REGIONS = [
  { name: 'delighted',  v:  0.8, a:  0.7, face: 'grin' },
  { name: 'playful',    v:  0.6, a:  0.9, face: 'grin' },
  { name: 'happy',      v:  0.6, a:  0.2, face: 'smile' },
  { name: 'content',    v:  0.35, a: -0.3, face: 'smile' },
  { name: 'calm',       v:  0.1, a: -0.5, face: 'neutral' },
  { name: 'sleepy',     v:  0.0, a: -0.9, face: 'sleepy' },
  { name: 'curious',    v:  0.25, a:  0.6, face: 'wide' },
  { name: 'restless',   v: -0.1, a:  0.6, face: 'wide' },
  { name: 'bored',      v: -0.3, a: -0.6, face: 'flat' },
  { name: 'lonely',     v: -0.5, a: -0.2, face: 'sad' },
  { name: 'sad',        v: -0.7, a: -0.4, face: 'sad' },
  { name: 'anxious',    v: -0.5, a:  0.7, face: 'worried' },
  { name: 'grumpy',     v: -0.7, a:  0.3, face: 'cross' },
  { name: 'miserable',  v: -0.9, a:  0.0, face: 'sad' },
];

function createEmotion(init) {
  let valence = init?.valence ?? 0.2;
  let arousal = init?.arousal ?? 0;
  let pulseV = 0, pulseA = 0;          // short-lived reactions to events
  const recent = [];                    // event names, for "what just happened"

  const self = {
    get valence() { return clamp(valence + pulseV, -1, 1); },
    get arousal() { return clamp(arousal + pulseA, -1, 1); },
    recent,

    /** A one-off emotional kick: eating, being petted, a loud bang. */
    pulse(v, a, tag) {
      pulseV = clamp(pulseV + v, -1.2, 1.2);
      pulseA = clamp(pulseA + a, -1.2, 1.2);
      if (tag) { recent.unshift({ tag, t: 0 }); if (recent.length > 8) recent.pop(); }
    },

    /**
     * @param wellbeing  0..1 from needs
     * @param ctx        { urgency, novelty, stimulation, tired, bond, social }
     */
    update(dt, wellbeing, ctx) {
      // Baseline mood follows wellbeing, lifted a little by a strong bond and
      // nudged by whatever Sims-style moodlets (well rested, burnt dinner...)
      // are currently active.
      const targetV = clamp((wellbeing - 0.55) * 2.2 + ctx.bond * 0.25 + (ctx.moodletPull || 0), -1, 1);
      // Arousal rises with unmet urgency and with stimulation, falls with fatigue.
      const targetA = clamp(ctx.urgency * 1.3 + ctx.stimulation * 0.8 + ctx.novelty * 0.9
        - ctx.tired * 1.4 - 0.15, -1, 1);

      valence = approach(valence, targetV, 0.10, dt);
      arousal = approach(arousal, targetA, 0.25, dt);
      pulseV = approach(pulseV, 0, 0.5, dt);
      pulseA = approach(pulseA, 0, 0.6, dt);
      for (const r of recent) r.t += dt;
    },

    label() {
      const v = self.valence, a = self.arousal;
      let best = REGIONS[0], bestD = Infinity;
      for (const r of REGIONS) {
        const d = (r.v - v) ** 2 + (r.a - a) ** 2 * 0.8;
        if (d < bestD) { bestD = d; best = r; }
      }
      return best;
    },

    serialize: () => ({ valence, arousal }),
  };
  return self;
}


// ---- src/creature/memory.js ----
// What the critter knows, as opposed to what is true.
//
// The planner may only reason about objects that are in here, so a fresh critter
// genuinely has to look around its room before it can use the fridge. Outcomes
// are written back as a per-object association, which is the seed of learning:
// things that reliably felt good get chosen sooner next time.


function createMemory(init) {
  /** id -> { type, gx, gy, seen, lastSeen, familiarity, assoc } */
  const objects = new Map(Object.entries(init?.objects || {}).map(([k, v]) => [Number(k), v]));
  const habit = new Map(Object.entries(init?.habit || {}));   // action -> satiation 0..1
  const episodes = init?.episodes ? init.episodes.slice(-30) : [];
  let explored = init?.explored ?? 0;

  const self = {
    objects, habit, episodes,
    get explored() { return explored; },

    knows: (id) => objects.has(id),
    recall: (id) => objects.get(id) || null,

    /** Called by perception for everything currently in view. */
    see(o, nowMinutes, c) {
      let m = objects.get(o.id);
      if (!m) {
        m = { type: o.type, gx: o.gx, gy: o.gy, seen: 0, lastSeen: nowMinutes, familiarity: 0, assoc: 0 };
        objects.set(o.id, m);
        explored = clamp(objects.size / 18);
        return { novel: true, mem: m };
      }
      m.seen++;
      m.lastSeen = nowMinutes;
      m.familiarity = clamp(m.familiarity + 0.004 * (c || 1));
      return { novel: false, mem: m };
    },

    /** How surprising is this object right now? Drives curiosity + arousal. */
    novelty(id) {
      const m = objects.get(id);
      if (!m) return 1;
      return clamp(1 - m.familiarity);
    },

    /** Reinforce: `delta` is how much better life got after using the object. */
    reinforce(id, delta) {
      const m = objects.get(id);
      if (!m) return;
      m.assoc = clamp(m.assoc + delta * 0.25, -1, 1);
    },

    assoc(id) { return objects.get(id)?.assoc ?? 0; },

    /** Doing the same thing over and over stops being fun for a while. */
    satiation(action) { return habit.get(action) ?? 0; },
    bumpSatiation(action, amount = 0.45) {
      habit.set(action, clamp((habit.get(action) ?? 0) + amount));
    },
    decaySatiation(hours) {
      for (const [k, v] of habit) {
        const n = clamp(v - hours * 0.12);
        if (n <= 0.001) habit.delete(k); else habit.set(k, n);
      }
    },

    log(text, kind = 'note') {
      episodes.unshift({ text, kind, t: Date.now() });
      if (episodes.length > 30) episodes.pop();
    },

    /** Objects the critter knows that offer a given affordance. */
    knownOffering(world, act) {
      const out = [];
      for (const o of world.offering(act)) if (objects.has(o.id)) out.push(o);
      return out;
    },

    serialize() {
      return {
        objects: Object.fromEntries(objects),
        habit: Object.fromEntries(habit),
        episodes: episodes.slice(0, 12),
        explored,
      };
    },
  };
  return self;
}


// ---- src/creature/moodlets.js ----
// Sims-style temporary buffs. A moodlet is just a labelled timer with a small
// effect on need decay or emotion — the "Well Rested" / "Burnt Dinner" kind of
// thing that gives the HUD something concrete to say about *why* a critter
// feels the way it does right now, beyond the raw valence/arousal numbers.


/** id -> { label, icon, mods: {need: multiplier}, tone: 'good'|'bad' } */
const MOODLET_DEFS = {
  well_rested:   { label: 'Well rested',   icon: '😴', hours: 6,  mods: { energy: 0.6 },  tone: 'good' },
  freshly_bathed:{ label: 'Freshly bathed',icon: '🛁', hours: 4,  mods: { hygiene: 0.5 }, tone: 'good' },
  caffeinated:   { label: 'Caffeinated',   icon: '☕', hours: 2,  mods: {},               tone: 'good' },
  good_meal:     { label: 'Good meal',     icon: '🍽️', hours: 3,  mods: { hunger: 0.7 },  tone: 'good' },
  made_a_friend: { label: 'Made a friend', icon: '💗', hours: 5,  mods: {},               tone: 'good' },
  goal_met:      { label: 'Got what it wanted', icon: '✅', hours: 3, mods: {},           tone: 'good' },
  // Sick: everything gets harder to keep on top of until it clears.
  unwell:        { label: 'Unwell',        icon: '🤒', hours: 8,  mods: { hygiene: 1.4, hunger: 1.2, energy: 1.3 }, tone: 'bad' },
  explored:      { label: 'Saw the world', icon: '🗺️', hours: 8,  mods: {},               tone: 'good' },
  burnt_dinner:  { label: 'Burnt dinner',  icon: '🔥', hours: 3,  mods: {},               tone: 'bad' },
  lonely:        { label: 'Lonely',        icon: '💧', hours: 4,  mods: { social: 1.4 },  tone: 'bad' },
  messy_room:    { label: 'Messy room',    icon: '🗑️', hours: 3,  mods: { hygiene: 1.3 }, tone: 'bad' },
  stir_crazy:    { label: 'Stir-crazy',    icon: '😤', hours: 5,  mods: { fun: 1.3 },     tone: 'bad' },
  birthday:      { label: 'Birthday!',     icon: '🎂', hours: 5,  mods: { fun: 0.6, social: 0.7 }, tone: 'good' },
  totem_charged: { label: 'Totem-charged', icon: '🗿', hours: 4,  mods: { fun: 0.8 }, tone: 'good' },
};

function createMoodlets(init) {
  /** id -> hours remaining */
  const active = new Map(Object.entries(init || {}));

  return {
    add(id, hours) {
      const def = MOODLET_DEFS[id];
      if (!def) return;
      active.set(id, Math.max(active.get(id) || 0, hours ?? def.hours));
    },

    remove(id) { active.delete(id); },
    has: (id) => active.has(id),

    update(hours) {
      for (const [id, left] of active) {
        const n = left - hours;
        if (n <= 0) active.delete(id); else active.set(id, n);
      }
    },

    /** Combined need-decay multipliers from every active moodlet, for needs.update(). */
    needMods() {
      const mods = {};
      for (const id of active.keys()) {
        const def = MOODLET_DEFS[id];
        if (!def) continue;
        for (const k in def.mods) mods[k] = (mods[k] ?? 1) * def.mods[k];
      }
      return mods;
    },

    /** Net mood pull for the emotion model: +1 per good, -1 per bad, scaled small. */
    valencePull() {
      let v = 0;
      for (const id of active.keys()) {
        const def = MOODLET_DEFS[id];
        if (def) v += def.tone === 'good' ? 0.05 : -0.05;
      }
      return v;
    },

    list() {
      return [...active.entries()]
        .filter(([id]) => MOODLET_DEFS[id])
        .map(([id, hoursLeft]) => ({ id, hoursLeft, ...MOODLET_DEFS[id] }))
        .sort((a, b) => b.hoursLeft - a.hoursLeft);
    },

    serialize: () => Object.fromEntries(active),
  };
}


// ---- src/creature/aspirations.js ----
// A light "wants" system, Sims-whims style. Each critter gets one persistent
// aspiration (flavour + a skill it leans toward) at creation, and a rotating
// small whim — a single concrete, achievable goal tied to one action — that
// refreshes whenever it's completed or goes stale. It's deliberately shallow:
// no quest chains, just "here's a nice thing to do next" with a payoff when
// the critter (or the player, via a suggestion) follows through.

const ASPIRATIONS = [
  { id: 'gourmet',   label: 'Gourmet',         icon: '🍳', skill: 'cooking',   flavor: 'wants to cook something great' },
  { id: 'athlete',   label: 'Athlete',         icon: '🏃', skill: 'fitness',   flavor: 'wants to stay active' },
  { id: 'bookworm',  label: 'Bookworm',        icon: '📖', skill: 'creativity',flavor: 'wants a quiet corner and a good book' },
  { id: 'social',    label: 'Social Butterfly',icon: '💬', skill: 'charisma',  flavor: 'wants to know everyone in the house' },
  { id: 'neat',      label: 'Neat Freak',      icon: '🧹', skill: null,        flavor: 'wants everything spotless' },
];

/** id -> { label, icon, actionId, weight: {aspirationId: multiplier} } */
const WHIM_POOL = [
  { id: 'cook_meal',   label: 'cook a meal',        icon: '🍳', actionId: 'cook',          weight: { gourmet: 4 } },
  { id: 'eat_well',    label: 'eat a proper meal',  icon: '🍽️', actionId: 'eat_at',        weight: { gourmet: 2 } },
  { id: 'play_ball',   label: 'play with the ball', icon: '⚽', actionId: 'play_ball',      weight: { athlete: 4 } },
  { id: 'dance_a_bit', label: 'dance a little',     icon: '🕺', actionId: 'dance',          weight: { athlete: 2, social: 3 } },
  { id: 'read_book',   label: 'read something',     icon: '📖', actionId: 'read',          weight: { bookworm: 4 } },
  { id: 'craft_thing', label: 'craft something',    icon: '🔨', actionId: 'craft',         weight: { bookworm: 3 } },
  { id: 'roll_dice',   label: 'roll the dice',      icon: '🎲', actionId: 'roll_dice',      weight: { bookworm: 1 } },
  { id: 'make_friend', label: 'spend time with someone', icon: '💗', actionId: 'socialize', weight: { social: 4 } },
  { id: 'tidy_up',     label: 'tidy up the house',  icon: '🧹', actionId: 'clean_up',       weight: { neat: 4 } },
  { id: 'wash_up',     label: 'wash up',            icon: '💧', actionId: 'wash_up',        weight: { neat: 2 } },
  { id: 'water_plant', label: 'water a plant',      icon: '🪴', actionId: 'water_plant',    weight: { neat: 1 } },
  { id: 'see_outside', label: 'go see outside',     icon: '🗺️', actionId: 'explore_outside', weight: {} },
  { id: 'get_coffee',  label: 'grab a coffee',      icon: '☕', actionId: 'brew_coffee',    weight: {} },
];

function pickAspiration(rng) {
  return ASPIRATIONS[rng.int(0, ASPIRATIONS.length - 1)];
}

/** Weighted toward the critter's aspiration, but never exclusively — a
 *  bookworm still gets asked to play ball sometimes. */
function rollWhim(rng, aspirationId, excludeId) {
  const pool = WHIM_POOL.filter((w) => w.id !== excludeId);
  const weights = pool.map((w) => 1 + (w.weight[aspirationId] || 0));
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = rng() * total;
  for (let i = 0; i < pool.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}


// ---- src/creature/actions.js ----
// The action library.
//
// Each entry is (a) a way to score how appealing the action looks right now and
// (b) a generator that yields low-level commands the creature runner executes.
// Generators keep multi-step behaviour readable: fetching dinner is literally
// "walk to fridge, open it, take food, walk to stove, cook, walk to table, eat".



// ---------------------------------------------------------------- commands

const goto = (cells) => ({ t: 'goto', cells });
const use = (obj, dur, opts = {}) => ({ t: 'use', obj, dur, ...opts });
const wait = (dur, opts = {}) => ({ t: 'use', obj: null, dur, ...opts });
const face = (dir) => ({ t: 'face', dir });
const hold = (item) => ({ t: 'hold', item });
const set = (obj, key, value) => ({ t: 'set', obj, key, value });
const say = (emote, dur = 1.2) => ({ t: 'emote', emote, dur });

// ---------------------------------------------------------------- helpers

/** Nearest object the critter *remembers* that offers `act`. */
function nearestKnown(c, world, act) {
  let best = null, bestD = Infinity;
  for (const o of world.offering(act)) {
    if (!c.memory.knows(o.id)) continue;
    // Not just "does this have a walkable cell" — is there actually a path
    // from here right now. A bed behind a closed gate is otherwise a target
    // the critter will pick every single think-tick and fail to reach every
    // single time, forever, instead of settling for something it can get to.
    const cells = world.reachableApproachCells(o, c.gx, c.gy);
    if (!cells.length) continue;
    let d = Infinity;
    for (const [x, y] of cells) d = Math.min(d, manhattan(c.gx, c.gy, x, y));
    d -= c.memory.assoc(o.id) * 3;          // fond memories feel closer
    if (d < bestD) { bestD = d; best = o; }
  }
  return best ? { obj: best, dist: bestD } : null;
}

/** Distance discourages, but never enough to override a real emergency. */
const travel = (t) => (t ? -0.018 * Math.max(0, t.dist) : 0);

/** True if some other peer is already sitting/lying on cell (x,y). */
function seatTaken(c, x, y) {
  return (c.peers || []).some((p) => p !== c && !p.away
    && (p.pose === 'sit' || p.pose === 'lie') && Math.round(p.gx) === x && Math.round(p.gy) === y);
}

/** The sofa's near cushion (o.gx,o.gy) by default — but lounge/watch_tv both
 *  always aimed there regardless of who else was already sitting, so two
 *  critters using the same sofa landed on the exact same cell and just got
 *  stuck shoving each other in place forever (there's nowhere to separate
 *  TO — the sofa's other cell is itself a sit-cell, off limits to an
 *  involuntary nudge). Fall back to the far cushion when the near one's
 *  taken, same pattern as chairsFor above.
 */
function sofaSpot(c, w, o) {
  const seats = w.approachCells(o);
  return seats.find(([x, y]) => !seatTaken(c, x, y)) || seats[0];
}

const nightness = (world) => {
  const h = world.minutes / 60;
  return h >= 22 || h < 6 ? 1 : h >= 20 ? (h - 20) / 2 : h < 8 ? (8 - h) / 2 : 0;
};

// ---------------------------------------------------------------- actions

const ACTIONS = [

  {
    id: 'relieve', act: 'relieve', label: 'use the toilet', emote: 'drop',
    pick: (c, w) => nearestKnown(c, w, 'relieve'),
    score(c, w, t) {
      return c.needs.urgency('bladder') * 2.2 + travel(t) * 0.4;
    },
    *run(c, w, t) {
      const o = t.obj;
      yield goto(w.approachCells(o));
      yield say('drop', 0.8);
      yield use(o, 7, { pose: 'sit', fill: { bladder: 1 }, sound: 0.2 });
      w.emitSound(o.gx, o.gy, 0.5, 'flush');
      c.needs.drain('hygiene', 0.05);
      const sink = nearestKnown(c, w, 'wash');
      if (sink && c.trait.tidiness > 0.35) {
        yield goto(w.approachCells(sink.obj));
        yield set(sink.obj, 'on', true);
        yield use(sink.obj, 3, { fill: { hygiene: 0.12 } });
        yield set(sink.obj, 'on', false);
      }
    },
  },

  {
    id: 'fetch_food', act: 'fetch_food', label: 'get something to eat', emote: 'food',
    pick: (c, w) => (c.holding ? null : nearestKnown(c, w, 'fetch_food')),
    score(c, w, t) {
      if (c.holding) return -1;
      return c.needs.urgency('hunger') * 1.6 + travel(t);
    },
    *run(c, w, t) {
      const o = t.obj;
      yield goto(w.approachCells(o));
      yield set(o, 'open', true);
      yield use(o, 2.2, { pose: 'reach' });
      w.emitSound(o.gx, o.gy, 0.3, 'fridge');
      yield set(o, 'open', false);
      yield hold('raw');
      yield say('food', 1);
    },
  },

  {
    id: 'cook', act: 'cook', label: 'cook a meal', emote: 'cook',
    pick: (c, w) => (c.holding === 'raw' && c.canCook ? nearestKnown(c, w, 'cook') : null),
    score(c, w, t) {
      if (c.holding !== 'raw' || !c.canCook) return -1;
      return 1.1 + c.needs.urgency('hunger') * 1.2 + travel(t);
    },
    *run(c, w, t) {
      const o = t.obj;
      yield goto(w.approachCells(o));
      yield set(o, 'on', true);
      yield say('cook', 1.4);
      const skill = c.skill.cooking;
      yield use(o, 9 - skill * 3, { pose: 'reach', fill: {}, sound: 0.3 });
      yield set(o, 'on', false);
      const burnt = Math.random() > 0.45 + skill * 0.5;
      if (Math.random() < 0.55 - skill * 0.3) w.addMess(o.gx, o.gy, 'crumbs');
      c.skill.cooking = clamp(skill + 0.06);
      c.needs.drain('hygiene', 0.04);
      if (burnt) {
        yield hold('burnt');
        yield say('bad', 1.6);
        c.emotion.pulse(-0.3, 0.3, 'burnt the food');
        c.moodlets.add('burnt_dinner');
        c.think('burnt it. again.');
      } else {
        yield hold('meal');
        yield say('good', 1.2);
        c.emotion.pulse(0.25, 0.1, 'cooked a meal');
        c.think('that smells right.');
      }
    },
  },

  {
    id: 'eat_at', act: 'eat_at', label: 'eat', emote: 'food',
    pick: (c, w) => (c.holding && c.holding !== 'toy' ? nearestKnown(c, w, 'eat_at') : null),
    score(c, w, t) {
      if (!c.holding || c.holding === 'toy') return -1;
      const quality = c.holding === 'meal' ? 1.9 : c.holding === 'burnt' ? 1.0 : 1.2;
      return c.needs.urgency('hunger') * quality + 0.35 + travel(t);
    },
    *run(c, w, t) {
      const o = t.obj;
      const item = c.holding;
      // Chairs and tables both own their cells. Eat from a free adjacent tile
      // instead of treating a chair footprint as a walkable destination.
      yield goto(w.approachCells(o));
      yield set(o, 'plate', item);
      yield hold(null);
      const gain = item === 'meal' ? 0.95 : item === 'raw' ? 0.5 : 0.4;
      yield use(o, item === 'meal' ? 8 : 6, { pose: 'eat', fill: { hunger: gain }, emote: 'food' });
      yield set(o, 'plate', null);
      if (item === 'meal') { c.emotion.pulse(0.45, 0.1, 'a good meal'); c.moodlets.add('good_meal'); c.think('good.'); }
      else if (item === 'burnt') { c.emotion.pulse(-0.25, 0.15, 'ate something burnt'); c.think('…edible. barely.'); }
      else { c.emotion.pulse(-0.1, 0.1, 'ate it raw'); c.think('cold, but food.'); }
      c.needs.drain('hygiene', 0.03);
      if (Math.random() < 0.5) w.addMess(o.gx, o.gy + 1, 'crumbs');
    },
  },

  {
    id: 'sleep', act: 'sleep', label: 'sleep', emote: 'zzz',
    pick: (c, w) => nearestKnown(c, w, 'sleep'),
    score(c, w, t) {
      const need = c.needs.urgency('energy') * 1.7;
      const night = nightness(w) * 0.55;
      const blocked = c.needs.urgency('bladder') > 0.35 ? -0.6 : 0;
      return need + night + blocked + travel(t) * 0.5;
    },
    *run(c, w, t) {
      const o = t.obj;
      yield goto(w.approachCells(o));
      yield say('zzz', 1.5);
      c.asleep = true;
      const hours = 6 + Math.random() * 2;
      yield use(o, hours * 6, { pose: 'lie', fill: { energy: 1 }, emote: 'zzz', hold: true });
      c.asleep = false;
      c.awakeHours = 0;
      c.emotion.pulse(0.25, -0.2, 'slept well');
      c.moodlets.add('well_rested');
      c.moodlets.remove('lonely');
      c.think('mmh. morning.');
    },
  },

  {
    id: 'lounge', act: 'lounge', label: 'sit down and relax', emote: 'heart',
    pick: (c, w) => nearestKnown(c, w, 'lounge'),
    score(c, w, t) {
      const tired = c.needs.urgency('energy') * 0.7;
      const low = c.emotion.valence < -0.2 ? 0.3 : 0;
      return tired + low + 0.12 - c.memory.satiation('lounge') * 0.6 + travel(t);
    },
    *run(c, w, t) {
      const seat = sofaSpot(c, w, t.obj);
      if (!seat) return;
      yield goto([seat]);
      yield use(t.obj, 14, { pose: 'sit', fill: { energy: 0.18, fun: 0.06 } });
      c.memory.bumpSatiation('lounge', 0.35);
    },
  },

  {
    id: 'watch_tv', act: 'watch_tv', label: 'watch TV', emote: 'note',
    pick(c, w) {
      const sofa = nearestKnown(c, w, 'lounge');
      const tv = nearestKnown(c, w, 'watch_tv');
      if (!sofa || !tv) return null;
      const partner = (c.peers || []).find((p) => p !== c && !p.away
        && manhattan(p.gx, p.gy, sofa.obj.gx, sofa.obj.gy) <= 2);
      return { obj: sofa.obj, tv: tv.obj, dist: sofa.dist, partner };
    },
    score(c, w, t) {
      if (!t) return -1;
      const together = t.partner ? 0.25 : 0;
      return c.needs.urgency('fun') * 1.5 + 0.15 + together
        - c.memory.satiation('watch_tv') * 1.5
        + (t.tv.state.on ? 0.35 : 0) + travel(t);
    },
    *run(c, w, t) {
      if (!t.tv.state.on) {
        yield goto(w.approachCells(t.tv));
        yield set(t.tv, 'on', true);
        w.emitSound(t.tv.gx, t.tv.gy, 0.6, 'tv on');
      }
      const seat = sofaSpot(c, w, t.obj);
      if (!seat) return;
      yield goto([seat]);
      yield use(t.obj, 22, { pose: 'sit', fill: { fun: 0.55, energy: 0.08 }, emote: 'note' });
      c.memory.bumpSatiation('watch_tv', 0.5);
      c.emotion.pulse(0.2, 0.15, 'watched TV');
      if (t.partner && !t.partner.away) {
        const bonus = 0.02 * (1 + c.skill.charisma) * (t.partner.visitor ? 0.4 : 1);
        c.bumpRelationship(t.partner.id, bonus);
        t.partner.bumpRelationship(c.id, bonus);
        c.needs.satisfy('social', 0.1);
        c.think(t.partner.visitor ? 'sharing the sofa with that visitor, I guess' : 'watched TV with ' + t.partner.name);
      }
    },
  },

  {
    id: 'play', act: 'play', label: 'play', emote: 'star',
    pick: (c, w) => nearestKnown(c, w, 'play'),
    score(c, w, t) {
      return 0.13 * c.trait.playfulness + c.needs.urgency('fun') * 1.35 * (0.6 + c.trait.playfulness * 0.8)
        + c.energyFor(0.35) - c.memory.satiation('play') * 0.9 + travel(t);
    },
    *run(c, w, t) {
      yield goto(w.approachCells(t.obj));
      yield use(t.obj, 3, { pose: 'reach' });
      yield hold('toy');
      yield say('star', 1);
      for (let i = 0; i < 3; i++) {
        const cell = c.randomFreeCellNear(4);
        if (cell) yield goto([cell]);
        yield use(null, 2.5, { pose: 'play', fill: { fun: 0.22, energy: -0.03 }, emote: 'star' });
      }
      yield goto(w.approachCells(t.obj));
      yield hold(null);
      c.memory.bumpSatiation('play', 0.5);
      c.emotion.pulse(0.35, 0.4, 'played');
      c.needs.drain('hygiene', 0.03);
      c.skill.fitness = clamp(c.skill.fitness + 0.02);
    },
  },

  {
    id: 'read', act: 'read', label: 'read something', emote: 'book',
    pick: (c, w) => nearestKnown(c, w, 'read'),
    score(c, w, t) {
      const calmSeeking = c.emotion.arousal > 0.4 ? 0.25 : 0;
      return 0.11 + c.needs.urgency('fun') * 0.9 + calmSeeking + c.trait.curiosity * 0.25
        - c.memory.satiation('read') * 0.8 + travel(t);
    },
    *run(c, w, t) {
      yield goto(w.approachCells(t.obj));
      yield use(t.obj, 4, { pose: 'reach' });
      // A more creative critter gets more out of the same book.
      const fun = 0.3 * (1 + c.skill.creativity * 0.5);
      yield use(t.obj, 16, { pose: 'read', fill: { fun, energy: 0.05 }, emote: 'book' });
      c.memory.bumpSatiation('read', 0.45);
      c.emotion.pulse(0.15, -0.25, 'read a book');
      c.skill.creativity = clamp(c.skill.creativity + 0.025);
    },
  },

  {
    id: 'flip_switch', act: 'toggle_light', label: 'get the light', emote: 'star',
    pick: (c, w) => nearestKnown(c, w, 'toggle_light'),
    score(c, w, t) {
      if (!t) return -1;
      const dark = w.daylight() < 0.3;
      const on = t.obj.state.on;
      // Only worth crossing the room when the light is wrong for the hour.
      return (dark && !on ? 0.9 : !dark && on ? 0.25 : -0.4) + travel(t);
    },
    *run(c, w, t) {
      yield goto(w.approachCells(t.obj));
      yield use(t.obj, 1.2, { pose: 'reach' });
      // Re-check rather than blindly flip: with more than one critter in the
      // house, another one can easily have already fixed the light on its
      // own walk over here, and blindly toggling "relative to now" would
      // just switch it right back the wrong way — a second critter arriving
      // a moment after the first turned it on would turn it straight back
      // off, and so on, reading as the light flicking on and off rapidly.
      const stillWrong = (w.daylight() < 0.3) !== t.obj.state.on;
      if (stillWrong) {
        w.lightsForced = !t.obj.state.on;
        t.obj.state.on = w.lightsForced;
        w.emitSound(t.obj.gx, t.obj.gy, 0.25, 'click');
      }
      yield use(null, 0.8, { pose: 'stand' });
    },
  },

  {
    id: 'brew_coffee', act: 'brew_coffee', label: 'grab a coffee', emote: 'star',
    pick: (c, w) => nearestKnown(c, w, 'brew_coffee'),
    score(c, w, t) {
      if (!t) return -1;
      const groggy = c.emotion.arousal < -0.15 ? 0.35 : 0;
      return 0.1 + c.needs.urgency('energy') * 0.65 + groggy - c.memory.satiation('brew_coffee') * 1.3 + travel(t);
    },
    *run(c, w, t) {
      const o = t.obj;
      yield goto(w.approachCells(o));
      yield set(o, 'on', true);
      yield use(o, 3, { pose: 'reach' });
      yield set(o, 'on', false);
      yield use(null, 2.5, { pose: 'eat', fill: { energy: 0.3 }, emote: 'star' });
      c.memory.bumpSatiation('brew_coffee', 0.6);
      c.emotion.pulse(0.2, 0.55, 'had a coffee');
      c.moodlets.add('caffeinated');
      c.think('better.');
    },
  },

  {
    id: 'use_teleporter', act: 'teleport', label: 'step through the teleporter', emote: 'star',
    pick(c, w) {
      const here = nearestKnown(c, w, 'teleport');
      if (!here) return null;
      // If more than one pad shares a pairId (the room editor doesn't stop
      // you), jump to the nearest of the others rather than always the same
      // one — keeps a 3+ pad group usable instead of stuck on a single pair.
      const candidates = w.byType('teleporter')
        .filter((o) => o.id !== here.obj.id && o.state.pairId === here.obj.state.pairId && w.approachCells(o).length)
        .sort((a, b) => manhattan(here.obj.gx, here.obj.gy, a.gx, a.gy) - manhattan(here.obj.gx, here.obj.gy, b.gx, b.gy));
      if (!candidates.length) return null;
      return { obj: here.obj, other: candidates[0], dist: here.dist };
    },
    score(c, w, t) {
      if (!t) return -1;
      return 0.12 * c.trait.curiosity - c.memory.satiation('use_teleporter') * 1.6 + travel(t);
    },
    *run(c, w, t) {
      yield goto(w.approachCells(t.obj));
      yield say('star', 1);
      yield use(t.obj, 1.4, { pose: 'stand' });
      // The other pad is a flat object, invisible to canPlace's overlap
      // check, so nothing stops the room editor dropping solid furniture
      // directly on top of it — and a peer could simply be standing there.
      // Re-check right before actually moving rather than trusting pick()'s
      // snapshot from whenever this action was chosen; land on the pad
      // itself when it's clear, otherwise step out to whichever adjacent
      // cell is free instead of materializing inside a peer or a table.
      const occupiedByPeer = (x, y) => (c.peers || []).some((p) =>
        p !== c && !p.away && Math.round(p.gx) === x && Math.round(p.gy) === y);
      let dest = (w.isWalkable(t.other.gx, t.other.gy) && !occupiedByPeer(t.other.gx, t.other.gy))
        ? [t.other.gx, t.other.gy]
        : w.approachCells(t.other).find(([x, y]) => !occupiedByPeer(x, y));
      if (!dest) {
        c.emotion.pulse(-0.15, 0.2, 'the pad felt jammed');
        c.think("...it's not working?");
        return;
      }
      [c.gx, c.gy] = dest; c.px = c.gx; c.py = c.gy;
      w.emitSound(c.gx, c.gy, 0.3, 'zap');
      yield say('star', 1);
      c.memory.bumpSatiation('use_teleporter', 0.55);
      c.emotion.pulse(0.2, 0.5, 'teleported');
      c.think('whoa!');
    },
  },

  {
    id: 'roll_dice', act: 'roll_dice', label: 'roll the dice', emote: 'star',
    pick: (c, w) => nearestKnown(c, w, 'roll_dice'),
    score(c, w, t) {
      if (!t) return -1;
      return 0.1 * c.trait.playfulness + c.needs.urgency('fun') * 0.4 - c.memory.satiation('roll_dice') * 1.6 + travel(t);
    },
    *run(c, w, t) {
      const o = t.obj;
      yield goto(w.approachCells(o));
      yield use(o, 1, { pose: 'reach' });
      const roll = 1 + Math.floor(Math.random() * 6);
      o.state.face = roll;
      yield say('star', 1);
      c.needs.satisfy('fun', 0.1);
      c.memory.bumpSatiation('roll_dice', 0.7);
      c.think(roll === 6 ? 'a six!' : 'rolled a ' + roll + '.');
    },
  },

  {
    id: 'toggle_gate', act: 'toggle_gate', label: 'work the gate', emote: 'star',
    pick: (c, w) => nearestKnown(c, w, 'toggle_gate'),
    // Never autonomously chosen — the main house gate is load-bearing for
    // getting between rooms, so a critter should never decide on its own to
    // swing it shut and strand itself. Still fully usable via a direct click
    // (creature.suggest bypasses score with its own override).
    score: () => -1,
    *run(c, w, t) {
      const o = t.obj;
      yield goto(w.approachCells(o));
      yield use(o, 1, { pose: 'reach' });
      o.state.open = !o.state.open;
      w.rebuildCollision();
      w.emitSound(o.gx, o.gy, 0.3, 'gate');
    },
  },

  {
    id: 'wash_up', act: 'wash', label: 'wash up', emote: 'drop',
    pick: (c, w) => nearestKnown(c, w, 'wash'),
    score(c, w, t) {
      if (!t) return -1;
      return c.needs.urgency('hygiene') * 0.75 * (0.5 + c.trait.tidiness) - 0.12 + travel(t);
    },
    *run(c, w, t) {
      yield goto(w.approachCells(t.obj));
      yield set(t.obj, 'on', true);
      yield use(t.obj, 4, { pose: 'reach', fill: { hygiene: 0.3 }, emote: 'drop' });
      yield set(t.obj, 'on', false);
    },
  },

  {
    id: 'bathe', act: 'bathe', label: 'take a shower', emote: 'drop',
    pick: (c, w) => nearestKnown(c, w, 'bathe'),
    score(c, w, t) {
      return c.needs.urgency('hygiene') * 1.7 + travel(t);
    },
    *run(c, w, t) {
      const o = t.obj;
      yield goto(w.approachCells(o));
      yield set(o, 'on', true);
      w.emitSound(o.gx, o.gy, 0.35, 'water');
      yield use(o, 10, { pose: 'stand', fill: { hygiene: 1, fun: 0.02 }, emote: 'drop' });
      yield set(o, 'on', false);
      if (Math.random() < 0.5) w.addMess(o.gx, o.gy, 'puddle');
      c.emotion.pulse(0.3, -0.1, 'got clean');
      c.moodlets.add('freshly_bathed');
    },
  },

  {
    id: 'soak', act: 'soak', label: 'take a bath', emote: 'drop',
    pick: (c, w) => nearestKnown(c, w, 'soak'),
    score(c, w, t) {
      if (!t) return -1;
      // A soak is the relaxing, unhurried version of getting clean — worth it
      // even before hygiene is actually low, unlike the quick utilitarian shower.
      return c.needs.urgency('hygiene') * 1.3 + c.needs.urgency('fun') * 0.5
        - c.memory.satiation('soak') * 1.1 + travel(t);
    },
    *run(c, w, t) {
      const o = t.obj;
      yield goto(w.approachCells(o));
      yield set(o, 'on', true);
      w.emitSound(o.gx, o.gy, 0.2, 'water');
      yield use(o, 13, { pose: 'sit', fill: { hygiene: 1, fun: 0.25, energy: 0.1 }, emote: 'drop' });
      yield set(o, 'on', false);
      c.memory.bumpSatiation('soak', 0.5);
      c.emotion.pulse(0.4, -0.25, 'had a good soak');
      c.moodlets.add('freshly_bathed');
      c.think('ahh.');
    },
  },

  {
    id: 'primp', act: 'primp', label: 'check the mirror', emote: 'star',
    pick: (c, w) => nearestKnown(c, w, 'primp'),
    score(c, w, t) {
      if (!t) return -1;
      return 0.1 * c.trait.playfulness - c.memory.satiation('primp') * 1.8 + travel(t);
    },
    *run(c, w, t) {
      yield goto(w.approachCells(t.obj));
      yield face(t.obj.def.faceDir ?? 1);
      yield use(t.obj, 3, { pose: 'stand', fill: { fun: 0.06 }, emote: 'star' });
      c.memory.bumpSatiation('primp', 0.9);
      c.emotion.pulse(0.15, 0.05, 'looking good');
    },
  },

  {
    id: 'dance', act: 'dance', label: 'dance to the jukebox', emote: 'star',
    pick(c, w) {
      const box = nearestKnown(c, w, 'dance');
      if (!box) return null;
      // Dancing alone is fine; dancing with whoever else is nearby is better —
      // find a peer already at (or heading for) the jukebox.
      const partner = (c.peers || []).find((p) => p !== c && !p.away
        && manhattan(p.gx, p.gy, box.obj.gx, box.obj.gy) <= 2);
      return { obj: box.obj, partner, dist: box.dist };
    },
    score(c, w, t) {
      if (!t) return -1;
      const together = t.partner ? 0.5 : 0;
      return 0.15 * c.trait.playfulness + c.needs.urgency('fun') * 0.7 + together
        - c.memory.satiation('dance') * 1.1 + travel(t);
    },
    *run(c, w, t) {
      const box = t.obj;
      if (!box.state.on) {
        yield goto(w.approachCells(box));
        yield set(box, 'on', true);
        w.emitSound(box.gx, box.gy, 0.7, 'music on');
      }
      const spot = w.approachCells(box).find(([x, y]) => !t.partner || x !== t.partner.gx || y !== t.partner.gy)
        || w.approachCells(box)[0];
      if (!spot) return;
      yield goto([spot]);
      yield say('star', 1);
      yield use(null, 6, { pose: 'play', fill: { fun: 0.35 }, emote: 'star' });
      c.memory.bumpSatiation('dance', 0.5);
      c.emotion.pulse(0.35, 0.5, 'danced');
      c.skill.fitness = clamp(c.skill.fitness + 0.015);
      if (t.partner) {
        c.skill.charisma = clamp(c.skill.charisma + 0.03);
        const bonus = 0.03 * (1 + c.skill.charisma) * (t.partner.visitor ? 0.4 : 1);
        c.bumpRelationship(t.partner.id, bonus);
        t.partner.bumpRelationship(c.id, bonus);
        c.think(t.partner.visitor ? 'that visitor thinks it can out-dance me?' : 'dancing with ' + t.partner.name + '!');
      } else {
        c.think('nobody dances like nobody is watching.');
      }
    },
  },

  {
    id: 'gaze', act: 'gaze', label: 'look out of the window', emote: 'dots',
    pick: (c, w) => nearestKnown(c, w, 'gaze'),
    score(c, w, t) {
      const day = w.daylight();
      return 0.18 + c.trait.curiosity * 0.5 * day + c.needs.urgency('fun') * 0.5
        - c.memory.satiation('gaze') * 1.1 + travel(t);
    },
    *run(c, w, t) {
      yield goto(w.approachCells(t.obj));
      yield face(t.obj.def.faceDir ?? 3);
      yield use(t.obj, 12, { pose: 'stand', fill: { fun: 0.18 }, emote: 'dots' });
      c.memory.bumpSatiation('gaze', 0.55);
      c.emotion.pulse(0.1, -0.15, 'watched the outside');
    },
  },

  {
    id: 'sniff', act: 'sniff', label: 'inspect the plant', emote: 'question',
    pick: (c, w) => nearestKnown(c, w, 'sniff'),
    score(c, w, t) {
      return 0.1 + c.trait.curiosity * 0.35 - c.memory.satiation('sniff') * 1.3 + travel(t);
    },
    *run(c, w, t) {
      yield goto(w.approachCells(t.obj));
      yield use(t.obj, 5, { pose: 'reach', fill: { fun: 0.1 }, emote: 'question' });
      c.memory.bumpSatiation('sniff', 0.8);
    },
  },

  {
    id: 'seek_user', label: 'look for company', emote: 'heart',
    pick: () => ({ obj: null, dist: 0 }),
    score(c) {
      return c.needs.urgency('social') * 1.3 * (0.5 + c.trait.sociability)
        + c.signals.attention * 0.5 - c.memory.satiation('seek_user') * 0.7;
    },
    *run(c, w) {
      const cell = c.frontRowCell();
      if (cell) yield goto([cell]);
      yield face(1);
      yield say('heart', 2);
      yield use(null, 5, { pose: 'wave', fill: { social: 0.25 }, emote: 'heart' });
      c.memory.bumpSatiation('seek_user', 0.5);
      if (c.signals.attention > 0.3) {
        c.needs.satisfy('social', 0.35);
        c.emotion.pulse(0.35, 0.25, 'got attention');
      } else {
        c.emotion.pulse(-0.12, 0.1, 'nobody came');
      }
    },
  },

  {
    id: 'socialize', label: 'hang out together', emote: 'heart',
    pick(c) {
      if (!c.peers) return null;
      let best = null, bestD = Infinity;
      for (const p of c.peers) {
        if (p === c || p.away) continue;
        const d = manhattan(c.gx, c.gy, p.gx, p.gy);
        if (d < bestD) { bestD = d; best = p; }
      }
      return best ? { obj: null, peer: best, dist: bestD } : null;
    },
    score(c, w, t) {
      if (!t) return -1;
      // Two critters already side by side is company enough without a whole
      // walk-over-and-wave routine — this only kicks in when it'd mean
      // actually closing some distance.
      if (t.dist <= 1) return -1;
      const friendship = c.relationshipWith(t.peer.id);
      return c.needs.urgency('social') * 1.2 * (0.5 + c.trait.sociability)
        + friendship * 0.4 - c.memory.satiation('socialize') * 0.9 + travel(t) * 0.6;
    },
    *run(c, w, t) {
      const peer = t.peer;
      const near = [[peer.gx + 1, peer.gy], [peer.gx - 1, peer.gy], [peer.gx, peer.gy + 1],
        [peer.gx, peer.gy - 1]].filter(([x, y]) =>
        w.isWalkable(x, y) && !w._sitCells.has(x + ',' + y) && !w.isPerimeter(x, y));
      if (!near.length) return;
      const ok = yield goto(near);
      if (ok === false) return;
      const dx = peer.gx - c.gx, dy = peer.gy - c.gy;
      c.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 0 : 2) : (dy > 0 ? 1 : 3);
      yield say('heart', 1.5);
      yield use(null, 4, { pose: 'wave', fill: { social: 0.3 }, emote: 'heart' });
      const wasStranger = c.relationshipWith(peer.id) < 0.15;
      const bonus = 0.06 * (1 + c.skill.charisma);
      c.bumpRelationship(peer.id, bonus);
      peer.bumpRelationship(c.id, bonus);
      c.skill.charisma = clamp(c.skill.charisma + 0.02);
      peer.needs.satisfy('social', 0.2);
      peer.emotion.pulse(0.25, 0.2, 'hung out with ' + c.name);
      peer.moodlets.remove('lonely');
      c.memory.bumpSatiation('socialize', 0.55);
      c.emotion.pulse(0.3, 0.25, 'hung out with ' + peer.name);
      c.moodlets.remove('lonely');
      if (wasStranger && c.relationshipWith(peer.id) >= 0.15) {
        c.moodlets.add('made_a_friend');
        peer.moodlets.add('made_a_friend');
        c.think('made a friend in ' + peer.name + '!');
      } else {
        c.think('good to see ' + peer.name + '.');
      }
    },
  },

  {
    id: 'answer_call', label: 'come when called', emote: 'excl',
    pick: (c) => (c.signals.callCell ? { obj: null, dist: 0, cell: c.signals.callCell } : null),
    score(c) {
      if (!c.signals.callCell) return -1;
      return 1.4 + c.bond * 0.8 + c.trait.sociability * 0.4;
    },
    *run(c, w, t) {
      yield say('excl', 0.8);
      yield goto([t.cell]);
      c.signals.callCell = null;
      yield face(1);
      yield use(null, 3, { pose: 'wave', fill: { social: 0.2 }, emote: 'heart' });
      c.bond = clamp(c.bond + 0.02);
      c.emotion.pulse(0.3, 0.3, 'answered a call');
    },
  },

  {
    id: 'play_ball', act: 'kick', label: 'play with the ball', emote: 'star',
    pick(c, w) {
      if (c.holding) return null;
      const t = nearestKnown(c, w, 'kick');
      if (!t) return null;
      // A peer already hanging around the ball turns solo kicking into a
      // proper game of catch — the ball gets passed rather than booted at random.
      const partner = (c.peers || []).find((p) => p !== c && !p.away
        && manhattan(p.gx, p.gy, t.obj.gx, t.obj.gy) <= 3);
      return { obj: t.obj, dist: t.dist, partner };
    },
    score(c, w, t) {
      if (!t || c.holding) return -1;
      const together = t.partner ? 0.35 : 0;
      return 0.16 * c.trait.playfulness + c.needs.urgency('fun') * 1.45 * (0.5 + c.trait.playfulness)
        + c.energyFor(0.3) + together - c.memory.satiation('play_ball') * 0.85 + travel(t);
    },
    *run(c, w, t) {
      const ball = t.obj;
      const rounds = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < rounds; i++) {
        const cells = w.approachCells(ball);
        if (!cells.length) break;
        const ok = yield goto(cells);
        if (ok === false) break;
        if (t.partner && !t.partner.away && manhattan(t.partner.gx, t.partner.gy, ball.gx, ball.gy) <= 4) {
          w.kickToward(ball, t.partner.px, t.partner.py, 4 + Math.random() * 3);
        } else {
          w.kick(ball, c.px, c.py, 4 + Math.random() * 4);
        }
        yield use(null, 0.5, { pose: 'play', emote: 'star' });
        yield use(null, 1.6, { pose: 'stand', fill: { fun: 0.16, energy: -0.02 } });
      }
      c.memory.bumpSatiation('play_ball', 0.5);
      c.emotion.pulse(0.4, 0.5, 'chased the ball');
      c.needs.drain('hygiene', 0.02);
      c.skill.fitness = clamp(c.skill.fitness + 0.02);
      if (t.partner) {
        c.skill.charisma = clamp(c.skill.charisma + 0.02);
        const bonus = 0.025 * (1 + c.skill.charisma) * (t.partner.visitor ? 0.4 : 1);
        c.bumpRelationship(t.partner.id, bonus);
        t.partner.bumpRelationship(c.id, bonus);
        c.needs.satisfy('social', 0.15);
        c.think(t.partner.visitor ? 'that visitor better not keep my ball' : 'played catch with ' + t.partner.name + '!');
      }
      if (Math.random() < 0.3) w.addMess(c.gx, c.gy, 'dirt');
    },
  },

  {
    id: 'water_plant', act: 'water', label: 'water the plants', emote: 'drop',
    pick(c, w) {
      const dry = w.offering('water')
        .filter((o) => c.memory.knows(o.id) && (o.state.thirst || 0) > 0.35)
        .sort((a, b) => (b.state.thirst || 0) - (a.state.thirst || 0))[0];
      if (!dry) return null;
      return { obj: dry, dist: manhattan(c.gx, c.gy, dry.gx, dry.gy) };
    },
    score(c, w, t) {
      if (!t) return -1;
      const thirst = t.obj.state.thirst || 0;
      return thirst * 1.1 * (0.5 + c.trait.tidiness) + (c.holding === 'can' ? 0.7 : 0) + travel(t);
    },
    *run(c, w, t) {
      if (c.holding !== 'can') {
        const sink = nearestKnown(c, w, 'fill_can');
        if (!sink) return;
        yield goto(w.approachCells(sink.obj));
        yield set(sink.obj, 'on', true);
        yield use(sink.obj, 3, { pose: 'reach', emote: 'drop' });
        yield set(sink.obj, 'on', false);
        yield hold('can');
      }
      yield goto(w.approachCells(t.obj));
      yield use(t.obj, 4.5, { pose: 'reach', fill: { fun: 0.04 }, emote: 'drop' });
      t.obj.state.thirst = 0;
      yield hold(null);
      c.emotion.pulse(0.28, -0.05, 'watered a plant');
      c.think('there. much better.');
      c.memory.reinforce(t.obj.id, 0.3);
    },
  },

  {
    id: 'feed_fish', act: 'feed_fish', label: 'feed the fish', emote: 'good',
    pick(c, w) {
      const hungry = w.offering('feed_fish')
        .filter((o) => c.memory.knows(o.id) && (o.state.hunger || 0) > 0.35)
        .sort((a, b) => (b.state.hunger || 0) - (a.state.hunger || 0))[0];
      if (!hungry) return null;
      return { obj: hungry, dist: manhattan(c.gx, c.gy, hungry.gx, hungry.gy) };
    },
    score(c, w, t) {
      if (!t) return -1;
      const hunger = t.obj.state.hunger || 0;
      return hunger * 1.2 * (0.5 + c.trait.tidiness) + travel(t);
    },
    *run(c, w, t) {
      yield goto(w.approachCells(t.obj));
      yield use(t.obj, 3.5, { pose: 'reach', fill: { fun: 0.05 }, emote: 'good' });
      t.obj.state.hunger = 0;
      c.emotion.pulse(0.22, 0, 'fed the fish');
      c.think('there you go, little guy.');
      c.memory.reinforce(t.obj.id, 0.25);
    },
  },

  {
    id: 'gaze_fish', act: 'gaze_fish', label: 'watch the fish', emote: 'dots',
    pick: (c, w) => nearestKnown(c, w, 'gaze_fish'),
    score(c, w, t) {
      if (!t) return -1;
      const hunger = t.obj.state.hunger || 0;
      return 0.14 + c.trait.curiosity * 0.4 - c.memory.satiation('gaze_fish') * 1.2
        - hunger * 0.3 + travel(t);
    },
    *run(c, w, t) {
      yield goto(w.approachCells(t.obj));
      yield use(t.obj, 10, { pose: 'stand', fill: { fun: 0.14, energy: 0.03 }, emote: 'dots' });
      c.memory.bumpSatiation('gaze_fish', 0.6);
      c.emotion.pulse(0.12, -0.2, 'watched the fish swim');
    },
  },

  {
    id: 'craft', act: 'craft', label: 'craft something', emote: 'star',
    pick(c, w) {
      if (c.holding || w.materials < 3) return null;
      return nearestKnown(c, w, 'craft');
    },
    score(c, w, t) {
      if (!t || c.holding || w.materials < 3) return -1;
      return 0.12 * c.trait.curiosity + c.needs.urgency('fun') * 0.4
        + (c.aspiration.id === 'bookworm' ? 0.35 : 0)
        - c.memory.satiation('craft') * 1.3 + travel(t);
    },
    *run(c, w, t) {
      yield goto(w.approachCells(t.obj));
      yield use(t.obj, 5, { pose: 'reach', fill: { fun: 0.1 }, emote: 'star' });
      if (!w.spendMaterials(3)) { c.think('not enough scrap for that.'); return; }
      c.memory.bumpSatiation('craft', 0.6);
      c.skill.creativity = clamp(c.skill.creativity + 0.04);
      c.emotion.pulse(0.3, 0.3, 'made something');
      // a handmade gift for whoever's closest, or just quiet pride if alone
      const partner = (c.peers || []).find((p) => p !== c && !p.away
        && manhattan(p.gx, p.gy, c.gx, c.gy) <= 3);
      if (partner) {
        const bonus = 0.06 * (1 + c.skill.creativity) * (partner.visitor ? 0.4 : 1);
        c.bumpRelationship(partner.id, bonus);
        partner.bumpRelationship(c.id, bonus);
        partner.emotion.pulse(0.2, 0.15, 'got a handmade gift');
        c.think('made a little gift for ' + partner.name + '.');
      } else {
        c.think('made something nice with the scrap.');
      }
    },
  },

  {
    id: 'open_present', act: 'open_present', label: 'open the present', emote: 'star',
    pick: (c, w) => nearestKnown(c, w, 'open_present'),
    score(c, w, t) {
      if (!t) return -1;
      return 0.6 + c.trait.curiosity * 0.3 + travel(t);
    },
    *run(c, w, t) {
      const box = t.obj;
      yield goto(w.approachCells(box));
      yield use(box, 2, { pose: 'reach', fill: { fun: 0.15 }, emote: 'star' });
      w.removeObject(box.id);
      const roll = Math.random();
      if (roll < 0.4) {
        const coins = 8 + Math.floor(Math.random() * 18);
        w.earnCoins(coins);
        c.think(`a present! ${coins} coins inside.`);
      } else if (roll < 0.7) {
        const mats = 2 + Math.floor(Math.random() * 4);
        w.earnMaterials(mats);
        c.think(`a present! ${mats} scrap inside.`);
      } else {
        c.moodlets.add('goal_met');
        c.think('a present! just what I wanted.');
      }
      c.emotion.pulse(0.45, 0.4, 'opened a present');
      w.emitSound(box.gx, box.gy, 0.5, 'chime');
    },
  },

  {
    id: 'spin_wheel', act: 'spin_wheel', label: 'spin the wheel', emote: 'star',
    pick: (c, w) => nearestKnown(c, w, 'spin_wheel'),
    score(c, w, t) {
      if (!t) return -1;
      return 0.18 * c.trait.playfulness + c.needs.urgency('fun') * 0.5
        - c.memory.satiation('spin_wheel') * 1.4 + travel(t);
    },
    *run(c, w, t) {
      const wheel = t.obj;
      yield goto(w.approachCells(wheel));
      wheel.state.on = true;
      w.emitSound(wheel.gx, wheel.gy, 0.4, 'click');
      yield use(wheel, 2.5, { pose: 'reach', emote: 'star' });
      wheel.state.on = false;
      const roll = Math.random();
      const payout = roll < 0.08 ? 40 + Math.floor(Math.random() * 30)
        : roll < 0.4 ? 10 + Math.floor(Math.random() * 15)
        : 1 + Math.floor(Math.random() * 6);
      w.earnCoins(payout);
      c.memory.bumpSatiation('spin_wheel', 0.6);
      c.emotion.pulse(payout > 30 ? 0.5 : 0.2, 0.4, 'spun the wheel');
      c.think(payout > 30 ? `jackpot! ${payout} coins!` : `won ${payout} coins.`);
    },
  },

  {
    id: 'use_vending', act: 'use_vending', label: 'get a snack', emote: 'good',
    pick(c, w) { return w.coins >= 5 ? nearestKnown(c, w, 'use_vending') : null; },
    score(c, w, t) {
      if (!t) return -1;
      return c.needs.urgency('hunger') * 0.9 - c.memory.satiation('use_vending') * 1.2 + travel(t);
    },
    *run(c, w, t) {
      const vm = t.obj;
      yield goto(w.approachCells(vm));
      if (!w.spendCoins(5)) { c.think('not enough coins for a snack.'); return; }
      vm.state.on = true;
      yield use(vm, 2, { pose: 'reach', fill: { hunger: 0.3 }, emote: 'good' });
      vm.state.on = false;
      c.memory.bumpSatiation('use_vending', 0.6);
      c.emotion.pulse(0.15, 0.1, 'grabbed a snack');
      c.think('vending machine snack. not bad.');
    },
  },

  {
    id: 'totem_charge', act: 'totem_charge', label: 'channel the totem', emote: 'dots',
    pick: (c, w) => nearestKnown(c, w, 'totem_charge'),
    score(c, w, t) {
      if (!t) return -1;
      return 0.12 * c.trait.curiosity - c.memory.satiation('totem_charge') * 1.5 + travel(t);
    },
    *run(c, w, t) {
      yield goto(w.approachCells(t.obj));
      yield use(t.obj, 4, { pose: 'stand', emote: 'dots' });
      c.memory.bumpSatiation('totem_charge', 0.75);
      c.moodlets.add('totem_charged');
      const skills = ['cooking', 'fitness', 'creativity', 'charisma'];
      const pick = skills[Math.floor(Math.random() * skills.length)];
      c.skill[pick] = clamp(c.skill[pick] + 0.03);
      c.emotion.pulse(0.25, 0.3, "felt the totem's energy");
      c.think(`the totem hums... ${pick} feels sharper.`);
    },
  },

  {
    id: 'clean_up', label: 'clean up', emote: 'good',
    pick(c, w) {
      const near = w.messNear(c.gx, c.gy);
      return near ? { obj: null, mess: near.mess, dist: near.dist } : null;
    },
    score(c, w, t) {
      if (!t) return -1;
      return (0.25 + w.messes.length * 0.14) * (0.35 + c.trait.tidiness * 1.3)
        + c.needs.urgency('hygiene') * 0.4 + travel(t);
    },
    *run(c, w, t) {
      const cells = [[t.mess.gx, t.mess.gy]];
      const ok = yield goto(cells);
      if (ok === false) return;
      yield use(null, 4, { pose: 'groom', emote: 'dots' });
      w.removeMess(t.mess);
      c.needs.drain('hygiene', 0.06);
      c.emotion.pulse(0.18, -0.1, 'tidied up');
      if (w.messes.length === 0) c.think('that is better.');
    },
  },

  {
    id: 'take_out_trash', act: 'take_out_trash', label: 'take out the trash', emote: 'good',
    pick(c, w) {
      if (c.holding) return null;
      const can = w.first('trashcan'), vent = w.first('vent');
      if (!can || !vent || !c.memory.knows(can.id) || !c.memory.knows(vent.id)) return null;
      if ((can.state.level || 0) < 0.7) return null;
      if (!w.approachCells(can).length || !w.approachCells(vent).length) return null;
      return { obj: can, vent, dist: manhattan(c.gx, c.gy, can.gx, can.gy) };
    },
    score(c, w, t) {
      if (!t) return -1;
      return (t.obj.state.level || 0) * 1.3 * (0.4 + c.trait.tidiness) + travel(t);
    },
    *run(c, w, t) {
      const can = t.obj, vent = t.vent;
      yield goto(w.approachCells(can));
      yield use(can, 2, { pose: 'reach' });
      yield hold('trash');
      can.state.level = 0;
      yield goto(w.approachCells(vent));
      yield use(vent, 2, { pose: 'reach', emote: 'good' });
      yield hold(null);
      w.emitSound(vent.gx, vent.gy, 0.3, 'chute');
      c.needs.satisfy('hygiene', 0.05);
      c.emotion.pulse(0.2, 0.05, 'took out the trash');
      c.memory.bumpSatiation('take_out_trash', 0.6);
      c.think('all tidy.');
    },
  },

  {
    id: 'explore_outside', act: 'explore', label: 'go exploring', emote: 'question',
    pick(c, w) {
      if (w.doorLocked) return null;
      const cell = [0, Math.round(DOOR_GY)];
      if (!w.isWalkable(cell[0], cell[1])) return null;
      return { obj: null, dist: manhattan(c.gx, c.gy, cell[0], cell[1]), cell };
    },
    score(c, w, t) {
      if (!t) return -1;
      // Curiosity and boredom pull it toward the door; a strong bond, or a
      // real need at home, is enough reason to stay in.
      return c.trait.curiosity * 0.5 + c.boredom * 0.7 - c.bond * 0.3 + travel(t) * 0.4 - 0.35;
    },
    *run(c, w, t) {
      yield say('question', 1);
      yield goto([t.cell]);
      c.think('what is out there…');
      c.leaveToExplore(20 + Math.random() * 60);
      // leaveToExplore() takes over from here — the critter is "away" the
      // instant this generator ends, so there is nothing left to yield.
    },
  },

  {
    id: 'investigate', label: 'investigate', emote: 'question',
    pick(c, w) {
      let best = null, bestN = 0.18;
      for (const o of w.objects) {
        const n = c.memory.novelty(o.id);
        const cells = w.approachCells(o);
        if (!cells.length) continue;
        if (n > bestN) { bestN = n; best = { obj: o, dist: manhattan(c.gx, c.gy, o.gx, o.gy), novelty: n }; }
      }
      return best;
    },
    score(c, w, t) {
      if (!t) return -1;
      return t.novelty * 1.1 * (0.4 + c.trait.curiosity) + travel(t) * 0.5;
    },
    *run(c, w, t) {
      yield say('question', 1);
      yield goto(w.exteriorApproachCells(t.obj));
      yield use(t.obj, 4, { outside: true, pose: 'peer', fill: { fun: 0.06 }, emote: 'dots' });
      c.memory.see(t.obj, w.minutes, 40);
      c.emotion.pulse(0.12, 0.3, 'found something new');
      c.think('so that is what that is.');
    },
  },

  {
    id: 'wander', label: 'wander', emote: null,
    pick: () => ({ obj: null, dist: 0 }),
    score(c) {
      return 0.09 + (1 - c.memory.explored) * 0.5 + c.trait.curiosity * 0.12
        + (c.emotion.arousal > 0.2 ? 0.12 : 0);
    },
    *run(c) {
      const n = 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        const cell = c.randomFreeCellNear(6);
        if (!cell) break;
        yield goto([cell]);
        yield use(null, 0.6 + Math.random() * 1.8, { pose: 'stand' });
      }
    },
  },

  {
    id: 'idle', label: 'potter about', emote: null,
    pick: () => ({ obj: null, dist: 0 }),
    score: () => 0.05,
    *run(c) {
      // Keep the last meaningful facing while idling. Facing may change when
      // a new cell step begins or when an interaction deliberately turns the
      // critter toward its target, never as an arbitrary in-cell twitch.
      yield use(null, 1.5 + Math.random() * 2.5, { pose: 'stand', fill: { fun: 0.01 } });
      if (Math.random() < 0.35) {
        yield use(null, 2, { pose: 'groom', fill: { hygiene: 0.03 } });
      }
    },
  },
];

const ACTION_IDS = ACTIONS.map((a) => a.id);
const actionById = (id) => ACTIONS.find((a) => a.id === id);

/** Which action consumes a given affordance, e.g. 'kick' -> play_ball. */
const actionFor = (act) => ACTIONS.find((a) => a.act === act) || null;


// ---- src/creature/neural.js ----
// The seat reserved for neurons.
//
// One layer of rate-coded units, softmax output over the action set, trained
// online two ways at once:
//   - `learn()`  — imitation: nudged toward whatever the utility brain just
//     picked, every think-tick. This is the safety net that keeps the network
//     roughly sane from the very first sample.
//   - `reinforce()` — genuine outcome-based learning: once an action finishes,
//     creature.js hands back how much actual wellbeing it produced, and the
//     taken action's log-probability moves up or down by that amount (the
//     standard REINFORCE gradient for a softmax policy). This is the part
//     that isn't just copying the hand-written brain — a choice the utility
//     brain would make but that turns out badly gets pushed back down.
// From here, deeper layers, recurrence, or spikes are a change inside this
// file only. Everything upstream just produces `percept.vector`; everything
// downstream just consumes an action id.


function createNeuralBrain(dims, actionIds, init) {
  const n = actionIds.length;
  // A saved brain is only reusable if the sensory layout and action set still
  // match; adding a sense or an action retires the old weights rather than
  // silently feeding the net garbage.
  const usable = init?.W && init.W.length === n * dims && init.b?.length === n;
  const W = usable ? Float32Array.from(init.W) : new Float32Array(n * dims);
  const b = usable ? Float32Array.from(init.b) : new Float32Array(n);
  if (!usable) for (let i = 0; i < W.length; i++) W[i] = (Math.random() - 0.5) * 0.02;

  let samples = usable ? (init.samples ?? 0) : 0;
  let accuracy = usable ? (init.accuracy ?? 0) : 0;   // exponential moving average
  let rewardSamples = usable ? (init.rewardSamples ?? 0) : 0;
  let avgReward = usable ? (init.avgReward ?? 0) : 0; // exponential moving average, can go negative
  const lr = 0.06;
  const rewardLr = 0.10;

  function forward(vec) {
    const logits = new Array(n);
    for (let a = 0; a < n; a++) {
      let s = b[a];
      const off = a * dims;
      for (let i = 0; i < dims; i++) s += W[off + i] * vec[i];
      logits[a] = s;
    }
    return logits;
  }

  return {
    id: 'neural',
    dims, actionIds,
    get samples() { return samples; },
    get accuracy() { return accuracy; },
    get rewardSamples() { return rewardSamples; },
    get avgReward() { return avgReward; },
    get ready() { return samples > 150 && accuracy > 0.55; },

    /** Probabilities over the action set, highest first. */
    rank(vec) {
      const p = softmax(forward(vec), 1);
      return actionIds
        .map((id, i) => ({ id, p: p[i] }))
        .sort((x, y) => y.p - x.p);
    },

    /** One supervised step towards `targetId`. Cross-entropy on a softmax. */
    learn(vec, targetId) {
      const ti = actionIds.indexOf(targetId);
      if (ti < 0) return;
      const p = softmax(forward(vec), 1);
      let argmax = 0;
      for (let i = 1; i < n; i++) if (p[i] > p[argmax]) argmax = i;
      accuracy = accuracy * 0.97 + (argmax === ti ? 1 : 0) * 0.03;
      samples++;
      for (let a = 0; a < n; a++) {
        const err = (a === ti ? 1 : 0) - p[a];
        const off = a * dims;
        const g = lr * err;
        for (let i = 0; i < dims; i++) W[off + i] += g * vec[i];
        b[a] += g;
      }
    },

    /**
     * Outcome-based update: `reward` is however much wellbeing actually
     * changed while `actionId` ran (can be negative). Pushes that action's
     * probability, given `vec`, up for a good outcome and down for a bad one
     * — independent of whatever the utility brain would have picked.
     */
    reinforce(vec, actionId, reward) {
      const ti = actionIds.indexOf(actionId);
      if (ti < 0 || !vec) return;
      const r = clamp(reward * 4, -1, 1);        // needs-wellbeing deltas are small; rescale to a useful range
      avgReward = avgReward * 0.97 + r * 0.03;
      rewardSamples++;
      const p = softmax(forward(vec), 1);
      for (let a = 0; a < n; a++) {
        const err = (a === ti ? 1 : 0) - p[a];
        const g = rewardLr * err * r;
        const off = a * dims;
        for (let i = 0; i < dims; i++) W[off + i] += g * vec[i];
        b[a] += g;
      }
    },

    /** Snapshot of what each unit is currently listening to — for the inspector. */
    weightsFor(actionId) {
      const a = actionIds.indexOf(actionId);
      if (a < 0) return null;
      return W.subarray(a * dims, (a + 1) * dims);
    },

    serialize: () => ({
      W: Array.from(W, (v) => Math.round(v * 1e4) / 1e4),
      b: Array.from(b, (v) => Math.round(v * 1e4) / 1e4),
      samples, accuracy: clamp(accuracy),
      rewardSamples, avgReward: clamp(avgReward, -1, 1),
    }),
  };
}


// ---- src/creature/perception.js ----
// Senses. Every tick this builds a percept — the only view of the world the
// brain is allowed to use — and encodes it into a fixed-layout Float32Array.
//
// That vector is the contract for anything neural we bolt on later: same length,
// same meaning per slot, values normalised to roughly 0..1. Change SENSE_LAYOUT
// and both the algorithmic and the learned brain see the change at once.


const CLASSES = [
  'fridge', 'stove', 'counter', 'sink', 'table', 'chair', 'toilet', 'shower',
  'bed', 'sofa', 'tv', 'toybox', 'bookshelf', 'plant', 'lamp', 'window', 'ball',
];

const HOLDABLE = ['none', 'raw', 'meal', 'burnt', 'toy', 'can'];

const VISION_RANGE = 7.5;
const FOV = Math.cos((62 * Math.PI) / 180);   // dot-product threshold
const PERIPHERAL = 1.6;                        // always-sensed bubble

/** Human-readable slot names, built once so the debug panel can label bars. */
const SENSE_LAYOUT = (() => {
  const names = [];
  for (const k of NEED_KEYS) names.push('need:' + k);
  names.push('valence', 'arousal', 'time:sin', 'time:cos', 'light', 'sound',
    'bond', 'attention', 'touch');
  for (const h of HOLDABLE) names.push('hold:' + h);
  names.push('pos:x', 'pos:y', 'face:se', 'face:sw', 'face:nw', 'face:ne',
    'novelty', 'fatigue', 'mess', 'plant:thirst', 'trash', 'door:unlocked', 'boredom',
    'moodlet:good', 'moodlet:bad', 'nearestPeer:dist', 'nearestPeer:friendship');
  for (const c of CLASSES) { names.push('see:' + c); names.push('near:' + c); }
  return names;
})();

const SENSE_DIMS = SENSE_LAYOUT.length;

const HOLD_INDEX = Object.fromEntries(HOLDABLE.map((h, i) => [h, i]));

function perceive(c, world) {
  const cx = c.gx + 0.5, cy = c.gy + 0.5;
  const [fx, fy] = DIRS[c.dir];

  const visible = [];
  let maxNovelty = 0;

  for (const o of world.objects) {
    const oc = world.center(o);
    const dx = oc.gx - cx, dy = oc.gy - cy;
    const d = Math.hypot(dx, dy);
    if (d > VISION_RANGE) continue;

    const inFront = d < 0.001 || (dx * fx + dy * fy) / d >= FOV;
    if (!inFront && d > PERIPHERAL) continue;
    if (!world.lineOfSight(c.gx, c.gy, Math.floor(oc.gx), Math.floor(oc.gy))) continue;

    const { novel, mem } = c.memory.see(o, world.minutes, 1 / (1 + d));
    const nov = c.memory.novelty(o.id);
    if (novel) c.onNovel(o);
    maxNovelty = Math.max(maxNovelty, nov);
    visible.push({ obj: o, dist: d, novelty: nov, assoc: mem.assoc });
  }
  visible.sort((a, b) => a.dist - b.dist);

  const light = world.lightLevel();
  const sound = world.soundAt(cx, cy);
  const attention = clamp(c.signals.attention);
  const touch = clamp(c.signals.touch);

  const vec = c.senseVec;
  vec.fill(0);
  let i = 0;
  for (const k of NEED_KEYS) vec[i++] = c.needs.get(k);
  vec[i++] = (c.emotion.valence + 1) / 2;
  vec[i++] = (c.emotion.arousal + 1) / 2;
  const dayFrac = (world.minutes / 1440) * Math.PI * 2;
  vec[i++] = (Math.sin(dayFrac) + 1) / 2;
  vec[i++] = (Math.cos(dayFrac) + 1) / 2;
  vec[i++] = light;
  vec[i++] = sound;
  vec[i++] = c.bond;
  vec[i++] = attention;
  vec[i++] = touch;
  const hi = HOLD_INDEX[c.holding || 'none'] ?? 0;
  vec[i + hi] = 1; i += HOLDABLE.length;
  vec[i++] = c.gx / world.cols;
  vec[i++] = c.gy / world.rows;
  vec[i + c.dir] = 1; i += 4;
  vec[i++] = maxNovelty;
  vec[i++] = clamp(c.awakeHours / 18);
  vec[i++] = clamp(world.messes.length / 6);
  vec[i++] = world.objects.reduce((m, o) => Math.max(m, o.state.thirst || 0), 0);
  vec[i++] = world.objects.reduce((m, o) => Math.max(m, o.type === 'trashcan' ? o.state.level || 0 : 0), 0);
  vec[i++] = world.doorLocked ? 0 : 1;
  vec[i++] = c.boredom ?? 0;
  const moodletList = c.moodlets ? c.moodlets.list() : [];
  vec[i++] = clamp(moodletList.filter((m) => m.tone === 'good').length / 3);
  vec[i++] = clamp(moodletList.filter((m) => m.tone === 'bad').length / 3);
  let nearestPeerDist = 1, nearestPeerFriend = 0;
  if (c.peers) {
    let bestD = Infinity;
    for (const p of c.peers) {
      if (p === c || p.away) continue;
      const d = Math.hypot(p.gx - c.gx, p.gy - c.gy);
      if (d < bestD) { bestD = d; nearestPeerFriend = c.relationshipWith ? c.relationshipWith(p.id) : 0; }
    }
    if (bestD < Infinity) nearestPeerDist = clamp(bestD / 15);
  }
  vec[i++] = nearestPeerDist;
  vec[i++] = nearestPeerFriend;

  const classBase = i;
  for (const v of visible) {
    const ci = CLASSES.indexOf(v.obj.type);
    if (ci < 0) continue;
    const s = classBase + ci * 2;
    vec[s] = 1;
    vec[s + 1] = Math.max(vec[s + 1], clamp(1 - v.dist / VISION_RANGE));
  }

  return {
    visible,
    nearest: visible[0] || null,
    light, sound, attention, touch,
    novelty: maxNovelty,
    minutes: world.minutes,
    vector: vec,
  };
}

/** Can the critter currently see this object? Used by actions that need a target. */
function sees(percept, obj) {
  return percept.visible.some((v) => v.obj === obj);
}


// ---- src/creature/brain.js ----
// Decision making.
//
// The brain's whole job: given a percept, return { action, target }. Two
// implementations share that interface — a hand-written utility brain and the
// learned one in neural.js — so swapping them at runtime changes nothing else.


/** Deliberation is expensive-looking; think a few times a second, not 30. */
const THINK_INTERVAL = 0.6;

function createBrain(init) {
  const neural = createNeuralBrain(SENSE_DIMS, ACTION_IDS, init?.neural);
  let mode = init?.mode === 'neural' ? 'neural' : 'utility';
  let lastRanking = [];

  /** Score every action that currently has a valid target. */
  function evaluate(c, world, percept) {
    const out = [];
    // Which action ids a nearby, visible peer is currently doing — used below
    // to nudge toward "join in" behaviour instead of every critter living in
    // its own bubble. Distance-gated so it only counts peers actually close by.
    const peerActions = new Set();
    if (c.peers) {
      for (const p of c.peers) {
        if (p === c || p.away || !p.task) continue;
        if (Math.hypot(p.gx - c.gx, p.gy - c.gy) <= 5) peerActions.add(p.task.action.id);
      }
    }
    for (const a of ACTIONS) {
      let target = null;
      try { target = a.pick(c, world, percept); } catch { target = null; }
      if (target === null && a.pick.length > 0 && a.id !== 'wander' && a.id !== 'idle'
        && a.id !== 'seek_user') continue;
      let s;
      try { s = a.score(c, world, target, percept); } catch { s = -1; }
      if (!isFinite(s) || s <= -1) continue;

      // Personality and mood tilt the whole set a little. Fondness for an object
      // amplifies an existing desire rather than inventing one, so a much-loved
      // shower cannot out-argue a need that is already satisfied.
      s *= 1 + (c.trait.impulsiveness - 0.5) * 0.1 * (Math.random() - 0.5) * 2;
      if (target?.obj) s *= 1 + c.memory.assoc(target.obj.id) * 0.35;
      if (c.whim && a.id === c.whim.actionId) s += 0.22;   // a small nudge toward the current want
      // a lonelier or more sociable critter is more likely to wander over and
      // join whatever a nearby friend is already doing
      if (peerActions.has(a.id) && a.id !== 'seek_user' && a.id !== 'wander' && a.id !== 'idle') {
        s += 0.12 + c.trait.sociability * 0.15 + c.needs.urgency('social') * 0.1;
      }

      out.push({ action: a, target, score: s });
    }
    out.sort((x, y) => y.score - x.score);
    lastRanking = out;
    return out;
  }

  return {
    neural,
    get mode() { return mode; },
    set mode(m) { mode = m === 'neural' ? 'neural' : 'utility'; },
    get ranking() { return lastRanking; },

    /**
     * Decide what to do next. The utility brain always runs — even in neural
     * mode — because it is the teaching signal the network learns from.
     */
    decide(c, world, percept) {
      const ranked = evaluate(c, world, percept);
      if (!ranked.length) return null;

      // When nothing is urgent, don't always take the top option — sample among
      // the close contenders. That is what stops a critter with a working TV
      // from watching it forever, and it is where most of the "life of its own"
      // comes from. A real need (score above URGENT) suppresses the dice.
      const URGENT = 0.75, TEMP = 0.10;
      let teacher = ranked[0];
      if (ranked[0].score < URGENT) {
        const pool = ranked.filter((r) => r.score > ranked[0].score - 0.35).slice(0, 5);
        const p = softmax(pool.map((r) => r.score), TEMP);
        let roll = Math.random();
        for (let i = 0; i < pool.length; i++) {
          roll -= p[i];
          if (roll <= 0) { teacher = pool[i]; break; }
        }
      }
      neural.learn(percept.vector, teacher.action.id);

      if (mode === 'neural') {
        for (const { id } of neural.rank(percept.vector)) {
          const hit = ranked.find((r) => r.action.id === id);
          if (hit) return hit;                 // first viable action the net wants
        }
      }
      return teacher;
    },

    /**
     * Score the options without acting on them. Called on every think tick so
     * the network keeps learning while a long action plays out — otherwise it
     * would only ever see the handful of moments a new task begins.
     */
    observe(c, world, percept) {
      const ranked = evaluate(c, world, percept);
      if (ranked.length) neural.learn(percept.vector, ranked[0].action.id);
    },

    /** Should the critter drop what it is doing? Only real emergencies interrupt. */
    shouldInterrupt(c, world, percept, current) {
      if (!current) return true;
      if (c.asleep) {
        return c.needs.urgency('bladder') > 1.05 || c.signals.touch > 0.6;
      }
      if (c.signals.callCell && current.action.id !== 'answer_call') return true;
      if (c.signals.suggested && current.action.id !== c.signals.suggested) return true;
      for (const k of ['bladder', 'hunger', 'energy']) {
        if (c.needs.urgency(k) > 0.95 && !current.action.needsAddressed?.includes(k)) {
          const ranked = evaluate(c, world, percept);
          if (ranked[0] && ranked[0].action.id !== current.action.id
            && ranked[0].score > current.score * 1.5) return true;
        }
      }
      return false;
    },

    serialize: () => ({ mode, neural: neural.serialize() }),
  };
}


// ---- src/world/pathfind.js ----
// 4-directional A* over the tile grid. Small enough map that a binary heap is
// overkill, but the open list is kept sorted-on-insert so paths stay cheap even
// when the critter re-plans every few seconds.

const STEP_DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];

/**
 * @param world   provides isWalkable(gx,gy) and the grid bounds
 * @param start   [gx,gy]
 * @param goals   array of [gx,gy] — the path ends at whichever is cheapest
 * @param avoid   optional Set of "gx,gy" keys — other critters' current cells,
 *                treated as temporarily blocked so paths route around them
 *                instead of walking straight through/onto each other. The
 *                start cell is never treated as blocked even if it's in here.
 * @param transit optional Set of "gx,gy" keys — cells (currently the room
 *                rim) that are fine as the actual destination but not as a
 *                shortcut through: unlike `avoid`, these stay valid goals.
 * @param avoidEdges optional Set of world.edgeKey(...) values learned when a
 *                swept-body collision rejects an otherwise valid grid edge.
 * @returns array of [gx,gy] steps (excluding start), or null
 */
function findPath(world, start, goals, avoid, transit, avoidEdges = null) {
  if (!goals.length) return null;
  const key = (x, y) => y * world.cols + x;
  const startKey = key(start[0], start[1]);
  const blocked = (x, y) => avoid && avoid.has(x + ',' + y) && key(x, y) !== startKey;
  const transitBlocked = (x, y) => transit && transit.has(x + ',' + y);
  const goalSet = new Set();
  for (const [gx, gy] of goals) {
    if (world.inBounds(gx, gy) && world.isWalkable(gx, gy) && !blocked(gx, gy)) goalSet.add(key(gx, gy));
  }
  if (!goalSet.size) return null;
  if (goalSet.has(key(start[0], start[1]))) return [];

  const h = (x, y) => {
    let best = Infinity;
    for (const [gx, gy] of goals) best = Math.min(best, Math.abs(gx - x) + Math.abs(gy - y));
    return best;
  };

  const came = new Map(), g = new Map();
  const open = [{ x: start[0], y: start[1], f: h(start[0], start[1]) }];
  g.set(key(start[0], start[1]), 0);
  let guard = 0;

  while (open.length && guard++ < 4000) {
    const cur = open.shift();
    const ck = key(cur.x, cur.y);
    if (goalSet.has(ck)) {
      const path = [];
      let k = ck, node = [cur.x, cur.y];
      while (came.has(k)) { path.push(node); node = came.get(k); k = key(node[0], node[1]); }
      return path.reverse();
    }
    const cg = g.get(ck);
    for (const [dx, dy] of STEP_DIRS) {
      const nx = cur.x + dx, ny = cur.y + dy;
      if (!world.inBounds(nx, ny) || !world.isWalkable(nx, ny) || blocked(nx, ny)) continue;
      const edge = world.edgeKey(cur.x, cur.y, nx, ny);
      if (world.edgeBlocked(cur.x, cur.y, nx, ny) || avoidEdges?.has(edge)) continue;
      const nk = key(nx, ny);
      if (transitBlocked(nx, ny) && !goalSet.has(nk)) continue;
      const ng = cg + world.stepCost(nx, ny);
      if (g.has(nk) && g.get(nk) <= ng) continue;
      g.set(nk, ng);
      came.set(nk, [cur.x, cur.y]);
      const f = ng + h(nx, ny);
      let i = 0;
      while (i < open.length && open[i].f <= f) i++;
      open.splice(i, 0, { x: nx, y: ny, f });
    }
  }
  return null;
}


// ---- src/creature/creature.js ----
// The critter itself: body state, the runner that executes an action's
// generator, growth over days, and the glue between needs / emotion / memory /
// perception / brain.


const STAGES = [
  { name: 'hatchling', days: 0, scale: 0.70, speed: 1.5 },
  { name: 'sprout',    days: 2, scale: 0.82, speed: 1.9 },
  { name: 'youngling', days: 5, scale: 0.92, speed: 2.2 },
  { name: 'grown',     days: 10, scale: 1.0, speed: 2.1 },
];

const NAMES = ['Pib', 'Onno', 'Tuff', 'Mochi', 'Bramble', 'Nix', 'Poppy', 'Grub', 'Fen', 'Wisp'];

let nextCritterId = 1;

function createCritter(world, save) {
  const rng = makeRng(save?.seed ?? (Date.now() >>> 0));

  const id = save?.id ?? nextCritterId++;
  nextCritterId = Math.max(nextCritterId, id + 1);   // stay ahead of restored ids

  // A brand-new game's very first critter has no save to place it, so it
  // fell back to a hardcoded (5,5) — which the shipped layout puts a
  // wall_seg on, spawning it embedded in a wall until its first task moved
  // it. Walk outward in rings to the nearest actually-walkable cell instead,
  // so this can't break again no matter how the starting layout changes.
  let spawnGx = save?.gx, spawnGy = save?.gy;
  if (spawnGx == null || spawnGy == null || !world.isWalkable(spawnGx, spawnGy)) {
    spawnGx = 5; spawnGy = 5;
    outer:
    for (let r = 0; r <= Math.max(world.cols, world.rows); r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (world.isWalkable(5 + dx, 5 + dy)) { spawnGx = 5 + dx; spawnGy = 5 + dy; break outer; }
        }
      }
    }
  }

  const c = {
    id,
    seed: rng.seed,
    name: save?.name ?? NAMES[Math.floor(rng() * NAMES.length)],
    gx: spawnGx, gy: spawnGy,
    px: spawnGx, py: spawnGy,       // smooth visual position
    dir: save?.dir ?? 1,
    pose: 'stand',
    holding: save?.holding ?? null,
    asleep: false,
    bond: save?.bond ?? 0.05,                          // bond with the *player* — petting, calls, gifts
    relationships: save?.relationships ?? {},          // peer critter id -> friendship 0..1
    // The world-clock day this critter was born on — age is measured from
    // here, not from the household's clock, so a critter added later starts
    // as a hatchling instead of instantly inheriting everyone else's age.
    bornDay: save?.bornDay ?? (save?.ageDays != null
      ? (world.day + world.minutes / 1440) - save.ageDays
      : (world.day + world.minutes / 1440)),
    ageDays: save?.ageDays ?? 0,
    awakeHours: save?.awakeHours ?? 0,
    skill: Object.assign({ cooking: 0, fitness: 0, creativity: 0, charisma: 0 }, save?.skill),
    aspiration: save?.aspiration ?? pickAspiration(rng),
    whim: save?.whim ?? null,   // filled in just below once `c` exists
    whimAge: save?.whimAge ?? 0,
    neglect: save?.neglect ?? 0,

    trait: save?.trait ?? {
      curiosity: rng.range(0.3, 1),
      sociability: rng.range(0.2, 1),
      playfulness: rng.range(0.2, 1),
      tidiness: rng.range(0.1, 0.9),
      impulsiveness: rng.range(0.2, 0.9),
    },

    needs: createNeeds(save?.needs),
    emotion: createEmotion(save?.emotion),
    memory: createMemory(save?.memory),
    moodlets: createMoodlets(save?.moodlets),
    brain: createBrain(save?.brain),

    senseVec: new Float32Array(SENSE_DIMS),
    percept: null,
    signals: { attention: 0, touch: 0, callCell: null, suggested: null },

    task: null,
    thoughts: [],
    emote: null,
    lookAt: null,          // world point the eyes track
    blink: 0, blinkT: rng.range(1, 4),
    bob: 0,
    thinkT: 0,
    stuck: 0,
    away: save?.away ?? false, awayTimer: save?.awayTimer ?? 0,   // out exploring beyond the door
    visitor: !!save?.visitor,   // a passing-through critter, not part of the household — never saved
  };
  if (!c.whim) c.whim = rollWhim(rng, c.aspiration.id);

  // ------------------------------------------------------------- derived

  Object.defineProperty(c, 'stage', {
    get() {
      let s = STAGES[0];
      for (const st of STAGES) if (c.ageDays >= st.days) s = st;
      return s;
    },
  });
  Object.defineProperty(c, 'stageIndex', { get: () => STAGES.indexOf(c.stage) });
  Object.defineProperty(c, 'canCook', { get: () => c.stageIndex >= 1 });
  // The highest growth stage already celebrated, so a save/restore round-trip
  // never replays a birthday that already happened.
  c.stageIndexSeen = save?.stageIndexSeen ?? c.stageIndex;
  Object.defineProperty(c, 'moving', { get: () => c.pose === 'walk' });

  /** How under-stimulated the critter is right now: low fun plus "I've done
   *  everything in this room already" (every habit sitting near satiated). */
  Object.defineProperty(c, 'boredom', {
    get() {
      const funGap = 1 - c.needs.get('fun');
      let sum = 0, n = 0;
      for (const v of c.memory.habit.values()) { sum += v; n++; }
      const avgSat = n ? sum / n : 0;
      return clamp(funGap * 0.6 + avgSat * 0.5);
    },
  });

  c.energyFor = (cost) => (c.needs.get('energy') > cost ? 0.1 : -0.5);

  /** Friendship with another critter — separate from `bond`, which is only
   *  ever about the player. */
  c.relationshipWith = (peerId) => c.relationships[peerId] ?? 0;
  c.bumpRelationship = (peerId, delta) => {
    c.relationships[peerId] = clamp((c.relationships[peerId] ?? 0) + delta);
  };

  c.think = (text) => {
    c.thoughts.unshift(text);
    if (c.thoughts.length > 20) c.thoughts.pop();
    c.memory.log(text);
  };

  c.onNovel = (o) => {
    c.emotion.pulse(0.05, 0.35, 'saw ' + o.label);
    if (c.memory.objects.size <= 18) c.think('what is that? ' + o.label + '.');
  };

  c.randomFreeCellNear = (r) => {
    for (let i = 0; i < 30; i++) {
      const x = c.gx + Math.round(rng.range(-r, r));
      const y = c.gy + Math.round(rng.range(-r, r));
      // Keep free roaming off the room rim and the semantic sit/lie set as a
      // belt-and-suspenders guard. All non-flat furniture is already blocked
      // by isWalkable(), including chairs, beds and sofas.
      if (world.inBounds(x, y) && world.isWalkable(x, y) && !world._sitCells.has(x + ',' + y)
        && !world.isPerimeter(x, y) && !(x === c.gx && y === c.gy)) return [x, y];
    }
    return null;
  };

  /** A tile near the front of the room, i.e. facing whoever is watching. */
  c.frontRowCell = () => {
    let best = null, bestD = -1;
    for (let x = 0; x < world.cols; x++) {
      for (let y = 0; y < world.rows; y++) {
        if (!world.isWalkable(x, y) || world._sitCells.has(x + ',' + y) || world.isPerimeter(x, y)) continue;
        const d = x + y - Math.abs(x - y) * 0.4;
        if (d > bestD) { bestD = d; best = [x, y]; }
      }
    }
    return best;
  };

  // ------------------------------------------------------------- task runner

  function startTask(choice) {
    const alignCell = c.replanAlignment || null;
    c.replanAlignment = null;
    c.task = {
      action: choice.action,
      target: choice.target,
      score: choice.score ?? 0,
      gen: choice.action.run(c, world, choice.target),
      cmd: null, cmdT: 0, cmdInit: false,
      path: null, pathIdx: 0, segmentFacing: -1, lastResult: true,
      blockedSteps: null,
      // A replacement assignment can arrive between cell centres. Preserve
      // that live position and finish/reverse only the current grid segment
      // before asking A* for the new route; never run the remainder of the
      // superseded assignment and never teleport back to its previous cell.
      alignCell,
      wellbeingAtStart: c.needs.wellbeing(),
      // a snapshot, not a reference — c.senseVec gets overwritten every tick
      vectorAtStart: Float32Array.from(c.senseVec),
    };
    if (alignCell) c.pose = 'walk';
    if (choice.action.emote) setEmote(choice.action.emote, 1.2);
  }

  function finishTask({ preservePosition = false } = {}) {
    if (!c.task) return;
    // A decision can interrupt a walk halfway across a tile. Keep that live
    // point and only settle the active one-cell segment for a replacement
    // task. Normal completion/error cleanup still returns to a cell centre.
    let alignment = null;
    if (c.moving && preservePosition) {
      const next = c.task.path?.[c.task.pathIdx];
      if (next && Math.abs(next[0] - c.gx) + Math.abs(next[1] - c.gy) === 1
        && world.isWalkable(next[0], next[1])
        && !world.edgeBlocked(c.gx, c.gy, next[0], next[1])) {
        alignment = [next[0], next[1]];
      } else {
        alignment = [c.gx, c.gy];
      }
    } else if (c.moving) {
      snapToCell(c.gx, c.gy);
    }
    const gain = c.needs.wellbeing() - c.task.wellbeingAtStart;
    const obj = c.task.target?.obj;
    if (obj) c.memory.reinforce(obj.id, gain * 3);
    c.brain.neural.reinforce(c.task.vectorAtStart, c.task.action.id, gain);
    if (c.whim && c.task.action.id === c.whim.actionId) completeWhim();
    c.task = null;
    c.replanAlignment = alignment;
    c.pose = alignment ? 'walk' : 'stand';
  }

  function completeWhim() {
    const done = c.whim;
    c.emotion.pulse(0.35, 0.2, 'satisfied a want');
    c.moodlets.add('goal_met');
    c.needs.satisfy('fun', 0.08);
    const skillKey = c.aspiration.skill;
    if (skillKey && done.weight[c.aspiration.id]) {
      c.skill[skillKey] = clamp(c.skill[skillKey] + 0.04);
    }
    c.think('wanted to ' + done.label + ' — done.');
    c.whim = rollWhim(rng, c.aspiration.id, done.id);
    c.whimAge = 0;
  }

  function setEmote(name, dur) { c.emote = { name, t: 0, dur }; }

  /** Execute the current generator until it needs more time. */
  function runTask(dt) {
    const T = c.task;
    if (!T) return;

    // Reassignment is immediate, but movement stays on the grid: discard the
    // old route, settle just the segment the critter is physically on, then
    // let the replacement generator/A* plan from that newly reached centre.
    if (T.alignCell) {
      if (!alignInterruptedStep(dt)) return;
      T.alignCell = null;
      T.segmentFacing = -1;
    }
    let guard = 0;

    while (guard++ < 12) {
      if (!T.cmd) {
        let step;
        try { step = T.gen.next(T.lastResult); } catch (e) { console.warn(e); finishTask(); return; }
        if (step.done) { finishTask(); return; }
        T.cmd = step.value; T.cmdT = 0; T.cmdInit = false;
        if (!T.cmd) { T.lastResult = true; continue; }
      }

      const cmd = T.cmd;

      if (cmd.t === 'goto') {
        if (!T.cmdInit) {
          T.cmdInit = true;
          // `alignInterruptedStep` guarantees that replacement assignments
          // reach a true cell centre before A* starts.
          if (c.px !== c.gx || c.py !== c.gy) snapToCell(c.gx, c.gy);
          // Route around wherever everyone else currently stands, so paths
          // don't cross straight through/onto another critter mid-walk.
          const avoid = new Set();
          for (const p of c.peers || []) {
            if (p === c || p.away) continue;
            avoid.add(Math.round(p.gx) + ',' + Math.round(p.gy));
          }
          // Never aim at a tile someone is already on — that's what had two
          // critters walking into each other forever, each shoved off by the
          // separation nudge and immediately re-pathing back onto the same
          // spot. Routing *through* a peer is fine though (they move), so if
          // the strict path fails, retry ignoring peers as obstacles while
          // still refusing to finish on top of one.
          const free = cmd.cells.filter(([x, y]) => !avoid.has(x + ',' + y));
          if (!free.length) {
            T.lastResult = false; T.cmd = null; T.gotoFailed = true; T.fails = (T.fails || 0) + 1;
            if (T.fails > 2) { c.think('someone else is there.'); finishTask(); return; }
            continue;
          }
          T.path = findPath(world, [c.gx, c.gy], free, avoid, world._noTransit, T.blockedSteps)
            || findPath(world, [c.gx, c.gy], free, null, world._noTransit, T.blockedSteps);
          T.pathIdx = 0;
          T.segmentFacing = -1;
          T.pathFrom = [c.gx, c.gy];
          if (!T.path) {
            // Unreachable. Hand `false` back so the action can bail gracefully;
            // give up entirely if it keeps asking for places it cannot get to.
            T.lastResult = false; T.cmd = null; T.gotoFailed = true; T.fails = (T.fails || 0) + 1;
            if (T.fails > 2) {
              c.emotion.pulse(-0.3, 0.45, 'could not get there');
              c.think("can't get to it.");
              finishTask();
              return;
            }
            continue;
          }
        }
        if (!walkStep(dt)) return;             // still walking; wait for next tick
        T.lastResult = true; T.cmd = null; T.path = null; T.gotoFailed = false; T.blockedSteps = null;
        continue;
      }

      if (cmd.t === 'use') {
        if (!T.cmdInit) {
          T.cmdInit = true;
          // The preceding goto may have silently failed (unreachable, or
          // another critter already standing where this one was headed) —
          // most actions don't check its result before yielding straight
          // into use(), which used to mean "sit"/"cook"/etc. would just
          // happen from wherever the critter actually ended up. Refuse to
          // use furniture from a tile that isn't actually a valid spot for
          // it, rather than let every action remember to check for itself.
          const validUseCells = cmd.obj
            ? (cmd.outside ? world.exteriorApproachCells(cmd.obj) : useCells(cmd.obj))
            : null;
          if (cmd.obj && !validUseCells.some(([vx, vy]) => vx === c.gx && vy === c.gy)) {
            T.cmd = null;
            // Say which it actually was. A failed walk and a piece of
            // furniture that moved out from under them are different
            // problems, and reporting both as "that's not where I thought"
            // made every unreachable target look like a glitch.
            if (T.gotoFailed) {
              c.emotion.pulse(-0.2, 0.3, 'could not get there');
              c.think("can't get to it.");
            } else {
              c.emotion.pulse(-0.15, 0.25, "wasn't actually there");
              c.think("huh, that's not where I thought it was.");
            }
            finishTask();
            return;
          }
          if (cmd.obj) faceObject(cmd.obj);
          if (cmd.emote) setEmote(cmd.emote, cmd.dur);
        }
        c.pose = cmd.pose || 'stand';
        const before = T.cmdT;
        T.cmdT = Math.min(cmd.dur, T.cmdT + dt);
        const frac = (T.cmdT - before) / cmd.dur;
        if (cmd.fill) for (const k in cmd.fill) c.needs.satisfy(k, cmd.fill[k] * frac);
        if (cmd.sound && cmd.obj && Math.random() < dt * 0.6) {
          world.emitSound(cmd.obj.gx, cmd.obj.gy, cmd.sound, 'use');
        }
        if (T.cmdT >= cmd.dur) { T.lastResult = true; T.cmd = null; continue; }
        return;
      }

      if (cmd.t === 'emote') {
        if (!T.cmdInit) { T.cmdInit = true; setEmote(cmd.emote, cmd.dur); }
        T.cmdT += dt;
        if (T.cmdT >= cmd.dur) { T.lastResult = true; T.cmd = null; continue; }
        return;
      }

      if (cmd.t === 'face') { c.dir = cmd.value ?? cmd.dir; T.cmd = null; T.lastResult = true; continue; }
      if (cmd.t === 'hold') { c.holding = cmd.item; T.cmd = null; T.lastResult = true; continue; }
      if (cmd.t === 'set') { cmd.obj.state[cmd.key] = cmd.value; T.cmd = null; T.lastResult = true; continue; }

      T.cmd = null; T.lastResult = true;       // unknown command — skip it
    }
  }

  /** Finish or safely reverse the one cell transition that was already in
   *  progress when a new assignment arrived. The old route itself is gone. */
  function alignInterruptedStep(dt) {
    const T = c.task;
    let [tx, ty] = T.alignCell;
    const fromX = c.gx, fromY = c.gy;
    const changingCell = tx !== fromX || ty !== fromY;
    const peerOnTarget = (c.peers || []).some((p) => p !== c && !p.away
      && p.gx === tx && p.gy === ty);
    if ((changingCell && (!world.isWalkable(tx, ty)
      || world.edgeBlocked(fromX, fromY, tx, ty) || peerOnTarget))) {
      // The forward half of the interrupted segment became unsafe after the
      // assignment was made. Reverse along the same centre line instead.
      T.alignCell = [fromX, fromY];
      tx = fromX; ty = fromY;
    }

    const dx = tx - c.px, dy = ty - c.py;
    const remaining = Math.abs(dx) + Math.abs(dy);
    c.pose = 'walk';
    if (remaining < 0.06) {
      snapToCell(tx, ty);
      c.pose = 'stand';
      return true;
    }

    const speed = c.stage.speed * (c.needs.get('energy') > 0.2 ? 1 : 0.6);
    const horizontal = Math.abs(dx) > Math.abs(dy);
    const step = Math.min(remaining, speed * dt);
    const nx = horizontal ? c.px + Math.sign(dx) * step : tx;
    const ny = horizontal ? ty : c.py + Math.sign(dy) * step;
    const ignores = occupancyObjectsAt(fromX, fromY, tx, ty);
    if (!segmentClearOfFurniture(c.px, c.py, nx, ny, 0.3, ignores)) {
      if (changingCell) {
        T.alignCell = [fromX, fromY];
        return false;
      }
      snapToCell(fromX, fromY);
      c.pose = 'stand';
      return true;
    }
    c.px = nx; c.py = ny;
    clampToRoom(false);
    c.bob += dt * 9;
    return false;
  }

  /** @returns true when the path is finished. */
  function walkStep(dt) {
    const T = c.task;
    if (!T.path || T.pathIdx >= T.path.length) { c.pose = 'stand'; return true; }
    const [tx, ty] = T.path[T.pathIdx];
    const [fromX, fromY] = T.pathIdx === 0 ? T.pathFrom : T.path[T.pathIdx - 1];
    const isDestination = T.pathIdx === T.path.length - 1;
    const cardinalStep = Math.abs(tx - fromX) + Math.abs(ty - fromY) === 1;

    // Paths are snapshots, while the room can change underneath them. An
    // item moved onto the next cell (or a gate closed across this edge) used
    // to be ignored until the old route completed, so the critter visibly
    // walked through the new obstacle. Return to the last known-safe cell and
    // let the same goto command plan again against the current collision map.
    const peerOnTarget = (c.peers || []).some((p) => {
      if (p === c || p.away) return false;
      if (p.gx === tx && p.gy === ty) return true;
      const reserved = p.task?.path?.[p.task.pathIdx];
      return p.id < c.id && reserved && reserved[0] === tx && reserved[1] === ty;
    });
    const stepStillOpen = cardinalStep && world.isWalkable(tx, ty) && !peerOnTarget
      && !world.edgeBlocked(fromX, fromY, tx, ty)
      && (isDestination || !world._noTransit.has(tx + ',' + ty));
    if (!stepStillOpen) return rejectCurrentStep(T, fromX, fromY, tx, ty);

    // Turn exactly once, while still centered in the cell being departed.
    // Direction is stable for the entire segment; it never flips while the
    // critter is resting on a cell edge or halfway across a tile.
    if (T.segmentFacing !== T.pathIdx) {
      const dir = DIRS.findIndex(([dx, dy]) => dx === tx - fromX && dy === ty - fromY);
      if (dir >= 0) c.dir = dir;
      T.segmentFacing = T.pathIdx;
    }
    const speed = c.stage.speed * (c.needs.get('energy') > 0.2 ? 1 : 0.6);
    const horizontal = tx !== fromX;
    const current = horizontal ? c.px : c.py;
    const target = horizontal ? tx : ty;
    const remaining = Math.abs(target - current);
    c.pose = 'walk';

    if (remaining < 0.06) {
      snapToCell(tx, ty);
      c.stuck = 0;
      T.pathIdx++;
      if (T.pathIdx >= T.path.length) { c.pose = 'stand'; return true; }
      return false;
    }
    const step = Math.min(remaining, speed * dt);
    const next = current + Math.sign(target - current) * step;
    // Lock the perpendicular coordinate to the centre line explicitly. This
    // removes even microscopic diagonal drift and makes every rendered frame
    // agree with the four-neighbour grid that A* searched.
    const nx = horizontal ? next : fromX;
    const ny = horizontal ? fromY : next;
    const collisionIgnores = movementOccupancyObjects(T, fromX, fromY, tx, ty, isDestination);
    if (!segmentClearOfFurniture(c.px, c.py, nx, ny, 0.3, collisionIgnores)) {
      return rejectCurrentStep(T, fromX, fromY, tx, ty);
    }
    c.px = nx;
    c.py = ny;
    clampToRoom(false);
    c.bob += dt * 9;
    return false;
  }

  /** Remember a grid edge rejected by live collision so replanning cannot
   *  choose the identical bad approach forever. This is the wall/chair
   *  oscillation guard: A* tries another side once, or reports unreachable
   *  when the seat truly has no body-clear entrance. */
  function rejectCurrentStep(T, fromX, fromY, tx, ty) {
    if (Math.abs(tx - fromX) + Math.abs(ty - fromY) === 1) {
      if (!T.blockedSteps) T.blockedSteps = new Set();
      T.blockedSteps.add(world.edgeKey(fromX, fromY, tx, ty));
    }
    c.stuck++;
    snapToCell(fromX, fromY);
    c.pose = 'stand';
    T.path = null; T.pathIdx = 0; T.segmentFacing = -1; T.cmdInit = false;
    return false;
  }

  /**
   * Hard backstop: whatever set px/py, pull them back inside the room. This
   * should never actually trigger — pathfinding only ever targets in-bounds
   * cells — but it means a critter can never visually end up outside the
   * floor no matter what bug or future action manages to move it there.
   */
  function clampToRoom(syncGrid = true) {
    c.px = Math.max(0, Math.min(world.cols - 1, c.px));
    c.py = Math.max(0, Math.min(world.rows - 1, c.py));
    if (syncGrid) { c.gx = Math.round(c.px); c.gy = Math.round(c.py); }
  }

  function snapToCell(gx, gy) {
    c.gx = Math.max(0, Math.min(world.cols - 1, Math.round(gx)));
    c.gy = Math.max(0, Math.min(world.rows - 1, Math.round(gy)));
    c.px = c.gx;
    c.py = c.gy;
  }

  /** Keep the critter's body outside furniture continuously, rather than
   *  waiting until its centre rounds into the blocked cell. The old rounded
   *  test allowed almost half a tile of visible penetration. */
  function bodyClearOfFurniture(px, py, radius = 0.3, ignoreObjects = null) {
    const cx = px + 0.5, cy = py + 0.5;
    for (const o of world.objects) {
      if (o.def.flat || o.def.edgeBlock) continue;
      if (ignoreObjects?.has(o)) continue;
      const ox = o.def.mobile ? o.fx : o.gx;
      const oy = o.def.mobile ? o.fy : o.gy;
      const nx = Math.max(ox, Math.min(ox + o.w, cx));
      const ny = Math.max(oy, Math.min(oy + o.h, cy));
      if (Math.hypot(cx - nx, cy - ny) < radius) return false;
    }
    return true;
  }

  /** Swept collision for the visible body. A large simulation-speed frame or
   *  a moving ball must not be able to sit between the previous and next
   *  endpoint and get skipped by an endpoint-only collision test. */
  function segmentClearOfFurniture(ax, ay, bx, by, radius = 0.3, ignoreObjects = null) {
    const distance = Math.hypot(bx - ax, by - ay);
    const samples = Math.max(1, Math.ceil(distance / Math.max(0.08, radius * 0.4)));
    for (let i = 1; i <= samples; i++) {
      const f = i / samples;
      if (!bodyClearOfFurniture(ax + (bx - ax) * f, ay + (by - ay) * f, radius, ignoreObjects)) return false;
    }
    return true;
  }

  const coversCell = (o, x, y) => x >= o.gx && x < o.gx + o.w
    && y >= o.gy && y < o.gy + o.h;

  /** Occupiable furniture overlapping either endpoint of a segment. Used
   *  when leaving a bed/seat and while settling an interrupted seat entry. */
  function occupancyObjectsAt(...coords) {
    const result = new Set();
    for (const o of world.objects) {
      if (!canOccupyObject(o)) continue;
      for (let i = 0; i < coords.length; i += 2) {
        if (coversCell(o, coords[i], coords[i + 1])) { result.add(o); break; }
      }
    }
    return result;
  }

  /** Only the explicitly assigned item may be entered at the end of a route.
   *  The occupiable item under the starting cell is also ignored so a critter
   *  can get back out without colliding with the seat it is leaving. */
  function movementOccupancyObjects(T, fromX, fromY, tx, ty, isDestination) {
    const result = occupancyObjectsAt(fromX, fromY);
    const target = T.target?.obj;
    if (isDestination && target && canOccupyObject(target) && coversCell(target, tx, ty)) {
      result.add(target);
    }
    return result;
  }

  /** Whole-cell moves used for the two non-path movement cases: resolving a
   *  legacy stacked save and stepping off a floor roller. */
  function wholeCellOpen(fromX, fromY, x, y) {
    const fx = Math.round(fromX), fy = Math.round(fromY);
    const tx = Math.round(x), ty = Math.round(y);
    if (!world.isWalkable(tx, ty) || world._noTransit.has(tx + ',' + ty)) return false;
    if (world.edgeBlocked(fx, fy, tx, ty)) return false;
    return !(c.peers || []).some((p) => p !== c && !p.away && p.gx === tx && p.gy === ty);
  }

  /** Repair old saves (or a piece restored after the critter) that place a
   *  critter inside newly-solid furniture. Search outward by Manhattan ring
   *  and land once, exactly at a free cell center. */
  function recoverFromBlockedCell() {
    if (world.isWalkable(c.gx, c.gy)) return;
    const sx = c.gx, sy = c.gy;
    for (let radius = 1; radius <= Math.max(world.cols, world.rows); radius++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const dy = radius - Math.abs(dx);
        for (const sign of dy === 0 ? [1] : [-1, 1]) {
          const x = sx + dx, y = sy + dy * sign;
          if (!world.inBounds(x, y) || !world.isWalkable(x, y) || world.isPerimeter(x, y)) continue;
          if ((c.peers || []).some((p) => p !== c && !p.away && p.gx === x && p.gy === y)) continue;
          c.task = null;
          c.asleep = false;
          c.pose = 'stand';
          snapToCell(x, y);
          return;
        }
      }
    }
  }

  function faceObject(o) {
    // Sitting/lying directly on the piece puts the critter's own centre
    // right on top of the object's, so the delta below is ~0 and the
    // early-return further down just left whatever direction the critter
    // happened to be walking in when it arrived — a chair sat in facing
    // sideways, a bed slept in facing the wrong way. Face however the piece
    // is actually oriented instead: the chair's open side (state.face), a
    // directional piece's own state.rotation, or a fixed def.faceDir for
    // anything occupiable but not itself rotatable (the toilet).
    const onIt = canOccupyObject(o) && o.gx <= c.gx && c.gx < o.gx + o.w
      && o.gy <= c.gy && c.gy < o.gy + o.h;
    if (onIt) {
      // state.face (plain chairs) is defined in world/objects.js as "which
      // way the seat opens" using this exact 0:+gx 1:+gy 2:-gx 3:-gy scale,
      // so it drops straight in — confirmed correct.
      //
      // state.rotation (kenneyItem sit furniture — armchair, office_chair,
      // bar_stool, bench) has no such documented guarantee: it only picks
      // which of the 4 compass-labelled sprite images to show (ROT_FILES in
      // sprites.js), an independently-authored convention with no promise of
      // lining up with a critter's own facing scale — critter.js draws this
      // creature procedurally, with no compass-labelled art of its own to
      // anchor a comparison against. Reported live as wrong (a chair rotated
      // to visually face NW sat a critter visually facing SW), but I don't
      // have a reliable way to independently verify which of the three other
      // rotation values is actually correct — the creature's round, mostly
      // symmetric shape makes "which way does it face" hard to judge from a
      // screenshot even directly, and I tried two derivations (a constant
      // +1, and a 0/2-fixed 1/3-swap) that disagreed with each other and, on
      // recheck, with the report itself. Left as a direct pass-through
      // rather than shipping an unverified guess — needs an actual side by
      // side (rotate the piece through all 4 states, sit a critter in each,
      // compare) to pin down the real mapping.
      const facing = o.def.directional
        ? (o.type === 'chair' ? o.state.face : o.state.rotation)
        : o.def.faceDir;
      if (facing != null) { c.dir = facing & 3; return; }
    }
    const cc = world.center(o);
    const dx = cc.gx - (c.px + 0.5), dy = cc.gy - (c.py + 0.5);
    if (Math.abs(dx) < 0.2 && Math.abs(dy) < 0.2) return;
    c.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 0 : 2) : (dy > 0 ? 1 : 3);
  }

  // ------------------------------------------------------------- interactions

  c.pet = () => {
    c.signals.touch = 1;
    c.signals.attention = 1;
    c.bond = clamp(c.bond + 0.012);
    c.needs.satisfy('social', 0.16);
    c.emotion.pulse(0.45, 0.3, 'was petted');
    setEmote('heart', 1.6);
    if (c.asleep && Math.random() < 0.5) c.think('…five more minutes.');
  };

  c.callTo = (cell) => {
    if (!world.isWalkable(cell[0], cell[1])) return;
    c.signals.callCell = [Math.round(cell[0]), Math.round(cell[1])];
    c.signals.attention = 1;
    // A direct player command is an assignment, not merely another sensory
    // hint for the next think tick. Replace the current route immediately;
    // startTask preserves/settles its live one-cell segment before replanning.
    const action = actionById('answer_call');
    if (action) {
      c.asleep = false;
      finishTask({ preservePosition: true });
      startTask({ action, target: { obj: null, dist: 0, cell: c.signals.callCell }, score: 99 });
    }
    return true;
  };

  c.give = (item) => {
    c.holding = item;
    c.signals.attention = 1;
    c.emotion.pulse(0.3, 0.35, 'was given something');
    setEmote('food', 1.4);
    c.needs.satisfy('social', 0.1);
    c.think('for me?');
  };

  /** User clicked a piece of furniture: try to start the matching action.
   *  `onlyAct`, when given, tries just that one affordance instead of the
   *  first the object happens to offer — for objects with more than one
   *  (a sink offers both 'wash' and 'fill_can'), the click menu lets the
   *  player pick which. */
  c.suggest = (obj, onlyAct) => {
    c.signals.attention = 1;
    for (const act of onlyAct ? [onlyAct] : obj.def.acts) {
      const a = actionFor(act);
      if (!a) continue;
      let target = null;
      try { target = a.pick(c, world, c.percept); } catch { target = null; }
      if (!target) continue;
      // Point the action at the thing the user actually clicked, but only when
      // that object is the one supplying the affordance (the sofa supplies
      // 'lounge' for watch_tv, so don't swap the TV in for it).
      if (target.obj && target.obj !== obj && obj.def.acts.includes(act)
        && target.obj.def.acts.includes(act) && world.approachCells(obj).length) {
        target = { ...target, obj };
      }
      finishTask({ preservePosition: true });
      startTask({ action: a, target, score: 99 });
      c.think('alright, the ' + obj.label + '.');
      return true;
    }
    // Nothing it can do with that right now (an empty stove, a table with no
    // food on it). Rather than ignore the user, go and have a look at it.
    const look = actionById('investigate');
    if (look && world.approachCells(obj).length) {
      finishTask({ preservePosition: true });
      startTask({
        action: look, score: 99,
        target: { obj, dist: 0, novelty: c.memory.novelty(obj.id) },
      });
      setEmote('question', 1.2);
      return true;
    }
    c.emotion.pulse(-0.05, 0.2, 'not sure what to do with that');
    setEmote('question', 1.2);
    return false;
  };

  /** Step out through the door for a while. Called by the explore action once
   *  it has walked the critter to the doorway. */
  c.leaveToExplore = (minutesGone) => {
    c.away = true;
    c.awayTimer = minutesGone;
    c.task = null;
    c.think('off exploring…');
  };

  // ------------------------------------------------------------- main tick

  c.update = (dt) => {
    const hours = (dt * MINUTES_PER_SECOND) / 60;

    if (c.away) {
      // Time still passes while it's gone — needs still drift, curiosity and
      // company both get a little top-up, as if something out there happened.
      c.needs.update(hours, { fun: -2.5, social: -1, hygiene: 0.5 });
      c.awayTimer -= hours * 60;
      if (c.awayTimer <= 0) {
        c.away = false;
        c.gx = 0; c.gy = Math.round(DOOR_GY);
        c.px = c.gx; c.py = c.gy;
        c.memory.log('came back from outside');
        c.emotion.pulse(0.3, 0.3, 'back from an adventure');
        c.moodlets.add('explored');
        c.moodlets.remove('stir_crazy');
        const found = 4 + Math.floor(Math.random() * 13);
        world.earnCoins(found);
        if (Math.random() < 0.5) {
          const mats = 1 + Math.floor(Math.random() * 3);
          world.earnMaterials(mats);
          c.think(`home again. found ${found} coins and ${mats} scrap out there.`);
        } else {
          c.think('home again. found ' + found + ' coins out there.');
        }
      }
      return;
    }

    recoverFromBlockedCell();
    if (!c.moving) snapToCell(c.gx, c.gy);

    c.percept = perceive(c, world);

    // needs — sleep's own multipliers combine with whatever moodlets are active
    // (well-rested slows energy decay further, a messy room speeds up hygiene, etc.)
    const mods = c.asleep ? { hunger: 0.5, energy: 0, fun: 0.2, social: 0.4, hygiene: 0.5 } : {};
    const moodMods = c.moodlets.needMods();
    for (const k in moodMods) mods[k] = (mods[k] ?? 1) * moodMods[k];
    // a cold winter burns a little more energy and appetite; a warm summer eases both
    const season = world.season();
    if (season === 'winter') { mods.hunger = (mods.hunger ?? 1) * 1.15; mods.energy = (mods.energy ?? 1) * 1.1; }
    else if (season === 'summer') { mods.hunger = (mods.hunger ?? 1) * 0.9; }
    c.needs.update(hours, mods);
    c.memory.decaySatiation(hours);
    if (!c.asleep) c.awakeHours += hours;
    c.ageDays = Math.max(0, (world.day + world.minutes / 1440) - c.bornDay);
    if (c.stageIndex > c.stageIndexSeen) {
      c.stageIndexSeen = c.stageIndex;
      c.moodlets.add('birthday');
      c.emotion.pulse(0.6, 0.5, 'grew up');
      c.think(`I'm a ${c.stage.name} now!`);
      world.emitSound(c.gx, c.gy, 0.7, 'birthday');
      world.earnCoins(15);
    }

    // friendships fade a little without upkeep, same idea as habit satiation
    for (const id in c.relationships) c.relationships[id] = clamp(c.relationships[id] - hours * 0.004);

    c.moodlets.update(hours);
    if (c.needs.get('social') < 0.15 && !c.moodlets.has('lonely')) c.moodlets.add('lonely');
    if (world.messes.length >= 4 && !c.moodlets.has('messy_room')) c.moodlets.add('messy_room');
    if (c.boredom > 0.85 && !c.moodlets.has('stir_crazy')) c.moodlets.add('stir_crazy');

    // a want that never gets picked up eventually gives way to a fresher one
    c.whimAge += hours;
    if (c.whimAge > 20) { c.whim = rollWhim(rng, c.aspiration.id, c.whim.id); c.whimAge = 0; }

    // sustained neglect (not one bad hour, but many) eventually makes it sick;
    // steady good care brings it back down and clears the moodlet
    const wellbeing = c.needs.wellbeing();
    c.neglect = clamp((c.neglect ?? 0) + (wellbeing < 0.3 ? hours : -hours * 1.5), 0, 24);
    if (c.neglect >= 18 && !c.moodlets.has('unwell')) {
      c.moodlets.add('unwell');
      c.emotion.pulse(-0.3, -0.1, 'feeling unwell');
      c.think('not feeling great...');
    }
    if (c.neglect <= 2 && c.moodlets.has('unwell')) {
      c.moodlets.remove('unwell');
      c.emotion.pulse(0.2, 0, 'feeling better');
      c.think('feeling better now.');
    }

    // emotion
    const worst = c.needs.worst();
    c.emotion.update(dt, c.needs.wellbeing(), {
      urgency: worst.urgency,
      novelty: c.percept.novelty * (c.asleep ? 0 : 1),
      stimulation: c.percept.sound * 0.6 + (c.pose === 'play' ? 0.5 : 0),
      tired: clamp(c.awakeHours / 16) * (c.asleep ? 1.4 : 1),
      bond: c.bond,
      moodletPull: c.moodlets.valencePull(),
    });

    // signals fade
    c.signals.attention = approach(c.signals.attention, 0, 0.08, dt);
    c.signals.touch = approach(c.signals.touch, 0, 2.2, dt);

    // deliberate
    c.thinkT -= dt;
    if (c.thinkT <= 0) {
      c.thinkT = THINK_INTERVAL;
      const interrupt = c.brain.shouldInterrupt(c, world, c.percept, c.task);
      if (!c.task || interrupt) {
        if (c.task && interrupt) { c.asleep = false; finishTask({ preservePosition: true }); }
        const choice = c.brain.decide(c, world, c.percept);
        if (choice) startTask(choice);
      } else if (!c.asleep) {
        c.brain.observe(c, world, c.percept);
      }
    }

    if (c.task) runTask(dt);
    else c.pose = 'stand';

    // Never solve crowding with a fractional shove: that was the only code
    // path able to leave an idle critter balanced on a tile edge. Planned
    // steps reserve peer cells above; this is just a migration backstop for
    // an old save that already contains two stopped critters on one cell.
    if (!c.moving) {
      const stacked = (c.peers || []).find((p) => p !== c && !p.away && !p.moving
        && p.gx === c.gx && p.gy === c.gy && p.id < c.id);
      if (stacked) {
        const stepIndex = DIRS.findIndex(([dx, dy]) => wholeCellOpen(c.gx, c.gy, c.gx + dx, c.gy + dy));
        if (stepIndex >= 0) {
          const [dx, dy] = DIRS[stepIndex];
          c.task = null;
          c.dir = stepIndex;
          snapToCell(c.gx + dx, c.gy + dy);
        }
      }
    }

    // idle animation state
    c.blinkT -= dt;
    if (c.blinkT <= 0) { c.blink = 0.16; c.blinkT = 1.6 + Math.random() * 4; }
    c.blink = Math.max(0, c.blink - dt);
    if (!c.moving) c.bob = approach(c.bob, 0, 4, dt);
    if (c.emote) { c.emote.t += dt; if (c.emote.t > c.emote.dur) c.emote = null; }

    // eyes follow the most interesting thing in view
    const focus = c.percept.visible.find((v) => v.novelty > 0.25) || c.percept.nearest;
    c.lookAt = focus ? world.center(focus.obj) : null;

    // A roller advances exactly one whole tile. It never leaves a critter at
    // a fractional coordinate and never changes facing except as that cell
    // transition begins.
    if (!c.task && !c.asleep) {
      const push = world.rollerAt(c.gx, c.gy);
      if (push) {
        const nx = c.gx + push[0], ny = c.gy + push[1];
        if (wholeCellOpen(c.gx, c.gy, nx, ny)) {
          c.dir = DIRS.findIndex(([dx, dy]) => dx === push[0] && dy === push[1]);
          snapToCell(nx, ny);
        }
      }
    }

    // Strong invariant: only an active center-to-center walk may have
    // fractional visual coordinates. Every idle or interaction pose is
    // snapped to the exact center of its logical cell each frame.
    if (c.moving) clampToRoom(false);
    else snapToCell(c.gx, c.gy);
  };

  c.currentLabel = () => {
    if (c.away) return 'out exploring';
    if (c.asleep) return 'sleeping';
    return c.task ? c.task.action.label : 'thinking';
  };

  c.serialize = () => ({
    id: c.id, seed: c.seed, name: c.name, gx: c.gx, gy: c.gy, dir: c.dir,
    holding: c.holding, bond: c.bond, relationships: c.relationships,
    ageDays: c.ageDays, bornDay: c.bornDay, stageIndexSeen: c.stageIndexSeen, awakeHours: c.awakeHours,
    skill: c.skill, trait: c.trait, away: c.away, awayTimer: c.awayTimer,
    aspiration: c.aspiration, whim: c.whim, whimAge: c.whimAge, neglect: c.neglect,
    needs: c.needs.serialize(), emotion: c.emotion.serialize(),
    memory: c.memory.serialize(), brain: c.brain.serialize(),
    moodlets: c.moodlets.serialize(),
  });

  return c;
}


// ---- src/render/critter.js ----
// Drawing the critter. Everything is procedural so expression, pose and growth
// stage are continuous parameters rather than a sprite sheet — which is exactly
// what you want when the face has to reflect a valence/arousal pair.


const FACING_CAMERA = (dir) => dir === 0 || dir === 1;

/** Eye/mouth shapes per emotional region name (see creature/emotion.js). */
const FACES = {
  grin:    { eye: 'arc',   mouth: 'grin',  blush: 0.9 },
  smile:   { eye: 'open',  mouth: 'smile', blush: 0.5 },
  neutral: { eye: 'open',  mouth: 'small', blush: 0.2 },
  sleepy:  { eye: 'half',  mouth: 'small', blush: 0.1 },
  wide:    { eye: 'wide',  mouth: 'o',     blush: 0.3 },
  flat:    { eye: 'half',  mouth: 'flat',  blush: 0 },
  sad:     { eye: 'droop', mouth: 'frown', blush: 0 },
  worried: { eye: 'wide',  mouth: 'wobble', blush: 0 },
  cross:   { eye: 'angry', mouth: 'frown', blush: 0 },
};

/**
 * @param x,y    screen position of the tile the critter stands on (north corner)
 * @param c      the critter
 * @param t      seconds, for animation
 * @param opts   { scale, portrait }
 */
function drawCritter(ctx, x, y, c, t, opts = {}) {
  const s = (opts.scale ?? c.stage.scale) * (opts.portrait ? 1.9 : 1);
  const face = FACES[c.emotion.label().face] || FACES.neutral;
  const pose = c.pose;
  const asleep = c.asleep;

  const walkPhase = Math.sin(c.bob);
  const breathe = Math.sin(t * (asleep ? 1.1 : 2.2)) * (asleep ? 1.2 : 0.5);
  let lift = 0, squash = 1, lean = 0;

  if (pose === 'walk') { lift = Math.abs(walkPhase) * 1.6; squash = 1 + walkPhase * 0.03; }
  if (pose === 'sit' || pose === 'read') { lift = -3; squash = 0.86; }
  if (pose === 'lie') { lift = -5; squash = 0.62; lean = 1; }
  if (pose === 'play') { lift = Math.abs(Math.sin(t * 7)) * 4; }
  if (pose === 'peer') { lean = 0.4; }
  if (pose === 'groom') { lean = -0.3; }

  // `y` is the tile's north corner (sy(c.px,c.py)); the +8 (=HH) below
  // descends to the tile's true centre. Anchoring the BODY's own origin
  // there left the feet — drawn further south still, at local y = bh*0.52
  // below this origin — sitting well past true centre instead of on it,
  // which is what actually reads as "standing in the cell" at a glance.
  // Pull the whole body back up by exactly that local offset (measured at
  // neutral stand, not the current pose's squash, so a seated/lying
  // critter's own separate seat-height lift still layers on top of a
  // correctly-grounded stand baseline rather than compounding with it) so
  // the feet — not the torso — land on the tile's true centre.
  const FEET_DROP = 10.5 * s * 0.52;
  const bx = x, by = y + 8 - FEET_DROP - lift + breathe * 0.5;
  const bw = 9 * s, bh = 10.5 * s * squash;

  // shadow
  if (!opts.portrait) {
    ctx.fillStyle = PAL.shadow;
    ctx.beginPath();
    ctx.ellipse(x, y + 9, bw * 0.95, bw * 0.48, 0, 0, 7);
    ctx.fill();
  }

  ctx.save();
  ctx.translate(bx, by);
  if (lean) ctx.rotate(lean * 0.22);

  // feet
  if (pose !== 'lie') {
    ctx.fillStyle = PAL.bodyD;
    const fo = pose === 'walk' ? walkPhase * 2.2 : 0;
    ctx.beginPath(); ctx.ellipse(-3.4 * s + fo, bh * 0.52, 2.6 * s, 1.7 * s, 0, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.ellipse(3.4 * s - fo, bh * 0.52, 2.6 * s, 1.7 * s, 0, 0, 7); ctx.fill();
  }

  // ears — set back a little when the critter faces away
  const earTilt = FACING_CAMERA(c.dir) ? 1 : -1;
  const earDroop = c.emotion.valence < -0.2 ? 0.5 : 0;
  ctx.fillStyle = PAL.bodyD;
  for (const sx of [-1, 1]) {
    ctx.save();
    ctx.translate(sx * bw * 0.62, -bh * 0.72);
    ctx.rotate(sx * (0.35 + earDroop) * earTilt);
    ctx.beginPath();
    ctx.ellipse(0, -2.2 * s, 1.9 * s, 3.6 * s, 0, 0, 7);
    ctx.fill();
    ctx.fillStyle = PAL.blush;
    ctx.beginPath(); ctx.ellipse(0, -2.2 * s, 0.9 * s, 2.1 * s, 0, 0, 7); ctx.fill();
    ctx.fillStyle = PAL.bodyD;
    ctx.restore();
  }

  // tail
  ctx.fillStyle = PAL.bodyD;
  ctx.save();
  ctx.translate((c.dir === 0 ? -1 : 1) * bw * 0.85, bh * 0.12);
  ctx.rotate(Math.sin(t * 3 + c.bob) * 0.25 * (c.emotion.arousal + 1));
  ctx.beginPath(); ctx.ellipse(0, 0, 3.2 * s, 1.5 * s, 0.4, 0, 7); ctx.fill();
  ctx.restore();

  // body
  ctx.fillStyle = PAL.body;
  ctx.beginPath();
  ctx.ellipse(0, 0, bw, bh, 0, 0, 7);
  ctx.fill();
  ctx.fillStyle = PAL.bodyL;
  ctx.beginPath(); ctx.ellipse(-bw * 0.22, -bh * 0.28, bw * 0.55, bh * 0.5, 0, 0, 7); ctx.fill();
  ctx.fillStyle = PAL.belly;
  ctx.beginPath(); ctx.ellipse(0, bh * 0.24, bw * 0.55, bh * 0.42, 0, 0, 7); ctx.fill();

  // arms
  const armUp = pose === 'reach' || pose === 'wave' || pose === 'play';
  ctx.fillStyle = PAL.bodyD;
  const waveA = pose === 'wave' ? Math.sin(t * 9) * 0.5 : 0;
  for (const sx of [-1, 1]) {
    ctx.save();
    ctx.translate(sx * bw * 0.86, -bh * 0.05);
    const up = armUp && (sx > 0 || pose !== 'wave');
    ctx.rotate(sx * (up ? -1.1 + waveA : 0.25 + (pose === 'walk' ? walkPhase * 0.3 * sx : 0)));
    ctx.beginPath(); ctx.ellipse(0, 1.5 * s, 1.6 * s, 3 * s, 0, 0, 7); ctx.fill();
    ctx.restore();
  }

  // face
  if (FACING_CAMERA(c.dir) || opts.portrait) {
    const dx = (opts.portrait ? 0 : (c.dir === 0 ? 1.6 : -1.6)) * s;
    const closed = asleep || c.blink > 0 || face.eye === 'half';
    const ey = -bh * 0.18;
    drawEyes(ctx, dx, ey, s, face.eye, closed, asleep, c);
    drawMouth(ctx, dx, ey + 4.4 * s, s, asleep ? 'small' : face.mouth);
    if (face.blush > 0.35) {
      ctx.fillStyle = 'rgba(240,145,142,' + (0.35 * face.blush).toFixed(2) + ')';
      ctx.beginPath(); ctx.ellipse(dx - 4.6 * s, ey + 2.6 * s, 1.9 * s, 1.2 * s, 0, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.ellipse(dx + 4.6 * s, ey + 2.6 * s, 1.9 * s, 1.2 * s, 0, 0, 7); ctx.fill();
    }
  } else {
    ctx.fillStyle = PAL.bodyD;                        // back of the head
    ctx.beginPath(); ctx.ellipse(0, -bh * 0.15, bw * 0.5, bh * 0.35, 0, 0, 7); ctx.fill();
  }

  // visitors wear a little red bandana so they read as "not yours" at a glance
  if (c.visitor) {
    ctx.fillStyle = '#d9534f';
    ctx.beginPath();
    ctx.ellipse(0, bh * 0.02, bw * 0.66, bh * 0.16, 0, 0, Math.PI, true);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-bw * 0.14, bh * 0.08);
    ctx.lineTo(-bw * 0.02, bh * 0.34);
    ctx.lineTo(bw * 0.14, bh * 0.08);
    ctx.closePath();
    ctx.fill();
  }

  ctx.restore();

  if (c.holding && !opts.portrait) drawItem(ctx, bx, by - bh - 3, s, c.holding, pose);
}

function drawEyes(ctx, dx, ey, s, kind, closed, asleep, c) {
  const off = 3.1 * s;
  // pupils drift toward whatever the critter is looking at
  const look = c.lookAt ? Math.max(-1, Math.min(1, (c.lookAt.gx - c.px - (c.lookAt.gy - c.py)) * 0.4)) : 0;

  for (const sx of [-1, 1]) {
    const ex = dx + sx * off;
    if (closed || kind === 'half') {
      ctx.strokeStyle = PAL.ink; ctx.lineWidth = 1.1 * s;
      ctx.beginPath();
      ctx.moveTo(ex - 1.7 * s, ey);
      ctx.quadraticCurveTo(ex, ey + (asleep ? 1.4 : 0.9) * s, ex + 1.7 * s, ey);
      ctx.stroke();
      continue;
    }
    const rw = kind === 'wide' ? 2.2 : 1.9, rh = kind === 'wide' ? 2.5 : 2.1;
    ctx.fillStyle = PAL.white;
    ctx.beginPath(); ctx.ellipse(ex, ey, rw * s, rh * s, 0, 0, 7); ctx.fill();
    ctx.fillStyle = PAL.ink;
    ctx.beginPath();
    ctx.ellipse(ex + look * 0.7 * s, ey + (kind === 'droop' ? 0.7 * s : 0), 1.1 * s, 1.3 * s, 0, 0, 7);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillRect(ex + look * 0.7 * s - 0.2 * s, ey - 1 * s, 0.8 * s, 0.8 * s);

    if (kind === 'angry') {
      ctx.strokeStyle = PAL.ink; ctx.lineWidth = 1.2 * s;
      ctx.beginPath();
      ctx.moveTo(ex - sx * 2.2 * s, ey - 3.4 * s);
      ctx.lineTo(ex + sx * 1.6 * s, ey - 2.2 * s);
      ctx.stroke();
    }
    if (kind === 'droop') {
      ctx.strokeStyle = PAL.ink; ctx.lineWidth = 1 * s;
      ctx.beginPath();
      ctx.moveTo(ex - sx * 2.2 * s, ey - 2.6 * s);
      ctx.lineTo(ex + sx * 1.8 * s, ey - 3.4 * s);
      ctx.stroke();
    }
  }
}

function drawMouth(ctx, dx, my, s, kind) {
  ctx.strokeStyle = PAL.ink;
  ctx.lineWidth = 1.1 * s;
  ctx.lineCap = 'round';
  ctx.beginPath();
  if (kind === 'grin') {
    ctx.moveTo(dx - 2.6 * s, my - 0.6 * s);
    ctx.quadraticCurveTo(dx, my + 2.6 * s, dx + 2.6 * s, my - 0.6 * s);
    ctx.stroke();
    ctx.fillStyle = PAL.ink;
    ctx.beginPath();
    ctx.moveTo(dx - 2.4 * s, my - 0.4 * s);
    ctx.quadraticCurveTo(dx, my + 2.4 * s, dx + 2.4 * s, my - 0.4 * s);
    ctx.closePath(); ctx.fill();
    return;
  }
  if (kind === 'smile') { ctx.moveTo(dx - 2 * s, my); ctx.quadraticCurveTo(dx, my + 1.8 * s, dx + 2 * s, my); }
  else if (kind === 'frown') { ctx.moveTo(dx - 2 * s, my + 1.4 * s); ctx.quadraticCurveTo(dx, my - 0.8 * s, dx + 2 * s, my + 1.4 * s); }
  else if (kind === 'flat') { ctx.moveTo(dx - 1.8 * s, my + 0.4 * s); ctx.lineTo(dx + 1.8 * s, my + 0.4 * s); }
  else if (kind === 'o') { ctx.ellipse(dx, my + 0.6 * s, 1.2 * s, 1.4 * s, 0, 0, 7); }
  else if (kind === 'wobble') {
    ctx.moveTo(dx - 2.2 * s, my + 0.6 * s);
    ctx.quadraticCurveTo(dx - 1.1 * s, my - 0.8 * s, dx, my + 0.6 * s);
    ctx.quadraticCurveTo(dx + 1.1 * s, my + 2 * s, dx + 2.2 * s, my + 0.6 * s);
  } else { ctx.moveTo(dx - 1 * s, my + 0.3 * s); ctx.quadraticCurveTo(dx, my + 1.4 * s, dx + 1 * s, my + 0.3 * s); }
  ctx.stroke();
}

function drawItem(ctx, x, y, s, item, pose) {
  const yy = pose === 'eat' ? y + 8 : y;
  if (item === 'raw') {
    ctx.fillStyle = '#b8564f'; ctx.fillRect(x - 3, yy, 6, 4);
    ctx.fillStyle = '#d97b6f'; ctx.fillRect(x - 3, yy, 6, 2);
  } else if (item === 'meal') {
    ctx.fillStyle = PAL.white; ctx.fillRect(x - 4, yy + 2, 8, 2);
    ctx.fillStyle = PAL.warm; ctx.fillRect(x - 3, yy - 1, 6, 3);
    ctx.fillStyle = PAL.red; ctx.fillRect(x - 1, yy - 3, 3, 2);
  } else if (item === 'burnt') {
    ctx.fillStyle = PAL.white; ctx.fillRect(x - 4, yy + 2, 8, 2);
    ctx.fillStyle = '#3a3040'; ctx.fillRect(x - 3, yy - 1, 6, 3);
  } else if (item === 'can') {
    ctx.fillStyle = '#6f9bb5'; ctx.fillRect(x - 3, yy - 1, 6, 5);
    ctx.fillStyle = '#8fbdd6'; ctx.fillRect(x + 3, yy, 3, 1);
    ctx.fillRect(x - 4, yy - 3, 2, 3);
  } else if (item === 'toy') {
    ctx.fillStyle = PAL.fabricL;
    ctx.beginPath(); ctx.arc(x, yy + 1, 3, 0, 7); ctx.fill();
    ctx.fillStyle = PAL.white; ctx.fillRect(x - 3, yy, 6, 1);
  }
}

// ---------------------------------------------------------------- emotes

const ICONS = {
  heart: (ctx, x, y) => {
    ctx.fillStyle = PAL.red;
    ctx.beginPath(); ctx.arc(x - 1.6, y - 1, 1.8, 0, 7); ctx.arc(x + 1.6, y - 1, 1.8, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x - 3.3, y - 0.4); ctx.lineTo(x, y + 3.4); ctx.lineTo(x + 3.3, y - 0.4); ctx.fill();
  },
  zzz: (ctx, x, y, t) => {
    ctx.fillStyle = PAL.white;
    ctx.font = 'bold 7px monospace'; ctx.textAlign = 'center';
    ctx.fillText('z', x - 2, y + 2 + Math.sin(t * 3) * 0.6);
    ctx.font = 'bold 5px monospace';
    ctx.fillText('z', x + 3, y - 1);
  },
  food: (ctx, x, y) => {
    ctx.fillStyle = PAL.warm; ctx.fillRect(x - 3, y - 1, 6, 3);
    ctx.fillStyle = PAL.red; ctx.fillRect(x - 1, y - 3, 3, 2);
  },
  cook: (ctx, x, y, t) => {
    ctx.fillStyle = '#c9c2d8';
    for (let i = 0; i < 3; i++) {
      ctx.fillRect(x - 2 + i * 2, y - 2 - ((t * 6 + i * 2) % 5), 1, 2);
    }
    ctx.fillStyle = PAL.steel; ctx.fillRect(x - 4, y + 1, 8, 3);
  },
  note: (ctx, x, y) => {
    ctx.fillStyle = PAL.accent2 || '#7fd0c4';
    ctx.fillRect(x + 1, y - 4, 1.4, 6);
    ctx.beginPath(); ctx.ellipse(x, y + 2, 2, 1.5, -0.3, 0, 7); ctx.fill();
  },
  star: (ctx, x, y, t) => {
    ctx.save(); ctx.translate(x, y); ctx.rotate(t * 2);
    ctx.fillStyle = '#ffd76a';
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 1.7 : 4;
      const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
      ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath(); ctx.fill(); ctx.restore();
  },
  question: (ctx, x, y) => {
    ctx.fillStyle = PAL.white; ctx.font = 'bold 9px monospace'; ctx.textAlign = 'center';
    ctx.fillText('?', x, y + 3);
  },
  excl: (ctx, x, y) => {
    ctx.fillStyle = '#ffd76a'; ctx.font = 'bold 9px monospace'; ctx.textAlign = 'center';
    ctx.fillText('!', x, y + 3);
  },
  dots: (ctx, x, y, t) => {
    ctx.fillStyle = PAL.white;
    for (let i = 0; i < 3; i++) {
      const a = Math.sin(t * 4 - i) * 0.5 + 0.5;
      ctx.globalAlpha = 0.35 + a * 0.65;
      ctx.fillRect(x - 4 + i * 3.5, y, 2, 2);
    }
    ctx.globalAlpha = 1;
  },
  drop: (ctx, x, y) => {
    ctx.fillStyle = PAL.glass;
    ctx.beginPath(); ctx.arc(x, y + 1, 2.4, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x - 2, y); ctx.lineTo(x, y - 4); ctx.lineTo(x + 2, y); ctx.fill();
  },
  book: (ctx, x, y) => {
    ctx.fillStyle = '#5aa363'; ctx.fillRect(x - 4, y - 3, 8, 6);
    ctx.fillStyle = PAL.white; ctx.fillRect(x - 0.5, y - 3, 1, 6);
  },
  good: (ctx, x, y) => {
    ctx.strokeStyle = '#79c97f'; ctx.lineWidth = 1.6; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x - 3, y); ctx.lineTo(x - 1, y + 2.5); ctx.lineTo(x + 3.5, y - 3); ctx.stroke();
  },
  bad: (ctx, x, y) => {
    ctx.strokeStyle = '#e0675f'; ctx.lineWidth = 1.6; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x - 3, y - 3); ctx.lineTo(x + 3, y + 3);
    ctx.moveTo(x + 3, y - 3); ctx.lineTo(x - 3, y + 3); ctx.stroke();
  },
};

function drawEmote(ctx, x, y, emote, t) {
  const icon = ICONS[emote.name];
  if (!icon) return;
  const pop = Math.min(1, emote.t * 7);
  const fade = Math.min(1, (emote.dur - emote.t) * 4);
  ctx.globalAlpha = Math.max(0, Math.min(pop, fade));
  const by = y - 4 - pop * 4 + Math.sin(t * 2.5) * 0.8;

  ctx.fillStyle = 'rgba(28,23,44,0.88)';
  ctx.strokeStyle = 'rgba(120,110,160,0.6)';
  ctx.lineWidth = 1;
  roundRect(ctx, x - 9, by - 9, 18, 15, 5);
  ctx.fill(); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - 3, by + 5); ctx.lineTo(x, by + 9); ctx.lineTo(x + 3, by + 5);
  ctx.fillStyle = 'rgba(28,23,44,0.88)'; ctx.fill();

  icon(ctx, x, by - 1, t);
  ctx.globalAlpha = 1;
  ctx.textAlign = 'left';
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}


// ---- src/render/renderer.js ----
// Canvas renderer. Draws at a small fixed internal resolution and blits with
// nearest-neighbour scaling, which is what gives the chunky pixel look — all the
// art is vector-ish but the output grid is deliberately coarse.

const setIsoRotation = setRotation;

// A 12x13 floor is 400px wide in this projection. The old 384px backing
// canvas physically could not contain both side corners, regardless of CSS
// sizing, so they were clipped before the browser ever displayed the image.
const VIEW_W = 416, VIEW_H = 272;
const ORIGIN = { x: 216, y: 42 };
/** Thickness of the floor slab along the two open, camera-facing edges. Deep
 *  enough that a critter standing on the outermost row of tiles still has
 *  floor under it rather than the void beyond the room. */
const FLOOR_LIP = 14;

function createRenderer(canvas, world) {
  const ctx = canvas.getContext('2d');
  const overlays = { vision: false, path: false, grid: false };
  // The room editor drives these from outside; render() just reads them.
  // menuHighlightId is separate from selectedId — it's purely visual (which
  // object's footprint to outline while its click-menu is open), so opening
  // that menu in ordinary play can never accidentally arm edit-mode's own
  // move/rotate/remove behaviour, which selectedId still drives.
  const editor = { active: false, selectedId: null, ghost: null, menuHighlightId: null };
  // Habbo-style pointer feedback (which tile / which piece is under the
  // cursor) and the Sims-style plumbob target. Driven from outside by the
  // input layer; render() only reads them.
  const hud = { hoverGx: null, hoverGy: null, hoverObjId: null, activeId: null };
  let scale = 2;
  let t = 0;

  // ----------------------------------------------------------- fixed camera
  //
  // The room stays at its original viewpoint. Keeping this value immutable
  // lets the established projection helpers remain straightforward while
  // item rotation is handled independently by each object's facing state.
  const rotation = 0;

  function rot(gx, gy) {
    const { cols, rows } = world;
    switch (rotation & 3) {
      case 1: return [rows - gy, gx];
      case 2: return [cols - gx, rows - gy];
      case 3: return [gy, cols - gx];
      default: return [gx, gy];
    }
  }
  function unrot(gx, gy) {
    const { cols, rows } = world;
    switch (rotation & 3) {
      case 1: return [gy, rows - gx];
      case 2: return [cols - gx, rows - gy];
      case 3: return [cols - gy, gx];
      default: return [gx, gy];
    }
  }
  // Which two of the room's four edges are "far" (drawn as walls) at each
  // rotation — derived from where each edge's rotated depth (rx+ry) lands.
  const FAR_EDGES = { 0: ['N', 'W'], 1: ['S', 'W'], 2: ['S', 'E'], 3: ['N', 'E'] };
  // Flat furniture that's painted directly onto whichever wall it sits
  // against, rather than sitting free on the floor (contrast: a rug).
  const WALL_MOUNTED = new Set(['window', 'vent', 'mirror']);
  /** Which wall a wall-mounted piece is actually against, or null if it
   *  isn't against any of the four (e.g. dropped mid-room by the editor) —
   *  in which case it should just always draw rather than flicker in and
   *  out with rotation for no reason. */
  function wallEdgeOf(o) {
    if (o.gy === 0) return 'N';
    if (o.gy >= world.rows - 1) return 'S';
    if (o.gx === 0) return 'W';
    if (o.gx >= world.cols - 1) return 'E';
    return null;
  }
  // The 6-point clip/wall silhouette for each rotation: [gx, gy, level] where
  // level is 'R' (raised, top of wall) or 'L' (floor + lip). See the
  // derivation in the module notes — each row is [farCorner, edge1End,
  // edge1End, openCorner, edge2End, edge2End] going around the silhouette
  // once.
  //
  // Both ends of each open edge carry the lip. The corner where a wall meets
  // an open edge used to sit at bare floor level, and since the clip edge
  // between two vertices is a straight line, that gave the floor slab zero
  // thickness at that corner ramping to full thickness at the far one — so a
  // critter standing near that corner got its legs clipped off against the
  // void while one at the other end of the same wall was fine. A slab is the
  // same depth all the way along.
  function silhouette() {
    const C = world.cols, R = world.rows;
    const table = {
      0: [[0, 0, 'R'], [C, 0, 'R'], [C, 0, 'L'], [C, R, 'L'], [0, R, 'L'], [0, R, 'R']],
      1: [[0, R, 'R'], [C, R, 'R'], [C, R, 'L'], [C, 0, 'L'], [0, 0, 'L'], [0, 0, 'R']],
      2: [[C, R, 'R'], [0, R, 'R'], [0, R, 'L'], [0, 0, 'L'], [C, 0, 'L'], [C, 0, 'R']],
      3: [[C, 0, 'R'], [0, 0, 'R'], [0, 0, 'L'], [0, R, 'L'], [C, R, 'L'], [C, R, 'R']],
    };
    return table[rotation & 3];
  }

  canvas.width = VIEW_W;
  canvas.height = VIEW_H;

  function resize(container) {
    const pad = 16;
    const sx = (container.clientWidth - pad) / VIEW_W;
    const sy = (container.clientHeight - pad - 60) / VIEW_H;
    const fit = Math.min(sx, sy);
    // Retain crisp integer enlargement where it fits, but shrink smoothly on
    // narrow windows instead of forcing a 1x canvas wider than the stage.
    scale = fit >= 1 ? Math.floor(fit) : Math.max(0.5, fit);
    canvas.style.width = VIEW_W * scale + 'px';
    canvas.style.height = VIEW_H * scale + 'px';
  }

  const sx = (gx, gy) => { const [rx, ry] = rot(gx, gy); return toScreen(rx, ry).x + ORIGIN.x; };
  const sy = (gx, gy) => { const [rx, ry] = rot(gx, gy); return toScreen(rx, ry).y + ORIGIN.y; };

  /**
   * The room's full outer silhouette — the two raised walls plus the floor
   * slab under them. Everything is clipped to this before it's drawn, so no
   * sprite (a critter reaching for something, an emote bubble, a shadow) can
   * ever render past the edge of the room, even at the two open/camera-facing
   * sides where there is no wall to block the eye.
   */
  function clipToRoom() {
    // Has to clear FLOOR_LIP: this clip is what stops a sprite escaping the
    // room, but a critter standing on the outermost ring of tiles reaches
    // about 11px past its own tile's front edge, so a shallow lip sliced its
    // legs off — reading in game as the critter standing half off the map.
    const lip = FLOOR_LIP + 1;
    const pts = silhouette();
    ctx.beginPath();
    pts.forEach(([gx, gy, level], i) => {
      const x = sx(gx, gy);
      const y = sy(gx, gy) + (level === 'R' ? -WALL_H - 2 : level === 'L' ? lip : 0);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.clip();
  }

  // -------------------------------------------------------------- room

  /** The two grid points bounding edge `edge`'s i-th segment (i=0..len-1). */
  function edgeSegment(edge, i) {
    const C = world.cols, R = world.rows;
    if (edge === 'N') return [[i, 0], [i + 1, 0]];
    if (edge === 'S') return [[i, R], [i + 1, R]];
    if (edge === 'W') return [[0, i], [0, i + 1]];
    return [[C, i], [C, i + 1]];                          // 'E'
  }
  const edgeLength = (edge) => (edge === 'N' || edge === 'S' ? world.cols : world.rows);
  /** Which room a point on this edge belongs to, for per-segment theming. */
  function edgeRoom(edge, i) {
    if (edge === 'N') return world.roomAt(i, 0);
    if (edge === 'S') return world.roomAt(i, world.rows - 1);
    if (edge === 'W') return world.roomAt(0, i);
    return world.roomAt(world.cols - 1, i);                // 'E'
  }

  function drawWallEdge(edge) {
    const len = edgeLength(edge);
    for (let i = 0; i < len; i++) {
      const theme = world.themeFor(edgeRoom(edge, i));
      const [[ax, ay], [bx, by]] = edgeSegment(edge, i);
      const x0 = sx(ax, ay), y0 = sy(ax, ay);
      const x1 = sx(bx, by), y1 = sy(bx, by);
      ctx.fillStyle = shade(theme.wall, 12);
      ctx.beginPath();
      ctx.moveTo(x0, y0 - WALL_H); ctx.lineTo(x1, y1 - WALL_H);
      ctx.lineTo(x1, y1); ctx.lineTo(x0, y0);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = theme.wallDark;
      ctx.beginPath();
      ctx.moveTo(x0, y0 - 3); ctx.lineTo(x1, y1 - 3);
      ctx.lineTo(x1, y1); ctx.lineTo(x0, y0);
      ctx.closePath(); ctx.fill();
    }
  }

  function drawWalls() {
    const [edge1, edge2] = FAR_EDGES[rotation & 3];
    drawWallEdge(edge1);
    drawWallEdge(edge2);

    // top caps, so the two far walls read as having thickness
    const pts = silhouette();
    const capTheme = world.themeFor(edgeRoom(edge1, 0));
    ctx.fillStyle = shade(capTheme.wall, 24);
    for (const [a, b] of [[0, 1], [4, 5]]) {
      const [ax, ay] = pts[a], [bx, by] = pts[b];
      const x0 = sx(ax, ay), y0 = sy(ax, ay) - WALL_H;
      const x1 = sx(bx, by), y1 = sy(bx, by) - WALL_H;
      // a thin sliver nudged toward the camera for a beveled-top look
      const nx = (x0 + x1) / 2, ny = (y0 + y1) / 2;
      ctx.beginPath();
      ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
      ctx.lineTo(nx, ny - 2); ctx.closePath(); ctx.fill();
    }

    if (FAR_EDGES[rotation & 3].includes('N')) drawWindow();
    if (FAR_EDGES[rotation & 3].includes('W')) drawDoor();
  }

  /**
   * A rectangle painted flat onto one of the two back walls.
   * `side` 'right' runs along +gx (the gy=0 wall), 'left' along +gy.
   * `a`..`b` are grid coordinates along the wall, `lo`..`hi` heights off the floor.
   */
  function wallQuad(side, a, b, lo, hi, colour) {
    const p = side === 'right'
      ? (g, h) => [sx(g, 0), sy(g, 0) - h]
      : (g, h) => [sx(0, g), sy(0, g) - h];
    const c0 = p(a, hi), c1 = p(b, hi), c2 = p(b, lo), c3 = p(a, lo);
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.moveTo(c0[0], c0[1]); ctx.lineTo(c1[0], c1[1]);
    ctx.lineTo(c2[0], c2[1]); ctx.lineTo(c3[0], c3[1]);
    ctx.closePath(); ctx.fill();
  }

  /** Mix a hex colour toward a tint by a small fraction — used to lean the
   *  window's sky toward the season without fighting the day/night colours. */
  function tintTowards(hex, tint, amt) {
    const p = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
    const [r1, g1, b1] = p(hex), [r2, g2, b2] = p(tint);
    const mix = (a, b) => Math.round(a + (b - a) * amt);
    return `rgb(${mix(r1, r2)},${mix(g1, g2)},${mix(b1, b2)})`;
  }

  function drawWindow() {
    const win = world.first('window');
    if (!win) return;
    const g = win.gx, day = world.daylight();
    let sky = day > 0.55 ? '#8fc9e0' : day > 0.2 ? '#c98f7a' : PAL.night;
    if (day > 0.2) sky = tintTowards(sky, SEASON_TINTS[world.season()], 0.22);
    if (world.weather === 'cloudy' || world.weather === 'rain') sky = tintTowards(sky, '#8a8a94', 0.4);

    wallQuad('right', g + 0.02, g + 0.98, 8, 26, '#3b3653');
    wallQuad('right', g + 0.10, g + 0.90, 10, 24, sky);
    if (day > 0.55 && world.weather === 'clear') wallQuad('right', g + 0.10, g + 0.50, 10, 24, '#a8dcee');
    else if (day <= 0.2 && world.weather !== 'cloudy' && world.weather !== 'rain' && world.weather !== 'snow') {
      ctx.fillStyle = '#dfe6ff';
      for (let i = 0; i < 6; i++) {
        const t2 = 0.16 + (i * 0.13) % 0.7;
        const [px, py] = [sx(g + t2, 0), sy(g + t2, 0) - (12 + ((i * 5) % 11))];
        ctx.fillRect(px, py, 1, 1);
      }
    }
    if (world.weather === 'rain') {
      ctx.strokeStyle = 'rgba(190,210,230,0.6)'; ctx.lineWidth = 1;
      for (let i = 0; i < 10; i++) {
        const px = g + 0.14 + (i * 0.09) % 0.72;
        const drop = (t * 40 + i * 7) % 14;
        const [x0, y0] = [sx(px, 0), sy(px, 0) - 10 - drop];
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0 - 1, y0 + 3); ctx.stroke();
      }
    } else if (world.weather === 'snow') {
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      for (let i = 0; i < 8; i++) {
        const px = g + 0.14 + (i * 0.11) % 0.72;
        const flake = (t * 8 + i * 5) % 14;
        const [x0, y0] = [sx(px + Math.sin(t + i) * 0.02, 0), sy(px, 0) - 10 - flake];
        ctx.fillRect(x0, y0, 1, 1);
      }
    }
    wallQuad('right', g + 0.47, g + 0.53, 10, 24, '#4a4468');   // mullion
    wallQuad('right', g + 0.10, g + 0.90, 16.6, 17.4, '#4a4468');
    wallQuad('right', g - 0.02, g + 1.02, 6.6, 8, '#6d6889');   // sill
  }

  function drawDoor() {
    const g = DOOR_GY;
    const locked = world.doorLocked;
    wallQuad('left', g, g + 1.1, 0, WALL_H - 2, '#3d3652');
    if (locked) {
      wallQuad('left', g + 0.08, g + 1.02, 0, WALL_H - 5, PAL.wood);
      wallQuad('left', g + 0.16, g + 0.94, 3, WALL_H - 9, PAL.woodD);
      const [hx, hy] = [sx(0, g + 0.2), sy(0, g + 0.2) - 13];
      ctx.fillStyle = PAL.warm;
      ctx.fillRect(hx - 2, hy, 2, 2);
      // a small padlock glyph so "locked" reads at a glance
      const [lx, ly] = [sx(0, g + 0.55), sy(0, g + 0.55) - 18];
      ctx.strokeStyle = '#2b2740'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(lx, ly - 2, 1.6, Math.PI, 0); ctx.stroke();
      ctx.fillStyle = '#c9a84a';
      ctx.fillRect(lx - 2, ly - 2, 4, 3);
    } else {
      // door standing ajar: a shifted, narrower panel with a dark gap behind it
      wallQuad('left', g + 0.08, g + 0.80, 0, WALL_H - 5, PAL.wood);
      wallQuad('left', g + 0.14, g + 0.74, 3, WALL_H - 9, PAL.woodD);
      const [hx, hy] = [sx(0, g + 0.16), sy(0, g + 0.16) - 13];
      ctx.fillStyle = '#8fd08a';
      ctx.fillRect(hx - 2, hy, 2, 2);
    }
  }

  function drawFloor() {
    for (let gx = 0; gx < world.cols; gx++) {
      for (let gy = 0; gy < world.rows; gy++) {
        const theme = world.themeFor(world.roomAt(gx, gy));
        const x = sx(gx, gy), y = sy(gx, gy);
        tilePath(ctx, x, y);
        ctx.fillStyle = (gx + gy) % 2 ? theme.floorA : theme.floorB;
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.11)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    // A lip along the two camera-facing (open) edges so the floor has thickness.
    const lip = FLOOR_LIP;
    const far = FAR_EDGES[rotation & 3];
    const openEdges = ['N', 'S', 'W', 'E'].filter((e) => !far.includes(e));
    for (const edge of openEdges) {
      const len = edgeLength(edge);
      const shadeAmt = edge === 'N' || edge === 'S' ? -45 : -30;
      for (let i = 0; i < len; i++) {
        const theme = world.themeFor(edgeRoom(edge, i));
        ctx.fillStyle = shade(theme.floorA, shadeAmt);
        const [[ax, ay], [bx, by]] = edgeSegment(edge, i);
        const a = [sx(ax, ay), sy(ax, ay)];
        const b = [sx(bx, by), sy(bx, by)];
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
        ctx.lineTo(b[0], b[1] + lip); ctx.lineTo(a[0], a[1] + lip);
        ctx.closePath(); ctx.fill();
      }
    }
  }

  /** The screen-space quad of a w×h footprint's floor area. */
  function footprintQuad(gx, gy, w, h, inset = 0) {
    const i = inset;
    return [[gx + i, gy + i], [gx + w - i, gy + i],
      [gx + w - i, gy + h - i], [gx + i, gy + h - i]]
      .map(([a, b]) => [sx(a, b), sy(a, b)]);
  }
  function quadPath(quad) {
    ctx.beginPath();
    quad.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
  }

  /**
   * Habbo's tile marker: the floor tile under the pointer lights up, and
   * hovering a piece of furniture lights up its whole footprint instead of a
   * single tile. Drawn on the floor, under everything else, so furniture
   * still sits on top of its own highlight.
   */
  function drawTileHover() {
    if (editor.ghost) return;               // the placement ghost owns the cursor in build mode
    // Only bare floor gets the marker painted onto the ground. A hovered
    // piece of furniture would just cover its own highlight, so that case is
    // outlined over the top instead — see drawOverlays.
    if (hud.hoverObjId != null) return;
    if (hud.hoverGx == null || !world.inBounds(hud.hoverGx, hud.hoverGy)) return;
    ctx.save();
    quadPath(footprintQuad(hud.hoverGx, hud.hoverGy, 1, 1));
    ctx.fillStyle = 'rgba(255,255,255,0.20)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  /**
   * A soft contact shadow on the floor under every solid piece. Painted flat
   * on the ground plane in one pass before the furniture itself, so it needs
   * no depth sorting — and it's what stops everything looking like it's
   * hovering a few pixels above the tiles.
   */
  function drawContactShadows() {
    ctx.save();
    ctx.fillStyle = 'rgba(24,18,38,0.18)';
    for (const o of world.objects) {
      if (o.def.flat) continue;
      const gx = o.def.mobile ? o.fx : o.gx, gy = o.def.mobile ? o.fy : o.gy;
      quadPath(footprintQuad(gx, gy, o.w, o.h, 0.12));
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * The Sims' plumbob, floating over whichever critter you have selected —
   * it doubles as the "who am I looking at" marker the roster tabs otherwise
   * only tell you in text, and its colour reads the same way it does there:
   * green when they're doing well, sinking through amber to red as mood
   * drops. Drawn after the lighting pass so it stays legible at night.
   */
  function drawPlumbob(critters) {
    const c = critters.find((k) => k.id === hud.activeId && !k.away && k._screen);
    if (!c) return;
    const v = c.emotion?.valence ?? 0;                        // -1 unhappy .. +1 happy
    const hue = 10 + Math.max(0, Math.min(1, (v + 1) / 2)) * 105;   // red -> green
    const bob = Math.sin(t * 2.2) * 1.2;
    const x = c._screen.x;
    const y = c._screen.y - 21 * (c.stage?.scale ?? 1) + bob;
    // A slow spin, faked by squeezing the diamond's half-width. It keeps a
    // floor so the crystal never turns fully edge-on and vanishes.
    const wob = Math.abs(Math.cos(t * 1.6));
    const hw = 2 + 3 * wob, hh = 6;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, y - hh); ctx.lineTo(x + hw, y);
    ctx.lineTo(x, y + hh); ctx.lineTo(x - hw, y);
    ctx.closePath();
    ctx.fillStyle = `hsl(${hue} 85% 52%)`;
    ctx.fill();
    // lit facet on one side + a soft glow on the tile below
    ctx.beginPath();
    ctx.moveTo(x, y - hh); ctx.lineTo(x + hw, y); ctx.lineTo(x, y + hh);
    ctx.closePath();
    ctx.fillStyle = `hsl(${hue} 90% 68%)`;
    ctx.fill();
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = `hsl(${hue} 90% 80%)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y - hh); ctx.lineTo(x + hw, y);
    ctx.lineTo(x, y + hh); ctx.lineTo(x - hw, y);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  // -------------------------------------------------------------- entities

  /** Draw one furniture piece, honouring its stored flip (the editor's crude
   *  "rotate" for anything that doesn't have real per-facing art). */
  function drawFurniture(o, ox, oy) {
    if (o.state.flip) {
      ctx.save();
      ctx.translate(ox, 0); ctx.scale(-1, 1); ctx.translate(-ox, 0);
      o.def.draw(ctx, ox, oy, o, t);
      ctx.restore();
    } else {
      o.def.draw(ctx, ox, oy, o, t);
    }
  }

  /** Nearest-camera ground level of a footprint. This is also the pixel row
   *  where isoBox and Kenney sprites anchor their base, so rectangular pieces
   *  no longer borrow an arbitrary centre depth that disagrees with the art. */
  function footprintFrontDepth(gx, gy, w, h) {
    let front = -Infinity;
    for (const [x, y] of [[gx, gy], [gx + w, gy], [gx, gy + h], [gx + w, gy + h]]) {
      const [rx, ry] = rot(x, y);
      front = Math.max(front, rx + ry);
    }
    return front;
  }

  function depthOfObject(o, critters = null) {
    const gx = o.def.mobile ? o.fx : o.gx;
    const gy = o.def.mobile ? o.fy : o.gy;
    // Thin wall fragments are filed in a grid tile for collision/selection,
    // but visually live on one edge of it. Sort the drawn geometry, not the
    // full filing tile, so a translucent panel changes sides at its edge.
    const w = o.def.depthW ?? o.w;
    const h = o.def.depthH ?? o.h;
    let depth = footprintFrontDepth(gx, gy, w, h);

    // A critter actively sitting/lying/soaking on occupiable furniture must
    // appear on its surface. The sprite is not split into seat/back layers,
    // so place the complete item immediately before the occupant; this is
    // preferable to the old result where the sofa painted over the critter.
    if (critters) {
      for (const c of critters) {
        if (c.moving || c.gx < o.gx || c.gx >= o.gx + o.w || c.gy < o.gy || c.gy >= o.gy + o.h) continue;
        const activelyUsing = c.task?.cmd?.t === 'use' && c.task.cmd.obj === o;
        const occupiable = o.def.occupiable || o.def.sit || o.def.lie;
        if (activelyUsing || occupiable) depth = Math.min(depth, depthOfCritter(c) - 0.01);
      }
    }
    return depth;
  }

  /** Sort on the critter's visible feet, not merely its tile centre. The art
   *  extends below that centre, and ignoring that rendered ground contact is
   *  what let nearby furniture stay above a critter for part of a move. */
  function depthOfCritter(c) {
    // drawCritter receives the tile's north corner and performs its own
    // half-tile descent to the body/feet. Start depth at that same corner;
    // adding another +0.5,+0.5 here would reproduce the old (+1,+1) visual
    // displacement in the painter even after the sprite anchor was fixed.
    const [rx, ry] = rot(c.px, c.py);
    const scale = c.stage?.scale ?? 1;
    // Mirrors drawCritter's neutral ground contact: body origin (now the
    // tile's true centre — see the FEET_DROP correction in critter.js) plus
    // the foot radius past it. Deliberately exclude walk bob/breathing so the
    // layer does not flicker on every animation frame.
    const footPixels = 8 + 1.7 * scale;
    return rx + ry + footPixels / HH + 0.01; // living subject wins exact ties
  }

  function drawEntities(critters) {
    const present = critters.filter((c) => !c.away);
    for (const c of critters) if (c.away) c._screen = null;

    const list = [];
    for (const o of world.objects) {
      if (o.def.flat) continue;
      const ox = o.def.mobile ? o.fx : o.gx, oy = o.def.mobile ? o.fy : o.gy;
      list.push({
        d: depthOfObject(o, present),
        draw: () => drawFurniture(o, sx(ox, oy), sy(ox, oy)),
      });
    }
    for (const c of present) {
      list.push({
        // This key changes continuously with px/py, so crossing a depth level
        // while walking changes the layer at the actual feet crossing rather
        // than when Math.round() happens to select a different grid cell.
        d: depthOfCritter(c),
        draw: () => {
          // drawCritter's x/y contract is the NORTH corner of the occupied
          // tile. It adds HH internally to place the body over the diamond's
          // centre. Passing the centre here as well added HH twice, which is
          // exactly one (+1,+1) projected-grid offset toward the south.
          const x = sx(c.px, c.py);
          // Occupied furniture raises the body to its seat/sleeping surface;
          // ordinary items can never produce this overlap through pathing.
          const rest = world.objectAt(Math.round(c.px), Math.round(c.py));
          const onIt = rest && (rest.def.sit || rest.def.lie)
            && (c.pose === 'sit' || c.pose === 'lie' || c.pose === 'read' || c.asleep);
          const seat = onIt ? (rest.def.seatH ?? Math.round(rest.def.tall * 0.5)) : 0;
          const y = sy(c.px, c.py) - seat;
          drawCritter(ctx, x, y, c, t);
          // Picking, emotes and the plumbob reference the visible body centre,
          // not drawCritter's north-corner input anchor.
          c._screen = {
            x: sx(c.px + 0.5, c.py + 0.5),
            y: sy(c.px + 0.5, c.py + 0.5) - seat,
          };
        },
      });
    }
    list.sort((a, b) => a.d - b.d);
    for (const e of list) e.draw();
  }

  function drawMesses() {
    for (const m of world.messes) {
      const x = sx(m.gx + 0.5, m.gy + 0.5), y = sy(m.gx + 0.5, m.gy + 0.5);
      const col = m.kind === 'crumbs' ? '#6b4a2c' : m.kind === 'puddle' ? '#4d6a80' : '#4a3b2e';
      ctx.fillStyle = col;
      ctx.globalAlpha = 0.35 + m.amount * 0.55;
      for (const [ox, oy, r] of m.blobs) {
        ctx.beginPath();
        ctx.ellipse(x + ox, y + oy, r * (0.5 + m.amount), r * 0.5 * (0.5 + m.amount), 0, 0, 7);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  // -------------------------------------------------------------- light

  function drawLighting() {
    const l = world.lightLevel();
    if (l >= 0.88) return;
    const k = 1 - l;
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    const r = Math.round(255 - k * 130), g = Math.round(255 - k * 120), b = Math.round(255 - k * 55);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.restore();

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const o of world.objects) {
      if (!o.state.on || !o.def.emitsWhenOn) continue;
      const x = sx(o.gx + 0.5, o.gy + 0.5), y = sy(o.gx + 0.5, o.gy + 0.5) - 10;
      const rad = o.type === 'lamp' ? 58 : 42;
      const grad = ctx.createRadialGradient(x, y, 2, x, y, rad);
      const warm = o.type === 'lamp' ? '255,215,140' : '150,215,240';
      grad.addColorStop(0, `rgba(${warm},${0.30 * k})`);
      grad.addColorStop(1, `rgba(${warm},0)`);
      ctx.fillStyle = grad;
      ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    ctx.restore();
  }

  // -------------------------------------------------------------- overlays

  function drawOverlays(critters) {
    if (overlays.grid) {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '5px monospace';
      for (let gx = 0; gx < world.cols; gx++) {
        for (let gy = 0; gy < world.rows; gy++) {
          tilePath(ctx, sx(gx, gy), sy(gx, gy));
          const blocked = !world.isWalkable(gx, gy);
          const destinationOnly = !blocked && world._noTransit.has(gx + ',' + gy);
          ctx.fillStyle = blocked
            ? 'rgba(224,80,78,0.34)'
            : destinationOnly ? 'rgba(242,180,70,0.27)' : 'rgba(70,205,156,0.10)';
          ctx.fill();
          ctx.strokeStyle = blocked
            ? 'rgba(255,120,112,0.86)'
            : destinationOnly ? 'rgba(255,203,105,0.72)' : 'rgba(185,255,224,0.28)';
          ctx.lineWidth = blocked ? 1.2 : 0.65;
          ctx.stroke();
          ctx.fillStyle = blocked ? 'rgba(255,226,220,0.92)' : 'rgba(236,255,248,0.72)';
          ctx.fillText(`${gx},${gy}`, sx(gx + 0.5, gy + 0.5), sy(gx + 0.5, gy + 0.5) + 1);
        }
      }

      // Draw the actual blocked boundaries, since partition walls and closed
      // gates block an edge rather than consuming either neighbouring cell.
      ctx.strokeStyle = 'rgba(255,72,93,0.98)';
      ctx.lineWidth = 2.2;
      for (let gx = 0; gx < world.cols; gx++) {
        for (let gy = 0; gy < world.rows; gy++) {
          if (gx + 1 < world.cols && world.edgeBlocked(gx, gy, gx + 1, gy)) {
            ctx.beginPath();
            ctx.moveTo(sx(gx + 1, gy), sy(gx + 1, gy));
            ctx.lineTo(sx(gx + 1, gy + 1), sy(gx + 1, gy + 1));
            ctx.stroke();
          }
          if (gy + 1 < world.rows && world.edgeBlocked(gx, gy, gx, gy + 1)) {
            ctx.beginPath();
            ctx.moveTo(sx(gx, gy + 1), sy(gx, gy + 1));
            ctx.lineTo(sx(gx + 1, gy + 1), sy(gx + 1, gy + 1));
            ctx.stroke();
          }
        }
      }

      // The grid edge is also an impassable boundary even where no raised
      // wall happens to be painted. Showing it closes the collision map and
      // makes it obvious that A* never owns a node outside this diamond.
      quadPath(footprintQuad(0, 0, world.cols, world.rows));
      ctx.strokeStyle = 'rgba(172,55,77,0.95)';
      ctx.lineWidth = 2.2;
      ctx.stroke();

      // Draw the active route as actual cells, including the already-traversed
      // portion still retained by the runner. Future cells are purple, the
      // next reservation is yellow, and small numbers show traversal order.
      const active = critters.find((k) => k.id === hud.activeId) || critters[0];
      const route = active?.task?.path;
      if (active && !active.away && route?.length) {
        const routeStart = active.task.pathFrom || [active.gx, active.gy];
        ctx.beginPath();
        ctx.moveTo(sx(routeStart[0] + 0.5, routeStart[1] + 0.5), sy(routeStart[0] + 0.5, routeStart[1] + 0.5));
        for (const [gx, gy] of route) {
          ctx.lineTo(sx(gx + 0.5, gy + 0.5), sy(gx + 0.5, gy + 0.5));
        }
        ctx.strokeStyle = 'rgba(177,143,255,0.88)';
        ctx.lineWidth = 1.4;
        ctx.stroke();

        for (let i = 0; i < route.length; i++) {
          const [gx, gy] = route[i];
          const traversed = i < active.task.pathIdx;
          const next = i === active.task.pathIdx;
          tilePath(ctx, sx(gx, gy), sy(gx, gy));
          ctx.fillStyle = next
            ? 'rgba(255,236,92,0.48)'
            : traversed ? 'rgba(177,143,255,0.10)' : 'rgba(177,143,255,0.28)';
          ctx.fill();
          ctx.strokeStyle = next
            ? 'rgba(255,236,92,1)' : traversed ? 'rgba(177,143,255,0.32)' : 'rgba(198,174,255,0.82)';
          ctx.lineWidth = next ? 2 : 1;
          ctx.stroke();
          ctx.fillStyle = next ? '#fff6a8' : traversed ? 'rgba(230,218,255,0.4)' : '#e7dcff';
          ctx.fillText(String(i + 1), sx(gx + 0.5, gy + 0.5), sy(gx + 0.5, gy + 0.5) - 3);
        }
      }

      // Every critter owns its last fully reached grid cell. The active one
      // is cyan; peers are magenta. While walking, the smaller dot is its
      // exact continuous foot position between the occupied and reserved cell.
      for (const cr of critters) {
        if (cr.away) continue;
        const isActive = cr === active;
        tilePath(ctx, sx(cr.gx, cr.gy), sy(cr.gx, cr.gy));
        ctx.fillStyle = isActive ? 'rgba(71,220,255,0.32)' : 'rgba(242,132,214,0.28)';
        ctx.fill();
        ctx.strokeStyle = isActive ? 'rgba(71,220,255,1)' : 'rgba(247,155,224,0.95)';
        ctx.lineWidth = isActive ? 2 : 1.5;
        ctx.stroke();
        ctx.fillStyle = isActive ? '#c9f7ff' : '#ffd6f5';
        ctx.fillText(isActive ? 'C' : `C${cr.id}`, sx(cr.gx + 0.5, cr.gy + 0.5), sy(cr.gx + 0.5, cr.gy + 0.5) + 5);
      }

      // Three reference points per critter, so a foot/cell mismatch shows up
      // directly instead of needing to eyeball it: red is the tile's own true
      // centre (independent of the critter entirely — sx/sy(px,py)+HH, same
      // as the tile diamonds above); green is drawCritter's body-origin
      // anchor; blue is that body's own feet. Green and blue coinciding with
      // red is the FEET_DROP fix in critter.js doing its job — the point of
      // this overlay is to make that checkable at a glance, live, rather
      // than asserted from code alone.
      const dot = (px, py, color) => {
        ctx.beginPath(); ctx.arc(px, py, 2, 0, Math.PI * 2);
        ctx.fillStyle = color; ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 0.6; ctx.stroke();
      };
      for (const cr of critters) {
        if (cr.away) continue;
        const s = cr.stage.scale;
        let lift = 0, squash = 1;
        if (cr.pose === 'walk') { const wp = Math.sin(cr.bob); lift = Math.abs(wp) * 1.6; squash = 1 + wp * 0.03; }
        if (cr.pose === 'sit' || cr.pose === 'read') { lift = -3; squash = 0.86; }
        if (cr.pose === 'lie') { lift = -5; squash = 0.62; }
        const anchorX = sx(cr.px, cr.py), anchorY = sy(cr.px, cr.py);
        const cellCenterY = anchorY + HH; // true tile centre, per tilePath's own geometry above
        const bodyY = anchorY + 8 - 10.5 * s * 0.52 - lift; // drawCritter's (bx,by) post-fix (breathe omitted, sub-pixel)
        const feetY = bodyY + 10.5 * s * squash * 0.52;
        dot(anchorX, cellCenterY, '#ff2d55');
        dot(anchorX, bodyY, '#39ff14');
        dot(anchorX, feetY, '#2d8bff');
      }
      ctx.restore();
    }
    const c = critters.find((k) => k.id === hud.activeId) || critters[0];
    if (overlays.vision && c?.percept) {
      ctx.save();
      ctx.globalAlpha = 0.13;
      ctx.fillStyle = '#ffe9a8';
      for (let gx = 0; gx < world.cols; gx++) {
        for (let gy = 0; gy < world.rows; gy++) {
          if (!inView(c, gx, gy)) continue;
          tilePath(ctx, sx(gx, gy), sy(gx, gy));
          ctx.fill();
        }
      }
      ctx.restore();
      ctx.strokeStyle = 'rgba(255,220,140,0.75)';
      ctx.lineWidth = 1;
      for (const v of c.percept.visible) {
        const cc = world.center(v.obj);
        ctx.globalAlpha = 0.25 + v.novelty * 0.6;
        ctx.beginPath();
        ctx.moveTo(sx(c.px + 0.5, c.py + 0.5), sy(c.px + 0.5, c.py + 0.5) - 8);
        ctx.lineTo(sx(cc.gx, cc.gy), sy(cc.gx, cc.gy) - 6);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    if (overlays.path && c?.task?.path) {
      ctx.fillStyle = 'rgba(127,208,196,0.85)';
      for (let i = c.task.pathIdx; i < c.task.path.length; i++) {
        const [px, py] = c.task.path[i];
        ctx.fillRect(sx(px + 0.5, py + 0.5) - 1.5, sy(px + 0.5, py + 0.5) + 6, 3, 3);
      }
    }
    // The actual tile(s) something refers to — a cell outline, not a circle
    // that only ever approximately points at a spot. `cells` is [gx,gy]
    // pairs; works for a single called-to tile or a whole footprint alike.
    function outlineCells(cells, color, lineWidth = 1.5) {
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      for (const [gx, gy] of cells) {
        tilePath(ctx, sx(gx, gy), sy(gx, gy));
        ctx.stroke();
      }
    }
    function footprintCells(o) {
      const cells = [];
      for (let x = 0; x < o.w; x++) for (let y = 0; y < o.h; y++) cells.push([o.gx + x, o.gy + y]);
      return cells;
    }

    for (const cr of critters) {
      if (!cr.signals.callCell) continue;
      const [px, py] = cr.signals.callCell;
      const pulse = 0.6 + 0.3 * Math.sin(t * 6);
      outlineCells([[px, py]], `rgba(242,180,107,${pulse})`, 2);
    }

    // Hovered furniture outlines over the top — a piece tall enough to stand
    // on its own tile hides any highlight painted on the floor beneath it.
    if (hud.hoverObjId != null && !editor.ghost
      && hud.hoverObjId !== editor.selectedId && hud.hoverObjId !== editor.menuHighlightId) {
      const o = world.byId(hud.hoverObjId);
      if (o) outlineCells(footprintCells(o), 'rgba(255,255,255,0.8)', 1);
    }
    // ---- room editor: selection outline + placement ghost
    if (editor.selectedId != null) {
      const o = world.byId(editor.selectedId);
      if (o) outlineCells(footprintCells(o), `rgba(242,180,107,${0.6 + 0.3 * Math.sin(t * 6)})`, 2);
    }
    // Regular (non-edit) mode: which cells the click-menu's furniture
    // actually occupies, while that menu is open.
    if (editor.menuHighlightId != null && editor.menuHighlightId !== editor.selectedId) {
      const o = world.byId(editor.menuHighlightId);
      if (o) outlineCells(footprintCells(o), 'rgba(127,208,196,0.85)', 2);
    }
    if (editor.ghost) {
      const { gx, gy, w, h, valid } = editor.ghost;
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = valid ? 'rgba(127,208,196,0.9)' : 'rgba(224,103,95,0.9)';
      for (let x = 0; x < w; x++) {
        for (let y = 0; y < h; y++) {
          tilePath(ctx, sx(gx + x, gy + y), sy(gx + x, gy + y));
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    }
  }

  function inView(c, gx, gy) {
    const dx = gx + 0.5 - (c.px + 0.5), dy = gy + 0.5 - (c.py + 0.5);
    const d = Math.hypot(dx, dy);
    if (d > 7.5) return false;
    if (d < 1.6) return true;
    const [fx, fy] = [[1, 0], [0, 1], [-1, 0], [0, -1]][c.dir];
    if ((dx * fx + dy * fy) / d < Math.cos((62 * Math.PI) / 180)) return false;
    return world.lineOfSight(Math.round(c.px), Math.round(c.py), gx, gy);
  }

  // -------------------------------------------------------------- public

  return {
    ctx, overlays, editor, hud, resize,
    /** Ground-contact depth numbers used by the live painter, exposed for
     *  deterministic movement/layering regression checks. */
    debugDepth(critters) {
      const present = critters.filter((c) => !c.away);
      return {
        critters: present.map((c) => ({ id: c.id, name: c.name, gx: c.gx, gy: c.gy, px: c.px, py: c.py, d: depthOfCritter(c) })),
        objects: world.objects.filter((o) => !o.def.flat).map((o) => ({
          id: o.id, type: o.type, gx: o.gx, gy: o.gy,
          d: depthOfObject(o, present),
          baseD: depthOfObject(o),
        })),
      };
    },
    get rotation() { return rotation; },
    get scale() { return scale; },

    render(critters, dt) {
      const list = Array.isArray(critters) ? critters : [critters];
      t += dt;
      setIsoRotation(rotation);   // sync iso.js's furniture-shape basis to this frame's camera angle
      setSpriteRotation(rotation);
      ctx.clearRect(0, 0, VIEW_W, VIEW_H);
      ctx.fillStyle = '#151223';
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);

      ctx.save();
      clipToRoom();

      drawWalls();
      drawFloor();
      drawTileHover();
      drawContactShadows();
      const far = FAR_EDGES[rotation & 3];
      for (const o of world.objects) {
        if (!o.def.flat) continue;
        // Window/vent/mirror are painted onto a specific wall — only draw
        // them while that wall is actually one of the two currently solid;
        // otherwise they'd float in mid-air over what's now an open side.
        const edge = WALL_MOUNTED.has(o.type) ? wallEdgeOf(o) : null;
        if (edge && !far.includes(edge)) continue;
        drawFurniture(o, sx(o.gx, o.gy), sy(o.gx, o.gy));
      }
      drawMesses();
      drawEntities(list);
      drawLighting();
      drawOverlays(list);

      for (const c of list) {
        if (c.emote && c._screen) {
          drawEmote(ctx, c._screen.x, c._screen.y - 15 * c.stage.scale, c.emote, t);
        }
      }
      drawPlumbob(list);
      ctx.restore();   // lift the room clip
    },

    /** Screen pixels -> grid coords (float), for the room editor's drag. */
    screenToGrid(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      const px = (clientX - rect.left) / scale, py = (clientY - rect.top) / scale;
      const g = toGrid(px - ORIGIN.x, py - ORIGIN.y);
      const [gx, gy] = unrot(g.gx, g.gy);
      return { gx, gy };
    },

    /** Canvas-relative pixels -> what the user clicked on. */
    pick(clientX, clientY, critters) {
      const list = Array.isArray(critters) ? critters : [critters];
      const rect = canvas.getBoundingClientRect();
      const px = (clientX - rect.left) / scale;
      const py = (clientY - rect.top) / scale;

      for (const c of list) {
        if (!c._screen) continue;
        const d = Math.hypot(px - c._screen.x, py - c._screen.y + 6);
        if (d < 12) return { kind: 'critter', critter: c };
      }
      // Tall furniture is picked by its screen box, floor by projection.
      for (const o of [...world.objects].sort((a, b) => depthOfObject(b) - depthOfObject(a))) {
        if (o.def.flat || !o.def.tall) continue;
        // A partition wall is drawn see-through on purpose, and there is
        // nothing you can do to one — so it shouldn't absorb clicks either.
        // Its panel covers the tile behind it, which made that whole strip of
        // floor unusable: every click there landed on the wall and got the
        // "load-bearing" refusal instead of the floor. Structural pieces that
        // DO have actions (the gates) still take their clicks normally.
        if (o.def.structural && !o.def.acts?.length) continue;
        const ox = sx(o.gx + o.w / 2, o.gy + o.h / 2), oy = sy(o.gx + o.w / 2, o.gy + o.h / 2);
        // The box has to stop at the piece's own footprint, not a whole tile
        // past it. A w×h footprint is (w+h)*HW wide and its front corner sits
        // (w+h)/2*HH below its centre; the old bounds used TILE_W*w and
        // oy+TILE_H, which for anything against a wall reached a full tile
        // forward and swallowed clicks meant for the open floor in front of
        // it — the reason the strip beside the partition walls felt dead.
        const halfW = (o.w + o.h) * HW * 0.5;
        const front = (o.w + o.h) * 0.5 * HH;
        // The bed and sofa draw a pre-rendered sprite taller than their own
        // def.tall (the bed's is more than double), so the click box used to
        // cut off partway down the headboard/back. Flooring EVERY object's
        // margin to at least 30px "fixed" that but way overshot for anything
        // small — a chair's box nearly quadrupled for no reason — and a box
        // that tall on a piece sitting near a room boundary reached clear
        // into the next room's furniture on the same screen-diagonal,
        // stealing its clicks. Widen only the two pieces that actually need
        // it; leave everything else at its own real height.
        const SPRITE_TALLER_THAN_DEF = { bed: 34, sofa: 34 };
        const topMargin = (SPRITE_TALLER_THAN_DEF[o.type] ?? o.def.tall) + 4;
        if (px > ox - halfW && px < ox + halfW
          && py > oy - topMargin && py < oy + front) return { kind: 'object', obj: o };
      }
      const g = toGrid(px - ORIGIN.x, py - ORIGIN.y);
      const [ugx, ugy] = unrot(g.gx, g.gy);
      const gx = Math.floor(ugx), gy = Math.floor(ugy);
      if (!world.inBounds(gx, gy)) return { kind: 'none' };
      const o = world.selectableAt(gx, gy);
      if (o) return { kind: 'object', obj: o };
      return { kind: 'floor', cell: [gx, gy] };
    },
  };
}

/** Small standalone portrait used by the side panel. */
function drawPortrait(canvas, critter, t) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#171426';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  const stash = { dir: critter.dir, pose: critter.pose };
  critter.dir = 1;
  drawCritter(ctx, canvas.width / 2, canvas.height / 2 + 12, critter, t, { portrait: true, scale: 1.5 });
  critter.dir = stash.dir;
  ctx.restore();
}


// ---- src/ui/hud.js ----
// All DOM updating lives here. The simulation never touches the document.


const $ = (sel) => document.querySelector(sel);

function createHud(world) {
  let critter = null;
  let editingName = false;

  // ---- need bars, built once. Boredom rides along as an extra row — it's a
  // derived stat rather than a homeostatic need, but reads the same way.
  const needsHost = $('#needs');
  const bars = {};
  for (const n of NEEDS) {
    const el = document.createElement('div');
    el.className = 'need';
    el.innerHTML = `<div class="lab"><span>${n.label}</span><span class="v">0%</span></div>
      <div class="bar"><i style="background:${n.colour}"></i></div>`;
    needsHost.appendChild(el);
    bars[n.key] = { el, fill: el.querySelector('i'), val: el.querySelector('.v') };
  }
  const boredomEl = document.createElement('div');
  boredomEl.className = 'need';
  boredomEl.innerHTML = `<div class="lab"><span>boredom</span><span class="v">0%</span></div>
    <div class="bar"><i style="background:#b98fe0"></i></div>`;
  needsHost.appendChild(boredomEl);
  const boredomBar = { fill: boredomEl.querySelector('i'), val: boredomEl.querySelector('.v') };

  // ---- skill bars, built once
  const SKILLS = [
    { key: 'cooking',    label: 'cooking',    colour: '#e0a05a' },
    { key: 'fitness',    label: 'fitness',    colour: '#79c97f' },
    { key: 'creativity', label: 'creativity', colour: '#7f8fd0' },
    { key: 'charisma',   label: 'charisma',   colour: '#e79bb0' },
  ];
  const skillsHost = $('#skills');
  const skillBars = {};
  for (const s of SKILLS) {
    const el = document.createElement('div');
    el.className = 'need';
    el.innerHTML = `<div class="lab"><span>${s.label}</span><span class="v">0%</span></div>
      <div class="bar"><i style="background:${s.colour}"></i></div>`;
    skillsHost.appendChild(el);
    skillBars[s.key] = { fill: el.querySelector('i'), val: el.querySelector('.v') };
  }

  const utilHost = $('#utils');
  const utilRows = new Map();

  const affectCtx = $('#affect').getContext('2d');
  const sensorCtx = $('#sensor').getContext('2d');
  $('#sv-dims').textContent = SENSE_LAYOUT.length + ' dims';

  let t = 0;

  function needBars() {
    for (const n of NEEDS) {
      const v = critter.needs.get(n.key);
      const b = bars[n.key];
      b.fill.style.width = (v * 100).toFixed(0) + '%';
      b.val.textContent = Math.round(v * 100) + '%';
      b.el.className = 'need' + (v < 0.18 ? ' crit' : v < 0.4 ? ' low' : '');
    }
    const bd = critter.boredom;
    boredomBar.fill.style.width = (bd * 100).toFixed(0) + '%';
    boredomBar.val.textContent = Math.round(bd * 100) + '%';
    boredomEl.className = 'need' + (bd > 0.75 ? ' crit' : bd > 0.5 ? ' low' : '');

    for (const s of SKILLS) {
      const v = critter.skill[s.key] || 0;
      const b = skillBars[s.key];
      b.fill.style.width = (v * 100).toFixed(0) + '%';
      b.val.textContent = Math.round(v * 100) + '%';
    }
  }

  function aspirationAndWhim() {
    const a = critter.aspiration;
    $('#aspiration').textContent = a.icon + ' ' + a.label + ' — ' + a.flavor;
    const w = critter.whim;
    $('#whim').textContent = w ? 'wants to: ' + w.icon + ' ' + w.label : '';
  }

  function affectPlot() {
    const c = affectCtx, W = 120;
    c.clearRect(0, 0, W, W);
    c.strokeStyle = '#2b2740'; c.lineWidth = 1;
    c.beginPath(); c.moveTo(W / 2, 4); c.lineTo(W / 2, W - 4); c.moveTo(4, W / 2); c.lineTo(W - 4, W / 2); c.stroke();
    c.strokeStyle = '#232032';
    c.beginPath(); c.arc(W / 2, W / 2, W / 2 - 6, 0, 7); c.stroke();
    c.fillStyle = '#4a4468';
    c.font = '8px monospace'; c.textAlign = 'center';
    c.fillText('wired', W / 2, 10); c.fillText('dozy', W / 2, W - 3);

    const x = W / 2 + critter.emotion.valence * (W / 2 - 8);
    const y = W / 2 - critter.emotion.arousal * (W / 2 - 8);
    const pulse = 3 + Math.sin(t * 3) * 0.7;
    c.fillStyle = 'rgba(242,180,107,0.22)';
    c.beginPath(); c.arc(x, y, pulse + 5, 0, 7); c.fill();
    c.fillStyle = '#f2b46b';
    c.beginPath(); c.arc(x, y, pulse, 0, 7); c.fill();
  }

  function sensorPlot() {
    const c = sensorCtx, W = 240, H = 80;
    const vec = critter.senseVec;
    c.clearRect(0, 0, W, H);
    const cols = 30;
    const cw = W / cols, rows = Math.ceil(vec.length / cols), ch = H / rows;
    for (let i = 0; i < vec.length; i++) {
      const cx = (i % cols) * cw, cy = Math.floor(i / cols) * ch;
      const v = Math.max(0, Math.min(1, vec[i]));
      c.fillStyle = `rgba(127,208,196,${0.08 + v * 0.92})`;
      c.fillRect(cx + 0.5, cy + 0.5, cw - 1, ch - 1);
    }
  }

  function utilities() {
    const ranking = critter.brain.ranking;
    if (!ranking.length) return;
    const max = Math.max(0.001, ranking[0].score);
    const current = critter.task?.action.id;
    const seen = new Set();
    for (const r of ranking.slice(0, 9)) {
      seen.add(r.action.id);
      let row = utilRows.get(r.action.id);
      if (!row) {
        const el = document.createElement('div');
        el.className = 'util';
        el.innerHTML = `<div class="lab"><span class="n"></span><span class="v"></span></div>
          <div class="bar"><i></i></div>`;
        utilHost.appendChild(el);
        row = { el, name: el.querySelector('.n'), val: el.querySelector('.v'), fill: el.querySelector('i') };
        utilRows.set(r.action.id, row);
      }
      row.name.textContent = r.action.id;
      row.val.textContent = r.score.toFixed(2);
      row.fill.style.width = Math.max(0, (r.score / max) * 100).toFixed(0) + '%';
      row.el.className = 'util' + (r.action.id === current ? ' pick' : '');
      utilHost.appendChild(row.el);          // re-append = re-sort by rank
    }
    for (const [id, row] of utilRows) if (!seen.has(id)) row.el.remove(), utilRows.delete(id);
  }

  function memoryList() {
    const known = [...critter.memory.objects.entries()];
    $('#memlist').innerHTML = known.length
      ? known.map(([id, m]) => {
        const fam = Math.round(m.familiarity * 100);
        const a = m.assoc > 0.05 ? ' <span style="color:#79c97f">+</span>'
          : m.assoc < -0.05 ? ' <span style="color:#e0675f">−</span>' : '';
        return `${m.type} <span style="opacity:.6">${fam}%</span>${a}`;
      }).join('<br>')
      : 'nothing yet — it has to look around first';
  }

  function thoughts() {
    $('#thoughts').innerHTML = critter.thoughts.slice(0, 6)
      .map((s) => `<div>${s}</div>`).join('');
  }

  function moodlets() {
    const list = critter.moodlets.list();
    $('#moodlets').innerHTML = list.length
      ? list.map((m) => `<span class="moodlet ${m.tone}"><span class="ic">${m.icon}</span>${m.label}
          <span class="hrs">${Math.ceil(m.hoursLeft)}h</span></span>`).join('')
      : '<span class="dim">none right now</span>';
  }

  function friendships(critters) {
    const card = $('#friends-card');
    const others = (critters || []).filter((c) => c !== critter);
    card.hidden = others.length === 0;
    if (!others.length) return;
    $('#friends').innerHTML = others.map((p) => {
      const v = Math.round(critter.relationshipWith(p.id) * 100);
      return `<div class="friend-row"><span class="name">${p.name}</span>
        <span class="bar"><i style="width:${v}%;background:#e79bb0"></i></span>
        <span class="pct">${v}%</span></div>`;
    }).join('');
  }

  let slowT = 0;

  return {
    /** Switch which critter the panels describe — used when the user clicks
     *  a different one, or when a new one is spawned. */
    setCritter(c) {
      critter = c;
      for (const [, row] of utilRows) row.el.remove();
      utilRows.clear();
    },
    get critter() { return critter; },
    setEditingName(v) { editingName = v; },

    update(dt, allCritters) {
      if (!critter) return;
      t += dt;
      needBars();
      affectPlot();

      if (!editingName) $('#c-name').textContent = critter.name;
      $('#c-stage').textContent = critter.stage.name;
      $('#c-age').textContent = 'day ' + Math.floor(critter.ageDays);
      $('#c-mood').textContent = critter.away ? 'exploring' : critter.emotion.label().name;
      if (critter.away) {
        $('#c-room').textContent = 'outside';
      } else {
        const room = world.roomAt(Math.round(critter.gx), Math.round(critter.gy));
        $('#c-room').textContent = 'Room ' + room + ' · ' + world.themeFor(room).label;
      }
      $('#a-val').textContent = critter.emotion.valence.toFixed(2);
      $('#a-aro').textContent = critter.emotion.arousal.toFixed(2);
      $('#a-bond').textContent = Math.round(critter.bond * 100) + '%';
      $('#current-action').textContent = critter.currentLabel()
        + (critter.holding ? ' · holding ' + critter.holding : '');
      $('#clock').textContent = hhmm(world.minutes);

      drawPortrait($('#portrait'), critter, t);

      slowT += dt;
      if (slowT > 0.25) {
        slowT = 0;
        thoughts();
        aspirationAndWhim();
        moodlets();
        friendships(allCritters);
        if (!$('#panel-right').classList.contains('hidden')) {
          sensorPlot();
          utilities();
          memoryList();
          const acc = critter.brain.neural.accuracy;
          $('#nn-acc').textContent = critter.brain.neural.samples > 20 ? Math.round(acc * 100) + '%' : '—';
          $('#nn-n').textContent = critter.brain.neural.samples + ' samples';
          $('#nn-bar').style.width = Math.round(acc * 100) + '%';
          const nb = critter.brain.neural;
          $('#nn-reward').textContent = nb.rewardSamples > 10 ? nb.avgReward.toFixed(3) : '—';
          $('#nn-rn').textContent = nb.rewardSamples + ' outcomes';
          const rb = $('#nn-reward-bar');
          rb.style.width = Math.round(((nb.avgReward + 1) / 2) * 100) + '%';
          rb.style.background = nb.avgReward >= 0 ? 'var(--good)' : 'var(--bad)';
        }
      }
    },
  };
}

/** The row of small portraits above the needs panel when more than one
 *  critter shares the room — click one to make it the active critter. */
function renderCritterSwitcher(host, critters, activeId, onPick) {
  if (critters.length < 2) { host.innerHTML = ''; host.hidden = true; return; }
  host.hidden = false;
  host.innerHTML = '';
  for (const c of critters) {
    const b = document.createElement('button');
    b.className = 'crit-tab' + (c.id === activeId ? ' on' : '');
    b.textContent = c.name;
    b.title = c.away ? c.name + ' (out exploring)' : c.name;
    b.addEventListener('click', () => onPick(c));
    host.appendChild(b);
  }
}


// ---- src/main.js ----
// Bootstrap: build the world and the critter(s), wire input and the panels, run.


const SAVE_KEY = 'iso-critter.v2';
const MAX_CRITTERS = 4;

preloadSprites([
  'loungeSofa', 'bedDouble', 'bookcaseOpen', 'chairRounded',
  'loungeChairRelax', 'benchCushion', 'tableCoffee', 'desk', 'chairDesk',
  'sideTableDrawers', 'plantSmall1', 'radio', 'cardboardBoxClosed',
  'stoolBar', 'bookcaseClosedDoors',
]);

const world = createWorld();
const save = loadSave();

const critters = (save?.critters?.length ? save.critters : [save?.critter].filter(Boolean))
  .map((c) => createCritter(world, c));
if (!critters.length) critters.push(createCritter(world, null));
world.restore(save?.world);

// Every critter gets a live reference to the shared roster — the array
// itself, not a copy — so 'socialize' can see the others (and any spawned
// later) without the world needing to know critters exist at all.
for (const c of critters) c.peers = critters;

let active = critters[0];

const canvas = document.getElementById('screen');
const stage = document.getElementById('stage');
const switchHost = document.getElementById('critter-switch');
const renderer = createRenderer(canvas, world);
const hud = createHud(world);
const audio = createAudio();
addEventListener('pointerdown', () => audio.unlock(), { once: true });
hud.setCritter(active);
renderer.hud.activeId = active.id;

renderer.resize(stage);
addEventListener('resize', () => renderer.resize(stage));
refreshSwitcher();

for (const b of document.querySelectorAll('[data-place]')) {
  const price = PRICES[b.dataset.place];
  if (price != null) b.title = DEFS[b.dataset.place].label + ' — ' + price + ' coins';
}

// ------------------------------------------------------------------ paint panel

function buildSwatches(room, hostId) {
  const host = document.getElementById(hostId);
  host.innerHTML = '';
  for (const [id, theme] of Object.entries(ROOM_THEMES)) {
    const b = document.createElement('button');
    b.className = 'swatch' + (world.decor[room] === id ? ' on' : '');
    b.style.background = theme.wall;
    b.title = theme.label;
    b.addEventListener('click', () => {
      world.decor[room] = id;
      for (const s of host.children) s.classList.remove('on');
      b.classList.add('on');
    });
    host.appendChild(b);
  }
}
buildSwatches('A', 'paint-a');
buildSwatches('B', 'paint-b');
buildSwatches('C', 'paint-c');

// ------------------------------------------------------------------ rename

document.getElementById('rename-btn').addEventListener('click', () => {
  const nameEl = document.getElementById('c-name');
  if (document.getElementById('c-name-input')) return;
  hud.setEditingName(true);
  const input = document.createElement('input');
  input.id = 'c-name-input';
  input.maxLength = 16;
  input.value = active.name;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    const val = input.value.trim();
    if (val) active.name = val.slice(0, 16);
    input.replaceWith(nameEl);
    hud.setEditingName(false);
    refreshSwitcher();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { input.value = active.name; commit(); }
  });
  input.addEventListener('blur', commit);
});

function setActive(c) {
  active = c;
  renderer.hud.activeId = c.id;   // whose plumbob to float
  hud.setCritter(active);
  refreshSwitcher();
}

function refreshSwitcher() {
  renderCritterSwitcher(switchHost, critters, active.id, setActive);
}

function spawnCritter() {
  if (critters.length >= MAX_CRITTERS) return;
  const cell = active.randomFreeCellNear(5) || [Math.floor(world.cols / 2), Math.floor(world.rows / 2)];
  const c = createCritter(world, { gx: cell[0], gy: cell[1] });
  c.peers = critters;
  critters.push(c);
  setActive(c);
}

// ------------------------------------------------------------------ visitor
// A random critter that isn't part of the household — it lets itself in,
// hangs around competing for the toys for a while, then heads back out.
// Never saved: it simply isn't there any more on the next load, same as if
// it had let itself out overnight.

const RIVAL_NAMES = ['Scamp', 'Ruckus', 'Momo', 'Ziggy', 'Snips', 'Puck'];
let visitor = null;
let visitorTimer = 0;        // in-world hours left before it heads out
let visitorLeaving = false;
let visitorLeaveGrace = 0;   // real seconds standing at the door before despawn
let nextVisitRoll = world.day + 1;

function maybeSpawnVisitor() {
  if (visitor || critters.length >= MAX_CRITTERS) return;
  // A visitor "wandering in through the door" while it's locked, or while
  // something's physically standing on the door cell, was never actually
  // checked — it force-wrote the spawn position regardless.
  if (world.doorLocked || !world.isWalkable(0, Math.round(DOOR_GY))) return;
  if (Math.random() > 0.35) return;
  const name = RIVAL_NAMES[Math.floor(Math.random() * RIVAL_NAMES.length)];
  const c = createCritter(world, { gx: 0, gy: Math.round(DOOR_GY), name, visitor: true, ageDays: 10 + Math.random() * 5 });
  c.peers = critters;
  critters.push(c);
  c.think(name + ' wandered in through the door.');
  flash(name + ' is visiting');
  visitor = c;
  visitorTimer = 3 + Math.random() * 4;
  visitorLeaving = false;
}

function updateVisitor(dt) {
  if (!visitor) return;
  if (!visitorLeaving) {
    visitorTimer -= (dt * MINUTES_PER_SECOND) / 60;
    if (visitorTimer <= 0) {
      visitorLeaving = true;
      visitorLeaveGrace = 1.5;
      visitor.task = null;
      visitor.gx = 0; visitor.gy = Math.round(DOOR_GY);
      visitor.px = visitor.gx; visitor.py = visitor.gy;
      visitor.think('time to head home.');
    }
  } else {
    visitorLeaveGrace -= dt;
    if (visitorLeaveGrace <= 0) {
      const idx = critters.indexOf(visitor);
      if (idx >= 0) critters.splice(idx, 1);
      if (active === visitor) setActive(critters[0]);
      refreshSwitcher();
      visitor = null;
      nextVisitRoll = world.day + 1 + Math.random() * 3;
    }
  }
}

// ------------------------------------------------------------------ room editor

// Selection and movement are intentionally different states. A single click
// may inspect a piece without making the next floor click mutate the room.
const editState = { active: false, placing: null, moving: false };

// Single-level undo: each mutating edit overwrites whatever was here before,
// so only the very last placement/move/remove/rotate can be taken back.
let lastEdit = null;
function setLastEdit(undo) {
  lastEdit = { undo };
  syncUndoButton();
}
function undoLastEdit() {
  if (!lastEdit) return;
  lastEdit.undo();
  lastEdit = null;
  syncUndoButton();
  renderer.editor.selectedId = null;
  editState.moving = false;
  syncEditButtons();
}
function syncUndoButton() {
  const b = document.getElementById('btn-undo');
  if (b) b.disabled = !lastEdit;
}

function setEditing(on) {
  editState.active = on;
  editState.placing = null;
  editState.moving = false;
  renderer.editor.selectedId = null;
  lastEdit = null;
  document.getElementById('edit-palette').classList.toggle('hidden', !on);
  document.getElementById('paint-panel').classList.toggle('hidden', !on);
  document.querySelector('[data-act="edit"]').classList.toggle('on', on);
  syncEditButtons();
  syncUndoButton();
  if (on) syncPaletteAffordability();
  document.getElementById('hint').textContent = on
    ? 'pick something to place, or select a piece · R rotates it'
    : 'double-click floor/rug to move · click furniture to inspect · right-click for actions';
}

function selectedObject() {
  return renderer.editor.selectedId == null ? null : world.byId(renderer.editor.selectedId);
}

function itemKind(o) {
  if (o.def.structural) return 'fixed room fixture';
  if (o.def.lie) return 'bed';
  if (o.def.acts?.includes('bathe') || o.def.acts?.includes('soak')) return 'bathing fixture';
  if (o.def.sit) return 'seating';
  if (o.def.surface) return 'surface';
  if (o.def.flat) return o.def.standOn ? 'wall decoration' : 'floor item';
  if (o.def.mobile) return 'movable toy';
  if (o.def.acts?.length) return 'interactive furniture';
  return 'furniture';
}

function syncItemInspector() {
  const panel = document.getElementById('item-inspector');
  const o = selectedObject();
  panel.classList.toggle('hidden', !o);
  if (!o) return;
  document.getElementById('item-name').textContent = o.label;
  const footprint = `${o.w}×${o.h} ${o.w * o.h === 1 ? 'tile' : 'tiles'}`;
  const facing = o.def.directional
    ? ` · direction ${(((o.type === 'chair' ? o.state.face : o.state.rotation) ?? 0) & 3) + 1}/4`
    : '';
  const interaction = canOccupyObject(o)
    ? 'entered to use'
    : o.def.acts?.length
      ? 'used from beside it'
      : 'not directly usable';
  document.getElementById('item-description').textContent = `${itemKind(o)} · ${interaction} · ${o.type.replaceAll('_', ' ')} · ${footprint}${facing}`;
  const fixed = !!o.def.structural;
  const turnable = !fixed;
  const rotateLeft = document.getElementById('item-rotate-left');
  const rotate = document.getElementById('item-rotate');
  const move = document.getElementById('item-move');
  rotateLeft.disabled = !turnable;
  rotate.disabled = !turnable;
  move.disabled = fixed;
  move.classList.toggle('on', editState.moving);
  move.textContent = editState.moving ? '✓ Moving' : '↔ Move';
  document.getElementById('item-tip').textContent = fixed
    ? 'This piece is part of the room and cannot be moved.'
    : editState.moving
      ? 'Choose an empty tile · R rotates · Escape cancels'
      : 'Use ↶ / ↷ or R to rotate · click again to move · click away to cancel.';
}

function clearItemSelection() {
  renderer.editor.selectedId = null;
  renderer.editor.ghost = null;
  editState.moving = false;
  syncEditButtons();
}

function selectItem(o) {
  editState.placing = null;
  editState.moving = false;
  renderer.editor.selectedId = o.id;
  for (const b of document.querySelectorAll('[data-place]')) b.classList.remove('armed');
  syncEditButtons();
}

function startMovingSelected() {
  const o = selectedObject();
  if (!o || o.def.structural) return;
  const occupied = critters.some((c) => !c.away
    && Math.round(c.px) >= o.gx && Math.round(c.px) < o.gx + o.w
    && Math.round(c.py) >= o.gy && Math.round(c.py) < o.gy + o.h);
  if (occupied) { flash(`${o.label} is currently in use`); return; }
  editState.moving = true;
  syncEditButtons();
}

function footprintHasCritter(gx, gy, w, h) {
  return critters.some((c) => !c.away
    && Math.round(c.px) >= gx && Math.round(c.px) < gx + w
    && Math.round(c.py) >= gy && Math.round(c.py) < gy + h);
}

function canPlaceSafely(type, gx, gy) {
  const def = DEFS[type];
  return world.canPlace(type, gx, gy)
    && (def?.flat || !footprintHasCritter(gx, gy, def.w, def.h));
}

function canMoveSafely(o, gx, gy) {
  for (let x = gx; x < gx + o.w; x++) {
    for (let y = gy; y < gy + o.h; y++) {
      if (!world.inBounds(x, y)) return false;
      const occ = world.objectAt(x, y);
      if (!o.def.flat && occ && occ !== o) return false;
      if (!o.def.flat && x === 0 && y === DOOR_GY) return false;
    }
  }
  return o.def.flat || !footprintHasCritter(gx, gy, o.w, o.h);
}

function moveSelectedTo(gx, gy) {
  const o = selectedObject();
  if (!o || o.def.structural || !editState.moving) return false;
  if (!canMoveSafely(o, gx, gy)) {
    flash(`there isn't room for ${o.label} there`);
    return false;
  }
  const prevGx = o.gx, prevGy = o.gy;
  if (!world.moveObject(o.id, gx, gy)) return false;
  setLastEdit(() => world.moveObject(o.id, prevGx, prevGy));
  editState.moving = false;
  renderer.editor.ghost = null;
  syncEditButtons();
  return true;
}

function rotateSelected(direction = 1) {
  const o = selectedObject();
  if (!o || o.def.structural) return;
  // Include both the current and possible turned footprint. A seated critter
  // or one standing in the space a long item would rotate into must never be
  // swallowed by a convenient keyboard turn.
  const turnW = o.def.rotatesFootprint ? o.h : o.w;
  const turnH = o.def.rotatesFootprint ? o.w : o.h;
  if (footprintHasCritter(o.gx, o.gy, o.w, o.h)
    || footprintHasCritter(o.gx, o.gy, turnW, turnH)) {
    flash(`${o.label} is currently in use`);
    return;
  }
  const previous = {
    face: o.state.face, rotation: o.state.rotation, flip: o.state.flip,
    w: o.w, h: o.h,
  };
  if (!world.rotateObject(o.id, direction)) {
    flash(`there isn't room to rotate ${o.label}`);
    return;
  }
  setLastEdit(() => {
    const restored = world.byId(o.id);
    if (restored) {
      restored.state.face = previous.face;
      restored.state.rotation = previous.rotation;
      restored.state.flip = previous.flip;
      restored.w = previous.w;
      restored.h = previous.h;
      world.rebuildCollision();
    }
  });
  syncEditButtons();
}

/** Grey out (and disable) any shop button the household can't currently
 *  afford, instead of only complaining after the tile is clicked. */
let lastAffordCoins = -1;
function syncPaletteAffordability() {
  if (world.coins === lastAffordCoins) return;
  lastAffordCoins = world.coins;
  for (const b of document.querySelectorAll('[data-place]')) {
    const price = PRICES[b.dataset.place] ?? 0;
    const affordable = world.coins >= price;
    b.disabled = !affordable;
    b.classList.toggle('unaffordable', !affordable);
  }
}

function syncEditButtons() {
  const o = selectedObject();
  const has = !!o && !o.def.structural;
  document.getElementById('btn-rotate').disabled = !has;
  document.getElementById('btn-remove').disabled = !has;
  document.getElementById('edit-hint').textContent = editState.placing
    ? 'click a floor tile to place it'
    : editState.moving ? 'moving — click an empty tile'
      : o ? 'selected — click again or choose Move' : '';
  syncItemInspector();
}

document.getElementById('btn-undo').addEventListener('click', undoLastEdit);

document.getElementById('edit-palette').addEventListener('click', (e) => {
  const placeBtn = e.target.closest('[data-place]');
  if (placeBtn) {
    const type = placeBtn.dataset.place;
    editState.placing = editState.placing === type ? null : type;
    editState.moving = false;
    renderer.editor.selectedId = null;
    for (const b of document.querySelectorAll('[data-place]')) b.classList.toggle('armed', b === placeBtn && editState.placing);
    syncEditButtons();
    return;
  }
  const actBtn = e.target.closest('[data-edit-act]');
  if (!actBtn || actBtn.disabled) return;
  const id = renderer.editor.selectedId;
  if (id == null) return;
  if (actBtn.dataset.editAct === 'rotate') {
    rotateSelected();
  } else if (actBtn.dataset.editAct === 'remove') {
    const o = world.byId(id);
    if (o) {
      const snap = { type: o.type, gx: o.gx, gy: o.gy, state: { ...o.state } };
      world.removeObject(id);
      setLastEdit(() => world.addObject(snap.type, snap.gx, snap.gy, { state: snap.state }));
    }
    renderer.editor.selectedId = null;
    editState.moving = false;
    syncEditButtons();
  }
});

document.getElementById('item-rotate').addEventListener('click', (e) => {
  e.stopPropagation();
  rotateSelected();
});
document.getElementById('item-rotate-left').addEventListener('click', (e) => {
  e.stopPropagation();
  rotateSelected(-1);
});
document.getElementById('item-move').addEventListener('click', (e) => {
  e.stopPropagation();
  if (editState.moving) {
    editState.moving = false;
    renderer.editor.ghost = null;
    syncEditButtons();
  } else {
    startMovingSelected();
  }
});

// ------------------------------------------------------------------ input

canvas.addEventListener('click', (e) => {
  if (editState.active) {
    const g = renderer.screenToGrid(e.clientX, e.clientY);
    const gx = Math.floor(g.gx), gy = Math.floor(g.gy);

    if (editState.placing) {
      const price = PRICES[editState.placing] ?? 0;
      if (canPlaceSafely(editState.placing, gx, gy)) {
        if (world.spendCoins(price)) {
          const obj = world.addObject(editState.placing, gx, gy);
          if (obj) {
            renderer.editor.selectedId = obj.id; // immediately ready for ↶ / ↷ / R
            setLastEdit(() => { world.removeObject(obj.id); world.earnCoins(price); });
          }
        } else {
          flash("can't afford that (" + price + ' coins)');
        }
      }
      editState.placing = null;
      for (const b of document.querySelectorAll('[data-place]')) b.classList.remove('armed');
      syncEditButtons();
      return;
    }

    // Resolve by the exact cell under the cursor — not renderer.pick()'s
    // click box, which for tall furniture (fridge, bookshelf, bed...) is
    // deliberately oversized well past its own tile so its sprite stays
    // clickable in normal play. In the editor that's exactly backwards: it
    // means the neighbour's box, not the floor tile you're aiming at, eats
    // your click whenever you try to move something into an adjacent or
    // wall-hugging cell. Precise per-cell lookup has no such halo, so a
    // click either lands on the object actually occupying that cell or on
    // open floor, matching what you're looking at.
    if (world.inBounds(gx, gy)) {
      const o = world.selectableAt(gx, gy);
      if (o) {
        if (renderer.editor.selectedId === o.id && !editState.moving) startMovingSelected();
        else if (renderer.editor.selectedId !== o.id) selectItem(o);
        return;
      }
      if (editState.moving) {
        moveSelectedTo(gx, gy);
        return;
      }
      if (renderer.editor.selectedId != null) {
        clearItemSelection();
        return;
      }
    }
    const hit = renderer.pick(e.clientX, e.clientY, critters);
    if (hit.kind === 'critter') hit.critter.pet();
    else if (hit.kind === 'none' && renderer.editor.selectedId != null) clearItemSelection();
    return;
  }

  const hit = renderer.pick(e.clientX, e.clientY, critters);
  // The second click of the floor/rug double-click is handled below. Do not
  // reopen a menu or arm rug movement in the moment before `dblclick` fires.
  if (e.detail > 1 && (hit.kind === 'floor' || (hit.kind === 'object' && hit.obj.type === 'rug'))) return;
  if (hit.kind === 'critter') {
    clearItemSelection();
    setActive(hit.critter);
    hit.critter.pet();
    return;
  }

  // First click only selects and explains a piece. A second click on that
  // same item deliberately arms movement, so clicking away after inspecting
  // it cannot accidentally rearrange the room.
  if (hit.kind === 'object') {
    if (renderer.editor.selectedId === hit.obj.id && !editState.moving) startMovingSelected();
    else if (renderer.editor.selectedId !== hit.obj.id) selectItem(hit.obj);
    return;
  }

  if (hit.kind === 'floor') {
    if (editState.moving) {
      moveSelectedTo(hit.cell[0], hit.cell[1]);
      return;
    }
    if (renderer.editor.selectedId != null) {
      clearItemSelection();
      return;
    }
    e.stopPropagation();
    showClickMenu(e.clientX, e.clientY, [{
      label: '📣 call here',
      run: () => { active.callTo(hit.cell); world.emitSound(hit.cell[0], hit.cell[1], 0.45, 'tap'); },
    }]);
    return;
  }
  if (hit.kind === 'none' && renderer.editor.selectedId != null) clearItemSelection();
});

canvas.addEventListener('dblclick', (e) => {
  if (editState.active) return;
  const g = renderer.screenToGrid(e.clientX, e.clientY);
  const gx = Math.floor(g.gx), gy = Math.floor(g.gy);
  if (!world.inBounds(gx, gy)) return;
  // Resolve the exact ground cell rather than a tall sprite's generous click
  // box. Bare floor and rugs are valid; a rug covered by real furniture is not.
  const ground = world.selectableAt(gx, gy);
  if (ground && ground.type !== 'rug') return;
  if (!world.isWalkable(gx, gy)) return;
  e.preventDefault();
  e.stopPropagation();
  hideClickMenu();
  clearItemSelection();
  active.callTo([gx, gy]);
  world.emitSound(gx, gy, 0.45, 'tap');
});

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (editState.active) return;
  const hit = renderer.pick(e.clientX, e.clientY, critters);
  if (hit.kind !== 'object') return;

  const options = [];
  if (hit.obj.type === 'jukebox') {
    // A direct switch, like the TV — otherwise nothing ever turns the
    // music back off once a critter has danced to it.
    options.push({
      label: (hit.obj.state.on ? '🔇 turn off' : '🎵 turn on'),
      run: () => {
        hit.obj.state.on = !hit.obj.state.on;
        world.emitSound(hit.obj.gx, hit.obj.gy, 0.6, hit.obj.state.on ? 'music on' : 'click');
      },
    });
  } else {
    for (const act of hit.obj.def.acts) {
      const a = actionFor(act);
      options.push({ label: a ? a.label : act, run: () => active.suggest(hit.obj, act) });
    }
  }
  if (!options.length) { active.suggest(hit.obj); return; }
  showClickMenu(e.clientX, e.clientY, options, hit.obj);
});

// ------------------------------------------------------------------ click menu
// A click opens a small menu of what's actually possible there instead of
// guessing a single action (floor used to always mean "call the critter
// here" even when that's not what the click was for).

function showClickMenu(clientX, clientY, options, obj) {
  const menu = document.getElementById('click-menu');
  const rect = stage.getBoundingClientRect();
  menu.innerHTML = '';
  if (obj) {
    const header = document.createElement('div');
    header.className = 'click-menu-header';
    header.textContent = obj.label;
    menu.appendChild(header);
    renderer.editor.menuHighlightId = obj.id;
  } else {
    renderer.editor.menuHighlightId = null;
  }
  for (const opt of options) {
    const b = document.createElement('button');
    b.textContent = opt.label;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      hideClickMenu();
      opt.run();
    });
    menu.appendChild(b);
  }
  // Offset well clear of the cursor (and whatever was clicked) rather than
  // popping up right on top of it.
  const OFFSET = 36;
  const x = Math.min(clientX - rect.left + OFFSET, rect.width - 150);
  const y = Math.min(clientY - rect.top + OFFSET, rect.height - 40 * options.length - 30);
  menu.style.left = Math.max(4, x) + 'px';
  menu.style.top = Math.max(4, y) + 'px';
  menu.classList.remove('hidden');
}

function hideClickMenu() {
  document.getElementById('click-menu').classList.add('hidden');
  renderer.editor.menuHighlightId = null;
}

document.addEventListener('click', () => hideClickMenu());

canvas.addEventListener('mousemove', (e) => {
  if (editState.active && editState.placing) {
    const g = renderer.screenToGrid(e.clientX, e.clientY);
    const gx = Math.floor(g.gx), gy = Math.floor(g.gy);
    const type = editState.placing;
    const def = DEFS[type] || { w: 1, h: 1 };
    const affordable = world.coins >= (PRICES[type] ?? 0);
    renderer.editor.ghost = { gx, gy, w: def.w, h: def.h, valid: canPlaceSafely(type, gx, gy) && affordable };
    canvas.style.cursor = 'copy';
    return;
  }
  // Moving a piece already in the room gets the same live footprint preview
  // as placing a new one. Without it you're aiming at a cell you can't see,
  // which is nearly impossible where tall pieces stand shoulder to shoulder
  // and their sprites cover the very tiles you're trying to drop onto.
  if (editState.moving && renderer.editor.selectedId != null) {
    const sel = world.byId(renderer.editor.selectedId);
    if (sel) {
      const g = renderer.screenToGrid(e.clientX, e.clientY);
      const gx = Math.floor(g.gx), gy = Math.floor(g.gy);
      const fits = canMoveSafely(sel, gx, gy);
      renderer.editor.ghost = { gx, gy, w: sel.w, h: sel.h, valid: fits };
      renderer.hud.hoverObjId = null;
      renderer.hud.hoverGx = gx; renderer.hud.hoverGy = gy;
      canvas.style.cursor = fits ? 'move' : 'not-allowed';
      return;
    }
  }
  renderer.editor.ghost = null;
  const hit = renderer.pick(e.clientX, e.clientY, critters);
  canvas.style.cursor = hit.kind === 'none' ? 'default' : 'pointer';
  canvas.title = hit.kind === 'object' ? hit.obj.label : '';
  // Feed the tile marker: the piece under the cursor if there is one, else
  // the bare tile, so the pointer always has something under it to light up.
  const g = renderer.screenToGrid(e.clientX, e.clientY);
  renderer.hud.hoverObjId = hit.kind === 'object' ? hit.obj.id : null;
  renderer.hud.hoverGx = Math.floor(g.gx);
  renderer.hud.hoverGy = Math.floor(g.gy);
});

canvas.addEventListener('mouseleave', () => {
  renderer.hud.hoverGx = null;
  renderer.hud.hoverGy = null;
  renderer.hud.hoverObjId = null;
});

let jukeboxWasOn = false;
const SEASON_EMOJI = { spring: '🌱', summer: '☀️', autumn: '🍂', winter: '❄️' };
const WEATHER_EMOJI = { clear: '', cloudy: '☁️', rain: '🌧️', snow: '🌨️' };
let lastSeasonLabel = '';

const loop = startLoop({
  update(dt) {
    world.tick(dt);
    for (const c of critters) c.update(dt);
    updateVisitor(dt);
    if (world.day >= nextVisitRoll) {
      nextVisitRoll = world.day + 1 + Math.random() * 2;
      maybeSpawnVisitor();
    }
  },
  render(dt) {
    renderer.render(critters, dt);
    hud.update(dt, critters);
    document.getElementById('coins').textContent = '🪙 ' + world.coins;
    if (editState.active) syncPaletteAffordability();
    const season = world.season();
    const seasonLabel = WEATHER_EMOJI[world.weather] + SEASON_EMOJI[season] + ' ' + season;
    if (seasonLabel !== lastSeasonLabel) {
      const el = document.getElementById('season');
      el.textContent = seasonLabel;
      el.title = `${season[0].toUpperCase()}${season.slice(1)} — ${world.weather}`;
      lastSeasonLabel = seasonLabel;
    }

    for (const ev of world.drainAudioQueue()) audio.play(ev.tag, ev.loud);
    const jukebox = world.first('jukebox');
    const jukeboxOn = !!(jukebox && jukebox.state.on);
    if (jukeboxOn && !jukeboxWasOn) audio.startMusic();
    if (!jukeboxOn && jukeboxWasOn) audio.stopMusic();
    jukeboxWasOn = jukeboxOn;
  },
});

// ------------------------------------------------------------------ toolbar

function setSpeed(speed) {
  loop.speed = speed;
  for (const b of document.querySelectorAll('.speed')) b.classList.toggle('on', Number(b.dataset.speed) === speed);
}

document.getElementById('toolbar').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;

  if (btn.dataset.speed) {
    setSpeed(Number(btn.dataset.speed));
    return;
  }

  switch (btn.dataset.act) {
    case 'pet': active.pet(); break;
    case 'call': {
      const cell = active.frontRowCell();
      if (cell) active.callTo(cell);
      break;
    }
    case 'snack':
      active.give('meal');
      break;
    case 'tv': {
      const tv = world.first('tv');
      if (tv) {
        tv.state.on = !tv.state.on;
        world.emitSound(tv.gx, tv.gy, 0.6, 'tv');
      }
      break;
    }
    case 'light': {
      const lamp = world.first('lamp');
      if (!lamp) { flash('no lamp in the house to switch'); break; }
      world.lightsForced = world.lightsForced === null ? !lamp.state.on : !world.lightsForced;
      break;
    }
    case 'door':
      world.doorLocked = !world.doorLocked;
      btn.textContent = world.doorLocked ? '🔒 Door' : '🔓 Door';
      break;
    case 'edit':
      setEditing(!editState.active);
      break;
    case 'add-critter':
      spawnCritter();
      break;
    case 'mute':
      audio.muted = !audio.muted;
      btn.textContent = audio.muted ? '🔇' : '🔊';
      // Muting stops the music directly (audio.js's own setter), but
      // unmuting never restarted it — jukeboxWasOn was already `true` from
      // before the mute, so the edge-triggered check in the render loop
      // never fired again. An on jukebox stayed silent until switched off
      // and back on.
      if (!audio.muted && jukeboxWasOn) audio.startMusic();
      break;
    case 'debug':
      document.getElementById('panel-right').classList.toggle('hidden');
      btn.classList.toggle('on');
      renderer.resize(stage);
      break;
    case 'grid': {
      const input = document.getElementById('show-grid');
      renderer.overlays.grid = !renderer.overlays.grid;
      input.checked = renderer.overlays.grid;
      btn.classList.toggle('on', renderer.overlays.grid);
      break;
    }
  }
});

document.getElementById('toolbar').querySelector('[data-act="door"]').textContent =
  world.doorLocked ? '🔒 Door' : '🔓 Door';

// ------------------------------------------------------------------ inspector

for (const input of document.querySelectorAll('input[name=brain]')) {
  input.addEventListener('change', () => {
    if (input.checked) active.brain.mode = input.value;
  });
}
// Reflect the active critter's brain mode whenever the panel is drawn.
setInterval(() => {
  for (const input of document.querySelectorAll('input[name=brain]')) {
    input.checked = input.value === active.brain.mode;
  }
}, 500);

const bindOverlay = (id, key) => {
  const el = document.getElementById(id);
  el.addEventListener('change', () => {
    renderer.overlays[key] = el.checked;
    if (key === 'grid') {
      document.querySelector('[data-act="grid"]').classList.toggle('on', el.checked);
    }
  });
};
bindOverlay('show-vision', 'vision');
bindOverlay('show-path', 'path');
bindOverlay('show-grid', 'grid');

document.getElementById('btn-save').addEventListener('click', () => { doSave(); flash('saved'); });
document.getElementById('btn-reset').addEventListener('click', () => {
  if (!confirm('Start over with a brand new household? This erases everything currently saved.')) return;
  saveSuspended = true;   // otherwise beforeunload's autosave races the reload and undoes this
  localStorage.removeItem(SAVE_KEY);
  location.reload();
});

const SPEED_KEYS = { 1: 1, 2: 4, 3: 16 };

addEventListener('keydown', (e) => {
  if (document.activeElement?.tagName === 'INPUT') return;   // don't hijack the rename box
  if (e.key === '`' || e.key === '~') document.querySelector('[data-act=debug]').click();
  if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'g') {
    document.querySelector('[data-act=grid]').click();
  }
  if (e.key === ' ') { loop.running = !loop.running; e.preventDefault(); }
  if (SPEED_KEYS[e.key]) setSpeed(SPEED_KEYS[e.key]);
  if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'r' && selectedObject()) {
    rotateSelected(e.shiftKey ? -1 : 1);
    e.preventDefault();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && editState.active) { e.preventDefault(); undoLastEdit(); }
  if (e.key === 'Escape' && (editState.active || renderer.editor.selectedId != null)) {
    editState.placing = null;
    editState.moving = false;
    renderer.editor.selectedId = null;
    renderer.editor.ghost = null;
    for (const b of document.querySelectorAll('[data-place]')) b.classList.remove('armed');
    syncEditButtons();
  }
});

document.querySelector('[data-act="shortcuts"]').addEventListener('click', () => {
  document.getElementById('shortcuts-legend').classList.toggle('hidden');
});

// ------------------------------------------------------------------ save

let saveSuspended = false;

function doSave() {
  if (saveSuspended) return;
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      v: 2, critters: critters.filter((c) => !c.visitor).map((c) => c.serialize()), world: world.serialize(),
    }));
  } catch (err) { console.warn('save failed', err); }
}

function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

setInterval(doSave, 20000);
addEventListener('beforeunload', doSave);

function flash(text) {
  const el = document.getElementById('hint');
  const old = el.textContent;
  el.textContent = text;
  setTimeout(() => { el.textContent = old; }, 1200);
}

// Expose for tinkering from the console. `critter` always reflects whichever
// one is currently active/selected, even after a switch.
window.critters = critters;
Object.defineProperty(window, 'critter', { get: () => active, configurable: true });
window.world = world;
window.loop = loop;
window.renderer = renderer;

})();
