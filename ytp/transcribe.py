"""Listening to a clip: every word, and exactly when it was said."""
from __future__ import annotations

import os
import threading
from pathlib import Path
from typing import Callable

import numpy as np

from .media import SAMPLE_RATE

_model = None
_model_lock = threading.Lock()


def model_name() -> str:
    return os.environ.get("YTP_MODEL", "small.en")


def _load():
    """Loaded once, lazily — the first call downloads the model."""
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


# Frame size for the energy curve used to tighten word edges.
HOP = 80                     # 5 ms at 16 kHz
SNAP_WINDOW = 0.12           # how far either side of a reported edge to look
PULL = 0.5                   # bias toward leaving the edge where it was
MIN_WORD = 0.02              # never let a word collapse below 20 ms
KEEP_AT_LEAST = 0.5          # tightening may not cut a word below this share


def _energy(samples: np.ndarray) -> np.ndarray:
    """Short-term RMS, one value per HOP samples."""
    n = samples.size // HOP
    if n == 0:
        return np.zeros(1, dtype=np.float32)
    trimmed = samples[: n * HOP].reshape(n, HOP)
    return np.sqrt((trimmed.astype(np.float32) ** 2).mean(axis=1))


def _snap(energy: np.ndarray, raw: float, lo: float, hi: float) -> float:
    """The most convincing quiet moment near `raw`, preferring to stay put.

    Plain "quietest point in the window" drags edges toward whatever deep
    silence happens to be in range, which steals audio from the next word.
    Scoring loudness plus distance keeps an edge still unless moving it
    buys a real drop in level.
    """
    frames_per_sec = SAMPLE_RATE / HOP
    lo = max(lo, raw - SNAP_WINDOW)
    hi = min(hi, raw + SNAP_WINDOW)
    if hi <= lo:
        return raw

    a = max(0, min(int(lo * frames_per_sec), energy.size - 1))
    b = max(a + 1, min(int(hi * frames_per_sec) + 1, energy.size))
    if b <= a + 1:
        return raw

    window = energy[a:b]
    times = np.arange(a, b, dtype=np.float32) / frames_per_sec
    loudest = float(window.max())
    if loudest <= 0:
        return raw
    score = window / loudest + PULL * np.abs(times - raw) / SNAP_WINDOW
    return float(times[int(np.argmin(score))])


def repair(words: list[dict]) -> list[dict]:
    """Rescue words Whisper collapsed to nothing.

    Alignment sometimes fails on a long or unusual word: it comes back with
    zero duration while the word beside it holds the whole shared span. Left
    alone, clicking that word plays silence. When a neighbour is carrying
    obviously more time than its own length justifies, split the span they
    share in proportion to how many characters each word has.
    """
    healthy = [w for w in words if w["e"] - w["s"] >= MIN_WORD and w["w"]]
    if len(healthy) < 3:
        return words
    per_char = float(np.median([(w["e"] - w["s"]) / len(w["w"]) for w in healthy]))
    if per_char <= 0:
        return words

    for i, word in enumerate(words):
        if word["e"] - word["s"] >= MIN_WORD:
            continue

        # The word's time is often not in a neighbour at all — it's sitting in
        # an unclaimed gap that nothing occupies. Observed on real output: "it"
        # came back as 10.540-10.540 with 140 ms of empty space in front of it.
        # Take the gap first, because it costs no neighbour anything.
        prev = words[i - 1] if i > 0 else None
        nxt = words[i + 1] if i + 1 < len(words) else None
        gap_from = max(prev["e"], word["s"]) if prev else word["s"]
        gap_to = nxt["s"] if nxt else word["e"]
        if gap_to - gap_from >= MIN_WORD:
            word["s"], word["e"] = gap_from, gap_to
            continue

        for j in (i - 1, i + 1):
            if not 0 <= j < len(words):
                continue
            other = words[j]
            touching = min(abs(other["e"] - word["s"]), abs(word["e"] - other["s"])) <= 0.05
            bloated = (other["e"] - other["s"]) > 1.6 * per_char * max(1, len(other["w"]))
            if not (touching and bloated):
                continue

            first, second = (words[j], words[i]) if j < i else (words[i], words[j])
            lo, hi = min(word["s"], other["s"]), max(word["e"], other["e"])
            if hi - lo < 2 * MIN_WORD:
                continue
            share = max(1, len(first["w"])) / (max(1, len(first["w"])) + max(1, len(second["w"])))
            cut = lo + (hi - lo) * share
            first["s"], first["e"] = lo, cut
            second["s"], second["e"] = cut, hi
            break
    return words


def tighten(words: list[dict], samples: np.ndarray) -> list[dict]:
    """Whisper's edges drift by ~0.1 s. Nudge each one to the nearest gap.

    Every edge is snapped from its *original* position, never from an
    already-moved neighbour, so a single bad nudge can't cascade down the
    rest of the sentence.
    """
    if not words:
        return words
    energy = _energy(samples)
    total = samples.size / SAMPLE_RATE

    # The recogniser's last chunk can overrun the audio: observed on real
    # output, "artificial" came back starting at 25.180 against 25.01 s of
    # sound. Clamping only the end would leave the end before the start, so
    # anything with no audio left to sit in goes, and the rest is pulled back
    # inside the file before any of the edge finding runs.
    words = [w for w in words if w["s"] < total - MIN_WORD / 2]
    if not words:
        return words
    for word in words:
        word["s"] = max(0.0, min(word["s"], total - MIN_WORD))
        word["e"] = max(word["s"] + MIN_WORD, min(word["e"], total))
    for i, word in enumerate(words):
        word["i"] = i

    raw = [(w["s"], w["e"]) for w in words]

    for word, (rs, re) in zip(words, raw):
        word["s"] = _snap(energy, rs, 0.0, total)
        word["e"] = _snap(energy, re, 0.0, total)

    # Snapping independently can leave two words overlapping; split the difference.
    for earlier, later in zip(words, words[1:]):
        if earlier["e"] > later["s"]:
            middle = (earlier["e"] + later["s"]) / 2
            earlier["e"] = later["s"] = middle

    # Tightening is meant to nudge an edge onto the nearby silence, not to
    # resize the word. A word with a stop consonant in it has a quiet closure
    # in the middle, and an edge can snap to that instead of the real end:
    # observed on real output, "benefit" was healthy until tightening cut it
    # to 45 ms. If a word loses most of itself, the reported timing was better
    # than ours.
    for word, (rs, re) in zip(words, raw):
        after = word["e"] - word["s"]
        if after < MIN_WORD or after < (re - rs) * KEEP_AT_LEAST:
            word["s"], word["e"] = rs, re

    # Restoring can put an edge back over its neighbour, so settle order last.
    for earlier, later in zip(words, words[1:]):
        if earlier["e"] > later["s"]:
            earlier["e"] = max(earlier["s"] + MIN_WORD, min(earlier["e"], later["s"]))

    for word in words:
        word["s"] = round(max(0.0, word["s"]), 4)
        word["e"] = round(min(total, max(word["e"], word["s"] + MIN_WORD)), 4)
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

    return tighten(repair(words), samples)
