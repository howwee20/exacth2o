import test from 'node:test';
import assert from 'node:assert/strict';
import {FIELD_MAP, FIELD_PROJECT_ID, FIELD_DEVICE_ID, fieldPotForValve, fieldValveBlockReason, assertAutocalibrationCommandsAllowed} from './installation-field-map.mjs';

test('retains the physical field map, including swapped and end-of-bench routes', () => {
  assert.equal(FIELD_MAP.length, 100);
  assert.deepEqual(FIELD_MAP.filter(row => row.status === 'unresolved').map(row => row.pot), [63,87,88,89,90]);
  assert.equal(FIELD_MAP.filter(row => row.output !== null).length,95);
  assert.equal(new Set(FIELD_MAP.filter(row => row.output !== null).map(row => row.output)).size,95);
  for (const [pot,output] of [[83,84],[84,83],[86,96],[96,86],[97,87],[98,88],[99,89],[100,90]]) {
    assert.equal(FIELD_MAP.find(row => row.pot === pot).output,output);
  }
  assert.equal(fieldPotForValve('0x20:36').pot,83);
  assert.equal(fieldPotForValve('32:48').pot,86);
});

const pairing = (name,key) => ({name,valve_key:key});
const guard = (commands,pairings) => assertAutocalibrationCommandsAllowed({projectId:FIELD_PROJECT_ID,deviceId:FIELD_DEVICE_ID,commands,pairings});
test('blocks unresolved outputs and every live Pan valve even behind legacy names', () => {
  assert.match(fieldValveBlockReason('0x20:15'), /63/);
  for(let channel=17;channel<=28;channel++) {
    assert.throws(()=>guard([{command_type:'manual_water',payload:{pairing_names:['legacy']}}],[pairing('legacy',`32:${channel}`)]), /Pan/);
  }
  assert.throws(()=>guard([{command_type:'manual_water',payload:{pairing_names:['unmapped']}}],[pairing('unmapped','38:1')]), /no confirmed/);
});
test('protects prepare, remap, and restore; allows confirmed routes despite misleading old pot labels', () => {
  const pairings=[pairing('active','32:17'),pairing('Zone3-Pot66','36:18')];
  assert.throws(()=>guard([{command_type:'bulk_update_pairings',payload:{pairing_names:['active']}}],pairings), /Pan/);
  assert.throws(()=>guard([{command_type:'restore_pairing_settings',payload:{pairings:[{pairing_name:'active',valve_key:'32:17'}]}}],pairings), /Pan/);
  assert.throws(()=>guard([{command_type:'remap_pairing_valves',payload:{changes:[{pairing_name:'Zone3-Pot66',to_valve_key:'32:18'}]}}],pairings), /Pan/);
  assert.doesNotThrow(()=>guard([{command_type:'manual_water',payload:{pairing_names:['Zone3-Pot66']}}],pairings));
});

test('checks the raw controller pairing shape before an entire batch can enter the queue', () => {
  const pairings = [{name:'allowed',Valve:{relayAddress:36,address:18}}, {name:'legacy-pan',Valve:{relayAddress:32,address:20}}];
  assert.doesNotThrow(()=>guard([{command_type:'manual_water',payload:{pairing_names:['allowed']}}],pairings));
  assert.throws(()=>guard([
    {command_type:'update_system_state',payload:{state:'stopped'}},
    {command_type:'bulk_update_pairings',payload:{pairing_names:['allowed','legacy-pan']}},
    {command_type:'update_system_state',payload:{state:'running'}},
  ],pairings), /Pan/);
});
