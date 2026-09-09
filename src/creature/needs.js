// Homeostatic drives. Everything the critter does is ultimately an attempt to
// push one of these back toward 1. They are the only "hard" motivation in the
// system — moods and habits modulate them, they never replace them.

import { clamp } from '../core/util.js';

export const NEEDS = [
  { key: 'hunger',  label: 'fullness', decay: 0.058, weight: 1.25, colour: '#e0a05a' },
  { key: 'energy',  label: 'energy',   decay: 0.044, weight: 1.15, colour: '#7f8fd0' },
  { key: 'bladder', label: 'bladder',  decay: 0.090, weight: 1.40, colour: '#7fd0c4' },
  { key: 'hygiene', label: 'hygiene',  decay: 0.030, weight: 0.70, colour: '#9ad0e8' },
  { key: 'fun',     label: 'fun',      decay: 0.088, weight: 0.85, colour: '#e79bb0' },
  { key: 'social',  label: 'company',  decay: 0.048, weight: 0.80, colour: '#f2b46b' },
];

export const NEED_KEYS = NEEDS.map((n) => n.key);

export function createNeeds(init) {
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
