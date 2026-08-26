import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_SYLLABLE, MIN_WORD,
  envelope, nearestZeroCrossing, peaks, rawEnergy, repair, snapPoints, splitSyllables, tighten,
} from '../../docs/js/analysis.js';

const RATE = 16000;

function syllabic(bursts, total) {
  const samples = new Float32Array(Math.round(total * RATE));
  for (const [start, end] of bursts) {
    const a = Math.round(start * RATE);
    const b = Math.round(end * RATE);
    for (let i = a; i < b; i++) {
      samples[i] = 0.6 * Math.sin((2 * Math.PI * 180 * (i - a)) / RATE);
    }
  }
  return samples;
}

function wordsFrom(times) {
  return times.map(([s, e], i) => ({ i, w: `w${i}`, s, e, p: 1 }));
}

test('a four syllable word comes apart', () => {
  const word = syllabic([[0, 0.16], [0.22, 0.38], [0.44, 0.60], [0.66, 0.84]], 0.84);
  const pieces = splitSyllables(word, RATE);
  assert.equal(pieces.length, 4);
  for (const p of pieces) assert.ok(p.e - p.s >= MIN_SYLLABLE);
});

test('a single sound is left whole', () => {
  assert.equal(splitSyllables(syllabic([[0, 0.35]], 0.35), RATE).length, 1);
});

test('silence is left whole', () => {
  assert.equal(splitSyllables(new Float32Array(Math.round(0.4 * RATE)), RATE).length, 1);
});

test('pieces are in order and do not overlap', () => {
  const pieces = splitSyllables(syllabic([[0, 0.15], [0.25, 0.40], [0.50, 0.70]], 0.70), RATE);
  for (let i = 0; i < pieces.length - 1; i++) {
    assert.ok(pieces[i + 1].s >= pieces[i].e - 1e-6);
  }
});

test('no sliver pieces survive', () => {
  const word = syllabic([[0, 0.18], [0.19, 0.21], [0.30, 0.50]], 0.50);
  for (const p of splitSyllables(word, RATE)) assert.ok(p.e - p.s >= MIN_SYLLABLE);
});

test('snap points land in the quiet bits', () => {
  const marks = snapPoints(syllabic([[0, 0.15], [0.30, 0.45]], 0.45), RATE);
  assert.ok(marks.length > 0);
  assert.ok(marks.some((m) => m >= 0.13 && m <= 0.32));
});

test('zero crossing lands on a sign change', () => {
  const tone = new Float32Array(RATE);
  for (let i = 0; i < RATE; i++) tone[i] = Math.sin((2 * Math.PI * 100 * i) / RATE);
  for (const probe of [1234, 4321, 8000]) {
    const i = nearestZeroCrossing(tone, probe);
    assert.notEqual(tone[i] < 0, tone[i + 1] < 0);
    assert.ok(Math.abs(i - probe) <= 160);
  }
});

test('zero crossing survives flat audio', () => {
  assert.equal(nearestZeroCrossing(new Float32Array(1000).fill(0.3), 500), 500);
});

test('a zero length word gets its time back', () => {
  const words = wordsFrom([[3.18, 3.52], [3.52, 3.86], [3.86, 4.62], [4.62, 4.62], [4.62, 4.96]]);
  ['its', 'features', 'and', 'motivations', 'might'].forEach((w, i) => { words[i].w = w; });

  const out = repair(words);
  const and = out.find((w) => w.w === 'and');
  const motiv = out.find((w) => w.w === 'motivations');

  assert.ok(motiv.e - motiv.s >= MIN_WORD, 'still silent when clicked');
  assert.ok(motiv.e - motiv.s > and.e - and.s);
  assert.ok(Math.abs(and.e - motiv.s) < 1e-9);
});

test('repair leaves healthy neighbours alone', () => {
  const words = wordsFrom([[1.0, 1.34], [1.34, 1.35], [1.35, 1.69]]);
  ['one', 'a', 'two'].forEach((w, i) => { words[i].w = w; });
  const before = [words[0].s, words[0].e, words[2].s, words[2].e];
  const out = repair(words);
  assert.deepEqual([out[0].s, out[0].e, out[2].s, out[2].e], before);
});

test('no word is crushed by tightening', () => {
  const spans = [[0.5, 1.0], [1.6, 2.4], [3.0, 3.3], [3.9, 4.8]];
  const samples = syllabic(spans, 6.0);
  const out = tighten(wordsFrom(spans.map(([s, e]) => [s + 0.07, e + 0.07])), samples, RATE);
  for (const w of out) assert.ok(w.e - w.s >= MIN_WORD, `${w.w} collapsed`);
});

