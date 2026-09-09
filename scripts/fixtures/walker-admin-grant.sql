-- Test data for verify-database-baseline.sh's disposable local restore only.
-- The addresses match the migration's explicit allowlist; these are synthetic
-- local users with no password or session, not copied production identities.
insert into public.organizations (id, slug, name)
values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee0', 'baseline-admin-fixture', 'Baseline admin fixture')
on conflict (id) do nothing;

insert into public.projects (id, organization_id, slug, name)
values (
  '22222222-2222-4222-8222-222222222222',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee0',
  'baseline-admin-fixture', 'Baseline admin fixture'
)
on conflict (id) do nothing;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
select
  '00000000-0000-0000-0000-000000000000'::uuid,
  fixture.id, 'authenticated', 'authenticated', fixture.email, '',
  now(), '{}'::jsonb, '{}'::jsonb, now(), now()
from (values
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1'::uuid, 'basyalbi@msu.edu'),
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2'::uuid, 'berkley@msu.edu'),
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3'::uuid, 'hicksj23@msu.edu'),
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee4'::uuid, 'howeeva1@msu.edu')
) as fixture(id, email);

insert into public.portal_access (project_id, user_id, email, role)
select '22222222-2222-4222-8222-222222222222'::uuid, id, email, 'admin'
from auth.users
where id in (
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1'::uuid,
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2'::uuid,
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3'::uuid,
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee4'::uuid
);
