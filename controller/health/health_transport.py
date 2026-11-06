"""HTTP, SSH, command and socket transports, with API response caching."""
import json
import shlex
import socket
import ssl
import subprocess
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from health_config import (
    API_BASE,
    API_HTTP_TIMEOUT,
    DEVICE_API_BASE,
    DEVICE_API_SSH_RETRY_TIMEOUT,
    DEVICE_API_SSH_TIMEOUT,
    DEVICE_ID,
    DEVICE_SSH_CONNECT_TIMEOUT,
    DEVICE_SSH_FALLBACK,
    DEVICE_SSH_TARGET,
    PI_ETHERNET_STATUS_FILE,
)


API_RESPONSE_CACHE = {}


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
