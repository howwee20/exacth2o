import { createClient } from "@supabase/supabase-js";

const rdPreview = import.meta.env.DEV && new URLSearchParams(window.location.search).get("rd-preview") === "1";
const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ??
  (rdPreview ? "http://127.0.0.1:54321" : undefined);
const supabaseAnonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ??
  (rdPreview ? "local-preview-anon-key" : undefined);

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error("Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY");
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
