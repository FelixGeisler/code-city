import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PACKAGE_BASE_PATH,
  assertPackageStateUnchanged,
  capturePackageState,
  createPackageManifest,
  parsePackageManifest,
  readPackageManifest,
  serializePackageManifest,
  validatePackageManifest,
  verifyManifestAgainstDirectory,
  writePackageManifest,
} from "../tools/package-manifest.mjs";

const CSP = "default-src 'none'; base-uri 'none'; connect-src 'self' https://api.github.com https://raw.githubusercontent.com; form-action 'none'; frame-src 'none'; object-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; worker-src 'self'";
const ORIGINS = ["'self'", "https://api.github.com", "https://raw.githubusercontent.com"];
const encoder = new TextEncoder();

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalManifest() {
  return {
    schemaVersion: 3,
    basePath: "/code-city/",
    policy: {
      contentSecurityPolicy: CSP,
      referrerPolicy: "no-referrer",
      connectOrigins: [...ORIGINS],
    },
    files: [
      { path: "assets/app.js", mediaType: "application/javascript", byteLength: 3, sha256: "0".repeat(64) },
      { path: "index.html", mediaType: "text/html", byteLength: 0, sha256: "f".repeat(64) },
    ],
  };
}

function clone(value) {
  return structuredClone(value);
}

function expectInvalidObject(value, pattern = /./u) {
  const before = clone(value);
  assert.throws(() => validatePackageManifest(value), pattern);
  assert.deepEqual(value, before);
}

function bytes(text) {
  return encoder.encode(text);
}

function expectInvalidBytes(value, pattern = /./u) {
  const before = Uint8Array.from(value);
  assert.throws(() => parsePackageManifest(value), pattern);
  assert.deepEqual(Uint8Array.from(value), before);
}

test("schema-v3 object and canonical-byte APIs preserve exact order, identity, and copies", () => {
  const manifest = canonicalManifest();
  assert.equal(PACKAGE_BASE_PATH, "/code-city/");
  assert.equal(validatePackageManifest(manifest), manifest);
  assert.deepEqual(Object.keys(manifest), ["schemaVersion", "basePath", "policy", "files"]);
  assert.deepEqual(Object.keys(manifest.policy), ["contentSecurityPolicy", "referrerPolicy", "connectOrigins"]);
  assert.deepEqual(Object.keys(manifest.files[0]), ["path", "mediaType", "byteLength", "sha256"]);
  assert.equal(manifest.policy.contentSecurityPolicy, CSP);
  assert.equal(manifest.policy.referrerPolicy, "no-referrer");
  assert.deepEqual(manifest.policy.connectOrigins, ORIGINS);

  const first = serializePackageManifest(manifest);
  const second = serializePackageManifest(manifest);
  const expected = bytes(`${JSON.stringify(manifest)}\n`);
  assert(first instanceof Uint8Array);
  assert.equal(Buffer.isBuffer(first), false);
  assert.equal(first.byteOffset, 0);
  assert.equal(first.byteLength, first.buffer.byteLength);
  assert.deepEqual(first, expected);
  assert.equal(digest(expected), "7ca903ebf9fc54270da10399ef7658716e0c6f3fbcdd1964746623eb80a8c5c9");
  assert.deepEqual(second, expected);
  assert.notEqual(first, second);
  first[0] = 0;
  assert.deepEqual(second, expected);

  const parsed = parsePackageManifest(second);
  assert.deepEqual(parsed, manifest);
  assert.notEqual(parsed, manifest);
  assert.equal(validatePackageManifest(parsed), parsed);
});

