import { expect, test, type Page } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

import {
  GENERIC_GIT_PRESECURED_CANONICAL_ANCESTRY,
  GENERIC_GIT_PRESECURED_WINDOWS_ACL,
  HISTORY_SELECTION_LIMITS,
  type GenericGitAnalysisResult,
  type GenericGitHistoryAnalysisResult,
  type LocalAnalysisOptions,
  type PublicGitHubAnalysisResult,
} from "../../packages/analyzer/src/index.js";
import type {
  CityBuilding,
  CityDependency,
  CityDistrict,
  CityModel,
  CityModule,
  CitySolution,
} from "../../packages/core/src/model.js";
import {
  deriveEvolutionChangeKinds,
  prepareEvolutionSerialization,
  replayValidatedEvolutionBundle,
  serializeEvolutionBundle,
  type EvolutionBundle,
  type EvolutionChanges,
} from "../../packages/core/src/index.js";
import type {
  RemoteImportDependencies,
} from "../../apps/server/src/remote-import.js";
import {
  startCodeCityServer,
  type CodeCityServerHandle,
} from "../../apps/server/src/server.js";

let server: CodeCityServerHandle;
let testRoot: string;
let dataDirectory: string;
let accessToken: string;
let directoryFixture: string;
let zipFixture: string;
let sourceNavigationZipFixture: string;
let unavailableDetailFixture: string;
let availableDetailFixture: string;
let cappedDetailFixture: string;
let cityModelFixture: CityModel;

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const HISTORY_LATEST_COMMIT =
  "1123456789abcdef0123456789abcdef01234567";
const PUBLIC_GITHUB_URL = "https://github.com/code-city-e2e/public";
const PRIVATE_GITHUB_URL = "https://github.com/code-city-e2e/private";
const AZURE_DEVOPS_URL =
  "https://dev.azure.com/CodeCityE2E/Project/_git/Repository";
const GENERIC_GIT_URL =
  "https://git.example.test/group/repository.git";
const CANCELLATION_GIT_URL =
  "https://git.example.test/group/cancel.git";
const HISTORY_COMMIT_COUNT = 37;
const HISTORY_SAMPLE_EVERY = 4;
const HISTORY_TIMEOUT_MS = 23_000;
const HISTORY_TITLE = "History import E2E";
const HISTORY_VERSION = "history-v1";
const LINEAGE_JOB_ID = "25800000-0000-4000-8000-000000000258";
const LINEAGE_TITLE = "Lineage time travel E2E";
const LINEAGE_COMMITS = Object.freeze([
  "a".repeat(40),
  "b".repeat(40),
  "c".repeat(40),
  "d".repeat(40),
]);

interface RemoteInvocation {
  readonly kind: "github" | "git";
  readonly repositoryUrl: string;
  readonly ref?: string;
  readonly credentialProvider?: "basic" | "github";
  readonly title?: string;
  readonly version?: string;
  readonly maxRetainedFiles?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly timeoutMs?: number;
}

const remoteInvocations: RemoteInvocation[] = [];

type HistoryAnalyzer = NonNullable<
  RemoteImportDependencies["analyzeGenericGitHistory"]
>;

interface HistoryInvocation {
  readonly request: Parameters<HistoryAnalyzer>[0];
  readonly options: Parameters<HistoryAnalyzer>[1];
  readonly dependencies: Parameters<HistoryAnalyzer>[2];
}

const historyInvocations: HistoryInvocation[] = [];
let historyResultFixture: GenericGitHistoryAnalysisResult;
let canonicalEvolutionFixture: Uint8Array;
let lineageEvolutionFixture: LineageEvolutionFixture;

interface LineageEvolutionFixture {
  readonly jobId: string;
  readonly model: CityModel;
  readonly bundle: EvolutionBundle;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly futureBuilding: CityBuilding;
  readonly removedBuilding: CityBuilding;
}

async function privateFile(
  file: string,
  contents: string,
): Promise<void> {
  await fs.writeFile(file, contents, { mode: 0o600 });
  if (process.platform !== "win32") await fs.chmod(file, 0o600);
}

function modelForOptions(options?: LocalAnalysisOptions): CityModel {
  const title = options?.title;
  const version = options?.version;
  if (title === undefined) return cityModelFixture;
  return {
    ...cityModelFixture,
    identity: {
      title,
      ...(version === undefined ? {} : { version }),
    },
  };
}

function createHistoryAnalysisResult(
  model: CityModel,
): GenericGitHistoryAnalysisResult {
  const repositoryId = model.repositories[0]?.id;
  if (repositoryId === undefined) {
    throw new Error("The history E2E fixture requires a repository.");
  }
  const fingerprint = `sha256:${"1".repeat(64)}` as const;
  const historyBackend = {
    name: "git" as const,
    version: "2.47.1.windows.2",
    renamePolicyRevision: "diff-tree-renames-50-myers-v1" as const,
  };
  const addedDependency = model.dependencies.find(
    ({ id }) => id === "dependency:validation-model",
  );
  if (addedDependency === undefined) {
    throw new Error("The history E2E fixture requires a route addition.");
  }
  const baselineModel: CityModel = {
    ...model,
    dependencies: model.dependencies.filter(
      ({ id }) => id !== addedDependency.id,
    ),
  };
  const bundle: EvolutionBundle = {
    schemaVersion: "1.0",
    generator: model.generator,
    authorPolicy: "omit-v1",
    selection: {
      mode: "commit-count",
      traversal: "first-parent",
      order: "oldest-first",
      sampleEvery: HISTORY_SAMPLE_EVERY,
      requestedCommitCount: HISTORY_COMMIT_COUNT,
      selectedCommitCount: 2,
      sampledCommitCount: 2,
      traversedCommitCount: 2,
      resolvedOldestSha: COMMIT,
      resolvedNewestSha: HISTORY_LATEST_COMMIT,
      sampledCommitShas: [COMMIT, HISTORY_LATEST_COMMIT],
    },
    provenance: {
      repositoryId,
      repositoryFingerprint: fingerprint,
      analyzer: {
        name: "code-city",
        version: model.generator.version,
        fingerprint,
      },
      historyBackend,
      metricConfigurationFingerprint: fingerprint,
      selectionFingerprint: fingerprint,
    },
    baseline: {
      commit: {
        index: 0,
        sha: COMMIT,
        committedAt: "2026-01-01T00:00:00.000Z",
        parentShas: [],
        analyzerVersion: model.generator.version,
        analysisFingerprint: fingerprint,
      },
      model: baselineModel,
    },
    deltas: [
      {
        commit: {
          index: 1,
          sha: HISTORY_LATEST_COMMIT,
          committedAt: "2026-01-02T00:00:00.000Z",
          parentShas: [COMMIT],
          analyzerVersion: model.generator.version,
          analysisFingerprint: `sha256:${"2".repeat(64)}`,
        },
        changes: {
          model: {},
          repositories: { added: [], removed: [], changed: [] },
          solutions: { added: [], removed: [], changed: [] },
          modules: { added: [], removed: [], changed: [] },
          semanticGroups: { added: [], removed: [], changed: [] },
          districts: { added: [], removed: [], changed: [] },
          buildings: { added: [], removed: [], changed: [] },
          dependencies: {
            added: [addedDependency],
            removed: [],
            changed: [],
          },
        },
      },
    ],
  };
  const preparedSerialization =
    prepareEvolutionSerialization(bundle);
  const baselineCommit = {
    sha: COMMIT,
    parents: [] as const,
    committedAt: "2026-01-01T00:00:00.000Z",
  };
  const latestCommit = {
    sha: HISTORY_LATEST_COMMIT,
    parents: [COMMIT] as const,
    committedAt: "2026-01-02T00:00:00.000Z",
  };
  const analysisBounds = {
    totalDeadlineMs: HISTORY_TIMEOUT_MS,
    maxAggregateChangedPaths: 500_000,
    maxAggregateChangedPathBytes: 16 * 1024 * 1024,
    maxAggregateSemanticBytes: 128 * 1024 * 1024,
    maxUniqueLineages: 100_000,
    maxEvolutionOutputBytes:
      HISTORY_SELECTION_LIMITS.maxEvolutionOutputBytes,
    maxAggregateTreeEntries: 2_000_000,
  };
  return {
    repository: "public",
    tipSha: HISTORY_LATEST_COMMIT,
    transport: "https",
    historyBackend,
    selection: {
      selectedCommits: [baselineCommit, latestCommit],
      sampledCommits: [baselineCommit, latestCommit],
      summary: preparedSerialization.bundle.selection,
      analysisBounds,
      requestedTagCount: 0,
    },
    model,
    evolution: {
      repositoryId,
      model,
      bundle: preparedSerialization.bundle,
      preparedSerialization,
    },
    costEstimate: {
      traversedCommitCount: 2,
      selectedCommitCount: 2,
      sampledFrameCount: 2,
      maximumChangedPathEntries:
        analysisBounds.maxAggregateChangedPaths,
      maximumChangedPathBytes:
        analysisBounds.maxAggregateChangedPathBytes,
      maximumSemanticBytes:
        analysisBounds.maxAggregateSemanticBytes,
      maximumTreeEntries: analysisBounds.maxAggregateTreeEntries,
      maximumUniqueLineages: analysisBounds.maxUniqueLineages,
      maximumOutputBytes: analysisBounds.maxEvolutionOutputBytes,
      totalDeadlineMs: analysisBounds.totalDeadlineMs,
    },
    cacheHits: 0,
    cacheMisses: 2,
  };
}

function emptyLineageChanges(): EvolutionChanges {
  const empty = () => ({ added: [], removed: [], changed: [] });
  return {
    model: {},
    repositories: empty(),
    solutions: empty(),
    modules: empty(),
    semanticGroups: empty(),
    districts: empty(),
    buildings: empty(),
    dependencies: empty(),
  };
}

