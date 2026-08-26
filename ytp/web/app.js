'use strict';

const FADE = 0.008;          // every cut gets this. never optional.
const $ = (id) => document.getElementById(id);

const state = {
  clips: [],
  activeId: null,
  words: [],
  query: '',
  selected: null,           // {clipId, s, e, w}
  mix: [],                  // [{key, clipId, s, e, w}]
  playing: null,            // active playback teardown
};

let ctx = null;
const buffers = new Map();  // clipId -> AudioBuffer
const polls = new Map();    // clipId -> interval id

/* ------------------------------------------------------------------ audio */

function audio() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

async function bufferFor(clipId) {
  if (buffers.has(clipId)) return buffers.get(clipId);
  const res = await fetch(`/api/clips/${clipId}/audio.wav`);
  if (!res.ok) throw new Error('no audio yet');
  const buf = await audio().decodeAudioData(await res.arrayBuffer());
  buffers.set(clipId, buf);
  return buf;
}

/** Schedule one slice. Returns when it ends, on the audio clock. */
function schedule(buf, at, start, end) {
  const dur = Math.max(0.01, end - start);
  const src = audio().createBufferSource();
  src.buffer = buf;
  const gain = audio().createGain();
  const fade = Math.min(FADE, dur / 2);
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(1, at + fade);
  gain.gain.setValueAtTime(1, at + dur - fade);
  gain.gain.linearRampToValueAtTime(0, at + dur);
  src.connect(gain).connect(audio().destination);
  src.start(at, start, dur);
  return { src, gain, endsAt: at + dur };
}

function stopAll() {
  if (state.playing) {
    state.playing.nodes.forEach((n) => { try { n.src.stop(); } catch (_) {} });
    state.playing.timers.forEach(clearTimeout);
    state.playing = null;
  }
  const v = $('video');
  if (v) v.pause();
  document.querySelectorAll('.w.on, .chip.on').forEach((el) => el.classList.remove('on'));
  $('play').innerHTML = '&#9654; play';
}

/** Hear one word, on its own, right now. */
async function audition(clipId, s, e, el) {
  stopAll();
  const buf = await bufferFor(clipId);
  const at = audio().currentTime + 0.02;
  const node = schedule(buf, at, s, e);
  if (el) el.classList.add('on');

  const v = $('video');
  if (v && clipId === state.activeId && v.src) {
    v.currentTime = s;
    v.play().catch(() => {});
  }

  const timers = [setTimeout(() => stopAll(), (e - s) * 1000 + 60)];
  state.playing = { nodes: [node], timers };
}

/** Play the whole mix, joined end to end. */
async function playMix() {
  if (!state.mix.length) return;
  stopAll();
  const needed = [...new Set(state.mix.map((m) => m.clipId))];
  const loaded = new Map();
  for (const id of needed) loaded.set(id, await bufferFor(id));

  const nodes = [];
  const timers = [];
  let at = audio().currentTime + 0.05;
  const v = $('video');

  state.mix.forEach((item, i) => {
    const node = schedule(loaded.get(item.clipId), at, item.s, item.e);
    nodes.push(node);
    const lead = (at - audio().currentTime) * 1000;
    timers.push(setTimeout(() => {
      document.querySelectorAll('.chip.on').forEach((c) => c.classList.remove('on'));
      const chip = $('mix').children[i];
      if (chip) chip.classList.add('on');
      if (v && item.clipId === state.activeId && v.src) {
        v.currentTime = item.s;
        v.play().catch(() => {});
      }
    }, Math.max(0, lead)));
    at = node.endsAt;
  });

  timers.push(setTimeout(stopAll, (at - audio().currentTime) * 1000 + 80));
  state.playing = { nodes, timers };
  $('play').innerHTML = '&#9632; stop';
}

/* -------------------------------------------------------------------- mix */

function mixDuration() {
  return state.mix.reduce((sum, m) => sum + (m.e - m.s), 0);
}

function addToMix(clipId, s, e, w) {
  state.mix.push({ key: Math.random().toString(36).slice(2), clipId, s, e, w });
  renderMix();
}

