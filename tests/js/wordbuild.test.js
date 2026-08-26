import test from 'node:test';
import assert from 'node:assert/strict';
import { encode, indexSounds, planWord, spanOfPhones } from '../../docs/js/wordbuild.js';

/** A source word as the app holds it: text, sounds, and when it was said. */
function said(w, phones, s, e, clipId = 'a') {
  return { w, phones: encode(phones), s, e, clipId };
}

const FUCKING = encode(['F', 'AH', 'K', 'IH', 'NG']);
const ARCHITECT = encode(['AA', 'R', 'K', 'AH', 'T', 'EH', 'K', 'T']);

test('a word the speaker actually said comes back whole', () => {
  const words = [
    said('an', ['AE', 'N'], 1.0, 1.2),
    said('architect', ['AA', 'R', 'K', 'AH', 'T', 'EH', 'K', 'T'], 1.3, 2.0),
  ];

  const [top] = planWord(ARCHITECT, indexSounds(words));

  assert.equal(top.pieces.length, 1, 'should not rebuild a word it already has');
  assert.equal(top.joins, 0);
  assert.equal(top.pieces[0].from, 'architect');
  assert.ok(top.pieces[0].whole);
});

test('a word nobody said is spliced from other words', () => {
  // nothing here is the target, but "funny" opens with F AH and
  // "working" closes with K IH NG
  const words = [
    said('funny', ['F', 'AH', 'N', 'IY'], 0.0, 0.5),
    said('working', ['W', 'ER', 'K', 'IH', 'NG'], 1.0, 1.6),
    said('hello', ['HH', 'AH', 'L', 'OW'], 2.0, 2.5),
  ];

  const [top] = planWord(FUCKING, indexSounds(words));

  assert.ok(top, 'could not build it at all');
  assert.equal(top.pieces.length, 2, `wanted two pieces, got ${top.pieces.length}`);
  assert.deepEqual(top.pieces.map((p) => p.from), ['funny', 'working']);
});

test('every piece sits inside the word it came from', () => {
  const words = [
    said('funny', ['F', 'AH', 'N', 'IY'], 0.0, 0.5),
    said('working', ['W', 'ER', 'K', 'IH', 'NG'], 1.0, 1.6),
  ];
  const byName = Object.fromEntries(words.map((w) => [w.w, w]));

  for (const option of planWord(FUCKING, indexSounds(words))) {
    for (const piece of option.pieces) {
      const source = byName[piece.from];
      assert.ok(piece.s >= source.s - 1e-6, `${piece.from} starts before the word does`);
      assert.ok(piece.e <= source.e + 1e-6, `${piece.from} ends after the word does`);
      assert.ok(piece.e > piece.s, `${piece.from} has no length`);
    }
  }
});

test('pieces stay in the order the sounds are said', () => {
  const words = [
    said('funny', ['F', 'AH', 'N', 'IY'], 0.0, 0.5),
    said('working', ['W', 'ER', 'K', 'IH', 'NG'], 1.0, 1.6),
  ];

  const [top] = planWord(FUCKING, indexSounds(words));
  const sounds = top.pieces.map((p) => p.from).join(' ');

  assert.equal(sounds, 'funny working', 'the front of the word must come first');
});

test('a word with no matching sounds cannot be built', () => {
  const words = [
    said('the', ['DH', 'AH'], 0.0, 0.2),
    said('and', ['AE', 'N', 'D'], 0.5, 0.7),
  ];

  assert.deepEqual(planWord(encode(['ZH', 'OY', 'CH']), indexSounds(words)), []);
});

test('an empty target asks for nothing', () => {
  assert.deepEqual(planWord('', indexSounds([])), []);
});

test('sound positions are weighted, not evenly spaced', () => {
  // "duck" is D AH K: the vowel takes far more of the word than the two stops
  const word = said('duck', ['D', 'AH', 'K'], 0.0, 1.0);

  const d = spanOfPhones(word, 0, 1);
  const vowel = spanOfPhones(word, 1, 2);

  assert.ok(vowel.e - vowel.s > d.e - d.s,
    'the vowel should occupy more of the word than the opening stop');
  assert.ok(Math.abs(d.e - vowel.s) < 1e-9, 'the sounds should join up with no gap');
});

test('the whole word spans the whole word', () => {
  const word = said('duck', ['D', 'AH', 'K'], 0.4, 1.4);
  const span = spanOfPhones(word, 0, 3);
  assert.ok(Math.abs(span.s - 0.4) < 1e-9);
  assert.ok(Math.abs(span.e - 1.4) < 1e-9);
});

test('it offers more than one way when the source has more than one take', () => {
  const words = [
    said('funny', ['F', 'AH', 'N', 'IY'], 0.0, 0.5),
    said('fun', ['F', 'AH', 'N'], 3.0, 3.4),
    said('working', ['W', 'ER', 'K', 'IH', 'NG'], 1.0, 1.6),
    said('walking', ['W', 'AO', 'K', 'IH', 'NG'], 4.0, 4.6),
  ];

  const options = planWord(FUCKING, indexSounds(words));

  assert.ok(options.length > 1, 'only offered one way to say it');
  const signatures = new Set(options.map((o) => o.pieces.map((p) => p.s).join(',')));
  assert.equal(signatures.size, options.length, 'the options are duplicates');
});

test('it can pull from more than one clip', () => {
  const words = [
    said('funny', ['F', 'AH', 'N', 'IY'], 0.0, 0.5, 'clip1'),
    said('working', ['W', 'ER', 'K', 'IH', 'NG'], 1.0, 1.6, 'clip2'),
  ];

  const [top] = planWord(FUCKING, indexSounds(words));

  assert.deepEqual(top.pieces.map((p) => p.clipId), ['clip1', 'clip2']);
});