function createLineageEvolutionFixture(
  demo: CityModel,
): LineageEvolutionFixture {
  const replacedBuilding = demo.buildings.find(
    ({ id }) => id === "building:demo-model",
  );
  if (replacedBuilding === undefined) {
    throw new Error("The lineage E2E fixture requires demo-model.ts.");
  }
  const removedBuilding: CityBuilding = {
    ...replacedBuilding,
    id: "building:1111111111111111",
    name: "removed-lineage.ts",
    path: "apps/viewer/src/removed-lineage.ts",
    sourceLocation: { startLine: 1, endLine: 2 },
  };
  const futureBuilding: CityBuilding = {
    ...replacedBuilding,
    id: "building:2222222222222222",
    name: "future-lineage.ts",
    path: "apps/viewer/src/future-lineage.ts",
    sourceLocation: { startLine: 1, endLine: 2 },
  };
  const persistentBuildingDependencies: CityDependency[] =
    Array.from({ length: 10 }, (_, index) => ({
      id: `dependency:lineage-building:${index.toString().padStart(2, "0")}`,
      repositoryId: replacedBuilding.repositoryId,
      sourceId: "building:main",
      targetId: "building:model",
      resolution: "internal",
      kind: "typescript-import",
      weight: index + 1,
    }));
  const persistentExternalDependencies: CityDependency[] =
    Array.from({ length: 20 }, (_, index) => ({
      id: `dependency:lineage-package:${index.toString().padStart(2, "0")}`,
      repositoryId: replacedBuilding.repositoryId,
      sourceId: "module:viewer",
      externalTarget: `lineage-package-${index.toString().padStart(2, "0")}`,
      resolution: "external",
      kind: "package-reference",
      version: "1.0.0",
      weight: index + 1,
    }));
  const persistentIncomingDependency: CityDependency = {
    id: "dependency:lineage-incoming",
    repositoryId: replacedBuilding.repositoryId,
    sourceId: "building:validation",
    targetId: "building:main",
    resolution: "internal",
    kind: "typescript-import",
    weight: 1,
  };
  const baselineModel: CityModel = {
    ...demo,
    identity: {
      title: LINEAGE_TITLE,
      version: "lineage-v1",
    },
    sourceProvenance: {
      version: "codecity.source-navigation/1",
      repositories: [
        {
          repositoryId: removedBuilding.repositoryId,
          provider: "github",
          revision: {
            kind: "commit",
            value: LINEAGE_COMMITS[3]!,
          },
          repositoryUrl: "https://github.com/example/repository",
        },
      ],
    },
    buildings: demo.buildings.map((building) =>
      building.id === replacedBuilding.id
        ? removedBuilding
        : building,
    ),
    dependencies: [
      ...demo.dependencies,
      ...persistentBuildingDependencies,
      ...persistentExternalDependencies,
      persistentIncomingDependency,
    ],
  };
  const template =
    createHistoryAnalysisResult(baselineModel).evolution.bundle;
  const commit = (index: number) => ({
    index,
    sha: LINEAGE_COMMITS[index]!,
    committedAt: new Date(
      Date.UTC(2026, 0, index + 1),
    ).toISOString(),
    parentShas:
      index === 0 ? [] : [LINEAGE_COMMITS[index - 1]!],
    analyzerVersion: baselineModel.generator.version,
    analysisFingerprint:
      `sha256:${String(index + 1).repeat(64)}` as const,
  });
  const dependency = (id: string): CityDependency => {
    const value = baselineModel.dependencies.find(
      (candidate) => candidate.id === id,
    );
    if (value === undefined) {
      throw new Error(`Missing lineage dependency '${id}'.`);
    }
    return value;
  };
  const replacement = (
    before: CityDependency,
    entity: CityDependency,
  ) => ({
    id: before.id,
    changeKinds: deriveEvolutionChangeKinds(
      "dependencies",
      before,
      entity,
    ),
    entity,
  });
  const projectBefore = dependency(
    "dependency:viewer-core-project",
  );
  const projectAfter: CityDependency = {
    ...projectBefore,
    weight: 30,
  };
  const frameOneChanges: EvolutionChanges = {
    ...emptyLineageChanges(),
    dependencies: {
      added: [],
      removed: [],
      changed: [replacement(projectBefore, projectAfter)],
    },
  };
  const removedDependency = dependency(
    "dependency:core-typescript-package",
  );
  const changedBefore = dependency("dependency:main-model");
  const changedAfter: CityDependency = {
    ...changedBefore,
    weight: 4,
  };
  const retargetedBefore = dependency(
    "dependency:validation-model",
  );
  const retargetedAfter: CityDependency = {
    ...retargetedBefore,
    targetId: "building:schema",
  };
  const addedDependency: CityDependency = {
    id: "dependency:lineage-added",
    repositoryId: replacedBuilding.repositoryId,
    sourceId: "module:viewer",
    externalTarget: "lineage-added-package",
    resolution: "external",
    kind: "package-reference",
    version: "2.0.0",
    weight: 40,
  };
  const coreDistrictBefore = baselineModel.districts.find(
    ({ id }) => id === "district:core",
  );
  if (coreDistrictBefore === undefined) {
    throw new Error("The lineage E2E fixture requires the core district.");
  }
  const coreDistrictAfter: CityDistrict = {
    ...coreDistrictBefore,
    size: { ...coreDistrictBefore.size, x: 10 },
  };
  const topologyModuleId = "module:lineage-added";
  const topologySolutionId = "solution:lineage-added";
  const topologySolution: CitySolution = {
    id: topologySolutionId,
    repositoryId: replacedBuilding.repositoryId,
    name: "Lineage added solution",
    path: "lineage-added",
    moduleIds: [topologyModuleId],
  };
  const topologyModule: CityModule = {
    id: topologyModuleId,
    repositoryId: replacedBuilding.repositoryId,
    kind: "npm-package",
    name: "Lineage added module",
    path: "packages/lineage-added",
    solutionIds: [topologySolutionId],
    packageId: "@code-city/lineage-added",
  };
  const turnoverChanges: EvolutionChanges = {
    ...emptyLineageChanges(),
    solutions: {
      added: [topologySolution],
      removed: [],
      changed: [],
    },
    modules: {
      added: [topologyModule],
      removed: [],
      changed: [],
    },
    districts: {
      added: [],
      removed: [],
      changed: [
        {
          id: coreDistrictBefore.id,
          changeKinds: deriveEvolutionChangeKinds(
            "districts",
            coreDistrictBefore,
            coreDistrictAfter,
          ),
          entity: coreDistrictAfter,
        },
      ],
    },
    dependencies: {
      added: [addedDependency],
      removed: [removedDependency.id],
      changed: [
        replacement(changedBefore, changedAfter),
        replacement(retargetedBefore, retargetedAfter),
      ],
    },
  };
  const frameThreeChanges = emptyLineageChanges();
  const bundle: EvolutionBundle = {
    ...template,
    selection: {
      mode: "commit-count",
      traversal: "first-parent",
      order: "oldest-first",
      sampleEvery: 1,
      requestedCommitCount: LINEAGE_COMMITS.length,
      selectedCommitCount: LINEAGE_COMMITS.length,
      sampledCommitCount: LINEAGE_COMMITS.length,
      traversedCommitCount: LINEAGE_COMMITS.length,
      resolvedOldestSha: LINEAGE_COMMITS[0]!,
      resolvedNewestSha: LINEAGE_COMMITS[3]!,
      sampledCommitShas: LINEAGE_COMMITS,
    },
    baseline: {
      commit: commit(0),
      model: baselineModel,
    },
    deltas: [
      {
        commit: commit(1),
        changes: frameOneChanges,
      },
      {
        commit: commit(2),
        changes: {
          ...turnoverChanges,
          buildings: {
            added: [futureBuilding],
            removed: [removedBuilding.id],
            changed: [],
          },
        },
      },
      {
        commit: commit(3),
        changes: frameThreeChanges,
      },
    ],
  };
  const prepared = prepareEvolutionSerialization(bundle);
  const frames = [
    ...replayValidatedEvolutionBundle(prepared.bundle),
  ];
  const model = frames.at(-1)?.model;
  if (model === undefined) {
    throw new Error("The lineage E2E fixture did not replay.");
  }
  const bytes = serializeEvolutionBundle(prepared.bundle);
  return {
    jobId: LINEAGE_JOB_ID,
    model,
    bundle: prepared.bundle,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    futureBuilding,
    removedBuilding,
  };
}

function invocationOptions(
  options?: LocalAnalysisOptions,
): Omit<RemoteInvocation, "kind" | "repositoryUrl" | "ref" | "credentialProvider"> {
  return {
    ...(options?.title === undefined ? {} : { title: options.title }),
    ...(options?.version === undefined
      ? {}
      : { version: options.version }),
    ...(options?.maxRetainedFiles === undefined
      ? {}
      : { maxRetainedFiles: options.maxRetainedFiles }),
    ...(options?.maxFileBytes === undefined
      ? {}
      : { maxFileBytes: options.maxFileBytes }),
    ...(options?.maxTotalBytes === undefined
      ? {}
      : { maxTotalBytes: options.maxTotalBytes }),
    ...(options?.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
  };
}

const githubAnalyzer: NonNullable<
  RemoteImportDependencies["analyzePublicGitHubRepository"]
> = async (
  request,
  options,
  dependencies,
): Promise<PublicGitHubAnalysisResult> => {
  const parsed = new URL(request.repositoryUrl);
  const [owner = "code-city-e2e", repository = "repository"] =
    parsed.pathname.split("/").filter(Boolean);
  remoteInvocations.push({
    kind: "github",
    repositoryUrl: request.repositoryUrl,
    ...(request.ref === undefined ? {} : { ref: request.ref }),
    ...(dependencies?.credentialProvider === undefined
      ? {}
      : {
          credentialProvider:
            dependencies.credentialProvider.provider,
        }),
    ...invocationOptions(options),
  });
  return {
    owner,
    repository,
    canonicalRepositoryUrl: request.repositoryUrl,
    commitSha: COMMIT,
    model: modelForOptions(options),
  };
};

const gitAnalyzer: NonNullable<
  RemoteImportDependencies["analyzeGenericGitRepository"]
> = async (
  request,
  options,
  dependencies,
): Promise<GenericGitAnalysisResult> => {
  remoteInvocations.push({
    kind: "git",
    repositoryUrl: request.repositoryUrl,
    ...(request.ref === undefined ? {} : { ref: request.ref }),
    ...(dependencies?.credentialProvider === undefined
      ? {}
      : {
          credentialProvider:
            dependencies.credentialProvider.provider,
        }),
    ...invocationOptions(options),
  });
  if (request.repositoryUrl === CANCELLATION_GIT_URL) {
    const signal = options?.signal;
    if (signal === undefined) {
      throw new Error("The cancellation import did not receive a signal.");
    }
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    signal.throwIfAborted();
  }
  return {
    repository: "repository",
    commitSha: COMMIT,
    transport: "https",
    model: modelForOptions(options),
  };
};

const historyAnalyzer: HistoryAnalyzer = async (
  request,
  options,
  dependencies,
): Promise<GenericGitHistoryAnalysisResult> => {
  historyInvocations.push({ request, options, dependencies });
  return historyResultFixture;
};

async function availableLoopbackPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (address === null || typeof address === "string") {
    throw new Error("Loopback port probe did not bind.");
  }
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  return address.port;
}

test.beforeAll(async () => {
  testRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "code-city-viewer-import-"),
  );
  dataDirectory = path.join(testRoot, "data");
  directoryFixture = path.join(testRoot, "directory-project");
  await fs.mkdir(path.join(directoryFixture, "src"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(directoryFixture, "package.json"),
    JSON.stringify({ name: "directory-project", version: "1.0.0" }),
    "utf8",
  );
  await fs.writeFile(
    path.join(directoryFixture, "src", "index.ts"),
    "export function directoryValue(input: boolean): number {\n  return input ? 1 : 0;\n}\n",
    "utf8",
  );
  zipFixture = path.join(testRoot, "archive-project.zip");
  await fs.writeFile(
    zipFixture,
    zipSync({
      "archive-project/package.json": strToU8(
        JSON.stringify({
          name: "archive-project",
          version: "1.0.0",
        }),
      ),
      "archive-project/src/index.ts": strToU8(
        "export const archiveValue = 42;\n",
      ),
    }),
  );
  const retainedSourceLines = Array.from(
    { length: 260 },
    (_, index) =>
      index === 4
        ? "// retained-source-sentinel"
        : `// retained filler line ${index + 1}`,
  );
  retainedSourceLines.push(
    "export function retainedComplexity(value: number): number {",
    "  let score = 0;",
    ...Array.from(
      { length: 14 },
      (_, index) =>
        `  if (value > ${index}) score += 1;`,
    ),
    "  return score;",
    "}",
    "export const sameLinePrefix = 1; export function sameLineExact(): number { return 7; } export const sameLineSuffix = 2;",
    "export class DetailClass {",
    ...Array.from(
      { length: 45 },
      (_, index) => `  method${index}(): number { return ${index}; }`,
    ),
    "}",
    "",
  );
  sourceNavigationZipFixture = path.join(
    testRoot,
    "source-navigation-project.zip",
  );
  await fs.writeFile(
    sourceNavigationZipFixture,
    zipSync({
      "source-navigation-project/package.json": strToU8(
        JSON.stringify({
          name: "source-navigation-project",
          version: "1.0.0",
        }),
      ),
      "source-navigation-project/src/retained-large.ts": strToU8(
        retainedSourceLines.join("\n"),
      ),
      "source-navigation-project/src/sibling.ts": strToU8(
        "export const siblingMustNotBeFetched = true;\n",
      ),
    }),
  );
  cityModelFixture = JSON.parse(
    await fs.readFile(
      path.resolve("examples/demo-city.json"),
      "utf8",
    ),
  ) as CityModel;
  unavailableDetailFixture = path.join(testRoot, "unavailable-detail.json");
  const firstBuilding = cityModelFixture.buildings[0]!;
  await fs.writeFile(
    unavailableDetailFixture,
    JSON.stringify({
      ...cityModelFixture,
      buildings: [{
        ...firstBuilding,
        sourceLocation: { startLine: 1, endLine: 1 },
        sourceStructure: {
          version: "codecity.source-structure/1",
          availability: "unavailable",
          types: [], callables: [], relations: [],
          unavailable: ["JavaScript declaration facts were not captured for this model."],
        },
      }, ...cityModelFixture.buildings.slice(1)],
    }),
    "utf8",
  );
  availableDetailFixture = path.join(testRoot, "available-detail.json");
  await fs.writeFile(
    availableDetailFixture,
    JSON.stringify({
      ...cityModelFixture,
      buildings: [{
        ...firstBuilding,
        sourceLocation: { startLine: 1, endLine: 10 },
        sourceStructure: {
          version: "codecity.source-structure/1",
          availability: "available",
          types: [{ id: "type:demo", name: "DemoType", kind: "class", provenance: "syntax", range: { startLine: 1, startColumn: 1, endLine: 10, endColumn: 1 } }],
          callables: [{ id: "callable:demo", name: "run", kind: "method", provenance: "syntax", enclosingTypeId: "type:demo", complexity: 1, range: { startLine: 2, startColumn: 3, endLine: 3, endColumn: 3 } }],
          relations: [], unavailable: ["Call targets are unavailable without semantic binding."],
        },
      }, ...cityModelFixture.buildings.slice(1)],
    }),
    "utf8",
  );
  cappedDetailFixture = path.join(testRoot, "capped-detail.json");
  await fs.writeFile(
    cappedDetailFixture,
    JSON.stringify({
      ...cityModelFixture,
      buildings: [{
        ...firstBuilding,
        sourceLocation: { startLine: 1, endLine: 1 },
        sourceStructure: {
          version: "codecity.source-structure/1",
          availability: "available",
          types: [],
          callables: Array.from({ length: 250 }, (_, index) => ({
            id: `callable:cap:${index.toString().padStart(3, "0")}`,
            name: `method${index.toString().padStart(3, "0")}`,
            kind: "method",
            provenance: "syntax",
            complexity: 1,
            range: {
              startLine: 1,
              startColumn: 1,
              endLine: 1,
              endColumn: 1,
            },
          })),
          relations: [],
          unavailable: [],
        },
      }, ...cityModelFixture.buildings.slice(1)],
    }),
    "utf8",
  );
  lineageEvolutionFixture =
    createLineageEvolutionFixture(cityModelFixture);
  historyResultFixture = createHistoryAnalysisResult(
    modelForOptions({
      title: HISTORY_TITLE,
      version: HISTORY_VERSION,
    }),
  );
  canonicalEvolutionFixture = serializeEvolutionBundle(
    historyResultFixture.evolution.bundle,
  );

  accessToken = randomBytes(32).toString("base64url");
  const tokenFile = path.join(testRoot, "access-token");
  await privateFile(tokenFile, `${accessToken}\n`);
  const credentialDirectory = path.join(testRoot, "credentials");
  await fs.mkdir(credentialDirectory, { mode: 0o700 });
  if (process.platform !== "win32") {
    await fs.chmod(credentialDirectory, 0o700);
  }
  await privateFile(
    path.join(credentialDirectory, "github.secret"),
    "e2e-github-placeholder-credential\n",
  );
  await privateFile(
    path.join(credentialDirectory, "git.secret"),
    "e2e-git-placeholder-credential\n",
  );
  const profilesFile = path.join(
    credentialDirectory,
    "profiles.json",
  );
  await privateFile(
    profilesFile,
    JSON.stringify({
      version: 1,
      profiles: [
        {
          id: "e2e-github",
          label: "E2E GitHub profile",
          provider: "github",
          repositories: [PRIVATE_GITHUB_URL],
          authentication: {
            kind: "bearer",
            secretFile: "github.secret",
          },
        },
        {
          id: "e2e-azure",
          label: "E2E Azure DevOps profile",
          provider: "azure-devops",
          repositories: [AZURE_DEVOPS_URL],
          authentication: {
            kind: "basic",
            username: "e2e-azure-user",
            secretFile: "git.secret",
          },
        },
        {
          id: "e2e-generic",
          label: "E2E Generic Git profile",
          provider: "generic-https",
          repositories: [GENERIC_GIT_URL, CANCELLATION_GIT_URL],
          authentication: {
            kind: "basic",
            username: "e2e-git-user",
            secretFile: "git.secret",
          },
        },
      ],
    }),
  );

  const port = await availableLoopbackPort();
  server = await startCodeCityServer({
    host: "127.0.0.1",
    port,
    dataDirectory,
    viewerRoot: path.resolve("build/viewer"),
    authorization: {
      tokenFile,
      publicOrigin: `http://127.0.0.1:${port}`,
      ...(process.platform === "win32"
        ? { trustWindowsTokenFile: true }
        : {}),
    },
    credentialProfiles: {
      profilesFile,
      ...(process.platform === "win32"
        ? { trustWindowsCredentialFiles: true }
        : {}),
    },
    allowedGitOrigins: [
      "https://dev.azure.com",
      "https://git.example.test",
    ],
    editorUrlTemplate:
      "https://editor.example.test/open?path={path}&line={line}",
    sourceRetention: "retain",
    trustWindowsGitWorkspace: true,
    importDependencies: {
      analyzePublicGitHubRepository: githubAnalyzer,
      analyzeGenericGitRepository: gitAnalyzer,
      analyzeGenericGitHistory: historyAnalyzer,
    },
  });
});

