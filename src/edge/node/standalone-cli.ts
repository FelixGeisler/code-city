import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseStandaloneArguments } from "./config";
import { installInactiveSessionShutdownSignals, startInactiveSessionRuntime } from "./session-runtime";

const artifactRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const manifestPath = fileURLToPath(new URL("../../../../package-manifest.json", import.meta.url));
const configuration = parseStandaloneArguments(process.argv.slice(2));
const runtime = await startInactiveSessionRuntime({
  configuration,
  fixtureManifestBytes: Uint8Array.from(await readFile(manifestPath)),
  artifactRoot,
});
installInactiveSessionShutdownSignals(runtime);
process.stdout.write(`READY ${runtime.origin}\n`);
