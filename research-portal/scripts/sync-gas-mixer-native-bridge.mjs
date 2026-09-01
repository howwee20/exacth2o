import { chmod, copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../..");
const sourceRoot = path.join(repositoryRoot, "controller-release/gas-mixer-native-bridge");
const outputRoot = path.join(repositoryRoot, "portal-app");

await mkdir(outputRoot, { recursive: true });
await copyFile(path.join(sourceRoot, "native_bridge.py"), path.join(outputRoot, "gas-mixer-native-bridge.py"));
await copyFile(path.join(sourceRoot, "install-native-bridge.sh"), path.join(outputRoot, "install-gas-mixer-native-bridge.sh"));
await copyFile(path.join(sourceRoot, "rollback-native-bridge.sh"), path.join(outputRoot, "rollback-gas-mixer-native-bridge.sh"));
await chmod(path.join(outputRoot, "install-gas-mixer-native-bridge.sh"), 0o755);
await chmod(path.join(outputRoot, "rollback-gas-mixer-native-bridge.sh"), 0o755);
