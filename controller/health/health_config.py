"""Environment configuration for the health service. Importing this module performs no I/O."""
import hashlib
import os
import secrets
from pathlib import Path


ROOT = Path(__file__).resolve().parent


STATIC = ROOT / "static"


DEFAULT_API_BASE = "http://35.8.86.10:8888"


DEFAULT_PUBLIC_URL = "https://3100e37ee3205651fe3dd86dafd4dc0c.balena-devices.com"


API_BASE = os.environ.get("PI_API_BASE", DEFAULT_API_BASE).rstrip("/")


PUBLIC_URL = os.environ.get("PI_PUBLIC_URL", DEFAULT_PUBLIC_URL).rstrip("/")


HEALTH_SIDECAR_URL = os.environ.get("PI_HEALTH_SIDECAR_URL", "http://35.8.86.10:8788").rstrip("/")


API_HTTP_TIMEOUT = float(os.environ.get("PI_API_HTTP_TIMEOUT", "1.5"))


HOST_SSH_TARGET = os.environ.get("PI_HOST_SSH_TARGET", "root@35.8.86.10")


HOST_SSH_PORT = os.environ.get("PI_HOST_SSH_PORT", "22222")


DEVICE_API_BASE = os.environ.get("PI_DEVICE_API_BASE", "http://127.0.0.1:8888").rstrip("/")


DEVICE_ID = os.environ.get("PI_BALENA_DEVICE_ID", "3100e37ee3205651fe3dd86dafd4dc0c")


DEVICE_SSH_TARGET = os.environ.get("PI_BALENA_SSH_TARGET", "basyalbi@ssh.balena-devices.com")


DEVICE_SSH_FALLBACK = os.environ.get("PI_DEVICE_SSH_FALLBACK", "1") != "0"


DEVICE_SSH_CONNECT_TIMEOUT = int(os.environ.get("PI_DEVICE_SSH_CONNECT_TIMEOUT", "12"))


DEVICE_API_SSH_TIMEOUT = int(os.environ.get("PI_DEVICE_API_SSH_TIMEOUT", "18"))


DEVICE_API_SSH_RETRY_TIMEOUT = int(os.environ.get("PI_DEVICE_API_SSH_RETRY_TIMEOUT", "18"))


REMOTE_HOST_HEALTH_ENABLED = os.environ.get("PI_REMOTE_HOST_HEALTH_ENABLED", "1") != "0"


SCHEDULER_HEALTH_ENABLED = os.environ.get("PI_SCHEDULER_HEALTH_ENABLED", "1") != "0"


READINGS_PAGE_SIZE = int(os.environ.get("PI_READINGS_PAGE_SIZE", "500"))


WATERING_LOG_LIMIT = max(1, min(1000, int(os.environ.get("PI_WATERING_LOG_LIMIT", "1000"))))


WATERING_LOOKBACK_DAYS = max(1, int(os.environ.get("PI_WATERING_LOOKBACK_DAYS", "21")))


EXPECTED_BOARDS = [
    item.strip().lower()
    for item in os.environ.get("PI_EXPECTED_BOARDS", "0x20,0x24,0x26").split(",")
    if item.strip()
]


PI_ETH_DEVICE = os.environ.get("PI_ETH_DEVICE", "eth0")


HOST_SYS = Path(os.environ.get("PI_HOST_SYS", "/sys"))


HOST_PROC = Path(os.environ.get("PI_HOST_PROC", "/proc"))


CONTROLLER_IPV4 = os.environ.get("PI_CONTROLLER_IPV4", "")


BALENA_ENGINE_SOCKET = Path(os.environ.get("BALENA_ENGINE_SOCKET", "/var/run/balena-engine.sock"))


SCHEDULER_HEALTH_SOURCE = os.environ.get("PI_SCHEDULER_HEALTH_SOURCE", "auto").lower()


REDIS_HOST = os.environ.get("PI_REDIS_HOST", "127.0.0.1")


