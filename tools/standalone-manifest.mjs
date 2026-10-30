import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { types as utilTypes } from "node:util";

const TOP_LEVEL_KEYS = Object.freeze(["version", "files"]);
const RECORD_KEYS = Object.freeze(["path", "role", "mediaType", "length", "sha256"]);
const ROOT_ENTRIES = Object.freeze(["package-manifest.json", "public", "server"]);
const RUNTIME_DIRECTORIES = Object.freeze(["parser", "public", "server"]);
const decoder = new TextDecoder("utf-8", { fatal: true });

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function exactDataObject(value, keys, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  invariant(!utilTypes.isProxy(value) && Object.getPrototypeOf(value) === Object.prototype, `${label} must be plain`);
  invariant(Reflect.ownKeys(value).length === keys.length && keys.every((key, index) => Reflect.ownKeys(value)[index] === key), `${label} keys differ`);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    invariant(descriptor?.enumerable === true && Object.hasOwn(descriptor, "value"), `${label}.${key} must be own data`);
  }
}

function denseArray(value, label) {
  invariant(Array.isArray(value) && !utilTypes.isProxy(value) && Object.getPrototypeOf(value) === Array.prototype, `${label} must be a plain array`);
  const keys = Reflect.ownKeys(value);
  invariant(keys.length === value.length + 1 && keys.at(-1) === "length", `${label} must be dense`);
  for (let index = 0; index < value.length; index += 1) {
    invariant(keys[index] === String(index), `${label} must be dense`);
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    invariant(descriptor?.enumerable === true && Object.hasOwn(descriptor, "value"), `${label}[${index}] must be own data`);
  }
}

export function standaloneMediaType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".wasm")) return "application/wasm";
  throw new Error(`Unsupported standalone runtime suffix: ${filePath}`);
}

function validatePath(filePath) {
  invariant(typeof filePath === "string" && /^(?:public|server|parser)\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/u.test(filePath), `Invalid standalone path: ${String(filePath)}`);
  invariant(!filePath.includes("%") && !filePath.includes("\\") && !filePath.split("/").some((segment) => segment === "." || segment === ".."), `Invalid standalone path: ${filePath}`);
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function validateStandaloneManifest(value) {
  exactDataObject(value, TOP_LEVEL_KEYS, "Standalone manifest");
  invariant(value.version === 1, "Unsupported standalone manifest version");
  denseArray(value.files, "Standalone manifest files");
  let previous;
  for (const [index, record] of value.files.entries()) {
    exactDataObject(record, RECORD_KEYS, `Standalone manifest record ${index}`);
    validatePath(record.path);
    invariant(previous === undefined || compareUtf8(previous, record.path) < 0, "Standalone manifest paths are not strictly ordered");
    previous = record.path;
    const expectedRole = record.path.startsWith("public/") ? "public" : "private";
    invariant(record.role === expectedRole, `Incorrect standalone role: ${record.path}`);
    invariant(record.mediaType === standaloneMediaType(record.path), `Incorrect standalone media type: ${record.path}`);
    invariant(Number.isSafeInteger(record.length) && record.length >= 0, `Invalid standalone length: ${record.path}`);
    invariant(typeof record.sha256 === "string" && /^[0-9a-f]{64}$/u.test(record.sha256), `Invalid standalone digest: ${record.path}`);
  }
  invariant(value.files.some((record) => record.path === "public/index.html"), "Standalone public index is missing");
  return value;
}

export function serializeStandaloneManifest(manifest) {
  validateStandaloneManifest(manifest);
  return Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
}

export function parseStandaloneManifest(bytes) {
  invariant(bytes instanceof Uint8Array, "Standalone manifest must be bytes");
  let value;
  try { value = JSON.parse(decoder.decode(bytes)); }
  catch { throw new Error("Standalone manifest is not canonical UTF-8 JSON"); }
  const manifest = validateStandaloneManifest(value);
  invariant(Buffer.from(bytes).equals(serializeStandaloneManifest(manifest)), "Standalone manifest bytes are not canonical");
  return manifest;
}

async function collectFiles(directory, prefix) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compareUtf8(left.name, right.name));
  const files = [];
  for (const entry of entries) {
    const relative = `${prefix}/${entry.name}`;
    const absolute = path.join(directory, entry.name);
    const metadata = await lstat(absolute);
    invariant(!metadata.isSymbolicLink(), `Standalone artifact contains a symbolic link: ${relative}`);
    if (metadata.isDirectory()) files.push(...await collectFiles(absolute, relative));
    else {
      invariant(metadata.isFile(), `Standalone artifact contains a non-file entry: ${relative}`);
      files.push(relative);
    }
  }
  return files;
}

export async function createStandaloneManifest(artifactRoot) {
  const root = path.resolve(artifactRoot);
  const rootMetadata = await lstat(root);
  invariant(rootMetadata.isDirectory() && !rootMetadata.isSymbolicLink(), "Standalone artifact root must be a real directory");
  const rootEntries = (await readdir(root)).sort(compareUtf8);
  // Version 1 records files, not empty directories. Older artifacts may also
  // have a private parser root; file-only archive transport need not retain it.
  invariant(JSON.stringify(rootEntries.filter(entry => entry !== "parser")) === JSON.stringify(ROOT_ENTRIES), "Standalone artifact root layout differs");
  const files = [];
  for (const directory of RUNTIME_DIRECTORIES) {
    if (directory === "parser" && !rootEntries.includes(directory)) continue;
    const metadata = await lstat(path.join(root, directory));
    invariant(metadata.isDirectory() && !metadata.isSymbolicLink(), `Standalone ${directory} must be a real directory`);
    files.push(...await collectFiles(path.join(root, directory), directory));
  }
  files.sort(compareUtf8);
  const records = [];
  for (const filePath of files) {
    validatePath(filePath);
    const bytes = await readFile(path.join(root, ...filePath.split("/")));
    records.push({
      path: filePath,
      role: filePath.startsWith("public/") ? "public" : "private",
      mediaType: standaloneMediaType(filePath),
      length: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return validateStandaloneManifest({ version: 1, files: records });
}

export async function writeStandaloneManifest(artifactRoot) {
  const manifestPath = path.join(artifactRoot, "package-manifest.json");
  await writeFile(manifestPath, Buffer.from('{"version":1,"files":[]}\n', "utf8"), { flag: "wx" });
  const manifest = await createStandaloneManifest(artifactRoot);
  await writeFile(manifestPath, serializeStandaloneManifest(manifest));
  return manifest;
}

export async function auditStandaloneArtifact(artifactRoot) {
  const root = path.resolve(artifactRoot);
  const manifestBytes = Uint8Array.from(await readFile(path.join(root, "package-manifest.json")));
  const manifest = parseStandaloneManifest(manifestBytes);
  const actual = await createStandaloneManifest(root);
  invariant(serializeStandaloneManifest(actual).equals(Buffer.from(manifestBytes)), "Standalone manifest does not close over the runtime files");
  for (const record of manifest.files) {
    const bytes = await readFile(path.join(root, ...record.path.split("/")));
    invariant(bytes.byteLength === record.length, `Standalone length mismatch: ${record.path}`);
    invariant(createHash("sha256").update(bytes).digest("hex") === record.sha256, `Standalone digest mismatch: ${record.path}`);
  }
  return manifest;
}
