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

  pipe = await pipeline('automatic-speech-recognition', model.id, {
    device,
    dtype: 'q8',
    progress_callback: (report) => {
      if (report.status === 'progress' && report.total) {
        onProgress(report.loaded / report.total, report.file || '');
      } else if (report.status === 'ready') {
        onProgress(1, '');
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
  onPartial = null,
} = {}) {
  const transcriber = await load(quality, onProgress);

  const result = await transcriber(samples, {
    return_timestamps: 'word',
    chunk_length_s: 30,
    stride_length_s: 5,
    callback_function: onPartial || undefined,
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
