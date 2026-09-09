// Bootstrap: build the world and the critter(s), wire input and the panels, run.

import { startLoop } from './core/loop.js';
import { createAudio } from './core/audio.js';
import { createWorld, ROOM_THEMES, MINUTES_PER_SECOND, DOOR_GY } from './world/world.js';
import { DEFS, PRICES, canOccupyObject } from './world/objects.js';
import { createCritter } from './creature/creature.js';
import { createRenderer } from './render/renderer.js';
import { createHud, renderCritterSwitcher } from './ui/hud.js';
import { preloadSprites } from './render/sprites.js';
import { actionFor } from './creature/actions.js';

const SAVE_KEY = 'iso-critter.v2';
const MAX_CRITTERS = 4;

preloadSprites([
  'loungeSofa', 'bedDouble', 'bookcaseOpen', 'chairRounded',
  'loungeChairRelax', 'benchCushion', 'tableCoffee', 'desk', 'chairDesk',
  'sideTableDrawers', 'plantSmall1', 'radio', 'cardboardBoxClosed',
  'stoolBar', 'bookcaseClosedDoors',
]);

const world = createWorld();
const save = loadSave();

const critters = (save?.critters?.length ? save.critters : [save?.critter].filter(Boolean))
  .map((c) => createCritter(world, c));
if (!critters.length) critters.push(createCritter(world, null));
world.restore(save?.world);

// Every critter gets a live reference to the shared roster — the array
// itself, not a copy — so 'socialize' can see the others (and any spawned
// later) without the world needing to know critters exist at all.
for (const c of critters) c.peers = critters;

let active = critters[0];

const canvas = document.getElementById('screen');
const stage = document.getElementById('stage');
const switchHost = document.getElementById('critter-switch');
const renderer = createRenderer(canvas, world);
const hud = createHud(world);
const audio = createAudio();
addEventListener('pointerdown', () => audio.unlock(), { once: true });
hud.setCritter(active);
renderer.hud.activeId = active.id;

renderer.resize(stage);
addEventListener('resize', () => renderer.resize(stage));
refreshSwitcher();

for (const b of document.querySelectorAll('[data-place]')) {
  const price = PRICES[b.dataset.place];
  if (price != null) b.title = DEFS[b.dataset.place].label + ' — ' + price + ' coins';
}

// ------------------------------------------------------------------ paint panel

function buildSwatches(room, hostId) {
  const host = document.getElementById(hostId);
  host.innerHTML = '';
  for (const [id, theme] of Object.entries(ROOM_THEMES)) {
    const b = document.createElement('button');
    b.className = 'swatch' + (world.decor[room] === id ? ' on' : '');
    b.style.background = theme.wall;
    b.title = theme.label;
    b.addEventListener('click', () => {
      world.decor[room] = id;
      for (const s of host.children) s.classList.remove('on');
      b.classList.add('on');
    });
    host.appendChild(b);
  }
}
buildSwatches('A', 'paint-a');
buildSwatches('B', 'paint-b');
buildSwatches('C', 'paint-c');

// ------------------------------------------------------------------ rename

document.getElementById('rename-btn').addEventListener('click', () => {
  const nameEl = document.getElementById('c-name');
  if (document.getElementById('c-name-input')) return;
  hud.setEditingName(true);
  const input = document.createElement('input');
  input.id = 'c-name-input';
  input.maxLength = 16;
  input.value = active.name;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    const val = input.value.trim();
    if (val) active.name = val.slice(0, 16);
    input.replaceWith(nameEl);
    hud.setEditingName(false);
    refreshSwitcher();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { input.value = active.name; commit(); }
  });
  input.addEventListener('blur', commit);
});

function setActive(c) {
  active = c;
  renderer.hud.activeId = c.id;   // whose plumbob to float
  hud.setCritter(active);
  refreshSwitcher();
}

function refreshSwitcher() {
  renderCritterSwitcher(switchHost, critters, active.id, setActive);
}

function spawnCritter() {
  if (critters.length >= MAX_CRITTERS) return;
  const cell = active.randomFreeCellNear(5) || [Math.floor(world.cols / 2), Math.floor(world.rows / 2)];
  const c = createCritter(world, { gx: cell[0], gy: cell[1] });
  c.peers = critters;
  critters.push(c);
  setActive(c);
}