test.afterAll(async () => {
  await server.close();
  await fs.rm(testRoot, { recursive: true, force: true });
});

async function openAuthenticatedWizard(
  page: Page,
  performance = false,
): Promise<void> {
  await page.goto(
    performance ? `${server.url.href}?performance=1` : server.url.href,
    { waitUntil: "domcontentloaded" },
  );
  await page.getByRole("button", { name: "Import project" }).click();
  await page.locator("#project-import-token").fill(accessToken);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("#project-import-auth")).toBeHidden();
  await expect(page.locator("#project-import-source-title")).toBeVisible();
}

async function openNextImport(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Import project" }).click();
  const restartButton = page.getByRole("button", {
    name: "Start another import",
  });
  await expect(restartButton).toBeVisible();
  await restartButton.click();
  await expect(page.locator("#project-import-source-title")).toBeVisible();
}

async function chooseSource(
  page: Page,
  source:
    | "directory"
    | "zip"
    | "github-public"
    | "github-authenticated"
    | "azure-devops"
    | "git",
): Promise<void> {
  await page
    .locator(`input[name="project-import-source"][value="${source}"]`)
    .check();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator("#project-import-details-title")).toBeVisible();
}

async function continueToOptions(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator("#project-import-options-title")).toBeVisible();
}

async function continueToReview(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator("#project-import-progress-title")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start import" }),
  ).toBeVisible();
}

