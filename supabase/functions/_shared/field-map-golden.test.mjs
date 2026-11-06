import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {FIELD_MAP,UNRESOLVED_POTS,PROTECTED_POTS} from './installation-field-map.mjs';
test('all physical routes match the original November 1 field record',()=>{
 const reference=JSON.parse(readFileSync(new URL('../../tests/fixtures/confirmed-routes-2026-11-01.json',import.meta.url),'utf8'));
 for(const row of reference){const actual=FIELD_MAP.find(r=>r.pot===row.pot);assert.deepEqual([actual.output,actual.relayAddress,actual.channel],[row.output,row.board==null?null:Number(row.board),row.channel]);}
 assert.deepEqual(UNRESOLVED_POTS,[63,87,88,89,90]);
 assert.deepEqual(PROTECTED_POTS,Array.from({length:12},(_,i)=>65+i));
 assert.equal(new Set(FIELD_MAP.filter(r=>r.output!==null).map(r=>`${r.relayAddress}:${r.channel}`)).size,95);
});
