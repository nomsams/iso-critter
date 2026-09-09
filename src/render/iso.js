// Isometric projection. One grid cell is a 32x16 diamond — the classic 2:1 ratio
// that keeps every edge on a clean pixel step.

export const TILE_W = 32, TILE_H = 16;
export const HW = TILE_W / 2, HH = TILE_H / 2;
export const WALL_H = 30;

/** Grid (float tile coords) -> screen pixels. Returns the cell's north corner. */
export function toScreen(gx, gy) {
  return { x: (gx - gy) * HW, y: (gx + gy) * HH };
}

/** Centre of a cell (or of a w*h footprint anchored at gx,gy). */
export function cellCenter(gx, gy, w = 1, h = 1) {
  return toScreen(gx + w / 2, gy + h / 2);
}

/** Screen pixels -> fractional grid coords. Inverse of toScreen. */
export function toGrid(sx, sy) {
  return { gx: (sy / HH + sx / HW) / 2, gy: (sy / HH - sx / HW) / 2 };
}

/** Painter's-algorithm depth key. Bigger = nearer the camera = drawn later. */
export const depthOf = (gx, gy, w = 1, h = 1, bias = 0) => (gx + w) + (gy + h) + bias;

/** Fill the diamond of one cell. */
export function tilePath(ctx, x, y) {
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
export function setRotation(r) { rotation = r & 3; }
const basis = () => BASIS[rotation];

/** Rotation-aware local "+w,+h" offset in screen pixels, for the odd piece of
 *  furniture (the chair's legs) that draws itself by hand instead of going
 *  through isoBox/isoPlate/boxFace. */
export function localOffset(w, h) {
  const { w: W, h: H } = basis();
  return [w * W[0] + h * H[0], w * W[1] + h * H[1]];
}

/**
 * Draw an axis-aligned cuboid sitting on cells (0,0)..(w,h) relative to the
 * north corner at (x,y). Only the three camera-facing sides exist.
 */
export function isoBox(ctx, x, y, w, h, ht, top, right, left) {
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
export function isoPlate(ctx, x, y, w, h, ht, color) {
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
export function boxFace(ctx, x, y, w, h, side, u0, u1, h0, h1, color) {
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