async function startAndWaitForImportedCity(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Start import" }).click();
  await expect(page.locator("#project-import-dialog")).toBeHidden({
    timeout: 30_000,
  });
  const jobId = await page.evaluate(() =>
    localStorage.getItem("code-city.last-import-job.v1"),
  );
  expect(jobId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  expect(server.jobs.get(jobId!)?.state).toBe("completed");
  return jobId!;
}

async function openLineageEvolutionFixture(
  page: Page,
  options: {
    readonly performanceDiagnostics?: boolean;
    readonly seekDelayMs?: number;
  } = {},
): Promise<LineageEvolutionFixture> {
  await openAuthenticatedWizard(page);
  await page
    .getByRole("button", { name: "Close project import" })
    .click();
  if (options.seekDelayMs !== undefined) {
    if (
      !Number.isSafeInteger(options.seekDelayMs) ||
      options.seekDelayMs < 1
    ) {
      throw new Error("The evolution seek delay must be positive.");
    }
    await page.addInitScript({
      content: `(() => {
        const nativePostMessage = Worker.prototype.postMessage;
        Worker.prototype.postMessage = function(message, transfer) {
          const send = () => transfer === undefined
            ? nativePostMessage.call(this, message)
            : nativePostMessage.call(this, message, transfer);
          if (message?.type === "seek") {
            setTimeout(send, ${options.seekDelayMs});
          } else {
            send();
          }
        };
      })();`,
    });
  }

  const fixture = lineageEvolutionFixture;
  const cityPath =
    `/api/v1/artifacts/${fixture.jobId}/city-model.json`;
  const evolutionPath =
    `/api/v1/artifacts/${fixture.jobId}/evolution.json`;
  const sourcePath =
    `/api/v1/artifacts/${fixture.jobId}/source`;
  const buildingsById = new Map(
    [fixture.futureBuilding, fixture.removedBuilding].map(
      (building) => [building.id, building] as const,
    ),
  );
  await page.route(`**${cityPath}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(fixture.model),
    });
  });
  await page.route(`**${evolutionPath}`, async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-length": String(fixture.bytes.byteLength),
        "content-type": "application/json; charset=utf-8",
      },
      body: Buffer.from(fixture.bytes),
    });
  });
  await page.route(
    `**/api/v1/artifacts/${fixture.jobId}/sources/*`,
    async (route) => {
      const buildingId = decodeURIComponent(
        new URL(route.request().url()).pathname.split("/").at(-1) ??
          "",
      );
      const building = buildingsById.get(buildingId);
      if (building === undefined) {
        await route.fulfill({
          status: 404,
          contentType: "application/json; charset=utf-8",
          body: JSON.stringify({
            error: {
              code: "source-not-found",
              message: "Source file not found.",
            },
          }),
        });
        return;
      }
      const future = building.id === fixture.futureBuilding.id;
      const identifier = future ? "futureLineage" : "removedLineage";
      const sentinel = future
        ? "future-lineage-source-sentinel"
        : "removed-lineage-source-sentinel";
      await route.fulfill({
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify({
          source: {
            buildingId: building.id,
            repositoryId: building.repositoryId,
            path: building.path,
            language: building.language,
            text:
              `export const ${identifier} = true;\n` +
              `// ${sentinel}`,
            location: building.sourceLocation,
            provenance:
              fixture.model.sourceProvenance!.repositories[0]!,
            externalUrl:
              `https://github.com/example/repository/blob/` +
              `${LINEAGE_COMMITS[3]}/${building.path}#L1`,
          },
        }),
      });
    },
  );
  await page.route(
    `**/api/v1/jobs/${fixture.jobId}`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify({
          job: {
            id: fixture.jobId,
            kind: "project-import",
            state: "completed",
            createdAt: "2026-01-04T00:00:00.000Z",
            updatedAt: "2026-01-04T00:00:00.000Z",
            result: {
              kind: "city-model",
              artifactToken: fixture.jobId,
              artifactUrl: cityPath,
              evolution: {
                artifactUrl: evolutionPath,
                size: fixture.bytes.byteLength,
                sha256: fixture.sha256,
              },
              source: {
                availability: "retained",
                artifactUrl: sourcePath,
                size: 1,
                sha256: "e".repeat(64),
                indexSha256: "f".repeat(64),
              },
            },
          },
        }),
      });
    },
  );
  await page.evaluate(
    ({ jobId }) => {
      localStorage.setItem("code-city.last-import-job.v1", jobId);
    },
    { jobId: fixture.jobId },
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#model-name")).toHaveText(LINEAGE_TITLE, {
    timeout: 30_000,
  });
  await expect(page.locator("#evolution-commit")).toContainText(
    `4/4 \u00b7 ${LINEAGE_COMMITS[3]!.slice(0, 10)}`,
    { timeout: 30_000 },
  );
  if (options.performanceDiagnostics === true) {
    // The hardened production server rejects query-bearing request targets.
    // Enable the viewer's read-only diagnostics after navigation; subsequent
    // route renders publish the snapshot without another request.
    await page.evaluate(() => {
      const url = new URL(window.location.href);
      url.searchParams.set("performance", "1");
      window.history.replaceState(null, "", url);
    });
  }
  return fixture;
}

async function seekEvolutionFrame(
  page: Page,
  frameIndex: number,
): Promise<void> {
  const range = page.locator("#evolution-range");
  await range.fill(String(frameIndex));
  await expect(range).toHaveValue(String(frameIndex));
  await expect(page.locator("#evolution-commit")).toContainText(
    `${frameIndex + 1}/${LINEAGE_COMMITS.length} \u00b7 ` +
      LINEAGE_COMMITS[frameIndex]!.slice(0, 10),
    { timeout: 15_000 },
  );
  await expect(page.locator("#evolution-status")).not.toHaveText(
    "Seeking\u2026",
  );
}

interface BrowserRoutePoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

interface BrowserRouteGeometry {
  readonly consumer: {
    readonly contact: BrowserRoutePoint;
    readonly anchor: BrowserRoutePoint;
  };
  readonly provider: {
    readonly contact: BrowserRoutePoint;
    readonly anchor: BrowserRoutePoint;
  };
}

async function districtRouteGeometry(
  page: Page,
  frameIndex: number,
  routeId: string,
): Promise<BrowserRouteGeometry> {
  await expect
    .poll(() =>
      page.evaluate(
        ({ expectedFrame, expectedRoute }) => {
          const diagnostics = window.__CODE_CITY_PERFORMANCE__;
          if (
            diagnostics?.evolutionFrameIndex !== expectedFrame
          ) {
            return null;
          }
          const route =
            diagnostics.districtDependencyRoutes.routes.find(
              ({ id }) => id === expectedRoute,
            );
          return route === undefined
            ? null
            : {
                consumer: route.consumer,
                provider: route.provider,
              };
        },
        {
          expectedFrame: frameIndex,
          expectedRoute: routeId,
        },
      ),
    )
    .not.toBeNull();
  const geometry = await page.evaluate(
    ({ expectedFrame, expectedRoute }) => {
      const diagnostics = window.__CODE_CITY_PERFORMANCE__;
      if (
        diagnostics?.evolutionFrameIndex !== expectedFrame
      ) {
        return null;
      }
      const route =
        diagnostics.districtDependencyRoutes.routes.find(
          ({ id }) => id === expectedRoute,
        );
      return route === undefined
        ? null
        : {
            consumer: route.consumer,
            provider: route.provider,
          };
    },
    {
      expectedFrame: frameIndex,
      expectedRoute: routeId,
    },
  );
  if (geometry === null) {
    throw new Error("Expected district route diagnostics.");
  }
  return geometry;
}

async function selectLineageBuilding(
  page: Page,
  building: CityBuilding,
): Promise<void> {
  await page.getByRole("tab", { name: "Explore" }).click();
  await page.locator("#building-search").fill(building.name);
  const result = page
    .locator(".search-result-button")
    .filter({ hasText: building.name });
  await expect(result).toHaveCount(1);
  await result.click();
  await expect(page.locator("#inspector-title")).toHaveText("Building");
  await expect(page.locator("#selection-name")).toHaveText(building.name);
}

function lastRemoteInvocation(
  repositoryUrl: string,
): RemoteInvocation | undefined {
  return [...remoteInvocations]
    .reverse()
    .find((invocation) => invocation.repositoryUrl === repositoryUrl);
}

test("uploads, opens, and restores a city model through the real browser API", async ({
  page,
}) => {
  await page.goto(server.url.href, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Import project" }).click();
  await page.locator("#project-import-token").fill(accessToken);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("#project-import-auth")).toBeHidden();
  await expect(page.locator("#project-import-token")).toHaveValue("");
  await page
    .locator('input[name="project-import-source"][value="city-model"]')
    .check();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator("#project-import-details-title")).toBeFocused();
  await expect(page.locator("#project-import-live-status")).toContainText(
    "Step 2 of 4: Source details.",
  );
  await page
    .locator("#project-import-model")
    .setInputFiles(path.resolve("examples/demo-city.json"));
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator("#project-import-progress-title")).toBeFocused();
  await expect(page.locator("#project-import-live-status")).toContainText(
    "Step 4 of 4: Import project.",
  );
  await expect(
    page.getByRole("button", { name: "Start import" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Start import" }).click();

  await expect(page.locator("#project-import-dialog")).toBeHidden({
    timeout: 30_000,
  });
  await expect(page.locator("#model-name")).toHaveAttribute(
    "title",
    "Source: Imported project",
  );
  await expect(page.locator("#project-import-model")).toHaveValue("");
  await expect(page.locator("#project-import-repository-url")).toHaveValue(
    "",
  );

  const stored = await page.evaluate(() => ({
    keys: Object.keys(localStorage),
    jobId: localStorage.getItem("code-city.last-import-job.v1"),
    sessionKeys: Object.keys(sessionStorage),
  }));
  expect(stored.keys).toEqual(["code-city.last-import-job.v1"]);
  expect(stored.jobId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  expect(stored.sessionKeys).toEqual([]);
  expect(await page.evaluate(() => document.cookie)).toBe("");
  expect(await page.content()).not.toContain(accessToken);
  expect(server.jobs.get(stored.jobId!)?.state).toBe("completed");

  await page.getByRole("tab", { name: "Explore" }).click();
  await page
    .locator("#building-search")
    .fill("apps/viewer/src/main.ts");
  await page
    .locator(
      '.search-result-button[title="apps/viewer/src/main.ts"]',
    )
    .click();
  await expect(page.locator("#building-source-status")).toHaveText(
    "This model-only import contains no retained source. Import the repository or a repository ZIP to enable source navigation.",
  );

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#model-name")).toHaveAttribute(
    "title",
    "Source: Imported project",
    { timeout: 30_000 },
  );
  await expect(page.getByRole("alert")).toBeHidden();

  await page.getByRole("button", { name: "Import project" }).click();
  await expect(
    page.getByRole("button", { name: "Sign out" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.locator("#project-import-auth")).toBeVisible();
  await expect(page.locator("#model-name")).toHaveAttribute(
    "title",
    "Source: Built-in demo",
  );
  expect(
    await page.evaluate(() =>
      localStorage.getItem("code-city.last-import-job.v1"),
    ),
  ).toBeNull();
});

test("keeps explicit unavailable fine detail visible after initial selection", async ({
  page,
}) => {
  await openAuthenticatedWizard(page);
  await page.locator('input[name="project-import-source"][value="city-model"]').check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.locator("#project-import-model").setInputFiles(unavailableDetailFixture);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("button", { name: "Start import" })).toBeVisible();
  await startAndWaitForImportedCity(page);
  await page.getByRole("tab", { name: "Explore" }).click();
  await page.locator("#building-search").fill(cityModelFixture.buildings[0]!.name);
  await page.locator("#search-results .search-result-button").first().click();
  await expect(page.locator("#building-source-structure-details")).toBeVisible();
  await page.locator("#building-source-structure-details summary").click();
  await expect(page.locator("#building-source-structure-summary")).toHaveText("Unavailable");
  await expect(page.locator("#building-source-structure-status")).toContainText(
    "declaration facts were not captured",
  );
  await expect(page.locator("#building-source-structure")).not.toContainText(
    "Executable unit",
  );
});

test("initial selection exposes an accessible persisted type hierarchy", async ({
  page,
}) => {
  await openAuthenticatedWizard(page);
  await page.locator('input[name="project-import-source"][value="city-model"]').check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.locator("#project-import-model").setInputFiles(availableDetailFixture);
  await page.getByRole("button", { name: "Continue" }).click();
  await startAndWaitForImportedCity(page);
  await page.getByRole("tab", { name: "Explore" }).click();
  await page.locator("#building-search").fill(cityModelFixture.buildings[0]!.name);
  await page.locator("#search-results .search-result-button").first().click();
  await page.locator("#building-source-structure-details summary").click();
  const typeToggle = page.getByRole("button", {
    name: /Class DemoType \(1\)/u,
  });
  await expect(typeToggle).toHaveAttribute("aria-expanded", "false");
  const method = page.getByRole("button", { name: /Method run\./u });
  await expect(method).toBeHidden();
  await typeToggle.press("Enter");
  await expect(typeToggle).toHaveAttribute("aria-expanded", "true");
  await expect(typeToggle).toBeFocused();
  await expect(method).toBeVisible();
  await expect(method).toHaveAttribute("title", /cyclomatic complexity 1/u);
  await expect(page.getByRole("button", {
    name: /Class DemoType\..*Open its exact persisted source range/u,
  })).toBeVisible();
  await expect(page.locator("#building-source-structure-status")).toContainText(
    "syntax-provenance relationships",
  );
});

test("fine detail reaches a terminal cap without a no-op Show more action", async ({
  page,
}) => {
  await openAuthenticatedWizard(page);
  await page.locator('input[name="project-import-source"][value="city-model"]').check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.locator("#project-import-model").setInputFiles(cappedDetailFixture);
  await page.getByRole("button", { name: "Continue" }).click();
  await startAndWaitForImportedCity(page);
  await page.getByRole("tab", { name: "Explore" }).click();
  await page.locator("#building-search").fill(cityModelFixture.buildings[0]!.name);
  await page.locator("#search-results .search-result-button").first().click();
  await page.locator("#building-source-structure-details summary").click();
  const showMore = page.locator("#building-source-structure-show-more");
  for (let pageIndex = 0; pageIndex < 4; pageIndex += 1) {
    await expect(showMore).toBeVisible();
    await showMore.click();
  }
  await expect(showMore).toBeHidden();
  await expect(page.locator("#building-source-structure-summary")).toHaveText(
    "250 declarations · 50 not loaded",
  );
  await expect(page.locator("#building-source-structure-status")).toContainText(
    "capped at 200 declarations",
  );
  await expect(page.locator("#building-source-structure > li")).toHaveCount(200);
});

test("submits bounded history, validates both artifacts, and restores its recent job", async ({
  page,
}) => {
  historyInvocations.length = 0;
  const browserRequests: {
    readonly method: string;
    readonly pathname: string;
    readonly origin: string;
  }[] = [];
  let submittedRequest: unknown;
  page.on("request", (request) => {
    const url = new URL(request.url());
    browserRequests.push({
      method: request.method(),
      pathname: url.pathname,
      origin: url.origin,
    });
    if (
      request.method() === "POST" &&
      url.pathname === "/api/v1/imports"
    ) {
      submittedRequest = request.postDataJSON();
    }
  });

  await openAuthenticatedWizard(page);
  await chooseSource(page, "github-public");
  await page
    .locator("#project-import-repository-url")
    .fill(PUBLIC_GITHUB_URL);
  await page
    .locator('input[name="project-import-revision"][value="branch"]')
    .check();
  await page.locator("#project-import-revision-value").fill("main");
  await page.locator("#project-import-history-enabled").check();
  await page
    .locator("#project-import-history-commit-count")
    .fill(HISTORY_COMMIT_COUNT.toString());
  await page
    .locator("#project-import-history-sample-every")
    .fill(HISTORY_SAMPLE_EVERY.toString());
  await expect(
    page.locator("#project-import-history-frame-help"),
  ).toHaveText("This range can produce up to 10 animation frames.");

  await continueToOptions(page);
  await page
    .locator("#project-import-identity-title")
    .fill(HISTORY_TITLE);
  await page
    .locator("#project-import-identity-version")
    .fill(HISTORY_VERSION);
  await page.locator("#project-import-max-files").fill("432");
  await page.locator("#project-import-max-file-mib").fill("1");
  await page.locator("#project-import-max-total-mib").fill("3");
  await page
    .locator("#project-import-timeout-seconds")
    .fill((HISTORY_TIMEOUT_MS / 1_000).toString());
  await continueToReview(page);
  await expect(page.locator("#project-import-review-source")).toHaveText(
    "Public GitHub",
  );
  await expect(page.locator("#project-import-review-input")).toHaveText(
    PUBLIC_GITHUB_URL,
  );
  await expect(page.locator("#project-import-review-revision")).toHaveText(
    `branch: main; ${HISTORY_COMMIT_COUNT} recent commits`,
  );

  const jobId = await startAndWaitForImportedCity(page);
  await expect(page.locator("#model-name")).toHaveText(HISTORY_TITLE);
  await expect(page.locator("#status")).toContainText(HISTORY_VERSION);

  expect(submittedRequest).toEqual({
    source: {
      kind: "github",
      repositoryUrl: PUBLIC_GITHUB_URL,
      revision: { kind: "branch", name: "main" },
    },
    history: {
      mode: "commit-count",
      commitCount: HISTORY_COMMIT_COUNT,
      sampleEvery: HISTORY_SAMPLE_EVERY,
    },
    identity: {
      title: HISTORY_TITLE,
      version: HISTORY_VERSION,
    },
    analysis: {
      maxRetainedFiles: 432,
      maxFileBytes: 1024 * 1024,
      maxTotalBytes: 3 * 1024 * 1024,
      timeoutMs: HISTORY_TIMEOUT_MS,
    },
  });
  expect(historyInvocations).toHaveLength(1);
  const historyInvocation = historyInvocations[0]!;
  expect(historyInvocation.request).toEqual({
    repositoryUrl: PUBLIC_GITHUB_URL,
    repositoryIdentity: PUBLIC_GITHUB_URL,
    ref: "refs/heads/main",
    selection: {
      mode: "commit-count",
      commitCount: HISTORY_COMMIT_COUNT,
      sampleEvery: HISTORY_SAMPLE_EVERY,
      totalDeadlineMs: HISTORY_TIMEOUT_MS,
    },
    signal: expect.any(AbortSignal),
  });
  expect(historyInvocation.options).toEqual({
    identity: {
      title: HISTORY_TITLE,
      version: HISTORY_VERSION,
    },
    retainSourceSnapshot: true,
    analysisOptions: {
      maxRetainedFiles: 432,
      maxFileBytes: 1024 * 1024,
      maxTotalBytes: 3 * 1024 * 1024,
    },
  });
  expect(historyInvocation.dependencies).toMatchObject({
    semanticCache: {
      acquire: expect.any(Function),
    },
    git: {
      isolateCredentials: true,
      temporaryWorkspaceOptions: {
        trustedPrivateParent: {
          directory: expect.any(String),
          windowsAclProtection:
            GENERIC_GIT_PRESECURED_WINDOWS_ACL,
          canonicalAncestryProtection:
            GENERIC_GIT_PRESECURED_CANONICAL_ANCESTRY,
        },
      },
    },
  });

  const evolutionSha256 = createHash("sha256")
    .update(canonicalEvolutionFixture)
    .digest("hex");
  const expectedResult = {
    kind: "city-model",
    artifactToken: jobId,
    artifactUrl: `/api/v1/artifacts/${jobId}/city-model.json`,
    evolution: {
      artifactUrl: `/api/v1/artifacts/${jobId}/evolution.json`,
      size: canonicalEvolutionFixture.byteLength,
      sha256: evolutionSha256,
    },
  } as const;
  expect(server.jobs.get(jobId)).toMatchObject({
    kind: "project-import",
    state: "completed",
    progress: { phase: "ready", current: 3, total: 3 },
    result: expectedResult,
  });

  const jobResponse = await page.evaluate(async (id) => {
    const response = await fetch(`/api/v1/jobs/${id}`);
    return {
      status: response.status,
      value: await response.json() as unknown,
    };
  }, jobId);
  expect(jobResponse.status).toBe(200);
  expect(jobResponse.value).toMatchObject({
    job: {
      id: jobId,
      kind: "project-import",
      state: "completed",
      result: expectedResult,
    },
  });

  const companionResponse = await page.evaluate(async (artifactUrl) => {
    const response = await fetch(artifactUrl);
    return {
      status: response.status,
      cacheControl: response.headers.get("cache-control"),
      contentLength: response.headers.get("content-length"),
      body: await response.text(),
    };
  }, expectedResult.evolution.artifactUrl);
  expect(companionResponse).toEqual({
    status: 200,
    cacheControl: "no-store",
    contentLength: canonicalEvolutionFixture.byteLength.toString(),
    body: new TextDecoder().decode(canonicalEvolutionFixture),
  });
  const parsedCompanion = JSON.parse(companionResponse.body) as unknown;
  expect(parsedCompanion).toMatchObject({
    selection: historyResultFixture.evolution.bundle.selection,
    baseline: {
      commit: historyResultFixture.evolution.bundle.baseline.commit,
      model: {
        identity: {
          title: HISTORY_TITLE,
          version: HISTORY_VERSION,
        },
      },
    },
  });
  expect(
    new TextDecoder().decode(
      serializeEvolutionBundle(parsedCompanion),
    ),
  ).toBe(companionResponse.body);

  const jobPath = `/api/v1/jobs/${jobId}`;
  const cityPath = expectedResult.artifactUrl;
  const jobRequestsBeforeReload = browserRequests.filter(
    ({ method, pathname }) =>
      method === "GET" && pathname === jobPath,
  ).length;
  const cityRequestsBeforeReload = browserRequests.filter(
    ({ method, pathname }) =>
      method === "GET" && pathname === cityPath,
  ).length;
  expect(jobRequestsBeforeReload).toBeGreaterThan(0);
  expect(cityRequestsBeforeReload).toBeGreaterThan(0);
  expect(
    await page.evaluate(() =>
      localStorage.getItem("code-city.last-import-job.v1"),
    ),
  ).toBe(jobId);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#model-name")).toHaveText(HISTORY_TITLE, {
    timeout: 30_000,
  });
  await expect(page.locator("#model-name")).toHaveAttribute(
    "title",
    "Source: Imported project",
  );
  await expect(page.locator("#status")).toContainText(HISTORY_VERSION);
  await expect.poll(
    () =>
      browserRequests.filter(
        ({ method, pathname }) =>
          method === "GET" && pathname === jobPath,
      ).length,
  ).toBeGreaterThan(jobRequestsBeforeReload);
  await expect.poll(
    () =>
      browserRequests.filter(
        ({ method, pathname }) =>
          method === "GET" && pathname === cityPath,
      ).length,
  ).toBeGreaterThan(cityRequestsBeforeReload);
  expect(
    await page.evaluate(() =>
      localStorage.getItem("code-city.last-import-job.v1"),
    ),
  ).toBe(jobId);
  expect(
    browserRequests.filter(
      ({ origin }) => origin !== server.url.origin,
    ),
  ).toEqual([]);

  await page.getByRole("button", { name: "Import project" }).click();
  const removeResultButton = page.getByRole("button", {
    name: "Remove stored import",
  });
  await expect(removeResultButton).toBeVisible();
  await removeResultButton.click();

  await expect.poll(() => server.jobs.get(jobId)).toBeUndefined();
  await expect
    .poll(() =>
      page.evaluate(() =>
        localStorage.getItem("code-city.last-import-job.v1"),
      ),
    )
    .toBeNull();
  const removedResponses = await page.evaluate(
    async ({ jobUrl, cityUrl, evolutionUrl }) =>
      await Promise.all(
        [jobUrl, cityUrl, evolutionUrl].map(async (url) => {
          const response = await fetch(url);
          return response.status;
        }),
      ),
    {
      jobUrl: jobPath,
      cityUrl: cityPath,
      evolutionUrl: expectedResult.evolution.artifactUrl,
    },
  );
  expect(removedResponses).toEqual([404, 404, 404]);
  await expect(page.locator("#model-name")).toHaveText(HISTORY_TITLE);
  await expect(page.locator("#status")).toContainText(HISTORY_VERSION);
});

test("preserves filtered selected dependency routes across evolution seeks", async ({
  page,
}) => {
  await openAuthenticatedWizard(page);
  await chooseSource(page, "github-public");
  await page
    .locator("#project-import-repository-url")
    .fill(PUBLIC_GITHUB_URL);
  await page.locator("#project-import-history-enabled").check();
  await continueToOptions(page);
  await continueToReview(page);
  await startAndWaitForImportedCity(page);

  await expect(page.locator("#evolution-timeline")).toBeVisible();
  await expect(page.locator("#evolution-commit")).toContainText("2/2");
  await page.getByRole("tab", { name: "Routes" }).click();
  await page.locator("#district-routes-toggle").click();
  await page.locator("#district-route-filter-project").click();
  await page.locator("#district-route-filter-package").click();

  const route = page.locator(
    '.district-route-button[data-bundle-id="district-dependency:district%3Aviewer:district:district%3Acore"]',
  );
  await expect(route).toHaveAttribute("aria-label", /2 edges, 2 references/u);
  await route.click();
  await expect(route).toHaveAttribute("aria-current", "true");
  await expect(
    page.locator("#district-route-detail-summary"),
  ).toHaveText(/2 edges.*2 references/u);

  await page.locator("#evolution-previous").click();
  await expect(page.locator("#evolution-commit")).toContainText("1/2");
  await expect(page.locator("#district-routes-toggle")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(
    page.locator("#district-route-filter-typescript"),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.locator("#district-route-filter-project"),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(
    page.locator("#district-route-filter-package"),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(route).toHaveAttribute("aria-current", "true");
  await expect(route).toHaveAttribute("aria-label", /1 edge, 1 reference/u);
  await expect(
    page.locator("#district-route-detail-summary"),
  ).toHaveText(/1 edge.*1 reference/u);
  await expect(page.locator("#evolution-status")).toContainText(
    "1 dependency removed",
  );
  await expect(page.locator("#legend")).toContainText(
    "1 dependency route change (0 added, 1 removed, 0 changed, 0 retargeted)",
  );

  await page.locator("#evolution-next").click();
  await expect(page.locator("#evolution-commit")).toContainText("2/2");
  await expect(route).toHaveAttribute("aria-current", "true");
  await expect(route).toHaveAttribute("aria-label", /2 edges, 2 references/u);

  await page.waitForTimeout(1_300);
  await page.getByRole("tab", { name: "Queries" }).click();
  await page
    .locator("#advanced-query-preset")
    .selectOption("changed-recently");
  await page.locator("#advanced-query-run").click();
  await expect(page.locator("#advanced-query-status")).toHaveText(
    "0 matches",
  );
});

test("retains an exact building mask across evolution and intersects removed identities", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const initialSavedName = "Topology continuity initial";
  const changedSavedName = "Topology continuity changed";
  const savedOption = (
    selectId: "#advanced-query-saved" | "#advanced-selection-saved",
    name: string,
  ) => page.locator(`${selectId} option`).filter({ hasText: name });
  const fixture = await openLineageEvolutionFixture(page, {
    performanceDiagnostics: true,
  });
  await expect(page.locator("#overview-solutions")).toHaveText("2");
  await expect(page.locator("#overview-modules")).toHaveText("3");
  await page.getByRole("tab", { name: "Queries" }).click();
  await page.locator("#advanced-query-preset").selectOption("custom");
  await page.locator("#advanced-query-text").fill(".ts");
  await page.locator("#advanced-query-limit").selectOption("25");
  await page.locator("#advanced-query-run").click();
  await expect(page.locator("#advanced-query-status")).toContainText(
    "4 matches",
    { timeout: 30_000 },
  );
  await page
    .locator(
      '.advanced-query-result[data-building-id="building:main"]',
    )
    .click();
  await page
    .locator(
      `.advanced-query-result[data-building-id="${fixture.futureBuilding.id}"]`,
    )
    .click({ modifiers: ["Control"] });
  await expect(page.locator("#selection-status")).toContainText(
    "2 buildings selected",
  );
  await page
    .locator("#advanced-query-save-name")
    .fill(initialSavedName);
  await page.locator("#advanced-query-save").click();
  await page.locator("#advanced-selection-save").click();
  await expect(
    savedOption("#advanced-query-saved", initialSavedName),
  ).toHaveText(initialSavedName);
  await expect(
    savedOption("#advanced-selection-saved", initialSavedName),
  ).toHaveText(initialSavedName);
  await page.locator("#advanced-query-isolate").click();

  const selectionSnapshot = () =>
    page.evaluate(() => {
      const diagnostics = (
        window as Window & {
          __CODE_CITY_PERFORMANCE__?: {
            readonly evolutionFrameIndex: number;
            readonly buildingRenderMode: "instanced" | "legacy" | null;
            readonly buildingVisibilityMaskActive: boolean;
            readonly visibleBuildingCount: number;
          };
        }
      ).__CODE_CITY_PERFORMANCE__;
      return diagnostics === undefined
        ? undefined
        : {
            evolutionFrameIndex: diagnostics.evolutionFrameIndex,
            buildingRenderMode: diagnostics.buildingRenderMode,
            buildingVisibilityMaskActive:
              diagnostics.buildingVisibilityMaskActive,
            visibleBuildingCount: diagnostics.visibleBuildingCount,
          };
    });
  await expect.poll(selectionSnapshot).toMatchObject({
    evolutionFrameIndex: 3,
    buildingRenderMode: "instanced",
    buildingVisibilityMaskActive: true,
    visibleBuildingCount: 2,
  });

  await seekEvolutionFrame(page, 1);
  await page.getByRole("tab", { name: "Queries" }).click();
  await expect
    .poll(selectionSnapshot, { timeout: 30_000 })
    .toMatchObject({
      evolutionFrameIndex: 1,
      buildingRenderMode: "instanced",
      buildingVisibilityMaskActive: true,
      visibleBuildingCount: 1,
    });
  await expect(page.locator("#overview-solutions")).toHaveText("1");
  await expect(page.locator("#overview-modules")).toHaveText("2");
  await expect(page.locator("#advanced-query-preset")).toHaveValue(
    "custom",
  );
  await expect(page.locator("#advanced-query-text")).toHaveValue(".ts");
  await expect(page.locator("#advanced-query-limit")).toHaveValue("25");
  await expect(page.locator("#advanced-query-status")).toContainText(
    "4 matches",
    { timeout: 30_000 },
  );
  await expect(
    savedOption("#advanced-query-saved", initialSavedName),
  ).toHaveText(initialSavedName);
  await expect(
    savedOption("#advanced-selection-saved", initialSavedName),
  ).toHaveText(initialSavedName);
  await expect(
    page.locator('.advanced-query-result[aria-selected="true"]'),
  ).toHaveCount(1, { timeout: 30_000 });
  await expect(
    page.locator(
      '.advanced-query-result[data-building-id="building:main"]',
    ),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#selection-name")).toHaveText("main.ts");
  await expect(
    page.locator(
      `.advanced-query-result[data-building-id="${fixture.futureBuilding.id}"]`,
    ),
  ).toHaveCount(0);
  await expect(
    page.locator(
      `.advanced-query-result[data-building-id="${fixture.removedBuilding.id}"]`,
    ),
  ).toHaveCount(1);
  await page
    .locator("#advanced-query-save-name")
    .fill(changedSavedName);
  await page.locator("#advanced-query-save").click();
  await page.locator("#advanced-selection-save").click();
  await expect(
    savedOption("#advanced-query-saved", changedSavedName),
  ).toHaveText(changedSavedName);
  await expect(
    savedOption("#advanced-selection-saved", changedSavedName),
  ).toHaveText(changedSavedName);

  await seekEvolutionFrame(page, 3);
  await page.getByRole("tab", { name: "Queries" }).click();
  await expect
    .poll(selectionSnapshot, { timeout: 30_000 })
    .toMatchObject({
      evolutionFrameIndex: 3,
      buildingRenderMode: "instanced",
      buildingVisibilityMaskActive: true,
      visibleBuildingCount: 1,
    });
  await expect(page.locator("#overview-solutions")).toHaveText("2");
  await expect(page.locator("#overview-modules")).toHaveText("3");
  await expect(page.locator("#advanced-query-preset")).toHaveValue(
    "custom",
  );
  await expect(page.locator("#advanced-query-text")).toHaveValue(".ts");
  await expect(page.locator("#advanced-query-limit")).toHaveValue("25");
  await expect(page.locator("#advanced-query-status")).toContainText(
    "4 matches",
    { timeout: 30_000 },
  );
  await expect(
    savedOption("#advanced-query-saved", initialSavedName),
  ).toHaveText(initialSavedName);
  await expect(
    savedOption("#advanced-selection-saved", initialSavedName),
  ).toHaveText(initialSavedName);
  await expect(
    savedOption("#advanced-query-saved", changedSavedName),
  ).toHaveText(changedSavedName);
  await expect(
    savedOption("#advanced-selection-saved", changedSavedName),
  ).toHaveText(changedSavedName);
  await expect(
    page.locator(
      '.advanced-query-result[data-building-id="building:main"]',
    ),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.locator(
      `.advanced-query-result[data-building-id="${fixture.futureBuilding.id}"]`,
    ),
  ).toHaveAttribute("aria-selected", "false");
});

test("rejects an oversized legacy evolution artifact before downloading it", async ({
  page,
}) => {
  const legacyJobId = "33333333-3333-4333-8333-333333333333";
  const jobPath = `/api/v1/jobs/${legacyJobId}`;
  const evolutionPath =
    `/api/v1/artifacts/${legacyJobId}/evolution.json`;
  await openAuthenticatedWizard(page);
  await page
    .getByRole("button", { name: "Close project import" })
    .click();
  await page.evaluate((jobId) => {
    localStorage.setItem("code-city.last-import-job.v1", jobId);
  }, legacyJobId);

  let evolutionRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === evolutionPath) {
      evolutionRequests += 1;
    }
  });
  await page.route(`**${jobPath}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        job: {
          id: legacyJobId,
          kind: "project-import",
          state: "completed",
          createdAt: "2026-07-31T00:00:00.000Z",
          updatedAt: "2026-07-31T00:00:01.000Z",
          progress: { phase: "ready", current: 3, total: 3 },
          result: {
            kind: "city-model",
            artifactToken: legacyJobId,
            artifactUrl:
              `/api/v1/artifacts/${legacyJobId}/city-model.json`,
            evolution: {
              artifactUrl: evolutionPath,
              size:
                HISTORY_SELECTION_LIMITS.maxEvolutionOutputBytes + 1,
              sha256: "a".repeat(64),
            },
          },
        },
      }),
    });
  });

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Import project" }).click();
  await expect(page.locator("#project-import-progress-detail")).toContainText(
    "Evolution artifact exceeds the browser-safe 64 MiB limit. Re-import with fewer history frames or a lower maxEvolutionOutputBytes.",
  );
  expect(evolutionRequests).toBe(0);
  await page
    .getByRole("button", { name: "Close project import" })
    .click();
  await expect(page.locator("#project-import-dialog")).toBeHidden();
});

