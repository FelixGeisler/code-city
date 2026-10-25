import type { MessagePort } from "node:worker_threads";
import { fixedTransferSourceOwnership } from "../../application/internal/source-byte-ownership";
import { analyzeProjectSources } from "../../application/project-analysis";
import { resolveRevision, type RevisionGateway } from "../../application/resolution";
import { buildCity } from "../../domain/city-model";
import {
  acquireProjectSources,
  type ImmutableRawSourceGateway,
  type ProjectSourceAcquisitionResult,
  type RetrievalOwnership,
} from "../../application/source-retrieval";
import type { RepositoryReference } from "../../domain/repository-reference";
import type { NormalizedSourceText } from "../../domain/source-admission";
import type { SyntaxProjectionCapability } from "../../application/base-metric-processing";
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

export type NodeAnalysisWorkerDependencies = Readonly<{
  revisionGateway: RevisionGateway;
  sourceGateway: ImmutableRawSourceGateway;
  parser: SyntaxProjectionCapability;
}>;

type NodeWorkerProgressPayload =
  | Omit<Extract<NodeWorkerProgress, { stage: "acquisition" }>, "attemptId" | "generation" | "revision">
  | Omit<Extract<NodeWorkerProgress, { stage: "analysis-initialization" }>, "attemptId" | "generation" | "revision">
  | Omit<Extract<NodeWorkerProgress, { stage: "analysis" }>, "attemptId" | "generation" | "revision">
  | Omit<Extract<NodeWorkerProgress, { stage: "city-construction" }>, "attemptId" | "generation" | "revision">;

function providerFailure(attemptId: string, generation: number, revision?: string): NodeWorkerFailure {
  return revision === undefined
    ? { type: "FAILURE", attemptId, generation, category: "Provider/resolution failure" }
    : { type: "FAILURE", attemptId, generation, revision, category: "Provider/resolution failure" };
}

export function publishNodeWorkerEvent(port: Pick<MessagePort, "postMessage">, event: NodeWorkerEvent): void {
  const publication = validateNodeWorkerEventForPublication(event);
  const { validation } = publication;
  if (validation.kind !== "valid") {
    if (validation.attemptId === undefined || validation.generation === undefined) {
      throw new Error("Worker event correlation is invalid");
    }
    const fallback: NodeWorkerFailure = validation.mapping === "city" && validation.revision
      ? { type: "FAILURE", attemptId: validation.attemptId, generation: validation.generation, revision: validation.revision, category: "City construction failed", code: "M1-CITY-1" }
      : providerFailure(validation.attemptId, validation.generation, validation.revision);
    if (validateNodeWorkerEvent(fallback).kind !== "valid") throw new Error("Worker failure event is invalid");
    port.postMessage(fallback);
    return;
  }
  if (event.type !== "SUCCESS") {
    port.postMessage(event);
    return;
  }
  if (!publication.transfer) throw new Error("Worker success transfer list is invalid");
  port.postMessage(event, publication.transfer);
}

