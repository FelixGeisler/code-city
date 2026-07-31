/// <reference lib="webworker" />

import { evaluateSafeExtension } from "../../../packages/core/src/index.js";
import {
  safeExtensionFailureMessage,
  validateSafeExtensionWorkerRequest,
  validateSafeExtensionWorkerResponse,
  type SafeExtensionWorkerResponse,
} from "./safe-extension-protocol.js";

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.addEventListener("message", (event: MessageEvent<unknown>) => {
  let request;
  try {
    request = validateSafeExtensionWorkerRequest(event.data);
  } catch {
    return;
  }
  // Evaluation is synchronous. The owning client cancels it by terminating
  // this dedicated worker, which is an immediate interrupt rather than a
  // queued cancel message that cannot run until evaluation has already ended.
  if (request.type === "cancel") return;
  let response: SafeExtensionWorkerResponse;
  try {
    response = validateSafeExtensionWorkerResponse(
      {
        type: "result",
        jobId: request.jobId,
        evaluation: evaluateSafeExtension(
          request.model,
          request.configuration,
        ),
      },
      request,
    );
  } catch (error) {
    response = {
      type: "failure",
      jobId: request.jobId,
      message: safeExtensionFailureMessage(error),
    };
  }
  scope.postMessage(response);
});

export {};
