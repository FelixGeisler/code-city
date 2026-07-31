/// <reference lib="webworker" />

import {
  evaluateAdvancedQuery,
  validateAdvancedQueryDefinition,
  type AdvancedQueryContext,
} from "./advanced-query.js";
import {
  advancedQueryFailureMessage,
  isAdvancedQueryEvaluateRequest,
  type AdvancedQueryWorkerResponse,
} from "./advanced-query-protocol.js";
import { validateCityModel } from "./model-validation.js";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.addEventListener("message", (event: MessageEvent<unknown>) => {
  const request = event.data;
  if (!isAdvancedQueryEvaluateRequest(request)) return;
  let response: AdvancedQueryWorkerResponse;
  try {
    const model = validateCityModel(request.model);
    const definition = validateAdvancedQueryDefinition(
      request.definition,
    );
    const context: AdvancedQueryContext = {
      ...(request.context.changes === null
        ? {}
        : {
            changesByBuildingId: new Map(
              request.context.changes.map(([id, changes]) => [
                id,
                new Set(changes),
              ]),
            ),
          }),
      ...(request.context.smellRules === null
        ? {}
        : {
            smellRuleIdsByBuildingId: new Map(
              request.context.smellRules.map(([id, ruleIds]) => [
                id,
                new Set(ruleIds),
              ]),
            ),
          }),
      ...(request.context.ruleSchemaVersion === null
        ? {}
        : {
            ruleSchemaVersion: request.context.ruleSchemaVersion,
          }),
    };
    response = {
      type: "result",
      jobId: request.jobId,
      evaluation: evaluateAdvancedQuery(model, definition, context),
    };
  } catch (error) {
    response = {
      type: "failure",
      jobId: request.jobId,
      message: advancedQueryFailureMessage(error),
    };
  }
  workerScope.postMessage(response);
});

export {};
