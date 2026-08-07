import { describe, expect, it } from "vitest";

import {
  analyzeRepositorySnapshotFacts,
  SnapshotLimitError,
  type LocalAnalysisFacts,
  type RepositorySnapshot,
} from "../packages/analyzer/src/index.js";
import type { CityModule } from "../packages/core/src/index.js";

type FixtureFile = readonly [path: string, text: string];

function repositorySnapshot(
  name: string,
  definitions: readonly FixtureFile[],
): RepositorySnapshot {
  return {
    name,
    files: definitions.map(([filePath, text]) => ({
      path: filePath,
      text,
      byteLength: Buffer.byteLength(text, "utf8"),
    })),
    diagnostics: [],
  };
}

function moduleForSource(
  facts: LocalAnalysisFacts,
  sourcePath: string,
): CityModule {
  const source = facts.sources.find(({ path }) => path === sourcePath);
  if (source === undefined) {
    throw new Error(`Test source '${sourcePath}' was not analyzed.`);
  }
  const module = facts.modules.find(({ id }) => id === source.moduleId);
  if (module === undefined) {
    throw new Error(`Test source '${sourcePath}' has no module.`);
  }
  return module;
}

function moduleAt(
  facts: LocalAnalysisFacts,
  modulePath: string,
): CityModule {
  const module = facts.modules.find(({ path }) => path === modulePath);
  if (module === undefined) {
    throw new Error(`Test module '${modulePath}' was not discovered.`);
  }
  return module;
}

