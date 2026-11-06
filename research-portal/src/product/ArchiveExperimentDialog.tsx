import { useEffect, useRef } from "react";
import { ExperimentArchiveReview } from "../ExperimentArchiveReview";

export function ArchiveExperimentDialog({ projectId, experiment, onClose, onArchived }: {
  projectId: string; experiment: string; onClose: () => void; onArchived: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => previous?.focus();
  }, []);
  return (
    <dialog ref={dialog} className="px-archive-dialog" aria-label="Archive experiment" onCancel={(event) => { event.preventDefault(); onClose(); }}>
      <ExperimentArchiveReview projectId={projectId} experiment={experiment} onClose={onClose} onArchived={onArchived} />
    </dialog>
  );
}
