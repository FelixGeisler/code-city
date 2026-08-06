import { describe, expect, it } from "vitest";

import {
  createHistoryEvolution,
  selectHistory,
  type HistoryEvolutionFrameInput,
  type LocalAnalysisFacts,
  type SourceFileFact,
} from "../packages/analyzer/src/index.js";
import {
  replayEvolutionBundle,
  serializeEvolutionBundle,
  type CityDependency,
  type CityModule,
} from "../packages/core/src/index.js";
import {
  GENERIC_GIT_HISTORY_RENAME_POLICY_REVISION,
} from "../packages/analyzer/src/git-snapshot.js";

const A = "1111111111111111111111111111111111111111";
const B = "2222222222222222222222222222222222222222";
const C = "3333333333333333333333333333333333333333";
const COMMITS = Object.freeze({
  a: Object.freeze({
    sha: A,
    parents: Object.freeze([]),
    committedAt: "2025-01-01T00:00:00.000Z",
  }),
  b: Object.freeze({
    sha: B,
    parents: Object.freeze([A]),
    committedAt: "2025-01-02T00:00:00.000Z",
  }),
  c: Object.freeze({
    sha: C,
    parents: Object.freeze([B]),
    committedAt: "2025-01-03T00:00:00.000Z",
  }),
});

function dependencyFacts(
  dependencies: readonly {
    readonly id: string;
    readonly version?: string;
    readonly resolution?: "external" | "unresolved";
    readonly weight?: number;
  }[],
): LocalAnalysisFacts {
  return Object.freeze({
    repositories: Object.freeze([
      Object.freeze({
        id: "raw-repository",
        name: "Dependency repository",
      }),
    ]),
    solutions: Object.freeze([]),
    modules: Object.freeze([
      Object.freeze({
        id: "raw-module",
        repositoryId: "raw-repository",
        kind: "dotnet-project" as const,
        name: "Dependency module",
        path: "Dependency.csproj",
        solutionIds: Object.freeze([]),
      }),
    ]),
    sources: Object.freeze([]),
    dependencies: Object.freeze(
      dependencies.map((dependency) =>
        Object.freeze({
          id: dependency.id,
          repositoryId: "raw-repository",
          sourceId: "raw-module",
          externalTarget: "example-package",
          resolution: dependency.resolution ?? "external",
          kind: "package-reference" as const,
          ...(dependency.version === undefined
            ? {}
            : { version: dependency.version }),
          weight: dependency.weight ?? 1,
        }),
      ),
    ),
    warnings: Object.freeze([]),
  });
}

function emptyAngularFacts(
  id: string,
  modulePath: string,
): LocalAnalysisFacts {
  return Object.freeze({
    repositories: Object.freeze([
      Object.freeze({
        id: "raw-repository",
        name: "Empty Angular repository",
      }),
    ]),
    solutions: Object.freeze([]),
    modules: Object.freeze([
      Object.freeze({
        id,
        repositoryId: "raw-repository",
        kind: "angular-project" as const,
        name: "Empty Angular project",
        path: modulePath,
        solutionIds: Object.freeze([]),
      }),
    ]),
    sources: Object.freeze([]),
    dependencies: Object.freeze([]),
    warnings: Object.freeze([]),
  });
}

function moduleFact(
  id: string,
  kind: CityModule["kind"],
  name: string,
  modulePath: string,
  packageId?: string,
): CityModule {
  return Object.freeze({
    id,
    repositoryId: "raw-repository",
    kind,
    name,
    path: modulePath,
    solutionIds: Object.freeze([]),
    ...(packageId === undefined ? {} : { packageId }),
  });
}

function sourceFact(
  id: string,
  moduleId: string,
  sourcePath: string,
  imports: readonly {
    readonly specifier: string;
    readonly count: number;
  }[],
): SourceFileFact {
  return Object.freeze({
    id,
    repositoryId: "raw-repository",
    moduleId,
    districtId: moduleId,
    districtName: moduleId,
    districtPath: moduleId,
    name: sourcePath.split("/").at(-1) ?? sourcePath,
    path: sourcePath,
    language: "typescript",
    metrics: Object.freeze({
      sloc: 1,
      decisionLoad: 0,
      maximumComplexity: 1,
      executableUnitCount: 1,
    }),
    metricMethod: "typescript-compiler-api-v1",
    units: Object.freeze([
      Object.freeze({
        name: "module",
        line: 1,
        complexity: 1,
      }),
    ]),
    risk: "low",
    semanticGroupId: "risk-low",
    imports: Object.freeze([...imports]),
  });
}

