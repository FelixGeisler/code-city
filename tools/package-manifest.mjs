import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { types as utilTypes } from "node:util";
import { EXACT_CSP, EXACT_REFERRER_POLICY } from "./package-policy.mjs";

export const PACKAGE_BASE_PATH = "/code-city/";

const CONNECT_ORIGINS = Object.freeze([
  "'self'",
  "https://api.github.com",
  "https://raw.githubusercontent.com",
]);
const MANIFEST_KEYS = Object.freeze(["schemaVersion", "basePath", "policy", "files"]);
const POLICY_KEYS = Object.freeze(["contentSecurityPolicy", "referrerPolicy", "connectOrigins"]);
const FILE_KEYS = Object.freeze(["path", "mediaType", "byteLength", "sha256"]);
const MEDIA_TYPES = new Map([
  [".css", "text/css"],
  [".html", "text/html"],
  [".js", "text/javascript"],
  [".wasm", "application/wasm"],
]);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

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

function sameKeys(actual, expected) {
  return actual.length === expected.length
    && actual.every((key, index) => typeof key === "string" && key === expected[index]);
}

function assertExactDataObject(value, expectedKeys, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  invariant(!utilTypes.isProxy(value), `${label} must not be a proxy`);
  invariant(Object.getPrototypeOf(value) === Object.prototype, `${label} must be a plain object`);
  const ownKeys = Reflect.ownKeys(value);
  invariant(sameKeys(ownKeys, expectedKeys), `${label} has unexpected or reordered fields`);
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    invariant(descriptor && Object.hasOwn(descriptor, "value") && descriptor.enumerable, `${label}.${key} must be an enumerable own data property`);
  }
}

function assertDenseArray(value, label, { nonempty = false } = {}) {
  invariant(Array.isArray(value), `${label} must be an array`);
  invariant(!utilTypes.isProxy(value), `${label} must not be a proxy`);
  invariant(Object.getPrototypeOf(value) === Array.prototype, `${label} must be a plain array`);
  invariant(!nonempty || value.length > 0, `${label} must not be empty`);
  const ownKeys = Reflect.ownKeys(value);
  invariant(ownKeys.length === value.length + 1 && ownKeys.at(-1) === "length", `${label} must be a dense array without extra fields`);
  for (let index = 0; index < value.length; index += 1) {
    invariant(ownKeys[index] === String(index), `${label} must be a dense array without extra fields`);
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    invariant(descriptor && Object.hasOwn(descriptor, "value") && descriptor.enumerable, `${label}[${index}] must be an enumerable own data property`);
  }
}

function assertWholeUint8Array(bytes, label) {
  invariant(bytes instanceof Uint8Array && !Buffer.isBuffer(bytes), `${label} must be a Uint8Array`);
  invariant(!utilTypes.isProxy(bytes), `${label} must not be a proxy`);
  invariant(Object.getPrototypeOf(bytes) === Uint8Array.prototype, `${label} must be a plain Uint8Array`);
  invariant(bytes.buffer instanceof ArrayBuffer, `${label} must use an ArrayBuffer`);
  invariant(bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength, `${label} must cover its whole backing buffer`);
}

