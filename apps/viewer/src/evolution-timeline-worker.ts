/// <reference lib="webworker" />

import {
  ValidatedEvolutionReplayCursor,
  validateEvolutionBundle,
  type EvolutionBundle,
} from "../../../packages/core/src/index.js";
import {
  analyzeEvolutionBuildingHistory,
  analyzeEvolutionFrame,
  compareEvolutionFrames,
  summarizeEvolutionFrames,
} from "./evolution-timeline.js";
import {
  evolutionWorkerFailureMessage,
  isEvolutionWorkerRequest,
  type EvolutionWorkerResponse,
} from "./evolution-timeline-protocol.js";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
let activeBundle: EvolutionBundle | undefined;
let replayCursor: ValidatedEvolutionReplayCursor | undefined;
let latestRequestId = 0;

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function assertCurrentRequest(requestId: number): void {
  if (requestId !== latestRequestId) {
    throw new DOMException("The evolution seek was replaced.", "AbortError");
  }
}

workerScope.addEventListener(
  "message",
  async (event: MessageEvent<unknown>) => {
    const request = event.data;
    if (!isEvolutionWorkerRequest(request)) return;
    latestRequestId = request.requestId;
    if (request.type === "cancel") return;
    let response: EvolutionWorkerResponse;
    try {
      if (request.type === "load") {
        const digest = await crypto.subtle.digest("SHA-256", request.bytes);
        if (hex(digest) !== request.expectedSha256) {
          throw new Error("The evolution artifact checksum does not match.");
        }
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          request.bytes,
        );
        const bundle = validateEvolutionBundle(JSON.parse(text) as unknown);
        activeBundle = bundle;
        replayCursor = new ValidatedEvolutionReplayCursor(bundle);
        response = {
          type: "loaded",
          requestId: request.requestId,
          frames: summarizeEvolutionFrames(bundle),
          histories: analyzeEvolutionBuildingHistory(bundle),
          model: structuredClone(bundle.baseline.model),
          analysis: analyzeEvolutionFrame(bundle, 0),
        };
      } else {
        const bundle = activeBundle;
        const cursor = replayCursor;
        if (!bundle || !cursor) {
          throw new Error("Repository evolution is not loaded.");
        }
        const replay = await cursor.seek(
          request.fromIndex,
          request.toIndex,
          {
            checkpoint: () => assertCurrentRequest(request.requestId),
            yieldControl: () =>
              new Promise<void>((resolve) => setTimeout(resolve, 0)),
          },
        );
        assertCurrentRequest(request.requestId);
        const frames = summarizeEvolutionFrames(bundle);
        response = {
          type: "frame",
          requestId: request.requestId,
          frame: frames[request.toIndex]!,
          model: replay.model,
          analysis: analyzeEvolutionFrame(bundle, request.toIndex),
          transition: compareEvolutionFrames(
            replay.fromModel,
            replay.model,
            request.fromIndex,
            request.toIndex,
          ),
        };
      }
    } catch (error) {
      response = {
        type: "failure",
        requestId: request.requestId,
        message: evolutionWorkerFailureMessage(error),
      };
    }
    workerScope.postMessage(response);
  },
);

export {};