function renderMix() {
  const box = $('mix');
  box.innerHTML = '';
  if (!state.mix.length) {
    box.innerHTML = '<p class="mix-empty">Double-click a word on the left and it lands here.</p>';
  } else {
    state.mix.forEach((item) => {
      const chip = document.createElement('div');
      chip.className = 'chip';
      chip.draggable = true;
      chip.dataset.key = item.key;

      const label = document.createElement('span');
      label.textContent = item.w;
      chip.appendChild(label);

      const x = document.createElement('button');
      x.className = 'x';
      x.innerHTML = '&times;';
      x.title = 'remove';
      x.addEventListener('click', (ev) => {
        ev.stopPropagation();
        state.mix = state.mix.filter((m) => m.key !== item.key);
        renderMix();
      });
      chip.appendChild(x);

      chip.addEventListener('click', () => audition(item.clipId, item.s, item.e, chip));
      chip.addEventListener('dragstart', (ev) => {
        ev.dataTransfer.setData('text/ytp-key', item.key);
        ev.dataTransfer.effectAllowed = 'move';
        chip.classList.add('dragging');
      });
      chip.addEventListener('dragend', () => chip.classList.remove('dragging'));
      box.appendChild(chip);
    });
  }
  $('play').disabled = !state.mix.length;
  $('clear').disabled = !state.mix.length;
  $('save').disabled = !state.mix.length;
  $('mixTime').textContent = mixDuration().toFixed(2) + 's';
}

function keyAtPoint(x, y) {
  const chips = [...$('mix').querySelectorAll('.chip')];
  for (const chip of chips) {
    const r = chip.getBoundingClientRect();
    if (y >= r.top && y <= r.bottom && x < r.left + r.width / 2) return chip.dataset.key;
  }
  return null;
}

function wireMixDrop() {
  const box = $('mix');
  box.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    box.classList.add('drop');
  });
  box.addEventListener('dragleave', () => box.classList.remove('drop'));
  box.addEventListener('drop', (ev) => {
    ev.preventDefault();
    box.classList.remove('drop');

    const moved = ev.dataTransfer.getData('text/ytp-key');
    const grabbed = ev.dataTransfer.getData('text/ytp-word');
    const before = keyAtPoint(ev.clientX, ev.clientY);

    if (moved) {
      const idx = state.mix.findIndex((m) => m.key === moved);
      if (idx < 0) return;
      const [item] = state.mix.splice(idx, 1);
      const target = before ? state.mix.findIndex((m) => m.key === before) : -1;
      if (target < 0) state.mix.push(item);
      else state.mix.splice(target, 0, item);
      renderMix();
    } else if (grabbed) {
      const word = JSON.parse(grabbed);
      const item = { key: Math.random().toString(36).slice(2), ...word };
      const target = before ? state.mix.findIndex((m) => m.key === before) : -1;
      if (target < 0) state.mix.push(item);
      else state.mix.splice(target, 0, item);
      renderMix();
    }
  });
}

/* ----------------------------------------------------------------- saving */

