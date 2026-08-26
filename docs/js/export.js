// Saving a mix as a video, in the tab.
//
// The obvious route is ffmpeg compiled to WebAssembly, but GitHub Pages
// can't send the cross-origin isolation headers that unlock threading, so
// it would be a ~30 MB download running on one core. Instead this plays the
// mix once and records it: the picture is drawn to a canvas and the sound
// comes off the same Web Audio graph the preview uses, so what gets saved is
// literally what was heard.
//
// The cost is that saving takes as long as the mix runs. For sentence
// mixing, which is seconds rather than minutes, that's a fair trade.

const FADE = 0.008;

/** Containers worth trying, best first. Browsers differ on what they'll take. */
const CONTAINERS = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4',
];

export function pickContainer() {
  if (typeof MediaRecorder === 'undefined') return null;
  return CONTAINERS.find((type) => MediaRecorder.isTypeSupported(type)) || null;
}

export function supported() {
  return Boolean(pickContainer()) &&
    typeof HTMLCanvasElement.prototype.captureStream === 'function';
}

function extensionFor(type) {
  return type && type.startsWith('video/mp4') ? 'mp4' : 'webm';
}

/**
 * Play the mix through once, recording picture and sound into one file.
 *
 * `sources` maps a clip id to {video, samples} — the video element is only
 * used to pull frames from, so it stays muted and off-screen.
 */
export async function recordMix(mix, sources, {
  width = 854,
  height = 480,
  fps = 30,
  onProgress = () => {},
} = {}) {
  const type = pickContainer();
  if (!type) throw new Error("This browser can't record video. Try Chrome or Edge.");
  if (!mix.length) throw new Error("There's nothing in your mix yet.");

  const total = mix.reduce((sum, p) => sum + Math.max(0, p.e - p.s), 0);
  if (total <= 0) throw new Error('That mix has no length.');

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const paint = canvas.getContext('2d');
  paint.fillStyle = '#000';
  paint.fillRect(0, 0, width, height);

  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const sink = ctx.createMediaStreamDestination();

  // Lay the pieces out on one clock so picture and sound agree.
  const plan = [];
  let at = 0;
  for (const piece of mix) {
    const source = sources.get(piece.clipId);
    const length = Math.max(0, piece.e - piece.s);
    if (!source || length <= 0) continue;
    plan.push({ ...piece, source, at, until: at + length });
    at += length;
  }
  if (!plan.length) throw new Error('None of the clips in that mix are loaded.');

  for (const piece of plan) {
    const buffer = ctx.createBuffer(1, piece.source.samples.length, piece.source.rate);
    buffer.copyToChannel(piece.source.samples, 0);
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    const gain = ctx.createGain();
    const length = piece.until - piece.at;
    const fade = Math.min(FADE, length / 2);
    const startsAt = ctx.currentTime + 0.15 + piece.at;
    gain.gain.setValueAtTime(0, startsAt);
    gain.gain.linearRampToValueAtTime(1, startsAt + fade);
    gain.gain.setValueAtTime(1, startsAt + length - fade);
    gain.gain.linearRampToValueAtTime(0, startsAt + length);
    node.connect(gain).connect(sink);
    node.start(startsAt, piece.s, length);
  }

  const stream = canvas.captureStream(fps);
  sink.stream.getAudioTracks().forEach((track) => stream.addTrack(track));

  const recorder = new MediaRecorder(stream, { mimeType: type });
  const parts = [];
  recorder.ondataavailable = (ev) => { if (ev.data.size) parts.push(ev.data); };

  const began = ctx.currentTime + 0.15;
  let showing = null;

  const drawFrom = (video) => {
    if (!video || !video.videoWidth) return;
    const scale = Math.min(width / video.videoWidth, height / video.videoHeight);
    const w = video.videoWidth * scale;
    const h = video.videoHeight * scale;
    paint.fillStyle = '#000';
    paint.fillRect(0, 0, width, height);
    paint.drawImage(video, (width - w) / 2, (height - h) / 2, w, h);
  };

  const finished = new Promise((resolve, reject) => {
    recorder.onstop = () => resolve(new Blob(parts, { type }));
    recorder.onerror = () => reject(new Error("The recording stopped unexpectedly."));
  });

  recorder.start();

  await new Promise((resolve) => {
    const tick = () => {
      const elapsed = ctx.currentTime - began;
      if (elapsed >= total) { resolve(); return; }

      const piece = plan.find((p) => elapsed >= p.at && elapsed < p.until);
      if (piece) {
        if (showing !== piece) {
          showing = piece;
          const video = piece.source.video;
          if (video) {
            video.currentTime = piece.s + Math.max(0, elapsed - piece.at);
            video.play().catch(() => {});
          }
        }
        drawFrom(piece.source.video);
      }
      onProgress(Math.max(0, Math.min(1, elapsed / total)));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  plan.forEach((p) => { if (p.source.video) p.source.video.pause(); });
  recorder.stop();
  const blob = await finished;
  ctx.close();

  return { blob, name: `poop.${extensionFor(type)}`, seconds: total };
}
