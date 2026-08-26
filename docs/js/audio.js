// Getting samples out of a file the user dropped in, without a server.
//
// Everything downstream — the recogniser, the waveform, the syllable
// splitter — wants 16 kHz mono, which is also what keeps memory sane on a
// long video.

export const RATE = 16000;

/**
 * Decode a dropped file to 16 kHz mono.
 *
 * The browser decodes the audio track out of a video container for us. It
 * lands at the device's own rate (usually 44.1 or 48 kHz), so it's rendered
 * again through an offline context to resample properly rather than by
 * dropping samples, which would alias and wreck the energy curve the edge
 * finding depends on.
 */
export async function decodeTo16kMono(file) {
  const bytes = await file.arrayBuffer();

  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(bytes);
  } catch (err) {
    throw new Error(
      "I can't read the sound in this file. Try converting it to MP4 or WebM."
    );
  } finally {
    ctx.close();
  }

  if (decoded.sampleRate === RATE && decoded.numberOfChannels === 1) {
    return decoded.getChannelData(0).slice();
  }

  const frames = Math.max(1, Math.round((decoded.duration * RATE)));
  const offline = new OfflineAudioContext(1, frames, RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0).slice();
}

/** Seconds, formatted the way the app shows them everywhere. */
export function secs(value) {
  return `${value.toFixed(2)}s`;
}

/**
 * Mix a list of pieces into one continuous track.
 *
 * Each piece gets the same 8 ms fade the preview uses, so what gets saved
 * sounds like what was heard. Anything shorter than two fades gets a
 * proportionally shorter one rather than fades that overlap each other.
 */
export function mixdown(pieces, buffers, rate = RATE, fade = 0.008) {
  const total = pieces.reduce(
    (sum, p) => sum + Math.max(0, p.e - p.s), 0);
  const out = new Float32Array(Math.max(1, Math.round(total * rate)));

  let at = 0;
  for (const piece of pieces) {
    const samples = buffers.get(piece.clipId);
    if (!samples) continue;
    const from = Math.max(0, Math.round(piece.s * rate));
    const to = Math.min(samples.length, Math.round(piece.e * rate));
    const length = to - from;
    if (length <= 0) continue;

    const ramp = Math.min(Math.round(fade * rate), Math.floor(length / 2));
    for (let i = 0; i < length; i++) {
      let gain = 1;
      if (ramp > 0) {
        if (i < ramp) gain = i / ramp;
        else if (i >= length - ramp) gain = (length - 1 - i) / ramp;
      }
      out[at + i] = samples[from + i] * gain;
    }
    at += length;
  }
  return out.subarray(0, at);
}

/** A 16-bit WAV file, for saving just the sound. */
export function toWav(samples, rate = RATE) {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const text = (offset, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);           // PCM
  view.setUint16(22, 1, true);           // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);    // byte rate
  view.setUint16(32, 2, true);           // block align
  view.setUint16(34, 16, true);          // bits
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, clamped * 0x7fff, true);
  }
  return new Blob([bytes], { type: 'audio/wav' });
}
