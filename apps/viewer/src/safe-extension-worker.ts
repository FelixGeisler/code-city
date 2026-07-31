/// <reference lib="webworker" />
import { evaluateSafeExtension, validateCityModel } from "../../../packages/core/src/index.js";
import { isSafeExtensionWorkerRequest, safeExtensionFailureMessage, type SafeExtensionWorkerResponse } from "./safe-extension-protocol.js";
const scope = self as unknown as DedicatedWorkerGlobalScope;
const cancelled = new Set<number>();
scope.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (!isSafeExtensionWorkerRequest(event.data)) return;
  const request = event.data;
  if (request.type === "cancel") { cancelled.add(request.jobId); return; }
  cancelled.delete(request.jobId);
  let response: SafeExtensionWorkerResponse;
  try { response = { type: "result", jobId: request.jobId, evaluation: evaluateSafeExtension(validateCityModel(request.model), request.configuration, { checkpoint: () => { if (cancelled.has(request.jobId)) throw new DOMException("The extension evaluation was cancelled.", "AbortError"); } }) }; }
  catch (error) { response = { type: "failure", jobId: request.jobId, message: safeExtensionFailureMessage(error) }; }
  if (!cancelled.has(request.jobId)) scope.postMessage(response);
});
export {};
