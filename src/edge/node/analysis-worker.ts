import type { MessagePort } from "node:worker_threads";
import { analyzeProjectSources } from "../../application/project-analysis";
import { resolveRevision, type RevisionGateway } from "../../application/resolution";
import { acquireProjectSources, type ImmutableRawSourceGateway } from "../../application/source-retrieval";
import type { SyntaxProjectionCapability } from "../../application/base-metric-processing";
import { createGithubRevisionGateway } from "../github-revision-gateway";
import { createGithubRawSourceGateway } from "../github-source-gateway";
import { createNodeTreeSitterAdapter } from "./parser-assets";
import {
  parseNodeWorkerCommand,
  prepareNodeWorkerSuccessForPublication,
  validateNodeWorkerEvent,
  validateNodeWorkerEventForPublication,
  type NodeWorkerEvent,
  type NodeWorkerFailure,
  type NodeWorkerSuccess,
} from "./worker-protocol";

export type NodeAnalysisWorkerDependencies = Readonly<{
  revisionGateway: RevisionGateway;
  sourceGateway: ImmutableRawSourceGateway;
  parser: SyntaxProjectionCapability;
}>;

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
      publishNodeWorkerEvent(port, { type: "REVISION_SELECTED", attemptId: command.attemptId, generation: command.generation, revision });
      const acquired = await acquireProjectSources(
        command.repository, revision, controller.signal, dependencies.sourceGateway, undefined, command.additionalExclusions,
        "fixed-transfer",
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
      const analysis = await analyzeProjectSources(acquired, dependencies.parser);
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

export function productionNodeAnalysisWorkerDependencies(): NodeAnalysisWorkerDependencies {
  return {
    revisionGateway: createGithubRevisionGateway(fetch),
    sourceGateway: createGithubRawSourceGateway(fetch),
    parser: createNodeTreeSitterAdapter(),
  };
}