test("manifest object validation rejects every shape, policy, file, and runtime-property mutation", () => {
  const cases = [];
  const add = (label, mutate) => {
    const manifest = canonicalManifest();
    mutate(manifest);
    cases.push([label, manifest]);
  };

  add("schema v1", (value) => { value.schemaVersion = 1; });
  add("schema v2", (value) => { value.schemaVersion = 2; });
  add("schema type", (value) => { value.schemaVersion = "3"; });
  add("base path", (value) => { value.basePath = "/"; });
  add("base path type", (value) => { value.basePath = null; });
  add("policy type", (value) => { value.policy = null; });
  add("files type", (value) => { value.files = {}; });
  add("missing top field", (value) => { delete value.policy; });
  add("extra top field", (value) => { value.extra = true; });
  cases.push(["reordered top fields", { basePath: "/code-city/", schemaVersion: 3, policy: canonicalManifest().policy, files: canonicalManifest().files }]);

  add("CSP", (value) => { value.policy.contentSecurityPolicy += ";"; });
  add("CSP type", (value) => { value.policy.contentSecurityPolicy = null; });
  add("referrer", (value) => { value.policy.referrerPolicy = "origin"; });
  add("referrer type", (value) => { value.policy.referrerPolicy = null; });
  add("origins type", (value) => { value.policy.connectOrigins = {}; });
  add("missing policy field", (value) => { delete value.policy.referrerPolicy; });
  add("extra policy field", (value) => { value.policy.extra = true; });
  add("origin self", (value) => { value.policy.connectOrigins[0] = "self"; });
  add("origin type", (value) => { value.policy.connectOrigins[0] = null; });
  add("origin API", (value) => { value.policy.connectOrigins[1] += "/"; });
  add("origin raw", (value) => { value.policy.connectOrigins[2] += "/"; });
  add("origin missing", (value) => { value.policy.connectOrigins.pop(); });
  add("origin extra", (value) => { value.policy.connectOrigins.push("https://example.invalid"); });
  add("origin reordered", (value) => { value.policy.connectOrigins.reverse(); });
  add("empty files", (value) => { value.files = []; });
  add("files extra field", (value) => { value.files.extra = true; });

  add("file record type", (value) => { value.files[0] = null; });
  add("missing file field", (value) => { delete value.files[0].mediaType; });
  add("extra file field", (value) => { value.files[0].extra = true; });
  add("reordered file fields", (value) => {
    const record = value.files[0];
    value.files[0] = { mediaType: record.mediaType, path: record.path, byteLength: record.byteLength, sha256: record.sha256 };
  });
  const encodedDots = ["%2e", "%2E"];
  const encodedSeparators = ["%2f", "%2F", "%5c", "%5C"];
  const encodedAliases = [
    ...encodedDots.flatMap((left) => encodedDots.map((right) => `${left}${right}/app.js`)),
    ...encodedDots.flatMap((dot) => [`assets/${dot}/app.js`, `${dot}./app.js`, `.${dot}/app.js`]),
    ...encodedSeparators.map((separator) => `assets${separator}app.js`),
    "%252e%252e/app.js",
    "%61pp.js",
    "app%2ejs",
    "app%2Ejs",
    "assets/%7eapp.js",
    "assets/%7Eapp.js",
  ];
  for (const unsafePath of [
    "", "/app.js", "a\\b.js", "a//b.js", "a/./b.js", "a/../b.js", ".", "..", "a/",
    "a b.js", "a#b.js", "a?b.js", "a:b.js", "å.js", "a\u0000b.js", "a\u007fb.js",
    ...encodedAliases,
  ]) {
    add(`unsafe path ${JSON.stringify(unsafePath)}`, (value) => { value.files[0].path = unsafePath; });
  }
  const urlSafePath = canonicalManifest();
  urlSafePath.files[0].path = "Assets/~app_test-1.0.js";
  assert.equal(validatePackageManifest(urlSafePath), urlSafePath);
  add("path type", (value) => { value.files[0].path = null; });
  add("unsupported extension", (value) => { value.files[0].path = "asset.json"; });
  add("uppercase extension", (value) => { value.files[0].path = "asset.JS"; });
  add("legacy JavaScript media type", (value) => { value.files[0].mediaType = "text/javascript"; });
  add("media type type", (value) => { value.files[0].mediaType = null; });
  for (const badLength of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "3", null]) {
    add(`length ${String(badLength)}`, (value) => { value.files[0].byteLength = badLength; });
  }
  for (const badDigest of ["F".repeat(64), "0".repeat(63), "g".repeat(64), 0, null]) {
    add(`digest ${String(badDigest)}`, (value) => { value.files[0].sha256 = badDigest; });
  }
  add("duplicate paths", (value) => { value.files[1] = { ...value.files[0] }; });
  add("out-of-order paths", (value) => { value.files.reverse(); });

  for (const [label, value] of cases) {
    const before = clone(value);
    assert.throws(() => validatePackageManifest(value), undefined, label);
    assert.deepEqual(value, before, label);
  }

  const sparseFiles = canonicalManifest();
  sparseFiles.files = new Array(1);
  assert.throws(() => validatePackageManifest(sparseFiles), /dense/u);
  const sparseOrigins = canonicalManifest();
  sparseOrigins.policy.connectOrigins = new Array(3);
  assert.throws(() => validatePackageManifest(sparseOrigins), /dense/u);

  const inherited = Object.create(canonicalManifest());
  assert.throws(() => validatePackageManifest(inherited), /plain object/u);
  const inheritedFile = canonicalManifest();
  inheritedFile.files[0] = Object.assign(Object.create(inheritedFile.files[0]), inheritedFile.files[0]);
  assert.throws(() => validatePackageManifest(inheritedFile), /plain object/u);
  const inheritedPolicy = canonicalManifest();
  inheritedPolicy.policy = Object.assign(Object.create({ inherited: true }), inheritedPolicy.policy);
  assert.throws(() => validatePackageManifest(inheritedPolicy), /plain object/u);

  const accessor = canonicalManifest();
  Object.defineProperty(accessor, "schemaVersion", { enumerable: true, get: () => 3 });
  assert.throws(() => validatePackageManifest(accessor), /data property/u);
  const fileAccessor = canonicalManifest();
  Object.defineProperty(fileAccessor.files[0], "path", { enumerable: true, get: () => "assets/app.js" });
  assert.throws(() => validatePackageManifest(fileAccessor), /data property/u);
  const arrayAccessor = canonicalManifest();
  Object.defineProperty(arrayAccessor.files, "0", { enumerable: true, get: () => canonicalManifest().files[0] });
  assert.throws(() => validatePackageManifest(arrayAccessor), /data property/u);

  const symbol = canonicalManifest();
  symbol[Symbol("extra")] = true;
  assert.throws(() => validatePackageManifest(symbol), /fields/u);
  const fileSymbol = canonicalManifest();
  fileSymbol.files[0][Symbol("extra")] = true;
  assert.throws(() => validatePackageManifest(fileSymbol), /fields/u);
  const arraySymbol = canonicalManifest();
  arraySymbol.files[Symbol("extra")] = true;
  assert.throws(() => validatePackageManifest(arraySymbol), /dense/u);
  assert.throws(() => validatePackageManifest(new Proxy(canonicalManifest(), {})), /proxy/u);
  const proxiedFile = canonicalManifest();
  proxiedFile.files[0] = new Proxy(proxiedFile.files[0], {});
  assert.throws(() => validatePackageManifest(proxiedFile), /proxy/u);
  const proxiedOrigins = canonicalManifest();
  proxiedOrigins.policy.connectOrigins = new Proxy(proxiedOrigins.policy.connectOrigins, {});
  assert.throws(() => validatePackageManifest(proxiedOrigins), /proxy/u);
});

