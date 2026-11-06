#!/usr/bin/env python3
"""Structured ExactH2O bridge for the existing pi-mfc-gui Qt model.

This module runs inside the existing mixer process. It never opens the Alicat
serial port; all commands are applied to the same PiMfcGuiModel already used by
the physical touchscreen, so there cannot be a second hardware controller.

2.2.0 (staged, not yet installed): one held "sync" request carries the
heartbeat, the newest state and pending acknowledgements and waits for
commands, over a reused HTTPS connection. A local control change interrupts
the hold so the portal sees it at once. The Qt side, command validation and
acknowledgement semantics are unchanged from 2.1.2.
"""

import collections
import hashlib
from datetime import datetime
import http.client
import json
import logging
from logging.handlers import RotatingFileHandler
import math
import os
import random
import socket
import ssl
import threading
import time
from urllib.parse import urlparse

from PySide2.QtCore import QObject, QTimer, Slot

from config import err_thresh, mfc_config


BRIDGE_VERSION = "exacth2o-gas-mixer-native-bridge/2.2.0"
CONFIG_PATH = os.path.expanduser("~/.config/exacth2o-gas-mixer-agent/config.json")
# The server answers a held sync inside hold_ms, which it keeps 5 s below this.
REQUEST_TIMEOUT_SECONDS = 40
DEFAULT_HOLD_MS = 25000
MAX_RETRY_SECONDS = 30
# Wait this long for the Qt thread to acknowledge just-delivered commands, so
# their receipts ride on the next sync instead of interrupting a new hold.
ACK_SETTLE_SECONDS = 1.5
MAX_PENDING_ACKS = 256
MAX_ACKS_PER_SYNC = 20
MAX_REMEMBERED_COMMANDS = 512


class QuietRotatingFileHandler(RotatingFileHandler):
    def handleError(self, record):
        # The legacy mixer redirects stderr into its instrument display too.
        # Even a full/unwritable log disk must not flood or break that display.
        pass


def _cloud_logger():
    logger = logging.getLogger("exacth2o.native-cloud")
    if not logger.handlers:
        logger.propagate = False
        logger.setLevel(logging.INFO)
        try:
            directory = os.path.expanduser(
                "~/.local/state/exacth2o-gas-mixer-native-bridge"
            )
            os.makedirs(directory, mode=0o700, exist_ok=True)
            handler = QuietRotatingFileHandler(
                os.path.join(directory, "cloud.log"),
                maxBytes=262144,
                backupCount=2,
                encoding="utf-8",
            )
            handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        except OSError:
            handler = logging.NullHandler()
        logger.addHandler(handler)
    return logger


def _native_endpoint():
    with open(CONFIG_PATH, "r") as handle:
        value = json.load(handle)
    endpoint = value.get("endpoint", "")
    token = value.get("device_token", "")
    if not endpoint.startswith("https://") or len(token) < 32:
        raise RuntimeError("existing gas mixer agent configuration is invalid")
    return endpoint.rsplit("/", 1)[0] + "/gas-mixer-native-agent", token


class CloudError(Exception):
    def __init__(self, status):
        super().__init__("native bridge endpoint returned {}".format(status))
        self.status = status


class Interrupted(Exception):
    """A local change cut a held sync short; resend at once, not a failure."""


