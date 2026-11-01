import { createSourceColoring } from "./shiki-source-highlighting";
import { isCanonicalSourcePath } from "../domain/source-admission";
import { SOURCE_PAGE_BYTES, createFileInspection, validateInspectionQuery, type InspectionEvidence } from "../application/unit-inspection";
import { analyzeRepository } from "../application/analyze-repository";
import { analyzeProjectSources, type ProjectAnalysis } from "../application/project-analysis";
import { investigationIdentity, validWorkingTreeName, type InvestigationOrigin } from "../application/investigation-origin";
import { acquireLocalWorkingTree } from "../application/local-working-tree";
import { createLocalFolderGateway } from "./local-folder-gateway";
import { buildCity } from "../domain/city-model";
import { validateCityPayload } from "../application/city-payload";
import { createInvestigationCapture } from "../application/investigation-capture";
import { decodeSnapshot, SAVE_LIMITS, snapshotCity, snapshotIdentity, validSavedId, type SavedRecord } from "../application/saved-investigation";
import { parseSavedRecord } from "./browser-saved-investigations";
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
let started = false, saving = false;
let controller: AbortController | undefined;
let identity: Readonly<{ sessionId: string; generation: number }> | undefined;
let current: ProjectAnalysis | undefined;
// revision in the existing analysis/inspection frames is an opaque identity;
// origin distinguishes a Git revision from a content-identified working-tree capture.
let selectedRevision: string | undefined;
let origin: InvestigationOrigin | undefined;
let exclusions: readonly string[] = [];
let saved: SavedRecord | undefined;
const capture = createInvestigationCapture();
const send = (type: string, payload: Record<string, unknown> = {}): void => scope.postMessage({ type, ...identity, ...payload });
declare const __CODE_CITY_ANALYZER__: string;
const options = { credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" } as const;
async function readLimited(response: Response, maximum: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.ok || !response.body) throw new Error("Saved investigation unavailable");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; total += next.value.length; if (total > maximum) { await reader.cancel(); throw new Error("Saved investigation exceeds limits"); } chunks.push(next.value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; } return bytes;
}
function publish(): void {
  if (!current || !selectedRevision) throw new Error("Missing investigation");
  if (current.city === null) { send("ANALYSIS_ALL_FILES_FAILED", { revision: selectedRevision, notAnalyzedFiles: current.notAnalyzedFiles }); return; }
  const city = validateCityPayload(current.city);
  send("ANALYSIS_SUCCEEDED", { revision: selectedRevision, notAnalyzedFiles: current.notAnalyzedFiles, city: {
    geometry: { ...city.geometry, origins: Array.from(city.geometry.origins), sizes: Array.from(city.geometry.sizes), rgba: Array.from(city.geometry.rgba), bounds: Array.from(city.geometry.bounds) },
    inspection: city.inspection.map(({ canonicalPath, S, U, M }) => ({ canonicalPath, S, U, M })),
    presentation: { plates: city.presentation.plates.map(({ minimum, dimensions }) => ({ minimum: [...minimum], dimensions: [...dimensions] })), sceneBounds: [...city.presentation.sceneBounds], centre: [...city.presentation.centre] },
    districts: city.districts.map(({ root, identity: districtIdentity }) => ({ root, identity: districtIdentity })),
  } });
}
async function save(requestId: number): Promise<void> {
  if (saving || !current || !selectedRevision) { send("SAVE_RESULT", { requestId, ok: false, error: "No completed investigation is available" }); return; }
  saving = true;
  try {
    if (!origin) throw new Error("Missing investigation origin");
    if (saved && retainedSnapshot && investigationIdentity(retainedSnapshot.header.origin) !== saved.revision) throw new Error("Saved identity differs");
    if (!saved) {
      const body = await capture.snapshot(origin, exclusions, current, __CODE_CITY_ANALYZER__);
      const response = await fetch(new URL("/api/investigations", scope.location.origin), { ...options, method: "POST", headers: { "Content-Type": "application/octet-stream" }, body });
      if (!response.ok) throw new Error(response.status === 507 ? "Saved storage is full" : response.status === 503 ? "Saving is unavailable or busy" : "Save failed");
      saved = parseSavedRecord(JSON.parse(new TextDecoder().decode(await readLimited(response, 16384))));
    }
    send("SAVE_RESULT", { requestId, ok: true, record: saved });
  } catch (error) { send("SAVE_RESULT", { requestId, ok: false, error: error instanceof Error ? error.message : "Save failed" }); }
  finally { saving = false; }
}
async function restore(id: string): Promise<void> {
  const receiptResponse = await fetch(new URL(`/api/investigations/${id}/record`, scope.location.origin), options);
  const receipt = parseSavedRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readLimited(receiptResponse, 16384))));
  if (receipt.id !== id) throw new Error("Invalid saved identity");
  const response = await fetch(new URL(`/api/investigations/${id}`, scope.location.origin), options);
  const bytes = await readLimited(response, Math.min(receipt.bytes, SAVE_LIMITS.snapshot));
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer)), byte => byte.toString(16).padStart(2, "0")).join("");
  if (bytes.length !== receipt.bytes || digest !== receipt.sha256) throw new Error("Damaged saved investigation");
  const restored = await decodeSnapshot(bytes);
  const context = snapshotIdentity(restored.header);
  if ((["repository", "ref", "revision"] as const).some(key => context[key] !== receipt[key]) || context.kind !== (receipt.kind ?? "github")) throw new Error("Saved identity differs");
  const restoredOrigin: InvestigationOrigin = restored.header.origin;
  origin = restoredOrigin; selectedRevision = investigationIdentity(restoredOrigin); exclusions = restored.header.exclusions;
  const city = snapshotCity(restored.header.city);
  const sources: ProjectAnalysis["sources"] = []; let offset = 0;
  for (const file of restored.header.files) { if (file.normalized) sources.push({ canonicalPath: file.path, normalizedUtf8: restored.sourceBytes[offset++]! }); }
  current = { city: city ? { geometry: city.geometry, inspection: city.inspection } : null, sources,
    notAnalyzedFiles: restored.header.files.filter(file => file.outcome !== "success").map(file => ({ canonicalPath: file.path, category: file.outcome as ProjectAnalysis["notAnalyzedFiles"][number]["category"] })) };
  saved = receipt;
  // Keep the complete decoded snapshot for subsequent inspection, not just the city.
  retainedSnapshot = restored;
  send("RESTORED", { origin, record: receipt, exclusions });
  if (restoredOrigin.kind === "working-tree") send("WORKING_TREE_CAPTURED", { origin: restoredOrigin });
  else send("REVISION_SELECTED", { revision: selectedRevision });
  publish();
}
let inspectionCache: { path: string; read: ReturnType<typeof createFileInspection> } | undefined;
async function inspect(requestId: number, queryValue: unknown): Promise<void> {
  const owner = identity, investigation = current, revision = selectedRevision;
  const ownsReply = () => identity === owner && current === investigation && selectedRevision === revision && !controller?.signal.aborted;
  try {
    const query = validateInspectionQuery(queryValue);
    if (!current?.city || !current.city.inspection.some(row => row.canonicalPath === query.path)) throw new Error("File unavailable");
    if (inspectionCache?.path !== query.path) {
      const source = current.sources.find(row => row.canonicalPath === query.path);
      if (!source) throw new Error("Source unavailable");
      let evidence = capture.inspection(query.path);
      if (retainedSnapshot) {
        const file = retainedSnapshot.header.files.find(row => row.path === query.path);
        if (!file) throw new Error("Evidence unavailable");
        evidence = {
          units: { length: file.units.length, at(index) { const row = file.units[index]; return row ? { kind: row[0], startByte: row[1], endByte: row[2], complexity: row[4] } : undefined; } },
          contributionCount: file.contributions.length,
          contributions: () => file.contributions,
        } satisfies InspectionEvidence;
      }
      if (!evidence) throw new Error("Evidence unavailable");
      inspectionCache = { path: query.path, read: createFileInspection(query.path, source.normalizedUtf8, evidence, createSourceColoring) };
    }
    const result = await inspectionCache.read(query);
    if (ownsReply()) send("INSPECTION_RESULT", { requestId, revision, ok: true, value: result });
  } catch { if (ownsReply()) send("INSPECTION_RESULT", { requestId, revision, ok: false }); }
}
function fileSource(requestId: number, value: unknown): void {
  try {
    if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).sort().join(",") !== "cursor,path") throw new Error("Invalid source query");
    const { path, cursor } = value as { path: unknown; cursor: unknown };
    if (typeof path !== "string" || !isCanonicalSourcePath(path) || typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Invalid source query");
    const bytes = current?.sources.find(source => source.canonicalPath === path)?.normalizedUtf8;
    if (!bytes || cursor > bytes.length || (cursor < bytes.length && (bytes[cursor]! & 0xc0) === 0x80)) throw new Error("Source unavailable");
    let end = Math.min(bytes.length, cursor + SOURCE_PAGE_BYTES), lines = 0;
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    for (let offset = cursor; offset < end; offset++) if (bytes[offset] === 10 && ++lines === 80) { end = offset + 1; break; }
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(cursor, end));
    send("FILE_SOURCE_RESULT", { requestId, revision: selectedRevision, ok: true, value: { path, cursor, next: end < bytes.length ? end : null, text } });
  } catch { send("FILE_SOURCE_RESULT", { requestId, revision: selectedRevision, ok: false }); }
}
let retainedSnapshot: Awaited<ReturnType<typeof decodeSnapshot>> | undefined;
scope.addEventListener("message", (event: MessageEvent<unknown>) => {
  const value = event.data as Record<string, unknown> | null;
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return;
  const exact = (keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  if (value.type === "INSPECT" && exact(["type", "sessionId", "generation", "requestId", "query"]) && identity && value.sessionId === identity.sessionId && value.generation === identity.generation && typeof value.requestId === "number" && Number.isSafeInteger(value.requestId) && value.requestId > 0) { void inspect(value.requestId, value.query); return; }
  if (value.type === "FILE_SOURCE" && exact(["type", "sessionId", "generation", "requestId", "query"]) && identity && value.sessionId === identity.sessionId && value.generation === identity.generation
    && typeof value.requestId === "number" && Number.isSafeInteger(value.requestId) && value.requestId > 0) { fileSource(value.requestId, value.query); return; }
  if (value.type === "SAVE" && exact(["type", "sessionId", "generation", "requestId"]) && identity && value.sessionId === identity.sessionId && value.generation === identity.generation && typeof value.requestId === "number" && Number.isSafeInteger(value.requestId) && value.requestId > 0) { void save(value.requestId); return; }
  if (value.type === "STOP" && exact(["type", "sessionId", "generation"]) && identity && value.sessionId === identity.sessionId && value.generation === identity.generation) {
    controller?.abort(); if (current) { current = undefined; retainedSnapshot = undefined; scope.close(); } return;
  }
  if (value.type !== "START" || started || typeof value.sessionId !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value.sessionId)
    || typeof value.generation !== "number" || !Number.isSafeInteger(value.generation) || value.generation < 1
    || typeof value.additionalExclusions !== "string") return;
  const local = value.inputKind === "working-tree";
  const keys = local ? ["type", "sessionId", "generation", "inputKind", "root", "name", "additionalExclusions"]
    : ["type", "sessionId", "generation", "repositoryUrl", "additionalExclusions", ...(value.savedId === undefined ? [] : ["savedId"])];
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) { scope.close(); return; }
  const repository = !local && typeof value.repositoryUrl === "string" ? parseRepositoryReference(value.repositoryUrl) : undefined;
  const parsedExclusions = parseAdditionalExclusions(value.additionalExclusions);
  if (value.savedId === undefined && (!parsedExclusions || (local ? !validWorkingTreeName(value.name) : !repository))) { scope.close(); return; }
  started = true; identity = { sessionId: value.sessionId, generation: value.generation }; controller = new AbortController();
  const signal = controller.signal;
  void (async () => {
    if (value.savedId !== undefined) {
      if (!validSavedId(value.savedId)) throw new Error("Invalid saved identity");
      await restore(value.savedId); return;
    }
    exclusions = parsedExclusions!;
    if (local) {
      send("WORKING_TREE_STARTED", { name: value.name });
      const acquired = await acquireLocalWorkingTree(value.name as string, exclusions, signal, createLocalFolderGateway(value.root),
        (completed: number, total: number) => send("WORKING_TREE_PROGRESS", { completed, total }));
      if (signal.aborted || acquired.kind === "cancelled") { send("ANALYSIS_CANCELLED"); scope.close(); return; }
      if (acquired.kind === "failure") { send("WORKING_TREE_FAILED", { category: acquired.category, ...("code" in acquired ? { code: acquired.code } : {}) }); scope.close(); return; }
      const capturedOrigin: InvestigationOrigin = acquired.origin;
      origin = capturedOrigin; selectedRevision = investigationIdentity(capturedOrigin);
      send("WORKING_TREE_CAPTURED", { origin: capturedOrigin });
      send("ANALYSIS_PROGRESS", { revision: selectedRevision, stage: "analysis-initialization" });
      const parser = createTreeSitterAdapter(assets), total = acquired.acquired.modules.length;
      let completed = 0;
      const progress = () => send("ANALYSIS_PROGRESS", { revision: selectedRevision, stage: "analysis", completed, total });
      const analysis = await analyzeProjectSources(acquired.acquired, {
        async initialize() { await parser.initialize(); if (total > 0) progress(); },
        async project(family, source) {
          let projected: Awaited<ReturnType<typeof parser.project>>;
          try { projected = await parser.project(family, source); }
          catch (error) { completed++; progress(); throw error; }
          return { observations: projected.observations, release() { projected.release(); completed++; progress(); } };
        },
      }, facts => { send("ANALYSIS_PROGRESS", { revision: selectedRevision, stage: "city-construction" }); return buildCity(facts); }, capture);
      if (signal.aborted) { send("ANALYSIS_CANCELLED"); scope.close(); return; }
      if (analysis.kind === "failure") { send("ANALYSIS_FAILED", { revision: selectedRevision, category: analysis.category, code: analysis.code }); scope.close(); return; }
      current = analysis.result; publish(); return;
    }
    const outcome = await analyzeRepository(repository!, exclusions, signal, {
      revisionGateway: createGithubRevisionGateway(fetch), sourceGateway: createGithubRawSourceGateway(fetch), parser: createTreeSitterAdapter(assets), capture,
    }, revision => { selectedRevision = revision; origin = { kind: "github", repositoryUrl: value.repositoryUrl as string, revision }; send("REVISION_SELECTED", { revision }); }, progress => send("ANALYSIS_PROGRESS", { revision: selectedRevision, ...progress }));
    if (outcome.kind === "cancelled") { send("ANALYSIS_CANCELLED"); scope.close(); return; }
    if (outcome.kind === "failure") { send("ANALYSIS_FAILED", { category: outcome.category, ...(outcome.revision === undefined ? {} : { revision: outcome.revision }), ...(outcome.code === undefined ? {} : { code: outcome.code }) }); scope.close(); return; }
    current = outcome.result; publish();
  })().catch(() => {
    current = undefined;
    if (signal.aborted) send("ANALYSIS_CANCELLED");
    else if (local && selectedRevision === undefined) send("WORKING_TREE_FAILED", { category: "Local working tree unavailable" });
    else send("ANALYSIS_FAILED", { category: value.savedId !== undefined ? "Saved investigation unavailable" : local ? "Local working tree unavailable" : "Provider/resolution failure", ...(selectedRevision === undefined ? {} : { revision: selectedRevision }) });
    scope.close();
  });
});
