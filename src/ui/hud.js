// All DOM updating lives here. The simulation never touches the document.

import { NEEDS } from '../creature/needs.js';
import { SENSE_LAYOUT } from '../creature/perception.js';
import { hhmm } from '../core/util.js';
import { drawPortrait } from '../render/renderer.js';

const $ = (sel) => document.querySelector(sel);

export function createHud(world) {
  let critter = null;
  let editingName = false;

  // ---- need bars, built once. Boredom rides along as an extra row — it's a
  // derived stat rather than a homeostatic need, but reads the same way.
  const needsHost = $('#needs');
  const bars = {};
  for (const n of NEEDS) {
    const el = document.createElement('div');
    el.className = 'need';
    el.innerHTML = `<div class="lab"><span>${n.label}</span><span class="v">0%</span></div>
      <div class="bar"><i style="background:${n.colour}"></i></div>`;
    needsHost.appendChild(el);
    bars[n.key] = { el, fill: el.querySelector('i'), val: el.querySelector('.v') };
  }
  const boredomEl = document.createElement('div');
  boredomEl.className = 'need';
  boredomEl.innerHTML = `<div class="lab"><span>boredom</span><span class="v">0%</span></div>
    <div class="bar"><i style="background:#b98fe0"></i></div>`;
  needsHost.appendChild(boredomEl);
  const boredomBar = { fill: boredomEl.querySelector('i'), val: boredomEl.querySelector('.v') };

  // ---- skill bars, built once
  const SKILLS = [
    { key: 'cooking',    label: 'cooking',    colour: '#e0a05a' },
    { key: 'fitness',    label: 'fitness',    colour: '#79c97f' },
    { key: 'creativity', label: 'creativity', colour: '#7f8fd0' },
    { key: 'charisma',   label: 'charisma',   colour: '#e79bb0' },
  ];
  const skillsHost = $('#skills');
  const skillBars = {};
  for (const s of SKILLS) {
    const el = document.createElement('div');
    el.className = 'need';
    el.innerHTML = `<div class="lab"><span>${s.label}</span><span class="v">0%</span></div>
      <div class="bar"><i style="background:${s.colour}"></i></div>`;
    skillsHost.appendChild(el);
    skillBars[s.key] = { fill: el.querySelector('i'), val: el.querySelector('.v') };
  }

  const utilHost = $('#utils');
  const utilRows = new Map();

  const affectCtx = $('#affect').getContext('2d');
  const sensorCtx = $('#sensor').getContext('2d');
  $('#sv-dims').textContent = SENSE_LAYOUT.length + ' dims';

  let t = 0;

  function needBars() {
    for (const n of NEEDS) {
      const v = critter.needs.get(n.key);
      const b = bars[n.key];
      b.fill.style.width = (v * 100).toFixed(0) + '%';
      b.val.textContent = Math.round(v * 100) + '%';
      b.el.className = 'need' + (v < 0.18 ? ' crit' : v < 0.4 ? ' low' : '');
    }
    const bd = critter.boredom;
    boredomBar.fill.style.width = (bd * 100).toFixed(0) + '%';
    boredomBar.val.textContent = Math.round(bd * 100) + '%';
    boredomEl.className = 'need' + (bd > 0.75 ? ' crit' : bd > 0.5 ? ' low' : '');

    for (const s of SKILLS) {
      const v = critter.skill[s.key] || 0;
      const b = skillBars[s.key];
      b.fill.style.width = (v * 100).toFixed(0) + '%';
      b.val.textContent = Math.round(v * 100) + '%';
    }
  }

  function aspirationAndWhim() {
    const a = critter.aspiration;
    $('#aspiration').textContent = a.icon + ' ' + a.label + ' — ' + a.flavor;
    const w = critter.whim;
    $('#whim').textContent = w ? 'wants to: ' + w.icon + ' ' + w.label : '';
  }

  function affectPlot() {
    const c = affectCtx, W = 120;
    c.clearRect(0, 0, W, W);
    c.strokeStyle = '#2b2740'; c.lineWidth = 1;
    c.beginPath(); c.moveTo(W / 2, 4); c.lineTo(W / 2, W - 4); c.moveTo(4, W / 2); c.lineTo(W - 4, W / 2); c.stroke();
    c.strokeStyle = '#232032';
    c.beginPath(); c.arc(W / 2, W / 2, W / 2 - 6, 0, 7); c.stroke();
    c.fillStyle = '#4a4468';
    c.font = '8px monospace'; c.textAlign = 'center';
    c.fillText('wired', W / 2, 10); c.fillText('dozy', W / 2, W - 3);

    const x = W / 2 + critter.emotion.valence * (W / 2 - 8);
    const y = W / 2 - critter.emotion.arousal * (W / 2 - 8);
    const pulse = 3 + Math.sin(t * 3) * 0.7;
    c.fillStyle = 'rgba(242,180,107,0.22)';
    c.beginPath(); c.arc(x, y, pulse + 5, 0, 7); c.fill();
    c.fillStyle = '#f2b46b';
    c.beginPath(); c.arc(x, y, pulse, 0, 7); c.fill();
  }

  function sensorPlot() {
    const c = sensorCtx, W = 240, H = 80;
    const vec = critter.senseVec;
    c.clearRect(0, 0, W, H);
    const cols = 30;
    const cw = W / cols, rows = Math.ceil(vec.length / cols), ch = H / rows;
    for (let i = 0; i < vec.length; i++) {
      const cx = (i % cols) * cw, cy = Math.floor(i / cols) * ch;
      const v = Math.max(0, Math.min(1, vec[i]));
      c.fillStyle = `rgba(127,208,196,${0.08 + v * 0.92})`;
      c.fillRect(cx + 0.5, cy + 0.5, cw - 1, ch - 1);
    }
  }

  function utilities() {
    const ranking = critter.brain.ranking;
    if (!ranking.length) return;
    const max = Math.max(0.001, ranking[0].score);
    const current = critter.task?.action.id;
    const seen = new Set();
    for (const r of ranking.slice(0, 9)) {
      seen.add(r.action.id);
      let row = utilRows.get(r.action.id);
      if (!row) {
        const el = document.createElement('div');
        el.className = 'util';
        el.innerHTML = `<div class="lab"><span class="n"></span><span class="v"></span></div>
          <div class="bar"><i></i></div>`;
        utilHost.appendChild(el);
        row = { el, name: el.querySelector('.n'), val: el.querySelector('.v'), fill: el.querySelector('i') };
        utilRows.set(r.action.id, row);
      }
      row.name.textContent = r.action.id;
      row.val.textContent = r.score.toFixed(2);
      row.fill.style.width = Math.max(0, (r.score / max) * 100).toFixed(0) + '%';
      row.el.className = 'util' + (r.action.id === current ? ' pick' : '');
      utilHost.appendChild(row.el);          // re-append = re-sort by rank
    }
    for (const [id, row] of utilRows) if (!seen.has(id)) row.el.remove(), utilRows.delete(id);
  }

  function memoryList() {
    const known = [...critter.memory.objects.entries()];
    $('#memlist').innerHTML = known.length
      ? known.map(([id, m]) => {
        const fam = Math.round(m.familiarity * 100);
        const a = m.assoc > 0.05 ? ' <span style="color:#79c97f">+</span>'
          : m.assoc < -0.05 ? ' <span style="color:#e0675f">−</span>' : '';
        return `${m.type} <span style="opacity:.6">${fam}%</span>${a}`;
      }).join('<br>')
      : 'nothing yet — it has to look around first';
  }

  function thoughts() {
    $('#thoughts').innerHTML = critter.thoughts.slice(0, 6)
      .map((s) => `<div>${s}</div>`).join('');
  }

  function moodlets() {
    const list = critter.moodlets.list();
    $('#moodlets').innerHTML = list.length
      ? list.map((m) => `<span class="moodlet ${m.tone}"><span class="ic">${m.icon}</span>${m.label}
          <span class="hrs">${Math.ceil(m.hoursLeft)}h</span></span>`).join('')
      : '<span class="dim">none right now</span>';
  }

  function friendships(critters) {
    const card = $('#friends-card');
    const others = (critters || []).filter((c) => c !== critter);
    card.hidden = others.length === 0;
    if (!others.length) return;
    $('#friends').innerHTML = others.map((p) => {
      const v = Math.round(critter.relationshipWith(p.id) * 100);
      return `<div class="friend-row"><span class="name">${p.name}</span>
        <span class="bar"><i style="width:${v}%;background:#e79bb0"></i></span>
        <span class="pct">${v}%</span></div>`;
    }).join('');
  }

  let slowT = 0;

  return {
    /** Switch which critter the panels describe — used when the user clicks
     *  a different one, or when a new one is spawned. */
    setCritter(c) {
      critter = c;
      for (const [, row] of utilRows) row.el.remove();
      utilRows.clear();
    },
    get critter() { return critter; },
    setEditingName(v) { editingName = v; },

    update(dt, allCritters) {
      if (!critter) return;
      t += dt;
      needBars();
      affectPlot();

      if (!editingName) $('#c-name').textContent = critter.name;
      $('#c-stage').textContent = critter.stage.name;
      $('#c-age').textContent = 'day ' + Math.floor(critter.ageDays);
      $('#c-mood').textContent = critter.away ? 'exploring' : critter.emotion.label().name;
      if (critter.away) {
        $('#c-room').textContent = 'outside';
      } else {
        const room = world.roomAt(Math.round(critter.gx), Math.round(critter.gy));
        $('#c-room').textContent = 'Room ' + room + ' · ' + world.themeFor(room).label;
      }
      $('#a-val').textContent = critter.emotion.valence.toFixed(2);
      $('#a-aro').textContent = critter.emotion.arousal.toFixed(2);
      $('#a-bond').textContent = Math.round(critter.bond * 100) + '%';
      $('#current-action').textContent = critter.currentLabel()
        + (critter.holding ? ' · holding ' + critter.holding : '');
      $('#clock').textContent = hhmm(world.minutes);

      drawPortrait($('#portrait'), critter, t);

      slowT += dt;
      if (slowT > 0.25) {
        slowT = 0;
        thoughts();
        aspirationAndWhim();
        moodlets();
        friendships(allCritters);
        if (!$('#panel-right').classList.contains('hidden')) {
          sensorPlot();
          utilities();
          memoryList();
          const acc = critter.brain.neural.accuracy;
          $('#nn-acc').textContent = critter.brain.neural.samples > 20 ? Math.round(acc * 100) + '%' : '—';
          $('#nn-n').textContent = critter.brain.neural.samples + ' samples';
          $('#nn-bar').style.width = Math.round(acc * 100) + '%';
          const nb = critter.brain.neural;
          $('#nn-reward').textContent = nb.rewardSamples > 10 ? nb.avgReward.toFixed(3) : '—';
          $('#nn-rn').textContent = nb.rewardSamples + ' outcomes';
          const rb = $('#nn-reward-bar');
          rb.style.width = Math.round(((nb.avgReward + 1) / 2) * 100) + '%';
          rb.style.background = nb.avgReward >= 0 ? 'var(--good)' : 'var(--bad)';
        }
      }
    },
  };
}

/** The row of small portraits above the needs panel when more than one
 *  critter shares the room — click one to make it the active critter. */
export function renderCritterSwitcher(host, critters, activeId, onPick) {
  if (critters.length < 2) { host.innerHTML = ''; host.hidden = true; return; }
  host.hidden = false;
  host.innerHTML = '';
  for (const c of critters) {
    const b = document.createElement('button');
    b.className = 'crit-tab' + (c.id === activeId ? ' on' : '');
    b.textContent = c.name;
    b.title = c.away ? c.name + ' (out exploring)' : c.name;
    b.addEventListener('click', () => onPick(c));
    host.appendChild(b);
  }
}
