// Small math / helper toolbox shared by every subsystem.

export const clamp = (v, lo = 0, hi = 1) => v < lo ? lo : v > hi ? hi : v;
export const lerp = (a, b, t) => a + (b - a) * t;
export const inv = (v) => 1 - v;
export const smooth = (t) => t * t * (3 - 2 * t);
export const dist2 = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
export const manhattan = (ax, ay, bx, by) => Math.abs(ax - bx) + Math.abs(ay - by);

/** Approach `target` at `rate` per second, frame-rate independent. */
export const approach = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

/** Deterministic little PRNG so a saved critter keeps its personality. */
export function makeRng(seed = Date.now() >>> 0) {
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

export function choose(list, scoreFn) {
  let best = null, bestScore = -Infinity;
  for (const item of list) {
    const s = scoreFn(item);
    if (s > bestScore) { bestScore = s; best = item; }
  }
  return { item: best, score: bestScore };
}

export const softmax = (arr, temp = 1) => {
  const m = Math.max(...arr);
  const e = arr.map((v) => Math.exp((v - m) / temp));
  const sum = e.reduce((a, b) => a + b, 0) || 1;
  return e.map((v) => v / sum);
};

/** 24h clock formatting from sim minutes-of-day. */
export const hhmm = (minutes) => {
  const m = ((minutes % 1440) + 1440) % 1440;
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(Math.floor(m % 60)).padStart(2, '0');
};
