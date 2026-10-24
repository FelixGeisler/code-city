import { deriveBaseMetricAnalysis, selectGrammarFamily } from "../domain/base-metrics";
import { buildCity } from "../domain/city-model";
import { finalizeModuleComplexity, type ModuleComplexityFact } from "../domain/complexity";
import { compareUnsignedUtf8 } from "../domain/source-admission";
import type { CityPayload } from "./city-payload";
import type { SyntaxProjectionCapability } from "./base-metric-processing";
import type { AcquiredProjectSources, FailedFile } from "./source-retrieval";

export type RetainedProjectSource = Readonly<{
  canonicalPath: string;
  normalizedUtf8: Uint8Array;
}>;

export type ProjectAnalysis = Readonly<{
  city: CityPayload | null;
  notAnalyzedFiles: FailedFile[];
  sources: RetainedProjectSource[];
}>;

export type ProjectAnalysisResult =
  | Readonly<{ kind: "analyzed"; result: ProjectAnalysis }>
  | Readonly<{ kind: "failure"; category: "Metric processing failed"; code: "M1-MET-1" }>
  | Readonly<{ kind: "failure"; category: "City construction failed"; code: "M1-CITY-1" }>;

const metricFailure = (): ProjectAnalysisResult => ({
  kind: "failure",
  category: "Metric processing failed",
  code: "M1-MET-1",
});

const cityFailure = (): ProjectAnalysisResult => ({
  kind: "failure",
  category: "City construction failed",
  code: "M1-CITY-1",
});

function sortedUniquePaths(rows: Readonly<{ canonicalPath: string }>[]): boolean {
  rows.sort((left, right) => compareUnsignedUtf8(left.canonicalPath, right.canonicalPath));
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index - 1]!.canonicalPath === rows[index]!.canonicalPath) return false;
  }
  return true;
}

function ownData(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) throw new Error("Missing city record");
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) throw new Error("Missing city field");
  return descriptor.value;
}

function cityHasRequiredOwnership(city: CityPayload, facts: readonly ModuleComplexityFact[]): boolean {
  try {
    const geometry = ownData(city, "geometry");
    const inspection = ownData(city, "inspection");
    const count = ownData(geometry, "count");
    const origins = ownData(geometry, "origins");
    const sizes = ownData(geometry, "sizes");
    const rgba = ownData(geometry, "rgba");
    const bounds = ownData(geometry, "bounds");
    if (!Array.isArray(inspection)
      || !Number.isSafeInteger(count)
      || count !== inspection.length
      || inspection.length !== facts.length) return false;

    for (let index = 0; index < facts.length; index += 1) {
      if (ownData(inspection[index], "canonicalPath") !== facts[index]!.canonicalPath) return false;
    }

    const views = [origins, sizes, rgba, bounds];
    if (views.some((view) => !ArrayBuffer.isView(view))) return false;
    const buffers = views.map((view) => (view as ArrayBufferView).buffer);
    return new Set(buffers).size === buffers.length;
  } catch {
    return false;
  }
}

export async function analyzeProjectSources(
  acquired: AcquiredProjectSources,
  parser: SyntaxProjectionCapability,
  constructCity: (facts: readonly ModuleComplexityFact[]) => CityPayload = buildCity,
): Promise<ProjectAnalysisResult> {
  const facts: ModuleComplexityFact[] = [];
  const notAnalyzedFiles: FailedFile[] = acquired.notAnalyzedFiles.map((failure) => ({ ...failure }));
  const sources: RetainedProjectSource[] = acquired.modules.map((module) => ({
    canonicalPath: module.canonicalPath,
    normalizedUtf8: module.normalizedUtf8,
  }));

  const attemptedPaths = [
    ...acquired.modules.map(({ canonicalPath }) => ({ canonicalPath })),
    ...acquired.notAnalyzedFiles.map(({ canonicalPath }) => ({ canonicalPath })),
  ];
  if (!sortedUniquePaths(attemptedPaths)
    || acquired.modules.some(({ normalizedUtf8 }) => (
      Object.getPrototypeOf(normalizedUtf8) !== Uint8Array.prototype
      || !(normalizedUtf8.buffer instanceof ArrayBuffer)
      || normalizedUtf8.byteOffset !== 0
      || normalizedUtf8.byteLength !== normalizedUtf8.buffer.byteLength
    ))) return metricFailure();

  try {
    await parser.initialize();
  } catch {
    return metricFailure();
  }

  for (const module of acquired.modules) {
    let stream: Awaited<ReturnType<SyntaxProjectionCapability["project"]>>;
    try {
      stream = await parser.project(selectGrammarFamily(module.canonicalPath), module.normalizedSource);
    } catch {
      notAnalyzedFiles.push({ canonicalPath: module.canonicalPath, category: "Syntax could not be analyzed" });
      continue;
    }

    let fact: ModuleComplexityFact | undefined;
    let releaseFailed = false;
    try {
      const analysis = deriveBaseMetricAnalysis(module.canonicalPath, module.normalizedSource, stream.observations);
      fact = finalizeModuleComplexity(analysis).fact;
    } catch {
      notAnalyzedFiles.push({ canonicalPath: module.canonicalPath, category: "Metrics could not be computed" });
    } finally {
      try {
        stream.release();
      } catch {
        releaseFailed = true;
      }
    }
    if (releaseFailed) {
      facts.length = 0;
      notAnalyzedFiles.length = 0;
      sources.length = 0;
      return metricFailure();
    }
    if (fact) facts.push(fact);
  }

  if (!sortedUniquePaths(facts)
    || !sortedUniquePaths(notAnalyzedFiles)
    || !sortedUniquePaths(sources)) return metricFailure();

  const successfulPaths = new Set(facts.map(({ canonicalPath }) => canonicalPath));
  const failedPaths = new Set(notAnalyzedFiles.map(({ canonicalPath }) => canonicalPath));
  const sourcePaths = new Set(sources.map(({ canonicalPath }) => canonicalPath));
  if (successfulPaths.size + failedPaths.size !== attemptedPaths.length
    || [...successfulPaths].some((path) => failedPaths.has(path))
    || attemptedPaths.some(({ canonicalPath }) => !successfulPaths.has(canonicalPath) && !failedPaths.has(canonicalPath))
    || sourcePaths.size !== acquired.modules.length
    || acquired.modules.some(({ canonicalPath }) => !sourcePaths.has(canonicalPath))) return metricFailure();

  if (facts.length === 0) {
    if (notAnalyzedFiles.length === 0) return metricFailure();
    return { kind: "analyzed", result: { city: null, notAnalyzedFiles, sources } };
  }

  try {
    const city = constructCity(facts);
    if (!cityHasRequiredOwnership(city, facts)) throw new Error("Invalid city ownership");
    return { kind: "analyzed", result: { city, notAnalyzedFiles, sources } };
  } catch {
    facts.length = 0;
    notAnalyzedFiles.length = 0;
    sources.length = 0;
    return cityFailure();
  }
}
