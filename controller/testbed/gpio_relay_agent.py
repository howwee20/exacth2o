#!/usr/bin/env python3
"""Own four GPIO lines continuously; accept only independently timed pulses.

Only --serve imports lgpio or accesses GPIO. --client only uses a local socket.
Line offsets, chip identity and relay polarity must be explicitly configured.
"""
import argparse
import json
import uuid
import os
import signal
import socket
import sys
import time
from pathlib import Path


def config_from(raw):
    if not raw:
        raise ValueError("gpio4 requires EXACTH2O_GPIO_RELAY_CONFIG with verified wiring")
    c = json.loads(raw)
    integer = lambda x: type(x) is int
    if (not isinstance(c, dict)
        or not integer(c.get("boardAddress")) or not 3 <= c["boardAddress"] <= 119
        or not integer(c.get("chip")) or not 0 <= c["chip"] <= 63
        or not isinstance(c.get("chipLabel"), str) or not c["chipLabel"].strip()
        or not isinstance(c.get("lineOffsets"), list) or len(c["lineOffsets"]) != 4
        or any(not integer(x) or not 0 <= x <= 27 for x in c["lineOffsets"])
        or len(set(c["lineOffsets"])) != 4
        or not integer(c.get("activeLevel")) or c["activeLevel"] not in (0, 1)):
        raise ValueError("invalid gpio4 wiring: require boardAddress, chip, chipLabel, four unique lineOffsets and activeLevel")
    return {k: c[k] for k in ("boardAddress", "chip", "chipLabel", "lineOffsets", "activeLevel")}


class LgpioOutputs:
    def __init__(self, config, lgpio):
        self.config, self.lgpio = config, lgpio
        self.handle = lgpio.gpiochip_open(config["chip"])
        self.check(self.handle)
        self.claimed = []
        try:
            info = lgpio.gpio_get_chip_info(self.handle)
            if not isinstance(info, (list, tuple)) or len(info) != 4 or info[0] != 0 or info[3] != config["chipLabel"]:
                raise ValueError("gpiochip label does not match the verified configuration")
            for pin in config["lineOffsets"]:
                self.check(lgpio.gpio_claim_output(self.handle, pin, 1 - config["activeLevel"]))
                self.claimed.append(pin)
        except BaseException:
            self.shutdown()
            raise

    @staticmethod
    def check(result):
        if type(result) is int and result < 0:
            raise OSError("lgpio operation failed: " + str(result))

    def write(self, channel, active):
        pin = self.config["lineOffsets"][channel - 1]
        self.check(self.lgpio.gpio_write(self.handle, pin, self.config["activeLevel"] if active else 1 - self.config["activeLevel"]))

    def close_all(self):
        failures = []
        for channel in range(1, 5):
            if self.config["lineOffsets"][channel - 1] not in self.claimed:
                continue
            try: self.write(channel, False)
            except BaseException as error: failures.append(str(error))
        if failures: raise OSError("GPIO close unconfirmed: " + "; ".join(failures))

    def shutdown(self):
        try: self.close_all()
        finally: self.check(self.lgpio.gpiochip_close(self.handle))


