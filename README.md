# YTP Maker

Make him say things he never said.

A sentence-mixing editor for making YouTube Poops. Drop a video in, it writes
down every word the speaker says, and you click the words you want. No timeline
scrubbing, no typing timecodes.

## The idea

The hard part of sentence mixing isn't editing, it's *finding the syllable*.
So this is built around a searchable word bank, not a timeline. Every word in
the video is already a clip: search it, click it to hear it, double-click it to
use it. To get "duh" out of "documentaries", the word comes pre-chopped into
syllable-sized pieces, with magnetic drag handles if you want to be precise.

## Two ways to run it

### In the browser (`docs/`)

Everything runs in the tab — the speech recognition included. Your video is
never uploaded anywhere. Hosted on GitHub Pages, so it costs nothing to keep
running.

The first visit downloads about 80 MB of speech model, which the browser then
caches. Add `?model=fast` to the URL for a smaller, rougher one.

To run it locally:

```
python -m http.server -d docs
```

### On your own machine (`ytp/`)

The Python version. Faster on long videos, and it's the one that can save a
finished video file rather than just the audio.

```
uv venv
uv pip install --python .venv/bin/python -e .
.venv/bin/python -m ytp
```

It starts a local server and opens your browser. First run downloads the
speech model (about 500 MB), cached afterwards.

| Variable | Default | Does |
| --- | --- | --- |
| `YTP_HOME` | `~/.ytp` | Where imported clips are kept |
| `YTP_MODEL` | `small.en` | `tiny.en` is faster, `medium.en` is more accurate |
| `YTP_DEVICE` | `cpu` | Set to `cuda` if you have a suitable GPU |

## Tests

```
python -m pytest tests/ -q        # the Python side
node --test tests/js/*.test.js    # the browser side
```

The browser code is a port of the Python analysis, so the two are also checked
against each other by running both over identical samples — that's what caught
the start edges drifting a frame early.

## Where it's up to

Working: import, transcribe, search, click a word to hear it, cut inside a word,
build a mix, play it back, save the audio. The Python version also saves video.

Next: the say-it box (type a sentence, get ranked ways to build it from what the
speaker actually said), then effects.