test("keeps a future lineage selected before creation and restores its source at creation", async ({
  page,
}) => {
  const fixture = await openLineageEvolutionFixture(page);
  const building = fixture.futureBuilding;
  const shortCreationCommit = LINEAGE_COMMITS[2]!.slice(0, 10);

  await selectLineageBuilding(page, building);
  await expect(page.locator("#building-source-status")).toContainText(
    "Showing the exact retained file",
  );
  await expect(page.locator("#building-source-code")).toContainText(
    "future-lineage-source-sentinel",
  );
  await expect(page.locator("#building-evolution")).toContainText(
    `First seen ${shortCreationCommit} at frame 3`,
  );

  await seekEvolutionFrame(page, 1);
  await expect(page.locator("#inspector-title")).toHaveText(
    "Not yet created",
  );
  await expect(page.locator("#selection-name")).toHaveText(building.name);
  await expect(page.locator("#building-repository")).toHaveText(
    `Introduced by ${shortCreationCommit}`,
  );
  await expect(
    page.locator("#building-metric-explanation"),
  ).toContainText(
    `not present at this commit. It is introduced by commit ` +
      `${shortCreationCommit} at frame 3`,
  );
  await expect(page.locator("#selection-status")).toContainText(
    `is not yet created at this commit; it is introduced by commit ` +
      shortCreationCommit,
  );
  await expect(page.locator("#selection-status")).not.toContainText(
    "removed",
  );
  await expect(page.locator("#building-source-details")).toBeHidden();

  await seekEvolutionFrame(page, 0);
  await expect(page.locator("#inspector-title")).toHaveText(
    "Not yet created",
  );
  await expect(page.locator("#selection-name")).toHaveText(building.name);
  await expect(page.locator("#building-repository")).toHaveText(
    `Introduced by ${shortCreationCommit}`,
  );
  await expect(page.locator("#selection-status")).not.toContainText(
    "removed",
  );

  await seekEvolutionFrame(page, 2);
  await expect(page.locator("#inspector-title")).toHaveText("Building");
  await expect(page.locator("#selection-name")).toHaveText(building.name);
  await expect(page.locator("#building-repository")).toHaveText(
    "Code City Demo",
  );
  await expect(page.locator("#building-source-details")).toBeVisible();
  await expect(page.locator("#building-source-status")).toContainText(
    "Showing the exact retained file",
  );
  await expect(page.locator("#building-source-code")).toContainText(
    "future-lineage-source-sentinel",
  );
  await expect(page.locator("#building-evolution")).toContainText(
    `First seen ${shortCreationCommit} at frame 3`,
  );
});

