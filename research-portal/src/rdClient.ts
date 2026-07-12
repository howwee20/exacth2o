import { supabase } from "./supabase";
import type { RdLabSnapshot } from "./rdTypes";

export async function loadRdLabSnapshot(): Promise<RdLabSnapshot | null> {
  const response = await supabase.functions.invoke("rd-admin-lab", {
    body: { action: "snapshot" },
  });
  if (response.error || !response.data?.current) return null;
  return response.data as RdLabSnapshot;
}
