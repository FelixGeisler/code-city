import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as viteBuild } from "vite";
import { writePackageManifest } from "./package-manifest.mjs";

export const projectRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
export const canonicalDistDirectory = path.join(projectRoot, "dist");
export const canonicalManifestPath = path.join(projectRoot, "build", "evidence", "package-manifest.json");

export async function buildVitePackage(outputDirectory, { logLevel = "info" } = {}) {
  await rm(outputDirectory, { force: true, recursive: true });
  await viteBuild({
    root: projectRoot,
    configFile: path.join(projectRoot, "vite.config.mjs"),
    logLevel,
    build: {
      emptyOutDir: true,
      outDir: outputDirectory,
    },
  });
}

export async function buildCanonicalPackage() {
  await rm(path.dirname(canonicalManifestPath), { force: true, recursive: true });
  await buildVitePackage(canonicalDistDirectory);
  const manifest = await writePackageManifest(canonicalDistDirectory, canonicalManifestPath);
  console.log(`Wrote ${manifest.files.length} packaged files and ${path.relative(projectRoot, canonicalManifestPath)}.`);
  return manifest;
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  await buildCanonicalPackage();
}
