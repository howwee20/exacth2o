import { useEffect, useState } from "react";
import { loadAccountNotifications, loadTeam, saveNotificationPreference, type AccountNotification, type NotificationPreference, type TeamSnapshot } from "../accountClient";
import type { PortalAccess } from "../portalTypes";
import { PortalLink } from "./PortalLink";

export function AccountPage({access}: {access: NonNullable<PortalAccess>}) {
  const [preferences,setPreferences] = useState<NotificationPreference[]>([]);
  const [notifications,setNotifications] = useState<AccountNotification[]>([]);
  const [team,setTeam] = useState<TeamSnapshot | null>(null);
  const [error,setError] = useState<string | null>(null);
  const [teamError,setTeamError] = useState<string | null>(null);
  const [loading,setLoading] = useState(true);
  const [busy,setBusy] = useState(false);
  const [saved,setSaved] = useState(false);
  const [revision,setRevision] = useState(0);
  useEffect(() => {
    let active=true;setLoading(true);setError(null);setTeamError(null);
    void loadAccountNotifications(access.projectId).then((data) => {if(active){setPreferences(data.preferences);setNotifications(data.notifications);}}).catch(() => active && setError("Notifications could not be loaded. Your preferences have not changed.")).finally(() => active && setLoading(false));
    if(access.role === "admin" && access.accessScope === "project") void loadTeam(access.projectId).then((data) => active && setTeam(data)).catch(() => active && setTeamError("Team access could not be loaded."));
    return () => {active=false;};
  },[access.projectId,access.role,access.accessScope,revision]);
  const value = (channel: "portal" | "email") => preferences.find((item) => item.channel===channel) ?? {channel,enabled:channel==="portal",destination:channel==="email"?access.email:null};
  const change = (channel: "portal" | "email",enabled:boolean) => {setSaved(false);setPreferences((current) => [...current.filter((item) => item.channel!==channel),{...value(channel),enabled}]);};
  const save = async () => {setBusy(true);setError(null);try{for(const channel of ["portal","email"] as const) await saveNotificationPreference(access.projectId,value(channel));setSaved(true);}catch{setSaved(false);setError("Could not save every preference. Reload to check which changes were saved.");}finally{setBusy(false);}};
  return <section className="px-page"><PortalLink className="px-crumb" to={{view:"home"}}>← Experiments</PortalLink><h1 className="px-title">Account &amp; access</h1><p className="px-subtitle">{access.email} · {access.role}</p>
    <section className="px-card px-account-section"><h2>Notifications</h2><p className="px-muted">Monitor conditions and failed operations for this account.</p>
      {error ? <p className="px-notice" role="alert">{error} <button className="px-button is-small" onClick={() => setRevision((current)=>current+1)}>Reload</button></p> : null}
      <label className="px-check"><input type="checkbox" disabled={loading||busy||Boolean(error)} checked={value("portal").enabled} onChange={(event)=>change("portal",event.target.checked)}/> In the portal</label>
      <label className="px-check"><input type="checkbox" disabled={loading||busy||Boolean(error)||!access.email} checked={value("email").enabled} onChange={(event)=>change("email",event.target.checked)}/> Email to {value("email").destination ?? access.email}</label>
      <p className="px-muted px-small">Email delivery depends on the installation's notification service. Delivery status appears below; a saved preference does not confirm delivery.</p>
      <button className="px-button" disabled={loading||busy||Boolean(error)} onClick={()=>void save()}>{busy?"Saving…":"Save preferences"}</button>{saved?<span role="status"> Preferences saved</span>:null}
      <h3>Recent notifications</h3>{loading?<p>Loading…</p>:notifications.length?<ul className="px-notification-list">{notifications.map((item)=><li key={item.id}><strong>{item.subject}</strong><span className="px-muted px-small">{new Date(item.created_at).toLocaleString()} · {item.channel} · {item.status}</span><p>{item.body}</p></li>)}</ul>:<p className="px-muted">No notifications available.</p>}
    </section>
    {access.role==="admin"&&access.accessScope==="project"?<section className="px-card px-account-section"><h2>Team access</h2><p className="px-muted">Members and invitation status for this project. Contact support to arrange an invitation or change access.</p>{teamError?<p className="px-notice" role="alert">{teamError} <button className="px-button is-small" onClick={()=>setRevision(current=>current+1)}>Retry</button></p>:null}
      <div className="px-table-wrap"><table className="px-table"><thead><tr><th>Account</th><th>Role</th><th>Scope</th></tr></thead><tbody>{team?.members.map((member)=><tr key={member.email}><td>{member.email}</td><td>{member.role}</td><td>{member.access_scope}</td></tr>)}</tbody></table></div>
      <h3>Invitations</h3>{team?.invites.length?<ul className="px-notification-list">{team.invites.map((invite,index)=><li key={`${invite.email}:${index}`}><strong>{invite.email}</strong><span>{invite.role} · {invite.accepted_at?"Accepted":Date.parse(invite.expires_at)<Date.now()?"Expired":"Pending"}</span></li>)}</ul>:<p className="px-muted">{team?"No invitations recorded.":"Loading invitations…"}</p>}
    </section>:<p className="px-muted">Your role controls which experiments and operations you can access. Contact your administrator for changes.</p>}
  </section>;
}