test("keeps a removed lineage tombstone and restores its source before removal", async ({
  page,
}) => {
  const fixture = await openLineageEvolutionFixture(page);
  const building = fixture.removedBuilding;
  const shortCreationCommit = LINEAGE_COMMITS[0]!.slice(0, 10);
  const shortRemovalCommit = LINEAGE_COMMITS[2]!.slice(0, 10);
  const shortNewestCommit = LINEAGE_COMMITS[3]!.slice(0, 10);

  await seekEvolutionFrame(page, 1);
  await selectLineageBuilding(page, building);
  await expect(page.locator("#building-source-status")).toContainText(
    "Showing the exact retained file",
  );
  await expect(page.locator("#building-source-code")).toContainText(
    "removed-lineage-source-sentinel",
  );

  await seekEvolutionFrame(page, 2);
  await expect(page.locator("#inspector-title")).toHaveText(
    "Removed building",
  );
  await expect(page.locator("#selection-name")).toHaveText(building.name);
  await expect(page.locator("#building-repository")).toHaveText(
    `Removed by ${shortRemovalCommit}`,
  );
  await expect(
    page.locator("#building-metric-explanation"),
  ).toContainText(
    `removed by commit ${shortRemovalCommit} at frame 3`,
  );
  await expect(page.locator("#selection-status")).toContainText(
    `was removed by commit ${shortRemovalCommit}`,
  );
  await expect(page.locator("#building-evolution")).toContainText(
    `Removed by ${shortRemovalCommit} at frame 3`,
  );
  await expect(page.locator("#building-source-details")).toBeHidden();

  await seekEvolutionFrame(page, 3);
  await expect(page.locator("#inspector-title")).toHaveText(
    "Removed building",
  );
  await expect(page.locator("#selection-name")).toHaveText(building.name);
  await expect(page.locator("#building-repository")).toHaveText(
    `Removed by ${shortRemovalCommit}`,
  );
  await expect(page.locator("#building-repository")).not.toContainText(
    shortNewestCommit,
  );
  await expect(
    page.locator("#building-metric-explanation"),
  ).toContainText(
    `removed by commit ${shortRemovalCommit} at frame 3`,
  );

  await seekEvolutionFrame(page, 1);
  await expect(page.locator("#inspector-title")).toHaveText("Building");
  await expect(page.locator("#selection-name")).toHaveText(building.name);
  await expect(page.locator("#building-repository")).toHaveText(
    "Code City Demo",
  );
  await expect(page.locator("#building-source-details")).toBeVisible();
  await expect(page.locator("#building-source-status")).toContainText(
    "Showing the exact retained file",
  );
  await expect(page.locator("#building-source-code")).toContainText(
    "removed-lineage-source-sentinel",
  );
  await expect(page.locator("#building-evolution")).toContainText(
    `First seen ${shortCreationCommit} at frame 1`,
  );
  await expect(page.locator("#building-evolution")).toContainText(
    `Removed by ${shortRemovalCommit} at frame 3`,
  );
});

test("does not overwrite a newer clear or replacement selection during a seek", async ({
  page,
}) => {
  const fixture = await openLineageEvolutionFixture(page, {
    seekDelayMs: 2_000,
  });
  await selectLineageBuilding(page, fixture.futureBuilding);
  await expect(page.locator("#building-source-status")).toContainText(
    "Showing the exact retained file",
  );

  await page.locator("#evolution-range").fill("1");
  await expect(page.locator("#evolution-status")).toHaveText(
    "Seeking\u2026",
  );
  await page.getByRole("button", { name: "Clear selection" }).click();
  await expect(page.locator("#inspector-title")).toHaveText("Details");
  await expect(page.locator("#selection-name")).toHaveText(
    "Nothing selected",
  );

  await expect(page.locator("#evolution-commit")).toContainText(
    `2/4 \u00b7 ${LINEAGE_COMMITS[1]!.slice(0, 10)}`,
    { timeout: 15_000 },
  );
  await expect(page.locator("#evolution-status")).not.toHaveText(
    "Seeking\u2026",
  );
  await expect(page.locator("#inspector-title")).toHaveText("Details");
  await expect(page.locator("#selection-name")).toHaveText(
    "Nothing selected",
  );
  await expect(page.locator("#selection-status")).toHaveText(
    "Selection cleared.",
  );
  await expect(page.locator("#building-source-code")).toHaveText("");

  const stableReplacement = fixture.model.buildings.find(
    ({ id }) => id === "building:main",
  );
  expect(stableReplacement).toBeDefined();
  await selectLineageBuilding(page, fixture.removedBuilding);
  await page.locator("#evolution-range").fill("2");
  await expect(page.locator("#evolution-status")).toHaveText(
    "Seeking\u2026",
  );
  await selectLineageBuilding(page, stableReplacement!);

  await expect(page.locator("#evolution-commit")).toContainText(
    `3/4 \u00b7 ${LINEAGE_COMMITS[2]!.slice(0, 10)}`,
    { timeout: 15_000 },
  );
  await expect(page.locator("#evolution-status")).not.toHaveText(
    "Seeking\u2026",
  );
  await expect(page.locator("#inspector-title")).toHaveText("Building");
  await expect(page.locator("#selection-name")).toHaveText(
    stableReplacement!.name,
  );
  await expect(page.locator("#building-repository")).toHaveText(
    "Code City Demo",
  );
});

