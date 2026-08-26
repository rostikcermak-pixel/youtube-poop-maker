"""`ytp` — start the server and open the app."""
from __future__ import annotations

import argparse
import socket
import threading
import webbrowser


def _free_port(host: str, preferred: int) -> int:
    with socket.socket() as s:
        try:
            s.bind((host, preferred))
            return preferred
        except OSError:
            s.bind((host, 0))
            return s.getsockname()[1]


def _lan_address() -> str | None:
    """This machine's address on the local network, for reaching it from a phone.

    Nothing is sent; opening a UDP socket toward an outside address is just
    how you ask the routing table which interface it would leave by.
    """
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except OSError:
        return None


def main() -> None:
    parser = argparse.ArgumentParser(prog="ytp", description="YouTube Poop maker")
    parser.add_argument("--port", type=int, default=8722)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument(
        "--share",
        action="store_true",
        help="also answer other devices on your network, so a phone can use "
             "this machine's speed. Only do this on a network you trust.",
    )
    args = parser.parse_args()

    import uvicorn

    host = "0.0.0.0" if args.share else "127.0.0.1"
    port = _free_port(host, args.port)
    local = f"http://127.0.0.1:{port}"

    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(local)).start()

    print(f"\n  YTP Maker is running at {local}")
    if args.share:
        address = _lan_address()
        if address:
            print(f"  On your phone, on the same wifi:  http://{address}:{port}")
        else:
            print("  Couldn't work out this machine's network address.")
        print("  Anyone on this network can reach it while it's running.")
    print("  Press Ctrl+C to stop.\n")

    uvicorn.run("ytp.server:app", host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()