export function runNodeAnalysisWorker(port: MessagePort, dependencies: NodeAnalysisWorkerDependencies): void {
  const sourceGateway: ImmutableRawSourceGateway & Readonly<{ [fixedTransferSourceOwnership]: true }> = {
    [fixedTransferSourceOwnership]: true,
    loadInventory: (repository, selected, signal, additionalExclusions) => (
      dependencies.sourceGateway.loadInventory(repository, selected, signal, additionalExclusions)
    ),
    readRawSource: (repository, selected, candidate, signal) => (
      dependencies.sourceGateway.readRawSource(repository, selected, candidate, signal)
    ),
  };
  let active: Readonly<{ attemptId: string; generation: number; controller: AbortController }> | undefined;
  let terminal = false;

  const finish = (): void => {
    active = undefined;
    port.close();
  };

  const execute = async (command: Extract<ReturnType<typeof parseNodeWorkerCommand>, { type: "START" }>): Promise<void> => {
    if (!command) return;
    const controller = new AbortController();
    active = { attemptId: command.attemptId, generation: command.generation, controller };
    let revision: string | undefined;
    try {
      const resolution = await resolveRevision(command.repository, controller.signal, dependencies.revisionGateway);
      if (controller.signal.aborted || resolution.kind === "cancelled") { finish(); return; }
      if (resolution.kind === "failure") {
        terminal = true;
        publishNodeWorkerEvent(port, {
          type: "FAILURE", attemptId: command.attemptId, generation: command.generation,
          category: resolution.category === "Repository unavailable for anonymous access" || resolution.category === "Revision unavailable"
            ? resolution.category : "Provider/resolution failure",
        });
        finish();
        return;
      }
      revision = resolution.revision;
      const progressIdentity = { attemptId: command.attemptId, generation: command.generation, revision };
      const publishProgress = (progress: NodeWorkerProgressPayload): void => {
        publishNodeWorkerEvent(port, { ...progressIdentity, ...progress } as NodeWorkerProgress);
      };
      publishNodeWorkerEvent(port, { type: "REVISION_SELECTED", ...progressIdentity });
      const acquired = await acquireProjectSources(
        command.repository,
        revision,
        controller.signal,
        sourceGateway,
        (ownership) => {
          if (ownership.phase === "provider-candidate"
            && ownership.candidateIndex !== undefined && ownership.candidateCount !== undefined) {
            publishProgress({
              type: "PROGRESS",
              stage: "acquisition",
              completed: ownership.candidateIndex,
              total: ownership.candidateCount,
            });
          } else if (ownership.phase === "provider-cleared" && !ownership.projectedInventory
            && ownership.candidateIndex !== undefined && ownership.candidateCount !== undefined) {
            publishProgress({
              type: "PROGRESS",
              stage: "acquisition",
              completed: ownership.candidateIndex,
              total: ownership.candidateCount,
            });
          }
        },
        command.additionalExclusions,
      );
      if (controller.signal.aborted || acquired.kind === "cancelled") { finish(); return; }
      if (acquired.kind === "failure") {
        terminal = true;
        if (acquired.code === undefined) {
          publishNodeWorkerEvent(port, {
            type: "FAILURE", attemptId: command.attemptId, generation: command.generation, revision,
            category: acquired.category === "Repository exceeds Code City limits" ? acquired.category : "Provider/resolution failure",
          });
        } else {
          publishNodeWorkerEvent(port, {
            type: "FAILURE", attemptId: command.attemptId, generation: command.generation, revision,
            category: acquired.category === "No supported modules" ? "No supported modules" : "Source admission failed",
            code: acquired.code,
          });
        }
        finish();
        return;
      }
      publishProgress({ type: "PROGRESS", stage: "analysis-initialization" });
      const analysisTotal = acquired.modules.length;
      let analysisCompleted = 0;
      const parser: SyntaxProjectionCapability = {
        async initialize() {
          await dependencies.parser.initialize();
          if (analysisTotal > 0) {
            publishProgress({ type: "PROGRESS", stage: "analysis", completed: 0, total: analysisTotal });
          }
        },
        async project(grammarFamily, normalizedSource) {
          let projected: Awaited<ReturnType<SyntaxProjectionCapability["project"]>>;
          try {
            projected = await dependencies.parser.project(grammarFamily, normalizedSource);
          } catch (error) {
            analysisCompleted += 1;
            publishProgress({
              type: "PROGRESS",
              stage: "analysis",
              completed: analysisCompleted,
              total: analysisTotal,
            });
            throw error;
          }
          return {
            observations: projected.observations,
            release() {
              projected.release();
              analysisCompleted += 1;
              publishProgress({
                type: "PROGRESS",
                stage: "analysis",
                completed: analysisCompleted,
                total: analysisTotal,
              });
            },
          };
        },
      };
      const analysis = await analyzeProjectSources(acquired, parser, (facts) => {
        publishProgress({ type: "PROGRESS", stage: "city-construction" });
        return buildCity(facts);
      });
      if (controller.signal.aborted) { finish(); return; }
      if (analysis.kind === "failure") {
        publishNodeWorkerEvent(port, {
          type: "FAILURE", attemptId: command.attemptId, generation: command.generation, revision,
          category: analysis.category, code: analysis.code,
        });
      } else {
        const success = prepareNodeWorkerSuccessForPublication({
          type: "SUCCESS", attemptId: command.attemptId, generation: command.generation, revision,
          result: { city: analysis.result.city, notAnalyzedFiles: analysis.result.notAnalyzedFiles },
          sources: analysis.result.sources,
        } satisfies NodeWorkerSuccess);
        publishNodeWorkerEvent(port, success);
      }
      terminal = true;
      finish();
    } catch {
      if (controller.signal.aborted) { finish(); return; }
      if (!terminal) {
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
      return;
    }
    if (active?.attemptId === command.attemptId && active.generation === command.generation) active.controller.abort();
  });
  port.start();
}

type ExactType<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends (<Value>() => Value extends Left ? 1 : 2)
      ? true
      : false
    : false;
type AssertType<Value extends true> = Value;
type AcceptedAcquireProjectSources = (
  repository: RepositoryReference,
  selected: string,
  signal: AbortSignal,
  gateway: ImmutableRawSourceGateway,
  observe?: (ownership: RetrievalOwnership) => void,
  additionalExclusions?: readonly string[],
) => Promise<ProjectSourceAcquisitionResult>;
type AcceptedNormalizeSourceText = (decodedSource: string) => NormalizedSourceText | undefined;
type SourceAdmissionExports = typeof import("../../domain/source-admission");
type _AcquireProjectSourcesApi619 = AssertType<ExactType<typeof acquireProjectSources, AcceptedAcquireProjectSources>>;
type _NormalizeSourceTextApi619 = AssertType<ExactType<SourceAdmissionExports["normalizeSourceText"], AcceptedNormalizeSourceText>>;
type _NoSourceOwnershipFunctionExport619 = AssertType<"isFixedTransferNormalizedUtf8" extends keyof SourceAdmissionExports ? false : true>;
