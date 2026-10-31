import { PRESENTATION_KIND } from "../domain/city-model";
import type { InspectionQuery, InspectionResult } from "../application/unit-inspection";
import type { SavedRecord } from "../application/saved-investigation";
import { validateCityPayload, type ValidatedCity } from "../application/city-payload";
import { compareUnsignedUtf8, isCanonicalSourcePath, MAX_ADMITTED_MODULES } from "../domain/source-admission";

export type FailedFileCategory =
  | "Source text is not supported"
  | "Syntax could not be analyzed"
  | "Metrics could not be computed";

export type BrowserFailedFile = Readonly<{ canonicalPath: string; category: FailedFileCategory }>;

export type BrowserProgressEvent =
  | Readonly<{
      type: "ANALYSIS_PROGRESS";
      sessionId: string;
      generation: number;
      revision: string;
      stage: "acquisition";
      completed: number;
      total: number;
    }>
  | Readonly<{
      type: "ANALYSIS_PROGRESS";
      sessionId: string;
      generation: number;
      revision: string;
      stage: "analysis-initialization";
    }>
  | Readonly<{
      type: "ANALYSIS_PROGRESS";
      sessionId: string;
      generation: number;
      revision: string;
      stage: "analysis";
      completed: number;
      total: number;
    }>
  | Readonly<{
      type: "ANALYSIS_PROGRESS";
      sessionId: string;
      generation: number;
      revision: string;
      stage: "city-construction";
    }>;

export type BrowserSessionEvent =
  | Readonly<{ type: "REVISION_SELECTED"; sessionId: string; generation: number; revision: string }>
  | BrowserProgressEvent
  | Readonly<{ type: "ANALYSIS_FAILED"; sessionId: string; generation: number; revision?: string; category: string; code?: string }>
  | Readonly<{ type: "ANALYSIS_CANCELLED"; sessionId: string; generation: number }>
  | Readonly<{ type: "ANALYSIS_ALL_FILES_FAILED"; sessionId: string; generation: number; revision: string; notAnalyzedFiles: readonly BrowserFailedFile[] }>
  | Readonly<{ type: "ANALYSIS_SUCCEEDED"; sessionId: string; generation: number; revision: string; city: ValidatedCity; notAnalyzedFiles: readonly BrowserFailedFile[] }>
  | Readonly<{ type: "CURRENT_DISCARDED"; sessionId: string; generation: number }>;

export type BrowserSessionObserver = Readonly<{
  event(event: BrowserSessionEvent): void;
  lost(): void;
}>;

export type BrowserCommand = Readonly<{ sessionId: string; generation: number }>;
export type BrowserAnalyzeCommand = Readonly<BrowserCommand & { repositoryUrl: string; additionalExclusions: string; savedId?: string }>;

export type BrowserSessionOpenResult = Readonly<{ kind: "opened"; sessionId: string }> | Readonly<{ kind: "capacity" }> | Readonly<{ kind: "lost" }>;

export interface BrowserSessionOwner {
  readonly ready: Promise<BrowserSessionOpenResult>;
  analyze(command: BrowserAnalyzeCommand): Promise<number>;
  cancel(command: BrowserCommand): Promise<number>;
  discard(command: BrowserCommand): Promise<number>;
  close(): void;
  save?(): Promise<SavedRecord>;
  inspect?(query: InspectionQuery): Promise<InspectionResult>;
}

export type BrowserSessionTransport = Readonly<{
  open(observer: BrowserSessionObserver): BrowserSessionOwner;
}>;

export type StandaloneBrowserView = Readonly<{
  clear(): void;
  working(cancel: () => void): void;
  progress(label: string, completed?: number, total?: number): void;
  invalid(): void;
  capacity(): void;
  lost(): void;
  revision(value: string): void;
  failed(category: string, code?: string, revision?: string): void;
  cancelled(): void;
  succeeded(generation: number, city: ValidatedCity, failures: readonly BrowserFailedFile[], revision: string, discard: () => void): void;
  allFilesFailed(generation: number, failures: readonly BrowserFailedFile[], revision: string, discard: () => void): void;
}>;

