import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const [recipe, destination] = process.argv.slice(2);
const recipes = ["full", "control-executor", "matt-health-reporting-20261020", "matt-safety-20261103"];
if (!recipes.includes(recipe) || !destination) {
  throw new Error(`Usage: node scripts/build-controller-release.mjs <${recipes.join("|")}> <empty-output-directory>`);
}

const output = path.resolve(destination);
const controller = path.join(root, "controller");
const metadata = path.join(root, "controller-release");
if ([controller, metadata].some((source) => output === source || output.startsWith(`${source}${path.sep}`))) {
  throw new Error("The release output must be outside the source directories.");
}
await mkdir(output, { recursive: true });
if ((await readdir(output)).length) throw new Error("The release output directory must be empty.");

// Build contexts contain maintained input files only. Docker builds compile the
// full image; the pinned-image safety overlay needs three compiled files first.
const excluded = new Set(["node_modules", "dist", "__pycache__", ".pytest_cache", ".DS_Store"]);
const includeSource = (source) => !excluded.has(path.basename(source)) && !source.endsWith(".pyc");
if (recipe === "full" || recipe === "control-executor") {
  const source = recipe === "full" ? controller : path.join(controller, "control-executor");
  await cp(source, output, { recursive: true, filter: includeSource });
} else {
  const source = path.join(metadata, recipe);
  const mapping = JSON.parse(await readFile(path.join(source, "source-map.json"), "utf8"));
  for (const project of mapping.build) {
    execFileSync("npm", ["run", "build", "--prefix", path.join(root, project)], { stdio: "inherit" });
  }
  await cp(source, output, {
    recursive: true,
    filter: (entry) => includeSource(entry) && !["source-map.json", "test_release_contract.py"].includes(path.basename(entry)),
  });
  for (const [relative, maintained] of Object.entries(mapping.files)) {
    const target = path.join(output, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(root, maintained), target);
  }
}

const files = {};
async function recordFiles(directory) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await recordFiles(filename);
    else files[path.relative(output, filename)] = createHash("sha256").update(await readFile(filename)).digest("hex");
  }
}
await recordFiles(output);
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const sourceDirty = execFileSync("git", ["status", "--porcelain", "--", "controller", "controller-release", "scripts/build-controller-release.mjs"], { cwd: root, encoding: "utf8" }).trim().length > 0;
await writeFile(path.join(output, "source-manifest.json"), `${JSON.stringify({ recipe, revision, sourceDirty, files }, null, 2)}\n`);
console.log(`Built ${recipe} from maintained controller source into ${output}`);
