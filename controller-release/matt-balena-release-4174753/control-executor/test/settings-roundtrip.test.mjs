import assert from 'node:assert/strict';
import test from 'node:test';
import { executeCommand } from '../src/control-executor.mjs';

// Stateful, hardware-free controller API. The production executor performs each
// mutation; subsequent commands resolve and read back the resulting inventory.
test('settings round trip preserves sensing-only fields and exercises every settings mutation', async () => {
  const state = {
    system: { state: 'STOPPED' },
    pairings: [{ name: 'Zone1-Pot1', sensorId: 1, valveId: 11, groupId: 1, WTCPercentLimit: -999999, ValveOpenTime: 0, MeasurementInterval: 600000 }],
    sensors: [{ id: 1, boardSerialId: 'A', address: 1 }, { id: 2, boardSerialId: 'A', address: 2 }],
    valves: [{ id: 11, relayAddress: '0x20', address: 1 }, { id: 12, relayAddress: '0x20', address: 2 }],
    groups: [{ id: 1, name: 'Original' }], calibrations: [],
  };
  let nextId = 20;
  const api = {
    async get(path) { assert.ok(path.slice(1) in state, path); return structuredClone(state[path.slice(1)]); },
    async post(path, body) {
      if (path === '/system') { state.system = structuredClone(body); return state.system; }
      assert.ok(['/groups', '/pairings', '/calibrations'].includes(path), path);
      const row = { id: nextId++, ...structuredClone(body) }; state[path.slice(1)].push(row); return row;
    },
    async put(path, body) {
      const [,kind,sensor,valve] = path.split('/');
      assert.equal(kind, 'pairings');
      const row = state.pairings.find(p => p.sensorId === Number(sensor) && p.valveId === Number(valve));
      assert.ok(row, path); Object.assign(row, structuredClone(body)); return row;
    },
    async delete(path) {
      const [,kind,id,valve] = path.split('/');
      const index = state[kind].findIndex(row => kind === 'pairings' ? row.sensorId === Number(id) && row.valveId === Number(valve) : row.id === Number(id));
      assert.ok(index >= 0, path); return state[kind].splice(index, 1)[0];
    },
  };
  const run = (command_type,payload) => executeCommand({ id: crypto.randomUUID(), command_type,payload }, { api, dryRun:false, manualWaterEnabled:false });
  await run('update_pairing',{pairing_name:'Zone1-Pot1',disable_watering:true,measurement_interval_seconds:660});
  assert.deepEqual(state.pairings[0], {name:'Zone1-Pot1',sensorId:1,valveId:11,groupId:1,WTCPercentLimit:-999999,ValveOpenTime:0,MeasurementInterval:660000});
  await run('create_group',{group_name:'Trial',group_type:'block'});
  await run('update_pairing',{pairing_name:'Zone1-Pot1',new_name:'Zone2-Pot1',group_name:'Trial'});
  assert.equal(state.pairings[0].groupId,state.groups.find(g=>g.name==='Trial').id);
  await run('create_pairing',{name:'Zone2-Pot2',sensor_key:'A:2',valve_key:'0x20:2',group_name:'Trial',target_vwc:25,open_time_seconds:2,measurement_interval_seconds:600});
  await run('bulk_update_pairings',{pairing_names:['Zone2-Pot1','Zone2-Pot2'],target_vwc:30,open_time_seconds:3,measurement_interval_seconds:900});
  assert.ok(state.pairings.every(p=>p.WTCPercentLimit===30 && p.ValveOpenTime===3000 && p.MeasurementInterval===900000));
  await run('create_calibration',{name:'Trial calibration',function_text:'0,1',points:[{vwc:10,average_reading:10},{vwc:30,average_reading:30}]});
  assert.equal(state.calibrations[0].polynomialCoefficientsCommaDelimited,'0,1');
  assert.equal(JSON.parse(state.calibrations[0].readingsJSONString).length,2);
  await run('apply_calibration',{calibration_name:'Trial calibration',pairing_names:['Zone2-Pot2']});
  assert.equal(state.pairings[1].calibrationId,state.calibrations[0].id);
  await run('delete_pairing',{pairing_name:'Zone2-Pot2'});
  assert.equal(state.pairings.length,1);
  await run('delete_calibration',{calibration_name:'Trial calibration'});
  assert.equal(state.calibrations.length,0);
  await run('update_pairing',{pairing_name:'Zone2-Pot1',new_name:'Zone1-Pot1',group_name:'Original',disable_watering:true,measurement_interval_seconds:600});
  await run('remove_group',{group_name:'Trial'});
  assert.deepEqual(state.groups,[{id:1,name:'Original'}]);
  assert.equal(state.pairings[0].WTCPercentLimit,-999999);
  assert.equal(state.pairings[0].MeasurementInterval,600000);
  const before = structuredClone(state);
  await run('export_data',{data_type:'pairings'});
  assert.deepEqual(state,before,'Export does not mutate controller configuration');
});
