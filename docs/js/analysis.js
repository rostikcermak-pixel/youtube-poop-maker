// Working out where words and syllables actually start and stop.
//
// Ported from the Python version so the browser build needs no server.
// These are pure functions over Float32 samples: no DOM, no fetching, so
// they can be tested directly.

export const HOP = 80;             // 5 ms at 16 kHz
export const SMOOTH = 3;           // frames of moving average over the energy
export const MIN_WORD = 0.02;      // never let a word collapse below 20 ms
export const MIN_SYLLABLE = 0.06;  // a piece shorter than this isn't a syllable
export const SNAP_WINDOW = 0.12;   // how far either side of an edge to look
export const PULL = 0.5;           // bias toward leaving an edge where it was
export const PEAK_FLOOR = 0.25;    // ignore bumps below this share of the loudest
export const VALLEY_DROP = 0.9;    // how far a dip must fall below its peaks
export const QUIET = 0.15;         // share of peak level counted as "quiet"
export const KEEP_AT_LEAST = 0.5;  // tightening may not cut a word below this share

// VALLEY_DROP is deliberately permissive. Syllables inside a word are joined,
// not separated by silence, so the dip between them is shallow: measured on 33
// real words, a strict 0.6 averaged 1.97 pieces and never split anything more
// than four ways, leaving six-syllable words nearly whole. At 0.9 the same
// words average 2.91 pieces with a 0.145s median, which is syllable-sized.
// Over-splitting is cheap; under-splitting leaves you dragging by hand.

/**
 * Short-term loudness, one value per HOP samples. No smoothing.
 *
 * Word edges are found against this raw curve, not the smoothed one below.
 * Smoothing averages each frame with its neighbours, which bleeds a burst's
 * energy backwards into the silent frame ahead of it — enough to pull every
 * word's start edge one frame early and clip the front of the consonant.
 */
export function rawEnergy(samples) {
  const n = Math.floor(samples.length / HOP);
  if (n === 0) return new Float32Array(1);

  const rms = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    const base = i * HOP;
    for (let j = 0; j < HOP; j++) {
      const v = samples[base + j];
      sum += v * v;
    }
    rms[i] = Math.sqrt(sum / HOP);
  }
  return rms;
}

/**
 * The same loudness curve, smoothed.
 *
 * Syllable splitting wants this: the dips inside a word are shallow and the
 * raw curve is too jittery to find them reliably.
 */
export function envelope(samples) {
  const rms = rawEnergy(samples);
  const n = rms.length;
  if (n < SMOOTH) return rms;

  const out = new Float32Array(n);
  const half = Math.floor(SMOOTH / 2);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let count = 0;
    for (let k = -half; k <= half; k++) {
      const j = i + k;
      if (j >= 0 && j < n) { sum += rms[j]; count++; }
    }
    // match numpy's zero-padded convolution at the edges
    out[i] = sum / SMOOTH;
    if (count === 0) out[i] = 0;
  }
  return out;
}

function maxOf(arr) {
  let m = 0;
  for (let i = 0; i < arr.length; i++) if (arr[i] > m) m = arr[i];
  return m;
}

function peakIndexes(env) {
  const floor = maxOf(env) * PEAK_FLOOR;
  const out = [];
  for (let i = 1; i < env.length - 1; i++) {
    if (env[i] >= env[i - 1] && env[i] > env[i + 1] && env[i] >= floor) out.push(i);
  }
  return out;
}

/** Dips between consecutive peaks, with how convincing each one is. */
function valleys(env, peaks) {
  const out = [];
  for (let p = 0; p < peaks.length - 1; p++) {
    const left = peaks[p];
    const right = peaks[p + 1];
    if (right - left < 2) continue;
    let at = left;
    let lowest = Infinity;
    for (let i = left; i < right; i++) {
      if (env[i] < lowest) { lowest = env[i]; at = i; }
    }
    const shallower = Math.min(env[left], env[right]);
    out.push({ at, depth: lowest / Math.max(1e-9, shallower) });
  }
  return out;
}

