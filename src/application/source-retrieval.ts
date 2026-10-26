import type { RepositoryReference } from "../domain/repository-reference";
import { applyRequestedSourceByteOwnership } from "./internal/source-byte-ownership";
import {
  createSourceAdmissionSession,
  MAX_ADMITTED_MODULES,
  MAX_NORMALIZED_MODULE_BYTES,
  MAX_NORMALIZED_TOTAL_BYTES,
  normalizeSourceText,
  prepareSourceInventory,
  type AdmittedModule,
  type AdmissionCode,
  type ProjectedTreeEntry,
  type SourceCandidate,
} from "../domain/source-admission";

export type SourceFailure = Readonly<{
  kind: "failure";
  category: "Provider/resolution failure" | "No supported modules" | "Source admission failed" | "Repository exceeds Code City limits";
  code?: AdmissionCode;
}>;

export type InventoryGatewayResult =
  | Readonly<{ kind: "inventory"; entries: readonly ProjectedTreeEntry[] }>
  | Readonly<{ kind: "provider-failure" }>;

export type SourceGatewayResult =
  | Readonly<{ kind: "source"; decodedSource: string }>
  | Readonly<{ kind: "provider-failure" }>
  | Readonly<{ kind: "invalid-content" }>
  | Readonly<{ kind: "product-limit" }>;

export type ImmutableSourceGateway = Readonly<{
  loadInventory(
    repository: RepositoryReference,
    selected: string,
    signal: AbortSignal,
    additionalExclusions?: readonly string[],
  ): Promise<InventoryGatewayResult>;
  readSource(
    repository: RepositoryReference,
    selected: string,
    candidate: Readonly<SourceCandidate & { expectedBlobId: string }>,
    signal: AbortSignal,
  ): Promise<SourceGatewayResult>;
}>;

export type RawSourceGatewayResult =
  | Readonly<{ kind: "source"; rawBytes: Uint8Array }>
  | Readonly<{ kind: "provider-failure" }>
  | Readonly<{ kind: "product-limit" }>;

export type ImmutableRawSourceGateway = Readonly<{
  loadInventory(
    repository: RepositoryReference,
    selected: string,
    signal: AbortSignal,
    additionalExclusions?: readonly string[],
  ): Promise<InventoryGatewayResult>;
  readRawSource(
    repository: RepositoryReference,
    selected: string,
    candidate: Readonly<SourceCandidate & { expectedBlobId: string }>,
    signal: AbortSignal,
  ): Promise<RawSourceGatewayResult>;
}>;

export type FailedFileCategory =
  | "Source text is not supported"
  | "Syntax could not be analyzed"
  | "Metrics could not be computed";

export type FailedFile = Readonly<{
  canonicalPath: string;
  category: FailedFileCategory;
}>;

export type AcquiredProjectModule = Readonly<{
  canonicalPath: string;
  normalizedSource: string;
  normalizedUtf8: Uint8Array;
}>;

export type AcquiredProjectSources = Readonly<{
  kind: "acquired";
  selected: string;
  modules: AcquiredProjectModule[];
  notAnalyzedFiles: FailedFile[];
}>;

export type ProjectSourceAcquisitionResult =
  | AcquiredProjectSources
  | SourceFailure
  | Readonly<{ kind: "cancelled" }>;

export type RetrievalOwnership = Readonly<{
  phase: "provider-inventory" | "provider-candidate" | "provider-cleared" | "static";
  candidateIndex?: number;
  candidateCount?: number;
  projectedInventory: boolean;
  providerResource: false;
}>;

export type SourceRetrievalResult =
  | Readonly<{ kind: "admitted"; selected: string; modules: AdmittedModule[] }>
  | SourceFailure
  | Readonly<{ kind: "cancelled" }>;

const OBJECT_ID_40 = /^[0-9a-f]{40}$/;
const OBJECT_ID_64 = /^[0-9a-f]{64}$/;

export function validObjectId(value: unknown, width?: number): value is string {
  if (typeof value !== "string") {
    return false;
  }
  if (width === 40) {
    return OBJECT_ID_40.test(value);
  }
  if (width === 64) {
    return OBJECT_ID_64.test(value);
  }
  return OBJECT_ID_40.test(value) || OBJECT_ID_64.test(value);
}

