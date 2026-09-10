import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { CalendarClock, Loader2, Pause, Pencil, Plus, X } from "lucide-react";
import { supabase } from "./supabase";
import { loadGasMixerNativeStatus } from "./gasMixerNativeClient";
import { gasMixerNativeChannelConfig, type GasMixerNativeStatus } from "./gasMixerNative";
import "./chamberSchedules.css";

type Channel = "B" | "C" | "D" | "E" | "F";
type Recipe = { total_slpm: number; use_licor: boolean; ratios: Record<Channel, number> };
type Actions = { gas?: Recipe; light?: number };
type Definition = { name: string; local_time: string; weekdays: number[]; starts_on: string; ends_on: string; repeat_daily: boolean; actions: Actions; enabled: boolean };
type Schedule = Definition & { id: string; owner: string; next_run_at: string | null };
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

export function ChamberSchedules() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState<Definition | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
    setForm(schedule ? { ...schedule, ends_on: schedule.ends_on ?? "", local_time: schedule.local_time.slice(0, 5) } : blank());
    setReview(false); setError(null); setNotice(null);
    void loadGasMixerNativeStatus().then(setGas).catch(() => setGas(null));
  };
  const patch = (changes: Partial<Definition>) => { setForm(current => current ? { ...current, ...changes } : current); setReview(false); };
  const setRecipe = (changes: Partial<Recipe>) => { if (form?.actions.gas) patch({ actions: { ...form.actions, gas: { ...form.actions.gas, ...changes } } }); };
  const pause = (id: string | null) => void operate(async () => {
    const { error: reason } = await supabase.rpc("chamber_schedule_pause", { p_schedule_id: id });
    if (reason) throw reason;
    setNotice("Schedules paused. Live settings stay as they are; commands already accepted may finish.");
  });
  const save = () => void operate(async () => {
    if (!form) return;
    const { error: reason } = await supabase.rpc("chamber_schedule_save", { schedule_id: editing, definition: form });
    if (reason) throw reason;
    setForm(null); setReview(false); setNotice(form.enabled ? "Schedule saved and enabled." : "Schedule saved as paused.");
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
        {overview?.can_control ? <button type="button" disabled={busy} onClick={() => open()}><Plus size={15} /> New schedule</button> : null}
      </div>
    </header>
    <div className="schedule-content">
      {overview && !overview.scheduler_online ? <p className="schedule-error" role="alert">The scheduler has not reported a recent successful check. Do not rely on upcoming runs until it reconnects.</p> : null}
      {loading ? <p><Loader2 size={18} className="chart-loading-spinner" /> Loading schedules…</p> : null}
      {connectionError || error ? <p className="schedule-error" role="alert">{connectionError ?? error}</p> : null}
      {notice ? <p className="schedule-notice" role="status">{notice}</p> : null}
      {form ? <form className="schedule-form" onSubmit={submit}>
        <div className="schedule-form-title"><strong>{editing ? "Edit schedule" : "New schedule"}</strong><button type="button" aria-label="Close schedule editor" disabled={busy} onClick={() => setForm(null)}><X size={17} /></button></div>
        <fieldset disabled={busy}>
          <p className="schedule-help">Choose a time at least one minute ahead. Leave three minutes between schedules for the same device.</p>
          <div className="schedule-fields">
            <label>Name<input required maxLength={80} value={form.name} placeholder="Morning conditions" onChange={e => patch({ name: e.target.value })} /></label>
            <label>Time in the lab<input required type="time" value={form.local_time} onChange={e => patch({ local_time: e.target.value })} /></label>
            <label>Repeat<select value={form.repeat_daily ? "repeat" : "once"} onChange={e => patch({ repeat_daily: e.target.value === "repeat" })}><option value="repeat">Weekly / every day</option><option value="once">Once</option></select></label>
            <label>{form.repeat_daily ? "Start date" : "Date"}<input required type="date" value={form.starts_on} onChange={e => patch({ starts_on: e.target.value })} /></label>
            {form.repeat_daily ? <label>End date · optional<input type="date" min={form.starts_on} value={form.ends_on} onChange={e => patch({ ends_on: e.target.value })} /></label> : null}
          </div>
          {form.repeat_daily ? <div className="schedule-days" role="group" aria-label="Days of the week">{weekdays.map((day, i) => <button key={day} type="button" aria-pressed={form.weekdays.includes(i)} onClick={() => patch({ weekdays: form.weekdays.includes(i) ? form.weekdays.filter(d => d !== i) : [...form.weekdays, i].sort() })}>{day}</button>)}</div> : null}
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
          <label className="schedule-check"><input type="checkbox" checked={form.enabled} onChange={e => patch({ enabled: e.target.checked })} /> Enable this schedule</label>
        </fieldset>
        {review ? <div className="schedule-review"><strong>{form.name} · {form.local_time} lab time</strong><p>{describeActions(form.actions)}</p><p>{form.repeat_daily ? `Repeats ${form.weekdays.map(d => weekdays[d]).join(", ")} from ${form.starts_on}${form.ends_on ? ` through ${form.ends_on}` : ""}` : `Once on ${form.starts_on}`}. {form.enabled ? "Enabled after saving." : "Saved as paused."}</p><button type="button" disabled={busy} onClick={save}>{busy ? "Saving…" : "Confirm and save"}</button></div> : <button className="schedule-primary" type="submit" disabled={busy}>Review schedule</button>}
      </form> : null}
      {!loading && overview?.schedules.length === 0 ? <div className="schedule-empty"><CalendarClock size={23} /><span>No schedules yet. Add the times and settings for your experiment.</span></div> : null}
      <div className="schedule-list">{overview?.schedules.map(schedule => <article key={schedule.id}>
        <div><strong>{schedule.name}</strong><span className={`schedule-badge ${schedule.enabled ? "is-enabled" : ""}`}>{schedule.enabled ? "Enabled" : "Paused"}</span><p>{describeActions(schedule.actions)}</p><small>{schedule.enabled ? `Next: ${timeLabel(schedule.next_run_at)}` : `${schedule.local_time.slice(0, 5)} lab time`} · {schedule.repeat_daily ? schedule.weekdays.map(d => weekdays[d]).join(", ") : "Once"}<br />{schedule.owner}</small></div>
        {overview.can_control ? <div className="schedule-actions">{schedule.enabled ? <button type="button" disabled={busy} onClick={() => pause(schedule.id)}><Pause size={14} /> Pause</button> : null}<button type="button" disabled={busy} onClick={() => open(schedule)}><Pencil size={14} /> {schedule.enabled ? "Edit" : "Edit / resume"}</button></div> : null}
      </article>)}</div>
      {overview && overview.runs.length > 0 ? <details className="schedule-history" open={overview.runs.some(r => ["failed", "partial", "missed"].includes(r.status))}><summary>Recent runs</summary><div className="schedule-history-scroll"><table><thead><tr><th>Lab time / schedule</th><th>Result</th><th>Details</th></tr></thead><tbody>{overview.runs.map(run => <tr key={run.id}><td>{timeLabel(run.due_at)}<br /><strong>{run.name}</strong></td><td>{run.status === "applied" ? "Controller applied" : run.status}<small>Gas: {run.gas_status}<br />Lights: {run.light_status}</small></td><td>{run.detail ?? "Waiting for controller confirmation"}</td></tr>)}</tbody></table></div></details> : null}
      <details className="schedule-rules"><summary>Using schedules</summary><p>Schedules apply the saved settings. For combined schedules, gas changes first, then lights.</p><p>Changing a device through the portal pauses its schedules. Pause schedules before using local controls. Pausing leaves the current settings in place.</p><p>Keep controllers online. Failed or missed runs pause the schedule; check Recent runs before resuming. Times follow the lab’s time zone.</p></details>
    </div>
  </section>;
}
