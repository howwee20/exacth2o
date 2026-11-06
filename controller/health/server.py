"""Health service HTTP entry point and background sampling orchestration."""
import hmac
import json
import os
import socket
import threading
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from health_alerts import (
    maybe_send_owner_alert,
    read_alert_state,
    send_owner_alert,
)
from health_auth import (
    auth_is_enabled,
    check_basic_auth,
    check_bearer_token,
    create_session_token,
    internal_path,
    login_page,
    parse_cookies,
    public_path,
    verify_session_token,
)
from health_config import (
    API_BASE,
    DASHBOARD_AUTH_DISABLED,
    DASHBOARD_COOKIE_SECURE,
    DASHBOARD_PASSWORD,
    DASHBOARD_SESSION_COOKIE,
    DASHBOARD_SESSION_TTL_SECONDS,
    DASHBOARD_USERNAME,
    EXPECTED_BOARDS,
    HEALTH_SIDECAR_URL,
    HISTORY_FILE,
    HISTORY_RETENTION_DAYS,
    HISTORY_SAMPLE_INTERVAL_SECONDS,
    OWNER_ALERTS_ENABLED,
    OWNER_ALERT_LEVELS,
    PI_ETH_DEVICE,
    PUBLIC_BASE_PATH,
    PUBLIC_URL,
    STATIC,
)
from health_controller import (
    api_health,
    collect_researcher_direct_reads,
    controller_config_snapshot,
)
from health_history import (
    read_history,
    record_history,
)
from health_host import (
    mac_network_health,
    pi_local_health,
)
from health_measurements import (
    RESEARCHER_MAP,
)
from health_parsing import (
    parse_int,
    utc_now,
)
from health_scheduler import (
    scheduler_health,
)
from health_status import (
    canonical_owner_status,
    overall_status,
)
from health_transport import (
    confirmed_pi_ethernet_health,
    fetch_head,
)


SAMPLER_STOP = threading.Event()


SAMPLER_RUNNING = False


def public_url_health():
    checks = {
        "dashboard": f"{PUBLIC_URL}/dashboard",
        "ownerHealth": f"{PUBLIC_URL}{public_path('/')}",
        "systemConfig": f"{PUBLIC_URL}/system-config",
    }
    with ThreadPoolExecutor(max_workers=len(checks)) as executor:
        futures = {name: executor.submit(fetch_head, url) for name, url in checks.items()}
        results = {name: future.result() for name, future in futures.items()}
    return {
        "url": PUBLIC_URL,
        "dashboard": results["dashboard"],
        "ownerHealth": results["ownerHealth"],
        "systemConfig": results["systemConfig"],
    }


def history_sampler():
    global SAMPLER_RUNNING
    if SAMPLER_RUNNING:
        return
    SAMPLER_RUNNING = True
    while not SAMPLER_STOP.is_set():
        try:
            health = collect_health(notify=True, write_history=False)
            record_history(health, force=True)
        except Exception as exc:
            try:
                HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
                with HISTORY_FILE.open("a") as handle:
                    handle.write(
                        json.dumps(
                            {
                                "t": utc_now(),
                                "level": "critical",
                                "title": "Sampler error",
                                "issues": 1,
                                "warnings": 0,
                                "apiOk": False,
                                "publicOk": False,
                                "ethUp": False,
                                "undervoltage": False,
                                "error": str(exc)[:240],
                            },
                            separators=(",", ":"),
                        )
                        + "\n"
                    )
            except Exception:
                pass
        SAMPLER_STOP.wait(max(60, HISTORY_SAMPLE_INTERVAL_SECONDS))