test("manifest parser rejects non-whole views and every noncanonical byte representation", () => {
  const manifest = canonicalManifest();
  const canonical = serializePackageManifest(manifest);
  expectInvalidBytes(Buffer.from(canonical), /Uint8Array/u);

  const padded = new Uint8Array(canonical.byteLength + 2);
  padded.set(canonical, 1);
  expectInvalidBytes(padded.subarray(1, -1), /whole backing buffer/u);
  const partial = new Uint8Array(canonical.buffer, 0, canonical.byteLength - 1);
  expectInvalidBytes(partial, /whole backing buffer/u);
  assert.throws(() => parsePackageManifest(new Proxy(canonical, {})), /proxy|Uint8Array/u);

  const text = new TextDecoder().decode(canonical);
  const representations = [
    Uint8Array.from([0xc3, 0x28]),
    bytes("{not-json}\n"),
    Uint8Array.from([0xef, 0xbb, 0xbf, ...canonical]),
    bytes(text.replace(/\n$/u, "\r\n")),
    bytes(text.slice(0, -1)),
    bytes(`${text}\n`),
    bytes(`${JSON.stringify(manifest, null, 2)}\n`),
    bytes(text.replace("/code-city/", "\\/code-city\\/")),
    bytes(text.replace('{"schemaVersion":3,"basePath":"/code-city/"', '{"basePath":"/code-city/","schemaVersion":3')),
    bytes(text.replace('{"schemaVersion":3', '{"schemaVersion":3,"schemaVersion":3')),
    bytes(`${text}false`),
    bytes(`${JSON.stringify({ ...manifest, schemaVersion: 2 })}\n`),
  ];
  for (const representation of representations) {
    expectInvalidBytes(representation);
  }
});

