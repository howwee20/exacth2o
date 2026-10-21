#!/usr/bin/env python3
"""Read-only invocation audit; no device commands or billing changes.

python3 scripts/audit-supabase-usage.py --project-ref REF --hours 24
Uses SUPABASE_ACCESS_TOKEN, or the existing macOS Supabase CLI Keychain entry.
The token stays in process memory. This reports a rate, not a billing invoice.
"""
import argparse
import base64
from datetime import datetime, timedelta, timezone
import json
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.request

INCLUDED_CALLS = 2_000_000
EXPECTED_AGENTS = {"gas-mixer-agent", "gas-mixer-native-agent", "lighting-native-agent"}
QUERY = """select log_attributes['request.pathname'] as path,
log_attributes['response.status_code'] as status, count() as calls
from logs where source='function_edge_logs'
group by path,status order by calls desc limit 1000"""


def summarize(rows, hours):
    if not rows:
        raise ValueError("No log rows; zero usage cannot be confirmed.")
    by_function = {}
    errors = {}
    for row in rows:
        name = row["path"].rsplit("/", 1)[-1]
        calls = int(row["calls"])
        if calls < 0:
            raise ValueError("Invalid negative count")
        by_function[name] = by_function.get(name, 0) + calls
        # Failed requests and preflights also consume invocation quota.
        if int(row["status"] or 0) >= 400:
            errors[name] = errors.get(name, 0) + calls
    total = sum(by_function.values())
    projected = round(total / hours * 24 * 31)
    return {
        "calls_in_window": total,
        "projected_31_day_calls_at_observed_rate": projected,
        "included_calls": INCLUDED_CALLS,
        "quota_percent": round(100 * projected / INCLUDED_CALLS, 1),
        "status": "OVER_BUDGET" if projected > INCLUDED_CALLS else
                  "LOW_HEADROOM" if projected > INCLUDED_CALLS * 0.8 else "WITHIN_BUDGET",
        "calls_by_function": dict(sorted(by_function.items(), key=lambda item: -item[1])),
        "http_errors_by_function": errors,
        "agents_absent_from_window": sorted(EXPECTED_AGENTS - by_function.keys()),
        "caveat": "Observed rate only. Offline agents, interactive sessions, log lag, and future traffic change the forecast; the dashboard controls billing.",
    }


def access_token():
    token = os.environ.get("SUPABASE_ACCESS_TOKEN")
    if token:
        return token
    if sys.platform != "darwin":
        raise RuntimeError("Set SUPABASE_ACCESS_TOKEN to an existing authorized token.")
    result = subprocess.run(
        ["security", "find-generic-password", "-s", "Supabase CLI", "-w"],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    return base64.b64decode(result.split(":", 1)[1]).decode() if result.startswith("go-keyring-base64:") else result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-ref", required=True)
    parser.add_argument("--hours", type=float, default=1)
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z]{20}", args.project_ref) or not 0 < args.hours <= 24:
        parser.error("Use a 20-letter project ref and a window >0 and <=24 hours.")
    # Exclude the latest two minutes to reduce ingestion-lag bias.
    end = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(minutes=2)
    start = end - timedelta(hours=args.hours)
    params = urllib.parse.urlencode({"sql": QUERY, "iso_timestamp_start": start.isoformat().replace("+00:00", "Z"), "iso_timestamp_end": end.isoformat().replace("+00:00", "Z")})
    url = f"https://api.supabase.com/v1/projects/{args.project_ref}/analytics/endpoints/logs?{params}"
    request = urllib.request.Request(url, headers={"Authorization": "Bearer " + access_token()})
    with urllib.request.urlopen(request, timeout=45) as response:
        payload = json.load(response)
    if payload.get("error") or not isinstance(payload.get("result"), list):
        raise RuntimeError("Log query failed; no valid usage measurement available.")
    if len(payload["result"]) >= 1000:
        raise RuntimeError("Result limit reached; refusing to report an incomplete forecast.")
    report = summarize(payload["result"], args.hours)
    report.update(window_start=start.isoformat(), window_end=end.isoformat())
    print(json.dumps(report, indent=2))
    return 2 if report["status"] == "OVER_BUDGET" else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        # Avoid dumping request objects, response bodies, or authentication material.
        print(f"Usage audit failed ({type(error).__name__}); no budget conclusion.", file=sys.stderr)
        sys.exit(1)
