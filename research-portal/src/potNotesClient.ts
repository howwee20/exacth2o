import { isSessionAuthorizationError } from "./authSession";
import { supabase } from "./supabase";

/** A pot note as stored (portal_pot_notes). Append-only; corrections supersede. */
export type PotNote = {
  id: string;
  project_id: string;
  device_id: string;
  pairing_name: string;
  research_pot_id: string | null;
  experiment_id: string | null;
  body: string;
  tags: string[];
  observed_at: string;
  recorded_at: string;
  created_by: string;
  author_label: string;
  supersedes_id: string | null;
  client_context: Record<string, unknown>;
};

export type NewPotNote = {
  id: string;
  project_id: string;
  device_id: string;
  pairing_name: string;
  research_pot_id: string | null;
  experiment_id: string | null;
  body: string;
  tags: string[];
  observed_at: string;
  author_label: string;
  supersedes_id: string | null;
  client_context: Record<string, unknown>;
};

const noteColumns = "id,project_id,device_id,pairing_name,research_pot_id,experiment_id,body,tags,observed_at,recorded_at,created_by,author_label,supersedes_id,client_context";

/** Notes for the project's controller, newest first; optionally for one pot or a time range. */
export async function loadPotNotes(
  projectId: string,
  deviceId: string,
  options: { pairingNames?: readonly string[]; sinceIso?: string; untilIso?: string; limit?: number } = {},
) {
  let query = supabase
    .from("portal_pot_notes")
    .select(noteColumns)
    .eq("project_id", projectId)
    .eq("device_id", deviceId)
    .order("observed_at", { ascending: false })
    .limit(Math.min(options.limit ?? 200, 1000));
  if (options.pairingNames?.length === 1) query = query.eq("pairing_name", options.pairingNames[0]);
  else if (options.pairingNames?.length) query = query.in("pairing_name", [...options.pairingNames]);
  if (options.sinceIso) query = query.gte("observed_at", options.sinceIso);
  if (options.untilIso) query = query.lte("observed_at", options.untilIso);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as PotNote[];
}

export type SendFailure = "network" | "auth" | "rejected";

export class NoteSendError extends Error {
  constructor(message: string, readonly kind: SendFailure) {
    super(message);
  }
}

/** What kind of failure a write hit: try again later, sign in again, or the server said no. */
export function classifySendError(error: unknown): SendFailure {
  if (isSessionAuthorizationError(error)) return "auth";
  const candidate = (error ?? {}) as { message?: string; code?: string; status?: number; name?: string };
  const message = (candidate.message ?? "").toLowerCase();
  if (candidate.name === "TypeError" || message.includes("failed to fetch") || message.includes("network") || message.includes("load failed") || message.includes("timed out")) {
    return "network";
  }
  if (typeof candidate.status === "number" && (candidate.status === 0 || candidate.status >= 500)) return "network";
  if (typeof candidate.code === "string" && candidate.code.length) return "rejected";
  return "network";
}

/**
 * Write a note once. The id comes from the writer's device, so a retry after a dropped
 * response is a no-op (`on conflict do nothing`); the note is then read back to confirm it is
 * stored and visible.
 */
export async function sendPotNote(note: NewPotNote): Promise<PotNote> {
  const { error } = await supabase
    .from("portal_pot_notes")
    .upsert(note, { onConflict: "id", ignoreDuplicates: true });
  if (error) throw new NoteSendError(error.message, classifySendError(error));
  const { data, error: readError } = await supabase
    .from("portal_pot_notes")
    .select(noteColumns)
    .eq("id", note.id)
    .maybeSingle();
  if (readError) throw new NoteSendError(readError.message, classifySendError(readError));
  if (!data) throw new NoteSendError("The note was not accepted.", "rejected");
  return data as PotNote;
}
