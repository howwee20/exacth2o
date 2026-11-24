import { useEffect, useState } from "react";
import { loadAccountNotifications, loadTeam, saveNotificationPreference, type AccountNotification, type NotificationPreference, type TeamSnapshot } from "../accountClient";
import type { PortalAccess } from "../portalTypes";
import "../phoneAlerts/moisture.css";
import { PhoneSetup } from "../phoneAlerts/PhoneSetup";
import { TestEmailButton } from "../phoneAlerts/TestEmailButton";
import { PortalLink } from "./PortalLink";

const titled = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Who is signed in, how they are notified, and (for a project administrator) who else has access. */
export function AccountPage({ access }: { access: NonNullable<PortalAccess> }) {
  const [preferences, setPreferences] = useState<NotificationPreference[]>([]);
  const [notifications, setNotifications] = useState<AccountNotification[]>([]);
  const [team, setTeam] = useState<TeamSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [teamError, setTeamError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [changed, setChanged] = useState(false);
  const [revision, setRevision] = useState(0);
  const admin = access.role === "admin" && access.accessScope === "project";
  useEffect(() => {
    let active = true;
    setLoading(true); setError(null); setTeamError(null);
    void loadAccountNotifications(access.projectId)
      .then((data) => { if (active) { setPreferences(data.preferences); setNotifications(data.notifications); setChanged(false); } })
      .catch(() => active && setError("Notifications could not be loaded. Your preferences have not changed."))
      .finally(() => active && setLoading(false));
    if (admin) void loadTeam(access.projectId).then((data) => active && setTeam(data)).catch(() => active && setTeamError("Team access could not be loaded."));
    return () => { active = false; };
  }, [access.projectId, admin, revision]);
  const value = (channel: "portal" | "email") => preferences.find((item) => item.channel === channel)
    ?? { channel, enabled: channel === "portal", destination: channel === "email" ? access.email : null };
  const change = (channel: "portal" | "email", enabled: boolean) => {
    setSaved(false); setChanged(true);
    setPreferences((current) => [...current.filter((item) => item.channel !== channel), { ...value(channel), enabled }]);
  };
  const save = async () => {
    setBusy(true); setError(null);
    try {
      for (const channel of ["portal", "email"] as const) await saveNotificationPreference(access.projectId, value(channel));
      setSaved(true); setChanged(false);
    } catch {
      setSaved(false);
      setError("Could not save every preference. Reload to check which changes were saved.");
    } finally { setBusy(false); }
  };
  const locked = loading || busy || Boolean(error);
  return <section className="px-page px-account">
    <PortalLink className="px-home-button" to={{ view: "home" }}>← Home</PortalLink>
    <h1 className="px-title">Account &amp; access</h1>
    <p className="px-subtitle">{access.email} · {titled(access.role)}</p>

    <section className="px-account-block" aria-labelledby="account-notifications">
      <div className="px-account-head">
        <h2 id="account-notifications">Notifications</h2>
        {saved ? <span role="status">Saved</span> : null}
        {changed ? <button type="button" className="px-button is-small" disabled={locked} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button> : null}
      </div>
      {error ? <p className="px-notice" role="alert">{error} <button type="button" className="px-button is-small" onClick={() => setRevision((current) => current + 1)}>Reload</button></p> : null}
      <div className="px-account-rows">
        <label className="px-account-row">
          <input type="checkbox" disabled={locked} checked={value("portal").enabled} onChange={(event) => change("portal", event.target.checked)} />
          <span>In the portal</span>
        </label>
        <label className="px-account-row">
          <input type="checkbox" disabled={locked || !access.email} checked={value("email").enabled} onChange={(event) => change("email", event.target.checked)} />
          <span>Email</span>
          <small>{value("email").destination ?? access.email}</small>
        </label>
      </div>
      <p className="px-muted">Email includes pot alerts from monitored experiments you can access in this project. Pot numbers and readings appear under Recent.</p>
      <TestEmailButton key={access.projectId} projectId={access.projectId} />
      <div id="phone-alerts">
        <h3>Phone alerts</h3>
        <p className="px-muted">Connect your phone for ExactH2O lock-screen notifications. Choose “Notify me on my phone” in each experiment you want to follow.</p>
        <PhoneSetup key={access.projectId} projectId={access.projectId} setupView="account" />
      </div>
      <h3>Recent</h3>
      {loading ? <p className="px-muted">Loading…</p> : notifications.length ? <ul className="px-account-list">
        {notifications.map((item) => <li key={item.id}>
          <strong>{item.subject}</strong>
          <small>{new Date(item.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · {titled(item.channel)} · {titled(item.status)}</small>
          <p>{item.body}</p>
        </li>)}
      </ul> : <p className="px-muted">No notifications yet.</p>}
    </section>

    {admin ? <section className="px-account-block" aria-labelledby="account-team">
      <div className="px-account-head">
        <h2 id="account-team">Team access</h2>
        <span>Contact support to invite someone or change access.</span>
      </div>
      {teamError ? <p className="px-notice" role="alert">{teamError} <button type="button" className="px-button is-small" onClick={() => setRevision((current) => current + 1)}>Retry</button></p> : null}
      {team ? <ul className="px-account-list">
        {team.members.map((member) => <li key={member.email}>
          <strong>{member.email}</strong>
          <small>{titled(member.role)} · {titled(member.access_scope)}</small>
        </li>)}
      </ul> : teamError ? null : <p className="px-muted">Loading…</p>}
      {team?.invites.length ? <>
        <h3>Invitations</h3>
        <ul className="px-account-list">
          {team.invites.map((invite, index) => <li key={`${invite.email}:${index}`}>
            <strong>{invite.email}</strong>
            <small>{titled(invite.role)} · {invite.accepted_at ? "Accepted" : Date.parse(invite.expires_at) < Date.now() ? "Expired" : "Pending"}</small>
          </li>)}
        </ul>
      </> : null}
    </section> : <p className="px-muted px-account-foot">Contact your administrator to change your access.</p>}
  </section>;
}
