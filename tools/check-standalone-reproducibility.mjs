import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildStandaloneArtifact, canonicalStandaloneRoot } from "./build-standalone.mjs";
import { auditStandaloneArtifact, parseStandaloneManifest } from "./standalone-manifest.mjs";

const temporary = await mkdtemp(path.join(os.tmpdir(), "code-city-standalone-reproducibility-"));
try {
  const canonical = await auditStandaloneArtifact(canonicalStandaloneRoot);
  const secondRoot = path.join(temporary, "standalone");
  await buildStandaloneArtifact(secondRoot);
  const secondBytes = await readFile(path.join(secondRoot, "package-manifest.json"));
  const canonicalBytes = await readFile(path.join(canonicalStandaloneRoot, "package-manifest.json"));
  if (!canonicalBytes.equals(secondBytes)) throw new Error("Standalone manifests are not byte-identical");
  const second = parseStandaloneManifest(Uint8Array.from(secondBytes));
  if (JSON.stringify(canonical) !== JSON.stringify(second)) throw new Error("Standalone manifest records differ");
  for (const record of canonical.files) {
    const left = await readFile(path.join(canonicalStandaloneRoot, ...record.path.split("/")));
    const right = await readFile(path.join(secondRoot, ...record.path.split("/")));
    if (!left.equals(right)) throw new Error(`Standalone file is not reproducible: ${record.path}`);
  }
  process.stdout.write(`Reproduced ${canonical.files.length} standalone files byte-for-byte.\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
