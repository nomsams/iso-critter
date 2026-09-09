// Fixed-timestep simulation with an uncapped render pass.
// The brain must see a stable dt or utility scores jitter, so sim steps are
// always exactly STEP seconds no matter what the display does.

export const STEP = 1 / 30;

export function startLoop({ update, render, maxCatchUp = 8 }) {
  let acc = 0, last = performance.now(), raf = 0;
  const state = { speed: 1, running: true, fps: 0 };
  let frames = 0, fpsT = 0;

  function frame(now) {
    raf = requestAnimationFrame(frame);
    let elapsed = (now - last) / 1000;
    last = now;
    if (elapsed > 0.25) elapsed = 0.25;      // tab was hidden — don't fast-forward a week

    if (state.running) {
      acc += elapsed * state.speed;
      let steps = 0;
      while (acc >= STEP && steps < maxCatchUp * state.speed) { update(STEP); acc -= STEP; steps++; }
      if (acc > STEP * 4) acc = 0;
    }

    frames++; fpsT += elapsed;
    if (fpsT >= 0.5) { state.fps = Math.round(frames / fpsT); frames = 0; fpsT = 0; }
    render(elapsed);
  }
  raf = requestAnimationFrame(frame);
  state.stop = () => cancelAnimationFrame(raf);
  return state;
}