class RelayAgent:
    def __init__(self, config, outputs, clock=time.monotonic, load=lambda: {}, save=lambda state: None):
        self.config, self.outputs, self.clock, self.save = config, outputs, clock, save
        self.active = None
        self.hold = None
        previous = load()
        self.tripped = bool(previous.get("tripped", False))
        self.records = dict(previous.get("records", {}))
        self.holds = dict(previous.get("holds", {}))
        for record in self.holds.values():
            if record.get('status') in ('open','requested'): record.update(status='closed', endReason='recovered_after_restart', closedAt=time.time())
        # Initial claim already uses OFF levels; explicitly close all before serving.
        self.outputs.close_all()
        self.persist()

    def persist(self):
        self.save({"tripped": self.tripped, "records": dict(self.records), "holds": dict(self.holds)})

    def status(self):
        return {"ok": True, "config": self.config, "tripped": self.tripped,
                "hold": self.hold_reply(self.hold["sessionId"] if self.hold else None),
                "active": None if self.active is None else {"channel": self.active["channel"], "pulseId": self.active["pulseId"],
                  "remainingMs": max(0, round((self.active["deadline"] - self.clock()) * 1000))}}

    def close_all(self, reason):
        # Retain active ownership on failure, and retry closure on every event-loop tick.
        self.outputs.close_all()
        self.close_hold(reason)
        if self.active:
            self.records[self.active["pulseId"]]["status"] = reason
        self.active = None

    def hold_reply(self, session_id=None):
        record = self.holds.get(session_id, {})
        active = self.hold
        return {"ok": True, "available": True, "ready": not self.tripped,
                "busy": active is not None and active['sessionId'] != session_id,
                "status": 'open' if active and active['sessionId'] == session_id else 'closed',
                "endReason": record.get('endReason'), "openedAt": record.get("openedAt"), "closedAt": record.get("closedAt"), "sequence": record.get('sequence', 0),
                "activeOwnerId": active.get('ownerId') if active else None,
                "openedForMs": round((self.clock()-active['openedMono'])*1000) if active else 0,
                "remainingMs": max(0,round((active['deadline']-self.clock())*1000)) if active else 0,
                "leaseMilliseconds": 2500, "maxContinuousMilliseconds": None,
                "automaticSuspended": True, "configRewrite": False,
                "activeRoute": {"relayAddress": self.config['boardAddress'], "address": active['channel']} if active else None}

    def close_hold(self, reason):
        if self.hold:
            self.outputs.write(self.hold['channel'], False)
            record = self.holds[self.hold['sessionId']]
            record.update(status='closed', endReason=reason, closedAt=time.time())
            self.hold = None
            self.persist()

    def dispatch_hold(self, request):
        action = request.get('action')
        session_id = request.get('sessionId')
        owner = request.get('ownerId')
        sequence = request.get('sequence')
        if action == 'status': return self.hold_reply(session_id)
        try: uuid.UUID(session_id)
        except (ValueError, TypeError, AttributeError): raise ValueError('Invalid hold session')
        if not owner or type(sequence) is not int or sequence < 0: raise ValueError('Invalid hold owner or sequence')
        record = self.holds.get(session_id)
        if record and record.get('ownerId') != owner: raise ValueError('Hold owner mismatch')
        if action == 'stop':
            if self.hold and self.hold['sessionId'] == session_id: self.close_hold('released')
            self.holds[session_id] = {**(record or {}), 'ownerId': owner, 'sequence': max(sequence, (record or {}).get('sequence', 0)), 'status':'closed', 'endReason':'released', 'closedAt':time.time()}
            self.persist()
            return self.hold_reply(session_id)
        if action not in ('start', 'renew'): raise ValueError('Invalid hold action')
        channel = request.get('address')
        if type(channel) is not int or channel not in (1,2,3,4) or request.get('relayAddress') != self.config['boardAddress']:
            raise ValueError('Unknown hold route')
        expires = request.get('expiresAt')
        if type(expires) not in (float,int) or not 0 < expires-time.time()*1000 <= 3000:
            raise ValueError('Hold signal expired')
        if record:
            if record.get('status') == 'closed': return self.hold_reply(session_id)
            if record.get('channel') != channel: raise ValueError('Hold route changed')
            if sequence <= record.get('sequence', -1): return self.hold_reply(session_id)
        if self.tripped or self.active: raise ValueError('Relay is unavailable')
        if self.hold and self.hold['sessionId'] != session_id: raise ValueError('Another hold is active')
        if action == 'renew' and not self.hold: return self.hold_reply(session_id)
        if not self.hold:
            self.holds[session_id] = {'ownerId':owner,'channel':channel,'sequence':sequence,'status':'requested','openedAt':time.time()}
            self.persist()
            self.hold = {'sessionId':session_id,'ownerId':owner,'channel':channel,'openedMono':self.clock(),'deadline':self.clock()+(expires-time.time()*1000)/1000}
            try: self.outputs.write(channel,True)
            except BaseException:
                self.tripped=True
                self.close_hold('start_failed')
                raise
        self.hold['deadline'] = self.clock()+max(0,(expires-time.time()*1000)/1000)
        self.holds[session_id].update(status='open',sequence=sequence,delivered=True)
        return self.hold_reply(session_id)

    def tick(self):
        if self.hold and (self.tripped or self.clock() >= self.hold['deadline']):
            self.close_hold('expired')
        if self.tripped or (self.active and self.clock() >= self.active["deadline"]):
            was_active = self.active is not None
            self.close_all("closed")
            if was_active: self.persist()

    def dispatch(self, request):
        self.tick()
        if not isinstance(request, dict): raise ValueError("request must be an object")
        op = request.get("op")
        if op == "hold": return self.dispatch_hold(request)
        if op == "status": return self.status()
        if op == "trip":
            if self.tripped:
                self.close_all("watchdog_trip")
                return self.status()
            self.tripped = True
            self.close_all("watchdog_trip")
        elif op == "reconcile":
            self.close_all("reconciled")
            self.tripped = False
        elif op == "close_all": self.close_all("closed")
        elif op in ("pulse", "close"):
            channel = request.get("channel")
            if type(channel) is not int or not 1 <= channel <= 4: raise ValueError("invalid relay channel")
            if op == "close":
                self.outputs.write(channel, False)
                if self.active and self.active["channel"] == channel:
                    self.records[self.active["pulseId"]]["status"] = "closed"
                    self.active = None
                elif self.active:
                    # No state changed; never block the active deadline on disk I/O.
                    return self.status()
            else:
                duration, pulse_id = request.get("durationMilliseconds"), request.get("pulseId")
                if type(duration) is not int or not 1 <= duration <= 60000:
                    raise ValueError("timed pulse must be 1–60000 ms")
                if not isinstance(pulse_id, str) or not 1 <= len(pulse_id) <= 200: raise ValueError("pulseId required")
                prior = self.records.get(pulse_id)
                identity = {"channel": channel, "durationMilliseconds": duration}
                if prior:
                    if any(prior[k] != v for k, v in identity.items()): raise ValueError("pulseId reused with different request")
                    return {**self.status(), "replayed": True}
                if self.tripped: raise ValueError("GPIO relay watchdog lockout requires reconciliation")
                if self.active or self.hold: raise ValueError("another GPIO relay operation is already active")
                self.records[pulse_id] = {**identity, "status": "requested"}
                # Remember before opening, so agent restart can never replay this pulse.
                self.persist()
                self.active = {"channel": channel, "pulseId": pulse_id, "deadline": self.clock() + duration / 1000}
                try:
                    self.outputs.write(channel, True)
                except BaseException:
                    self.tripped = True
                    self.close_all("open_failed")
                    self.persist()
                    raise
                # Durable intent was saved while all relays were off. No filesystem
                # work is allowed to delay the event-loop timer while a relay is on.
                return self.status()
        else: raise ValueError("unsupported relay operation")
        self.persist()
        return self.status()