test("preserves filtered route overlays and rebuilds their geometry across arbitrary seeks", async ({
  page,
}) => {
  test.setTimeout(75_000);
  const fixture = await openLineageEvolutionFixture(page, {
    performanceDiagnostics: true,
  });
  const selectedBuilding = fixture.model.buildings.find(
    ({ id }) => id === "building:main",
  );
  if (selectedBuilding === undefined) {
    throw new Error("The route E2E fixture requires building:main.");
  }
  await selectLineageBuilding(page, selectedBuilding);
  await page.locator("#dependency-section > summary").click();
  await page.locator("#dependency-incoming-toggle").click();
  await page.locator("#dependency-outgoing-toggle").click();
  await expect(
    page.locator("#dependency-incoming-toggle"),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.locator("#dependency-outgoing-toggle"),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.locator("#dependency-list .dependency-result-button"),
  ).toHaveCount(9);
  await page.locator("#dependency-show-more").click();
  await expect(
    page.locator("#dependency-list .dependency-result-button"),
  ).toHaveCount(12);

  await page.getByRole("tab", { name: "Routes" }).click();
  await page.locator("#district-route-filter-typescript").click();
  await expect(
    page.locator("#district-route-filter-typescript"),
  ).toHaveAttribute("aria-pressed", "false");
  await page.locator("#district-routes-toggle").click();
  await expect(page.locator("#district-routes-toggle")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(
    page.locator("#district-routes-list .district-route-button"),
  ).toHaveCount(8);
  await page.locator("#district-routes-show-more").click();
  await expect(
    page.locator("#district-routes-list .district-route-button"),
  ).toHaveCount(16);

  const selectedRoute = page
    .locator("#district-routes-list .district-route-button")
    .filter({ hasText: "Viewer" })
    .filter({ hasText: "Core" })
    .filter({ hasText: "Project" });
  await expect(selectedRoute).toHaveCount(1);
  const routeId = await selectedRoute.getAttribute("data-bundle-id");
  if (routeId === null) {
    throw new Error("The selected district route requires a stable id.");
  }
  await selectedRoute.click();
  await expect(selectedRoute).toHaveAttribute("aria-current", "true");
  await expect(selectedRoute).toContainText("30 references");
  const newestGeometry = await districtRouteGeometry(
    page,
    3,
    routeId,
  );

  const assertPreservedRouteState = async (
    frameIndex: number,
  ): Promise<void> => {
    await expect(
      page.locator("#dependency-incoming-toggle"),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.locator("#dependency-outgoing-toggle"),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.locator("#dependency-list .dependency-result-button"),
    ).toHaveCount(12);
    await expect(
      page.locator("#district-route-filter-typescript"),
    ).toHaveAttribute("aria-pressed", "false");
    await expect(
      page.locator("#district-route-filter-project"),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.locator("#district-route-filter-package"),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#district-routes-toggle")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(
      page.locator("#district-routes-list .district-route-button"),
    ).toHaveCount(16);
    await expect(selectedRoute).toHaveAttribute(
      "aria-current",
      "true",
    );
    await expect
      .poll(() =>
        page.evaluate((expectedFrame) => {
          const diagnostics = window.__CODE_CITY_PERFORMANCE__;
          return diagnostics?.evolutionFrameIndex === expectedFrame
            ? [
                diagnostics.dependencyRoutes.routeCount,
                diagnostics.districtDependencyRoutes.routeCount,
              ]
            : null;
        }, frameIndex),
      )
      .toEqual([12, 16]);
  };

  await seekEvolutionFrame(page, 1);
  await expect(page.locator("#legend")).toContainText(
    "4 dependency route changes",
  );
  await expect(page.locator("#evolution-status")).toContainText(
    "1 dependency added",
  );
  await expect(page.locator("#evolution-status")).toContainText(
    "1 dependency removed",
  );
  await expect(page.locator("#evolution-status")).toContainText(
    "1 dependency changed",
  );
  await expect(page.locator("#evolution-status")).toContainText(
    "1 dependency retargeted",
  );
  await assertPreservedRouteState(1);
  const olderGeometry = await districtRouteGeometry(
    page,
    1,
    routeId,
  );
  expect(olderGeometry).not.toEqual(newestGeometry);

  await seekEvolutionFrame(page, 2);
  await assertPreservedRouteState(2);
  await expect(selectedRoute).toContainText("30 references");
  expect(
    await districtRouteGeometry(page, 2, routeId),
  ).toEqual(newestGeometry);
  const addedPackageRoute = page
    .locator("#district-routes-list .district-route-button")
    .filter({ hasText: "lineage-added-package" });
  await expect(addedPackageRoute).toHaveCount(1);
  const addedPackageRouteId =
    await addedPackageRoute.getAttribute("data-bundle-id");
  if (addedPackageRouteId === null) {
    throw new Error(
      "The changed package route requires a stable bundle id.",
    );
  }
  await expect
    .poll(() =>
      page.evaluate(
        ({ expectedFrame, expectedRoute }) => {
          const diagnostics = window.__CODE_CITY_PERFORMANCE__;
          if (
            diagnostics?.evolutionFrameIndex !== expectedFrame
          ) {
            return null;
          }
          const route =
            diagnostics.districtDependencyRoutes.routes.find(
              ({ id }) => id === expectedRoute,
            );
          return route === undefined
            ? null
            : {
                color: route.color,
                emphasized: route.emphasized,
              };
        },
        {
          expectedFrame: 2,
          expectedRoute: addedPackageRouteId,
        },
      ),
    )
    .toEqual({
      color: "#f472b6",
      emphasized: true,
    });

  await seekEvolutionFrame(page, 0);
  await assertPreservedRouteState(0);
  await expect(selectedRoute).toContainText("1 reference");
  await expect(page.locator("#district-routes-status")).toContainText(
    /\d+ not shown/u,
  );
  expect(
    await districtRouteGeometry(page, 0, routeId),
  ).toEqual(olderGeometry);

  await seekEvolutionFrame(page, 2);
  await page.getByRole("tab", { name: "Routes" }).click();
  const transientRoute = page
    .locator("#district-routes-list .district-route-button")
    .filter({ hasText: "lineage-added-package" });
  await expect(transientRoute).toHaveCount(1);
  await transientRoute.click();
  await expect(transientRoute).toHaveAttribute(
    "aria-current",
    "true",
  );
  await seekEvolutionFrame(page, 1);
  await expect(transientRoute).toHaveCount(0);
  await expect(
    page.locator(
      "#district-routes-list .district-route-button[aria-current='true']",
    ),
  ).toHaveCount(0);
  await expect(page.locator("#district-route-details")).toBeHidden();
  await expect(page.locator("#district-routes-toggle")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(
    page.locator("#district-routes-list .district-route-button"),
  ).toHaveCount(16);
});

test("imports a browser directory and repository ZIP with identity and analysis options", async ({
  page,
}) => {
  await openAuthenticatedWizard(page);

  await chooseSource(page, "directory");
  await page
    .locator("#project-import-directory")
    .setInputFiles(directoryFixture);
  await continueToOptions(page);
  await page
    .locator("#project-import-identity-title")
    .fill("Directory import E2E");
  await page
    .locator("#project-import-identity-version")
    .fill("directory-v1");
  await page.locator("#project-import-max-files").fill("75");
  await page.locator("#project-import-max-file-mib").fill("2");
  await page.locator("#project-import-max-total-mib").fill("1");
  await page.locator("#project-import-timeout-seconds").fill("30");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.locator("#project-import-error-analysis"),
  ).toContainText("Per-file MiB must not exceed total MiB.");
  await expect(page.locator("#project-import-max-files")).toBeFocused();
  await page.locator("#project-import-max-total-mib").fill("2");
  await continueToReview(page);
  await expect(page.locator("#project-import-review-source")).toHaveText(
    "Local directory",
  );
  await expect(page.locator("#project-import-review-input")).toHaveText(
    path.basename(directoryFixture),
  );
  await expect(page.locator("#project-import-review-revision")).toHaveText(
    "Uploaded content",
  );
  await startAndWaitForImportedCity(page);
  await expect(page.locator("#model-name")).toHaveText(
    "Directory import E2E",
  );
  await expect(page.locator("#status")).toContainText("directory-v1");

  await openNextImport(page);
  await chooseSource(page, "zip");
  await page.locator("#project-import-zip").setInputFiles(zipFixture);
  await expect(page.locator("#project-import-zip-name")).toHaveValue(
    "archive-project",
  );
  await page.locator("#project-import-zip-root").selectOption(
    "archive-root",
  );
  await continueToOptions(page);
  await page
    .locator("#project-import-identity-title")
    .fill("ZIP import E2E");
  await page
    .locator("#project-import-identity-version")
    .fill("zip-v1");
  await continueToReview(page);
  await expect(page.locator("#project-import-review-source")).toHaveText(
    "ZIP archive",
  );
  await expect(page.locator("#project-import-review-input")).toHaveText(
    path.basename(zipFixture),
  );
  await startAndWaitForImportedCity(page);
  await expect(page.locator("#model-name")).toHaveText("ZIP import E2E");
  await expect(page.locator("#status")).toContainText("zip-v1");
});

test("scrubs retained ZIP source across selection, stale response, refetch, and removal", async ({
  page,
}) => {
  const sourceRequests: string[] = [];
  let releaseRemotePreview!: () => void;
  let announceRemotePreview!: () => void;
  const remotePreviewReleased = new Promise<void>((resolve) => { releaseRemotePreview = resolve; });
  const remotePreviewStarted = new Promise<void>((resolve) => { announceRemotePreview = resolve; });
  let localPreviewCalls = 0;
  let guidanceRequests = 0;
  await page.route("**/api/v1/ai/providers", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enabled: true, providers: [{ id: "remote", label: "Remote review" }, { id: "local", label: "Local model" }] }) });
  });
  await page.route("**/api/v1/ai/preview/**", async (route) => {
    const providerId = new URL(route.request().url()).pathname.split("/").at(-1)!;
    if (providerId === "remote") {
      announceRemotePreview();
      await remotePreviewReleased;
    } else {
      localPreviewCalls += 1;
    }
    const marker = providerId === "remote" ? "REMOTE-PAYLOAD" : `LOCAL-PAYLOAD-${localPreviewCalls}`;
    try {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ preview: {
        enabled: true,
        provider: { id: providerId, label: providerId === "remote" ? "Remote review" : "Local model" },
        transmission: { version: 1, task: "source-guidance", source: { path: "src/retained-large.ts", language: "typescript", text: marker, lines: { startLine: 1, endLine: 1 } }, findings: { sloc: 1, maximumComplexity: 1, decisionLoad: 0 } },
        limits: { timeoutMs: 20_000, maximumSourceBytes: 131_072 },
        privacy: "no-prompt-storage",
        grant: (providerId === "remote" ? "R" : "L").repeat(43),
      } }) });
    } catch {
      // Switching providers is expected to abort the stale remote preview.
    }
  });
  await page.route("**/api/v1/ai/requests", async (route) => {
    guidanceRequests += 1;
    if (guidanceRequests === 1) {
      await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: { code: "provider-unavailable", message: "Unavailable" } }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { provider: { id: "local", label: "Local model" }, suggestions: [{ title: "Keep it small", detail: "Extract the branch.", citation: { path: "src/retained-large.ts", startLine: 1, endLine: 1 } }] } }) });
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      request.method() === "GET" &&
      /^\/api\/v1\/artifacts\/[^/]+\/sources\/[^/]+$/u.test(
        url.pathname,
      )
    ) {
      sourceRequests.push(url.pathname);
    }
  });

  await openAuthenticatedWizard(page);
  await chooseSource(page, "zip");
  await page
    .locator("#project-import-zip")
    .setInputFiles(sourceNavigationZipFixture);
  await page.locator("#project-import-zip-root").selectOption(
    "archive-root",
  );
  await continueToOptions(page);
  await page
    .locator("#project-import-identity-title")
    .fill("Source navigation E2E");
  await continueToReview(page);
  const jobId = await startAndWaitForImportedCity(page);
  await expect(page.locator("#model-name")).toHaveText(
    "Source navigation E2E",
  );

  const cityArtifact = await server.artifacts.readCityModel(jobId);
  expect(cityArtifact).toBeDefined();
  const importedModel = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      cityArtifact!.bytes,
    ),
  ) as CityModel;
  const retainedBuilding = importedModel.buildings.find(
    ({ path: sourcePath }) =>
      sourcePath.endsWith("src/retained-large.ts"),
  );
  const siblingBuilding = importedModel.buildings.find(
    ({ path: sourcePath }) =>
      sourcePath.endsWith("src/sibling.ts"),
  );
  expect(retainedBuilding).toBeDefined();
  expect(siblingBuilding).toBeDefined();

  await page.getByRole("tab", { name: "Explore" }).click();
  await page.locator("#building-search").fill("retained-large");
  const retainedResult = page
    .locator(".search-result-button")
    .filter({ hasText: "retained-large.ts" });
  await expect(retainedResult).toHaveCount(1);
  await retainedResult.click();
  await remotePreviewStarted;
  await page.locator("#building-ai-guidance-details summary").click();
  await page.locator("#building-ai-guidance-provider").selectOption("local");
  await expect(page.locator("#building-ai-guidance-preview")).toContainText("LOCAL-PAYLOAD-1");
  releaseRemotePreview();
  await expect(page.locator("#building-ai-guidance-provider")).toHaveValue("local");
  await expect(page.locator("#building-ai-guidance-preview")).not.toContainText("REMOTE-PAYLOAD");
  await page.locator("#building-ai-guidance-request").dblclick();
  await expect.poll(() => guidanceRequests).toBe(1);
  await expect.poll(() => localPreviewCalls).toBeGreaterThanOrEqual(2);
  await expect(page.locator("#building-ai-guidance-preview")).toContainText("LOCAL-PAYLOAD-2");
  await page.locator("#building-ai-guidance-request").click();
  await expect.poll(() => guidanceRequests).toBe(2);
  await expect(page.locator("#building-ai-guidance-suggestions")).toContainText("Keep it small");

  await expect(page.locator("#building-source-status")).toContainText(
    "Showing the exact retained file",
  );
  await expect(page.locator("#building-source-code")).toContainText(
    "retained-source-sentinel",
  );
  // Fine detail is projected only for this selected file. The initial drill is
  // bounded, exposes both a type and a function, and keeps source navigation
  // exact without requesting another source artifact.
  await page.locator("#building-source-structure-details summary").click();
  await expect(page.locator("#building-source-structure-details")).toBeVisible();
  await expect(page.locator("#building-source-structure")).toContainText(
    "Function retainedComplexity",
  );
  const typeToggle = page.getByRole("button", {
    name: /Class DetailClass \(/u,
  });
  await expect(typeToggle).toHaveAttribute("aria-expanded", "false");
  await typeToggle.press("Enter");
  await expect(typeToggle).toHaveAttribute("aria-expanded", "true");
  await expect(typeToggle).toBeFocused();
  const firstMethod = page.getByRole("button", { name: /Method method0\./u });
  await expect(firstMethod).toBeVisible();
  await expect(firstMethod).toHaveAttribute(
    "title",
    /persisted syntax provenance; cyclomatic complexity 1/u,
  );
  const cameraBeforeDetail = await page.evaluate(() =>
    document.querySelector<HTMLCanvasElement>("#scene canvas")?.getBoundingClientRect().toJSON(),
  );
  const exactFunction = page.getByRole("button", {
    name: /Function sameLineExact\./u,
  });
  await expect(exactFunction).toHaveAttribute(
    "data-source-declaration-id",
    /callable:/u,
  );
  await expect(exactFunction).toHaveAttribute(
    "data-source-declaration-category",
    "callable",
  );
  await expect(exactFunction).toHaveAttribute(
    "data-source-declaration-start-line",
    /\d+/u,
  );
  await expect(exactFunction).toHaveAttribute(
    "data-source-declaration-start-column",
    /\d+/u,
  );
  await exactFunction.click();
  const highlightedLine = page.locator(".source-line-highlight").first();
  await expect(highlightedLine).toContainText("sameLinePrefix");
  await expect(highlightedLine).toContainText("sameLineSuffix");
  await expect.poll(async () =>
    (await highlightedLine.locator(".source-range-highlight").allTextContents()).join("")
  ).toBe("export function sameLineExact(): number { return 7; }");
  await expect(page.locator("#building-ai-guidance-summary")).toHaveText(
    "Declaration selected",
  );
  await expect(page.locator("#building-ai-guidance-status")).toContainText(
    "requires scoped server review support",
  );
  await expect(page.locator("#building-ai-guidance-status")).toContainText(
    "No source was sent",
  );
  await expect(page.locator("#building-ai-guidance-request")).toBeHidden();
  expect(guidanceRequests).toBe(2);
  await expect(page.locator("#building-source-structure-return")).toBeVisible();
  await page.locator("#building-source-structure-show-more").click();
  await expect(page.locator("#building-source-structure-details")).toHaveAttribute("open", "");
  await expect(page.locator("#building-source-structure-return")).toBeVisible();
  await expect(page.locator("#building-source-structure-show-more")).toBeHidden();
  await expect(page.getByRole("button", { name: /Method method44\./u })).toBeVisible();
  await page.locator("#building-source-structure-return").click();
  await expect(page.locator("#selection-name")).toHaveText("retained-large.ts");
  await expect(page.locator("#scene canvas")).toBeFocused();
  expect(await page.evaluate(() =>
    document.querySelector<HTMLCanvasElement>("#scene canvas")?.getBoundingClientRect().toJSON(),
  )).toEqual(cameraBeforeDetail);
  const sourceDetails = page.locator("#building-source-details");
  await expect(sourceDetails).not.toHaveAttribute("open", "");
  await sourceDetails.locator("summary").click();
  await expect(page.locator(".source-line-omitted")).toBeVisible();
  await expect(page.locator(".source-line-omitted").first()).toContainText(
    "…",
  );
  await expect(
    page.locator(".source-line-omitted").first(),
  ).not.toContainText("â€¦");
  await expect
    .poll(() => page.locator(".source-line").count())
    .toBeLessThanOrEqual(500);
  const structureDetails = page.locator(
    "#building-source-structure-details",
  );
  await expect(structureDetails).toBeVisible();
  await structureDetails.locator("summary").click();
  const structureJump = structureDetails.getByRole("button", {
    name: /Function retainedComplexity/u,
  });
  await expect(structureJump).toBeVisible();
  await structureJump.click();
  await expect(page.locator(".source-line-highlight").first()).toContainText(
    "export function retainedComplexity",
  );
  await structureDetails.getByRole("button", {
    name: "Return to city",
  }).click();
  await expect(structureDetails).not.toHaveAttribute("open", "");
  await expect(page.locator("#building-source-details")).not.toHaveAttribute(
    "open",
    "",
  );
  expect(guidanceRequests).toBe(2);
  await expect.poll(() => sourceRequests).toEqual([
    `/api/v1/artifacts/${jobId}/sources/${retainedBuilding!.id}`,
  ]);

  await page.locator("#building-units-details summary").click();
  const unitJump = page.locator(
    '.unit-source-jump[title^="Open retainedComplexity at line"]',
  );
  await expect(unitJump).toHaveCount(1);
  await unitJump.click();
  await expect(
    page.locator(".source-line-highlight").first(),
  ).toContainText("export function retainedComplexity");
  await expect(page.locator(".source-line-omitted")).toContainText(
    "omitted",
  );
  expect(sourceRequests).toEqual([
    `/api/v1/artifacts/${jobId}/sources/${retainedBuilding!.id}`,
  ]);
  expect(sourceRequests).not.toContain(
    `/api/v1/artifacts/${jobId}/sources/${siblingBuilding!.id}`,
  );

  const retainedUnit = retainedBuilding!.units?.find(
    ({ name }) => name === "retainedComplexity",
  );
  expect(retainedUnit).toBeDefined();
  expect(retainedUnit!.complexity).toBeGreaterThanOrEqual(15);
  expect(retainedUnit!.endLine).toBeDefined();

  await page.getByRole("tab", { name: "Metrics" }).click();
  const smellPanel = page.locator("#design-smell-panel");
  await expect(smellPanel).toHaveAttribute("aria-busy", "false", {
    timeout: 30_000,
  });
  await smellPanel
    .getByRole("button", {
      name: /High-complexity method.*retained-large\.ts/u,
    })
    .click();
  await expect(
    page.getByRole("tab", { name: "Details" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#selection-name")).toHaveText(
    "retained-large.ts",
  );
  const smellHighlights = page.locator(".source-line-highlight");
  await expect(smellHighlights.first()).toHaveAttribute(
    "data-line",
    String(retainedUnit!.line),
  );
  await expect(smellHighlights.last()).toHaveAttribute(
    "data-line",
    String(retainedUnit!.endLine),
  );

  const sourcePath =
    `/api/v1/artifacts/${jobId}/sources/${retainedBuilding!.id}`;
  const sourceCode = page.locator("#building-source-code");
  const sourceContent = page.locator("#building-source-content");
  const sourcePathLabel = page.locator("#building-source-path");
  const sourceEditor = page.locator("#building-source-editor");
  await expect(sourcePathLabel).toContainText("retained-large.ts");
  await expect(sourceEditor).toHaveAttribute(
    "href",
    /^https:\/\/editor\.example\.test\/open\?/u,
  );

  await page.getByRole("button", { name: "Clear selection" }).click();
  await expect(sourceCode).toHaveText("");
  await expect(sourceContent).toBeHidden();
  await expect(sourcePathLabel).toHaveText("");
  await expect(sourceEditor).not.toHaveAttribute("href", /.+/u);
  await expect(page.locator("#building-ai-guidance-preview")).toBeHidden();
  await expect(page.locator("#building-ai-guidance-preview")).toHaveText("");
  await expect(page.locator("#building-ai-guidance-suggestions")).toBeHidden();

  let releaseStaleResponse = (): void => undefined;
  let markStaleRequestStarted = (): void => undefined;
  let markStaleRequestFinished = (): void => undefined;
  const staleResponseGate = new Promise<void>((resolve) => {
    releaseStaleResponse = () => resolve();
  });
  const staleRequestStarted = new Promise<void>((resolve) => {
    markStaleRequestStarted = () => resolve();
  });
  const staleRequestFinished = new Promise<void>((resolve) => {
    markStaleRequestFinished = () => resolve();
  });
  await page.route(
    `**${sourcePath}`,
    async (route) => {
      markStaleRequestStarted();
      await staleResponseGate;
      try {
        const response = await route.fetch();
        await route.fulfill({ response });
      } catch {
        // Clearing the selection is expected to abort this request.
      } finally {
        markStaleRequestFinished();
      }
    },
    { times: 1 },
  );

  await page.getByRole("tab", { name: "Explore" }).click();
  await retainedResult.click();
  await staleRequestStarted;
  await expect(page.locator("#building-source-status")).toContainText(
    "Loading",
  );
  await page.getByRole("button", { name: "Clear selection" }).click();
  releaseStaleResponse();
  await staleRequestFinished;
  await page.evaluate(
    async () =>
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      }),
  );
  await expect(sourceCode).toHaveText("");
  await expect(sourceContent).toBeHidden();
  await expect(sourcePathLabel).toHaveText("");
  await expect(sourceEditor).not.toHaveAttribute("href", /.+/u);

  const requestsBeforeRefetch = sourceRequests.length;
  await page.getByRole("tab", { name: "Explore" }).click();
  await retainedResult.click();
  await expect(page.locator("#building-source-status")).toContainText(
    "Showing the exact retained file",
  );
  await expect
    .poll(() => sourceRequests.length)
    .toBeGreaterThan(requestsBeforeRefetch);
  expect(new Set(sourceRequests)).toEqual(new Set([sourcePath]));

  await page.getByRole("button", { name: "Import project" }).click();
  expect(
    await page.evaluate(() =>
      localStorage.getItem("code-city.last-import-job.v1"),
    ),
  ).toBe(jobId);
  expect(server.jobs.get(jobId)?.state).toBe("completed");
  const removeCurrentResult = page.getByRole("button", {
    name: "Remove stored import",
  });
  await expect(removeCurrentResult).toBeVisible();
  await removeCurrentResult.click();
  await expect.poll(() => server.jobs.get(jobId)).toBeUndefined();
  await expect(sourceCode).toHaveText("");
  await expect(sourceContent).toBeHidden();
  await expect(sourcePathLabel).toHaveText("");
  await expect(sourceEditor).not.toHaveAttribute("href", /.+/u);
  await expect(page.locator("#building-source-status")).toHaveText(
    "The retained source result was removed from the server.",
  );
});

