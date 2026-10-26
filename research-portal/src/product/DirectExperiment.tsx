import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { launchExperiment, preflightExperiment } from '../experimentClient';
import { experimentDraftFromPortalExperiment, type ExperimentDraft } from '../experimentSpec';
import type { PortalExperiment } from '../experimentRegistry';
import type { ChartTargetLine } from '../portalTypes';
import { navigatePortal } from '../portalRoute';
import type { PairingRow } from '../types';
import { readDirectCommands } from '../directExperimentClient';
import { clampTarget, commandOutcome, pillOffsets, potRanges, targetDraft, targetGroups, targetLabel, type TargetGroup } from './directExperimentModel';
import { TargetBand, TargetPill, TargetPopover, type TargetGeometry } from './TargetControl';
import { TargetConfirmation, type TargetReview } from './TargetConfirmation';

export type DirectChartState = {
  groups: boolean;
  viewToggle: ReactNode;
  affected: Set<string>;
  lines: ChartTargetLine[];
  targetLayer?: (geometry: TargetGeometry) => ReactNode;
  freezeScale: boolean;
  extraTargetValues: number[];
};

type Phase = 'idle' | 'applying' | 'waiting' | 'failed' | 'delayed';
type Edit = { anchor: string; scope: string; custom: string[]; value: number; phase: Phase; message: string };

const pillWidth = (label: string) => label.length * 7 + 24;

