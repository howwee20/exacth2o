-- Both retained indexes enforce the same keys as the redundant indexes.
-- Guard the definitions before removing anything. No stored rows are changed.
set lock_timeout = '2s';
set statement_timeout = '30s';

do $$
declare
  duplicate_name text;
  retained_name text;
begin
  for duplicate_name, retained_name in
    values ('sensor_readings_event_id_idx', 'sensor_readings_event_id_key'),
           ('rd_single_champion_model_idx', 'rd_one_champion_idx')
  loop
    if to_regclass('public.' || duplicate_name) is null then
      continue;
    end if;
    if not exists (
      select 1
      from pg_index redundant
      join pg_index retained on retained.indexrelid = to_regclass('public.' || retained_name)
      join pg_class redundant_relation on redundant_relation.oid = redundant.indexrelid
      join pg_class retained_relation on retained_relation.oid = retained.indexrelid
      where redundant.indexrelid = to_regclass('public.' || duplicate_name)
        and retained.indisunique and retained.indisvalid and retained.indisready
        and redundant.indrelid = retained.indrelid
        and redundant_relation.relam = retained_relation.relam
        and redundant.indkey = retained.indkey
        and redundant.indclass = retained.indclass
        and redundant.indcollation = retained.indcollation
        and redundant.indoption = retained.indoption
        and redundant.indnkeyatts = retained.indnkeyatts
        and redundant.indnatts = retained.indnatts
        and redundant.indnullsnotdistinct = retained.indnullsnotdistinct
        and redundant.indpred::text is not distinct from retained.indpred::text
        and redundant.indexprs::text is not distinct from retained.indexprs::text
        and not exists (
          select 1 from pg_constraint where conindid = redundant.indexrelid
        )
    ) then
      raise exception 'Retained index does not safely cover redundant index %', duplicate_name;
    end if;
  end loop;
end;
$$;

drop index if exists public.sensor_readings_event_id_idx;
drop index if exists public.rd_single_champion_model_idx;

reset lock_timeout;
reset statement_timeout;
