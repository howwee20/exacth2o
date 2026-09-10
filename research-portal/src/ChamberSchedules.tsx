import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { CalendarClock, Check, CircleHelp, Loader2, Pause, Pencil, Play, Plus, Trash2, X } from "lucide-react";
import { supabase } from "./supabase";
import { loadGasMixerNativeStatus } from "./gasMixerNativeClient";
import { gasMixerNativeChannelConfig, type GasMixerNativeStatus } from "./gasMixerNative";
import "./chamberSchedules.css";

type Channel = "B" | "C" | "D" | "E" | "F";
type Recipe = { total_slpm: number; use_licor: boolean; ratios: Record<Channel, number> };
type Actions = { gas?: Recipe; light?: number };
type Definition = { name: string; local_time: string; weekdays: number[]; starts_on: string; ends_on: string; repeat_daily: boolean; actions: Actions; enabled: boolean };
type Schedule = Definition & { id: string; owner: string; next_run_at: string | null; version: number; can_resume: boolean };
type Run = { id: string; name: string; due_at: string; status: string; detail: string | null; gas_status: string; light_status: string };
type Overview = { schedules: Schedule[]; runs: Run[]; can_control: boolean; scheduler_online: boolean };
const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const channels: Channel[] = ["B", "C", "D", "E", "F"];
const emptyRecipe = (): Recipe => ({ total_slpm: 0, use_licor: false, ratios: { B: 0, C: 0, D: 0, E: 0, F: 0 } });
const labDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Detroit", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const timeLabel = (value: string | null) => value ? new Intl.DateTimeFormat("en-US", { timeZone: "America/Detroit", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(value)) : "No future runs";
const errorText = (error: unknown) => error && typeof error === "object" && "message" in error ? String(error.message) : "Unable to update schedules. Please try again.";
function describeActions(actions: Actions) {
  const parts: string[] = [];
  if (actions.gas) {
    const gas = actions.gas;
    const composition = channels.filter(k => gas.ratios[k] > 0).map(k => {
      const config = gasMixerNativeChannelConfig.find(c => c.address === k)!;
      return `${gas.ratios[k]} ${config.ratio_unit} ${config.formula} ${k}`;
    });
    parts.push(`Gas ${gas.total_slpm} SLPM${composition.length ? ` · ${composition.join(", ")} · N₂ balance` : " · 100% N₂"}${gas.use_licor ? " · LI-COR on" : " · LI-COR off"}`);
  }
  if (actions.light !== undefined) parts.push(actions.light === 0 ? "Lights off" : `Lights ${actions.light}`);
  return parts.join(" / ");
}
function blank(): Definition {
  return { name: "", local_time: "06:00", weekdays: [0, 1, 2, 3, 4, 5, 6], starts_on: labDate(), ends_on: "", repeat_daily: true, actions: { light: 134 }, enabled: true };
}

