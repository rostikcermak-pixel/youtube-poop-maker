"""Where clips live on disk. One folder per imported video."""
from __future__ import annotations

import json
import os
import shutil
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path


def data_dir() -> Path:
    root = Path(os.environ.get("YTP_HOME", Path.home() / ".ytp"))
    root.mkdir(parents=True, exist_ok=True)
    return root


def clips_dir() -> Path:
    d = data_dir() / "clips"
    d.mkdir(parents=True, exist_ok=True)
    return d


@dataclass
class Clip:
    id: str
    name: str
    duration: float = 0.0
    width: int | None = None
    height: int | None = None
    fps: float | None = None
    has_video: bool = True
    # "importing" -> "listening" -> "ready", or "failed"
    status: str = "importing"
    progress: float = 0.0
    error: str | None = None
    words: list[dict] = field(default_factory=list)

    @property
    def dir(self) -> Path:
        return clips_dir() / self.id

    @property
    def video_path(self) -> Path:
        matches = sorted(self.dir.glob("source.*"))
        return matches[0] if matches else self.dir / "source.bin"

    @property
    def wav_path(self) -> Path:
        return self.dir / "audio.wav"

    @property
    def peaks_path(self) -> Path:
        return self.dir / "peaks.json"

    def save(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        (self.dir / "clip.json").write_text(json.dumps(asdict(self)), encoding="utf-8")

    def summary(self) -> dict:
        """Everything the browser needs except the (large) peaks array."""
        d = asdict(self)
        return d


def new_id() -> str:
    return uuid.uuid4().hex[:12]


def load(clip_id: str) -> Clip | None:
    meta = clips_dir() / clip_id / "clip.json"
    if not meta.exists():
        return None
    return Clip(**json.loads(meta.read_text(encoding="utf-8")))


def load_all() -> list[Clip]:
    out = []
    for d in sorted(clips_dir().iterdir()) if clips_dir().exists() else []:
        if (clip := load(d.name)) is not None:
            out.append(clip)
    return out


def delete(clip_id: str) -> None:
    shutil.rmtree(clips_dir() / clip_id, ignore_errors=True)
