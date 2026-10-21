// Deno-only LISTEN connector for agent-wake.mjs. It only listens: no query
// ever runs on this connection, so it cannot read or change data. Each held
// request opens one short-lived connection and closes it before responding.
import postgres from "npm:postgres@3.4.5";
import { agentWakeChannel } from "./agent-wake.mjs";

export function postgresWakeConnector(databaseUrl: string | undefined) {
  if (!databaseUrl) return null;
  // LISTEN needs a session. Supavisor's transaction mode (port 6543) would
  // accept LISTEN and then never deliver a notification, so fall back to
  // bounded re-reads there instead of holding requests that cannot wake.
  try {
    if (new URL(databaseUrl).port === "6543") return null;
  } catch {
    return null;
  }
  return async (onNotify: (payload: string) => void, onLost: () => void) => {
    const sql = postgres(databaseUrl, {
      max: 1,
      prepare: false,
      connect_timeout: 3,
      idle_timeout: 0,
      connection: { application_name: "exacth2o-agent-wake" },
      onnotice: () => {},
    });
    let listens = 0;
    try {
      await sql.listen(agentWakeChannel, (payload: string) => onNotify(payload), () => {
        listens += 1;
        // postgres.js re-runs LISTEN after a dropped connection; anything sent
        // during the gap is unknown, so have the caller re-read its queue.
        if (listens > 1) onLost();
      });
    } catch (error) {
      await sql.end({ timeout: 0 }).catch(() => {});
      throw error;
    }
    return { close: () => sql.end({ timeout: 1 }) };
  };
}