// ------------------------------------------------------------------ visitor
// A random critter that isn't part of the household — it lets itself in,
// hangs around competing for the toys for a while, then heads back out.
// Never saved: it simply isn't there any more on the next load, same as if
// it had let itself out overnight.

const RIVAL_NAMES = ['Scamp', 'Ruckus', 'Momo', 'Ziggy', 'Snips', 'Puck'];
let visitor = null;
let visitorTimer = 0;        // in-world hours left before it heads out
let visitorLeaving = false;
let visitorLeaveGrace = 0;   // real seconds standing at the door before despawn
let nextVisitRoll = world.day + 1;

function maybeSpawnVisitor() {
  if (visitor || critters.length >= MAX_CRITTERS) return;
  // A visitor "wandering in through the door" while it's locked, or while
  // something's physically standing on the door cell, was never actually
  // checked — it force-wrote the spawn position regardless.
  if (world.doorLocked || !world.isWalkable(0, Math.round(DOOR_GY))) return;
  if (Math.random() > 0.35) return;
  const name = RIVAL_NAMES[Math.floor(Math.random() * RIVAL_NAMES.length)];
  const c = createCritter(world, { gx: 0, gy: Math.round(DOOR_GY), name, visitor: true, ageDays: 10 + Math.random() * 5 });
  c.peers = critters;
  critters.push(c);
  c.think(name + ' wandered in through the door.');
  flash(name + ' is visiting');
  visitor = c;
  visitorTimer = 3 + Math.random() * 4;
  visitorLeaving = false;
}

function updateVisitor(dt) {
  if (!visitor) return;
  if (!visitorLeaving) {
    visitorTimer -= (dt * MINUTES_PER_SECOND) / 60;
    if (visitorTimer <= 0) {
      visitorLeaving = true;
      visitorLeaveGrace = 1.5;
      visitor.task = null;
      visitor.gx = 0; visitor.gy = Math.round(DOOR_GY);
      visitor.px = visitor.gx; visitor.py = visitor.gy;
      visitor.think('time to head home.');
    }
  } else {
    visitorLeaveGrace -= dt;
    if (visitorLeaveGrace <= 0) {
      const idx = critters.indexOf(visitor);
      if (idx >= 0) critters.splice(idx, 1);
      if (active === visitor) setActive(critters[0]);
      refreshSwitcher();
      visitor = null;
      nextVisitRoll = world.day + 1 + Math.random() * 3;
    }
  }
}

// ------------------------------------------------------------------ room editor

// Selection and movement are intentionally different states. A single click
// may inspect a piece without making the next floor click mutate the room.
const editState = { active: false, placing: null, moving: false };

// Single-level undo: each mutating edit overwrites whatever was here before,
// so only the very last placement/move/remove/rotate can be taken back.
let lastEdit = null;
function setLastEdit(undo) {
  lastEdit = { undo };
  syncUndoButton();
}
function undoLastEdit() {
  if (!lastEdit) return;
  lastEdit.undo();
  lastEdit = null;
  syncUndoButton();
  renderer.editor.selectedId = null;
  editState.moving = false;
  syncEditButtons();
}
function syncUndoButton() {
  const b = document.getElementById('btn-undo');
  if (b) b.disabled = !lastEdit;
}

function setEditing(on) {
  editState.active = on;
  editState.placing = null;
  editState.moving = false;
  renderer.editor.selectedId = null;
  lastEdit = null;
  document.getElementById('edit-palette').classList.toggle('hidden', !on);
  document.getElementById('paint-panel').classList.toggle('hidden', !on);
  document.querySelector('[data-act="edit"]').classList.toggle('on', on);
  syncEditButtons();
  syncUndoButton();
  if (on) syncPaletteAffordability();
  document.getElementById('hint').textContent = on
    ? 'pick something to place, or select a piece · R rotates it'
    : 'double-click floor/rug to move · click furniture to inspect · right-click for actions';
}

function selectedObject() {
  return renderer.editor.selectedId == null ? null : world.byId(renderer.editor.selectedId);
}

