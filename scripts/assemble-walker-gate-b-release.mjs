#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const cliRoot = process.env.BALENA_CLI_ROOT;
if (!cliRoot) {
  throw new Error("BALENA_CLI_ROOT must point to the installed balena-cli package");
}

const BalenaSdk = require(resolve(cliRoot, "node_modules/balena-sdk"));
const { CliSettings } = require(resolve(cliRoot, "build/utils/bootstrap"));
const yaml = require(resolve(cliRoot, "node_modules/js-yaml"));

const baseline = Object.freeze({
  fleet: "basyalbi/walker-labs-pi5",
  applicationId: 2310664,
  releaseId: 3981239,
  releaseCommit: "24165fb95a29664b3a2231cb58a3ad89",
  deviceUuid: "a1c4ace2b367fbee8521f1aff6a6329b",
  images: Object.freeze({
    api_svc: 14443963,
    cron_svc: 14443961,
    database_svc: 14443964,
    redis_svc: 14443965,
    ui_svc: 14443962,
  }),
});
const publisherService = "walker_telemetry_publisher";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

function digest(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1] ?? null;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function releaseImageDetails(sdk, releaseId) {
  const rows = await sdk.pine.get({
    resource: "image__is_part_of__release",
    options: {
      $filter: { is_part_of__release: releaseId },
      $select: ["id"],
      $expand: {
        image: {
          $select: [
            "id",
            "content_hash",
            "is_stored_at__image_location",
            "status",
          ],
          $expand: {
            is_a_build_of__service: { $select: ["id", "service_name"] },
          },
        },
      },
    },
  });
  return rows.map((row) => {
    const image = row.image[0];
    const service = image.is_a_build_of__service[0];
    return {
      releaseImageId: row.id,
      imageId: image.id,
      serviceId: service.id,
      serviceName: service.service_name,
      contentHash: image.content_hash,
      imageLocation: image.is_stored_at__image_location,
      status: image.status,
    };
  });
}

async function copyJoinMetadata(sdk, sourceJoinId, targetJoinId) {
  const [environment, labels] = await Promise.all([
    sdk.pine.get({
      resource: "image_environment_variable",
      options: {
        $filter: { release_image: sourceJoinId },
        $select: ["name", "value"],
      },
    }),
    sdk.pine.get({
      resource: "image_label",
      options: {
        $filter: { release_image: sourceJoinId },
        $select: ["label_name", "value"],
      },
    }),
  ]);
  for (const variable of environment) {
    await sdk.pine.post({
      resource: "image_environment_variable",
      body: {
        release_image: targetJoinId,
        name: variable.name,
        value: variable.value,
      },
    });
  }
  for (const label of labels) {
    await sdk.pine.post({
      resource: "image_label",
      body: {
        release_image: targetJoinId,
        label_name: label.label_name,
        value: label.value,
      },
    });
  }
  return { environment: environment.length, labels: labels.length };
}

const publisherReleaseId = Number(argument("--publisher-release"));
assert(
  Number.isSafeInteger(publisherReleaseId) && publisherReleaseId > 0,
  "--publisher-release must be a positive Balena release ID",
);
const apply = process.argv.includes("--apply");
if (apply) {
  assert(
    process.env.WALKER_GATE_B_APPLY === "YES",
    "WALKER_GATE_B_APPLY=YES is required with --apply",
  );
}

const settings = new CliSettings();
BalenaSdk.setSharedOptions({
  apiUrl: settings.get("apiUrl"),
  dataDirectory: settings.get("dataDirectory"),
});
const sdk = BalenaSdk.fromSharedOptions();

const [baseRelease, device, publisherRelease, baseImages, publisherImages] =
  await Promise.all([
    sdk.models.release.get(baseline.releaseId),
    sdk.models.device.get(baseline.deviceUuid),
    sdk.models.release.get(publisherReleaseId),
    releaseImageDetails(sdk, baseline.releaseId),
    releaseImageDetails(sdk, publisherReleaseId),
  ]);

assert(baseRelease.id === baseline.releaseId, "Baseline release ID drift");
assert(
  baseRelease.commit === baseline.releaseCommit,
  "Baseline release commit drift",
);
assert(
  baseRelease.belongs_to__application.__id === baseline.applicationId,
  "Baseline fleet/application drift",
);
assert(
  device.belongs_to__application.__id === baseline.applicationId,
  "Walker device fleet drift",
);
assert(
  device.is_running__release.__id === baseline.releaseId,
  "Walker is no longer running the approved baseline",
);
assert(
  baseRelease.is_final && baseRelease.status === "success",
  "Baseline release is not finalized and successful",
);
assert(
  publisherRelease.belongs_to__application.__id === baseline.applicationId,
  "Publisher draft belongs to the wrong fleet",
);
assert(
  !publisherRelease.is_final && publisherRelease.status === "success",
  "Publisher image release must be a successful draft",
);