/** The most convincing quiet moment near `raw`, preferring to stay put. */
function snapEdge(env, raw, lo, hi, rate) {
  const framesPerSec = rate / HOP;
  lo = Math.max(lo, raw - SNAP_WINDOW);
  hi = Math.min(hi, raw + SNAP_WINDOW);
  if (hi <= lo) return raw;

  let a = Math.max(0, Math.min(Math.floor(lo * framesPerSec), env.length - 1));
  let b = Math.max(a + 1, Math.min(Math.floor(hi * framesPerSec) + 1, env.length));
  if (b <= a + 1) return raw;

  let loudest = 0;
  for (let i = a; i < b; i++) if (env[i] > loudest) loudest = env[i];
  if (loudest <= 0) return raw;

  let best = raw;
  let bestScore = Infinity;
  for (let i = a; i < b; i++) {
    const t = i / framesPerSec;
    const score = env[i] / loudest + (PULL * Math.abs(t - raw)) / SNAP_WINDOW;
    if (score < bestScore) { bestScore = score; best = t; }
  }
  return best;
}

/**
 * Rescue words the recogniser collapsed to nothing.
 *
 * Alignment sometimes fails on a long word: it comes back with zero duration
 * while the word beside it holds the whole shared span. Left alone, clicking
 * that word plays silence.
 */
export function repair(words) {
  const healthy = words.filter((w) => w.e - w.s >= MIN_WORD && w.w);
  if (healthy.length < 3) return words;

  const rates = healthy.map((w) => (w.e - w.s) / w.w.length).sort((a, b) => a - b);
  const perChar = rates[Math.floor(rates.length / 2)];
  if (!(perChar > 0)) return words;

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word.e - word.s >= MIN_WORD) continue;

    // The word's time is often not in a neighbour at all — it's sitting in an
    // unclaimed gap that nothing occupies. Observed on real output: "it" came
    // back as 10.540-10.540 with 140ms of empty space in front of it. Take
    // the gap first, because it costs no neighbour anything.
    const prev = words[i - 1];
    const next = words[i + 1];
    const gapFrom = prev ? Math.max(prev.e, word.s) : word.s;
    const gapTo = next ? next.s : word.e;
    if (gapTo - gapFrom >= MIN_WORD) {
      word.s = gapFrom;
      word.e = gapTo;
      continue;
    }

    for (const j of [i - 1, i + 1]) {
      if (j < 0 || j >= words.length) continue;
      const other = words[j];
      const touching =
        Math.min(Math.abs(other.e - word.s), Math.abs(word.e - other.s)) <= 0.05;
      const bloated =
        other.e - other.s > 1.6 * perChar * Math.max(1, other.w.length);
      if (!touching || !bloated) continue;

      const first = j < i ? other : word;
      const second = j < i ? word : other;
      const lo = Math.min(word.s, other.s);
      const hi = Math.max(word.e, other.e);
      if (hi - lo < 2 * MIN_WORD) continue;

      const a = Math.max(1, first.w.length);
      const b = Math.max(1, second.w.length);
      const cut = lo + (hi - lo) * (a / (a + b));
      first.s = lo; first.e = cut;
      second.s = cut; second.e = hi;
      break;
    }
  }
  return words;
}

/**
 * Nudge each reported word edge to the nearest gap in the sound.
 *
 * Every edge is snapped from its *original* position, never from an
 * already-moved neighbour, so one bad nudge can't cascade down the sentence.
 */
export function tighten(words, samples, rate) {
  if (!words.length) return words;
  const env = rawEnergy(samples);
  const total = samples.length / rate;

  // The recogniser's last chunk can overrun the audio: observed on real
  // output, "artificial" came back starting at 25.180 against 25.01s of
  // sound. Clamping only the end would leave the end before the start, so
  // anything with no audio left to sit in goes, and the rest is pulled back
  // inside the file before any of the edge finding runs.
  words = words.filter((w) => w.s < total - MIN_WORD / 2);
  if (!words.length) return words;
  words.forEach((w) => {
    w.s = Math.max(0, Math.min(w.s, total - MIN_WORD));
    w.e = Math.max(w.s + MIN_WORD, Math.min(w.e, total));
  });
  words.forEach((w, i) => { w.i = i; });

  const raw = words.map((w) => [w.s, w.e]);

  words.forEach((word, i) => {
    word.s = snapEdge(env, raw[i][0], 0, total, rate);
    word.e = snapEdge(env, raw[i][1], 0, total, rate);
  });

  for (let i = 0; i < words.length - 1; i++) {
    if (words[i].e > words[i + 1].s) {
      const middle = (words[i].e + words[i + 1].s) / 2;
      words[i].e = middle;
      words[i + 1].s = middle;
    }
  }

  // Tightening is meant to nudge an edge onto the nearby silence, not to
  // resize the word. A word with a stop consonant in it has a quiet closure
  // in the middle, and an edge can snap to that instead of the real end:
  // observed on real output, "benefit" was healthy until tightening cut it
  // to 45ms. If a word loses most of itself, the reported timing was better
  // than ours.
  words.forEach((word, i) => {
    const before = raw[i][1] - raw[i][0];
    const after = word.e - word.s;
    if (after < MIN_WORD || after < before * KEEP_AT_LEAST) {
      word.s = raw[i][0];
      word.e = raw[i][1];
    }
  });
  for (let i = 0; i < words.length - 1; i++) {
    if (words[i].e > words[i + 1].s) {
      words[i].e = Math.max(words[i].s + MIN_WORD,
                            Math.min(words[i].e, words[i + 1].s));
    }
  }
  words.forEach((word) => {
    word.s = Math.max(0, round4(word.s));
    word.e = Math.min(total, round4(Math.max(word.e, word.s + MIN_WORD)));
  });
  return words;
}

