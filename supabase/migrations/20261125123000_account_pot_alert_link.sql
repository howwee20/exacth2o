-- Update email navigation without changing the evaluator, recipient rules or grants.
do $migration$
declare
  definition text;
  updated text;
  item record;
begin
  for item in select * from (values
    ('public.evaluate_moisture_alerts()'::regprocedure, 'rule.project_id'),
    ('public.request_alert_test_email(uuid)'::regprocedure, 'selected_project_id')
  ) as templates(routine, project_argument) loop
    definition := pg_get_functiondef(item.routine);
    if position('Account & access → Notifications → Pot alerts' in definition) > 0
       and position('#pot-alerts' in definition) > 0 then continue; end if;
    if position('Account & access → Recent' in definition) = 0
       or position('https://exacth2o.com/portal?view=account''' in definition) = 0 then
      raise exception 'Unexpected email template for %', item.routine;
    end if;
    updated := replace(definition, 'Account & access → Recent', 'Account & access → Notifications → Pot alerts');
    updated := replace(updated, 'https://exacth2o.com/portal?view=account''',
      'https://exacth2o.com/portal?view=account&project='' || ' || item.project_argument || '::text || ''#pot-alerts''');
    execute updated;
  end loop;
end;
$migration$;