function itemKind(o) {
  if (o.def.structural) return 'fixed room fixture';
  if (o.def.lie) return 'bed';
  if (o.def.acts?.includes('bathe') || o.def.acts?.includes('soak')) return 'bathing fixture';
  if (o.def.sit) return 'seating';
  if (o.def.surface) return 'surface';
  if (o.def.flat) return o.def.standOn ? 'wall decoration' : 'floor item';
  if (o.def.mobile) return 'movable toy';
  if (o.def.acts?.length) return 'interactive furniture';
  return 'furniture';
}

function syncItemInspector() {
  const panel = document.getElementById('item-inspector');
  const o = selectedObject();
  panel.classList.toggle('hidden', !o);
  if (!o) return;
  document.getElementById('item-name').textContent = o.label;
  const footprint = `${o.w}×${o.h} ${o.w * o.h === 1 ? 'tile' : 'tiles'}`;
  const facing = o.def.directional
    ? ` · direction ${(((o.type === 'chair' ? o.state.face : o.state.rotation) ?? 0) & 3) + 1}/4`
    : '';
  const interaction = canOccupyObject(o)
    ? 'entered to use'
    : o.def.acts?.length
      ? 'used from beside it'
      : 'not directly usable';
  document.getElementById('item-description').textContent = `${itemKind(o)} · ${interaction} · ${o.type.replaceAll('_', ' ')} · ${footprint}${facing}`;
  const fixed = !!o.def.structural;
  const turnable = !fixed;
  const rotateLeft = document.getElementById('item-rotate-left');
  const rotate = document.getElementById('item-rotate');
  const move = document.getElementById('item-move');
  rotateLeft.disabled = !turnable;
  rotate.disabled = !turnable;
  move.disabled = fixed;
  move.classList.toggle('on', editState.moving);
  move.textContent = editState.moving ? '✓ Moving' : '↔ Move';
  document.getElementById('item-tip').textContent = fixed
    ? 'This piece is part of the room and cannot be moved.'
    : editState.moving
      ? 'Choose an empty tile · R rotates · Escape cancels'
      : 'Use ↶ / ↷ or R to rotate · click again to move · click away to cancel.';
}

function clearItemSelection() {
  renderer.editor.selectedId = null;
  renderer.editor.ghost = null;
  editState.moving = false;
  syncEditButtons();
}

function selectItem(o) {
  editState.placing = null;
  editState.moving = false;
  renderer.editor.selectedId = o.id;
  for (const b of document.querySelectorAll('[data-place]')) b.classList.remove('armed');
  syncEditButtons();
}

function startMovingSelected() {
  const o = selectedObject();
  if (!o || o.def.structural) return;
  const occupied = critters.some((c) => !c.away
    && Math.round(c.px) >= o.gx && Math.round(c.px) < o.gx + o.w
    && Math.round(c.py) >= o.gy && Math.round(c.py) < o.gy + o.h);
  if (occupied) { flash(`${o.label} is currently in use`); return; }
  editState.moving = true;
  syncEditButtons();
}

function footprintHasCritter(gx, gy, w, h) {
  return critters.some((c) => !c.away
    && Math.round(c.px) >= gx && Math.round(c.px) < gx + w
    && Math.round(c.py) >= gy && Math.round(c.py) < gy + h);
}

function canPlaceSafely(type, gx, gy) {
  const def = DEFS[type];
  return world.canPlace(type, gx, gy)
    && (def?.flat || !footprintHasCritter(gx, gy, def.w, def.h));
}

function canMoveSafely(o, gx, gy) {
  for (let x = gx; x < gx + o.w; x++) {
    for (let y = gy; y < gy + o.h; y++) {
      if (!world.inBounds(x, y)) return false;
      const occ = world.objectAt(x, y);
      if (!o.def.flat && occ && occ !== o) return false;
      if (!o.def.flat && x === 0 && y === DOOR_GY) return false;
    }
  }
  return o.def.flat || !footprintHasCritter(gx, gy, o.w, o.h);
}

function moveSelectedTo(gx, gy) {
  const o = selectedObject();
  if (!o || o.def.structural || !editState.moving) return false;
  if (!canMoveSafely(o, gx, gy)) {
    flash(`there isn't room for ${o.label} there`);
    return false;
  }
  const prevGx = o.gx, prevGy = o.gy;
  if (!world.moveObject(o.id, gx, gy)) return false;
  setLastEdit(() => world.moveObject(o.id, prevGx, prevGy));
  editState.moving = false;
  renderer.editor.ghost = null;
  syncEditButtons();
  return true;
}

