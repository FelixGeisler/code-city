import type { AdmittedModule } from "../domain/source-admission";
import type { RepositoryReference } from "../domain/repository-reference";
import type { WorkerMessage } from "./protocol";
import { resolveRevision, type RevisionGateway } from "./resolution";
import {
  retrieveAdmittedSources,
  type ImmutableSourceGateway,
  type RetrievalOwnership,
} from "./source-retrieval";

type ActiveAttempt = {
  admittedModules?: readonly AdmittedModule[];
  controller?: AbortController;
  drained: boolean;
  generation: number;
  phase: "provider" | "static";
  repository?: RepositoryReference;
  run: Promise<void>;
  selectedRevision?: string;
  stopped: boolean;
};

export type AttemptOwnership = Readonly<{
  phase: "idle" | "provider" | "static";
  generation?: number;
  selectedRevisionRetained: boolean;
  admittedModuleCount: number;
  providerResource: false;
}>;

export type WorkerAttemptPipeline = Readonly<{
  start(repository: RepositoryReference, generation: number): void;
  stop(generation: number): void;
  ownership(): AttemptOwnership;
}>;

export function createWorkerAttemptPipeline(
  revisionGateway: RevisionGateway,
  sourceGateway: ImmutableSourceGateway,
  publish: (message: WorkerMessage) => void,
  observeRetrieval: (ownership: RetrievalOwnership) => void = () => {},
): WorkerAttemptPipeline {
  let active: ActiveAttempt | undefined;

  function drain(attempt: ActiveAttempt): void {
    if (attempt.drained) {
      return;
    }
    attempt.drained = true;
    attempt.controller = undefined;
    attempt.repository = undefined;
    attempt.selectedRevision = undefined;
    attempt.admittedModules = undefined;
    publish({ type: "ATTEMPT_DRAINED", generation: attempt.generation });
    if (active === attempt) {
      active = undefined;
    }
  }

  function start(repository: RepositoryReference, generation: number): void {
    if (active) {
      return;
    }
    const attempt: ActiveAttempt = {
      controller: new AbortController(),
      drained: false,
      generation,
      phase: "provider",
      repository,
      run: Promise.resolve(),
      stopped: false,
    };
    active = attempt;
    attempt.run = (async () => {
      const controller = attempt.controller;
      if (!controller) {
        return;
      }
      const resolution = await resolveRevision(repository, controller.signal, revisionGateway);
      if (attempt.stopped || resolution.kind === "cancelled") {
        drain(attempt);
        return;
      }
      if (resolution.kind === "failure") {
        publish({ type: "FAILURE", generation, category: resolution.category });
        drain(attempt);
        return;
      }

      const retrieval = await retrieveAdmittedSources(
        repository,
        resolution.revision,
        controller.signal,
        sourceGateway,
        observeRetrieval,
      );
      if (attempt.stopped || retrieval.kind === "cancelled") {
        drain(attempt);
        return;
      }
      if (retrieval.kind === "failure") {
        publish({
          type: "FAILURE",
          generation,
          category: retrieval.category,
          ...(retrieval.code === undefined ? {} : { code: retrieval.code }),
        });
        drain(attempt);
        return;
      }

      attempt.phase = "static";
      attempt.repository = undefined;
      attempt.controller = undefined;
      attempt.selectedRevision = retrieval.selected;
      attempt.admittedModules = retrieval.modules;
      publish({ type: "PROVIDER_DRAINED_STATIC_ENTERED", generation });
    })().catch(() => {
      if (attempt.stopped) {
        drain(attempt);
        return;
      }
      publish({ type: "FAILURE", generation, category: "Provider/resolution failure" });
      drain(attempt);
    });
  }

  function stop(generation: number): void {
    const attempt = active;
    if (!attempt || attempt.generation !== generation || attempt.stopped || attempt.phase === "static") {
      return;
    }
    attempt.stopped = true;
    attempt.controller?.abort();
    void attempt.run.then(
      () => drain(attempt),
      () => drain(attempt),
    );
  }

  return {
    start,
    stop,
    ownership: () => active
      ? {
          phase: active.phase,
          generation: active.generation,
          selectedRevisionRetained: active.selectedRevision !== undefined,
          admittedModuleCount: active.admittedModules?.length ?? 0,
          providerResource: false,
        }
      : {
          phase: "idle",
          selectedRevisionRetained: false,
          admittedModuleCount: 0,
          providerResource: false,
        },
  };
}