export type StandaloneBrowserController = Readonly<{
  start(): void;
  submit(repositoryUrl: string, additionalExclusions: string): void;
  openSaved(id: string): void;
  save(): Promise<SavedRecord>;
  inspect(query: InspectionQuery): Promise<InspectionResult>;
  dispose(): void;
}>;

type DataRecord = Record<string, unknown>;

type BrowserAttemptState = {
  revision?: string;
  terminal: boolean;
  stage: 0 | 1 | 2 | 3 | 4;
  acquisitionTotal?: number;
  acquisitionCompleted?: number;
  analysisTotal?: number;
  analysisCompleted?: number;
  saved?: boolean;
};

const FAILURE_CATEGORIES = new Set([
  "Repository unavailable for anonymous access",
  "Revision unavailable",
  "Provider/resolution failure",
  "Saved investigation unavailable",
  "Repository exceeds Code City limits",
  "No supported modules",
  "Source admission failed",
  "Metric processing failed",
  "City construction failed",
]);

function exactRecord(value: unknown, keys: readonly string[]): DataRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string") || keys.some((key) => !Object.hasOwn(descriptors, key))) return undefined;
  const record: DataRecord = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined;
    record[key] = descriptor.value;
  }
  return record;
}

function exactArray(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) return undefined;
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined;
    result.push(descriptor.value);
  }
  return result;
}

function validSessionId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value);
}

function validGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validRevision(value: unknown): value is string {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value);
}

function validProgressCount(completed: unknown, total: unknown): completed is number {
  return typeof completed === "number" && Number.isSafeInteger(completed) && completed >= 0
    && typeof total === "number" && Number.isSafeInteger(total) && total > 0
    && total <= MAX_ADMITTED_MODULES && completed <= total;
}

function validCode(category: string, code: unknown): code is string {
  if (typeof code !== "string") return false;
  if (category === "No supported modules") return code === "ADM-06" || code === "ADM-07";
  if (category === "Source admission failed") return code === "M1-ADM-1" || code === "M1-ADM-3" || code === "M1-ADM-4";
  if (category === "Metric processing failed") return code === "M1-MET-1";
  return category === "City construction failed" && code === "M1-CITY-1";
}

function parseFailures(value: unknown): readonly BrowserFailedFile[] | undefined {
  const rows = exactArray(value);
  if (!rows || rows.length > MAX_ADMITTED_MODULES) return undefined;
  const failures: BrowserFailedFile[] = [];
  let prior: string | undefined;
  for (const row of rows) {
    const record = exactRecord(row, ["canonicalPath", "category"]);
    if (!record || typeof record.canonicalPath !== "string" || !isCanonicalSourcePath(record.canonicalPath)
      || (record.category !== "Source text is not supported" && record.category !== "Syntax could not be analyzed"
        && record.category !== "Metrics could not be computed")
      || (prior !== undefined && compareUnsignedUtf8(prior, record.canonicalPath) >= 0)) return undefined;
    failures.push(Object.freeze({ canonicalPath: record.canonicalPath, category: record.category }));
    prior = record.canonicalPath;
  }
  return Object.freeze(failures);
}

function exactNumberArray(value: unknown, length?: number): number[] | undefined {
  const rows = exactArray(value);
  if (!rows || (length !== undefined && rows.length !== length) || rows.some((entry) => typeof entry !== "number")) return undefined;
  return rows as number[];
}

function exactFloat32Array(value: unknown, length: number): number[] | undefined {
  const rows = exactNumberArray(value, length);
  return rows && rows.every((entry) => Number.isFinite(entry) && Object.is(Math.fround(entry), entry)) ? rows : undefined;
}

function exactUint8Array(value: unknown, length: number): number[] | undefined {
  const rows = exactNumberArray(value, length);
  return rows && rows.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255) ? rows : undefined;
}

