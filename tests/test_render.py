"""The render graph is built as a string, so it's worth checking it says what we mean."""
from pathlib import Path

import pytest

from ytp.render import FADE, Piece, build_command, render_audio


def cmd(pieces, **kw):
    kw.setdefault("width", 640)
    kw.setdefault("height", 360)
    kw.setdefault("fps", 25)
    return build_command(pieces, Path("/tmp/out.mp4"), **kw)


def filtergraph(args):
    return args[args.index("-filter_complex") + 1]


def test_each_source_is_opened_once():
    a, b = Path("/x/a.mp4"), Path("/x/b.mp4")
    pieces = [Piece(a, 0, 1), Piece(b, 2, 3), Piece(a, 4, 5), Piece(a, 6, 7)]

    args = cmd(pieces)

    assert args.count("-i") == 2, "same file opened more than once"
    assert str(a) in args and str(b) in args


def test_pieces_keep_their_order_through_the_concat():
    src = Path("/x/a.mp4")
    pieces = [Piece(src, 5.0, 5.5), Piece(src, 1.0, 1.5), Piece(src, 9.0, 9.5)]

    graph = filtergraph(cmd(pieces))

    assert "concat=n=3:v=1:a=1" in graph
    assert "[v0][a0][v1][a1][v2][a2]concat" in graph
    # trims appear in mix order, not source order
    assert graph.index("start=5.0000") < graph.index("start=1.0000") < graph.index("start=9.0000")


def test_every_cut_is_faded():
    src = Path("/x/a.mp4")
    graph = filtergraph(cmd([Piece(src, 1.0, 3.0)]))

    assert f"afade=t=in:st=0:d={FADE:.4f}" in graph
    # 2.0s piece: the fade out starts FADE before the end
    assert f"afade=t=out:st={2.0 - FADE:.4f}" in graph


def test_a_very_short_piece_still_fades_without_overlapping_itself():
    """A 10ms grab can't take an 8ms fade at each end and still have a middle."""
    src = Path("/x/a.mp4")
    graph = filtergraph(cmd([Piece(src, 1.0, 1.01)]))

    fades = [seg for seg in graph.split(",") if seg.startswith("afade")]
    assert len(fades) == 2
    for fade in fades:
        d = float(fade.split("d=")[1].split(":")[0].rstrip("]"))
        assert 0 < d <= 0.01 / 2 + 1e-9


def test_sound_is_normalised_so_clips_can_be_mixed_together():
    graph = filtergraph(cmd([Piece(Path("/x/a.mp4"), 0, 1), Piece(Path("/x/b.mp4"), 0, 1)]))
    assert graph.count("aformat=sample_rates=48000:channel_layouts=stereo") == 2


def test_empty_mix_is_refused_clearly():
    with pytest.raises(ValueError, match="nothing in the mix"):
        cmd([])
    with pytest.raises(ValueError, match="nothing in the mix"):
        render_audio([], Path("/tmp/out.wav"))


def test_a_zero_length_piece_is_refused():
    """Better a clear error than a filter graph that silently produces nothing."""
    with pytest.raises(ValueError, match="no length"):
        cmd([Piece(Path("/x/a.mp4"), 2.0, 2.0)])


def test_duration_is_never_rounded_up():
    assert Piece(Path("/x/a.mp4"), 1.0, 1.01).duration == pytest.approx(0.01)
