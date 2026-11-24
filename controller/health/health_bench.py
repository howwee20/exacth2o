"""Read a single inventory-verified probe on the local controller."""
import math
import threading

_capture_lock = threading.Lock()


def bench_capture(query, api_base, fetch_json, parse_reading):
    if query.get("capabilities") == ["1"]:
        return {"singleProbe": True}, 200
    sensor_id = query.get("id", [""])[0]
    key = query.get("key", [""])[0]
    if not sensor_id.isascii() or not sensor_id.isdigit() or not 0 < int(sensor_id) < 2147483648 or not 1 <= len(key) <= 120:
        return {"error": "Select a probe from this controller."}, 400
    if not _capture_lock.acquire(blocking=False):
        return {"error": "Another probe is being read. Try again in a moment."}, 409
    try:
        lookup = fetch_json(f"{api_base}/v1/sensors/{int(sensor_id)}", timeout=5)
        sensor = lookup.get("data") or {}
        if not lookup.get("ok") or not isinstance(sensor, dict):
            return {"error": "The selected probe is unavailable."}, 503
        if f"{sensor.get('boardSerialId')}:{sensor.get('address')}" != key:
            return {"error": "Probe identity changed. Refresh the inventory."}, 409
        result = parse_reading(fetch_json(f"{api_base}/v1/sensors/{int(sensor_id)}/direct-reading/1", timeout=35))
        raw = (result.get("reading") or {}).get("rawValue")
        if not result.get("ok") or type(raw) not in (int, float) or not math.isfinite(raw):
            return {"error": "The probe returned no valid reading."}, 503
        return {"sensorKey": key, "rawValue": raw, "capturedAt": result.get("timestamp")}, 200
    finally:
        _capture_lock.release()
