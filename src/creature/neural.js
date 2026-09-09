// The seat reserved for neurons.
//
// One layer of rate-coded units, softmax output over the action set, trained
// online two ways at once:
//   - `learn()`  — imitation: nudged toward whatever the utility brain just
//     picked, every think-tick. This is the safety net that keeps the network
//     roughly sane from the very first sample.
//   - `reinforce()` — genuine outcome-based learning: once an action finishes,
//     creature.js hands back how much actual wellbeing it produced, and the
//     taken action's log-probability moves up or down by that amount (the
//     standard REINFORCE gradient for a softmax policy). This is the part
//     that isn't just copying the hand-written brain — a choice the utility
//     brain would make but that turns out badly gets pushed back down.
// From here, deeper layers, recurrence, or spikes are a change inside this
// file only. Everything upstream just produces `percept.vector`; everything
// downstream just consumes an action id.

import { softmax, clamp } from '../core/util.js';

export function createNeuralBrain(dims, actionIds, init) {
  const n = actionIds.length;
  // A saved brain is only reusable if the sensory layout and action set still
  // match; adding a sense or an action retires the old weights rather than
  // silently feeding the net garbage.
  const usable = init?.W && init.W.length === n * dims && init.b?.length === n;
  const W = usable ? Float32Array.from(init.W) : new Float32Array(n * dims);
  const b = usable ? Float32Array.from(init.b) : new Float32Array(n);
  if (!usable) for (let i = 0; i < W.length; i++) W[i] = (Math.random() - 0.5) * 0.02;

  let samples = usable ? (init.samples ?? 0) : 0;
  let accuracy = usable ? (init.accuracy ?? 0) : 0;   // exponential moving average
  let rewardSamples = usable ? (init.rewardSamples ?? 0) : 0;
  let avgReward = usable ? (init.avgReward ?? 0) : 0; // exponential moving average, can go negative
  const lr = 0.06;
  const rewardLr = 0.10;

  function forward(vec) {
    const logits = new Array(n);
    for (let a = 0; a < n; a++) {
      let s = b[a];
      const off = a * dims;
      for (let i = 0; i < dims; i++) s += W[off + i] * vec[i];
      logits[a] = s;
    }
    return logits;
  }

  return {
    id: 'neural',
    dims, actionIds,
    get samples() { return samples; },
    get accuracy() { return accuracy; },
    get rewardSamples() { return rewardSamples; },
    get avgReward() { return avgReward; },
    get ready() { return samples > 150 && accuracy > 0.55; },

    /** Probabilities over the action set, highest first. */
    rank(vec) {
      const p = softmax(forward(vec), 1);
      return actionIds
        .map((id, i) => ({ id, p: p[i] }))
        .sort((x, y) => y.p - x.p);
    },

    /** One supervised step towards `targetId`. Cross-entropy on a softmax. */
    learn(vec, targetId) {
      const ti = actionIds.indexOf(targetId);
      if (ti < 0) return;
      const p = softmax(forward(vec), 1);
      let argmax = 0;
      for (let i = 1; i < n; i++) if (p[i] > p[argmax]) argmax = i;
      accuracy = accuracy * 0.97 + (argmax === ti ? 1 : 0) * 0.03;
      samples++;
      for (let a = 0; a < n; a++) {
        const err = (a === ti ? 1 : 0) - p[a];
        const off = a * dims;
        const g = lr * err;
        for (let i = 0; i < dims; i++) W[off + i] += g * vec[i];
        b[a] += g;
      }
    },

    /**
     * Outcome-based update: `reward` is however much wellbeing actually
     * changed while `actionId` ran (can be negative). Pushes that action's
     * probability, given `vec`, up for a good outcome and down for a bad one
     * — independent of whatever the utility brain would have picked.
     */
    reinforce(vec, actionId, reward) {
      const ti = actionIds.indexOf(actionId);
      if (ti < 0 || !vec) return;
      const r = clamp(reward * 4, -1, 1);        // needs-wellbeing deltas are small; rescale to a useful range
      avgReward = avgReward * 0.97 + r * 0.03;
      rewardSamples++;
      const p = softmax(forward(vec), 1);
      for (let a = 0; a < n; a++) {
        const err = (a === ti ? 1 : 0) - p[a];
        const g = rewardLr * err * r;
        const off = a * dims;
        for (let i = 0; i < dims; i++) W[off + i] += g * vec[i];
        b[a] += g;
      }
    },

    /** Snapshot of what each unit is currently listening to — for the inspector. */
    weightsFor(actionId) {
      const a = actionIds.indexOf(actionId);
      if (a < 0) return null;
      return W.subarray(a * dims, (a + 1) * dims);
    },

    serialize: () => ({
      W: Array.from(W, (v) => Math.round(v * 1e4) / 1e4),
      b: Array.from(b, (v) => Math.round(v * 1e4) / 1e4),
      samples, accuracy: clamp(accuracy),
      rewardSamples, avgReward: clamp(avgReward, -1, 1),
    }),
  };
}