class NativeCloudWorker(object):
    """Network worker isolated from Qt's object and thread machinery.

    Only the newest state snapshot is kept, commands return through the same
    bounded main-thread timer drain as 2.1.2, and every queue is bounded.
    """

    def __init__(self):
        self._endpoint = None
        self._token = None
        self._state = None
        self._revision = 0
        self._sync_requested = False
        self._state_sequence = 0
        self._state_lock = threading.Lock()
        self._sent_revision = None
        self._sent_state_hash = None
        self._last_state_sent = 0.0
        self._state_interval = DEFAULT_HOLD_MS / 1000.0
        self._next_hold_ms = DEFAULT_HOLD_MS
        self._commands = collections.deque()
        self._commands_lock = threading.Lock()
        self._remembered = collections.OrderedDict()
        self._acks = collections.deque()
        self._acks_lock = threading.Lock()
        self._ack_arrived = threading.Event()
        self._interrupt = threading.Event()
        self._holding = False
        self._connection = None
        self._stop = threading.Event()
        self._thread = None
        self._logger = _cloud_logger()
        self._request_started_at = None

    # ----- Qt-thread API (same shape as 2.1.2) -----
    def start(self):
        self._thread = threading.Thread(target=self._run, name="exacth2o-native-cloud")
        self._thread.daemon = True
        self._thread.start()

    def publish_state(self, state, revision, sync_requested):
        with self._state_lock:
            control_changed = revision != self._revision
            self._state = state
            self._revision = revision
            self._sync_requested = self._sync_requested or sync_requested
            self._state_sequence += 1
        # Observed-only changes ride on the next sync; a control change or a
        # local edit should reach the portal (and its revision checks) now.
        if control_changed or sync_requested:
            self.interrupt()

    def acknowledge(self, payload):
        with self._acks_lock:
            self._acks.append(dict(payload))
            while len(self._acks) > MAX_PENDING_ACKS:
                # Never silently claim success: a dropped receipt leaves the
                # command visibly unconfirmed in the portal.
                self._acks.popleft()
        self._ack_arrived.set()
        # A receipt should not wait out a held sync.
        self.interrupt()

    def drain_commands(self):
        commands = []
        with self._commands_lock:
            while self._commands and len(commands) < 10:
                commands.append(self._commands.popleft())
        return commands

    def stop(self):
        self._stop.set()
        self.interrupt()
        if self._thread is not None:
            self._thread.join(2.0)

    def interrupt(self):
        self._interrupt.set()
        connection = self._connection
        if self._holding and connection is not None and connection.sock is not None:
            try:
                connection.sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    # ----- network thread -----
    def _post(self, payload, holding):
        url = urlparse(self._endpoint)
        if self._connection is None:
            if url.scheme == "https":
                self._connection = http.client.HTTPSConnection(
                    url.hostname, url.port or 443, timeout=REQUEST_TIMEOUT_SECONDS,
                    context=ssl.create_default_context())
            else:
                # Only the local test harness uses plain HTTP.
                self._connection = http.client.HTTPConnection(
                    url.hostname, url.port or 80, timeout=REQUEST_TIMEOUT_SECONDS)
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self._request_started_at = time.monotonic()
        self._holding = holding
        try:
            if holding and self._interrupt.is_set():
                raise Interrupted()
            self._connection.request("POST", url.path, body=body, headers={
                "Content-Type": "application/json",
                "User-Agent": BRIDGE_VERSION,
                "X-Device-Token": self._token,
                "Connection": "keep-alive",
            })
            response = self._connection.getresponse()
            value = response.read()
        except Exception:
            self._close_connection()
            if holding and self._interrupt.is_set():
                raise Interrupted()
            raise
        finally:
            self._holding = False
        if response.status < 200 or response.status >= 300:
            self._close_connection()
            raise CloudError(response.status)
        return json.loads(value.decode("utf-8"))

    def _close_connection(self):
        connection, self._connection = self._connection, None
        if connection is not None:
            try:
                connection.close()
            except OSError:
                pass

    def _remember(self, command_id):
        self._remembered[command_id] = True
        self._remembered.move_to_end(command_id)
        while len(self._remembered) > MAX_REMEMBERED_COMMANDS:
            self._remembered.popitem(last=False)

    def _tick(self):
        with self._state_lock:
            state = self._state
            revision = self._revision
            sync_requested = self._sync_requested
            sequence = self._state_sequence
        if state is None:
            return
        self._interrupt.clear()
        now = time.monotonic()
        encoded = json.dumps(state, sort_keys=True, separators=(",", ":")).encode("utf-8")
        state_hash = hashlib.sha256(encoded).hexdigest()
        send_state = (sync_requested or revision != self._sent_revision or
                      (state_hash != self._sent_state_hash and now - self._last_state_sent >= self._state_interval))
        with self._acks_lock:
            acks = list(self._acks)[:MAX_ACKS_PER_SYNC]
            more_acks = len(self._acks) > len(acks)
        payload = {
            "action": "sync",
            "protocol": 2,
            "bridge_version": BRIDGE_VERSION,
            "bridge_ready": True,
            "client_timeout_ms": REQUEST_TIMEOUT_SECONDS * 1000,
            "hold_ms": 0 if more_acks else self._next_hold_ms,
        }
        if send_state:
            payload["state"] = {
                "state_revision": revision,
                "applied_state": state,
                "observed_state": state,
                "sync_requested": sync_requested,
            }
        if acks:
            payload["acks"] = acks
        response = self._post(payload, holding=payload["hold_ms"] > 0)

        if send_state:
            with self._state_lock:
                if self._state_sequence == sequence:
                    self._sync_requested = False
            self._sent_revision = revision
            self._sent_state_hash = state_hash
            self._last_state_sent = now
        recorded = set()
        for result in response.get("acks") or []:
            if result.get("recorded") and not result.get("retry"):
                recorded.add(result.get("command_id"))
        if acks:
            with self._acks_lock:
                sent = len(acks)
                kept = [ack for ack in acks if ack.get("command_id") not in recorded]
                remainder = list(self._acks)[sent:]
                self._acks.clear()
                self._acks.extend(kept + remainder)
        advice = response.get("next") or {}
        try:
            self._next_hold_ms = max(0, min(DEFAULT_HOLD_MS, int(advice.get("hold_ms", DEFAULT_HOLD_MS))))
            self._state_interval = max(1.0, min(60.0, float(advice.get("state_interval_ms", 25000)) / 1000.0))
        except (TypeError, ValueError):
            pass

        delivered = set()
        for command in response.get("commands") or []:
            command_id = command.get("id")
            if not command_id or command_id in self._remembered:
                continue
            with self._commands_lock:
                if len(self._commands) >= 64:
                    # Still queued in the cloud: it comes back on the next sync.
                    break
                self._commands.append(command)
            self._remember(command_id)
            delivered.add(command_id)
        if delivered:
            # Let the Qt drain (every 250 ms) record terminal receipts before
            # the next sync, so they ride on it instead of interrupting a hold.
            deadline = time.monotonic() + ACK_SETTLE_SECONDS
            while time.monotonic() < deadline and not self._stop.is_set():
                with self._acks_lock:
                    finished = {ack.get("command_id") for ack in self._acks
                                if ack.get("status") in ("applied", "verified", "rejected", "failed")}
                if delivered <= finished:
                    break
                self._ack_arrived.wait(min(0.1, max(0.0, deadline - time.monotonic())))
                self._ack_arrived.clear()

    def _run(self):
        failures = 0
        last_error_log = None
        while not self._stop.is_set():
            delay = 0.0
            try:
                if not self._endpoint:
                    self._endpoint, self._token = _native_endpoint()
                self._tick()
                if failures:
                    self._logger.info("Cloud connection recovered after %d failed attempts", failures)
                failures = 0
                last_error_log = None
                if self._state is None:
                    delay = 0.25
            except Interrupted:
                delay = 0.0
            except Exception as error:
                failures += 1
                delay = min(MAX_RETRY_SECONDS, (2 ** min(failures, 5)) * random.uniform(0.8, 1.2))
                now = time.monotonic()
                if last_error_log is None or now - last_error_log >= 60:
                    # Do not log payloads, tokens, response bodies, or exception
                    # text; preserve useful transport evidence outside the GUI.
                    self._logger.warning(
                        "Cloud request failed action=sync error=%s http_status=%s "
                        "elapsed=%.2fs failures=%d retry=%.1fs",
                        type(error).__name__,
                        error.status if isinstance(error, CloudError) else "-",
                        now - self._request_started_at if self._request_started_at is not None else 0,
                        failures,
                        delay,
                    )
                    last_error_log = now
            if delay:
                self._stop.wait(delay)
        self._close_connection()


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
        self._command_results = collections.OrderedDict()
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

    def _remember_result(self, command_id, result):
        self._command_results[command_id] = result
        while len(self._command_results) > MAX_REMEMBERED_COMMANDS:
            self._command_results.popitem(last=False)

    @Slot(list)
    def apply_commands(self, commands):
        for command in commands:
            command_id = command.get("id")
            if command_id in self._command_results:
                self._worker.acknowledge(self._command_results[command_id])
                continue
            try:
                expires_at = datetime.fromisoformat(command["expires_at"].replace("Z", "+00:00"))
                if expires_at.tzinfo is None or expires_at.timestamp() <= time.time():
                    raise RuntimeError("Mixer command expired before delivery")
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
                # Model application is not proof of instrument delivery.
                result = {"command_id": command_id, "status": "applied"}
                self._remember_result(command_id, result)
                self._worker.acknowledge(result)
            except Exception as error:
                result = {
                    "command_id": command_id,
                    "status": "rejected",
                    "error": str(error)[:240],
                }
                self._remember_result(command_id, result)
                self._worker.acknowledge(result)
            finally:
                self._applying_cloud_command = False
