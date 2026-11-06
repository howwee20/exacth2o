-- Synthetic identities/content only. Exercise real RLS and SECURITY DEFINER paths, then roll back.
begin;
create schema inbox_test;
create table inbox_test.users(label text primary key, id uuid not null);
insert into inbox_test.users values
 ('approved','ab121212-1212-4121-8121-121212121201'),
 ('new_admin','ab121212-1212-4121-8121-121212121202'),
 ('researcher','ab121212-1212-4121-8121-121212121203'),
 ('viewer','ab121212-1212-4121-8121-121212121204'),
 ('other','ab121212-1212-4121-8121-121212121205'),
 ('nobody','ab121212-1212-4121-8121-121212121206');
grant usage on schema inbox_test to authenticated;
grant select on inbox_test.users to authenticated;
insert into auth.users(id,email) select id,label||'@inbox-test.invalid' from inbox_test.users;
insert into public.projects(id,organization_id,slug,name)
 select 'ab121212-1212-4121-8121-121212121299',organization_id,'inbox-test-other','Inbox test other'
 from public.projects where id='22222222-2222-4222-8222-222222222222';
insert into public.portal_access(project_id,user_id,email,role)
 select '22222222-2222-4222-8222-222222222222',id,label||'@inbox-test.invalid',
 case when label in ('approved','new_admin') then 'admin' else label end
 from inbox_test.users where label in ('approved','new_admin','researcher','viewer');
insert into public.portal_access(project_id,user_id,email,role)
 select 'ab121212-1212-4121-8121-121212121299',id,label||'@inbox-test.invalid','admin'
 from inbox_test.users where label='other';
insert into public.sales_support_staff(project_id,user_id) values
 ('22222222-2222-4222-8222-222222222222','ab121212-1212-4121-8121-121212121201'),
 ('ab121212-1212-4121-8121-121212121299','ab121212-1212-4121-8121-121212121205');
insert into public.quote_requests(id,name,email,application,message) values
 ('ab121212-1212-4121-8121-121212121210','Synthetic customer','customer@inbox-test.invalid','Test','Synthetic inquiry');
insert into public.support_threads(id,subject,customer_email,quote_request_id) values
 ('ab121212-1212-4121-8121-121212121211','Linked synthetic thread','customer@inbox-test.invalid','ab121212-1212-4121-8121-121212121210'),
 ('ab121212-1212-4121-8121-121212121212','Unrelated synthetic thread','customer@inbox-test.invalid',null);
insert into public.support_messages(thread_id,direction,body_text) values
 ('ab121212-1212-4121-8121-121212121211','inbound','Synthetic message');
insert into public.support_notes(thread_id,author_user_id,note) values
 ('ab121212-1212-4121-8121-121212121211','ab121212-1212-4121-8121-121212121201','Synthetic note');

create function inbox_test.act_as(label text) returns void language plpgsql as $$
declare subject uuid;
begin
 select id into subject from inbox_test.users u where u.label=act_as.label;
 perform set_config('request.jwt.claim.sub',subject::text,true);
 perform set_config('request.jwt.claims',json_build_object('sub',subject,'role','authenticated')::text,true);
 execute 'set local role authenticated';
end $$;
create function inbox_test.denied(statement text) returns void language plpgsql as $$
begin
 begin execute statement;
 exception when insufficient_privilege then return;
 end;
 raise exception 'Expected authorization refusal: %',statement;
end $$;
create function inbox_test.assert_blocked() returns void language plpgsql as $$
declare affected integer;
begin
 if public.is_sales_support_staff('22222222-2222-4222-8222-222222222222') then raise exception 'Unapproved identity has capability'; end if;
 if exists(select 1 from public.quote_requests where id='ab121212-1212-4121-8121-121212121210')
 or exists(select 1 from public.support_threads where id='ab121212-1212-4121-8121-121212121211')
 or exists(select 1 from public.support_messages where thread_id='ab121212-1212-4121-8121-121212121211')
 or exists(select 1 from public.support_notes where thread_id='ab121212-1212-4121-8121-121212121211') then raise exception 'Inbox data leaked'; end if;
 update public.quote_requests set status='closed' where id='ab121212-1212-4121-8121-121212121210';
 get diagnostics affected=row_count;
 if affected<>0 then raise exception 'Unapproved identity updated quote'; end if;
 update public.support_threads set status='closed' where id='ab121212-1212-4121-8121-121212121211';
 get diagnostics affected=row_count;
 if affected<>0 then raise exception 'Unapproved identity updated thread'; end if;
 perform inbox_test.denied($q$select public.delete_quote_request('22222222-2222-4222-8222-222222222222','ab121212-1212-4121-8121-121212121210')$q$);
 perform inbox_test.denied(format($q$insert into public.support_notes(thread_id,author_user_id,note) values ('ab121212-1212-4121-8121-121212121211',%L,'Denied note')$q$,auth.uid()));
 perform inbox_test.denied(format($q$insert into public.sales_support_staff(project_id,user_id) values ('22222222-2222-4222-8222-222222222222',%L)$q$,auth.uid()));
 perform inbox_test.denied($q$select * from public.sales_support_staff$q$);
