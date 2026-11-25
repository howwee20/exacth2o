import { useEffect, useState, type FormEvent } from "react";
import { defaultNotificationPreference, inviteMember, loadAccountNotifications, loadTeam, saveNotificationPreference, type NotificationPreference, type PotAlert, type TeamSnapshot } from "../accountClient";
import type { PortalAccess } from "../portalTypes";
import "../phoneAlerts/moisture.css";
import { PhoneSetup } from "../phoneAlerts/PhoneSetup";
import { TestEmailButton } from "../phoneAlerts/TestEmailButton";
import { PortalLink } from "./PortalLink";

const titled = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const day = (iso: string) => new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
const moment = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
// The phone setup link (and its QR code) opens this page with the phone panel showing.
const phoneLink = () => location.hash === "#phone-alerts" || new URLSearchParams(location.search).get("phoneSetup") === "1";

/** Who is signed in, how they are told about pots, and (for a project administrator) who else has access. */
export function AccountPage({ access }: { access: NonNullable<PortalAccess> }) {
  const [preferences, setPreferences] = useState<NotificationPreference[]>([]);
  const [alerts, setAlerts] = useState<PotAlert[]>([]);
  const [team, setTeam] = useState<TeamSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [teamError, setTeamError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [emailEdit, setEmailEdit] = useState<boolean | null>(null);
  const [potEmailEdit, setPotEmailEdit] = useState<boolean | null>(null);
  const [phoneOpen, setPhoneOpen] = useState(phoneLink);
  const [phoneConnected, setPhoneConnected] = useState<boolean | null>(null);
  const [invitee, setInvitee] = useState("");
  const [inviting, setInviting] = useState(false);
  const [inviteNote, setInviteNote] = useState<{ text: string; failed: boolean } | null>(null);
  const [revision, setRevision] = useState(0);
  const admin = access.role === "admin" && access.accessScope === "project";
  useEffect(() => {
    let active = true;
    setLoading(true); setError(null); setTeamError(null);
    void loadAccountNotifications(access.projectId)
      .then((data) => { if (active) { setPreferences(data.preferences); setAlerts(data.alerts); setEmailEdit(null); setPotEmailEdit(null); } })
      .catch(() => active && setError("Notifications could not be loaded. Your preferences have not changed."))
      .finally(() => active && setLoading(false));
    if (admin) void loadTeam(access.projectId).then((data) => active && setTeam(data)).catch(() => active && setTeamError("Team access could not be loaded."));
    return () => { active = false; };
  }, [access.projectId, admin, revision]);
  const email = preferences.find((item) => item.channel === "email") ?? defaultNotificationPreference("email", access.email);
  const emailEnabled = emailEdit ?? email.enabled;
  const savedPotEmail = email.event_types.includes("pot_moisture");
  const potEmail = potEmailEdit ?? savedPotEmail;
  const changed = emailEnabled !== email.enabled || potEmail !== savedPotEmail;
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const preference = { ...email, enabled: emailEnabled };
      if (preference.enabled) preference.destination = access.email;
      if (potEmail !== savedPotEmail) {
        preference.event_types = potEmail ? [...preference.event_types, "pot_moisture"]
          : preference.event_types.filter((type) => type !== "pot_moisture");
      }
      await saveNotificationPreference(access.projectId, preference);
      setPreferences((current) => [...current.filter((item) => item.channel !== "email"), preference]);
      setSaved(true);
      setEmailEdit(null);
      setPotEmailEdit(null);
    } catch {
      setSaved(false);
      setError("Could not save. Reload to check what was saved.");
    } finally { setBusy(false); }
  };
  const invite = async (event: FormEvent) => {
    event.preventDefault();
    const address = invitee.trim().toLowerCase();
    if (!address) return;
    setInviting(true); setInviteNote(null);
    try {
      await inviteMember(access.projectId, address);
      setInviteNote({ text: `Invitation sent to ${address}`, failed: false });
      setInvitee("");
      void loadTeam(access.projectId).then(setTeam).catch(() => {});
    } catch (problem) {
      setInviteNote({ text: problem instanceof Error ? problem.message : "Could not send the invitation.", failed: true });
    } finally { setInviting(false); }
  };
  const locked = loading || busy || Boolean(error);
  // An accepted invitation is a member already, and an expired one is nothing.
  useEffect(() => {
    if (alerts.length && window.location.hash === "#pot-alerts") {
      document.getElementById("pot-alerts")?.scrollIntoView({block:"nearest"});
    }
  }, [alerts.length]);
  const pending = team?.invites.filter((item) => !item.accepted_at && Date.parse(item.expires_at) > Date.now()
    && !team.members.some((member) => member.email === item.email)) ?? [];
  return <section className="px-page px-account">
    <PortalLink className="px-home-button" to={{ view: "home" }}>← Home</PortalLink>
    <h1 className="px-title">Account &amp; access</h1>
    <p className="px-subtitle">{access.email} · {titled(access.role)}</p>

    <section className="px-account-block" aria-labelledby="account-notifications">
      <div className="px-account-head">
        <h2 id="account-notifications">Notifications</h2>
        {saved && !changed ? <span role="status">Saved</span> : null}
        {changed ? <button type="button" className="px-button is-small" disabled={locked} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button> : null}
      </div>
      {error ? <p className="px-notice" role="alert">{error} <button type="button" className="px-button is-small" onClick={() => setRevision((current) => current + 1)}>Reload</button></p> : null}
      <div className="px-account-rows">
        <div className="px-account-row">
          <label>
            <input type="checkbox" disabled={locked || !access.email} checked={emailEnabled} onChange={(event) => { setSaved(false); setEmailEdit(event.target.checked); }} />
            <span>Email</span>
          </label>
          <small>{email.destination ?? access.email}</small>
          {email.enabled ? <TestEmailButton key={access.projectId} projectId={access.projectId} /> : null}
        </div>
        {emailEnabled ? <div className="px-account-row">
          <label>
            <input type="checkbox" disabled={locked} checked={potEmail} onChange={(event) => { setSaved(false); setPotEmailEdit(event.target.checked); }} />
            <span>Email me when a pot goes out of range</span>
          </label>
        </div> : null}
        <div className="px-account-row">
          <span>Phone</span>
          <small>{phoneConnected === null ? "" : phoneConnected ? "Connected" : "Not connected"}</small>
          <button type="button" className="xb-link" aria-expanded={phoneOpen} aria-controls="phone-alerts" onClick={() => setPhoneOpen((open) => !open)}>
            {phoneOpen ? "Done" : phoneConnected ? "Manage" : "Set up"}
          </button>
        </div>
      </div>
      <div id="phone-alerts" hidden={!phoneOpen}>
        <PhoneSetup key={access.projectId} projectId={access.projectId} setupView="account" onConnected={setPhoneConnected} />
      </div>
      {alerts.length ? <section id="pot-alerts" aria-label="Pot alerts">
        <h3>Pot alerts</h3>
        <ul className="px-account-list">
        {alerts.map((item) => <li key={item.id}>
          {item.url ? <a href={item.url}><strong>{item.subject}</strong></a> : <strong>{item.subject}</strong>}
          <small>{moment(item.created_at)}</small>
          <p>{item.body}</p>
        </li>)}
      </ul></section> : null}
    </section>

    {admin ? <section className="px-account-block" aria-labelledby="account-team">
      <div className="px-account-head">
        <h2 id="account-team">Team access</h2>
        {inviteNote ? <span role={inviteNote.failed ? "alert" : "status"} className={inviteNote.failed ? "is-failed" : undefined}>{inviteNote.text}</span> : null}
      </div>
      {teamError ? <p className="px-notice" role="alert">{teamError} <button type="button" className="px-button is-small" onClick={() => setRevision((current) => current + 1)}>Retry</button></p> : null}
      {team ? <ul className="px-account-list">
        {team.members.map((member) => <li key={member.email}>
          <strong>{member.email}</strong>
          <small>{titled(member.role)}{member.access_scope === "project" ? "" : " · Mixer only"}</small>
        </li>)}
        {pending.map((item) => <li key={`invite:${item.email}`}>
          <strong>{item.email}</strong>
          <small>Invited · expires {day(item.expires_at)}</small>
        </li>)}
        <li className="px-account-invite">
          <form onSubmit={(event) => void invite(event)}>
            <input type="email" required autoComplete="off" placeholder="name@example.edu" aria-label="Email to invite" value={invitee} disabled={inviting}
              onChange={(event) => { setInvitee(event.target.value); setInviteNote(null); }} />
            <button type="submit" className="px-button is-small" disabled={inviting || !invitee.trim()}>{inviting ? "Sending…" : "Send invite"}</button>
          </form>
        </li>
      </ul> : teamError ? null : <p className="px-muted">Loading…</p>}
    </section> : null}
  </section>;
}
