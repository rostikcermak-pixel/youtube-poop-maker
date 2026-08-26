// Building a word the speaker never said.
//
// Every word has a pronunciation, written here as one character per sound, so
// matching is a substring search rather than walking arrays of tokens. To make
// "fucking" (F AH K IH NG) out of a video where nobody says it, we look for
// runs of sounds inside other words that join up to spell it: the tail of
// "working" (W ER | K IH NG) supplies K IH NG, and the F AH can come from the
// front of anything that starts that way.
//
// The catch is that we only know when each *word* was said, not each sound
// inside it. Sound positions are estimated by weighting: a vowel occupies more
// of a word than a stop consonant does. It lands close, and the drag handles
// are there for when it doesn't.

/** Rough relative duration of each sound, used to guess where inside a word it falls. */
const WEIGHTS = {
  // vowels carry most of a word's length
  AA: 1.5, AE: 1.5, AH: 1.1, AO: 1.5, EH: 1.3, ER: 1.4, IH: 1.1, IY: 1.4,
  UH: 1.2, UW: 1.5,
  // diphthongs are longer still
  AW: 2.0, AY: 2.0, EY: 1.8, OW: 1.8, OY: 2.0,
  // stops are brief
  B: 0.6, D: 0.6, G: 0.6, K: 0.7, P: 0.7, T: 0.6,
  // everything else sits in between
  CH: 0.9, DH: 0.7, F: 0.9, HH: 0.7, JH: 0.9, L: 0.8, M: 0.8, N: 0.8,
  NG: 0.9, R: 0.8, S: 1.0, SH: 1.0, TH: 0.9, V: 0.8, W: 0.7, Y: 0.7,
  Z: 1.0, ZH: 1.0,
};

export const PHONES = [
  'AA','AE','AH','AO','AW','AY','B','CH','D','DH','EH','ER','EY','F','G',
  'HH','IH','IY','JH','K','L','M','N','NG','OW','OY','P','R','S','SH',
  'T','TH','UH','UW','V','W','Y','Z','ZH',
];

const CODE_BASE = 33;
export const encode = (phones) =>
  phones.map((p) => String.fromCharCode(CODE_BASE + PHONES.indexOf(p))).join('');
export const decode = (coded) =>
  [...coded].map((c) => PHONES[c.charCodeAt(0) - CODE_BASE]);

function weightOf(coded, i) {
  return WEIGHTS[PHONES[coded.charCodeAt(i) - CODE_BASE]] ?? 1;
}

/**
 * Where inside a word a run of sounds falls, in seconds.
 *
 * Weighted rather than evenly spaced: splitting "documentaries" into twelve
 * equal slices would put the boundaries in the wrong places, because the
 * vowels take far longer to say than the stops around them.
 */
export function spanOfPhones(word, from, to) {
  const coded = word.phones;
  let total = 0;
  for (let i = 0; i < coded.length; i++) total += weightOf(coded, i);
  if (total <= 0) return { s: word.s, e: word.e };

  let before = 0;
  for (let i = 0; i < from; i++) before += weightOf(coded, i);
  let inside = 0;
  for (let i = from; i < to; i++) inside += weightOf(coded, i);

  const length = word.e - word.s;
  const s = word.s + (before / total) * length;
  return { s, e: s + (inside / total) * length };
}

/**
 * Every run of sounds available in the source, indexed by the sounds it makes.
 *
 * Whole words are indexed too, so a word the speaker actually said wins on
 * its own terms instead of being rebuilt from fragments.
 */
export function indexSounds(words, { longest = 12 } = {}) {
  const index = new Map();
  words.forEach((word) => {
    const coded = word.phones || '';
    for (let from = 0; from < coded.length; from++) {
      for (let to = from + 1; to <= Math.min(coded.length, from + longest); to++) {
        const key = coded.slice(from, to);
        const entry = {
          word,
          from,
          to,
          whole: from === 0 && to === coded.length,
        };
        const bucket = index.get(key);
        if (bucket) bucket.push(entry);
        else index.set(key, [entry]);
      }
    }
  });
  return index;
}

/** Fewer joins is better; a whole word beats a fragment; longer runs beat short ones. */
function costOf(entry) {
  return entry.whole ? 0.4 : 1;
}

/**
 * Work out how to say `targetPhones` using sounds from the indexed source.
 *
 * Returns up to `limit` ways of building it, cheapest first, each a list of
 * pieces with the times to cut. Empty if it can't be built at all.
 */
export function planWord(targetPhones, index, { limit = 4, maxPieces = 6 } = {}) {
  const n = targetPhones.length;
  if (!n) return [];

  // best[i] = cheapest way to have said the first i sounds
  const best = new Array(n + 1).fill(null);
  best[0] = { cost: 0, pieces: 0, trail: null };

  for (let i = 0; i < n; i++) {
    const here = best[i];
    if (!here || here.pieces >= maxPieces) continue;
    for (let j = Math.min(n, i + 12); j > i; j--) {
      const bucket = index.get(targetPhones.slice(i, j));
      if (!bucket) continue;
      for (const entry of bucket) {
        const cost = here.cost + costOf(entry);
        const better = !best[j] || cost < best[j].cost ||
          (cost === best[j].cost && here.pieces + 1 < best[j].pieces);
        if (better) {
          best[j] = { cost, pieces: here.pieces + 1, trail: { at: i, entry } };
        }
      }
      // a longer run is always preferable, so stop once one lands
      if (best[j] && best[j].trail && best[j].trail.at === i) break;
    }
  }

  if (!best[n]) return [];

  // Walk the trail back, then offer variations that swap one piece for another
  // take of the same sounds — a different reading of the same word often sits
  // better next to what surrounds it.
  const chain = [];
  for (let at = n; at > 0;) {
    const step = best[at].trail;
    if (!step) return [];
    chain.unshift({ from: step.at, to: at, entry: step.entry });
    at = step.at;
  }

  const options = [];
  const seen = new Set();
  const alternatives = chain.map((link) =>
    (index.get(targetPhones.slice(link.from, link.to)) || [link.entry]).slice(0, limit));

  for (let take = 0; take < limit; take++) {
    const pieces = chain.map((link, i) => {
      const choices = alternatives[i];
      const entry = choices[Math.min(take, choices.length - 1)];
      const span = spanOfPhones(entry.word, entry.from, entry.to);
      return {
        clipId: entry.word.clipId,
        from: entry.word.w,
        whole: entry.whole,
        s: Math.round(span.s * 1e4) / 1e4,
        e: Math.round(span.e * 1e4) / 1e4,
      };
    });
    const signature = pieces.map((p) => `${p.clipId}:${p.s}:${p.e}`).join('|');
    if (seen.has(signature)) continue;
    seen.add(signature);
    options.push({ pieces, joins: pieces.length - 1 });
  }
  return options;
}
