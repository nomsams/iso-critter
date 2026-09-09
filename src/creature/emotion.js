// Affect is modelled as a point drifting in valence/arousal space.
//
//   valence  -1 miserable .. +1 delighted   — mostly "are my needs met?"
//   arousal  -1 dozy      .. +1 wired       — urgency, novelty, stimulation
//
// Discrete emotions are just labelled regions of that plane, which keeps the
// face and the behaviour driven by one continuous signal instead of a switch.

import { clamp, approach } from '../core/util.js';

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

export function createEmotion(init) {
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
