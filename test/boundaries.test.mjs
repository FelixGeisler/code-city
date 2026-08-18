import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BoundaryError, checkBoundaries } from "../tools/check-boundaries.mjs";

const projectRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

async function withFixture(files, callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "code-city-boundaries-"));
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const absolutePath = path.join(root, ...relativePath.split("/"));
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content, "utf8");
    }
    return await callback(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function rejectedFixture(files) {
  let captured;
  await withFixture(files, async (root) => {
    await assert.rejects(
      checkBoundaries(root),
      (error) => {
        captured = error;
        return error instanceof BoundaryError;
      },
    );
  });
  return captured;
}

test("accepts same-layer, inward, and edge-to-outside imports in every supported static form", async () => {
  await withFixture({
    "outside.ts": "export const outside = true;\n",
    "src/edge/main.ts": [
      "import './same.ts';",
      "import { application } from '../application/main.ts';",
      "import type { DomainValue } from '../domain/types.ts';",
      "export { domainValue } from '../domain/value.ts';",
      "void import('../application/dynamic.ts');",
      "import '../../outside.ts';",
      "import 'edge-package';",
      "void application;",
      "void (null as DomainValue | null);",
    ].join("\n"),
    "src/edge/same.ts": "export {};\n",
    "src/application/main.ts": [
      "import './same.ts';",
      "import type { DomainValue } from '../domain/types.ts';",
      "export { domainValue } from '../domain/value.ts';",
      "void import('../domain/dynamic.ts');",
      "export const application = true;",
      "void (null as DomainValue | null);",
    ].join("\n"),
    "src/application/same.ts": "export {};\n",
    "src/application/dynamic.ts": "export {};\n",
    "src/domain/main.ts": [
      "import './same.ts';",
      "import type { DomainValue } from './types.ts';",
      "export { domainValue } from './value.ts';",
      "void import('./dynamic.ts');",
      "void (null as DomainValue | null);",
    ].join("\n"),
    "src/domain/same.ts": "export {};\n",
    "src/domain/types.ts": "export type DomainValue = string;\n",
    "src/domain/value.ts": "export const domainValue = 'value';\n",
    "src/domain/dynamic.ts": "export {};\n",
  }, async (root) => {
    const result = await checkBoundaries(root);
    const kinds = new Set(result.imports.map((entry) => entry.kind));
    assert(kinds.has("ordinary import"));
    assert(kinds.has("type-only import"));
    assert(kinds.has("re-export"));
    assert(kinds.has("string-literal dynamic import"));
    assert(result.imports.some((entry) => entry.sourceLayer === "edge" && entry.targetLayer === "outside-src"));
    assert(result.imports.some((entry) => entry.sourceLayer === "application" && entry.targetLayer === "domain"));
    assert(result.imports.some((entry) => entry.sourceLayer === "domain" && entry.targetLayer === "domain"));
  });
});

test("rejects outward ordinary, type-only, re-export, dynamic, and outside imports", async () => {
  const error = await rejectedFixture({
    "outside.ts": "export {};\n",
    "src/edge/edge.ts": "export type EdgeValue = string; export const edgeValue = true;\n",
    "src/application/app.ts": "export const applicationValue = true;\n",
    "src/application/ordinary.ts": "import '../edge/edge.ts';\n",
    "src/application/external.ts": "import 'outside-package';\n",
    "src/application/outside.ts": "import '../../outside.ts';\n",
    "src/domain/type-only.ts": "import type { EdgeValue } from '../edge/edge.ts'; void (null as EdgeValue | null);\n",
    "src/domain/reexport.ts": "export { applicationValue } from '../application/app.ts';\n",
    "src/domain/dynamic.ts": "void import('../application/app.ts');\n",
  });

  assert(error.violations.some((violation) => violation.kind === "ordinary import" && violation.reason === "application -> edge is forbidden"));
  assert(error.violations.some((violation) => violation.kind === "type-only import" && violation.reason === "domain -> edge is forbidden"));
  assert(error.violations.some((violation) => violation.kind === "re-export" && violation.reason === "domain -> application is forbidden"));
  assert(error.violations.some((violation) => violation.kind === "string-literal dynamic import" && violation.reason === "domain -> application is forbidden"));
  assert(error.violations.some((violation) => violation.source === "src/application/external.ts" && violation.reason === "application -> outside-src is forbidden"));
  assert(error.violations.some((violation) => violation.source === "src/application/outside.ts" && violation.reason === "application -> outside-src is forbidden"));
});

test("preserves and resolves an accepted exact ?worker&url import", async () => {
  await withFixture({
    "src/edge/main.ts": "import workerUrl from './worker.ts?worker&url'; void workerUrl;\n",
    "src/edge/worker.ts": "export {};\n",
  }, async (root) => {
    const result = await checkBoundaries(root);
    assert.deepEqual(result.imports, [{
      source: "src/edge/main.ts",
      sourceLayer: "edge",
      line: 1,
      column: 1,
      kind: "ordinary import",
      specifier: "./worker.ts?worker&url",
      resolved: "src/edge/worker.ts",
      targetLayer: "edge",
    }]);
  });
});

test("rejects a forbidden-layer exact ?worker&url import using the underlying target", async () => {
  const error = await rejectedFixture({
    "src/edge/worker.ts": "export {};\n",
    "src/application/main.ts": "import workerUrl from '../edge/worker.ts?worker&url'; void workerUrl;\n",
  });
  assert(error.violations.some((violation) => (
    violation.specifier === "../edge/worker.ts?worker&url"
      && violation.reason === "application -> edge is forbidden after stripping exact ?worker&url suffix"
  )));
});

test("rejects a missing exact ?worker&url target", async () => {
  const error = await rejectedFixture({
    "src/edge/main.ts": "import workerUrl from './missing.ts?worker&url'; void workerUrl;\n",
  });
  assert(error.violations.some((violation) => (
    violation.specifier === "./missing.ts?worker&url"
      && violation.reason === "unresolved local target after stripping exact ?worker&url suffix"
  )));
});

test("fails closed for unknown queries, non-literal dynamic imports, and unresolved local targets", async () => {
  const error = await rejectedFixture({
    "src/edge/main.ts": [
      "import './same.ts?raw';",
      "import './missing.ts';",
      "const target = './same.ts';",
      "void import(target);",
    ].join("\n"),
    "src/edge/same.ts": "export {};\n",
  });
  assert(error.violations.some((violation) => violation.specifier === "./same.ts?raw" && violation.reason === "unknown import query suffix is forbidden"));
  assert(error.violations.some((violation) => violation.specifier === "./missing.ts" && violation.reason === "unresolved local target"));
  assert(error.violations.some((violation) => violation.kind === "non-literal dynamic import" && violation.reason === "dynamic and module imports must use a string literal"));
});

test("accepts the actual edge-only production source and retains worker import evidence", async () => {
  const result = await checkBoundaries(projectRoot);
  assert.equal(result.filesChecked, 2);
  assert(result.imports.some((entry) => (
    entry.source === "src/edge/main.ts"
      && entry.specifier === "./processing-worker.ts?worker&url"
      && entry.resolved === "src/edge/processing-worker.ts"
      && entry.sourceLayer === "edge"
      && entry.targetLayer === "edge"
  )));
});
