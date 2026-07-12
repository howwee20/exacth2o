import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const bundle = await readFile(resolve("../portal-app/assets/portal.js"), "utf8");
const forbidden = [
  "rdReplayFixture",
  "synthetic-000",
  "previous_peak_delta",
  "previous_curve_area",
  "slope_per_hour_360m",
  "training_dataset_hash",
  ".joblib",
  "RD_WORKER_TOKEN",
  "SUPABASE_SERVICE_ROLE_KEY",
];
const leaked = forbidden.filter((value) => bundle.includes(value));
if (leaked.length) {
  throw new Error(`R&D production bundle contains private material: ${leaked.join(", ")}`);
}
if (!bundle.includes("rd-admin-lab")) {
  throw new Error("R&D DTO client is missing from the production bundle");
}
console.log("R&D bundle audit passed: DTO UI present; fixture, features, artifacts, and secrets absent.");
