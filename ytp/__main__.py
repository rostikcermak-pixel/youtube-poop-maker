"""`ytp` — start the server and open the app."""
from __future__ import annotations

import argparse
import socket
import threading
import webbrowser


def _free_port(preferred: int) -> int:
    with socket.socket() as s:
        try:
            s.bind(("127.0.0.1", preferred))
            return preferred
        except OSError:
            s.bind(("127.0.0.1", 0))
            return s.getsockname()[1]


def main() -> None:
    parser = argparse.ArgumentParser(prog="ytp", description="YouTube Poop maker")
    parser.add_argument("--port", type=int, default=8722)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    import uvicorn

    port = _free_port(args.port)
    url = f"http://127.0.0.1:{port}"

    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()

    print(f"\n  YTP Maker is running at {url}\n  Press Ctrl+C to stop.\n")
    uvicorn.run("ytp.server:app", host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
