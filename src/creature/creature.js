// The critter itself: body state, the runner that executes an action's
// generator, growth over days, and the glue between needs / emotion / memory /
// perception / brain.

import { clamp, approach, makeRng } from '../core/util.js';
import { createNeeds } from './needs.js';
import { createEmotion } from './emotion.js';
import { createMemory } from './memory.js';
import { createMoodlets } from './moodlets.js';
import { pickAspiration, rollWhim } from './aspirations.js';
import { createBrain, THINK_INTERVAL } from './brain.js';
import { perceive, SENSE_DIMS } from './perception.js';
import { findPath } from '../world/pathfind.js';
import { useCells, canOccupyObject } from '../world/objects.js';
import { MINUTES_PER_SECOND, DIRS, DOOR_GY } from '../world/world.js';
import { actionFor, actionById } from './actions.js';

export const STAGES = [
  { name: 'hatchling', days: 0, scale: 0.70, speed: 1.5 },
  { name: 'sprout',    days: 2, scale: 0.82, speed: 1.9 },
  { name: 'youngling', days: 5, scale: 0.92, speed: 2.2 },
  { name: 'grown',     days: 10, scale: 1.0, speed: 2.1 },
];

const NAMES = ['Pib', 'Onno', 'Tuff', 'Mochi', 'Bramble', 'Nix', 'Poppy', 'Grub', 'Fen', 'Wisp'];

let nextCritterId = 1;