function rotateSelected(direction = 1) {
  const o = selectedObject();
  if (!o || o.def.structural) return;
  // Include both the current and possible turned footprint. A seated critter
  // or one standing in the space a long item would rotate into must never be
  // swallowed by a convenient keyboard turn.
  const turnW = o.def.rotatesFootprint ? o.h : o.w;
  const turnH = o.def.rotatesFootprint ? o.w : o.h;
  if (footprintHasCritter(o.gx, o.gy, o.w, o.h)
    || footprintHasCritter(o.gx, o.gy, turnW, turnH)) {
    flash(`${o.label} is currently in use`);
    return;
  }
  const previous = {
    face: o.state.face, rotation: o.state.rotation, flip: o.state.flip,
    w: o.w, h: o.h,
  };
  if (!world.rotateObject(o.id, direction)) {
    flash(`there isn't room to rotate ${o.label}`);
    return;
  }
  setLastEdit(() => {
    const restored = world.byId(o.id);
    if (restored) {
      restored.state.face = previous.face;
      restored.state.rotation = previous.rotation;
      restored.state.flip = previous.flip;
      restored.w = previous.w;
      restored.h = previous.h;
      world.rebuildCollision();
    }
  });
  syncEditButtons();
}

/** Grey out (and disable) any shop button the household can't currently
 *  afford, instead of only complaining after the tile is clicked. */
let lastAffordCoins = -1;
function syncPaletteAffordability() {
  if (world.coins === lastAffordCoins) return;
  lastAffordCoins = world.coins;
  for (const b of document.querySelectorAll('[data-place]')) {
    const price = PRICES[b.dataset.place] ?? 0;
    const affordable = world.coins >= price;
    b.disabled = !affordable;
    b.classList.toggle('unaffordable', !affordable);
  }
}

function syncEditButtons() {
  const o = selectedObject();
  const has = !!o && !o.def.structural;
  document.getElementById('btn-rotate').disabled = !has;
  document.getElementById('btn-remove').disabled = !has;
  document.getElementById('edit-hint').textContent = editState.placing
    ? 'click a floor tile to place it'
    : editState.moving ? 'moving — click an empty tile'
      : o ? 'selected — click again or choose Move' : '';
  syncItemInspector();
}

document.getElementById('btn-undo').addEventListener('click', undoLastEdit);

document.getElementById('edit-palette').addEventListener('click', (e) => {
  const placeBtn = e.target.closest('[data-place]');
  if (placeBtn) {
    const type = placeBtn.dataset.place;
    editState.placing = editState.placing === type ? null : type;
    editState.moving = false;
    renderer.editor.selectedId = null;
    for (const b of document.querySelectorAll('[data-place]')) b.classList.toggle('armed', b === placeBtn && editState.placing);
    syncEditButtons();
    return;
  }
  const actBtn = e.target.closest('[data-edit-act]');
  if (!actBtn || actBtn.disabled) return;
  const id = renderer.editor.selectedId;
  if (id == null) return;
  if (actBtn.dataset.editAct === 'rotate') {
    rotateSelected();
  } else if (actBtn.dataset.editAct === 'remove') {
    const o = world.byId(id);
    if (o) {
      const snap = { type: o.type, gx: o.gx, gy: o.gy, state: { ...o.state } };
      world.removeObject(id);
      setLastEdit(() => world.addObject(snap.type, snap.gx, snap.gy, { state: snap.state }));
    }
    renderer.editor.selectedId = null;
    editState.moving = false;
    syncEditButtons();
  }
});

document.getElementById('item-rotate').addEventListener('click', (e) => {
  e.stopPropagation();
  rotateSelected();
});
document.getElementById('item-rotate-left').addEventListener('click', (e) => {
  e.stopPropagation();
  rotateSelected(-1);
});
document.getElementById('item-move').addEventListener('click', (e) => {
  e.stopPropagation();
  if (editState.moving) {
    editState.moving = false;
    renderer.editor.ghost = null;
    syncEditButtons();
  } else {
    startMovingSelected();
  }
});