const actualBaseImages = Object.fromEntries(
  baseImages.map((image) => [image.serviceName, image.imageId]),
);
assert(
  JSON.stringify(canonical(actualBaseImages)) ===
    JSON.stringify(canonical(baseline.images)),
  "Baseline service image mapping drift",
);
const publisherImage = publisherImages.find(
  (image) => image.serviceName === publisherService,
);
assert(publisherImage, "Publisher draft is missing its service image");
assert(
  publisherImages.length === 1,
  "Publisher build draft must contain exactly one service image",
);

const snippet = yaml.load(
  await readFile(
    resolve(
      "controller-release/walker-telemetry-publisher/docker-compose.gate-b.yml",
    ),
    "utf8",
  ),
);
const publisherDefinition = snippet.services?.[publisherService];
assert(publisherDefinition, "Gate B snippet is missing the publisher service");
assert(
  Object.keys(snippet.services).length === 1,
  "Gate B snippet must be additive-only",
);

const composition = structuredClone(baseRelease.composition);
const originalServiceDigest = digest(composition.services);
composition.services[publisherService] = publisherDefinition;
composition.volumes = {
  ...(composition.volumes ?? {}),
  ...(snippet.volumes ?? {}),
};

for (const serviceName of Object.keys(baseline.images)) {
  assert(
    digest(composition.services[serviceName]) ===
      digest(baseRelease.composition.services[serviceName]),
    `Pre-existing service definition changed: ${serviceName}`,
  );
}
assert(
  Object.keys(composition.services).sort().join(",") ===
    [...Object.keys(baseline.images), publisherService].sort().join(","),
  "Assembled release service set is not exactly five retained plus publisher",
);

const plan = {
  apply,
  device: baseline.deviceUuid,
  fleet: baseline.fleet,
  baselineRelease: {
    id: baseline.releaseId,
    commit: baseline.releaseCommit,
    compositionSha256: digest(baseRelease.composition),
    retainedServicesSha256: originalServiceDigest,
  },
  publisherDraft: {
    id: publisherReleaseId,
    imageId: publisherImage.imageId,
    contentHash: publisherImage.contentHash,
    imageLocation: publisherImage.imageLocation,
  },
  assembled: {
    compositionSha256: digest(composition),
    serviceCount: Object.keys(composition.services).length,
    addedServices: [publisherService],
    addedVolumes: Object.keys(snippet.volumes ?? {}),
    retainedImageIds: baseline.images,
  },
};

if (!apply) {
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  process.exit(0);
}

const actor = await sdk.auth.getUserInfo();
const now = new Date().toISOString();
const newRelease = await sdk.pine.post({
  resource: "release",
  body: {
    is_created_by__user: actor.id,
    belongs_to__application: baseline.applicationId,
    composition,
    commit: randomBytes(16).toString("hex"),
    status: "running",
    source: "local",
    start_timestamp: now,
    is_final: false,
  },
});

try {
  const sources = [
    ...baseImages,
    publisherImage,
  ];
  const associatedImages = {};
  const copiedMetadata = {};
  for (const image of sources) {
    const association = await sdk.pine.post({
      resource: "image__is_part_of__release",
      body: {
        is_part_of__release: newRelease.id,
        image: image.imageId,
      },
    });
    associatedImages[image.serviceName] = image.imageId;
    copiedMetadata[image.serviceName] = await copyJoinMetadata(
      sdk,
      image.releaseImageId,
      association.id,
    );
  }
  const completedAt = new Date().toISOString();
  await sdk.pine.patch({
    resource: "release",
    id: newRelease.id,
    body: {
      status: "success",
      end_timestamp: completedAt,
    },
  });
  process.stdout.write(`${JSON.stringify({
    ...plan,
    release: {
      id: newRelease.id,
      commit: newRelease.commit,
      isFinal: false,
      status: "success",
      associatedImages,
      copiedMetadata,
    },
  }, null, 2)}\n`);
} catch (error) {
  await sdk.pine.patch({
    resource: "release",
    id: newRelease.id,
    body: {
      status: "failed",
      end_timestamp: new Date().toISOString(),
    },
  }).catch(() => {});
  throw error;
}