export function createCritter(world, save) {
  const rng = makeRng(save?.seed ?? (Date.now() >>> 0));

  const id = save?.id ?? nextCritterId++;
  nextCritterId = Math.max(nextCritterId, id + 1);   // stay ahead of restored ids

  // A brand-new game's very first critter has no save to place it, so it
  // fell back to a hardcoded (5,5) — which the shipped layout puts a
  // wall_seg on, spawning it embedded in a wall until its first task moved
  // it. Walk outward in rings to the nearest actually-walkable cell instead,
  // so this can't break again no matter how the starting layout changes.
  let spawnGx = save?.gx, spawnGy = save?.gy;
  if (spawnGx == null || spawnGy == null || !world.isWalkable(spawnGx, spawnGy)) {
    spawnGx = 5; spawnGy = 5;
    outer:
    for (let r = 0; r <= Math.max(world.cols, world.rows); r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (world.isWalkable(5 + dx, 5 + dy)) { spawnGx = 5 + dx; spawnGy = 5 + dy; break outer; }
        }
      }
    }
  }

  const c = {
    id,
    seed: rng.seed,
    name: save?.name ?? NAMES[Math.floor(rng() * NAMES.length)],
    gx: spawnGx, gy: spawnGy,
    px: spawnGx, py: spawnGy,       // smooth visual position
    dir: save?.dir ?? 1,
    pose: 'stand',
    holding: save?.holding ?? null,
    asleep: false,
    bond: save?.bond ?? 0.05,                          // bond with the *player* — petting, calls, gifts
    relationships: save?.relationships ?? {},          // peer critter id -> friendship 0..1
    // The world-clock day this critter was born on — age is measured from
    // here, not from the household's clock, so a critter added later starts
    // as a hatchling instead of instantly inheriting everyone else's age.
    bornDay: save?.bornDay ?? (save?.ageDays != null
      ? (world.day + world.minutes / 1440) - save.ageDays
      : (world.day + world.minutes / 1440)),
    ageDays: save?.ageDays ?? 0,
    awakeHours: save?.awakeHours ?? 0,
    skill: Object.assign({ cooking: 0, fitness: 0, creativity: 0, charisma: 0 }, save?.skill),
    aspiration: save?.aspiration ?? pickAspiration(rng),
    whim: save?.whim ?? null,   // filled in just below once `c` exists
    whimAge: save?.whimAge ?? 0,
    neglect: save?.neglect ?? 0,

    trait: save?.trait ?? {
      curiosity: rng.range(0.3, 1),
      sociability: rng.range(0.2, 1),
      playfulness: rng.range(0.2, 1),
      tidiness: rng.range(0.1, 0.9),
      impulsiveness: rng.range(0.2, 0.9),
    },

    needs: createNeeds(save?.needs),
    emotion: createEmotion(save?.emotion),
    memory: createMemory(save?.memory),
    moodlets: createMoodlets(save?.moodlets),
    brain: createBrain(save?.brain),

    senseVec: new Float32Array(SENSE_DIMS),
    percept: null,
    signals: { attention: 0, touch: 0, callCell: null, suggested: null },

    task: null,
    thoughts: [],
    emote: null,
    lookAt: null,          // world point the eyes track
    blink: 0, blinkT: rng.range(1, 4),
    bob: 0,
    thinkT: 0,
    stuck: 0,
    away: save?.away ?? false, awayTimer: save?.awayTimer ?? 0,   // out exploring beyond the door
    visitor: !!save?.visitor,   // a passing-through critter, not part of the household — never saved
  };
  if (!c.whim) c.whim = rollWhim(rng, c.aspiration.id);

  // ------------------------------------------------------------- derived

  Object.defineProperty(c, 'stage', {
    get() {
      let s = STAGES[0];
      for (const st of STAGES) if (c.ageDays >= st.days) s = st;
      return s;
    },
  });
  Object.defineProperty(c, 'stageIndex', { get: () => STAGES.indexOf(c.stage) });
  Object.defineProperty(c, 'canCook', { get: () => c.stageIndex >= 1 });
  // The highest growth stage already celebrated, so a save/restore round-trip
  // never replays a birthday that already happened.
  c.stageIndexSeen = save?.stageIndexSeen ?? c.stageIndex;
  Object.defineProperty(c, 'moving', { get: () => c.pose === 'walk' });

  /** How under-stimulated the critter is right now: low fun plus "I've done
   *  everything in this room already" (every habit sitting near satiated). */
  Object.defineProperty(c, 'boredom', {
    get() {
      const funGap = 1 - c.needs.get('fun');
      let sum = 0, n = 0;
      for (const v of c.memory.habit.values()) { sum += v; n++; }
      const avgSat = n ? sum / n : 0;
      return clamp(funGap * 0.6 + avgSat * 0.5);
    },
  });

  c.energyFor = (cost) => (c.needs.get('energy') > cost ? 0.1 : -0.5);

  /** Friendship with another critter — separate from `bond`, which is only
   *  ever about the player. */
  c.relationshipWith = (peerId) => c.relationships[peerId] ?? 0;
  c.bumpRelationship = (peerId, delta) => {
    c.relationships[peerId] = clamp((c.relationships[peerId] ?? 0) + delta);
  };

  c.think = (text) => {
    c.thoughts.unshift(text);
    if (c.thoughts.length > 20) c.thoughts.pop();
    c.memory.log(text);
  };

  c.onNovel = (o) => {
    c.emotion.pulse(0.05, 0.35, 'saw ' + o.label);
    if (c.memory.objects.size <= 18) c.think('what is that? ' + o.label + '.');
  };

  c.randomFreeCellNear = (r) => {
    for (let i = 0; i < 30; i++) {
      const x = c.gx + Math.round(rng.range(-r, r));
      const y = c.gy + Math.round(rng.range(-r, r));
      // Keep free roaming off the room rim and the semantic sit/lie set as a
      // belt-and-suspenders guard. All non-flat furniture is already blocked
      // by isWalkable(), including chairs, beds and sofas.
      if (world.inBounds(x, y) && world.isWalkable(x, y) && !world._sitCells.has(x + ',' + y)
        && !world.isPerimeter(x, y) && !(x === c.gx && y === c.gy)) return [x, y];
    }
    return null;
  };

  /** A tile near the front of the room, i.e. facing whoever is watching. */
  c.frontRowCell = () => {
    let best = null, bestD = -1;
    for (let x = 0; x < world.cols; x++) {
      for (let y = 0; y < world.rows; y++) {
        if (!world.isWalkable(x, y) || world._sitCells.has(x + ',' + y) || world.isPerimeter(x, y)) continue;
        const d = x + y - Math.abs(x - y) * 0.4;
        if (d > bestD) { bestD = d; best = [x, y]; }
      }
    }
    return best;
  };

  // ------------------------------------------------------------- task runner

  function startTask(choice) {
    const alignCell = c.replanAlignment || null;
    c.replanAlignment = null;
    c.task = {
      action: choice.action,
      target: choice.target,
      score: choice.score ?? 0,
      gen: choice.action.run(c, world, choice.target),
      cmd: null, cmdT: 0, cmdInit: false,
      path: null, pathIdx: 0, segmentFacing: -1, lastResult: true,
      blockedSteps: null,
      // A replacement assignment can arrive between cell centres. Preserve
      // that live position and finish/reverse only the current grid segment
      // before asking A* for the new route; never run the remainder of the
      // superseded assignment and never teleport back to its previous cell.
      alignCell,
      wellbeingAtStart: c.needs.wellbeing(),
      // a snapshot, not a reference — c.senseVec gets overwritten every tick
      vectorAtStart: Float32Array.from(c.senseVec),
    };
    if (alignCell) c.pose = 'walk';
    if (choice.action.emote) setEmote(choice.action.emote, 1.2);
  }

  function finishTask({ preservePosition = false } = {}) {
    if (!c.task) return;
    // A decision can interrupt a walk halfway across a tile. Keep that live
    // point and only settle the active one-cell segment for a replacement
    // task. Normal completion/error cleanup still returns to a cell centre.
    let alignment = null;
    if (c.moving && preservePosition) {
      const next = c.task.path?.[c.task.pathIdx];
      if (next && Math.abs(next[0] - c.gx) + Math.abs(next[1] - c.gy) === 1
        && world.isWalkable(next[0], next[1])
        && !world.edgeBlocked(c.gx, c.gy, next[0], next[1])) {
        alignment = [next[0], next[1]];
      } else {
        alignment = [c.gx, c.gy];
      }
    } else if (c.moving) {
      snapToCell(c.gx, c.gy);
    }
    const gain = c.needs.wellbeing() - c.task.wellbeingAtStart;
    const obj = c.task.target?.obj;
    if (obj) c.memory.reinforce(obj.id, gain * 3);
    c.brain.neural.reinforce(c.task.vectorAtStart, c.task.action.id, gain);
    if (c.whim && c.task.action.id === c.whim.actionId) completeWhim();
    c.task = null;
    c.replanAlignment = alignment;
    c.pose = alignment ? 'walk' : 'stand';
  }

  function completeWhim() {
    const done = c.whim;
    c.emotion.pulse(0.35, 0.2, 'satisfied a want');
    c.moodlets.add('goal_met');
    c.needs.satisfy('fun', 0.08);
    const skillKey = c.aspiration.skill;
    if (skillKey && done.weight[c.aspiration.id]) {
      c.skill[skillKey] = clamp(c.skill[skillKey] + 0.04);
    }
    c.think('wanted to ' + done.label + ' — done.');
    c.whim = rollWhim(rng, c.aspiration.id, done.id);
    c.whimAge = 0;
  }

  function setEmote(name, dur) { c.emote = { name, t: 0, dur }; }

  /** Execute the current generator until it needs more time. */
  function runTask(dt) {
    const T = c.task;
    if (!T) return;

    // Reassignment is immediate, but movement stays on the grid: discard the
    // old route, settle just the segment the critter is physically on, then
    // let the replacement generator/A* plan from that newly reached centre.
    if (T.alignCell) {
      if (!alignInterruptedStep(dt)) return;
      T.alignCell = null;
      T.segmentFacing = -1;
    }
    let guard = 0;

    while (guard++ < 12) {
      if (!T.cmd) {
        let step;
        try { step = T.gen.next(T.lastResult); } catch (e) { console.warn(e); finishTask(); return; }
        if (step.done) { finishTask(); return; }
        T.cmd = step.value; T.cmdT = 0; T.cmdInit = false;
        if (!T.cmd) { T.lastResult = true; continue; }
      }

      const cmd = T.cmd;

      if (cmd.t === 'goto') {
        if (!T.cmdInit) {
          T.cmdInit = true;
          // `alignInterruptedStep` guarantees that replacement assignments
          // reach a true cell centre before A* starts.
          if (c.px !== c.gx || c.py !== c.gy) snapToCell(c.gx, c.gy);
          // Route around wherever everyone else currently stands, so paths
          // don't cross straight through/onto another critter mid-walk.
          const avoid = new Set();
          for (const p of c.peers || []) {
            if (p === c || p.away) continue;
            avoid.add(Math.round(p.gx) + ',' + Math.round(p.gy));
          }
          // Never aim at a tile someone is already on — that's what had two
          // critters walking into each other forever, each shoved off by the
          // separation nudge and immediately re-pathing back onto the same
          // spot. Routing *through* a peer is fine though (they move), so if
          // the strict path fails, retry ignoring peers as obstacles while
          // still refusing to finish on top of one.
          const free = cmd.cells.filter(([x, y]) => !avoid.has(x + ',' + y));
          if (!free.length) {
            T.lastResult = false; T.cmd = null; T.gotoFailed = true; T.fails = (T.fails || 0) + 1;
            if (T.fails > 2) { c.think('someone else is there.'); finishTask(); return; }
            continue;
          }
          T.path = findPath(world, [c.gx, c.gy], free, avoid, world._noTransit, T.blockedSteps)
            || findPath(world, [c.gx, c.gy], free, null, world._noTransit, T.blockedSteps);
          T.pathIdx = 0;
          T.segmentFacing = -1;
          T.pathFrom = [c.gx, c.gy];
          if (!T.path) {
            // Unreachable. Hand `false` back so the action can bail gracefully;
            // give up entirely if it keeps asking for places it cannot get to.
            T.lastResult = false; T.cmd = null; T.gotoFailed = true; T.fails = (T.fails || 0) + 1;
            if (T.fails > 2) {
              c.emotion.pulse(-0.3, 0.45, 'could not get there');
              c.think("can't get to it.");
              finishTask();
              return;
            }
            continue;
          }
        }
        if (!walkStep(dt)) return;             // still walking; wait for next tick
        T.lastResult = true; T.cmd = null; T.path = null; T.gotoFailed = false; T.blockedSteps = null;
        continue;
      }

      if (cmd.t === 'use') {
        if (!T.cmdInit) {
          T.cmdInit = true;
          // The preceding goto may have silently failed (unreachable, or
          // another critter already standing where this one was headed) —
          // most actions don't check its result before yielding straight
          // into use(), which used to mean "sit"/"cook"/etc. would just
          // happen from wherever the critter actually ended up. Refuse to
          // use furniture from a tile that isn't actually a valid spot for
          // it, rather than let every action remember to check for itself.
          const validUseCells = cmd.obj
            ? (cmd.outside ? world.exteriorApproachCells(cmd.obj) : useCells(cmd.obj))
            : null;
          if (cmd.obj && !validUseCells.some(([vx, vy]) => vx === c.gx && vy === c.gy)) {
            T.cmd = null;
            // Say which it actually was. A failed walk and a piece of
            // furniture that moved out from under them are different
            // problems, and reporting both as "that's not where I thought"
            // made every unreachable target look like a glitch.
            if (T.gotoFailed) {
              c.emotion.pulse(-0.2, 0.3, 'could not get there');
              c.think("can't get to it.");
            } else {
              c.emotion.pulse(-0.15, 0.25, "wasn't actually there");
              c.think("huh, that's not where I thought it was.");
            }
            finishTask();
            return;
          }
          if (cmd.obj) faceObject(cmd.obj);
          if (cmd.emote) setEmote(cmd.emote, cmd.dur);
        }
        c.pose = cmd.pose || 'stand';
        const before = T.cmdT;
        T.cmdT = Math.min(cmd.dur, T.cmdT + dt);
        const frac = (T.cmdT - before) / cmd.dur;
        if (cmd.fill) for (const k in cmd.fill) c.needs.satisfy(k, cmd.fill[k] * frac);
        if (cmd.sound && cmd.obj && Math.random() < dt * 0.6) {
          world.emitSound(cmd.obj.gx, cmd.obj.gy, cmd.sound, 'use');
        }
        if (T.cmdT >= cmd.dur) { T.lastResult = true; T.cmd = null; continue; }
        return;
      }

      if (cmd.t === 'emote') {
        if (!T.cmdInit) { T.cmdInit = true; setEmote(cmd.emote, cmd.dur); }
        T.cmdT += dt;
        if (T.cmdT >= cmd.dur) { T.lastResult = true; T.cmd = null; continue; }
        return;
      }

      if (cmd.t === 'face') { c.dir = cmd.value ?? cmd.dir; T.cmd = null; T.lastResult = true; continue; }
      if (cmd.t === 'hold') { c.holding = cmd.item; T.cmd = null; T.lastResult = true; continue; }
      if (cmd.t === 'set') { cmd.obj.state[cmd.key] = cmd.value; T.cmd = null; T.lastResult = true; continue; }

      T.cmd = null; T.lastResult = true;       // unknown command — skip it
    }
  }

  /** Finish or safely reverse the one cell transition that was already in
   *  progress when a new assignment arrived. The old route itself is gone. */
  function alignInterruptedStep(dt) {
    const T = c.task;
    let [tx, ty] = T.alignCell;
    const fromX = c.gx, fromY = c.gy;
    const changingCell = tx !== fromX || ty !== fromY;
    const peerOnTarget = (c.peers || []).some((p) => p !== c && !p.away
      && p.gx === tx && p.gy === ty);
    if ((changingCell && (!world.isWalkable(tx, ty)
      || world.edgeBlocked(fromX, fromY, tx, ty) || peerOnTarget))) {
      // The forward half of the interrupted segment became unsafe after the
      // assignment was made. Reverse along the same centre line instead.
      T.alignCell = [fromX, fromY];
      tx = fromX; ty = fromY;
    }

    const dx = tx - c.px, dy = ty - c.py;
    const remaining = Math.abs(dx) + Math.abs(dy);
    c.pose = 'walk';
    if (remaining < 0.06) {
      snapToCell(tx, ty);
      c.pose = 'stand';
      return true;
    }

    const speed = c.stage.speed * (c.needs.get('energy') > 0.2 ? 1 : 0.6);
    const horizontal = Math.abs(dx) > Math.abs(dy);
    const step = Math.min(remaining, speed * dt);
    const nx = horizontal ? c.px + Math.sign(dx) * step : tx;
    const ny = horizontal ? ty : c.py + Math.sign(dy) * step;
    const ignores = occupancyObjectsAt(fromX, fromY, tx, ty);
    if (!segmentClearOfFurniture(c.px, c.py, nx, ny, 0.3, ignores)) {
      if (changingCell) {
        T.alignCell = [fromX, fromY];
        return false;
      }
      snapToCell(fromX, fromY);
      c.pose = 'stand';
      return true;
    }
    c.px = nx; c.py = ny;
    clampToRoom(false);
    c.bob += dt * 9;
    return false;
  }

  /** @returns true when the path is finished. */
  function walkStep(dt) {
    const T = c.task;
    if (!T.path || T.pathIdx >= T.path.length) { c.pose = 'stand'; return true; }
    const [tx, ty] = T.path[T.pathIdx];
    const [fromX, fromY] = T.pathIdx === 0 ? T.pathFrom : T.path[T.pathIdx - 1];
    const isDestination = T.pathIdx === T.path.length - 1;
    const cardinalStep = Math.abs(tx - fromX) + Math.abs(ty - fromY) === 1;

    // Paths are snapshots, while the room can change underneath them. An
    // item moved onto the next cell (or a gate closed across this edge) used
    // to be ignored until the old route completed, so the critter visibly
    // walked through the new obstacle. Return to the last known-safe cell and
    // let the same goto command plan again against the current collision map.
    const peerOnTarget = (c.peers || []).some((p) => {
      if (p === c || p.away) return false;
      if (p.gx === tx && p.gy === ty) return true;
      const reserved = p.task?.path?.[p.task.pathIdx];
      return p.id < c.id && reserved && reserved[0] === tx && reserved[1] === ty;
    });
    const stepStillOpen = cardinalStep && world.isWalkable(tx, ty) && !peerOnTarget
      && !world.edgeBlocked(fromX, fromY, tx, ty)
      && (isDestination || !world._noTransit.has(tx + ',' + ty));
    if (!stepStillOpen) return rejectCurrentStep(T, fromX, fromY, tx, ty);

    // Turn exactly once, while still centered in the cell being departed.
    // Direction is stable for the entire segment; it never flips while the
    // critter is resting on a cell edge or halfway across a tile.
    if (T.segmentFacing !== T.pathIdx) {
      const dir = DIRS.findIndex(([dx, dy]) => dx === tx - fromX && dy === ty - fromY);
      if (dir >= 0) c.dir = dir;
      T.segmentFacing = T.pathIdx;
    }
    const speed = c.stage.speed * (c.needs.get('energy') > 0.2 ? 1 : 0.6);
    const horizontal = tx !== fromX;
    const current = horizontal ? c.px : c.py;
    const target = horizontal ? tx : ty;
    const remaining = Math.abs(target - current);
    c.pose = 'walk';

    if (remaining < 0.06) {
      snapToCell(tx, ty);
      c.stuck = 0;
      T.pathIdx++;
      if (T.pathIdx >= T.path.length) { c.pose = 'stand'; return true; }
      return false;
    }
    const step = Math.min(remaining, speed * dt);
    const next = current + Math.sign(target - current) * step;
    // Lock the perpendicular coordinate to the centre line explicitly. This
    // removes even microscopic diagonal drift and makes every rendered frame
    // agree with the four-neighbour grid that A* searched.
    const nx = horizontal ? next : fromX;
    const ny = horizontal ? fromY : next;
    const collisionIgnores = movementOccupancyObjects(T, fromX, fromY, tx, ty, isDestination);
    if (!segmentClearOfFurniture(c.px, c.py, nx, ny, 0.3, collisionIgnores)) {
      return rejectCurrentStep(T, fromX, fromY, tx, ty);
    }
    c.px = nx;
    c.py = ny;
    clampToRoom(false);
    c.bob += dt * 9;
    return false;
  }

  /** Remember a grid edge rejected by live collision so replanning cannot
   *  choose the identical bad approach forever. This is the wall/chair
   *  oscillation guard: A* tries another side once, or reports unreachable
   *  when the seat truly has no body-clear entrance. */
  function rejectCurrentStep(T, fromX, fromY, tx, ty) {
    if (Math.abs(tx - fromX) + Math.abs(ty - fromY) === 1) {
      if (!T.blockedSteps) T.blockedSteps = new Set();
      T.blockedSteps.add(world.edgeKey(fromX, fromY, tx, ty));
    }
    c.stuck++;
    snapToCell(fromX, fromY);
    c.pose = 'stand';
    T.path = null; T.pathIdx = 0; T.segmentFacing = -1; T.cmdInit = false;
    return false;
  }

  /**
   * Hard backstop: whatever set px/py, pull them back inside the room. This
   * should never actually trigger — pathfinding only ever targets in-bounds
   * cells — but it means a critter can never visually end up outside the
   * floor no matter what bug or future action manages to move it there.
   */
  function clampToRoom(syncGrid = true) {
    c.px = Math.max(0, Math.min(world.cols - 1, c.px));
    c.py = Math.max(0, Math.min(world.rows - 1, c.py));
    if (syncGrid) { c.gx = Math.round(c.px); c.gy = Math.round(c.py); }
  }

  function snapToCell(gx, gy) {
    c.gx = Math.max(0, Math.min(world.cols - 1, Math.round(gx)));
    c.gy = Math.max(0, Math.min(world.rows - 1, Math.round(gy)));
    c.px = c.gx;
    c.py = c.gy;
  }

  /** Keep the critter's body outside furniture continuously, rather than
   *  waiting until its centre rounds into the blocked cell. The old rounded
   *  test allowed almost half a tile of visible penetration. */
  function bodyClearOfFurniture(px, py, radius = 0.3, ignoreObjects = null) {
    const cx = px + 0.5, cy = py + 0.5;
    for (const o of world.objects) {
      if (o.def.flat || o.def.edgeBlock) continue;
      if (ignoreObjects?.has(o)) continue;
      const ox = o.def.mobile ? o.fx : o.gx;
      const oy = o.def.mobile ? o.fy : o.gy;
      const nx = Math.max(ox, Math.min(ox + o.w, cx));
      const ny = Math.max(oy, Math.min(oy + o.h, cy));
      if (Math.hypot(cx - nx, cy - ny) < radius) return false;
    }
    return true;
  }

  /** Swept collision for the visible body. A large simulation-speed frame or
   *  a moving ball must not be able to sit between the previous and next
   *  endpoint and get skipped by an endpoint-only collision test. */
  function segmentClearOfFurniture(ax, ay, bx, by, radius = 0.3, ignoreObjects = null) {
    const distance = Math.hypot(bx - ax, by - ay);
    const samples = Math.max(1, Math.ceil(distance / Math.max(0.08, radius * 0.4)));
    for (let i = 1; i <= samples; i++) {
      const f = i / samples;
      if (!bodyClearOfFurniture(ax + (bx - ax) * f, ay + (by - ay) * f, radius, ignoreObjects)) return false;
    }
    return true;
  }

  const coversCell = (o, x, y) => x >= o.gx && x < o.gx + o.w
    && y >= o.gy && y < o.gy + o.h;

  /** Occupiable furniture overlapping either endpoint of a segment. Used
   *  when leaving a bed/seat and while settling an interrupted seat entry. */
  function occupancyObjectsAt(...coords) {
    const result = new Set();
    for (const o of world.objects) {
      if (!canOccupyObject(o)) continue;
      for (let i = 0; i < coords.length; i += 2) {
        if (coversCell(o, coords[i], coords[i + 1])) { result.add(o); break; }
      }
    }
    return result;
  }

  /** Only the explicitly assigned item may be entered at the end of a route.
   *  The occupiable item under the starting cell is also ignored so a critter
   *  can get back out without colliding with the seat it is leaving. */
  function movementOccupancyObjects(T, fromX, fromY, tx, ty, isDestination) {
    const result = occupancyObjectsAt(fromX, fromY);
    const target = T.target?.obj;
    if (isDestination && target && canOccupyObject(target) && coversCell(target, tx, ty)) {
      result.add(target);
    }
    return result;
  }

  /** Whole-cell moves used for the two non-path movement cases: resolving a
   *  legacy stacked save and stepping off a floor roller. */
  function wholeCellOpen(fromX, fromY, x, y) {
    const fx = Math.round(fromX), fy = Math.round(fromY);
    const tx = Math.round(x), ty = Math.round(y);
    if (!world.isWalkable(tx, ty) || world._noTransit.has(tx + ',' + ty)) return false;
    if (world.edgeBlocked(fx, fy, tx, ty)) return false;
    return !(c.peers || []).some((p) => p !== c && !p.away && p.gx === tx && p.gy === ty);
  }

  /** Repair old saves (or a piece restored after the critter) that place a
   *  critter inside newly-solid furniture. Search outward by Manhattan ring
   *  and land once, exactly at a free cell center. */
  function recoverFromBlockedCell() {
    if (world.isWalkable(c.gx, c.gy)) return;
    const sx = c.gx, sy = c.gy;
    for (let radius = 1; radius <= Math.max(world.cols, world.rows); radius++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const dy = radius - Math.abs(dx);
        for (const sign of dy === 0 ? [1] : [-1, 1]) {
          const x = sx + dx, y = sy + dy * sign;
          if (!world.inBounds(x, y) || !world.isWalkable(x, y) || world.isPerimeter(x, y)) continue;
          if ((c.peers || []).some((p) => p !== c && !p.away && p.gx === x && p.gy === y)) continue;
          c.task = null;
          c.asleep = false;
          c.pose = 'stand';
          snapToCell(x, y);
          return;
        }
      }
    }
  }

  function faceObject(o) {
    // Sitting/lying directly on the piece puts the critter's own centre
    // right on top of the object's, so the delta below is ~0 and the
    // early-return further down just left whatever direction the critter
    // happened to be walking in when it arrived — a chair sat in facing
    // sideways, a bed slept in facing the wrong way. Face however the piece
    // is actually oriented instead: the chair's open side (state.face), a
    // directional piece's own state.rotation, or a fixed def.faceDir for
    // anything occupiable but not itself rotatable (the toilet).
    const onIt = canOccupyObject(o) && o.gx <= c.gx && c.gx < o.gx + o.w
      && o.gy <= c.gy && c.gy < o.gy + o.h;
    if (onIt) {
      // state.face (plain chairs) is defined in world/objects.js as "which
      // way the seat opens" using this exact 0:+gx 1:+gy 2:-gx 3:-gy scale,
      // so it drops straight in — confirmed correct.
      //
      // state.rotation (kenneyItem sit furniture — armchair, office_chair,
      // bar_stool, bench) selects which of the 4 compass-labelled sprite
      // images to show — ROT_FILES in sprites.js: 0:'SE' 1:'NE' 2:'NW'
      // 3:'SW', verified there against the camera's actual position. c.dir
      // uses the same compass words in DIRS' own comment: 0:'SE' 1:'SW'
      // 2:'NW' 3:'NE'. Those two labellings were authored independently, so
      // matching rotation to the c.dir of the SAME label — not a plain
      // pass-through, which silently assumes the two scales already agree —
      // is what actually lines the critter up with the chair: rotation
      // 0(SE)->dir 0(SE), 1(NE)->dir 3(NE), 2(NW)->dir 2(NW), 3(SW)->dir
      // 1(SW). Checked directly this time: spawned one office_chair, cycled
      // all 4 rotations, sat a critter in each via this exact table. 0 and 2
      // are unambiguous (chair's open side faces toward vs away from
      // camera; critter shows face vs back to match, confirmed both ways)
      // and agree with the table either way. 1 and 3 turn the chair exactly
      // side-on to the camera, which critter.js has no profile pose for —
      // its face only ever draws for dir 0/1, otherwise the same generic
      // back-of-head regardless of 2 vs 3 — so neither of THOSE two has a
      // render that's more "correct" than the other; this table just picks
      // one consistently instead of leaving it to whatever the critter
      // happened to be facing when it sat down.
      const ROT_TO_DIR = [0, 3, 2, 1];
      const facing = o.def.directional
        ? (o.type === 'chair' ? o.state.face : ROT_TO_DIR[(o.state.rotation ?? 0) & 3])
        : o.def.faceDir;
      if (facing != null) { c.dir = facing & 3; return; }
    }
    const cc = world.center(o);
    const dx = cc.gx - (c.px + 0.5), dy = cc.gy - (c.py + 0.5);
    if (Math.abs(dx) < 0.2 && Math.abs(dy) < 0.2) return;
    c.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 0 : 2) : (dy > 0 ? 1 : 3);
  }

  // ------------------------------------------------------------- interactions

  c.pet = () => {
    c.signals.touch = 1;
    c.signals.attention = 1;
    c.bond = clamp(c.bond + 0.012);
    c.needs.satisfy('social', 0.16);
    c.emotion.pulse(0.45, 0.3, 'was petted');
    setEmote('heart', 1.6);
    if (c.asleep && Math.random() < 0.5) c.think('…five more minutes.');
  };

  c.callTo = (cell) => {
    if (!world.isWalkable(cell[0], cell[1])) return;
    c.signals.callCell = [Math.round(cell[0]), Math.round(cell[1])];
    c.signals.attention = 1;
    // A direct player command is an assignment, not merely another sensory
    // hint for the next think tick. Replace the current route immediately;
    // startTask preserves/settles its live one-cell segment before replanning.
    const action = actionById('answer_call');
    if (action) {
      c.asleep = false;
      finishTask({ preservePosition: true });
      startTask({ action, target: { obj: null, dist: 0, cell: c.signals.callCell }, score: 99 });
    }
    return true;
  };

  c.give = (item) => {
    c.holding = item;
    c.signals.attention = 1;
    c.emotion.pulse(0.3, 0.35, 'was given something');
    setEmote('food', 1.4);
    c.needs.satisfy('social', 0.1);
    c.think('for me?');
  };

  /** User clicked a piece of furniture: try to start the matching action.
   *  `onlyAct`, when given, tries just that one affordance instead of the
   *  first the object happens to offer — for objects with more than one
   *  (a sink offers both 'wash' and 'fill_can'), the click menu lets the
   *  player pick which. */
  c.suggest = (obj, onlyAct) => {
    c.signals.attention = 1;
    for (const act of onlyAct ? [onlyAct] : obj.def.acts) {
      const a = actionFor(act);
      if (!a) continue;
      let target = null;
      try { target = a.pick(c, world, c.percept); } catch { target = null; }
      if (!target) continue;
      // Point the action at the thing the user actually clicked, but only when
      // that object is the one supplying the affordance (the sofa supplies
      // 'lounge' for watch_tv, so don't swap the TV in for it).
      if (target.obj && target.obj !== obj && obj.def.acts.includes(act)
        && target.obj.def.acts.includes(act) && world.approachCells(obj).length) {
        target = { ...target, obj };
      }
      finishTask({ preservePosition: true });
      startTask({ action: a, target, score: 99 });
      c.think('alright, the ' + obj.label + '.');
      return true;
    }
    // Nothing it can do with that right now (an empty stove, a table with no
    // food on it). Rather than ignore the user, go and have a look at it.
    const look = actionById('investigate');
    if (look && world.approachCells(obj).length) {
      finishTask({ preservePosition: true });
      startTask({
        action: look, score: 99,
        target: { obj, dist: 0, novelty: c.memory.novelty(obj.id) },
      });
      setEmote('question', 1.2);
      return true;
    }
    c.emotion.pulse(-0.05, 0.2, 'not sure what to do with that');
    setEmote('question', 1.2);
    return false;
  };

  /** Step out through the door for a while. Called by the explore action once
   *  it has walked the critter to the doorway. */
  c.leaveToExplore = (minutesGone) => {
    c.away = true;
    c.awayTimer = minutesGone;
    c.task = null;
    c.think('off exploring…');
  };

  // ------------------------------------------------------------- main tick

  c.update = (dt) => {
    const hours = (dt * MINUTES_PER_SECOND) / 60;

    if (c.away) {
      // Time still passes while it's gone — needs still drift, curiosity and
      // company both get a little top-up, as if something out there happened.
      c.needs.update(hours, { fun: -2.5, social: -1, hygiene: 0.5 });
      c.awayTimer -= hours * 60;
      if (c.awayTimer <= 0) {
        c.away = false;
        c.gx = 0; c.gy = Math.round(DOOR_GY);
        c.px = c.gx; c.py = c.gy;
        c.memory.log('came back from outside');
        c.emotion.pulse(0.3, 0.3, 'back from an adventure');
        c.moodlets.add('explored');
        c.moodlets.remove('stir_crazy');
        const found = 4 + Math.floor(Math.random() * 13);
        world.earnCoins(found);
        if (Math.random() < 0.5) {
          const mats = 1 + Math.floor(Math.random() * 3);
          world.earnMaterials(mats);
          c.think(`home again. found ${found} coins and ${mats} scrap out there.`);
        } else {
          c.think('home again. found ' + found + ' coins out there.');
        }
      }
      return;
    }

    recoverFromBlockedCell();
    if (!c.moving) snapToCell(c.gx, c.gy);

    c.percept = perceive(c, world);

    // needs — sleep's own multipliers combine with whatever moodlets are active
    // (well-rested slows energy decay further, a messy room speeds up hygiene, etc.)
    const mods = c.asleep ? { hunger: 0.5, energy: 0, fun: 0.2, social: 0.4, hygiene: 0.5 } : {};
    const moodMods = c.moodlets.needMods();
    for (const k in moodMods) mods[k] = (mods[k] ?? 1) * moodMods[k];
    // a cold winter burns a little more energy and appetite; a warm summer eases both
    const season = world.season();
    if (season === 'winter') { mods.hunger = (mods.hunger ?? 1) * 1.15; mods.energy = (mods.energy ?? 1) * 1.1; }
    else if (season === 'summer') { mods.hunger = (mods.hunger ?? 1) * 0.9; }
    c.needs.update(hours, mods);
    c.memory.decaySatiation(hours);
    if (!c.asleep) c.awakeHours += hours;
    c.ageDays = Math.max(0, (world.day + world.minutes / 1440) - c.bornDay);
    if (c.stageIndex > c.stageIndexSeen) {
      c.stageIndexSeen = c.stageIndex;
      c.moodlets.add('birthday');
      c.emotion.pulse(0.6, 0.5, 'grew up');
      c.think(`I'm a ${c.stage.name} now!`);
      world.emitSound(c.gx, c.gy, 0.7, 'birthday');
      world.earnCoins(15);
    }

    // friendships fade a little without upkeep, same idea as habit satiation
    for (const id in c.relationships) c.relationships[id] = clamp(c.relationships[id] - hours * 0.004);

    c.moodlets.update(hours);
    if (c.needs.get('social') < 0.15 && !c.moodlets.has('lonely')) c.moodlets.add('lonely');
    if (world.messes.length >= 4 && !c.moodlets.has('messy_room')) c.moodlets.add('messy_room');
    if (c.boredom > 0.85 && !c.moodlets.has('stir_crazy')) c.moodlets.add('stir_crazy');

    // a want that never gets picked up eventually gives way to a fresher one
    c.whimAge += hours;
    if (c.whimAge > 20) { c.whim = rollWhim(rng, c.aspiration.id, c.whim.id); c.whimAge = 0; }

    // sustained neglect (not one bad hour, but many) eventually makes it sick;
    // steady good care brings it back down and clears the moodlet
    const wellbeing = c.needs.wellbeing();
    c.neglect = clamp((c.neglect ?? 0) + (wellbeing < 0.3 ? hours : -hours * 1.5), 0, 24);
    if (c.neglect >= 18 && !c.moodlets.has('unwell')) {
      c.moodlets.add('unwell');
      c.emotion.pulse(-0.3, -0.1, 'feeling unwell');
      c.think('not feeling great...');
    }
    if (c.neglect <= 2 && c.moodlets.has('unwell')) {
      c.moodlets.remove('unwell');
      c.emotion.pulse(0.2, 0, 'feeling better');
      c.think('feeling better now.');
    }

    // emotion
    const worst = c.needs.worst();
    c.emotion.update(dt, c.needs.wellbeing(), {
      urgency: worst.urgency,
      novelty: c.percept.novelty * (c.asleep ? 0 : 1),
      stimulation: c.percept.sound * 0.6 + (c.pose === 'play' ? 0.5 : 0),
      tired: clamp(c.awakeHours / 16) * (c.asleep ? 1.4 : 1),
      bond: c.bond,
      moodletPull: c.moodlets.valencePull(),
    });

    // signals fade
    c.signals.attention = approach(c.signals.attention, 0, 0.08, dt);
    c.signals.touch = approach(c.signals.touch, 0, 2.2, dt);

    // deliberate
    c.thinkT -= dt;
    if (c.thinkT <= 0) {
      c.thinkT = THINK_INTERVAL;
      const interrupt = c.brain.shouldInterrupt(c, world, c.percept, c.task);
      if (!c.task || interrupt) {
        if (c.task && interrupt) { c.asleep = false; finishTask({ preservePosition: true }); }
        const choice = c.brain.decide(c, world, c.percept);
        if (choice) startTask(choice);
      } else if (!c.asleep) {
        c.brain.observe(c, world, c.percept);
      }
    }

    if (c.task) runTask(dt);
    else c.pose = 'stand';

    // Never solve crowding with a fractional shove: that was the only code
    // path able to leave an idle critter balanced on a tile edge. Planned
    // steps reserve peer cells above; this is just a migration backstop for
    // an old save that already contains two stopped critters on one cell.
    if (!c.moving) {
      const stacked = (c.peers || []).find((p) => p !== c && !p.away && !p.moving
        && p.gx === c.gx && p.gy === c.gy && p.id < c.id);
      if (stacked) {
        const stepIndex = DIRS.findIndex(([dx, dy]) => wholeCellOpen(c.gx, c.gy, c.gx + dx, c.gy + dy));
        if (stepIndex >= 0) {
          const [dx, dy] = DIRS[stepIndex];
          c.task = null;
          c.dir = stepIndex;
          snapToCell(c.gx + dx, c.gy + dy);
        }
      }
    }

    // idle animation state
    c.blinkT -= dt;
    if (c.blinkT <= 0) { c.blink = 0.16; c.blinkT = 1.6 + Math.random() * 4; }
    c.blink = Math.max(0, c.blink - dt);
    if (!c.moving) c.bob = approach(c.bob, 0, 4, dt);
    if (c.emote) { c.emote.t += dt; if (c.emote.t > c.emote.dur) c.emote = null; }

    // eyes follow the most interesting thing in view
    const focus = c.percept.visible.find((v) => v.novelty > 0.25) || c.percept.nearest;
    c.lookAt = focus ? world.center(focus.obj) : null;

    // A roller advances exactly one whole tile. It never leaves a critter at
    // a fractional coordinate and never changes facing except as that cell
    // transition begins.
    if (!c.task && !c.asleep) {
      const push = world.rollerAt(c.gx, c.gy);
      if (push) {
        const nx = c.gx + push[0], ny = c.gy + push[1];
        if (wholeCellOpen(c.gx, c.gy, nx, ny)) {
          c.dir = DIRS.findIndex(([dx, dy]) => dx === push[0] && dy === push[1]);
          snapToCell(nx, ny);
        }
      }
    }

    // Strong invariant: only an active center-to-center walk may have
    // fractional visual coordinates. Every idle or interaction pose is
    // snapped to the exact center of its logical cell each frame.
    if (c.moving) clampToRoom(false);
    else snapToCell(c.gx, c.gy);
  };

  c.currentLabel = () => {
    if (c.away) return 'out exploring';
    if (c.asleep) return 'sleeping';
    return c.task ? c.task.action.label : 'thinking';
  };

  c.serialize = () => ({
    id: c.id, seed: c.seed, name: c.name, gx: c.gx, gy: c.gy, dir: c.dir,
    holding: c.holding, bond: c.bond, relationships: c.relationships,
    ageDays: c.ageDays, bornDay: c.bornDay, stageIndexSeen: c.stageIndexSeen, awakeHours: c.awakeHours,
    skill: c.skill, trait: c.trait, away: c.away, awayTimer: c.awayTimer,
    aspiration: c.aspiration, whim: c.whim, whimAge: c.whimAge, neglect: c.neglect,
    needs: c.needs.serialize(), emotion: c.emotion.serialize(),
    memory: c.memory.serialize(), brain: c.brain.serialize(),
    moodlets: c.moodlets.serialize(),
  });

  return c;
}
