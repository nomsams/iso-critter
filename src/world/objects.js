// Furniture definitions: footprint, physical properties, what the critter can do
// with them (affordances) and how they are drawn.
//
// Adding a new piece of furniture is meant to be a single entry here plus one
// action in creature/actions.js — nothing else in the codebase needs to change.

import { HW, HH, isoBox, isoPlate, boxFace, localOffset } from '../render/iso.js';
import { PAL } from '../render/palette.js';
import { drawSprite } from '../render/sprites.js';

const rect = (ctx, x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); };

/** A catalog item backed by one of Kenney's four isometric sprite views.
 *  The room camera is fixed, so `state.rotation` chooses which compass view
 *  to draw and, for rectangular pieces, which way its collision footprint
 *  runs across the floor. */
function kenneyItem(label, sprite, opts = {}) {
  const {
    w = 1, h = 1, tall = 20, solid = true, acts = [],
    sit = false, lie = false, occupiable = false, seatH = 6, surface = false,
    blocksSight = false, thirsty = false,
  } = opts;
  return {
    label, w, h, tall, solid, acts, sit, lie, occupiable, seatH, surface,
    blocksSight, thirsty,
    rotatable: true,
    directional: true,
    rotatesFootprint: w !== h,
    draw(ctx, x, y, o) {
      if (drawSprite(ctx, x, y, sprite, {
        w: o.w, h: o.h, angleOffset: o.state.rotation ?? 0,
      })) return;
      // Assets are preloaded, but retain a small physical placeholder for the
      // very first frame on a slow disk rather than letting the piece vanish.
      isoBox(ctx, x, y, o.w, o.h, Math.min(tall, 14), PAL.woodL, PAL.wood, PAL.woodD);
    },
  };
}

/** Recompute an object's live footprint from its base definition and facing.
 *  Exported for save restore, where state is applied after construction. */
export function syncObjectFootprint(o) {
  const quarterTurn = o.def.rotatesFootprint && ((o.state.rotation ?? 0) & 1);
  o.w = quarterTurn ? o.def.h : o.def.w;
  o.h = quarterTurn ? o.def.w : o.def.h;
  return o;
}

