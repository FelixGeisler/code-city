/// <reference lib="webworker" />

import {
  applyMetricMapping,
  validateMetricMappingDefinition,
} from "../../../packages/core/src/index.js";
import {
  isMetricMappingProjectRequest,
  metricMappingFailureMessage,
  type MetricMappingWorkerResponse,
} from "./metric-mapping-protocol.js";
import { validateCityModel } from "./model-validation.js";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.addEventListener("message", (event: MessageEvent<unknown>) => {
  const request = event.data;
  if (!isMetricMappingProjectRequest(request)) return;

  let response: MetricMappingWorkerResponse;
  try {
    const source = validateCityModel(request.model);
    validateMetricMappingDefinition(request.mapping);
    response = {
      type: "result",
      jobId: request.jobId,
      model: applyMetricMapping(source, request.mapping),
    };
  } catch (error) {
    response = {
      type: "failure",
      jobId: request.jobId,
      message: metricMappingFailureMessage(error),
    };
  }
  workerScope.postMessage(response);
});

export {};