def socket_path():
    return os.environ.get("EXACTH2O_GPIO_RELAY_SOCKET", "/run/exacth2o-relay/relay.sock")


def client(request):
    encoded = json.dumps(request).encode() + b"\n"
    if len(encoded) > 4096: raise ValueError("request too large")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(1.0)
        sock.connect(socket_path())
        sock.sendall(encoded)
        data = b""
        while b"\n" not in data:
            part = sock.recv(16384)
            if not part: raise OSError("relay agent disconnected without a reply")
            data += part
            if len(data) > 16384: raise ValueError("reply too large")
        return json.loads(data.split(b"\n", 1)[0])


def serve():
    config = config_from(os.environ.get("EXACTH2O_GPIO_RELAY_CONFIG"))
    # lgpio creates a notification FIFO during import even for output-only use.
    # Keep it in the private writable runtime volume, never the source directory.
    runtime = Path(socket_path()).parent
    runtime.mkdir(parents=True, exist_ok=True)
    os.chdir(runtime)
    import lgpio  # Only the dedicated, explicitly configured service accesses GPIO.
    state_path = Path(os.environ.get("EXACTH2O_GPIO_RELAY_STATE", "/data/gpio-relays.json"))
    def load():
        try: return json.loads(state_path.read_text())
        except FileNotFoundError: return {}
    def save(state):
        state_path.parent.mkdir(parents=True, exist_ok=True)
        temp = state_path.with_suffix(".tmp")
        with temp.open("w") as f:
            json.dump(state, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, state_path)
    outputs = LgpioOutputs(config, lgpio)
    listener = None
    path = Path(socket_path())
    try:
        agent = RelayAgent(config, outputs, load=load, save=save)
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            # Never unlink a live agent's socket and create a second owner.
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
                try: probe.connect(str(path))
                except ConnectionRefusedError: path.unlink()
                else: raise OSError("a relay agent is already serving this socket")
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(str(path))
        os.chmod(path, 0o660)
        listener.listen(8)
        listener.settimeout(0.02)
        def stop(*_): raise KeyboardInterrupt()
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        while True:
            try: agent.tick()
            except Exception:
                agent.tripped = True
                # A failing close is retried every tick; never accept another pulse.
                time.sleep(0.02)
                continue
            try: conn, _ = listener.accept()
            except socket.timeout: continue
            with conn:
                conn.settimeout(0.05)
                try:
                    data = b""
                    request_deadline = time.monotonic() + 0.05
                    while b"\n" not in data:
                        agent.tick()
                        remaining = request_deadline - time.monotonic()
                        if remaining <= 0: raise TimeoutError("incomplete request")
                        conn.settimeout(remaining)
                        part = conn.recv(4097 - len(data))
                        if not part: raise ValueError("incomplete request")
                        data += part
                        if len(data) > 4096: raise ValueError("request too large")
                    reply = agent.dispatch(json.loads(data.split(b"\n", 1)[0]))
                except Exception as error:
                    reply = {"ok": False, "error": str(error)}
                try: conn.sendall(json.dumps(reply).encode() + b"\n")
                except OSError: pass  # The independent pulse deadline remains armed.
    finally:
        try: outputs.shutdown()
        finally:
            if listener:
                listener.close()
                path.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("--client", action="store_true")
    args = parser.parse_args()
    try:
        if args.serve == args.client: raise ValueError("choose --serve or --client")
        if args.serve: serve()
        else:
            result = client(json.load(sys.stdin))
            print(json.dumps(result))
            if not result.get("ok"): sys.exit(1)
    except KeyboardInterrupt:
        pass
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