test("temporary packages generate recursively in lexical order and preserve canonical file APIs and state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "code-city-manifest-"));
  const packageDirectory = path.join(root, "dist");
  const manifestPath = path.join(root, "evidence", "package-manifest.json");
  try {
    await mkdir(path.join(packageDirectory, "a"), { recursive: true });
    await writeFile(path.join(packageDirectory, "a.js"), Uint8Array.from([0, 255, 1]));
    await writeFile(path.join(packageDirectory, "a", "style.css"), "body{}\n", "utf8");
    await writeFile(path.join(packageDirectory, "index.html"), "", "utf8");
    await writeFile(path.join(packageDirectory, "worker.wasm"), Uint8Array.from([0, 97, 115, 109]));

    const manifest = await createPackageManifest(packageDirectory);
    assert.deepEqual(manifest.files.map((record) => record.path), ["a.js", "a/style.css", "index.html", "worker.wasm"]);
    assert.deepEqual(manifest.files.map((record) => record.mediaType), ["application/javascript", "text/css", "text/html", "application/wasm"]);
    for (const record of manifest.files) {
      const content = await readFile(path.join(packageDirectory, ...record.path.split("/")));
      assert.equal(record.byteLength, content.byteLength);
      assert.equal(record.sha256, digest(content));
    }

    const written = await writePackageManifest(packageDirectory, manifestPath);
    assert.deepEqual(written, manifest);
    const stored = await readFile(manifestPath);
    assert.deepEqual(stored, Buffer.from(serializePackageManifest(written)));
    assert.deepEqual(await readPackageManifest(manifestPath), manifest);
    const verified = await verifyManifestAgainstDirectory(manifest, packageDirectory);
    assert.deepEqual(verified, manifest);
    assert.notEqual(verified, manifest);

    const state = await capturePackageState(packageDirectory, manifestPath);
    await assertPackageStateUnchanged(state, packageDirectory, manifestPath);
    await writeFile(path.join(packageDirectory, "a.js"), Uint8Array.from([0, 255, 2]));
    await assert.rejects(() => verifyManifestAgainstDirectory(manifest, packageDirectory), /does not match/u);
    await assert.rejects(() => assertPackageStateUnchanged(state, packageDirectory, manifestPath), /changed/u);
    await writeFile(path.join(packageDirectory, "a.js"), Uint8Array.from([0, 255, 1]));
    await assertPackageStateUnchanged(state, packageDirectory, manifestPath);

    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await assert.rejects(() => readPackageManifest(manifestPath), /canonical/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("directory generation rejects empty, unsupported, symlink, non-file, and non-directory roots", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "code-city-manifest-boundary-"));
  try {
    const empty = path.join(root, "empty");
    await mkdir(empty);
    await assert.rejects(() => createPackageManifest(empty), /must not be empty/u);

    const unsupported = path.join(root, "unsupported");
    await mkdir(unsupported);
    await writeFile(path.join(unsupported, "data.json"), "{}", "utf8");
    await assert.rejects(() => createPackageManifest(unsupported), /Unsupported production artifact type/u);

    const encodedAlias = path.join(root, "encoded-alias");
    await mkdir(path.join(encodedAlias, "%2e%2e"), { recursive: true });
    await writeFile(path.join(encodedAlias, "%2e%2e", "app.js"), "", "utf8");
    await assert.rejects(() => createPackageManifest(encodedAlias), /canonical URL-safe form/u);

    const rootFile = path.join(root, "file.js");
    await writeFile(rootFile, "", "utf8");
    await assert.rejects(() => createPackageManifest(rootFile), /real directory/u);

    const symlinkTarget = path.join(root, "target");
    await mkdir(symlinkTarget);
    await writeFile(path.join(symlinkTarget, "app.js"), "", "utf8");
    try {
      const linkedRoot = path.join(root, "linked-root");
      await symlink(symlinkTarget, linkedRoot, process.platform === "win32" ? "junction" : "dir");
      await assert.rejects(() => createPackageManifest(linkedRoot), /real directory/u);
      if (process.platform !== "win32") {
        for (const lexicalAlias of [`${linkedRoot}${path.sep}`, `${linkedRoot}${path.sep}.`]) {
          await assert.rejects(() => createPackageManifest(lexicalAlias), /real directory/u);
        }
      }

      const linkedEntryPackage = path.join(root, "linked-entry-package");
      await mkdir(linkedEntryPackage);
      await symlink(path.join(symlinkTarget, "app.js"), path.join(linkedEntryPackage, "app.js"), "file");
      await assert.rejects(() => createPackageManifest(linkedEntryPackage), /symbolic link/u);
    } catch (error) {
      if (!["EPERM", "EACCES", "ENOSYS"].includes(error.code)) throw error;
      t.diagnostic(`Symlink checks unsupported on this platform: ${error.code}`);
    }

    if (process.platform !== "win32") {
      const socketPackage = path.join(root, "socket-package");
      const socketPath = path.join(socketPackage, "entry.js");
      await mkdir(socketPackage);
      const server = createServer();
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      try {
        await assert.rejects(() => createPackageManifest(socketPackage), /non-file entry/u);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
