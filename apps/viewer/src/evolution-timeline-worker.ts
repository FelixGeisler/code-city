/// <reference lib="webworker" />

import { EvolutionTimelineWorkerRuntime } from "./evolution-timeline-worker-runtime.js";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
const runtime = new EvolutionTimelineWorkerRuntime({
  postMessage: (response) => workerScope.postMessage(response),
});

workerScope.addEventListener("message", (event: MessageEvent<unknown>) => {
  void runtime.handle(event.data);
});

export {};
