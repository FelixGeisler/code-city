import { FAILURE_CATEGORIES, FAILURE_CODES, type FailureCategory, type FailureCode } from "./resolution";
import type { RepositoryReference } from "../domain/repository-reference";

export type WorkerCommand =
  | Readonly<{ type: "START"; generation: number; repository: RepositoryReference }>
  | Readonly<{ type: "STOP"; generation: number }>;

export type WorkerMessage =
  | Readonly<{ type: "FAILURE"; generation: number; category: FailureCategory; code?: FailureCode }>
  | Readonly<{ type: "PROVIDER_DRAINED_STATIC_ENTERED"; generation: number }>
  | Readonly<{ type: "ATTEMPT_DRAINED"; generation: number }>;

type DataRecord = Record<string, unknown>;

function ownDataRecord(value: unknown, exactKeys: readonly string[]): DataRecord | undefined {
  try {
    if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) {
      return undefined;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")
      || Object.keys(descriptors).length !== exactKeys.length
      || exactKeys.some((key) => !Object.hasOwn(descriptors, key))) {
      return undefined;
    }
    for (const descriptor of Object.values(descriptors)) {
      if (!("value" in descriptor) || !descriptor.enumerable) {
        return undefined;
      }
    }
    return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
  } catch {
    return undefined;
  }
}

function generation(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function repositoryReference(value: unknown): RepositoryReference | undefined {
  const record = ownDataRecord(value, ["owner", "repository"]);
  if (!record || typeof record.owner !== "string" || typeof record.repository !== "string") {
    return undefined;
  }
  return { owner: record.owner, repository: record.repository };
}

export function readGeneration(value: unknown): number | undefined {
  try {
    if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) {
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, "generation");
    return descriptor && "value" in descriptor && generation(descriptor.value)
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

export function parseWorkerCommand(value: unknown): WorkerCommand | undefined {
  const start = ownDataRecord(value, ["type", "generation", "repository"]);
  if (start?.type === "START" && generation(start.generation)) {
    const repository = repositoryReference(start.repository);
    return repository ? { type: "START", generation: start.generation, repository } : undefined;
  }

  const stop = ownDataRecord(value, ["type", "generation"]);
  return stop?.type === "STOP" && generation(stop.generation)
    ? { type: "STOP", generation: stop.generation }
    : undefined;
}

function validFailureCode(category: FailureCategory, code: unknown): code is FailureCode {
  if (typeof code !== "string" || !(FAILURE_CODES as readonly string[]).includes(code)) {
    return false;
  }
  return category === "No supported modules"
    ? code === "ADM-06" || code === "ADM-07"
    : category === "Source admission failed" && code.startsWith("M1-ADM-");
}

export function parseWorkerMessage(value: unknown, expectedGeneration: number): WorkerMessage | undefined {
  const codedFailure = ownDataRecord(value, ["type", "generation", "category", "code"]);
  if (codedFailure?.type === "FAILURE"
    && codedFailure.generation === expectedGeneration
    && generation(codedFailure.generation)
    && typeof codedFailure.category === "string"
    && (FAILURE_CATEGORIES as readonly string[]).includes(codedFailure.category)
    && validFailureCode(codedFailure.category as FailureCategory, codedFailure.code)) {
    return {
      type: "FAILURE",
      generation: codedFailure.generation,
      category: codedFailure.category as FailureCategory,
      code: codedFailure.code,
    };
  }

  const failure = ownDataRecord(value, ["type", "generation", "category"]);
  if (failure?.type === "FAILURE"
    && failure.generation === expectedGeneration
    && generation(failure.generation)
    && typeof failure.category === "string"
    && (FAILURE_CATEGORIES as readonly string[]).includes(failure.category)
    && failure.category !== "No supported modules"
    && failure.category !== "Source admission failed") {
    return {
      type: "FAILURE",
      generation: failure.generation,
      category: failure.category as FailureCategory,
    };
  }

  const terminal = ownDataRecord(value, ["type", "generation"]);
  if (terminal?.generation !== expectedGeneration || !generation(terminal.generation)) {
    return undefined;
  }
  if (terminal.type === "PROVIDER_DRAINED_STATIC_ENTERED") {
    return { type: "PROVIDER_DRAINED_STATIC_ENTERED", generation: terminal.generation };
  }
  return terminal.type === "ATTEMPT_DRAINED"
    ? { type: "ATTEMPT_DRAINED", generation: terminal.generation }
    : undefined;
}