function bytesEqual(left, right) {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function mediaTypeFor(relativePath) {
  const mediaType = MEDIA_TYPES.get(path.posix.extname(relativePath));
  invariant(mediaType, `Unsupported production artifact type: ${relativePath}`);
  return mediaType;
}

function validatePackagePath(relativePath, label) {
  invariant(typeof relativePath === "string" && relativePath.length > 0, `${label} has no path`);
  invariant(!path.posix.isAbsolute(relativePath) && !relativePath.includes("\\"), `Unsafe package path: ${relativePath}`);
  invariant(!/\p{Cc}/u.test(relativePath), `Package path contains a control character: ${relativePath}`);
  const segments = relativePath.split("/");
  invariant(!segments.some((segment) => segment === "" || segment === "." || segment === ".."), `Non-canonical package path: ${relativePath}`);
  invariant(segments.every((segment) => /^[A-Za-z0-9._~-]+$/u.test(segment)), `Package path segment is not in canonical URL-safe form: ${relativePath}`);
  invariant(path.posix.normalize(relativePath) === relativePath, `Non-canonical package path: ${relativePath}`);
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
  const rootDirectory = path.resolve(directory);
  const rootMetadata = await lstat(rootDirectory);
  invariant(rootMetadata.isDirectory() && !rootMetadata.isSymbolicLink(), "Production package root must be a real directory");

  const paths = await listFiles(rootDirectory);
  paths.sort(lexicalCompare);
  const files = [];
  for (const relativePath of paths) {
    const content = await readFile(path.join(rootDirectory, ...relativePath.split("/")));
    files.push({
      path: relativePath,
      mediaType: mediaTypeFor(relativePath),
      byteLength: content.byteLength,
      sha256: sha256(content),
    });
  }

  return validatePackageManifest({
    schemaVersion: 2,
    basePath: PACKAGE_BASE_PATH,
    policy: {
      contentSecurityPolicy: EXACT_CSP,
      referrerPolicy: EXACT_REFERRER_POLICY,
      connectOrigins: [...CONNECT_ORIGINS],
    },
    files,
  });
}

export function validatePackageManifest(manifest) {
  assertExactDataObject(manifest, MANIFEST_KEYS, "Package manifest");
  invariant(manifest.schemaVersion === 2, "Unsupported package manifest schema");
  invariant(manifest.basePath === PACKAGE_BASE_PATH, `Package manifest base must be ${PACKAGE_BASE_PATH}`);

  assertExactDataObject(manifest.policy, POLICY_KEYS, "Package manifest policy");
  invariant(manifest.policy.contentSecurityPolicy === EXACT_CSP, "Package manifest has the wrong content security policy");
  invariant(manifest.policy.referrerPolicy === EXACT_REFERRER_POLICY, "Package manifest has the wrong referrer policy");
  assertDenseArray(manifest.policy.connectOrigins, "Package manifest connect origins");
  invariant(
    manifest.policy.connectOrigins.length === CONNECT_ORIGINS.length
      && manifest.policy.connectOrigins.every((origin, index) => origin === CONNECT_ORIGINS[index]),
    "Package manifest has the wrong connection origins",
  );

  assertDenseArray(manifest.files, "Package manifest files", { nonempty: true });
  let previousPath;
  const seen = new Set();
  for (const [index, record] of manifest.files.entries()) {
    assertExactDataObject(record, FILE_KEYS, `Package manifest file ${index}`);
    validatePackagePath(record.path, `Package manifest file ${index}`);
    invariant(!seen.has(record.path), `Duplicate package path: ${record.path}`);
    invariant(previousPath === undefined || lexicalCompare(previousPath, record.path) < 0, "Package manifest paths are not in lexical order");
    invariant(record.mediaType === mediaTypeFor(record.path), `Incorrect media type for ${record.path}`);
    invariant(Number.isSafeInteger(record.byteLength) && record.byteLength >= 0, `Invalid byte length for ${record.path}`);
    invariant(typeof record.sha256 === "string" && /^[0-9a-f]{64}$/u.test(record.sha256), `Invalid SHA-256 for ${record.path}`);
    seen.add(record.path);
    previousPath = record.path;
  }

  return manifest;
}

export function serializePackageManifest(manifest) {
  validatePackageManifest(manifest);
  return encoder.encode(`${JSON.stringify(manifest)}\n`);
}

export function parsePackageManifest(bytes) {
  assertWholeUint8Array(bytes, "Package manifest bytes");
  let manifest;
  try {
    manifest = JSON.parse(decoder.decode(bytes));
  } catch (error) {
    throw new Error(`Package manifest bytes are not valid UTF-8 JSON: ${error.message}`);
  }
  validatePackageManifest(manifest);
  const canonicalBytes = serializePackageManifest(manifest);
  invariant(bytesEqual(bytes, canonicalBytes), "Package manifest bytes are not canonical");
  return manifest;
}

export async function writePackageManifest(directory, manifestPath) {
  const manifest = validatePackageManifest(await createPackageManifest(directory));
  const bytes = serializePackageManifest(manifest);
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, bytes);
  return manifest;
}

export async function readPackageManifest(manifestPath) {
  const bytes = Uint8Array.from(await readFile(manifestPath));
  return parsePackageManifest(bytes);
}

export async function verifyManifestAgainstDirectory(manifest, directory) {
  const expectedBytes = serializePackageManifest(manifest);
  const actual = await createPackageManifest(directory);
  const actualBytes = serializePackageManifest(actual);
  invariant(bytesEqual(actualBytes, expectedBytes), "Package manifest does not match the production directory");
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
