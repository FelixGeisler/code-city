import type { MessagePort } from "node:worker_threads";
import { fixedTransferSourceOwnership } from "../../application/internal/source-byte-ownership";
import { analyzeRepository, type RepositoryAnalysisDependencies } from "../../application/analyze-repository";
import {
  acquireProjectSources,
  type ImmutableRawSourceGateway,
  type ProjectSourceAcquisitionResult,
  type RetrievalOwnership,
} from "../../application/source-retrieval";
import type { RepositoryReference } from "../../domain/repository-reference";
import type { NormalizedSourceText } from "../../domain/source-admission";
import {
  parseNodeWorkerCommand,
  prepareNodeWorkerSuccessForPublication,
  validateNodeWorkerEvent,
  validateNodeWorkerEventForPublication,
  type NodeWorkerEvent,
  type NodeWorkerFailure,
  type NodeWorkerProgress,
  type NodeWorkerSuccess,
} from "./worker-protocol";

/** Native adapter retained for shared-core regression tests, not the application host. */
export type NodeAnalysisWorkerDependencies = RepositoryAnalysisDependencies;

function providerFailure(attemptId: string, generation: number, revision?: string): NodeWorkerFailure {
  return revision === undefined
    ? { type: "FAILURE", attemptId, generation, category: "Provider/resolution failure" }
    : { type: "FAILURE", attemptId, generation, revision, category: "Provider/resolution failure" };
}

export function publishNodeWorkerEvent(port: Pick<MessagePort, "postMessage">, event: NodeWorkerEvent): void {
  const publication = validateNodeWorkerEventForPublication(event);
  const { validation } = publication;
  if (validation.kind !== "valid") {
    if (validation.attemptId === undefined || validation.generation === undefined) throw new Error("Worker event correlation is invalid");
    const fallback: NodeWorkerFailure = validation.mapping === "city" && validation.revision
      ? { type: "FAILURE", attemptId: validation.attemptId, generation: validation.generation, revision: validation.revision, category: "City construction failed", code: "M1-CITY-1" }
      : providerFailure(validation.attemptId, validation.generation, validation.revision);
    if (validateNodeWorkerEvent(fallback).kind !== "valid") throw new Error("Worker failure event is invalid");
    port.postMessage(fallback);
    return;
  }
  if (event.type !== "SUCCESS") { port.postMessage(event); return; }
  if (!publication.transfer) throw new Error("Worker success transfer list is invalid");
  port.postMessage(event, publication.transfer);
}

export function runNodeAnalysisWorker(port: MessagePort, dependencies: NodeAnalysisWorkerDependencies): void {
  const sourceGateway: ImmutableRawSourceGateway & Readonly<{ [fixedTransferSourceOwnership]: true }> = {
    [fixedTransferSourceOwnership]: true,
    loadInventory: (...args) => dependencies.sourceGateway.loadInventory(...args),
    readRawSource: (...args) => dependencies.sourceGateway.readRawSource(...args),
  };
  let active: Readonly<{ attemptId: string; generation: number; controller: AbortController }> | undefined;
  let terminal = false;
  const finish = (): void => { active = undefined; port.close(); };
  const execute = async (command: Extract<ReturnType<typeof parseNodeWorkerCommand>, { type: "START" }>): Promise<void> => {
    if (!command) return;
    const controller = new AbortController();
    active = { attemptId: command.attemptId, generation: command.generation, controller };
    const identity = { attemptId: command.attemptId, generation: command.generation };
    let revision: string | undefined;
    try {
      const outcome = await analyzeRepository(command.repository, command.additionalExclusions, controller.signal,
        { ...dependencies, sourceGateway },
        (selected) => {
          revision = selected;
          publishNodeWorkerEvent(port, { type: "REVISION_SELECTED", ...identity, revision });
        },
        (progress) => publishNodeWorkerEvent(port, { type: "PROGRESS", ...identity, revision: revision!, ...progress } as NodeWorkerProgress));
      if (controller.signal.aborted || outcome.kind === "cancelled") { finish(); return; }
      terminal = true;
      if (outcome.kind === "failure") {
        publishNodeWorkerEvent(port, {
          type: "FAILURE", ...identity, category: outcome.category,
          ...(outcome.revision === undefined ? {} : { revision: outcome.revision }),
          ...(outcome.code === undefined ? {} : { code: outcome.code }),
        } as NodeWorkerFailure);
      } else {
        publishNodeWorkerEvent(port, prepareNodeWorkerSuccessForPublication({
          type: "SUCCESS", ...identity, revision: outcome.revision,
          result: { city: outcome.result.city, notAnalyzedFiles: outcome.result.notAnalyzedFiles },
          sources: outcome.result.sources,
        } satisfies NodeWorkerSuccess));
      }
      finish();
    } catch {
      if (!controller.signal.aborted && !terminal) {
        terminal = true;
        publishNodeWorkerEvent(port, providerFailure(command.attemptId, command.generation, revision));
      }
      finish();
    }
  };
  port.on("message", (value: unknown) => {
    const command = parseNodeWorkerCommand(value);
    if (!command) return;
    if (command.type === "START") {
      if (!active && !terminal) void execute(command);
    } else if (active?.attemptId === command.attemptId && active.generation === command.generation) active.controller.abort();
  });
  port.start();
}

type ExactType<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends (<Value>() => Value extends Left ? 1 : 2) ? true : false
    : false;
type AssertType<Value extends true> = Value;
type AcceptedAcquireProjectSources = (
  repository: RepositoryReference, selected: string, signal: AbortSignal, gateway: ImmutableRawSourceGateway,
  observe?: (ownership: RetrievalOwnership) => void, additionalExclusions?: readonly string[],
) => Promise<ProjectSourceAcquisitionResult>;
type AcceptedNormalizeSourceText = (decodedSource: string) => NormalizedSourceText | undefined;
type SourceAdmissionExports = typeof import("../../domain/source-admission");
type _AcquireProjectSourcesApi619 = AssertType<ExactType<typeof acquireProjectSources, AcceptedAcquireProjectSources>>;
type _NormalizeSourceTextApi619 = AssertType<ExactType<SourceAdmissionExports["normalizeSourceText"], AcceptedNormalizeSourceText>>;
type _NoSourceOwnershipFunctionExport619 = AssertType<"isFixedTransferNormalizedUtf8" extends keyof SourceAdmissionExports ? false : true>;
