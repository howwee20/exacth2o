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
        {freshness.measuredAtMs == null ? (
          <strong>No readings in the last 72 hours</strong>
        ) : (
          <>
            <strong><LatestReadingText freshness={freshness} /></strong>
            {absolute ? <span>{absolute}</span> : null}
          </>
        )}
      </span>
      <span className="measurement-status-meta">
        {progress ? <span>{progress}</span> : null}
        {totalPots ? <span>{`${reportingPots} of ${totalPots} pots reporting`}</span> : null}
        {freshness.expectedIntervalMs == null ? null : (
          <span title="Reporting interval configured on the controller">{freshness.detail.match(/expected [^)]+/)?.[0] ?? ""}</span>
        )}
      </span>
      <span className="measurement-status-checked" aria-live="polite">
        {fetchError
          ? <span className="is-error" title={fetchError}>Couldn’t check for new data · showing readings already loaded</span>
          : refreshing
            ? "Checking for new readings…"
            : checked
              ? `Portal checked ${checked}`
              : null}
      </span>
    </section>
  );
}
