import { resolveRevision, type RevisionGateway } from "./resolution";
import { acquireProjectSources, type ImmutableRawSourceGateway } from "./source-retrieval";
import { analyzeProjectSources, type ProjectAnalysis } from "./project-analysis";
import { buildCity } from "../domain/city-model";
import type { RepositoryReference } from "../domain/repository-reference";
import type { SyntaxProjectionCapability } from "./base-metric-processing";

export type AnalysisProgress =
  | Readonly<{ stage: "acquisition" | "analysis"; completed: number; total: number }>
  | Readonly<{ stage: "analysis-initialization" | "city-construction" }>;
export type RepositoryAnalysisResult =
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "failure"; category: string; code?: string; revision?: string }>
  | Readonly<{ kind: "success"; revision: string; result: ProjectAnalysis }>;
export type RepositoryAnalysisDependencies = Readonly<{
  revisionGateway: RevisionGateway;
  sourceGateway: ImmutableRawSourceGateway;
  parser: SyntaxProjectionCapability;
  capture?: Parameters<typeof analyzeProjectSources>[3];
}>;

/** One execution-neutral acquisition/analysis path; edges own worker lifetime. */
export async function analyzeRepository(
  repository: RepositoryReference,
  additionalExclusions: readonly string[],
  signal: AbortSignal,
  dependencies: RepositoryAnalysisDependencies,
  onRevision: (revision: string) => void,
  onProgress: (progress: AnalysisProgress) => void,
): Promise<RepositoryAnalysisResult> {
  let revision: string | undefined;
  try {
    const resolution = await resolveRevision(repository, signal, dependencies.revisionGateway);
    if (signal.aborted || resolution.kind === "cancelled") return { kind: "cancelled" };
    if (resolution.kind === "failure") return resolution;
    revision = resolution.revision;
    onRevision(revision);
    const acquired = await acquireProjectSources(repository, revision, signal, dependencies.sourceGateway, (ownership) => {
      if ((ownership.phase === "provider-candidate" || (ownership.phase === "provider-cleared" && !ownership.projectedInventory))
        && ownership.candidateIndex !== undefined && ownership.candidateCount !== undefined) {
        onProgress({ stage: "acquisition", completed: ownership.candidateIndex, total: ownership.candidateCount });
      }
    }, additionalExclusions);
    if (signal.aborted || acquired.kind === "cancelled") return { kind: "cancelled" };
    if (acquired.kind === "failure") return { ...acquired, revision };
    onProgress({ stage: "analysis-initialization" });
    const total = acquired.modules.length;
    let completed = 0;
    const parser: SyntaxProjectionCapability = {
      async initialize() {
        await dependencies.parser.initialize();
        if (total > 0) onProgress({ stage: "analysis", completed: 0, total });
      },
      async project(family, source) {
        let projected: Awaited<ReturnType<SyntaxProjectionCapability["project"]>>;
        try { projected = await dependencies.parser.project(family, source); }
        catch (error) { onProgress({ stage: "analysis", completed: ++completed, total }); throw error; }
        return {
          observations: projected.observations,
          release() {
            projected.release();
            onProgress({ stage: "analysis", completed: ++completed, total });
          },
        };
      },
    };
    const analysis = await analyzeProjectSources(acquired, parser, (facts) => {
      onProgress({ stage: "city-construction" });
      return buildCity(facts);
    }, dependencies.capture);
    if (signal.aborted) return { kind: "cancelled" };
    return analysis.kind === "failure" ? { ...analysis, revision } : { kind: "success", revision, result: analysis.result };
  } catch {
    return signal.aborted ? { kind: "cancelled" } : {
      kind: "failure", category: "Provider/resolution failure", ...(revision === undefined ? {} : { revision }),
    };
  }
}
