// Canvas renderer. Draws at a small fixed internal resolution and blits with
// nearest-neighbour scaling, which is what gives the chunky pixel look — all the
// art is vector-ish but the output grid is deliberately coarse.

import { HW, HH, WALL_H, toScreen, toGrid, tilePath, isoPlate, setRotation as setIsoRotation } from './iso.js';
import { setSpriteRotation } from './sprites.js';
import { PAL, shade } from './palette.js';
import { drawCritter, drawEmote } from './critter.js';
import { DOOR_GY, SEASON_TINTS } from '../world/world.js';

// A 12x13 floor is 400px wide in this projection. The old 384px backing
// canvas physically could not contain both side corners, regardless of CSS
// sizing, so they were clipped before the browser ever displayed the image.
export const VIEW_W = 416, VIEW_H = 272;
const ORIGIN = { x: 216, y: 42 };
/** Thickness of the floor slab along the two open, camera-facing edges. Deep
 *  enough that a critter standing on the outermost row of tiles still has
 *  floor under it rather than the void beyond the room. */
const FLOOR_LIP = 14;

export function createRenderer(canvas, world) {
  const ctx = canvas.getContext('2d');
  const overlays = { vision: false, path: false, grid: false };
  // The room editor drives these from outside; render() just reads them.
  // menuHighlightId is separate from selectedId — it's purely visual (which
  // object's footprint to outline while its click-menu is open), so opening
  // that menu in ordinary play can never accidentally arm edit-mode's own
  // move/rotate/remove behaviour, which selectedId still drives.
  const editor = { active: false, selectedId: null, ghost: null, menuHighlightId: null };
  // Habbo-style pointer feedback (which tile / which piece is under the
  // cursor) and the Sims-style plumbob target. Driven from outside by the
  // input layer; render() only reads them.
  const hud = { hoverGx: null, hoverGy: null, hoverObjId: null, activeId: null };
  let scale = 2;
  let t = 0;

  // ----------------------------------------------------------- fixed camera
  //
  // The room stays at its original viewpoint. Keeping this value immutable
  // lets the established projection helpers remain straightforward while
  // item rotation is handled independently by each object's facing state.
  const rotation = 0;

  function rot(gx, gy) {
    const { cols, rows } = world;
    switch (rotation & 3) {
      case 1: return [rows - gy, gx];
      case 2: return [cols - gx, rows - gy];
      case 3: return [gy, cols - gx];
      default: return [gx, gy];
    }
  }
  function unrot(gx, gy) {
    const { cols, rows } = world;
    switch (rotation & 3) {
      case 1: return [gy, rows - gx];
      case 2: return [cols - gx, rows - gy];
      case 3: return [cols - gy, gx];
      default: return [gx, gy];
    }
  }
  // Which two of the room's four edges are "far" (drawn as walls) at each
  // rotation — derived from where each edge's rotated depth (rx+ry) lands.
  const FAR_EDGES = { 0: ['N', 'W'], 1: ['S', 'W'], 2: ['S', 'E'], 3: ['N', 'E'] };
  // Flat furniture that's painted directly onto whichever wall it sits
  // against, rather than sitting free on the floor (contrast: a rug).
  const WALL_MOUNTED = new Set(['window', 'vent', 'mirror']);
  /** Which wall a wall-mounted piece is actually against, or null if it
   *  isn't against any of the four (e.g. dropped mid-room by the editor) —
   *  in which case it should just always draw rather than flicker in and
   *  out with rotation for no reason. */
  function wallEdgeOf(o) {
    if (o.gy === 0) return 'N';
    if (o.gy >= world.rows - 1) return 'S';
    if (o.gx === 0) return 'W';
    if (o.gx >= world.cols - 1) return 'E';
    return null;
  }
  // The 6-point clip/wall silhouette for each rotation: [gx, gy, level] where
  // level is 'R' (raised, top of wall) or 'L' (floor + lip). See the
  // derivation in the module notes — each row is [farCorner, edge1End,
  // edge1End, openCorner, edge2End, edge2End] going around the silhouette
  // once.
  //
  // Both ends of each open edge carry the lip. The corner where a wall meets
  // an open edge used to sit at bare floor level, and since the clip edge
  // between two vertices is a straight line, that gave the floor slab zero
  // thickness at that corner ramping to full thickness at the far one — so a
  // critter standing near that corner got its legs clipped off against the
  // void while one at the other end of the same wall was fine. A slab is the
  // same depth all the way along.
  function silhouette() {
    const C = world.cols, R = world.rows;
    const table = {
      0: [[0, 0, 'R'], [C, 0, 'R'], [C, 0, 'L'], [C, R, 'L'], [0, R, 'L'], [0, R, 'R']],
      1: [[0, R, 'R'], [C, R, 'R'], [C, R, 'L'], [C, 0, 'L'], [0, 0, 'L'], [0, 0, 'R']],
      2: [[C, R, 'R'], [0, R, 'R'], [0, R, 'L'], [0, 0, 'L'], [C, 0, 'L'], [C, 0, 'R']],
      3: [[C, 0, 'R'], [0, 0, 'R'], [0, 0, 'L'], [0, R, 'L'], [C, R, 'L'], [C, R, 'R']],
    };
    return table[rotation & 3];
  }

  canvas.width = VIEW_W;
  canvas.height = VIEW_H;

  function resize(container) {
    const pad = 16;
    const sx = (container.clientWidth - pad) / VIEW_W;
    const sy = (container.clientHeight - pad - 60) / VIEW_H;
    const fit = Math.min(sx, sy);
    // Retain crisp integer enlargement where it fits, but shrink smoothly on
    // narrow windows instead of forcing a 1x canvas wider than the stage.
    scale = fit >= 1 ? Math.floor(fit) : Math.max(0.5, fit);
    canvas.style.width = VIEW_W * scale + 'px';
    canvas.style.height = VIEW_H * scale + 'px';
  }

  const sx = (gx, gy) => { const [rx, ry] = rot(gx, gy); return toScreen(rx, ry).x + ORIGIN.x; };
  const sy = (gx, gy) => { const [rx, ry] = rot(gx, gy); return toScreen(rx, ry).y + ORIGIN.y; };

  /**
   * The room's full outer silhouette — the two raised walls plus the floor
   * slab under them. Everything is clipped to this before it's drawn, so no
   * sprite (a critter reaching for something, an emote bubble, a shadow) can
   * ever render past the edge of the room, even at the two open/camera-facing
   * sides where there is no wall to block the eye.
   */
  function clipToRoom() {
    // Has to clear FLOOR_LIP: this clip is what stops a sprite escaping the
    // room, but a critter standing on the outermost ring of tiles reaches
    // about 11px past its own tile's front edge, so a shallow lip sliced its
    // legs off — reading in game as the critter standing half off the map.
    const lip = FLOOR_LIP + 1;
    const pts = silhouette();
    ctx.beginPath();
    pts.forEach(([gx, gy, level], i) => {
      const x = sx(gx, gy);
      const y = sy(gx, gy) + (level === 'R' ? -WALL_H - 2 : level === 'L' ? lip : 0);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.clip();
  }

  // -------------------------------------------------------------- room

  /** The two grid points bounding edge `edge`'s i-th segment (i=0..len-1). */
  function edgeSegment(edge, i) {
    const C = world.cols, R = world.rows;
    if (edge === 'N') return [[i, 0], [i + 1, 0]];
    if (edge === 'S') return [[i, R], [i + 1, R]];
    if (edge === 'W') return [[0, i], [0, i + 1]];
    return [[C, i], [C, i + 1]];                          // 'E'
  }
  const edgeLength = (edge) => (edge === 'N' || edge === 'S' ? world.cols : world.rows);
  /** Which room a point on this edge belongs to, for per-segment theming. */
  function edgeRoom(edge, i) {
    if (edge === 'N') return world.roomAt(i, 0);
    if (edge === 'S') return world.roomAt(i, world.rows - 1);
    if (edge === 'W') return world.roomAt(0, i);
    return world.roomAt(world.cols - 1, i);                // 'E'
  }

  function drawWallEdge(edge) {
    const len = edgeLength(edge);
    for (let i = 0; i < len; i++) {
      const theme = world.themeFor(edgeRoom(edge, i));
      const [[ax, ay], [bx, by]] = edgeSegment(edge, i);
      const x0 = sx(ax, ay), y0 = sy(ax, ay);
      const x1 = sx(bx, by), y1 = sy(bx, by);
      ctx.fillStyle = shade(theme.wall, 12);
      ctx.beginPath();
      ctx.moveTo(x0, y0 - WALL_H); ctx.lineTo(x1, y1 - WALL_H);
      ctx.lineTo(x1, y1); ctx.lineTo(x0, y0);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = theme.wallDark;
      ctx.beginPath();
      ctx.moveTo(x0, y0 - 3); ctx.lineTo(x1, y1 - 3);
      ctx.lineTo(x1, y1); ctx.lineTo(x0, y0);
      ctx.closePath(); ctx.fill();
    }
  }

  function drawWalls() {
    const [edge1, edge2] = FAR_EDGES[rotation & 3];
    drawWallEdge(edge1);
    drawWallEdge(edge2);

    // top caps, so the two far walls read as having thickness
    const pts = silhouette();
    const capTheme = world.themeFor(edgeRoom(edge1, 0));
    ctx.fillStyle = shade(capTheme.wall, 24);
    for (const [a, b] of [[0, 1], [4, 5]]) {
      const [ax, ay] = pts[a], [bx, by] = pts[b];
      const x0 = sx(ax, ay), y0 = sy(ax, ay) - WALL_H;
      const x1 = sx(bx, by), y1 = sy(bx, by) - WALL_H;
      // a thin sliver nudged toward the camera for a beveled-top look
      const nx = (x0 + x1) / 2, ny = (y0 + y1) / 2;
      ctx.beginPath();
      ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
      ctx.lineTo(nx, ny - 2); ctx.closePath(); ctx.fill();
    }

    if (FAR_EDGES[rotation & 3].includes('N')) drawWindow();
    if (FAR_EDGES[rotation & 3].includes('W')) drawDoor();
  }

  /**
   * A rectangle painted flat onto one of the two back walls.
   * `side` 'right' runs along +gx (the gy=0 wall), 'left' along +gy.
   * `a`..`b` are grid coordinates along the wall, `lo`..`hi` heights off the floor.
   */
  function wallQuad(side, a, b, lo, hi, colour) {
    const p = side === 'right'
      ? (g, h) => [sx(g, 0), sy(g, 0) - h]
      : (g, h) => [sx(0, g), sy(0, g) - h];
    const c0 = p(a, hi), c1 = p(b, hi), c2 = p(b, lo), c3 = p(a, lo);
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.moveTo(c0[0], c0[1]); ctx.lineTo(c1[0], c1[1]);
    ctx.lineTo(c2[0], c2[1]); ctx.lineTo(c3[0], c3[1]);
    ctx.closePath(); ctx.fill();
  }

  /** Mix a hex colour toward a tint by a small fraction — used to lean the
   *  window's sky toward the season without fighting the day/night colours. */
  function tintTowards(hex, tint, amt) {
    const p = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
    const [r1, g1, b1] = p(hex), [r2, g2, b2] = p(tint);
    const mix = (a, b) => Math.round(a + (b - a) * amt);
    return `rgb(${mix(r1, r2)},${mix(g1, g2)},${mix(b1, b2)})`;
  }

  function drawWindow() {
    const win = world.first('window');
    if (!win) return;
    const g = win.gx, day = world.daylight();
    let sky = day > 0.55 ? '#8fc9e0' : day > 0.2 ? '#c98f7a' : PAL.night;
    if (day > 0.2) sky = tintTowards(sky, SEASON_TINTS[world.season()], 0.22);
    if (world.weather === 'cloudy' || world.weather === 'rain') sky = tintTowards(sky, '#8a8a94', 0.4);

    wallQuad('right', g + 0.02, g + 0.98, 8, 26, '#3b3653');
    wallQuad('right', g + 0.10, g + 0.90, 10, 24, sky);
    if (day > 0.55 && world.weather === 'clear') wallQuad('right', g + 0.10, g + 0.50, 10, 24, '#a8dcee');
    else if (day <= 0.2 && world.weather !== 'cloudy' && world.weather !== 'rain' && world.weather !== 'snow') {
      ctx.fillStyle = '#dfe6ff';
      for (let i = 0; i < 6; i++) {
        const t2 = 0.16 + (i * 0.13) % 0.7;
        const [px, py] = [sx(g + t2, 0), sy(g + t2, 0) - (12 + ((i * 5) % 11))];
        ctx.fillRect(px, py, 1, 1);
      }
    }
    if (world.weather === 'rain') {
      ctx.strokeStyle = 'rgba(190,210,230,0.6)'; ctx.lineWidth = 1;
      for (let i = 0; i < 10; i++) {
        const px = g + 0.14 + (i * 0.09) % 0.72;
        // Counts UP with time, so the drop's height offset (subtracted from
        // the sill) has to count DOWN from the pane's top (24) to its
        // bottom (10) as this grows — the reverse read the drops as rising.
        const drop = (t * 40 + i * 7) % 14;
        const [x0, y0] = [sx(px, 0), sy(px, 0) - 24 + drop];
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0 - 1, y0 + 3); ctx.stroke();
      }
    } else if (world.weather === 'snow') {
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      for (let i = 0; i < 8; i++) {
        const px = g + 0.14 + (i * 0.11) % 0.72;
        const flake = (t * 8 + i * 5) % 14;
        const [x0, y0] = [sx(px + Math.sin(t + i) * 0.02, 0), sy(px, 0) - 24 + flake];
        ctx.fillRect(x0, y0, 1, 1);
      }
    }
    wallQuad('right', g + 0.47, g + 0.53, 10, 24, '#4a4468');   // mullion
    wallQuad('right', g + 0.10, g + 0.90, 16.6, 17.4, '#4a4468');
    wallQuad('right', g - 0.02, g + 1.02, 6.6, 8, '#6d6889');   // sill
  }

  function drawDoor() {
    const g = DOOR_GY;
    const locked = world.doorLocked;
    wallQuad('left', g, g + 1.1, 0, WALL_H - 2, '#3d3652');
    if (locked) {
      wallQuad('left', g + 0.08, g + 1.02, 0, WALL_H - 5, PAL.wood);
      wallQuad('left', g + 0.16, g + 0.94, 3, WALL_H - 9, PAL.woodD);
      const [hx, hy] = [sx(0, g + 0.2), sy(0, g + 0.2) - 13];
      ctx.fillStyle = PAL.warm;
      ctx.fillRect(hx - 2, hy, 2, 2);
      // a small padlock glyph so "locked" reads at a glance
      const [lx, ly] = [sx(0, g + 0.55), sy(0, g + 0.55) - 18];
      ctx.strokeStyle = '#2b2740'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(lx, ly - 2, 1.6, Math.PI, 0); ctx.stroke();
      ctx.fillStyle = '#c9a84a';
      ctx.fillRect(lx - 2, ly - 2, 4, 3);
    } else {
      // door standing ajar: a shifted, narrower panel with a dark gap behind it
      wallQuad('left', g + 0.08, g + 0.80, 0, WALL_H - 5, PAL.wood);
      wallQuad('left', g + 0.14, g + 0.74, 3, WALL_H - 9, PAL.woodD);
      const [hx, hy] = [sx(0, g + 0.16), sy(0, g + 0.16) - 13];
      ctx.fillStyle = '#8fd08a';
      ctx.fillRect(hx - 2, hy, 2, 2);
    }
  }

  function drawFloor() {
    for (let gx = 0; gx < world.cols; gx++) {
      for (let gy = 0; gy < world.rows; gy++) {
        const theme = world.themeFor(world.roomAt(gx, gy));
        const x = sx(gx, gy), y = sy(gx, gy);
        tilePath(ctx, x, y);
        ctx.fillStyle = (gx + gy) % 2 ? theme.floorA : theme.floorB;
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.11)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    // A lip along the two camera-facing (open) edges so the floor has thickness.
    const lip = FLOOR_LIP;
    const far = FAR_EDGES[rotation & 3];
    const openEdges = ['N', 'S', 'W', 'E'].filter((e) => !far.includes(e));
    for (const edge of openEdges) {
      const len = edgeLength(edge);
      const shadeAmt = edge === 'N' || edge === 'S' ? -45 : -30;
      for (let i = 0; i < len; i++) {
        const theme = world.themeFor(edgeRoom(edge, i));
        ctx.fillStyle = shade(theme.floorA, shadeAmt);
        const [[ax, ay], [bx, by]] = edgeSegment(edge, i);
        const a = [sx(ax, ay), sy(ax, ay)];
        const b = [sx(bx, by), sy(bx, by)];
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
        ctx.lineTo(b[0], b[1] + lip); ctx.lineTo(a[0], a[1] + lip);
        ctx.closePath(); ctx.fill();
      }
    }
  }

  /** The screen-space quad of a w×h footprint's floor area. */
  function footprintQuad(gx, gy, w, h, inset = 0) {
    const i = inset;
    return [[gx + i, gy + i], [gx + w - i, gy + i],
      [gx + w - i, gy + h - i], [gx + i, gy + h - i]]
      .map(([a, b]) => [sx(a, b), sy(a, b)]);
  }
  function quadPath(quad) {
    ctx.beginPath();
    quad.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
  }

  /**
   * Habbo's tile marker: the floor tile under the pointer lights up, and
   * hovering a piece of furniture lights up its whole footprint instead of a
   * single tile. Drawn on the floor, under everything else, so furniture
   * still sits on top of its own highlight.
   */
  function drawTileHover() {
    if (editor.ghost) return;               // the placement ghost owns the cursor in build mode
    // Only bare floor gets the marker painted onto the ground. A hovered
    // piece of furniture would just cover its own highlight, so that case is
    // outlined over the top instead — see drawOverlays.
    if (hud.hoverObjId != null) return;
    if (hud.hoverGx == null || !world.inBounds(hud.hoverGx, hud.hoverGy)) return;
    ctx.save();
    quadPath(footprintQuad(hud.hoverGx, hud.hoverGy, 1, 1));
    ctx.fillStyle = 'rgba(255,255,255,0.20)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  /**
   * A soft contact shadow on the floor under every solid piece. Painted flat
   * on the ground plane in one pass before the furniture itself, so it needs
   * no depth sorting — and it's what stops everything looking like it's
   * hovering a few pixels above the tiles.
   */
  function drawContactShadows() {
    ctx.save();
    ctx.fillStyle = 'rgba(24,18,38,0.18)';
    for (const o of world.objects) {
      if (o.def.flat) continue;
      const gx = o.def.mobile ? o.fx : o.gx, gy = o.def.mobile ? o.fy : o.gy;
      quadPath(footprintQuad(gx, gy, o.w, o.h, 0.12));
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * The Sims' plumbob, floating over whichever critter you have selected —
   * it doubles as the "who am I looking at" marker the roster tabs otherwise
   * only tell you in text, and its colour reads the same way it does there:
   * green when they're doing well, sinking through amber to red as mood
   * drops. Drawn after the lighting pass so it stays legible at night.
   */
  function drawPlumbob(critters) {
    const c = critters.find((k) => k.id === hud.activeId && !k.away && k._screen);
    if (!c) return;
    const v = c.emotion?.valence ?? 0;                        // -1 unhappy .. +1 happy
    const hue = 10 + Math.max(0, Math.min(1, (v + 1) / 2)) * 105;   // red -> green
    const bob = Math.sin(t * 2.2) * 1.2;
    const x = c._screen.x;
    const y = c._screen.y - 21 * (c.stage?.scale ?? 1) + bob;
    // A slow spin, faked by squeezing the diamond's half-width. It keeps a
    // floor so the crystal never turns fully edge-on and vanishes.
    const wob = Math.abs(Math.cos(t * 1.6));
    const hw = 2 + 3 * wob, hh = 6;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, y - hh); ctx.lineTo(x + hw, y);
    ctx.lineTo(x, y + hh); ctx.lineTo(x - hw, y);
    ctx.closePath();
    ctx.fillStyle = `hsl(${hue} 85% 52%)`;
    ctx.fill();
    // lit facet on one side + a soft glow on the tile below
    ctx.beginPath();
    ctx.moveTo(x, y - hh); ctx.lineTo(x + hw, y); ctx.lineTo(x, y + hh);
    ctx.closePath();
    ctx.fillStyle = `hsl(${hue} 90% 68%)`;
    ctx.fill();
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = `hsl(${hue} 90% 80%)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y - hh); ctx.lineTo(x + hw, y);
    ctx.lineTo(x, y + hh); ctx.lineTo(x - hw, y);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  // -------------------------------------------------------------- entities

  /** Draw one furniture piece, honouring its stored flip (the editor's crude
   *  "rotate" for anything that doesn't have real per-facing art). */
  function drawFurniture(o, ox, oy) {
    if (o.state.flip) {
      ctx.save();
      ctx.translate(ox, 0); ctx.scale(-1, 1); ctx.translate(-ox, 0);
      o.def.draw(ctx, ox, oy, o, t);
      ctx.restore();
    } else {
      o.def.draw(ctx, ox, oy, o, t);
    }
  }

  /** Nearest-camera ground level of a footprint. This is also the pixel row
   *  where isoBox and Kenney sprites anchor their base, so rectangular pieces
   *  no longer borrow an arbitrary centre depth that disagrees with the art. */
  function footprintFrontDepth(gx, gy, w, h) {
    let front = -Infinity;
    for (const [x, y] of [[gx, gy], [gx + w, gy], [gx, gy + h], [gx + w, gy + h]]) {
      const [rx, ry] = rot(x, y);
      front = Math.max(front, rx + ry);
    }
    return front;
  }

  function depthOfObject(o, critters = null) {
    const gx = o.def.mobile ? o.fx : o.gx;
    const gy = o.def.mobile ? o.fy : o.gy;
    // Thin wall fragments are filed in a grid tile for collision/selection,
    // but visually live on one edge of it. Sort the drawn geometry, not the
    // full filing tile, so a translucent panel changes sides at its edge.
    const w = o.def.depthW ?? o.w;
    const h = o.def.depthH ?? o.h;
    let depth = footprintFrontDepth(gx, gy, w, h);

    // A critter actively sitting/lying/soaking on occupiable furniture must
    // appear on its surface. The sprite is not split into seat/back layers,
    // so place the complete item immediately before the occupant; this is
    // preferable to the old result where the sofa painted over the critter.
    if (critters) {
      for (const c of critters) {
        const onCell = c.gx >= o.gx && c.gx < o.gx + o.w && c.gy >= o.gy && c.gy < o.gy + o.h;
        if (onCell) {
          const activelyUsing = c.task?.cmd?.t === 'use' && c.task.cmd.obj === o;
          const occupiable = o.def.occupiable || o.def.sit || o.def.lie;
          if (!c.moving && (activelyUsing || occupiable)) depth = Math.min(depth, depthOfCritter(c) - 0.01);
        }
        // Thin wall fragments have the opposite situation from sit furniture:
        // their own filing cell is normal floor (see the wall_seg comment
        // below), so a critter regularly walks straight through it — and for
        // that whole cell, not just past whatever single px the two depth
        // numbers happen to cross, they should stay in front of the panel's
        // thin decorative sliver. Painter's algorithm has no pixel-level
        // blending, so right at that one crossing px, a full sprite-width
        // swap in either direction is visible as a pop — reported live as
        // the wall briefly rendering in front of a critter walking along it.
        // A same-CELL gate (onCell above) fixed the crossing in the middle
        // of the wall's own tile, but not the approach: the critter's
        // sprite has real pixel width, wide enough to visually reach the
        // next segment along the wall before its rounded grid cell has
        // actually caught up (confirmed live by sweeping a continuous
        // position across a whole row and diffing depth against every
        // segment within reach, not just the exact cell match) — which
        // read as the same pop, just at each segment's leading edge instead
        // of its middle. Checking continuous position within a full tile,
        // not the rounded cell, covers the segment being approached or just
        // departed as well as the one currently stood on.
        if (o.def.edgeBlock && Math.abs(c.px - o.gx) < 1 && Math.abs(c.py - o.gy) < 1) {
          depth = Math.min(depth, depthOfCritter(c) - 0.01);
        }
      }
    }
    return depth;
  }

  /** Sort on the critter's visible feet, not merely its tile centre. The art
   *  extends below that centre, and ignoring that rendered ground contact is
   *  what let nearby furniture stay above a critter for part of a move. */
  function depthOfCritter(c) {
    // drawCritter receives the tile's north corner and performs its own
    // half-tile descent to the body/feet. Start depth at that same corner;
    // adding another +0.5,+0.5 here would reproduce the old (+1,+1) visual
    // displacement in the painter even after the sprite anchor was fixed.
    const [rx, ry] = rot(c.px, c.py);
    const scale = c.stage?.scale ?? 1;
    // Mirrors drawCritter's neutral ground contact: body origin (now the
    // tile's true centre — see the FEET_DROP correction in critter.js) plus
    // the foot radius past it. Deliberately exclude walk bob/breathing so the
    // layer does not flicker on every animation frame.
    const footPixels = 8 + 1.7 * scale;
    return rx + ry + footPixels / HH + 0.01; // living subject wins exact ties
  }

  function drawEntities(critters) {
    const present = critters.filter((c) => !c.away);
    for (const c of critters) if (c.away) c._screen = null;

    const list = [];
    for (const o of world.objects) {
      if (o.def.flat) continue;
      const ox = o.def.mobile ? o.fx : o.gx, oy = o.def.mobile ? o.fy : o.gy;
      list.push({
        d: depthOfObject(o, present),
        draw: () => drawFurniture(o, sx(ox, oy), sy(ox, oy)),
      });
    }
    for (const c of present) {
      list.push({
        // This key changes continuously with px/py, so crossing a depth level
        // while walking changes the layer at the actual feet crossing rather
        // than when Math.round() happens to select a different grid cell.
        d: depthOfCritter(c),
        draw: () => {
          // drawCritter's x/y contract is the NORTH corner of the occupied
          // tile. It adds HH internally to place the body over the diamond's
          // centre. Passing the centre here as well added HH twice, which is
          // exactly one (+1,+1) projected-grid offset toward the south.
          const x = sx(c.px, c.py);
          // Occupied furniture raises the body to its seat/sleeping surface;
          // ordinary items can never produce this overlap through pathing.
          const rest = world.objectAt(Math.round(c.px), Math.round(c.py));
          const onIt = rest && (rest.def.sit || rest.def.lie)
            && (c.pose === 'sit' || c.pose === 'lie' || c.pose === 'read' || c.asleep);
          const seat = onIt ? (rest.def.seatH ?? Math.round(rest.def.tall * 0.5)) : 0;
          const y = sy(c.px, c.py) - seat;
          drawCritter(ctx, x, y, c, t);
          // Picking, emotes and the plumbob reference the visible body centre,
          // not drawCritter's north-corner input anchor.
          c._screen = {
            x: sx(c.px + 0.5, c.py + 0.5),
            y: sy(c.px + 0.5, c.py + 0.5) - seat,
          };
        },
      });
    }
    list.sort((a, b) => a.d - b.d);
    for (const e of list) e.draw();
  }

  function drawMesses() {
    for (const m of world.messes) {
      const x = sx(m.gx + 0.5, m.gy + 0.5), y = sy(m.gx + 0.5, m.gy + 0.5);
      const col = m.kind === 'crumbs' ? '#6b4a2c' : m.kind === 'puddle' ? '#4d6a80' : '#4a3b2e';
      ctx.fillStyle = col;
      ctx.globalAlpha = 0.35 + m.amount * 0.55;
      for (const [ox, oy, r] of m.blobs) {
        ctx.beginPath();
        ctx.ellipse(x + ox, y + oy, r * (0.5 + m.amount), r * 0.5 * (0.5 + m.amount), 0, 0, 7);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  // -------------------------------------------------------------- light

  function drawLighting() {
    const l = world.lightLevel();
    if (l >= 0.88) return;
    const k = 1 - l;
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    const r = Math.round(255 - k * 130), g = Math.round(255 - k * 120), b = Math.round(255 - k * 55);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.restore();

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const o of world.objects) {
      if (!o.state.on || !o.def.emitsWhenOn) continue;
      const x = sx(o.gx + 0.5, o.gy + 0.5), y = sy(o.gx + 0.5, o.gy + 0.5) - 10;
      const rad = o.type === 'lamp' ? 58 : 42;
      const grad = ctx.createRadialGradient(x, y, 2, x, y, rad);
      const warm = o.type === 'lamp' ? '255,215,140' : '150,215,240';
      grad.addColorStop(0, `rgba(${warm},${0.30 * k})`);
      grad.addColorStop(1, `rgba(${warm},0)`);
      ctx.fillStyle = grad;
      ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    ctx.restore();
  }

  // -------------------------------------------------------------- overlays

  function drawOverlays(critters) {
    if (overlays.grid) {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '5px monospace';
      for (let gx = 0; gx < world.cols; gx++) {
        for (let gy = 0; gy < world.rows; gy++) {
          tilePath(ctx, sx(gx, gy), sy(gx, gy));
          const blocked = !world.isWalkable(gx, gy);
          const destinationOnly = !blocked && world._noTransit.has(gx + ',' + gy);
          ctx.fillStyle = blocked
            ? 'rgba(224,80,78,0.34)'
            : destinationOnly ? 'rgba(242,180,70,0.27)' : 'rgba(70,205,156,0.10)';
          ctx.fill();
          ctx.strokeStyle = blocked
            ? 'rgba(255,120,112,0.86)'
            : destinationOnly ? 'rgba(255,203,105,0.72)' : 'rgba(185,255,224,0.28)';
          ctx.lineWidth = blocked ? 1.2 : 0.65;
          ctx.stroke();
          ctx.fillStyle = blocked ? 'rgba(255,226,220,0.92)' : 'rgba(236,255,248,0.72)';
          ctx.fillText(`${gx},${gy}`, sx(gx + 0.5, gy + 0.5), sy(gx + 0.5, gy + 0.5) + 1);
        }
      }

      // Draw the actual blocked boundaries, since partition walls and closed
      // gates block an edge rather than consuming either neighbouring cell.
      ctx.strokeStyle = 'rgba(255,72,93,0.98)';
      ctx.lineWidth = 2.2;
      for (let gx = 0; gx < world.cols; gx++) {
        for (let gy = 0; gy < world.rows; gy++) {
          if (gx + 1 < world.cols && world.edgeBlocked(gx, gy, gx + 1, gy)) {
            ctx.beginPath();
            ctx.moveTo(sx(gx + 1, gy), sy(gx + 1, gy));
            ctx.lineTo(sx(gx + 1, gy + 1), sy(gx + 1, gy + 1));
            ctx.stroke();
          }
          if (gy + 1 < world.rows && world.edgeBlocked(gx, gy, gx, gy + 1)) {
            ctx.beginPath();
            ctx.moveTo(sx(gx, gy + 1), sy(gx, gy + 1));
            ctx.lineTo(sx(gx + 1, gy + 1), sy(gx + 1, gy + 1));
            ctx.stroke();
          }
        }
      }

      // The grid edge is also an impassable boundary even where no raised
      // wall happens to be painted. Showing it closes the collision map and
      // makes it obvious that A* never owns a node outside this diamond.
      quadPath(footprintQuad(0, 0, world.cols, world.rows));
      ctx.strokeStyle = 'rgba(172,55,77,0.95)';
      ctx.lineWidth = 2.2;
      ctx.stroke();

      // Draw the active route as actual cells, including the already-traversed
      // portion still retained by the runner. Future cells are purple, the
      // next reservation is yellow, and small numbers show traversal order.
      const active = critters.find((k) => k.id === hud.activeId) || critters[0];
      const route = active?.task?.path;
      if (active && !active.away && route?.length) {
        const routeStart = active.task.pathFrom || [active.gx, active.gy];
        ctx.beginPath();
        ctx.moveTo(sx(routeStart[0] + 0.5, routeStart[1] + 0.5), sy(routeStart[0] + 0.5, routeStart[1] + 0.5));
        for (const [gx, gy] of route) {
          ctx.lineTo(sx(gx + 0.5, gy + 0.5), sy(gx + 0.5, gy + 0.5));
        }
        ctx.strokeStyle = 'rgba(177,143,255,0.88)';
        ctx.lineWidth = 1.4;
        ctx.stroke();

        for (let i = 0; i < route.length; i++) {
          const [gx, gy] = route[i];
          const traversed = i < active.task.pathIdx;
          const next = i === active.task.pathIdx;
          tilePath(ctx, sx(gx, gy), sy(gx, gy));
          ctx.fillStyle = next
            ? 'rgba(255,236,92,0.48)'
            : traversed ? 'rgba(177,143,255,0.10)' : 'rgba(177,143,255,0.28)';
          ctx.fill();
          ctx.strokeStyle = next
            ? 'rgba(255,236,92,1)' : traversed ? 'rgba(177,143,255,0.32)' : 'rgba(198,174,255,0.82)';
          ctx.lineWidth = next ? 2 : 1;
          ctx.stroke();
          ctx.fillStyle = next ? '#fff6a8' : traversed ? 'rgba(230,218,255,0.4)' : '#e7dcff';
          ctx.fillText(String(i + 1), sx(gx + 0.5, gy + 0.5), sy(gx + 0.5, gy + 0.5) - 3);
        }
      }

      // Every critter owns its last fully reached grid cell. The active one
      // is cyan; peers are magenta. While walking, the smaller dot is its
      // exact continuous foot position between the occupied and reserved cell.
      for (const cr of critters) {
        if (cr.away) continue;
        const isActive = cr === active;
        tilePath(ctx, sx(cr.gx, cr.gy), sy(cr.gx, cr.gy));
        ctx.fillStyle = isActive ? 'rgba(71,220,255,0.32)' : 'rgba(242,132,214,0.28)';
        ctx.fill();
        ctx.strokeStyle = isActive ? 'rgba(71,220,255,1)' : 'rgba(247,155,224,0.95)';
        ctx.lineWidth = isActive ? 2 : 1.5;
        ctx.stroke();
        ctx.fillStyle = isActive ? '#c9f7ff' : '#ffd6f5';
        ctx.fillText(isActive ? 'C' : `C${cr.id}`, sx(cr.gx + 0.5, cr.gy + 0.5), sy(cr.gx + 0.5, cr.gy + 0.5) + 5);
      }

      // Three reference points per critter, so a foot/cell mismatch shows up
      // directly instead of needing to eyeball it: red is the tile's own true
      // centre (independent of the critter entirely — sx/sy(px,py)+HH, same
      // as the tile diamonds above); green is drawCritter's body-origin
      // anchor; blue is that body's own feet. Green and blue coinciding with
      // red is the FEET_DROP fix in critter.js doing its job — the point of
      // this overlay is to make that checkable at a glance, live, rather
      // than asserted from code alone.
      const dot = (px, py, color) => {
        ctx.beginPath(); ctx.arc(px, py, 2, 0, Math.PI * 2);
        ctx.fillStyle = color; ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 0.6; ctx.stroke();
      };
      for (const cr of critters) {
        if (cr.away) continue;
        const s = cr.stage.scale;
        let lift = 0, squash = 1;
        if (cr.pose === 'walk') { const wp = Math.sin(cr.bob); lift = Math.abs(wp) * 1.6; squash = 1 + wp * 0.03; }
        if (cr.pose === 'sit' || cr.pose === 'read') { lift = -3; squash = 0.86; }
        if (cr.pose === 'lie') { lift = -5; squash = 0.62; }
        const anchorX = sx(cr.px, cr.py), anchorY = sy(cr.px, cr.py);
        const cellCenterY = anchorY + HH; // true tile centre, per tilePath's own geometry above
        const bodyY = anchorY + 8 - 10.5 * s * 0.52 - lift; // drawCritter's (bx,by) post-fix (breathe omitted, sub-pixel)
        const feetY = bodyY + 10.5 * s * squash * 0.52;
        dot(anchorX, cellCenterY, '#ff2d55');
        dot(anchorX, bodyY, '#39ff14');
        dot(anchorX, feetY, '#2d8bff');
      }
      ctx.restore();
    }
    const c = critters.find((k) => k.id === hud.activeId) || critters[0];
    if (overlays.vision && c?.percept) {
      ctx.save();
      ctx.globalAlpha = 0.13;
      ctx.fillStyle = '#ffe9a8';
      for (let gx = 0; gx < world.cols; gx++) {
        for (let gy = 0; gy < world.rows; gy++) {
          if (!inView(c, gx, gy)) continue;
          tilePath(ctx, sx(gx, gy), sy(gx, gy));
          ctx.fill();
        }
      }
      ctx.restore();
      ctx.strokeStyle = 'rgba(255,220,140,0.75)';
      ctx.lineWidth = 1;
      for (const v of c.percept.visible) {
        const cc = world.center(v.obj);
        ctx.globalAlpha = 0.25 + v.novelty * 0.6;
        ctx.beginPath();
        ctx.moveTo(sx(c.px + 0.5, c.py + 0.5), sy(c.px + 0.5, c.py + 0.5) - 8);
        ctx.lineTo(sx(cc.gx, cc.gy), sy(cc.gx, cc.gy) - 6);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    if (overlays.path && c?.task?.path) {
      ctx.fillStyle = 'rgba(127,208,196,0.85)';
      for (let i = c.task.pathIdx; i < c.task.path.length; i++) {
        const [px, py] = c.task.path[i];
        ctx.fillRect(sx(px + 0.5, py + 0.5) - 1.5, sy(px + 0.5, py + 0.5) + 6, 3, 3);
      }
    }
    // The actual tile(s) something refers to — a cell outline, not a circle
    // that only ever approximately points at a spot. `cells` is [gx,gy]
    // pairs; works for a single called-to tile or a whole footprint alike.
    function outlineCells(cells, color, lineWidth = 1.5) {
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      for (const [gx, gy] of cells) {
        tilePath(ctx, sx(gx, gy), sy(gx, gy));
        ctx.stroke();
      }
    }
    function footprintCells(o) {
      const cells = [];
      for (let x = 0; x < o.w; x++) for (let y = 0; y < o.h; y++) cells.push([o.gx + x, o.gy + y]);
      return cells;
    }

    for (const cr of critters) {
      if (!cr.signals.callCell) continue;
      const [px, py] = cr.signals.callCell;
      const pulse = 0.6 + 0.3 * Math.sin(t * 6);
      outlineCells([[px, py]], `rgba(242,180,107,${pulse})`, 2);
    }

    // Hovered furniture outlines over the top — a piece tall enough to stand
    // on its own tile hides any highlight painted on the floor beneath it.
    if (hud.hoverObjId != null && !editor.ghost
      && hud.hoverObjId !== editor.selectedId && hud.hoverObjId !== editor.menuHighlightId) {
      const o = world.byId(hud.hoverObjId);
      if (o) outlineCells(footprintCells(o), 'rgba(255,255,255,0.8)', 1);
    }
    // ---- room editor: selection outline + placement ghost
    if (editor.selectedId != null) {
      const o = world.byId(editor.selectedId);
      if (o) outlineCells(footprintCells(o), `rgba(242,180,107,${0.6 + 0.3 * Math.sin(t * 6)})`, 2);
    }
    // Regular (non-edit) mode: which cells the click-menu's furniture
    // actually occupies, while that menu is open.
    if (editor.menuHighlightId != null && editor.menuHighlightId !== editor.selectedId) {
      const o = world.byId(editor.menuHighlightId);
      if (o) outlineCells(footprintCells(o), 'rgba(127,208,196,0.85)', 2);
    }
    if (editor.ghost) {
      const { gx, gy, w, h, valid } = editor.ghost;
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = valid ? 'rgba(127,208,196,0.9)' : 'rgba(224,103,95,0.9)';
      for (let x = 0; x < w; x++) {
        for (let y = 0; y < h; y++) {
          tilePath(ctx, sx(gx + x, gy + y), sy(gx + x, gy + y));
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    }
  }

  function inView(c, gx, gy) {
    const dx = gx + 0.5 - (c.px + 0.5), dy = gy + 0.5 - (c.py + 0.5);
    const d = Math.hypot(dx, dy);
    if (d > 7.5) return false;
    if (d < 1.6) return true;
    const [fx, fy] = [[1, 0], [0, 1], [-1, 0], [0, -1]][c.dir];
    if ((dx * fx + dy * fy) / d < Math.cos((62 * Math.PI) / 180)) return false;
    return world.lineOfSight(Math.round(c.px), Math.round(c.py), gx, gy);
  }

  // -------------------------------------------------------------- public

  return {
    ctx, overlays, editor, hud, resize,
    /** Ground-contact depth numbers used by the live painter, exposed for
     *  deterministic movement/layering regression checks. */
    debugDepth(critters) {
      const present = critters.filter((c) => !c.away);
      return {
        critters: present.map((c) => ({ id: c.id, name: c.name, gx: c.gx, gy: c.gy, px: c.px, py: c.py, d: depthOfCritter(c) })),
        objects: world.objects.filter((o) => !o.def.flat).map((o) => ({
          id: o.id, type: o.type, gx: o.gx, gy: o.gy,
          d: depthOfObject(o, present),
          baseD: depthOfObject(o),
        })),
      };
    },
    get rotation() { return rotation; },
    get scale() { return scale; },

    render(critters, dt) {
      const list = Array.isArray(critters) ? critters : [critters];
      t += dt;
      setIsoRotation(rotation);   // sync iso.js's furniture-shape basis to this frame's camera angle
      setSpriteRotation(rotation);
      ctx.clearRect(0, 0, VIEW_W, VIEW_H);
      ctx.fillStyle = '#151223';
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);

      ctx.save();
      clipToRoom();

      drawWalls();
      drawFloor();
      drawTileHover();
      drawContactShadows();
      const far = FAR_EDGES[rotation & 3];
      for (const o of world.objects) {
        if (!o.def.flat) continue;
        // Window/vent/mirror are painted onto a specific wall — only draw
        // them while that wall is actually one of the two currently solid;
        // otherwise they'd float in mid-air over what's now an open side.
        const edge = WALL_MOUNTED.has(o.type) ? wallEdgeOf(o) : null;
        if (edge && !far.includes(edge)) continue;
        drawFurniture(o, sx(o.gx, o.gy), sy(o.gx, o.gy));
      }
      drawMesses();
      drawEntities(list);
      drawLighting();
      drawOverlays(list);

      for (const c of list) {
        if (c.emote && c._screen) {
          drawEmote(ctx, c._screen.x, c._screen.y - 15 * c.stage.scale, c.emote, t);
        }
      }
      drawPlumbob(list);
      ctx.restore();   // lift the room clip
    },

    /** Screen pixels -> grid coords (float), for the room editor's drag. */
    screenToGrid(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      const px = (clientX - rect.left) / scale, py = (clientY - rect.top) / scale;
      const g = toGrid(px - ORIGIN.x, py - ORIGIN.y);
      const [gx, gy] = unrot(g.gx, g.gy);
      return { gx, gy };
    },

    /** Canvas-relative pixels -> what the user clicked on. */
    pick(clientX, clientY, critters) {
      const list = Array.isArray(critters) ? critters : [critters];
      const rect = canvas.getBoundingClientRect();
      const px = (clientX - rect.left) / scale;
      const py = (clientY - rect.top) / scale;

      for (const c of list) {
        if (!c._screen) continue;
        const d = Math.hypot(px - c._screen.x, py - c._screen.y + 6);
        if (d < 12) return { kind: 'critter', critter: c };
      }
      // Tall furniture is picked by its screen box, floor by projection.
      for (const o of [...world.objects].sort((a, b) => depthOfObject(b) - depthOfObject(a))) {
        if (o.def.flat || !o.def.tall) continue;
        // A partition wall is drawn see-through on purpose, and there is
        // nothing you can do to one — so it shouldn't absorb clicks either.
        // Its panel covers the tile behind it, which made that whole strip of
        // floor unusable: every click there landed on the wall and got the
        // "load-bearing" refusal instead of the floor. Structural pieces that
        // DO have actions (the gates) still take their clicks normally.
        if (o.def.structural && !o.def.acts?.length) continue;
        const ox = sx(o.gx + o.w / 2, o.gy + o.h / 2), oy = sy(o.gx + o.w / 2, o.gy + o.h / 2);
        // The box has to stop at the piece's own footprint, not a whole tile
        // past it. A w×h footprint is (w+h)*HW wide and its front corner sits
        // (w+h)/2*HH below its centre; the old bounds used TILE_W*w and
        // oy+TILE_H, which for anything against a wall reached a full tile
        // forward and swallowed clicks meant for the open floor in front of
        // it — the reason the strip beside the partition walls felt dead.
        const halfW = (o.w + o.h) * HW * 0.5;
        const front = (o.w + o.h) * 0.5 * HH;
        // The bed and sofa draw a pre-rendered sprite taller than their own
        // def.tall (the bed's is more than double), so the click box used to
        // cut off partway down the headboard/back. Flooring EVERY object's
        // margin to at least 30px "fixed" that but way overshot for anything
        // small — a chair's box nearly quadrupled for no reason — and a box
        // that tall on a piece sitting near a room boundary reached clear
        // into the next room's furniture on the same screen-diagonal,
        // stealing its clicks. Widen only the two pieces that actually need
        // it; leave everything else at its own real height.
        const SPRITE_TALLER_THAN_DEF = { bed: 34, sofa: 34 };
        const topMargin = (SPRITE_TALLER_THAN_DEF[o.type] ?? o.def.tall) + 4;
        if (px > ox - halfW && px < ox + halfW
          && py > oy - topMargin && py < oy + front) return { kind: 'object', obj: o };
      }
      const g = toGrid(px - ORIGIN.x, py - ORIGIN.y);
      const [ugx, ugy] = unrot(g.gx, g.gy);
      const gx = Math.floor(ugx), gy = Math.floor(ugy);
      if (!world.inBounds(gx, gy)) return { kind: 'none' };
      const o = world.selectableAt(gx, gy);
      if (o) return { kind: 'object', obj: o };
      return { kind: 'floor', cell: [gx, gy] };
    },
  };
}

/** Small standalone portrait used by the side panel. */
export function drawPortrait(canvas, critter, t) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#171426';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  const stash = { dir: critter.dir, pose: critter.pose };
  critter.dir = 1;
  drawCritter(ctx, canvas.width / 2, canvas.height / 2 + 12, critter, t, { portrait: true, scale: 1.5 });
  critter.dir = stash.dir;
  ctx.restore();
}
