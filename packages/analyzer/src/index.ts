import {
  CITY_MODEL_SCHEMA_VERSION,
  DEFAULT_METRIC_MAPPING,
  DEFAULT_SEMANTIC_GROUPS,
  layoutCity,
  validateCityModel,
} from "../../core/src/index.js";
import type { CityModel } from "../../core/src/index.js";

import {
  analyzeLocalFacts,
  analyzeRepositorySnapshotFacts,
} from "./discovery.js";
import {
  snapshotPublicGitHubRepository,
  type GitHubSnapshotDependencies,
} from "./github-snapshot.js";
import {
  DEFAULT_SNAPSHOT_LIMITS,
  SnapshotDeadlineError,
} from "./snapshot.js";
import type { RepositorySnapshot } from "./snapshot.js";
import type {
  LocalAnalysisFacts,
  LocalAnalysisOptions,
} from "./types.js";

export * from "./csharp-lexical.js";
export * from "./discovery.js";
export * from "./filesystem.js";
export * from "./github-snapshot.js";
export * from "./local-snapshot.js";
export * from "./roslyn-host.js";
export * from "./snapshot.js";
export * from "./typescript-metrics.js";
export * from "./types.js";
export * from "./zip-snapshot-source.js";

export interface PublicGitHubRepositoryRequest {
  readonly repositoryUrl: string;
  readonly ref?: string;
}

export interface PublicGitHubAnalysisResult {
  readonly owner: string;
  readonly repository: string;
  readonly canonicalRepositoryUrl: string;
  readonly commitSha: string;
  readonly model: CityModel;
}

function cityModelFromFacts(facts: LocalAnalysisFacts): CityModel {
  const layout = layoutCity({
    repositories: facts.repositories,
    modules: facts.modules,
    buildings: facts.sources.map((source) => ({
      repositoryId: source.repositoryId,
      moduleId: source.moduleId,
      name: source.name,
      path: source.path,
      language: source.language,
      metrics: source.metrics,
      metricMethod: source.metricMethod,
      units: source.units,
      semanticGroupId: source.semanticGroupId,
    })),
    ...(facts.identity === undefined ? {} : { identity: facts.identity }),
  });

  return validateCityModel({
    schemaVersion: CITY_MODEL_SCHEMA_VERSION,
    generator: {
      name: "code-city",
      version: "0.1.0",
    },
    repositories: facts.repositories,
    solutions: facts.solutions,
    modules: facts.modules,
    semanticGroups: DEFAULT_SEMANTIC_GROUPS,
    metricMapping: DEFAULT_METRIC_MAPPING,
    analysis: { warnings: facts.warnings },
    ...(layout.identity === undefined ? {} : { identity: layout.identity }),
    ...(layout.identityPanel === undefined
      ? {}
      : { identityPanel: layout.identityPanel }),
    ...(layout.base === undefined ? {} : { base: layout.base }),
    districts: layout.districts,
    buildings: layout.buildings,
    dependencies: facts.dependencies,
    bounds: layout.bounds,
  });
}

export async function analyzeRepositorySnapshots(
  snapshots: readonly RepositorySnapshot[],
  options: LocalAnalysisOptions = {},
): Promise<CityModel> {
  return cityModelFromFacts(
    await analyzeRepositorySnapshotFacts(snapshots, options),
  );
}

export async function analyzeLocalRepositories(
  roots: readonly string[],
  options: LocalAnalysisOptions = {},
): Promise<CityModel> {
  return cityModelFromFacts(await analyzeLocalFacts(roots, options));
}

export async function analyzePublicGitHubRepository(
  request: PublicGitHubRepositoryRequest,
  options: LocalAnalysisOptions = {},
  dependencies?: GitHubSnapshotDependencies,
): Promise<PublicGitHubAnalysisResult> {
  const startedAt = Date.now();
  const totalTimeout =
    options.timeoutMs ?? DEFAULT_SNAPSHOT_LIMITS.timeoutMs;
  const result = await snapshotPublicGitHubRepository(
    {
      ...request,
      snapshotOptions: options,
      timeoutMs: totalTimeout,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
    dependencies,
  );
  const remainingTimeout = totalTimeout - (Date.now() - startedAt);
  if (remainingTimeout <= 0) throw new SnapshotDeadlineError();
  const commitSha = result.commitSha;
  const model = await analyzeRepositorySnapshots([result.snapshot], {
    ...options,
    title: options.title ?? result.repository,
    version: options.version ?? commitSha,
    timeoutMs: remainingTimeout,
  });
  return Object.freeze({
    owner: result.owner,
    repository: result.repository,
    canonicalRepositoryUrl: result.canonicalRepositoryUrl,
    commitSha,
    model,
  });
}