// ------------------------------------------------------------------ input

canvas.addEventListener('click', (e) => {
  if (editState.active) {
    const g = renderer.screenToGrid(e.clientX, e.clientY);
    const gx = Math.floor(g.gx), gy = Math.floor(g.gy);

    if (editState.placing) {
      const price = PRICES[editState.placing] ?? 0;
      if (canPlaceSafely(editState.placing, gx, gy)) {
        if (world.spendCoins(price)) {
          const obj = world.addObject(editState.placing, gx, gy);
          if (obj) {
            renderer.editor.selectedId = obj.id; // immediately ready for ↶ / ↷ / R
            setLastEdit(() => { world.removeObject(obj.id); world.earnCoins(price); });
          }
        } else {
          flash("can't afford that (" + price + ' coins)');
        }
      }
      editState.placing = null;
      for (const b of document.querySelectorAll('[data-place]')) b.classList.remove('armed');
      syncEditButtons();
      return;
    }

    // Resolve by the exact cell under the cursor — not renderer.pick()'s
    // click box, which for tall furniture (fridge, bookshelf, bed...) is
    // deliberately oversized well past its own tile so its sprite stays
    // clickable in normal play. In the editor that's exactly backwards: it
    // means the neighbour's box, not the floor tile you're aiming at, eats
    // your click whenever you try to move something into an adjacent or
    // wall-hugging cell. Precise per-cell lookup has no such halo, so a
    // click either lands on the object actually occupying that cell or on
    // open floor, matching what you're looking at.
    if (world.inBounds(gx, gy)) {
      const o = world.selectableAt(gx, gy);
      if (o) {
        if (renderer.editor.selectedId === o.id && !editState.moving) startMovingSelected();
        else if (renderer.editor.selectedId !== o.id) selectItem(o);
        return;
      }
      if (editState.moving) {
        moveSelectedTo(gx, gy);
        return;
      }
      if (renderer.editor.selectedId != null) {
        clearItemSelection();
        return;
      }
    }
    const hit = renderer.pick(e.clientX, e.clientY, critters);
    if (hit.kind === 'critter') hit.critter.pet();
    else if (hit.kind === 'none' && renderer.editor.selectedId != null) clearItemSelection();
    return;
  }

  const hit = renderer.pick(e.clientX, e.clientY, critters);
  // The second click of the floor/rug double-click is handled below. Do not
  // reopen a menu or arm rug movement in the moment before `dblclick` fires.
  if (e.detail > 1 && (hit.kind === 'floor' || (hit.kind === 'object' && hit.obj.type === 'rug'))) return;
  if (hit.kind === 'critter') {
    clearItemSelection();
    setActive(hit.critter);
    hit.critter.pet();
    return;
  }

  // First click only selects and explains a piece. A second click on that
  // same item deliberately arms movement, so clicking away after inspecting
  // it cannot accidentally rearrange the room.
  if (hit.kind === 'object') {
    if (renderer.editor.selectedId === hit.obj.id && !editState.moving) startMovingSelected();
    else if (renderer.editor.selectedId !== hit.obj.id) selectItem(hit.obj);
    return;
  }

  if (hit.kind === 'floor') {
    if (editState.moving) {
      moveSelectedTo(hit.cell[0], hit.cell[1]);
      return;
    }
    if (renderer.editor.selectedId != null) {
      clearItemSelection();
      return;
    }
    e.stopPropagation();
    showClickMenu(e.clientX, e.clientY, [{
      label: '📣 call here',
      run: () => { active.callTo(hit.cell); world.emitSound(hit.cell[0], hit.cell[1], 0.45, 'tap'); },
    }]);
    return;
  }
  if (hit.kind === 'none' && renderer.editor.selectedId != null) clearItemSelection();
});

