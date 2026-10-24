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

    let normalizedTotalBytes = 0;
    for (let index = 0; index < inventory.candidates.length; index += 1) {
      if (signal.aborted) return terminal({ kind: "cancelled" });
      const candidate = inventory.candidates[index]!;
      const expectedBlobId = candidate.expectedBlobId!;
      observe({ phase: "provider-candidate", candidateIndex: index, projectedInventory: true, providerResource: false });
      const source = await gateway.readRawSource(repository, selected, { ...candidate, expectedBlobId }, signal);
      if (signal.aborted) return terminal({ kind: "cancelled" });
      if (source.kind === "provider-failure") return terminal(providerFailure());
      if (source.kind === "product-limit") {
        return terminal({ kind: "failure", category: "Repository exceeds Code City limits" });
      }

      let decodedSource: string;
      try {
        decodedSource = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(source.rawBytes);
      } catch {
        notAnalyzedFiles.push({ canonicalPath: candidate.canonicalPath, category: "Source text is not supported" });
        continue;
      }
      const normalized = normalizeSourceText(decodedSource);
      if (!normalized) {
        notAnalyzedFiles.push({ canonicalPath: candidate.canonicalPath, category: "Source text is not supported" });
        continue;
      }
      applyRequestedSourceByteOwnership(gateway, normalized.normalizedUtf8);
      if (normalized.normalizedUtf8.byteLength > MAX_NORMALIZED_MODULE_BYTES
        || normalizedTotalBytes + normalized.normalizedUtf8.byteLength > MAX_NORMALIZED_TOTAL_BYTES) {
        return terminal({ kind: "failure", category: "Repository exceeds Code City limits" });
      }
      normalizedTotalBytes += normalized.normalizedUtf8.byteLength;
      modules.push({
        canonicalPath: candidate.canonicalPath,
        normalizedSource: normalized.normalizedSource,
        normalizedUtf8: normalized.normalizedUtf8,
      });
    }

    observe({ phase: "provider-cleared", projectedInventory: false, providerResource: false });
    if (signal.aborted) return terminal({ kind: "cancelled" });
    observe({ phase: "static", projectedInventory: false, providerResource: false });
    return { kind: "acquired", selected, modules, notAnalyzedFiles };
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
