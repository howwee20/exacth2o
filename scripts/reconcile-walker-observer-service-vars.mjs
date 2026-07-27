#!/usr/bin/env node

import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const cliRoot = process.env.BALENA_CLI_ROOT;
if (!cliRoot) {
  throw new Error("BALENA_CLI_ROOT must point to the installed balena-cli package");
}

const BalenaSdk = require(resolve(cliRoot, "node_modules/balena-sdk"));
const { CliSettings } = require(resolve(cliRoot, "build/utils/bootstrap"));
const settings = new CliSettings();
BalenaSdk.setSharedOptions({
  apiUrl: settings.get("apiUrl"),
  dataDirectory: settings.get("dataDirectory"),
});
const sdk = BalenaSdk.fromSharedOptions();

const deviceUuid = "a1c4ace2b367fbee8521f1aff6a6329b";
const fleet = "basyalbi/walker-labs-pi5";
const serviceName = "walker_telemetry_publisher";
const publishKey = "WALKER_TELEMETRY_PUBLISH_SECRET";
const obsoleteDatabaseKey = "WALKER_TELEMETRY_DB_PASSWORD";
const apply = process.argv.includes("--apply");

if (
  apply &&
  process.env.WALKER_OBSERVER_CREDENTIAL_CLEANUP !== "YES"
) {
  throw new Error(
    "WALKER_OBSERVER_CREDENTIAL_CLEANUP=YES is required with --apply",
  );
}

const serviceKey = {
  application: fleet,
  service_name: serviceName,
};
const devicePublishSecret = await sdk.models.device.serviceVar.get(
  deviceUuid,
  serviceName,
  publishKey,
);
const fleetPublishSecret = await sdk.models.service.var.get(
  serviceKey,
  publishKey,
);
const deviceDatabaseSecret = await sdk.models.device.serviceVar.get(
  deviceUuid,
  serviceName,
  obsoleteDatabaseKey,
);
const fleetDatabaseSecret = await sdk.models.service.var.get(
  serviceKey,
  obsoleteDatabaseKey,
);

if (!devicePublishSecret && !fleetPublishSecret) {
  throw new Error("Walker append-only publish secret is missing");
}

if (apply && deviceDatabaseSecret) {
  await sdk.models.device.serviceVar.remove(
    deviceUuid,
    serviceName,
    obsoleteDatabaseKey,
  );
}
if (apply && fleetDatabaseSecret) {
  await sdk.models.service.var.remove(serviceKey, obsoleteDatabaseKey);
}

const [deviceDatabaseSecretAfter, fleetDatabaseSecretAfter] = apply
  ? await Promise.all([
    sdk.models.device.serviceVar.get(
      deviceUuid,
      serviceName,
      obsoleteDatabaseKey,
    ),
    sdk.models.service.var.get(serviceKey, obsoleteDatabaseKey),
  ])
  : [deviceDatabaseSecret, fleetDatabaseSecret];

process.stdout.write(`${JSON.stringify({
  apply,
  device: deviceUuid,
  fleet,
  service: serviceName,
  publishSecretPresent: Boolean(devicePublishSecret || fleetPublishSecret),
  publishSecretScope: devicePublishSecret ? "device" : "fleet",
  obsoleteDatabaseSecretPresentBefore: Boolean(
    deviceDatabaseSecret || fleetDatabaseSecret,
  ),
  obsoleteDatabaseSecretScopesBefore: [
    ...(deviceDatabaseSecret ? ["device"] : []),
    ...(fleetDatabaseSecret ? ["fleet"] : []),
  ],
  obsoleteDatabaseSecretPresentAfter: Boolean(
    deviceDatabaseSecretAfter || fleetDatabaseSecretAfter,
  ),
}, null, 2)}\n`);
