#!/usr/bin/env python3
"""Outbound-only ExactH2O bridge for the existing Walker Pi mixer UI.

This process does not import or modify the mixer application. It captures the
existing X11 screen and accepts only short-lived normalized pointer taps.
"""

import base64
import ctypes
import ctypes.util
import fcntl
import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request


AGENT_VERSION = "exacth2o-gas-mixer-agent/1.0.0"
WIDTH = 800
HEIGHT = 480
CONFIG_PATH = os.path.expanduser(
    "~/.config/exacth2o-gas-mixer-agent/config.json"
)
LOCK_PATH = "/tmp/exacth2o-gas-mixer-agent.lock"
FRAME_INTERVAL_SECONDS = 1.25
POLL_INTERVAL_SECONDS = 0.50
HEARTBEAT_INTERVAL_SECONDS = 10.0


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


def post_json(endpoint, token, payload):
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        endpoint,
        data=body,
        headers={
            "Content-Type": "application/json",
            "User-Agent": AGENT_VERSION,
            "X-Device-Token": token,
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        response_body = response.read()
        if response.status < 200 or response.status >= 300:
            raise RuntimeError("agent endpoint returned {}".format(response.status))
    return json.loads(response_body.decode("utf-8"))


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
        tap_available = True
        tap_error = ""
    except (OSError, RuntimeError) as error:
        tapper = None
        tap_available = False
        tap_error = str(error)
        log("tap backend unavailable: {}".format(tap_error))

    last_frame_hash = None
    last_heartbeat = 0.0
    last_frame = 0.0
    next_poll = 0.0
    consecutive_errors = 0
    log("agent starting; existing mixer process remains untouched")

    while True:
        now = time.monotonic()
        mixer_ready = mixer_is_running() and graphical_console_is_active()
        local_session_available = mixer_ready and tap_available
        try:
            if now - last_heartbeat >= HEARTBEAT_INTERVAL_SECONDS:
                post_json(
                    endpoint,
                    token,
                    {
                        "action": "heartbeat",
                        "agent_version": AGENT_VERSION,
                        "capture_backend": "x11-ffmpeg+xtest",
                        "local_session_available": local_session_available,
                        "width": WIDTH,
                        "height": HEIGHT,
                    },
                )
                last_heartbeat = now

            if mixer_ready and now - last_frame >= FRAME_INTERVAL_SECONDS:
                frame = capture_png()
                frame_hash = hashlib.sha256(frame).hexdigest()
                if frame_hash != last_frame_hash:
                    post_json(
                        endpoint,
                        token,
                        {
                            "action": "frame",
                            "png_base64": base64.b64encode(frame).decode("ascii"),
                        },
                    )
                    last_frame_hash = frame_hash
                last_frame = now

            if now >= next_poll:
                poll = post_json(endpoint, token, {"action": "poll"})
                commands = poll.get("commands", [])
                for command in commands:
                    command_id = command.get("id")
                    try:
                        if not local_session_available or tapper is None:
                            raise RuntimeError(
                                "local graphical mixer session is not available"
                            )
                        if command.get("event_type") != "tap":
                            raise RuntimeError("unsupported command type")
                        tapper.tap(
                            float(command.get("normalized_x")),
                            float(command.get("normalized_y")),
                        )
                        post_json(
                            endpoint,
                            token,
                            {
                                "action": "ack",
                                "command_ids": [command_id],
                                "status": "executed",
                            },
                        )
                    except Exception as error:
                        post_json(
                            endpoint,
                            token,
                            {
                                "action": "ack",
                                "command_ids": [command_id],
                                "status": "failed",
                                "error": str(error)[:240],
                            },
                        )
                next_poll = now + POLL_INTERVAL_SECONDS

            if consecutive_errors:
                log("cloud connection restored")
            consecutive_errors = 0
            time.sleep(0.10)
        except (urllib.error.URLError, urllib.error.HTTPError, OSError,
                RuntimeError, ValueError, subprocess.TimeoutExpired) as error:
            consecutive_errors += 1
            if consecutive_errors == 1 or consecutive_errors % 10 == 0:
                log("agent loop error: {}".format(error))
            time.sleep(min(15.0, 1.0 + consecutive_errors))


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
