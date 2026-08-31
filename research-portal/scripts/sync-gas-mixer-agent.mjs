import { chmod, copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../..");
const sourceRoot = path.join(repositoryRoot, "controller-release/gas-mixer-agent");
const outputRoot = path.join(repositoryRoot, "portal-app");

await mkdir(outputRoot, { recursive: true });
await copyFile(path.join(sourceRoot, "agent.py"), path.join(outputRoot, "gas-mixer-agent.py"));
await copyFile(path.join(sourceRoot, "update-agent.sh"), path.join(outputRoot, "pi-agent-update.sh"));
await chmod(path.join(outputRoot, "pi-agent-update.sh"), 0o755);
