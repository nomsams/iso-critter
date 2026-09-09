// Sims-style temporary buffs. A moodlet is just a labelled timer with a small
// effect on need decay or emotion — the "Well Rested" / "Burnt Dinner" kind of
// thing that gives the HUD something concrete to say about *why* a critter
// feels the way it does right now, beyond the raw valence/arousal numbers.

import { clamp } from '../core/util.js';

/** id -> { label, icon, mods: {need: multiplier}, tone: 'good'|'bad' } */
export const MOODLET_DEFS = {
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

export function createMoodlets(init) {
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
