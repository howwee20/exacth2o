#!/usr/bin/env python3
"""Outbound-only ExactH2O bridge for the existing Walker Pi mixer UI.

This process does not import or modify the mixer application. It captures the
existing X11 screen and accepts only short-lived normalized pointer taps.

1.1.0 (staged, not yet installed): one held "sync" request is the heartbeat,
the tap poll, tap receipts and, only while a portal session is open, the
newest changed frame. Nothing is captured or uploaded while nobody watches.
"""

import base64
import collections
import ctypes
import ctypes.util
import fcntl
import hashlib
import http.client
import json
import os
import ssl
import subprocess
import sys
import time
from urllib.parse import urlparse


AGENT_VERSION = "exacth2o-gas-mixer-agent/1.1.0"
WIDTH = 800
HEIGHT = 480
CONFIG_PATH = os.path.expanduser(
    "~/.config/exacth2o-gas-mixer-agent/config.json"
)
LOCK_PATH = "/tmp/exacth2o-gas-mixer-agent.lock"
# The server answers a held sync inside hold_ms, which it keeps 5 s below this.
REQUEST_TIMEOUT_SECONDS = 40
IDLE_HOLD_MS = 25000
SESSION_HOLD_MS = 1000
FRAME_INTERVAL_SECONDS = 1.25
MAX_PENDING_ACKS = 40
# Taps expire 10 s after the portal queues them; remembering executed ids for
# a minute guarantees a re-delivered tap (lost receipt) is never replayed.
EXECUTED_MEMORY_SECONDS = 60


def log(message):
    print("{} {}".format(time.strftime("%Y-%m-%dT%H:%M:%S%z"), message))
    sys.stdout.flush()


def load_config():
    with open(CONFIG_PATH, "r") as handle:
        value = json.load(handle)
    endpoint = value.get("endpoint", "")
    token = value.get("device_token", "")
    if not endpoint.startswith("https://") or len(token) < 32:
        raise RuntimeError("agent configuration is invalid")
    return endpoint, token


class CloudClient(object):
    """One reused HTTPS connection; reopened after any failure."""

    def __init__(self, endpoint, token):
        self._url = urlparse(endpoint)
        self._token = token
        self._connection = None

    def post(self, payload):
        if self._connection is None:
            if self._url.scheme == "https":
                self._connection = http.client.HTTPSConnection(
                    self._url.hostname, self._url.port or 443,
                    timeout=REQUEST_TIMEOUT_SECONDS, context=ssl.create_default_context())
            else:
                # Only the local test harness uses plain HTTP.
                self._connection = http.client.HTTPConnection(
                    self._url.hostname, self._url.port or 80, timeout=REQUEST_TIMEOUT_SECONDS)
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        try:
            self._connection.request("POST", self._url.path, body=body, headers={
                "Content-Type": "application/json",
                "User-Agent": AGENT_VERSION,
                "X-Device-Token": self._token,
                "Connection": "keep-alive",
            })
            response = self._connection.getresponse()
            value = response.read()
        except Exception:
            self.close()
            raise
        if response.status < 200 or response.status >= 300:
            self.close()
            raise RuntimeError("agent endpoint returned {}".format(response.status))
        return json.loads(value.decode("utf-8"))

    def close(self):
        connection, self._connection = self._connection, None
        if connection is not None:
            try:
                connection.close()
            except OSError:
                pass


def mixer_is_running():
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open("/proc/{}/cmdline".format(entry), "rb") as handle:
                command = handle.read().replace(b"\0", b" ")
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
        if b"pi-mfc-gui.py" in command:
            return True
    return False


def graphical_console_is_active():
    try:
        with open("/sys/class/tty/tty0/active", "r") as handle:
            return handle.read().strip() == "tty7"
    except (FileNotFoundError, PermissionError):
        # On systems without this kernel indicator, the active mixer process
        # and successful X11 capture remain the availability checks.
        return True