export const DEFS = {

  // A wall feature rather than furniture — the renderer paints it directly
  // onto the wall it sits against, but it still needs to exist as an object
  // so the critter can perceive it and stand at it.
  window: {
    label: 'window', w: 1, h: 1, tall: 0, solid: false, flat: true, standOn: true,
    acts: ['gaze'], faceDir: 3,
    draw() { /* painted onto the wall by the renderer */ },
  },

  fridge: {
    label: 'fridge', w: 1, h: 1, tall: 30, solid: true, blocksSight: true,
    acts: ['fetch_food'], frontDir: 1,   // door swings open toward +gy, into the room
    draw(ctx, x, y, o) {
      isoBox(ctx, x, y, 1, 1, 30, PAL.whiteD, PAL.white, PAL.whiteS);
      boxFace(ctx, x, y, 1, 1, 'right', 0.08, 0.92, 1, 17, '#d9d3e6');       // lower door
      boxFace(ctx, x, y, 1, 1, 'right', 0.08, 0.92, 19, 29, '#d9d3e6');      // freezer
      boxFace(ctx, x, y, 1, 1, 'right', 0.14, 0.22, 4, 15, PAL.steel);       // handles
      boxFace(ctx, x, y, 1, 1, 'right', 0.14, 0.22, 21, 27, PAL.steel);
      boxFace(ctx, x, y, 1, 1, 'left', 0.08, 0.92, 1, 29, '#c0b9d2');
      if (o.state.open) boxFace(ctx, x, y, 1, 1, 'right', 0.08, 0.92, 1, 17, '#cfe9f2');
    },
  },

  stove: {
    label: 'stove', w: 1, h: 1, tall: 18, solid: true,
    acts: ['cook'],
    draw(ctx, x, y, o, t) {
      isoBox(ctx, x, y, 1, 1, 18, PAL.steelL, PAL.steel, PAL.steelD);
      isoPlate(ctx, x + 4, y + 2, 0.42, 0.42, 18, PAL.black);
      isoPlate(ctx, x - 6, y + 8, 0.42, 0.42, 18, PAL.black);
      boxFace(ctx, x, y, 1, 1, 'right', 0.15, 0.85, 3, 14, '#4b5262');
      if (o.state.on) {
        const f = 0.5 + 0.5 * Math.sin(t * 9);
        ctx.globalAlpha = 0.55 + 0.45 * f;
        isoPlate(ctx, x + 4, y + 2, 0.42, 0.42, 18, '#ff7a3d');
        ctx.globalAlpha = 1;
        boxFace(ctx, x, y, 1, 1, 'right', 0.18, 0.82, 4, 13,
          'rgba(255,140,60,' + (0.35 + 0.3 * f).toFixed(2) + ')');
      }
    },
  },

  counter: {
    label: 'counter', w: 1, h: 1, tall: 17, solid: true,
    acts: [],
    draw(ctx, x, y) {
      isoBox(ctx, x, y, 1, 1, 15, PAL.woodD, PAL.wood, '#5d3f27');
      isoPlate(ctx, x, y, 1, 1, 17, PAL.steelL);
      boxFace(ctx, x, y, 1, 1, 'right', 0.06, 0.94, 3, 13, '#7a5335');
      boxFace(ctx, x, y, 1, 1, 'right', 0.44, 0.56, 3, 13, PAL.woodD);
    },
  },

  sink: {
    label: 'sink', w: 1, h: 1, tall: 17, solid: true,
    acts: ['wash', 'fill_can'],
    draw(ctx, x, y, o, t) {
      isoBox(ctx, x, y, 1, 1, 15, PAL.whiteS, PAL.white, PAL.whiteD);
      isoPlate(ctx, x, y, 1, 1, 17, PAL.steelL);
      isoPlate(ctx, x + 1, y + 2, 0.66, 0.66, 16.4, PAL.steelD);
      rect(ctx, x - 1, y - 4, 2, 5, PAL.steel);
      rect(ctx, x - 1, y - 5, 5, 2, PAL.steel);
      if (o.state.on) rect(ctx, x + 2, y - 3, 1, 6 + ((t * 40) % 3), PAL.glass);
    },
  },

  table: {
    label: 'table', w: 2, h: 1, tall: 15, solid: true, surface: true,
    rotatable: true, directional: true, rotatesFootprint: true,
    acts: ['eat_at'],
    draw(ctx, x, y, o) {
      const w = o.w, h = o.h;
      for (const [lx, ly] of [[0.18, 0.18], [w - 0.18, 0.18], [0.18, h - 0.18], [w - 0.18, h - 0.18]]) {
        const px = x + (lx - ly) * HW, py = y + (lx + ly) * HH;
        rect(ctx, px - 1, py - 15, 2, 15, PAL.woodD);
      }
      isoPlate(ctx, x, y, w, h, 15, PAL.woodL);
      ctx.globalAlpha = 0.22;
      isoPlate(ctx, x + 1, y + 1, Math.max(0.4, w - 0.14), Math.max(0.4, h - 0.12), 15, PAL.woodD);
      ctx.globalAlpha = 1;
      if (o.state.plate) {
        isoPlate(ctx, x + 5, y + 2, 0.5, 0.5, 15.5, PAL.white);
        if (o.state.plate === 'meal') {
          rect(ctx, x + 3, y + 1, 4, 3, PAL.warm);
          rect(ctx, x + 4, y - 1, 2, 2, PAL.red);
        } else {
          rect(ctx, x + 3, y + 2, 4, 2, '#b96f5a');
        }
      }
    },
  },

  chair: {
    label: 'chair', w: 1, h: 1, tall: 10, solid: false, sit: true, seatH: 6,
    rotatable: true, directional: true,
    acts: ['lounge'],
    // state.face is which way the seat opens: 0=+gx 1=+gy(default) 2=-gx 3=-gy.
    // A chair pulled up to a table needs its back to the room and its seat
    // open toward whatever it's pulled up to, not just one fixed orientation.
    draw(ctx, x, y, o) {
      const face = o.state.face ?? 1;
      if (drawSprite(ctx, x, y, 'chairRounded', { w: 1, h: 1, angleOffset: face })) return;
      const ox = x, oy = y + 3;                       // seat inset into the cell
      const shift = localOffset;                       // rotation-aware, so legs track the seat when the camera spins
      const CORNERS = { n: [0, 0], e: [0.72, 0], s: [0, 0.72], f: [0.72, 0.72] };
      // [backrest anchor local (gx,gy), backrest (w,h), hidden corner key]
      const FACES = {
        0: [[0, 0], [0.14, 0.72], 'n'],
        1: [[0, 0], [0.72, 0.14], 'n'],
        2: [[0.58, 0], [0.14, 0.72], 'e'],
        3: [[0, 0.58], [0.72, 0.14], 's'],
      };
      const [anchor, dims, hidden] = FACES[face] ?? FACES[1];
      const [bx, by] = shift(anchor[0], anchor[1]);
      isoBox(ctx, ox + bx, oy + by, dims[0], dims[1], 21, PAL.wood, PAL.woodD, '#5d3f27');

      for (const key of Object.keys(CORNERS)) {
        if (key === hidden) continue;
        const [dgx, dgy] = CORNERS[key];
        const [dx, dy] = shift(dgx, dgy);
        rect(ctx, ox + dx - 1, oy + dy - 10, 2, 10, PAL.woodD);
      }
      isoPlate(ctx, ox, oy, 0.72, 0.72, 10, PAL.wood);
    },
  },

  toilet: {
    // Sat on, not approached — a stand-beside-and-use toilet always looked
    // wrong next to a bathtub/shower that are properly entered. Joining the
    // same occupiable category (footprint becomes the destination, not a
    // ring around it) fixes both the pose and the position at once.
    label: 'toilet', w: 1, h: 1, tall: 16, solid: false, sit: true, seatH: 6, faceDir: 1,
    acts: ['relieve'],
    draw(ctx, x, y) {
      isoBox(ctx, x + 3, y + 4, 0.5, 0.5, 8, PAL.white, PAL.whiteD, PAL.whiteS);
      isoPlate(ctx, x + 3, y + 3, 0.58, 0.58, 9, PAL.whiteS);
      isoPlate(ctx, x + 3, y + 3, 0.36, 0.36, 9.3, '#a9c6d6');
      isoBox(ctx, x - 4, y - 3, 0.5, 0.5, 16, PAL.white, PAL.whiteD, PAL.whiteS);
    },
  },

  shower: {
    label: 'shower', w: 1, h: 1, tall: 4, solid: false, sit: true,
    acts: ['bathe'],
    draw(ctx, x, y, o, t) {
      isoPlate(ctx, x, y, 1, 1, 0.5, '#93a1ad');
      isoPlate(ctx, x, y, 1, 1, 2, '#cdd8e0');
      rect(ctx, x - 1, y - 24, 2, 9, PAL.steel);
      rect(ctx, x - 4, y - 17, 7, 2, PAL.steelL);
      if (o.state.on) {
        ctx.fillStyle = 'rgba(160,215,235,0.5)';
        for (let i = 0; i < 18; i++) {
          const p = (t * 26 + i * 3.1) % 15;
          ctx.fillRect(x - 4 + (i % 7), y - 14 + p, 1, 2);
        }
      }
    },
  },

  bed: {
    label: 'bed', w: 2, h: 2, tall: 15, solid: false, sit: true, lie: true, seatH: 6,
    rotatable: true, directional: true,
    acts: ['sleep'],
    draw(ctx, x, y, o) {
      if (drawSprite(ctx, x, y, 'bedDouble', {
        w: 2, h: 2, tall: 34, angleOffset: o.state.rotation ?? 0,
      })) return;
      isoBox(ctx, x, y, 2, 2, 6, PAL.woodD, PAL.wood, '#5d3f27');
      isoPlate(ctx, x, y, 2, 2, 9, '#6f7fb5');
      isoPlate(ctx, x, y, 2, 1.2, 9.4, '#8b9ad0');
      isoPlate(ctx, x + 2, y + 2, 0.8, 0.55, 10, PAL.white);
    },
  },

  sofa: {
    label: 'sofa', w: 1, h: 2, tall: 20, solid: false, sit: true, seatH: 8,
    rotatable: true, directional: true, rotatesFootprint: true,
    acts: ['lounge'],
    draw(ctx, x, y, o) {
      if (drawSprite(ctx, x, y, 'loungeSofa', {
        w: o.w, h: o.h, angleOffset: o.state.rotation ?? 0,
      })) return;
      isoBox(ctx, x, y, Math.min(0.32, o.w), o.h, 20, PAL.fabricL, PAL.fabric, PAL.fabricD);   // backrest
      isoBox(ctx, x, y, o.w, o.h, 8, PAL.fabricL, PAL.fabric, PAL.fabricD);       // seat
      isoBox(ctx, x, y, 1, 0.26, 13, PAL.fabricL, PAL.fabric, PAL.fabricD);   // near armrest
      isoBox(ctx, x - 1.74 * HW, y + 1.74 * HH, 1, 0.26, 13,
        PAL.fabricL, PAL.fabric, PAL.fabricD);                                // far armrest
      isoPlate(ctx, x - 6, y + 12, 0.5, 0.5, 8.6, '#6fb8bb');                 // cushion
    },
  },

  tv: {
    label: 'TV', w: 1, h: 1, tall: 28, solid: true, blocksSight: true,
    acts: ['watch_tv'], emitsWhenOn: { light: 0.45, sound: 0.85 }, backDir: 0,   // screen faces away from +gx
    draw(ctx, x, y, o, t) {
      isoBox(ctx, x, y + 3, 0.62, 0.62, 4, '#4a4468', '#39344f', '#2e2a42');   // foot
      rect(ctx, x - 2, y - 4, 5, 12, '#39344f');                               // neck
      const sy = y - 18;
      rect(ctx, x - 10, sy - 1, 20, 16, '#39344f');                            // bezel
      rect(ctx, x - 9, sy, 18, 14, o.state.on ? PAL.screenOn : PAL.screen);
      if (o.state.on) {
        for (let i = 0; i < 6; i++) {
          const b = Math.sin(t * 4 + i * 1.7) * 0.5 + 0.5;
          rect(ctx, x - 8 + i * 3, sy + 1 + Math.floor(b * 8), 2, 3 + Math.floor(b * 3),
            i % 2 ? '#5fb6d8' : '#e8f6ff');
        }
      } else {
        rect(ctx, x - 9, sy, 18, 4, '#1e2136');
      }
    },
  },

  rug: {
    label: 'rug', w: 2, h: 2, tall: 0, solid: false, flat: true,
    acts: [],
    draw(ctx, x, y) {
      isoPlate(ctx, x, y, 2, 2, 0.3, '#8a5566');
      isoPlate(ctx, x, y + 2, 1.75, 1.75, 0.4, '#a06a7a');
      isoPlate(ctx, x, y + 4, 1.3, 1.3, 0.5, '#8a5566');
    },
  },

  lamp: {
    label: 'lamp', w: 1, h: 1, tall: 36, solid: true,
    acts: ['toggle_light'], emitsWhenOn: { light: 0.95, sound: 0 },
    draw(ctx, x, y, o) {
      if (o.state.on) {
        ctx.fillStyle = 'rgba(255,222,150,0.09)';
        ctx.beginPath(); ctx.ellipse(x, y + 6, 30, 18, 0, 0, 7); ctx.fill();
      }
      isoPlate(ctx, x, y + 2, 0.55, 0.55, 1, PAL.woodD);
      rect(ctx, x - 1, y - 26, 2, 30, PAL.woodD);
      ctx.fillStyle = o.state.on ? '#ffe6a8' : '#bdb4a0';
      ctx.beginPath();
      ctx.moveTo(x - 8, y - 26); ctx.lineTo(x + 8, y - 26);
      ctx.lineTo(x + 5, y - 37); ctx.lineTo(x - 5, y - 37);
      ctx.closePath(); ctx.fill();
      if (o.state.on) rect(ctx, x - 7, y - 27, 14, 2, '#fff4d0');
    },
  },

  plant: {
    label: 'plant', w: 1, h: 1, tall: 28, solid: true,
    acts: ['sniff', 'water'], thirsty: true,
    draw(ctx, x, y, o, t) {
      isoBox(ctx, x + 2, y + 5, 0.5, 0.5, 9, '#b5714e', '#9a5c3d', '#844d32');
      const thirst = o.state.thirst || 0;
      const sway = Math.sin(t * 1.1 + o.gx) * 1.3 * (1 - thirst * 0.7);
      const droop = thirst * 4;
      const mix = (a, b) => {
        const p = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
        const [r1, g1, b1] = p(a), [r2, g2, b2] = p(b);
        const f = thirst;
        return `rgb(${r1 + (r2 - r1) * f | 0},${g1 + (g2 - g1) * f | 0},${b1 + (b2 - b1) * f | 0})`;
      };
      ctx.fillStyle = mix(PAL.greenD, '#8a6b35');
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        ctx.beginPath();
        ctx.ellipse(x + Math.cos(a) * 5 + sway, y - 5 + droop + Math.sin(a) * 3, 4, 6, a + droop * 0.1, 0, 7);
        ctx.fill();
      }
      ctx.fillStyle = mix(PAL.green, '#a68b46');
      ctx.beginPath(); ctx.ellipse(x + sway, y - 12 + droop, 5, 7 - thirst * 2, 0, 0, 7); ctx.fill();
      if (thirst > 0.65) {
        ctx.fillStyle = 'rgba(200,170,110,0.9)';
        ctx.fillRect(x + 5, y - 2 + droop, 2, 1);
        ctx.fillRect(x - 7, y + 1 + droop, 2, 1);
      }
    },
  },

  ball: {
    label: 'ball', w: 1, h: 1, tall: 8, solid: false, mobile: true,
    acts: ['kick'],
    draw(ctx, x, y, o) {
      const cx = x, cy = y + 8 - 4 - (o.hop || 0);
      ctx.fillStyle = PAL.shadow;
      ctx.beginPath(); ctx.ellipse(x, y + 8, 4.5, 2.2, 0, 0, 7); ctx.fill();
      ctx.fillStyle = '#e8635e';
      ctx.beginPath(); ctx.arc(cx, cy, 4.5, 0, 7); ctx.fill();
      ctx.fillStyle = '#f2f0f8';
      ctx.beginPath();
      ctx.ellipse(cx, cy, 4.5, 1.6, Math.sin((o.spin || 0)) * 0.9, 0, 7);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.beginPath(); ctx.arc(cx - 1.6, cy - 1.8, 1.2, 0, 7); ctx.fill();
    },
  },

  toybox: {
    label: 'toy box', w: 1, h: 1, tall: 13, solid: true,
    acts: ['play'],
    draw(ctx, x, y) {
      isoBox(ctx, x, y, 1, 1, 11, '#c4643f', '#a94f30', '#8c4027');
      isoPlate(ctx, x, y, 1, 1, 12, '#d97b52');
      rect(ctx, x + 2, y + 3, 3, 3, PAL.warm);
      rect(ctx, x - 6, y + 6, 3, 3, PAL.fabricL);
      rect(ctx, x - 1, y + 1, 3, 3, PAL.pink);
    },
  },

  bookshelf: {
    label: 'shelf', w: 1, h: 1, tall: 34, solid: true, blocksSight: true,
    acts: ['read'], frontDir: 0,   // a shallow box set back against the wall; only readable from +gx
    draw(ctx, x, y, o) {
      // The shelf is a shallow box (h=0.5) set back against the wall; every
      // book sits on the FRONT face of that box via boxFace so they scale and
      // shear with perspective the same way the rest of the furniture does.
      isoBox(ctx, x, y, 1, 0.5, 34, PAL.woodD, PAL.wood, '#5d3f27');
      const cols = ['#c4643f', '#5aa363', '#e0a05a', '#7f8fd0', '#d9625c', '#e8e4f0'];
      const held = o.state.borrowed;
      for (let shelf = 0; shelf < 3; shelf++) {
        const h0 = 8 + shelf * 9, h1 = h0 + 7;
        let n = 0;
        for (let i = 0; i < 6; i++) {
          if (held === shelf * 6 + i) continue;          // that one is out being read
          const u0 = 0.06 + n * 0.15, u1 = u0 + 0.12;
          boxFace(ctx, x, y, 1, 0.5, 'right', u0, u1, h0 + (i % 3) * 0.6, h1, cols[(i + shelf) % 6]);
          n++;
        }
        boxFace(ctx, x, y, 1, 0.5, 'right', 0.02, 0.98, h0 - 1.4, h0 - 0.6, PAL.woodD);
      }
    },
  },

  trashcan: {
    label: 'trash can', w: 1, h: 1, tall: 14, solid: true,
    acts: ['take_out_trash'],
    draw(ctx, x, y, o) {
      const level = o.state.level || 0;
      isoBox(ctx, x, y, 0.62, 0.62, 13, '#7a8090', '#626775', '#4f5460');
      isoPlate(ctx, x, y, 0.62, 0.62, 13, '#8b91a0');
      if (level > 0.15) {
        boxFace(ctx, x, y, 0.62, 0.62, 'right', 0.1, 0.9, 13 - level * 8, 12, '#5a6048');
      }
      if (level > 0.75) {
        ctx.fillStyle = '#c9c2d8';
        rect(ctx, x - 1, y - 15, 2, 3, '#c9c2d8');
      }
    },
  },

  vent: {
    label: 'trash chute', w: 1, h: 1, tall: 0, solid: false, flat: true,
    acts: ['dump_trash'],
    draw(ctx, x, y) {
      // Painted directly onto the wall above wherever it's placed.
      const gx = x, gy = y - 22;
      rect(ctx, gx - 6, gy, 12, 10, '#3a3550');
      rect(ctx, gx - 5, gy + 1, 10, 8, '#242034');
      for (let i = 0; i < 4; i++) rect(ctx, gx - 5, gy + 1.5 + i * 2, 10, 0.8, '#4a4468');
    },
  },

  // ---------------------------------------------------------------------
  // A handful of pieces inspired by classic Habbo Hotel furni: a coffee
  // machine, a pair of linked teleporters, a rollable die, a one-way floor
  // roller, and a togglable gate. Same contract as everything else — a
  // footprint, some acts, a draw() — so they slot into the room editor and
  // the action library exactly like the rest of the catalog.
  // ---------------------------------------------------------------------

  coffee_machine: {
    label: 'coffee machine', w: 1, h: 1, tall: 20, solid: true,
    acts: ['brew_coffee'],
    draw(ctx, x, y, o, t) {
      isoBox(ctx, x, y, 0.7, 0.7, 20, '#4a4468', '#39344f', '#2e2a42');
      isoPlate(ctx, x, y, 0.7, 0.7, 20, '#5c5779');
      rect(ctx, x - 4, y - 26, 8, 8, '#241d33');            // reservoir
      rect(ctx, x - 3, y - 24, 6, 4, '#8a5f3c');             // coffee level
      rect(ctx, x - 1, y - 10, 2, 6, '#2e2a42');             // spout
      if (o.state.on) {
        ctx.fillStyle = 'rgba(230,230,240,0.5)';
        for (let i = 0; i < 3; i++) {
          const p = (t * 20 + i * 6) % 12;
          ctx.fillRect(x - 1 + Math.sin(t * 3 + i) * 1.5, y - 12 - p, 1, 2);
        }
      }
    },
  },

  teleporter: {
    label: 'teleporter', w: 1, h: 1, tall: 2, solid: false, flat: true,
    acts: ['teleport'], occupiable: true,
    draw(ctx, x, y, o, t) {
      // Colour-code by id parity so the two ends of a pair read as visually
      // linked-but-distinct, without needing a second "which end" flag.
      const col = o.id % 2 === 0 ? '#7fd0c4' : '#e79bb0';
      const pulse = 0.5 + 0.5 * Math.sin(t * 3);
      isoPlate(ctx, x, y, 1, 1, 0.4, '#2b2740');
      isoPlate(ctx, x, y, 0.8, 0.8, 0.8 + pulse * 1.5, col);
      isoPlate(ctx, x, y, 0.45, 0.45, 1.4 + pulse * 2, '#171426');
      ctx.strokeStyle = col; ctx.globalAlpha = 0.5 + pulse * 0.4; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.ellipse(x, y - 2 - pulse * 3, 8, 4, 0, 0, 7); ctx.stroke();
      ctx.globalAlpha = 1;
    },
  },

  dice: {
    label: 'dice', w: 1, h: 1, tall: 8, solid: true,
    acts: ['roll_dice'],
    draw(ctx, x, y, o) {
      isoBox(ctx, x, y, 0.5, 0.5, 8, PAL.whiteD, PAL.white, PAL.whiteS);
      isoPlate(ctx, x, y, 0.5, 0.5, 8, PAL.white);
      const face = o.state.face || 1;
      const pip = (dx, dy) => { ctx.fillStyle = PAL.ink; ctx.beginPath(); ctx.arc(x + dx, y - 4 + dy, 0.7, 0, 7); ctx.fill(); };
      const layouts = {
        1: [[0, 0]],
        2: [[-2, -1.5], [2, 1.5]],
        3: [[-2, -1.5], [0, 0], [2, 1.5]],
        4: [[-2, -1.5], [2, -1.5], [-2, 1.5], [2, 1.5]],
        5: [[-2, -1.5], [2, -1.5], [0, 0], [-2, 1.5], [2, 1.5]],
        6: [[-2, -2], [2, -2], [-2, 0], [2, 0], [-2, 2], [2, 2]],
      };
      for (const [dx, dy] of layouts[face] || layouts[1]) pip(dx, dy);
    },
  },

  present: {
    label: 'present', w: 1, h: 1, tall: 9, solid: true,
    acts: ['open_present'],
    draw(ctx, x, y) {
      isoBox(ctx, x, y, 0.6, 0.6, 9, '#d9645a', '#c14f46', '#a33f37');
      isoPlate(ctx, x, y, 0.6, 0.6, 9, '#e87a70');
      boxFace(ctx, x, y, 0.6, 0.6, 'right', 0.42, 0.58, 0, 9, '#f2d879');
      boxFace(ctx, x, y, 0.6, 0.6, 'left', 0.42, 0.58, 0, 9, '#f2d879');
      ctx.fillStyle = '#f2d879';
      ctx.beginPath(); ctx.ellipse(x - 2.5, y - 10, 2, 1.4, 0.4, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.ellipse(x + 2.5, y - 10, 2, 1.4, -0.4, 0, 7); ctx.fill();
    },
  },

  wheel: {
    label: 'wheel of fortune', w: 1, h: 1, tall: 22, solid: true,
    acts: ['spin_wheel'],
    draw(ctx, x, y, o, t) {
      isoBox(ctx, x, y, 0.24, 0.24, 14, '#6d5a42', '#584735', '#4a3b2b');
      const segColors = ['#e0675f', '#f2b46b', '#e8c65a', '#79c97f', '#7fd0c4', '#7f8fd0'];
      const spin = o.state.on ? t * 6 : 0;
      ctx.save();
      ctx.translate(x, y - 18);
      ctx.rotate(spin);
      for (let i = 0; i < 6; i++) {
        ctx.fillStyle = segColors[i];
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, 9, (i / 6) * Math.PI * 2, ((i + 1) / 6) * Math.PI * 2);
        ctx.closePath(); ctx.fill();
      }
      ctx.restore();
      ctx.strokeStyle = '#2c2840'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, y - 18, 9, 0, 7); ctx.stroke();
      ctx.fillStyle = '#f2d879';
      ctx.beginPath(); ctx.moveTo(x, y - 30); ctx.lineTo(x - 2, y - 26); ctx.lineTo(x + 2, y - 26); ctx.closePath(); ctx.fill();
    },
  },

  vending: {
    label: 'vending machine', w: 1, h: 1, tall: 22, solid: true,
    acts: ['use_vending'],
    draw(ctx, x, y, o) {
      isoBox(ctx, x, y, 0.8, 0.8, 22, '#5c5779', '#4a4468', '#39344f');
      isoPlate(ctx, x, y, 0.8, 0.8, 22, '#6d6889');
      boxFace(ctx, x, y, 0.8, 0.8, 'right', 0.1, 0.9, 6, 19, '#241d33');
      const snackColors = ['#e8c65a', '#e0675f', '#79c97f', '#f2b46b'];
      for (let row = 0; row < 2; row++) {
        for (let col = 0; col < 2; col++) {
          boxFace(ctx, x, y, 0.8, 0.8, 'right', 0.16 + col * 0.34, 0.32 + col * 0.34,
            8 + row * 5.5, 12 + row * 5.5, snackColors[row * 2 + col]);
        }
      }
      if (o.state.on) {
        ctx.fillStyle = 'rgba(255,214,110,0.9)';
        ctx.fillRect(x + 6, y - 20, 1, 1);
      }
    },
  },

  totem: {
    label: 'totem', w: 1, h: 1, tall: 30, solid: true, blocksSight: true,
    acts: ['totem_charge'],
    draw(ctx, x, y) {
      const bands = [
        ['#c14f46', '#a33f37', '#8a352e'],
        ['#e8c65a', '#c9a847', '#a88a3a'],
        ['#79c97f', '#5fa864', '#4d8a52'],
        ['#7f8fd0', '#6572ad', '#525d8f'],
      ];
      for (let i = 0; i < 4; i++) {
        const [top, right, left] = bands[i];
        isoBox(ctx, x, y - i * 7, 0.5, 0.5, 7, top, right, left);
      }
      ctx.fillStyle = '#2c2840';
      ctx.beginPath(); ctx.arc(x - 2, y - 26, 1, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.arc(x + 2, y - 26, 1, 0, 7); ctx.fill();
      ctx.fillRect(x - 2, y - 23, 4, 1);
    },
  },

  roller: {
    label: 'roller', w: 1, h: 1, tall: 0, solid: false, flat: true, rollDir: 0,
    acts: [],
    draw(ctx, x, y, o, t) {
      isoPlate(ctx, x, y, 1, 1, 0.3, '#4a5a4a');
      ctx.strokeStyle = '#8fd08a'; ctx.lineWidth = 1; ctx.globalAlpha = 0.7;
      const dir = o.state.dir ?? 0;
      const [dx, dy] = [[1, 0], [0, 1], [-1, 0], [0, -1]][dir];
      for (let i = 0; i < 3; i++) {
        const p = ((t * 0.6 + i / 3) % 1);
        const cx = x + (dx - dy) * HW * (p - 0.5) * 0.7, cy = y + (dx + dy) * HH * (p - 0.5) * 0.7 + HH * 0.5;
        ctx.beginPath(); ctx.moveTo(cx - 2, cy - 2); ctx.lineTo(cx + 2, cy); ctx.lineTo(cx - 2, cy + 2); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    },
  },

  gate: {
    // Blocks the crossing at its own N edge (the boundary with the row
    // behind it), not its whole cell — see the _blockedEdges comment in
    // world.js. Its own tile stays walkable on both sides regardless of
    // open/closed, exactly like standing right next to a real door.
    label: 'gate', w: 1, h: 1, tall: 22, edgeBlock: 'N', structural: true,
    acts: ['toggle_gate'],
    draw(ctx, x, y, o) {
      const open = o.state.open;
      ctx.globalAlpha = open ? 0.35 : 1;
      isoBox(ctx, x, y, 0.12, 1, 22, '#8a7355', '#6d5a42', '#584735');   // near post
      isoBox(ctx, x, y, 1, 0.12, 22, '#8a7355', '#6d5a42', '#584735');   // far post
      for (let i = 0; i < 4; i++) {
        boxFace(ctx, x, y, 1, 1, 'left', 0.14, 0.94, 4 + i * 5, 7 + i * 5, '#6d5a42');   // rails
      }
      ctx.globalAlpha = 1;
      if (!open) {
        ctx.fillStyle = '#e8c65a';
        ctx.fillRect(x - 1, y - 12, 2, 2);   // latch light
      }
    },
  },

  // An interior partition wall, built one tile at a time out of ordinary
  // solid furniture — no changes needed anywhere else in the renderer or
  // collision system to get a second "room" out of it.
  wall_seg: {
    // A low, half-height partition — one straight panel per tile, Habbo-style,
    // rather than a floor-to-ceiling block. Every wall_seg in the layout is
    // laid out as a row of constant gy (varying gx), so only the panel running
    // along the "+w" (grid-x) direction is ever needed; drawing a second one
    // along "+h" at every tile used to give each segment a spurious corner,
    // making a straight run of wall look like a zigzag of little L-pieces.
    // Collision-wise it blocks only the N edge crossing it's actually drawn
    // on (see world.js's _blockedEdges) — its own cell is normal floor, not
    // a whole extra row of the room quietly eaten by a sliver of art.
    label: 'wall', w: 1, h: 1, tall: 13, edgeBlock: 'N', blocksSight: true, structural: true,
    // The panel really occupies only this thin north edge. The painter must
    // sort it at that edge as well; using the full 1x1 filing tile makes the
    // translucent panel jump in front of a critter on the camera-near side.
    depthW: 1, depthH: 0.14,
    acts: [],
    draw(ctx, x, y) {
      ctx.save();
      ctx.globalAlpha = 0.7;
      isoBox(ctx, x, y, 1, 0.14, 13, PAL.wallTop, PAL.wallR, PAL.wallTrim);
      ctx.restore();
    },
  },

  bathtub: {
    label: 'bathtub', w: 1, h: 2, tall: 12, solid: false, sit: true, seatH: 4,
    acts: ['soak'],
    draw(ctx, x, y, o, t) {
      isoBox(ctx, x, y, 1, 2, 10, PAL.whiteS, PAL.white, PAL.whiteD);
      isoPlate(ctx, x, y, 0.82, 1.7, 12, '#a9c6d6');
      if (o.state.on) {
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        for (let i = 0; i < 4; i++) {
          const p = (t * 1.5 + i / 4) % 1;
          const cx = x + Math.sin(i * 2) * 4, cy = y + 6 - p * 8;
          ctx.beginPath(); ctx.arc(cx, cy, 1.2 - p * 0.6, 0, 7); ctx.fill();
        }
      }
    },
  },

  mirror: {
    label: 'mirror', w: 1, h: 1, tall: 26, solid: false, flat: true, standOn: true,
    acts: ['primp'], faceDir: 2,
    draw(ctx, x, y) {
      // Painted onto whichever wall it's placed against, like the window.
      const gy = y - 30;
      ctx.fillStyle = '#6d5a42'; ctx.fillRect(x - 6, gy, 12, 20);
      ctx.fillStyle = '#cfe0ea'; ctx.fillRect(x - 4, gy + 2, 8, 16);
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath(); ctx.moveTo(x - 3, gy + 3); ctx.lineTo(x - 1, gy + 3); ctx.lineTo(x - 3, gy + 15); ctx.closePath(); ctx.fill();
    },
  },

  jukebox: {
    label: 'jukebox', w: 1, h: 1, tall: 26, solid: true, blocksSight: true,
    acts: ['dance'], emitsWhenOn: { light: 0.3, sound: 0.9 },
    draw(ctx, x, y, o, t) {
      isoBox(ctx, x, y, 0.7, 0.7, 26, '#c4643f', '#a94f30', '#8c4027');
      isoPlate(ctx, x, y, 0.7, 0.7, 26, '#d97b52');
      const glow = o.state.on ? (0.5 + 0.5 * Math.sin(t * 6)) : 0;
      ctx.fillStyle = `rgba(255,214,110,${0.4 + glow * 0.5})`;
      ctx.beginPath(); ctx.arc(x, y - 15, 4, 0, 7); ctx.fill();
      ctx.strokeStyle = '#3a2a1e'; ctx.lineWidth = 1;
      for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.arc(x, y - 15, 2 + i * 2.2, 0, 7); ctx.stroke(); }
      if (o.state.on) {
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        for (let i = 0; i < 3; i++) {
          const bar = 3 + Math.abs(Math.sin(t * 5 + i * 2)) * 6;
          ctx.fillRect(x - 6 + i * 5, y - 4 - bar, 2, bar);
        }
      }
    },
  },

  fish_tank: {
    label: 'fish tank', w: 1, h: 1, tall: 18, solid: true, hungry: true,
    acts: ['gaze_fish', 'feed_fish'],
    draw(ctx, x, y, o, t) {
      // wooden stand, then a dark opaque back so the fish reads clearly
      // against it, then a translucent glass shell drawn back OVER the fish —
      // three stacked isoBoxes, no flat screen-rect anywhere, so it stays a
      // proper 3D tank instead of a flat blue square glued onto the room.
      isoBox(ctx, x, y, 0.86, 0.86, 4, '#6d5a42', '#584735', '#4a3b2b');
      isoBox(ctx, x, y - 4, 0.7, 0.7, 13, '#2c3550', '#232a42', '#1c2236');

      const hunger = o.state.hunger || 0;
      const swim = Math.sin(t * 1.8 + o.gx * 2) * 4;
      const bob = Math.sin(t * 1.3) * 1.2;
      const sad = hunger > 0.6;
      ctx.save();
      ctx.translate(x + swim, y - 10 + bob);
      if (swim < 0) ctx.scale(-1, 1);
      ctx.fillStyle = sad ? '#8a7a5a' : '#f2a94e';
      ctx.beginPath(); ctx.ellipse(0, 0, 3.6, 2.2, 0, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-3.4, 0); ctx.lineTo(-6.4, -2.2); ctx.lineTo(-6.4, 2.2); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#2c2840';
      ctx.beginPath(); ctx.arc(1.7, -0.3, 0.5, 0, 7); ctx.fill();
      ctx.restore();

      isoBox(ctx, x, y - 4, 0.7, 0.7, 13,
        'rgba(150,210,230,0.3)', 'rgba(120,190,220,0.4)', 'rgba(90,160,200,0.4)');
      isoPlate(ctx, x, y - 16.5, 0.62, 0.62, 0.6, 'rgba(205,238,247,0.55)');

      if (hunger > 0.6) {
        ctx.fillStyle = 'rgba(210,200,160,0.9)';
        ctx.fillRect(x + 3, y - 15, 1, 1);
        ctx.fillRect(x + 5, y - 12, 1, 1);
      }
    },
  },

  // -------------------------------------------------------------------
  // Extra CC0 pieces from Kenney's Furniture Kit. These deliberately share
  // the same object contract as the hand-drawn catalog, so selection,
  // movement, collision, saving and the critter's existing affordances all
  // work without a parallel "asset furniture" system.
  armchair: kenneyItem('armchair', 'loungeChairRelax', {
    tall: 24, solid: false, sit: true, seatH: 7, acts: ['lounge'],
  }),
  bench: kenneyItem('cushioned bench', 'benchCushion', {
    w: 2, h: 1, tall: 20, solid: false, sit: true, seatH: 7, acts: ['lounge'],
  }),
  coffee_table: kenneyItem('coffee table', 'tableCoffee', {
    w: 2, h: 1, tall: 20, surface: true, acts: ['eat_at'],
  }),
  desk: kenneyItem('desk', 'desk', {
    w: 2, h: 1, tall: 24, surface: true,
  }),
  office_chair: kenneyItem('desk chair', 'chairDesk', {
    tall: 23, solid: false, sit: true, seatH: 7, acts: ['lounge'],
  }),
  side_table: kenneyItem('drawer side table', 'sideTableDrawers', {
    tall: 21, surface: true,
  }),
  small_plant: kenneyItem('small plant', 'plantSmall1', {
    tall: 18, acts: ['sniff', 'water'], thirsty: true,
  }),
  radio: kenneyItem('radio', 'radio', {
    tall: 13,
  }),
  storage_box: kenneyItem('storage box', 'cardboardBoxClosed', {
    tall: 16,
  }),
  bar_stool: kenneyItem('bar stool', 'stoolBar', {
    tall: 20, solid: false, sit: true, seatH: 10, acts: ['lounge'],
  }),
  storage_cabinet: kenneyItem('storage cabinet', 'bookcaseClosedDoors', {
    tall: 31, blocksSight: true,
  }),

  workbench: {
    label: 'workbench', w: 1, h: 1, tall: 15, solid: true,
    acts: ['craft'],
    draw(ctx, x, y) {
      isoBox(ctx, x, y, 1, 1, 13, PAL.woodD, PAL.wood, '#5d3f27');
      isoPlate(ctx, x, y, 1, 1, 15, '#8a6a45');
      boxFace(ctx, x, y, 1, 1, 'right', 0.1, 0.9, 2, 11, '#5d3f27');
      // a little pile of scrap and a saw laid across the top
      isoPlate(ctx, x - 5, y + 3, 0.24, 0.24, 15.4, '#8a8a94');
      isoPlate(ctx, x - 3, y + 5, 0.2, 0.2, 15.4, '#6d6d78');
      ctx.strokeStyle = '#c8c8d4'; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(x + 1, y - 1); ctx.lineTo(x + 7, y + 3); ctx.stroke();
      ctx.fillStyle = '#8a6a45';
      ctx.beginPath(); ctx.ellipse(x + 1, y - 1, 1.6, 1, 0.5, 0, 7); ctx.fill();
    },
  },
};

