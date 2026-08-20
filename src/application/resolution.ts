import type { RepositoryReference } from "../domain/repository-reference";

export const FAILURE_CATEGORIES = [
  "Repository unavailable for anonymous access",
  "Revision unavailable",
  "Provider/resolution failure",
] as const;

export type FailureCategory = typeof FAILURE_CATEGORIES[number];

export type GatewayResult =
  | Readonly<{ kind: "http"; status: number }>
  | Readonly<{ kind: "revision"; revision: string }>
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "invalid-evidence" }>;

export type ResolutionResult =
  | Readonly<{ kind: "selected"; repository: RepositoryReference; revision: string }>
  | Readonly<{ kind: "failure"; category: FailureCategory }>
  | Readonly<{ kind: "cancelled" }>;

export type RevisionGateway = (
  repository: RepositoryReference,
  signal: AbortSignal,
) => Promise<GatewayResult>;

export async function resolveRevision(
  repository: RepositoryReference,
  signal: AbortSignal,
  gateway: RevisionGateway,
): Promise<ResolutionResult> {
  try {
    const result = await gateway(repository, signal);
    if (signal.aborted) {
      return { kind: "cancelled" };
    }
    if (result.kind === "revision") {
      return { kind: "selected", repository, revision: result.revision };
    }
    if (result.kind === "empty" || (result.kind === "http" && result.status === 409)) {
      return { kind: "failure", category: "Revision unavailable" };
    }
    if (result.kind === "http" && result.status === 404) {
      return { kind: "failure", category: "Repository unavailable for anonymous access" };
    }
    return { kind: "failure", category: "Provider/resolution failure" };
  } catch {
    return signal.aborted
      ? { kind: "cancelled" }
      : { kind: "failure", category: "Provider/resolution failure" };
  }
}