async function saveMix(height, audioOnly) {
  const note = $('saveState');
  const buttons = $('saveSheet').querySelectorAll('.btn');
  buttons.forEach((b) => { b.disabled = true; });
  note.hidden = false;
  note.className = 'sheet-state';
  note.textContent = audioOnly ? 'Saving the sound…' : 'Saving your video…';

  try {
    const res = await fetch('/api/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items: state.mix.map((m) => ({ clipId: m.clipId, s: m.s, e: m.e })),
        height,
        audioOnly,
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.detail || 'something went wrong');

    const link = document.createElement('a');
    link.href = body.url;
    link.download = body.name;
    document.body.appendChild(link);
    link.click();
    link.remove();

    const mb = (body.bytes / 1e6).toFixed(1);
    note.textContent = `Saved ${body.name} (${mb} MB).`;
  } catch (err) {
    note.className = 'sheet-state bad';
    note.textContent = String(err.message || err);
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
}

/* ---------------------------------------------------------------- clips UI */

function renderTabs() {
  const box = $('tabs');
  box.innerHTML = '';
  state.clips.forEach((clip) => {
    const b = document.createElement('button');
    b.className = 'tab' + (clip.id === state.activeId ? ' on' : '') +
                  (clip.status !== 'ready' ? ' busy' : '');
    b.textContent = clip.name.replace(/\.[^.]+$/, '');
    b.title = clip.name;
    b.addEventListener('click', () => selectClip(clip.id));
    box.appendChild(b);
  });
}

function statusLine(clip) {
  const box = $('status');
  if (!clip || clip.status === 'ready') { box.hidden = true; return; }
  box.hidden = false;
  box.className = 'status' + (clip.status === 'failed' ? ' bad' : '');
  const msg = {
    importing: 'Reading the video…',
    listening: 'Listening — words appear as it goes, click them any time.',
    failed: clip.error || "I couldn't read this file. Try converting it to MP4.",
  }[clip.status] || clip.status;
  $('statusText').textContent = msg;
  $('statusBar').style.width = Math.round((clip.progress || 0) * 100) + '%';
}

function drawWave(peaks) {
  const cv = $('wave');
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  cv.width = w * dpr; cv.height = h * dpr;
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  if (!peaks || !peaks.length) return;

  const css = getComputedStyle(document.documentElement);
  g.fillStyle = css.getPropertyValue('--lime-bar').trim() || '#a3d100';
  const mid = h / 2;
  const step = peaks.length / w;
  for (let x = 0; x < w; x++) {
    const p = peaks[Math.min(peaks.length - 1, Math.floor(x * step))];
    const top = mid + p[0] * mid * 0.95;
    const bot = mid + p[1] * mid * 0.95;
    g.fillRect(x, top, 1, Math.max(1, bot - top));
  }
}

async function loadWave(clipId) {
  try {
    const res = await fetch(`/api/clips/${clipId}/peaks`);
    if (res.ok) drawWave(await res.json());
  } catch (_) { /* waveform is decoration until it isn't */ }
}

function renderScript() {
  const box = $('script');
  box.innerHTML = '';
  const q = state.query.trim().toLowerCase();
  let hits = 0;

  state.words.forEach((word) => {
    const el = document.createElement('span');
    el.className = 'w';
    el.textContent = word.w;
    if (word.p !== undefined && word.p < 0.5) el.classList.add('unsure');

    if (q) {
      if (word.w.toLowerCase().includes(q)) { el.classList.add('hit'); hits++; }
      else el.classList.add('dim');
    }

    const payload = { clipId: state.activeId, s: word.s, e: word.e, w: word.w };
    el.draggable = true;
    el.addEventListener('dragstart', (ev) => {
      ev.dataTransfer.setData('text/ytp-word', JSON.stringify(payload));
      ev.dataTransfer.effectAllowed = 'copy';
    });
    el.addEventListener('click', () => {
      state.selected = payload;
      audition(payload.clipId, word.s, word.e, el);
    });
    el.addEventListener('dblclick', (ev) => {
      ev.preventDefault();
      addToMix(payload.clipId, word.s, word.e, word.w);
    });
    box.appendChild(el);
    box.appendChild(document.createTextNode(' '));
  });

  $('searchCount').textContent = q ? (hits ? `${hits} found` : 'none') : '';
}

function applyClip(clip) {
  const idx = state.clips.findIndex((c) => c.id === clip.id);
  if (idx < 0) state.clips.push(clip); else state.clips[idx] = clip;

  if (clip.id !== state.activeId) { renderTabs(); return; }

  state.words = clip.words || [];
  renderTabs();
  statusLine(clip);
  renderScript();
  $('searchWrap').hidden = !state.words.length;
}

function pollClip(clipId) {
  if (polls.has(clipId)) return;
  const id = setInterval(async () => {
    try {
      const res = await fetch(`/api/clips/${clipId}`);
      if (!res.ok) throw new Error('gone');
      const clip = await res.json();
      applyClip(clip);
      if (clip.status === 'listening' && !buffers.has(clipId)) loadWave(clipId);
      if (clip.status === 'ready' || clip.status === 'failed') {
        clearInterval(id); polls.delete(clipId);
        if (clip.status === 'ready') loadWave(clipId);
      }
    } catch (_) {
      clearInterval(id); polls.delete(clipId);
    }
  }, 700);
  polls.set(clipId, id);
}

async function selectClip(clipId) {
  state.activeId = clipId;
  stopAll();
  const res = await fetch(`/api/clips/${clipId}`);
  if (!res.ok) return;
  const clip = await res.json();

  $('dropzone').hidden = true;
  $('loaded').hidden = false;
  const v = $('video');
  v.src = `/api/clips/${clipId}/video`;
  v.muted = true;                       // the sound comes from WebAudio, not here

  applyClip(clip);
  loadWave(clipId);
  if (clip.status !== 'ready' && clip.status !== 'failed') pollClip(clipId);
}

async function upload(file) {
  const body = new FormData();
  body.append('file', file);
  const res = await fetch('/api/clips', { method: 'POST', body });
  if (!res.ok) return;
  const clip = await res.json();
  state.clips.push(clip);
  await selectClip(clip.id);
  pollClip(clip.id);
}

/* ------------------------------------------------------------------ wiring */

function wire() {
  $('pick').addEventListener('click', () => $('file').click());
  $('add').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', (ev) => {
    [...ev.target.files].forEach(upload);
    ev.target.value = '';
  });

  ['dragenter', 'dragover'].forEach((t) =>
    document.addEventListener(t, (ev) => { ev.preventDefault(); }));
  document.addEventListener('drop', (ev) => {
    if (!ev.dataTransfer.files.length) return;
    ev.preventDefault();
    [...ev.dataTransfer.files].forEach(upload);
  });

  $('search').addEventListener('input', (ev) => {
    state.query = ev.target.value;
    renderScript();
  });

  $('play').addEventListener('click', () => {
    if (state.playing) stopAll(); else playMix();
  });
  $('clear').addEventListener('click', () => { state.mix = []; stopAll(); renderMix(); });

  $('save').addEventListener('click', () => {
    const secs = mixDuration().toFixed(2);
    $('saveInfo').textContent = `${state.mix.length} pieces, ${secs} seconds long.`;
    $('saveState').hidden = true;
    $('saveSheet').showModal();
  });
  $('saveClose').addEventListener('click', () => $('saveSheet').close());
  $('saveSheet').querySelectorAll('[data-h],[data-audio]').forEach((b) => {
    b.addEventListener('click', () => saveMix(
      Number(b.dataset.h || 0),
      b.dataset.audio === '1',
    ));
  });

  $('wave').addEventListener('click', (ev) => {
    const clip = state.clips.find((c) => c.id === state.activeId);
    if (!clip || !clip.duration) return;
    const r = ev.currentTarget.getBoundingClientRect();
    const t = ((ev.clientX - r.left) / r.width) * clip.duration;
    audition(clip.id, t, Math.min(clip.duration, t + 1.2), null);
  });

  document.addEventListener('keydown', (ev) => {
    const typing = ev.target.tagName === 'INPUT';
    if (ev.key === '/' && !typing) { ev.preventDefault(); $('search').focus(); }
    if (ev.key === ' ' && !typing) {
      ev.preventDefault();
      if (state.playing) stopAll(); else playMix();
    }
    if (ev.key === 'Enter' && !typing && state.selected) {
      const s = state.selected;
      addToMix(s.clipId, s.s, s.e, s.w);
    }
    if (ev.key === 'Escape') stopAll();
  });

  window.addEventListener('resize', () => {
    if (state.activeId) loadWave(state.activeId);
  });

  wireMixDrop();
  renderMix();
}

async function boot() {
  wire();
  try {
    const res = await fetch('/api/clips');
    state.clips = await res.json();
    renderTabs();
    if (state.clips.length) await selectClip(state.clips[state.clips.length - 1].id);
  } catch (_) { /* first run, nothing stored yet */ }
}

boot();
