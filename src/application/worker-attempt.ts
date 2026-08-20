import type { RepositoryReference } from "../domain/repository-reference";
import type { WorkerMessage } from "./protocol";
import { resolveRevision, type ResolutionResult, type RevisionGateway } from "./resolution";

type ActiveAttempt = {
  controller: AbortController;
  drained: boolean;
  generation: number;
  repository: RepositoryReference;
  result?: ResolutionResult;
  run: Promise<void>;
  stopped: boolean;
};

export type WorkerAttemptPipeline = Readonly<{
  start(repository: RepositoryReference, generation: number): void;
  stop(generation: number): void;
  selected(): ResolutionResult | undefined;
}>;

export function createWorkerAttemptPipeline(
  gateway: RevisionGateway,
  publish: (message: WorkerMessage) => void,
): WorkerAttemptPipeline {
  let active: ActiveAttempt | undefined;

  function drain(attempt: ActiveAttempt): void {
    if (attempt.drained) {
      return;
    }
    attempt.drained = true;
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
      repository,
      run: Promise.resolve(),
      stopped: false,
    };
    active = attempt;
    attempt.run = (async () => {
      const result = await resolveRevision(repository, attempt.controller.signal, gateway);
      attempt.result = result;
      if (attempt.stopped || result.kind === "cancelled") {
        drain(attempt);
        return;
      }
      if (result.kind === "failure") {
        publish({ type: "FAILURE", generation, category: result.category });
        drain(attempt);
      }
      // A selected revision deliberately remains in this same application pipeline.
    })();
  }

  function stop(generation: number): void {
    const attempt = active;
    if (!attempt || attempt.generation !== generation || attempt.stopped) {
      return;
    }
    attempt.stopped = true;
    attempt.controller.abort();
    void attempt.run.then(
      () => drain(attempt),
      () => drain(attempt),
    );
  }

  return {
    start,
    stop,
    selected: () => active?.result?.kind === "selected" ? active.result : undefined,
  };
}
