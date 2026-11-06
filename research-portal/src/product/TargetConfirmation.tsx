import { useEffect, useRef } from "react";

export type TargetReview = { label: string; names: string[]; previous: Array<number | undefined>; value: number };

export function TargetConfirmation({ review, pots, demo, onCancel, onConfirm }: {
  review: TargetReview; pots: string; demo: boolean; onCancel: () => void; onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const pill = previous?.closest(".px-tcontrol")?.querySelector<HTMLElement>(".px-tpill");
    dialog.current?.showModal();
    return () => { (previous?.isConnected ? previous : pill)?.focus(); };
  }, []);
  const old = [...new Set(review.previous)].map((value) => value == null ? "Unknown" : `${value}%`).join(" / ");
  return <dialog ref={dialog} className="px-target-confirmation" aria-labelledby="target-confirm-title"
    onCancel={(event) => { event.preventDefault(); onCancel(); }}>
    <h2 id="target-confirm-title">Change {review.label} target?</h2>
    <p>Are you sure you want to apply this target to {review.names.length} {review.names.length === 1 ? "pot" : "pots"}?</p>
    <p className="px-target-change"><span>{old}</span><span aria-hidden="true">→</span><strong>{review.value}% VWC</strong></p>
    <p className="px-target-pots">{pots}</p>
    <p>{demo ? "This changes the demo only." : "This updates the watering target on the controller."}</p>
    <div className="px-target-confirm-actions"><button type="button" className="px-button" autoFocus onClick={onCancel}>Cancel</button><button type="button" className="px-button is-primary" onClick={onConfirm}>Confirm target</button></div>
  </dialog>;
}