canvas.addEventListener('dblclick', (e) => {
  if (editState.active) return;
  const g = renderer.screenToGrid(e.clientX, e.clientY);
  const gx = Math.floor(g.gx), gy = Math.floor(g.gy);
  if (!world.inBounds(gx, gy)) return;
  // Resolve the exact ground cell rather than a tall sprite's generous click
  // box. Bare floor and rugs are valid; a rug covered by real furniture is not.
  const ground = world.selectableAt(gx, gy);
  if (ground && ground.type !== 'rug') return;
  if (!world.isWalkable(gx, gy)) return;
  e.preventDefault();
  e.stopPropagation();
  hideClickMenu();
  clearItemSelection();
  active.callTo([gx, gy]);
  world.emitSound(gx, gy, 0.45, 'tap');
});

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (editState.active) return;
  const hit = renderer.pick(e.clientX, e.clientY, critters);
  if (hit.kind !== 'object') return;

  const options = [];
  if (hit.obj.type === 'jukebox') {
    // A direct switch, like the TV — otherwise nothing ever turns the
    // music back off once a critter has danced to it.
    options.push({
      label: (hit.obj.state.on ? '🔇 turn off' : '🎵 turn on'),
      run: () => {
        hit.obj.state.on = !hit.obj.state.on;
        world.emitSound(hit.obj.gx, hit.obj.gy, 0.6, hit.obj.state.on ? 'music on' : 'click');
      },
    });
  } else {
    for (const act of hit.obj.def.acts) {
      const a = actionFor(act);
      options.push({ label: a ? a.label : act, run: () => active.suggest(hit.obj, act) });
    }
  }
  if (!options.length) { active.suggest(hit.obj); return; }
  showClickMenu(e.clientX, e.clientY, options, hit.obj);
});

// ------------------------------------------------------------------ click menu
// A click opens a small menu of what's actually possible there instead of
// guessing a single action (floor used to always mean "call the critter
// here" even when that's not what the click was for).

function showClickMenu(clientX, clientY, options, obj) {
  const menu = document.getElementById('click-menu');
  const rect = stage.getBoundingClientRect();
  menu.innerHTML = '';
  if (obj) {
    const header = document.createElement('div');
    header.className = 'click-menu-header';
    header.textContent = obj.label;
    menu.appendChild(header);
    renderer.editor.menuHighlightId = obj.id;
  } else {
    renderer.editor.menuHighlightId = null;
  }
  for (const opt of options) {
    const b = document.createElement('button');
    b.textContent = opt.label;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      hideClickMenu();
      opt.run();
    });
    menu.appendChild(b);
  }
  // Offset well clear of the cursor (and whatever was clicked) rather than
  // popping up right on top of it.
  const OFFSET = 36;
  const x = Math.min(clientX - rect.left + OFFSET, rect.width - 150);
  const y = Math.min(clientY - rect.top + OFFSET, rect.height - 40 * options.length - 30);
  menu.style.left = Math.max(4, x) + 'px';
  menu.style.top = Math.max(4, y) + 'px';
  menu.classList.remove('hidden');
}

function hideClickMenu() {
  document.getElementById('click-menu').classList.add('hidden');
  renderer.editor.menuHighlightId = null;
}

document.addEventListener('click', () => hideClickMenu());

canvas.addEventListener('mousemove', (e) => {
  if (editState.active && editState.placing) {
    const g = renderer.screenToGrid(e.clientX, e.clientY);
    const gx = Math.floor(g.gx), gy = Math.floor(g.gy);
    const type = editState.placing;
    const def = DEFS[type] || { w: 1, h: 1 };
    const affordable = world.coins >= (PRICES[type] ?? 0);
    renderer.editor.ghost = { gx, gy, w: def.w, h: def.h, valid: canPlaceSafely(type, gx, gy) && affordable };
    canvas.style.cursor = 'copy';
    return;
  }
  // Moving a piece already in the room gets the same live footprint preview
  // as placing a new one. Without it you're aiming at a cell you can't see,
  // which is nearly impossible where tall pieces stand shoulder to shoulder
  // and their sprites cover the very tiles you're trying to drop onto.
  if (editState.moving && renderer.editor.selectedId != null) {
    const sel = world.byId(renderer.editor.selectedId);
    if (sel) {
      const g = renderer.screenToGrid(e.clientX, e.clientY);
      const gx = Math.floor(g.gx), gy = Math.floor(g.gy);
      const fits = canMoveSafely(sel, gx, gy);
      renderer.editor.ghost = { gx, gy, w: sel.w, h: sel.h, valid: fits };
      renderer.hud.hoverObjId = null;
      renderer.hud.hoverGx = gx; renderer.hud.hoverGy = gy;
      canvas.style.cursor = fits ? 'move' : 'not-allowed';
      return;
    }
  }
  renderer.editor.ghost = null;
  const hit = renderer.pick(e.clientX, e.clientY, critters);
  canvas.style.cursor = hit.kind === 'none' ? 'default' : 'pointer';
  canvas.title = hit.kind === 'object' ? hit.obj.label : '';
  // Feed the tile marker: the piece under the cursor if there is one, else
  // the bare tile, so the pointer always has something under it to light up.
  const g = renderer.screenToGrid(e.clientX, e.clientY);
  renderer.hud.hoverObjId = hit.kind === 'object' ? hit.obj.id : null;
  renderer.hud.hoverGx = Math.floor(g.gx);
  renderer.hud.hoverGy = Math.floor(g.gy);
});

