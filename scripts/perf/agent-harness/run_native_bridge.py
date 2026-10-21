#!/usr/bin/env python3
"""Run the installed native mixer bridge's network worker against a LOCAL stack.

The real controller-release/gas-mixer-native-bridge/native_bridge.py is
imported unchanged; only Qt and the Alicat model are replaced. The fake model
publishes a snapshot every 250 ms whose delivered flows jitter, so every cycle
carries changed state (the most expensive case), and it acknowledges drained
commands the way NativeBridge.apply_commands does (accepted, then applied).
No serial port, GPIO or instrument is touched.

  python3 run_native_bridge.py --endpoint http://127.0.0.1:57400/functions/v1/gas-mixer-native-agent \
      --token-env NATIVE_TOKEN --out native-receipts.jsonl --seconds 600
"""
import argparse
import importlib.util
import json
import logging
import os
from pathlib import Path
import random
import sys
import threading
import time
import types
from unittest.mock import Mock, patch
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[3]
BRIDGE = ROOT / "controller-release" / "gas-mixer-native-bridge" / "native_bridge.py"
CHANNELS = [
    ("A", "N2", True, "%", "SLPM"),
    ("B", "O2", False, "%", "SLPM"),
    ("C", "Ar", False, "PPM", "SCCM"),
    ("D", "CO2", False, "PPM", "SCCM"),
    ("E", "N2", False, "%", "SLPM"),
    ("F", "O2", False, "%", "SLPM"),
]


def load_bridge(path=BRIDGE):
    qt = types.ModuleType("PySide2.QtCore")
    qt.QObject = object
    qt.QTimer = Mock()
    qt.Slot = lambda *args: lambda function: function
    config = types.ModuleType("config")
    config.err_thresh = 3
    config.mfc_config = []
    spec = importlib.util.spec_from_file_location("harness_native_bridge", path)
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {"PySide2": types.ModuleType("PySide2"), "PySide2.QtCore": qt, "config": config}):
        spec.loader.exec_module(module)
    return module


def snapshot(total_slpm):
    channels = {}
    for address, formula, balance, ratio_unit, flow_unit in CHANNELS:
        ratio = 79.0 if address == "A" else (21.0 if address == "B" else 0.0)
        setpoint = total_slpm * ratio / 100
        channels[address] = {
            "address": address, "formula": formula, "balance": balance,
            "ratio_unit": ratio_unit, "flow_unit": flow_unit,
            "ratio": ratio, "setpoint": setpoint,
            # Live MFC readback jitters around the setpoint.
            "delivered": round(setpoint + random.uniform(-0.004, 0.004), 4),
            "available": True, "flow_error": False,
        }
    return {"use_licor": False, "total_slpm": total_slpm, "channels": channels}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--token-env", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--seconds", type=float, default=600)
    parser.add_argument("--bridge", default=str(BRIDGE), help="bridge file (default: the installed 2.1.2)")
    args = parser.parse_args()
    if urlparse(args.endpoint).hostname not in ("127.0.0.1", "localhost"):
        raise SystemExit("harness clients only talk to a local stack")
    token = os.environ[args.token_env]

    bridge = load_bridge(Path(args.bridge))
    # Keep the bridge's cloud log out of this machine's home directory.
    quiet = logging.getLogger("harness-native-cloud")
    quiet.addHandler(logging.NullHandler())
    quiet.propagate = False
    bridge._cloud_logger = lambda: quiet
    worker = bridge.NativeCloudWorker()
    worker._endpoint = args.endpoint
    worker._token = token
    revision = int(time.time() * 1000)
    total = 3.0
    receipts = open(args.out, "a")
    stop_at = time.monotonic() + args.seconds
    worker.publish_state(snapshot(total), revision, True)
    worker.start()

    def qt_loop():
        nonlocal revision, total
        while time.monotonic() < stop_at:
            for command in worker.drain_commands():
                receipts.write(json.dumps({"command_id": command.get("id"), "drained_at": time.time()}) + "\n")
                receipts.flush()
                worker.acknowledge({"command_id": command["id"], "status": "accepted"})
                field = (command.get("payload") or {}).get("field")
                value = (command.get("payload") or {}).get("value")
                if field == "total_slpm" and isinstance(value, (int, float)):
                    total = float(value)
                revision += 1
                worker.publish_state(snapshot(total), revision, False)
                worker.acknowledge({"command_id": command["id"], "status": "applied"})
            worker.publish_state(snapshot(total), revision, False)
            time.sleep(0.25)

    qt = threading.Thread(target=qt_loop, daemon=True)
    qt.start()
    qt.join()
    worker.stop()


if __name__ == "__main__":
    main()
