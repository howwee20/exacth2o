import { supabase } from "./supabase";
import type { RdLabSnapshot } from "./rdTypes";

function responseError(error: unknown, fallback: string) {
  if (error && typeof error === "object" && "message" in error) {
    const message = String((error as { message?: unknown }).message ?? "").trim();
    if (message) return new Error(message);
  }
  return new Error(fallback);
}

export async function loadRdLabAccess(): Promise<boolean> {
  const response = await supabase.functions.invoke("rd-admin-lab", {
    body: { action: "access" },
  });
  if (response.error) throw responseError(response.error, "Could not verify R&D access");
  return response.data?.allowed === true;
}

export async function loadRdLabSnapshot(options: {
  historyCursor?: string | null;
  historyPageSize?: number;
} = {}): Promise<RdLabSnapshot> {
  const response = await supabase.functions.invoke("rd-admin-lab", {
    body: {
      action: "snapshot",
      history_cursor: options.historyCursor ?? null,
      history_page_size: options.historyPageSize ?? 24,
    },
  });
  if (response.error) throw responseError(response.error, "Could not load the R&D Lab");
  if (!response.data?.current) throw new Error("R&D Lab returned an incomplete snapshot");
  return response.data as RdLabSnapshot;
}
