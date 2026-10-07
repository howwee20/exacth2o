import { type ReactNode } from "react";
import { type HealthSelectedDetail } from "../portalTypes";

export function HealthSelectedDetailDrawer({
  detail,
  onClose,
}: {
  detail: HealthSelectedDetail | null;
  onClose: () => void;
}) {
  if (!detail) return null;

  return (
    <>
      <button
        type="button"
        className="health-detail-scrim"
        aria-label="Close selected detail"
        onClick={onClose}
      />
      <aside className="health-selected-detail" aria-label="Selected detail">
        <header>
          <div>
            <p>Selected Detail</p>
            <h2>{detail.title}</h2>
          </div>
          <button type="button" onClick={onClose}>Close</button>
        </header>
        <div className="health-selected-detail-rows">
          {detail.rows.map((row) => (
            <div className="health-selected-detail-row" key={row.label}>
              <span>{row.label}</span>
              <strong>{row.value}</strong>
            </div>
          ))}
        </div>
      </aside>
    </>
  );
}

export function HealthMiniFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="health-mini-fact">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function HealthPanel({
  title,
  detail,
  badge,
  badgeTone = "ok",
  children,
}: {
  title: string;
  detail: string;
  badge?: string;
  badgeTone?: "ok" | "warning" | "bad" | "unknown";
  children: ReactNode;
}) {
  return (
    <section className="health-evidence-panel">
      <div className="health-evidence-head">
        <div>
          <h2>{title}</h2>
          <p>{detail}</p>
        </div>
        {badge ? <span className={`portal-status-pill is-${badgeTone}`}>{badge}</span> : null}
      </div>
      {children}
    </section>
  );
}
