import assert from 'node:assert/strict';
import test from 'node:test';
import { isTestbed, TESTBED_PROJECT_ID, TESTBED_DEVICE_ID, assertTestbedPairing } from './testbed-policy.mjs';
test('exact testbed scope and current physical pairing are required', () => {
  assert.equal(isTestbed(TESTBED_PROJECT_ID, TESTBED_DEVICE_ID), true);
  assert.equal(isTestbed(TESTBED_PROJECT_ID, 'other'), false);
  const payload={pairing_names:['Sensor Two'],duration_seconds:2};
  const pairings=[{name:'Sensor Two',Sensor:{address:'2',boardSerialId:'D30GQN2Q'},Valve:{address:'2',relayAddress:'0x20'}}];
  assert.doesNotThrow(()=>assertTestbedPairing(payload,pairings));
  assert.throws(()=>assertTestbedPairing({...payload,duration_seconds:6},pairings));
  assert.throws(()=>assertTestbedPairing({...payload,pairing_names:['Sensor One','Sensor Two']},pairings));
  assert.throws(()=>assertTestbedPairing(payload,[{...pairings[0],Valve:{address:'1',relayAddress:'0x20'}}]));
});
