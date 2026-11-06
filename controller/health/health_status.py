"""Combines collected diagnostics into owner-facing status and alerts."""
import time
from health_config import (
    EXPECTED_BOARDS,
)
from health_history import (
    recent_restart_summary,
)
from health_parsing import (
    iso_to_ts,
    parse_int,
)


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
    # The scheduler serves every configured pairing, not only the legacy
    # 20-pot researcher map. Compare counts only with a successful API read.
    pairing_inventory = api.get("pairings") or {}
    configured_jobs = pairing_inventory.get("count") if pairing_inventory.get("ok") else None
    scheduler_diag = scheduler_diagnostics(scheduler, configured_jobs)
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
            f"Scheduler has {scheduler_diag['jobsLoaded']} pending jobs for {configured_jobs} configured pairings; inspect the {scheduler_diag['extraJobsLoaded']} excess jobs."
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
