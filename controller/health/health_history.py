"""Local history retention, storage and restart summaries."""
import json
import threading
import time
from health_config import (
    HISTORY_FILE,
    HISTORY_MAX_LINES,
    HISTORY_RETENTION_DAYS,
    HISTORY_SAMPLE_INTERVAL_SECONDS,
)
from health_parsing import (
    iso_minus_seconds,
    iso_to_ts,
    parse_float,
    utc_now,
)


HISTORY_LOCK = threading.Lock()


HISTORY_LAST_WRITE = 0


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
