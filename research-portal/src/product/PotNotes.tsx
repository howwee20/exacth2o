import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { draftKey, loadDraft, saveDraft, type OutboxEntry } from "../noteOutbox";
import { formatMeasurementTime } from "../measurementFreshness";
import { loadPotNotes, type PotNote } from "../potNotesClient";
import "./product.css";

export const quickTags = ["sensor reseated", "emitter checked", "pot moved", "hand-watered", "plant observation"];

/** Notes for one pot from the database; refreshed when `refreshKey` changes. */
export function usePotNotes(projectId: string | null, deviceId: string | null, pairingName: string | null, refreshKey: unknown) {
  const [notes, setNotes] = useState<PotNote[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!projectId || !deviceId || !pairingName) return;
    setLoading(true);
    try {
      setNotes(await loadPotNotes(projectId, deviceId, { pairingNames: [pairingName], limit: 100 }));
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Notes could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [deviceId, pairingName, projectId]);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);
  return { notes, loading, error, reload: load };
}

function stateLabel(entry: OutboxEntry) {
  if (entry.state === "failed") return "Not accepted";
  if (entry.state === "sending") return "Sending…";
  if (entry.needsSignIn) return "Waiting — sign in again to send";
  return "Saved on this device · waiting to send";
}

export function NoteComposer({
  userId,
  projectId,
  pairingName,
  potLabel,
  large = false,
  supersedes,
  onSave,
  onCancel,
}: {
  userId: string;
  projectId: string;
  pairingName: string;
  potLabel: string;
  large?: boolean;
  supersedes?: PotNote | null;
  onSave: (body: string, tags: string[]) => Promise<void>;
  onCancel?: () => void;
}) {
  const key = draftKey(userId, projectId, supersedes ? `${pairingName}:correct:${supersedes.id}` : pairingName);
  const initial = loadDraft(key);
  const [body, setBody] = useState(initial?.body ?? "");
  const [tags, setTags] = useState<string[]>(initial?.tags ?? []);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const id = useId();
  useEffect(() => saveDraft(key, { body, tags }), [body, key, tags]);
  return (
    <form
      className={`px-note-form ${large ? "is-large" : ""}`}
      onSubmit={async (event) => {
        event.preventDefault();
        if (!body.trim()) return;
        setSaving(true);
        setProblem(null);
        try {
          await onSave(body.trim(), tags);
          saveDraft(key, { body: "", tags: [] });
          setBody("");
          setTags([]);
        } catch (error) {
          // The draft stays in the box and in storage.
          setProblem(error instanceof Error ? error.message : "The note could not be saved on this device.");
        } finally {
          setSaving(false);
        }
      }}
    >
      <label htmlFor={id} className="px-note-label">
        {supersedes ? `Correct the note from ${formatMeasurementTime(supersedes.observed_at)}` : `Note for ${potLabel}`}
      </label>
      <textarea
        id={id}
        value={body}
        maxLength={2000}
        rows={large ? 5 : 3}
        placeholder={supersedes ? "What should the record say instead?" : "What did you see or do?"}
        onChange={(event) => setBody(event.target.value)}
      />
      <div className="px-note-tags" role="group" aria-label="Tags">
        {quickTags.map((tag) => (
          <button key={tag} type="button" aria-pressed={tags.includes(tag)} onClick={() => setTags((current) => current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag])}>
            {tag}
          </button>
        ))}
      </div>
      {problem ? <p className="px-notice is-bad" role="alert">{problem}</p> : null}
      <div className="px-note-actions">
        <button type="submit" className="px-button is-primary" disabled={!body.trim() || saving}>{saving ? "Saving…" : supersedes ? "Save correction" : "Save note"}</button>
        {onCancel ? <button type="button" className="px-button is-quiet" onClick={onCancel}>Cancel</button> : null}
        <span className="px-muted px-small">Saved on this device first; sent when there is a connection. The draft is kept if you leave.</span>
      </div>
    </form>
  );
}

/** Notes on a pot: waiting ones from this device, then the record, newest first. */
export function PotNotesList({
  notes,
  waiting,
  loading,
  error,
  canWrite,
  onRetry,
  onDiscard,
  onCorrect,
}: {
  notes: readonly PotNote[];
  waiting: readonly OutboxEntry[];
  loading: boolean;
  error: string | null;
  canWrite: boolean;
  onRetry: (id: string) => void;
  onDiscard: (id: string) => void;
  onCorrect?: (note: PotNote) => void;
}) {
  const storedIds = useMemo(() => new Set(notes.map((note) => note.id)), [notes]);
  const supersededBy = useMemo(() => {
    const map = new Map<string, PotNote>();
    for (const note of notes) if (note.supersedes_id) map.set(note.supersedes_id, note);
    return map;
  }, [notes]);
  const pending = waiting.filter((entry) => !storedIds.has(entry.id) && entry.state !== "sent");
  if (!pending.length && !notes.length) {
    return <p className="px-muted px-small">{loading ? "Loading notes…" : error ? `Notes could not be loaded: ${error}` : "No notes for this pot yet."}</p>;
  }
  return (
    <ol className="px-notes" aria-label="Notes">
      {pending.map((entry) => (
        <li key={entry.id} className={`px-note is-${entry.state}`}>
          <p className="px-note-body">{entry.body}</p>
          {entry.tags.length ? <p className="px-note-tags-line">{entry.tags.join(" · ")}</p> : null}
          <p className="px-note-meta">
            <b>{stateLabel(entry)}</b> · written {formatMeasurementTime(entry.observedAt)} on this device
            {entry.state === "failed" && entry.lastError ? ` · ${entry.lastError}` : ""}
          </p>
          {entry.state === "failed" ? (
            <div className="px-note-actions">
              <button type="button" className="px-button is-small" onClick={() => onRetry(entry.id)}>Try again</button>
              <button type="button" className="px-button is-small is-quiet" onClick={() => {
                if (window.confirm("Discard this note? It has not reached the record and will be removed from this device.")) onDiscard(entry.id);
              }}>Discard</button>
            </div>
          ) : null}
        </li>
      ))}
      {notes.map((note) => {
        const correction = supersededBy.get(note.id);
        const writtenOffline = note.client_context?.written_offline === true;
        const receivedLate = writtenOffline || Math.abs(Date.parse(note.recorded_at) - Date.parse(note.observed_at)) > 2 * 60_000;
        return (
          <li key={note.id} className={`px-note ${correction ? "is-superseded" : ""}`}>
            <p className="px-note-body">{note.body}</p>
            {note.tags.length ? <p className="px-note-tags-line">{note.tags.join(" · ")}</p> : null}
            <p className="px-note-meta">
              {note.author_label} · written {formatMeasurementTime(note.observed_at)}{writtenOffline ? " without a connection" : ""}
              {receivedLate ? ` · received ${formatMeasurementTime(note.recorded_at)}` : ""}
              {note.supersedes_id ? " · correction" : ""}
              {correction ? ` · corrected ${formatMeasurementTime(correction.observed_at)}` : ""}
            </p>
            {canWrite && onCorrect && !correction ? (
              <button type="button" className="px-link-button" onClick={() => onCorrect(note)}>Correct this note</button>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
