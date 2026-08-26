// Listening to a clip, in the tab.
//
// Whisper runs through Transformers.js, so nothing is uploaded and there is
// no server to pay for. The model is fetched once and then cached by the
// browser, which is why the first visit is the slow one.

import { repair, tighten } from './analysis.js';
import { RATE } from './audio.js';

const LIB = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3';

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
  const device = (await usingGpu()) ? 'webgpu' : 'wasm';

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
    dtype: 'q8',
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
} = {}) {
  onPhase('downloading');
  const transcriber = await load(quality, onProgress);

  // Downloading is only the first part. Compiling the model and then running
  // it report nothing at all, and on a phone that silence lasts minutes — so
  // say which part is happening rather than leaving the last percentage up.
  onPhase('listening');
  await new Promise((r) => setTimeout(r, 0));   // let the message paint first

  const result = await transcriber(samples, {
    return_timestamps: 'word',
    chunk_length_s: 30,
    stride_length_s: 5,
  });

  const chunks = result?.chunks;
  if (!Array.isArray(chunks) || !chunks.length) {
    throw new Error("I couldn't hear any talking in this one.");
  }

  const words = [];
  for (const chunk of chunks) {
    const text = (chunk.text || '').trim();
    const [start, end] = chunk.timestamp || [];
    if (!text || start == null) continue;
    words.push({
      i: words.length,
      w: text,
      s: Number(start),
      // the very last word sometimes comes back open-ended
      e: Number(end != null ? end : start + 0.2),
      p: 1,
    });
  }
  if (!words.length) throw new Error("I couldn't hear any talking in this one.");

  return tighten(repair(words), samples, RATE);
}