canvas.addEventListener('mouseleave', () => {
  renderer.hud.hoverGx = null;
  renderer.hud.hoverGy = null;
  renderer.hud.hoverObjId = null;
});

let jukeboxWasOn = false;
const SEASON_EMOJI = { spring: '🌱', summer: '☀️', autumn: '🍂', winter: '❄️' };
const WEATHER_EMOJI = { clear: '', cloudy: '☁️', rain: '🌧️', snow: '🌨️' };
let lastSeasonLabel = '';

const loop = startLoop({
  update(dt) {
    world.tick(dt);
    for (const c of critters) c.update(dt);
    updateVisitor(dt);
    if (world.day >= nextVisitRoll) {
      nextVisitRoll = world.day + 1 + Math.random() * 2;
      maybeSpawnVisitor();
    }
  },
  render(dt) {
    renderer.render(critters, dt);
    hud.update(dt, critters);
    document.getElementById('coins').textContent = '🪙 ' + world.coins;
    if (editState.active) syncPaletteAffordability();
    const season = world.season();
    const seasonLabel = WEATHER_EMOJI[world.weather] + SEASON_EMOJI[season] + ' ' + season;
    if (seasonLabel !== lastSeasonLabel) {
      const el = document.getElementById('season');
      el.textContent = seasonLabel;
      el.title = `${season[0].toUpperCase()}${season.slice(1)} — ${world.weather}`;
      lastSeasonLabel = seasonLabel;
    }

    for (const ev of world.drainAudioQueue()) audio.play(ev.tag, ev.loud);
    const jukebox = world.first('jukebox');
    const jukeboxOn = !!(jukebox && jukebox.state.on);
    if (jukeboxOn && !jukeboxWasOn) audio.startMusic();
    if (!jukeboxOn && jukeboxWasOn) audio.stopMusic();
    jukeboxWasOn = jukeboxOn;
  },
});

// ------------------------------------------------------------------ toolbar

function setSpeed(speed) {
  loop.speed = speed;
  for (const b of document.querySelectorAll('.speed')) b.classList.toggle('on', Number(b.dataset.speed) === speed);
}

document.getElementById('toolbar').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;

  if (btn.dataset.speed) {
    setSpeed(Number(btn.dataset.speed));
    return;
  }

  switch (btn.dataset.act) {
    case 'pet': active.pet(); break;
    case 'call': {
      const cell = active.frontRowCell();
      if (cell) active.callTo(cell);
      break;
    }
    case 'snack':
      active.give('meal');
      break;
    case 'tv': {
      const tv = world.first('tv');
      if (tv) {
        tv.state.on = !tv.state.on;
        world.emitSound(tv.gx, tv.gy, 0.6, 'tv');
      }
      break;
    }
    case 'light': {
      const lamp = world.first('lamp');
      if (!lamp) { flash('no lamp in the house to switch'); break; }
      world.lightsForced = world.lightsForced === null ? !lamp.state.on : !world.lightsForced;
      break;
    }
    case 'door':
      world.doorLocked = !world.doorLocked;
      btn.textContent = world.doorLocked ? '🔒 Door' : '🔓 Door';
      break;
    case 'edit':
      setEditing(!editState.active);
      break;
    case 'add-critter':
      spawnCritter();
      break;
    case 'mute':
      audio.muted = !audio.muted;
      btn.textContent = audio.muted ? '🔇' : '🔊';
      // Muting stops the music directly (audio.js's own setter), but
      // unmuting never restarted it — jukeboxWasOn was already `true` from
      // before the mute, so the edge-triggered check in the render loop
      // never fired again. An on jukebox stayed silent until switched off
      // and back on.
      if (!audio.muted && jukeboxWasOn) audio.startMusic();
      break;
    case 'debug':
      document.getElementById('panel-right').classList.toggle('hidden');
      btn.classList.toggle('on');
      renderer.resize(stage);
      break;
    case 'grid': {
      const input = document.getElementById('show-grid');
      renderer.overlays.grid = !renderer.overlays.grid;
      input.checked = renderer.overlays.grid;
      btn.classList.toggle('on', renderer.overlays.grid);
      break;
    }
  }
});

