"""Scheduler and Redis diagnostics."""
import socket
from health_config import (
    HOST_SSH_PORT,
    HOST_SSH_TARGET,
    REDIS_HOST,
    REDIS_PORT,
    REDIS_TIMEOUT,
    SCHEDULER_HEALTH_ENABLED,
    SCHEDULER_HEALTH_SOURCE,
)
from health_parsing import (
    parse_int,
    parse_key_value_lines,
)
from health_transport import (
    command_path,
    run_cmd,
)


def redis_read_line(reader):
    line = reader.readline()
    if line.endswith(b"\r\n"):
        line = line[:-2]
    return line


def redis_parse_response(reader):
    prefix = reader.read(1)
    if not prefix:
        raise RuntimeError("empty Redis response")
    if prefix == b"+":
        return redis_read_line(reader).decode("utf-8", errors="replace")
    if prefix == b"-":
        raise RuntimeError(redis_read_line(reader).decode("utf-8", errors="replace"))
    if prefix == b":":
        return int(redis_read_line(reader))
    if prefix == b"$":
        size = int(redis_read_line(reader))
        if size == -1:
            return None
        data = reader.read(size)
        reader.read(2)
        return data.decode("utf-8", errors="replace")
    if prefix == b"*":
        count = int(redis_read_line(reader))
        return [redis_parse_response(reader) for _ in range(count)]
    raise RuntimeError(f"unknown Redis response prefix {prefix!r}")


def redis_command(*args):
    payload = [f"*{len(args)}\r\n".encode("utf-8")]
    for arg in args:
        encoded = str(arg).encode("utf-8")
        payload.append(f"${len(encoded)}\r\n".encode("utf-8"))
        payload.append(encoded + b"\r\n")
    with socket.create_connection((REDIS_HOST, REDIS_PORT), timeout=REDIS_TIMEOUT) as client:
        client.sendall(b"".join(payload))
        with client.makefile("rb") as reader:
            return redis_parse_response(reader)


def redis_count_key(key):
    key_type = redis_command("TYPE", key)
    if key_type == "none":
        return 0
    if key_type == "list":
        return parse_int(redis_command("LLEN", key)) or 0
    if key_type == "zset":
        return parse_int(redis_command("ZCARD", key)) or 0
    if key_type == "set":
        return parse_int(redis_command("SCARD", key)) or 0
    return 0


def redis_scheduler_health():
    try:
        pong = redis_command("PING")
        counts = {
            name: redis_count_key(f"bull:state-transitions:{name}")
            for name in ("wait", "active", "delayed", "completed", "failed")
        }
    except Exception as exc:
        return {
            "available": False,
            "ok": None,
            "source": "redis",
            "error": str(exc),
        }
    total_pending = counts["wait"] + counts["active"] + counts["delayed"]
    return {
        "available": True,
        "ok": total_pending > 0,
        "source": "redis",
        "redisHost": REDIS_HOST,
        "redisPort": REDIS_PORT,
        "redisPing": pong,
        "redisContainer": "redis_svc",
        "cronContainer": "cron_svc",
        "cronInitLastStart": None,
        "cronInitPairings": None,
        "cronApiRefused": 0,
        "cronFetchedZero": 0,
        "cronStateMachineStarted": None,
        "startupFailure": False,
        "counts": counts,
        "totalPending": total_pending,
        "keysCount": None,
    }


