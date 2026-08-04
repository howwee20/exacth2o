import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const [bundle, applications, appSource, stressImage, phenotypingImage, greenhouseImage] = await Promise.all([
  readFile(resolve("../portal-app/assets/portal.js"), "utf8"),
  readFile(resolve("../applications.html"), "utf8"),
  readFile(resolve("src/App.tsx"), "utf8"),
  readFile(resolve("../applications-plant-stress-20260804.jpg")),
  readFile(resolve("../applications-plant-phenotyping-20260804.jpg")),
  readFile(resolve("../applications-research-greenhouse-20260804.jpg")),
]);

const requiredPortalCopy = [
  "New Experiment",
  "Pots in another active experiment stay visible but cannot be selected.",
  "Marker color matches VWC line",
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
  "Interactive experiment explorer",
  "Example irrigation response",
  "Target guide",
  "Irrigation event",
  ">Start</text>",
  ">72 hr</text>",
];
const requiredApplicationsCopy = [
  ">0</text>",
  ">72 hours</text>",
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
  throw new Error(`Applications page is missing required graph labels: ${missingApplicationsCopy.join(", ")}`);
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

console.log("Portal surface audit passed: pot-colored watering markers, lean graph labels, and baseline application JPEGs are present.");