export function parseBrowserCity(value: unknown): ValidatedCity | undefined {
  try {
    const city = exactRecord(value, ["geometry", "inspection", "presentation", "districts"]);
    const geometry = city && exactRecord(city.geometry, ["kind", "count", "origins", "sizes", "rgba", "bounds"]);
    if (!geometry || geometry.kind !== PRESENTATION_KIND || !Number.isSafeInteger(geometry.count) || (geometry.count as number) < 1) return undefined;
    const count = geometry.count as number;
    const origins = exactFloat32Array(geometry.origins, count * 3);
    const sizes = exactFloat32Array(geometry.sizes, count * 3);
    const rgba = exactUint8Array(geometry.rgba, count * 4);
    const bounds = exactFloat32Array(geometry.bounds, 6);
    const inspectionRows = exactArray(city!.inspection);
    if (!origins || !sizes || !rgba || !bounds || !inspectionRows) return undefined;
    const inspection = inspectionRows.map((row) => {
      const record = exactRecord(row, ["canonicalPath", "S", "U", "M"]);
      if (!record) throw new Error("invalid inspection");
      return record;
    });
    const validated = validateCityPayload({
      geometry: {
        kind: geometry.kind,
        count,
        origins: new Float32Array(origins),
        sizes: new Float32Array(sizes),
        rgba: new Uint8Array(rgba),
        bounds: new Float32Array(bounds),
      },
      inspection,
    });
    const presentation = exactRecord(city!.presentation, ["plates", "sceneBounds", "centre"]);
    const plates = presentation && exactArray(presentation.plates);
    const sceneBounds = presentation && exactFloat32Array(presentation.sceneBounds, 6);
    const centre = presentation && exactFloat32Array(presentation.centre, 3);
    const districts = exactArray(city!.districts);
    if (!presentation || !plates || !sceneBounds || !centre || !districts) return undefined;
    const plainPlates = plates.map((plate) => {
      const record = exactRecord(plate, ["minimum", "dimensions"]);
      const minimum = record && exactFloat32Array(record.minimum, 3);
      const dimensions = record && exactFloat32Array(record.dimensions, 3);
      if (!minimum || !dimensions) throw new Error("invalid plate");
      return { minimum, dimensions };
    });
    const plainDistricts = districts.map((district) => {
      const record = exactRecord(district, ["root", "identity"]);
      if (!record || typeof record.root !== "boolean" || typeof record.identity !== "string") throw new Error("invalid district");
      return { root: record.root, identity: record.identity };
    });
    const expected = {
      plates: validated.presentation.plates.map(({ minimum, dimensions }) => ({ minimum: [...minimum], dimensions: [...dimensions] })),
      sceneBounds: [...validated.presentation.sceneBounds],
      centre: [...validated.presentation.centre],
      districts: validated.districts.map(({ root, identity }) => ({ root, identity })),
    };
    if (JSON.stringify({ plates: plainPlates, sceneBounds, centre, districts: plainDistricts }) !== JSON.stringify(expected)) return undefined;
    return validated;
  } catch {
    return undefined;
  }
}

