-- One-time invite links for Matt Stata and Binod Basyal.
-- Raw invite tokens are not stored here; only SHA-256 token hashes are inserted.

insert into public.project_invites (
  token_hash,
  project_id,
  email,
  role,
  expires_at,
  created_by
)
values
  (
    'b127a02f9ef6ef58af6d6f57a3a591a61e650494e1d3dfbb6503d19810342982',
    '22222222-2222-4222-8222-222222222222'::uuid,
    'statamat@msu.edu',
    'owner',
    now() + interval '14 days',
    null
  ),
  (
    '1b59ddbd4f2e911eb9dddd2870572696480cb16926c2f98586ed9b1eea1136ee',
    '22222222-2222-4222-8222-222222222222'::uuid,
    'basyalbi@msu.edu',
    'owner',
    now() + interval '14 days',
    null
  )
on conflict (token_hash) do nothing;
