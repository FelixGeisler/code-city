/// <reference lib="webworker" />
import { evaluateAdvancedQuery } from "./advanced-query.js";
import { advancedQueryFailureMessage, isAdvancedQueryWorkerMessage, type AdvancedQueryWorkerResponse } from "./advanced-query-protocol.js";
import { validateCityModel } from "./model-validation.js";
const scope = self as unknown as DedicatedWorkerGlobalScope;
const cancelled = new Set<number>();
scope.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (!isAdvancedQueryWorkerMessage(event.data)) return;
  if (event.data.type === "cancel") { cancelled.add(event.data.jobId); return; }
  const request = event.data;
  cancelled.delete(request.jobId);
  let response: AdvancedQueryWorkerResponse;
  try { response = { type: "result", jobId: request.jobId, result: evaluateAdvancedQuery(validateCityModel(request.model), request.query, new Set(request.selectedBuildingIds), request.limit) }; }
  catch (error) { response = { type: "failure", jobId: request.jobId, message: advancedQueryFailureMessage(error) }; }
  if (!cancelled.has(request.jobId)) scope.postMessage(response);
});
export {};
