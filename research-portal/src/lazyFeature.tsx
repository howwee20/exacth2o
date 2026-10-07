import { AlertTriangle, Loader2 } from "lucide-react";
import { Component, type ComponentType, lazy, type ReactNode, Suspense } from "react";

const retryDelaysMs = [400, 1200];

/**
 * A feature loaded on first use. Transient network failures are retried; a
 * missing chunk (usually a deploy while the portal was open) surfaces in the
 * FeatureBoundary with a reload option instead of a blank screen.
 */
export function lazyFeature<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
      try {
        return await load();
      } catch (error) {
        lastError = error;
        if (attempt < retryDelaysMs.length) {
          await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
        }
      }
    }
    throw lastError;
  });
}

type BoundaryProps = {
  name: string;
  children: ReactNode;
  inline?: boolean;
  /** Render nothing (not even an error) while the feature is closed but kept mounted. */
  hidden?: boolean;
  /** A change clears a previous error, e.g. reopening the feature. */
  resetKey?: unknown;
};

/** A chunk that could not be fetched (usually a deploy while the page was open), not a bug in the feature. */
export function isChunkLoadError(error: unknown) {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? "");
  return /dynamically imported module|Importing a module script failed|ChunkLoadError|Unable to preload|Loading chunk/i.test(message);
}

class FeatureErrorBoundary extends Component<BoundaryProps, { error: unknown; failed: boolean }> {
  state = { error: null as unknown, failed: false };

  static getDerivedStateFromError(error: unknown) {
    return { error, failed: true };
  }

  componentDidUpdate(previous: BoundaryProps) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ error: null, failed: false });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    if (this.props.hidden) return null;
    const chunk = isChunkLoadError(this.state.error);
    return (
      <div className={`feature-load-state is-error ${this.props.inline ? "is-inline" : ""}`} role="alert">
        <AlertTriangle size={20} aria-hidden="true" />
        <p>
          {chunk
            ? `${this.props.name} could not be loaded. The portal may have been updated while this page was open.`
            : `${this.props.name} stopped because of an unexpected error. Reloading the portal usually clears it.`}
        </p>
        <button type="button" className="header-action" onClick={() => window.location.reload()}>
          Reload portal
        </button>
      </div>
    );
  }
}

export function FeatureLoading({ name, inline = false }: { name: string; inline?: boolean }) {
  return (
    <div className={`feature-load-state ${inline ? "is-inline" : ""}`} role="status" aria-live="polite">
      <Loader2 className="chart-loading-spinner" size={24} aria-hidden="true" />
      <p>Loading {name.toLowerCase()}…</p>
    </div>
  );
}

/** Suspense plus an error boundary around a lazily loaded feature. */
export function FeatureBoundary({ name, children, inline = false, hidden = false, resetKey, fallback }: BoundaryProps & { fallback?: ReactNode }) {
  return (
    <FeatureErrorBoundary name={name} inline={inline} hidden={hidden} resetKey={resetKey}>
      <Suspense fallback={fallback === undefined ? <FeatureLoading name={name} inline={inline} /> : fallback}>{children}</Suspense>
    </FeatureErrorBoundary>
  );
}
