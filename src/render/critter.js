// Drawing the critter. Everything is procedural so expression, pose and growth
// stage are continuous parameters rather than a sprite sheet — which is exactly
// what you want when the face has to reflect a valence/arousal pair.

import { PAL } from './palette.js';

const FACING_CAMERA = (dir) => dir === 0 || dir === 1;

/** Eye/mouth shapes per emotional region name (see creature/emotion.js). */
const FACES = {
  grin:    { eye: 'arc',   mouth: 'grin',  blush: 0.9 },
  smile:   { eye: 'open',  mouth: 'smile', blush: 0.5 },
  neutral: { eye: 'open',  mouth: 'small', blush: 0.2 },
  sleepy:  { eye: 'half',  mouth: 'small', blush: 0.1 },
  wide:    { eye: 'wide',  mouth: 'o',     blush: 0.3 },
  flat:    { eye: 'half',  mouth: 'flat',  blush: 0 },
  sad:     { eye: 'droop', mouth: 'frown', blush: 0 },
  worried: { eye: 'wide',  mouth: 'wobble', blush: 0 },
  cross:   { eye: 'angry', mouth: 'frown', blush: 0 },
};

/**
 * @param x,y    screen position of the tile the critter stands on (north corner)
 * @param c      the critter
 * @param t      seconds, for animation
 * @param opts   { scale, portrait }
 */