function referenceFacts(
  modules: readonly CityModule[],
  sources: readonly SourceFileFact[],
  dependencies: readonly CityDependency[],
): LocalAnalysisFacts {
  return Object.freeze({
    repositories: Object.freeze([
      Object.freeze({
        id: "raw-repository",
        name: "Reference repository",
      }),
    ]),
    solutions: Object.freeze([]),
    modules: Object.freeze([...modules]),
    sources: Object.freeze([...sources]),
    dependencies: Object.freeze([...dependencies]),
    warnings: Object.freeze([]),
  });
}

function packageReferenceFacts(
  internal: boolean,
  entries: readonly {
    readonly id: string;
    readonly version: string;
  }[] = [
    {
      id: internal ? "raw-package-internal" : "raw-package-external",
      version: "1.0.0",
    },
  ],
): LocalAnalysisFacts {
  const consumer = moduleFact(
    "raw-consumer",
    "dotnet-project",
    "Consumer",
    "src/Consumer/Consumer.csproj",
    "Consumer",
  );
  const provider = moduleFact(
    "raw-provider",
    "dotnet-project",
    "Provider",
    "src/Provider/Provider.csproj",
    "Example.Package",
  );
  return referenceFacts(
    internal ? [consumer, provider] : [consumer],
    [],
    entries.map((entry) =>
      Object.freeze({
        id: entry.id,
        repositoryId: "raw-repository",
        sourceId: consumer.id,
        ...(internal
          ? { targetId: provider.id }
          : { externalTarget: "Example.Package" }),
        resolution: internal ? "internal" : "external",
        kind: "package-reference",
        version: entry.version,
        weight: 1,
      }),
    ),
  );
}

function distinctPackageReferenceFacts(
  internal: boolean,
  reverseDependencies = false,
): LocalAnalysisFacts {
  const consumer = moduleFact(
    "raw-distinct-consumer",
    "dotnet-project",
    "Consumer",
    "src/Consumer/Consumer.csproj",
    "Consumer",
  );
  const references = [
    {
      suffix: "alpha",
      packageId: "Example.Alpha",
    },
    {
      suffix: "beta",
      packageId: "Example.Beta",
    },
  ] as const;
  const providers = references.map(({ suffix, packageId }) =>
    moduleFact(
      `raw-provider-${suffix}`,
      "dotnet-project",
      `Provider ${suffix}`,
      `src/${suffix}/Provider.csproj`,
      packageId,
    ),
  );
  const dependencies = references.map(
    ({ suffix, packageId }, index): CityDependency =>
      Object.freeze({
        id: `raw-${internal ? "internal" : "external"}-${suffix}`,
        repositoryId: "raw-repository",
        sourceId: consumer.id,
        ...(internal
          ? { targetId: providers[index]!.id }
          : { externalTarget: packageId }),
        resolution: internal ? "internal" : "external",
        kind: "package-reference",
        version: "1.0.0",
        weight: 1,
      }),
  );
  return referenceFacts(
    internal ? [consumer, ...providers] : [consumer],
    [],
    reverseDependencies
      ? [...dependencies].reverse()
      : dependencies,
  );
}

function projectReferenceFacts(
  internal: boolean,
  additionalProviders: readonly CityModule[] = [],
): LocalAnalysisFacts {
  const consumer = moduleFact(
    "raw-consumer",
    "dotnet-project",
    "Consumer",
    "src/Consumer/Consumer.csproj",
  );
  const provider = moduleFact(
    "raw-provider",
    "dotnet-project",
    "Provider",
    "src/Provider/Provider.csproj",
  );
  return referenceFacts(
    internal
      ? [consumer, provider, ...additionalProviders]
      : [consumer, ...additionalProviders],
    [],
    [
      Object.freeze({
        id: internal ? "raw-project-internal" : "raw-project-unresolved",
        repositoryId: "raw-repository",
        sourceId: consumer.id,
        ...(internal
          ? { targetId: provider.id }
          : { externalTarget: "Provider.csproj" }),
        resolution: internal ? "internal" : "unresolved",
        kind: "project-reference",
        weight: 1,
      }),
    ],
  );
}

