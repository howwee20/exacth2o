-- The approved roster is the set of accounts with inbox access at rollout.
-- This is a one-time snapshot: accepting a future admin invite never enrolls staff.
begin;
lock table public.portal_access in share mode;

create table public.sales_support_staff (
  project_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);
alter table public.sales_support_staff enable row level security;
revoke all on public.sales_support_staff from public, anon, authenticated;
grant select, insert, update, delete on public.sales_support_staff to service_role;

insert into public.sales_support_staff (project_id, user_id)
select project_id, user_id from public.portal_access where role = 'admin';

create function public.is_sales_support_staff(check_project_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_portal_admin(check_project_id) and exists (
    select 1 from public.sales_support_staff staff
    where staff.project_id = check_project_id and staff.user_id = (select auth.uid())
  );
$$;
revoke all on function public.is_sales_support_staff(uuid) from public, anon;
grant execute on function public.is_sales_support_staff(uuid) to authenticated;

-- Keep the existing policy identities so older performance rollbacks can retain this boundary.
alter policy "Portal admins can read quote requests" on public.quote_requests
  using (public.is_sales_support_staff(project_id));
alter policy "Portal admins can update quote requests" on public.quote_requests
  using (public.is_sales_support_staff(project_id)) with check (public.is_sales_support_staff(project_id));
alter policy "Portal admins can read support threads" on public.support_threads
  using (public.is_sales_support_staff(project_id));
alter policy "Portal admins can update support threads" on public.support_threads
  using (public.is_sales_support_staff(project_id)) with check (public.is_sales_support_staff(project_id));
alter policy "Portal admins can read support messages" on public.support_messages
  using (public.is_sales_support_staff(project_id));
alter policy "Portal admins can read support notes" on public.support_notes
  using (public.is_sales_support_staff(project_id));
alter policy "Portal admins can add support notes" on public.support_notes
  with check (public.is_sales_support_staff(project_id) and author_user_id = (select auth.uid()));

create or replace function public.delete_quote_request(p_project_id uuid, p_quote_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not coalesce(public.is_sales_support_staff(p_project_id), false) then
    raise exception 'Sales & Support access is required to delete quote requests' using errcode = '42501';
  end if;
  perform 1 from public.quote_requests where id = p_quote_id and project_id = p_project_id for update;
  if not found then return false; end if;
  delete from public.support_threads where quote_request_id = p_quote_id and project_id = p_project_id;
  delete from public.quote_requests where id = p_quote_id and project_id = p_project_id;
  return true;
end;
$$;
commit;
