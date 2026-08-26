// Listening to a clip, in the tab.
//
// Whisper runs through Transformers.js, so nothing is uploaded and there is
// no server to pay for. The model is fetched once and then cached by the
// browser, which is why the first visit is the slow one.

import { repair, tighten } from './analysis.js';
import { RATE } from './audio.js';

const LIB = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3';

// How much audio to read at a time, and how much to re-read at each seam so a
// word straddling the boundary is heard whole by one of the two passes.
const WINDOW = 30;
const OVERLAP = 2;

// These must be the `_timestamped` exports. Whisper derives per-word times
// from its cross-attentions, and the ordinary ONNX exports are built without
// them: asking for word timings against `whisper-tiny.en` fails outright with
// "Model outputs must contain cross attentions to extract timestamps". Every
// part of this app is built on word times, so a plain export is not a
// lower-quality option here, it is a broken one.
export const MODELS = {
  fast: { id: 'onnx-community/whisper-tiny.en_timestamped', label: 'faster', mb: 40 },
  good: { id: 'onnx-community/whisper-base.en_timestamped', label: 'better', mb: 80 },
};

let pipe = null;
let pipeKey = null;
let libPromise = null;
let lastBackend = null;

/** Which backend actually ran, so a bad one can be spotted rather than guessed at. */
export function backend() {
  return lastBackend;
}

function lib() {
  if (!libPromise) libPromise = import(/* @vite-ignore */ LIB);
  return libPromise;
}

/** Whether this browser can use the GPU, which is several times faster. */
export async function usingGpu() {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

/**
 * Load the recogniser, reporting download progress.
 *
 * Kept in a module-level slot so the model is only fetched and compiled once
 * per session however many clips get imported.
 */
export async function load(quality = 'good', onProgress = () => {}) {
  const model = MODELS[quality] || MODELS.good;
  if (pipe && pipeKey === model.id) return pipe;

  const { pipeline } = await lib();

  // WebAssembly by default, even where the GPU is available.
  //
  // Asking for WebGPU while handing it q8 weights produced a model that
  // loaded, ran, and emitted essentially random vocabulary tokens: a phone
  // returned 229 "words" from thirty seconds of speech, things like
  // "biasesVIDEO" and "TwilightixirAbyss", which are Whisper's internal
  // subword fragments rather than anything it misheard. Every check that
  // passed had gone through the native runtime, never this backend.
  //
  // WebAssembly is the path that is actually verified end to end, so it is
  // the one that ships. ?gpu=1 opts in to WebGPU at a precision it can
  // handle, for anyone who wants to try it.
  const wantsGpu = typeof location !== 'undefined' &&
    new URLSearchParams(location.search).get('gpu') === '1';
  const device = (wantsGpu && await usingGpu()) ? 'webgpu' : 'wasm';
  const dtype = device === 'webgpu' ? 'fp32' : 'q8';
  lastBackend = device;

  // The model is several files, and the callback reports each one separately.
  // Reporting one file's fraction makes the bar hit 100% over and over and
  // then sit there while the rest are still coming, so add them up instead.
  const files = new Map();
  const report = () => {
    let loaded = 0;
    let total = 0;
    for (const file of files.values()) {
      loaded += file.loaded;
      total += file.total;
    }
    onProgress(total ? loaded / total : 0);
  };

  pipe = await pipeline('automatic-speech-recognition', model.id, {
    device,
    dtype,
    progress_callback: (update) => {
      if (!update || !update.file) return;
      if (update.status === 'progress' && update.total) {
        files.set(update.file, { loaded: update.loaded || 0, total: update.total });
        report();
      } else if (update.status === 'done') {
        const file = files.get(update.file);
        if (file) { file.loaded = file.total; report(); }
      }
    },
  });
  pipeKey = model.id;
  return pipe;
}

let serverPromise = null;

/**
 * Is there a local server behind this page that can do the listening?
 *
 * The same interface is served two ways: from a static host, where the
 * work happens in the tab under WebAssembly on one core, and from the
 * local server, where it happens natively across all of them. Asking once
 * costs a round trip to the same origin and decides which.
 */
export function localServer() {
  if (!serverPromise) {
    serverPromise = fetch('api/health', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((info) => (info && info.server ? info : null))
      .catch(() => null);
  }
  return serverPromise;
}

/** Hand the samples to the local server and take back words. */
async function listenOnServer(samples, info, onPhase) {
  onPhase('server');
  const res = await fetch('api/transcribe', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    // already decoded and resampled here, so send it as it sits in memory
    body: samples.buffer.byteLength === samples.length * 4
      ? samples.buffer
      : samples.slice().buffer,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error((detail && detail.detail) || 'The local server could not read that.');
  }
  const body = await res.json();
  if (!body.words || !body.words.length) {
    throw new Error("I couldn't hear any talking in this one.");
  }
  lastBackend = `server (${body.model || 'local'})`;
  return body.words;
}

/**
 * Transcribe 16 kHz mono samples into words with times.
 *
 * Word-level timings are what the whole app is built on, so if the model
 * can't produce them this reports the failure rather than silently handing
 * back sentence-level chunks that would make every grab wrong.
 */
export async function listen(samples, {
  quality = 'good',
  onProgress = () => {},
  onPhase = () => {},
  onWords = () => {},
} = {}) {
  // Running on the machine beats anything the tab can do, so take it when
  // it's there: no model to download, and every core instead of one.
  const server = await localServer();
  if (server) {
    const words = await listenOnServer(samples, server, onPhase);
    onWords(words, 1);
    return words;
  }

  onPhase('downloading');
  const transcriber = await load(quality, onProgress);

  // Downloading is only the first part. Compiling the model and then running
  // it report nothing at all, and on a phone that silence lasts minutes — so
  // say which part is happening rather than leaving the last percentage up.
  onPhase('listening');
  await new Promise((r) => setTimeout(r, 0));   // let the message paint first

  // Work through the audio a window at a time rather than handing over the
  // whole file. A five minute clip on a phone takes minutes either way, but
  // this way the opening words are clickable while the end is still being
  // read, and there is a real fraction to show instead of a frozen bar.
  const total = samples.length / RATE;
  const words = [];
  let at = 0;

  while (at < total - 0.05) {
    // Start each window slightly early so a word sitting on the seam is heard
    // whole by at least one of the two passes.
    const from = at > 0 ? Math.max(0, at - OVERLAP) : 0;
    const to = Math.min(total, at + WINDOW);
    const slice = samples.subarray(Math.round(from * RATE), Math.round(to * RATE));

    const result = await transcriber(slice, {
      return_timestamps: 'word',
      chunk_length_s: 30,
      stride_length_s: 5,
    });

    for (const chunk of result?.chunks || []) {
      const text = (chunk.text || '').trim();
      const [start, end] = chunk.timestamp || [];
      if (!text || start == null) continue;

      const s = from + Number(start);
      // anything starting before the boundary was already heard last time
      if (at > 0 && s < at - 0.02) continue;
      words.push({
        i: words.length,
        w: text,
        s,
        // the last word of a window often comes back open-ended
        e: from + Number(end != null ? end : start + 0.2),
        p: 1,
      });
    }

    at = to;
    // Hand back a tightened copy so what appears mid-run is usable, while the
    // running list stays raw for the next window to append to.
    onWords(tighten(repair(words.map((w) => ({ ...w }))), samples, RATE), at / total);
    await new Promise((r) => setTimeout(r, 0));   // let the page paint
  }

  if (!words.length) throw new Error("I couldn't hear any talking in this one.");

  return tighten(repair(words), samples, RATE);
}
