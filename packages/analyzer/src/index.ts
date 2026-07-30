import type { CityModel } from "../../core/src/index.js";

import { cityModelFromFacts } from "./city-model.js";
import {
  analyzeLocalFacts,
  analyzeRepositorySnapshotFacts,
} from "./discovery.js";
import {
  snapshotGenericGitRepository,
  type GenericGitSnapshotDependencies,
  type GenericGitTransport,
} from "./git-snapshot.js";
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
export * from "./city-model.js";
export * from "./discovery.js";
export * from "./evolution-analysis.js";
export * from "./filesystem.js";
export * from "./generic-git-history-analysis.js";
export * from "./git-snapshot.js";
export * from "./github-snapshot.js";
export * from "./history-selection.js";
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

export interface GenericGitRepositoryRequest {
  readonly repositoryUrl: string;
  readonly ref?: string;
}

export interface GenericGitAnalysisResult {
  readonly repository: string;
  readonly commitSha: string;
  readonly transport: GenericGitTransport;
  readonly model: CityModel;
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

export async function analyzeGenericGitRepository(
  request: GenericGitRepositoryRequest,
  options: LocalAnalysisOptions = {},
  dependencies?: GenericGitSnapshotDependencies,
): Promise<GenericGitAnalysisResult> {
  const startedAt = Date.now();
  const totalTimeout =
    options.timeoutMs ?? DEFAULT_SNAPSHOT_LIMITS.timeoutMs;
  const result = await snapshotGenericGitRepository(
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
  const model = await analyzeRepositorySnapshots([result.snapshot], {
    ...options,
    title: options.title ?? result.repository,
    version: options.version ?? result.commitSha,
    timeoutMs: remainingTimeout,
  });
  return Object.freeze({
    repository: result.repository,
    commitSha: result.commitSha,
    transport: result.transport,
    model,
  });
}
