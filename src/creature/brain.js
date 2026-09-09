// Decision making.
//
// The brain's whole job: given a percept, return { action, target }. Two
// implementations share that interface — a hand-written utility brain and the
// learned one in neural.js — so swapping them at runtime changes nothing else.

import { ACTIONS, ACTION_IDS } from './actions.js';
import { softmax } from '../core/util.js';
import { createNeuralBrain } from './neural.js';
import { SENSE_DIMS } from './perception.js';

/** Deliberation is expensive-looking; think a few times a second, not 30. */
export const THINK_INTERVAL = 0.6;

export function createBrain(init) {
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
