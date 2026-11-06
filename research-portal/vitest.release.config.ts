import { defineConfig } from 'vitest/config';
import { escapeRegex, unitChecks } from './scripts/release-checks.mjs';

export default defineConfig({
  test: {
    environment: 'node',
    include: [...new Set(unitChecks.map((check: { file: string }) => check.file))],
    testNamePattern: new RegExp(`(?:^| )(?:${unitChecks.map((check: { name: string }) => escapeRegex(check.name)).join('|')})$`),
    maxWorkers: 2,
  },
});
