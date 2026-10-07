import { Download } from "lucide-react";
import { type ReactNode } from "react";
import { collectionStartDate, formatChange, formatCount, formatDay, formatShare, shareNote, toCsv } from "./analyticsFormat";
import { type DayRow, type FunnelStep, type Metric, type OutcomeRow } from "./analyticsTypes";

export function AnalyticsSection({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="analytics-section">
      <header>
        <div>
          <h2>{title}</h2>
          {description ? <p>{description}</p> : null}
        </div>
        {actions ? <div className="analytics-section-actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

export function StatCard({
  label,
  metric,
  detail,
  previousStart,
  emphasis = false,
}: {
  label: string;
  metric: Metric | null | undefined;
  detail?: ReactNode;
  previousStart?: string;
  emphasis?: boolean;
}) {
  // When the comparison period predates collection, the range line says so once; cards show no pill.
  const comparable = !(previousStart && previousStart < collectionStartDate);
  const change = metric && comparable ? formatChange({ value: metric.value, previous: metric.previous, change: metric.change, previousStart }) : null;
  return (
    <article className={`analytics-stat ${emphasis ? "is-emphasis" : ""}`}>
      <p>{label}</p>
      <strong>{metric ? formatCount(metric.value) : "—"}</strong>
      {detail ? <small>{detail}</small> : null}
      {change ? <span className={`analytics-change is-${change.tone}`}>{change.text}</span> : null}
    </article>
  );
}

export function downloadCsv(name: string, headers: string[], rows: Array<Array<string | number | null | undefined>>) {
  const blob = new Blob([toCsv(headers, rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `exacth2o-website-${name}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function CsvButton({ name, headers, rows }: { name: string; headers: string[]; rows: Array<Array<string | number | null | undefined>> }) {
  return (
    <button type="button" className="analytics-csv" onClick={() => downloadCsv(name, headers, rows)} disabled={!rows.length}>
      <Download size={13} aria-hidden="true" />
      CSV
    </button>
  );
}

/** Sessions by source/page/device with outcomes as counts and shares. */
export function OutcomeTable({
  rows,
  keyLabel,
  csvName,
  rangeLabel,
  empty = "No sessions in this range.",
}: {
  rows: OutcomeRow[];
  keyLabel: string;
  csvName: string;
  rangeLabel: string;
  empty?: string;
}) {
  const max = Math.max(1, ...rows.map((row) => row.sessions));
  return (
    <>
      <div className="analytics-table-tools">
        <span>{rangeLabel}</span>
        <CsvButton
          name={csvName}
          headers={[keyLabel, "Sessions", "Engaged sessions", "Sessions reaching quote page", "Sessions with accepted quote (analytics)"]}
          rows={rows.map((row) => [row.key, row.sessions, row.engaged, row.quoteSessions, row.inquirySessions])}
        />
      </div>
      {rows.length ? (
        <div className="analytics-table-scroll">
          <table className="analytics-table">
            <thead>
              <tr>
                <th scope="col">{keyLabel}</th>
                <th scope="col">Sessions</th>
                <th scope="col">Engaged</th>
                <th scope="col">Reached quote</th>
                <th scope="col">Quote accepted</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <th scope="row">
                    <span className="analytics-bar" style={{ width: `${(row.sessions / max) * 100}%` }} aria-hidden="true" />
                    <span>{row.key}</span>
                  </th>
                  <td>{formatCount(row.sessions)}</td>
                  <td>{formatShare(row.engaged, row.sessions)}</td>
                  <td>{formatCount(row.quoteSessions)}</td>
                  <td>{formatCount(row.inquirySessions)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="analytics-empty">{empty}</p>}
    </>
  );
}

/** Ordered steps; each shows its count, share of the first step and of the step before. */
export function Funnel({ steps, note }: { steps: FunnelStep[]; note?: ReactNode }) {
  const first = steps[0]?.sessions ?? 0;
  return (
    <>
      <ol className="analytics-funnel">
        {steps.map((step, index) => {
          const previous = index ? steps[index - 1].sessions : null;
          return (
            <li key={step.key}>
              <span className="analytics-funnel-label">{step.label}</span>
              <span className="analytics-funnel-track" aria-hidden="true">
                <span style={{ width: `${first ? Math.max(step.sessions ? 1.5 : 0, (step.sessions / first) * 100) : 0}%` }} />
              </span>
              <span className="analytics-funnel-count">
                <strong>{formatCount(step.sessions)}</strong>
                {previous != null ? <em>{previous ? `${formatShare(step.sessions, previous)} of previous step` : "previous step: 0"}</em> : <em>sessions</em>}
              </span>
            </li>
          );
        })}
      </ol>
      {first > 0 && shareNote(first) ? <p className="analytics-note">Small sample: {formatCount(first)} sessions. Read the counts, not the percentages.</p> : null}
      {note ? <p className="analytics-note">{note}</p> : null}
    </>
  );
}

/** Daily visitors and sessions with accepted inquiries; today's partial day is marked. */
export function DailyChart({ days }: { days: DayRow[] }) {
  const width = 720;
  const height = 210;
  const pad = { left: 36, right: 10, top: 14, bottom: 34 };
  const max = Math.max(2, ...days.map((day) => Math.max(day.sessions, day.visitors)));
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const slot = plotWidth / Math.max(1, days.length);
  const barWidth = Math.max(2, Math.min(22, slot * 0.36));
  const y = (value: number) => pad.top + plotHeight - (value / max) * plotHeight;
  const labelEvery = Math.max(1, Math.ceil(days.length / 10));
  const summary = days.map((day) => `${formatDay(day.date)}: ${day.visitors} visitors, ${day.sessions} sessions${day.acceptedInquiries ? `, ${day.acceptedInquiries} accepted inquiries` : ""}${day.partial ? " (today, partial)" : ""}`).join("; ");
  return (
    <figure className="analytics-daily">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Daily traffic. ${summary}`}>
        {[0, 0.5, 1].map((fraction) => (
          <g key={fraction}>
            <line x1={pad.left} x2={width - pad.right} y1={y(max * fraction)} y2={y(max * fraction)} className="analytics-grid" />
            <text x={pad.left - 6} y={y(max * fraction) + 4} textAnchor="end">{Math.round(max * fraction)}</text>
          </g>
        ))}
        {days.map((day, index) => {
          const x = pad.left + slot * index + slot / 2;
          return (
            <g key={day.date} className={day.partial ? "is-partial" : ""}>
              <rect x={x - barWidth - 1} y={y(day.visitors)} width={barWidth} height={plotHeight + pad.top - y(day.visitors)} className="analytics-bar-visitors">
                <title>{`${formatDay(day.date)}: ${day.visitors} visitors${day.partial ? " (partial day)" : ""}`}</title>
              </rect>
              <rect x={x + 1} y={y(day.sessions)} width={barWidth} height={plotHeight + pad.top - y(day.sessions)} className="analytics-bar-sessions">
                <title>{`${formatDay(day.date)}: ${day.sessions} sessions`}</title>
              </rect>
              {day.acceptedInquiries ? (
                <circle cx={x} cy={pad.top + 4} r={4} className="analytics-inquiry-dot">
                  <title>{`${day.acceptedInquiries} accepted ${day.acceptedInquiries === 1 ? "inquiry" : "inquiries"}`}</title>
                </circle>
              ) : null}
              {index % labelEvery === 0 || index === days.length - 1 ? (
                <text x={x} y={height - 12} textAnchor="middle">{formatDay(day.date)}{day.partial ? "*" : ""}</text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <figcaption>
        <span><i className="is-visitors" />Visitors</span>
        <span><i className="is-sessions" />Sessions</span>
        <span><i className="is-inquiry" />Accepted inquiry (server record)</span>
        {days.some((day) => day.partial) ? <span>* today so far</span> : null}
      </figcaption>
    </figure>
  );
}

export function KeyValueTable({
  rows,
  headers,
  csvName,
  empty,
}: {
  rows: Array<Array<string | number | null | undefined>>;
  headers: string[];
  csvName: string;
  empty: string;
}) {
  return (
    <>
      <div className="analytics-table-tools">
        <span />
        <CsvButton name={csvName} headers={headers} rows={rows} />
      </div>
      {rows.length ? (
        <div className="analytics-table-scroll">
          <table className="analytics-table">
            <thead>
              <tr>{headers.map((header) => <th scope="col" key={header}>{header}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index}>
                  {row.map((cell, cellIndex) => cellIndex === 0
                    ? <th scope="row" key={cellIndex}>{cell ?? "—"}</th>
                    : <td key={cellIndex}>{typeof cell === "number" ? formatCount(cell) : cell ?? "—"}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="analytics-empty">{empty}</p>}
    </>
  );
}
