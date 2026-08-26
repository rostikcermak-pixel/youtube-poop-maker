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

# Greedy decoding rather than a beam search.
#
# Measured on a 25 s clip: five beams took 1.7 s against 0.6 s greedy with
# tiny, and 4.6 s against 2.6 s with small — two to three times the work for
# the same 64 words either way. Sentence mixing wants the timings far more
# than it wants the model's second-guessing, and you can hear every word
# before you use it.
BEAM = int(os.environ.get("YTP_BEAM", 1))


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
                # default is conservative; use the machine you're on
                cpu_threads=int(os.environ.get("YTP_THREADS", 0)) or (os.cpu_count() or 4),
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


def repair(words: list[dict], total: float | None = None) -> list[dict]:
    """Rescue words the recogniser collapsed to nothing.

    Alignment sometimes fails: a word comes back with no duration while the
    word beside it holds the whole shared span. Left alone, clicking that
    word plays silence, and clicking its neighbour plays both.
    """
    healthy = [w for w in words if w["e"] - w["s"] >= MIN_WORD and w["w"]]
    if len(healthy) < 3:
        return words

    for i, word in enumerate(words):
        if word["e"] - word["s"] >= MIN_WORD:
            continue

        prev = words[i - 1] if i > 0 else None
        nxt = words[i + 1] if i + 1 < len(words) else None

        # Unclaimed space, which costs no neighbour anything. A word at the
        # very end of the clip can run to the end of the audio, which is why
        # the clip's length is worth knowing here — without it the last word
        # has nowhere to grow and stays silent.
        gap_from = max(prev["e"], word["s"]) if prev else word["s"]
        gap_to = nxt["s"] if nxt else (total if total is not None else word["e"])
        gap_gives = gap_to - gap_from

        # Or take the span shared with a neighbour and split it by how long
        # each word is. Overlapping counts, not just touching: a starved word
        # often sits inside its neighbour's span rather than against its edge,
        # and testing the edges alone finds no donor and leaves it silent.
        #
        # The neighbour used to have to look greedy — longer than 1.6x what
        # its own character count justified — which let the real failure
        # through: a long word holding 1.4 s for itself and the word after it
        # still measured as innocent. A word with no time is evidence enough.
        split = None
        donors = [
            other for other in (prev, nxt)
            if other is not None
            and other["s"] <= word["e"] + 0.05
            and word["s"] <= other["e"] + 0.05
        ]
        donors.sort(key=lambda o: o["e"] - o["s"], reverse=True)

        for other in donors:
            lo = min(word["s"], other["s"])
            hi = max(word["e"], other["e"])
            if hi - lo < 2 * MIN_WORD:
                continue

            before = other is prev
            mine = max(1, len(word["w"]))
            theirs = max(1, len(other["w"]))
            share = theirs / (mine + theirs) if before else mine / (mine + theirs)
            cut = lo + (hi - lo) * share
            cut = min(max(cut, lo + MIN_WORD), hi - MIN_WORD)

            split = {
                "other": other, "before": before, "lo": lo, "hi": hi, "cut": cut,
                "gives": (hi - cut) if before else (cut - lo),
            }
            break

        # Free space wins unless it is markedly worse than what a split would
        # give. Taking a 0.1 s gap while the neighbour sits on 1.4 s leaves a
        # word too short to hear, which is barely better than silence.
        if gap_gives >= MIN_WORD and (split is None or gap_gives >= split["gives"] * 0.6):
            word["s"], word["e"] = gap_from, gap_to
        elif split is not None:
            first = split["other"] if split["before"] else word
            second = word if split["before"] else split["other"]
            first["s"], first["e"] = split["lo"], split["cut"]
            second["s"], second["e"] = split["cut"], split["hi"]

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


def warm() -> None:
    """Load the model now, so the first clip doesn't wait for it.

    Loading is most of what a first request costs: the same clip that
    transcribes in under two seconds took twenty-seven the first time,
    almost all of it getting the model into memory.
    """
    _load()


def listen_samples(samples: np.ndarray) -> list[dict]:
    """Transcribe samples the browser has already decoded for us.

    faster-whisper takes an array directly, so audio that has been decoded
    and resampled in the page does not need writing back out to a file
    just to be read again.
    """
    model = _load()
    segments, _info = model.transcribe(
        samples.astype(np.float32),
        word_timestamps=True,
        vad_filter=True,
        beam_size=BEAM,
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
    return tighten(repair(words, samples.size / SAMPLE_RATE), samples)


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
        beam_size=BEAM,
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

    return tighten(repair(words, samples.size / SAMPLE_RATE), samples)
