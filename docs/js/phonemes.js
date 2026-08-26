// The pronunciation dictionary.
//
// Loaded only when someone first tries to make a word, because most sessions
// never need it. About 0.75 MB over the wire, which the browser then caches.

let table = null;
let loading = null;

async function fetchTable() {
  const res = await fetch(new URL('../data/phonemes.txt', import.meta.url));
  if (!res.ok) throw new Error("Couldn't load the pronunciation dictionary.");
  const text = await res.text();

  const map = new Map();
  for (const line of text.split('\n')) {
    const gap = line.indexOf(' ');
    if (gap > 0) map.set(line.slice(0, gap), line.slice(gap + 1));
  }
  return map;
}

export async function load() {
  if (table) return table;
  if (!loading) loading = fetchTable().then((t) => { table = t; return t; });
  return loading;
}

export function ready() {
  return Boolean(table);
}

/** Strip the punctuation the transcript carries so "ducks," still matches. */
export function tidy(word) {
  return String(word || '').toLowerCase().replace(/[^a-z']/g, '');
}

/** How a word is said, or null if the dictionary has never heard of it. */
export function soundsOf(word) {
  if (!table) return null;
  return table.get(tidy(word)) || null;
}
