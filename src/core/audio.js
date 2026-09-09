// Tiny synthesized sound effects — no audio files, just oscillators and noise
// bursts. The world already calls `emitSound(gx,gy,loud,tag)` everywhere
// something audible happens (a flush, a fridge door, a chime) as part of the
// critter's *hearing*; this module just also turns those same tags into
// actual sound, so nothing upstream needs to change to get audio.

let ctx = null;
let muted = false;
let musicNodes = null;

function ensureCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone(freq, dur, { type = 'sine', gain = 0.15, glideTo = null, delay = 0 } = {}) {
  const c = ensureCtx();
  const t0 = c.currentTime + delay;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t0 + dur);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.connect(g); g.connect(c.destination);
  osc.start(t0); osc.stop(t0 + dur + 0.02);
}

function noise(dur, { gain = 0.1, filterFreq = 1200, delay = 0 } = {}) {
  const c = ensureCtx();
  const t0 = c.currentTime + delay;
  const n = c.createBufferSource();
  const buf = c.createBuffer(1, c.sampleRate * dur, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  n.buffer = buf;
  const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = filterFreq;
  const g = c.createGain(); g.gain.setValueAtTime(gain, t0); g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  n.connect(f); f.connect(g); g.connect(c.destination);
  n.start(t0); n.stop(t0 + dur);
}

// tag -> a little synth patch. `loud` (0..1, from world.emitSound) scales gain.
const PATCHES = {
  fridge:  (l) => tone(180, 0.18, { type: 'square', gain: 0.06 * l }),
  flush:   (l) => noise(0.5, { gain: 0.12 * l, filterFreq: 900 }),
  water:   (l) => noise(0.6, { gain: 0.08 * l, filterFreq: 2200 }),
  sizzle:  (l) => noise(0.15, { gain: 0.05 * l, filterFreq: 3000 }),
  tv:      (l) => tone(440, 0.1, { type: 'triangle', gain: 0.05 * l }),
  'tv on': (l) => tone(300, 0.15, { type: 'triangle', gain: 0.08 * l, glideTo: 500 }),
  click:   (l) => tone(700, 0.05, { type: 'square', gain: 0.05 * l }),
  chute:   (l) => tone(220, 0.2, { type: 'sawtooth', gain: 0.06 * l, glideTo: 90 }),
  thud:    (l) => tone(90, 0.12, { type: 'sine', gain: 0.1 * l }),
  bounce:  (l) => tone(180, 0.08, { type: 'sine', gain: 0.06 * l }),
  tap:     (l) => tone(900, 0.06, { type: 'sine', gain: 0.05 * l }),
  zap:     (l) => { tone(600, 0.15, { type: 'sawtooth', gain: 0.08 * l, glideTo: 1400 }); tone(1400, 0.1, { gain: 0.05 * l, delay: 0.05 }); },
  gate:    (l) => tone(140, 0.25, { type: 'square', gain: 0.05 * l, glideTo: 100 }),
  chime:   (l) => { tone(660, 0.2, { gain: 0.08 * l }); tone(880, 0.25, { gain: 0.07 * l, delay: 0.08 }); },
  buzz:    (l) => tone(120, 0.25, { type: 'sawtooth', gain: 0.08 * l }),
  coin:    (l) => { tone(988, 0.08, { gain: 0.08 * l }); tone(1319, 0.12, { gain: 0.07 * l, delay: 0.06 }); },
  'music on': (l) => tone(392, 0.2, { gain: 0.06 * l, glideTo: 523 }),
  birthday: (l) => {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.22, { type: 'triangle', gain: 0.09 * l, delay: i * 0.1 }));
  },
};

export function createAudio() {
  return {
    get muted() { return muted; },
    set muted(v) { muted = v; if (v) stopMusic(); },

    /** Called once from a real user gesture (a click) to satisfy autoplay policy. */
    unlock() { try { ensureCtx(); } catch { /* no Web Audio available — silently skip */ } },

    play(tag, loud = 0.5) {
      if (muted) return;
      const patch = PATCHES[tag];
      if (!patch) return;
      try { patch(Math.max(0.15, Math.min(1, loud))); } catch { /* ignore */ }
    },

    /** A tiny looping four-note phrase for the jukebox — not music, but the idea of it. */
    startMusic() {
      if (muted || musicNodes) return;
      try {
        const c = ensureCtx();
        const notes = [392, 440, 523, 440];
        let i = 0;
        const id = setInterval(() => {
          if (muted) return;
          tone(notes[i % notes.length], 0.35, { type: 'triangle', gain: 0.05 });
          i++;
        }, 420);
        musicNodes = { id };
      } catch { /* ignore */ }
    },
    stopMusic,
  };
}

function stopMusic() {
  if (musicNodes) { clearInterval(musicNodes.id); musicNodes = null; }
}
