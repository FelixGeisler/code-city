import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { types as utilTypes } from "node:util";

export type FixtureRole = "public" | "private";

export interface FixtureRecord {
  readonly path: string;
  readonly role: FixtureRole;
  readonly mediaType: string;
  readonly length: number;
  readonly sha256: string;
}

export interface FixtureManifest {
  readonly version: 1;
  readonly files: readonly FixtureRecord[];
}

export interface PublicFixture {
  readonly mediaType: string;
  readonly bytes: Buffer;
}

const TOP_LEVEL_KEYS = Object.freeze(["version", "files"]);
const RECORD_KEYS = Object.freeze(["path", "role", "mediaType", "length", "sha256"]);
const decoder = new TextDecoder("utf-8", { fatal: true });

function invariant(condition: unknown, message = "Invalid fixture manifest"): asserts condition {
  if (!condition) throw new Error(message);
}

function exactDataObject(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value));
  invariant(!utilTypes.isProxy(value));
  invariant(Object.getPrototypeOf(value) === Object.prototype);
  const ownKeys = Reflect.ownKeys(value);
  invariant(ownKeys.length === keys.length && ownKeys.every((key, index) => key === keys[index]));
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    invariant(descriptor?.enumerable === true && Object.hasOwn(descriptor, "value"));
  }
}

function denseArray(value: unknown): asserts value is unknown[] {
  invariant(Array.isArray(value) && !utilTypes.isProxy(value) && Object.getPrototypeOf(value) === Array.prototype);
  const keys = Reflect.ownKeys(value);
  invariant(keys.length === value.length + 1 && keys.at(-1) === "length");
  for (let index = 0; index < value.length; index += 1) {
    invariant(keys[index] === String(index));
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    invariant(descriptor?.enumerable === true && Object.hasOwn(descriptor, "value"));
  }
}

function mediaTypeFor(filePath: string): string | undefined {
  if (filePath === "server/licenses.json") return "application/json; charset=utf-8";
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".wasm")) return "application/wasm";
  return undefined;
}

function validateFixturePath(filePath: unknown): asserts filePath is string {
  invariant(typeof filePath === "string" && /^(?:public|server|parser)\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/u.test(filePath));
  invariant(!filePath.includes("%") && !filePath.includes("\\"));
  const segments = filePath.split("/");
  invariant(!segments.some((segment) => segment === "." || segment === ".."));
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function validateFixtureManifest(value: unknown): FixtureManifest {
  exactDataObject(value, TOP_LEVEL_KEYS);
  invariant(value.version === 1);
  denseArray(value.files);

  let previousPath: string | undefined;
  let hasIndex = false;
  for (const record of value.files) {
    exactDataObject(record, RECORD_KEYS);
    validateFixturePath(record.path);
    invariant(previousPath === undefined || compareUtf8(previousPath, record.path) < 0);
    previousPath = record.path;

    const expectedRole = record.path.startsWith("public/") ? "public" : "private";
    invariant(record.role === expectedRole);
    invariant(record.mediaType === mediaTypeFor(record.path));
    invariant(Number.isSafeInteger(record.length) && (record.length as number) >= 0);
    invariant(typeof record.sha256 === "string" && /^[0-9a-f]{64}$/u.test(record.sha256));
    if (record.path === "public/index.html") hasIndex = true;
  }
  invariant(hasIndex);
  return value as unknown as FixtureManifest;
}

export function parseFixtureManifest(bytes: Uint8Array): FixtureManifest {
  invariant(bytes instanceof Uint8Array);
  let decoded: string;
  let parsed: unknown;
  try {
    decoded = decoder.decode(bytes);
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    throw new Error("Invalid fixture manifest");
  }
  const manifest = validateFixtureManifest(parsed);
  const canonical = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
  invariant(Buffer.from(bytes).equals(canonical));
  return manifest;
}

export async function loadPublicFixtures(
  manifestBytes: Uint8Array,
  artifactRoot: string,
): Promise<{ readonly manifest: FixtureManifest; readonly routes: ReadonlyMap<string, PublicFixture> }> {
  invariant(path.isAbsolute(artifactRoot), "Invalid artifact root");
  const manifest = parseFixtureManifest(manifestBytes);
  const routes = new Map<string, PublicFixture>();
  for (const record of manifest.files) {
    if (record.role !== "public") continue;
    const bytes = await readFile(path.join(artifactRoot, ...record.path.split("/")));
    invariant(bytes.byteLength === record.length, "Public fixture length mismatch");
    invariant(createHash("sha256").update(bytes).digest("hex") === record.sha256, "Public fixture digest mismatch");
    if (record.path === "public/index.html") {
      routes.set("/", Object.freeze({ mediaType: record.mediaType, bytes }));
    } else {
      const target = `/${record.path.slice("public/".length)}`;
      if (target !== "/index.html" && target !== "/package-manifest.json") {
        routes.set(target, Object.freeze({ mediaType: record.mediaType, bytes }));
      }
    }
  }
  return Object.freeze({ manifest, routes });
}