describe("npm package module discovery", () => {
  it("treats a Code City-shaped repository as one manifest-backed module", async () => {
    const facts = await analyzeRepositorySnapshotFacts([
      repositorySnapshot("Code City", [
        [
          "package.json",
          JSON.stringify({ name: "code-city", private: true, type: "module" }),
        ],
        [
          "tsconfig.json",
          JSON.stringify({
            include: ["apps/**/*.ts", "packages/**/*.ts", "tests/**/*.ts"],
          }),
        ],
        ["tsconfig.build.json", JSON.stringify({ extends: "./tsconfig.json" })],
        ["apps/cli/src/main.ts", "export const cli = true;"],
        ["apps/server/src/main.ts", "export const server = true;"],
        ["apps/viewer/src/main.ts", "export const viewer = true;"],
        ["packages/analyzer/src/index.ts", "export const analyzer = true;"],
        ["packages/core/src/index.ts", "export const core = true;"],
        ["packages/exporter/src/index.ts", "export const exporter = true;"],
        ["tests/analyzer.test.ts", "export const testFixture = true;"],
      ]),
    ]);

    expect(facts.modules).toHaveLength(1);
    expect(facts.modules[0]).toMatchObject({
      kind: "npm-package",
      name: "code-city",
      packageId: "code-city",
      path: "package.json",
      solutionIds: [],
    });
    expect(facts.modules[0]).not.toHaveProperty("parentModuleId");
    expect(new Set(facts.sources.map(({ moduleId }) => moduleId))).toEqual(
      new Set([facts.modules[0]!.id]),
    );
    expect(facts.modules.some(({ kind }) => kind === "unassigned")).toBe(false);
    const syntheticNames = new Set([
      "cli",
      "server",
      "viewer",
      "analyzer",
      "core",
      "exporter",
    ]);
    expect(
      facts.modules.filter(({ name }) => syntheticNames.has(name)),
    ).toEqual([]);
  });

  it("uses the deepest manifest, links npm parents, and ignores tsconfig as a boundary", async () => {
    const definitions: readonly FixtureFile[] = [
      ["package.json", JSON.stringify({ name: "workspace-root", private: true })],
      ["tsconfig.json", JSON.stringify({ compilerOptions: { strict: true } })],
      ["src/root.ts", "export const root = true;"],
      ["apps/api/tsconfig.json", JSON.stringify({ extends: "../../tsconfig.json" })],
      ["apps/api/src/main.ts", "export const api = true;"],
      ["packages/core/package.json", JSON.stringify({ name: "@code-city/core" })],
      ["packages/core/tsconfig.json", JSON.stringify({ extends: "../../tsconfig.json" })],
      ["packages/core/src/index.ts", "export const core = true;"],
      [
        "packages/core/internal/package.json",
        JSON.stringify({ name: "@code-city/internal" }),
      ],
      [
        "packages/core/internal/tsconfig.build.json",
        JSON.stringify({ extends: "../../../tsconfig.json" }),
      ],
      ["packages/core/internal/src/index.ts", "export const internal = true;"],
    ];
    const forward = await analyzeRepositorySnapshotFacts([
      repositorySnapshot("Workspace", definitions),
    ]);
    const reversed = await analyzeRepositorySnapshotFacts([
      repositorySnapshot("Workspace", [...definitions].reverse()),
    ]);

    expect(reversed).toEqual(forward);
    expect(
      forward.modules
        .filter(({ kind }) => kind === "npm-package")
        .map(({ path }) => path)
        .sort(),
    ).toEqual([
      "package.json",
      "packages/core/internal/package.json",
      "packages/core/package.json",
    ]);
    expect(forward.modules.some(({ path }) => path.includes("tsconfig"))).toBe(
      false,
    );

    const root = moduleAt(forward, "package.json");
    const core = moduleAt(forward, "packages/core/package.json");
    const internal = moduleAt(
      forward,
      "packages/core/internal/package.json",
    );
    expect(core).toMatchObject({
      name: "@code-city/core",
      packageId: "@code-city/core",
      parentModuleId: root.id,
    });
    expect(internal).toMatchObject({
      name: "@code-city/internal",
      packageId: "@code-city/internal",
      parentModuleId: core.id,
    });
    expect(moduleForSource(forward, "src/root.ts").id).toBe(root.id);
    expect(moduleForSource(forward, "apps/api/src/main.ts").id).toBe(root.id);
    expect(moduleForSource(forward, "packages/core/src/index.ts").id).toBe(
      core.id,
    );
    expect(
      moduleForSource(forward, "packages/core/internal/src/index.ts").id,
    ).toBe(internal.id);
  });

  it("respects framework precedence and keeps genuinely uncovered source unassigned", async () => {
    const frameworkFacts = await analyzeRepositorySnapshotFacts([
      repositorySnapshot("Mixed", [
        ["package.json", JSON.stringify({ name: "mixed-node" })],
        [
          "angular.json",
          JSON.stringify({
            projects: {
              frontend: { root: "frontend" },
              hybrid: { root: "packages/hybrid" },
            },
          }),
        ],
        ["loose.ts", "export const loose = true;"],
        ["frontend/main.ts", "export const frontend = true;"],
        [
          "packages/hybrid/package.json",
          JSON.stringify({ name: "@mixed/hybrid" }),
        ],
        ["packages/hybrid/main.ts", "export const hybrid = true;"],
        [
          "packages/hybrid/deeper/package.json",
          JSON.stringify({ name: "@mixed/deeper" }),
        ],
        [
          "packages/hybrid/deeper/main.ts",
          "export const deeper = true;",
        ],
        ["backend/App.csproj", "<Project />"],
        [
          "backend/Program.cs",
          "public sealed class Program { public int Value() => 1; }",
        ],
      ]),
    ]);

    expect(moduleForSource(frameworkFacts, "loose.ts")).toMatchObject({
      kind: "npm-package",
      path: "package.json",
    });
    expect(moduleForSource(frameworkFacts, "frontend/main.ts")).toMatchObject({
      kind: "angular-project",
      path: "frontend",
    });
    expect(
      moduleForSource(frameworkFacts, "packages/hybrid/main.ts"),
    ).toMatchObject({
      kind: "angular-project",
      path: "packages/hybrid",
    });
    expect(
      moduleForSource(frameworkFacts, "packages/hybrid/deeper/main.ts"),
    ).toMatchObject({
      kind: "npm-package",
      path: "packages/hybrid/deeper/package.json",
    });
    expect(moduleForSource(frameworkFacts, "backend/Program.cs")).toMatchObject(
      {
        kind: "dotnet-project",
        path: "backend/App.csproj",
      },
    );

    const uncoveredFacts = await analyzeRepositorySnapshotFacts([
      repositorySnapshot("Partially covered", [
        [
          "packages/owned/package.json",
          JSON.stringify({ name: "@partial/owned" }),
        ],
        ["packages/owned/index.ts", "export const owned = true;"],
        ["loose.ts", "export const uncovered = true;"],
      ]),
    ]);
    expect(
      moduleForSource(uncoveredFacts, "packages/owned/index.ts"),
    ).toMatchObject({ kind: "npm-package", name: "@partial/owned" });
    expect(moduleForSource(uncoveredFacts, "loose.ts")).toMatchObject({
      kind: "unassigned",
      name: "Unassigned",
    });
  }, 20_000);

  it("does not retain an empty Unassigned module for skipped loose C#", async () => {
    const facts = await analyzeRepositorySnapshotFacts([
      repositorySnapshot("Node with malformed C#", [
        ["package.json", JSON.stringify({ name: "node-with-malformed-csharp" })],
        ["src/index.ts", "export const retained = true;"],
        [
          "loose-broken.cs",
          `public sealed class Broken
{
    public int Choose(bool value)
    {
        if (value) {
`,
        ],
      ]),
    ]);

    expect(facts.sources.map(({ path }) => path)).toEqual(["src/index.ts"]);
    expect(facts.modules).toEqual([
      expect.objectContaining({
        kind: "npm-package",
        name: "node-with-malformed-csharp",
        path: "package.json",
      }),
    ]);
    expect(facts.modules.some(({ kind }) => kind === "unassigned")).toBe(false);
    expect(facts.warnings.join("\n")).toContain("loose-broken.cs");
  }, 20_000);

  it("skips invalid manifests and uses sanitized names for unnamed package boundaries", async () => {
    const facts = await analyzeRepositorySnapshotFacts([
      repositorySnapshot("Fallback Root", [
        ["package.json", JSON.stringify({ private: true })],
        ["src/main.ts", "export const root = true;"],
        ["packages/unnamed/package.json", JSON.stringify({ name: "   " })],
        ["packages/unnamed/index.ts", "export const unnamed = true;"],
        ["packages/bad/package.json", '{"name":"super-secret-value"'],
        ["packages/bad/index.ts", "export const bad = true;"],
        ["packages/list/package.json", "[]"],
        ["packages/list/index.ts", "export const list = true;"],
        [
          "packages/comment/package.json",
          '{"name":"commented" // package.json is strict JSON\n}',
        ],
        ["packages/comment/index.ts", "export const comment = true;"],
        ["packages/trailing/package.json", '{"name":"trailing",}'],
        ["packages/trailing/index.ts", "export const trailing = true;"],
      ]),
    ]);

    const root = moduleAt(facts, "package.json");
    const unnamed = moduleAt(facts, "packages/unnamed/package.json");
    expect(root).toMatchObject({
      kind: "npm-package",
      name: "Fallback Root",
    });
    expect(root).not.toHaveProperty("packageId");
    expect(unnamed).toMatchObject({
      kind: "npm-package",
      name: "unnamed",
      parentModuleId: root.id,
    });
    expect(unnamed).not.toHaveProperty("packageId");
    const invalidManifestPaths = new Set([
      "packages/bad/package.json",
      "packages/comment/package.json",
      "packages/list/package.json",
      "packages/trailing/package.json",
    ]);
    expect(
      facts.modules.filter(({ path }) => invalidManifestPaths.has(path)),
    ).toEqual([]);
    expect(moduleForSource(facts, "packages/bad/index.ts").id).toBe(root.id);
    expect(moduleForSource(facts, "packages/comment/index.ts").id).toBe(
      root.id,
    );
    expect(moduleForSource(facts, "packages/list/index.ts").id).toBe(root.id);
    expect(moduleForSource(facts, "packages/trailing/index.ts").id).toBe(
      root.id,
    );
    const warnings = facts.warnings.join("\n");
    expect(warnings).toContain("packages/bad/package.json");
    expect(warnings).toContain("packages/comment/package.json");
    expect(warnings).toContain("packages/list/package.json");
    expect(warnings).toContain("packages/trailing/package.json");
    expect(warnings).not.toContain("super-secret-value");
  });

  it("never turns invalid package names or dependency keys into internal identities", async () => {
    const facts = await analyzeRepositorySnapshotFacts([
      repositorySnapshot("Logical names", [
        ["package.json", JSON.stringify({ name: "logical-name-workspace" })],
        [
          "packages/consumer/package.json",
          JSON.stringify({
            name: "@scope/consumer",
            dependencies: {
              core: "1.0.0",
              "@scope/valid": "workspace:*",
              "../invalid-dependency": "1.0.0",
              "UpperCase-Dependency": "1.0.0",
              "/absolute-dependency": "1.0.0",
              "   ": "1.0.0",
            },
          }),
        ],
        ["packages/consumer/index.ts", "export const consumer = true;"],
        [
          "packages/traversal/package.json",
          JSON.stringify({ name: "../core" }),
        ],
        ["packages/traversal/index.ts", "export const traversal = true;"],
        [
          "packages/uppercase/package.json",
          JSON.stringify({ name: "UpperCase-Producer" }),
        ],
        ["packages/uppercase/index.ts", "export const uppercase = true;"],
        [
          "packages/absolute/package.json",
          JSON.stringify({ name: "/absolute-producer" }),
        ],
        ["packages/absolute/index.ts", "export const absolute = true;"],
        [
          "packages/whitespace/package.json",
          JSON.stringify({ name: "   " }),
        ],
        ["packages/whitespace/index.ts", "export const whitespace = true;"],
        [
          "packages/valid/package.json",
          JSON.stringify({ name: "@scope/valid" }),
        ],
        ["packages/valid/index.ts", "export const valid = true;"],
      ]),
    ]);

    for (const [modulePath, fallbackName] of [
      ["packages/traversal/package.json", "traversal"],
      ["packages/uppercase/package.json", "uppercase"],
      ["packages/absolute/package.json", "absolute"],
      ["packages/whitespace/package.json", "whitespace"],
    ] as const) {
      const invalidlyNamed = moduleAt(facts, modulePath);
      expect(invalidlyNamed.name).toBe(fallbackName);
      expect(invalidlyNamed).not.toHaveProperty("packageId");
    }

    const consumer = moduleAt(facts, "packages/consumer/package.json");
    const valid = moduleAt(facts, "packages/valid/package.json");
    expect(consumer).toMatchObject({
      name: "@scope/consumer",
      packageId: "@scope/consumer",
    });
    expect(valid).toMatchObject({
      name: "@scope/valid",
      packageId: "@scope/valid",
    });

    const references = facts.dependencies.filter(
      ({ kind, sourceId }) =>
        kind === "package-reference" && sourceId === consumer.id,
    );
    expect(references).toHaveLength(2);
    expect(references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          externalTarget: "core",
          resolution: "external",
          version: "1.0.0",
        }),
        expect.objectContaining({
          targetId: valid.id,
          resolution: "internal",
          version: "workspace:*",
        }),
      ]),
    );
    const core = references.find(
      ({ externalTarget }) => externalTarget === "core",
    );
    expect(core).not.toHaveProperty("targetId");
    expect(
      references.some(({ externalTarget }) =>
        [
          "invalid-dependency",
          "UpperCase-Dependency",
          "absolute-dependency",
        ].includes(externalTarget ?? ""),
      ),
    ).toBe(false);
  });

  it("matches the npm new-package logical-name boundaries", async () => {
    const invalidNames = [
      "@scope/.hidden",
      "~legacy",
      "-leading-hyphen",
      "UpperCase",
      "a".repeat(215),
      "http",
      "node_modules",
      "favicon.ico",
    ] as const;
    const validNames = [
      "@_scope/pkg",
      "@.scope/pkg",
      "@scope/-package",
      "@scope/_package",
      "ordinary_name",
      "ordinary.name",
    ] as const;
    const dependencies = Object.fromEntries([
      ...validNames.map((name) => [name, "workspace:*"] as const),
      ...invalidNames.map((name) => [name, "invalid-boundary"] as const),
      ["uppercase", "1.0.0"] as const,
    ]);
    const definitions: FixtureFile[] = [
      ["package.json", JSON.stringify({ name: "name-boundary-workspace" })],
      [
        "packages/consumer/package.json",
        JSON.stringify({ name: "boundary-consumer", dependencies }),
      ],
    ];
    for (const [index, name] of invalidNames.entries()) {
      const suffix = String(index).padStart(2, "0");
      definitions.push([
        `packages/invalid-${suffix}/package.json`,
        JSON.stringify({ name }),
      ]);
    }
    for (const [index, name] of validNames.entries()) {
      const suffix = String(index).padStart(2, "0");
      definitions.push([
        `packages/valid-${suffix}/package.json`,
        JSON.stringify({ name }),
      ]);
    }

    const facts = await analyzeRepositorySnapshotFacts([
      repositorySnapshot("Name boundaries", definitions),
    ]);
    for (const [index] of invalidNames.entries()) {
      const suffix = String(index).padStart(2, "0");
      const invalidlyNamed = moduleAt(
        facts,
        `packages/invalid-${suffix}/package.json`,
      );
      expect(invalidlyNamed.name).toBe(`invalid-${suffix}`);
      expect(invalidlyNamed).not.toHaveProperty("packageId");
    }
    const validModules = validNames.map((name, index) => {
      const suffix = String(index).padStart(2, "0");
      const module = moduleAt(facts, `packages/valid-${suffix}/package.json`);
      expect(module).toMatchObject({ name, packageId: name });
      return module;
    });

    const consumer = moduleAt(facts, "packages/consumer/package.json");
    const references = facts.dependencies.filter(
      ({ kind, sourceId }) =>
        kind === "package-reference" && sourceId === consumer.id,
    );
    expect(references).toHaveLength(validNames.length + 1);
    validModules.forEach((provider) => {
      expect(references).toContainEqual(
        expect.objectContaining({
          targetId: provider.id,
          resolution: "internal",
          version: "workspace:*",
        }),
      );
    });
    expect(references).toContainEqual(
      expect.objectContaining({
        externalTarget: "uppercase",
        resolution: "external",
        version: "1.0.0",
      }),
    );
    expect(
      references.some(({ version }) => version === "invalid-boundary"),
    ).toBe(false);
    const lowercaseCollision = references.find(
      ({ externalTarget }) => externalTarget === "uppercase",
    );
    expect(lowercaseCollision).not.toHaveProperty("targetId");
  });

  it("builds safe npm dependency edges and never guesses an ambiguous internal target", async () => {
    const facts = await analyzeRepositorySnapshotFacts([
      repositorySnapshot("Dependencies", [
        ["package.json", JSON.stringify({ name: "dependency-workspace" })],
        [
          "packages/app/package.json",
          JSON.stringify({
            name: "@code-city/app",
            dependencies: {
              "@code-city/core": "workspace:*",
              "@code-city/duplicate": "1.0.0",
              "left-pad": "^1.3.0",
              "ignored-number": 1,
            },
            optionalDependencies: { fsevents: "^2.3.3" },
            peerDependencies: { react: "^19.0.0" },
            devDependencies: { vitest: "^4.0.0" },
          }),
        ],
        ["packages/app/index.ts", "export const app = true;"],
        [
          "packages/core/package.json",
          JSON.stringify({ name: "@code-city/core" }),
        ],
        ["packages/core/index.ts", "export const core = true;"],
        [
          "packages/duplicate-a/package.json",
          JSON.stringify({ name: "@code-city/duplicate" }),
        ],
        ["packages/duplicate-a/index.ts", "export const duplicateA = true;"],
        [
          "packages/duplicate-b/package.json",
          JSON.stringify({ name: "@code-city/duplicate" }),
        ],
        ["packages/duplicate-b/index.ts", "export const duplicateB = true;"],
      ]),
    ]);

    const app = moduleAt(facts, "packages/app/package.json");
    const core = moduleAt(facts, "packages/core/package.json");
    const references = facts.dependencies.filter(
      ({ kind, sourceId }) =>
        kind === "package-reference" && sourceId === app.id,
    );
    expect(references).toHaveLength(5);
    expect(references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetId: core.id,
          resolution: "internal",
          version: "workspace:*",
          weight: 1,
        }),
        expect.objectContaining({
          externalTarget: "left-pad",
          resolution: "external",
          version: "^1.3.0",
        }),
        expect.objectContaining({
          externalTarget: "fsevents",
          resolution: "external",
          version: "^2.3.3",
        }),
        expect.objectContaining({
          externalTarget: "react",
          resolution: "external",
          version: "^19.0.0",
        }),
        expect.objectContaining({
          externalTarget: "@code-city/duplicate",
          resolution: "external",
          version: "1.0.0",
        }),
      ]),
    );
    expect(
      references.some(
        ({ externalTarget }) =>
          externalTarget === "vitest" || externalTarget === "ignored-number",
      ),
    ).toBe(false);
    const ambiguous = references.find(
      ({ externalTarget }) => externalTarget === "@code-city/duplicate",
    );
    expect(ambiguous).not.toHaveProperty("targetId");
  });

  it("rejects repositories exceeding the city module budget", async () => {
    const manifests: FixtureFile[] = Array.from(
      { length: 10_001 },
      (_, index) => {
        const suffix = String(index).padStart(5, "0");
        return [
          `packages/package-${suffix}/package.json`,
          JSON.stringify({ name: `package-${suffix}` }),
        ];
      },
    );

    let failure: unknown;
    try {
      await analyzeRepositorySnapshotFacts([
        repositorySnapshot("Too many packages", manifests),
      ]);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(SnapshotLimitError);
    expect(failure).toMatchObject({
      limitName: "modules",
      limit: 10_000,
      actual: 10_001,
    });
  }, 30_000);

  it("assigns many sources by the nearest package deterministically", async () => {
    const packageCount = 512;
    const definitions: FixtureFile[] = [
      ["package.json", JSON.stringify({ name: "indexed-workspace" })],
      [
        "angular.json",
        JSON.stringify({
          projects: {
            priority: { root: "packages/package-000" },
          },
        }),
      ],
    ];
    for (let index = 0; index < packageCount; index += 1) {
      const suffix = String(index).padStart(3, "0");
      const packageRoot = `packages/package-${suffix}`;
      definitions.push([
        `${packageRoot}/package.json`,
        JSON.stringify({ name: `@indexed/package-${suffix}` }),
      ]);
      definitions.push([
        `${packageRoot}/src/index.ts`,
        `export const value${suffix} = ${index};`,
      ]);
      definitions.push([
        `${packageRoot}/test/index.test.ts`,
        `export const testValue${suffix} = ${index};`,
      ]);
    }

    const forward = await analyzeRepositorySnapshotFacts([
      repositorySnapshot("Indexed ownership", definitions),
    ]);
    const reversed = await analyzeRepositorySnapshotFacts([
      repositorySnapshot("Indexed ownership", [...definitions].reverse()),
    ]);

    expect(reversed).toEqual(forward);
    expect(forward.sources).toHaveLength(packageCount * 2);
    expect(
      forward.modules.filter(({ kind }) => kind === "npm-package"),
    ).toHaveLength(packageCount + 1);
    expect(
      forward.modules.filter(({ kind }) => kind === "angular-project"),
    ).toHaveLength(1);
    expect(
      moduleForSource(forward, "packages/package-000/src/index.ts"),
    ).toMatchObject({
      kind: "angular-project",
      path: "packages/package-000",
    });
    for (const index of [1, 127, 255, 511]) {
      const suffix = String(index).padStart(3, "0");
      const expectedModulePath = `packages/package-${suffix}/package.json`;
      expect(
        moduleForSource(
          forward,
          `packages/package-${suffix}/src/index.ts`,
        ).path,
      ).toBe(expectedModulePath);
      expect(
        moduleForSource(
          forward,
          `packages/package-${suffix}/test/index.test.ts`,
        ).path,
      ).toBe(expectedModulePath);
    }
  }, 30_000);
});
