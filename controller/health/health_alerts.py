"""Owner notification delivery, deduplication and cooldown state."""
import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from health_auth import (
    public_path,
)
from health_config import (
    OWNER_ALERTS_ENABLED,
    OWNER_ALERT_COOLDOWN_SECONDS,
    OWNER_ALERT_LEVELS,
    OWNER_ALERT_NTFY_TOPIC,
    OWNER_ALERT_NTFY_URL,
    OWNER_ALERT_STATE_FILE,
    OWNER_ALERT_WEBHOOK_URL,
)
from health_parsing import (
    utc_now,
)


ALERT_STATE_LOCK = threading.Lock()


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
