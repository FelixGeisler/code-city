import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const PACKAGE_BASE_PATH = "/code-city/";

const MEDIA_TYPES = new Map([
  [".css", "text/css"],
  [".html", "text/html"],
  [".js", "text/javascript"],
]);

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function lexicalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function mediaTypeFor(relativePath) {
  const mediaType = MEDIA_TYPES.get(path.posix.extname(relativePath));
  invariant(mediaType, `Unsupported production artifact type: ${relativePath}`);
  return mediaType;
}

async function listFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => lexicalCompare(left.name, right.name));

  const files = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = path.join(directory, entry.name);
    const metadata = await lstat(absolutePath);
    invariant(!metadata.isSymbolicLink(), `Production package contains a symbolic link: ${relativePath}`);

    if (metadata.isDirectory()) {
      files.push(...await listFiles(absolutePath, relativePath));
      continue;
    }

    invariant(metadata.isFile(), `Production package contains a non-file entry: ${relativePath}`);
    files.push(relativePath);
  }
  return files;
}

export async function createPackageManifest(directory) {
  const rootMetadata = await lstat(directory);
  invariant(rootMetadata.isDirectory() && !rootMetadata.isSymbolicLink(), "Production package root must be a real directory");

  const paths = await listFiles(directory);
  const files = [];
  for (const relativePath of paths) {
    const content = await readFile(path.join(directory, ...relativePath.split("/")));
    files.push({
      path: relativePath,
      mediaType: mediaTypeFor(relativePath),
      byteLength: content.byteLength,
      sha256: sha256(content),
    });
  }

  return {
    schemaVersion: 1,
    basePath: PACKAGE_BASE_PATH,
    files,
  };
}

function assertExactKeys(value, expectedKeys, label) {
  invariant(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const actualKeys = Object.keys(value).sort(lexicalCompare);
  const sortedExpected = [...expectedKeys].sort(lexicalCompare);
  invariant(JSON.stringify(actualKeys) === JSON.stringify(sortedExpected), `${label} has unexpected fields`);
}

export function validatePackageManifest(manifest) {
  assertExactKeys(manifest, ["basePath", "files", "schemaVersion"], "Package manifest");
  invariant(manifest.schemaVersion === 1, "Unsupported package manifest schema");
  invariant(manifest.basePath === PACKAGE_BASE_PATH, `Package manifest base must be ${PACKAGE_BASE_PATH}`);
  invariant(Array.isArray(manifest.files) && manifest.files.length > 0, "Package manifest must list production files");

  let previousPath;
  const seen = new Set();
  for (const [index, record] of manifest.files.entries()) {
    assertExactKeys(record, ["byteLength", "mediaType", "path", "sha256"], `Package manifest file ${index}`);
    invariant(typeof record.path === "string" && record.path.length > 0, `Package manifest file ${index} has no path`);
    invariant(!record.path.startsWith("/") && !record.path.includes("\\"), `Unsafe package path: ${record.path}`);
    invariant(path.posix.normalize(record.path) === record.path && !record.path.split("/").includes(".."), `Non-canonical package path: ${record.path}`);
    invariant(!seen.has(record.path), `Duplicate package path: ${record.path}`);
    invariant(previousPath === undefined || lexicalCompare(previousPath, record.path) < 0, "Package manifest paths are not in lexical order");
    invariant(record.mediaType === mediaTypeFor(record.path), `Incorrect media type for ${record.path}`);
    invariant(Number.isSafeInteger(record.byteLength) && record.byteLength >= 0, `Invalid byte length for ${record.path}`);
    invariant(typeof record.sha256 === "string" && /^[0-9a-f]{64}$/.test(record.sha256), `Invalid SHA-256 for ${record.path}`);
    seen.add(record.path);
    previousPath = record.path;
  }

  return manifest;
}

export async function writePackageManifest(directory, manifestPath) {
  const manifest = validatePackageManifest(await createPackageManifest(directory));
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

export async function readPackageManifest(manifestPath) {
  const text = await readFile(manifestPath, "utf8");
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw new Error(`Package manifest is not valid JSON: ${error.message}`);
  }
  return validatePackageManifest(manifest);
}

export async function verifyManifestAgainstDirectory(manifest, directory) {
  validatePackageManifest(manifest);
  const actual = await createPackageManifest(directory);
  invariant(JSON.stringify(actual) === JSON.stringify(manifest), "Package manifest does not match the production directory");
  return actual;
}

export async function capturePackageState(directory, manifestPath) {
  const manifestBytes = await readFile(manifestPath);
  const paths = await listFiles(directory);
  const files = new Map();
  for (const relativePath of paths) {
    files.set(relativePath, await readFile(path.join(directory, ...relativePath.split("/"))));
  }
  return { manifestBytes, files };
}

export async function assertPackageStateUnchanged(before, directory, manifestPath) {
  const after = await capturePackageState(directory, manifestPath);
  invariant(before.manifestBytes.equals(after.manifestBytes), "Canonical package manifest changed");
  invariant(before.files.size === after.files.size, "Canonical package file set changed");
  for (const [relativePath, content] of before.files) {
    const afterContent = after.files.get(relativePath);
    invariant(afterContent && content.equals(afterContent), `Canonical package changed: ${relativePath}`);
  }
}
