import { useEffect, useState } from "react";
import { supabase } from "../supabase";

export function TestEmailButton({ projectId }: { projectId: string }) {
  const [job, setJob] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!job) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const deadline = Date.now() + 120_000;
    async function check() {
      const { data } = await supabase.from("notification_outbox")
        .select("status").eq("id", job).maybeSingle();
      if (!active) return;
      if (data?.status === "delivered") {
        setMessage("Email accepted for delivery. Check your inbox and spam folder.");
      } else if (data?.status === "failed" || data?.status === "canceled") {
        setMessage("The test email could not be sent. Check your confirmed sign-in address.");
      } else if (Date.now() < deadline) {
        timer = setTimeout(() => void check(), 5_000);
        return;
      } else {
        setMessage("Delivery is still pending. Check Account & access → Recent for its status.");
      }
      setBusy(false);
      setJob("");
    }
    timer = setTimeout(() => void check(), 2_000);
    return () => { active = false; clearTimeout(timer); };
  }, [job]);

  async function send() {
    setBusy(true);
    setMessage("");
    try {
      const { data, error } = await supabase.rpc("request_alert_test_email", { selected_project_id: projectId });
      if (error) throw error;
      setMessage("Test email queued for your confirmed sign-in address.");
      setJob(data as string);
    } catch (error) {
      setMessage(error && typeof error === "object" && "message" in error
        ? String(error.message) : "Could not request a test email. Try again.");
      setBusy(false);
    }
  }

  return <div className="moisture-actions">
    <button type="button" className="px-button is-small" disabled={busy} onClick={() => void send()}>Send test email</button>
    {message && <span role="status">{message}</span>}
  </div>;
}
