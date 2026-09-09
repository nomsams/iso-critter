// Senses. Every tick this builds a percept — the only view of the world the
// brain is allowed to use — and encodes it into a fixed-layout Float32Array.
//
// That vector is the contract for anything neural we bolt on later: same length,
// same meaning per slot, values normalised to roughly 0..1. Change SENSE_LAYOUT
// and both the algorithmic and the learned brain see the change at once.

import { clamp } from '../core/util.js';
import { NEED_KEYS } from './needs.js';
import { DIRS } from '../world/world.js';

export const CLASSES = [
  'fridge', 'stove', 'counter', 'sink', 'table', 'chair', 'toilet', 'shower',
  'bed', 'sofa', 'tv', 'toybox', 'bookshelf', 'plant', 'lamp', 'window', 'ball',
];

export const HOLDABLE = ['none', 'raw', 'meal', 'burnt', 'toy', 'can'];

export const VISION_RANGE = 7.5;
export const FOV = Math.cos((62 * Math.PI) / 180);   // dot-product threshold
export const PERIPHERAL = 1.6;                        // always-sensed bubble

/** Human-readable slot names, built once so the debug panel can label bars. */
export const SENSE_LAYOUT = (() => {
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

export const SENSE_DIMS = SENSE_LAYOUT.length;

const HOLD_INDEX = Object.fromEntries(HOLDABLE.map((h, i) => [h, i]));

export function perceive(c, world) {
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
export function sees(percept, obj) {
  return percept.visible.some((v) => v.obj === obj);
}
