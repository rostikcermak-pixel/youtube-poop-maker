# YTP Maker

### → [rostikcermak-pixel.github.io/youtube-poop-maker](https://rostikcermak-pixel.github.io/youtube-poop-maker/)

Make him say things he never said.

A sentence-mixing editor for making YouTube Poops. Drop a video in, it writes
down every word the speaker says, and you click the words you want. No timeline
scrubbing, no typing timecodes.

Nothing to install and nothing to sign up for. It all runs in the tab, so your
video is never uploaded anywhere — the first visit fetches a speech model
(40 MB on a phone, 80 MB on a desktop) and keeps it for next time.

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

Phones get the small, quick model and desktops the larger, more accurate one.
`?model=fast` and `?model=good` override that either way.

Long clips are read a window at a time, so the opening words are clickable
while the end is still being transcribed.

To run it locally:

```
python -m http.server -d docs
```

### On your own machine

One command:

```
python run.py
```

That builds its own environment beside the file, installs what it needs the
first time, starts the server and opens the app. Nothing is installed
system-wide.

It serves the same interface as the website — the only difference is where the
listening happens. The page notices the server and hands the audio to it, so
there is no model to download in the browser and the work runs natively across
every core instead of in a tab on one.

Measured on a slow shared machine, a 25 second clip: 0.5 s, about **47x
realtime**. The website on a phone takes minutes for the same thing.

Saving a video also goes through ffmpeg here rather than by recording playback,
so it is not limited to real time.

| Variable | Default | Does |
| --- | --- | --- |
| `YTP_HOME` | `~/.ytp` | Where imported clips are kept |
| `YTP_MODEL` | `small.en` | `tiny.en` is quicker, `medium.en` is more accurate |
| `YTP_DEVICE` | `cpu` | Set to `cuda` if you have a suitable GPU |
| `YTP_THREADS` | every core | Decoding threads |
| `YTP_BEAM` | `1` | Greedy. `5` searches wider for the same words, 2-3x slower |

## Tests

```
python -m pytest tests/ -q        # the Python side
node --test tests/js/*.test.js    # the browser side
```

The browser code is a port of the Python analysis, so the two are also checked
against each other by running both over identical samples — that's what caught
the start edges drifting a frame early.

## What it does

- Import a video; every word is transcribed with its own timing
- Search every word across every clip you have open
- Click a word to hear it on its own, double-click to use it
- Cut inside a word, either from its syllable pieces or with magnetic handles
- **Make a word nobody said**, spliced from sounds inside other words
- Drop anything at a caret, so a new word goes mid-sentence rather than on the end
- Undo anything
- Save as a video or just the sound

Every cut gets an 8 ms fade, always, which is what stops joins clicking.

Not built: effects (stutter, reverse, pitch, and the rest), and loading a video
from a URL — the browser isn't allowed to fetch from YouTube, so files go in by
hand.
