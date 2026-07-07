alter table public.support_threads
  add column if not exists last_message_preview text,
  add column if not exists last_message_from_email text,
  add column if not exists last_message_subject text;

create or replace function public.support_message_preview(
  body_text text,
  body_html text,
  subject text
)
returns text
language sql
immutable
as $$
  select nullif(
    left(
      regexp_replace(
        coalesce(
          nullif(trim(body_text), ''),
          nullif(trim(regexp_replace(coalesce(body_html, ''), '<[^>]+>', ' ', 'g')), ''),
          nullif(trim(subject), '')
        ),
        '\s+',
        ' ',
        'g'
      ),
      300
    ),
    ''
  );
$$;

create or replace function public.touch_support_thread_from_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.support_threads
  set last_message_at = greatest(new.created_at, last_message_at),
      last_message_preview = coalesce(
        public.support_message_preview(new.body_text, new.body_html, new.subject),
        last_message_preview
      ),
      last_message_from_email = coalesce(new.from_email, last_message_from_email),
      last_message_subject = coalesce(new.subject, last_message_subject),
      updated_at = now()
  where id = new.thread_id;

  return new;
end;
$$;

with latest_message as (
  select distinct on (thread_id)
    thread_id,
    from_email,
    subject,
    public.support_message_preview(body_text, body_html, subject) as preview
  from public.support_messages
  order by thread_id, created_at desc
)
update public.support_threads thread
set last_message_preview = coalesce(latest_message.preview, thread.last_message_preview),
    last_message_from_email = coalesce(latest_message.from_email, thread.last_message_from_email),
    last_message_subject = coalesce(latest_message.subject, thread.last_message_subject)
from latest_message
where thread.id = latest_message.thread_id;
