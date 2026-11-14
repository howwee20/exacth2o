import importlib.util
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('gpio_agent',Path(__file__).with_name('gpio_relay_agent.py'))
agent=importlib.util.module_from_spec(spec);spec.loader.exec_module(agent)
class Outputs:
    def __init__(self): self.open=set();self.opens=0
    def close_all(self): self.open.clear()
    def write(self,ch,on):
        if on: self.open.add(ch);self.opens+=1
        else:self.open.discard(ch)

class HoldTests(TestCase):
    def setUp(self):
        self.t=1000.;self.outputs=Outputs();self.saved={}
        self.agent=agent.RelayAgent({'boardAddress':32},self.outputs,clock=lambda:self.t,save=lambda s:self.saved.update(s))
        self.body={'op':'hold','action':'start','sessionId':'c18c52ee-01e7-41d2-a120-3b480c0c7616','ownerId':'operator','sequence':0,'address':1,'relayAddress':32,'expiresAt':1002500}
        self.clock=patch.object(agent.time,'time',lambda:self.t);self.clock.start();self.addCleanup(self.clock.stop)
    def test_release_closes_and_delayed_requests_never_reopen(self):
        self.assertEqual(self.agent.dispatch(self.body)['status'],'open')
        self.agent.dispatch({**self.body,'action':'stop','sequence':2})
        self.assertFalse(self.outputs.open)
        self.assertEqual(self.agent.dispatch({**self.body,'sequence':1})['status'],'closed')
        self.assertEqual(self.outputs.opens,1)
    def test_expiry_independent_of_bridge_and_old_renewal(self):
        self.agent.dispatch(self.body);self.t+=1
        self.agent.dispatch({**self.body,'action':'renew','sequence':2,'expiresAt':1003500})
        self.agent.dispatch({**self.body,'action':'renew','sequence':1,'expiresAt':1004000})
        self.t=1003.6;self.agent.tick()
        self.assertFalse(self.outputs.open)
        self.assertEqual(self.agent.hold_reply(self.body['sessionId'])['endReason'],'expired')
    def test_stop_before_start_prevents_delayed_start(self):
        self.agent.dispatch({**self.body,'action':'stop','sequence':1})
        self.assertEqual(self.agent.dispatch(self.body)['status'],'closed');self.assertEqual(self.outputs.opens,0)
    def test_restart_never_replays_prior_session(self):
        self.agent.dispatch(self.body)
        restarted=agent.RelayAgent({'boardAddress':32},self.outputs,clock=lambda:self.t,load=lambda:self.saved)
        self.assertEqual(restarted.dispatch(self.body)['status'],'closed');self.assertEqual(self.outputs.opens,1)
    def test_rejects_wrong_routes_and_cross_owner(self):
        for change in ({'address':5},{'relayAddress':33},{'expiresAt':999999}):
            with self.assertRaises(ValueError):self.agent.dispatch({**self.body,**change})
        self.agent.dispatch(self.body)
        with self.assertRaises(ValueError):self.agent.dispatch({**self.body,'action':'stop','ownerId':'other'})
        self.assertTrue(self.outputs.open)