export function DirectExperiment({experiment, pairings, projectId, inventoryUpdatedAt, canEdit, demo, onRefresh, children}: {
  experiment: PortalExperiment; pairings: PairingRow[]; projectId: string; inventoryUpdatedAt: string | null;
  canEdit: boolean; demo: boolean; onRefresh: () => Promise<unknown>; children: (state: DirectChartState) => ReactNode;
}) {
  const [demoTargets, setDemoTargets] = useState<Record<string, number>>({});
  const effectivePairings = useMemo(() => demo ? pairings.map(p => ({...p, wtc_percent_limit: demoTargets[p.name] ?? p.wtc_percent_limit})) : pairings, [demo, demoTargets, pairings]);
  const [groupsView, setGroupsView] = useState(false);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [dragging, setDragging] = useState(false);
  const [popover, setPopover] = useState(false);
  const [flash, setFlash] = useState<{ value: number; text: string } | null>(null);
  const [labelStatus, setLabelStatus] = useState('');
  const [confirmation, setConfirmation] = useState<TargetReview | null>(null);
  const applying = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (!flash) return undefined; const timer = window.setTimeout(() => setFlash(null), 4000); return () => window.clearTimeout(timer); }, [flash]);

  const groups = useMemo(() => targetGroups(experiment, effectivePairings), [effectivePairings, experiment]);
  const enabledNames = useMemo(() => groups.flatMap(g => g.names), [groups]);
  const current = useCallback((name: string) => effectivePairings.find(p => p.name === name)?.wtc_percent_limit, [effectivePairings]);
  const crops = useMemo(() => [...new Set(enabledNames.map(n => experiment.assignments?.find(a => a.pairing_name === n)?.crop).filter((c): c is string => Boolean(c)))], [enabledNames, experiment.assignments]);
  const potNumber = (name: string) => effectivePairings.find(p => p.name === name)?.pot_number ?? 0;
  const cropOf = (name: string) => experiment.assignments?.find(a => a.pairing_name === name)?.crop ?? null;
  const live = experiment.mode === 'controlled' && !['completed', 'archived'].includes(experiment.status ?? '');
  const editable = (canEdit || demo) && experiment.mode === 'controlled' && (experiment.status === 'active' || demo);
  const distinguish = groups.length > 1;

  // Scope comes only from experiment assignments and live targets, never from which traces are visible.
  const scopeNames = (e: Edit): string[] => {
    if (e.scope === 'all') return enabledNames;
    if (e.scope === 'custom') return e.custom.filter(n => enabledNames.includes(n));
    if (e.scope.startsWith('crop:')) return enabledNames.filter(n => experiment.assignments?.find(a => a.pairing_name === n)?.crop === e.scope.slice(5));
    return groups.find(g => g.key === e.scope.slice(6))?.names ?? [];
  };
  const count = (n: number) => `${n} ${n === 1 ? 'pot' : 'pots'}`;
  // The chip beside the pill states exactly which pots the change touches.
  const scopeLabel = (e: Edit, names: string[]) => e.scope === 'all' ? `All ${count(names.length)}`
    : e.scope.startsWith('crop:') ? `${capital(e.scope.slice(5))} · ${count(names.length)}` : potRanges(names.map(potNumber));
  const scopeKey = edit ? scopeNames(edit).join('|') : '';
  const names = useMemo(() => scopeKey ? scopeKey.split('|') : [], [scopeKey]);
  const affected = useMemo(() => new Set(names), [names]);
  const changed = Boolean(edit && names.some(n => current(n) !== edit.value));
  const busy = edit?.phase === 'applying' || edit?.phase === 'waiting';

  const defaultScope = (group: TargetGroup) => {
    if (!distinguish) return 'all';
    if (group.crops.length === 1) {
      const cropNames = enabledNames.filter(n => experiment.assignments?.find(a => a.pairing_name === n)?.crop === group.crops[0]);
      if (cropNames.length === group.names.length) return `crop:${group.crops[0]}`;
    }
    return `group:${group.key}`;
  };
  const begin = (group: TargetGroup) => {
    setFlash(null);
    setEdit(old => old && old.anchor === group.key ? old : { anchor: group.key, scope: defaultScope(group), custom: group.names, value: group.value, phase: 'idle', message: '' });
  };
  const preview = (value: number) => setEdit(old => old && !['applying', 'waiting'].includes(old.phase) ? { ...old, value: clampTarget(value), phase: 'idle', message: '' } : old);
  const cancel = useCallback(() => { setEdit(old => old && ['applying', 'waiting'].includes(old.phase) ? old : null); setPopover(false); setDragging(false); }, []);
  const closePopover = useCallback(() => { setPopover(false); setEdit(old => old && old.phase === 'idle' && !names.some(n => current(n) !== old.value) ? null : old); }, [current, names]);

  async function save(draft: ExperimentDraft, control: boolean, scope: Set<string>) {
    if (!canEdit || !inventoryUpdatedAt || !experiment.databaseId || !experiment.currentRevisionId) throw new Error('Refresh this experiment before making changes.');
    const checked = await preflightExperiment({projectId, draft, inventoryUpdatedAt, experimentId: experiment.databaseId, expectedRevisionId: experiment.currentRevisionId});
    // An inline edit must never widen the reviewed scope or change other controls.
    if (!control && checked.plan.change_count) throw new Error('This edit would change controller settings. Use the full experiment editor.');
    if (control && checked.plan.changes.some(c => c.pairing_names.some(n => !scope.has(n)))) throw new Error('Other pots changed since this view loaded. Refresh and try again.');
    return launchExperiment({projectId, draft: checked.draft, inventoryUpdatedAt: checked.inventory_updated_at, source: 'manual', model: null, promptFingerprint: null,
      reviewedConfigHash: checked.config_hash, experimentId: experiment.databaseId, expectedRevisionId: experiment.currentRevisionId});
  }

  function reviewTarget() {
    if (!edit || busy || !changed) return;
    const group = groups.find((item) => item.key === edit.anchor);
    const label = group?.treatments?.length === 1 && group.treatments[0] ? group.treatments[0] : 'moisture';
    setPopover(false);
    setConfirmation({ label, names: [...names], previous: names.map(current), value: edit.value });
  }

  async function apply(review: TargetReview) {
    if (!edit || busy || !changed || applying.current) return;
    setConfirmation(null);
    if (review.value !== edit.value || review.names.join('|') !== names.join('|') || review.previous.some((value, i) => value !== current(review.names[i]))) {
      setEdit({ ...edit, phase: 'failed', message: 'Targets changed while you were reviewing. Check the values and confirm again.' });
      return;
    }
    const value = edit.value, scope = new Set(names);
    let draft: ExperimentDraft;
    try { draft = targetDraft(experiment, effectivePairings, names, value); }
    catch (error) { setEdit({ ...edit, phase: 'failed', message: error instanceof Error ? error.message : 'Could not apply.' }); return; }
    applying.current = true;
    setPopover(false);
    setEdit({ ...edit, phase: 'applying', message: 'Applying…' });
    if (demo) {
      setDemoTargets(old => ({ ...old, ...Object.fromEntries(names.map(n => [n, value])) }));
      setEdit(null);
      setFlash({ value, text: 'Applied · demo only' });
      applying.current = false;
      return;
    }
    try {
      const result = await save(draft, true, scope);
      if (result.command_ids.length) {
        if (mounted.current) setEdit(old => old && { ...old, phase: 'waiting', message: 'Waiting for controller…' });
        let outcome: 'pending' | 'applied' | 'failed' = 'pending';
        for (let attempt = 0; attempt < 60 && mounted.current && outcome === 'pending'; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          outcome = commandOutcome(result.command_ids, await readDirectCommands(projectId, result.command_ids).catch(() => []));
        }
        if (outcome === 'failed') throw new Error('The controller did not complete this change.');
        await onRefresh();
        if (!mounted.current) return;
        if (outcome === 'pending') { setEdit(old => old && { ...old, phase: 'delayed', message: 'Not confirmed yet' }); return; }
      } else await onRefresh();
      if (!mounted.current) return;
      setEdit(null);
      setFlash({ value, text: result.command_ids.length ? 'Applied · controller confirmed' : 'Already at this target' });
    } catch (error) {
      await onRefresh().catch(() => undefined);
      if (mounted.current) setEdit(old => old && { ...old, phase: 'failed', message: error instanceof Error ? error.message : 'Could not apply.' });
    } finally {
      applying.current = false;
    }
  }

  async function saveLabels(kind: 'name' | 'crop' | 'treatment', text: string) {
    if (!edit) return;
    setLabelStatus('Saving…');
    try {
      const draft = experimentDraftFromPortalExperiment(experiment, pairings);
      draft.controller_changes_requested = false;
      if (kind === 'name') draft.name = text.trim();
      else draft.assignments = draft.assignments.map(a => affected.has(a.pairing_name) ? { ...a, [kind]: text.trim() || null } : a);
      if (demo) { setLabelStatus('Demo only · not saved'); return; }
      await save(draft, false, affected);
      await onRefresh();
      if (mounted.current) setLabelStatus('Saved');
    } catch (error) { if (mounted.current) setLabelStatus(error instanceof Error ? error.message : 'Could not save.'); }
  }

  // Escape restores the previous value when no field has focus inside the popover.
  useEffect(() => {
    if (!edit || popover) return undefined;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [cancel, edit, popover]);

  const lines: ChartTargetLine[] = live ? groups.map(g => ({ value: g.value, label: targetLabel(g.value, g, distinguish), tone: 'neutral' })) : [];

  const targetLayer = live && groups.length ? (geometry: TargetGeometry) => {
    const anchor = edit ? groups.find(g => g.key === edit.anchor) ?? null : null;
    const shown = groups.map(group => {
      const editing = anchor?.key === group.key && edit;
      const value = editing ? edit.value : group.value;
      // While editing, the chip names the pots, so the pill shows only the value.
      const label = editing ? (distinguish ? `${value}%` : `${value}% target`) : targetLabel(value, group, distinguish);
      return { group, value, label, editing: Boolean(editing), y: geometry.yScale(value) };
    });
    const offsets = pillOffsets(shown.map(item => ({ key: item.group.key, y: item.y, width: pillWidth(item.label) + (item.editing && changed ? 150 : 0) })));
    return <>
      {edit && changed ? <div className="px-tline" style={{ top: geometry.yScale(edit.value), left: geometry.left, width: geometry.right - geometry.left }} /> : null}
      {shown.map(({ group, value, editing, y }) => <div key={`band-${group.key}`}>
        <TargetBand value={value} top={y} left={geometry.left} right={geometry.right} pixelsPerPercent={geometry.pixelsPerPercent} low={geometry.low} high={geometry.high}
          disabled={!editable || busy || Boolean(edit && !editing)} onStart={() => { begin(group); setDragging(true); }} onPreview={preview} onEnd={() => setDragging(false)} />
      </div>)}
      {shown.map(({ group, value, label, editing, y }) => {
        const left = geometry.left + 8 + (offsets.get(group.key) ?? 0);
        const dimmed = Boolean(edit && !editing && group.names.some(n => affected.has(n)));
        if (!editable) return <span key={group.key} className="px-tpill is-static" style={{ top: y, left }}>{label}</span>;
        return <div key={group.key} className={`px-tcontrol${editing ? ' is-active' : ''}`} style={{ top: y, left }}>
          <TargetPill label={label} value={value} previewing={editing && changed} disabled={busy || Boolean(edit && !editing)} dimmed={dimmed}
            ariaLabel={distinguish ? `${group.treatments?.length === 1 && group.treatments[0] ? group.treatments[0] : group.crops.map(capital).join(' / ') || `${group.names.length} pots`} target` : 'Moisture target'}
            pixelsPerPercent={geometry.pixelsPerPercent} low={geometry.low} high={geometry.high}
            onStart={() => { begin(group); setDragging(true); }} onPreview={preview} onEnd={() => setDragging(false)}
            onTap={() => { begin(group); setPopover(open => !(open && editing)); }}
            onStep={delta => { setFlash(null); setEdit(old => {
              const base = old && old.anchor === group.key ? old : { anchor: group.key, scope: defaultScope(group), custom: group.names, value: group.value, phase: 'idle' as Phase, message: '' };
              return { ...base, value: clampTarget(base.value + delta), phase: 'idle', message: '' };
            }); }}
            onCancel={cancel} onOpen={() => { begin(group); setPopover(true); }} />
          {editing ? <Cluster edit={edit!} changed={changed} scopeLabel={scopeLabel(edit!, names)}
            applyLabel={`Apply ${edit!.value}% target to ${count(names.length)}`}
            onApply={reviewTarget} onCancel={cancel} onScope={() => setPopover(open => !open)}
            onRecord={() => navigatePortal({ view: 'experiment', experiment: experiment.id, tab: 'record', pot: null })} /> : null}
          {!edit && flash && flash.value === group.value ? <span className="px-tstatus is-good" role="status">✓ {flash.text}</span> : null}
          {editing && popover ? <TargetPopover up={y - geometry.top > (geometry.bottom - geometry.top) / 2} onClose={closePopover}>
            <PopoverBody edit={edit!} names={names} crops={crops} cropOf={cropOf} enabledNames={enabledNames} potNumber={potNumber} canEdit={canEdit && !demo} demo={demo}
              experimentName={experiment.name} labelStatus={labelStatus}
              onValue={preview} onScope={(scope, custom) => setEdit(old => old && { ...old, scope, custom: custom ?? old.custom })}
              onLabels={(kind, text) => void saveLabels(kind, text)} />
          </TargetPopover> : null}
        </div>;
      })}
    </>;
  } : undefined;

  const viewToggle = <div className="chart-view-toggle px-view-toggle" role="group" aria-label="Plant view">
    <button type="button" aria-pressed={!groupsView} className={!groupsView ? 'is-selected' : ''} onClick={() => setGroupsView(false)}>Individual</button>
    <button type="button" aria-pressed={groupsView} className={groupsView ? 'is-selected' : ''} onClick={() => setGroupsView(true)}>Groups</button>
  </div>;

  return <>{children({ groups: groupsView, viewToggle, affected: edit ? affected : new Set(), lines, targetLayer, freezeScale: dragging,
    extraTargetValues: edit && !dragging ? [edit.value] : [] })}
    {confirmation ? <TargetConfirmation review={confirmation} pots={potRanges(confirmation.names.map(potNumber))} demo={demo}
      onCancel={() => { setConfirmation(null); cancel(); }} onConfirm={() => void apply(confirmation)} /> : null}
  </>;
}

