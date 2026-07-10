#!/usr/bin/env python3
import base64
import hashlib
import hmac
import json
import os
import platform
import shlex
import socket
import ssl
import subprocess
import shutil
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"

DEFAULT_API_BASE = "http://35.8.86.10:8888"
DEFAULT_PUBLIC_URL = "https://3100e37ee3205651fe3dd86dafd4dc0c.balena-devices.com"
API_BASE = os.environ.get("PI_API_BASE", DEFAULT_API_BASE).rstrip("/")
PUBLIC_URL = os.environ.get("PI_PUBLIC_URL", DEFAULT_PUBLIC_URL).rstrip("/")
HEALTH_SIDECAR_URL = os.environ.get("PI_HEALTH_SIDECAR_URL", "http://35.8.86.10:8788").rstrip("/")
API_HTTP_TIMEOUT = float(os.environ.get("PI_API_HTTP_TIMEOUT", "1.5"))
HOST_SSH_TARGET = os.environ.get("PI_HOST_SSH_TARGET", "root@35.8.86.10")
HOST_SSH_PORT = os.environ.get("PI_HOST_SSH_PORT", "22222")
DEVICE_API_BASE = os.environ.get("PI_DEVICE_API_BASE", "http://127.0.0.1:8888").rstrip("/")
DEVICE_ID = os.environ.get("PI_BALENA_DEVICE_ID", "3100e37ee3205651fe3dd86dafd4dc0c")
DEVICE_SSH_TARGET = os.environ.get("PI_BALENA_SSH_TARGET", "basyalbi@ssh.balena-devices.com")
DEVICE_SSH_FALLBACK = os.environ.get("PI_DEVICE_SSH_FALLBACK", "1") != "0"
DEVICE_SSH_CONNECT_TIMEOUT = int(os.environ.get("PI_DEVICE_SSH_CONNECT_TIMEOUT", "12"))
DEVICE_API_SSH_TIMEOUT = int(os.environ.get("PI_DEVICE_API_SSH_TIMEOUT", "18"))
DEVICE_API_SSH_RETRY_TIMEOUT = int(os.environ.get("PI_DEVICE_API_SSH_RETRY_TIMEOUT", "18"))
REMOTE_HOST_HEALTH_ENABLED = os.environ.get("PI_REMOTE_HOST_HEALTH_ENABLED", "1") != "0"
SCHEDULER_HEALTH_ENABLED = os.environ.get("PI_SCHEDULER_HEALTH_ENABLED", "1") != "0"
READINGS_PAGE_SIZE = int(os.environ.get("PI_READINGS_PAGE_SIZE", "500"))
WATERING_LOG_LIMIT = max(1, min(1000, int(os.environ.get("PI_WATERING_LOG_LIMIT", "1000"))))
WATERING_LOOKBACK_DAYS = max(1, int(os.environ.get("PI_WATERING_LOOKBACK_DAYS", "21")))
EXPECTED_BOARDS = [
    item.strip().lower()
    for item in os.environ.get("PI_EXPECTED_BOARDS", "0x20,0x24,0x26").split(",")
    if item.strip()
]
PI_ETH_DEVICE = os.environ.get("PI_ETH_DEVICE", "eth0")
HOST_SYS = Path(os.environ.get("PI_HOST_SYS", "/sys"))
HOST_PROC = Path(os.environ.get("PI_HOST_PROC", "/proc"))
CONTROLLER_IPV4 = os.environ.get("PI_CONTROLLER_IPV4", "")
BALENA_ENGINE_SOCKET = Path(os.environ.get("BALENA_ENGINE_SOCKET", "/var/run/balena-engine.sock"))
SCHEDULER_HEALTH_SOURCE = os.environ.get("PI_SCHEDULER_HEALTH_SOURCE", "auto").lower()
REDIS_HOST = os.environ.get("PI_REDIS_HOST", "127.0.0.1")
REDIS_PORT = int(os.environ.get("PI_REDIS_PORT", "6379"))
REDIS_TIMEOUT = float(os.environ.get("PI_REDIS_TIMEOUT", "2"))
PI_ETHERNET_STATUS_FILE = Path(
    os.environ.get("PI_ETHERNET_STATUS_FILE", str(ROOT / "pi_ethernet_status.json"))
)
I2C_BUS = os.environ.get("PI_I2C_BUS", "1")
EXPECTED_SERVICES = [
    item.strip()
    for item in os.environ.get(
        "PI_EXPECTED_SERVICES",
        "api_svc,ui_svc,cron_svc,database_svc,redis_svc",
    ).split(",")
    if item.strip()
]
API_RESPONSE_CACHE = {}
CONFIG_SNAPSHOT_CACHE = {"at": 0.0, "value": None}
CONFIG_SNAPSHOT_LOCK = threading.Lock()
ALERT_STATE_LOCK = threading.Lock()
HISTORY_LOCK = threading.Lock()
SAMPLER_STOP = threading.Event()
SAMPLER_RUNNING = False

DASHBOARD_USERNAME = os.environ.get("DASHBOARD_USERNAME", "")
DASHBOARD_PASSWORD = os.environ.get("DASHBOARD_PASSWORD", "")
DASHBOARD_AUTH_DISABLED = os.environ.get("DASHBOARD_AUTH_DISABLED", "0") == "1"
DASHBOARD_REALM = os.environ.get("DASHBOARD_REALM", "ExactH2O Health")
DASHBOARD_SESSION_SECRET = os.environ.get(
    "DASHBOARD_SESSION_SECRET",
    DASHBOARD_PASSWORD or "replace-this-session-secret",
)
DASHBOARD_SESSION_COOKIE = os.environ.get("DASHBOARD_SESSION_COOKIE", "exacth2o_health_session")
DASHBOARD_SESSION_TTL_SECONDS = int(os.environ.get("DASHBOARD_SESSION_TTL_SECONDS", "604800"))
DASHBOARD_COOKIE_SECURE = os.environ.get("DASHBOARD_COOKIE_SECURE", "0") == "1"
PUBLIC_BASE_PATH = os.environ.get("PUBLIC_BASE_PATH", "").rstrip("/")
HEALTHCHECK_TOKEN = os.environ.get("HEALTHCHECK_TOKEN", "")

OWNER_ALERT_NTFY_TOPIC = os.environ.get("OWNER_ALERT_NTFY_TOPIC", "")
OWNER_ALERT_NTFY_URL = os.environ.get("OWNER_ALERT_NTFY_URL", "https://ntfy.sh").rstrip("/")
OWNER_ALERT_WEBHOOK_URL = os.environ.get("OWNER_ALERT_WEBHOOK_URL", "")
OWNER_ALERT_COOLDOWN_SECONDS = int(os.environ.get("OWNER_ALERT_COOLDOWN_SECONDS", "300"))
OWNER_ALERT_LEVELS = {
    item.strip().lower()
    for item in os.environ.get("OWNER_ALERT_LEVELS", "critical").split(",")
    if item.strip()
}
OWNER_ALERT_STATE_FILE = Path(
    os.environ.get("OWNER_ALERT_STATE_FILE", str(ROOT / "owner-alert-state.json"))
)
OWNER_ALERTS_ENABLED = (
    os.environ.get("OWNER_ALERTS_ENABLED", "1") != "0"
    and bool(OWNER_ALERT_NTFY_TOPIC or OWNER_ALERT_WEBHOOK_URL)
)
HISTORY_FILE = Path(os.environ.get("HEALTH_HISTORY_FILE", str(ROOT / "health-history.jsonl")))
HISTORY_RETENTION_DAYS = int(os.environ.get("HEALTH_HISTORY_RETENTION_DAYS", "21"))
HISTORY_SAMPLE_INTERVAL_SECONDS = int(os.environ.get("HEALTH_HISTORY_SAMPLE_INTERVAL_SECONDS", "300"))
HISTORY_MAX_LINES = int(os.environ.get("HEALTH_HISTORY_MAX_LINES", "50000"))
HISTORY_LAST_WRITE = 0

RESEARCHER_MAP = [
    (41, "Zone2-Pot41", "D30GQN2D:p", "0x24:41", "standard"),
    (42, "Zone2-Pot42", "D30GQN2D:q", "0x24:42", "standard"),
    (43, "Zone2-Pot43", "D30GQN2D:r", "0x24:43", "standard"),
    (44, "Zone2-Pot44", "D30GQN2D:s", "0x24:44", "standard"),
    (45, "Zone2-Pot45", "D30GQN2D:o", "0x24:45", "replacement o"),
    (46, "Zone2-Pot46", "D30GQN2D:u", "0x24:46", "standard"),
    (47, "Zone2-Pot47", "D30GQN2D:v", "0x24:47", "standard"),
    (48, "Zone2-Pot48", "D30GQN2D:w", "0x24:48", "standard"),
    (49, "Zone2-Pot49", "D30GQN2D:x", "0x20:1", "standard"),
    (50, "Zone2-Pot50", "D30GQN2D:2", "0x20:2", "standard"),
    (91, "Zone4-Pot91", "D30GQN2E:p", "0x20:44", "standard"),
    (92, "Zone4-Pot92", "D30GQN2E:q", "0x20:45", "standard"),
    (93, "Zone4-Pot93", "D30GQN2E:r", "0x20:46", "standard"),
    (94, "Zone4-Pot94", "D30GQN2E:s", "0x20:47", "standard"),
    (95, "Zone4-Pot95", "D30GQN2E:o", "0x20:48", "replacement o"),
    (96, "Zone4-Pot96", "D30GQN2E:u", "0x20:39", "piped from row 86"),
    (97, "Zone4-Pot97", "D30GQN2E:v", "0x20:40", "piped from row 87"),
    (98, "Zone4-Pot98", "D30GQN2E:w", "0x20:41", "piped from row 88"),
    (99, "Zone4-Pot99", "D30GQN2E:x", "0x20:42", "piped from row 89"),
    (100, "Zone4-Pot100", "D30GQN2E:2", "0x20:43", "piped from row 90"),
]


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def auth_is_enabled():
    return (
        not DASHBOARD_AUTH_DISABLED
        and bool(DASHBOARD_USERNAME)
        and bool(DASHBOARD_PASSWORD)
    )


def check_basic_auth(header):
    if not auth_is_enabled():
        return True
    if not header or not header.lower().startswith("basic "):
        return False
    token = header.split(" ", 1)[1].strip()
    try:
        decoded = base64.b64decode(token).decode("utf-8")
    except Exception:
        return False
    username, sep, password = decoded.partition(":")
    if not sep:
        return False
    return hmac.compare_digest(username, DASHBOARD_USERNAME) and hmac.compare_digest(
        password,
        DASHBOARD_PASSWORD,
    )


def session_signature(username, issued_at):
    payload = f"{username}:{issued_at}".encode("utf-8")
    return hmac.new(
        DASHBOARD_SESSION_SECRET.encode("utf-8"),
        payload,
        hashlib.sha256,
    ).hexdigest()


def create_session_token(username):
    issued_at = str(int(time.time()))
    signature = session_signature(username, issued_at)
    return base64.urlsafe_b64encode(f"{username}:{issued_at}:{signature}".encode("utf-8")).decode("ascii")


def verify_session_token(token):
    if not token:
        return False
    try:
        decoded = base64.urlsafe_b64decode(token.encode("ascii")).decode("utf-8")
    except Exception:
        return False
    username, issued_at, signature = (decoded.split(":", 2) + ["", "", ""])[:3]
    if username != DASHBOARD_USERNAME:
        return False
    try:
        age = int(time.time()) - int(issued_at)
    except Exception:
        return False
    if age < 0 or age > DASHBOARD_SESSION_TTL_SECONDS:
        return False
    expected = session_signature(username, issued_at)
    return hmac.compare_digest(signature, expected)


def parse_cookies(header):
    cookies = {}
    for part in (header or "").split(";"):
        if "=" not in part:
            continue
        key, value = part.strip().split("=", 1)
        cookies[key] = value
    return cookies


def public_path(path):
    if not path.startswith("/"):
        path = f"/{path}"
    return f"{PUBLIC_BASE_PATH}{path}" if PUBLIC_BASE_PATH else path


def internal_path(path):
    if PUBLIC_BASE_PATH and path == PUBLIC_BASE_PATH:
        return "/"
    if PUBLIC_BASE_PATH and path.startswith(f"{PUBLIC_BASE_PATH}/"):
        stripped = path[len(PUBLIC_BASE_PATH):]
        return stripped or "/"
    return path


