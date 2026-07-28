import {
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
} from "node:fs/promises";
import { dirname } from "node:path";

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function durableWrite(path, value, { backup = false } = {}) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporaryPath = `${path}.next`;
  const handle = await open(temporaryPath, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  if (backup) {
    try {
      await readJson(path);
      const backupPath = `${path}.previous`;
      await copyFile(path, backupPath);
      const backupHandle = await open(backupPath, "r");
      try {
        await backupHandle.sync();
      } finally {
        await backupHandle.close();
      }
    } catch {
      // Keep any existing known-good backup when the primary is absent or corrupt.
    }
  }
  await rename(temporaryPath, path);

  const directoryHandle = await open(directory, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

export class FileCursorStore {
  constructor(path) {
    this.path = path;
  }

  async read() {
    try {
      return await readJson(this.path);
    } catch (error) {
      try {
        const recovered = await readJson(`${this.path}.previous`);
        console.warn("Recovered Walker cursor from the previous durable state");
        return recovered;
      } catch (backupError) {
        if (error?.code === "ENOENT" && backupError?.code === "ENOENT") return null;
        throw error;
      }
    }
  }

  async write(value) {
    await durableWrite(this.path, value, { backup: true });
  }
}

export class FileHealthStore {
  constructor(path) {
    this.path = path;
  }

  async write(value) {
    await durableWrite(this.path, value);
  }
}
