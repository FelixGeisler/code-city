import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildVitePackage,
  canonicalDistDirectory,
  canonicalManifestPath,
  projectRoot,
} from "./build-package.mjs";
import {
  assertPackageStateUnchanged,
  capturePackageState,
  readPackageManifest,
  serializePackageManifest,
  verifyManifestAgainstDirectory,
  writePackageManifest,
} from "./package-manifest.mjs";

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export async function checkReproducibility() {
  const canonicalManifest = await readPackageManifest(canonicalManifestPath);
  await verifyManifestAgainstDirectory(canonicalManifest, canonicalDistDirectory);
  const canonicalBefore = await capturePackageState(canonicalDistDirectory, canonicalManifestPath);

  const reproducibilityRoot = path.join(projectRoot, "build", "reproducibility");
  const reproducedDist = path.join(reproducibilityRoot, "dist");
  const reproducedManifestPath = path.join(reproducibilityRoot, "package-manifest.json");
  let failure;

  await rm(reproducibilityRoot, { force: true, recursive: true });
  try {
    await buildVitePackage(reproducedDist);
    const reproducedManifest = await writePackageManifest(reproducedDist, reproducedManifestPath);
    const canonicalManifestBytes = serializePackageManifest(canonicalManifest);
    const reproducedManifestBytes = serializePackageManifest(reproducedManifest);
    invariant(
      Buffer.from(reproducedManifestBytes).equals(Buffer.from(canonicalManifestBytes)),
      "Reproduced manifest differs from the canonical manifest",
    );

    for (const record of canonicalManifest.files) {
      const [canonicalBytes, reproducedBytes] = await Promise.all([
        readFile(path.join(canonicalDistDirectory, ...record.path.split("/"))),
        readFile(path.join(reproducedDist, ...record.path.split("/"))),
      ]);
      invariant(canonicalBytes.equals(reproducedBytes), `Reproduced artifact differs: ${record.path}`);
    }
  } catch (error) {
    failure = error;
  } finally {
    await rm(reproducibilityRoot, { force: true, recursive: true });
    try {
      await assertPackageStateUnchanged(canonicalBefore, canonicalDistDirectory, canonicalManifestPath);
    } catch (stateError) {
      failure = failure
        ? new AggregateError([failure, stateError], "Reproducibility check failed and mutated the canonical package")
        : stateError;
    }
  }

  if (failure) {
    throw failure;
  }
  console.log(`Reproduced ${canonicalManifest.files.length} canonical package files byte for byte.`);
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  await checkReproducibility();
}
