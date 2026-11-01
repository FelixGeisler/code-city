import { investigationIdentity, parseInvestigationOrigin, validWorkingTreeName, type InvestigationOrigin } from "../application/investigation-origin";
import { parseInspectionResult, validateInspectionQuery, type InspectionQuery, type InspectionResult } from "../application/unit-inspection";
import { parseSavedRecord } from "./browser-saved-investigations";
import { validSavedId, type SavedRecord } from "../application/saved-investigation";
import { parseRepositoryReference } from "../domain/repository-reference";
import { parseAdditionalExclusions } from "../domain/source-admission";
import { parseBrowserSessionEvent, parseBrowserFileSource, parseBrowserFileSourceQuery, type BrowserFileSource, type BrowserFileSourceQuery, type BrowserAnalyzeCommand, type BrowserCommand, type BrowserSessionTransport } from "./standalone-browser-controller";

type OwnedWorker = {
  worker: Worker;
  generation: number;
  providerActive: boolean;
  finished: boolean;
  revision?: string;
  inspections: Map<InspectionQuery["type"], { id: number; query: InspectionQuery; resolve(value: InspectionResult): void; reject(error: Error): void }>;
  saveRequest?: { id: number; resolve(record: SavedRecord): void; reject(error: Error): void };
  sourceRequest?: { id: number; query: BrowserFileSourceQuery; resolve(source: BrowserFileSource): void; reject(error: Error): void };
  stop?: Promise<void>;
  releaseStop?: () => void;
  dispose(): void;
};

