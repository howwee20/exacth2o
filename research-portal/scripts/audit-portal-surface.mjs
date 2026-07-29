import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const [bundle, applications] = await Promise.all([
  readFile(resolve("../portal-app/assets/portal.js"), "utf8"),
  readFile(resolve("../applications.html"), "utf8"),
]);

const requiredPortalCopy = [
  "New Experiment",
  "Pots in another active experiment stay visible but cannot be selected.",
];
const forbiddenPortalCopy = [
  "Research workspace",
  "Open a tile to view results, or edit its reviewed settings.",
];
const forbiddenApplicationsCopy = [
  "Hover or click a run",
  "Select a run to isolate its response",
  "Representative visualization",
  "not live experiment data",
];

const missingPortalCopy = requiredPortalCopy.filter((value) => !bundle.includes(value));
if (missingPortalCopy.length) {
  throw new Error(`Portal production bundle is missing required UI: ${missingPortalCopy.join(", ")}`);
}

const retainedPortalCopy = forbiddenPortalCopy.filter((value) => bundle.includes(value));
if (retainedPortalCopy.length) {
  throw new Error(`Portal production bundle retained removed UI: ${retainedPortalCopy.join(", ")}`);
}

const retainedApplicationsCopy = forbiddenApplicationsCopy.filter((value) =>
  applications.toLowerCase().includes(value.toLowerCase())
);
if (retainedApplicationsCopy.length) {
  throw new Error(`Applications page retained removed graph copy: ${retainedApplicationsCopy.join(", ")}`);
}

if (!applications.includes("Example irrigation response")) {
  throw new Error("Applications page is missing the concise example-data title.");
}

console.log("Portal surface audit passed: direct action, occupied-pot guard, and concise graph copy are present.");
