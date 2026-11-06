import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initializeState,reconcileOnce,readingEvent} from '../src/publisher.mjs';
test('new installations start from the beginning with a durable identity',async()=>{
 const state=await initializeState({bootstrapCursorId:0},{});
 assert.equal((await initializeState({bootstrapCursorId:0},state)).epoch,state.epoch);
 assert.equal(state.cursorId,0);assert.ok(state.epoch);assert.notEqual(state.epoch,'legacy');
 const row={id:1,sensorId:1,createdAt:'2026-11-01T00:00:00Z'};
 const a=readingEvent(row,null,null,{deviceId:'a',epoch:state.epoch});
 assert.equal(a.event_id,readingEvent(row,null,null,{deviceId:'a',epoch:state.epoch}).event_id);
 assert.notEqual(a.event_id,readingEvent(row,null,null,{deviceId:'a',epoch:'new'}).event_id);
});
test('reset with retained cursor uploads the new generation, and retry keeps its identity',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'publisher-reset-'));const original=globalThis.fetch;
 const row={id:1,sensorId:1,createdAt:'2026-11-01T01:00:00Z'};let sent=[];
 const config={apiBase:'http://local/v1',supabaseUrl:'http://cloud',anonKey:'test',deviceToken:'test',deviceId:'device-a',statePath:join(dir,'state'),healthPath:join(dir,'health'),requestTimeoutMs:1000,pageSize:10,maxPagesPerPass:1,ingestBatchSize:10};
 globalThis.fetch=async(url,options={})=>{
  const u=String(url);let data;
  if(u.endsWith('/readings/99'))return new Response('{}',{status:404});
  if(u.endsWith('/readings/1'))data=row;
  else if(u.endsWith('/pairings'))data=[];
  else if(u.includes('/rpc/device_ingest')){const body=JSON.parse(options.body);sent.push(...body.payload.events);data={inserted_readings:body.payload.events.length,duplicate_events:0};}
  else data={data:[row],pagination:{totalPages:1}};
  return Response.json(data);
 };
 try{
  const state={cursorId:99,cursorRecordedAt:'2026-10-01T00:00:00Z',epoch:'legacy',uploadedEvents:0,duplicateEvents:0};
  await reconcileOnce(config,state,{});assert.equal(sent.length,1);assert.equal(state.cursorId,1);assert.notEqual(state.epoch,'legacy');
  const saved=JSON.parse(await readFile(config.statePath));assert.equal(saved.epoch,state.epoch);
  const epoch=state.epoch;await reconcileOnce(config,state,{});assert.equal(state.epoch,epoch);assert.equal(sent.length,1);
 }finally{globalThis.fetch=original;await rm(dir,{recursive:true,force:true});}
});
