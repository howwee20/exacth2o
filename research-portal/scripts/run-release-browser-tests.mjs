import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { browserChecks } from './release-checks.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const result = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config', 'playwright.release.config.ts'], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const report = JSON.parse(readFileSync(new URL('../.release-results/browser.json', import.meta.url), 'utf8'));
function specs(suites) { return suites.flatMap((suite) => [...(suite.specs ?? []), ...specs(suite.suites ?? [])]); }
const executed = specs(report.suites);
if (executed.length !== browserChecks.length || browserChecks.some((name) => !executed.some((spec) => spec.title === name && spec.tests.length === 1 && spec.tests[0].status === 'expected' && spec.tests[0].results.at(-1)?.status === 'passed'))) {
  throw new Error('The release gate did not pass all three named browser checks.');
}
console.log('UI release gate: 3 browser checks passed; 10 focused checks total.');