/** Chop a word into syllable-ish pieces, as seconds from its start. */
export function splitSyllables(samples, rate) {
  const total = samples.length;
  const whole = [{ s: 0, e: total / rate }];
  const env = envelope(samples);
  if (env.length < 4 || maxOf(env) <= 0) return whole;

  const peaks = peakIndexes(env);
  if (peaks.length < 2) return whole;

  const cuts = valleys(env, peaks).filter((v) => v.depth <= VALLEY_DROP).map((v) => v.at);
  if (!cuts.length) return whole;

  let bounds = [0, ...cuts, env.length];
  const least = Math.max(1, Math.floor((MIN_SYLLABLE * rate) / HOP));
  let changed = true;
  while (changed && bounds.length > 2) {
    changed = false;
    for (let i = 0; i < bounds.length - 1; i++) {
      if (bounds[i + 1] - bounds[i] < least) {
        const drop = i + 1 < bounds.length - 1 ? i + 1 : i;
        if (drop > 0 && drop < bounds.length - 1) {
          bounds.splice(drop, 1);
          changed = true;
          break;
        }
      }
    }
  }
  if (bounds.length < 3) return whole;

  const pieces = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const s = (bounds[i] * HOP) / rate;
    const e = Math.min(total / rate, (bounds[i + 1] * HOP) / rate);
    if (e - s >= MIN_SYLLABLE) pieces.push({ s: round4(s), e: round4(e) });
  }
  return pieces.length ? pieces : whole;
}

/** Places a dragged handle should be drawn to, as seconds from the start. */
export function snapPoints(samples, rate) {
  const env = envelope(samples);
  if (env.length < 3 || maxOf(env) <= 0) return [];

  const quiet = maxOf(env) * QUIET;
  const marks = new Set(valleys(env, peakIndexes(env)).map((v) => v.at));
  for (let i = 1; i < env.length; i++) {
    const up = env[i - 1] < quiet && env[i] >= quiet;
    const down = env[i - 1] >= quiet && env[i] < quiet;
    if (up || down) marks.add(i);
  }
  return [...marks].map((i) => round4((i * HOP) / rate)).sort((a, b) => a - b);
}

/** Cutting where the waveform crosses zero is what stops a click. */
export function nearestZeroCrossing(samples, index, search = 160) {
  const lo = Math.max(1, index - search);
  const hi = Math.min(samples.length - 1, index + search);
  if (hi <= lo) return index;

  let best = index;
  let gap = Infinity;
  for (let i = lo; i < hi; i++) {
    if (samples[i] < 0 !== samples[i + 1] < 0) {
      const d = Math.abs(i - index);
      if (d < gap) { gap = d; best = i; }
    }
  }
  return gap === Infinity ? index : best;
}

/** Min/max pairs so a waveform draws instantly however long the video is. */
export function peaks(samples, buckets = 2000) {
  if (!samples.length) return [];
  buckets = Math.max(1, Math.min(buckets, samples.length));
  const out = [];
  for (let b = 0; b < buckets; b++) {
    const lo = Math.floor((b * samples.length) / buckets);
    const hi = Math.floor(((b + 1) * samples.length) / buckets);
    let min = 0;
    let max = 0;
    for (let i = lo; i < hi; i++) {
      if (samples[i] < min) min = samples[i];
      if (samples[i] > max) max = samples[i];
    }
    out.push([min, max]);
  }
  return out;
}

function round4(v) {
  return Math.round(v * 1e4) / 1e4;
}
