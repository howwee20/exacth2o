"""Host, network, container and hardware diagnostics."""
import os
import platform
import shlex
import socket
import shutil
import time
from pathlib import Path
from health_config import (
    BALENA_ENGINE_SOCKET,
    CONTROLLER_IPV4,
    DEVICE_SSH_CONNECT_TIMEOUT,
    EXPECTED_BOARDS,
    EXPECTED_SERVICES,
    HEALTH_SIDECAR_URL,
    HOST_PROC,
    HOST_SYS,
    I2C_BUS,
    PI_ETH_DEVICE,
    REMOTE_HOST_HEALTH_ENABLED,
)
from health_parsing import (
    compact_command,
    ethernet_diagnosis,
    find_inet,
    find_value,
    parse_float,
    parse_i2cdetect,
    parse_int,
    parse_key_value_lines,
    parse_linux_gateway,
    parse_linux_ipv4,
    service_matches,
    undervoltage_state,
)
from health_transport import (
    balena_ssh_args,
    command_path,
    fetch_json,
    fetch_unix_json,
    read_text,
    run_cmd,
    run_cmd_input,
)


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
