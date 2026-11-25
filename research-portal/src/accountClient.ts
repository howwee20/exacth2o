import { supabase } from "./supabase";
export type NotificationChannel = "portal" | "email";
export type NotificationPreference = {
  channel: NotificationChannel;
  enabled: boolean;
  destination: string | null;
  event_types: string[];
};

export function defaultNotificationPreference(channel: NotificationChannel, email: string | null): NotificationPreference {
  return {
    channel,
    enabled: channel === "portal",
    destination: channel === "email" ? email : null,
    event_types: channel === "portal" ? ["monitor_triggered", "operation_failed"]
      : ["monitor_triggered", "operation_failed", "pot_moisture"],
  };
}
/** A pot that left its range: the one notification with detail the email leaves out. */
export type PotAlert = {id: string; subject: string; body: string; created_at: string; url: string | null};
export type TeamSnapshot = {members: {email: string; role: string; access_scope: string}[]; invites: {email: string; role: string; expires_at: string; accepted_at: string | null}[]};

export async function loadAccountNotifications(projectId: string) {
  const [preferences, alerts] = await Promise.all([
    supabase.from("notification_preferences").select("channel,enabled,destination,event_types").eq("project_id",projectId),
    supabase.from("notification_outbox").select("id,subject,body,created_at,metadata").eq("project_id",projectId)
      .eq("event_type","pot_moisture").eq("channel","portal").order("created_at",{ascending:false}).limit(5),
  ]);
  if (preferences.error || alerts.error) throw preferences.error ?? alerts.error;
  return {
    preferences: (preferences.data ?? []) as NotificationPreference[],
    alerts: (alerts.data ?? []).map((row): PotAlert => {
      const url = (row.metadata as {url?: unknown} | null)?.url;
      // Only a link back into the portal is followed.
      return {id: row.id, subject: row.subject, body: row.body, created_at: row.created_at,
        url: typeof url === "string" && url.startsWith("/portal?") ? url : null};
    }),
  };
}
export async function loadTeam(projectId: string) {
  const {data,error} = await supabase.rpc("portal_team_snapshot",{requested_project_id:projectId});
  if (error) throw error;
  return data as TeamSnapshot;
}
export async function saveNotificationPreference(projectId: string, preference: NotificationPreference) {
  const {error} = await supabase.rpc("set_notification_preference",{
    selected_project_id:projectId,selected_channel:preference.channel,selected_enabled:preference.enabled,
    selected_destination:preference.destination,
    selected_event_types: preference.event_types,
  });
  if (error) throw error;
}
/** Emails a one-time account link to someone new. The link itself never comes back to this browser. */
export async function inviteMember(projectId: string, email: string) {
  const {error} = await supabase.functions.invoke("invite-member",{body:{projectId,email}});
  if (!error) return;
  const body = await (error as {context?: Response}).context?.json?.().catch(() => null);
  throw new Error(typeof body?.error === "string" ? body.error : "Could not send the invitation.");
}
