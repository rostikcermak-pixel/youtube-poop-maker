"""Edge-tightening is the part most likely to quietly ruin a mix, so it gets tests."""
import numpy as np
import pytest

from ytp.media import SAMPLE_RATE
from ytp.transcribe import MIN_WORD, repair, tighten


def speech_like(spans, total=6.0):
    """Tone bursts where words are, silence everywhere else."""
    samples = np.zeros(int(total * SAMPLE_RATE), dtype=np.float32)
    for start, end in spans:
        a, b = int(start * SAMPLE_RATE), int(end * SAMPLE_RATE)
        t = np.arange(b - a) / SAMPLE_RATE
        samples[a:b] = 0.5 * np.sin(2 * np.pi * 220 * t)
    return samples


def words_from(times):
    return [{"i": i, "w": f"w{i}", "s": s, "e": e, "p": 1.0}
            for i, (s, e) in enumerate(times)]


def test_no_word_is_crushed():
    """The bug this was written for: one edge drifting and flattening its neighbour."""
    spans = [(0.5, 1.0), (1.6, 2.4), (3.0, 3.3), (3.9, 4.8)]
    samples = speech_like(spans)
    # Whisper-ish: every edge reported slightly late.
    reported = [(s + 0.07, e + 0.07) for s, e in spans]

    out = tighten(words_from(reported), samples)

    for word in out:
        assert word["e"] - word["s"] >= MIN_WORD, f"{word['w']} collapsed"


def test_edges_move_toward_the_real_silence():
    spans = [(0.5, 1.0), (1.6, 2.4)]
    samples = speech_like(spans)
    reported = [(0.57, 1.07), (1.67, 2.47)]

    out = tighten(words_from(reported), samples)

    for word, (true_s, true_e) in zip(out, spans):
        assert abs(word["s"] - true_s) <= 0.09
        assert abs(word["e"] - true_e) <= 0.09


def test_words_never_overlap():
    spans = [(0.5, 1.0), (1.05, 1.6), (1.65, 2.2)]
    samples = speech_like(spans)
    reported = [(0.44, 1.09), (0.99, 1.68), (1.59, 2.28)]

    out = tighten(words_from(reported), samples)

    for earlier, later in zip(out, out[1:]):
        assert earlier["e"] <= later["s"] + 1e-6


def test_one_bad_edge_does_not_cascade():
    """A word next to a long pause must not steal from the word after it."""
    spans = [(0.5, 0.9), (2.5, 3.4), (3.5, 3.9)]
    samples = speech_like(spans)
    reported = [(0.5, 0.9), (2.5, 3.45), (3.47, 3.9)]

    out = tighten(words_from(reported), samples)

    assert out[1]["e"] - out[1]["s"] > 0.5, "long word lost its body"
    assert out[2]["e"] - out[2]["s"] > 0.2, "short word got crushed"


def test_empty_and_silent_inputs_are_survivable():
    assert tighten([], np.zeros(1000, dtype=np.float32)) == []
    silent = np.zeros(int(2 * SAMPLE_RATE), dtype=np.float32)
    out = tighten(words_from([(0.4, 0.8)]), silent)
    assert out[0]["e"] > out[0]["s"]


# --- rescuing words Whisper collapsed to nothing ------------------------------

def test_zero_length_word_gets_its_time_back():
    """The real failure: 'and' held 0.76s while 'motivations' came back as 0.00s."""
    words = words_from([(3.18, 3.52), (3.52, 3.86), (3.86, 4.62), (4.62, 4.62), (4.62, 4.96)])
    for word, text in zip(words, ["its", "features", "and", "motivations", "might"]):
        word["w"] = text

    out = repair(words)
    and_word = next(w for w in out if w["w"] == "and")
    motiv = next(w for w in out if w["w"] == "motivations")

    assert motiv["e"] - motiv["s"] >= MIN_WORD, "still silent when clicked"
    # 'motivations' is far longer than 'and', so it should get the bigger share.
    assert motiv["e"] - motiv["s"] > and_word["e"] - and_word["s"]
    assert and_word["e"] == pytest.approx(motiv["s"]), "left a hole between them"


def test_repair_leaves_healthy_neighbours_alone():
    """A short word next to a normal-length word must not carve it up."""
    words = words_from([(1.0, 1.34), (1.34, 1.35), (1.35, 1.69)])
    for word, text in zip(words, ["one", "a", "two"]):
        word["w"] = text
    before = [(w["s"], w["e"]) for w in words[::2]]

    out = repair(words)

    assert [(w["s"], w["e"]) for w in out[::2]] == before


def test_repair_survives_short_input():
    assert repair([]) == []
