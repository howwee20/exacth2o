import { ListChecks, Loader2 } from "lucide-react";

export type OperationActivityItem = {
  id: string;
  label: string;
  status: string;
  statusLabel: string;
  createdAt: string;
  createdAtLabel: string;
  active: boolean;
};

export function OperationActivity({
  items,
  activeCount,
  loading,
}: {
  items: readonly OperationActivityItem[];
  activeCount: number;
  loading: boolean;
}) {
  return (
    <section className="portal-command-activity" aria-label="System activity">
      <header>
        <div>
          <ListChecks size={17} />
          <h2>Activity</h2>
        </div>
        <span className={activeCount ? "is-active" : ""}>
          {activeCount ? `${activeCount} active` : "No active work"}
        </span>
      </header>
      {loading && items.length === 0 ? (
        <div className="portal-command-empty">
          <Loader2 className="chart-loading-spinner" size={16} />
          Checking activity
        </div>
      ) : items.length ? (
        <div className="portal-command-list">
          {items.map((item) => (
            <div className="portal-command-row" key={item.id}>
              <span
                className={`portal-command-dot ${item.active ? "is-active" : `is-${item.status}`}`}
                aria-hidden="true"
              />
              <strong>{item.label}</strong>
              <time dateTime={item.createdAt}>{item.createdAtLabel}</time>
              <em className={`is-${item.status}`}>{item.statusLabel}</em>
            </div>
          ))}
        </div>
      ) : (
        <div className="portal-command-empty">Confirmed work will appear here.</div>
      )}
    </section>
  );
}
