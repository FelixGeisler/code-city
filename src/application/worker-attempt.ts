import type { AdmittedModule } from "../domain/source-admission";
import type { RepositoryReference } from "../domain/repository-reference";
import type { ModuleComplexityFact } from "../domain/complexity";
import { buildCity, type City } from "../domain/city-model";
import { processAdmittedBaseMetrics, type MetricProcessingEvent, type SyntaxProjectionCapability } from "./base-metric-processing";
import { validRevision, type WorkerMessage } from "./protocol";
import { resolveRevision, type RevisionGateway } from "./resolution";
import {
  retrieveAdmittedSources,
  type ImmutableSourceGateway,
  type RetrievalOwnership,
} from "./source-retrieval";

type ActiveAttempt = {
  city?: City;
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
  presentationModelRetained: boolean;
  finalFactCount: number;
  providerResource: false;
}>;

export type CityConstructionCapability = (facts: readonly ModuleComplexityFact[]) => City;

type SuccessfulPreparation = Readonly<{ revision: string; city: City }>;

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
  syntaxParser?: SyntaxProjectionCapability,
  observeMetricProcessing: (event: MetricProcessingEvent) => void = () => {},
  constructCity: CityConstructionCapability = buildCity,
): WorkerAttemptPipeline {
  let active: ActiveAttempt | undefined;

  function prepareCity(facts: readonly ModuleComplexityFact[]): City {
    const city = constructCity(facts);
    const geometry = city.geometry;
    const buffers = [geometry.origins.buffer, geometry.sizes.buffer, geometry.rgba.buffer, geometry.bounds.buffer];
    if (new Set(buffers).size !== 4 || city.inspection.length !== geometry.count) {
      throw new Error("City construction did not produce one aligned transferable result");
    }
    return city;
  }

  async function prepareStaticSuccess(
    attempt: ActiveAttempt,
    revision: string,
    admittedModules: AdmittedModule[],
  ): Promise<SuccessfulPreparation | undefined> {
    if (!syntaxParser) {
      return undefined;
    }
    const processing = await processAdmittedBaseMetrics(admittedModules, syntaxParser, observeMetricProcessing);
    if (processing.kind === "failure") {
      publish({
        type: "FAILURE",
        generation: attempt.generation,
        revision,
        category: processing.category,
        code: processing.code,
      });
      drain(attempt);
      return undefined;
    }
    let city: City;
    try {
      city = prepareCity(processing.facts);
    } catch {
      processing.release();
      publish({
        type: "FAILURE",
        generation: attempt.generation,
        revision,
        category: "City construction failed",
        code: "M1-CITY-1",
      });
      drain(attempt);
      return undefined;
    }
    processing.release();
    return { revision, city };
  }

  async function prepareProviderSuccess(attempt: ActiveAttempt): Promise<SuccessfulPreparation | undefined> {
    const repository = attempt.repository;
    const controller = attempt.controller;
    if (!repository || !controller) {
      return undefined;
    }
    const resolution = await resolveRevision(repository, controller.signal, revisionGateway);
    if (attempt.stopped || resolution.kind === "cancelled") {
      drain(attempt);
      return undefined;
    }
    if (resolution.kind === "failure") {
      const category = resolution.category === "Repository unavailable for anonymous access"
        || resolution.category === "Revision unavailable"
        ? resolution.category
        : "Provider/resolution failure";
      publish({ type: "FAILURE", generation: attempt.generation, category });
      drain(attempt);
      return undefined;
    }

    if (!validRevision(resolution.revision)) {
      publish({ type: "FAILURE", generation: attempt.generation, category: "Provider/resolution failure" });
      drain(attempt);
      return undefined;
    }
    attempt.selectedRevision = resolution.revision;
    publish({ type: "REVISION_SELECTED", generation: attempt.generation, revision: resolution.revision });
    const retrieval = await retrieveAdmittedSources(
      repository,
      resolution.revision,
      controller.signal,
      sourceGateway,
      observeRetrieval,
    );
    if (attempt.stopped || retrieval.kind === "cancelled") {
      drain(attempt);
      return undefined;
    }
    if (retrieval.kind === "failure") {
      if (retrieval.code === undefined) {
        const category = retrieval.category === "Repository exceeds Code City limits"
          ? retrieval.category
          : "Provider/resolution failure";
        publish({ type: "FAILURE", generation: attempt.generation, revision: resolution.revision, category });
      } else {
        const category = retrieval.category === "No supported modules"
          ? retrieval.category
          : "Source admission failed";
        publish({
          type: "FAILURE",
          generation: attempt.generation,
          revision: resolution.revision,
          category,
          code: retrieval.code,
        });
      }
      drain(attempt);
      return undefined;
    }

    const revision = retrieval.selected;
    attempt.phase = "static";
    attempt.repository = undefined;
    attempt.controller = undefined;
    attempt.selectedRevision = revision;
    publish({ type: "PROVIDER_DRAINED_STATIC_ENTERED", generation: attempt.generation });
    return prepareStaticSuccess(attempt, revision, retrieval.modules);
  }

  function drain(attempt: ActiveAttempt): void {
    if (attempt.drained) {
      return;
    }
    attempt.drained = true;
    attempt.controller = undefined;
    attempt.repository = undefined;
    attempt.city = undefined;
    attempt.selectedRevision = undefined;
    publish({ type: "ATTEMPT_DRAINED", generation: attempt.generation });
    if (active === attempt) {
      active = undefined;
    }
  }

  async function runAttempt(attempt: ActiveAttempt): Promise<void> {
    try {
      let prepared = await prepareProviderSuccess(attempt);
      if (!prepared) {
        return;
      }
      attempt.selectedRevision = prepared.revision;
      attempt.city = prepared.city;
      publish({ type: "SUCCESS", generation: attempt.generation, revision: prepared.revision, city: prepared.city });
      attempt.city = undefined;
      prepared = undefined;
      drain(attempt);
    } catch {
      if (attempt.stopped) {
        drain(attempt);
        return;
      }
      const revision = attempt.selectedRevision;
      publish(revision === undefined
        ? { type: "FAILURE", generation: attempt.generation, category: "Provider/resolution failure" }
        : { type: "FAILURE", generation: attempt.generation, revision, category: "Provider/resolution failure" });
      drain(attempt);
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
    attempt.run = runAttempt(attempt);
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
          admittedModuleCount: 0,
          presentationModelRetained: active.city !== undefined,
          finalFactCount: active.city?.inspection.length ?? 0,
          providerResource: false,
        }
      : {
          phase: "idle",
          selectedRevisionRetained: false,
          admittedModuleCount: 0,
          presentationModelRetained: false,
          finalFactCount: 0,
          providerResource: false,
        },
  };
}
