#!/usr/bin/env python3
"""Run the installed gas-mixer screen agent's real loop against a LOCAL stack.

controller-release/gas-mixer-agent/agent.py is imported unchanged and its
main() runs as shipped. Only hardware edges are replaced: capture returns a
valid PNG whose pixels change on every capture (the live mixer screen shows
changing flow values), taps are recorded instead of injected into X11, and the
mixer process/console checks report an available session.

  python3 run_screen_agent.py --endpoint http://127.0.0.1:57400/functions/v1/gas-mixer-agent \
      --token-env NATIVE_TOKEN --out screen-taps.jsonl --lock /path/agent.lock --seconds 600
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import struct
import sys
import threading
import time
from urllib.parse import urlparse
import zlib

ROOT = Path(__file__).resolve().parents[3]
AGENT = ROOT / "controller-release" / "gas-mixer-agent" / "agent.py"


def png(seed):
    width, height = 64, 32
    rows = b"".join(b"\x00" + bytes(((seed + x + y) % 256 for x in range(width * 3))) for y in range(height))

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--token-env", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--lock", required=True)
    parser.add_argument("--seconds", type=float, default=600)
    parser.add_argument("--agent", default=str(AGENT), help="agent file (default: the installed 1.0.1)")
    args = parser.parse_args()
    if urlparse(args.endpoint).hostname not in ("127.0.0.1", "localhost"):
        raise SystemExit("harness clients only talk to a local stack")
    token = os.environ[args.token_env]

    spec = importlib.util.spec_from_file_location("harness_screen_agent", Path(args.agent))
    agent = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(agent)
    taps = open(args.out, "a")
    counter = {"frame": 0}

    class RecordingTapper:
        def tap(self, normalized_x, normalized_y):
            taps.write(json.dumps({"tapped_at": time.time(), "x": normalized_x, "y": normalized_y}) + "\n")
            taps.flush()

    def capture_png():
        counter["frame"] += 1
        return png(counter["frame"])

    agent.LOCK_PATH = args.lock
    agent.load_config = lambda: (args.endpoint, token)
    agent.X11Tapper = RecordingTapper
    agent.mixer_is_running = lambda: True
    agent.graphical_console_is_active = lambda: True
    agent.capture_png = capture_png
    os.environ.setdefault("XAUTHORITY", os.devnull)

    loop = threading.Thread(target=agent.main, daemon=True)
    loop.start()
    time.sleep(args.seconds)


if __name__ == "__main__":
    main()