class X11Tapper:
    def __init__(self):
        x11_name = ctypes.util.find_library("X11") or "libX11.so.6"
        xtst_name = ctypes.util.find_library("Xtst") or "libXtst.so.6"
        self.x11 = ctypes.CDLL(x11_name)
        self.xtst = ctypes.CDLL(xtst_name)

        self.x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
        self.x11.XOpenDisplay.restype = ctypes.c_void_p
        self.x11.XDefaultScreen.argtypes = [ctypes.c_void_p]
        self.x11.XDefaultScreen.restype = ctypes.c_int
        self.x11.XFlush.argtypes = [ctypes.c_void_p]
        self.x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
        self.xtst.XTestFakeMotionEvent.argtypes = [
            ctypes.c_void_p,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_ulong,
        ]
        self.xtst.XTestFakeButtonEvent.argtypes = [
            ctypes.c_void_p,
            ctypes.c_uint,
            ctypes.c_int,
            ctypes.c_ulong,
        ]

    def tap(self, normalized_x, normalized_y):
        x = int(round(max(0.0, min(1.0, normalized_x)) * (WIDTH - 1)))
        y = int(round(max(0.0, min(1.0, normalized_y)) * (HEIGHT - 1)))
        display_name = os.environ.get("DISPLAY", ":0").encode("utf-8")
        display = self.x11.XOpenDisplay(display_name)
        if not display:
            raise RuntimeError("unable to open the local X11 display")
        try:
            screen = self.x11.XDefaultScreen(display)
            if not self.xtst.XTestFakeMotionEvent(display, screen, x, y, 0):
                raise RuntimeError("X11 pointer motion was rejected")
            if not self.xtst.XTestFakeButtonEvent(display, 1, 1, 0):
                raise RuntimeError("X11 pointer press was rejected")
            if not self.xtst.XTestFakeButtonEvent(display, 1, 0, 35):
                raise RuntimeError("X11 pointer release was rejected")
            self.x11.XFlush(display)
        finally:
            self.x11.XCloseDisplay(display)


def capture_png():
    command = [
        "/usr/bin/ffmpeg",
        "-nostdin",
        "-loglevel",
        "error",
        "-f",
        "x11grab",
        "-video_size",
        "{}x{}".format(WIDTH, HEIGHT),
        "-i",
        os.environ.get("DISPLAY", ":0"),
        "-frames:v",
        "1",
        "-vf",
        "format=rgb24",
        "-f",
        "image2pipe",
        "-vcodec",
        "png",
        "pipe:1",
    ]
    completed = subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=15,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(
            "screen capture failed: {}".format(
                completed.stderr.decode("utf-8", "replace")[-240:]
            )
        )
    if not completed.stdout.startswith(b"\x89PNG\r\n\x1a\n"):
        raise RuntimeError("screen capture did not produce PNG data")
    if len(completed.stdout) > 524288:
        raise RuntimeError("captured frame exceeded the 512 KiB safety limit")
    return completed.stdout


