import test from 'node:test';
import assert from 'node:assert/strict';
import {assertFieldCommandsAllowed,assertKnownFieldRoute} from './field-command-policy.mjs';
import {FIELD_PROJECT_ID as projectId,FIELD_DEVICE_ID as deviceId} from './installation-field-map.mjs';
const p=(name,key)=>({name,valve_key:key,sensor_key:'board:A'});
const run=(command_type,payload,pairings=[p('unknown','32:15')],extra={})=>assertFieldCommandsAllowed({projectId,deviceId,commands:[{command_type,payload}],pairings,...extra});
test('unlabelled water cannot open unknown output in any accepted spelling',()=>{for(const key of ['32:15','0x20:15','032:015','0X20:15']) assert.throws(()=>run('manual_water',{pairing_names:['unknown']},[p('unknown',key)]),/confirmed/)});
test('unknown create, enable and restore fail closed',()=>{
 assert.throws(()=>run('create_pairing',{name:'new',valve_key:'32:15',target_vwc:20}),/confirmed/);
 assert.throws(()=>run('update_pairing',{pairing_name:'unknown',target_vwc:20}),/confirmed/);
 assert.throws(()=>run('restore_pairing_settings',{pairings:[{pairing_name:'unknown',target_vwc:20,valve_open_time_ms:2000}]}),/confirmed/);
});
test('sensing-only disable and stop remain possible',()=>{
 run('update_pairing',{pairing_name:'unknown',disable_watering:true});
 run('restore_pairing_settings',{pairings:[{pairing_name:'unknown',target_vwc:null,valve_open_time_ms:2000}]});
 run('update_system_state',{state:'stopped'});
});
test('ordinary Pan watering remains available',()=>run('update_pairing',{pairing_name:'Pan',target_vwc:30},[p('Pan','32:17')]));
test('corrected automatic route requires sensor binding; manual known route remains usable',()=>{
 const pairings=[p('corrected','32:35')];
 assert.throws(()=>run('update_pairing',{pairing_name:'corrected',target_vwc:30},pairings),/Confirm/);
 run('update_pairing',{pairing_name:'corrected',target_vwc:30},pairings,{bindings:[{sensor_key:'board:A',valve_key:'0x20:35',physical_status:'researcher_confirmed'}]});
 run('manual_water',{pairing_names:['corrected']},pairings);
});
test('identity mismatch and contradictory valve aliases cannot bypass',()=>{
 assert.throws(()=>assertKnownFieldRoute(projectId,'replacement','32:17'),/identity/);
 assert.throws(()=>assertKnownFieldRoute('other',deviceId,'32:17'),/identity/);
 assert.throws(()=>run('manual_water',{pairing_names:['x']},[{...p('x','32:17'),Valve:{relayAddress:'32',address:'15'}}]),/Ambiguous/);
});
