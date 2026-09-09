// The action library.
//
// Each entry is (a) a way to score how appealing the action looks right now and
// (b) a generator that yields low-level commands the creature runner executes.
// Generators keep multi-step behaviour readable: fetching dinner is literally
// "walk to fridge, open it, take food, walk to stove, cook, walk to table, eat".

import { clamp, manhattan } from '../core/util.js';
import { DOOR_GY } from '../world/world.js';


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

export const ACTIONS = [

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

export const ACTION_IDS = ACTIONS.map((a) => a.id);
export const actionById = (id) => ACTIONS.find((a) => a.id === id);

/** Which action consumes a given affordance, e.g. 'kick' -> play_ball. */
export const actionFor = (act) => ACTIONS.find((a) => a.act === act) || null;