export function parseBrowserSessionEvent(value: unknown): BrowserSessionEvent | undefined {
  const opened = exactRecord(value, ["type", "sessionId"]);
  if (opened?.type === "SESSION_OPENED" && validSessionId(opened.sessionId)) return undefined;

  const control = exactRecord(value, ["type", "sessionId", "generation"]);
  if (control && validSessionId(control.sessionId) && validGeneration(control.generation)
    && (control.type === "ANALYSIS_CANCELLED" || control.type === "CURRENT_DISCARDED")) {
    return control as BrowserSessionEvent;
  }

  const revision = exactRecord(value, ["type", "sessionId", "generation", "revision"]);
  if (revision?.type === "REVISION_SELECTED" && validSessionId(revision.sessionId)
    && validGeneration(revision.generation) && validRevision(revision.revision)) return revision as BrowserSessionEvent;

  const countedProgress = exactRecord(
    value,
    ["type", "sessionId", "generation", "revision", "stage", "completed", "total"],
  );
  if (countedProgress?.type === "ANALYSIS_PROGRESS" && validSessionId(countedProgress.sessionId)
    && validGeneration(countedProgress.generation) && validRevision(countedProgress.revision)
    && (countedProgress.stage === "acquisition" || countedProgress.stage === "analysis")
    && validProgressCount(countedProgress.completed, countedProgress.total)) {
    return countedProgress as BrowserProgressEvent;
  }
  const stageProgress = exactRecord(value, ["type", "sessionId", "generation", "revision", "stage"]);
  if (stageProgress?.type === "ANALYSIS_PROGRESS" && validSessionId(stageProgress.sessionId)
    && validGeneration(stageProgress.generation) && validRevision(stageProgress.revision)
    && (stageProgress.stage === "analysis-initialization" || stageProgress.stage === "city-construction")) {
    return stageProgress as BrowserProgressEvent;
  }

  for (const keys of [
    ["type", "sessionId", "generation", "category"],
    ["type", "sessionId", "generation", "revision", "category"],
    ["type", "sessionId", "generation", "revision", "category", "code"],
  ] as const) {
    const failure = exactRecord(value, keys);
    if (failure?.type !== "ANALYSIS_FAILED" || !validSessionId(failure.sessionId) || !validGeneration(failure.generation)
      || typeof failure.category !== "string" || !FAILURE_CATEGORIES.has(failure.category)) continue;
    const hasRevision = Object.hasOwn(failure, "revision");
    const hasCode = Object.hasOwn(failure, "code");
    if (hasRevision && !validRevision(failure.revision)) continue;
    if (hasCode && !validCode(failure.category, failure.code)) continue;
    const preSelection = ["Repository unavailable for anonymous access", "Revision unavailable", "Provider/resolution failure"].includes(failure.category);
    const postSelectionUncoded = ["Provider/resolution failure", "Repository exceeds Code City limits"].includes(failure.category);
    const postSelectionCoded = ["No supported modules", "Source admission failed", "Metric processing failed", "City construction failed"].includes(failure.category);
    if ((!hasRevision && !hasCode && preSelection)
      || (hasRevision && !hasCode && postSelectionUncoded)
      || (hasRevision && hasCode && postSelectionCoded)) return failure as BrowserSessionEvent;
  }

  const allFailed = exactRecord(value, ["type", "sessionId", "generation", "revision", "notAnalyzedFiles"]);
  if (allFailed?.type === "ANALYSIS_ALL_FILES_FAILED" && validSessionId(allFailed.sessionId)
    && validGeneration(allFailed.generation) && validRevision(allFailed.revision)) {
    const failures = parseFailures(allFailed.notAnalyzedFiles);
    if (failures && failures.length > 0) return { ...allFailed, notAnalyzedFiles: failures } as BrowserSessionEvent;
  }

  const succeeded = exactRecord(value, ["type", "sessionId", "generation", "revision", "city", "notAnalyzedFiles"]);
  if (succeeded?.type === "ANALYSIS_SUCCEEDED" && validSessionId(succeeded.sessionId)
    && validGeneration(succeeded.generation) && validRevision(succeeded.revision)) {
    const city = parseBrowserCity(succeeded.city);
    const failures = parseFailures(succeeded.notAnalyzedFiles);
    if (city && failures && city.inspection.length + failures.length <= MAX_ADMITTED_MODULES
      && !failures.some(({ canonicalPath }) => city.inspection.some((fact) => fact.canonicalPath === canonicalPath))) {
      return { ...succeeded, city, notAnalyzedFiles: failures } as BrowserSessionEvent;
    }
  }
  return undefined;
}

function parseOpened(value: unknown): string | undefined {
  const opened = exactRecord(value, ["type", "sessionId"]);
  return opened?.type === "SESSION_OPENED" && validSessionId(opened.sessionId) ? opened.sessionId : undefined;
}

async function commandStatus(target: string, value: BrowserCommand | BrowserAnalyzeCommand, signal: AbortSignal): Promise<number> {
  const response = await fetch(target, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    signal,
  });
  if ((await response.arrayBuffer()).byteLength !== 0) throw new Error("Command response was not empty");
  return response.status;
}

