import assert from "node:assert/strict";
import test from "node:test";
import {
  healthSyncInstallation,
  publicIntakeProjectId,
} from "./installation-config.mjs";

const projectId = "22222222-2222-4222-8222-222222222222";
const organizationId = "11111111-1111-4111-8111-111111111111";

test("public intake requires an explicit tenant project", () => {
  assert.equal(publicIntakeProjectId({}), null);
  assert.equal(publicIntakeProjectId({ PUBLIC_INTAKE_PROJECT_ID: "invalid" }), null);
  assert.equal(publicIntakeProjectId({ PUBLIC_INTAKE_PROJECT_ID: projectId }), projectId);
});

test("health sync is deployment configuration rather than application behavior", () => {
  assert.equal(healthSyncInstallation({}), null);
  assert.deepEqual(healthSyncInstallation({
    HEALTH_SYNC_PROJECT_ID: projectId,
    HEALTH_SYNC_ORGANIZATION_ID: organizationId,
    HEALTH_SYNC_DEVICE_ID: "device-1",
    HEALTH_SYNC_DEVICE_NAME: "greenhouse-controller",
  }), {
    projectId,
    organizationId,
    deviceId: "device-1",
    deviceName: "greenhouse-controller",
    ownerHealthBaseUrl: "https://device-1.balena-devices.com/owner-health",
  });
});
