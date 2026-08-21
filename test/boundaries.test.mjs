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
    const kindCounts = Map.groupBy(result.imports, (entry) => entry.kind);
    assert.equal(result.imports.length, 15);
    assert.equal(kindCounts.get("ordinary import")?.length, 6);
    assert.equal(kindCounts.get("type-only import")?.length, 3);
    assert.equal(kindCounts.get("re-export")?.length, 3);
    assert.equal(kindCounts.get("string-literal dynamic import")?.length, 3);
    assert(result.imports.some((entry) => entry.sourceLayer === "edge" && entry.targetLayer === "outside-src"));
    assert(result.imports.some((entry) => entry.sourceLayer === "application" && entry.targetLayer === "domain"));
    assert(result.imports.some((entry) => entry.sourceLayer === "domain" && entry.targetLayer === "domain"));
  });
});

test("accepts same-layer, inward, and exact-query import types without duplicating dynamic evidence", async () => {
  await withFixture({
    "src/edge/main.ts": [
      "type Same = import('./same.ts').Same;",
      "type Inward = import('../domain/types.ts').Domain;",
      "type WorkerModule = typeof import('./worker.ts?worker&url');",
      "void import('../application/dynamic.ts');",
      "void (null as Same | Inward | WorkerModule | null);",
    ].join("\n"),
    "src/edge/same.ts": "export type Same = string;\n",
    "src/edge/worker.ts": "export {};\n",
    "src/application/dynamic.ts": "export {};\n",
    "src/domain/types.ts": "export type Domain = string;\n",
  }, async (root) => {
    const result = await checkBoundaries(root);
    const importTypes = result.imports.filter((entry) => entry.kind === "string-literal import type");
    assert.equal(importTypes.length, 3);
    assert(importTypes.some((entry) => entry.specifier === "./same.ts" && entry.targetLayer === "edge"));
    assert(importTypes.some((entry) => entry.specifier === "../domain/types.ts" && entry.targetLayer === "domain"));
    assert(importTypes.some((entry) => (
      entry.specifier === "./worker.ts?worker&url"
        && entry.resolved === "src/edge/worker.ts"
        && entry.targetLayer === "edge"
    )));
    assert.equal(result.imports.filter((entry) => entry.kind === "string-literal dynamic import").length, 1);
  });
});

test("accepts external-module import-equals dependencies without duplicate evidence", async () => {
  await withFixture({
    "src/edge/main.ts": [
      "import Same = require('./same.ts');",
      "import type Domain = require('../domain/types.ts');",
      "void Same;",
      "void (null as Domain.Value | null);",
    ].join("\n"),
    "src/edge/same.ts": "const same = true; export = same;\n",
    "src/domain/types.ts": "namespace Domain { export type Value = string; } export = Domain;\n",
  }, async (root) => {
    const result = await checkBoundaries(root);
    const imports = result.imports.filter((entry) => entry.kind.includes("external-module import equals"));
    assert.deepEqual(imports.map(({ kind, specifier, targetLayer }) => ({ kind, specifier, targetLayer })), [
      {
        kind: "external-module import equals",
        specifier: "./same.ts",
        targetLayer: "edge",
      },
      {
        kind: "type-only external-module import equals",
        specifier: "../domain/types.ts",
        targetLayer: "domain",
      },
    ]);
  });
});

test("rejects forbidden, missing, and unknown-query external-module import-equals dependencies", async () => {
  const error = await rejectedFixture({
    "src/edge/edge.ts": "const edge = true; export = edge;\n",
    "src/domain/main.ts": [
      "import Reverse = require('../edge/edge.ts');",
      "import Missing = require('./missing.ts');",
      "import Unknown = require('./same.ts?raw');",
      "void Reverse; void Missing; void Unknown;",
    ].join("\n"),
    "src/domain/same.ts": "const same = true; export = same;\n",
  });

  assert(error.violations.some((violation) => (
    violation.kind === "external-module import equals"
      && violation.specifier === "../edge/edge.ts"
      && violation.reason === "domain -> edge is forbidden"
  )));
  assert(error.violations.some((violation) => (
    violation.kind === "external-module import equals"
      && violation.specifier === "./missing.ts"
      && violation.reason === "unresolved local target"
  )));
  assert(error.violations.some((violation) => (
    violation.kind === "external-module import equals"
      && violation.specifier === "./same.ts?raw"
      && violation.reason === "unknown import query suffix is forbidden"
  )));
});

test("rejects a parser-permitted non-literal external-module import-equals dependency", async () => {
  const error = await rejectedFixture({
    "src/edge/main.ts": "const target = './same.ts'; import Invalid = require(target); void Invalid;\n",
    "src/edge/same.ts": "export {};\n",
  });

  assert(error.violations.some((violation) => (
    violation.kind === "non-literal external-module import equals"
      && violation.specifier === undefined
      && violation.reason === "dynamic, module, and import-type references must use a string literal"
  )));
});

