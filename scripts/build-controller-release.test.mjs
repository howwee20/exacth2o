import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = path.join(root, "scripts/build-controller-release.mjs");

test("full and executor packages use the maintained source and exclude build output", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "exacth2o-release-test-"));
  try {
    for (const recipe of ["full", "control-executor"]) {
      const output = path.join(temporary, recipe);
      execFileSync(process.execPath, [script, recipe, output]);
      const manifest = JSON.parse(readFileSync(path.join(output, "source-manifest.json"), "utf8"));
      const relative = recipe === "full" ? "control-executor/src/control-executor.mjs" : "src/control-executor.mjs";
      assert.deepEqual(readFileSync(path.join(output, relative)), readFileSync(path.join(root, "controller/control-executor/src/control-executor.mjs")));
      assert.ok(manifest.files[relative]);
      assert.ok(!Object.keys(manifest.files).some((name) => /(^|\/)(node_modules|dist|__pycache__)(\/|$)/.test(name)));
      if (recipe === "full") {
        assert.deepEqual(readFileSync(path.join(output, "docker-compose.yml")), readFileSync(path.join(root, "controller/docker-compose.yml")));
      }
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("release generation refuses a nonempty destination without changing it", () => {
  const output = mkdtempSync(path.join(tmpdir(), "exacth2o-release-existing-"));
  try {
    writeFileSync(path.join(output, "keep.txt"), "keep");
    assert.throws(() => execFileSync(process.execPath, [script, "full", output], { stdio: "pipe" }), /empty/);
    assert.equal(readFileSync(path.join(output, "keep.txt"), "utf8"), "keep");
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
