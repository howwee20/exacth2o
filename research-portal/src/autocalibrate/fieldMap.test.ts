import {describe,expect,it} from 'vitest';
import {FIELD_MAP,physicalPairings,fieldSelectionBlockReason,installationFieldMap} from './fieldMap';
import type {PairingRow} from '../types';

const pairing=(name:string,valve_key:string):PairingRow=>({id:1,name,valve_key,pot_number:83,zone:4,source_sensor_id:2,sensor_key:'board:A',source_valve_id:3,wtc_percent_limit:20,valve_open_time_ms:3000,measurement_interval_ms:60000});
describe('field map identity',()=>{
  it('uses the observed valve destination without rewriting controller identities or settings',()=>{
    const original=pairing('Old-Pot83','32:35');
    const [mapped]=physicalPairings([original],FIELD_MAP);
    expect(mapped.pot_number).toBe(84);
    expect({...mapped,pot_number:original.pot_number,zone:original.zone}).toEqual(original);
    expect(original.pot_number).toBe(83);
    expect(physicalPairings([pairing('Old-Pot86','32:38')],FIELD_MAP)[0].pot_number).toBe(96);
  });
  it('locks the exact unresolved and live-experiment routes',()=>{
    expect(fieldSelectionBlockReason([pairing('legacy','32:20')],FIELD_MAP)).toMatch(/Pan/);
    expect(fieldSelectionBlockReason([pairing('unresolved','32:15')],FIELD_MAP)).toMatch(/63/);
    expect(fieldSelectionBlockReason([pairing('third-board','38:4')],FIELD_MAP)).toMatch(/no confirmed/);
    expect(fieldSelectionBlockReason([pairing('known','32:36')],FIELD_MAP)).toBeNull();
  });
  it('scopes the recorded installation to its own controller',()=>{
    expect(installationFieldMap('other','device')).toBeNull();
  });
});