let nextId = 1;

export function makeObject(type, gx, gy, opts = {}) {
  const def = DEFS[type];
  if (!def) throw new Error('unknown object type: ' + type);
  const state = Object.assign(
    {
      on: false, open: false, plate: null, dirty: 0, level: 0, thirst: 0, hunger: 0, borrowed: null, flip: false,
      face: type === 'dice' ? (1 + Math.floor(Math.random() * 6)) : 1,
      rotation: 0,
      pairId: null, dir: 0,
    },
    opts.state,
  );
  const o = {
    id: nextId++, type, def,
    gx, gy, w: def.w, h: def.h,
    // mobile objects (the ball) keep a float position and get pushed around
    fx: gx, fy: gy, vx: 0, vy: 0, hop: 0, spin: 0,
    label: opts.label || def.label,
    use: opts.use || null,            // explicit interaction cells [[gx,gy],...]
    state,
  };
  return syncObjectFootprint(o);
}

/** True when using the item means physically occupying its footprint rather
 *  than stopping beside it. This is deliberately narrower than `standOn`:
 *  wall mirrors/windows are observed from the floor in front of them. */
export function canOccupyObject(o) {
  return !!(o?.def && (o.def.occupiable || o.def.sit || o.def.lie));
}

/** Every grid cell covered by an object's live, rotation-aware footprint. */
export function footprintCells(o) {
  const cells = [];
  for (let x = 0; x < o.w; x++) {
    for (let y = 0; y < o.h; y++) cells.push([o.gx + x, o.gy + y]);
  }
  return cells;
}

