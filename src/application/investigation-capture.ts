import type { InvestigationOrigin } from "./investigation-origin";
import type { BaseMetricAnalysis } from "../domain/base-metrics";
import type { InspectionEvidence } from "./unit-inspection";
import type { ProjectAnalysis } from "./project-analysis";
import { SAVE_LIMITS, sourceSha256, cityForSnapshot, snapshotPrefix, validateSavedHeader, type SavedContribution, type SavedHeader, type SavedUnit, type SourceSection } from "./saved-investigation";
import { compareUnsignedUtf8, FIXED_EXCLUDED_SEGMENTS } from "../domain/source-admission";

/** Save-only evidence budget; exhaustion never changes analysis admission/results. */
export function createInvestigationCapture() {
  const evidence = new Map<string, { units: SavedUnit[]; contributions: SavedContribution[] }>();
  const inspections = new Map<string, InspectionEvidence>();
  const owners = new Map<string, { values: number[]; counts: number[]; total: number }>();
  let metadataBytes = 0, complete = true;
  const disable = (): void => { complete = false; evidence.clear(); };
  const entry = (path: string) => { let value = evidence.get(path); if (!value) { value = { units: [], contributions: [] }; evidence.set(path, value); } return value; };
  const append = (path: string, value: SavedUnit | SavedContribution, units: boolean): void => {
    if (!complete) return;
    metadataBytes += JSON.stringify(value).length + 1;
    if (metadataBytes > 12 * 1_048_576) { disable(); return; }
    if (units) entry(path).units.push(value as SavedUnit); else entry(path).contributions.push(value as SavedContribution);
  };
  return {
    contribution(path: string, owner: number, kind: string, start: number, end: number): void {
      try {
        let runs = owners.get(path);
        if (!runs) { runs = { values: [], counts: [], total: 0 }; owners.set(path, runs); }
        const last = runs.values.length - 1;
        if (runs.values[last] === owner) runs.counts[last] = runs.counts[last]! + 1;
        else { runs.values.push(owner); runs.counts.push(1); }
        runs.total++;
      } catch { owners.delete(path); }
      try { append(path, [owner, kind, start, end], false); } catch { disable(); }
    },
    module(path: string, analysis: BaseMetricAnalysis, complexities: Readonly<Float64Array>): void {
      try {
        const runs = owners.get(path) ?? { values: [], counts: [], total: 0 };
        owners.delete(path);
        const values = Uint32Array.from(runs.values), counts = Uint32Array.from(runs.counts);
        inspections.set(path, {
          units: { length: analysis.units.length, at(index) {
            const unit = analysis.units.at(index);
            return unit ? { kind: unit.kind, startByte: unit.kind === "top-level" ? 0 : unit.startByte, endByte: unit.kind === "top-level" ? 0 : unit.endByte, complexity: complexities[index]! } : undefined;
          } },
          contributionCount: runs.total,
          *contributions() {
            let run = 0, remaining = counts[0] ?? 0;
            for (const row of analysis.observations) if (row.kind === "decision") {
              if (remaining === 0) { run++; remaining = counts[run] ?? 0; }
              if (remaining === 0) throw new Error("Missing contribution owner");
              remaining--;
              yield [values[run]!, row.decisionKind, row.startByte, row.endByte] as const;
            }
          },
        });
      } catch { inspections.delete(path); }
      try {
        let index = 0;
        if (complete) entry(path);
        for (const unit of analysis.units) {
          if (!complete) break;
          const top = unit.kind === "top-level";
          append(path, [unit.kind, top ? 0 : unit.startByte, top ? 0 : unit.endByte,
            top ? [] : unit.ownedRegions.flatMap(region => [region.startByte, region.endByte]), complexities[index++]!], true);
        }
      } catch { disable(); }
    },
    inspection(path: string): InspectionEvidence | undefined { return inspections.get(path); },
    async snapshot(origin: InvestigationOrigin, exclusions: readonly string[], result: ProjectAnalysis, analyzer: string): Promise<Blob> {
      if (!complete) throw new Error("Investigation exceeds Save limits");
      const sections: Uint8Array[] = [];
      const descriptor = async (bytes: Uint8Array): Promise<SourceSection> => ({ length: bytes.length,
        sha256: await sourceSha256(bytes) });
      const facts = new Map(result.city?.inspection.map(fact => [fact.canonicalPath, fact]) ?? []);
      const failures = new Map(result.notAnalyzedFiles.map(failure => [failure.canonicalPath, failure.category]));
      const normalized = new Map(result.sources.map(source => [source.canonicalPath, source.normalizedUtf8]));
      const paths = [...facts.keys(), ...failures.keys()].sort(compareUnsignedUtf8);
      if (new Set(paths).size !== paths.length || normalized.size !== result.sources.length
        || result.sources.some(source => !facts.has(source.canonicalPath) && !failures.has(source.canonicalPath))
        || paths.some(path => (failures.get(path) === "Source text is not supported") === normalized.has(path))) throw new Error("Complete source evidence is unavailable");
      const files: SavedHeader["files"] = [];
      const hierarchy = new Set<string>();
      for (const path of paths) {
        const parts = path.split("/"); for (let index = 1; index < parts.length; index++) hierarchy.add(parts.slice(0, index).join("/"));
        const norm = normalized.get(path), fact = facts.get(path);
        const captured = fact ? evidence.get(path) : undefined;
        if (fact && (!captured || captured.units.length !== fact.U)) throw new Error("Complete unit evidence is unavailable");
        files.push({ path, normalized: norm ? await descriptor(norm) : null,
          outcome: fact ? "success" : failures.get(path)!, fact: fact ?? null, units: captured?.units.map(unit => unit[0] === "top-level" ? [unit[0], 0, norm!.length, unit[3], unit[4]] : unit) ?? [], contributions: captured?.contributions ?? [] });
        if (norm) sections.push(norm);
      }
      const header: SavedHeader = { version: 3, analyzer, origin, exclusions: [...exclusions], fixedExcludedSegments: [...FIXED_EXCLUDED_SEGMENTS], hierarchy: [...hierarchy].sort(compareUnsignedUtf8), files, city: cityForSnapshot(result.city) };
      validateSavedHeader(header);
      const encoded = new TextEncoder().encode(JSON.stringify(header));
      const blob = new Blob([snapshotPrefix(encoded).buffer, encoded.buffer, ...sections.map(bytes => bytes.slice().buffer)], { type: "application/octet-stream" });
      if (blob.size > SAVE_LIMITS.snapshot) throw new Error("Investigation exceeds Save limits");
      return blob;
    },
  };
}