/** Browser-local ownership only: opening an idle page performs no backend request. */
export function createBrowserWorkerTransport(
  createWorker: () => Worker = () => new Worker(new URL("./browser-analysis-worker.ts", import.meta.url), { type: "module" }),
  restored?: (origin: InvestigationOrigin, record: SavedRecord, exclusions: readonly string[]) => void,
): BrowserSessionTransport {
  return Object.freeze({
    open(observer) {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const sessionId = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
      let closed = false;
      let version = 0;
      let latestGeneration = 0;
      let active: OwnedWorker | undefined;
      let saveId = 0;
      const destroy = (owned: OwnedWorker): void => {
        owned.dispose();
        if (active === owned) active = undefined;
        owned.releaseStop?.();
      };
      const stop = (owned: OwnedWorker): Promise<void> => {
        if (owned.stop) return owned.stop;
        if (owned.finished || !owned.providerActive) { destroy(owned); return Promise.resolve(); }
        owned.stop = new Promise<void>((resolve) => { owned.releaseStop = resolve; });
        try { owned.worker.postMessage({ type: "STOP", sessionId, generation: owned.generation }); }
        catch { destroy(owned); }
        return owned.stop;
      };
      const controlValid = (command: { sessionId: string; generation: number }): boolean => !closed
        && command.sessionId === sessionId && command.generation === latestGeneration;
      return Object.freeze({
        ready: Promise.resolve({ kind: "opened" as const, sessionId }),
        async analyze(command: BrowserAnalyzeCommand) {
          if (closed || command.sessionId !== sessionId || !Number.isSafeInteger(command.generation)
            || command.generation <= latestGeneration) return 409;
          latestGeneration = command.generation;
          const selectedVersion = ++version;
          if (active) await stop(active);
          if (closed || version !== selectedVersion) return 202;
          if (command.inputKind === "working-tree"
            ? !validWorkingTreeName(command.name) || !command.root || !parseAdditionalExclusions(command.additionalExclusions)
            : command.savedId === undefined ? !parseRepositoryReference(command.repositoryUrl) || !parseAdditionalExclusions(command.additionalExclusions) : !validSavedId(command.savedId)) return 422;
          try {
            const worker = createWorker();
            let disposed = false;
            const owned: OwnedWorker = {
              worker, generation: command.generation, providerActive: command.savedId === undefined, finished: false, inspections: new Map(),
              dispose() {
                if (disposed) return;
                disposed = true;
                for (const pending of owned.inspections.values()) pending.reject(new Error("Inspection changed"));
                owned.inspections.clear();
                owned.saveRequest?.reject(new Error("Investigation changed")); owned.saveRequest = undefined;
                owned.sourceRequest?.reject(new Error("Investigation changed")); owned.sourceRequest = undefined;
                worker.removeEventListener("message", message);
                worker.removeEventListener("error", error);
                worker.removeEventListener("messageerror", error);
                worker.terminate();
              },
            };
            const error = (): void => {
              const cancelling = owned.stop !== undefined;
              destroy(owned);
              if (!closed && !cancelling && version === selectedVersion) observer.lost();
            };
            const message = (received: MessageEvent<unknown>): void => {
              if (closed || active !== owned) return;
              const raw = received.data as Record<string, unknown> | null;
              if (raw && raw.sessionId === sessionId && raw.generation === command.generation && version === selectedVersion && !owned.stop) {
                if (raw.type === "INSPECTION_RESULT") {
                  const entry = [...owned.inspections].find(([, pending]) => pending.id === raw.requestId);
                  if (entry) {
                    owned.inspections.delete(entry[0]);
                    try {
                      if (raw.ok !== true || raw.revision !== owned.revision
                        || Object.keys(raw).sort().join(",") !== "generation,ok,requestId,revision,sessionId,type,value") throw new Error("Unit inspection unavailable");
                      entry[1].resolve(parseInspectionResult(raw.value, entry[1].query));
                    } catch { entry[1].reject(new Error("Unit inspection unavailable")); }
                  }
                  return;
                }
                if (raw.type === "FILE_SOURCE_RESULT") {
                  const pending = owned.sourceRequest;
                  if (pending && raw.requestId === pending.id) {
                    owned.sourceRequest = undefined;
                    try {
                      if (raw.ok !== true || raw.revision !== owned.revision
                        || Object.keys(raw).sort().join(",") !== "generation,ok,requestId,revision,sessionId,type,value") throw new Error("Source unavailable");
                      pending.resolve(parseBrowserFileSource(raw.value, pending.query));
                    } catch { pending.reject(new Error("Source unavailable")); }
                  }
                  return;
                }
                if (raw.type === "SAVE_RESULT") {
                  const pending = owned.saveRequest;
                  if (pending && raw.requestId === pending.id) {
                    owned.saveRequest = undefined;
                    try {
                      if (raw.ok !== true) {
                        if (Object.keys(raw).sort().join(",") !== "error,generation,ok,requestId,sessionId,type") throw new Error("Save failed");
                        throw new Error(typeof raw.error === "string" ? raw.error : "Save failed");
                      }
                      if (Object.keys(raw).sort().join(",") !== "generation,ok,record,requestId,sessionId,type") throw new Error("Save failed");
                      pending.resolve(parseSavedRecord(raw.record));
                    }
                    catch (failure) { pending.reject(failure instanceof Error ? failure : new Error("Save failed")); }
                  }
                  return;
                }
                if (raw.type === "RESTORED") {
                  try {
                    const record = parseSavedRecord(raw.record);
                    const origin = parseInvestigationOrigin(raw.origin);
                    if (Object.keys(raw).sort().join(",") !== "exclusions,generation,origin,record,sessionId,type" || record.id !== command.savedId
                      || investigationIdentity(origin) !== record.revision || (record.kind ?? "github") !== origin.kind) throw new Error("Invalid restored metadata");
                    if (!Array.isArray(raw.exclusions) || raw.exclusions.some(item => typeof item !== "string") || !parseAdditionalExclusions(raw.exclusions.join("\n"))) throw new Error("Invalid saved exclusions");
                    restored?.(origin, record, raw.exclusions as string[]);
                  } catch { error(); }
                  return;
                }
              }
              const event = parseBrowserSessionEvent(received.data);
              if (!event || event.sessionId !== sessionId || event.generation !== command.generation) { error(); return; }
              if (event.type === "WORKING_TREE_CAPTURED" || (event.type === "ANALYSIS_PROGRESS" && event.stage !== "acquisition")) owned.providerActive = false;
              const terminal = event.type === "ANALYSIS_SUCCEEDED" || event.type === "ANALYSIS_ALL_FILES_FAILED"
                || event.type === "ANALYSIS_FAILED" || event.type === "WORKING_TREE_FAILED" || event.type === "ANALYSIS_CANCELLED";
              if (owned.stop) {
                if (terminal || !owned.providerActive) destroy(owned);
                return;
              }
              if (version !== selectedVersion) return;
              if (event.type === "REVISION_SELECTED") owned.revision = event.revision;
              if (event.type === "WORKING_TREE_CAPTURED") owned.revision = event.origin.captureId;
              if (terminal) owned.finished = true;
              observer.event(event);
              if (event.type === "ANALYSIS_FAILED" || event.type === "WORKING_TREE_FAILED" || event.type === "ANALYSIS_CANCELLED") destroy(owned);
            };
            active = owned;
            try {
              worker.addEventListener("message", message);
              worker.addEventListener("error", error);
              worker.addEventListener("messageerror", error);
              worker.postMessage({ type: "START", ...command });
            } catch { destroy(owned); throw new Error("Browser worker startup failed"); }
          } catch { if (!closed && version === selectedVersion) observer.lost(); }
          return 202;
        },
        async cancel(command: BrowserCommand) {
          if (!controlValid(command)) return 409;
          const owned = active;
          if (owned && !owned.finished) {
            await stop(owned);
            if (!closed && command.generation === latestGeneration) observer.event({ type: "ANALYSIS_CANCELLED", ...command });
          }
          return 204;
        },
        async discard(command: BrowserCommand) {
          if (!controlValid(command)) return 409;
          if (active) await stop(active);
          if (!closed && command.generation === latestGeneration) observer.event({ type: "CURRENT_DISCARDED", ...command });
          return 204;
        },
        inspect(query: InspectionQuery) {
          const owned = active;
          if (closed || !owned?.finished || !owned.revision) return Promise.reject(new Error("Unit inspection unavailable"));
          try { validateInspectionQuery(query); } catch { return Promise.reject(new Error("Unit inspection unavailable")); }
          owned.inspections.get(query.type)?.reject(new Error("Inspection changed"));
          return new Promise<InspectionResult>((resolve, reject) => {
            const id = ++saveId; owned.inspections.set(query.type, { id, query, resolve, reject });
            try { owned.worker.postMessage({ type: "INSPECT", sessionId, generation: owned.generation, requestId: id, query }); }
            catch { owned.inspections.delete(query.type); reject(new Error("Unit inspection unavailable")); }
          });
        },
        fileSource(query: BrowserFileSourceQuery) {
          const owned = active;
          if (closed || !owned?.finished || !owned.revision) return Promise.reject(new Error("Source unavailable"));
          try { parseBrowserFileSourceQuery(query); } catch { return Promise.reject(new Error("Source unavailable")); }
          owned.sourceRequest?.reject(new Error("Source changed"));
          return new Promise<BrowserFileSource>((resolve, reject) => {
            const id = ++saveId; owned.sourceRequest = { id, query, resolve, reject };
            try { owned.worker.postMessage({ type: "FILE_SOURCE", sessionId, generation: owned.generation, requestId: id, query }); }
            catch { owned.sourceRequest = undefined; reject(new Error("Source unavailable")); }
          });
        },
        save() {
          const owned = active;
          if (closed || !owned || !owned.finished || !owned.revision || owned.saveRequest) return Promise.reject(new Error("Saving is unavailable or busy"));
          return new Promise<SavedRecord>((resolve, reject) => {
            const id = ++saveId; owned.saveRequest = { id, resolve, reject };
            try { owned.worker.postMessage({ type: "SAVE", sessionId, generation: owned.generation, requestId: id }); }
            catch { owned.saveRequest = undefined; reject(new Error("Save failed")); }
          });
        },
        close() {
          if (closed) return;
          closed = true;
          version += 1;
          if (active) destroy(active);
        },
      });
    },
  });
}
