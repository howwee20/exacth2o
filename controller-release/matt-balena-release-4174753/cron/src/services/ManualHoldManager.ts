import { readFile, writeFile, rename } from 'fs/promises'

export interface HoldRequest {
  sessionId: string; ownerId: string; sequence: number; expiresAt: number;
  relayAddress: number; address: number;
}
interface HoldRecord extends HoldRequest { startedAt: number; deadline: number; status: 'open' | 'closed' | 'fault' }
interface HoldState { active: HoldRecord | null; records: HoldRecord[] }

// Closed sessions are remembered so a delayed start or renewal cannot reopen them.
const TOMBSTONE_MS = 120_000
const MAX_RECORDS = 500

export class ManualHoldManager {
  private state: HoldState = { active: null, records: [] }
  private queue: Promise<unknown> = Promise.resolve()
  private timer: NodeJS.Timeout | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private ready = false
  constructor(
    private file: string,
    private open: (r: HoldRequest) => Promise<void>,
    private close: (r: HoldRequest) => Promise<void>,
    private leaseMs = 2500,
    private maxMs = 15000,
    private closeRetryMs = 1000,
  ) {}
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn); this.queue = next.catch(() => {}); return next
  }
  private async save() {
    const now = Date.now()
    this.state.records = this.state.records.filter(x => now - x.startedAt < TOMBSTONE_MS).slice(-MAX_RECORDS)
    await writeFile(this.file + '.tmp', JSON.stringify(this.state), {mode:0o600}); await rename(this.file + '.tmp', this.file)
  }
  async recover() {
    return this.serial(async () => {
      try { this.state = JSON.parse(await readFile(this.file, 'utf8')) } catch(e: any) { if(e.code !== 'ENOENT') throw e }
      if (this.state.active) await this.finish()
      this.ready = true
    })
  }
  private arm() {
    if(this.timer) clearTimeout(this.timer)
    if(!this.state.active) return
    this.timer = setTimeout(() => { void this.serial(() => this.finish()).catch(() => {}) }, Math.max(0, this.state.active.deadline-Date.now()))
    this.timer.unref?.()
  }
  // A valve that could not be closed is retried until it closes. Manual holds stay
  // disabled until the controller restarts, so an operator sees the fault first.
  private scheduleCloseRetry() {
    if(this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.serial(() => this.finish()).catch(() => this.scheduleCloseRetry())
    }, this.closeRetryMs)
    this.retryTimer.unref?.()
  }
  private async finish() {
    const r = this.state.active
    if(!r) return
    if(this.timer) clearTimeout(this.timer)
    try { await this.close(r) } catch(e) {
      r.status='fault'; this.ready=false; await this.save(); this.scheduleCloseRetry(); throw e
    }
    if(this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null }
    r.status='closed'; this.state.active=null; this.state.records.push(r)
    await this.save()
  }
  async stopAll() { return this.serial(() => this.finish()) }
  async request(action: 'start'|'renew'|'stop'|'status', r: HoldRequest) {
    return this.serial(async () => {
      const controllerTime = Date.now()
      if(!this.ready) {
        if(action === 'status') return {status: this.state.active?.status || 'closed', sessionId: r.sessionId, ready: false, controllerTime}
        throw new Error('Manual control unavailable: controller recovery required')
      }
      if(!/^[a-zA-Z0-9-]{16,80}$/.test(r.sessionId) || !r.ownerId || !Number.isInteger(r.sequence) || r.sequence<0) throw new Error('Invalid hold identity')
      let active=this.state.active
      if(active && Date.now()>=active.deadline) { await this.finish();active=null }
      const prior=this.state.records.find(x=>x.sessionId===r.sessionId)
      const existing=active?.sessionId===r.sessionId?active:prior
      if(existing && existing.ownerId!==r.ownerId) throw new Error('Hold owner mismatch')
      const busy=Boolean(active && active.sessionId!==r.sessionId)
      if(action==='stop') {
        if(active?.sessionId===r.sessionId) await this.finish()
        else if(!prior) { this.state.records.push({...r,startedAt:Date.now(),deadline:Date.now(),status:'closed'});await this.save() }
        return {status:'closed',sessionId:r.sessionId,ready:true,busy,controllerTime}
      }
      if(action==='status') return {status:existing?.status||'closed',sessionId:r.sessionId,ready:true,busy,controllerTime}
      if(prior) return {status:prior.status,sessionId:r.sessionId,ready:true,busy,controllerTime}
      if(!Number.isFinite(r.expiresAt)||r.expiresAt<=Date.now()||r.expiresAt>Date.now()+this.leaseMs) throw new Error('Hold signal expired')
      if(busy) throw new Error('Another manual hold is active')
      if(action==='renew') {
        if(!active) return {status:'closed',sessionId:r.sessionId,ready:true,busy,controllerTime}
        if(active.address!==r.address || active.relayAddress!==r.relayAddress) throw new Error('Hold route changed')
        if(r.sequence>active.sequence) {
          active.sequence=r.sequence;active.deadline=Math.min(r.expiresAt,active.startedAt+this.maxMs)
          await this.save();this.arm()
        }
      } else if(!active) {
        active={...r,startedAt:Date.now(),deadline:Math.min(r.expiresAt,Date.now()+this.maxMs),status:'open'}
        this.state.active=active
        await this.save()
        try { await this.open(r) } catch(e) { await this.finish();throw e }
        if(Date.now()>=active.deadline) await this.finish(); else this.arm()
      }
      return {status:this.state.active?.status||'closed',sessionId:r.sessionId,ready:true,busy,startedAt:active?.startedAt,deadline:this.state.active?.deadline,maxMilliseconds:this.maxMs,controllerTime}
    })
  }
}