test("accepts same-layer and inward external-module augmentations without treating declare global as a dependency", async () => {
  await withFixture({
    "src/edge/main.ts": [
      "export {};",
      "declare module './same.ts' { export interface SameAugmentation {} }",
      "declare module '../domain/types.ts' { export interface DomainAugmentation {} }",
      "declare global { interface Window { codeCity: boolean } }",
    ].join("\n"),
    "src/edge/same.ts": "export {};\n",
    "src/domain/types.ts": "export {};\n",
  }, async (root) => {
    const result = await checkBoundaries(root);
    const augmentations = result.imports.filter((entry) => entry.kind === "external-module augmentation");
    assert.deepEqual(
      augmentations.map(({ line, column, specifier, resolved, targetLayer }) => ({
        line,
        column,
        specifier,
        resolved,
        targetLayer,
      })),
      [
        {
          line: 2,
          column: 16,
          specifier: "./same.ts",
          resolved: "src/edge/same.ts",
          targetLayer: "edge",
        },
        {
          line: 3,
          column: 16,
          specifier: "../domain/types.ts",
          resolved: "src/domain/types.ts",
          targetLayer: "domain",
        },
      ],
    );
  });
});

test("rejects a reverse-layer external-module augmentation", async () => {
  const error = await rejectedFixture({
    "src/edge/types.ts": "export {};\n",
    "src/domain/main.ts": "export {}; declare module '../edge/types.ts' { export interface EdgeAugmentation {} }\n",
  });

  assert(error.violations.some((violation) => (
    violation.kind === "external-module augmentation"
      && violation.specifier === "../edge/types.ts"
      && violation.reason === "domain -> edge is forbidden"
  )));
});

test("rejects a missing local external-module augmentation target", async () => {
  const error = await rejectedFixture({
    "src/edge/main.ts": "export {}; declare module './missing.ts' { export interface MissingAugmentation {} }\n",
  });

  assert(error.violations.some((violation) => (
    violation.kind === "external-module augmentation"
      && violation.specifier === "./missing.ts"
      && violation.reason === "unresolved local target"
  )));
});

test("rejects an unknown-query external-module augmentation", async () => {
  const error = await rejectedFixture({
    "src/edge/main.ts": "export {}; declare module './same.ts?raw' { export interface QueryAugmentation {} }\n",
    "src/edge/same.ts": "export {};\n",
  });

  assert(error.violations.some((violation) => (
    violation.kind === "external-module augmentation"
      && violation.specifier === "./same.ts?raw"
      && violation.reason === "unknown import query suffix is forbidden"
  )));
});

test("classifies external-package augmentations as outside-src", async () => {
  await withFixture({
    "src/edge/main.ts": "export {}; declare module 'edge-package' { export interface EdgePackageAugmentation {} }\n",
  }, async (root) => {
    const result = await checkBoundaries(root);
    assert(result.imports.some((entry) => (
      entry.kind === "external-module augmentation"
        && entry.specifier === "edge-package"
        && entry.resolved === null
        && entry.targetLayer === "outside-src"
    )));
  });

  const error = await rejectedFixture({
    "src/application/main.ts": "export {}; declare module 'application-package' { export interface ApplicationPackageAugmentation {} }\n",
  });
  assert(error.violations.some((violation) => (
    violation.kind === "external-module augmentation"
      && violation.specifier === "application-package"
      && violation.reason === "application -> outside-src is forbidden"
  )));
});

test("rejects a reverse-layer import type", async () => {
  const error = await rejectedFixture({
    "src/edge/types.ts": "export type Edge = string;\n",
    "src/domain/main.ts": "type Edge = import('../edge/types.ts').Edge; void (null as Edge | null);\n",
  });

  assert(error.violations.some((violation) => (
    violation.kind === "string-literal import type"
      && violation.specifier === "../edge/types.ts"
      && violation.reason === "domain -> edge is forbidden"
  )));
});