export function drawCritter(ctx, x, y, c, t, opts = {}) {
  const s = (opts.scale ?? c.stage.scale) * (opts.portrait ? 1.9 : 1);
  const face = FACES[c.emotion.label().face] || FACES.neutral;
  const pose = c.pose;
  const asleep = c.asleep;

  const walkPhase = Math.sin(c.bob);
  const breathe = Math.sin(t * (asleep ? 1.1 : 2.2)) * (asleep ? 1.2 : 0.5);
  let lift = 0, squash = 1, lean = 0;

  if (pose === 'walk') { lift = Math.abs(walkPhase) * 1.6; squash = 1 + walkPhase * 0.03; }
  if (pose === 'sit' || pose === 'read') { lift = -3; squash = 0.86; }
  if (pose === 'lie') { lift = -5; squash = 0.62; lean = 1; }
  if (pose === 'play') { lift = Math.abs(Math.sin(t * 7)) * 4; }
  if (pose === 'peer') { lean = 0.4; }
  if (pose === 'groom') { lean = -0.3; }

  const bx = x, by = y + 8 - lift + breathe * 0.5;
  const bw = 9 * s, bh = 10.5 * s * squash;

  // shadow
  if (!opts.portrait) {
    ctx.fillStyle = PAL.shadow;
    ctx.beginPath();
    ctx.ellipse(x, y + 9, bw * 0.95, bw * 0.48, 0, 0, 7);
    ctx.fill();
  }

  ctx.save();
  ctx.translate(bx, by);
  if (lean) ctx.rotate(lean * 0.22);

  // feet
  if (pose !== 'lie') {
    ctx.fillStyle = PAL.bodyD;
    const fo = pose === 'walk' ? walkPhase * 2.2 : 0;
    ctx.beginPath(); ctx.ellipse(-3.4 * s + fo, bh * 0.52, 2.6 * s, 1.7 * s, 0, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.ellipse(3.4 * s - fo, bh * 0.52, 2.6 * s, 1.7 * s, 0, 0, 7); ctx.fill();
  }

  // ears — set back a little when the critter faces away
  const earTilt = FACING_CAMERA(c.dir) ? 1 : -1;
  const earDroop = c.emotion.valence < -0.2 ? 0.5 : 0;
  ctx.fillStyle = PAL.bodyD;
  for (const sx of [-1, 1]) {
    ctx.save();
    ctx.translate(sx * bw * 0.62, -bh * 0.72);
    ctx.rotate(sx * (0.35 + earDroop) * earTilt);
    ctx.beginPath();
    ctx.ellipse(0, -2.2 * s, 1.9 * s, 3.6 * s, 0, 0, 7);
    ctx.fill();
    ctx.fillStyle = PAL.blush;
    ctx.beginPath(); ctx.ellipse(0, -2.2 * s, 0.9 * s, 2.1 * s, 0, 0, 7); ctx.fill();
    ctx.fillStyle = PAL.bodyD;
    ctx.restore();
  }

  // tail
  ctx.fillStyle = PAL.bodyD;
  ctx.save();
  ctx.translate((c.dir === 0 ? -1 : 1) * bw * 0.85, bh * 0.12);
  ctx.rotate(Math.sin(t * 3 + c.bob) * 0.25 * (c.emotion.arousal + 1));
  ctx.beginPath(); ctx.ellipse(0, 0, 3.2 * s, 1.5 * s, 0.4, 0, 7); ctx.fill();
  ctx.restore();

  // body
  ctx.fillStyle = PAL.body;
  ctx.beginPath();
  ctx.ellipse(0, 0, bw, bh, 0, 0, 7);
  ctx.fill();
  ctx.fillStyle = PAL.bodyL;
  ctx.beginPath(); ctx.ellipse(-bw * 0.22, -bh * 0.28, bw * 0.55, bh * 0.5, 0, 0, 7); ctx.fill();
  ctx.fillStyle = PAL.belly;
  ctx.beginPath(); ctx.ellipse(0, bh * 0.24, bw * 0.55, bh * 0.42, 0, 0, 7); ctx.fill();

  // arms
  const armUp = pose === 'reach' || pose === 'wave' || pose === 'play';
  ctx.fillStyle = PAL.bodyD;
  const waveA = pose === 'wave' ? Math.sin(t * 9) * 0.5 : 0;
  for (const sx of [-1, 1]) {
    ctx.save();
    ctx.translate(sx * bw * 0.86, -bh * 0.05);
    const up = armUp && (sx > 0 || pose !== 'wave');
    ctx.rotate(sx * (up ? -1.1 + waveA : 0.25 + (pose === 'walk' ? walkPhase * 0.3 * sx : 0)));
    ctx.beginPath(); ctx.ellipse(0, 1.5 * s, 1.6 * s, 3 * s, 0, 0, 7); ctx.fill();
    ctx.restore();
  }

  // face
  if (FACING_CAMERA(c.dir) || opts.portrait) {
    const dx = (opts.portrait ? 0 : (c.dir === 0 ? 1.6 : -1.6)) * s;
    const closed = asleep || c.blink > 0 || face.eye === 'half';
    const ey = -bh * 0.18;
    drawEyes(ctx, dx, ey, s, face.eye, closed, asleep, c);
    drawMouth(ctx, dx, ey + 4.4 * s, s, asleep ? 'small' : face.mouth);
    if (face.blush > 0.35) {
      ctx.fillStyle = 'rgba(240,145,142,' + (0.35 * face.blush).toFixed(2) + ')';
      ctx.beginPath(); ctx.ellipse(dx - 4.6 * s, ey + 2.6 * s, 1.9 * s, 1.2 * s, 0, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.ellipse(dx + 4.6 * s, ey + 2.6 * s, 1.9 * s, 1.2 * s, 0, 0, 7); ctx.fill();
    }
  } else {
    ctx.fillStyle = PAL.bodyD;                        // back of the head
    ctx.beginPath(); ctx.ellipse(0, -bh * 0.15, bw * 0.5, bh * 0.35, 0, 0, 7); ctx.fill();
  }

  // visitors wear a little red bandana so they read as "not yours" at a glance
  if (c.visitor) {
    ctx.fillStyle = '#d9534f';
    ctx.beginPath();
    ctx.ellipse(0, bh * 0.02, bw * 0.66, bh * 0.16, 0, 0, Math.PI, true);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-bw * 0.14, bh * 0.08);
    ctx.lineTo(-bw * 0.02, bh * 0.34);
    ctx.lineTo(bw * 0.14, bh * 0.08);
    ctx.closePath();
    ctx.fill();
  }

  ctx.restore();

  if (c.holding && !opts.portrait) drawItem(ctx, bx, by - bh - 3, s, c.holding, pose);
}

function drawEyes(ctx, dx, ey, s, kind, closed, asleep, c) {
  const off = 3.1 * s;
  // pupils drift toward whatever the critter is looking at
  const look = c.lookAt ? Math.max(-1, Math.min(1, (c.lookAt.gx - c.px - (c.lookAt.gy - c.py)) * 0.4)) : 0;

  for (const sx of [-1, 1]) {
    const ex = dx + sx * off;
    if (closed || kind === 'half') {
      ctx.strokeStyle = PAL.ink; ctx.lineWidth = 1.1 * s;
      ctx.beginPath();
      ctx.moveTo(ex - 1.7 * s, ey);
      ctx.quadraticCurveTo(ex, ey + (asleep ? 1.4 : 0.9) * s, ex + 1.7 * s, ey);
      ctx.stroke();
      continue;
    }
    const rw = kind === 'wide' ? 2.2 : 1.9, rh = kind === 'wide' ? 2.5 : 2.1;
    ctx.fillStyle = PAL.white;
    ctx.beginPath(); ctx.ellipse(ex, ey, rw * s, rh * s, 0, 0, 7); ctx.fill();
    ctx.fillStyle = PAL.ink;
    ctx.beginPath();
    ctx.ellipse(ex + look * 0.7 * s, ey + (kind === 'droop' ? 0.7 * s : 0), 1.1 * s, 1.3 * s, 0, 0, 7);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillRect(ex + look * 0.7 * s - 0.2 * s, ey - 1 * s, 0.8 * s, 0.8 * s);

    if (kind === 'angry') {
      ctx.strokeStyle = PAL.ink; ctx.lineWidth = 1.2 * s;
      ctx.beginPath();
      ctx.moveTo(ex - sx * 2.2 * s, ey - 3.4 * s);
      ctx.lineTo(ex + sx * 1.6 * s, ey - 2.2 * s);
      ctx.stroke();
    }
    if (kind === 'droop') {
      ctx.strokeStyle = PAL.ink; ctx.lineWidth = 1 * s;
      ctx.beginPath();
      ctx.moveTo(ex - sx * 2.2 * s, ey - 2.6 * s);
      ctx.lineTo(ex + sx * 1.8 * s, ey - 3.4 * s);
      ctx.stroke();
    }
  }
}

function drawMouth(ctx, dx, my, s, kind) {
  ctx.strokeStyle = PAL.ink;
  ctx.lineWidth = 1.1 * s;
  ctx.lineCap = 'round';
  ctx.beginPath();
  if (kind === 'grin') {
    ctx.moveTo(dx - 2.6 * s, my - 0.6 * s);
    ctx.quadraticCurveTo(dx, my + 2.6 * s, dx + 2.6 * s, my - 0.6 * s);
    ctx.stroke();
    ctx.fillStyle = PAL.ink;
    ctx.beginPath();
    ctx.moveTo(dx - 2.4 * s, my - 0.4 * s);
    ctx.quadraticCurveTo(dx, my + 2.4 * s, dx + 2.4 * s, my - 0.4 * s);
    ctx.closePath(); ctx.fill();
    return;
  }
  if (kind === 'smile') { ctx.moveTo(dx - 2 * s, my); ctx.quadraticCurveTo(dx, my + 1.8 * s, dx + 2 * s, my); }
  else if (kind === 'frown') { ctx.moveTo(dx - 2 * s, my + 1.4 * s); ctx.quadraticCurveTo(dx, my - 0.8 * s, dx + 2 * s, my + 1.4 * s); }
  else if (kind === 'flat') { ctx.moveTo(dx - 1.8 * s, my + 0.4 * s); ctx.lineTo(dx + 1.8 * s, my + 0.4 * s); }
  else if (kind === 'o') { ctx.ellipse(dx, my + 0.6 * s, 1.2 * s, 1.4 * s, 0, 0, 7); }
  else if (kind === 'wobble') {
    ctx.moveTo(dx - 2.2 * s, my + 0.6 * s);
    ctx.quadraticCurveTo(dx - 1.1 * s, my - 0.8 * s, dx, my + 0.6 * s);
    ctx.quadraticCurveTo(dx + 1.1 * s, my + 2 * s, dx + 2.2 * s, my + 0.6 * s);
  } else { ctx.moveTo(dx - 1 * s, my + 0.3 * s); ctx.quadraticCurveTo(dx, my + 1.4 * s, dx + 1 * s, my + 0.3 * s); }
  ctx.stroke();
}

function drawItem(ctx, x, y, s, item, pose) {
  const yy = pose === 'eat' ? y + 8 : y;
  if (item === 'raw') {
    ctx.fillStyle = '#b8564f'; ctx.fillRect(x - 3, yy, 6, 4);
    ctx.fillStyle = '#d97b6f'; ctx.fillRect(x - 3, yy, 6, 2);
  } else if (item === 'meal') {
    ctx.fillStyle = PAL.white; ctx.fillRect(x - 4, yy + 2, 8, 2);
    ctx.fillStyle = PAL.warm; ctx.fillRect(x - 3, yy - 1, 6, 3);
    ctx.fillStyle = PAL.red; ctx.fillRect(x - 1, yy - 3, 3, 2);
  } else if (item === 'burnt') {
    ctx.fillStyle = PAL.white; ctx.fillRect(x - 4, yy + 2, 8, 2);
    ctx.fillStyle = '#3a3040'; ctx.fillRect(x - 3, yy - 1, 6, 3);
  } else if (item === 'can') {
    ctx.fillStyle = '#6f9bb5'; ctx.fillRect(x - 3, yy - 1, 6, 5);
    ctx.fillStyle = '#8fbdd6'; ctx.fillRect(x + 3, yy, 3, 1);
    ctx.fillRect(x - 4, yy - 3, 2, 3);
  } else if (item === 'toy') {
    ctx.fillStyle = PAL.fabricL;
    ctx.beginPath(); ctx.arc(x, yy + 1, 3, 0, 7); ctx.fill();
    ctx.fillStyle = PAL.white; ctx.fillRect(x - 3, yy, 6, 1);
  }
}

// ---------------------------------------------------------------- emotes

const ICONS = {
  heart: (ctx, x, y) => {
    ctx.fillStyle = PAL.red;
    ctx.beginPath(); ctx.arc(x - 1.6, y - 1, 1.8, 0, 7); ctx.arc(x + 1.6, y - 1, 1.8, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x - 3.3, y - 0.4); ctx.lineTo(x, y + 3.4); ctx.lineTo(x + 3.3, y - 0.4); ctx.fill();
  },
  zzz: (ctx, x, y, t) => {
    ctx.fillStyle = PAL.white;
    ctx.font = 'bold 7px monospace'; ctx.textAlign = 'center';
    ctx.fillText('z', x - 2, y + 2 + Math.sin(t * 3) * 0.6);
    ctx.font = 'bold 5px monospace';
    ctx.fillText('z', x + 3, y - 1);
  },
  food: (ctx, x, y) => {
    ctx.fillStyle = PAL.warm; ctx.fillRect(x - 3, y - 1, 6, 3);
    ctx.fillStyle = PAL.red; ctx.fillRect(x - 1, y - 3, 3, 2);
  },
  cook: (ctx, x, y, t) => {
    ctx.fillStyle = '#c9c2d8';
    for (let i = 0; i < 3; i++) {
      ctx.fillRect(x - 2 + i * 2, y - 2 - ((t * 6 + i * 2) % 5), 1, 2);
    }
    ctx.fillStyle = PAL.steel; ctx.fillRect(x - 4, y + 1, 8, 3);
  },
  note: (ctx, x, y) => {
    ctx.fillStyle = PAL.accent2 || '#7fd0c4';
    ctx.fillRect(x + 1, y - 4, 1.4, 6);
    ctx.beginPath(); ctx.ellipse(x, y + 2, 2, 1.5, -0.3, 0, 7); ctx.fill();
  },
  star: (ctx, x, y, t) => {
    ctx.save(); ctx.translate(x, y); ctx.rotate(t * 2);
    ctx.fillStyle = '#ffd76a';
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 1.7 : 4;
      const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
      ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath(); ctx.fill(); ctx.restore();
  },
  question: (ctx, x, y) => {
    ctx.fillStyle = PAL.white; ctx.font = 'bold 9px monospace'; ctx.textAlign = 'center';
    ctx.fillText('?', x, y + 3);
  },
  excl: (ctx, x, y) => {
    ctx.fillStyle = '#ffd76a'; ctx.font = 'bold 9px monospace'; ctx.textAlign = 'center';
    ctx.fillText('!', x, y + 3);
  },
  dots: (ctx, x, y, t) => {
    ctx.fillStyle = PAL.white;
    for (let i = 0; i < 3; i++) {
      const a = Math.sin(t * 4 - i) * 0.5 + 0.5;
      ctx.globalAlpha = 0.35 + a * 0.65;
      ctx.fillRect(x - 4 + i * 3.5, y, 2, 2);
    }
    ctx.globalAlpha = 1;
  },
  drop: (ctx, x, y) => {
    ctx.fillStyle = PAL.glass;
    ctx.beginPath(); ctx.arc(x, y + 1, 2.4, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x - 2, y); ctx.lineTo(x, y - 4); ctx.lineTo(x + 2, y); ctx.fill();
  },
  book: (ctx, x, y) => {
    ctx.fillStyle = '#5aa363'; ctx.fillRect(x - 4, y - 3, 8, 6);
    ctx.fillStyle = PAL.white; ctx.fillRect(x - 0.5, y - 3, 1, 6);
  },
  good: (ctx, x, y) => {
    ctx.strokeStyle = '#79c97f'; ctx.lineWidth = 1.6; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x - 3, y); ctx.lineTo(x - 1, y + 2.5); ctx.lineTo(x + 3.5, y - 3); ctx.stroke();
  },
  bad: (ctx, x, y) => {
    ctx.strokeStyle = '#e0675f'; ctx.lineWidth = 1.6; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x - 3, y - 3); ctx.lineTo(x + 3, y + 3);
    ctx.moveTo(x + 3, y - 3); ctx.lineTo(x - 3, y + 3); ctx.stroke();
  },
};

export function drawEmote(ctx, x, y, emote, t) {
  const icon = ICONS[emote.name];
  if (!icon) return;
  const pop = Math.min(1, emote.t * 7);
  const fade = Math.min(1, (emote.dur - emote.t) * 4);
  ctx.globalAlpha = Math.max(0, Math.min(pop, fade));
  const by = y - 4 - pop * 4 + Math.sin(t * 2.5) * 0.8;

  ctx.fillStyle = 'rgba(28,23,44,0.88)';
  ctx.strokeStyle = 'rgba(120,110,160,0.6)';
  ctx.lineWidth = 1;
  roundRect(ctx, x - 9, by - 9, 18, 15, 5);
  ctx.fill(); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - 3, by + 5); ctx.lineTo(x, by + 9); ctx.lineTo(x + 3, by + 5);
  ctx.fillStyle = 'rgba(28,23,44,0.88)'; ctx.fill();

  icon(ctx, x, by - 1, t);
  ctx.globalAlpha = 1;
  ctx.textAlign = 'left';
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