function typescriptReferenceFacts(internal: boolean): LocalAnalysisFacts {
  const packageModule = moduleFact(
    "raw-npm-package",
    "npm-package",
    "Application",
    "package.json",
    "@example/application",
  );
  const source = sourceFact(
    "raw-main-source",
    packageModule.id,
    "src/main.ts",
    [Object.freeze({ specifier: "./lib/helper", count: 1 })],
  );
  const target = sourceFact(
    "raw-helper-source",
    packageModule.id,
    "src/lib/helper.ts",
    [],
  );
  return referenceFacts(
    [packageModule],
    internal ? [source, target] : [source],
    [
      Object.freeze({
        id: internal ? "raw-import-internal" : "raw-import-unresolved",
        repositoryId: "raw-repository",
        sourceId: source.id,
        ...(internal
          ? { targetId: target.id }
          : { externalTarget: "lib/helper" }),
        resolution: internal ? "internal" : "unresolved",
        kind: "typescript-import",
        weight: 1,
      }),
    ],
  );
}

function typescriptAliasReferenceFacts(
  internal: boolean,
): LocalAnalysisFacts {
  const packageModule = moduleFact(
    "raw-alias-package",
    "npm-package",
    "Aliased application",
    "package.json",
    "@example/application",
  );
  const source = sourceFact(
    "raw-alias-source",
    packageModule.id,
    "src/main.ts",
    [Object.freeze({ specifier: "app/helper", count: 2 })],
  );
  const target = sourceFact(
    "raw-alias-target",
    packageModule.id,
    "src/lib/helper.ts",
    [],
  );
  return referenceFacts(
    [packageModule],
    internal ? [source, target] : [source],
    [
      Object.freeze({
        id: internal
          ? "raw-alias-internal"
          : "raw-alias-external",
        repositoryId: "raw-repository",
        sourceId: source.id,
        ...(internal
          ? { targetId: target.id }
          : { externalTarget: "app" }),
        resolution: internal ? "internal" : "external",
        kind: "typescript-import",
        weight: 2,
      }),
    ],
  );
}

function twoFrameEvolution(
  before: LocalAnalysisFacts,
  after: LocalAnalysisFacts,
) {
  return evolve(
    [COMMITS.b, COMMITS.a],
    [
      { commit: COMMITS.a, facts: before },
      { commit: COMMITS.b, facts: after },
    ],
    new Map([[B, []]]),
  );
}

function expectSingleRelationshipTransition(
  before: LocalAnalysisFacts,
  after: LocalAnalysisFacts,
): void {
  const result = twoFrameEvolution(before, after);
  const frames = [...replayEvolutionBundle(result.bundle)];
  const delta = result.bundle.deltas[0]!.changes.dependencies;

  expect(frames[0]!.model.dependencies).toHaveLength(1);
  expect(frames[1]!.model.dependencies).toHaveLength(1);
  expect(frames[0]!.model.dependencies[0]!.id).toBe(
    frames[1]!.model.dependencies[0]!.id,
  );
  expect(delta.added).toEqual([]);
  expect(delta.removed).toEqual([]);
  expect(delta.changed).toEqual([
    expect.objectContaining({
      id: frames[0]!.model.dependencies[0]!.id,
      changeKinds: ["relationships"],
    }),
  ]);
}

function reversedDependencies(
  facts: LocalAnalysisFacts,
): LocalAnalysisFacts {
  return Object.freeze({
    ...facts,
    dependencies: Object.freeze([...facts.dependencies].reverse()),
  });
}

function evolve(
  newestFirst: readonly (typeof COMMITS)[keyof typeof COMMITS][],
  frames: readonly HistoryEvolutionFrameInput[],
  boundaryChangesByCommit: ReadonlyMap<
    string,
    readonly (
      | {
          readonly kind:
            | "added"
            | "deleted"
            | "modified"
            | "type-changed";
          readonly path: string;
        }
      | {
          readonly kind: "renamed";
          readonly previousPath: string;
          readonly path: string;
        }
    )[]
  >,
) {
  return createHistoryEvolution({
    repositoryIdentity: "https://example.invalid/org/lineages.git",
    selection: selectHistory(newestFirst, {
      mode: "commit-count",
      commitCount: newestFirst.length,
    }),
    boundaryChangesByCommit,
    frames,
    analyzerFingerprint: "lineage-semantics-v1",
    historyBackend: {
      name: "git",
      version: "2.45.0",
      renamePolicyRevision:
        GENERIC_GIT_HISTORY_RENAME_POLICY_REVISION,
    },
    metricConfiguration: { geometry: "default-v1" },
  });
}

