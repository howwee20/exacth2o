"""Read-only measurement, pairing and historical assignment interpretation."""
import time
from health_parsing import (
    iso_to_ts,
    parse_int,
)


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
    # Software assignments in revision 08afcbb9 (2026-08-02), also confirmed
    # by the current controller configuration. This is not physical verification.
    (93, "Zone4-Pot93", "D30GQN2E:o", "0x20:46", "software assignment updated July 23"),
    (94, "Zone4-Pot94", "D30GQN2E:s", "0x20:47", "standard"),
    (95, "Zone4-Pot95", "D30GQN2E:r", "0x20:48", "software assignment updated July 23"),
    (96, "Zone4-Pot96", "D30GQN2E:u", "0x20:39", "piped from row 86"),
    (97, "Zone4-Pot97", "D30GQN2E:v", "0x20:40", "piped from row 87"),
    (98, "Zone4-Pot98", "D30GQN2E:w", "0x20:41", "piped from row 88"),
    (99, "Zone4-Pot99", "D30GQN2E:x", "0x20:42", "piped from row 89"),
    (100, "Zone4-Pot100", "D30GQN2E:2", "0x20:43", "piped from row 90"),
]


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


def pairing_reading_rows(pairings, readings_response=None, groups=None):
    """Return every configured pairing with its latest measurement evidence."""
    if not isinstance(pairings, list):
        return {"ok": False, "rows": [], "error": "pairings unavailable"}
    latest = latest_readings_by_sensor(readings_response or {})
    group_names = {
        group.get("id"): group.get("name")
        for group in (groups or [])
        if isinstance(group, dict)
    }
    rows = []
    for pairing in pairings:
        if not isinstance(pairing, dict):
            continue
        sensor_id = pairing.get("sensorId")
        valve_id = pairing.get("valveId")
        rows.append({
            "ok": bool(pairing.get("name") and sensor_id is not None and valve_id is not None),
            "actualName": pairing.get("name"),
            "softwarePairing": pairing.get("name"),
            "sensorId": sensor_id,
            "valveId": valve_id,
            "actualSensor": pairing_sensor_key(pairing),
            "actualValve": pairing_valve_key(pairing),
            "groupId": pairing.get("groupId"),
            "groupName": group_names.get(pairing.get("groupId")),
            "calibrationId": pairing.get("calibrationId"),
            "calibrationName": (pairing.get("Calibration") or {}).get("name"),
            "WTCPercentLimit": pairing.get("WTCPercentLimit"),
            "ValveOpenTime": pairing.get("ValveOpenTime"),
            "MeasurementInterval": pairing.get("MeasurementInterval"),
            "latestReading": compact_reading(latest.get(sensor_id)),
        })
    return {"ok": True, "rows": rows}


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
        pair_id = message.split("Opened Valve: ", 1)[1].strip().split()[0].rstrip(";,:")
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
