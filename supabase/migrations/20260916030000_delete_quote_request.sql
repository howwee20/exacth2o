-- Delete one quote and its linked conversation atomically, for project admins only.
create or replace function public.delete_quote_request(
  p_project_id uuid,
  p_quote_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not coalesce(public.is_portal_admin(p_project_id), false) then
    raise exception 'Only project administrators can delete quote requests'
      using errcode = '42501';
  end if;

  -- Lock the parent so a concurrent new conversation cannot be orphaned.
  perform 1 from public.quote_requests
    where id = p_quote_id and project_id = p_project_id
    for update;
  if not found then
    return false;
  end if;

  -- Messages and notes cascade from their conversation. Unrelated support stays intact.
  delete from public.support_threads
    where quote_request_id = p_quote_id and project_id = p_project_id;
  delete from public.quote_requests
    where id = p_quote_id and project_id = p_project_id;
  return true;
end;
$$;

revoke all on function public.delete_quote_request(uuid, uuid) from public, anon;
grant execute on function public.delete_quote_request(uuid, uuid) to authenticated;
