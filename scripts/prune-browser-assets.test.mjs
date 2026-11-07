import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { manifestAssets, pruneBrowserAssets } from './prune-browser-assets.mjs';

const directories = ['portal-app', 'demo-app', 'applications-demo-app'];

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'browser-assets-'));
  mkdirSync(path.join(root, 'scripts'));
  const history = {};
  for (const directory of directories) {
    mkdirSync(path.join(root, directory, 'assets'), { recursive: true });
    for (const file of ['old.js', 'previous.js', 'current.js', 'obsolete.js']) {
      writeFileSync(path.join(root, directory, 'assets', file), file);
    }
    writeFileSync(path.join(root, directory, 'asset-manifest.json'), JSON.stringify({ entry: { file: 'assets/current.js' } }));
    history[directory] = { current: ['assets/previous.js'], previous: ['assets/old.js'] };
  }
  writeFileSync(path.join(root, 'scripts/browser-asset-retention.json'), JSON.stringify(history));
  return root;
}

test('manifest inventory includes lazy chunks, styles, and images and rejects paths outside assets', () => {
  assert.deepEqual(manifestAssets({
    entry: { file: 'assets/main.js', css: ['assets/main.css'], assets: ['assets/logo.png'] },
    lazy: { file: 'assets/lazy.js' },
  }), ['assets/lazy.js', 'assets/logo.png', 'assets/main.css', 'assets/main.js']);
  assert.throws(() => manifestAssets({ entry: { file: '../source.ts' } }), /Expected a generated file/);
  assert.throws(() => manifestAssets({}), /no assets/);
});

test('retains the current and previous build, stays stable on rebuild, and advances on the next build', () => {
  const root = fixture();
  try {
    const first = pruneBrowserAssets(root);
    assert.ok(first.every(result => result.removed === 2));
    const history = readFileSync(path.join(root, 'scripts/browser-asset-retention.json'), 'utf8');
    assert.ok(pruneBrowserAssets(root).every(result => result.removed === 0));
    assert.equal(readFileSync(path.join(root, 'scripts/browser-asset-retention.json'), 'utf8'), history);
    for (const directory of directories) {
      assert.ok(existsSync(path.join(root, directory, 'assets/previous.js')));
      writeFileSync(path.join(root, directory, 'assets/next.js'), 'next');
      writeFileSync(path.join(root, directory, 'asset-manifest.json'), JSON.stringify({ entry: { file: 'assets/next.js' } }));
    }
    pruneBrowserAssets(root);
    for (const directory of directories) {
      assert.ok(existsSync(path.join(root, directory, 'assets/current.js')));
      assert.ok(existsSync(path.join(root, directory, 'assets/next.js')));
      assert.equal(existsSync(path.join(root, directory, 'assets/previous.js')), false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a missing retained file in any build prevents all deletion', () => {
  const root = fixture();
  try {
    rmSync(path.join(root, 'applications-demo-app/assets/previous.js'));
    assert.throws(() => pruneBrowserAssets(root), /ENOENT/);
    assert.ok(existsSync(path.join(root, 'portal-app/assets/obsolete.js')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
