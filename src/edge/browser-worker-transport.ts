import { parseRepositoryReference } from "../domain/repository-reference";
import { parseAdditionalExclusions } from "../domain/source-admission";
import { parseBrowserSessionEvent, type BrowserAnalyzeCommand, type BrowserCommand, type BrowserSessionTransport } from "./standalone-browser-controller";

type OwnedWorker = {
  worker: Worker;
  generation: number;
  providerActive: boolean;
  finished: boolean;
  stop?: Promise<void>;
  releaseStop?: () => void;
  dispose(): void;
};

/** Browser-local ownership only: opening an idle page performs no backend request. */
export function createBrowserWorkerTransport(
  createWorker: () => Worker = () => new Worker(new URL("./browser-analysis-worker.ts", import.meta.url), { type: "module" }),
): BrowserSessionTransport {
  return Object.freeze({
    open(observer) {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const sessionId = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
      let closed = false;
      let version = 0;
      let latestGeneration = 0;
      let active: OwnedWorker | undefined;
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
          if (!parseRepositoryReference(command.repositoryUrl) || !parseAdditionalExclusions(command.additionalExclusions)) return 422;
          try {
            const worker = createWorker();
            let disposed = false;
            const owned: OwnedWorker = {
              worker, generation: command.generation, providerActive: true, finished: false,
              dispose() {
                if (disposed) return;
                disposed = true;
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
              const event = parseBrowserSessionEvent(received.data);
              if (!event || event.sessionId !== sessionId || event.generation !== command.generation) { error(); return; }
              if (event.type === "ANALYSIS_PROGRESS" && event.stage !== "acquisition") owned.providerActive = false;
              const terminal = event.type === "ANALYSIS_SUCCEEDED" || event.type === "ANALYSIS_ALL_FILES_FAILED"
                || event.type === "ANALYSIS_FAILED" || event.type === "ANALYSIS_CANCELLED";
              if (owned.stop) {
                if (terminal || !owned.providerActive) destroy(owned);
                return;
              }
              if (version !== selectedVersion) return;
              if (terminal) owned.finished = true;
              observer.event(event);
              if (event.type === "ANALYSIS_FAILED" || event.type === "ANALYSIS_CANCELLED") destroy(owned);
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
