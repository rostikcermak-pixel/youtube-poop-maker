# YTP Maker

A sentence-mixing editor for making YouTube Poops. Drop a video in, it writes
down every word the speaker says, and you click the words you want. No
timeline scrubbing, no typing timecodes.

## Running it

```
uv venv
uv pip install --python .venv/bin/python -e .
.venv/bin/python -m ytp
```

It starts a local server and opens your browser. On the first run it downloads
the speech model (about 500 MB), which is cached afterwards.

## Settings

| Variable | Default | Does |
| --- | --- | --- |
| `YTP_HOME` | `~/.ytp` | Where imported clips are kept |
| `YTP_MODEL` | `small.en` | Speech model — `tiny.en` is faster, `medium.en` is more accurate |
| `YTP_DEVICE` | `cpu` | Set to `cuda` if you have a suitable GPU |

## Where it's up to

Phase 0 of the build plan: import a video, see its words, click one to hear it.
Phase 1 (building a mix and saving a video) is in progress.
