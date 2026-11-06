"""Controller API collection and configuration snapshot caching."""
import hashlib
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from health_config import (
    API_BASE,
    API_HTTP_TIMEOUT,
    DEVICE_API_BASE,
    DEVICE_API_SSH_RETRY_TIMEOUT,
    EXPECTED_BOARDS,
    READINGS_PAGE_SIZE,
    WATERING_LOG_LIMIT,
    WATERING_LOOKBACK_DAYS,
)
from health_measurements import (
    compact_collection,
    direct_sensor_read_from_response,
    pairing_reading_rows,
    validate_researcher_map,
    watering_events_from_logs,
    watering_summary,
)
from health_parsing import (
    utc_now,
)
from health_transport import (
    apply_cached_api_responses,
    fetch_api_bundle,
    fetch_device_api_bundle,
    fetch_json,
    fetch_json_post,
    remember_api_responses,
)


CONFIG_SNAPSHOT_CACHE = {"at": 0.0, "value": None}


CONFIG_SNAPSHOT_LOCK = threading.Lock()


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
        "groups": "/v1/groups",
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
    groups = results["groups"]
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
        "groups": compact_collection(groups),
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
        "pairingReadings": pairing_reading_rows(
            pairings.get("data"),
            readings,
            groups.get("data"),
        ),
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
