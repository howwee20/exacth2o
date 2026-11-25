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
      let status: string | undefined;
      try {
        const { data, error } = await supabase.from("notification_outbox")
          .select("status").eq("id", job).maybeSingle();
        if (!error) status = data?.status;
      } catch {
        // A temporary connection failure can recover on the next poll.
      }
      if (!active) return;
      if (status === "delivered") {
        setMessage("Sent. Check your inbox.");
      } else if (status === "failed" || status === "canceled") {
        setMessage("The test email was not delivered.");
      } else if (Date.now() < deadline) {
        timer = setTimeout(() => void check(), 5_000);
        return;
      } else {
        setMessage(status ? "Still sending. Check your inbox in a few minutes."
          : "Could not confirm delivery. Check your inbox.");
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
      if (typeof data !== "string" || !data) throw new Error("Could not confirm the test request.");
      setMessage("Sending…");
      setJob(data);
    } catch (error) {
      setMessage(error && typeof error === "object" && "message" in error
        ? String(error.message) : "Could not request a test email. Try again.");
      setBusy(false);
    }
  }

  return <>
    {message && <span role="status">{message}</span>}
    <button type="button" className="xb-link" disabled={busy} onClick={() => void send()}>Send test email</button>
  </>;
}