document.getElementById('toolbar').querySelector('[data-act="door"]').textContent =
  world.doorLocked ? '🔒 Door' : '🔓 Door';

// ------------------------------------------------------------------ inspector

for (const input of document.querySelectorAll('input[name=brain]')) {
  input.addEventListener('change', () => {
    if (input.checked) active.brain.mode = input.value;
  });
}
// Reflect the active critter's brain mode whenever the panel is drawn.
setInterval(() => {
  for (const input of document.querySelectorAll('input[name=brain]')) {
    input.checked = input.value === active.brain.mode;
  }
}, 500);

const bindOverlay = (id, key) => {
  const el = document.getElementById(id);
  el.addEventListener('change', () => {
    renderer.overlays[key] = el.checked;
    if (key === 'grid') {
      document.querySelector('[data-act="grid"]').classList.toggle('on', el.checked);
    }
  });
};
bindOverlay('show-vision', 'vision');
bindOverlay('show-path', 'path');
bindOverlay('show-grid', 'grid');

document.getElementById('btn-save').addEventListener('click', () => { doSave(); flash('saved'); });
document.getElementById('btn-reset').addEventListener('click', () => {
  if (!confirm('Start over with a brand new household? This erases everything currently saved.')) return;
  saveSuspended = true;   // otherwise beforeunload's autosave races the reload and undoes this
  localStorage.removeItem(SAVE_KEY);
  location.reload();
});

const SPEED_KEYS = { 1: 1, 2: 4, 3: 16 };

addEventListener('keydown', (e) => {
  if (document.activeElement?.tagName === 'INPUT') return;   // don't hijack the rename box
  if (e.key === '`' || e.key === '~') document.querySelector('[data-act=debug]').click();
  if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'g') {
    document.querySelector('[data-act=grid]').click();
  }
  if (e.key === ' ') { loop.running = !loop.running; e.preventDefault(); }
  if (SPEED_KEYS[e.key]) setSpeed(SPEED_KEYS[e.key]);
  if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'r' && selectedObject()) {
    rotateSelected(e.shiftKey ? -1 : 1);
    e.preventDefault();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && editState.active) { e.preventDefault(); undoLastEdit(); }
  if (e.key === 'Escape' && (editState.active || renderer.editor.selectedId != null)) {
    editState.placing = null;
    editState.moving = false;
    renderer.editor.selectedId = null;
    renderer.editor.ghost = null;
    for (const b of document.querySelectorAll('[data-place]')) b.classList.remove('armed');
    syncEditButtons();
  }
});

document.querySelector('[data-act="shortcuts"]').addEventListener('click', () => {
  document.getElementById('shortcuts-legend').classList.toggle('hidden');
});

// ------------------------------------------------------------------ save

let saveSuspended = false;

function doSave() {
  if (saveSuspended) return;
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      v: 2, critters: critters.filter((c) => !c.visitor).map((c) => c.serialize()), world: world.serialize(),
    }));
  } catch (err) { console.warn('save failed', err); }
}

function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

setInterval(doSave, 20000);
addEventListener('beforeunload', doSave);

function flash(text) {
  const el = document.getElementById('hint');
  const old = el.textContent;
  el.textContent = text;
  setTimeout(() => { el.textContent = old; }, 1200);
}

// Expose for tinkering from the console. `critter` always reflects whichever
// one is currently active/selected, even after a switch.
window.critters = critters;
Object.defineProperty(window, 'critter', { get: () => active, configurable: true });
window.world = world;
window.loop = loop;
window.renderer = renderer;
