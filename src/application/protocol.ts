import { FAILURE_CATEGORIES, FAILURE_CODES, type FailureCode } from "./resolution";
import { validateCityPayload, type CityPayload, type ValidatedCity } from "./city-payload";
import type { RepositoryReference } from "../domain/repository-reference";

export type WorkerCommand =
  | Readonly<{ type: "START"; generation: number; repository: RepositoryReference }>
  | Readonly<{ type: "STOP"; generation: number }>;

type PreSelectionCategory =
  | "Repository unavailable for anonymous access"
  | "Revision unavailable"
  | "Provider/resolution failure";

type PostSelectionUncodedCategory =
  | "Provider/resolution failure"
  | "Repository exceeds Code City limits";

type PostSelectionCodedCategory =
  | "No supported modules"
  | "Source admission failed"
  | "Metric processing failed"
  | "City construction failed";

export type WorkerMessage<C extends CityPayload = CityPayload> =
  | Readonly<{ type: "REVISION_SELECTED"; generation: number; revision: string }>
  | Readonly<{ type: "FAILURE"; generation: number; category: PreSelectionCategory }>
  | Readonly<{ type: "FAILURE"; generation: number; revision: string; category: PostSelectionUncodedCategory }>
  | Readonly<{ type: "FAILURE"; generation: number; revision: string; category: PostSelectionCodedCategory; code: FailureCode }>
  | Readonly<{ type: "PROVIDER_DRAINED_STATIC_ENTERED"; generation: number }>
  | Readonly<{ type: "SUCCESS"; generation: number; revision: string; city: C }>
  | Readonly<{ type: "ATTEMPT_DRAINED"; generation: number }>;

export type ParsedWorkerMessage = WorkerMessage<ValidatedCity>;

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

function validGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function validRevision(value: unknown): value is string {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
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
    if (typeof value !== "object" || value === null) {
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, "generation");
    return descriptor && "value" in descriptor && validGeneration(descriptor.value)
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

export function parseWorkerCommand(value: unknown): WorkerCommand | undefined {
  const start = ownDataRecord(value, ["type", "generation", "repository"]);
  if (start?.type === "START" && validGeneration(start.generation)) {
    const repository = repositoryReference(start.repository);
    return repository ? { type: "START", generation: start.generation, repository } : undefined;
  }

  const stop = ownDataRecord(value, ["type", "generation"]);
  return stop?.type === "STOP" && validGeneration(stop.generation)
    ? { type: "STOP", generation: stop.generation }
    : undefined;
}

function validFailureCode(category: string, code: unknown): code is FailureCode {
  if (category !== "No supported modules"
    && category !== "Source admission failed"
    && category !== "Metric processing failed"
    && category !== "City construction failed") {
    return false;
  }
  if (typeof code !== "string" || !(FAILURE_CODES as readonly string[]).includes(code)) {
    return false;
  }
  if (category === "No supported modules") {
    return code === "ADM-06" || code === "ADM-07";
  }
  if (category === "Source admission failed") {
    return code === "M1-ADM-1" || code === "M1-ADM-3" || code === "M1-ADM-4";
  }
  if (category === "Metric processing failed") {
    return code === "M1-MET-1";
  }
  return code === "M1-CITY-1";
}

function expectedGeneration(record: DataRecord | undefined, expected: number): record is DataRecord & { generation: number } {
  return record?.generation === expected && validGeneration(record.generation);
}

export function parseWorkerMessage(value: unknown, expected: number): ParsedWorkerMessage | undefined {
  const selected = ownDataRecord(value, ["type", "generation", "revision"]);
  if (selected?.type === "REVISION_SELECTED"
    && expectedGeneration(selected, expected)
    && validRevision(selected.revision)) {
    return { type: "REVISION_SELECTED", generation: selected.generation, revision: selected.revision };
  }

  const success = ownDataRecord(value, ["type", "generation", "revision", "city"]);
  if (success?.type === "SUCCESS"
    && expectedGeneration(success, expected)
    && validRevision(success.revision)) {
    try {
      return {
        type: "SUCCESS",
        generation: success.generation,
        revision: success.revision,
        city: validateCityPayload(success.city),
      };
    } catch {
      return {
        type: "FAILURE",
        generation: success.generation,
        revision: success.revision,
        category: "City construction failed",
        code: "M1-CITY-1",
      };
    }
  }

  const codedFailure = ownDataRecord(value, ["type", "generation", "revision", "category", "code"]);
  if (codedFailure?.type === "FAILURE"
    && expectedGeneration(codedFailure, expected)
    && validRevision(codedFailure.revision)
    && typeof codedFailure.category === "string"
    && (FAILURE_CATEGORIES as readonly string[]).includes(codedFailure.category)
    && validFailureCode(codedFailure.category, codedFailure.code)) {
    return {
      type: "FAILURE",
      generation: codedFailure.generation,
      revision: codedFailure.revision,
      category: codedFailure.category as PostSelectionCodedCategory,
      code: codedFailure.code,
    };
  }

  const postSelectionFailure = ownDataRecord(value, ["type", "generation", "revision", "category"]);
  if (postSelectionFailure?.type === "FAILURE"
    && expectedGeneration(postSelectionFailure, expected)
    && validRevision(postSelectionFailure.revision)
    && (postSelectionFailure.category === "Provider/resolution failure"
      || postSelectionFailure.category === "Repository exceeds Code City limits")) {
    return {
      type: "FAILURE",
      generation: postSelectionFailure.generation,
      revision: postSelectionFailure.revision,
      category: postSelectionFailure.category,
    };
  }

  const preSelectionFailure = ownDataRecord(value, ["type", "generation", "category"]);
  if (preSelectionFailure?.type === "FAILURE"
    && expectedGeneration(preSelectionFailure, expected)
    && (preSelectionFailure.category === "Repository unavailable for anonymous access"
      || preSelectionFailure.category === "Revision unavailable"
      || preSelectionFailure.category === "Provider/resolution failure")) {
    return {
      type: "FAILURE",
      generation: preSelectionFailure.generation,
      category: preSelectionFailure.category,
    };
  }

  const terminal = ownDataRecord(value, ["type", "generation"]);
  if (!expectedGeneration(terminal, expected)) {
    return undefined;
  }
  if (terminal.type === "PROVIDER_DRAINED_STATIC_ENTERED") {
    return { type: "PROVIDER_DRAINED_STATIC_ENTERED", generation: terminal.generation };
  }
  return terminal.type === "ATTEMPT_DRAINED"
    ? { type: "ATTEMPT_DRAINED", generation: terminal.generation }
    : undefined;
}
