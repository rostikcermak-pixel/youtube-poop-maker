"""Cutting inside a word.

Getting "duh" out of "documentaries" is the whole trick of sentence mixing,
so the app has to make it easy to cut *within* a word. Two things support
that: chopping a word at its natural quiet points, and offering a set of
sensible places for a dragged handle to land.
"""
from __future__ import annotations

import numpy as np

HOP = 80                  # 5 ms at 16 kHz
SMOOTH = 3                # frames of moving average over the energy curve
MIN_SYLLABLE = 0.06       # a piece shorter than this isn't a syllable
PEAK_FLOOR = 0.25         # ignore bumps below this fraction of the loudest
VALLEY_DROP = 0.9         # how far a dip must fall below its peaks to be a cut
QUIET = 0.15              # fraction of peak level counted as "quiet"

# VALLEY_DROP is deliberately permissive. Syllables inside a word are joined,
# not separated by silence, so the dip between them is shallow: on 33 real
# words a 0.6 threshold averaged 1.97 pieces and never split anything more
# than four ways, leaving six-syllable words nearly whole. At 0.9 the same
# words average 2.91 pieces with a 0.145s median, which is syllable-sized.
# Over-splitting is cheap (ignore the extra chips, or click the whole word);
# under-splitting leaves you dragging handles by hand, which is the thing
# this is here to avoid. MIN_SYLLABLE stops it producing slivers.


def envelope(samples: np.ndarray) -> np.ndarray:
    """Smoothed short-term loudness, one value per HOP samples."""
    n = samples.size // HOP
    if n == 0:
        return np.zeros(1, dtype=np.float32)
    frames = samples[: n * HOP].reshape(n, HOP).astype(np.float32)
    rms = np.sqrt((frames ** 2).mean(axis=1))
    if rms.size < SMOOTH:
        return rms
    kernel = np.ones(SMOOTH, dtype=np.float32) / SMOOTH
    return np.convolve(rms, kernel, mode="same")


def _peaks(env: np.ndarray) -> list[int]:
    floor = env.max() * PEAK_FLOOR
    return [
        i for i in range(1, env.size - 1)
        if env[i] >= env[i - 1] and env[i] > env[i + 1] and env[i] >= floor
    ]


def _valleys(env: np.ndarray, peaks: list[int]) -> list[tuple[int, float]]:
    """Dips between consecutive peaks, with how convincing each one is."""
    out = []
    for left, right in zip(peaks, peaks[1:]):
        if right - left < 2:
            continue
        i = left + int(np.argmin(env[left:right]))
        depth = float(env[i]) / max(1e-9, float(min(env[left], env[right])))
        out.append((i, depth))
    return out


def _merge_slivers(bounds: list[int], rate: int, total: int) -> list[int]:
    """Fold away any piece too short to be worth having as its own chip."""
    least = max(1, int(MIN_SYLLABLE * rate / HOP))
    changed = True
    while changed and len(bounds) > 2:
        changed = False
        for i in range(len(bounds) - 1):
            if bounds[i + 1] - bounds[i] < least:
                # drop whichever inner edge leaves the tidier pair
                drop = i + 1 if i + 1 < len(bounds) - 1 else i
                if 0 < drop < len(bounds) - 1:
                    bounds.pop(drop)
                    changed = True
                    break
    return bounds


def split(samples: np.ndarray, rate: int) -> list[tuple[float, float]]:
    """Chop a word into syllable-ish pieces, as seconds from its start."""
    total = samples.size
    whole = [(0.0, total / rate)]
    env = envelope(samples)
    if env.size < 4 or env.max() <= 0:
        return whole

    peaks = _peaks(env)
    if len(peaks) < 2:
        return whole

    cuts = [i for i, depth in _valleys(env, peaks) if depth <= VALLEY_DROP]
    if not cuts:
        return whole

    bounds = _merge_slivers([0, *cuts, env.size], rate, total)
    if len(bounds) < 3:
        return whole

    pieces = []
    for a, b in zip(bounds, bounds[1:]):
        start = a * HOP / rate
        end = min(total / rate, b * HOP / rate)
        if end - start >= MIN_SYLLABLE:
            pieces.append((round(start, 4), round(end, 4)))
    return pieces or whole


def snap_points(samples: np.ndarray, rate: int) -> list[float]:
    """Places a dragged handle should be drawn to, as seconds from the start.

    Every dip between syllables, plus wherever the sound crosses into or out
    of near-silence. Handles land on these so a grab lines up with the audio
    instead of whatever pixel the mouse happened to be over.
    """
    env = envelope(samples)
    if env.size < 3 or env.max() <= 0:
        return []

    quiet = env.max() * QUIET
    marks = {i for i, _ in _valleys(env, _peaks(env))}
    for i in range(1, env.size):
        crossed_up = env[i - 1] < quiet <= env[i]
        crossed_down = env[i - 1] >= quiet > env[i]
        if crossed_up or crossed_down:
            marks.add(i)

    return sorted(round(i * HOP / rate, 4) for i in marks)


def nearest_zero_crossing(samples: np.ndarray, index: int, search: int = 160) -> int:
    """Cutting where the waveform crosses zero is what stops a click."""
    lo = max(1, index - search)
    hi = min(samples.size - 1, index + search)
    if hi <= lo:
        return index
    window = samples[lo:hi]
    crossings = np.where(np.signbit(window[:-1]) != np.signbit(window[1:]))[0]
    if crossings.size == 0:
        return index
    return int(lo + crossings[np.argmin(np.abs(lo + crossings - index))])
