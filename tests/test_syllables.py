"""Cutting inside a word is the core trick, so the splitter gets pinned down."""
import numpy as np
import pytest

from ytp.syllables import (
    MIN_SYLLABLE,
    nearest_zero_crossing,
    snap_points,
    split,
)

RATE = 16_000


def syllabic(bursts, total, gap_level=0.0):
    """Loud bursts with quiet dips between them, like a spoken word."""
    samples = np.full(int(total * RATE), gap_level, dtype=np.float32)
    for start, end in bursts:
        a, b = int(start * RATE), int(end * RATE)
        t = np.arange(b - a) / RATE
        samples[a:b] = 0.6 * np.sin(2 * np.pi * 180 * t)
    return samples


def test_a_four_syllable_word_comes_apart():
    word = syllabic([(0.00, 0.16), (0.22, 0.38), (0.44, 0.60), (0.66, 0.84)], 0.84)

    pieces = split(word, RATE)

    assert len(pieces) == 4, f"expected four pieces, got {[p for p in pieces]}"
    for start, end in pieces:
        assert end - start >= MIN_SYLLABLE


def test_pieces_are_in_order_and_do_not_overlap():
    word = syllabic([(0.0, 0.15), (0.25, 0.40), (0.50, 0.70)], 0.70)

    pieces = split(word, RATE)

    for (_, end), (next_start, _) in zip(pieces, pieces[1:]):
        assert next_start >= end - 1e-6


def test_a_single_sound_is_left_whole():
    """One steady burst has nothing to cut at — don't invent seams."""
    word = syllabic([(0.0, 0.35)], 0.35)

    assert len(split(word, RATE)) == 1


def test_silence_is_left_whole():
    assert len(split(np.zeros(int(0.4 * RATE), dtype=np.float32), RATE)) == 1


def test_a_very_short_word_is_left_whole():
    assert len(split(syllabic([(0.0, 0.04)], 0.05), RATE)) == 1


def test_no_sliver_pieces_survive():
    """A tiny blip next to a real syllable must not become its own chip."""
    word = syllabic([(0.00, 0.18), (0.19, 0.21), (0.30, 0.50)], 0.50)

    for start, end in split(word, RATE):
        assert end - start >= MIN_SYLLABLE


def test_snap_points_land_in_the_quiet_bits():
    word = syllabic([(0.0, 0.15), (0.30, 0.45)], 0.45)

    marks = snap_points(word, RATE)

    assert marks, "no snap points offered at all"
    # something should be offered inside the 0.15-0.30 gap
    assert any(0.13 <= m <= 0.32 for m in marks)


def test_zero_crossing_lands_on_a_sign_change():
    t = np.arange(RATE) / RATE
    tone = np.sin(2 * np.pi * 100 * t).astype(np.float32)

    for probe in (1234, 4321, 8000):
        i = nearest_zero_crossing(tone, probe)
        assert np.signbit(tone[i]) != np.signbit(tone[i + 1])
        assert abs(i - probe) <= 160


def test_zero_crossing_survives_flat_audio():
    flat = np.full(1000, 0.3, dtype=np.float32)
    assert nearest_zero_crossing(flat, 500) == 500


def test_connected_syllables_still_split():
    """Syllables inside a word dip in loudness, they don't go silent.

    This is the ordinary case and the one worth guarding: a threshold tuned
    only on burst-and-silence audio hands the whole word back, which is what
    the drag handles exist to save you from.

    The carrier is noise, not a tone, because speech is broadband. A single
    sine at 180 Hz has a period longer than one analysis frame, so its
    envelope ripples at the frame rate and the ripple's own little peaks
    crowd out the real syllable dips — an artefact of the test signal that
    no speech produces.
    """
    rng = np.random.default_rng(7)
    t = np.arange(int(0.6 * RATE)) / RATE
    carrier = rng.normal(0, 0.3, t.size).astype(np.float32)
    # loudness dips to 55% between syllables, about five a second
    wobble = (0.775 + 0.225 * np.cos(2 * np.pi * 5 * t)).astype(np.float32)

    pieces = split(carrier * wobble, RATE)

    assert len(pieces) >= 3, f"connected syllables were left whole: {pieces}"
    for start, end in pieces:
        assert end - start >= MIN_SYLLABLE
