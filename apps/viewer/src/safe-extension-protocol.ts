import {
  validateSafeExtensionConfiguration,
  validateSafeExtensionEvaluation,
  validateSafeExtensionModelSnapshot,
  type ExtensionEvaluation,
  type SafeExtensionConfigurationV1,
  type SafeExtensionModelSnapshot,
} from "../../../packages/core/src/index.js";

export interface SafeExtensionEvaluateRequest {
  readonly type: "evaluate";
  readonly jobId: number;
  readonly model: SafeExtensionModelSnapshot;
  readonly configuration: SafeExtensionConfigurationV1;
}

export interface SafeExtensionCancelRequest {
  readonly type: "cancel";
  readonly jobId: number;
}

export type SafeExtensionWorkerRequest =
  | SafeExtensionEvaluateRequest
  | SafeExtensionCancelRequest;

export type SafeExtensionWorkerResponse =
  | {
      readonly type: "result";
      readonly jobId: number;
      readonly evaluation: ExtensionEvaluation;
    }
  | {
      readonly type: "failure";
      readonly jobId: number;
      readonly message: string;
    };

const unsafeText = /[\p{Cc}\p{Cf}\p{Cs}]/u;

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Worker message must be an object.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Worker message must be plain data.");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError("Worker message contains unsupported properties.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Object.keys(descriptors);
  if (
    actual.length !== keys.length ||
    !keys.every((key) => Object.hasOwn(descriptors, key))
  ) {
    throw new TypeError("Worker message contains unsupported properties.");
  }
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of keys) {
    const descriptor = descriptors[key]!;
    if (!("value" in descriptor)) {
      throw new TypeError("Worker message must not contain accessors.");
    }
    result[key] = descriptor.value;
  }
  return result;
}

function validateJobId(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    throw new TypeError("Worker job ID is invalid.");
  }
  return value;
}

export function validateSafeExtensionWorkerRequest(
  value: unknown,
): SafeExtensionWorkerRequest {
  const envelope = exactRecord(
    value,
    typeof value === "object" &&
      value !== null &&
      Object.getOwnPropertyDescriptor(value, "type")?.value === "cancel"
      ? ["type", "jobId"]
      : ["type", "jobId", "model", "configuration"],
  );
  const jobId = validateJobId(envelope.jobId);
  if (envelope.type === "cancel") {
    return Object.freeze({ type: "cancel", jobId });
  }
  if (envelope.type !== "evaluate") {
    throw new TypeError("Worker request type is invalid.");
  }
  return Object.freeze({
    type: "evaluate",
    jobId,
    model: validateSafeExtensionModelSnapshot(envelope.model),
    configuration: validateSafeExtensionConfiguration(envelope.configuration),
  });
}

export function isSafeExtensionWorkerRequest(
  value: unknown,
): value is SafeExtensionWorkerRequest {
  try {
    validateSafeExtensionWorkerRequest(value);
    return true;
  } catch {
    return false;
  }
}

export interface SafeExtensionResponseExpectation {
  readonly model: SafeExtensionModelSnapshot;
  readonly configuration: SafeExtensionConfigurationV1;
}

export function validateSafeExtensionWorkerResponse(
  value: unknown,
  expected?: SafeExtensionResponseExpectation,
): SafeExtensionWorkerResponse {
  const type =
    typeof value === "object" && value !== null
      ? Object.getOwnPropertyDescriptor(value, "type")?.value
      : undefined;
  const envelope = exactRecord(
    value,
    type === "failure"
      ? ["type", "jobId", "message"]
      : ["type", "jobId", "evaluation"],
  );
  const jobId = validateJobId(envelope.jobId);
  if (envelope.type === "failure") {
    if (
      typeof envelope.message !== "string" ||
      envelope.message.length < 1 ||
      envelope.message.length > 512 ||
      unsafeText.test(envelope.message)
    ) {
      throw new TypeError("Worker failure message is invalid.");
    }
    return Object.freeze({ type: "failure", jobId, message: envelope.message });
  }
  if (envelope.type !== "result") {
    throw new TypeError("Worker response type is invalid.");
  }
  return Object.freeze({
    type: "result",
    jobId,
    evaluation: validateSafeExtensionEvaluation(
      envelope.evaluation,
      expected === undefined
        ? {}
        : {
            model: expected.model,
            configuration: expected.configuration,
          },
    ),
  });
}

export function isSafeExtensionWorkerResponse(
  value: unknown,
): value is SafeExtensionWorkerResponse {
  try {
    validateSafeExtensionWorkerResponse(value);
    return true;
  } catch {
    return false;
  }
}

export function safeExtensionFailureMessage(error: unknown): string {
  const source =
    error instanceof Error && error.message
      ? error.message
      : "The extension could not be evaluated.";
  const sanitized = source
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, " ")
    .trim()
    .slice(0, 512);
  return sanitized || "The extension could not be evaluated.";
}
