-- Gate B operator template. Substitute the generated password through the
-- deployment secret workflow; do not commit it.
CREATE USER IF NOT EXISTS 'walker_telemetry'@'%' IDENTIFIED BY '<GENERATED_SECRET>';
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'walker_telemetry'@'%';
GRANT SELECT ON walkerlabs.readings TO 'walker_telemetry'@'%';
FLUSH PRIVILEGES;
