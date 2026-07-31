import {
  validateDesignSmellEvaluation,
  type CityModel,
  type DesignSmellConfiguration,
  type DesignSmellEvaluation,
  type DesignSmellSuppression,
} from "../../../packages/core/src/index.js";
import {
  isDesignSmellWorkerResponse,
  type DesignSmellEvaluateRequest,
} from "./design-smell-protocol.js";

interface ActiveEvaluation {
  readonly worker: Worker;
  readonly jobId: number;
  readonly reject: (reason: unknown) => void;
  readonly cleanup: () => void;
}

function cancellationError(): DOMException {
  return new DOMException(
    "The design-smell evaluation was cancelled.",
    "AbortError",
  );
}

export class DesignSmellWorkerClient {
  private active: ActiveEvaluation | undefined;
  private nextJobId = 0;
  private disposed = false;

  public constructor(
    private readonly createWorker: () => Worker = () =>
      new Worker(new URL("./design-smell-worker.ts", import.meta.url), {
        type: "module",
        name: "code-city-design-smells",
      }),
  ) {}

  public evaluate(
    model: CityModel,
    configuration: DesignSmellConfiguration,
    suppressions: readonly DesignSmellSuppression[],
  ): Promise<DesignSmellEvaluation> {
    if (this.disposed) {
      return Promise.reject(
        new Error(
          "The design-smell worker client has been disposed.",
        ),
      );
    }
    this.cancel();
    const worker = this.createWorker();
    const jobId = ++this.nextJobId;
    const request: DesignSmellEvaluateRequest = {
      type: "evaluate",
      jobId,
      model,
      configuration,
      suppressions,
    };

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        worker.terminate();
        if (this.active?.jobId === jobId) {
          this.active = undefined;
        }
        action();
      };
      const fail = (): void => {
        finish(() =>
          reject(
            new Error(
              "The design-smell worker stopped unexpectedly.",
            ),
          ),
        );
      };
      const onMessage = (event: MessageEvent<unknown>): void => {
        const response = event.data;
        if (
          !isDesignSmellWorkerResponse(response) ||
          response.jobId !== jobId
        ) {
          fail();
          return;
        }
        if (response.type === "failure") {
          finish(() => reject(new Error(response.message)));
          return;
        }
        try {
          validateDesignSmellEvaluation(
            response.evaluation,
            configuration,
          );
          if (
            !evaluationMatchesRequest(
              response.evaluation,
              model,
              suppressions,
            )
          ) {
            throw new TypeError(
              "The evaluation does not match the requested city.",
            );
          }
          finish(() => resolve(response.evaluation));
        } catch {
          finish(() =>
            reject(
              new Error(
                "The design-smell worker returned an invalid evaluation.",
              ),
            ),
          );
        }
      };
      const cleanup = (): void => {
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", fail);
        worker.removeEventListener("messageerror", fail);
      };

      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", fail);
      worker.addEventListener("messageerror", fail);
      this.active = {
        worker,
        jobId,
        reject,
        cleanup,
      };
      try {
        worker.postMessage(request);
      } catch {
        fail();
      }
    });
  }

  public cancel(): void {
    const active = this.active;
    if (active === undefined) return;
    this.active = undefined;
    active.cleanup();
    active.worker.terminate();
    active.reject(cancellationError());
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
  }
}

function evaluationMatchesRequest(
  evaluation: DesignSmellEvaluation,
  model: CityModel,
  suppressions: readonly DesignSmellSuppression[],
): boolean {
  const buildings = new Map(
    model.buildings.map((building) => [building.id, building]),
  );
  const suppressionByIdentity = new Map(
    suppressions.map((suppression) => [
      `${suppression.buildingId}\u0000${suppression.ruleId}`,
      suppression,
    ]),
  );
  const outgoingByBuilding = new Map<string, Set<string>>();
  for (const dependency of model.dependencies) {
    const source = buildings.get(dependency.sourceId);
    if (
      dependency.kind !== "typescript-import" ||
      source === undefined ||
      source.language === "csharp"
    ) {
      continue;
    }
    const target =
      dependency.targetId ??
      dependency.externalTarget ??
      dependency.id;
    const outgoing =
      outgoingByBuilding.get(source.id) ?? new Set<string>();
    outgoing.add(target);
    outgoingByBuilding.set(source.id, outgoing);
  }

  return evaluation.findings.every((finding) => {
    const building = buildings.get(finding.buildingId);
    if (
      building === undefined ||
      finding.language !== building.language
    ) {
      return false;
    }
    const suppression = suppressionByIdentity.get(
      `${finding.buildingId}\u0000${finding.ruleId}`,
    );
    if (
      finding.suppressed !== (suppression !== undefined) ||
      finding.suppressionReason !== suppression?.reason
    ) {
      return false;
    }
    switch (finding.ruleId) {
      case "high-complexity-method":
        return (building.units ?? []).some(
          (unit) =>
            unit.name === finding.evidence.subject &&
            unit.line === finding.evidence.line &&
            unit.endLine === finding.evidence.endLine &&
            unit.complexity === finding.evidence.value,
        );
      case "oversized-file":
        return building.metrics.sloc === finding.evidence.value;
      case "excessive-coupling":
        return (
          (outgoingByBuilding.get(building.id)?.size ?? 0) ===
          finding.evidence.value
        );
      case "dependency-cycle":
        return (
          finding.evidence.relatedBuildingIds?.every((id) =>
            buildings.has(id),
          ) === true
        );
      case "oversized-class":
      case "duplicate-code":
      case "feature-envy":
        return false;
    }
  });
}
