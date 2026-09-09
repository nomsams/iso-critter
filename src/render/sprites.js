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
import { HW, HH, localOffset } from './iso.js';

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
export function preloadSprites(names) {
  for (const name of names) {
    for (const rot of ROT_FILES) getImage(`assets/sprites/${name}_${rot}.png`);
  }
}

let spriteRotation = 0;
export function setSpriteRotation(r) { spriteRotation = r & 3; }

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
export function drawSprite(ctx, x, y, name, opts = {}) {
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
