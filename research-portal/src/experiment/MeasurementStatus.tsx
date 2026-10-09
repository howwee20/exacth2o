import { type Freshness, formatAge, formatCheckedAt, formatMeasurementTime } from "../measurementFreshness";

/** Small status pill; the state is always written out, never conveyed by colour alone. */
export function FreshnessPill({ freshness, compact = false }: { freshness: Freshness; compact?: boolean }) {
  return (
    <span
      className={`freshness-pill is-${freshness.state} ${compact ? "is-compact" : ""}`}
      title={freshness.detail}
    >
      <i aria-hidden="true" />
      {freshness.label}
    </span>
  );
}

/** "Latest reading 4 min ago" with the absolute time (and zone) available on hover. */
export function LatestReadingText({
  freshness,
  emptyText = "No readings in the last 72 hours",
}: {
  freshness: Freshness;
  emptyText?: string;
}) {
  if (freshness.measuredAtMs == null) return <>{emptyText}</>;
  return (
    <time dateTime={new Date(freshness.measuredAtMs).toISOString()} title={formatMeasurementTime(freshness.measuredAtMs) ?? undefined}>
      Latest reading {formatAge(freshness.ageMs)}
    </time>
  );
}

/**
 * Experiment status strip: what was measured, when, how that compares with the
 * expected cadence, and (separately) when the portal last checked for data.
 */
export function MeasurementStatusBar({
  freshness,
  checkedAt,
  refreshing,
  reportingPots,
  totalPots,
  fetchError,
  progress = null,
}: {
  progress?: string | null;
  freshness: Freshness;
  checkedAt: string | null;
  refreshing: boolean;
  reportingPots: number;
  totalPots: number;
  fetchError: string | null;
}) {
  const absolute = formatMeasurementTime(freshness.measuredAtMs);
  const checked = formatCheckedAt(checkedAt);
  return (
    <section className={`measurement-status is-${freshness.state}`} aria-label="Measurement status">
      <FreshnessPill freshness={freshness} />
      <span className="measurement-status-main">
        <strong><LatestReadingText freshness={freshness} /></strong>
      </span>
      {totalPots ? <span className="measurement-status-meta">{reportingPots} of {totalPots} pots reporting</span> : null}
      <details className="measurement-status-details">
        <summary>Data details</summary>
        <div>
          {absolute ? <p>Measured {absolute}</p> : null}
          {progress ? <p>{progress}</p> : null}
          <p>{freshness.detail}</p>
          {checked ? <p>Portal checked {checked}</p> : null}
        </div>
      </details>
      <span className="measurement-status-checked" aria-live="polite">
        {fetchError
          ? <span className="is-error" title={fetchError}>Couldn’t refresh · showing previously loaded readings</span>
          : refreshing ? "Checking for new readings…" : null}
      </span>
    </section>
  );
}