def scheduler_health():
    if not SCHEDULER_HEALTH_ENABLED:
        return {"available": False, "ok": None, "error": "scheduler check disabled"}
    if SCHEDULER_HEALTH_SOURCE in {"auto", "redis"}:
        redis_health = redis_scheduler_health()
        if redis_health.get("available") or SCHEDULER_HEALTH_SOURCE == "redis":
            return redis_health
    ssh = command_path("ssh")
    if not ssh:
        return {"available": False, "ok": None, "error": "ssh command not found"}
    script = r"""
set +e
redis="$(balena-engine ps --format '{{.Names}}' | grep redis | head -1)"
cron="$(balena-engine ps --format '{{.Names}}' | grep cron | head -1)"
printf 'redisContainer=%s\n' "$redis"
printf 'cronContainer=%s\n' "$cron"
if [ -n "$cron" ]; then
  balena-engine exec "$cron" node -e "try { const init = require('/app/init.json'); console.log('cronInitLastStart=' + (init.lastStartTime || '')); console.log('cronInitPairings=' + (Array.isArray(init.pairings) ? init.pairings.length : '')); } catch (error) { console.log('cronInitError=' + error.message); }" 2>/dev/null
  recentLogs="$(balena-engine logs --since 15m "$cron" 2>&1)"
  printf 'cronApiRefused=%s\n' "$(printf '%s\n' "$recentLogs" | grep -c 'ECONNREFUSED')"
  printf 'cronFetchedZero=%s\n' "$(printf '%s\n' "$recentLogs" | grep -c 'Total pairings fetched: 0')"
  printf 'cronStateMachineStarted=%s\n' "$(printf '%s\n' "$recentLogs" | grep -c 'State machine started')"
fi
if [ -z "$redis" ]; then exit 0; fi
for state in wait active delayed completed failed; do
  key="bull:state-transitions:$state"
  type="$(balena-engine exec "$redis" redis-cli type "$key" 2>/dev/null | tail -1)"
  count=0
  case "$type" in
    list) count="$(balena-engine exec "$redis" redis-cli llen "$key" 2>/dev/null | tail -1)" ;;
    zset) count="$(balena-engine exec "$redis" redis-cli zcard "$key" 2>/dev/null | tail -1)" ;;
    set) count="$(balena-engine exec "$redis" redis-cli scard "$key" 2>/dev/null | tail -1)" ;;
    none) count=0 ;;
  esac
  printf '%s=%s\n' "$state" "$count"
done
keysCount="$(balena-engine exec "$redis" sh -lc "redis-cli --scan --pattern 'bull:state-transitions:*' | wc -l" 2>/dev/null | tail -1 | tr -d ' ')"
printf 'keysCount=%s\n' "$keysCount"
"""
    result = run_cmd(
        [
            ssh,
            "-p",
            str(HOST_SSH_PORT),
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=4",
            "-o",
            "StrictHostKeyChecking=accept-new",
            HOST_SSH_TARGET,
            script,
        ],
        timeout=9,
    )
    if not result.get("ok"):
        return {
            "available": False,
            "ok": None,
            "source": "host-ssh",
            "error": result.get("error") or result.get("stderr") or "scheduler check failed",
        }
    raw = parse_key_value_lines(result.get("stdout", ""))
    counts = {
        name: parse_int(raw.get(name)) or 0
        for name in ("wait", "active", "delayed", "completed", "failed")
    }
    total_pending = counts["wait"] + counts["active"] + counts["delayed"]
    return {
        "available": True,
        "ok": total_pending > 0,
        "source": "host-ssh",
        "redisContainer": raw.get("redisContainer"),
        "cronContainer": raw.get("cronContainer"),
        "cronInitLastStart": raw.get("cronInitLastStart"),
        "cronInitPairings": parse_int(raw.get("cronInitPairings")),
        "cronApiRefused": parse_int(raw.get("cronApiRefused")) or 0,
        "cronFetchedZero": parse_int(raw.get("cronFetchedZero")) or 0,
        "cronStateMachineStarted": parse_int(raw.get("cronStateMachineStarted")) or 0,
        "startupFailure": (parse_int(raw.get("cronInitPairings")) == 0)
        and ((parse_int(raw.get("cronApiRefused")) or 0) > 0 or (parse_int(raw.get("cronFetchedZero")) or 0) > 0),
        "counts": counts,
        "totalPending": total_pending,
        "keysCount": parse_int(raw.get("keysCount")) or 0,
    }
