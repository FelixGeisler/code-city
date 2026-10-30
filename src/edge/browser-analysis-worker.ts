import { analyzeRepository } from "../application/analyze-repository";
import type { ProjectAnalysis } from "../application/project-analysis";
import { validateCityPayload } from "../application/city-payload";
import { parseRepositoryReference } from "../domain/repository-reference";
import { parseAdditionalExclusions } from "../domain/source-admission";
import { createGithubRevisionGateway } from "./github-revision-gateway";
import { createGithubRawSourceGateway } from "./github-source-gateway";
import { createTreeSitterAdapter } from "./tree-sitter-adapter";

const scope: DedicatedWorkerGlobalScope = self;
const assets = {
  runtimeJavaScript: new URL("/parser/web-tree-sitter.js", scope.location.origin).href,
  runtimeWasm: new URL("/parser/web-tree-sitter.wasm", scope.location.origin).href,
  grammarJavaScript: new URL("/parser/tree-sitter-javascript.wasm", scope.location.origin).href,
  grammarTypeScript: new URL("/parser/tree-sitter-typescript.wasm", scope.location.origin).href,
  grammarTsx: new URL("/parser/tree-sitter-tsx.wasm", scope.location.origin).href,
  grammarCSharp: new URL("/parser/tree-sitter-c-sharp.wasm", scope.location.origin).href,
};
let started = false;
let controller: AbortController | undefined;
let identity: Readonly<{ sessionId: string; generation: number }> | undefined;
let current: ProjectAnalysis | undefined;

scope.addEventListener("message", (event: MessageEvent<unknown>) => {
  const value = event.data as Record<string, unknown> | null;
  if (!value || typeof value !== "object") return;
  if (value.type === "STOP" && identity && value.sessionId === identity.sessionId && value.generation === identity.generation) {
    controller?.abort();
    if (current) { current = undefined; scope.close(); }
    return;
  }
  if (value.type !== "START" || started || typeof value.sessionId !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value.sessionId)
    || typeof value.generation !== "number" || !Number.isSafeInteger(value.generation) || value.generation < 1
    || typeof value.repositoryUrl !== "string" || typeof value.additionalExclusions !== "string") return;
  const repository = parseRepositoryReference(value.repositoryUrl);
  const exclusions = parseAdditionalExclusions(value.additionalExclusions);
  if (!repository || !exclusions) { scope.close(); return; }
  started = true;
  identity = { sessionId: value.sessionId, generation: value.generation };
  controller = new AbortController();
  const signal = controller.signal;
  let selectedRevision: string | undefined;
  const send = (type: string, payload: Record<string, unknown> = {}): void => scope.postMessage({ type, ...identity, ...payload });
  void (async () => {
    const outcome = await analyzeRepository(repository, exclusions, signal, {
      revisionGateway: createGithubRevisionGateway(fetch),
      sourceGateway: createGithubRawSourceGateway(fetch),
      parser: createTreeSitterAdapter(assets),
    }, (revision) => { selectedRevision = revision; send("REVISION_SELECTED", { revision }); },
    (progress) => send("ANALYSIS_PROGRESS", { revision: selectedRevision, ...progress }));
    if (outcome.kind === "cancelled") { send("ANALYSIS_CANCELLED"); scope.close(); return; }
    if (outcome.kind === "failure") {
      send("ANALYSIS_FAILED", {
        category: outcome.category,
        ...(outcome.revision === undefined ? {} : { revision: outcome.revision }),
        ...(outcome.code === undefined ? {} : { code: outcome.code }),
      });
      scope.close();
      return;
    }
    current = outcome.result;
    if (current.city === null) {
      send("ANALYSIS_ALL_FILES_FAILED", { revision: outcome.revision, notAnalyzedFiles: current.notAnalyzedFiles });
      return;
    }
    try {
      const city = validateCityPayload(current.city);
      send("ANALYSIS_SUCCEEDED", {
        revision: outcome.revision,
        notAnalyzedFiles: current.notAnalyzedFiles,
        city: {
          geometry: { ...city.geometry, origins: Array.from(city.geometry.origins), sizes: Array.from(city.geometry.sizes), rgba: Array.from(city.geometry.rgba), bounds: Array.from(city.geometry.bounds) },
          inspection: city.inspection.map(({ canonicalPath, S, U, M }) => ({ canonicalPath, S, U, M })),
          presentation: {
            plates: city.presentation.plates.map(({ minimum, dimensions }) => ({ minimum: [...minimum], dimensions: [...dimensions] })),
            sceneBounds: [...city.presentation.sceneBounds], centre: [...city.presentation.centre],
          },
          districts: city.districts.map(({ root, identity: districtIdentity }) => ({ root, identity: districtIdentity })),
        },
      });
    } catch {
      current = undefined;
      send("ANALYSIS_FAILED", { revision: outcome.revision, category: "City construction failed", code: "M1-CITY-1" });
      scope.close();
    }
  })().catch(() => {
    current = undefined;
    send("ANALYSIS_FAILED", { category: "Provider/resolution failure", ...(selectedRevision === undefined ? {} : { revision: selectedRevision }) });
    scope.close();
  });
});