def collect_health(notify=True, write_history=True):
    health = {
        "generatedAt": utc_now(),
        "host": socket.gethostname(),
        "environment": {
            "apiBase": API_BASE,
            "publicUrl": PUBLIC_URL,
            "healthSidecarUrl": HEALTH_SIDECAR_URL,
            "expectedBoards": EXPECTED_BOARDS,
            "piEthDevice": PI_ETH_DEVICE,
            "authEnabled": auth_is_enabled(),
            "ownerAlertsEnabled": OWNER_ALERTS_ENABLED,
        },
        "confirmedPiEthernet": confirmed_pi_ethernet_health(),
        "network": mac_network_health(),
        "api": api_health(),
        "publicUrl": public_url_health(),
        "piLocal": pi_local_health(),
        "scheduler": scheduler_health(),
    }
    health["overall"] = overall_status(health)
    health["ownerStatus"] = canonical_owner_status(health)
    health["ownerAlerts"] = {
        "enabled": OWNER_ALERTS_ENABLED,
        "levels": sorted(OWNER_ALERT_LEVELS),
        "lastState": read_alert_state(),
    }
    if notify:
        maybe_send_owner_alert(health)
    if write_history:
        record_history(health)
    return health


class Handler(BaseHTTPRequestHandler):
    def send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def send_json(self, payload, status=200):
        body = json.dumps(payload, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_cors_headers()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path, content_type):
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-cache")
        self.send_cors_headers()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_html(self, html, status=200):
        body = html.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def redirect(self, location):
        if location.startswith("/") and not location.startswith("//"):
            location = public_path(location)
        self.send_response(303)
        self.send_header("Location", location)
        self.end_headers()

    def clear_session(self):
        attrs = [
            f"{DASHBOARD_SESSION_COOKIE}=",
            f"Path={PUBLIC_BASE_PATH or '/'}",
            "Max-Age=0",
            "HttpOnly",
            "SameSite=Lax",
        ]
        if DASHBOARD_COOKIE_SECURE:
            attrs.append("Secure")
        self.send_header("Set-Cookie", "; ".join(attrs))

    def set_session(self, username):
        attrs = [
            f"{DASHBOARD_SESSION_COOKIE}={create_session_token(username)}",
            f"Path={PUBLIC_BASE_PATH or '/'}",
            f"Max-Age={DASHBOARD_SESSION_TTL_SECONDS}",
            "HttpOnly",
            "SameSite=Lax",
        ]
        if DASHBOARD_COOKIE_SECURE:
            attrs.append("Secure")
        self.send_header("Set-Cookie", "; ".join(attrs))

    def request_authenticated(self):
        if not auth_is_enabled():
            return DASHBOARD_AUTH_DISABLED
        cookies = parse_cookies(self.headers.get("Cookie", ""))
        if verify_session_token(cookies.get(DASHBOARD_SESSION_COOKIE, "")):
            return True
        return check_basic_auth(self.headers.get("Authorization", ""))

    def require_auth(self, path):
        if self.request_authenticated():
            return True
        if path.startswith("/api/"):
            return self.send_json({"ok": False, "error": "authentication required"}, status=401)
        next_path = urllib.parse.quote(path if path.startswith("/") else "/", safe="/")
        return self.redirect(f"/login?next={next_path}")

    def send_healthz(self, query):
        if not check_bearer_token(self.headers.get("Authorization", ""), query):
            return self.send_json({"ok": False, "error": "invalid healthcheck token"}, status=401)
        health = collect_health(notify=False, write_history=False)
        overall = health.get("overall") or {}
        owner_status = health.get("ownerStatus") or {}
        level = overall.get("level")
        ok = level != "critical"
        return self.send_json(
            {
                "ok": ok,
                "level": level,
                "title": overall.get("title"),
                "ownerStatus": owner_status,
                "generatedAt": health.get("generatedAt"),
                "issues": overall.get("issues") or [],
                "warnings": overall.get("warnings") or [],
            },
            status=200 if ok else 503,
        )

    def send_owner_healthz(self, query):
        if not check_bearer_token(self.headers.get("Authorization", ""), query):
            return self.send_json({"ok": False, "error": "invalid healthcheck token"}, status=401)
        health = collect_health(notify=False, write_history=False)
        owner_status = health.get("ownerStatus") or {}
        ok = owner_status.get("overall_status") == "OK"
        return self.send_json(
            {
                "ok": ok,
                "ownerStatus": owner_status,
                "generatedAt": health.get("generatedAt"),
            },
            status=200 if ok else 503,
        )

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = internal_path(parsed.path)
        query = urllib.parse.parse_qs(parsed.query)
        if path == "/api/livez":
            return self.send_json({"ok": True, "generatedAt": utc_now()})
        if path == "/api/healthz":
            return self.send_healthz(query)
        if path == "/api/owner-healthz":
            return self.send_owner_healthz(query)
        if path == "/login":
            if self.request_authenticated():
                return self.redirect(query.get("next", ["/"])[0] or "/")
            return self.send_html(login_page())
        if path == "/logout":
            self.send_response(303)
            self.clear_session()
            self.send_header("Location", public_path("/login"))
            self.end_headers()
            return
        auth_result = self.require_auth(path)
        if auth_result is not True:
            return auth_result
        if path in {"/app.js", "/dashboard/app.js"}:
            return self.send_file(STATIC / "app.js", "application/javascript; charset=utf-8")
        if path in {"/styles.css", "/dashboard/styles.css"}:
            return self.send_file(STATIC / "styles.css", "text/css; charset=utf-8")
        if path == "/" or path in {"/dashboard", "/dashboard/"}:
            return self.send_file(STATIC / "index.html", "text/html; charset=utf-8")
        if path == "/api/health":
            return self.send_json(collect_health())
        if path == "/api/status":
            health = collect_health(notify=False, write_history=False)
            return self.send_json(health.get("ownerStatus") or canonical_owner_status(health))
        if path in {"/api/system", "/api/system-config", "/api/config"}:
            snapshot = controller_config_snapshot()
            return self.send_json(snapshot, status=200 if snapshot.get("ok") else 503)
        if path == "/api/pairings":
            snapshot = controller_config_snapshot()
            payload = snapshot if not snapshot.get("ok") else {
                "ok": True,
                "source": snapshot.get("source"),
                "observed_at": snapshot.get("observed_at"),
                "config_hash": snapshot.get("config_hash"),
                "pairings": snapshot.get("pairings") or [],
            }
            return self.send_json(payload, status=200 if snapshot.get("ok") else 503)
        if path == "/api/history":
            days = parse_int(query.get("days", [HISTORY_RETENTION_DAYS])[0]) or HISTORY_RETENTION_DAYS
            days = max(1, min(days, HISTORY_RETENTION_DAYS))
            records = read_history(days)
            return self.send_json(
                {
                    "ok": True,
                    "days": days,
                    "retentionDays": HISTORY_RETENTION_DAYS,
                    "sampleIntervalSeconds": HISTORY_SAMPLE_INTERVAL_SECONDS,
                    "count": len(records),
                    "records": records,
                }
            )
        if path == "/api/researcher-direct-read":
            return self.send_json(collect_researcher_direct_reads())
        if path == "/api/researcher-map":
            return self.send_json(
                [
                    {
                        "physicalPot": pot,
                        "softwarePairing": software,
                        "sensor": sensor,
                        "valve": valve,
                        "note": note,
                    }
                    for pot, software, sensor, valve, note in RESEARCHER_MAP
                ]
            )
        self.send_error(404)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = internal_path(parsed.path)
        content_length = int(self.headers.get("Content-Length") or "0")
        body = self.rfile.read(min(content_length, 64 * 1024)).decode("utf-8", errors="replace")

        if path == "/api/manual-hold":
            expected = os.environ.get("EXACTH2O_MANUAL_HOLD_SECRET", "")
            supplied = self.headers.get("X-ExactH2O-Hold-Secret", "")
            if not expected or not hmac.compare_digest(supplied, expected):
                return self.send_json({"error": "Hold authentication required"}, status=401)
            try:
                payload = json.loads(body)
                if payload.get("action") not in ("start", "renew", "stop", "status"):
                    return self.send_json({"error": "Invalid hold action"}, status=400)
                req = urllib.request.Request(
                    "http://cron_svc:3000/v1/valves/hold", data=json.dumps(payload).encode(),
                    headers={"Content-Type": "application/json", "X-ExactH2O-Hold-Secret": expected}, method="POST")
                with urllib.request.urlopen(req, timeout=3) as result:
                    return self.send_json(json.load(result))
            except urllib.error.HTTPError as error:
                return self.send_json(json.loads(error.read()), status=error.code)
            except Exception:
                return self.send_json({"error": "Controller connection lost; hold will expire locally"}, status=503)

        if path == "/login":
            form = urllib.parse.parse_qs(body)
            username = (form.get("username") or [""])[0]
            password = (form.get("password") or [""])[0]
            if (
                auth_is_enabled()
                and hmac.compare_digest(username, DASHBOARD_USERNAME)
                and hmac.compare_digest(password, DASHBOARD_PASSWORD)
            ):
                next_path = (urllib.parse.parse_qs(parsed.query).get("next") or ["/"])[0]
                if not next_path.startswith("/") or next_path.startswith("//"):
                    next_path = "/"
                self.send_response(303)
                self.set_session(username)
                self.send_header("Location", public_path(next_path))
                self.end_headers()
                return
            return self.send_html(login_page("Invalid username or password."), status=401)

        auth_result = self.require_auth(path)
        if auth_result is not True:
            return auth_result

        if path == "/api/alert-test":
            errors = send_owner_alert(
                "plain-feather alert test",
                "Owner alert test from the ExactH2O health dashboard.",
                "warning",
            )
            return self.send_json({"ok": not errors, "errors": errors})

        self.send_error(404)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors_headers()
        self.end_headers()

    def do_HEAD(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)
        if path == "/api/livez":
            self.send_response(200)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return
        if path in {"/api/healthz", "/api/owner-healthz"}:
            if not check_bearer_token(self.headers.get("Authorization", ""), query):
                self.send_response(401)
                self.end_headers()
                return
            health = collect_health(notify=False, write_history=False)
            if path == "/api/owner-healthz":
                ok = (health.get("ownerStatus") or {}).get("overall_status") == "OK"
            else:
                ok = health.get("overall", {}).get("level") != "critical"
            self.send_response(200 if ok else 503)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return
        auth_result = self.require_auth(path)
        if auth_result is not True:
            return auth_result
        if path in {"/app.js", "/dashboard/app.js", "/styles.css", "/dashboard/styles.css", "/api/health", "/api/status", "/api/history", "/api/researcher-map", "/api/system", "/api/system-config", "/api/config", "/api/pairings"}:
            self.send_response(200)
            self.send_header("Cache-Control", "no-store")
            self.send_cors_headers()
            self.end_headers()
            return
        if path == "/" or path in {"/dashboard", "/dashboard/"}:
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_cors_headers()
            self.end_headers()
            return
        self.send_error(404)

    def log_message(self, fmt, *args):
        return


def main():
    port = int(os.environ.get("PORT", "8767"))
    host = os.environ.get("HOST", "127.0.0.1")
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"Pi health dashboard listening on http://{host}:{port}")
    print(f"Target API: {API_BASE}")
    print(f"Public URL: {PUBLIC_URL}")
    print(f"Owner login enabled: {auth_is_enabled()}")
    print(f"Owner alerts enabled: {OWNER_ALERTS_ENABLED}")
    threading.Thread(target=history_sampler, daemon=True).start()
    print(f"History file: {HISTORY_FILE}")
    print(f"History retention: {HISTORY_RETENTION_DAYS} days, {HISTORY_SAMPLE_INTERVAL_SECONDS}s interval")
    server.serve_forever()


if __name__ == "__main__":
    main()
