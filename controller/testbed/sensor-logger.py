#!/usr/bin/python3
"""Collect the four commissioned TEROS 11 sensors into the local reading store."""

import argparse
from datetime import datetime, timezone
import fcntl
import json
import logging
import os
from pathlib import Path
import re
import select
import subprocess
import termios
import time
import tty
import uuid

ROOT = Path('/opt/exacth2o/sensing')
STATE = Path('/var/lib/exacth2o-sensing')
LOG = logging.getLogger('exacth2o-sensing')


def exchange(fd, command, duration=1.1):
    termios.tcflush(fd, termios.TCIFLUSH)
    os.write(fd, command.encode('ascii'))
    termios.tcdrain(fd)
    deadline = time.monotonic() + duration
    response = b''
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], max(0, deadline - time.monotonic()))
        if ready:
            response += os.read(fd, 4096)
    return response.strip()


def sample(config):
    port = config['port']
    in_use = subprocess.run(['fuser', port], capture_output=True, timeout=5)
    if in_use.returncode == 0:
        raise RuntimeError('Sensor adapter is already in use')
    fd = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    observations = []
    try:
        fcntl.ioctl(fd, termios.TIOCEXCL)
        tty.setraw(fd, termios.TCSANOW)
        settings = termios.tcgetattr(fd)
        settings[4] = settings[5] = termios.B9600
        settings[2] = (settings[2] & ~(termios.CSIZE | termios.PARENB | termios.CSTOPB)) | termios.CS8 | termios.CLOCAL | termios.CREAD
        termios.tcsetattr(fd, termios.TCSANOW, settings)
        time.sleep(2.5)
        for sensor in config['sensors']:
            address = sensor['address']
            try:
                identity = exchange(fd, address + 'I!')
                pattern = address.encode() + rb'13METER   TER11 [0-9]{3}' + re.escape(sensor['serial'].encode())
                if not re.fullmatch(pattern, identity):
                    raise ValueError('Sensor serial did not match commissioned identity')
                acknowledgement = exchange(fd, address + 'M!')
                match = re.match(address.encode() + rb'(\d{3})(\d)', acknowledgement)
                if not match or int(match[2]) != 2:
                    raise ValueError('Invalid measurement acknowledgement')
                time.sleep(int(match[1]))
                response = exchange(fd, address + 'D0!')
                values = re.fullmatch(address.encode() + rb'([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)', response)
                if not values:
                    raise ValueError('Invalid measurement data')
                raw = float(values[1])
                temperature = float(values[2])
                if raw < 0 or not -40 <= temperature <= 60:
                    raise ValueError('Sensor returned an error value')
                observations.append({'sensor': sensor, 'raw_value': raw, 'temperature': temperature,
                    'recorded_at': datetime.now(timezone.utc).isoformat(timespec='seconds')})
            except ValueError as error:
                LOG.error('%s: %s', sensor['name'], error)
    finally:
        os.close(fd)
    return observations


def save_pending(config, observations):
    if not observations:
        return
    batch = {key: config[key] for key in ('board_serial', 'calibration_name', 'coefficients')}
    batch['observations'] = observations
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    path = STATE / 'pending' / (stamp + '-' + str(uuid.uuid4()) + '.json')
    temporary = path.with_suffix('.tmp')
    with temporary.open('w') as output:
        json.dump(batch, output)
        output.flush()
        os.fsync(output.fileno())
    temporary.replace(path)


def flush_pending():
    code = (ROOT / 'store-observations.cjs').read_text()
    for path in sorted((STATE / 'pending').glob('*.json')):
        result = subprocess.run(['docker', 'exec', '-i', 'exacth2o_testbed-api_svc-1',
            'node', '-e', code], input=path.read_text(), capture_output=True, text=True, timeout=30)
        if result.returncode:
            raise RuntimeError('Local reading storage failed: ' + result.stderr[-300:])
        LOG.info('Stored observation batch %s', path.stem)
        path.unlink()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--once', action='store_true')
    args = parser.parse_args()
    (STATE / 'pending').mkdir(parents=True, exist_ok=True)
    with (STATE / 'collector.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        while True:
            started = time.monotonic()
            config = json.loads((ROOT / 'sensors.json').read_text())
            try:
                observations = sample(config)
                save_pending(config, observations)
                flush_pending()
                status_path = STATE / 'status.json'
                status = json.loads(status_path.read_text()) if status_path.exists() else {'latest': {}}
                status['latest'].update({o['sensor']['address']: o['recorded_at'] for o in observations})
                status.update(checked_at=datetime.now(timezone.utc).isoformat(), collected=len(observations), expected=len(config['sensors']))
                temporary = status_path.with_suffix('.tmp')
                temporary.write_text(json.dumps(status))
                temporary.replace(status_path)
                LOG.info('Collected %d of %d sensors', len(observations), len(config['sensors']))
            except (OSError, RuntimeError, subprocess.SubprocessError) as error:
                LOG.error('%s', error)
                if args.once:
                    raise
            if args.once:
                break
            time.sleep(max(1, config['interval_seconds'] - (time.monotonic() - started)))


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    main()