test('tightened words never overlap', () => {
  const samples = syllabic([[0.5, 1.0], [1.05, 1.6], [1.65, 2.2]], 6.0);
  const out = tighten(wordsFrom([[0.44, 1.09], [0.99, 1.68], [1.59, 2.28]]), samples, RATE);
  for (let i = 0; i < out.length - 1; i++) assert.ok(out[i].e <= out[i + 1].s + 1e-6);
});

test('peaks summarise without losing the extremes', () => {
  const samples = new Float32Array(1000);
  samples[500] = 0.9;
  samples[501] = -0.8;
  const got = peaks(samples, 10);
  assert.equal(got.length, 10);
  assert.ok(got.some(([lo, hi]) => hi >= 0.89 && lo <= -0.79));
});

test('peaks handle empty input', () => {
  assert.deepEqual(peaks(new Float32Array(0)), []);
});

test('a word start does not drift early into the silence before it', () => {
  // Regression: tightening used the smoothed loudness curve, which averages
  // each frame with its neighbours. That bleeds a burst's energy backwards
  // into the silent frame ahead of it and pulls every start edge one 5ms
  // frame early, clipping the front of the consonant. Word edges must be
  // found against the raw curve.
  // Landing one frame early is right: that frame is the last fully silent
  // one before the sound, and cutting in silence is the whole point. Two
  // frames early is the bug.
  const frame = 80 / RATE;
  const spans = [[0.5, 1.0], [1.6, 2.4], [3.0, 3.3], [3.9, 4.8]];
  const samples = syllabic(spans, 6.0);
  const out = tighten(wordsFrom(spans.map(([s, e]) => [s + 0.07, e + 0.07])), samples, RATE);

  out.forEach((word, i) => {
    const earlyBy = spans[i][0] - word.s;
    assert.ok(earlyBy <= frame + 1e-6,
      `start is ${(earlyBy * 1000).toFixed(1)}ms early, more than one ${frame * 1000}ms frame`);
  });
});

test('the smoothed and raw loudness curves are not the same thing', () => {
  const samples = syllabic([[0.2, 0.4]], 0.6);
  const raw = rawEnergy(samples);
  const smooth = envelope(samples);
  assert.equal(raw.length, smooth.length);
  // the frame just before the burst is silent raw, but not once smoothed
  const justBefore = Math.floor(0.2 * (RATE / 80)) - 1;
  assert.equal(raw[justBefore], 0);
  assert.ok(smooth[justBefore] > 0);
});

test('a collapsed word claims the empty gap in front of it', () => {
  // Real output: "it" came back as 10.540-10.540 with 140ms of unclaimed
  // space before "could". Neither neighbour was hogging its time, so looking
  // only at bloated neighbours left it silent.
  const words = [
    { i: 0, w: 'and', s: 10.30, e: 10.42, p: 1 },
    { i: 1, w: 'that', s: 10.48, e: 10.54, p: 1 },
    { i: 2, w: 'it', s: 10.54, e: 10.54, p: 1 },
    { i: 3, w: 'could', s: 10.68, e: 10.96, p: 1 },
    { i: 4, w: 'take', s: 11.00, e: 11.30, p: 1 },
    { i: 5, w: 'over', s: 11.34, e: 11.70, p: 1 },
  ];

  const out = repair(words);
  const it = out.find((w) => w.w === 'it');

  assert.ok(it.e - it.s >= MIN_WORD, 'still silent when clicked');
  assert.ok(it.e - it.s > 0.1, `only claimed ${(it.e - it.s).toFixed(3)}s of the 140ms gap`);
  assert.equal(out.find((w) => w.w === 'that').e, 10.54, 'stole from an innocent neighbour');
  assert.equal(out.find((w) => w.w === 'could').s, 10.68, 'stole from an innocent neighbour');
});

test('words past the end of the audio are dropped, not inverted', () => {
  // Real output: "artificial" started at 25.180 against 25.01s of audio.
  // Clamping only the end leaves the end before the start.
  const samples = syllabic([[0.2, 0.6]], 1.0);
  const words = [
    { i: 0, w: 'from', s: 0.2, e: 0.6, p: 1 },
    { i: 1, w: 'artificial', s: 1.18, e: 1.20, p: 1 },
  ];

  const out = tighten(words, samples, RATE);

  assert.equal(out.length, 1, 'the out-of-bounds word should be gone');
  for (const w of out) {
    assert.ok(w.e > w.s, `${w.w} has its end (${w.e}) before its start (${w.s})`);
    assert.ok(w.e <= 1.0 + 1e-9, `${w.w} ends past the audio`);
  }
});