function providerFailure(): SourceFailure {
  return { kind: "failure", category: "Provider/resolution failure" };
}

const RAW_SOURCE_READ_WINDOW = 8;

type RawReadOutcome =
  | Readonly<{ kind: "gateway"; value: RawSourceGatewayResult }>
  | Readonly<{ kind: "thrown" }>;

type RawReadSlot = {
  readonly index: number;
  readonly controller: AbortController;
  settled: Promise<void>;
  outcome?: RawReadOutcome;
  isSettled: boolean;
  internallyAborted: boolean;
  released: boolean;
};

type CandidateConsumption =
  | Readonly<{ kind: "module"; module: AcquiredProjectModule }>
  | Readonly<{ kind: "unsupported" }>
  | Readonly<{ kind: "fatal"; failure: SourceFailure }>;

export async function acquireProjectSources(
  repository: RepositoryReference,
  selected: string,
  signal: AbortSignal,
  gateway: ImmutableRawSourceGateway,
  observe: (ownership: RetrievalOwnership) => void = () => {},
  additionalExclusions: readonly string[] = Object.freeze([]),
): Promise<ProjectSourceAcquisitionResult> {
  if (!validObjectId(selected)) return providerFailure();
  if (signal.aborted) return { kind: "cancelled" };

  const modules: AcquiredProjectModule[] = [];
  const notAnalyzedFiles: FailedFile[] = [];
  const discard = (): void => {
    modules.length = 0;
    notAnalyzedFiles.length = 0;
  };
  const terminal = <T extends SourceFailure | Readonly<{ kind: "cancelled" }>>(result: T): T => {
    discard();
    return result;
  };

  try {
    observe({ phase: "provider-inventory", projectedInventory: false, providerResource: false });
    const inventoryResult = await gateway.loadInventory(repository, selected, signal, additionalExclusions);
    if (signal.aborted) return terminal({ kind: "cancelled" });
    if (inventoryResult.kind !== "inventory") return terminal(providerFailure());

    const inventory = prepareSourceInventory(inventoryResult.entries, additionalExclusions);
    if (inventory.kind === "failure") return terminal(inventory);
    observe({ phase: "provider-cleared", projectedInventory: true, providerResource: false });

    for (const candidate of inventory.candidates) {
      if (!candidate.expectedBlobId || !validObjectId(candidate.expectedBlobId, selected.length)) {
        return terminal(providerFailure());
      }
    }
    if (inventory.candidates.length > MAX_ADMITTED_MODULES) {
      return terminal({ kind: "failure", category: "Repository exceeds Code City limits" });
    }

    const slots = new Map<number, RawReadSlot>();
    let nextAdmission = 0;
    let rawFailureHorizon: number | undefined;
    let admissionStopped = false;
    let normalizedTotalBytes = 0;
    let completion: ProjectSourceAcquisitionResult | undefined;

    const abortSlot = (slot: RawReadSlot, internal: boolean): void => {
      if (slot.isSettled || slot.controller.signal.aborted) return;
      slot.internallyAborted ||= internal;
      slot.controller.abort();
    };
    const abortAllOwned = (internal: boolean): void => {
      admissionStopped = true;
      for (const slot of slots.values()) abortSlot(slot, internal);
    };
    const updateRawFailureHorizon = (index: number): void => {
      if (rawFailureHorizon !== undefined && rawFailureHorizon <= index) return;
      rawFailureHorizon = index;
      admissionStopped = true;
      for (const slot of slots.values()) {
        if (slot.index <= index) continue;
        if (slot.isSettled) slot.outcome = undefined;
        else abortSlot(slot, true);
      }
    };
    const settleSlot = (slot: RawReadSlot, outcome: RawReadOutcome): void => {
      slot.isSettled = true;
      if (slot.internallyAborted || signal.aborted) {
        slot.outcome = undefined;
        return;
      }
      slot.outcome = outcome;
      if (outcome.kind === "thrown") {
        updateRawFailureHorizon(slot.index);
        return;
      }
      try {
        if (outcome.value.kind === "provider-failure" || outcome.value.kind === "product-limit") {
          updateRawFailureHorizon(slot.index);
        } else if (outcome.value.kind !== "source") {
          slot.outcome = { kind: "thrown" };
          updateRawFailureHorizon(slot.index);
        }
      } catch {
        slot.outcome = { kind: "thrown" };
        updateRawFailureHorizon(slot.index);
      }
    };
    const launch = (index: number): void => {
      if (signal.aborted || admissionStopped) return;
      const candidate = inventory.candidates[index]!;
      const controller = new AbortController();
      const slot: RawReadSlot = {
        index,
        controller,
        settled: Promise.resolve(),
        isSettled: false,
        internallyAborted: false,
        released: false,
      };
      slots.set(index, slot);
      try {
        const pending = Promise.resolve(gateway.readRawSource(
          repository,
          selected,
          { ...candidate, expectedBlobId: candidate.expectedBlobId! },
          controller.signal,
        ));
        slot.settled = pending.then(
          (value) => settleSlot(slot, { kind: "gateway", value }),
          () => settleSlot(slot, { kind: "thrown" }),
        );
      } catch {
        settleSlot(slot, { kind: "thrown" });
      }
    };
    const fillWindow = (): void => {
      while (!signal.aborted && !admissionStopped && nextAdmission < inventory.candidates.length
        && slots.size < RAW_SOURCE_READ_WINDOW) {
        launch(nextAdmission);
        nextAdmission += 1;
      }
    };
    const releaseSlot = (slot: RawReadSlot): void => {
      if (slot.released) return;
      slot.outcome = undefined;
      slot.released = true;
      slots.delete(slot.index);
    };
    const consumeSlot = (slot: RawReadSlot, candidate: SourceCandidate): CandidateConsumption => {
      const outcome = slot.outcome;
      slot.outcome = undefined;
      if (!outcome || outcome.kind === "thrown") {
        return { kind: "fatal", failure: providerFailure() };
      }
      try {
        if (outcome.value.kind === "provider-failure") {
          return { kind: "fatal", failure: providerFailure() };
        }
        if (outcome.value.kind === "product-limit") {
          return { kind: "fatal", failure: { kind: "failure", category: "Repository exceeds Code City limits" } };
        }
        let decodedSource: string;
        try {
          decodedSource = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(outcome.value.rawBytes);
        } catch {
          return { kind: "unsupported" };
        }
        const normalized = normalizeSourceText(decodedSource);
        if (!normalized) return { kind: "unsupported" };
        applyRequestedSourceByteOwnership(gateway, normalized.normalizedUtf8);
        if (normalized.normalizedUtf8.byteLength > MAX_NORMALIZED_MODULE_BYTES
          || normalizedTotalBytes + normalized.normalizedUtf8.byteLength > MAX_NORMALIZED_TOTAL_BYTES) {
          return { kind: "fatal", failure: { kind: "failure", category: "Repository exceeds Code City limits" } };
        }
        return {
          kind: "module",
          module: {
            canonicalPath: candidate.canonicalPath,
            normalizedSource: normalized.normalizedSource,
            normalizedUtf8: normalized.normalizedUtf8,
          },
        };
      } catch {
        return { kind: "fatal", failure: providerFailure() };
      }
    };
    const drainOwned = async (): Promise<void> => {
      const owned = [...slots.values()];
      for (const slot of owned) {
        slot.outcome = undefined;
        abortSlot(slot, true);
      }
      await Promise.all(owned.map((slot) => slot.settled));
      for (const slot of owned) releaseSlot(slot);
    };
    const externalAbort = (): void => abortAllOwned(false);
    signal.addEventListener("abort", externalAbort, { once: true });

    try {
      if (signal.aborted) {
        abortAllOwned(false);
      } else {
        observe({
          phase: "provider-candidate",
          candidateIndex: 0,
          candidateCount: inventory.candidates.length,
          projectedInventory: true,
          providerResource: false,
        });
        if (signal.aborted) abortAllOwned(false);
        else fillWindow();
      }

      for (let index = 0; index < inventory.candidates.length && !completion; index += 1) {
        if (signal.aborted) {
          abortAllOwned(false);
          break;
        }
        const slot = slots.get(index);
        if (!slot) {
          completion = providerFailure();
          abortAllOwned(true);
          break;
        }
        if (index > 0) {
          observe({
            phase: "provider-candidate",
            candidateIndex: index,
            candidateCount: inventory.candidates.length,
            projectedInventory: true,
            providerResource: false,
          });
          if (signal.aborted) {
            abortAllOwned(false);
            break;
          }
        }
        await slot.settled;
        if (signal.aborted) {
          abortAllOwned(false);
          break;
        }
        const consumed = consumeSlot(slot, inventory.candidates[index]!);
        releaseSlot(slot);
        if (consumed.kind === "fatal") {
          completion = consumed.failure;
          abortAllOwned(true);
          break;
        }
        if (consumed.kind === "unsupported") {
          notAnalyzedFiles.push({
            canonicalPath: inventory.candidates[index]!.canonicalPath,
            category: "Source text is not supported",
          });
        } else {
          normalizedTotalBytes += consumed.module.normalizedUtf8.byteLength;
          modules.push(consumed.module);
        }
        fillWindow();
      }

      if (!completion && !signal.aborted) {
        observe({
          phase: "provider-cleared",
          candidateIndex: inventory.candidates.length,
          candidateCount: inventory.candidates.length,
          projectedInventory: false,
          providerResource: false,
        });
        if (!signal.aborted) {
          observe({ phase: "static", projectedInventory: false, providerResource: false });
        }
        if (!signal.aborted) completion = { kind: "acquired", selected, modules, notAnalyzedFiles };
      }
    } catch {
      completion = providerFailure();
      abortAllOwned(true);
    }

    await drainOwned();
    signal.removeEventListener("abort", externalAbort);
    if (signal.aborted) return terminal({ kind: "cancelled" });
    if (!completion || completion.kind === "cancelled") return terminal(completion ?? providerFailure());
    return completion.kind === "failure" ? terminal(completion) : completion;
  } catch {
    return terminal(signal.aborted ? { kind: "cancelled" } : providerFailure());
  }
}