def login_page(error=""):
    error_html = (
        f'<div class="error">{error}</div>'
        if error
        else ""
    )
    return f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ExactH2O Login</title>
    <style>
      * {{ box-sizing: border-box; }}
      body {{
        margin: 0;
        min-height: 100vh;
        background: #f6f8fb;
        color: #111827;
        font: 15px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        display: grid;
        place-items: center;
        padding: 24px;
      }}
      .card {{
        width: min(100%, 420px);
        background: #fff;
        border: 1px solid #dde3ea;
        border-radius: 8px;
        box-shadow: 0 18px 60px rgba(15, 23, 42, 0.08);
        padding: 28px;
      }}
      .brand {{ color: #64748b; font-size: 12px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }}
      h1 {{ margin: 6px 0 18px; font-size: 28px; line-height: 1.15; letter-spacing: 0; }}
      label {{ display: block; color: #334155; font-weight: 700; margin: 14px 0 6px; }}
      input {{
        width: 100%;
        height: 44px;
        border: 1px solid #cbd5e1;
        border-radius: 8px;
        padding: 0 12px;
        font: inherit;
      }}
      input:focus {{ outline: 3px solid rgba(37, 99, 235, .16); border-color: #2563eb; }}
      button {{
        width: 100%;
        height: 44px;
        margin-top: 18px;
        border: 0;
        border-radius: 8px;
        color: #fff;
        background: #0f172a;
        font-weight: 800;
        cursor: pointer;
      }}
      .error {{
        border: 1px solid #fecdd3;
        background: #fff1f2;
        color: #be123c;
        border-radius: 8px;
        padding: 10px 12px;
        margin: 12px 0;
        font-weight: 700;
      }}
    </style>
  </head>
  <body>
    <form class="card" method="post" action="{public_path('/login')}">
      <div class="brand">ExactH2O</div>
      <h1>System Health</h1>
      {error_html}
      <label for="username">Email or username</label>
      <input id="username" name="username" autocomplete="username" required />
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required />
      <button type="submit">Sign in</button>
    </form>
  </body>
</html>"""


def check_bearer_token(header, query):
    if not HEALTHCHECK_TOKEN:
        return True
    expected = HEALTHCHECK_TOKEN
    candidate = ""
    if header and header.lower().startswith("bearer "):
        candidate = header.split(" ", 1)[1].strip()
    if not candidate:
        candidate = query.get("token", [""])[0]
    return hmac.compare_digest(candidate, expected)


def run_cmd(args, timeout=3):
    try:
        completed = subprocess.run(
            args,
            timeout=timeout,
            capture_output=True,
            text=True,
            check=False,
        )
        return {
            "ok": completed.returncode == 0,
            "returncode": completed.returncode,
            "stdout": completed.stdout.strip(),
            "stderr": completed.stderr.strip(),
        }
    except Exception as exc:
        return {"ok": False, "error": str(exc), "stdout": "", "stderr": ""}


def run_cmd_input(args, input_text, timeout=20):
    try:
        completed = subprocess.run(
            args,
            input=input_text,
            timeout=timeout,
            capture_output=True,
            text=True,
            check=False,
        )
        return {
            "ok": completed.returncode == 0,
            "returncode": completed.returncode,
            "stdout": completed.stdout.strip(),
            "stderr": completed.stderr.strip(),
        }
    except Exception as exc:
        return {"ok": False, "error": str(exc), "stdout": "", "stderr": ""}


def command_path(name):
    return shutil.which(name)


def read_text(path):
    try:
        return Path(path).read_text().strip()
    except Exception:
        return None


def confirmed_pi_ethernet_health():
    try:
        data = json.loads(PI_ETHERNET_STATUS_FILE.read_text())
    except Exception:
        return {"available": False, "ok": None, "source": None}

    carrier = str(data.get("carrier", "")).strip()
    ipv4 = str(data.get("ipv4", "")).strip()
    default_routes = data.get("defaultRoutes") or []
    eth_default = any(" dev eth0" in route for route in default_routes)
    ok = carrier == "1" and bool(ipv4) and eth_default
    return {
        "available": True,
        "ok": ok,
        "source": data.get("source"),
        "confirmedAt": data.get("confirmedAt"),
        "device": data.get("device", "eth0"),
        "carrier": carrier,
        "ipv4": ipv4,
        "route": data.get("route"),
        "defaultRoutes": default_routes,
        "networkManager": data.get("networkManager") or [],
        "notes": data.get("notes", ""),
    }


def fetch_json(url, timeout=4):
    started = time.time()
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            body = response.read().decode("utf-8")
            elapsed_ms = round((time.time() - started) * 1000)
            return {
                "ok": 200 <= response.status < 300,
                "status": response.status,
                "elapsedMs": elapsed_ms,
                "data": json.loads(body) if body else None,
            }
    except urllib.error.HTTPError as exc:
        return {
            "ok": False,
            "status": exc.code,
            "elapsedMs": round((time.time() - started) * 1000),
            "error": exc.read().decode("utf-8", errors="replace")[:500],
        }
    except Exception as exc:
        return {
            "ok": False,
            "elapsedMs": round((time.time() - started) * 1000),
            "error": str(exc),
        }


def fetch_json_post(url, payload, timeout=4):
    started = time.time()
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            response_body = response.read().decode("utf-8")
            elapsed_ms = round((time.time() - started) * 1000)
            return {
                "ok": 200 <= response.status < 300,
                "status": response.status,
                "elapsedMs": elapsed_ms,
                "data": json.loads(response_body) if response_body else None,
            }
    except urllib.error.HTTPError as exc:
        return {
            "ok": False,
            "status": exc.code,
            "elapsedMs": round((time.time() - started) * 1000),
            "error": exc.read().decode("utf-8", errors="replace")[:500],
        }
    except Exception as exc:
        return {
            "ok": False,
            "elapsedMs": round((time.time() - started) * 1000),
            "error": str(exc),
        }


def balena_ssh_args():
    return [
        command_path("ssh") or "ssh",
        "-T",
        "-p",
        "22",
        "-o",
        "LogLevel=ERROR",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        f"ConnectTimeout={DEVICE_SSH_CONNECT_TIMEOUT}",
        DEVICE_SSH_TARGET,
        "host",
        DEVICE_ID,
    ]


def parse_device_api_bundle(output, elapsed_ms):
    parsed = {}
    marker = "__PI_HEALTH_BEGIN__"
    status_marker = "__PI_HEALTH_STATUS__"
    for block in output.split(marker)[1:]:
        if "\n" not in block:
            continue
        name, rest = block.split("\n", 1)
        name = name.strip()
        if status_marker not in rest:
            parsed[name] = {
                "ok": False,
                "elapsedMs": elapsed_ms,
                "error": "device SSH response did not include HTTP status",
                "source": "device-ssh",
            }
            continue
        body, status_text = rest.rsplit(status_marker, 1)
        status_token = status_text.strip().splitlines()[0] if status_text.strip() else "000"
        try:
            status = int(status_token)
        except Exception:
            status = None
        body = body.strip()
        if status is None or not 200 <= status < 300:
            parsed[name] = {
                "ok": False,
                "status": status,
                "elapsedMs": elapsed_ms,
                "error": body[:500] or f"HTTP {status_token}",
                "source": "device-ssh",
            }
            continue
        try:
            data = json.loads(body) if body else None
        except Exception as exc:
            parsed[name] = {
                "ok": False,
                "status": status,
                "elapsedMs": elapsed_ms,
                "error": f"Could not parse device JSON: {exc}",
                "source": "device-ssh",
            }
            continue
        parsed[name] = {
            "ok": True,
            "status": status,
            "elapsedMs": elapsed_ms,
            "data": data,
            "source": "device-ssh",
        }
    return parsed


def fetch_device_api_bundle(paths, timeout=None, curl_timeout=None):
    timeout = timeout or DEVICE_API_SSH_TIMEOUT
    if not DEVICE_SSH_FALLBACK:
        return {
            name: {
                "ok": False,
                "elapsedMs": 0,
                "error": "device SSH fallback disabled",
                "source": "device-ssh",
            }
            for name in paths
        }
    if not command_path("ssh"):
        return {
            name: {
                "ok": False,
                "elapsedMs": 0,
                "error": "ssh command not found",
                "source": "device-ssh",
            }
            for name in paths
        }

    script_lines = ["set +e"]
    per_request_timeout = curl_timeout or int(max(3, API_HTTP_TIMEOUT + 3))
    for name, path in paths.items():
        url = f"{DEVICE_API_BASE}{path}"
        script_lines.extend(
            [
                f'printf "\\n__PI_HEALTH_BEGIN__{shlex.quote(name)}\\n"',
                f'curl -sS -m {int(per_request_timeout)} -w "\\n__PI_HEALTH_STATUS__%{{http_code}}\\n" {shlex.quote(url)}',
            ]
        )
    script_lines.append("exit")
    script = "\n".join(script_lines) + "\n"

    started = time.time()
    result = run_cmd_input(balena_ssh_args(), script, timeout=timeout)
    elapsed_ms = round((time.time() - started) * 1000)
    parsed = parse_device_api_bundle(result.get("stdout", ""), elapsed_ms)
    out = {}
    for name in paths:
        item = parsed.get(name)
        if item:
            out[name] = item
        else:
            out[name] = {
                "ok": False,
                "elapsedMs": elapsed_ms,
                "error": result.get("error") or result.get("stderr") or "No device API response",
                "source": "device-ssh",
            }
    return out


def fetch_api_bundle(paths):
    with ThreadPoolExecutor(max_workers=len(paths)) as executor:
        futures = {
            name: executor.submit(fetch_json, f"{API_BASE}{path}", API_HTTP_TIMEOUT)
            for name, path in paths.items()
        }
        direct = {name: future.result() for name, future in futures.items()}

    if direct.get("health", {}).get("ok"):
        for item in direct.values():
            item["source"] = "direct-api"
        remember_api_responses(direct)
        return direct, "direct-api", None

    device = fetch_device_api_bundle(paths)
    if device.get("health", {}).get("ok"):
        missing = {name: path for name, path in paths.items() if not device.get(name, {}).get("ok")}
        if missing:
            retry = fetch_device_api_bundle(missing, timeout=DEVICE_API_SSH_RETRY_TIMEOUT)
            for name, response in retry.items():
                if response.get("ok"):
                    device[name] = response
        remember_api_responses(device)
        apply_cached_api_responses(device)
        return device, "device-ssh", direct

    apply_cached_api_responses(direct)
    return direct, "direct-api-failed", direct


def remember_api_responses(responses):
    for name, response in responses.items():
        if response.get("ok"):
            API_RESPONSE_CACHE[name] = dict(response)


def apply_cached_api_responses(responses):
    for name, response in list(responses.items()):
        if response.get("ok"):
            continue
        cached = API_RESPONSE_CACHE.get(name)
        if cached:
            replacement = dict(cached)
            replacement["cached"] = True
            responses[name] = replacement


def fetch_head(url, timeout=4):
    started = time.time()
    req = urllib.request.Request(url, method="HEAD")
    try:
        context = ssl.create_default_context()
        with urllib.request.urlopen(req, timeout=timeout, context=context) as response:
            return {
                "ok": 200 <= response.status < 400,
                "status": response.status,
                "elapsedMs": round((time.time() - started) * 1000),
            }
    except urllib.error.HTTPError as exc:
        return {
            "ok": False,
            "status": exc.code,
            "elapsedMs": round((time.time() - started) * 1000),
            "error": str(exc),
        }
    except Exception as exc:
        return {
            "ok": False,
            "elapsedMs": round((time.time() - started) * 1000),
            "error": str(exc),
        }


def decode_chunked_body(body):
    output = bytearray()
    index = 0
    while index < len(body):
        line_end = body.find(b"\r\n", index)
        if line_end == -1:
            break
        size_text = body[index:line_end].split(b";", 1)[0].strip()
        try:
            size = int(size_text, 16)
        except Exception:
            break
        index = line_end + 2
        if size == 0:
            break
        output.extend(body[index:index + size])
        index += size + 2
    return bytes(output)


def fetch_unix_json(socket_path, path, timeout=4):
    started = time.time()
    if not Path(socket_path).exists():
        return {"ok": False, "elapsedMs": 0, "error": f"{socket_path} not found"}
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(timeout)
    try:
        client.connect(str(socket_path))
        request = (
            f"GET {path} HTTP/1.1\r\n"
            "Host: balena-engine\r\n"
            "Accept: application/json\r\n"
            "Connection: close\r\n\r\n"
        ).encode("utf-8")
        client.sendall(request)
        chunks = []
        while True:
            chunk = client.recv(65536)
            if not chunk:
                break
            chunks.append(chunk)
    except Exception as exc:
        return {"ok": False, "elapsedMs": round((time.time() - started) * 1000), "error": str(exc)}
    finally:
        try:
            client.close()
        except Exception:
            pass

    raw = b"".join(chunks)
    header_bytes, sep, body = raw.partition(b"\r\n\r\n")
    if not sep:
        return {"ok": False, "elapsedMs": round((time.time() - started) * 1000), "error": "invalid socket HTTP response"}
    header_text = header_bytes.decode("iso-8859-1", errors="replace")
    status_line = header_text.splitlines()[0] if header_text.splitlines() else ""
    try:
        status = int(status_line.split()[1])
    except Exception:
        status = 0
    headers = header_text.lower()
    if "transfer-encoding: chunked" in headers:
        body = decode_chunked_body(body)
    try:
        data = json.loads(body.decode("utf-8")) if body else None
    except Exception as exc:
        return {
            "ok": False,
            "status": status,
            "elapsedMs": round((time.time() - started) * 1000),
            "error": f"could not parse socket JSON: {exc}",
        }
    return {
        "ok": 200 <= status < 300,
        "status": status,
        "elapsedMs": round((time.time() - started) * 1000),
        "data": data,
    }


def read_alert_state():
    try:
        return json.loads(OWNER_ALERT_STATE_FILE.read_text())
    except Exception:
        return {}


def write_alert_state(state):
    try:
        OWNER_ALERT_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        OWNER_ALERT_STATE_FILE.write_text(json.dumps(state, indent=2) + "\n")
    except Exception:
        pass


def owner_alert_text(health, recovered=False):
    overall = health.get("overall") or {}
    if recovered:
        return "Greenhouse controller health recovered."
    lines = [f"{overall.get('title', 'Health alert')} ({overall.get('level', 'unknown')})"]
    for issue in (overall.get("issues") or [])[:5]:
        lines.append(f"- {issue}")
    for warning in (overall.get("warnings") or [])[:3]:
        lines.append(f"- {warning}")
    env = health.get("environment") or {}
    public_url = env.get("publicUrl")
    if public_url:
        lines.append(f"Dashboard: {public_url}{public_path('/')}")
    return "\n".join(lines)


def post_owner_webhook(title, message, level):
    if not OWNER_ALERT_WEBHOOK_URL:
        return
    payload = {
        "title": title,
        "message": message,
        "level": level,
        "timestamp": utc_now(),
        "source": "pi-health-dashboard",
    }
    req = urllib.request.Request(
        OWNER_ALERT_WEBHOOK_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=8) as response:
        response.read()


def post_owner_ntfy(title, message, level):
    if not OWNER_ALERT_NTFY_TOPIC:
        return
    priority = "urgent" if level == "critical" else "high"
    url = f"{OWNER_ALERT_NTFY_URL}/{OWNER_ALERT_NTFY_TOPIC}"
    req = urllib.request.Request(
        url,
        data=message.encode("utf-8"),
        headers={
            "Title": title,
            "Priority": priority,
            "Tags": "warning",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=8) as response:
        response.read()


def send_owner_alert(title, message, level):
    errors = []
    for sender in (post_owner_ntfy, post_owner_webhook):
        try:
            sender(title, message, level)
        except Exception as exc:
            errors.append(str(exc))
    return errors


def alert_fingerprint(health):
    overall = health.get("overall") or {}
    parts = [overall.get("level", "unknown")]
    parts.extend(overall.get("issues") or [])
    if overall.get("level") == "warning":
        parts.extend(overall.get("warnings") or [])
    return "\n".join(parts)


def maybe_send_owner_alert(health):
    if not OWNER_ALERTS_ENABLED:
        return

    overall = health.get("overall") or {}
    level = overall.get("level", "unknown")
    now = int(time.time())
    fingerprint = alert_fingerprint(health)

    with ALERT_STATE_LOCK:
        state = read_alert_state()
        previous_level = state.get("level")
        previous_fingerprint = state.get("fingerprint")
        last_sent_at = int(state.get("lastSentAt") or 0)
        should_alert = level in OWNER_ALERT_LEVELS and (
            fingerprint != previous_fingerprint
            or now - last_sent_at >= OWNER_ALERT_COOLDOWN_SECONDS
        )
        should_recover = level == "ok" and previous_level in OWNER_ALERT_LEVELS

        if should_alert:
            title = f"plain-feather {overall.get('title', 'health alert')}"
            errors = send_owner_alert(title, owner_alert_text(health), level)
            state.update(
                {
                    "level": level,
                    "fingerprint": fingerprint,
                    "lastSentAt": now,
                    "lastAlertAt": utc_now(),
                    "lastErrors": errors,
                }
            )
            write_alert_state(state)
            return

        if should_recover:
            errors = send_owner_alert(
                "plain-feather recovered",
                owner_alert_text(health, recovered=True),
                "ok",
            )
            state.update(
                {
                    "level": level,
                    "fingerprint": fingerprint,
                    "lastRecoveredAt": utc_now(),
                    "lastErrors": errors,
                }
            )
            write_alert_state(state)
            return

        state.update({"level": level, "fingerprint": fingerprint, "lastCheckedAt": utc_now()})
        write_alert_state(state)


def parse_ifconfig(device):
    raw = run_cmd(["/sbin/ifconfig", device])
    text = raw.get("stdout", "")
    return {
        "device": device,
        "exists": bool(text),
        "status": find_value(text, "status:") or "unknown",
        "media": find_value(text, "media:") or "unknown",
        "inet": find_inet(text),
        "raw": text,
    }


def find_value(text, marker):
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith(marker):
            return stripped.split(marker, 1)[1].strip()
    return None


def find_inet(text):
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("inet "):
            return stripped.split()[1]
    return None


def route_default():
    raw = run_cmd(["/sbin/route", "get", "default"])
    route = {"interface": None, "gateway": None, "raw": raw.get("stdout", "")}
    for line in route["raw"].splitlines():
        stripped = line.strip()
        if stripped.startswith("interface:"):
            route["interface"] = stripped.split(":", 1)[1].strip()
        if stripped.startswith("gateway:"):
            route["gateway"] = stripped.split(":", 1)[1].strip()
    return route


def parse_linux_ipv4(text):
    for line in text.splitlines():
        parts = line.split()
        if "inet" in parts:
            index = parts.index("inet")
            if index + 1 < len(parts):
                return parts[index + 1].split("/", 1)[0]
    return None


def parse_linux_gateway(text):
    for line in text.splitlines():
        parts = line.split()
        if len(parts) >= 3 and parts[0] == "default" and parts[1] == "via":
            return parts[2]
    return None


def parse_proc_default_gateway(device):
    raw = read_text(HOST_PROC / "net/route")
    if not raw:
        return None
    for line in raw.splitlines()[1:]:
        parts = line.split()
        if len(parts) < 3 or parts[0] != device or parts[1] != "00000000":
            continue
        try:
            gateway_hex = parts[2]
            octets = [str(int(gateway_hex[index:index + 2], 16)) for index in range(0, 8, 2)]
            return ".".join(reversed(octets))
        except Exception:
            return None
    return None


def ping_host(host):
    ping = command_path("ping")
    if not ping:
        return {"available": False, "ok": False, "error": "ping command not found"}
    result = run_cmd([ping, "-c", "1", "-W", "1", host], timeout=3)
    return {"available": True, **result}


def parse_key_value_lines(text):
    values = {}
    for line in text.splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def parse_float(value):
    try:
        return float(value)
    except Exception:
        return None


def parse_int(value):
    try:
        return int(float(str(value)))
    except Exception:
        return None


THROTTLED_BITS = [
    ("undervoltageCurrent", 0, "Undervoltage now"),
    ("armFrequencyCappedCurrent", 1, "ARM frequency capped now"),
    ("throttledCurrent", 2, "CPU throttled now"),
    ("softTempLimitCurrent", 3, "Soft temperature limit now"),
    ("undervoltageOccurred", 16, "Undervoltage since boot"),
    ("armFrequencyCappedOccurred", 17, "ARM frequency capping since boot"),
    ("throttledOccurred", 18, "CPU throttling since boot"),
    ("softTempLimitOccurred", 19, "Soft temperature limit since boot"),
]


def parse_throttled_flags(raw_value):
    text = str(raw_value or "").strip().lower()
    if not text:
        return {
            "raw": raw_value,
            "available": False,
            "flags": [],
        }
    if text.startswith("throttled="):
        text = text.split("=", 1)[1].strip()
    try:
        value = int(text, 16) if text.startswith("0x") else int(text)
    except Exception:
        return {
            "raw": raw_value,
            "available": False,
            "flags": [],
            "error": "could not parse throttled bitmask",
        }
    flags = [label for _, bit, label in THROTTLED_BITS if value & (1 << bit)]
    parsed = {
        "raw": raw_value,
        "available": True,
        "value": value,
        "flags": flags,
    }
    for key, bit, _label in THROTTLED_BITS:
        parsed[key] = bool(value & (1 << bit))
    return parsed


def undervoltage_state(undervoltage_alarm, throttled):
    parsed = parse_throttled_flags(throttled)
    current = undervoltage_alarm == "1" or bool(parsed.get("undervoltageCurrent"))
    occurred = bool(parsed.get("undervoltageOccurred"))
    return {
        "current": current,
        "occurred": occurred,
        "any": current or occurred,
        "rawAlarm": undervoltage_alarm,
        "throttled": parsed,
    }


def remote_pi_host_health():
    if not REMOTE_HOST_HEALTH_ENABLED:
        return {
            "available": False,
            "source": "balena-host-ssh",
            "error": "remote host health check disabled",
        }
    script = f"""
set +e
device={shlex.quote(PI_ETH_DEVICE)}
printf 'remoteCheckedAt=%s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'hostname=%s\\n' "$(hostname 2>/dev/null)"
printf 'uptimeSeconds=%s\\n' "$(cut -d' ' -f1 /proc/uptime 2>/dev/null)"
printf 'loadAverage=%s\\n' "$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)"
printf 'ethDevice=%s\\n' "$device"
printf 'ethMac=%s\\n' "$(cat /sys/class/net/$device/address 2>/dev/null)"
printf 'ethCarrier=%s\\n' "$(cat /sys/class/net/$device/carrier 2>/dev/null)"
printf 'ethOperstate=%s\\n' "$(cat /sys/class/net/$device/operstate 2>/dev/null)"
printf 'ethSpeed=%s\\n' "$(cat /sys/class/net/$device/speed 2>/dev/null)"
printf 'ethDuplex=%s\\n' "$(cat /sys/class/net/$device/duplex 2>/dev/null)"
printf 'ethIpv4=%s\\n' "$(ip -o -4 addr show dev $device 2>/dev/null | awk '{{print $4}}' | head -1)"
printf 'ethGateway=%s\\n' "$(ip route show default dev $device 2>/dev/null | awk '/default/ {{print $3; exit}}')"
gw="$(ip route show default dev $device 2>/dev/null | awk '/default/ {{print $3; exit}}')"
if [ -n "$gw" ]; then
  ping_ms="$(ping -c 1 -W 1 "$gw" 2>/dev/null | awk -F'time=' '/time=/{{print $2}}' | awk '{{print $1; exit}}')"
  printf 'gatewayPingMs=%s\\n' "$ping_ms"
else
  printf 'gatewayPingMs=\\n'
fi
printf 'cpuTempC=%s\\n' "$(awk '{{printf "%.1f", $1/1000}}' /sys/class/thermal/thermal_zone0/temp 2>/dev/null)"
if command -v vcgencmd >/dev/null 2>&1; then
  printf 'throttled=%s\\n' "$(vcgencmd get_throttled 2>/dev/null | cut -d= -f2)"
else
  printf 'throttled=\\n'
fi
uv=""
for name in /sys/class/hwmon/*/name; do
  [ -e "$name" ] || continue
  dir="$(dirname "$name")"
  if [ "$(cat "$name" 2>/dev/null)" = "rpi_volt" ]; then
    uv="$(cat "$dir/in0_lcrit_alarm" 2>/dev/null)"
  fi
done
printf 'undervoltageAlarm=%s\\n' "$uv"
df -P / 2>/dev/null | awk 'NR==2 {{gsub("%","",$5); print "diskUsedPercent="$5}}'
awk '/MemTotal:/{{t=$2}} /MemAvailable:/{{a=$2}} END{{if(t>0) printf "memoryUsedPercent=%.1f\\n", ((t-a)/t)*100}}' /proc/meminfo 2>/dev/null
"""
    started = time.time()
    result = run_cmd_input(balena_ssh_args(), script, timeout=DEVICE_SSH_CONNECT_TIMEOUT + 12)
    elapsed_ms = round((time.time() - started) * 1000)
    if not result.get("ok"):
        return {
            "available": False,
            "source": "balena-host-ssh",
            "elapsedMs": elapsed_ms,
            "error": result.get("error") or result.get("stderr") or "Host SSH failed",
        }

    raw = parse_key_value_lines(result.get("stdout", ""))
    gateway_ping_ms = parse_float(raw.get("gatewayPingMs"))
    carrier = raw.get("ethCarrier")
    operstate = raw.get("ethOperstate")
    ipv4 = raw.get("ethIpv4")
    throttled = raw.get("throttled") or ""
    undervoltage_alarm = raw.get("undervoltageAlarm")
    undervoltage = undervoltage_state(undervoltage_alarm, throttled)

    return {
        "available": True,
        "source": "balena-host-ssh",
        "elapsedMs": elapsed_ms,
        "checkedAt": raw.get("remoteCheckedAt"),
        "ethernet": {
            "device": raw.get("ethDevice") or PI_ETH_DEVICE,
            "mac": raw.get("ethMac"),
            "carrier": carrier,
            "operstate": operstate,
            "speed": parse_int(raw.get("ethSpeed")),
            "duplex": raw.get("ethDuplex"),
            "linkDetected": carrier == "1" or operstate == "up",
            "ipv4": ipv4,
            "gateway": raw.get("ethGateway"),
            "gatewayPingMs": gateway_ping_ms,
            "gatewayPing": {
                "available": bool(raw.get("ethGateway")),
                "ok": gateway_ping_ms is not None,
                "error": None if gateway_ping_ms is not None else "no ping reply",
            },
        },
        "resources": {
            "hostname": raw.get("hostname"),
            "temperatureC": parse_float(raw.get("cpuTempC")),
            "loadAverage": [parse_float(item) for item in raw.get("loadAverage", "").split() if parse_float(item) is not None],
            "memory": {
                "available": raw.get("memoryUsedPercent") is not None,
                "usedPercent": parse_float(raw.get("memoryUsedPercent")),
            },
            "disk": {
                "usedPercent": parse_float(raw.get("diskUsedPercent")),
            },
        },
        "hardware": {
            "uptimeSeconds": parse_float(raw.get("uptimeSeconds")),
            "undervoltageAlarm": undervoltage["any"],
            "undervoltageCurrent": undervoltage["current"],
            "undervoltageOccurred": undervoltage["occurred"],
            "undervoltageRaw": undervoltage_alarm,
            "throttled": throttled,
            "throttledFlags": undervoltage["throttled"],
        },
        "i2c": {"available": False, "ok": None, "error": "remote host check does not scan I2C"},
        "containers": {"available": False, "ok": None, "error": "remote host check does not inspect containers"},
    }


def pi_ethernet_health(device):
    carrier = read_text(HOST_SYS / f"class/net/{device}/carrier")
    operstate = read_text(HOST_SYS / f"class/net/{device}/operstate")
    address = read_text(HOST_SYS / f"class/net/{device}/address")
    speed = parse_int(read_text(HOST_SYS / f"class/net/{device}/speed"))
    duplex = read_text(HOST_SYS / f"class/net/{device}/duplex")

    ip_addr = {"ok": False, "stdout": "", "stderr": ""}
    route = {"ok": False, "stdout": "", "stderr": ""}
    if command_path("ip"):
        ip_addr = run_cmd(["ip", "-o", "-4", "addr", "show", device], timeout=3)
        route = run_cmd(["ip", "route", "show", "dev", device], timeout=3)

    gateway = parse_proc_default_gateway(device) or parse_linux_gateway(route.get("stdout", ""))
    ipv4 = CONTROLLER_IPV4 or parse_linux_ipv4(ip_addr.get("stdout", ""))
    link_detected = carrier == "1" if carrier in {"0", "1"} else operstate == "up"

    gateway_ping = ping_host(gateway) if gateway else {"available": False, "ok": False, "error": "no gateway"}
    gateway_ping_ms = None
    if gateway_ping.get("stdout"):
        marker = "time="
        after = gateway_ping["stdout"].split(marker, 1)[1] if marker in gateway_ping["stdout"] else ""
        gateway_ping_ms = parse_float(after.split()[0]) if after else None
    internet_ping = ping_host("8.8.8.8")

    return {
        "device": device,
        "mac": address,
        "carrier": carrier,
        "operstate": operstate,
        "speed": speed,
        "duplex": duplex,
        "linkDetected": link_detected,
        "ipv4": ipv4,
        "gateway": gateway,
        "gatewayPingMs": gateway_ping_ms,
        "gatewayPing": compact_command(gateway_ping),
        "internetPing": compact_command(internet_ping),
        "rawAddress": ip_addr.get("stdout", ""),
        "rawRoute": route.get("stdout", ""),
    }


def compact_command(result):
    return {
        "available": result.get("available", True),
        "ok": result.get("ok", False),
        "returncode": result.get("returncode"),
        "error": result.get("error") or result.get("stderr"),
    }


def parse_meminfo():
    raw = read_text(HOST_PROC / "meminfo")
    if not raw:
        return {"available": False}
    values = {}
    for line in raw.splitlines():
        key, value = line.split(":", 1)
        parts = value.strip().split()
        if parts:
            values[key] = int(parts[0])
    total = values.get("MemTotal")
    available = values.get("MemAvailable")
    if not total or available is None:
        return {"available": False}
    used_percent = round(((total - available) / total) * 100, 1)
    return {
        "available": True,
        "totalMb": round(total / 1024),
        "availableMb": round(available / 1024),
        "usedPercent": used_percent,
    }


def resource_health():
    disk = shutil.disk_usage("/")
    temp_raw = read_text(HOST_SYS / "class/thermal/thermal_zone0/temp")
    temp_c = None
    if temp_raw:
        try:
            temp_c = round(int(temp_raw) / 1000, 1)
        except Exception:
            temp_c = None

    try:
        load1, load5, load15 = os.getloadavg()
        load = [round(load1, 2), round(load5, 2), round(load15, 2)]
    except Exception:
        load = []

    return {
        "platform": platform.platform(),
        "hostname": socket.gethostname(),
        "memory": parse_meminfo(),
        "disk": {
            "totalGb": round(disk.total / (1024**3), 1),
            "freeGb": round(disk.free / (1024**3), 1),
            "usedPercent": round((disk.used / disk.total) * 100, 1),
        },
        "temperatureC": temp_c,
        "loadAverage": load,
    }


def hardware_health():
    uptime_raw = read_text(HOST_PROC / "uptime")
    uptime_seconds = parse_float((uptime_raw or "").split()[0] if uptime_raw else None)
    undervoltage_alarm = None
    try:
        for name_file in (HOST_SYS / "class/hwmon").glob("*/name"):
            if read_text(name_file) == "rpi_volt":
                undervoltage_alarm = read_text(name_file.parent / "in0_lcrit_alarm")
                break
    except Exception:
        undervoltage_alarm = None
    throttled = ""
    vcgencmd = command_path("vcgencmd")
    if vcgencmd:
        result = run_cmd([vcgencmd, "get_throttled"], timeout=3)
        if result.get("ok") and "=" in result.get("stdout", ""):
            throttled = result["stdout"].split("=", 1)[1].strip()
    undervoltage = undervoltage_state(undervoltage_alarm, throttled)
    return {
        "uptimeSeconds": uptime_seconds,
        "undervoltageAlarm": undervoltage["any"],
        "undervoltageCurrent": undervoltage["current"],
        "undervoltageOccurred": undervoltage["occurred"],
        "undervoltageRaw": undervoltage_alarm,
        "throttled": throttled,
        "throttledFlags": undervoltage["throttled"],
    }


def parse_i2cdetect(text):
    detected = []
    for line in text.splitlines():
        if ":" not in line:
            continue
        row_prefix, rest = line.split(":", 1)
        row_prefix = row_prefix.strip()
        if not row_prefix:
            continue
        for token in rest.split():
            token = token.strip().lower()
            if token == "--" or token == "uu":
                continue
            if all(ch in "0123456789abcdef" for ch in token):
                detected.append(f"0x{token.zfill(2)}")
    return sorted(set(detected))


def i2c_health():
    i2cdetect = command_path("i2cdetect")
    if not i2cdetect:
        return {
            "available": False,
            "ok": None,
            "error": "i2cdetect command not found",
            "expected": EXPECTED_BOARDS,
            "detected": [],
            "missing": [],
            "raw": "",
        }
    result = run_cmd([i2cdetect, "-r", "-y", I2C_BUS, "0x20", "0x30"], timeout=6)
    detected = parse_i2cdetect(result.get("stdout", ""))
    missing = [board for board in EXPECTED_BOARDS if board not in detected]
    return {
        "available": True,
        "ok": result.get("ok") and not missing,
        "error": result.get("error") or result.get("stderr"),
        "expected": EXPECTED_BOARDS,
        "detected": detected,
        "missing": missing,
        "raw": result.get("stdout", ""),
    }


def service_matches(name, expected):
    return name == expected or name.endswith(f"_{expected}") or expected in name


def docker_socket_container_health():
    response = fetch_unix_json(BALENA_ENGINE_SOCKET, "/containers/json?all=0", timeout=4)
    if not response.get("ok"):
        return {
            "available": False,
            "ok": None,
            "engine": "balena-engine-socket",
            "expected": EXPECTED_SERVICES,
            "services": [],
            "missing": [],
            "error": response.get("error") or f"HTTP {response.get('status')}",
        }
    services = []
    for item in response.get("data") or []:
        names = item.get("Names") or []
        name = (names[0] if names else item.get("Id", "")) or ""
        name = name.lstrip("/")
        services.append(
            {
                "name": name,
                "status": item.get("Status"),
                "image": item.get("Image"),
                "state": item.get("State"),
            }
        )
    running_names = [service["name"] for service in services]
    missing = [
        expected
        for expected in EXPECTED_SERVICES
        if not any(service_matches(name, expected) for name in running_names)
    ]
    return {
        "available": True,
        "ok": not missing,
        "engine": "balena-engine-socket",
        "expected": EXPECTED_SERVICES,
        "services": services,
        "missing": missing,
        "error": None,
    }


def container_health():
    engine = command_path("balena-engine") or command_path("docker")
    if not engine:
        return docker_socket_container_health()
    result = run_cmd([engine, "ps", "--format", "{{.Names}}\t{{.Status}}\t{{.Image}}"], timeout=5)
    services = []
    for line in result.get("stdout", "").splitlines():
        parts = line.split("\t")
        if len(parts) >= 3:
            services.append({"name": parts[0], "status": parts[1], "image": parts[2]})
    running_names = [service["name"] for service in services]
    missing = [
        expected
        for expected in EXPECTED_SERVICES
        if not any(service_matches(name, expected) for name in running_names)
    ]
    return {
        "available": True,
        "ok": result.get("ok") and not missing,
        "engine": Path(engine).name,
        "expected": EXPECTED_SERVICES,
        "services": services,
        "missing": missing,
        "error": result.get("error") or result.get("stderr"),
    }


def sidecar_health():
    response = fetch_json(f"{HEALTH_SIDECAR_URL}/snapshot", timeout=2.5)
    if not response.get("ok"):
        return {
            "available": False,
            "source": "health-sidecar",
            "url": HEALTH_SIDECAR_URL,
            "error": response.get("error") or f"HTTP {response.get('status')}",
        }
    data = response.get("data") or {}
    gateway_ping_ms = data.get("gatewayPingMs")
    return {
        "available": True,
        "source": "health-sidecar",
        "url": HEALTH_SIDECAR_URL,
        "checkedAt": data.get("timestamp"),
        "ethernet": {
            "device": PI_ETH_DEVICE,
            "mac": data.get("mac"),
            "carrier": "1" if data.get("carrier") else "0",
            "operstate": data.get("operstate"),
            "speed": data.get("speed"),
            "duplex": data.get("duplex"),
            "linkDetected": bool(data.get("carrier")),
            "ipv4": "35.8.86.10",
            "gateway": "35.8.86.1",
            "gatewayPingMs": gateway_ping_ms,
            "gatewayPing": {
                "available": True,
                "ok": gateway_ping_ms is not None,
                "error": None if gateway_ping_ms is not None else "no ping reply",
            },
            "rxMbps": data.get("rxMbps"),
            "txMbps": data.get("txMbps"),
            "rxErrors": data.get("rxErrors"),
            "txErrors": data.get("txErrors"),
            "rxDropped": data.get("rxDropped"),
            "txDropped": data.get("txDropped"),
        },
        "resources": {
            "hostname": "plain-feather",
            "temperatureC": data.get("cpuTempC"),
            "loadAverage": [],
            "memory": {"available": False},
            "disk": {},
        },
        "hardware": {
            "uptimeSeconds": data.get("uptimeSeconds"),
            "undervoltageAlarm": data.get("undervoltageAlarm") in {1, "1", True},
            "undervoltageCurrent": data.get("undervoltageAlarm") in {1, "1", True},
            "undervoltageOccurred": None,
            "undervoltageRaw": data.get("undervoltageAlarm"),
            "throttledFlags": {
                "available": False,
                "flags": [],
                "raw": None,
            },
            "cpuFreqMHz": data.get("cpuFreqMHz"),
            "rp1TempC": data.get("rp1TempC"),
        },
        "app": {
            "state": data.get("appState"),
            "board38": data.get("board38"),
            "status": data.get("status"),
        },
        "i2c": {"available": False, "ok": None, "error": "sidecar does not scan I2C"},
        "containers": {"available": False, "ok": None, "error": "sidecar does not inspect containers"},
    }


def pi_local_health():
    is_linux = platform.system().lower() == "linux"
    if not is_linux:
        sidecar = sidecar_health()
        if sidecar.get("available"):
            return sidecar
        remote = remote_pi_host_health()
        if remote.get("available"):
            return remote
        return {
            "available": False,
            "reason": remote.get("error") or "Pi-local checks activate when this dashboard runs on Linux/balenaOS.",
            "resources": resource_health(),
            "remote": remote,
        }
    return {
        "available": True,
        "ethernet": pi_ethernet_health(PI_ETH_DEVICE),
        "resources": resource_health(),
        "hardware": hardware_health(),
        "i2c": i2c_health(),
        "containers": container_health(),
    }


def mac_network_health():
    ethernet = [parse_ifconfig(device) for device in ("en4", "en5", "en6")]
    wifi = parse_ifconfig("en0")
    active_ethernet = [item for item in ethernet if item["status"] == "active"]
    default_route = route_default()
    return {
        "ethernet": ethernet,
        "wifi": wifi,
        "activeEthernet": active_ethernet,
        "defaultRoute": default_route,
        "diagnosis": ethernet_diagnosis(ethernet, default_route),
    }


def ethernet_diagnosis(ethernet, default_route):
    if any(item["status"] == "active" for item in ethernet):
        active = [item["device"] for item in ethernet if item["status"] == "active"]
        if default_route.get("interface") in active:
            return {
                "level": "ok",
                "title": "Ethernet is active and carrying traffic",
                "detail": f"Default route is {default_route.get('interface')}.",
            }
        return {
            "level": "warning",
            "title": "Ethernet link is active but not the default route",
            "detail": "Cable/link exists, but macOS is still sending traffic through another interface.",
        }
    return {
        "level": "critical",
        "title": "No physical ethernet link detected",
        "detail": "Adapter exists, but every ethernet interface reports media: none / inactive.",
    }


def pairing_sensor_key(pairing):
    sensor = pairing.get("Sensor") or {}
    return f"{sensor.get('boardSerialId')}:{sensor.get('address')}"


def pairing_valve_key(pairing):
    valve = pairing.get("Valve") or {}
    return f"{valve.get('relayAddress')}:{valve.get('address')}"


def normalize_pairing_name(value):
    return "".join(ch for ch in str(value or "").lower() if ch.isalnum())


def latest_readings_by_sensor(readings_response):
    payload = readings_response.get("data")
    if isinstance(payload, dict):
        readings = payload.get("data") or []
    elif isinstance(payload, list):
        readings = payload
    else:
        readings = []

    latest = {}
    for reading in readings:
        sensor_id = reading.get("sensorId")
        if sensor_id is None:
            continue
        previous = latest.get(sensor_id)
        if previous is None or str(reading.get("createdAt", "")) > str(previous.get("createdAt", "")):
            latest[sensor_id] = reading
    return latest


def compact_reading(reading):
    if not reading:
        return None
    return {
        "createdAt": reading.get("createdAt"),
        "rawValue": reading.get("rawValue"),
        "calibratedValue": reading.get("calibratedValue"),
        "temperature": reading.get("temperature"),
        "electricalConductivity": reading.get("electricalConductivity"),
    }


def pairing_auto_config_ok(pairing):
    if not pairing:
        return False
    return all(
        pairing.get(key) is not None
        for key in ("calibrationId", "WTCPercentLimit", "ValveOpenTime", "MeasurementInterval")
    )


def validate_researcher_map(pairings, readings_response=None):
    latest = latest_readings_by_sensor(readings_response or {})
    if not isinstance(pairings, list):
        return {
            "ok": False,
            "dataOk": False,
            "rows": [
                {
                    "physicalPot": physical_pot,
                    "softwarePairing": software_name,
                    "sensorId": None,
                    "valveId": None,
                    "expectedSensor": expected_sensor,
                    "actualSensor": None,
                    "expectedValve": expected_valve,
                    "actualValve": None,
                    "autoConfigOk": False,
                    "latestReading": None,
                    "note": note,
                    "ok": False,
                }
                for physical_pot, software_name, expected_sensor, expected_valve, note in RESEARCHER_MAP
            ],
            "missing": ["pairings unavailable"],
            "wrong": [],
            "missingReadings": ["readings unavailable"],
            "inactiveZone4LastFivePresent": [],
        }

    by_name = {pairing.get("name"): pairing for pairing in pairings}
    by_normalized_name = {normalize_pairing_name(pairing.get("name")): pairing for pairing in pairings}
    by_sensor_valve = {
        (pairing_sensor_key(pairing), pairing_valve_key(pairing)): pairing
        for pairing in pairings
    }
    rows = []
    missing = []
    wrong = []
    missing_readings = []
    missing_auto_config = []
    watering_disabled = []
    calibration_warnings = []
    config_warnings = []
    for physical_pot, software_name, expected_sensor, expected_valve, note in RESEARCHER_MAP:
        pairing = by_name.get(software_name)
        matched_by_name = pairing is not None
        if pairing is None:
            pairing = by_normalized_name.get(normalize_pairing_name(software_name))
            matched_by_name = pairing is not None
        if pairing is None:
            pairing = by_sensor_valve.get((expected_sensor, expected_valve))
        actual_sensor = pairing_sensor_key(pairing) if pairing else None
        actual_valve = pairing_valve_key(pairing) if pairing else None
        sensor_id = pairing.get("sensorId") if pairing else None
        valve_id = pairing.get("valveId") if pairing else None
        latest_reading = compact_reading(latest.get(sensor_id))
        auto_config_ok = pairing_auto_config_ok(pairing)
        calibration_id = pairing.get("calibrationId") if pairing else None
        wtc_limit = pairing.get("WTCPercentLimit") if pairing else None
        valve_open_time = pairing.get("ValveOpenTime") if pairing else None
        watering_is_disabled = parse_int(wtc_limit) == -999999 or parse_int(valve_open_time) == 0
        calibration_warning = None
        if physical_pot == 95 and calibration_id == 3:
            calibration_warning = "temporary Pot95 calibration; confirm with handheld METER before treating VWC as research-final"
        ok = bool(pairing) and actual_valve == expected_valve and actual_sensor == expected_sensor
        row = {
            "physicalPot": physical_pot,
            "softwarePairing": software_name,
            "sensorId": sensor_id,
            "valveId": valve_id,
            "expectedSensor": expected_sensor,
            "actualSensor": actual_sensor,
            "expectedValve": expected_valve,
            "actualValve": actual_valve,
            "calibrationId": calibration_id,
            "WTCPercentLimit": wtc_limit,
            "ValveOpenTime": valve_open_time,
            "MeasurementInterval": pairing.get("MeasurementInterval") if pairing else None,
            "autoConfigOk": auto_config_ok,
            "latestReading": latest_reading,
            "note": note,
            "actualName": pairing.get("name") if pairing else None,
            "nameMatches": matched_by_name,
            "wateringDisabled": watering_is_disabled,
            "calibrationWarning": calibration_warning,
            "ok": ok,
        }
        rows.append(row)
        if not pairing:
            missing.append(software_name)
        elif not ok:
            wrong.append(row)
            config_warnings.append(
                f"{software_name}: expected {expected_sensor} / {expected_valve}, actual {actual_sensor or '--'} / {actual_valve or '--'}"
            )
        if ok and not latest_reading:
            missing_readings.append(f"{physical_pot} ({software_name})")
        if ok and not auto_config_ok:
            missing_auto_config.append(f"{physical_pot} ({software_name})")
        if pairing and watering_is_disabled:
            watering_disabled.append(f"Pot{physical_pot} ({software_name})")
        if calibration_warning:
            calibration_warnings.append(f"Pot{physical_pot}: {calibration_warning}")

    inactive_present = [name for name in [f"Zone4-Pot{n}" for n in range(86, 91)] if name in by_name]
    return {
        "ok": not missing and not wrong and not inactive_present,
        "dataOk": not missing_readings,
        "autoConfigOk": not missing_auto_config,
        "rows": rows,
        "missing": missing,
        "wrong": wrong,
        "configWarnings": config_warnings,
        "missingReadings": missing_readings,
        "missingAutoConfig": missing_auto_config,
        "wateringDisabled": watering_disabled,
        "calibrationWarnings": calibration_warnings,
        "inactiveZone4LastFivePresent": inactive_present,
    }


def response_items(response):
    payload = response.get("data")
    if isinstance(payload, dict) and isinstance(payload.get("data"), list):
        return payload.get("data") or []
    if isinstance(payload, list):
        return payload
    return []


def pairing_display_map(pairings):
    lookup = {}
    if not isinstance(pairings, list):
        return lookup
    researcher_by_pair = {}
    researcher_by_name = {}
    for physical_pot, software_name, expected_sensor, expected_valve, _note in RESEARCHER_MAP:
        item = {
            "physicalPot": physical_pot,
            "softwarePairing": software_name,
        }
        researcher_by_pair[(expected_sensor, expected_valve)] = item
        researcher_by_name[normalize_pairing_name(software_name)] = item

    for pairing in pairings:
        sensor_id = pairing.get("sensorId")
        valve_id = pairing.get("valveId")
        sensor_key = pairing_sensor_key(pairing)
        valve_key = pairing_valve_key(pairing)
        display = {
            "sensorId": sensor_id,
            "valveId": valve_id,
            "pairing": pairing.get("name") or f"{sensor_id}-{valve_id}",
            "sensor": sensor_key,
            "valve": valve_key,
            "physicalPot": None,
            "valveOpenTimeMs": pairing.get("ValveOpenTime"),
        }
        display.update(researcher_by_pair.get((sensor_key, valve_key), {}))
        display.update(researcher_by_name.get(normalize_pairing_name(pairing.get("name")), {}))
        lookup[f"{sensor_id}-{valve_id}"] = display
    return lookup


def watering_events_from_logs(logs_response, pairings):
    events = []
    display = pairing_display_map(pairings)
    for log in response_items(logs_response):
        message = str(log.get("message") or "")
        if not message.startswith("Opened Valve: "):
            continue
        pair_id = message.split("Opened Valve: ", 1)[1].strip().split()[0]
        sensor_text, sep, valve_text = pair_id.partition("-")
        if not sep:
            continue
        meta = display.get(pair_id, {})
        events.append(
            {
                "id": log.get("id"),
                "t": log.get("createdAt"),
                "pairId": pair_id,
                "sensorId": parse_int(sensor_text),
                "valveId": parse_int(valve_text),
                "physicalPot": meta.get("physicalPot"),
                "pairing": meta.get("softwarePairing") or meta.get("pairing") or pair_id,
                "sensor": meta.get("sensor"),
                "valve": meta.get("valve"),
                "valveOpenTimeMs": meta.get("valveOpenTimeMs"),
            }
        )
    events.sort(key=lambda event: iso_to_ts(event.get("t")))
    return events[-350:]


def watering_summary(events):
    now = time.time()
    last_24h = [event for event in events if now - iso_to_ts(event.get("t")) <= 24 * 60 * 60]
    last_hour = [event for event in events if now - iso_to_ts(event.get("t")) <= 60 * 60]
    by_sensor = {}
    for event in events:
        key = event.get("pairId")
        if not key:
            continue
        by_sensor[key] = event
    last_event = events[-1] if events else None
    return {
        "events": events,
        "eventsLoaded": len(events),
        "last24h": len(last_24h),
        "lastHour": len(last_hour),
        "lastEvent": last_event,
        "lastBySensor": sorted(
            by_sensor.values(),
            key=lambda event: (
                event.get("physicalPot") is None,
                event.get("physicalPot") or event.get("sensorId") or 0,
            ),
        )[:120],
    }


def direct_sensor_read_from_response(response):
    if not response.get("ok"):
        return {
            "ok": False,
            "status": "error",
            "error": response.get("error") or f"HTTP {response.get('status')}",
            "timestamp": None,
            "reading": None,
        }

    payload = response.get("data") or {}
    data = ((payload.get("value") or {}).get("data") or [])
    if not data:
        return {
            "ok": False,
            "status": "no_data",
            "error": "Sensor endpoint returned no measurement rows",
            "timestamp": payload.get("timestamp"),
            "reading": None,
        }

    reading = data[0]
    return {
        "ok": True,
        "status": "ok",
        "error": None,
        "timestamp": payload.get("timestamp"),
        "reading": {
            "rawValue": reading.get("volumetricWaterContent"),
            "temperature": reading.get("temperature"),
            "electricalConductivity": reading.get("electricalConductivity"),
        },
    }


def direct_sensor_read(sensor_id):
    response = fetch_json(f"{API_BASE}/v1/sensors/{sensor_id}/direct-reading/1", timeout=API_HTTP_TIMEOUT)
    if not response.get("ok"):
        fallback = fetch_device_api_bundle(
            {"direct": f"/v1/sensors/{sensor_id}/direct-reading/1"},
            timeout=45,
            curl_timeout=35,
        )
        response = fallback.get("direct", response)
    return direct_sensor_read_from_response(response)


def collect_researcher_direct_reads():
    api_results, source, _direct_results = fetch_api_bundle(
        {
            "health": "/v1/healthcheck",
            "pairings": "/v1/pairings",
            "readings": f"/v1/readings?pageSize={READINGS_PAGE_SIZE}",
        }
    )
    pairings = api_results["pairings"]
    readings = api_results["readings"]
    map_status = validate_researcher_map(pairings.get("data"), readings)
    rows = [{**row, "directReading": None} for row in map_status.get("rows", [])]
    directable = {
        str(row["physicalPot"]): f"/v1/sensors/{row['sensorId']}/direct-reading/1"
        for row in map_status.get("rows", [])
        if row.get("ok") and row.get("sensorId")
    }
    direct_results = {}
    if directable:
        if source == "device-ssh":
            direct_results = fetch_device_api_bundle(
                directable,
                timeout=max(60, len(directable) * 40),
                curl_timeout=35,
            )
        else:
            with ThreadPoolExecutor(max_workers=min(5, len(directable))) as executor:
                futures = {
                    pot: executor.submit(fetch_json, f"{API_BASE}{path}", 35)
                    for pot, path in directable.items()
                }
                direct_results = {pot: future.result() for pot, future in futures.items()}

    for row in rows:
        key = str(row["physicalPot"])
        if key in direct_results:
            row["directReading"] = direct_sensor_read_from_response(direct_results[key])
    return {
        "generatedAt": utc_now(),
        "apiBase": API_BASE,
        "source": source,
        "ok": all((row.get("directReading") or {}).get("ok") for row in rows if row.get("ok")),
        "rows": rows,
    }


def api_health():
    endpoints = {
        "health": "/v1/healthcheck",
        "system": "/v1/system",
        "pairings": "/v1/pairings",
        "sensors": "/v1/sensors",
        "valves": "/v1/valves",
        "readings": f"/v1/readings?pageSize={READINGS_PAGE_SIZE}",
        "logs": "/v1/logs",
    }
    results, source, direct_results = fetch_api_bundle(endpoints)
    if source == "device-ssh" and not results.get("readings", {}).get("ok"):
        readings_retry = fetch_device_api_bundle(
            {"readings": endpoints["readings"]},
            timeout=DEVICE_API_SSH_RETRY_TIMEOUT,
        )
        if readings_retry.get("readings", {}).get("ok"):
            results["readings"] = readings_retry["readings"]
            remember_api_responses({"readings": readings_retry["readings"]})
        else:
            apply_cached_api_responses(results)

    health = results["health"]
    system = results["system"]
    pairings = results["pairings"]
    sensors = results["sensors"]
    valves = results["valves"]
    readings = results["readings"]
    logs = results["logs"]
    watering_since = datetime.fromtimestamp(
        time.time() - WATERING_LOOKBACK_DAYS * 24 * 60 * 60,
        timezone.utc,
    ).isoformat()
    watering_logs = fetch_json_post(
        f"{API_BASE}/v1/logs/search",
        {
            "message": "Opened Valve:",
            "startDate": watering_since,
            "limit": WATERING_LOG_LIMIT,
        },
        timeout=max(API_HTTP_TIMEOUT, 4),
    )
    watering_source = "logs-search"
    if not watering_logs.get("ok"):
        watering_logs = logs
        watering_source = "logs-page-fallback"
    watering = watering_summary(watering_events_from_logs(watering_logs, pairings.get("data")))
    watering["source"] = watering_source
    watering["lookbackDays"] = WATERING_LOOKBACK_DAYS
    watering["logLimit"] = WATERING_LOG_LIMIT
    watering["logs"] = compact_collection(watering_logs)
    system_data = system.get("data") if system.get("ok") else None
    boards = []
    if isinstance(system_data, dict):
        for item in system_data.get("configuration", {}).get("boardConfigs", []):
            try:
                boards.append(f"0x{int(item.get('address')):02x}".lower())
            except Exception:
                pass
    return {
        "base": API_BASE,
        "deviceBase": DEVICE_API_BASE,
        "source": source,
        "directHealthcheck": (direct_results or {}).get("health"),
        "healthcheck": health,
        "system": system,
        "pairings": compact_collection(pairings),
        "sensors": compact_collection(sensors),
        "valves": compact_collection(valves),
        "readings": compact_collection(readings),
        "logs": compact_collection(logs),
        "wateringLogs": compact_collection(watering_logs),
        "watering": watering,
        "boards": {
            "expected": EXPECTED_BOARDS,
            "actual": boards,
            "missing": [board for board in EXPECTED_BOARDS if board not in boards],
            "ok": all(board in boards for board in EXPECTED_BOARDS),
        },
        "researcherMap": validate_researcher_map(pairings.get("data"), readings),
    }


def _fetch_controller_config_snapshot():
    """Fetch authoritative controller configuration directly from the local API.

    This intentionally does not reuse aggregate health diagnostics; only the
    controller's configuration endpoints may populate the portal mirror.
    """
    endpoints = {
        "health": "/v1/healthcheck",
        "system": "/v1/system",
        "pairings": "/v1/pairings",
        "calibrations": "/v1/calibrations",
        "sensors": "/v1/sensors",
        "valves": "/v1/valves",
        "groups": "/v1/groups",
    }
    results, source, _direct_results = fetch_api_bundle(endpoints)
    required = ["system", "pairings", "calibrations", "sensors", "valves", "groups"]
    failures = {
        name: {
            "status": results.get(name, {}).get("status"),
            "error": results.get(name, {}).get("error"),
        }
        for name in required
        if not results.get(name, {}).get("ok")
    }
    if failures:
        return {
            "ok": False,
            "error": "authoritative controller configuration is incomplete",
            "source": source,
            "failures": failures,
            "observed_at": utc_now(),
        }

    system = results["system"].get("data")
    if not isinstance(system, dict):
        return {
            "ok": False,
            "error": "controller system response is invalid",
            "source": source,
            "observed_at": utc_now(),
        }

    board_config = (system.get("configuration") or {}).get("boardConfigs") or []
    config = {
        "pairings": results["pairings"].get("data") or [],
        "calibrations": results["calibrations"].get("data") or [],
        "board_config": board_config,
        "sensors": results["sensors"].get("data") or [],
        "valves": results["valves"].get("data") or [],
        "groups": results["groups"].get("data") or [],
    }
    canonical = json.dumps(config, sort_keys=True, separators=(",", ":"), default=str)
    observed_at = utc_now()
    return {
        "ok": True,
        "source": source,
        "observed_at": observed_at,
        "state_observed_at": observed_at,
        "controller_state": system.get("state"),
        "system": system,
        "config_hash": hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
        **config,
    }


def controller_config_snapshot():
    with CONFIG_SNAPSHOT_LOCK:
        now = time.time()
        if CONFIG_SNAPSHOT_CACHE["value"] is not None and now - CONFIG_SNAPSHOT_CACHE["at"] < 2:
            return CONFIG_SNAPSHOT_CACHE["value"]
        value = _fetch_controller_config_snapshot()
        CONFIG_SNAPSHOT_CACHE["at"] = now
        CONFIG_SNAPSHOT_CACHE["value"] = value
        return value


def compact_collection(response):
    data = response.get("data")
    count = None
    if isinstance(data, list):
        count = len(data)
    elif isinstance(data, dict) and isinstance(data.get("data"), list):
        count = len(data.get("data") or [])
    return {
        "ok": response.get("ok", False),
        "status": response.get("status"),
        "elapsedMs": response.get("elapsedMs"),
        "error": response.get("error"),
        "count": count,
    }


def public_url_health():
    checks = {
        "dashboard": f"{PUBLIC_URL}/dashboard",
        "ownerHealth": f"{PUBLIC_URL}{public_path('/')}",
        "systemConfig": f"{PUBLIC_URL}/system-config",
    }
    with ThreadPoolExecutor(max_workers=len(checks)) as executor:
        futures = {name: executor.submit(fetch_head, url) for name, url in checks.items()}
        results = {name: future.result() for name, future in futures.items()}
    return {
        "url": PUBLIC_URL,
        "dashboard": results["dashboard"],
        "ownerHealth": results["ownerHealth"],
        "systemConfig": results["systemConfig"],
    }


def redis_read_line(reader):
    line = reader.readline()
    if line.endswith(b"\r\n"):
        line = line[:-2]
    return line


def redis_parse_response(reader):
    prefix = reader.read(1)
    if not prefix:
        raise RuntimeError("empty Redis response")
    if prefix == b"+":
        return redis_read_line(reader).decode("utf-8", errors="replace")
    if prefix == b"-":
        raise RuntimeError(redis_read_line(reader).decode("utf-8", errors="replace"))
    if prefix == b":":
        return int(redis_read_line(reader))
    if prefix == b"$":
        size = int(redis_read_line(reader))
        if size == -1:
            return None
        data = reader.read(size)
        reader.read(2)
        return data.decode("utf-8", errors="replace")
    if prefix == b"*":
        count = int(redis_read_line(reader))
        return [redis_parse_response(reader) for _ in range(count)]
    raise RuntimeError(f"unknown Redis response prefix {prefix!r}")


def redis_command(*args):
    payload = [f"*{len(args)}\r\n".encode("utf-8")]
    for arg in args:
        encoded = str(arg).encode("utf-8")
        payload.append(f"${len(encoded)}\r\n".encode("utf-8"))
        payload.append(encoded + b"\r\n")
    with socket.create_connection((REDIS_HOST, REDIS_PORT), timeout=REDIS_TIMEOUT) as client:
        client.sendall(b"".join(payload))
        with client.makefile("rb") as reader:
            return redis_parse_response(reader)


def redis_count_key(key):
    key_type = redis_command("TYPE", key)
    if key_type == "none":
        return 0
    if key_type == "list":
        return parse_int(redis_command("LLEN", key)) or 0
    if key_type == "zset":
        return parse_int(redis_command("ZCARD", key)) or 0
    if key_type == "set":
        return parse_int(redis_command("SCARD", key)) or 0
    return 0


def redis_scheduler_health():
    try:
        pong = redis_command("PING")
        counts = {
            name: redis_count_key(f"bull:state-transitions:{name}")
            for name in ("wait", "active", "delayed", "completed", "failed")
        }
    except Exception as exc:
        return {
            "available": False,
            "ok": None,
            "source": "redis",
            "error": str(exc),
        }
    total_pending = counts["wait"] + counts["active"] + counts["delayed"]
    return {
        "available": True,
        "ok": total_pending > 0,
        "source": "redis",
        "redisHost": REDIS_HOST,
        "redisPort": REDIS_PORT,
        "redisPing": pong,
        "redisContainer": "redis_svc",
        "cronContainer": "cron_svc",
        "cronInitLastStart": None,
        "cronInitPairings": None,
        "cronApiRefused": 0,
        "cronFetchedZero": 0,
        "cronStateMachineStarted": None,
        "startupFailure": False,
        "counts": counts,
        "totalPending": total_pending,
        "keysCount": None,
    }


def scheduler_health():
    if not SCHEDULER_HEALTH_ENABLED:
        return {"available": False, "ok": None, "error": "scheduler check disabled"}
    if SCHEDULER_HEALTH_SOURCE in {"auto", "redis"}:
        redis_health = redis_scheduler_health()
        if redis_health.get("available") or SCHEDULER_HEALTH_SOURCE == "redis":
            return redis_health
    ssh = command_path("ssh")
    if not ssh:
        return {"available": False, "ok": None, "error": "ssh command not found"}
    script = r"""
set +e
redis="$(balena-engine ps --format '{{.Names}}' | grep redis | head -1)"
cron="$(balena-engine ps --format '{{.Names}}' | grep cron | head -1)"
printf 'redisContainer=%s\n' "$redis"
printf 'cronContainer=%s\n' "$cron"
if [ -n "$cron" ]; then
  balena-engine exec "$cron" node -e "try { const init = require('/app/init.json'); console.log('cronInitLastStart=' + (init.lastStartTime || '')); console.log('cronInitPairings=' + (Array.isArray(init.pairings) ? init.pairings.length : '')); } catch (error) { console.log('cronInitError=' + error.message); }" 2>/dev/null
  recentLogs="$(balena-engine logs --since 15m "$cron" 2>&1)"
  printf 'cronApiRefused=%s\n' "$(printf '%s\n' "$recentLogs" | grep -c 'ECONNREFUSED')"
  printf 'cronFetchedZero=%s\n' "$(printf '%s\n' "$recentLogs" | grep -c 'Total pairings fetched: 0')"
  printf 'cronStateMachineStarted=%s\n' "$(printf '%s\n' "$recentLogs" | grep -c 'State machine started')"
fi
if [ -z "$redis" ]; then exit 0; fi
for state in wait active delayed completed failed; do
  key="bull:state-transitions:$state"
  type="$(balena-engine exec "$redis" redis-cli type "$key" 2>/dev/null | tail -1)"
  count=0
  case "$type" in
    list) count="$(balena-engine exec "$redis" redis-cli llen "$key" 2>/dev/null | tail -1)" ;;
    zset) count="$(balena-engine exec "$redis" redis-cli zcard "$key" 2>/dev/null | tail -1)" ;;
    set) count="$(balena-engine exec "$redis" redis-cli scard "$key" 2>/dev/null | tail -1)" ;;
    none) count=0 ;;
  esac
  printf '%s=%s\n' "$state" "$count"
done
keysCount="$(balena-engine exec "$redis" sh -lc "redis-cli --scan --pattern 'bull:state-transitions:*' | wc -l" 2>/dev/null | tail -1 | tr -d ' ')"
printf 'keysCount=%s\n' "$keysCount"
"""
    result = run_cmd(
        [
            ssh,
            "-p",
            str(HOST_SSH_PORT),
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=4",
            "-o",
            "StrictHostKeyChecking=accept-new",
            HOST_SSH_TARGET,
            script,
        ],
        timeout=9,
    )
    if not result.get("ok"):
        return {
            "available": False,
            "ok": None,
            "source": "host-ssh",
            "error": result.get("error") or result.get("stderr") or "scheduler check failed",
        }
    raw = parse_key_value_lines(result.get("stdout", ""))
    counts = {
        name: parse_int(raw.get(name)) or 0
        for name in ("wait", "active", "delayed", "completed", "failed")
    }
    total_pending = counts["wait"] + counts["active"] + counts["delayed"]
    return {
        "available": True,
        "ok": total_pending > 0,
        "source": "host-ssh",
        "redisContainer": raw.get("redisContainer"),
        "cronContainer": raw.get("cronContainer"),
        "cronInitLastStart": raw.get("cronInitLastStart"),
        "cronInitPairings": parse_int(raw.get("cronInitPairings")),
        "cronApiRefused": parse_int(raw.get("cronApiRefused")) or 0,
        "cronFetchedZero": parse_int(raw.get("cronFetchedZero")) or 0,
        "cronStateMachineStarted": parse_int(raw.get("cronStateMachineStarted")) or 0,
        "startupFailure": (parse_int(raw.get("cronInitPairings")) == 0)
        and ((parse_int(raw.get("cronApiRefused")) or 0) > 0 or (parse_int(raw.get("cronFetchedZero")) or 0) > 0),
        "counts": counts,
        "totalPending": total_pending,
        "keysCount": parse_int(raw.get("keysCount")) or 0,
    }


def overall_status(health):
    issues = []
    warnings = []

    pi_local = health.get("piLocal", {})
    confirmed_eth = health.get("confirmedPiEthernet", {})
    scheduler = health.get("scheduler", {})

    if pi_local.get("available"):
        ethernet = pi_local.get("ethernet", {})
        if ethernet.get("linkDetected") is False:
            issues.append(f"Pi ethernet {ethernet.get('device', 'eth0')} has no physical link.")
        elif ethernet.get("linkDetected") and not ethernet.get("ipv4"):
            warnings.append("Pi ethernet has link but no IPv4 address.")

        i2c = pi_local.get("i2c", {})
        if i2c.get("available") and i2c.get("ok") is False:
            issues.append(f"I2C scan is missing expected board(s): {', '.join(i2c.get('missing') or [])}.")

        containers = pi_local.get("containers", {})
        if containers.get("available") and containers.get("ok") is False:
            issues.append(f"Balena service(s) missing: {', '.join(containers.get('missing') or [])}.")

        resources = pi_local.get("resources", {})
        disk = resources.get("disk", {})
        memory = resources.get("memory", {})
        if disk.get("usedPercent", 0) >= 90:
            warnings.append("Pi disk is above 90% used.")
        if memory.get("available") and memory.get("usedPercent", 0) >= 90:
            warnings.append("Pi memory is above 90% used.")
        if resources.get("temperatureC") and resources["temperatureC"] >= 75:
            warnings.append("Pi temperature is high.")
        hardware = pi_local.get("hardware", {})
        if hardware.get("undervoltageAlarm"):
            issues.append("Pi undervoltage alarm is active or has been reported by throttling flags.")
    elif confirmed_eth.get("available") and confirmed_eth.get("ok"):
        pass
    elif health["network"]["diagnosis"]["level"] == "critical":
        warnings.append("Mac ethernet has no physical link.")

    if not health["api"]["healthcheck"].get("ok"):
        issues.append("Direct Pi API is unreachable.")
    if not health["publicUrl"]["dashboard"].get("ok"):
        warnings.append("Balena public dashboard URL is not healthy.")
    if health["api"]["healthcheck"].get("ok") and not health["api"]["boards"]["ok"]:
        warnings.append("Relay board config could not be fully confirmed from the API.")
    if health["api"]["healthcheck"].get("ok") and not health["api"]["researcherMap"].get("dataOk", True):
        warnings.append(
            "Sensor readings are missing for: "
            + ", ".join(health["api"]["researcherMap"].get("missingReadings") or [])
            + "."
        )
    if (
        health["api"]["healthcheck"].get("ok")
        and scheduler.get("available")
        and scheduler.get("totalPending") == 0
    ):
        if scheduler.get("startupFailure"):
            issues.append(
                "Sensor scheduler started with 0 pairings after the API was unavailable at boot; normal automatic readings are not queued."
            )
        else:
            issues.append(
                "Sensor scheduler queue is empty, so normal automatic readings are not currently queued."
            )
    elif not scheduler.get("available"):
        warnings.append(
            "Sensor scheduler queue could not be checked from this dashboard."
        )

    if issues:
        level = "critical"
        title = "Action required"
    elif warnings:
        level = "warning"
        title = "Watch"
    else:
        level = "ok"
        title = "Healthy"

    return {"level": level, "title": title, "issues": issues, "warnings": warnings}


def latest_row_reading_at(rows):
    values = [
        ((row.get("latestReading") or {}).get("createdAt"))
        for row in rows
        if (row.get("latestReading") or {}).get("createdAt")
    ]
    if not values:
        return None
    return sorted(values, key=iso_to_ts)[-1]


def sensor_label(row):
    sensor = row.get("actualSensor") or row.get("expectedSensor") or ""
    address = sensor.split(":", 1)[1] if ":" in sensor else sensor
    if address:
        return f"{row.get('softwarePairing') or row.get('physicalPot')} / address {address}"
    return row.get("softwarePairing") or f"Pot {row.get('physicalPot')}"


def canonical_owner_status(health):
    api = health.get("api") or {}
    api_ok = bool((api.get("healthcheck") or {}).get("ok"))
    pi_local = health.get("piLocal") or {}
    ethernet = pi_local.get("ethernet") or {}
    resources = pi_local.get("resources") or {}
    hardware = pi_local.get("hardware") or {}
    map_status = api.get("researcherMap") or {}
    rows = map_status.get("rows") or []
    boards = api.get("boards") or {}
    public_url = health.get("publicUrl") or {}
    scheduler = health.get("scheduler") or {}
    watering = api.get("watering") or {}

    missing_rows = [row for row in rows if row.get("ok") and not row.get("latestReading")]
    stale_rows = []
    now_ts = time.time()
    for row in rows:
        reading_at = (row.get("latestReading") or {}).get("createdAt")
        interval_ms = parse_int(row.get("MeasurementInterval")) or 0
        if not reading_at or interval_ms <= 0:
            continue
        max_age = max((interval_ms / 1000) * 2, (interval_ms / 1000) + 300)
        if now_ts - iso_to_ts(reading_at) > max_age:
            stale_rows.append(row)

    missing_sensors = [sensor_label(row) for row in missing_rows]
    stale_sensors = [sensor_label(row) for row in stale_rows]
    sensors_expected = len(rows)
    sensors_missing = len(missing_sensors)
    sensors_stale = len(stale_sensors)
    sensors_current = max(0, sensors_expected - sensors_missing - sensors_stale)

    relay_status = {
        board: ("OK" if board in (boards.get("actual") or []) else "UNKNOWN")
        for board in (boards.get("expected") or EXPECTED_BOARDS)
    }
    ethernet_link = bool(ethernet.get("linkDetected") and ethernet.get("ipv4"))
    public_reachable_raw = bool((public_url.get("ownerHealth") or public_url.get("dashboard") or {}).get("ok"))
    public_reachable = public_reachable_raw or api_ok
    scheduler_jobs = scheduler.get("totalPending")
    scheduler_diag = scheduler_diagnostics(scheduler, sensors_expected)
    uptime_seconds = hardware.get("uptimeSeconds")
    restart_summary = recent_restart_summary(uptime_seconds, health.get("generatedAt"), hours=24)
    restart_count = restart_summary.get("count", 0)
    restart_storm_active = restart_count >= 3 and (
        restart_summary.get("recentlyRestarted")
        or (uptime_seconds is not None and uptime_seconds < 2 * 60 * 60)
    )
    undervoltage_current = bool(
        hardware.get("undervoltageCurrent")
        if hardware.get("undervoltageCurrent") is not None
        else hardware.get("undervoltageAlarm")
    )
    undervoltage_occurred = bool(hardware.get("undervoltageOccurred"))
    power_suspected = undervoltage_current or undervoltage_occurred or restart_storm_active
    config_warnings = map_status.get("configWarnings") or []
    calibration_warnings = map_status.get("calibrationWarnings") or []
    watering_disabled = map_status.get("wateringDisabled") or []
    active_alerts = []
    known_issues = []

    if not api_ok:
        active_alerts.append("Controller API is unreachable.")
    if sensors_missing:
        known_issues.extend(missing_sensors)
        active_alerts.append(f"{sensors_missing} mapped sensor has no stored reading: {', '.join(missing_sensors)}.")
    if sensors_stale:
        active_alerts.append(f"{sensors_stale} mapped sensor readings are not updating: {', '.join(stale_sensors[:8])}.")
    if undervoltage_current:
        active_alerts.append("Controller undervoltage alarm is active right now.")
    elif undervoltage_occurred:
        active_alerts.append("Controller undervoltage occurred since the last boot.")
    if restart_storm_active:
        active_alerts.append(
            f"Controller restarted {restart_summary['count']} times in the last 24h; current uptime is {round((uptime_seconds or 0) / 60)} min."
        )
    elif restart_summary.get("recentlyRestarted"):
        active_alerts.append(
            f"Controller restarted recently; current uptime is {round((uptime_seconds or 0) / 60)} min."
        )
    if scheduler.get("available") and scheduler_jobs == 0:
        active_alerts.append("Scheduler has no queued jobs.")
    if scheduler_diag.get("overloaded"):
        active_alerts.append(
            f"Scheduler is loading {scheduler_diag['jobsLoaded']} jobs for {sensors_expected} Matt pots; {scheduler_diag['extraJobsLoaded']} extra jobs are likely unused backlog/noise."
        )
    if scheduler.get("available") is False:
        active_alerts.append("Scheduler queue could not be checked.")
    if config_warnings:
        active_alerts.append(f"Experiment map mismatch: {config_warnings[0]}.")
    if calibration_warnings:
        active_alerts.append(calibration_warnings[0])
    if not boards.get("ok"):
        active_alerts.append("Relay board status could not be fully confirmed from API config.")
    if not ethernet_link and api_ok:
        active_alerts.append("Ethernet link is not confirmed, but the controller API is reachable.")
    if not api_ok:
        overall_status_text = "DOWN"
    elif power_suspected or sensors_missing or sensors_stale or (scheduler.get("available") and scheduler_jobs == 0):
        overall_status_text = "DEGRADED"
    elif (
        restart_summary.get("recentlyRestarted")
        or scheduler_diag.get("overloaded")
        or config_warnings
        or calibration_warnings
        or not ethernet_link
        or not public_reachable
        or not boards.get("ok")
    ):
        overall_status_text = "WATCH"
    elif api_ok:
        overall_status_text = "OK"
    else:
        overall_status_text = "UNKNOWN"

    last_sensor_at = latest_row_reading_at(rows)
    last_watering = watering.get("lastEvent") or {}
    return {
        "overall_status": overall_status_text,
        "last_checked_at": health.get("generatedAt"),
        "api_status": "OK" if api_ok else "DOWN",
        "pi_online": bool(api_ok or pi_local.get("available")),
        "last_sensor_reading_at": last_sensor_at,
        "last_database_write_at": last_sensor_at,
        "sensors_expected": sensors_expected,
        "sensors_current": sensors_current,
        "sensors_stale": sensors_stale,
        "sensors_missing": sensors_missing,
        "missing_sensors": missing_sensors,
        "stale_sensors": stale_sensors,
        "known_issues": known_issues,
        "undervoltage": bool(hardware.get("undervoltageAlarm")),
        "undervoltage_current": undervoltage_current,
        "undervoltage_occurred": undervoltage_occurred,
        "throttled_flags": hardware.get("throttledFlags") or {},
        "current_uptime_seconds": uptime_seconds,
        "current_boot_at": restart_summary.get("currentBootAt"),
        "restart_count_last_24h": restart_summary.get("count"),
        "last_restart_at": restart_summary.get("lastRestartAt"),
        "power_suspected": power_suspected,
        "cpu_temp_c": resources.get("temperatureC"),
        "ethernet_link": ethernet_link,
        "ethernet_ip": ethernet.get("ipv4"),
        "gateway_ping_ms": ethernet.get("gatewayPingMs"),
        "public_url_reachable": public_reachable,
        "relay_board_status": relay_status,
        "watering_last_event": last_watering.get("pairing") or last_watering.get("pairId"),
        "watering_last_event_at": last_watering.get("t"),
        "watering_events_last_24h": watering.get("last24h"),
        "watering_disabled": watering_disabled,
        "calibration_warnings": calibration_warnings,
        "config_warnings": config_warnings,
        "scheduler_jobs_loaded": scheduler_jobs,
        "scheduler_expected_matt_jobs": scheduler_diag.get("expectedMattJobs"),
        "scheduler_extra_jobs_loaded": scheduler_diag.get("extraJobsLoaded"),
        "scheduler_overloaded": scheduler_diag.get("overloaded"),
        "diagnostics": {
            "power": {
                "suspected": power_suspected,
                "undervoltageCurrent": undervoltage_current,
                "undervoltageOccurred": undervoltage_occurred,
                "uptimeSeconds": uptime_seconds,
                "restartSummary": restart_summary,
            },
            "connectivity": {
                "ethernetLink": ethernet_link,
                "gatewayPingMs": ethernet.get("gatewayPingMs"),
                "localApiReachable": api_ok,
                "publicUrlReachable": public_reachable,
            },
            "scheduler": scheduler_diag,
            "experiment": {
                "configWarnings": config_warnings,
                "calibrationWarnings": calibration_warnings,
                "wateringDisabled": watering_disabled,
            },
        },
        "active_alerts": active_alerts,
    }


def iso_to_ts(value):
    try:
        normalized = str(value).replace("Z", "+00:00")
        return datetime.fromisoformat(normalized).timestamp()
    except Exception:
        return 0


def iso_minus_seconds(value, seconds):
    base = iso_to_ts(value)
    if not base or seconds is None:
        return None
    try:
        return datetime.fromtimestamp(base - float(seconds), timezone.utc).isoformat()
    except Exception:
        return None


def recent_restart_summary(current_uptime_seconds=None, current_time=None, hours=24):
    records = read_history(1)
    if current_time and current_uptime_seconds is not None:
        records = records + [{"t": current_time, "uptimeSeconds": current_uptime_seconds}]
    cutoff = time.time() - hours * 60 * 60
    records = [record for record in records if iso_to_ts(record.get("t")) >= cutoff]
    records.sort(key=lambda record: iso_to_ts(record.get("t")))

    restarts = []
    previous = None
    for record in records:
        uptime = parse_float(record.get("uptimeSeconds"))
        if uptime is None:
            previous = record
            continue
        previous_uptime = parse_float(previous.get("uptimeSeconds")) if previous else None
        if previous_uptime is not None and uptime + 90 < previous_uptime:
            restarts.append(record.get("t"))
        previous = record

    last_restart_at = restarts[-1] if restarts else None
    current_boot_at = iso_minus_seconds(current_time, current_uptime_seconds)
    recently_restarted = current_uptime_seconds is not None and current_uptime_seconds < 10 * 60
    if recently_restarted and not last_restart_at:
        last_restart_at = current_boot_at

    return {
        "windowHours": hours,
        "count": len(restarts),
        "lastRestartAt": last_restart_at,
        "currentBootAt": current_boot_at,
        "recentlyRestarted": recently_restarted,
    }


def scheduler_diagnostics(scheduler, expected_jobs):
    jobs = scheduler.get("totalPending")
    extra = None
    if jobs is not None and expected_jobs is not None:
        extra = max(0, jobs - expected_jobs)
    return {
        "jobsLoaded": jobs,
        "expectedMattJobs": expected_jobs,
        "extraJobsLoaded": extra,
        "overloaded": bool(extra and extra > 0),
        "source": scheduler.get("source"),
        "counts": scheduler.get("counts") or {},
    }


def compact_history_record(health):
    pi_local = health.get("piLocal") or {}
    ethernet = pi_local.get("ethernet") or {}
    resources = pi_local.get("resources") or {}
    hardware = pi_local.get("hardware") or {}
    api = health.get("api") or {}
    map_status = api.get("researcherMap") or {}
    watering = api.get("watering") or {}
    scheduler = health.get("scheduler") or {}
    public_url = health.get("publicUrl") or {}
    overall = health.get("overall") or {}
    owner_status = health.get("ownerStatus") or {}
    missing_readings = map_status.get("missingReadings") or []
    owner_stale_or_missing = (owner_status.get("sensors_stale") or 0) + (owner_status.get("sensors_missing") or 0)
    stale_or_missing = owner_stale_or_missing or len(missing_readings)
    rows = map_status.get("rows") or []
    if rows and not stale_or_missing:
        stale_or_missing = sum(1 for row in rows if not row.get("latestReading"))

    return {
        "t": health.get("generatedAt") or utc_now(),
        "level": overall.get("level"),
        "title": overall.get("title"),
        "issues": len(overall.get("issues") or []),
        "warnings": len(overall.get("warnings") or []),
        "apiOk": bool((api.get("healthcheck") or {}).get("ok")),
        "apiMs": (api.get("healthcheck") or {}).get("elapsedMs"),
        "appState": ((api.get("system") or {}).get("data") or {}).get("state"),
        "publicOk": owner_status.get("public_url_reachable") if owner_status.get("public_url_reachable") is not None else bool((public_url.get("ownerHealth") or public_url.get("dashboard") or {}).get("ok")),
        "ethUp": bool(ethernet.get("linkDetected") and ethernet.get("ipv4")),
        "ethIp": ethernet.get("ipv4"),
        "gatewayPingMs": ethernet.get("gatewayPingMs"),
        "cpuTempC": resources.get("temperatureC"),
        "uptimeSeconds": hardware.get("uptimeSeconds"),
        "undervoltage": bool(hardware.get("undervoltageAlarm")),
        "undervoltageCurrent": bool(hardware.get("undervoltageCurrent")),
        "undervoltageOccurred": bool(hardware.get("undervoltageOccurred")),
        "powerSuspected": bool(owner_status.get("power_suspected")),
        "restartCountLast24h": owner_status.get("restart_count_last_24h"),
        "memoryUsedPercent": (resources.get("memory") or {}).get("usedPercent"),
        "diskUsedPercent": (resources.get("disk") or {}).get("usedPercent"),
        "boardsOk": bool((api.get("boards") or {}).get("ok")),
        "mapOk": bool(map_status.get("ok")),
        "sensorRows": owner_status.get("sensors_expected") or len(rows),
        "missingReadings": owner_status.get("sensors_missing") if owner_status.get("sensors_missing") is not None else len(missing_readings),
        "staleOrMissingSensors": stale_or_missing,
        "wateringOpenedLastHour": watering.get("lastHour"),
        "wateringOpenedLast24h": watering.get("last24h"),
        "wateringEventsLoaded": watering.get("eventsLoaded"),
        "wateringLastAt": (watering.get("lastEvent") or {}).get("t"),
        "schedulerAvailable": bool(scheduler.get("available")),
        "schedulerPending": scheduler.get("totalPending"),
        "schedulerExpectedMattJobs": owner_status.get("scheduler_expected_matt_jobs"),
        "schedulerExtraJobsLoaded": owner_status.get("scheduler_extra_jobs_loaded"),
    }


def prune_history_locked(now_ts):
    if not HISTORY_FILE.exists():
        return
    cutoff = now_ts - HISTORY_RETENTION_DAYS * 24 * 60 * 60
    try:
        lines = HISTORY_FILE.read_text().splitlines()
    except Exception:
        return
    kept = []
    for line in lines[-HISTORY_MAX_LINES:]:
        try:
            record = json.loads(line)
        except Exception:
            continue
        if iso_to_ts(record.get("t")) >= cutoff:
            kept.append(json.dumps(record, separators=(",", ":")))
    HISTORY_FILE.write_text("\n".join(kept) + ("\n" if kept else ""))


def record_history(health, force=False):
    global HISTORY_LAST_WRITE
    now = time.time()
    if not force and now - HISTORY_LAST_WRITE < max(30, HISTORY_SAMPLE_INTERVAL_SECONDS - 5):
        return
    record = compact_history_record(health)
    with HISTORY_LOCK:
        HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
        with HISTORY_FILE.open("a") as handle:
            handle.write(json.dumps(record, separators=(",", ":")) + "\n")
        HISTORY_LAST_WRITE = now
        prune_history_locked(now)


def read_history(days=None):
    days = days or HISTORY_RETENTION_DAYS
    cutoff = time.time() - max(1, min(days, HISTORY_RETENTION_DAYS)) * 24 * 60 * 60
    with HISTORY_LOCK:
        try:
            lines = HISTORY_FILE.read_text().splitlines()
        except Exception:
            return []
    records = []
    for line in lines:
        try:
            record = json.loads(line)
        except Exception:
            continue
        if iso_to_ts(record.get("t")) >= cutoff:
            records.append(record)
    return records[-HISTORY_MAX_LINES:]


def history_sampler():
    global SAMPLER_RUNNING
    if SAMPLER_RUNNING:
        return
    SAMPLER_RUNNING = True
    while not SAMPLER_STOP.is_set():
        try:
            health = collect_health(notify=True, write_history=False)
            record_history(health, force=True)
        except Exception as exc:
            try:
                HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
                with HISTORY_FILE.open("a") as handle:
                    handle.write(
                        json.dumps(
                            {
                                "t": utc_now(),
                                "level": "critical",
                                "title": "Sampler error",
                                "issues": 1,
                                "warnings": 0,
                                "apiOk": False,
                                "publicOk": False,
                                "ethUp": False,
                                "undervoltage": False,
                                "error": str(exc)[:240],
                            },
                            separators=(",", ":"),
                        )
                        + "\n"
                    )
            except Exception:
                pass
        SAMPLER_STOP.wait(max(60, HISTORY_SAMPLE_INTERVAL_SECONDS))


def collect_health(notify=True, write_history=True):
    health = {
        "generatedAt": utc_now(),
        "host": socket.gethostname(),
        "environment": {
            "apiBase": API_BASE,
            "publicUrl": PUBLIC_URL,
            "healthSidecarUrl": HEALTH_SIDECAR_URL,
            "expectedBoards": EXPECTED_BOARDS,
            "piEthDevice": PI_ETH_DEVICE,
            "authEnabled": auth_is_enabled(),
            "ownerAlertsEnabled": OWNER_ALERTS_ENABLED,
        },
        "confirmedPiEthernet": confirmed_pi_ethernet_health(),
        "network": mac_network_health(),
        "api": api_health(),
        "publicUrl": public_url_health(),
        "piLocal": pi_local_health(),
        "scheduler": scheduler_health(),
    }
    health["overall"] = overall_status(health)
    health["ownerStatus"] = canonical_owner_status(health)
    health["ownerAlerts"] = {
        "enabled": OWNER_ALERTS_ENABLED,
        "levels": sorted(OWNER_ALERT_LEVELS),
        "lastState": read_alert_state(),
    }
    if notify:
        maybe_send_owner_alert(health)
    if write_history:
        record_history(health)
    return health


class Handler(BaseHTTPRequestHandler):
    def send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def send_json(self, payload, status=200):
        body = json.dumps(payload, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_cors_headers()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path, content_type):
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-cache")
        self.send_cors_headers()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_html(self, html, status=200):
        body = html.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def redirect(self, location):
        if location.startswith("/") and not location.startswith("//"):
            location = public_path(location)
        self.send_response(303)
        self.send_header("Location", location)
        self.end_headers()

    def clear_session(self):
        attrs = [
            f"{DASHBOARD_SESSION_COOKIE}=",
            f"Path={PUBLIC_BASE_PATH or '/'}",
            "Max-Age=0",
            "HttpOnly",
            "SameSite=Lax",
        ]
        if DASHBOARD_COOKIE_SECURE:
            attrs.append("Secure")
        self.send_header("Set-Cookie", "; ".join(attrs))

    def set_session(self, username):
        attrs = [
            f"{DASHBOARD_SESSION_COOKIE}={create_session_token(username)}",
            f"Path={PUBLIC_BASE_PATH or '/'}",
            f"Max-Age={DASHBOARD_SESSION_TTL_SECONDS}",
            "HttpOnly",
            "SameSite=Lax",
        ]
        if DASHBOARD_COOKIE_SECURE:
            attrs.append("Secure")
        self.send_header("Set-Cookie", "; ".join(attrs))

    def request_authenticated(self):
        if not auth_is_enabled():
            return True
        cookies = parse_cookies(self.headers.get("Cookie", ""))
        if verify_session_token(cookies.get(DASHBOARD_SESSION_COOKIE, "")):
            return True
        return check_basic_auth(self.headers.get("Authorization", ""))

    def require_auth(self, path):
        if self.request_authenticated():
            return True
        if path.startswith("/api/"):
            return self.send_json({"ok": False, "error": "authentication required"}, status=401)
        next_path = urllib.parse.quote(path if path.startswith("/") else "/", safe="/")
        return self.redirect(f"/login?next={next_path}")

    def send_healthz(self, query):
        if not check_bearer_token(self.headers.get("Authorization", ""), query):
            return self.send_json({"ok": False, "error": "invalid healthcheck token"}, status=401)
        health = collect_health(notify=False, write_history=False)
        overall = health.get("overall") or {}
        owner_status = health.get("ownerStatus") or {}
        level = overall.get("level")
        ok = level != "critical"
        return self.send_json(
            {
                "ok": ok,
                "level": level,
                "title": overall.get("title"),
                "ownerStatus": owner_status,
                "generatedAt": health.get("generatedAt"),
                "issues": overall.get("issues") or [],
                "warnings": overall.get("warnings") or [],
            },
            status=200 if ok else 503,
        )

    def send_owner_healthz(self, query):
        if not check_bearer_token(self.headers.get("Authorization", ""), query):
            return self.send_json({"ok": False, "error": "invalid healthcheck token"}, status=401)
        health = collect_health(notify=False, write_history=False)
        owner_status = health.get("ownerStatus") or {}
        ok = owner_status.get("overall_status") == "OK"
        return self.send_json(
            {
                "ok": ok,
                "ownerStatus": owner_status,
                "generatedAt": health.get("generatedAt"),
            },
            status=200 if ok else 503,
        )

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = internal_path(parsed.path)
        query = urllib.parse.parse_qs(parsed.query)
        if path == "/api/livez":
            return self.send_json({"ok": True, "generatedAt": utc_now()})
        if path == "/api/healthz":
            return self.send_healthz(query)
        if path == "/api/owner-healthz":
            return self.send_owner_healthz(query)
        if path == "/login":
            if self.request_authenticated():
                return self.redirect(query.get("next", ["/"])[0] or "/")
            return self.send_html(login_page())
        if path == "/logout":
            self.send_response(303)
            self.clear_session()
            self.send_header("Location", public_path("/login"))
            self.end_headers()
            return
        auth_result = self.require_auth(path)
        if auth_result is not True:
            return auth_result
        if path in {"/app.js", "/dashboard/app.js"}:
            return self.send_file(STATIC / "app.js", "application/javascript; charset=utf-8")
        if path in {"/styles.css", "/dashboard/styles.css"}:
            return self.send_file(STATIC / "styles.css", "text/css; charset=utf-8")
        if path == "/" or path in {"/dashboard", "/dashboard/"}:
            return self.send_file(STATIC / "index.html", "text/html; charset=utf-8")
        if path == "/api/health":
            return self.send_json(collect_health())
        if path == "/api/status":
            health = collect_health(notify=False, write_history=False)
            return self.send_json(health.get("ownerStatus") or canonical_owner_status(health))
        if path in {"/api/system", "/api/system-config", "/api/config"}:
            snapshot = controller_config_snapshot()
            return self.send_json(snapshot, status=200 if snapshot.get("ok") else 503)
        if path == "/api/pairings":
            snapshot = controller_config_snapshot()
            payload = snapshot if not snapshot.get("ok") else {
                "ok": True,
                "source": snapshot.get("source"),
                "observed_at": snapshot.get("observed_at"),
                "config_hash": snapshot.get("config_hash"),
                "pairings": snapshot.get("pairings") or [],
            }
            return self.send_json(payload, status=200 if snapshot.get("ok") else 503)
        if path == "/api/history":
            days = parse_int(query.get("days", [HISTORY_RETENTION_DAYS])[0]) or HISTORY_RETENTION_DAYS
            days = max(1, min(days, HISTORY_RETENTION_DAYS))
            records = read_history(days)
            return self.send_json(
                {
                    "ok": True,
                    "days": days,
                    "retentionDays": HISTORY_RETENTION_DAYS,
                    "sampleIntervalSeconds": HISTORY_SAMPLE_INTERVAL_SECONDS,
                    "count": len(records),
                    "records": records,
                }
            )
        if path == "/api/researcher-direct-read":
            return self.send_json(collect_researcher_direct_reads())
        if path == "/api/researcher-map":
            return self.send_json(
                [
                    {
                        "physicalPot": pot,
                        "softwarePairing": software,
                        "sensor": sensor,
                        "valve": valve,
                        "note": note,
                    }
                    for pot, software, sensor, valve, note in RESEARCHER_MAP
                ]
            )
        self.send_error(404)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = internal_path(parsed.path)
        content_length = int(self.headers.get("Content-Length") or "0")
        body = self.rfile.read(min(content_length, 64 * 1024)).decode("utf-8", errors="replace")

        if path == "/login":
            form = urllib.parse.parse_qs(body)
            username = (form.get("username") or [""])[0]
            password = (form.get("password") or [""])[0]
            if (
                auth_is_enabled()
                and hmac.compare_digest(username, DASHBOARD_USERNAME)
                and hmac.compare_digest(password, DASHBOARD_PASSWORD)
            ):
                next_path = (urllib.parse.parse_qs(parsed.query).get("next") or ["/"])[0]
                if not next_path.startswith("/") or next_path.startswith("//"):
                    next_path = "/"
                self.send_response(303)
                self.set_session(username)
                self.send_header("Location", public_path(next_path))
                self.end_headers()
                return
            return self.send_html(login_page("Invalid username or password."), status=401)

        auth_result = self.require_auth(path)
        if auth_result is not True:
            return auth_result

        if path == "/api/alert-test":
            errors = send_owner_alert(
                "plain-feather alert test",
                "Owner alert test from the ExactH2O health dashboard.",
                "warning",
            )
            return self.send_json({"ok": not errors, "errors": errors})

        self.send_error(404)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors_headers()
        self.end_headers()

    def do_HEAD(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)
        if path == "/api/livez":
            self.send_response(200)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return
        if path in {"/api/healthz", "/api/owner-healthz"}:
            if not check_bearer_token(self.headers.get("Authorization", ""), query):
                self.send_response(401)
                self.end_headers()
                return
            health = collect_health(notify=False, write_history=False)
            if path == "/api/owner-healthz":
                ok = (health.get("ownerStatus") or {}).get("overall_status") == "OK"
            else:
                ok = health.get("overall", {}).get("level") != "critical"
            self.send_response(200 if ok else 503)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return
        auth_result = self.require_auth(path)
        if auth_result is not True:
            return auth_result
        if path in {"/app.js", "/dashboard/app.js", "/styles.css", "/dashboard/styles.css", "/api/health", "/api/status", "/api/history", "/api/researcher-map", "/api/system", "/api/system-config", "/api/config", "/api/pairings"}:
            self.send_response(200)
            self.send_header("Cache-Control", "no-store")
            self.send_cors_headers()
            self.end_headers()
            return
        if path == "/" or path in {"/dashboard", "/dashboard/"}:
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_cors_headers()
            self.end_headers()
            return
        self.send_error(404)

    def log_message(self, fmt, *args):
        return


def main():
    port = int(os.environ.get("PORT", "8767"))
    host = os.environ.get("HOST", "127.0.0.1")
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"Pi health dashboard listening on http://{host}:{port}")
    print(f"Target API: {API_BASE}")
    print(f"Public URL: {PUBLIC_URL}")
    print(f"Owner login enabled: {auth_is_enabled()}")
    print(f"Owner alerts enabled: {OWNER_ALERTS_ENABLED}")
    threading.Thread(target=history_sampler, daemon=True).start()
    print(f"History file: {HISTORY_FILE}")
    print(f"History retention: {HISTORY_RETENTION_DAYS} days, {HISTORY_SAMPLE_INTERVAL_SECONDS}s interval")
    server.serve_forever()


if __name__ == "__main__":
    main()
