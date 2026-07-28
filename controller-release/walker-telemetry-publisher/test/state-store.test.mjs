import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileCursorStore } from "../src/state-store.mjs";

test("recovers the last known-good cursor after primary-state corruption", async () => {
  const directory = await mkdtemp(join(tmpdir(), "walker-state-store-"));
  const path = join(directory, "cursor.json");
  try {
    const store = new FileCursorStore(path);
    await store.write({ cursor: 10 });
    await store.write({ cursor: 11 });
    assert.deepEqual(JSON.parse(await readFile(`${path}.previous`, "utf8")), {
      cursor: 10,
    });

    await writeFile(path, "{corrupt", "utf8");
    assert.deepEqual(await store.read(), { cursor: 10 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