export async function retrieveAdmittedSources(
  repository: RepositoryReference,
  selected: string,
  signal: AbortSignal,
  gateway: ImmutableSourceGateway,
  observe: (ownership: RetrievalOwnership) => void = () => {},
  additionalExclusions: readonly string[] = Object.freeze([]),
): Promise<SourceRetrievalResult> {
  if (!validObjectId(selected)) {
    return providerFailure();
  }
  if (signal.aborted) {
    return { kind: "cancelled" };
  }

  try {
    observe({ phase: "provider-inventory", projectedInventory: false, providerResource: false });
    const inventoryResult = await gateway.loadInventory(repository, selected, signal, additionalExclusions);
    if (signal.aborted) {
      return { kind: "cancelled" };
    }
    if (inventoryResult.kind !== "inventory") {
      return providerFailure();
    }

    const inventory = prepareSourceInventory(inventoryResult.entries, additionalExclusions);
    if (inventory.kind === "failure") {
      return inventory;
    }
    observe({ phase: "provider-cleared", projectedInventory: true, providerResource: false });

    const session = createSourceAdmissionSession();
    for (let index = 0; index < inventory.candidates.length; index += 1) {
      if (signal.aborted) {
        return { kind: "cancelled" };
      }
      const candidate = inventory.candidates[index];
      if (!candidate || !validObjectId(candidate.expectedBlobId, selected.length)) {
        return providerFailure();
      }
      observe({ phase: "provider-candidate", candidateIndex: index, projectedInventory: true, providerResource: false });
      const source = await gateway.readSource(
        repository,
        selected,
        { ...candidate, expectedBlobId: candidate.expectedBlobId },
        signal,
      );
      if (signal.aborted) {
        return { kind: "cancelled" };
      }
      if (source.kind === "provider-failure") {
        return providerFailure();
      }
      if (source.kind === "invalid-content") {
        return { kind: "failure", category: "Source admission failed", code: "M1-ADM-4" };
      }
      if (source.kind === "product-limit") {
        return { kind: "failure", category: "Repository exceeds Code City limits" };
      }
      const admissionFailure = session.add(candidate, source.decodedSource);
      if (admissionFailure) {
        return admissionFailure;
      }
    }

    observe({ phase: "provider-cleared", projectedInventory: false, providerResource: false });
    if (signal.aborted) {
      return { kind: "cancelled" };
    }
    const modules = session.complete();
    observe({ phase: "static", projectedInventory: false, providerResource: false });
    return { kind: "admitted", selected, modules };
  } catch {
    return signal.aborted ? { kind: "cancelled" } : providerFailure();
  }
}