function ScheduleHelp() {
  const [visible, setVisible] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => { if (!wrapper.current?.contains(event.target as Node)) setVisible(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  return <div ref={wrapper} className="schedule-help-corner" onMouseEnter={() => setVisible(true)} onMouseLeave={() => setVisible(false)}>
    <button type="button" className="schedule-help-button" aria-label="Schedule help" aria-describedby={visible ? "schedule-help-tooltip" : undefined} onFocus={() => setVisible(true)} onBlur={() => setVisible(false)} onClick={() => setVisible(true)} onKeyDown={event => { if (event.key === "Escape") setVisible(false); }}><CircleHelp size={18} /></button>
    {visible ? <div id="schedule-help-tooltip" role="tooltip" className="schedule-help-tooltip"><strong>Schedule help</strong><p>Schedules apply saved settings at lab time. For combined schedules, gas changes first, then lights.</p><p>Manual portal changes pause that device’s schedules. Use Resume to continue. Pause before using local controls.</p><p>Pause and Delete stop future runs, not the equipment. Commands already accepted may finish. Keep controllers online and check Recent runs after a failure.</p></div> : null}
  </div>;
}

export function ChamberSchedules() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState<Definition | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<Schedule | null>(null);
  const editorRef = useRef<HTMLFormElement>(null);
  const [gas, setGas] = useState<GasMixerNativeStatus | null>(null);
  const [review, setReview] = useState(false);
  const [loading, setLoading] = useState(true);
  const pending = useRef(false);
  const refresh = useCallback(async () => {
    const { data, error: reason } = await supabase.rpc("chamber_schedule_overview");
    if (reason) throw reason;
    setOverview(data as Overview);
  }, []);
  useEffect(() => {
    let active = true;
    let refreshing = false;
    const poll = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const { data, error: reason } = await supabase.rpc("chamber_schedule_overview");
        if (reason) throw reason;
        if (active) { setOverview(data as Overview); setConnectionError(null); }
      } catch (reason) { if (active) setConnectionError(errorText(reason)); }
      finally { refreshing = false; if (active) setLoading(false); }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  const operate = async (operation: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null); setNotice(null);
    try { await operation(); await refresh(); }
    catch (reason) { setError(errorText(reason)); }
    finally { pending.current = false; setBusy(false); }
  };
  const open = (schedule?: Schedule) => {
    setEditing(schedule?.id ?? null);
    setDeleting(null);
    setForm(schedule ? { ...schedule, ends_on: schedule.ends_on ?? "", local_time: schedule.local_time.slice(0, 5) } : blank());
    setReview(false); setError(null); setNotice(null);
    window.requestAnimationFrame(() => { editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); editorRef.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true }); });
    void loadGasMixerNativeStatus().then(setGas).catch(() => setGas(null));
  };
  const patch = (changes: Partial<Definition>) => { setForm(current => current ? { ...current, ...changes } : current); setReview(false); };
  const setRecipe = (changes: Partial<Recipe>) => { if (form?.actions.gas) patch({ actions: { ...form.actions, gas: { ...form.actions.gas, ...changes } } }); };
  const pause = (id: string | null) => void operate(async () => {
    const { error: reason } = await supabase.rpc("chamber_schedule_pause", { p_schedule_id: id });
    if (reason) throw reason;
    setNotice(id ? "Schedule paused." : "All schedules paused.");
  });
  const resume = (schedule: Schedule) => void operate(async () => {
    const { data, error: reason } = await supabase.rpc("chamber_schedule_resume", { p_schedule_id: schedule.id, expected_version: schedule.version });
    if (reason) throw reason;
    if (data.needs_new_time) { open(schedule); setNotice("Choose a new date or time, then save and activate."); return; }
    setNotice(`Schedule resumed. Next: ${timeLabel(data.next_run_at)}.`);
  });
  const remove = (schedule: Schedule) => void operate(async () => {
    const { error: reason } = await supabase.rpc("chamber_schedule_delete", { p_schedule_id: schedule.id, expected_version: schedule.version });
    if (reason) throw reason;
    setDeleting(null);
    if (editing === schedule.id) { setForm(null); setEditing(null); }
    setNotice("Schedule deleted. Past runs remain in history.");
  });
  const save = (enabled: boolean) => void operate(async () => {
    if (!form) return;
    const { error: reason } = await supabase.rpc("chamber_schedule_save", { schedule_id: editing, definition: { ...form, enabled } });
    if (reason) throw reason;
    setForm(null); setReview(false); setNotice(enabled ? "Schedule active." : "Schedule saved as paused.");
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!form) return;
    if (!form.actions.gas && form.actions.light === undefined) { setError("Choose gas, lights, or both."); return; }
    if (form.repeat_daily && form.weekdays.length === 0) { setError("Choose at least one day."); return; }
    const recipe = form.actions.gas;
    if (recipe && channels.reduce((sum, k) => sum + recipe.ratios[k] / (k === "C" || k === "D" ? 10000 : 1), 0) > 100) { setError("Gas composition exceeds 100%."); return; }
    if (form.actions.light !== undefined && form.actions.light !== 0 && form.actions.light < 10) { setError("Light intensity must be 0 or 10–255."); return; }
    setError(null); setReview(true);
  };
  const activeCount = overview?.schedules.filter(s => s.enabled).length ?? 0;

  return <section className="chamber-module chamber-schedules">
    <header className="is-iconless"><div><h2>Schedules</h2><small>Lab time · America/Detroit</small></div>
      <div className="schedule-actions">
        {overview?.can_control && activeCount > 0 ? <button type="button" disabled={busy} onClick={() => pause(null)}><Pause size={14} /> Pause all</button> : null}
        {overview?.can_control ? <button type="button" className="schedule-primary" disabled={busy} onClick={() => open()}><Plus size={15} /> New schedule</button> : null}
      </div>
    </header>
    <div className="schedule-content">
      {overview && !overview.scheduler_online ? <p className="schedule-error" role="alert">The scheduler has not reported a recent successful check. Do not rely on upcoming runs until it reconnects.</p> : null}
      {loading ? <p><Loader2 size={18} className="chart-loading-spinner" /> Loading schedules…</p> : null}
      {connectionError || error ? <p className="schedule-error" role="alert">{connectionError ?? error}</p> : null}
      {notice ? <p className="schedule-notice" role="status">{notice}</p> : null}
      {form ? <form ref={editorRef} className="schedule-form" onSubmit={submit}>
        <div className="schedule-form-title"><strong>{editing ? "Edit schedule" : "New schedule"}</strong><button type="button" aria-label="Close schedule editor" disabled={busy} onClick={() => setForm(null)}><X size={17} /></button></div>
        <fieldset disabled={busy}>
          <p className="schedule-help">Choose a time at least one minute ahead. Leave three minutes between schedules for the same device.</p>
          <div className="schedule-fields">
            <label>Name<input required maxLength={80} value={form.name} placeholder="Morning conditions" onChange={e => patch({ name: e.target.value })} /></label>
            <label>Time in the lab<input required type="time" value={form.local_time} onChange={e => patch({ local_time: e.target.value })} /></label>
            <label>Repeat<select value={form.repeat_daily ? "repeat" : "once"} onChange={e => patch({ repeat_daily: e.target.value === "repeat" })}><option value="repeat">On selected days</option><option value="once">Once</option></select></label>
            <label>{form.repeat_daily ? "Start date" : "Date"}<input required type="date" value={form.starts_on} onChange={e => patch({ starts_on: e.target.value })} /></label>
            {form.repeat_daily ? <label>End date · optional<input type="date" min={form.starts_on} value={form.ends_on} onChange={e => patch({ ends_on: e.target.value })} /></label> : null}
          </div>
          {form.repeat_daily ? <div className="schedule-day-picker"><div className="schedule-day-heading"><strong>Days to run</strong><span><button type="button" onClick={() => patch({ weekdays: [0,1,2,3,4,5,6] })}>Every day</button><button type="button" onClick={() => patch({ weekdays: [1,2,3,4,5] })}>Weekdays</button><button type="button" onClick={() => patch({ weekdays: [] })}>Clear</button></span></div><div className="schedule-days" role="group" aria-label="Days to run">{weekdays.map((day, i) => <button key={day} type="button" aria-label={`${day}: ${form.weekdays.includes(i) ? "selected" : "not selected"}`} aria-pressed={form.weekdays.includes(i)} onClick={() => patch({ weekdays: form.weekdays.includes(i) ? form.weekdays.filter(d => d !== i) : [...form.weekdays, i].sort() })}><span className="schedule-day-check" aria-hidden="true">{form.weekdays.includes(i) ? <Check size={13} strokeWidth={3} /> : null}</span>{day}</button>)}</div><p className="schedule-day-summary">{form.weekdays.length === 7 ? "Runs every day" : form.weekdays.length ? `Runs on ${form.weekdays.map(d => weekdays[d]).join(", ")}` : "Select at least one day"}</p></div> : null}
          <div className="schedule-targets">
            <label><input type="checkbox" checked={form.actions.gas !== undefined} onChange={e => { const actions = { ...form.actions }; if (e.target.checked) actions.gas = emptyRecipe(); else delete actions.gas; patch({ actions }); }} /> Gas recipe</label>
            <label><input type="checkbox" checked={form.actions.light !== undefined} onChange={e => { const actions = { ...form.actions }; if (e.target.checked) actions.light = 134; else delete actions.light; patch({ actions }); }} /> Lights</label>
          </div>
          {form.actions.gas ? <div className="schedule-recipe">
            <div className="schedule-form-title"><strong>Gas settings</strong><button type="button" disabled={!gas} onClick={() => { if (gas) setRecipe({ total_slpm: gas.applied_state.total_slpm, use_licor: gas.applied_state.use_licor, ratios: Object.fromEntries(channels.map(k => [k, gas.applied_state.channels[k].ratio])) as Recipe["ratios"] }); }}>Copy last reported settings</button></div>
            <div className="schedule-fields"><label>Total SLPM<input required type="number" min={0} max={9} step={0.001} value={form.actions.gas.total_slpm} onChange={e => setRecipe({ total_slpm: Number(e.target.value) })} /></label>
              {channels.map(k => { const config = gasMixerNativeChannelConfig.find(c => c.address === k)!; const available = gas?.observed_state.channels[k].available === true; return <label key={k}>{config.formula} {k} · {config.ratio_unit}{!available ? " · unavailable" : ""}<input required disabled={!available} type="number" min={0} max={k === "C" || k === "D" ? 99999 : 100} step={k === "C" || k === "D" ? 1 : 0.1} value={form.actions.gas!.ratios[k]} onChange={e => setRecipe({ ratios: { ...form.actions.gas!.ratios, [k]: Number(e.target.value) } })} /></label>; })}
            </div>
            <label className="schedule-check"><input type="checkbox" checked={form.actions.gas.use_licor} onChange={e => setRecipe({ use_licor: e.target.checked })} /> Enable LI-COR after applying the recipe</label>
            <p className="schedule-help">N₂ A supplies the remaining balance. Composition changes briefly set flow to zero, then restore the requested flow. LI-COR can change O₂ afterward.</p>
          </div> : null}
          {form.actions.light !== undefined ? <label className="schedule-light">Light intensity · 0 for off, 10–255 for on<input required type="number" min={0} max={255} step={1} value={form.actions.light} onChange={e => patch({ actions: { ...form.actions, light: Number(e.target.value) } })} /></label> : null}
        </fieldset>
        {review ? <div className="schedule-review"><strong>{form.name} · {form.local_time} lab time</strong><p>{describeActions(form.actions)}</p><p>{form.repeat_daily ? `Repeats ${form.weekdays.map(d => weekdays[d]).join(", ")} from ${form.starts_on}${form.ends_on ? ` through ${form.ends_on}` : ""}` : `Once on ${form.starts_on}`}.</p><div className="schedule-actions"><button type="button" disabled={busy} onClick={() => save(true)}><Play size={14} />{busy ? "Saving…" : editing && form.enabled ? "Save changes" : "Save & activate"}</button><button type="button" className="schedule-secondary" disabled={busy} onClick={() => save(false)}>Save paused</button><button type="button" className="schedule-secondary" disabled={busy} onClick={() => setReview(false)}>Back</button></div></div> : <button className="schedule-primary" type="submit" disabled={busy}>Review schedule</button>}
      </form> : null}
      {!loading && overview?.schedules.length === 0 ? <div className="schedule-empty"><CalendarClock size={23} /><span>No schedules yet. Choose New schedule to get started.</span></div> : null}
      <div className="schedule-list">{overview?.schedules.map(schedule => <article key={schedule.id}>
        <div><strong>{schedule.name}</strong><span className={`schedule-badge ${schedule.enabled ? "is-enabled" : ""}`}>{schedule.enabled ? "Active" : schedule.can_resume ? "Paused" : "Ended"}</span><p>{describeActions(schedule.actions)}</p><small>{schedule.enabled ? `Next: ${timeLabel(schedule.next_run_at)}` : `${schedule.local_time.slice(0, 5)} lab time`} · {schedule.repeat_daily ? schedule.weekdays.map(d => weekdays[d]).join(", ") : "Once"}<br />{schedule.owner}</small></div>
        {overview.can_control ? <div className="schedule-row-controls"><div className="schedule-actions">{schedule.enabled ? <button type="button" disabled={busy} onClick={() => pause(schedule.id)}><Pause size={14} /> Pause</button> : schedule.can_resume ? <button type="button" className="schedule-primary" disabled={busy} onClick={() => resume(schedule)}><Play size={14} /> Resume</button> : <button type="button" className="schedule-primary" disabled={busy} onClick={() => { open(schedule); setNotice("Choose a new date or time, then save and activate."); }}><CalendarClock size={14} /> Change time</button>}<button type="button" disabled={busy} onClick={() => open(schedule)}><Pencil size={14} /> Edit</button><button type="button" className="schedule-delete" disabled={busy} onClick={() => setDeleting(schedule)}><Trash2 size={14} /> Delete</button></div>{deleting?.id === schedule.id ? <div className="schedule-delete-confirm" role="group" aria-label={`Delete ${schedule.name}`}><strong>Delete “{schedule.name}”?</strong><p>Future runs stop. Past runs stay in history.</p><div className="schedule-actions"><button type="button" className="schedule-delete-confirm-button" disabled={busy} onClick={() => remove(deleting)}>Delete schedule</button><button type="button" disabled={busy} onClick={() => setDeleting(null)}>Cancel</button></div></div> : null}</div> : null}
      </article>)}</div>
      {overview && overview.runs.length > 0 ? <details className="schedule-history" open={overview.runs.some(r => ["failed", "partial", "missed"].includes(r.status))}><summary>Recent runs</summary><div className="schedule-history-scroll"><table><thead><tr><th>Lab time / schedule</th><th>Result</th></tr></thead><tbody>{overview.runs.map(run => <tr key={run.id}><td>{timeLabel(run.due_at)}<br /><strong>{run.name}</strong></td><td>{run.status === "applied" ? "Controller applied" : run.status}<small>Gas: {run.gas_status}<br />Lights: {run.light_status}</small></td></tr>)}</tbody></table></div></details> : null}
      <ScheduleHelp />
    </div>
  </section>;
}
