"""Turning a mix into a file.

Preview plays the source files where they sit; this is the only place
anything is actually rendered. One ffmpeg pass builds the whole thing:
each piece of the mix is trimmed, faded and normalised, then all of them
are concatenated in order.
"""
from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path

from .media import ffmpeg_exe

FADE = 0.008          # matches the browser exactly, so the file sounds like the preview
AUDIO_RATE = 48_000


@dataclass
class Piece:
    """One chip from the mix: a slice of one source clip."""
    source: Path
    start: float
    end: float
    has_video: bool = True

    @property
    def duration(self) -> float:
        """The true span. Never round this up — the fades are sized from it,
        and a piece that claims to be longer than it is gets fades that
        overlap each other, which puts back the click they exist to remove."""
        return max(0.0, self.end - self.start)


def _chain(index: int, piece: Piece, slot: int, width: int, height: int, fps: float) -> str:
    """Filters for one piece, labelled [vN]/[aN] for the concat at the end."""
    dur = piece.duration
    fade = min(FADE, dur / 2)

    video = (
        f"[{slot}:v]trim=start={piece.start:.4f}:end={piece.end:.4f},"
        f"setpts=PTS-STARTPTS,"
        f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,"
        f"setsar=1,fps={fps}[v{index}]"
    )
    audio = (
        f"[{slot}:a]atrim=start={piece.start:.4f}:end={piece.end:.4f},"
        f"asetpts=PTS-STARTPTS,"
        f"afade=t=in:st=0:d={fade:.4f},"
        f"afade=t=out:st={max(0.0, dur - fade):.4f}:d={fade:.4f},"
        f"aformat=sample_rates={AUDIO_RATE}:channel_layouts=stereo[a{index}]"
    )
    return video + ";" + audio


def build_command(
    pieces: list[Piece],
    out_path: Path,
    width: int,
    height: int,
    fps: float,
) -> list[str]:
    """The whole render as one ffmpeg invocation."""
    if not pieces:
        raise ValueError("nothing in the mix to save")
    if any(piece.duration <= 0 for piece in pieces):
        raise ValueError("one of the pieces in the mix has no length")

    # Each distinct source file is one input; pieces point at their input slot.
    sources: list[Path] = []
    for piece in pieces:
        if piece.source not in sources:
            sources.append(piece.source)

    args = [ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-y"]
    for source in sources:
        args += ["-i", str(source)]

    chains = [
        _chain(i, piece, sources.index(piece.source), width, height, fps)
        for i, piece in enumerate(pieces)
    ]
    joined = "".join(f"[v{i}][a{i}]" for i in range(len(pieces)))
    chains.append(f"{joined}concat=n={len(pieces)}:v=1:a=1[v][a]")

    args += [
        "-filter_complex", ";".join(chains),
        "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        str(out_path),
    ]
    return args


def render(
    pieces: list[Piece],
    out_path: Path,
    width: int = 1280,
    height: int = 720,
    fps: float = 30.0,
) -> Path:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    args = build_command(pieces, out_path, width, height, fps)
    done = subprocess.run(args, capture_output=True, text=True, errors="replace")
    if done.returncode != 0 or not out_path.exists():
        raise RuntimeError(f"couldn't save the video: {done.stderr.strip()[:400]}")
    return out_path


def render_audio(pieces: list[Piece], out_path: Path) -> Path:
    """Just the sound — for dropping into a different editor."""
    if not pieces:
        raise ValueError("nothing in the mix to save")
    if any(piece.duration <= 0 for piece in pieces):
        raise ValueError("one of the pieces in the mix has no length")

    sources: list[Path] = []
    for piece in pieces:
        if piece.source not in sources:
            sources.append(piece.source)

    args = [ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-y"]
    for source in sources:
        args += ["-i", str(source)]

    chains = []
    for i, piece in enumerate(pieces):
        dur = piece.duration
        fade = min(FADE, dur / 2)
        chains.append(
            f"[{sources.index(piece.source)}:a]"
            f"atrim=start={piece.start:.4f}:end={piece.end:.4f},"
            f"asetpts=PTS-STARTPTS,"
            f"afade=t=in:st=0:d={fade:.4f},"
            f"afade=t=out:st={max(0.0, dur - fade):.4f}:d={fade:.4f},"
            f"aformat=sample_rates={AUDIO_RATE}:channel_layouts=stereo[a{i}]"
        )
    chains.append("".join(f"[a{i}]" for i in range(len(pieces)))
                  + f"concat=n={len(pieces)}:v=0:a=1[a]")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    args += ["-filter_complex", ";".join(chains), "-map", "[a]", str(out_path)]
    done = subprocess.run(args, capture_output=True, text=True, errors="replace")
    if done.returncode != 0 or not out_path.exists():
        raise RuntimeError(f"couldn't save the audio: {done.stderr.strip()[:400]}")
    return out_path
