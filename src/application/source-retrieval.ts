import type { RepositoryReference } from "../domain/repository-reference";
import {
  createSourceAdmissionSession,
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
  ): Promise<InventoryGatewayResult>;
  readSource(
    repository: RepositoryReference,
    selected: string,
    candidate: Readonly<SourceCandidate & { expectedBlobId: string }>,
    signal: AbortSignal,
  ): Promise<SourceGatewayResult>;
}>;

export type RetrievalOwnership = Readonly<{
  phase: "provider-inventory" | "provider-candidate" | "provider-cleared" | "static";
  candidateIndex?: number;
  projectedInventory: boolean;
  providerResource: false;
}>;

export type SourceRetrievalResult =
  | Readonly<{ kind: "admitted"; selected: string; modules: readonly AdmittedModule[] }>
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

export async function retrieveAdmittedSources(
  repository: RepositoryReference,
  selected: string,
  signal: AbortSignal,
  gateway: ImmutableSourceGateway,
  observe: (ownership: RetrievalOwnership) => void = () => {},
): Promise<SourceRetrievalResult> {
  if (!validObjectId(selected)) {
    return providerFailure();
  }
  if (signal.aborted) {
    return { kind: "cancelled" };
  }

  try {
    observe({ phase: "provider-inventory", projectedInventory: false, providerResource: false });
    const inventoryResult = await gateway.loadInventory(repository, selected, signal);
    if (signal.aborted) {
      return { kind: "cancelled" };
    }
    if (inventoryResult.kind !== "inventory") {
      return providerFailure();
    }

    const inventory = prepareSourceInventory(inventoryResult.entries);
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
