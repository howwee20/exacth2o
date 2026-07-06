-- One-time test invite for EJ's Gmail account.
-- Raw invite token is not stored here; only the SHA-256 token hash is inserted.

insert into public.project_invites (
  token_hash,
  project_id,
  email,
  role,
  expires_at,
  created_by
)
values (
  '0149ebb6d002dac62c4b4c135b3f81ccb4ec88bdda6bb7e0d824a7517e17c81a',
  '22222222-2222-4222-8222-222222222222'::uuid,
  'howeej2255@gmail.com',
  'owner',
  now() + interval '14 days',
  null
)
on conflict (token_hash) do nothing;
