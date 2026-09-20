import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const [bundle, applications, appSource, stressImage, phenotypingImage, greenhouseImage, demoPage] = await Promise.all([
  readFile(resolve("../portal-app/assets/portal.js"), "utf8"),
  readFile(resolve("../applications.html"), "utf8"),
  readFile(resolve("src/App.tsx"), "utf8"),
  readFile(resolve("../applications-plant-stress-20260804.jpg")),
  readFile(resolve("../applications-plant-phenotyping-20260804.jpg")),
  readFile(resolve("../applications-research-greenhouse-20260804.jpg")),
  readFile(resolve("../applications-demo-app/index.html"), "utf8"),
]);

const requiredPortalCopy = [
  "New Experiment",
  "Pots in another active experiment stay visible but cannot be selected.",
  "Marker color matches VWC line",
];
const forbiddenPortalCopy = [
  "Research workspace",
  "Open a tile to view results, or edit its reviewed settings.",
  // Autocalibrate is real commissioning software. The simulator and mock
  // controller are internal test infrastructure and must never ship.
  "Simulator answer key",
  "Start simulated run",
  "Clean 24-pot installation",
  "made-up installation",
  "SimulatedBench",
  "exacth2o.autocalibration.v1",
  // The Response Curve lab was removed from ExactH2O. Nothing of it may ship.
  "rd-admin-lab",
  "Response Curve",
  "rdReplayFixture",
  "training_dataset_hash",
  // Privileged credentials never belong in a browser bundle.
  "SUPABASE_SERVICE_ROLE_KEY",
  "RD_WORKER_TOKEN",
];
const requiredCommissioningCopy = [
  "REAL HARDWARE",
  "Run preflight",
  "Physical validation",
];
const forbiddenApplicationsCopy = [
  "Hover or click a run",
  "Select a run to isolate its response",
  "Representative visualization",
  "not live experiment data",
  "Interactive experiment explorer",
  "Example irrigation response",
  "Target guide",
  "Irrigation event",
  ">Start</text>",
  ">72 hr</text>",
];
const requiredApplicationsCopy = [
  'src="/applications-demo-app/index.html"',
  'title="ExactH2O experiment portal with sample readings"',
  "/applications-plant-stress-20260804.jpg",
  "/applications-plant-phenotyping-20260804.jpg",
  "/applications-research-greenhouse-20260804.jpg",
  "Researcher using a tablet while examining greenhouse plants",
  "Rows of container plants inside a large commercial greenhouse",
];

const missingPortalCopy = requiredPortalCopy.filter((value) => !bundle.includes(value));
if (missingPortalCopy.length) {
  throw new Error(`Portal production bundle is missing required UI: ${missingPortalCopy.join(", ")}`);
}

const requiredMarkerColorSource = [
  'const seriesColor = pairing ? colorForPairing(pairing) : "#64748b";',
  "style={{ fill: seriesColor, stroke: seriesColor }}",
];
const missingMarkerColorSource = requiredMarkerColorSource.filter((value) => !appSource.includes(value));
if (missingMarkerColorSource.length) {
  throw new Error("Portal source is missing per-pot watering marker colors.");
}

const missingCommissioningCopy = requiredCommissioningCopy.filter((value) => !bundle.includes(value));
if (missingCommissioningCopy.length) {
  throw new Error(`Portal production bundle is missing the commissioning workflow: ${missingCommissioningCopy.join(", ")}`);
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

const missingApplicationsCopy = requiredApplicationsCopy.filter((value) => !applications.includes(value));
if (missingApplicationsCopy.length) {
  throw new Error(`Applications page is missing required demo or application content: ${missingApplicationsCopy.join(", ")}`);
}

// The public demo must stay a separate, network-disabled build.
const demoFrame = applications.match(/<iframe\b[^>]*class="portal-demo-frame"[^>]*>/)?.[0];
const sandbox = demoFrame?.match(/sandbox="([^"]*)"/)?.[1].split(/\s+/) || [];
if (!sandbox.includes("allow-scripts") || sandbox.some((token) =>
  !["allow-scripts", "allow-same-origin", "allow-downloads"].includes(token))) {
  throw new Error("Applications demo iframe has missing or unexpected sandbox permissions.");
}
const demoPolicy = demoPage.match(/<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*content="([^"]+)"/)?.[1];
const directives = new Map((demoPolicy || "").split(";").map((item) => {
  const [name, ...values] = item.trim().split(/\s+/);
  return [name, values.join(" ")];
}));
for (const name of ["connect-src", "form-action", "base-uri"]) {
  if (directives.get(name) !== "'none'") {
    throw new Error(`Applications demo must disable ${name}.`);
  }
}
if (!demoPage.includes('src="/applications-demo-app/assets/demo.js"')) {
  throw new Error("Applications demo must load its own bundle.");
}

const isBaselineJpeg = (image) =>
  image[0] === 0xff && image[1] === 0xd8 && image.includes(Buffer.from([0xff, 0xc0]));
const invalidApplicationImages = [
  ["plant stress", stressImage],
  ["phenotyping", phenotypingImage],
  ["greenhouse", greenhouseImage],
].filter(([, image]) => !isBaselineJpeg(image));
if (invalidApplicationImages.length) {
  throw new Error(`Applications page retained a non-baseline JPEG: ${invalidApplicationImages.map(([name]) => name).join(", ")}`);
}

console.log("Portal surface audit passed: pot-colored watering markers, sandboxed network-disabled demo, and baseline application JPEGs are present.");
