import test from 'node:test';
import assert from 'node:assert/strict';
import { mixdown, toWav } from '../../docs/js/audio.js';

const RATE = 16000;

function tone(seconds, level = 0.5) {
  const s = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < s.length; i++) s[i] = level;
  return s;
}

test('pieces are laid end to end with no gap', () => {
  const buffers = new Map([['a', tone(1.0)]]);
  const out = mixdown(
    [{ clipId: 'a', s: 0.1, e: 0.3 }, { clipId: 'a', s: 0.5, e: 0.6 }],
    buffers,
  );
  assert.equal(out.length, Math.round(0.3 * RATE));
});

test('every join is faded so it cannot click', () => {
  const buffers = new Map([['a', tone(1.0)]]);
  const out = mixdown([{ clipId: 'a', s: 0.0, e: 0.5 }], buffers);

  assert.ok(Math.abs(out[0]) < 0.01, 'first sample should start from silence');
  assert.ok(Math.abs(out[out.length - 1]) < 0.05, 'last sample should fade out');
  assert.ok(out[Math.floor(out.length / 2)] > 0.45, 'middle should be full level');
});

test('a piece too short for two fades still fades', () => {
  // 10ms can't take an 8ms fade at each end; the ramps must shrink, not overlap
  const buffers = new Map([['a', tone(1.0)]]);
  const out = mixdown([{ clipId: 'a', s: 0.0, e: 0.01 }], buffers);

  assert.equal(out.length, Math.round(0.01 * RATE));
  for (const v of out) assert.ok(v <= 0.5 + 1e-6 && v >= 0);
  assert.ok(Math.max(...out) > 0, 'faded away to nothing');
});

test('a missing clip is skipped rather than throwing', () => {
  const buffers = new Map([['a', tone(0.5)]]);
  const out = mixdown(
    [{ clipId: 'a', s: 0, e: 0.2 }, { clipId: 'gone', s: 0, e: 0.2 }],
    buffers,
  );
  assert.equal(out.length, Math.round(0.2 * RATE));
});

test('an empty mix produces nothing rather than crashing', () => {
  assert.equal(mixdown([], new Map()).length, 0);
});

test('wav header describes the samples it carries', async () => {
  const blob = toWav(tone(0.25), RATE);
  const view = new DataView(await blob.arrayBuffer());
  const chars = (o, n) => String.fromCharCode(
    ...Array.from({ length: n }, (_, i) => view.getUint8(o + i)));

  assert.equal(chars(0, 4), 'RIFF');
  assert.equal(chars(8, 4), 'WAVE');
  assert.equal(view.getUint16(22, true), 1, 'mono');
  assert.equal(view.getUint32(24, true), RATE);
  assert.equal(view.getUint16(34, true), 16, 'bit depth');
  assert.equal(view.getUint32(40, true), Math.round(0.25 * RATE) * 2);
});

test('wav clamps rather than wrapping around on loud samples', async () => {
  const hot = new Float32Array([2.0, -2.0, 0]);
  const view = new DataView(await toWav(hot, RATE).arrayBuffer());
  assert.equal(view.getInt16(44, true), 32767);
  assert.equal(view.getInt16(46, true), -32767);
});