/** Cells the critter may stand on to interact with `o`. Seating, beds,
 *  showers, baths and pads are entered; ordinary furniture is used from its
 *  orthogonal outside ring. Collision/pathfinding still decide whether a
 *  particular candidate is currently reachable. */
export function useCells(o) {
  if (o.use) return o.use;
  return canOccupyObject(o) ? footprintCells(o) : adjacentCells(o);
}

// Same 4-direction indexing as world.js's DIRS and a critter's own `dir` —
// 0:+gx  1:+gy  2:-gx  3:-gy. Duplicated locally (rather than imported) so
// this module, which world.js itself imports from, never has to import
// world.js back.
const RING_DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];

/** Every cell along one side of a w×h footprint, in ring direction `dir`. */
function ringSide(o, dir) {
  const [dx, dy] = RING_DIRS[dir];
  const cells = [];
  if (dx !== 0) {
    const x = dx > 0 ? o.gx + o.w : o.gx - 1;
    for (let y = o.gy; y < o.gy + o.h; y++) cells.push([x, y]);
  } else {
    const y = dy > 0 ? o.gy + o.h : o.gy - 1;
    for (let x = o.gx; x < o.gx + o.w; x++) cells.push([x, y]);
  }
  return cells;
}

/** Orthogonal ring outside an object's footprint — restricted to whichever
 *  side(s) actually make sense to use it from. Most furniture has no
 *  preferred side (a lamp, a fish tank, a workbench, a plant: reach it from
 *  wherever), so the ring is the full 4-neighbour set by default. A handful
 *  of pieces care: `def.frontDir` limits use to exactly one side (a fridge
 *  only opens into the room, a bookshelf is only ever read from the front —
 *  you cannot open a door or a page through the back panel), and
 *  `def.backDir` excludes exactly one (a TV can be watched from either
 *  flank or the front, just not through its own screen from behind). Both
 *  are RING_DIRS indices, fixed at the piece's shipped orientation — same
 *  simplification the existing `faceDir` (window/mirror) already makes. */
export function adjacentCells(o) {
  if (o.def.frontDir != null) return ringSide(o, o.def.frontDir);
  const sides = o.def.backDir != null
    ? [0, 1, 2, 3].filter((d) => d !== o.def.backDir)
    : [0, 1, 2, 3];
  return sides.flatMap((d) => ringSide(o, d));
}

/** What a piece of furniture costs in the room editor's shop. Anything not
 *  listed here (the two fixed exterior features, wall segments) isn't sold. */
export const PRICES = {
  chair: 15, table: 45, sofa: 65, tv: 85, lamp: 20, plant: 12, rug: 25,
  toybox: 30, bookshelf: 35, trashcan: 20, ball: 10,
  coffee_machine: 55, dice: 10, teleporter: 90, roller: 35, gate: 30,
  bathtub: 70, mirror: 25, jukebox: 95, fish_tank: 50, workbench: 60,
  present: 20, wheel: 80, vending: 65, totem: 40,
  armchair: 40, bench: 35, coffee_table: 30, desk: 50, office_chair: 25,
  side_table: 20, small_plant: 10, radio: 25, storage_box: 8,
  bar_stool: 18, storage_cabinet: 40,
};
