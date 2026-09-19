import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import viteConfig from "../vite.config.mjs";
import { assertClosedReference } from "../tools/audit-package.mjs";
import {
  METADATA,
  acquireOutputPath,
  createCleanupController,
  fetchBounded,
  validateMetadata,
} from "../tools/build-parser-assets.mjs";
import { inspectDependencyClosure } from "../tools/check-dependencies.mjs";
import {
  VENDOR_FILES,
  assertEntryNotices,
  checkParserAssets,
  inspectWasm,
  validateDylink,
  validateProvenance,
  verifyVendorFiles,
} from "../tools/check-parser-assets.mjs";
import {
  assertWorkerConstructionPolicy,
  inspectEntryPolicy,
} from "../tools/package-policy.mjs";

const projectRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

async function readText(relativePath) {
  return await readFile(path.join(projectRoot, ...relativePath.split("/")), "utf8");
}

async function readJson(relativePath) {
  return JSON.parse(await readText(relativePath));
}

function showTypeScriptConfig(relativePath) {
  const compiler = path.join(projectRoot, "node_modules", "typescript", "bin", "tsc");
  const output = execFileSync(process.execPath, [compiler, "--showConfig", "--project", relativePath], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  return JSON.parse(output);
}

async function listFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const files = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...await listFiles(path.join(directory, entry.name), relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

test("the dependency manifest and complete lock closure match the accepted pins", async () => {
  const result = await inspectDependencyClosure(projectRoot);
  assert(result.registryPackageCount > 0);
});

test("selected parser assets, notices, provenance, ABI envelope, dylink, and canonical inventory match accepted evidence", async () => {
  await checkParserAssets();
});

test("the exact six-file parser vendor boundary and every payload mutation fail closed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "code-city-parser-vendor-"));
  const source = path.join(projectRoot, "vendor", "tree-sitter-typescript");
  const target = path.join(root, "vendor", "tree-sitter-typescript");
  try {
    await cp(source, target, { recursive: true });
    await verifyVendorFiles(root);
    for (const relativePath of VENDOR_FILES) {
      const filePath = path.join(target, ...relativePath.split("/"));
      const original = await readFile(filePath);
      const mutation = Buffer.from(original);
      mutation[Math.floor(mutation.length / 2)] ^= 1;
      await writeFile(filePath, mutation);
      await assert.rejects(() => verifyVendorFiles(root), /changed|differs/u, relativePath);
      await writeFile(filePath, original);
    }
    await writeFile(path.join(target, "unknown"), "unexpected\n", "utf8");
    await assert.rejects(() => verifyVendorFiles(root), /allowlist/u);
    await rm(path.join(target, "unknown"));
    await rm(path.join(target, "grammar.patch"));
    await assert.rejects(() => verifyVendorFiles(root), /allowlist/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("closed dylink parsing rejects missing, duplicate, unknown, and trailing metadata", () => {
  const header = [0, 97, 115, 109, 1, 0, 0, 0];
  const name = [...Buffer.from("dylink.0", "utf8")];
  const custom = (subsections) => {
    const payload = [name.length, ...name, ...subsections];
    return [0, payload.length, ...payload];
  };
  const memory = [1, 4, 0, 0, 0, 0];
  const valid = Uint8Array.from([...header, ...custom(memory)]);
  assert.deepEqual(inspectWasm(valid).dylink, { memorySize: 0, memoryAlign: 0, tableSize: 0, tableAlign: 0, neededLibraries: [], subsectionTypes: [1] });
  assert.throws(() => inspectWasm(Uint8Array.from(header)), /exactly one/u);
  assert.throws(() => inspectWasm(Uint8Array.from([...header, ...custom(memory), ...custom(memory)])), /exactly one/u);
  assert.throws(() => inspectWasm(Uint8Array.from([...header, ...custom([3, 0])])), /Unknown/u);
  assert.throws(() => inspectWasm(Uint8Array.from([...header, ...custom([...memory, ...memory])])), /Duplicate/u);
  assert.throws(() => inspectWasm(Uint8Array.from([...header, ...custom([1, 5, 0, 0, 0, 0, 0])])), /Trailing/u);
  assert.notDeepEqual(inspectWasm(Uint8Array.from([...header, ...custom([...memory, 2, 1, 0])])).dylink, inspectWasm(valid).dylink);
});

test("the complete closed provenance validator directly rejects nested schema, type, array, mapping, and value mutations", async () => {
  const provenance = JSON.parse(await readFile(path.join(projectRoot, "vendor", "tree-sitter-typescript", "provenance.json"), "utf8"));
  assert.equal(validateProvenance(provenance), true);
  const mutations = [
    (value) => { value.unknown = true; },
    (value) => { delete value.patch; },
    (value) => { value.schemaVersion = "2"; },
    (value) => { value.source.typescript.package = "tree-sitter-typescript@latest"; },
    (value) => { value.source.javascriptDependency.license.path = "vendor/tree-sitter-typescript/LICENSE"; },
    (value) => { value.source.license.bytes = 1_081; },
    (value) => { value.patch.application = ["patch", "-p1"]; },
    (value) => { value.toolchain.generator.upstreamPublishedChecksumAvailable = true; },
    (value) => { delete value.toolchain.builder.releaseAssetId; },
    (value) => { value.toolchain.emscripten.networkDuringBuild = true; },
    (value) => { value.build.generate.arguments.reverse(); },
    (value) => { value.build.compile.arguments.push("--extra"); },
    (value) => { value.reproduction.control.typescriptWasm.bytes = 0; },
    (value) => { value.reproduction.patched.tsxParserC.sha256 = "0".repeat(64); },
    (value) => { value.reproduction.nodeTypes.byteIdenticalAcrossControlPatchedAndUpstream = "true"; },
    (value) => { value.closedAssetContract.abi.typescript = 15; },
    (value) => { value.closedAssetContract.canonicalInventory.rows = 218; },
    (value) => { value.closedAssetContract.dylink.typescript.neededLibraries = ["unknown"]; },
    (value) => { value.closedAssetContract.dylink.tsx.subsectionTypes = [1, 2]; },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(provenance);
    mutate(value);
    assert.throws(() => validateProvenance(value), /closed schema|mapping/u);
  }
});

test("actual parser dylink guards directly reject every closed field mutation", async () => {
  for (const [role, relativePath] of [
    ["grammar-typescript", "vendor/tree-sitter-typescript/wasm/tree-sitter-typescript.wasm"],
    ["grammar-tsx", "vendor/tree-sitter-typescript/wasm/tree-sitter-tsx.wasm"],
  ]) {
    const actual = inspectWasm(await readFile(path.join(projectRoot, ...relativePath.split("/")))).dylink;
    assert.equal(validateDylink(role, actual), true);
    for (const mutate of [
      (value) => { value.memorySize += 1; },
      (value) => { value.memoryAlign += 1; },
      (value) => { value.tableSize += 1; },
      (value) => { value.tableAlign += 1; },
      (value) => { value.neededLibraries.push("unknown"); },
      (value) => { value.subsectionTypes.push(2); },
      (value) => { delete value.memorySize; },
      (value) => { value.unknown = 0; },
    ]) {
      const value = structuredClone(actual);
      mutate(value);
      assert.throws(() => validateDylink(role, value), /dylink\.0 drift/u);
    }
  }
});

test("every labelled notice mutation fails closed", async () => {
  const sourceIndex = await readFile(path.join(projectRoot, "index.html"));
  const text = sourceIndex.toString("utf8");
  const firstStart = text.indexOf("  <!-- third-party-notice:source-grammar:");
  const secondStart = text.indexOf("  <!-- third-party-notice:source-grammar-dependency:");
  const viewportStart = text.indexOf("  <meta name=\"viewport\"");
  assert(firstStart >= 0 && secondStart > firstStart && viewportStart > secondStart);
  const first = text.slice(firstStart, secondStart);
  const second = text.slice(secondStart, viewportStart);
  const mutations = [
    text.slice(0, firstStart) + text.slice(secondStart),
    text.replace("Permission is hereby granted", "Permission is hereby changed"),
    text.slice(0, secondStart) + first + text.slice(secondStart),
    text.replace("third-party-notice:source-grammar:tree-sitter-typescript@0.23.2", "third-party-notice:source-grammar:unknown"),
    text.slice(0, firstStart) + second + first + text.slice(viewportStart),
    text.replace("-->\n  <!-- third-party-notice:source-grammar-dependency:", "\nthird-party-notice:source-grammar-dependency:"),
    text.replaceAll("\n", "\r\n"),
  ];
  for (const [index, mutation] of mutations.entries()) {
    await assert.rejects(() => assertEntryNotices(Buffer.from(mutation, "utf8"), `mutation-${index}`));
  }
});

test("the four prior and six narrow parser byte-fidelity attributes remain exact and effective", async () => {
  const expected = [
    "test/fixtures/wasm-inventory.tsv text eol=lf",
    "docs/modules/architecture/pages/adr/0011-interactive-webgl2-navigation-and-inspection.adoc text eol=lf",
    "test/fixtures/interactive/fixture.json text eol=lf",
    "docs/modules/architecture/pages/adr/0012-bounded-grouped-shaded-direct-webgl-city-presentation.adoc text eol=lf",
    "vendor/tree-sitter-typescript/LICENSE text eol=lf",
    "vendor/tree-sitter-typescript/LICENSE.javascript text eol=lf",
    "vendor/tree-sitter-typescript/grammar.patch text eol=lf",
    "vendor/tree-sitter-typescript/provenance.json text eol=lf",
    "vendor/tree-sitter-typescript/wasm/*.wasm -text",
    "index.html text eol=lf",
    "",
  ].join("\n");
  const workingTree = (await readText(".gitattributes")).replaceAll("\r\n", "\n");
  const committedBlob = execFileSync("git", ["show", "HEAD:.gitattributes"], { cwd: projectRoot, encoding: "utf8" });
  assert.equal(workingTree, expected);
  assert.equal(committedBlob, expected);
  const paths = [
    "vendor/tree-sitter-typescript/LICENSE",
    "vendor/tree-sitter-typescript/LICENSE.javascript",
    "vendor/tree-sitter-typescript/grammar.patch",
    "vendor/tree-sitter-typescript/provenance.json",
    "vendor/tree-sitter-typescript/wasm/tree-sitter-typescript.wasm",
    "vendor/tree-sitter-typescript/wasm/tree-sitter-tsx.wasm",
    "index.html",
  ];
  const output = execFileSync("git", ["check-attr", "text", "eol", "--", ...paths], { cwd: projectRoot, encoding: "utf8" });
  for (const relativePath of paths.slice(0, 4).concat("index.html")) {
    assert.match(output, new RegExp(`${relativePath.replaceAll("/", "\\/")}: text: set`));
    assert.match(output, new RegExp(`${relativePath.replaceAll("/", "\\/")}: eol: lf`));
  }
  for (const relativePath of paths.slice(4, 6)) assert.match(output, new RegExp(`${relativePath.replaceAll("/", "\\/")}: text: unset`));
  for (const relativePath of ["LICENSE", "LICENSE.javascript", "grammar.patch", "provenance.json"]) {
    const bytes = await readFile(path.join(projectRoot, "vendor", "tree-sitter-typescript", relativePath));
    assert(!bytes.includes(0x0d), `${relativePath} contains CR bytes`);
  }
});

test("exactly three strict no-emit TypeScript configs isolate main and worker libraries", async () => {
  const rootEntries = await readdir(projectRoot);
  const configFiles = rootEntries.filter((name) => /^tsconfig(?:\.[^.]+)?\.json$/.test(name)).sort();
  assert.deepEqual(configFiles, ["tsconfig.base.json", "tsconfig.main.json", "tsconfig.worker.json"]);

  const base = await readJson("tsconfig.base.json");
  assert.equal(base.compilerOptions.strict, true);
  assert.equal(base.compilerOptions.noEmit, true);
  assert.equal(base.compilerOptions.isolatedModules, true);

  const main = showTypeScriptConfig("tsconfig.main.json");
  assert.equal(main.compilerOptions.strict, true);
  assert.equal(main.compilerOptions.noEmit, true);
  assert.equal(main.compilerOptions.isolatedModules, true);
  assert.deepEqual(main.compilerOptions.lib, ["es2024", "dom", "dom.iterable"]);
  assert.deepEqual(main.compilerOptions.types, ["vite/client"]);
  assert.deepEqual(main.files.map((file) => file.replaceAll("\\", "/")), [
    "./src/edge/main.ts",
    "./src/edge/city-presenter.ts",
    "./src/domain/camera-picking-policy.ts",
  ]);

  const worker = showTypeScriptConfig("tsconfig.worker.json");
  assert.equal(worker.compilerOptions.strict, true);
  assert.equal(worker.compilerOptions.noEmit, true);
  assert.equal(worker.compilerOptions.isolatedModules, true);
  assert.deepEqual(worker.compilerOptions.lib, ["es2024", "webworker"]);
  assert(!worker.compilerOptions.lib.includes("dom"));
  assert.deepEqual(worker.compilerOptions.types, []);
  assert.deepEqual(worker.files.map((file) => file.replaceAll("\\", "/")), ["./src/edge/processing-worker.ts"]);
});

test("the Vite application is strictly layered, policy-closed, and has one static module worker", async () => {
  assert.equal(viteConfig.base, "/code-city/");
  assert.equal(viteConfig.publicDir, false);
  assert.equal(viteConfig.build.sourcemap, false);
  assert.equal(viteConfig.build.assetsInlineLimit, 0);
  assert.equal(viteConfig.worker.format, "es");

  const productionFiles = await listFiles(path.join(projectRoot, "src"));
  assert.deepEqual(productionFiles, [
    "application/base-metric-processing.ts",
    "application/city-payload.ts",
    "application/main-controller.ts",
    "application/metric-explanation.ts",
    "application/protocol.ts",
    "application/resolution.ts",
    "application/source-retrieval.ts",
    "application/worker-attempt.ts",
    "domain/base-metrics.ts",
    "domain/camera-picking-policy.ts",
    "domain/city-model.ts",
    "domain/complexity.ts",
    "domain/repository-reference.ts",
    "domain/source-admission.ts",
    "edge/city-presenter.ts",
    "edge/github-revision-gateway.ts",
    "edge/github-source-gateway.ts",
    "edge/main.ts",
    "edge/processing-worker.ts",
    "edge/semantic-publication.ts",
    "edge/shell.css",
    "edge/tree-sitter-adapter.ts",
    "edge/tree-sitter-assets.ts",
  ]);

  const indexHtml = await readText("index.html");
  inspectEntryPolicy(indexHtml);
  assert.match(indexHtml, /<h1>Code City<\/h1>/);
  assert.equal((indexHtml.match(/<form\b/gi) ?? []).length, 1);
  assert.equal((indexHtml.match(/<input\b/gi) ?? []).length, 1);
  assert.equal((indexHtml.match(/<button\b/gi) ?? []).length, 2);
  assert.equal((indexHtml.match(/\sdata-form(?:\s|>)/gi) ?? []).length, 1);
  assert.equal((indexHtml.match(/\sdata-status(?:\s|>)/gi) ?? []).length, 1);
  assert.equal((indexHtml.match(/\sdata-commit(?:\s|>)/gi) ?? []).length, 1);
  assert.equal((indexHtml.match(/\sdata-city(?:\s|>)/gi) ?? []).length, 1);
  assert.equal((indexHtml.match(/\sdata-city-reset(?:\s|>)/gi) ?? []).length, 1);
  assert.match(indexHtml, /<p id="city-navigation-instructions">[^<]+<\/p>/i);
  assert.match(indexHtml, /<button data-city-reset type="button">Reset view<\/button>/i);
  assert.doesNotMatch(indexHtml, /<(?:select|textarea|canvas)\b/i);

  const formTag = indexHtml.match(/<form\b[^>]*>/i)?.[0];
  const inputTag = indexHtml.match(/<input\b[^>]*>/i)?.[0];
  assert(formTag);
  assert(inputTag);
  assert.match(formTag, /\snovalidate(?:\s|>)/i);
  assert.match(indexHtml, /<label\s+for="repository">GitHub repository URL<\/label>/);
  assert.match(inputTag, /\sid="repository"(?:\s|>)/i);
  assert.match(inputTag, /\sname="repository"(?:\s|>)/i);
  assert.match(inputTag, /\stype="text"(?:\s|>)/i);
  assert.doesNotMatch(inputTag, /\stype="url"|\srequired(?:\s|>)/i);

  const mainSource = await readText("src/edge/main.ts");
  const workerSource = await readText("src/edge/processing-worker.ts");
  assert.match(mainSource, /from "\.\/processing-worker\.ts\?worker&url"/);
  assert.match(mainSource, /new Worker\(processingWorkerUrl, \{ type: "module" \}\)/);
  assert.match(mainSource, /form\.addEventListener\("submit", \(event\) => \{\s*event\.preventDefault\(\);\s*controller\.submit\(input\.value\);\s*\}\);/);
  assert.match(mainSource, /replaceStatus\("Working", cancel\)/);
  assert.match(mainSource, /commit\.textContent = revision/);
  assert.match(mainSource, /window\.addEventListener\("pagehide", \(\) => controller\.dispose\(\), \{ once: true \}\)/);
  assert.doesNotMatch(mainSource, /innerHTML|insertAdjacentHTML/);
  assertWorkerConstructionPolicy([["Main source", mainSource], ["Worker source", workerSource]]);
  assert.doesNotMatch(`${mainSource}\n${workerSource}`, /SharedWorker|blob:|data:|createObjectURL/);
});

test("the package closure guard rejects path aliases and traversal before manifest lookup", () => {
  const manifestPaths = new Set(["index.html", "assets/main.js", "assets/name with space.css"]);
  for (const reference of [
    "/code-city/",
    "/code-city/index.html",
    "/code-city/assets/main.js",
    "/code-city/assets/name%20with%20space.css",
  ]) {
    assert.doesNotThrow(() => assertClosedReference(reference, manifestPaths));
  }

  for (const reference of [
    "/code-city/../index.html",
    "/code-city/%2e%2e/index.html",
    "/code-city/assets%2fmain.js",
    "/code-city/assets%5cmain.js",
    "/code-city/assets\\main.js",
    "/code-city/assets//main.js",
    "/code-city/assets/./main.js",
    "/code-city/%69ndex.html",
    "/code-city/%",
  ]) {
    assert.throws(
      () => assertClosedReference(reference, manifestPaths),
      Error,
      `Expected package closure rejection for ${reference}`,
    );
  }
});

test("the development command configuration starts at the public base and shuts down cleanly", async () => {
  const server = await createViteServer({
    root: projectRoot,
    configFile: path.join(projectRoot, "vite.config.mjs"),
    logLevel: "silent",
    server: {
      host: "127.0.0.1",
      port: 0,
    },
  });
  try {
    await server.listen();
    const address = server.httpServer?.address();
    assert(typeof address === "object" && address);
    const response = await fetch(`http://127.0.0.1:${address.port}/code-city/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<h1>Code City<\/h1>/);
  } finally {
    await server.close();
  }
  assert.equal(server.httpServer?.listening, false);
});

test("metadata fetches require explicit JSON identity headers and exact per-endpoint streaming lengths before field acceptance", async () => {
  for (const metadata of METADATA) {
    const base = JSON.stringify({ gitHead: metadata.gitHead, dist: { integrity: metadata.integrity, tarball: metadata.tarball }, padding: "" });
    const paddingBytes = metadata.bytes - Buffer.byteLength(base, "utf8");
    assert(paddingBytes >= 0);
    const exact = Buffer.from(JSON.stringify({ gitHead: metadata.gitHead, dist: { integrity: metadata.integrity, tarball: metadata.tarball }, padding: "x".repeat(paddingBytes) }), "utf8");
    assert.equal(exact.byteLength, metadata.bytes);
    const fake = (body, declareLength = true) => async (url, options) => {
      assert.equal(url.href, metadata.url);
      assert.equal(options.headers.Accept, "application/json");
      assert.equal(options.headers["Accept-Encoding"], "identity");
      assert.equal(options.credentials, "omit");
      return new Response(body, { status: 200, headers: declareLength ? { "content-length": String(body.byteLength) } : {} });
    };
    const accepted = await fetchBounded(metadata.url, metadata.bytes, "application/json", fake(exact));
    assert.equal(validateMetadata(metadata, accepted).gitHead, metadata.gitHead);
    await assert.rejects(() => fetchBounded(metadata.url, metadata.bytes, "application/json", fake(exact.subarray(0, -1), false)), /byte length/u);
    await assert.rejects(() => fetchBounded(metadata.url, metadata.bytes, "application/json", fake(Buffer.concat([exact, Buffer.from("x")]), false)), /byte bound/u);
    const fieldsChanged = Buffer.from(exact);
    const offset = fieldsChanged.indexOf(Buffer.from(metadata.gitHead));
    fieldsChanged[offset] = fieldsChanged[offset] === 0x61 ? 0x62 : 0x61;
    assert.throws(() => validateMetadata(metadata, fieldsChanged), /npm metadata changed/u);
  }
});

test("builder ownership fakes cover create races and uncertain post-create containment without deleting unowned paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "code-city-builder-ownership-"));
  const raced = path.join(root, "raced");
  const removals = [];
  const racedController = createCleanupController({ removeOutput: async (value) => removals.push(value) });
  try {
    await assert.rejects(() => acquireOutputPath(raced, racedController, {
      mkdir: async () => { const error = new Error("created by another process"); error.code = "EEXIST"; throw error; },
      lstat: async () => assert.fail("post-create lstat must not run after EEXIST"),
      realpath: async () => assert.fail("post-create realpath must not run after EEXIST"),
    }), { code: "EEXIST" });
    await racedController.finish();
    assert.deepEqual(removals, []);

    const uncertain = path.join(root, "uncertain");
    const uncertainController = createCleanupController({ removeOutput: async (value) => removals.push(value) });
    await assert.rejects(() => acquireOutputPath(uncertain, uncertainController, {
      mkdir,
      lstat: async () => ({ isDirectory: () => true, isSymbolicLink: () => true }),
      realpath: async (value) => value,
    }), /ordinary directory/u);
    await assert.rejects(() => uncertainController.finish(), /Uncertain output ownership/u);
    assert.deepEqual(removals, []);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("builder terminal flow stops and awaits owned children before cleanup for SIGINT and SIGTERM", async () => {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const events = [];
    let settle;
    const controller = createCleanupController({ removeOutput: async () => { events.push("remove-output"); } });
    controller.claimOutput(path.join(os.tmpdir(), `owned-${signal}`));
    const record = {
      child: { kill: () => { events.push(`stop-${signal}`); settle(); return true; } },
      settled: new Promise((resolve) => { settle = () => { events.push(`settled-${signal}`); resolve(); }; }),
    };
    controller.trackChild(record);
    await controller.finish({ signal });
    assert.deepEqual(events, [`stop-${signal}`, `settled-${signal}`, "remove-output"]);
  }
});

test("builder terminal flow aggregates child-adjacent, container, and output cleanup failures without claiming clean state", async () => {
  const controller = createCleanupController({
    removeOutput: async () => { throw new Error("output cleanup failed"); },
    removeContainer: async () => { throw new Error("container cleanup failed"); },
    containerAbsent: async () => false,
  });
  controller.claimOutput(path.join(os.tmpdir(), "owned-cleanup-failure"));
  controller.trackContainer("code-city-parser-577-fake-owned");
  await assert.rejects(() => controller.finish(), (error) => {
    assert(error instanceof AggregateError);
    const detail = error.errors.map(String).join("\n");
    assert.match(detail, /Failed to remove owned container/u);
    assert.match(detail, /still exists/u);
    assert.match(detail, /Owned output retained/u);
    assert.match(detail, /absence was not verified/u);
    return true;
  });
});

test("the maintainer parser builder is manual, pinned, bounded, offline during builds, and absent from ordinary automation", async () => {
  const builder = await readText("tools/build-parser-assets.mjs");
  for (const expected of [
    "https://registry.npmjs.org/tree-sitter-typescript/0.23.2",
    "https://registry.npmjs.org/tree-sitter-javascript/0.23.1",
    "https://registry.npmjs.org/tree-sitter-cli/0.24.4",
    "https://registry.npmjs.org/tree-sitter-cli/0.25.10",
    "https://registry.npmjs.org/tree-sitter-typescript/-/tree-sitter-typescript-0.23.2.tgz",
    "https://registry.npmjs.org/tree-sitter-javascript/-/tree-sitter-javascript-0.23.1.tgz",
    "https://registry.npmjs.org/tree-sitter-cli/-/tree-sitter-cli-0.24.4.tgz",
    "https://registry.npmjs.org/tree-sitter-cli/-/tree-sitter-cli-0.25.10.tgz",
    "https://github.com/tree-sitter/tree-sitter/releases/download/v0.24.4/tree-sitter-linux-x64.gz",
    "https://github.com/tree-sitter/tree-sitter/releases/download/v0.25.10/tree-sitter-linux-x64.gz",
    "--pull", "never", "--network", "none", "--platform", "linux/amd64", "--rm",
    "control-1", "control-2", "patched-1", "patched-2",
  ]) assert(builder.includes(expected), `Builder is missing ${expected}`);
  assert.doesNotMatch(builder, /npm (?:install|ci)|docker (?:pull|build|tag|prune)|docker\.sock|--network[= ]host|--privileged/u);
  const packageManifest = await readJson("package.json");
  assert(!Object.values(packageManifest.scripts).some((command) => command.includes("build-parser-assets")));
  const ci = await readText(".github/workflows/ci.yml");
  const publish = await readText(".github/workflows/publish.yml");
  assert(!`${ci}\n${publish}`.includes("build-parser-assets"));
});

test("commands preserve the canonical package audit sequence and CI separates review from publication", async () => {
  const packageManifest = await readJson("package.json");
  assert.deepEqual(packageManifest.scripts, {
    dev: "vite",
    typecheck: "tsc -p tsconfig.main.json && tsc -p tsconfig.worker.json",
    test: "node --test",
    "test:manifest": "node --test test/package-manifest.test.mjs test/publication-record.test.mjs",
    "collect:production-evidence": "node tools/collect-production-evidence.mjs",
    build: "node tools/build-package.mjs",
    "test:reproducibility": "node tools/check-reproducibility.mjs",
    start: "node tools/serve-package.mjs",
    "test:package": "node tools/audit-package.mjs",
    "docs:build": "antora antora-playbook.yml",
    verify: "npm run typecheck && npm run test && npm run build && npm run test:reproducibility && npm run test:package && npm run docs:build",
  });

  const ci = await readText(".github/workflows/ci.yml");
  const publish = await readText(".github/workflows/publish.yml");
  assert.match(ci, /pull_request:/);
  assert.doesNotMatch(ci, /push:/);
  assert.match(publish, /push:\s*\n\s*branches: \[main\]/);
  assert.doesNotMatch(publish, /pull_request:/);
  for (const workflow of [ci, publish]) {
    const install = workflow.indexOf("npm ci --ignore-scripts");
    const closure = workflow.indexOf("npm ls --all");
    const audit = workflow.indexOf("npm audit --audit-level=high");
    const verify = workflow.indexOf("npm run verify");
    assert(install >= 0 && install < closure && closure < audit && audit < verify);
  }
  assert.doesNotMatch(ci, /upload-artifact|deploy-pages|configure-pages|environment:|pages:\s*write|id-token:\s*write|contents:\s*write/i);
});

test("both evidence observers require SUCCESS.city.geometry and contain no inspection access or retention surface", async () => {
  const browserObserver = await readText("tools/check-browser-evidence.mjs");
  const productionObserver = await readText("tools/collect-production-evidence.mjs");
  assert.equal((browserObserver.match(/message\.city\.geometry/gu) ?? []).length, 2);
  const productionStart = productionObserver.indexOf("export function createWorkerObserverSource");
  const productionEnd = productionObserver.indexOf("\nexport ", productionStart + 1);
  const productionWorkerObserver = productionObserver.slice(productionStart, productionEnd);
  assert.match(productionWorkerObserver, /descriptors\.city\.value[\s\S]*getOwnPropertyDescriptor\(city,"geometry"\)/u);
  for (const [name, source] of [["browser-package", browserObserver], ["production", productionWorkerObserver]]) {
    assert.doesNotMatch(source, /inspection|canonicalPath/iu, `${name} observer must have no inspection field vocabulary`);
  }
});

test("the packaged-Chrome watchdog is the exact ten-minute whole-harness bound", async () => {
  const browserEvidence = await readText("tools/check-browser-evidence.mjs");
  assert.match(browserEvidence, /^const WATCHDOG_MS = 600_000;$/m);
  assert.equal((browserEvidence.match(/Promise\.race\(/g) ?? []).length, 1);

  const navigation = browserEvidence.indexOf("await cdp.send(\"Page.navigate\"");
  const raceStart = browserEvidence.indexOf("const result = await Promise.race([");
  const raceEnd = browserEvidence.indexOf("clearTimeout(watchdog);", raceStart);
  const validation = browserEvidence.indexOf("validateBrowserResult(result, selected);", raceEnd);
  assert(navigation >= 0 && navigation < raceStart, "the watchdog race must start after the complete harness is launched");
  assert(raceStart >= 0 && raceEnd > raceStart, "the complete harness result and watchdog must remain in one race");
  assert(validation > raceEnd, "the raced whole-harness result must still be validated");

  const race = browserEvidence.slice(raceStart, raceEnd);
  assert.match(race, /document\.querySelector\('#result'\)\?\.textContent \|\| ''/);
  assert.match(race, /if \(text\) return JSON\.parse\(text\);/);
  assert.match(race, /Packaged browser evidence exceeded the ten-minute watchdog/);
  assert.match(race, /watchdog = setTimeout\([\s\S]*, WATCHDOG_MS\);/);
});

test("README and agent guidance describe the current product and supported commands", async () => {
  const readme = await readText("README.md");
  for (const expected of [
    "npm ci --ignore-scripts",
    "npm run dev",
    "http://localhost:5173/code-city/",
    "npm run build",
    "npm run start",
    "http://127.0.0.1:4173/code-city/",
    "npm run verify",
    "`main`",
  ]) {
    assert(readme.includes(expected), `README is missing ${expected}`);
  }

  const agents = await readText("AGENTS.md");
  for (const expected of ["npm run typecheck", "npm run test", "npm run build", "npm run test:reproducibility", "npm run test:package", "npm run docs:build", "npm run verify"]) {
    assert(agents.includes(expected), `AGENTS.md is missing ${expected}`);
  }
  assert.doesNotMatch(`${readme}\n${agents}`, /\bv2\b|\b2\.x\b|reimplementation|template|\bv1\b|\barchiv(?:e|al)\b|\bformer\b/i);
});