test("accepts all remote sources, revisions, profiles, and server field corrections without network access", async ({
  page,
}) => {
  remoteInvocations.length = 0;
  await openAuthenticatedWizard(page);

  await chooseSource(page, "github-public");
  const historyToggle = page.locator("#project-import-history-enabled");
  await expect(historyToggle).toBeVisible();
  await expect(historyToggle).not.toBeChecked();
  await expect(
    page.locator("#project-import-history-options"),
  ).toBeHidden();
  await historyToggle.check();
  await expect(
    page.locator("#project-import-history-options"),
  ).toBeVisible();
  await page
    .locator("#project-import-history-mode")
    .selectOption("date-range");
  await expect(page.locator("#project-import-history-from")).toBeVisible();
  await page
    .locator("#project-import-history-mode")
    .selectOption("tag-range");
  await expect(
    page.locator("#project-import-history-oldest-tag"),
  ).toBeVisible();
  await historyToggle.uncheck();
  await page
    .locator("#project-import-repository-url")
    .fill(`${PUBLIC_GITHUB_URL}/tree/main`);
  await page
    .locator('input[name="project-import-revision"][value="branch"]')
    .check();
  await page.locator("#project-import-revision-value").fill("feature/e2e");
  await continueToOptions(page);
  await page
    .locator("#project-import-identity-title")
    .fill("Public GitHub E2E");
  await page
    .locator("#project-import-identity-version")
    .fill("public-v1");
  await page.locator("#project-import-max-files").fill("321");
  await page.locator("#project-import-max-file-mib").fill("1");
  await page.locator("#project-import-max-total-mib").fill("2");
  await page.locator("#project-import-timeout-seconds").fill("17");
  await continueToReview(page);
  await page.getByRole("button", { name: "Start import" }).click();
  await expect(
    page.locator("#project-import-error-repository-url"),
  ).toContainText(
    "Must be a canonical anonymous https://github.com/owner/repository URL.",
  );
  await expect(
    page.locator("#project-import-repository-url"),
  ).toBeFocused();
  await expect(
    page.locator("#project-import-repository-url"),
  ).toHaveAttribute("aria-invalid", "true");

  await page
    .locator("#project-import-repository-url")
    .fill(PUBLIC_GITHUB_URL);
  await continueToOptions(page);
  await continueToReview(page);
  await expect(page.locator("#project-import-review-revision")).toHaveText(
    "branch: feature/e2e",
  );
  await startAndWaitForImportedCity(page);
  await expect(page.locator("#model-name")).toHaveText(
    "Public GitHub E2E",
  );
  expect(lastRemoteInvocation(PUBLIC_GITHUB_URL)).toMatchObject({
    kind: "github",
    repositoryUrl: PUBLIC_GITHUB_URL,
    ref: "heads/feature/e2e",
    title: "Public GitHub E2E",
    version: "public-v1",
    maxRetainedFiles: 321,
    maxFileBytes: 1024 * 1024,
    maxTotalBytes: 2 * 1024 * 1024,
    timeoutMs: 17_000,
  });

  await openNextImport(page);
  await chooseSource(page, "github-authenticated");
  await page
    .locator("#project-import-repository-url")
    .fill(PRIVATE_GITHUB_URL);
  await page
    .locator('input[name="project-import-revision"][value="commit"]')
    .check();
  await page.locator("#project-import-revision-value").fill("abc");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator("#project-import-error-profile")).toContainText(
    "Choose a configured GitHub profile.",
  );
  await expect(page.locator("#project-import-error-revision")).toContainText(
    "Enter an exact 40-character commit SHA.",
  );
  await page
    .locator("#project-import-profile")
    .selectOption({ label: "E2E GitHub profile" });
  await page.locator("#project-import-revision-value").fill(COMMIT);
  await continueToOptions(page);
  await page
    .locator("#project-import-identity-title")
    .fill("Authenticated GitHub E2E");
  await continueToReview(page);
  await startAndWaitForImportedCity(page);
  await expect(page.locator("#model-name")).toHaveText(
    "Authenticated GitHub E2E",
  );
  expect(lastRemoteInvocation(PRIVATE_GITHUB_URL)).toMatchObject({
    kind: "github",
    repositoryUrl: PRIVATE_GITHUB_URL,
    ref: COMMIT,
    credentialProvider: "github",
  });

  await openNextImport(page);
  await chooseSource(page, "azure-devops");
  await page
    .locator("#project-import-repository-url")
    .fill(AZURE_DEVOPS_URL);
  await page
    .locator("#project-import-profile")
    .selectOption({ label: "E2E Azure DevOps profile" });
  await page
    .locator('input[name="project-import-revision"][value="tag"]')
    .check();
  await page.locator("#project-import-revision-value").fill("release/v1");
  await continueToOptions(page);
  await page
    .locator("#project-import-identity-title")
    .fill("Azure DevOps E2E");
  await continueToReview(page);
  await expect(page.locator("#project-import-review-revision")).toHaveText(
    "tag: release/v1",
  );
  await startAndWaitForImportedCity(page);
  await expect(page.locator("#model-name")).toHaveText("Azure DevOps E2E");
  expect(lastRemoteInvocation(AZURE_DEVOPS_URL)).toMatchObject({
    kind: "git",
    repositoryUrl: AZURE_DEVOPS_URL,
    ref: "refs/tags/release/v1",
    credentialProvider: "basic",
  });

  await openNextImport(page);
  await chooseSource(page, "git");
  await page
    .locator("#project-import-repository-url")
    .fill(GENERIC_GIT_URL);
  await page
    .locator("#project-import-profile")
    .selectOption({ label: "E2E Generic Git profile" });
  await continueToOptions(page);
  await page
    .locator("#project-import-identity-title")
    .fill("Generic Git E2E");
  await continueToReview(page);
  await expect(page.locator("#project-import-review-revision")).toHaveText(
    "Repository default",
  );
  await startAndWaitForImportedCity(page);
  await expect(page.locator("#model-name")).toHaveText("Generic Git E2E");
  expect(lastRemoteInvocation(GENERIC_GIT_URL)).toMatchObject({
    kind: "git",
    repositoryUrl: GENERIC_GIT_URL,
    credentialProvider: "basic",
  });
  expect(lastRemoteInvocation(GENERIC_GIT_URL)).not.toHaveProperty("ref");
});

test("cancels an accepted remote import and removes its private staging data", async ({
  page,
}) => {
  await openAuthenticatedWizard(page);
  await chooseSource(page, "git");
  await page
    .locator("#project-import-repository-url")
    .fill(CANCELLATION_GIT_URL);
  await page
    .locator("#project-import-profile")
    .selectOption({ label: "E2E Generic Git profile" });
  await page
    .locator('input[name="project-import-revision"][value="branch"]')
    .check();
  await page.locator("#project-import-revision-value").fill("cancel-e2e");
  await continueToOptions(page);
  await page
    .locator("#project-import-identity-title")
    .fill("Sensitive cancellation title");
  await continueToReview(page);
  await page.getByRole("button", { name: "Start import" }).click();
  await expect(page.getByRole("button", { name: "Cancel import" }))
    .toBeVisible({ timeout: 15_000 });
  await expect.poll(
    () => lastRemoteInvocation(CANCELLATION_GIT_URL),
  ).toBeDefined();
  await expect.poll(() =>
    page.evaluate(() =>
      localStorage.getItem("code-city.last-import-job.v1"),
    ),
  ).not.toBeNull();
  const jobId = await page.evaluate(() =>
    localStorage.getItem("code-city.last-import-job.v1"),
  );
  await expect(
    page.locator("#project-import-repository-url"),
  ).toHaveValue("");
  await expect(
    page.locator("#project-import-identity-title"),
  ).toHaveValue("");

  await page.getByRole("button", { name: "Cancel import" }).click();
  await expect(page.locator("#project-import-status")).toHaveText(
    "Import cancelled",
    { timeout: 15_000 },
  );
  await expect.poll(() => server.jobs.get(jobId!)?.state).toBe(
    "cancelled",
  );
  await expect.poll(async () =>
    fs.readdir(path.join(dataDirectory, "tmp", "imports")),
  ).toEqual([]);
  expect(await server.artifacts.statCityModel(jobId!)).toBeUndefined();
  expect(lastRemoteInvocation(CANCELLATION_GIT_URL)).toMatchObject({
    kind: "git",
    repositoryUrl: CANCELLATION_GIT_URL,
    ref: "refs/heads/cancel-e2e",
    credentialProvider: "basic",
  });
});
