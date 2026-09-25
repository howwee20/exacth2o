import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { changedPaths, isWebsiteOnly } from './website-change-scope.mjs';

test('marketing copy and deleted root image assets use static publishing', () => {
  assert.equal(isWebsiteOnly(['about.html', 'index.html', 'quote.html', 'scheduling.jpg', 'scheduling.avif']), true);
});

test('mixed software changes, bundles, workflow changes and unknown paths keep full checks', () => {
  for (const path of ['research-portal/src/App.tsx', 'controller-release/agent.py',
    'supabase/migrations/access.sql', 'portal-app/assets/portal.js', 'demo-preview/main.tsx',
    'applications-preview/main.tsx', 'portal.html', 'demo.html', '.github/workflows/pages.yml',
    'scripts/website-change-scope.mjs', 'unknown.txt', 'research-portal/public/image.png']) {
    assert.equal(isWebsiteOnly(['about.html', path]), false, path);
  }
  assert.equal(isWebsiteOnly([]), false);
});

test('git comparison includes both rename paths and software since the last successful deployment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'website-scope-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  try {
    git('init', '-q'); git('config', 'user.name', 'Scope test'); git('config', 'user.email', 'test@example.com');
    mkdirSync(join(dir, 'research-portal'));
    writeFileSync(join(dir, 'research-portal/control.svg'), '<svg/>');
    writeFileSync(join(dir, 'about.html'), 'old');
    git('add', '.'); git('commit', '-qm', 'deployed'); const deployed = git('rev-parse', 'HEAD');
    renameSync(join(dir, 'research-portal/control.svg'), join(dir, 'image.svg'));
    git('add', '-A'); git('commit', '-qm', 'software change'); const previousPush = git('rev-parse', 'HEAD');
    writeFileSync(join(dir, 'about.html'), 'updated');
    git('add', '.'); git('commit', '-qm', 'website edit');
    assert.equal(isWebsiteOnly(changedPaths(previousPush, 'HEAD', dir)), true);
    const sinceDeployment = changedPaths(deployed, 'HEAD', dir);
    assert.ok(sinceDeployment.includes('research-portal/control.svg'));
    assert.ok(sinceDeployment.includes('image.svg'));
    assert.equal(isWebsiteOnly(sinceDeployment), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
