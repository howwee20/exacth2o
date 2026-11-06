-- Four public-schema functions still carry PostgreSQL's default ACL (EXECUTE for
-- PUBLIC): the baseline dump has no GRANT/REVOKE line for any of them (cf. baseline
-- 8608-8912), and anon has USAGE on schema public (baseline 8602). PostgREST therefore lets an
-- unauthenticated caller run, e.g., POST /rest/v1/rpc/portal_role_for_email, which maps staff
-- e-mail addresses to 'admin'/'researcher' (baseline 2297-2310), and invite_profile_name, which
-- maps them to personal names (baseline 2006-2019).
--
-- Compatibility: invite_profile_name is only called by apply_project_invite_membership and
-- support_message_preview only by touch_support_thread_from_message; both callers are
-- SECURITY DEFINER functions owned by postgres, so they keep EXECUTE through the owner.
-- portal_role_for_email has no remaining caller (apply_project_invite_membership switched to
-- portal_role_for_invite in 20260909170000). is_project_member is not referenced by any policy,
-- RPC client or Edge Function; it keeps authenticated/service_role access.

revoke all on function public.portal_role_for_email(text) from public, anon, authenticated;
revoke all on function public.invite_profile_name(text) from public, anon, authenticated;
revoke all on function public.support_message_preview(text, text, text) from public, anon, authenticated;
revoke all on function public.is_project_member(uuid) from public, anon;
grant execute on function public.is_project_member(uuid) to authenticated, service_role;
