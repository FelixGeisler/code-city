import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalStandaloneRoot, projectRoot } from "./build-standalone.mjs";
import { auditStandaloneArtifact } from "./standalone-manifest.mjs";

const invokedPath = process.argv[1] && path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const artifactRoot = process.argv[2] ? path.resolve(process.argv[2]) : canonicalStandaloneRoot;
  const manifest = await auditStandaloneArtifact(artifactRoot);
  process.stdout.write(`Audited ${manifest.files.length} standalone files in ${path.relative(projectRoot, artifactRoot)}.\n`);
}
