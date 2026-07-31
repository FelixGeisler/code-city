import type { CityModel, ExtensionEvaluation } from "../../../packages/core/src/index.js";

export interface SafeExtensionEvaluateRequest { readonly type: "evaluate"; readonly jobId: number; readonly model: CityModel; readonly configuration: unknown; }
export interface SafeExtensionCancelRequest { readonly type: "cancel"; readonly jobId: number; }
export type SafeExtensionWorkerRequest = SafeExtensionEvaluateRequest | SafeExtensionCancelRequest;
export type SafeExtensionWorkerResponse = { readonly type: "result"; readonly jobId: number; readonly evaluation: ExtensionEvaluation } | { readonly type: "failure"; readonly jobId: number; readonly message: string };
const record = (value: unknown): Record<string, unknown> | undefined => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
const job = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
export function isSafeExtensionWorkerRequest(value: unknown): value is SafeExtensionWorkerRequest { const candidate = record(value); return candidate !== undefined && job(candidate.jobId) && ((candidate.type === "cancel" && exact(candidate, ["type", "jobId"])) || (candidate.type === "evaluate" && exact(candidate, ["type", "jobId", "model", "configuration"]) && record(candidate.model) !== undefined)); }
export function isSafeExtensionWorkerResponse(value: unknown): value is SafeExtensionWorkerResponse { const candidate = record(value); return candidate !== undefined && job(candidate.jobId) && ((candidate.type === "result" && exact(candidate, ["type", "jobId", "evaluation"]) && record(candidate.evaluation) !== undefined) || (candidate.type === "failure" && exact(candidate, ["type", "jobId", "message"]) && typeof candidate.message === "string" && candidate.message.length > 0 && candidate.message.length <= 512)); }
export function safeExtensionFailureMessage(error: unknown): string { return (error instanceof Error && error.message ? error.message : "The extension could not be evaluated.").slice(0, 512); }
