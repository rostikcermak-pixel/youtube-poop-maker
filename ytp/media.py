"""ffmpeg helpers: probing, audio extraction, waveform peaks."""
from __future__ import annotations

import json
import re
import subprocess
import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np

SAMPLE_RATE = 16_000  # what whisper wants, and plenty for auditioning words


def ffmpeg_exe() -> str:
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def _run(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        [ffmpeg_exe(), *args],
        capture_output=True,
        text=True,
        errors="replace",
    )


_DURATION_RE = re.compile(r"Duration:\s*(\d+):(\d+):(\d+\.\d+)")
_FPS_RE = re.compile(r"(\d+(?:\.\d+)?)\s*fps")
_SIZE_RE = re.compile(r"Video:.*?,\s*(\d+)x(\d+)")


@dataclass
class Probe:
    duration: float
    fps: float | None
    width: int | None
    height: int | None
    has_video: bool


def probe(path: Path) -> Probe:
    """ffmpeg has no ffprobe in the bundled wheel, so read what it prints."""
    err = _run(["-hide_banner", "-i", str(path)]).stderr

    duration = 0.0
    if m := _DURATION_RE.search(err):
        h, mnt, s = m.groups()
        duration = int(h) * 3600 + int(mnt) * 60 + float(s)

    fps = float(m.group(1)) if (m := _FPS_RE.search(err)) else None
    width = height = None
    if m := _SIZE_RE.search(err):
        width, height = int(m.group(1)), int(m.group(2))

    return Probe(
        duration=duration,
        fps=fps,
        width=width,
        height=height,
        has_video="Video:" in err,
    )


def extract_wav(src: Path, dst: Path) -> None:
    """Mono 16k PCM — feeds both the transcriber and the browser's audition."""
    proc = _run(
        [
            "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(src),
            "-vn",
            "-ac", "1",
            "-ar", str(SAMPLE_RATE),
            "-c:a", "pcm_s16le",
            str(dst),
        ]
    )
    if proc.returncode != 0 or not dst.exists():
        raise RuntimeError(f"could not read audio from {src.name}: {proc.stderr.strip()[:400]}")


def read_wav(path: Path) -> np.ndarray:
    """Float32 mono samples in [-1, 1]."""
    with wave.open(str(path), "rb") as w:
        frames = w.readframes(w.getnframes())
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0


def peaks(samples: np.ndarray, buckets: int = 2000) -> list[list[float]]:
    """Min/max pairs so the waveform draws instantly however long the video is."""
    if samples.size == 0:
        return []
    buckets = max(1, min(buckets, samples.size))
    edges = np.linspace(0, samples.size, buckets + 1, dtype=int)
    out: list[list[float]] = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        chunk = samples[lo:hi]
        if chunk.size == 0:
            out.append([0.0, 0.0])
        else:
            out.append([round(float(chunk.min()), 4), round(float(chunk.max()), 4)])
    return out


def write_json(path: Path, data) -> None:
    path.write_text(json.dumps(data), encoding="utf-8")
