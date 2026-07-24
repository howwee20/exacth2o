import { useEffect, useState } from "react";
import { AlertTriangle, Archive, Check, Loader2, X } from "lucide-react";
import {
  archiveExperiment,
  preflightExperimentArchive,
  type ExperimentArchivePreflight,
} from "./experimentClient";

type ExperimentArchiveReviewProps = {
  projectId: string;
  experiment: string;
  onClose: () => void;
  onArchived: () => Promise<void>;
};

export function ExperimentArchiveReview({
  projectId,
  experiment,
  onClose,
  onArchived,
}: ExperimentArchiveReviewProps) {
  const [review, setReview] = useState<ExperimentArchivePreflight | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [archiving, setArchiving] = useState(false);
  const [archived, setArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void preflightExperimentArchive(projectId, experiment)
      .then((result) => {
        if (active) setReview(result);
      })
      .catch((nextError) => {
        if (active) {
          setError(
            nextError instanceof Error
              ? nextError.message
              : "Could not review the experiment.",
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [experiment, projectId]);

  const removeExperiment = async () => {
    if (!review || !review.can_archive || !confirmed) return;
    setArchiving(true);
    setError(null);
    try {
      await archiveExperiment({
        projectId,
        experiment: review.experiment_slug,
        experimentId: review.experiment_id,
        reviewToken: review.review_token,
      });
      setArchived(true);
      await onArchived();
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "Could not remove the experiment.",
      );
    } finally {
      setArchiving(false);
    }
  };

  return (
    <section className="portal-inline-settings experiment-archive-review">
      <header>
        <h2>Remove experiment</h2>
        <button type="button" onClick={onClose} aria-label="Close removal review">
          <X size={17} />
        </button>
      </header>
      <div className="experiment-archive-body">
        {loading ? (
          <div className="experiment-archive-loading">
            <Loader2 className="chart-loading-spinner" size={18} />
            Checking the experiment
          </div>
        ) : archived && review ? (
          <div className="experiment-archive-complete">
            <span><Check size={18} /></span>
            <div>
              <strong>{review.experiment_name} removed</strong>
              <p>Its readings and history remain saved.</p>
            </div>
            <button type="button" className="settings-secondary-button" onClick={onClose}>
              Done
            </button>
          </div>
        ) : review ? (
          <>
            <div className="experiment-archive-summary">
              <span><Archive size={18} /></span>
              <div>
                <strong>{review.experiment_name}</strong>
                <p>{review.reason}</p>
              </div>
            </div>
            {!review.can_archive ? (
              <div className="settings-callout is-error">
                <AlertTriangle size={17} />
                <p>No change was made.</p>
              </div>
            ) : (
              <>
                <label className="settings-assistant-confirm">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  Remove this tile and preserve its history.
                </label>
                <button
                  type="button"
                  className="settings-primary-button"
                  onClick={() => void removeExperiment()}
                  disabled={!confirmed || archiving}
                >
                  {archiving
                    ? <Loader2 className="chart-loading-spinner" size={15} />
                    : <Archive size={15} />}
                  Remove
                </button>
              </>
            )}
          </>
        ) : null}
        {error ? <p className="settings-error-line" role="alert">{error}</p> : null}
      </div>
    </section>
  );
}
