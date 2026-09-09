// What the critter knows, as opposed to what is true.
//
// The planner may only reason about objects that are in here, so a fresh critter
// genuinely has to look around its room before it can use the fridge. Outcomes
// are written back as a per-object association, which is the seed of learning:
// things that reliably felt good get chosen sooner next time.

import { clamp } from '../core/util.js';

export function createMemory(init) {
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
