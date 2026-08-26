"""Listening to a clip: every word, and exactly when it was said."""
from __future__ import annotations

import os
import threading
from pathlib import Path
from typing import Callable

import numpy as np

from .media import SAMPLE_RATE

# Frame size for the energy curve used to tighten word edges.
HOP = 80                     # 5 ms at 16 kHz
SNAP_WINDOW = 0.12           # look this far either side of a reported boundary
MIN_WORD = 0.02              # never shrink a word below 20 ms

_model = None
_model_lock = threading.Lock()


def model_name() -> str:
    return os.environ.get("YTP_MODEL", "small.en")


def _load():
    global _model
    with _model_lock:
        if _model is None:
            from faster_whisper import WhisperModel

            _model = WhisperModel(
                model_name(),
                device=os.environ.get("YTP_DEVICE", "cpu"),
                compute_type=os.environ.get("YTP_COMPUTE", "int8"),
            )
    return _model


def _energy(samples: np.ndarray) -> np.ndarray:
    """Short-term RMS, one value per HOP samples."""
    n = samples.size // HOP
    if n == 0:
        return np.zeros(1, dtype=np.float32)
    trimmed = samples[: n * HOP].reshape(n, HOP)
    return np.sqrt((trimmed.astype(np.float32) ** 2).mean(axis=1))


def _quietest_near(energy: np.ndarray, t: float, lo: float, hi: float) -> float:
    """The quietest moment within the search window — that's where to cut."""
    frames_per_sec = SAMPLE_RATE / HOP
    lo = max(lo, t - SNAP_WINDOW)
    hi = min(hi, t + SNAP_WINDOW)
    if hi <= lo:
        return t
    a = int(lo * frames_per_sec)
    b = int(hi * frames_per_sec)
    a = max(0, min(a, energy.size - 1))
    b = max(a + 1, min(b, energy.size))
    if b <= a:
        return t
    return (a + int(np.argmin(energy[a:b]))) / frames_per_sec


def tighten(words: list[dict], samples: np.ndarray) -> list[dict]:
    """Whisper's timings drift by ~0.1 s. Nudge each edge to the nearest gap."""
    if not words:
        return words
    energy = _energy(samples)
    total = samples.size / SAMPLE_RATE

    for i, word in enumerate(words):
        prev_end = words[i - 1]["e"] if i > 0 else 0.0
        next_start = words[i + 1]["s"] if i + 1 < len(words) else total

        start = _quietest_near(energy, word["s"], prev_end, word["e"] - MIN_WORD)
        end = _quietest_near(energy, word["e"], start + MIN_WORD, next_start)

        word["s"] = round(max(0.0, start), 4)
        word["e"] = round(min(total, max(end, start + MIN_WORD)), 4)
    return words


def listen(
    wav_path: Path,
    samples: np.ndarray,
    on_progress: Callable[[list[dict], float], None] | None = None,
) -> list[dict]:
    """Transcribe, reporting words as they arrive so the UI fills in live."""
    model = _load()
    segments, _info = model.transcribe(
        str(wav_path),
        word_timestamps=True,
        vad_filter=True,
        beam_size=5,
    )

    words: list[dict] = []
    for segment in segments:
        for w in segment.words or []:
            text = w.word.strip()
            if not text:
                continue
            words.append(
                {
                    "i": len(words),
                    "w": text,
                    "s": round(float(w.start), 4),
                    "e": round(float(w.end), 4),
                    "p": round(float(w.probability), 3),
                }
            )
        if on_progress is not None:
            # Report the raw timings while streaming; tighten once at the end.
            on_progress(list(words), float(segment.end))

    return tighten(words, samples)
