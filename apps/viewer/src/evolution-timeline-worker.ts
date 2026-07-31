/// <reference lib="webworker" />

import {
  replayValidatedEvolutionBundle,
  validateEvolutionBundle,
  type CityModel,
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
let activeFrameIndex = 0;
let activeFrameModel: CityModel | undefined;
let latestRequestId = 0;

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function replayAt(
  bundle: EvolutionBundle,
  index: number,
  requestId: number,
): Promise<CityModel> {
  if (index < 0 || index > bundle.deltas.length) {
    throw new Error("The requested evolution frame is out of range.");
  }
  if (activeFrameIndex === index && activeFrameModel !== undefined) {
    return structuredClone(activeFrameModel);
  }
  for (const frame of replayValidatedEvolutionBundle(bundle)) {
    if (requestId !== latestRequestId) {
      throw new DOMException("The evolution seek was replaced.", "AbortError");
    }
    if (frame.commit.index === index) {
      return frame.model;
    }
    if (frame.commit.index % 4 === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  throw new Error("The requested evolution frame is unavailable.");
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
        activeFrameIndex = 0;
        activeFrameModel = structuredClone(bundle.baseline.model);
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
        if (!bundle) throw new Error("Repository evolution is not loaded.");
        const from = await replayAt(
          bundle,
          request.fromIndex,
          request.requestId,
        );
        const model = await replayAt(
          bundle,
          request.toIndex,
          request.requestId,
        );
        if (request.requestId !== latestRequestId) {
          throw new DOMException(
            "The evolution seek was replaced.",
            "AbortError",
          );
        }
        activeFrameIndex = request.toIndex;
        activeFrameModel = structuredClone(model);
        const frames = summarizeEvolutionFrames(bundle);
        response = {
          type: "frame",
          requestId: request.requestId,
          frame: frames[request.toIndex]!,
          model,
          analysis: analyzeEvolutionFrame(bundle, request.toIndex),
          transition: compareEvolutionFrames(
            from,
            model,
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
