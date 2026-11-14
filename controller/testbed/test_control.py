import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('testbed_control', Path(__file__).with_name('control.py'))
control = importlib.util.module_from_spec(spec)
spec.loader.exec_module(control)

class ValidationTests(unittest.TestCase):
    def test_only_commissioned_bounded_routes(self):
        base = dict(address=1, relayAddress='0x20', durationMilliseconds=2000, commandId='abc', pulseId='abc:0x20:1')
        self.assertEqual(control.validate(base), (1, 2000, 'abc:0x20:1'))
        self.assertEqual(control.validate({**base, 'address': '2'})[0], 2)
        for patch in [dict(address=5),dict(address=True),dict(relayAddress='0x21'),dict(durationMilliseconds=1000),dict(durationMilliseconds=6000),dict(pulseId='unrelated')]:
            with self.assertRaises(ValueError): control.validate({**base, **patch})

if __name__ == '__main__': unittest.main()

class PulseContractTests(unittest.TestCase):
    def test_string_channel_closure_event_and_durable_deduplication(self):
        import tempfile
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as folder:
            request = dict(address='2', relayAddress='0x20', durationMilliseconds=2000, commandId='abc', pulseId='abc:0x20:2')
            relay_state = Path(folder) / 'agent.json'
            relay_state.write_text('{"records":{"abc:0x20:2":{"status":"closed"}}}')
            calls=[]
            def fake_relay(body):
                calls.append(body)
                return {'ok':True,'active': {'pulseId':request['pulseId']} if body['op']=='pulse' else None}
            with patch.object(control, 'STATE', Path(folder)), patch.object(control, 'relay', fake_relay), patch.object(control.time, 'sleep'), patch.dict(control.os.environ, {'EXACTH2O_GPIO_RELAY_STATE':str(relay_state)}):
                result=control.pulse(request)
                self.assertEqual(result['status'],'closed')
                self.assertEqual(control.pulse(request),result)
                self.assertEqual(len([c for c in calls if c['op']=='pulse']),1)
                events=[control.json.loads(p.read_text()) for p in (Path(folder)/'water-events').glob('*.json')]
                self.assertEqual({e['action'] for e in events},{'open','close'})
                self.assertTrue(all(e['pairing_name']=='Sensor Two' for e in events))