export function createFetchSessionTransport(): BrowserSessionTransport {
  return Object.freeze({
    open(observer): BrowserSessionOwner {
      const abort = new AbortController();
      let sessionId: string | undefined;
      let openedResolve!: (value: BrowserSessionOpenResult) => void;
      let openedSettled = false;
      let intentional = false;
      const ready = new Promise<BrowserSessionOpenResult>((resolve) => { openedResolve = resolve; });
      const settle = (value: BrowserSessionOpenResult): void => {
        if (openedSettled) return;
        openedSettled = true;
        openedResolve(value);
      };
      const lose = (): void => {
        if (intentional) return;
        if (!openedSettled) settle({ kind: "lost" });
        observer.lost();
      };
      void (async () => {
        try {
          const response = await fetch("/_code-city/session", {
            method: "POST", cache: "no-store", credentials: "omit", redirect: "error", signal: abort.signal,
          });
          if (response.status === 503) {
            await response.arrayBuffer();
            settle({ kind: "capacity" });
            return;
          }
          if (response.status !== 200 || response.headers.get("content-type") !== "application/x-ndjson; charset=utf-8" || !response.body) {
            await response.body?.cancel();
            settle({ kind: "lost" });
            return;
          }
          const reader = response.body.getReader();
          const decoder = new TextDecoder("utf-8", { fatal: true });
          let pending = "";
          let first = true;
          for (;;) {
            const result = await reader.read();
            if (result.done) break;
            pending += decoder.decode(result.value, { stream: true });
            for (;;) {
              const newline = pending.indexOf("\n");
              if (newline < 0) break;
              const line = pending.slice(0, newline);
              pending = pending.slice(newline + 1);
              if (line.length === 0 || line.includes("\r")) throw new Error("Invalid session frame");
              const value: unknown = JSON.parse(line);
              if (first) {
                first = false;
                sessionId = parseOpened(value);
                if (!sessionId) throw new Error("Invalid session opening event");
                settle({ kind: "opened", sessionId });
              } else {
                const event = parseBrowserSessionEvent(value);
                if (!event || event.sessionId !== sessionId) throw new Error("Invalid session event");
                observer.event(event);
              }
            }
          }
          pending += decoder.decode();
          if (first || pending.length !== 0) throw new Error("Session stream ended with an incomplete frame");
          lose();
        } catch {
          lose();
        }
      })();
      const post = (target: string, command: BrowserCommand | BrowserAnalyzeCommand): Promise<number> => commandStatus(target, command, abort.signal);
      return Object.freeze({
        ready,
        analyze: (command: BrowserAnalyzeCommand) => post("/_code-city/analyze", command),
        cancel: (command: BrowserCommand) => post("/_code-city/cancel", command),
        discard: (command: BrowserCommand) => post("/_code-city/discard", command),
        close() {
          intentional = true;
          settle({ kind: "lost" });
          abort.abort();
        },
      });
    },
  });
}

export function nextBrowserGeneration(current: number): number | undefined {
  const next = current + 1;
  return Number.isSafeInteger(next) && next > 0 ? next : undefined;
}