class Agent(object):
    def __init__(self, cloud, tapper, tap_error=""):
        self.cloud = cloud
        self.tapper = tapper
        self.tap_error = tap_error
        self.attended = False
        self.hold_ms = IDLE_HOLD_MS
        self.frame_interval = FRAME_INTERVAL_SECONDS
        self.last_frame_hash = None
        self.last_frame = float("-inf")
        self.acks = []
        self.executed = collections.OrderedDict()

    def step(self, now=None):
        now = time.monotonic() if now is None else now
        mixer_ready = mixer_is_running() and graphical_console_is_active()
        local_session_available = mixer_ready and self.tapper is not None
        payload = {
            "action": "sync",
            "protocol": 2,
            "agent_version": AGENT_VERSION,
            "capture_backend": "x11-ffmpeg+xtest",
            "local_session_available": local_session_available,
            "width": WIDTH,
            "height": HEIGHT,
            "client_timeout_ms": REQUEST_TIMEOUT_SECONDS * 1000,
            "hold_ms": SESSION_HOLD_MS if self.attended else self.hold_ms,
        }
        # Frames only while a portal session is open; none while unattended.
        if self.attended and mixer_ready and now - self.last_frame >= self.frame_interval:
            frame = capture_png()
            self.last_frame = now
            frame_hash = hashlib.sha256(frame).hexdigest()
            if frame_hash != self.last_frame_hash:
                payload["frame_png_base64"] = base64.b64encode(frame).decode("ascii")
                pending_hash = frame_hash
            else:
                pending_hash = None
        else:
            pending_hash = None
        if self.acks:
            payload["acks"] = self.acks[:20]
        response = self.cloud.post(payload)
        if pending_hash is not None:
            self.last_frame_hash = pending_hash
        sent = payload.get("acks", [])
        recorded = [result.get("recorded") is True and not result.get("retry")
                    for result in (response.get("acks") or [])]
        kept = [ack for index, ack in enumerate(sent) if not (index < len(recorded) and recorded[index])]
        self.acks = kept + self.acks[len(sent):]
        for command_id, executed_at in list(self.executed.items()):
            if now - executed_at > EXECUTED_MEMORY_SECONDS:
                del self.executed[command_id]

        was_attended = self.attended
        self.attended = response.get("attended") is True
        advice = response.get("next") or {}
        try:
            self.hold_ms = max(0, min(IDLE_HOLD_MS, int(advice.get("hold_ms") or IDLE_HOLD_MS)))
            interval = advice.get("frame_interval_ms")
            if interval:
                self.frame_interval = max(0.5, min(10.0, float(interval) / 1000.0))
        except (TypeError, ValueError):
            pass
        if self.attended and not was_attended:
            # A viewer just arrived: send a fresh frame on the next sync.
            self.last_frame = float("-inf")
            self.last_frame_hash = None

        for command in response.get("commands") or []:
            command_id = command.get("id")
            if command_id in self.executed:
                # Already tapped; only its receipt was lost. Never tap twice.
                if not any(command_id in ack.get("command_ids", []) for ack in self.acks):
                    self.acks.append({"command_ids": [command_id], "status": "executed"})
                continue
            try:
                if not local_session_available or self.tapper is None:
                    raise RuntimeError(self.tap_error or "local graphical mixer session is not available")
                if command.get("event_type") != "tap":
                    raise RuntimeError("unsupported command type")
                self.executed[command_id] = now
                self.tapper.tap(float(command.get("normalized_x")), float(command.get("normalized_y")))
                self.acks.append({"command_ids": [command_id], "status": "executed"})
                # Show the operator's result without waiting for the cadence.
                self.last_frame = float("-inf")
            except Exception as error:
                self.acks.append({"command_ids": [command_id], "status": "failed", "error": str(error)[:240]})
        if len(self.acks) > MAX_PENDING_ACKS:
            self.acks = self.acks[-MAX_PENDING_ACKS:]


def main():
    os.environ.setdefault("DISPLAY", ":0")
    os.environ.setdefault("XAUTHORITY", "/home/alarm/.Xauthority")

    lock_handle = open(LOCK_PATH, "w")
    try:
        fcntl.flock(lock_handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        log("another agent process is already active")
        return 0

    endpoint, token = load_config()
    try:
        tapper = X11Tapper()
        tap_error = ""
    except (OSError, RuntimeError) as error:
        tapper = None
        tap_error = str(error)
        log("tap backend unavailable: {}".format(tap_error))

    agent = Agent(CloudClient(endpoint, token), tapper, tap_error)
    consecutive_errors = 0
    log("agent starting; existing mixer process remains untouched")
    while True:
        try:
            agent.step()
            if consecutive_errors:
                log("cloud connection restored")
            consecutive_errors = 0
        except Exception as error:
            consecutive_errors += 1
            if consecutive_errors == 1 or consecutive_errors % 10 == 0:
                log("agent loop error: {}".format(error))
            time.sleep(min(15.0, 1.0 + consecutive_errors))


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
