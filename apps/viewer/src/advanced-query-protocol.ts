import type { CityModel } from "../../../packages/core/src/model.js";
import type { AdvancedQuery, AdvancedQueryResult } from "./advanced-query.js";

export interface AdvancedQueryWorkerRequest { readonly type: "evaluate"; readonly jobId: number; readonly model: CityModel; readonly query: AdvancedQuery; readonly selectedBuildingIds: readonly string[]; readonly limit: number; }
export interface AdvancedQueryWorkerCancel { readonly type: "cancel"; readonly jobId: number; }
export type AdvancedQueryWorkerMessage = AdvancedQueryWorkerRequest | AdvancedQueryWorkerCancel;
export type AdvancedQueryWorkerResponse = { readonly type: "result"; readonly jobId: number; readonly result: AdvancedQueryResult } | { readonly type: "failure"; readonly jobId: number; readonly message: string };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const jobId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
export function isAdvancedQueryWorkerMessage(value: unknown): value is AdvancedQueryWorkerMessage { if (!isRecord(value) || !jobId(value.jobId) || typeof value.type !== "string") return false; return value.type === "cancel" ? Object.keys(value).length === 2 : value.type === "evaluate" && isRecord(value.model) && isRecord(value.query) && Array.isArray(value.selectedBuildingIds) && value.selectedBuildingIds.every((id) => typeof id === "string") && typeof value.limit === "number"; }
export function isAdvancedQueryWorkerResponse(value: unknown): value is AdvancedQueryWorkerResponse { return isRecord(value) && jobId(value.jobId) && ((value.type === "result" && isRecord(value.result)) || (value.type === "failure" && typeof value.message === "string" && value.message.length > 0 && value.message.length <= 512)); }
export function advancedQueryFailureMessage(error: unknown): string { return (error instanceof Error && error.message ? error.message : "The advanced query could not be evaluated.").slice(0, 512); }
