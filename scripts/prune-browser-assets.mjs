import { readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const buildDirectories = ['portal-app', 'demo-app', 'applications-demo-app'];
const retentionFile = 'scripts/browser-asset-retention.json';

function validateAssetPath(name) {
  if (typeof name !== 'string' || !/^assets\/[^/\\]+$/.test(name)) {
    throw new Error(`Expected a generated file directly under assets/: ${name}`);
  }
  return name;
}

export function manifestAssets(manifest) {
  const assets = new Set();
  for (const item of Object.values(manifest)) {
    for (const name of [item.file, ...(item.css ?? []), ...(item.assets ?? [])]) {
      assets.add(validateAssetPath(name));
    }
  }
  if (assets.size === 0) throw new Error('The build manifest contains no assets');
  return [...assets].sort();
}

export function pruneBrowserAssets(root) {
  const snapshotPath = path.join(root, retentionFile);
  const snapshots = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  const plans = buildDirectories.map(directory => {
    const output = path.join(root, directory);
    const manifest = JSON.parse(readFileSync(path.join(output, 'asset-manifest.json'), 'utf8'));
    const current = manifestAssets(manifest);
    const saved = snapshots[directory];
    if (!saved) throw new Error(`Missing retention history for ${directory}`);
    const previous = JSON.stringify(current) === JSON.stringify(saved.current)
      ? saved.previous
      : saved.current;
    const retained = new Set([...current, ...previous].map(validateAssetPath));
    for (const name of retained) readFileSync(path.join(output, name));

    const obsolete = [];
    for (const entry of readdirSync(path.join(output, 'assets'), { withFileTypes: true })) {
      if (!entry.isFile()) throw new Error(`Unexpected non-file in ${directory}/assets/${entry.name}`);
      const name = `assets/${entry.name}`;
      if (!retained.has(name)) obsolete.push(name);
    }
    return { directory, current, previous, obsolete };
  });

  // Validate all three builds and retained files before removing any old output.
  for (const plan of plans) {
    for (const name of plan.obsolete) unlinkSync(path.join(root, plan.directory, name));
    snapshots[plan.directory] = { current: plan.current, previous: plan.previous };
  }
  writeFileSync(snapshotPath, `${JSON.stringify(snapshots, null, 2)}\n`);
  return plans.map(({ directory, current, previous, obsolete }) => ({
    directory, current: current.length, previous: previous.length, removed: obsolete.length,
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  for (const result of pruneBrowserAssets(root)) {
    console.log(`${result.directory}: kept current and previous builds, removed ${result.removed} older assets`);
  }
}
