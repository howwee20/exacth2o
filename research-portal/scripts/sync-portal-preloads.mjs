import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptsDirectory, "../..");
const generatedEntryPath = path.join(repositoryRoot, "portal-app/index.html");
const deployedEntryPath = path.join(repositoryRoot, "portal.html");
const startMarker = "    <!-- portal-modulepreloads:start -->";
const endMarker = "    <!-- portal-modulepreloads:end -->";

const [generatedEntry, deployedEntry, portalJavaScript, portalStyles] = await Promise.all([
  readFile(generatedEntryPath, "utf8"),
  readFile(deployedEntryPath, "utf8"),
  readFile(path.join(repositoryRoot, "portal-app/assets/portal.js")),
  readFile(path.join(repositoryRoot, "portal-app/assets/portal.css")),
]);

const modulePreloads = Array.from(
  generatedEntry.matchAll(/<link rel="modulepreload" crossorigin href="\.\/assets\/([^"?]+)">/g),
  (match) => `    <link rel="modulepreload" crossorigin href="portal-app/assets/${match[1]}">`,
);

if (modulePreloads.length === 0) {
  throw new Error("The generated portal entry did not contain modulepreload links.");
}

const markerPattern = new RegExp(`${startMarker}[\\s\\S]*?${endMarker}`);
if (!markerPattern.test(deployedEntry)) {
  throw new Error("portal.html is missing the generated modulepreload marker block.");
}

const assetVersion = createHash("sha256")
  .update(portalJavaScript)
  .update(portalStyles)
  .digest("hex")
  .slice(0, 16);

let nextEntry = deployedEntry.replace(
  markerPattern,
  [startMarker, ...modulePreloads, endMarker].join("\n"),
);
nextEntry = nextEntry
  .replace(/portal-app\/assets\/portal\.js\?v=[^"\s]+/, `portal-app/assets/portal.js?v=${assetVersion}`)
  .replace(/portal-app\/assets\/portal\.css\?v=[^"\s]+/, `portal-app/assets/portal.css?v=${assetVersion}`);

if (!nextEntry.includes(`portal.js?v=${assetVersion}`) || !nextEntry.includes(`portal.css?v=${assetVersion}`)) {
  throw new Error("portal.html is missing versioned portal JavaScript or CSS references.");
}

if (nextEntry !== deployedEntry) {
  await writeFile(deployedEntryPath, nextEntry, "utf8");
}