export function createStandaloneBrowserController(transport: BrowserSessionTransport, view: StandaloneBrowserView): StandaloneBrowserController {
  let latestGeneration = 0;
  let owner: BrowserSessionOwner | undefined;
  let sessionId: string | undefined;
  let ownerEpoch = 0;
  let currentGeneration: number | undefined;
  let attemptState: BrowserAttemptState | undefined;
  let disposed = false;

  const clearAssociation = (): void => {
    currentGeneration = undefined;
    attemptState = undefined;
    view.clear();
  };

  const lose = (epoch: number, capacity = false): void => {
    if (disposed || epoch !== ownerEpoch) return;
    const prior = owner;
    owner = undefined;
    sessionId = undefined;
    ownerEpoch += 1;
    prior?.close();
    clearAssociation();
    if (capacity) view.capacity(); else view.lost();
  };

  const onEvent = (epoch: number, event: BrowserSessionEvent): void => {
    if (disposed || epoch !== ownerEpoch || event.sessionId !== sessionId) return;
    if (event.generation < latestGeneration) return;
    if (event.generation > latestGeneration) { lose(epoch); return; }
    const state = attemptState;
    if (!state) return;
    if (state.terminal && event.type === "ANALYSIS_PROGRESS") return;

    if (event.type === "REVISION_SELECTED") {
      if (state.terminal || state.revision !== undefined || state.stage !== 0) { lose(epoch); return; }
      state.revision = event.revision;
      view.revision(event.revision);
      view.progress(state.saved ? "Preparing saved investigation" : "Preparing file inventory");
      return;
    }

    if (event.type === "ANALYSIS_PROGRESS") {
      if (state.terminal || state.revision === undefined || event.revision !== state.revision) { lose(epoch); return; }
      if (event.stage === "acquisition") {
        if (state.stage > 1) { lose(epoch); return; }
        if (state.acquisitionTotal === undefined) {
          state.acquisitionTotal = event.total;
          state.acquisitionCompleted = event.completed;
        } else if (event.total !== state.acquisitionTotal || event.completed <= state.acquisitionCompleted!) {
          lose(epoch);
          return;
        } else {
          state.acquisitionCompleted = event.completed;
        }
        state.stage = 1;
        // One fixed work budget: acquisition + outcome for each candidate,
        // then parser initialization, city construction, and view publication.
        view.progress(`Acquiring files ${event.completed} of ${event.total}`, event.completed, 2 * event.total + 3);
        return;
      }
      if (event.stage === "analysis-initialization") {
        if (state.stage >= 2) { lose(epoch); return; }
        state.stage = 2;
        view.progress("Initializing analysis", state.acquisitionTotal, state.acquisitionTotal === undefined ? undefined : 2 * state.acquisitionTotal + 3);
        return;
      }
      if (event.stage === "analysis") {
        if (state.stage > 3 || (state.acquisitionTotal !== undefined && event.total > state.acquisitionTotal)) {
          lose(epoch);
          return;
        }
        if (state.analysisTotal === undefined) {
          state.analysisTotal = event.total;
          state.analysisCompleted = event.completed;
        } else if (event.total !== state.analysisTotal || event.completed <= state.analysisCompleted!) {
          lose(epoch);
          return;
        } else {
          state.analysisCompleted = event.completed;
        }
        state.stage = 3;
        const candidates = state.acquisitionTotal ?? event.total;
        view.progress(`Analyzing files ${event.completed} of ${event.total}`, 2 * candidates + 1 - event.total + event.completed, 2 * candidates + 3);
        return;
      }
      if (state.stage >= 4) { lose(epoch); return; }
      state.stage = 4;
      const candidates = state.acquisitionTotal ?? state.analysisTotal;
      view.progress("Building city", candidates === undefined ? undefined : 2 * candidates + 1, candidates === undefined ? undefined : 2 * candidates + 3);
      return;
    }

    if (event.type === "ANALYSIS_FAILED") {
      const correlated = event.revision === undefined
        ? state.revision === undefined
        : state.revision !== undefined && event.revision === state.revision;
      if (state.terminal || !correlated) { lose(epoch); return; }
      state.terminal = true;
      currentGeneration = undefined;
      view.failed(event.category, event.code, event.revision);
      return;
    }
    if (event.type === "ANALYSIS_CANCELLED") {
      if (state.terminal) return;
      state.terminal = true;
      currentGeneration = undefined;
      view.cancelled();
      return;
    }
    if (event.type === "CURRENT_DISCARDED") {
      currentGeneration = undefined;
      view.clear();
      return;
    }
    if (state.terminal || state.revision === undefined || event.revision !== state.revision) { lose(epoch); return; }
    state.terminal = true;
    currentGeneration = event.generation;
    const discard = (): void => {
      if (!disposed && currentGeneration === event.generation) void discardGeneration(epoch, event.generation);
    };
    if (event.type === "ANALYSIS_ALL_FILES_FAILED") view.allFilesFailed(event.generation, event.notAnalyzedFiles, event.revision, discard);
    else view.succeeded(event.generation, event.city, event.notAnalyzedFiles, event.revision, discard);
  };

  const openOwner = (): Readonly<{ owner: BrowserSessionOwner; epoch: number }> => {
    const epoch = ownerEpoch + 1;
    ownerEpoch = epoch;
    const created = transport.open({
      event: (event) => onEvent(epoch, event),
      lost: () => lose(epoch),
    });
    owner = created;
    sessionId = undefined;
    void created.ready.then((result) => {
      if (disposed || owner !== created || epoch !== ownerEpoch) return;
      if (result.kind === "opened") sessionId = result.sessionId;
      else lose(epoch, result.kind === "capacity");
    }, () => lose(epoch));
    return { owner: created, epoch };
  };

  const ensureOwner = (): Readonly<{ owner: BrowserSessionOwner; epoch: number }> => owner
    ? { owner, epoch: ownerEpoch }
    : openOwner();

  const cancelGeneration = async (epoch: number, generation: number): Promise<void> => {
    const currentOwner = owner;
    const currentSessionId = sessionId;
    if (disposed || epoch !== ownerEpoch || !currentOwner || generation !== latestGeneration) return;
    if (!currentSessionId) {
      currentOwner.close();
      owner = undefined;
      ownerEpoch += 1;
      sessionId = undefined;
      currentGeneration = undefined;
      view.cancelled();
      return;
    }
    try {
      const status = await currentOwner.cancel({ sessionId: currentSessionId, generation });
      if (disposed || epoch !== ownerEpoch || generation !== latestGeneration) return;
      if (status !== 204) lose(epoch, status === 503);
    } catch {
      lose(epoch);
    }
  };

  const discardGeneration = async (epoch: number, generation: number): Promise<void> => {
    const currentOwner = owner;
    const currentSessionId = sessionId;
    if (disposed || epoch !== ownerEpoch || !currentOwner || !currentSessionId || currentGeneration !== generation) return;
    try {
      const status = await currentOwner.discard({ sessionId: currentSessionId, generation });
      if (disposed || epoch !== ownerEpoch || generation !== latestGeneration) return;
      if (status !== 204) lose(epoch, status === 503);
    } catch {
      lose(epoch);
    }
  };

  const submit = (repositoryUrl: string, additionalExclusions: string, savedId?: string): void => {
    if (disposed) return;
    const generation = nextBrowserGeneration(latestGeneration);
    clearAssociation();
    if (generation === undefined) {
      const prior = owner;
      owner = undefined;
      sessionId = undefined;
      ownerEpoch += 1;
      prior?.close();
      view.lost();
      return;
    }
    latestGeneration = generation;
    if (typeof repositoryUrl !== "string" || typeof additionalExclusions !== "string") {
      const prior = owner;
      owner = undefined;
      sessionId = undefined;
      ownerEpoch += 1;
      prior?.close();
      view.lost();
      return;
    }
    attemptState = { terminal: false, stage: 0, ...(savedId === undefined ? {} : { saved: true }) };
    const selected = ensureOwner();
    view.working(() => { void cancelGeneration(selected.epoch, generation); });
    void (async () => {
      const opened = await selected.owner.ready;
      if (disposed || selected.epoch !== ownerEpoch || generation !== latestGeneration || owner !== selected.owner) return;
      if (opened.kind !== "opened") return;
      sessionId = opened.sessionId;
      const command: BrowserAnalyzeCommand = { sessionId: opened.sessionId, generation, repositoryUrl, additionalExclusions, ...(savedId === undefined ? {} : { savedId }) };
      let serialized: string;
      try { serialized = JSON.stringify(command); }
      catch { lose(selected.epoch); return; }
      if (serialized.length === 0) { lose(selected.epoch); return; }
      try {
        const status = await selected.owner.analyze(command);
        if (disposed || selected.epoch !== ownerEpoch || generation !== latestGeneration) return;
        if (status === 202) {
          const state = attemptState;
          if (state && !state.terminal && state.revision === undefined && state.stage === 0) {
            view.progress(state.saved ? "Opening saved investigation" : "Resolving revision");
          }
          return;
        }
        if (status === 422) {
          currentGeneration = undefined;
          if (attemptState) attemptState.terminal = true;
          view.clear();
          view.invalid();
          return;
        }
        lose(selected.epoch, status === 503);
      } catch {
        lose(selected.epoch);
      }
    })();
  };

  return Object.freeze({
    start() { if (!disposed && !owner) openOwner(); },
    submit,
    openSaved(id) { submit("", "", id); },
    async inspect(query) {
      if (disposed || currentGeneration === undefined || !owner?.inspect) throw new Error("Unit inspection unavailable");
      return owner.inspect(query);
    },
    async save() {
      if (disposed || currentGeneration === undefined || !owner?.save) throw new Error("No completed investigation is available");
      return owner.save();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      ownerEpoch += 1;
      owner?.close();
      owner = undefined;
      sessionId = undefined;
      currentGeneration = undefined;
      view.clear();
    },
  });
}
