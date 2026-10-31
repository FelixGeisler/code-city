import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { openInvestigationStore } from "./investigation-store";
import { parseAssetHostArguments } from "./config";
import { startInactiveHttpPerimeter } from "./http-perimeter";

const artifactRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const manifestPath = fileURLToPath(new URL("../../../../package-manifest.json", import.meta.url));
const configuration = parseAssetHostArguments(process.argv.slice(2));
const store = await openInvestigationStore(configuration.dataDirectory, artifactRoot);
const runtime = await startInactiveHttpPerimeter({
  configuration,
  store,
  fixtureManifestBytes: Uint8Array.from(await readFile(manifestPath)),
  artifactRoot,
});
let stopping = false;
const shutdown = (): void => {
  if (stopping) return;
  stopping = true;
  const closed = runtime.close();
  runtime.closeAllConnections();
  void Promise.all([closed, store.close()]).then(() => { process.stdout.write("SHUTDOWN\n"); process.exitCode = 0; }, () => { process.exitCode = 1; });
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
process.stdout.write(`READY ${runtime.origin}\n`);
