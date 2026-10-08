import { useState } from "react";
import type { PotBinding } from "../benchClient";
import { formatMeasurementTime } from "../measurementFreshness";
import type { PotNote } from "../potNotesClient";
import { NoteComposer, PotNotesList, usePotNotes } from "./PotNotes";
import type { useNoteOutbox } from "./useNoteOutbox";
import "./product.css";

const statusText: Record<string, string> = {
  software_only: "Matched in software only — not physically confirmed",
  researcher_confirmed: "Confirmed at the bench by a researcher",
  delivery_verified: "Watering delivery verified",
  retired: "Retired",
};

/** Notes and physical identity for the desktop pot page. */
export function PotNotesSection({
  userId,
  projectId,
  deviceId,
  pairingName,
  potNumber,
  experimentId,
  binding,
  canWrite,
  outbox,
}: {
  userId: string | null;
  projectId: string;
  deviceId: string;
  pairingName: string;
  potNumber: number;
  experimentId: string | null;
  binding: PotBinding | null;
  canWrite: boolean;
  outbox: ReturnType<typeof useNoteOutbox>;
}) {
  const notes = usePotNotes(projectId, deviceId, pairingName, outbox.entries.filter((item) => item.state === "sent").length, userId);
  const scope = JSON.stringify([userId, projectId, deviceId, pairingName]);
  const [correction, setCorrection] = useState<{ scope: string; note: PotNote } | null>(null);
  const correcting = correction?.scope === scope ? correction.note : null;
  const waiting = outbox.entries.filter((entry) => entry.deviceId === deviceId && entry.pairingName === pairingName);
  return (
    <>
      <section className="px-card" style={{ padding: "12px 14px", display: "grid", gap: 10 }} aria-label="Notes">
        <h2 className="px-section-label">Notes</h2>
        {canWrite && userId ? (
          <NoteComposer
            key={correcting?.id ?? "new"}
            userId={userId}
            projectId={projectId}
            deviceId={deviceId}
            pairingName={pairingName}
            potLabel={`Pot ${potNumber}`}
            supersedes={correcting}
            onCancel={correcting ? () => setCorrection(null) : undefined}
            onSave={async (body, tags) => {
              await outbox.add({
                deviceId,
                pairingName,
                researchPotId: binding?.researchPotId ?? null,
                experimentId,
                body,
                tags,
                supersedesId: correcting?.id ?? null,
              });
              setCorrection(null);
            }}
          />
        ) : null}
        <PotNotesList
          notes={notes.notes}
          waiting={waiting}
          loading={notes.loading}
          error={notes.error}
          canWrite={canWrite && Boolean(userId)}
          onRetry={(id) => void outbox.retry(id)}
          onDiscard={(id) => void outbox.discard(id)}
          onCorrect={(note) => setCorrection({ scope, note })}
        />
      </section>
      <section className="px-card" style={{ padding: "4px 16px 10px" }} aria-label="Physical identity">
        <dl className="px-facts">
          <div><dt>Research pot</dt><dd>{binding ? `${binding.label}${binding.positionLabel ? ` · ${binding.positionLabel}` : ""}` : "No research pot is bound to this pairing"}</dd></div>
          {binding ? <div><dt>Binding</dt><dd>{statusText[binding.physicalStatus] ?? binding.physicalStatus}{binding.effectiveAt ? ` · since ${formatMeasurementTime(binding.effectiveAt)}` : ""}</dd></div> : null}
        </dl>
      </section>
    </>
  );
}