test('every word always has a positive length and sits inside the audio', () => {
  const samples = syllabic([[0.1, 0.3], [0.5, 0.8]], 1.0);
  const words = [
    { i: 0, w: 'a', s: -0.5, e: 0.3, p: 1 },
    { i: 1, w: 'b', s: 0.5, e: 5.0, p: 1 },
    { i: 2, w: 'c', s: 0.99, e: 0.99, p: 1 },
  ];

  for (const w of tighten(words, samples, RATE)) {
    assert.ok(w.s >= 0, `${w.w} starts before zero`);
    assert.ok(w.e > w.s, `${w.w} has no length`);
    assert.ok(w.e <= 1.0 + 1e-9, `${w.w} ends past the audio`);
  }
});

test('tightening never guts a word', () => {
  // A stop consonant leaves a quiet closure mid-word that an edge can snap to
  // instead of the real end. Real output: "benefit" was healthy until
  // tightening cut it to 45ms.
  const samples = syllabic([[0.30, 0.42], [0.50, 0.72]], 1.2);
  const words = [{ i: 0, w: 'benefit', s: 0.30, e: 0.72, p: 1 }];

  const out = tighten(words, samples, RATE);

  const kept = out[0].e - out[0].s;
  assert.ok(kept >= 0.42 * 0.5, `tightening cut the word to ${kept.toFixed(3)}s of 0.42s`);
});

test('a starved word takes time back from a greedy neighbour', () => {
  // Reported symptom: clicking one word played it and the word after it,
  // while clicking that next word played nothing at all. The neighbour was
  // holding both spans and the starved word had none.
  const words = [
    { i: 0, w: 'one', s: 0.2, e: 0.5, p: 1 },
    { i: 1, w: 'two', s: 0.6, e: 0.9, p: 1 },
    { i: 2, w: 'three', s: 1.0, e: 1.2, p: 1 },
    { i: 3, w: 'greedy', s: 1.3, e: 2.7, p: 1 },
    { i: 4, w: 'starved', s: 2.7, e: 2.7, p: 1 },
    { i: 5, w: 'after', s: 2.8, e: 3.1, p: 1 },
  ];

  const out = repair(words, 3.2);
  const starved = out.find((w) => w.w === 'starved');
  const greedy = out.find((w) => w.w === 'greedy');

  assert.ok(starved.e - starved.s > 0.2,
    `starved word only got ${(starved.e - starved.s).toFixed(3)}s, too short to hear`);
  assert.ok(greedy.e <= starved.s + 1e-6, 'the two still overlap');
  assert.equal(out.find((w) => w.w === 'after').s, 2.8, 'took from an innocent word');
});

test('a starved word inside its neighbour is still rescued', () => {
  // It often sits within the neighbour's span rather than against its edge,
  // so testing whether the edges touch finds no donor and leaves it silent.
  const words = [
    { i: 0, w: 'one', s: 0.2, e: 0.5, p: 1 },
    { i: 1, w: 'two', s: 0.6, e: 0.9, p: 1 },
    { i: 2, w: 'three', s: 1.0, e: 1.2, p: 1 },
    { i: 3, w: 'greedy', s: 1.3, e: 2.7, p: 1 },
    { i: 4, w: 'buried', s: 1.9, e: 1.9, p: 1 },
  ];

  const out = repair(words, 3.2);
  const buried = out.find((w) => w.w === 'buried');

  assert.ok(buried.e - buried.s > 0.2,
    `buried word only got ${(buried.e - buried.s).toFixed(3)}s`);
});

test('a starved last word can run to the end of the clip', () => {
  const words = [
    { i: 0, w: 'one', s: 0.2, e: 0.5, p: 1 },
    { i: 1, w: 'two', s: 0.6, e: 0.9, p: 1 },
    { i: 2, w: 'three', s: 1.0, e: 1.2, p: 1 },
    { i: 3, w: 'last', s: 1.3, e: 1.3, p: 1 },
  ];

  const out = repair(words, 2.5);
  const last = out[out.length - 1];

  assert.ok(last.e - last.s > 0.2, 'the last word had nowhere to grow');
  assert.ok(last.e <= 2.5 + 1e-9, 'it ran past the end of the audio');
});