test("rejects a missing import-type target", async () => {
  const error = await rejectedFixture({
    "src/edge/main.ts": "type Missing = import('./missing.ts').Missing; void (null as Missing | null);\n",
  });

  assert(error.violations.some((violation) => (
    violation.kind === "string-literal import type"
      && violation.specifier === "./missing.ts"
      && violation.reason === "unresolved local target"
  )));
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

test("fails closed for unknown queries, non-literal imports, and unresolved local targets", async () => {
  const error = await rejectedFixture({
    "src/edge/main.ts": [
      "type UnknownQuery = import('./same.ts?raw').Same;",
      "import './missing.ts';",
      "const target = './same.ts';",
      "type NonLiteral = import(target).Same;",
      "void import(target);",
      "void (null as UnknownQuery | NonLiteral | null);",
    ].join("\n"),
    "src/edge/same.ts": "export type Same = string;\n",
  });
  assert(error.violations.some((violation) => violation.kind === "string-literal import type" && violation.specifier === "./same.ts?raw" && violation.reason === "unknown import query suffix is forbidden"));
  assert(error.violations.some((violation) => violation.specifier === "./missing.ts" && violation.reason === "unresolved local target"));
  assert(error.violations.some((violation) => violation.kind === "non-literal import type" && violation.reason === "dynamic, module, and import-type references must use a string literal"));
  assert(error.violations.some((violation) => violation.kind === "non-literal dynamic import" && violation.reason === "dynamic, module, and import-type references must use a string literal"));
});

test("rejects direct Vite glob calls in every layer regardless of argument shape", async () => {
  const reason = "Vite import.meta.glob is forbidden in source layers because Vite is not a core dependency";
  const error = await rejectedFixture({
    "src/edge/same-layer.ts": "const modules = import.meta.glob('./*.ts'); void modules;\n",
    "src/application/array.ts": "const modules = import.meta.glob(['../edge/*.ts', '../domain/*.ts']); void modules;\n",
    "src/domain/literal.ts": "const modules = import.meta.glob('../edge/*.ts'); void modules;\n",
    "src/domain/options.ts": [
      "const pattern = '../application/*.ts';",
      "const modules = import.meta.glob<{ default: unknown }>(pattern, { eager: true, query: '?raw' });",
      "void modules;",
    ].join("\n"),
  });

  assert.deepEqual(
    error.violations.map(({ source, kind, specifier, reason: violationReason }) => ({
      source,
      kind,
      specifier,
      reason: violationReason,
    })),
    [
      { source: "src/application/array.ts", kind: "Vite import.meta.glob call", specifier: undefined, reason },
      { source: "src/domain/literal.ts", kind: "Vite import.meta.glob call", specifier: undefined, reason },
      { source: "src/domain/options.ts", kind: "Vite import.meta.glob call", specifier: undefined, reason },
      { source: "src/edge/same-layer.ts", kind: "Vite import.meta.glob call", specifier: undefined, reason },
    ],
  );
});

test("accepts same-layer and inward triple-slash path references from compiler metadata", async () => {
  await withFixture({
    "src/edge/main.ts": [
      '/// <reference path="./same.ts" />',
      '/// <reference path="../domain/types.ts" />',
      "export {};",
    ].join("\n"),
    "src/edge/same.ts": "export {};\n",
    "src/domain/types.ts": "export {};\n",
  }, async (root) => {
    const result = await checkBoundaries(root);
    const references = result.imports.filter((entry) => entry.kind === "triple-slash path reference");
    assert.deepEqual(references.map(({ specifier, targetLayer }) => ({ specifier, targetLayer })), [
      { specifier: "./same.ts", targetLayer: "edge" },
      { specifier: "../domain/types.ts", targetLayer: "domain" },
    ]);
  });
});

test("rejects forbidden and missing triple-slash path references", async () => {
  const error = await rejectedFixture({
    "src/edge/edge.ts": "export {};\n",
    "src/domain/main.ts": [
      '/// <reference path="../edge/edge.ts" />',
      '/// <reference path="./missing.ts" />',
      "export {};",
    ].join("\n"),
  });

  assert(error.violations.some((violation) => (
    violation.kind === "triple-slash path reference"
      && violation.specifier === "../edge/edge.ts"
      && violation.reason === "domain -> edge is forbidden"
  )));
  assert(error.violations.some((violation) => (
    violation.kind === "triple-slash path reference"
      && violation.specifier === "./missing.ts"
      && violation.reason === "unresolved local target"
  )));
});

test("fails closed on unsupported compiler reference, AMD, and no-default-lib directives", async () => {
  const error = await rejectedFixture({
    "src/edge/main.ts": [
      '/// <reference types="vite/client" />',
      '/// <reference lib="dom" />',
      '/// <reference no-default-lib="true" />',
      '/// <amd-dependency path="edge-browser-package" />',
      '/// <amd-module name="edge-browser-module" />',
      "export {};",
    ].join("\n"),
  });

  assert(error.violations.some((violation) => (
    violation.kind === "triple-slash types reference"
      && violation.specifier === "vite/client"
      && violation.reason === "unsupported compiler reference directive is forbidden"
  )));
  assert(error.violations.some((violation) => (
    violation.kind === "triple-slash lib reference"
      && violation.specifier === "dom"
      && violation.reason === "unsupported compiler reference directive is forbidden"
  )));
  for (const kind of [
    "unsupported reference compiler directive",
    "unsupported amd-dependency compiler directive",
    "unsupported amd-module compiler directive",
  ]) {
    assert(error.violations.some((violation) => (
      violation.kind === kind
        && violation.reason === "unsupported compiler reference directive is forbidden"
    )));
  }
});

test("accepts the actual strict production strata and retains the static worker import", async () => {
  const result = await checkBoundaries(projectRoot);
  assert.equal(result.filesChecked, 18);
  assert(result.imports.some((entry) => (
    entry.source === "src/edge/main.ts"
      && entry.specifier === "./processing-worker.ts?worker&url"
      && entry.resolved === "src/edge/processing-worker.ts"
      && entry.targetLayer === "edge"
  )));
  for (const entry of result.imports) {
    if (entry.sourceLayer === "application") {
      assert(["application", "domain"].includes(entry.targetLayer));
    }
    if (entry.sourceLayer === "domain") {
      assert.equal(entry.targetLayer, "domain");
    }
  }
});
