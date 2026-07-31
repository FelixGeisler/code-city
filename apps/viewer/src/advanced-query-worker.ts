/// <reference lib="webworker" />

import {
  evaluateAdvancedQuery,
  validateAdvancedQueryDefinition,
  type AdvancedQueryContext,
} from "./advanced-query.js";
import {
  advancedQueryFailureForInvalidRequest,
  advancedQueryFailureMessage,
  isAdvancedQueryEvaluateRequest,
  type AdvancedQueryEvaluateRequest,
  type AdvancedQueryWorkerResponse,
} from "./advanced-query-protocol.js";
import { validateCityModel } from "./model-validation.js";

export interface AdvancedQueryWorkerScope {
  readonly importScripts: (...urls: string[]) => void;
  readonly postMessage: (
    response: AdvancedQueryWorkerResponse,
  ) => void;
  readonly addEventListener: (
    type: "message",
    listener: (event: { readonly data: unknown }) => void,
  ) => void;
  readonly removeEventListener: (
    type: "message",
    listener: (event: { readonly data: unknown }) => void,
  ) => void;
}

function evaluateRequest(
  request: AdvancedQueryEvaluateRequest,
): AdvancedQueryWorkerResponse {
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
      ...(request.context.availableSmellRules === null
        ? {}
        : {
            availableSmellRuleIdsByBuildingId: new Map(
              request.context.availableSmellRules.map(
                ([id, ruleIds]) => [id, new Set(ruleIds)],
              ),
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
  return response;
}

export function isDedicatedAdvancedQueryWorkerScope(
  value: unknown,
): value is AdvancedQueryWorkerScope {
  if (typeof value !== "object" || value === null) return false;
  const scope = value as Record<string, unknown>;
  return (
    typeof scope["importScripts"] === "function" &&
    typeof scope["postMessage"] === "function" &&
    typeof scope["addEventListener"] === "function" &&
    typeof scope["removeEventListener"] === "function" &&
    !("document" in scope) &&
    !("clients" in scope) &&
    !("onconnect" in scope)
  );
}

export function installAdvancedQueryWorker(
  scope: AdvancedQueryWorkerScope,
): () => void {
  const listener = (event: { readonly data: unknown }): void => {
    const request = event.data;
    if (!isAdvancedQueryEvaluateRequest(request)) {
      const failure =
        advancedQueryFailureForInvalidRequest(request);
      if (failure !== undefined) scope.postMessage(failure);
      return;
    }
    scope.postMessage(evaluateRequest(request));
  };
  scope.addEventListener("message", listener);
  return () => {
    scope.removeEventListener("message", listener);
  };
}

if (isDedicatedAdvancedQueryWorkerScope(globalThis)) {
  installAdvancedQueryWorker(
    globalThis as unknown as AdvancedQueryWorkerScope,
  );
}
