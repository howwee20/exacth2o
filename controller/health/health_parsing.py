"""Pure parsing and formatting shared by health collectors."""
from datetime import datetime, timezone


def utc_now():
    return datetime.now(timezone.utc).isoformat()


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


def compact_command(result):
    return {
        "available": result.get("available", True),
        "ok": result.get("ok", False),
        "returncode": result.get("returncode"),
        "error": result.get("error") or result.get("stderr"),
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


def service_matches(name, expected):
    return name == expected or name.endswith(f"_{expected}") or expected in name


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
