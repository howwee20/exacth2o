import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class FileCursorStore {
  constructor(path) {
    this.path = path;
  }

  async read() {
    try {
      return JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async write(value) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.next`;
    await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
      mode: 0o600,
    });
    await rename(temporaryPath, this.path);
  }
}