end $$;
grant execute on all functions in schema inbox_test to authenticated;

select inbox_test.act_as('new_admin');
do $$ begin
 if not public.is_portal_admin('22222222-2222-4222-8222-222222222222') then raise exception 'Reproduction lacks admin role'; end if;
end $$;
select inbox_test.assert_blocked();
reset role;
select inbox_test.act_as('researcher'); select inbox_test.assert_blocked(); reset role;
select inbox_test.act_as('viewer'); select inbox_test.assert_blocked(); reset role;
select inbox_test.act_as('other'); select inbox_test.assert_blocked(); reset role;
select inbox_test.act_as('nobody'); select inbox_test.assert_blocked(); reset role;

select inbox_test.act_as('approved');
do $$ declare affected integer; begin
 if not public.is_sales_support_staff('22222222-2222-4222-8222-222222222222') then raise exception 'Approved staff lost access'; end if;
 if (select count(*) from public.quote_requests where id='ab121212-1212-4121-8121-121212121210')<>1
 or (select count(*) from public.support_threads where id='ab121212-1212-4121-8121-121212121211')<>1
 or (select count(*) from public.support_messages where thread_id='ab121212-1212-4121-8121-121212121211')<>1
 or (select count(*) from public.support_notes where thread_id='ab121212-1212-4121-8121-121212121211')<>1 then raise exception 'Approved staff cannot read queue'; end if;
 update public.quote_requests set status='open' where id='ab121212-1212-4121-8121-121212121210';
 get diagnostics affected=row_count;
 if affected<>1 then raise exception 'Approved quote update failed'; end if;
 update public.support_threads set status='open' where id='ab121212-1212-4121-8121-121212121211';
 get diagnostics affected=row_count;
 if affected<>1 then raise exception 'Approved thread update failed'; end if;
 if public.delete_quote_request('22222222-2222-4222-8222-222222222222','ab121212-1212-4121-8121-121212121219') then raise exception 'Unknown quote result changed'; end if;
end $$;
insert into public.support_notes(thread_id,author_user_id,note) values
 ('ab121212-1212-4121-8121-121212121211','ab121212-1212-4121-8121-121212121201','Allowed staff note');
select inbox_test.denied($q$insert into public.support_notes(thread_id,author_user_id,note) values ('ab121212-1212-4121-8121-121212121211','ab121212-1212-4121-8121-121212121202','Spoofed author')$q$);
select inbox_test.denied($q$update public.sales_support_staff set user_id='ab121212-1212-4121-8121-121212121202'$q$);
select inbox_test.denied($q$delete from public.sales_support_staff$q$);
select inbox_test.denied($q$select public.delete_quote_request('ab121212-1212-4121-8121-121212121299','ab121212-1212-4121-8121-121212121210')$q$);
reset role;

-- Roster eligibility alone never preserves access after demotion or membership removal.
update public.portal_access set role='researcher' where user_id='ab121212-1212-4121-8121-121212121201';
select inbox_test.act_as('approved'); select inbox_test.assert_blocked(); reset role;
update public.portal_access set role='admin' where user_id='ab121212-1212-4121-8121-121212121201';
delete from public.portal_access where user_id='ab121212-1212-4121-8121-121212121201';
select inbox_test.act_as('approved'); select inbox_test.assert_blocked(); reset role;
insert into public.portal_access(project_id,user_id,email,role) values
 ('22222222-2222-4222-8222-222222222222','ab121212-1212-4121-8121-121212121201','approved@inbox-test.invalid','admin');
delete from public.sales_support_staff where user_id='ab121212-1212-4121-8121-121212121201';
select inbox_test.act_as('approved'); select inbox_test.assert_blocked(); reset role;
insert into public.sales_support_staff(project_id,user_id) values
 ('22222222-2222-4222-8222-222222222222','ab121212-1212-4121-8121-121212121201');

select inbox_test.act_as('approved');
do $$ begin
 if not public.delete_quote_request('22222222-2222-4222-8222-222222222222','ab121212-1212-4121-8121-121212121210') then raise exception 'Approved deletion failed'; end if;
end $$;
reset role;
do $$ begin
 if exists(select 1 from public.support_threads where id='ab121212-1212-4121-8121-121212121211')
 or exists(select 1 from public.support_messages where thread_id='ab121212-1212-4121-8121-121212121211')
 or exists(select 1 from public.support_notes where thread_id='ab121212-1212-4121-8121-121212121211') then raise exception 'Linked deletion cascade changed'; end if;
 if not exists(select 1 from public.support_threads where id='ab121212-1212-4121-8121-121212121212') then raise exception 'Unrelated thread deleted'; end if;
 if has_function_privilege('anon','public.is_sales_support_staff(uuid)','execute')
 or has_table_privilege('authenticated','public.sales_support_staff','insert')
 or not has_table_privilege('service_role','public.sales_support_staff','insert') then raise exception 'Staff roster grants unsafe'; end if;
end $$;
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{"role":"authenticated"}',true);
set local role authenticated;
do $$ begin
 if public.is_sales_support_staff('22222222-2222-4222-8222-222222222222') then raise exception 'Empty identity has access'; end if;
end $$;
reset role;
rollback;
