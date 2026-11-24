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
export type AccountNotification = {id: string; subject: string; body: string; channel: string; status: string; created_at: string};
export type TeamSnapshot = {members: {email: string; role: string; access_scope: string}[]; invites: {email: string; role: string; expires_at: string; accepted_at: string | null}[]};

export async function loadAccountNotifications(projectId: string) {
  const [preferences, notifications] = await Promise.all([
    supabase.from("notification_preferences").select("channel,enabled,destination,event_types").eq("project_id",projectId),
    supabase.from("notification_outbox").select("id,subject,body,channel,status,created_at").eq("project_id",projectId).order("created_at",{ascending:false}).limit(20),
  ]);
  if (preferences.error || notifications.error) throw preferences.error ?? notifications.error;
  return {preferences:(preferences.data ?? []) as NotificationPreference[], notifications:(notifications.data ?? []) as AccountNotification[]};
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
