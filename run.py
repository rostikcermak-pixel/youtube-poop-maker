#!/usr/bin/env python3
"""Start YTP Maker on this machine.

    python run.py

That is the whole thing. It builds an isolated environment beside this
file, installs what it needs the first time, then serves the app and opens
it. Nothing is installed system-wide and nothing is uploaded anywhere.

Running it here rather than from the website is worth it for one reason:
the listening happens natively across every core instead of in a browser
tab on one, which is the difference between minutes and seconds.
"""
from __future__ import annotations

import os
import subprocess
import sys
import venv
from pathlib import Path

HERE = Path(__file__).resolve().parent
VENV = HERE / ".ytp-venv"
MARKER = VENV / ".installed"


def python_in(env: Path) -> Path:
    return env / ("Scripts" if os.name == "nt" else "bin") / (
        "python.exe" if os.name == "nt" else "python")


def run(args: list[str], why: str) -> None:
    done = subprocess.run(args)
    if done.returncode != 0:
        sys.exit(f"\n{why} failed. The output above should say why.")


def main() -> None:
    if sys.version_info < (3, 10):
        sys.exit(f"This needs Python 3.10 or newer; you have {sys.version.split()[0]}.")

    python = python_in(VENV)
    if not python.exists():
        print("Setting up (first run only, a minute or two)…")
        venv.EnvBuilder(with_pip=True, clear=True).create(VENV)

    if not MARKER.exists():
        print("Installing what it needs…")
        run([str(python), "-m", "pip", "install", "--quiet", "--upgrade", "pip"],
            "Upgrading pip")
        run([str(python), "-m", "pip", "install", "--quiet", "-e", str(HERE)],
            "Installing")
        MARKER.write_text("ok", encoding="utf-8")

    print("\n  Starting YTP Maker. The first clip also downloads the speech model.")
    print("  Press Ctrl+C to stop.\n")
    try:
        subprocess.run([str(python), "-m", "ytp", *sys.argv[1:]])
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
