#!/usr/bin/env python3
"""Four-pot host bridge: authenticated finite pulses, no automatic scheduler.

The separate GPIO agent owns the independent close timer and durable pulse IDs.
This bridge only serves Docker's private host interface, not the public network.
"""
import hashlib
import hmac
import json
import os
from pathlib import Path
import socket
import subprocess
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote
from urllib.request import Request, urlopen

ROOT = Path('/opt/exacth2o/sensing')
STATE = Path('/var/lib/exacth2o-sensing')
LOCK = threading.Lock()


def now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds')


def atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.tmp')
    with tmp.open('w') as f:
        json.dump(value, f)
        f.flush()
        os.fsync(f.fileno())
    tmp.replace(path)


def relay(body):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(2)
        sock.connect(os.environ['EXACTH2O_GPIO_RELAY_SOCKET'])
        sock.sendall(json.dumps(body).encode() + b'\n')
        data = b''
        while b'\n' not in data:
            part = sock.recv(16384)
            if not part or len(data) > 65536:
                raise RuntimeError('Relay reply incomplete')
            data += part
    result = json.loads(data.split(b'\n', 1)[0])
    if not result.get('ok'):
        raise RuntimeError(result.get('error', 'Relay unavailable'))
    return result


def record_path(pulse_id):
    return STATE / 'pulses' / (hashlib.sha256(pulse_id.encode()).hexdigest() + '.json')


def validate(body):
    raw_channel = body.get('address')
    channel = int(raw_channel) if isinstance(raw_channel, str) and raw_channel in ('1','2','3','4') else raw_channel
    duration = body.get('durationMilliseconds')
    pulse_id = body.get('pulseId')
    command_id = body.get('commandId')
    if str(body.get('relayAddress')).lower() not in ('0x20', '32'):
        raise ValueError('Only the commissioned 0x20 relay is configured')
    if type(channel) is not int or channel not in (1, 2, 3, 4):
        raise ValueError('Choose one of the four commissioned outputs')
    if type(duration) is not int or not 2000 <= duration <= 5000:
        raise ValueError('Testbed watering must be 2 to 5 seconds')
    if not isinstance(command_id, str) or not command_id or not isinstance(pulse_id, str) or not pulse_id.startswith(command_id + ':') or len(pulse_id) > 200:
        raise ValueError('A command-scoped pulse ID is required')
    return channel, duration, pulse_id


def queue_event(record, event, at):
    event_id = 'live-device:testbed-water:' + record['pulseId'] + ':' + event
    payload = {'event_id': event_id, 'type': 'valve_event', 'recorded_at': at,
               'valve_key': '0x20:' + str(record['address']), 'action': 'close' if event == 'closed' else event,
               'duration_ms': record['durationMilliseconds'], 'source_valve_id': record['address'], 'reason': 'Phone manual watering',
               'pairing_name': ['Sensor One', 'Sensor Two', 'Sensor Three', 'Sensor Four'][record['address'] - 1]}
    atomic(STATE / 'water-events' / (hashlib.sha256(event_id.encode()).hexdigest() + '.json'), payload)


def pulse(body):
    channel, duration, pulse_id = validate(body)
    body = {**body, 'address': channel, 'relayAddress': '0x20'}
    path = record_path(pulse_id)
    with LOCK:
        if path.exists():
            saved = json.loads(path.read_text())
            if any(saved.get(k) != body.get(k) for k in ('address', 'relayAddress', 'durationMilliseconds', 'commandId')):
                raise ValueError('Pulse ID cannot be reused with different parameters')
            if saved.get('status') != 'closed':
                raise RuntimeError('Previous pulse outcome requires reconciliation; it will not be replayed')
            return saved
        status = relay({'op': 'status'})
        if status.get('active') or status.get('tripped'):
            raise ValueError('Relay is active or requires reconciliation')
        saved = {**body, 'status': 'requested', 'requestedAt': now()}
        atomic(path, saved)
        result = relay({'op': 'pulse', 'channel': channel, 'durationMilliseconds': duration, 'pulseId': pulse_id})
        if result.get('replayed') or (result.get('active') or {}).get('pulseId') != pulse_id:
            raise RuntimeError('Relay did not confirm a new pulse')
        saved.update(status='open', openedAt=now())
        atomic(path, saved)
        queue_event(saved, 'open', saved['openedAt'])
    # The GPIO process closes independently even if this thread or service stops.
    time.sleep(duration / 1000 + 0.15)
    status = relay({'op': 'status'})
    agent_state = json.loads(Path(os.environ['EXACTH2O_GPIO_RELAY_STATE']).read_text())
    if (agent_state.get('records', {}).get(pulse_id) or {}).get('status') != 'closed':
        raise RuntimeError('Relay closure is unconfirmed')
    saved.update(status='closed', closedAt=now(), interruptedBy=None)
    atomic(path, saved)
    queue_event(saved, 'closed', saved['closedAt'])
    return saved


def read(path):
    try:
        return Path(path).read_text().strip()
    except OSError:
        return None


