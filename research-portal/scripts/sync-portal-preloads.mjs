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

const [generatedEntry, deployedEntry, portalStyles] = await Promise.all([
  readFile(generatedEntryPath, "utf8"),
  readFile(deployedEntryPath, "utf8"),
  readFile(path.join(repositoryRoot, "portal-app/assets/portal.css")),
]);

// The entry script is content-hashed (portal-<hash>.js) and must be referenced without a query:
// lazily loaded chunks import it by that exact file name.
const entryScript = generatedEntry.match(/<script type="module" crossorigin src="\.\/assets\/(portal-[A-Za-z0-9_-]+\.js)"><\/script>/)?.[1];
if (!entryScript) {
  throw new Error("The generated portal entry did not reference a hashed portal-<hash>.js script.");
}

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
  .update(entryScript)
  .update(portalStyles)
  .digest("hex")
  .slice(0, 16);

let nextEntry = deployedEntry.replace(
  markerPattern,
  [startMarker, ...modulePreloads, endMarker].join("\n"),
);
nextEntry = nextEntry
  .replace(/portal-app\/assets\/portal(?:-[A-Za-z0-9_-]+)?\.js(?:\?v=[^"\s]+)?/, `portal-app/assets/${entryScript}`)
  .replace(/portal-app\/assets\/portal\.css\?v=[^"\s]+/, `portal-app/assets/portal.css?v=${assetVersion}`);

if (!nextEntry.includes(`"portal-app/assets/${entryScript}"`) || !nextEntry.includes(`portal.css?v=${assetVersion}`)) {
  throw new Error("portal.html is missing the hashed portal entry or the versioned portal CSS reference.");
}

if (nextEntry !== deployedEntry) {
  await writeFile(deployedEntryPath, nextEntry, "utf8");
}
