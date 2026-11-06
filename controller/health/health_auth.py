"""Dashboard authentication, session cookies, and sign-in presentation."""
#!/usr/bin/env python3
import base64
import hashlib
import hmac
import time
from health_config import (
    DASHBOARD_AUTH_DISABLED,
    DASHBOARD_PASSWORD,
    DASHBOARD_SESSION_SECRET,
    DASHBOARD_SESSION_TTL_SECONDS,
    DASHBOARD_USERNAME,
    HEALTHCHECK_TOKEN,
    PUBLIC_BASE_PATH,
)


def auth_is_enabled():
    return (
        not DASHBOARD_AUTH_DISABLED
        and bool(DASHBOARD_USERNAME)
        and bool(DASHBOARD_PASSWORD)
    )


def check_basic_auth(header):
    if not auth_is_enabled():
        return DASHBOARD_AUTH_DISABLED
    if not header or not header.lower().startswith("basic "):
        return False
    token = header.split(" ", 1)[1].strip()
    try:
        decoded = base64.b64decode(token).decode("utf-8")
    except Exception:
        return False
    username, sep, password = decoded.partition(":")
    if not sep:
        return False
    return hmac.compare_digest(username, DASHBOARD_USERNAME) and hmac.compare_digest(
        password,
        DASHBOARD_PASSWORD,
    )


def session_signature(username, issued_at):
    payload = f"{username}:{issued_at}".encode("utf-8")
    return hmac.new(
        DASHBOARD_SESSION_SECRET.encode("utf-8"),
        payload,
        hashlib.sha256,
    ).hexdigest()


def create_session_token(username):
    issued_at = str(int(time.time()))
    signature = session_signature(username, issued_at)
    return base64.urlsafe_b64encode(f"{username}:{issued_at}:{signature}".encode("utf-8")).decode("ascii")


def verify_session_token(token):
    if not auth_is_enabled() or not token:
        return False
    try:
        decoded = base64.urlsafe_b64decode(token.encode("ascii")).decode("utf-8")
    except Exception:
        return False
    username, issued_at, signature = (decoded.split(":", 2) + ["", "", ""])[:3]
    if username != DASHBOARD_USERNAME:
        return False
    try:
        age = int(time.time()) - int(issued_at)
    except Exception:
        return False
    if age < 0 or age > DASHBOARD_SESSION_TTL_SECONDS:
        return False
    expected = session_signature(username, issued_at)
    return hmac.compare_digest(signature, expected)


def parse_cookies(header):
    cookies = {}
    for part in (header or "").split(";"):
        if "=" not in part:
            continue
        key, value = part.strip().split("=", 1)
        cookies[key] = value
    return cookies


def public_path(path):
    if not path.startswith("/"):
        path = f"/{path}"
    return f"{PUBLIC_BASE_PATH}{path}" if PUBLIC_BASE_PATH else path


def internal_path(path):
    if PUBLIC_BASE_PATH and path == PUBLIC_BASE_PATH:
        return "/"
    if PUBLIC_BASE_PATH and path.startswith(f"{PUBLIC_BASE_PATH}/"):
        stripped = path[len(PUBLIC_BASE_PATH):]
        return stripped or "/"
    return path


def login_page(error=""):
    error_html = (
        f'<div class="error">{error}</div>'
        if error
        else ""
    )
    return f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ExactH2O Login</title>
    <style>
      * {{ box-sizing: border-box; }}
      body {{
        margin: 0;
        min-height: 100vh;
        background: #f6f8fb;
        color: #111827;
        font: 15px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        display: grid;
        place-items: center;
        padding: 24px;
      }}
      .card {{
        width: min(100%, 420px);
        background: #fff;
        border: 1px solid #dde3ea;
        border-radius: 8px;
        box-shadow: 0 18px 60px rgba(15, 23, 42, 0.08);
        padding: 28px;
      }}
      .brand {{ color: #64748b; font-size: 12px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }}
      h1 {{ margin: 6px 0 18px; font-size: 28px; line-height: 1.15; letter-spacing: 0; }}
      label {{ display: block; color: #334155; font-weight: 700; margin: 14px 0 6px; }}
      input {{
        width: 100%;
        height: 44px;
        border: 1px solid #cbd5e1;
        border-radius: 8px;
        padding: 0 12px;
        font: inherit;
      }}
      input:focus {{ outline: 3px solid rgba(37, 99, 235, .16); border-color: #2563eb; }}
      button {{
        width: 100%;
        height: 44px;
        margin-top: 18px;
        border: 0;
        border-radius: 8px;
        color: #fff;
        background: #0f172a;
        font-weight: 800;
        cursor: pointer;
      }}
      .error {{
        border: 1px solid #fecdd3;
        background: #fff1f2;
        color: #be123c;
        border-radius: 8px;
        padding: 10px 12px;
        margin: 12px 0;
        font-weight: 700;
      }}
    </style>
  </head>
  <body>
    <form class="card" method="post" action="{public_path('/login')}">
      <div class="brand">ExactH2O</div>
      <h1>System Health</h1>
      {error_html}
      <label for="username">Email or username</label>
      <input id="username" name="username" autocomplete="username" required />
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required />
      <button type="submit">Sign in</button>
    </form>
  </body>
</html>"""


def check_bearer_token(header, query):
    if not HEALTHCHECK_TOKEN:
        return check_basic_auth(header)
    expected = HEALTHCHECK_TOKEN
    candidate = ""
    if header and header.lower().startswith("bearer "):
        candidate = header.split(" ", 1)[1].strip()
    if not candidate:
        candidate = query.get("token", [""])[0]
    return hmac.compare_digest(candidate, expected)
