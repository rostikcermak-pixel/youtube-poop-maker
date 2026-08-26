// The whole app, running in the tab. No server, nothing uploaded.

import { peaks, snapPoints, splitSyllables } from './analysis.js';
import { RATE, decodeTo16kMono, mixdown, toWav } from './audio.js';
import { MODELS, listen } from './asr.js';
import { recordMix, supported as canRecord } from './export.js';
import { load as loadSounds, soundsOf, tidy } from './phonemes.js';
import { indexSounds, planWord } from './wordbuild.js';

const FADE = 0.008;          // every cut gets this. never optional.
const SNAP_PULL = 0.035;     // how close a handle gets before it sticks
const ZOOM_PAD = 0.3;        // context shown either side of the word

const $ = (id) => document.getElementById(id);

const state = {
  clips: [],                 // {id, name, samples, peaks, words, url, duration, status}
  activeId: null,
  words: [],
  query: '',
  selected: null,
  zoom: null,
  mix: [],
  caret: 0,               // where the next thing lands in the mix
  playing: null,
  sounds: null,           // cached index of every sound in every clip
};

let ctx = null;
const buffers = new Map();   // clipId -> AudioBuffer, built once per clip

/* ------------------------------------------------------------------ audio */

function audio() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function bufferFor(clipId) {
  if (buffers.has(clipId)) return buffers.get(clipId);
  const clip = state.clips.find((c) => c.id === clipId);
  if (!clip) return null;
  const buf = audio().createBuffer(1, clip.samples.length, RATE);
  buf.copyToChannel(clip.samples, 0);
  buffers.set(clipId, buf);
  return buf;
}

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
  return { src, endsAt: at + dur };
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

function audition(clipId, s, e, el) {
  stopAll();
  const buf = bufferFor(clipId);
  if (!buf) return;
  const node = schedule(buf, audio().currentTime + 0.02, s, e);
  if (el) el.classList.add('on');

  const v = $('video');
  if (v && clipId === state.activeId && v.src) {
    v.currentTime = s;
    v.play().catch(() => {});
  }
  state.playing = { nodes: [node], timers: [setTimeout(stopAll, (e - s) * 1000 + 60)] };
}

