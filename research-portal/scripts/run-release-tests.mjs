import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { escapeRegex, policyCheck, unitChecks } from './release-checks.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(root, '.release-results/unit.json');
mkdirSync(resolve(root, '.release-results'), { recursive: true });
function run(args, cwd = root) {
  const result = spawnSync(process.execPath, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.release.config.ts', '--reporter=json', `--outputFile=${output}`]);
const report = JSON.parse(readFileSync(output, 'utf8'));
const executed = report.testResults.flatMap((file) => file.assertionResults).filter((test) => test.status !== 'pending' && test.status !== 'skipped');
if (executed.length !== unitChecks.length || unitChecks.some((check) => !executed.some((test) => test.status === 'passed' && test.title === check.name))) {
  throw new Error('The release gate did not run all six named unit checks. Update the explicit check list after renaming a test.');
}
for (const check of unitChecks) console.log(`PASS ${check.name}`);

const policyFile = resolve(root, '../supabase/functions/create-control-command/command-policy.test.mjs');
if (!readFileSync(policyFile, 'utf8').includes(`test("${policyCheck}",`)) throw new Error('The controller-permissions release check is missing.');
const policy = spawnSync(process.execPath, ['--test', '--test-reporter=tap', `--test-name-pattern=^${escapeRegex(policyCheck)}$`, policyFile], { cwd: root, encoding: 'utf8' });
if (policy.error) throw policy.error;
const passed = policy.stdout.split('\n').filter((line) => /^ok \d+ - /.test(line) && !/ # (SKIP|TODO)/i.test(line));
if (policy.status !== 0 || passed.length !== 1 || !passed[0].endsWith(`- ${policyCheck}`)) {
  process.stdout.write(policy.stdout);
  process.stderr.write(policy.stderr);
  throw new Error('The controller-permissions release check did not pass.');
}
console.log(`PASS ${policyCheck}`);
console.log('UI release gate: 7 data/safety checks passed. No full-scale simulations were run.');