describe("history evolution lineage semantics", () => {
  it.each([
    ["external to internal", false, true],
    ["internal to external", true, false],
  ] as const)(
    "keeps a package-reference lineage from %s resolution",
    (_label, beforeInternal, afterInternal) => {
      expectSingleRelationshipTransition(
        packageReferenceFacts(beforeInternal),
        packageReferenceFacts(afterInternal),
      );
    },
  );

  it.each([
    ["unresolved to internal", false, true],
    ["internal to unresolved", true, false],
  ] as const)(
    "keeps a project-reference lineage from %s resolution",
    (_label, beforeInternal, afterInternal) => {
      expectSingleRelationshipTransition(
        projectReferenceFacts(beforeInternal),
        projectReferenceFacts(afterInternal),
      );
    },
  );

  it.each([
    ["unresolved to internal", false, true],
    ["internal to unresolved", true, false],
  ] as const)(
    "keeps a relative TypeScript-import lineage from %s resolution",
    (_label, beforeInternal, afterInternal) => {
      expectSingleRelationshipTransition(
        typescriptReferenceFacts(beforeInternal),
        typescriptReferenceFacts(afterInternal),
      );
    },
  );

  it.each([
    ["external to internal", false, true],
    ["internal to external", true, false],
  ] as const)(
    "keeps a TypeScript path-alias lineage from %s resolution",
    (_label, beforeInternal, afterInternal) => {
      expectSingleRelationshipTransition(
        typescriptAliasReferenceFacts(beforeInternal),
        typescriptAliasReferenceFacts(afterInternal),
      );
    },
  );

  it("treats dependency version, resolution, and weight updates as one replacement", () => {
    const before = dependencyFacts([
      {
        id: "raw-dependency-version-1",
        version: "1.0.0",
      },
    ]);
    const after = dependencyFacts([
      {
        id: "raw-dependency-version-2",
        version: "2.0.0",
        resolution: "unresolved",
        weight: 3,
      },
    ]);
    const result = evolve(
      [COMMITS.b, COMMITS.a],
      [
        { commit: COMMITS.a, facts: before },
        { commit: COMMITS.b, facts: after },
      ],
      new Map([[B, []]]),
    );
    const frames = [...replayEvolutionBundle(result.bundle)];
    const delta = result.bundle.deltas[0]!.changes.dependencies;

    expect(frames[0]!.model.dependencies[0]!.id).toBe(
      frames[1]!.model.dependencies[0]!.id,
    );
    expect(delta.added).toEqual([]);
    expect(delta.removed).toEqual([]);
    expect(delta.changed).toHaveLength(1);
    expect(delta.changed[0]).toMatchObject({
      id: frames[0]!.model.dependencies[0]!.id,
      changeKinds: ["relationships", "metadata"],
      entity: {
        version: "2.0.0",
        resolution: "unresolved",
        weight: 3,
      },
    });
  });

  it("matches duplicate dependency edges deterministically", () => {
    const before = dependencyFacts([
      {
        id: "raw-dependency-version-1",
        version: "1.0.0",
      },
      {
        id: "raw-dependency-version-2",
        version: "2.0.0",
      },
    ]);
    const after = dependencyFacts([
      {
        id: "raw-dependency-version-3",
        version: "3.0.0",
      },
      {
        id: "raw-dependency-version-2",
        version: "2.0.0",
      },
    ]);
    const result = evolve(
      [COMMITS.b, COMMITS.a],
      [
        { commit: COMMITS.a, facts: before },
        { commit: COMMITS.b, facts: after },
      ],
      new Map([[B, []]]),
    );
    const reordered = evolve(
      [COMMITS.b, COMMITS.a],
      [
        {
          commit: COMMITS.a,
          facts: reversedDependencies(before),
        },
        {
          commit: COMMITS.b,
          facts: reversedDependencies(after),
        },
      ],
      new Map([[B, []]]),
    );
    const frames = [...replayEvolutionBundle(result.bundle)];
    const firstByVersion = new Map(
      frames[0]!.model.dependencies.map((dependency) => [
        dependency.version,
        dependency.id,
      ]),
    );
    const secondByVersion = new Map(
      frames[1]!.model.dependencies.map((dependency) => [
        dependency.version,
        dependency.id,
      ]),
    );

    expect(new Set(firstByVersion.values()).size).toBe(2);
    expect(secondByVersion.get("2.0.0")).toBe(
      firstByVersion.get("2.0.0"),
    );
    expect(secondByVersion.get("3.0.0")).toBe(
      firstByVersion.get("1.0.0"),
    );
    expect(result.bundle.deltas[0]!.changes.dependencies).toMatchObject({
      added: [],
      removed: [],
    });
    expect(
      result.bundle.deltas[0]!.changes.dependencies.changed,
    ).toHaveLength(1);
    expect(Buffer.from(serializeEvolutionBundle(reordered.bundle))).toEqual(
      Buffer.from(serializeEvolutionBundle(result.bundle)),
    );
  });

  it("matches duplicate logical package references deterministically across resolution", () => {
    const before = packageReferenceFacts(false, [
      { id: "raw-before-a", version: "1.0.0" },
      { id: "raw-before-z", version: "2.0.0" },
    ]);
    const after = packageReferenceFacts(true, [
      { id: "raw-after-a", version: "3.0.0" },
      { id: "raw-after-z", version: "2.0.0" },
    ]);
    const result = twoFrameEvolution(before, after);
    const reordered = twoFrameEvolution(
      reversedDependencies(before),
      reversedDependencies(after),
    );
    const frames = [...replayEvolutionBundle(result.bundle)];
    const firstByVersion = new Map(
      frames[0]!.model.dependencies.map((dependency) => [
        dependency.version,
        dependency.id,
      ]),
    );
    const secondByVersion = new Map(
      frames[1]!.model.dependencies.map((dependency) => [
        dependency.version,
        dependency.id,
      ]),
    );

    expect(new Set(firstByVersion.values()).size).toBe(2);
    expect(new Set(secondByVersion.values()).size).toBe(2);
    expect(secondByVersion.get("2.0.0")).toBe(
      firstByVersion.get("2.0.0"),
    );
    expect(result.bundle.deltas[0]!.changes.dependencies).toMatchObject({
      added: [],
      removed: [],
    });
    expect(Buffer.from(serializeEvolutionBundle(reordered.bundle))).toEqual(
      Buffer.from(serializeEvolutionBundle(result.bundle)),
    );
  });

  it("keeps distinct logical references separate across simultaneous resolution", () => {
    const before = distinctPackageReferenceFacts(false);
    const after = distinctPackageReferenceFacts(true);
    const result = twoFrameEvolution(before, after);
    const reordered = twoFrameEvolution(
      distinctPackageReferenceFacts(false, true),
      distinctPackageReferenceFacts(true, true),
    );
    const frames = [...replayEvolutionBundle(result.bundle)];
    const beforeByReference = new Map(
      frames[0]!.model.dependencies.map((dependency) => [
        dependency.externalTarget,
        dependency.id,
      ]),
    );
    const modulesById = new Map(
      frames[1]!.model.modules.map((module) => [module.id, module]),
    );
    const afterByReference = new Map(
      frames[1]!.model.dependencies.map((dependency) => [
        modulesById.get(dependency.targetId!)?.packageId,
        dependency.id,
      ]),
    );

    expect(new Set(beforeByReference.values()).size).toBe(2);
    expect(new Set(afterByReference.values()).size).toBe(2);
    expect(afterByReference.get("Example.Alpha")).toBe(
      beforeByReference.get("Example.Alpha"),
    );
    expect(afterByReference.get("Example.Beta")).toBe(
      beforeByReference.get("Example.Beta"),
    );
    expect(result.bundle.deltas[0]!.changes.dependencies).toMatchObject({
      added: [],
      removed: [],
    });
    expect(Buffer.from(serializeEvolutionBundle(reordered.bundle))).toEqual(
      Buffer.from(serializeEvolutionBundle(result.bundle)),
    );
  });

  it("does not join an ambiguous project leaf name to either internal target", () => {
    const collidingProvider = moduleFact(
      "raw-colliding-provider",
      "dotnet-project",
      "Other provider",
      "vendor/Provider.csproj",
    );
    const before = projectReferenceFacts(false);
    const after = projectReferenceFacts(true, [collidingProvider]);
    const result = twoFrameEvolution(before, after);
    const frames = [...replayEvolutionBundle(result.bundle)];
    const delta = result.bundle.deltas[0]!.changes.dependencies;

    expect(frames[0]!.model.dependencies[0]!.id).not.toBe(
      frames[1]!.model.dependencies[0]!.id,
    );
    expect(delta.removed).toEqual([
      frames[0]!.model.dependencies[0]!.id,
    ]);
    expect(delta.added).toEqual([
      expect.objectContaining({
        id: frames[1]!.model.dependencies[0]!.id,
      }),
    ]);
    expect(delta.changed).toEqual([]);
  });

  it("does not join a project leaf when a same-named non-target is replaced", () => {
    const nonTarget = moduleFact(
      "raw-non-target-provider",
      "dotnet-project",
      "Unrelated provider",
      "vendor/Provider.csproj",
    );
    const before = projectReferenceFacts(false, [nonTarget]);
    const after = projectReferenceFacts(true);
    const result = twoFrameEvolution(before, after);
    const frames = [...replayEvolutionBundle(result.bundle)];
    const delta = result.bundle.deltas[0]!.changes.dependencies;

    expect(frames[0]!.model.dependencies[0]!.id).not.toBe(
      frames[1]!.model.dependencies[0]!.id,
    );
    expect(delta.removed).toEqual([
      frames[0]!.model.dependencies[0]!.id,
    ]);
    expect(delta.added).toEqual([
      expect.objectContaining({
        id: frames[1]!.model.dependencies[0]!.id,
      }),
    ]);
    expect(delta.changed).toEqual([]);
  });

  it("does not resurrect a dependency lineage after delete and re-add", () => {
    const present = dependencyFacts([
      {
        id: "raw-dependency",
        version: "1.0.0",
      },
    ]);
    const absent = dependencyFacts([]);
    const result = evolve(
      [COMMITS.c, COMMITS.b, COMMITS.a],
      [
        { commit: COMMITS.a, facts: present },
        { commit: COMMITS.b, facts: absent },
        { commit: COMMITS.c, facts: present },
      ],
      new Map([
        [B, []],
        [C, []],
      ]),
    );
    const frames = [...replayEvolutionBundle(result.bundle)];

    expect(frames[0]!.model.dependencies[0]!.id).not.toBe(
      frames[2]!.model.dependencies[0]!.id,
    );
    expect(result.bundle.deltas[0]!.changes.dependencies.removed).toEqual([
      frames[0]!.model.dependencies[0]!.id,
    ]);
    expect(result.bundle.deltas[1]!.changes.dependencies.added[0]!.id).toBe(
      frames[2]!.model.dependencies[0]!.id,
    );
  });

  it("does not resurrect a retired external lineage as an internal reference", () => {
    const external = packageReferenceFacts(false);
    const internal = packageReferenceFacts(true);
    const absent = referenceFacts(
      external.modules,
      external.sources,
      [],
    );
    const result = evolve(
      [COMMITS.c, COMMITS.b, COMMITS.a],
      [
        { commit: COMMITS.a, facts: external },
        { commit: COMMITS.b, facts: absent },
        { commit: COMMITS.c, facts: internal },
      ],
      new Map([
        [B, []],
        [C, []],
      ]),
    );
    const frames = [...replayEvolutionBundle(result.bundle)];

    expect(frames[0]!.model.dependencies[0]!.id).not.toBe(
      frames[2]!.model.dependencies[0]!.id,
    );
    expect(result.bundle.deltas[0]!.changes.dependencies.removed).toEqual([
      frames[0]!.model.dependencies[0]!.id,
    ]);
    expect(result.bundle.deltas[1]!.changes.dependencies.added).toEqual([
      expect.objectContaining({
        id: frames[2]!.model.dependencies[0]!.id,
      }),
    ]);
  });

  it("keeps an empty Angular module across an available path-token rename", () => {
    const before = emptyAngularFacts(
      "raw-angular-before",
      "config/old-angular.json",
    );
    const after = emptyAngularFacts(
      "raw-angular-after",
      "config/new-angular.json",
    );
    const result = evolve(
      [COMMITS.b, COMMITS.a],
      [
        { commit: COMMITS.a, facts: before },
        { commit: COMMITS.b, facts: after },
      ],
      new Map([
        [
          B,
          [
            {
              kind: "renamed" as const,
              previousPath: "config/old-angular.json",
              path: "config/new-angular.json",
            },
          ],
        ],
      ]),
    );
    const frames = [...replayEvolutionBundle(result.bundle)];

    expect(frames[0]!.model.modules[0]!.id).toBe(
      frames[1]!.model.modules[0]!.id,
    );
    expect(result.bundle.deltas[0]!.changes.modules).toMatchObject({
      added: [],
      removed: [],
      changed: [
        {
          id: frames[0]!.model.modules[0]!.id,
          changeKinds: ["moved"],
        },
      ],
    });
  });
});
