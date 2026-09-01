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
import time
import urllib.error
import urllib.request

from PySide2.QtCore import QObject, QThread, QTimer, Signal, Slot

from config import err_thresh, mfc_config


BRIDGE_VERSION = "exacth2o-gas-mixer-native-bridge/2.0.0"
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


class NativeCloudWorker(QObject):
    commands_ready = Signal(list)

    def __init__(self):
        super().__init__()
        self._endpoint = None
        self._token = None
        self._timer = None
        self._last_heartbeat = 0.0
        self._last_state_hash = None
        self._state = None
        self._revision = 0
        self._sync_requested = False
        self._busy = False

    @Slot()
    def start(self):
        self._endpoint, self._token = _native_endpoint()
        self._timer = QTimer(self)
        self._timer.setInterval(250)
        self._timer.timeout.connect(self.tick)
        self._timer.start()
        self.tick()

    @Slot(dict, object, bool)
    def publish_state(self, state, revision, sync_requested):
        self._state = state
        self._revision = revision
        self._sync_requested = self._sync_requested or sync_requested

    @Slot(dict)
    def acknowledge(self, payload):
        try:
            _post_json(self._endpoint, self._token, dict({"action": "ack"}, **payload))
        except Exception as error:
            print("Native bridge acknowledgement failed: {}".format(error))

    @Slot()
    def tick(self):
        if self._busy or not self._endpoint:
            return
        self._busy = True
        try:
            now = time.monotonic()
            if self._state is not None and now - self._last_heartbeat >= 10:
                _post_json(self._endpoint, self._token, {
                    "action": "heartbeat",
                    "bridge_ready": True,
                    "bridge_version": BRIDGE_VERSION,
                })
                self._last_heartbeat = now
            if self._state is not None:
                encoded = json.dumps(self._state, sort_keys=True, separators=(",", ":")).encode("utf-8")
                state_hash = hashlib.sha256(encoded).hexdigest()
                if state_hash != self._last_state_hash or self._sync_requested:
                    _post_json(self._endpoint, self._token, {
                        "action": "state",
                        "state_revision": self._revision,
                        "applied_state": self._state,
                        "observed_state": self._state,
                        "sync_requested": self._sync_requested,
                    })
                    self._last_state_hash = state_hash
                    self._sync_requested = False
            poll = _post_json(self._endpoint, self._token, {"action": "poll"})
            commands = poll.get("commands", [])
            if commands:
                self.commands_ready.emit(commands)
        except (urllib.error.URLError, urllib.error.HTTPError, OSError, RuntimeError, ValueError) as error:
            print("Native bridge cloud error: {}".format(error))
        finally:
            self._busy = False


class NativeBridge(QObject):
    # Epoch-millisecond revisions exceed Qt's signed 32-bit `int`. Carry the
    # Python integer as an object so PySide does not raise OverflowError before
    # the state reaches the cloud worker.
    state_ready = Signal(dict, object, bool)
    ack_ready = Signal(dict)

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
        self._thread = QThread(parent)
        self._worker = NativeCloudWorker()
        self._worker.moveToThread(self._thread)
        self._thread.started.connect(self._worker.start)
        self._worker.commands_ready.connect(self.apply_commands)
        self.state_ready.connect(self._worker.publish_state)
        self.ack_ready.connect(self._worker.acknowledge)
        if parent is not None and hasattr(parent, "aboutToQuit"):
            parent.aboutToQuit.connect(self.shutdown)

        self._snapshot_timer = QTimer(self)
        self._snapshot_timer.setInterval(250)
        self._snapshot_timer.timeout.connect(self.publish_snapshot)
        self._snapshot_timer.start()
        self._thread.start()
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
        self.state_ready.emit(state, self._revision, sync_requested)

    @Slot()
    def shutdown(self):
        self._thread.quit()
        self._thread.wait(2000)

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
                self.ack_ready.emit(self._command_results[command_id])
                continue
            try:
                if int(command.get("expected_revision")) != self._revision:
                    raise RuntimeError("Mixer state revision changed")
                payload = command.get("payload") or {}
                field = payload.get("field")
                value = payload.get("value")
                self.ack_ready.emit({"command_id": command_id, "status": "accepted"})
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
                self.ack_ready.emit(result)
            except Exception as error:
                result = {
                    "command_id": command_id,
                    "status": "rejected",
                    "error": str(error)[:240],
                }
                self._command_results[command_id] = result
                self.ack_ready.emit(result)
            finally:
                self._applying_cloud_command = False
