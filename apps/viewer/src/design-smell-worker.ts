/// <reference lib="webworker" />
import { evaluateDesignSmells, validateDesignSmellConfiguration, validateDesignSmellSuppression } from "../../../packages/core/src/index.js";
import { validateCityModel } from "./model-validation.js";
import { designSmellFailureMessage, isDesignSmellEvaluateRequest, type DesignSmellWorkerResponse } from "./design-smell-protocol.js";
const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.addEventListener("message", (event: MessageEvent<unknown>) => { if (!isDesignSmellEvaluateRequest(event.data)) return; let response: DesignSmellWorkerResponse; try { const model = validateCityModel(event.data.model); validateDesignSmellConfiguration(event.data.configuration); event.data.suppressions.forEach(validateDesignSmellSuppression); response = { type: "result", jobId: event.data.jobId, evaluation: evaluateDesignSmells(model, event.data.configuration, event.data.suppressions) }; } catch (error) { response = { type: "failure", jobId: event.data.jobId, message: designSmellFailureMessage(error) }; } scope.postMessage(response); });
export {};