REDIS_PORT = int(os.environ.get("PI_REDIS_PORT", "6379"))


REDIS_TIMEOUT = float(os.environ.get("PI_REDIS_TIMEOUT", "2"))


PI_ETHERNET_STATUS_FILE = Path(
    os.environ.get("PI_ETHERNET_STATUS_FILE", str(ROOT / "pi_ethernet_status.json"))
)


I2C_BUS = os.environ.get("PI_I2C_BUS", "1")


EXPECTED_SERVICES = [
    item.strip()
    for item in os.environ.get(
        "PI_EXPECTED_SERVICES",
        "api_svc,ui_svc,cron_svc,database_svc,redis_svc",
    ).split(",")
    if item.strip()
]


DASHBOARD_USERNAME = os.environ.get("DASHBOARD_USERNAME", "")


DASHBOARD_PASSWORD = os.environ.get("DASHBOARD_PASSWORD", "")


DASHBOARD_AUTH_DISABLED = os.environ.get("DASHBOARD_AUTH_DISABLED", "0") == "1"


DASHBOARD_REALM = os.environ.get("DASHBOARD_REALM", "ExactH2O Health")


DASHBOARD_SESSION_SECRET = os.environ.get(
    "DASHBOARD_SESSION_SECRET",
    "",
)


DASHBOARD_SESSION_SECRET = DASHBOARD_SESSION_SECRET or (hashlib.sha256(("ExactH2O dashboard sessions:" + DASHBOARD_PASSWORD).encode()).hexdigest() if DASHBOARD_PASSWORD else secrets.token_hex(32))


DASHBOARD_SESSION_COOKIE = os.environ.get("DASHBOARD_SESSION_COOKIE", "exacth2o_health_session")


DASHBOARD_SESSION_TTL_SECONDS = int(os.environ.get("DASHBOARD_SESSION_TTL_SECONDS", "604800"))


DASHBOARD_COOKIE_SECURE = os.environ.get("DASHBOARD_COOKIE_SECURE", "0") == "1"


PUBLIC_BASE_PATH = os.environ.get("PUBLIC_BASE_PATH", "").rstrip("/")


HEALTHCHECK_TOKEN = os.environ.get("HEALTHCHECK_TOKEN", "")


OWNER_ALERT_NTFY_TOPIC = os.environ.get("OWNER_ALERT_NTFY_TOPIC", "")


OWNER_ALERT_NTFY_URL = os.environ.get("OWNER_ALERT_NTFY_URL", "https://ntfy.sh").rstrip("/")


OWNER_ALERT_WEBHOOK_URL = os.environ.get("OWNER_ALERT_WEBHOOK_URL", "")


OWNER_ALERT_COOLDOWN_SECONDS = int(os.environ.get("OWNER_ALERT_COOLDOWN_SECONDS", "300"))


OWNER_ALERT_LEVELS = {
    item.strip().lower()
    for item in os.environ.get("OWNER_ALERT_LEVELS", "critical").split(",")
    if item.strip()
}


OWNER_ALERT_STATE_FILE = Path(
    os.environ.get("OWNER_ALERT_STATE_FILE", str(ROOT / "owner-alert-state.json"))
)


OWNER_ALERTS_ENABLED = (
    os.environ.get("OWNER_ALERTS_ENABLED", "1") != "0"
    and bool(OWNER_ALERT_NTFY_TOPIC or OWNER_ALERT_WEBHOOK_URL)
)


HISTORY_FILE = Path(os.environ.get("HEALTH_HISTORY_FILE", str(ROOT / "health-history.jsonl")))


HISTORY_RETENTION_DAYS = int(os.environ.get("HEALTH_HISTORY_RETENTION_DAYS", "21"))


HISTORY_SAMPLE_INTERVAL_SECONDS = int(os.environ.get("HEALTH_HISTORY_SAMPLE_INTERVAL_SECONDS", "300"))


HISTORY_MAX_LINES = int(os.environ.get("HEALTH_HISTORY_MAX_LINES", "50000"))
