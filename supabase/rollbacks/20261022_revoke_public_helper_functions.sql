-- ROLLBACK for 03_revoke_public_helper_functions.sql (review only): restores PostgreSQL's
-- default function ACL (EXECUTE for PUBLIC), which is what the baseline shows for these four.
grant execute on function public.portal_role_for_email(text) to public;
grant execute on function public.invite_profile_name(text) to public;
grant execute on function public.support_message_preview(text, text, text) to public;
grant execute on function public.is_project_member(uuid) to public;