/** Play a run of pieces back to back. Used by the mix and by previews. */
function playPieces(list, { highlight = false } = {}) {
  if (!list.length) return;
  stopAll();
  const nodes = [];
  const timers = [];
  let at = audio().currentTime + 0.05;
  const v = $('video');

  list.forEach((item, i) => {
    const buf = bufferFor(item.clipId);
    if (!buf) return;
    const node = schedule(buf, at, item.s, item.e);
    nodes.push(node);
    const lead = (at - audio().currentTime) * 1000;
    timers.push(setTimeout(() => {
      document.querySelectorAll('.chip.on').forEach((c) => c.classList.remove('on'));
      const chip = highlight ? $('mix').querySelectorAll('.chip')[i] : null;
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
  if (highlight) $('play').innerHTML = '&#9632; stop';
}

function playMix() {
  playPieces(state.mix, { highlight: true });
}

/* -------------------------------------------------------------------- mix */

// Losing twenty minutes of work to a mis-tapped x is the fastest way to make
// someone close the tab, so every change to the mix is reversible.
const history = [];

function remember() {
  history.push(JSON.stringify({ mix: state.mix, caret: state.caret }));
  if (history.length > 200) history.shift();
}

function undo() {
  const previous = history.pop();
  if (previous === undefined) return;
  const was = JSON.parse(previous);
  state.mix = was.mix;
  state.caret = Math.min(was.caret, state.mix.length);
  stopAll();
  renderMix();
}

const mixDuration = () => state.mix.reduce((sum, m) => sum + (m.e - m.s), 0);

/** Put pieces in at the caret, then leave the caret after what was added. */
function insertIntoMix(pieces) {
  remember();
  const items = pieces.map((p) => ({ key: Math.random().toString(36).slice(2), ...p }));
  const at = Math.max(0, Math.min(state.caret, state.mix.length));
  state.mix.splice(at, 0, ...items);
  state.caret = at + items.length;
  renderMix();
}

function addToMix(clipId, s, e, w) {
  insertIntoMix([{ clipId, s, e, w }]);
}

function caretMark() {
  const mark = document.createElement('span');
  mark.className = 'caret';
  mark.title = 'the next word lands here';
  return mark;
}

function renderMix() {
  const box = $('mix');
  box.innerHTML = '';
  state.caret = Math.max(0, Math.min(state.caret, state.mix.length));

  if (!state.mix.length) {
    box.innerHTML = '<p class="mix-empty">Double-click a word on the left and it lands here.</p>';
  } else {
    state.mix.forEach((item, index) => {
      if (index === state.caret) box.appendChild(caretMark());
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
        remember();
        // A built word arrives as several chips that only mean anything
        // together, so removing one removes the whole word rather than
        // leaving orphaned continuation chips behind.
        const doomed = item.group
          ? state.mix.filter((m) => m.group === item.group).map((m) => m.key)
          : [item.key];
        const first = state.mix.findIndex((m) => doomed.includes(m.key));
        state.mix = state.mix.filter((m) => !doomed.includes(m.key));
        if (first > -1 && first < state.caret) {
          state.caret = Math.max(first, state.caret - doomed.length);
        }
        renderMix();
      });
      chip.appendChild(x);

      chip.addEventListener('click', () => audition(item.clipId, item.s, item.e, chip));
      chip.addEventListener('dragstart', (ev) => {
        ev.dataTransfer.setData('text/ytp-key', item.key);
        chip.classList.add('dragging');
      });
      chip.addEventListener('dragend', () => chip.classList.remove('dragging'));
      box.appendChild(chip);
    });
    if (state.caret >= state.mix.length) box.appendChild(caretMark());
  }
  $('play').disabled = !state.mix.length;
  $('clear').disabled = !state.mix.length;
  $('save').disabled = !state.mix.length;
  $('mixTime').textContent = mixDuration().toFixed(2) + 's';
}

function keyAtPoint(x, y) {
  for (const chip of $('mix').querySelectorAll('.chip')) {
    const r = chip.getBoundingClientRect();
    if (y >= r.top && y <= r.bottom && x < r.left + r.width / 2) return chip.dataset.key;
  }
  return null;
}

/** Clicking between chips is how you choose where the next word goes. */
function wireCaret() {
  $('mix').addEventListener('click', (ev) => {
    if (ev.target.closest('.chip')) return;      // clicking a chip plays it
    const chips = [...$('mix').querySelectorAll('.chip')];
    let at = chips.length;
    for (let i = 0; i < chips.length; i++) {
      const r = chips[i].getBoundingClientRect();
      const past = ev.clientY > r.bottom || (ev.clientY >= r.top && ev.clientX > r.left + r.width / 2);
      if (!past) { at = i; break; }
    }
    state.caret = at;
    renderMix();
  });
}

function wireMixDrop() {
  const box = $('mix');
  box.addEventListener('dragover', (ev) => { ev.preventDefault(); box.classList.add('drop'); });
  box.addEventListener('dragleave', () => box.classList.remove('drop'));
  box.addEventListener('drop', (ev) => {
    ev.preventDefault();
    box.classList.remove('drop');
    const moved = ev.dataTransfer.getData('text/ytp-key');
    const grabbed = ev.dataTransfer.getData('text/ytp-word');
    const before = keyAtPoint(ev.clientX, ev.clientY);
    const at = before ? state.mix.findIndex((m) => m.key === before) : -1;

    if (moved) {
      const idx = state.mix.findIndex((m) => m.key === moved);
      if (idx < 0) return;
      remember();
      const [item] = state.mix.splice(idx, 1);
      if (at < 0) state.mix.push(item); else state.mix.splice(at, 0, item);
      renderMix();
    } else if (grabbed) {
      const item = { key: Math.random().toString(36).slice(2), ...JSON.parse(grabbed) };
      if (at < 0) state.mix.push(item); else state.mix.splice(at, 0, item);
      renderMix();
    }
  });
}

/* ------------------------------------------------- cutting inside a word */

const zoomX = (t, width) => ((t - state.zoom.from) / (state.zoom.to - state.zoom.from)) * width;
const zoomT = (x, width) => state.zoom.from + (x / width) * (state.zoom.to - state.zoom.from);

function snapTo(t, free) {
  const z = state.zoom;
  if (free || !z.snaps.length) return t;
  let best = t;
  let gap = SNAP_PULL;
  for (const mark of z.snaps) {
    const d = Math.abs(mark - t);
    if (d < gap) { gap = d; best = mark; }
  }
  return best;
}

function drawZoom() {
  const z = state.zoom;
  if (!z) return;
  const cv = $('zoomWave');
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  if (!w) return;
  cv.width = w * dpr; cv.height = h * dpr;
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);

  const css = getComputedStyle(document.documentElement);
  const lime = css.getPropertyValue('--lime-bar').trim() || '#a3d100';
  const dim = css.getPropertyValue('--line2').trim() || '#d3d0e2';
  const x0 = zoomX(z.s, w);
  const x1 = zoomX(z.e, w);
  const mid = h / 2;
  const step = z.peaks.length / w;

  for (let x = 0; x < w; x++) {
    const p = z.peaks[Math.min(z.peaks.length - 1, Math.floor(x * step))];
    if (!p) continue;
    g.fillStyle = x >= x0 && x <= x1 ? lime : dim;
    const top = mid + p[0] * mid * 0.92;
    const bot = mid + p[1] * mid * 0.92;
    g.fillRect(x, top, 1, Math.max(1, bot - top));
  }
  g.fillStyle = 'rgba(120,116,150,.14)';
  g.fillRect(0, 0, Math.max(0, x0), h);
  g.fillRect(Math.min(w, x1), 0, w, h);

  $('hStart').style.left = x0 + 'px';
  $('hEnd').style.left = x1 + 'px';
  $('zoomTime').textContent =
    `${z.s.toFixed(2)}s – ${z.e.toFixed(2)}s  (${(z.e - z.s).toFixed(2)}s)`;
}

function openZoom(clipId, word) {
  const clip = state.clips.find((c) => c.id === clipId);
  if (!clip) return;

  const from = Math.max(0, word.s - ZOOM_PAD);
  const to = Math.min(clip.duration, word.e + ZOOM_PAD);
  const view = clip.samples.subarray(Math.round(from * RATE), Math.round(to * RATE));
  const body = clip.samples.subarray(Math.round(word.s * RATE), Math.round(word.e * RATE));

  state.zoom = {
    clipId,
    w: word.w,
    s: word.s,
    e: word.e,
    from,
    to,
    peaks: peaks(view, 900),
    snaps: snapPoints(view, RATE).map((t) => from + t),
    syllables: splitSyllables(body, RATE).map((p) => ({ s: word.s + p.s, e: word.s + p.e })),
    active: 'start',
  };
  $('zoom').hidden = false;
  $('zoomWord').textContent = word.w;
  renderSyllables();
  drawZoom();
}

function renderSyllables() {
  const box = $('sylls');
  box.innerHTML = '';
  const z = state.zoom;
  if (!z || z.syllables.length < 2) return;

  z.syllables.forEach((piece, i) => {
    const el = document.createElement('button');
    el.className = 'syl';
    el.textContent = `piece ${i + 1}`;
    el.title = `${(piece.e - piece.s).toFixed(2)}s — click to hear, double-click to add`;
    el.addEventListener('click', () => {
      document.querySelectorAll('.syl.on').forEach((s) => s.classList.remove('on'));
      el.classList.add('on');
      state.zoom.s = piece.s;
      state.zoom.e = piece.e;
      drawZoom();
      audition(z.clipId, piece.s, piece.e, null);
    });
    el.addEventListener('dblclick', (ev) => {
      ev.preventDefault();
      addToMix(z.clipId, piece.s, piece.e, z.w);
    });
    box.appendChild(el);
  });
}

function dragHandle(el, which) {
  el.addEventListener('pointerdown', (ev) => {
    if (!state.zoom) return;
    ev.preventDefault();
    el.setPointerCapture(ev.pointerId);
    el.classList.add('live');
    state.zoom.active = which;
    const strip = $('zoomWave');

    const move = (e) => {
      const r = strip.getBoundingClientRect();
      const z = state.zoom;
      const t = snapTo(zoomT(e.clientX - r.left, r.width), e.altKey);
      if (which === 'start') z.s = Math.max(z.from, Math.min(t, z.e - 0.02));
      else z.e = Math.min(z.to, Math.max(t, z.s + 0.02));
      drawZoom();
    };
    const up = () => {
      el.classList.remove('live');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      audition(state.zoom.clipId, state.zoom.s, state.zoom.e, null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

function nudge(seconds) {
  const z = state.zoom;
  if (!z) return;
  if (z.active === 'start') z.s = Math.max(z.from, Math.min(z.s + seconds, z.e - 0.02));
  else z.e = Math.min(z.to, Math.max(z.e + seconds, z.s + 0.02));
  drawZoom();
  audition(z.clipId, z.s, z.e, null);
}

/**
 * Which speech model to use.
 *
 * The bigger one is noticeably more accurate but runs several times slower,
 * and on a phone under WebAssembly that is the difference between a wait and
 * something that looks like it has hung. Small screens and low core counts
 * get the small model unless the URL says otherwise.
 */
function chosenQuality() {
  const asked = new URLSearchParams(location.search).get('model');
  if (asked === 'fast' || asked === 'good') return asked;

  // A small screen you can touch is a phone. Core count is only a tie-breaker
  // for genuinely feeble machines: plenty of perfectly capable desktops report
  // four, so treating four as weak downgrades everybody.
  const narrow = Math.min(screen.width || 9999, screen.height || 9999) < 820;
  const touch = (navigator.maxTouchPoints || 0) > 0;
  const feeble = (navigator.hardwareConcurrency || 8) <= 2;
  return (narrow && touch) || feeble ? 'fast' : 'good';
}

/* ---------------------------------------------------------------- clips UI */

function renderTabs() {
  const box = $('tabs');
  box.innerHTML = '';
  state.clips.forEach((clip) => {
    const tab = document.createElement('span');
    tab.className = 'tab' + (clip.id === state.activeId ? ' on' : '') +
                    (clip.status !== 'ready' ? ' busy' : '');

    const name = document.createElement('button');
    name.className = 'tab-name';
    name.textContent = clip.name.replace(/\.[^.]+$/, '');
    name.title = clip.name;
    name.addEventListener('click', () => selectClip(clip.id));
    tab.appendChild(name);

    const close = document.createElement('button');
    close.className = 'tab-x';
    close.innerHTML = '&times;';
    close.title = 'close this video';
    close.setAttribute('aria-label', `close ${clip.name}`);
    close.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeClip(clip.id);
    });
    tab.appendChild(close);

    box.appendChild(tab);
  });
}

/** Drop a clip and everything that points at it. */
function closeClip(clipId) {
  const clip = state.clips.find((c) => c.id === clipId);
  if (!clip) return;

  const inMix = state.mix.filter((m) => m.clipId === clipId).length;
  if (inMix && !window.confirm(
    `${inMix} piece${inMix > 1 ? 's' : ''} of your mix came from this video and will go too. Close it?`)) {
    return;
  }

  stopAll();
  if (inMix) remember();
  state.mix = state.mix.filter((m) => m.clipId !== clipId);
  state.caret = Math.min(state.caret, state.mix.length);

  // let go of the decoded audio, the blob and the hidden export element
  buffers.delete(clipId);
  URL.revokeObjectURL(clip.url);
  if (clip.exportVideo) clip.exportVideo.remove();
  state.clips = state.clips.filter((c) => c.id !== clipId);
  state.sounds = null;                    // the sound index is now stale

  if (state.activeId === clipId) {
    state.activeId = null;
    state.zoom = null;
    state.words = [];
    $('zoom').hidden = true;
    if (state.clips.length) {
      selectClip(state.clips[state.clips.length - 1].id);
    } else {
      $('loaded').hidden = true;
      $('dropzone').hidden = false;
      $('searchWrap').hidden = true;
      $('script').innerHTML = '';
      setStatus('');
      $('video').removeAttribute('src');
    }
  }
  renderTabs();
  renderMix();
}

function setStatus(message, fraction, bad) {
  const box = $('status');
  if (!message) { box.hidden = true; return; }
  box.hidden = false;
  box.className = 'status' + (bad ? ' bad' : '');
  $('statusText').textContent = message;
  $('statusBar').style.width = Math.round((fraction || 0) * 100) + '%';
}

function drawWave(clip) {
  const cv = $('wave');
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  if (!w || !clip.peaks) return;
  cv.width = w * dpr; cv.height = h * dpr;
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  g.fillStyle = getComputedStyle(document.documentElement)
    .getPropertyValue('--lime-bar').trim() || '#a3d100';

  const mid = h / 2;
  const step = clip.peaks.length / w;
  for (let x = 0; x < w; x++) {
    const p = clip.peaks[Math.min(clip.peaks.length - 1, Math.floor(x * step))];
    const top = mid + p[0] * mid * 0.95;
    const bot = mid + p[1] * mid * 0.95;
    g.fillRect(x, top, 1, Math.max(1, bot - top));
  }
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
    if (q) {
      if (word.w.toLowerCase().includes(q)) { el.classList.add('hit'); hits++; }
      else el.classList.add('dim');
    }

    const payload = { clipId: state.activeId, s: word.s, e: word.e, w: word.w };
    el.draggable = true;
    el.addEventListener('dragstart', (ev) => {
      ev.dataTransfer.setData('text/ytp-word', JSON.stringify(payload));
    });
    el.addEventListener('click', () => {
      state.selected = payload;
      audition(payload.clipId, word.s, word.e, el);
      openZoom(payload.clipId, word);
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

function selectClip(clipId) {
  const clip = state.clips.find((c) => c.id === clipId);
  if (!clip) return;
  state.activeId = clipId;
  state.zoom = null;
  stopAll();

  $('zoom').hidden = true;
  $('dropzone').hidden = true;
  $('loaded').hidden = false;
  $('video').hidden = false;
  $('novideo').hidden = true;

  const v = $('video');
  if (v.src !== clip.url) {
    v.src = clip.url;
    v.addEventListener('loadeddata', () => { if (!v.currentTime) v.currentTime = 0.04; },
                       { once: true });
    v.addEventListener('error', () => {
      v.hidden = true;
      $('novideo').hidden = false;
    }, { once: true });
  }
  v.muted = true;

  state.words = clip.words || [];
  renderTabs();
  renderScript();
  drawWave(clip);
  $('searchWrap').hidden = !state.words.length;
  setStatus(clip.status === 'ready' ? '' : clip.statusText, clip.progress, clip.status === 'failed');
}

async function importFile(file) {
  const clip = {
    id: Math.random().toString(36).slice(2, 12),
    name: file.name || 'clip',
    url: URL.createObjectURL(file),
    samples: new Float32Array(0),
    peaks: null,
    words: [],
    duration: 0,
    status: 'reading',
    statusText: 'Reading the video…',
    progress: 0.02,
  };
  state.clips.push(clip);
  selectClip(clip.id);

  const show = (text, fraction) => {
    clip.statusText = text;
    clip.progress = fraction;
    if (state.activeId === clip.id) setStatus(text, fraction, false);
  };

  try {
    show('Reading the video…', 0.05);
    clip.samples = await decodeTo16kMono(file);
    clip.duration = clip.samples.length / RATE;
    clip.peaks = peaks(clip.samples, 2000);
    if (state.activeId === clip.id) drawWave(clip);

    show('Getting the listener ready…', 0.1);

    const quality = chosenQuality();
    let phase = 'downloading';

    clip.words = await listen(clip.samples, {
      quality,
      onPhase: (which) => {
        phase = which;
        if (which !== 'listening') return;
        show('Listening… the words appear as it goes, and you can start '
           + 'clicking them straight away.', 0.55);
      },
      onWords: (found, fraction) => {
        // Show what has been heard so far rather than making someone wait for
        // the whole file. On a five minute clip the opening lines are usable
        // long before the end has been read.
        clip.words = found;
        if (state.activeId === clip.id) {
          state.words = found;
          renderScript();
          $('searchWrap').hidden = !found.length;
        }
        const done = Math.round(fraction * 100);
        show(`Listening… ${done}% — the ${found.length} words found so far are `
           + 'already clickable.', 0.55 + fraction * 0.45);
      },
      onProgress: (fraction) => {
        if (phase !== 'downloading') return;
        if (fraction >= 0.999) {
          // Downloading finishing is not the same as being ready: the model
          // still has to be compiled, which reports nothing and is slow on a
          // phone. Leaving "100%" up through that is what makes it look stuck.
          show('Unpacking the model… this takes a moment.', 0.55);
          return;
        }
        show(`Downloading the speech model, ${Math.round(fraction * 100)}% — one `
           + `time only, then it’s kept…`, 0.1 + fraction * 0.45);
      },
    });

    clip.status = 'ready';
    show('', 1);
    if (state.activeId === clip.id) {
      state.words = clip.words;
      renderScript();
      $('searchWrap').hidden = false;
      setStatus('', 1);
    }
    renderTabs();
  } catch (err) {
    clip.status = 'failed';
    const message = String(err && err.message ? err.message : err);
    clip.statusText = message;
    if (state.activeId === clip.id) setStatus(message, 1, true);
    renderTabs();
  }
}

/* --------------------------------------------- making a word he never said */

/** Every sound in every loaded clip, indexed so runs of them can be found. */
function soundsIndex() {
  const signature = state.clips.map((c) => `${c.id}:${(c.words || []).length}`).join(',');
  if (state.sounds && state.sounds.signature === signature) return state.sounds.index;

  const words = [];
  for (const clip of state.clips) {
    for (const word of clip.words || []) {
      const phones = soundsOf(word.w);
      if (phones) {
        words.push({ w: word.w, phones, clipId: clip.id, s: word.s, e: word.e });
      }
    }
  }
  const index = indexSounds(words);
  state.sounds = { signature, index, counted: words.length };
  return index;
}

function note(text, bad) {
  const out = $('makeOut');
  out.innerHTML = '';
  const p = document.createElement('p');
  p.className = 'maker-note' + (bad ? ' bad' : '');
  p.textContent = text;
  out.appendChild(p);
}

function showOptions(target, options) {
  const out = $('makeOut');
  out.innerHTML = '';

  options.forEach((option) => {
    const row = document.createElement('div');
    row.className = 'option';

    const how = document.createElement('span');
    how.className = 'how';
    how.innerHTML = option.pieces
      .map((piece) => `<b>${piece.from}</b>`)
      .join(' + ');
    row.appendChild(how);

    const joins = document.createElement('span');
    joins.className = 'joins';
    joins.textContent = option.joins === 0 ? 'as said' : `${option.joins} join${option.joins > 1 ? 's' : ''}`;
    row.appendChild(joins);

    const hear = document.createElement('button');
    hear.innerHTML = '&#9654;';
    hear.title = 'hear it';
    hear.addEventListener('click', () => playPieces(option.pieces));
    row.appendChild(hear);

    const use = document.createElement('button');
    use.className = 'use';
    use.textContent = 'insert';
    use.title = 'put it in the mix where the caret is';
    use.addEventListener('click', () => {
      const group = Math.random().toString(36).slice(2);
      insertIntoMix(option.pieces.map((piece, i) => ({
        clipId: piece.clipId,
        s: piece.s,
        e: piece.e,
        group,
        // one word can span several clips, so only the first chip carries the
        // name and the rest read as a continuation of it
        w: i === 0 ? target : '\u2026',
      })));
    });
    row.appendChild(use);

    out.appendChild(row);
  });
}

async function makeWord() {
  const raw = $('makeWord').value;
  const target = tidy(raw);
  if (!target) return;

  const ready = state.clips.some((c) => (c.words || []).length);
  if (!ready) {
    note('Load a video first, so there are some sounds to build it out of.', true);
    return;
  }

  note('Looking up how that is said\u2026');
  try {
    await loadSounds();
  } catch (err) {
    note("Couldn't load the pronunciation dictionary. Check your connection.", true);
    return;
  }

  const phones = soundsOf(target);
  if (!phones) {
    note(`I don't know how "${raw.trim()}" is pronounced, so I can't build it.`, true);
    return;
  }

  const options = planWord(phones, soundsIndex());
  if (!options.length) {
    note(`There aren't enough of the right sounds in this video to make "${target}". `
       + 'Try loading another clip as well.', true);
    return;
  }
  showOptions(target, options);
}

/* ----------------------------------------------------------------- saving */

function download(blob, name) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
}

/** A muted, off-screen video per clip, so export can pull frames from any of them. */
function exportSources() {
  const map = new Map();
  for (const clip of state.clips) {
    if (!clip.samples.length) continue;
    if (!clip.exportVideo) {
      const el = document.createElement('video');
      el.src = clip.url;
      el.muted = true;
      el.playsInline = true;
      el.preload = 'auto';
      el.style.cssText = 'position:fixed;left:-9999px;width:2px;height:2px';
      document.body.appendChild(el);
      clip.exportVideo = el;
    }
    map.set(clip.id, { samples: clip.samples, rate: RATE, video: clip.exportVideo });
  }
  return map;
}

async function saveVideo(height) {
  const note = $('saveState');
  const buttons = [...$('saveSheet').querySelectorAll('.btn')];
  buttons.forEach((b) => { b.disabled = true; });
  note.hidden = false;
  note.className = 'sheet-state';
  note.textContent = 'Getting ready…';

  try {
    if (!canRecord()) {
      throw new Error("This browser can't record video. Try Chrome or Edge, or save just the sound.");
    }
    stopAll();
    const width = Math.round((height * 16) / 9 / 2) * 2;
    const { blob, name, seconds } = await recordMix(state.mix, exportSources(), {
      width,
      height,
      onProgress: (fraction) => {
        note.textContent = `Saving your video, ${Math.round(fraction * 100)}%…`;
      },
    });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T-]/g, '');
    download(blob, name.replace('poop.', `poop-${stamp}.`));
    note.textContent = `Saved ${seconds.toFixed(2)}s, ${(blob.size / 1e6).toFixed(1)} MB.`;
  } catch (err) {
    note.className = 'sheet-state bad';
    note.textContent = String(err && err.message ? err.message : err);
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
}

function saveMix() {
  const note = $('saveState');
  note.hidden = false;
  note.className = 'sheet-state';
  note.textContent = 'Saving the sound…';
  try {
    const samples = mixdown(state.mix, new Map(state.clips.map((c) => [c.id, c.samples])));
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
    download(toWav(samples), `poop-${stamp}.wav`);
    note.textContent = `Saved ${(samples.length / RATE).toFixed(2)}s of sound.`;
  } catch (err) {
    note.className = 'sheet-state bad';
    note.textContent = String(err && err.message ? err.message : err);
  }
}

/* ------------------------------------------------------------------ wiring */

function wire() {
  // Say the size of the model this device will actually get, not a number
  // that is wrong for half of them.
  const picked = MODELS[chosenQuality()] || MODELS.good;
  const note = $('firstrun');
  if (note) {
    note.textContent = `First time only, it downloads about ${picked.mb} MB of speech `
      + `model, then keeps it.`;
  }

  $('pick').addEventListener('click', () => $('file').click());
  $('add').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', (ev) => {
    [...ev.target.files].forEach(importFile);
    ev.target.value = '';
  });

  ['dragenter', 'dragover'].forEach((t) =>
    document.addEventListener(t, (ev) => ev.preventDefault()));
  document.addEventListener('drop', (ev) => {
    if (!ev.dataTransfer.files.length) return;
    ev.preventDefault();
    [...ev.dataTransfer.files].forEach(importFile);
  });

  $('search').addEventListener('input', (ev) => {
    state.query = ev.target.value;
    renderScript();
  });

  $('play').addEventListener('click', () => { if (state.playing) stopAll(); else playMix(); });
  $('clear').addEventListener('click', () => {
    remember();
    state.mix = [];
    state.caret = 0;
    stopAll();
    renderMix();
  });

  $('makeGo').addEventListener('click', makeWord);
  $('makeWord').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); makeWord(); }
  });

  $('save').addEventListener('click', () => {
    $('saveInfo').textContent =
      `${state.mix.length} pieces, ${mixDuration().toFixed(2)} seconds long.`;
    $('saveState').hidden = true;
    $('saveSheet').showModal();
  });
  $('saveClose').addEventListener('click', () => $('saveSheet').close());
  $('saveSheet').querySelectorAll('[data-audio]').forEach((b) =>
    b.addEventListener('click', saveMix));
  $('saveSheet').querySelectorAll('[data-video]').forEach((b) =>
    b.addEventListener('click', () => saveVideo(Number(b.dataset.video))));

  dragHandle($('hStart'), 'start');
  dragHandle($('hEnd'), 'end');
  $('zoomPlay').addEventListener('click', () => {
    const z = state.zoom;
    if (z) audition(z.clipId, z.s, z.e, null);
  });
  $('zoomAdd').addEventListener('click', () => {
    const z = state.zoom;
    if (z) addToMix(z.clipId, z.s, z.e, z.w);
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
    if (!typing && (ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') {
      ev.preventDefault();
      undo();
    }
    if (!typing && state.zoom && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
      ev.preventDefault();
      nudge((ev.shiftKey ? 0.001 : 0.01) * (ev.key === 'ArrowLeft' ? -1 : 1));
    }
  });

  // Everything lives in memory, so a stray reload takes the whole mix with
  // it. The browser only shows this when there is something to lose.
  window.addEventListener('beforeunload', (ev) => {
    if (!state.mix.length) return;
    ev.preventDefault();
    ev.returnValue = '';
  });

  window.addEventListener('resize', () => {
    const clip = state.clips.find((c) => c.id === state.activeId);
    if (clip) drawWave(clip);
    if (state.zoom) drawZoom();
  });

  wireCaret();
  wireMixDrop();
  renderMix();
}

wire();
// A small debug surface: handy from the browser console, and what the
// end-to-end tests drive the app through.
window.ytp = { state, MODELS, addToMix, renderMix, renderScript, saveVideo,
               exportSources, selectClip };