def health():
    collector = json.loads(read(STATE / 'status.json') or '{}')
    samples = collector.get('latest', {})
    cfg = json.loads((ROOT / 'sensors.json').read_text())
    missing, stale = [], []
    for sensor in cfg['sensors']:
        at = samples.get(sensor['address'])
        if not at:
            missing.append(sensor['name'])
        elif time.time() - datetime.fromisoformat(at).timestamp() > 180:
            stale.append(sensor['name'])
    temperature = read('/sys/class/thermal/thermal_zone0/temp')
    try:
        flags = subprocess.check_output(['vcgencmd', 'get_throttled'], text=True, timeout=2).strip().split('=')[1]
        undervoltage = bool(int(flags, 16) & 1)
        occurred = bool(int(flags, 16) & (1 << 16))
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        flags = undervoltage = occurred = None
    status = relay({'op': 'status'})
    issues = ([] if not missing and not stale else ['Sensor readings are missing or stale'])
    if status.get('tripped'):
        issues.append('Relay requires reconciliation')
    if undervoltage:
        issues.append('Pi supply undervoltage')
    at = now()
    return {'observed_at': at, 'source': 'four-pot-host', 'overall_status': 'warning' if issues else 'ok',
            'api_reachable': True, 'pi_online': True, 'controller_state': 'STOPPED',
            'cpu_temp_c': float(temperature) / 1000 if temperature else None,
            'uptime_seconds': float(read('/proc/uptime').split()[0]),
            'ethernet_link': read('/sys/class/net/eth0/carrier') == '1',
            'undervoltage_current': undervoltage, 'undervoltage_occurred': occurred, 'throttled_flags': flags,
            'sensors_expected': len(cfg['sensors']), 'sensors_current': len(cfg['sensors']) - len(missing) - len(stale),
            'sensors_missing': len(missing), 'sensors_stale': len(stale),
            'missing_sensors': missing, 'stale_sensors': stale,
            'last_sensor_reading_at': max(samples.values()) if samples else None,
            'watering_enabled': False, 'manual_water_enabled': not status.get('tripped'),
            'relay_active': status.get('active'), 'known_issues': issues,
            'collector': collector}


def flush_events():
    while True:
        try:
            for path in sorted((STATE / 'water-events').glob('*.json')):
                request = Request(os.environ['SUPABASE_URL'] + '/rest/v1/rpc/device_ingest',
                    data=json.dumps({'device_token': os.environ['EXACTH2O_INGEST_TOKEN'], 'payload': {'device_id': os.environ['EXACTH2O_DEVICE_ID'], 'sent_at': now(), 'events': [json.loads(path.read_text())]}}).encode(),
                    headers={'apikey': os.environ['SUPABASE_ANON_KEY'], 'Content-Type': 'application/json'})
                with urlopen(request, timeout=15) as response:
                    response.read()
                path.unlink()
        except Exception as error:
            print('Event upload pending:', str(error), flush=True)
        time.sleep(5)


class Handler(BaseHTTPRequestHandler):
    def reply(self, code, value):
        data = json.dumps(value).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def authorized(self):
        expected = os.environ.get('EXACTH2O_CONTROLLER_COMMAND_SECRET', '')
        return bool(expected) and hmac.compare_digest(self.headers.get('x-exacth2o-controller-secret', ''), expected)

    def do_GET(self):
        try:
            if self.path == '/v1/state':
                return self.reply(200, {'data': 'STOPPED'})
            if self.path == '/v1/boardConfigs':
                return self.reply(200, {'data': [{'address': '0x20', 'valveCount': 4, 'backend': 'gpio4'}]})
            if not self.authorized():
                return self.reply(401, {'error': 'Controller authentication required'})
            if self.path == '/v1/health':
                return self.reply(200, health())
            if self.path.startswith('/v1/valves/pulse/'):
                path = record_path(unquote(self.path.split('/v1/valves/pulse/', 1)[1]))
                return self.reply(200, json.loads(path.read_text())) if path.exists() else self.reply(404, {'error': 'Unknown pulse'})
            self.reply(404, {'error': 'Unknown route'})
        except Exception as error:
            self.reply(503, {'error': str(error)})

    def do_POST(self):
        if not self.authorized():
            return self.reply(401, {'error': 'Controller authentication required'})
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if size < 1 or size > 4096:
                raise ValueError('Invalid request size')
            body = json.loads(self.rfile.read(size))
            if self.path == '/v1/valves/pulse':
                return self.reply(200, pulse(body))
            if self.path == '/v1/state' and body.get('state') == 'STOPPED' and not body.get('boardConfig'):
                relay({'op': 'close_all'})
                return self.reply(200, {'data': 'STOPPED'})
            self.reply(409, {'error': 'Testbed supports sensing and timed manual watering only'})
        except ValueError as error:
            self.reply(400, {'error': str(error)})
        except Exception as error:
            self.reply(503, {'error': str(error)})


if __name__ == '__main__':
    threading.Thread(target=flush_events, daemon=True).start()
    ThreadingHTTPServer(('172.18.0.1', 3001), Handler).serve_forever()
