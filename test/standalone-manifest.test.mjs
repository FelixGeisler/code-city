import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { buildStandaloneArtifact, packageStandaloneBrowserHtml } from "../tools/build-standalone.mjs";
import { auditStandaloneArtifact, parseStandaloneManifest, serializeStandaloneManifest, validateStandaloneManifest, writeStandaloneManifest } from "../tools/standalone-manifest.mjs";

const builtFixtureRoot = await mkdtemp(path.join(os.tmpdir(), "code-city-standalone-built-fixture-"));
const builtArtifactRoot = path.join(builtFixtureRoot, "standalone");
await buildStandaloneArtifact(builtArtifactRoot);
after(() => rm(builtFixtureRoot, { recursive: true, force: true }));

function record(filePath, overrides = {}) {
  return {
    path: filePath,
    role: filePath.startsWith("public/") ? "public" : "private",
    mediaType: filePath.endsWith(".html") ? "text/html; charset=utf-8" : filePath.endsWith(".css") ? "text/css; charset=utf-8" : filePath.endsWith(".svg") ? "image/svg+xml" : filePath.endsWith(".wasm") ? "application/wasm" : "text/javascript; charset=utf-8",
    length: 0,
    sha256: "0".repeat(64),
    ...overrides,
  };
}

function manifest(files = [record("public/index.html")]) {
  return { version: 1, files };
}

test("standalone browser packaging replaces LF and CRLF source entries with packaged artifact references", async () => {
  const template = await readFile(new URL("../standalone.html", import.meta.url), "utf8");
  const lf = template.replaceAll("\r\n", "\n");
  const crlf = lf.replaceAll("\n", "\r\n");
  for (const [name, input] of [["LF", lf], ["CRLF", crlf]]) {
    const html = packageStandaloneBrowserHtml(input);
    assert.equal(html.includes("\r"), false, name);
    assert.equal(html.includes('/src/edge/standalone-browser-main.ts'), false, name);
    assert.equal(html.match(/href="\/browser\.css"/gu)?.length, 1, name);
    assert.equal(html.match(/src="\/browser\.js"/gu)?.length, 1, name);
  }
  const packaged = await readFile(path.join(builtArtifactRoot, "public", "index.html"), "utf8");
  assert.equal(packaged.includes('/src/edge/standalone-browser-main.ts'), false);
  assert.equal(packaged.match(/href="\/browser\.css"/gu)?.length, 1);
  assert.equal(packaged.match(/src="\/browser\.js"/gu)?.length, 1);
});

test("standalone builder emits the exact role layout and canonical closed manifest", async () => {
  const built = await auditStandaloneArtifact(builtArtifactRoot);
  const bytes = await readFile(path.join(builtArtifactRoot, "package-manifest.json"));
  assert.deepEqual([...Buffer.from(bytes.subarray(0, 3))], [...Buffer.from('{"v')]);
  assert.equal(bytes.at(-1), 0x0a);
  assert.deepEqual(Object.keys(built), ["version", "files"]);
  assert.equal(Object.getPrototypeOf(built), Object.prototype);
  assert.equal(Object.getPrototypeOf(built.files), Array.prototype);
  assert.deepEqual(Object.keys(built.files[0]), ["path", "role", "mediaType", "length", "sha256"]);
  assert(built.files.every((item) => item.role === (item.path.startsWith("public/") ? "public" : "private")));
  assert.deepEqual([...new Set(built.files.map((item) => item.path.split("/")[0]))], ["parser", "public", "server"]);
  assert.equal(built.files.some((item) => item.path === "package-manifest.json"), false);
  assert.equal(Buffer.from(bytes).equals(serializeStandaloneManifest(built)), true);
});

test("standalone manifest rejects reordered/extra/accessor records, sparse arrays, unsafe paths, roles, suffixes, media, lengths, digests, and order", () => {
  const cases = [];
  cases.push({ files: [record("public/index.html")], version: 1 });
  const extra = manifest(); extra.extra = true; cases.push(extra);
  const accessor = manifest(); Object.defineProperty(accessor.files[0], "path", { enumerable: true, get() { return "public/index.html"; } }); cases.push(accessor);
  const reorderedRecord = record("public/index.html"); cases.push(manifest([{ role: reorderedRecord.role, path: reorderedRecord.path, mediaType: reorderedRecord.mediaType, length: reorderedRecord.length, sha256: reorderedRecord.sha256 }]));
  const sparse = manifest(); sparse.files.length = 2; cases.push(sparse);
  for (const filePath of ["/public/index.html", "public//index.html", "public/../index.html", "public/%2e.html", "public\\index.html", "public/ümlaut.html", "other/index.html"]) cases.push(manifest([record(filePath)]));
  cases.push(manifest([record("public/index.html", { role: "private" })]));
  cases.push(manifest([record("server/data.json")]));
  cases.push(manifest([record("public/index.html", { mediaType: "text/html" })]));
  cases.push(manifest([record("public/index.html", { length: -1 })]));
  cases.push(manifest([record("public/index.html", { sha256: "A".repeat(64) })]));
  cases.push(manifest([record("public/index.html"), record("parser/a.js")]));
  for (const value of cases) assert.throws(() => validateStandaloneManifest(value));
  const valid = manifest([record("parser/a.js"), record("public/index.html")]);
  assert.deepEqual(parseStandaloneManifest(Uint8Array.from(serializeStandaloneManifest(valid))), valid);
  assert.throws(() => parseStandaloneManifest(Uint8Array.from(Buffer.from(` ${JSON.stringify(valid)}\n`))));
});

test("direct standalone audit fails closed for absent artifacts/manifests, stale bytes, missing records/files, extras, and symlinks", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "code-city-standalone-audit-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(() => auditStandaloneArtifact(path.join(root, "absent")));
  for (const scenario of ["missing-manifest", "stale", "missing-record", "missing-file", "unrecorded", "symlink"]) {
    const target = path.join(root, scenario);
    await cp(builtArtifactRoot, target, { recursive: true });
    if (scenario === "missing-manifest") await rm(path.join(target, "package-manifest.json"));
    if (scenario === "stale") await writeFile(path.join(target, "public", "index.html"), "changed\n");
    if (scenario === "missing-record") {
      const parsed = JSON.parse(await readFile(path.join(target, "package-manifest.json"), "utf8"));
      parsed.files = parsed.files.filter(({ path: filePath }) => filePath !== "public/browser.css");
      await writeFile(path.join(target, "package-manifest.json"), `${JSON.stringify(parsed)}\n`);
    }
    if (scenario === "missing-file") await rm(path.join(target, "public", "browser.css"));
    if (scenario === "unrecorded") await writeFile(path.join(target, "public", "extra.js"), "export {};\n");
    if (scenario === "symlink") {
      const real = path.join(root, "real-directory");
      await mkdir(real, { recursive: true });
      await writeFile(path.join(real, "entry.js"), "export {};\n");
      await symlink(real, path.join(target, "public", "linked"), process.platform === "win32" ? "junction" : "dir");
    }
    await assert.rejects(() => auditStandaloneArtifact(target), /Standalone|standalone|symbolic|ENOENT/u, scenario);
  }
});

test("standalone builder rejects a symlink introduced before manifest closure", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "code-city-standalone-builder-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "standalone");
  await buildStandaloneArtifact(target);
  await rm(path.join(target, "package-manifest.json"));
  const real = path.join(root, "real-directory");
  await mkdir(real, { recursive: true });
  await writeFile(path.join(real, "entry.js"), "export {};\n");
  await symlink(real, path.join(target, "server", "linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(() => writeStandaloneManifest(target), /symbolic link/u);
});
