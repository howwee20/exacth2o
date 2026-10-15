import {mkdtemp, rm} from 'fs/promises'
import {tmpdir} from 'os'
import {join} from 'path'
import {ManualHoldManager, HoldRequest} from '../services/ManualHoldManager'
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms))
describe('controller-owned manual hold',()=>{
 let dir:string, open:jest.Mock, close:jest.Mock, manager:ManualHoldManager
 const request=():HoldRequest=>({sessionId:'01234567-89ab-cdef-0123-456789abcdef',ownerId:'owner',sequence:0,expiresAt:Date.now()+100,relayAddress:36,address:18})
 beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'hold-'));open=jest.fn(async()=>{});close=jest.fn(async()=>{});manager=new ManualHoldManager(join(dir,'state.json'),open,close,120,250);await manager.recover()})
 afterEach(async()=>{await manager.stopAll().catch(()=>{});await rm(dir,{recursive:true,force:true})})
 test('expires without browser stop and never reopens an expired session',async()=>{const r=request();await manager.request('start',r);await sleep(150);expect(close).toHaveBeenCalledTimes(1);expect((await manager.request('renew',{...r,sequence:1,expiresAt:Date.now()+100})).status).toBe('closed');expect(open).toHaveBeenCalledTimes(1)})
 test('release arriving before start cancels that start',async()=>{const r=request();await manager.request('stop',r);expect((await manager.request('start',r)).status).toBe('closed');expect(open).not.toHaveBeenCalled()})
 test('renewal cannot extend maximum continuous duration',async()=>{const r=request();await manager.request('start',r);for(let i=1;i<=4;i++){await sleep(65);await manager.request('renew',{...r,sequence:i,expiresAt:Date.now()+100})}expect(close).toHaveBeenCalledTimes(1)})
 test('rejects stale start, owner change, route change and concurrent session',async()=>{const r=request();await expect(manager.request('start',{...r,expiresAt:Date.now()-1})).rejects.toThrow('expired');await manager.request('start',r);await expect(manager.request('stop',{...r,ownerId:'other'})).rejects.toThrow('owner');await expect(manager.request('renew',{...r,address:19})).rejects.toThrow('route');await expect(manager.request('start',{...r,sessionId:'another-session-12345'})).rejects.toThrow('Another')})
 test('restart closes persisted hold before accepting requests',async()=>{const r=request();await manager.request('start',r);const recovered=new ManualHoldManager(join(dir,'state.json'),open,close);await recovered.recover();expect(close).toHaveBeenCalled();expect((await recovered.request('start',{...r,expiresAt:Date.now()+100})).status).toBe('closed')})
 test('a failed close keeps retrying until the valve closes, while holds stay disabled',async()=>{
  const retrying=new ManualHoldManager(join(dir,'retry.json'),open,close,120,250,20);await retrying.recover()
  const r=request();await retrying.request('start',r)
  close.mockRejectedValueOnce(new Error('relay failed')).mockRejectedValueOnce(new Error('relay failed'))
  await expect(retrying.request('stop',r)).rejects.toThrow('relay')
  await sleep(120)
  expect(close).toHaveBeenCalledTimes(3)
  expect((await retrying.request('status',r)).ready).toBe(false)
  await expect(retrying.request('start',{...r,sessionId:'another-session-12345'})).rejects.toThrow('recovery')
 })
 test('status reports another operator\'s hold without exposing or affecting it',async()=>{
  const r=request();await manager.request('start',r)
  const other={...r,sessionId:'another-session-12345',ownerId:'second'}
  const status=await manager.request('status',other)
  expect(status).toMatchObject({status:'closed',busy:true,ready:true})
  expect(typeof status.controllerTime).toBe('number')
  await expect(manager.request('start',{...other,expiresAt:Date.now()+100})).rejects.toThrow('Another')
  expect(close).not.toHaveBeenCalled()
 })
 test('out-of-order renewals never shorten or reopen a hold',async()=>{
  const r=request();await manager.request('start',r)
  await manager.request('renew',{...r,sequence:3,expiresAt:Date.now()+110})
  const late=await manager.request('renew',{...r,sequence:2,expiresAt:Date.now()+20})
  expect(late.deadline).toBeGreaterThan(Date.now()+60)
  await manager.request('stop',{...r,sequence:4})
  expect((await manager.request('renew',{...r,sequence:5,expiresAt:Date.now()+100})).status).toBe('closed')
  expect(open).toHaveBeenCalledTimes(1)
 })
 test('close failure blocks further starts and preserves recovery evidence',async()=>{const r=request();await manager.request('start',r);close.mockRejectedValue(new Error('relay failed'));await expect(manager.request('stop',r)).rejects.toThrow('relay');await expect(manager.request('start',{...r,sessionId:'another-session-12345'})).rejects.toThrow('recovery')})
})
