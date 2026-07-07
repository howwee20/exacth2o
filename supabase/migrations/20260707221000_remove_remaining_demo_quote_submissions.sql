do $$
declare
  deleted_messages integer := 0;
  deleted_threads integer := 0;
  deleted_quotes integer := 0;
begin
  create temp table exacth2o_remaining_test_quote_ids on commit drop as
  select id
  from public.quote_requests
  where id in (
    '567495ff-5d44-4c89-b2ee-cd831d3f9ee2'::uuid,
    '3bc76dbb-81ea-441a-9580-d6ab13ef6ff8'::uuid,
    '19b07b06-0ec1-4a10-940b-ffb0589ef350'::uuid
  )
  or lower(name) in (
    'ej resend success test',
    'ej demo quote',
    'demo quote test'
  )
  or lower(email) = 'demo@example.com'
  or (
    lower(coalesce(organization, '')) = 'exacth2o demo'
    and (
      message ilike '%live success test%'
      or message ilike '%live test:%'
      or message ilike '%test submission from codex%'
    )
  );

  delete from public.support_messages
  where thread_id in (
    select id
    from public.support_threads
    where quote_request_id in (select id from exacth2o_remaining_test_quote_ids)
  );
  get diagnostics deleted_messages = row_count;

  delete from public.support_notes
  where thread_id in (
    select id
    from public.support_threads
    where quote_request_id in (select id from exacth2o_remaining_test_quote_ids)
  );

  delete from public.support_threads
  where quote_request_id in (select id from exacth2o_remaining_test_quote_ids);
  get diagnostics deleted_threads = row_count;

  delete from public.quote_requests
  where id in (select id from exacth2o_remaining_test_quote_ids);
  get diagnostics deleted_quotes = row_count;

  raise notice 'Removed remaining demo quote submissions: % quote_requests, % support_threads, % support_messages',
    deleted_quotes,
    deleted_threads,
    deleted_messages;
end $$;
