do $$
declare
  deleted_messages integer := 0;
  deleted_threads integer := 0;
  deleted_quotes integer := 0;
begin
  create temp table exacth2o_test_quote_ids on commit drop as
  select id
  from public.quote_requests
  where
    message ilike '%end-to-end test%'
    or message ilike '%deployed Supabase submit-quote%'
    or trim(message) = 'Not much!!';

  delete from public.support_messages
  where thread_id in (
    select id
    from public.support_threads
    where quote_request_id in (select id from exacth2o_test_quote_ids)
  )
  or body_text ilike '%end-to-end test%'
  or body_text ilike '%deployed Supabase submit-quote%'
  or trim(coalesce(body_text, '')) = 'Not much!!';
  get diagnostics deleted_messages = row_count;

  delete from public.support_notes
  where thread_id in (
    select id
    from public.support_threads
    where quote_request_id in (select id from exacth2o_test_quote_ids)
  );

  delete from public.support_threads
  where quote_request_id in (select id from exacth2o_test_quote_ids)
    or last_message_preview ilike '%end-to-end test%'
    or last_message_preview ilike '%deployed Supabase submit-quote%'
    or trim(coalesce(last_message_preview, '')) = 'Not much!!';
  get diagnostics deleted_threads = row_count;

  delete from public.quote_requests
  where id in (select id from exacth2o_test_quote_ids);
  get diagnostics deleted_quotes = row_count;

  raise notice 'Removed test sales/support submissions: % quote_requests, % support_threads, % support_messages',
    deleted_quotes,
    deleted_threads,
    deleted_messages;
end $$;
