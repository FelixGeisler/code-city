import { parseRepositoryReference } from "../domain/repository-reference";

export type GithubInvestigationOrigin = Readonly<{ kind: "github"; repositoryUrl: string; revision: string }>;
export type WorkingTreeInvestigationOrigin = Readonly<{ kind: "working-tree"; name: string; captureId: string }>;
export type InvestigationOrigin = GithubInvestigationOrigin | WorkingTreeInvestigationOrigin;

export function validWorkingTreeName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 && value.isWellFormed()
    && value === value.normalize("NFC") && !/[\p{Cc}\\/]/u.test(value) && value !== "." && value !== "..";
}
export function investigationIdentity(origin: InvestigationOrigin): string {
  return origin.kind === "github" ? origin.revision : origin.captureId;
}
export function parseInvestigationOrigin(value: unknown): InvestigationOrigin {
  if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("Invalid investigation origin");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const kind = descriptors.kind?.value;
  const keys = kind === "github" ? ["kind", "repositoryUrl", "revision"] : kind === "working-tree" ? ["kind", "name", "captureId"] : [];
  if (keys.length === 0 || Reflect.ownKeys(descriptors).length !== keys.length || !keys.every(key => descriptors[key]?.enumerable && "value" in descriptors[key]!)) throw new Error("Invalid investigation origin");
  if (kind === "github") {
    const repositoryUrl: unknown = descriptors.repositoryUrl!.value, revision: unknown = descriptors.revision!.value;
    if (typeof repositoryUrl !== "string" || repositoryUrl.length > 4096 || !parseRepositoryReference(repositoryUrl)
      || typeof revision !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(revision)) throw new Error("Invalid investigation origin");
    return { kind, repositoryUrl, revision };
  }
  const name: unknown = descriptors.name!.value, captureId: unknown = descriptors.captureId!.value;
  if (!validWorkingTreeName(name) || typeof captureId !== "string" || !/^[0-9a-f]{64}$/u.test(captureId)) throw new Error("Invalid investigation origin");
  return { kind: "working-tree", name, captureId };
}