function Cluster({ edit, changed, scopeLabel, applyLabel, onApply, onCancel, onScope, onRecord }: {
  edit: Edit; changed: boolean; scopeLabel: string; applyLabel: string; onApply: () => void; onCancel: () => void; onScope: () => void; onRecord: () => void;
}) {
  const stop = (event: ReactPointerEvent) => event.stopPropagation();
  if (edit.phase === 'applying' || edit.phase === 'waiting') {
    return <span className="px-tstatus" role="status"><span className="px-tspinner" aria-hidden="true" />{edit.message}</span>;
  }
  if (edit.phase === 'failed' || edit.phase === 'delayed') {
    return <span className="px-tcluster" onPointerDown={stop}>
      <span className={`px-tstatus ${edit.phase === 'failed' ? 'is-bad' : 'is-warn'}`} role="alert">{edit.message}</span>
      {edit.phase === 'failed' && changed ? <button type="button" className="px-tlink" onClick={onApply}>Retry</button> : null}
      {edit.phase === 'delayed' ? <button type="button" className="px-tlink" onClick={onRecord}>Open record</button> : null}
      <button type="button" className="px-tbtn" aria-label={edit.phase === 'failed' ? 'Dismiss and restore the previous target' : 'Dismiss'} onClick={onCancel}>×</button>
    </span>;
  }
  if (!changed) return null;
  return <span className="px-tcluster" onPointerDown={stop}>
    <button type="button" className="px-tbtn is-apply" aria-label={applyLabel} title={applyLabel} onClick={onApply}>✓</button>
    <button type="button" className="px-tbtn" aria-label="Cancel and keep the current target" title="Cancel (Esc)" onClick={onCancel}>×</button>
    <button type="button" className="px-tscope" aria-label={`Change which pots: ${scopeLabel}`} title={scopeLabel} onClick={onScope}><span>{scopeLabel}</span><span aria-hidden="true">▾</span></button>
  </span>;
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function PopoverBody({ edit, names, crops, cropOf, enabledNames, potNumber, canEdit, demo, experimentName, labelStatus, onValue, onScope, onLabels }: {
  edit: Edit; names: string[]; crops: string[]; cropOf: (name: string) => string | null; enabledNames: string[]; potNumber: (name: string) => number;
  canEdit: boolean; demo: boolean; experimentName: string; labelStatus: string;
  onValue: (value: number) => void; onScope: (scope: string, custom?: string[]) => void; onLabels: (kind: 'name' | 'crop' | 'treatment', text: string) => void;
}) {
  const [text, setText] = useState(String(edit.value));
  const [crop, setCrop] = useState('');
  const [treatment, setTreatment] = useState('');
  const [rename, setRename] = useState(experimentName);
  useEffect(() => { setText(String(edit.value)); }, [edit.value]);
  const selecting = edit.scope === 'custom' || edit.scope.startsWith('group:');
  const scopes = [
    { id: 'all', label: 'All pots', count: enabledNames.length },
    ...crops.map(c => ({ id: `crop:${c}`, label: capital(c), count: enabledNames.filter(n => cropOf(n) === c).length })),
  ];
  return <div className="px-tpop">
    <label className="px-tpop-value">Target
      <input type="number" inputMode="numeric" min={0} max={80} step={1} aria-label="Target percent" value={text} autoFocus
        onChange={event => { setText(event.target.value); const n = Number(event.target.value); if (event.target.value !== '' && Number.isInteger(n) && n >= 0 && n <= 80) onValue(n); }} />
      <span aria-hidden="true">%</span>
    </label>
    <fieldset className="px-tpop-scope">
      <legend>Applies to</legend>
      {scopes.map(scope => <label key={scope.id}><input type="radio" name="target-scope" checked={edit.scope === scope.id} onChange={() => onScope(scope.id)} />
        <span>{scope.label}</span><span className="px-tpop-count">{scope.count}</span></label>)}
      <label><input type="radio" name="target-scope" checked={selecting} onChange={() => onScope('custom', names)} /><span>Selected pots</span>
        <span className="px-tpop-count">{selecting ? names.length : ''}</span></label>
    </fieldset>
    {selecting ? <div className="px-tpop-pots" role="group" aria-label="Pots to change">
      {enabledNames.map(name => {
        const on = names.includes(name);
        return <label key={name} className={on ? 'is-on' : ''}><input type="checkbox" checked={on} aria-label={`Pot ${potNumber(name)}`}
          onChange={event => onScope('custom', event.target.checked ? [...names, name] : names.filter(n => n !== name))} />{potNumber(name)}</label>;
      })}
    </div> : null}
    <p className="px-tpop-list" aria-live="polite"><strong>{names.length} {names.length === 1 ? 'pot' : 'pots'}</strong> · {potRanges(names.map(potNumber))}</p>
    {canEdit || demo ? <details className="px-tpop-more">
      <summary>Labels and name</summary>
      <form onSubmit={event => { event.preventDefault(); onLabels('crop', crop); }}><label>Crop for these pots<input value={crop} maxLength={80} onChange={event => setCrop(event.target.value)} /></label><button className="px-button is-small" disabled={!crop.trim()}>Save</button></form>
      <form onSubmit={event => { event.preventDefault(); onLabels('treatment', treatment); }}><label>Treatment for these pots<input value={treatment} maxLength={80} onChange={event => setTreatment(event.target.value)} /></label><button className="px-button is-small" disabled={!treatment.trim()}>Save</button></form>
      <form onSubmit={event => { event.preventDefault(); onLabels('name', rename); }}><label>Experiment name<input value={rename} maxLength={120} onChange={event => setRename(event.target.value)} /></label><button className="px-button is-small" disabled={!rename.trim() || rename.trim() === experimentName}>Save</button></form>
      <p className="px-tpop-note" role="status">{labelStatus || 'Labels only. Watering is unchanged.'}</p>
    </details> : null}
  </div>;
}
