#!/usr/bin/env python3
"""Structured ExactH2O bridge for the existing pi-mfc-gui Qt model.

This module runs inside the existing mixer process. It never opens the Alicat
serial port; all commands are applied to the same PiMfcGuiModel already used by
the physical touchscreen, so there cannot be a second hardware controller.
"""

import hashlib
import json
import math
import os
import queue
import threading
import time
import urllib.error
import urllib.request

from PySide2.QtCore import QObject, QTimer, Slot

from config import err_thresh, mfc_config


BRIDGE_VERSION = "exacth2o-gas-mixer-native-bridge/2.1.0"
CONFIG_PATH = os.path.expanduser("~/.config/exacth2o-gas-mixer-agent/config.json")


def _post_json(endpoint, token, payload):
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        endpoint,
        data=body,
        headers={
            "Content-Type": "application/json",
            "User-Agent": BRIDGE_VERSION,
            "X-Device-Token": token,
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        value = response.read()
        if response.status < 200 or response.status >= 300:
            raise RuntimeError("native bridge endpoint returned {}".format(response.status))
    return json.loads(value.decode("utf-8"))


def _native_endpoint():
    with open(CONFIG_PATH, "r") as handle:
        value = json.load(handle)
    endpoint = value.get("endpoint", "")
    token = value.get("device_token", "")
    if not endpoint.startswith("https://") or len(token) < 32:
        raise RuntimeError("existing gas mixer agent configuration is invalid")
    return endpoint.rsplit("/", 1)[0] + "/gas-mixer-native-agent", token


class NativeCloudWorker(object):
    """Network worker isolated from Qt's object and thread machinery.

    The original bridge placed blocking HTTPS calls and rapidly queued Python
    objects on a QThread. On the Walker Pi's Python 3.7/PySide2 stack that
    eventually produced a native QThread SIGSEGV and killed the mixer GUI.
    This worker keeps only the newest state snapshot under a normal Python
    lock and returns commands through a bounded, main-thread timer drain.
    """

    def __init__(self):
        self._endpoint = None
        self._token = None
        self._last_heartbeat = 0.0
        self._last_state_hash = None
        self._state = None
        self._revision = 0
        self._sync_requested = False
        self._state_sequence = 0
        self._state_lock = threading.Lock()
        self._commands = queue.Queue()
        self._command_ids = set()
        self._acknowledgements = queue.Queue()
        self._stop = threading.Event()
        self._thread = None

    def start(self):
        self._thread = threading.Thread(
            target=self._run,
            name="exacth2o-native-cloud",
        )
        self._thread.daemon = True
        self._thread.start()

    def publish_state(self, state, revision, sync_requested):
        # Replace the previous snapshot instead of queueing every 250 ms. If
        # the network is slow, memory and Qt's event queue remain bounded.
        with self._state_lock:
            self._state = state
            self._revision = revision
            self._sync_requested = self._sync_requested or sync_requested
            self._state_sequence += 1

    def acknowledge(self, payload):
        self._acknowledgements.put(payload)

    def drain_commands(self):
        commands = []
        while len(commands) < 10:
            try:
                commands.append(self._commands.get_nowait())
            except queue.Empty:
                break
        return commands

    def stop(self):
        self._stop.set()
        if self._thread is not None:
            self._thread.join(2.0)

    def _state_snapshot(self):
        with self._state_lock:
            return (
                self._state,
                self._revision,
                self._sync_requested,
                self._state_sequence,
            )

    def _mark_state_sent(self, sequence, state_hash):
        with self._state_lock:
            self._last_state_hash = state_hash
            if self._state_sequence == sequence:
                self._sync_requested = False

    def _send_acknowledgements(self):
        while True:
            try:
                payload = self._acknowledgements.get_nowait()
            except queue.Empty:
                return
            try:
                _post_json(
                    self._endpoint,
                    self._token,
                    dict({"action": "ack"}, **payload)
                )
            except Exception:
                # Keep the acknowledgement durable in memory for the next
                # network attempt instead of blocking or crashing the GUI.
                self._acknowledgements.put(payload)
                raise

    def _tick(self):
        state, revision, sync_requested, sequence = self._state_snapshot()
        now = time.monotonic()
        if state is not None and now - self._last_heartbeat >= 10:
            _post_json(self._endpoint, self._token, {
                "action": "heartbeat",
                "bridge_ready": True,
                "bridge_version": BRIDGE_VERSION,
            })
            self._last_heartbeat = now
        if state is not None:
            encoded = json.dumps(
                state,
                sort_keys=True,
                separators=(",", ":")
            ).encode("utf-8")
            state_hash = hashlib.sha256(encoded).hexdigest()
            if state_hash != self._last_state_hash or sync_requested:
                _post_json(self._endpoint, self._token, {
                    "action": "state",
                    "state_revision": revision,
                    "applied_state": state,
                    "observed_state": state,
                    "sync_requested": sync_requested,
                })
                self._mark_state_sent(sequence, state_hash)
        self._send_acknowledgements()
        poll = _post_json(self._endpoint, self._token, {"action": "poll"})
        for command in poll.get("commands", []):
            command_id = command.get("id")
            if command_id and command_id not in self._command_ids:
                self._command_ids.add(command_id)
                self._commands.put(command)

    def _run(self):
        while not self._stop.is_set():
            try:
                if not self._endpoint:
                    self._endpoint, self._token = _native_endpoint()
                self._tick()
            except (
                urllib.error.URLError,
                urllib.error.HTTPError,
                OSError,
                RuntimeError,
                ValueError,
            ) as error:
                print("Native bridge cloud error: {}".format(error))
            except Exception as error:
                # A bridge defect must take the bridge offline, never the
                # scientific instrument UI. Keep retrying and leave the Qt
                # main thread and mixer model untouched.
                print("Native bridge unexpected error: {}".format(error))
            self._stop.wait(0.25)


class NativeBridge(QObject):
    def __init__(self, model, mfcs, parent=None):
        super().__init__(parent)
        self._model = model
        self._mfcs = dict(zip([item["address"] for item in mfc_config], mfcs))
        # Millisecond wall time keeps the optimistic-concurrency revision
        # monotonic across supervised process and Pi restarts.
        self._revision = int(time.time() * 1000)
        self._last_control_hash = None
        self._applying_cloud_command = False
        self._command_results = {}
        self._worker = NativeCloudWorker()
        self._worker.start()
        if parent is not None and hasattr(parent, "aboutToQuit"):
            parent.aboutToQuit.connect(self.shutdown)

        self._command_timer = QTimer(self)
        self._command_timer.setInterval(250)
        self._command_timer.timeout.connect(self.drain_commands)
        self._command_timer.start()

        self._snapshot_timer = QTimer(self)
        self._snapshot_timer.setInterval(250)
        self._snapshot_timer.timeout.connect(self.publish_snapshot)
        self._snapshot_timer.start()
        self.publish_snapshot()

    def _channel_snapshot(self, configured, mfc):
        return {
            "address": configured["address"],
            "formula": configured["formula"],
            "balance": configured["balance"],
            "ratio_unit": configured["ratio_unit"],
            "flow_unit": configured["flow_unit"],
            "ratio": float(mfc.ratio),
            "setpoint": float(mfc.setpoint),
            "delivered": float(mfc.delivered),
            "available": bool(mfc.address),
            "flow_error": int(mfc.flow_error) >= err_thresh,
        }

    def snapshot(self):
        channels = {}
        for configured in mfc_config:
            address = configured["address"]
            channels[address] = self._channel_snapshot(configured, self._mfcs[address])
        return {
            "use_licor": bool(self._model.use_licor),
            "total_slpm": float(self._model.total_slpm),
            "channels": channels,
        }

    @Slot()
    def publish_snapshot(self):
        state = self.snapshot()
        control_state = {
            "use_licor": state["use_licor"],
            "total_slpm": state["total_slpm"],
            "channels": {
                address: {
                    "ratio": channel["ratio"],
                    "setpoint": channel["setpoint"],
                }
                for address, channel in state["channels"].items()
            },
        }
        control_hash = hashlib.sha256(
            json.dumps(control_state, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        first_snapshot = self._last_control_hash is None
        changed = not first_snapshot and control_hash != self._last_control_hash
        sync_requested = first_snapshot or (changed and not self._applying_cloud_command)
        if changed:
            self._revision += 1
        self._last_control_hash = control_hash
        self._worker.publish_state(state, self._revision, sync_requested)

    @Slot()
    def drain_commands(self):
        commands = self._worker.drain_commands()
        if commands:
            self.apply_commands(commands)

    @Slot()
    def shutdown(self):
        self._snapshot_timer.stop()
        self._command_timer.stop()
        self._worker.stop()

    def _set_channel_ratio(self, mfc, value):
        mfc.set_ratio(value)
        if mfc.ratio_unit == "PPM":
            setpoint = value * self._model.total_slpm / 1000000
        else:
            setpoint = value * self._model.total_slpm / 100
        if mfc.flow_unit == "SCCM":
            setpoint *= 1000
        mfc.set_setpoint(setpoint)
        mfc.set_modified(True)

    def _set_channel_setpoint(self, mfc, value):
        slpm = value / 1000 if mfc.flow_unit == "SCCM" else value
        if slpm > self._model.total_slpm and not math.isclose(slpm, self._model.total_slpm):
            raise RuntimeError("Setpoint exceeds total flow")
        mfc.set_setpoint(value)
        mfc.set_modified(True)

    @Slot(list)
    def apply_commands(self, commands):
        for command in commands:
            command_id = command.get("id")
            if command_id in self._command_results:
                self._worker.acknowledge(self._command_results[command_id])
                continue
            try:
                if int(command.get("expected_revision")) != self._revision:
                    raise RuntimeError("Mixer state revision changed")
                payload = command.get("payload") or {}
                field = payload.get("field")
                value = payload.get("value")
                self._worker.acknowledge({"command_id": command_id, "status": "accepted"})
                self._applying_cloud_command = True
                if field == "use_licor" and isinstance(value, bool):
                    self._model.set_use_licor(value)
                elif field == "total_slpm" and isinstance(value, (int, float)):
                    self._model.set_total_slpm(float(value))
                elif isinstance(field, str) and field.startswith("mfc.") and isinstance(value, (int, float)):
                    _, address, property_name = field.split(".")
                    mfc = self._mfcs.get(address)
                    if mfc is None or not mfc.address or mfc.balance:
                        raise RuntimeError("MFC {} is not available for native control".format(address))
                    if property_name == "ratio":
                        self._set_channel_ratio(mfc, float(value))
                    elif property_name == "setpoint":
                        self._set_channel_setpoint(mfc, float(value))
                    else:
                        raise RuntimeError("Unsupported native mixer field")
                else:
                    raise RuntimeError("Unsupported native mixer field")
                self.publish_snapshot()
                result = {"command_id": command_id, "status": "verified"}
                self._command_results[command_id] = result
                self._worker.acknowledge(result)
            except Exception as error:
                result = {
                    "command_id": command_id,
                    "status": "rejected",
                    "error": str(error)[:240],
                }
                self._command_results[command_id] = result
                self._worker.acknowledge(result)
            finally:
                self._applying_cloud_command = False
