-- PostgreSQL parsed the JSON text extraction and string concatenation in the
-- first published function body with the wrong precedence. Parenthesize every
-- extraction. Fresh installs already receive the corrected body above; this
-- migration repairs projects that applied the first version.
do $repair$
declare
  function_signature regprocedure :=
    'public.publish_sensing_experiment(uuid,jsonb,timestamp with time zone,text,text,text)'::regprocedure;
  original_definition text;
  corrected_definition text;
begin
  original_definition := pg_get_functiondef(function_signature);
  corrected_definition := original_definition;

  corrected_definition := replace(
    corrected_definition,
    $old$config_pairing->'Sensor'->>'boardSerialId' || ':' ||
      config_pairing->'Sensor'->>'address'$old$,
    $new$(config_pairing->'Sensor'->>'boardSerialId') || ':' ||
      (config_pairing->'Sensor'->>'address')$new$
  );
  corrected_definition := replace(
    corrected_definition,
    $old$config_pairing->'Valve'->>'relayAddress' || ':' ||
      config_pairing->'Valve'->>'address'$old$,
    $new$(config_pairing->'Valve'->>'relayAddress') || ':' ||
      (config_pairing->'Valve'->>'address')$new$
  );
  corrected_definition := replace(
    corrected_definition,
    $old$config_pairing->'Sensor'->>'boardSerialId' || ':' || config_pairing->'Sensor'->>'address'$old$,
    $new$(config_pairing->'Sensor'->>'boardSerialId') || ':' || (config_pairing->'Sensor'->>'address')$new$
  );
  corrected_definition := replace(
    corrected_definition,
    $old$config_pairing->'Valve'->>'relayAddress' || ':' || config_pairing->'Valve'->>'address'$old$,
    $new$(config_pairing->'Valve'->>'relayAddress') || ':' || (config_pairing->'Valve'->>'address')$new$
  );

  if corrected_definition <> original_definition then
    execute corrected_definition;
  end if;
end;
$repair$;
