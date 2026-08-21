import {
  deriveBaseMetricAnalysis,
  selectGrammarFamily,
  type BaseMetricAnalysis,
  type GrammarFamily,
} from "../domain/base-metrics";
import type { AdmittedModule } from "../domain/source-admission";

export type SyntaxProjectionCapability = Readonly<{
  initialize(): Promise<void>;
  project(grammarFamily: GrammarFamily, normalizedSource: string): Promise<Readonly<{
    observations: Parameters<typeof deriveBaseMetricAnalysis>[2];
    release(): void;
  }>>;
}>;

export type MetricProcessingEvent = "source-acquired" | "source-released" | "analysis-retained";

export type BaseMetricProcessingResult =
  | Readonly<{ kind: "processed"; analyses: readonly BaseMetricAnalysis[] }>
  | Readonly<{ kind: "failure"; category: "Metric processing failed"; code: "M1-MET-1" }>;

export async function processAdmittedBaseMetrics(
  admittedModules: AdmittedModule[],
  parser: SyntaxProjectionCapability,
  observe: (event: MetricProcessingEvent) => void = () => {},
): Promise<BaseMetricProcessingResult> {
  const queue: (AdmittedModule | undefined)[] = admittedModules;
  const analyses: BaseMetricAnalysis[] = [];

  function releaseSource(index: number): void {
    if (queue[index]) {
      queue[index] = undefined;
      observe("source-released");
    }
  }

  try {
    await parser.initialize();
    for (let index = 0; index < queue.length; index += 1) {
      const module = queue[index];
      if (!module) throw new Error("Missing admitted module");
      observe("source-acquired");
      let stream: Awaited<ReturnType<SyntaxProjectionCapability["project"]>> | undefined;
      try {
        stream = await parser.project(selectGrammarFamily(module.canonicalPath), module.normalizedSource);
        const analysis = deriveBaseMetricAnalysis(module.canonicalPath, module.normalizedSource, stream.observations);
        analyses.push(analysis);
        observe("analysis-retained");
      } finally {
        stream?.release();
        releaseSource(index);
      }
    }
    return { kind: "processed", analyses };
  } catch {
    analyses.length = 0;
    for (let index = 0; index < queue.length; index += 1) releaseSource(index);
    return { kind: "failure", category: "Metric processing failed", code: "M1-MET-1" };
  }
}
