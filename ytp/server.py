"""The local web server. Everything the browser talks to lives here."""
from __future__ import annotations

import re
import shutil
import time
import threading
import traceback
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, UploadFile
from pydantic import BaseModel
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import media, render, store, transcribe

WEB = Path(__file__).parent / "web"

app = FastAPI(title="YTP Maker")


# --------------------------------------------------------------- import work

def _import_clip(clip_id: str) -> None:
    """Runs on a worker thread: pull the audio out, draw the squiggle, listen."""
    clip = store.load(clip_id)
    if clip is None:
        return
    try:
        probe = media.probe(clip.video_path)
        clip.duration = probe.duration
        clip.width, clip.height = probe.width, probe.height
        clip.fps = probe.fps
        clip.has_video = probe.has_video
        clip.progress = 0.05
        clip.save()

        media.extract_wav(clip.video_path, clip.wav_path)
        samples = media.read_wav(clip.wav_path)
        media.write_json(clip.peaks_path, media.peaks(samples))

        clip.status = "listening"
        clip.progress = 0.15
        clip.save()

        def on_words(words: list[dict], done_upto: float) -> None:
            # Re-read so we never clobber a delete that landed mid-transcribe.
            current = store.load(clip_id)
            if current is None or current.status == "failed":
                return
            current.words = words
            if clip.duration:
                current.progress = 0.15 + 0.85 * min(1.0, done_upto / clip.duration)
            current.save()

        words = transcribe.listen(clip.wav_path, samples, on_progress=on_words)

        final = store.load(clip_id)
        if final is None:
            return
        final.words = words
        final.status = "ready"
        final.progress = 1.0
        final.save()
    except Exception as exc:  # surfaced to the user in plain words
        traceback.print_exc()
        failed = store.load(clip_id)
        if failed is not None:
            failed.status = "failed"
            failed.error = str(exc)[:500]
            failed.save()


# ------------------------------------------------------------------ clip API

@app.post("/api/clips")
async def create_clip(file: UploadFile):
    clip = store.Clip(id=store.new_id(), name=file.filename or "clip")
    clip.dir.mkdir(parents=True, exist_ok=True)

    suffix = Path(file.filename or "").suffix or ".mp4"
    dest = clip.dir / f"source{suffix}"
    with dest.open("wb") as fh:
        shutil.copyfileobj(file.file, fh)
    clip.save()

    threading.Thread(target=_import_clip, args=(clip.id,), daemon=True).start()
    return clip.summary()


@app.get("/api/clips")
async def list_clips():
    return [c.summary() for c in store.load_all()]


@app.get("/api/clips/{clip_id}")
async def get_clip(clip_id: str):
    clip = store.load(clip_id)
    if clip is None:
        raise HTTPException(404, "no such clip")
    return clip.summary()


@app.delete("/api/clips/{clip_id}")
async def remove_clip(clip_id: str):
    store.delete(clip_id)
    return {"ok": True}


@app.get("/api/clips/{clip_id}/peaks")
async def get_peaks(clip_id: str):
    clip = store.load(clip_id)
    if clip is None or not clip.peaks_path.exists():
        raise HTTPException(404, "no waveform yet")
    return FileResponse(clip.peaks_path, media_type="application/json")


@app.get("/api/clips/{clip_id}/audio.wav")
async def get_audio(clip_id: str):
    clip = store.load(clip_id)
    if clip is None or not clip.wav_path.exists():
        raise HTTPException(404, "no audio yet")
    return FileResponse(clip.wav_path, media_type="audio/wav")


_RANGE = re.compile(r"bytes=(\d*)-(\d*)")


@app.get("/api/clips/{clip_id}/video")
async def get_video(clip_id: str, request: Request):
    """Range-aware so the browser can seek without downloading the whole file."""
    clip = store.load(clip_id)
    if clip is None or not clip.video_path.exists():
        raise HTTPException(404, "no video")
    path = clip.video_path
    size = path.stat().st_size
    media_type = "video/mp4"

    rng = request.headers.get("range")
    if not rng or not (m := _RANGE.match(rng)):
        return FileResponse(path, media_type=media_type)

    start = int(m.group(1)) if m.group(1) else 0
    end = int(m.group(2)) if m.group(2) else size - 1
    end = min(end, size - 1)
    if start > end:
        return Response(status_code=416, headers={"content-range": f"bytes */{size}"})
    length = end - start + 1

    def chunks():
        with path.open("rb") as fh:
            fh.seek(start)
            left = length
            while left > 0:
                block = fh.read(min(65536, left))
                if not block:
                    break
                left -= len(block)
                yield block

    return StreamingResponse(
        chunks(),
        status_code=206,
        media_type=media_type,
        headers={
            "content-range": f"bytes {start}-{end}/{size}",
            "accept-ranges": "bytes",
            "content-length": str(length),
        },
    )


# -------------------------------------------------------------------- saving

class MixPiece(BaseModel):
    clipId: str
    s: float
    e: float


class RenderRequest(BaseModel):
    items: list[MixPiece]
    height: int = 720          # 0 keeps whatever the source was
    audioOnly: bool = False


def exports_dir():
    d = store.data_dir() / "exports"
    d.mkdir(parents=True, exist_ok=True)
    return d


@app.post("/api/render")
async def render_mix(req: RenderRequest):
    if not req.items:
        raise HTTPException(400, "There's nothing in your mix yet.")

    pieces, clips = [], {}
    for item in req.items:
        clip = clips.get(item.clipId) or store.load(item.clipId)
        if clip is None:
            raise HTTPException(404, "One of the clips in your mix is missing.")
        clips[item.clipId] = clip
        pieces.append(render.Piece(clip.video_path, item.s, item.e, clip.has_video))

    stamp = time.strftime("%Y%m%d-%H%M%S")
    try:
        if req.audioOnly:
            out = render.render_audio(pieces, exports_dir() / f"poop-{stamp}.wav")
        else:
            first = next(iter(clips.values()))
            height = req.height or (first.height or 720)
            width = round(height * 16 / 9 / 2) * 2
            out = render.render(
                pieces,
                exports_dir() / f"poop-{stamp}.mp4",
                width=width,
                height=height - (height % 2),
                fps=first.fps or 30.0,
            )
    except Exception as exc:
        raise HTTPException(500, str(exc)[:400])

    return {"name": out.name, "url": f"/api/exports/{out.name}", "bytes": out.stat().st_size}


@app.get("/api/exports/{name}")
async def get_export(name: str):
    path = exports_dir() / Path(name).name        # never escape the exports folder
    if not path.exists():
        raise HTTPException(404, "no such file")
    return FileResponse(path, filename=path.name)

@app.get("/api/health")
async def health():
    return {"ok": True, "model": transcribe.model_name()}


app.mount("/", StaticFiles(directory=WEB, html=True), name="web")
