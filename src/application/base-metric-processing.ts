import {
  deriveBaseMetricAnalysis,
  selectGrammarFamily,
  type GrammarFamily,
} from "../domain/base-metrics";
import {
  finalizeModuleComplexity,
  type ModuleComplexityFact,
} from "../domain/complexity";
import {
  compareUnsignedUtf8,
  type AdmittedModule,
} from "../domain/source-admission";

export type SyntaxProjectionCapability = Readonly<{
  initialize(): Promise<void>;
  project(grammarFamily: GrammarFamily, normalizedSource: string): Promise<Readonly<{
    observations: Parameters<typeof deriveBaseMetricAnalysis>[2];
    release(): void;
  }>>;
}>;

export type MetricProcessingEvent = "source-acquired" | "source-released" | "fact-retained";

export type BaseMetricProcessingResult =
  | Readonly<{ kind: "processed"; facts: readonly ModuleComplexityFact[] }>
  | Readonly<{ kind: "failure"; category: "Metric processing failed"; code: "M1-MET-1" }>;

export async function processAdmittedBaseMetrics(
  admittedModules: AdmittedModule[],
  parser: SyntaxProjectionCapability,
  observe: (event: MetricProcessingEvent) => void = () => {},
): Promise<BaseMetricProcessingResult> {
  const queue: (AdmittedModule | undefined)[] = admittedModules;
  const facts: ModuleComplexityFact[] = [];

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
        const { fact } = finalizeModuleComplexity(analysis);
        facts.push(fact);
        observe("fact-retained");
      } finally {
        stream?.release();
        releaseSource(index);
      }
    }
    facts.sort((left, right) => compareUnsignedUtf8(left.canonicalPath, right.canonicalPath));
    for (let index = 1; index < facts.length; index += 1) {
      if (facts[index - 1]!.canonicalPath === facts[index]!.canonicalPath) throw new Error("Duplicate canonical path");
    }
    return { kind: "processed", facts };
  } catch {
    facts.length = 0;
    for (let index = 0; index < queue.length; index += 1) releaseSource(index);
    return { kind: "failure", category: "Metric processing failed", code: "M1-MET-1" };
  }
}
