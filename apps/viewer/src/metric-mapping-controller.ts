import {
  DEFAULT_VERSIONED_METRIC_MAPPING,
  isVersionedMetricMapping,
  validateMetricMappingDefinition,
  type CityModel,
  type MetricMappingDefinitionV1,
} from "../../../packages/core/src/index.js";
import { MetricMappingWorkerClient } from "./metric-mapping-worker-client.js";

export type MetricMappingProjectionPhase =
  | "committed"
  | "projecting"
  | "preview";

export interface MetricMappingControllerState {
  readonly phase: MetricMappingProjectionPhase;
  readonly draft: MetricMappingDefinitionV1;
  readonly canApply: boolean;
  readonly error?: string;
}

export interface MetricMappingProjectionClient {
  project(
    model: CityModel,
    mapping: MetricMappingDefinitionV1,
  ): Promise<CityModel>;
  cancel(): void;
  dispose(): void;
}

export interface MetricMappingControllerOptions {
  readonly client?: MetricMappingProjectionClient;
  readonly onModelChange: (
    model: CityModel,
    phase: Exclude<MetricMappingProjectionPhase, "projecting">,
  ) => void;
  readonly onStateChange?: (
    state: MetricMappingControllerState,
  ) => void;
}

function mappingCopy(
  mapping: MetricMappingDefinitionV1,
): MetricMappingDefinitionV1 {
  return structuredClone(mapping);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, child]) =>
          `${JSON.stringify(key)}:${stableJson(child)}`,
      );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function metricMappingDraftForModel(
  model: CityModel,
): MetricMappingDefinitionV1 {
  return mappingCopy(
    isVersionedMetricMapping(model.metricMapping)
      ? model.metricMapping
      : DEFAULT_VERSIONED_METRIC_MAPPING,
  );
}

/**
 * Owns the viewer's three states: an unchanged imported source, the last
 * committed projection, and at most one disposable preview projection.
 */
export class MetricMappingController {
  private readonly client: MetricMappingProjectionClient;
  private readonly onModelChange: MetricMappingControllerOptions["onModelChange"];
  private readonly onStateChange:
    | MetricMappingControllerOptions["onStateChange"]
    | undefined;
  private sourceModel: CityModel | undefined;
  private committedModel: CityModel | undefined;
  private previewModel: CityModel | undefined;
  private draft = mappingCopy(DEFAULT_VERSIONED_METRIC_MAPPING);
  private successfulDraftFingerprint: string | undefined;
  private generation = 0;
  private phase: MetricMappingProjectionPhase = "committed";
  private error: string | undefined;
  private disposed = false;

  public constructor(options: MetricMappingControllerOptions) {
    this.client = options.client ?? new MetricMappingWorkerClient();
    this.onModelChange = options.onModelChange;
    this.onStateChange = options.onStateChange;
  }

  public get state(): MetricMappingControllerState {
    const state = {
      phase: this.phase,
      draft: mappingCopy(this.draft),
      canApply:
        this.phase === "preview" &&
        this.previewModel !== undefined &&
        this.successfulDraftFingerprint === stableJson(this.draft),
      ...(this.error === undefined ? {} : { error: this.error }),
    };
    return Object.freeze(state);
  }

  public setProject(model: CityModel): void {
    this.ensureActive();
    this.invalidateWork();
    this.sourceModel = model;
    this.committedModel = model;
    this.previewModel = undefined;
    this.draft = metricMappingDraftForModel(model);
    this.phase = "committed";
    this.error = undefined;
    this.publish();
  }

  public edit(mapping: MetricMappingDefinitionV1): void {
    this.ensureActive();
    validateMetricMappingDefinition(mapping);
    const hadPreview =
      this.phase === "preview" || this.phase === "projecting";
    this.invalidateWork();
    this.draft = mappingCopy(mapping);
    this.previewModel = undefined;
    this.phase = "committed";
    this.error = undefined;
    if (hadPreview && this.committedModel !== undefined) {
      this.onModelChange(this.committedModel, "committed");
    }
    this.publish();
  }

  public async preview(): Promise<boolean> {
    this.ensureActive();
    if (this.sourceModel === undefined || this.committedModel === undefined) {
      throw new Error("No project is available for metric mapping.");
    }
    validateMetricMappingDefinition(this.draft);
    this.invalidateWork();
    const generation = this.generation;
    const mapping = mappingCopy(this.draft);
    const fingerprint = stableJson(mapping);
    this.previewModel = undefined;
    this.phase = "projecting";
    this.error = undefined;
    this.publish();

    try {
      const projected = await this.client.project(
        this.sourceModel,
        mapping,
      );
      if (this.disposed || generation !== this.generation) return false;
      this.previewModel = projected;
      this.successfulDraftFingerprint = fingerprint;
      this.phase = "preview";
      this.error = undefined;
      this.onModelChange(projected, "preview");
      this.publish();
      return true;
    } catch (error) {
      if (this.disposed || generation !== this.generation) return false;
      this.previewModel = undefined;
      this.successfulDraftFingerprint = undefined;
      this.phase = "committed";
      this.error =
        error instanceof Error
          ? error.message
          : "The metric mapping preview could not be generated.";
      this.onModelChange(this.committedModel, "committed");
      this.publish();
      return false;
    }
  }

  public apply(): boolean {
    this.ensureActive();
    const state = this.state;
    if (!state.canApply || this.previewModel === undefined) return false;
    this.generation += 1;
    this.client.cancel();
    this.committedModel = this.previewModel;
    this.previewModel = undefined;
    this.successfulDraftFingerprint = undefined;
    this.phase = "committed";
    this.error = undefined;
    this.onModelChange(this.committedModel, "committed");
    this.publish();
    return true;
  }

  public cancel(): void {
    this.ensureActive();
    const shouldRestore =
      this.phase !== "committed" || this.previewModel !== undefined;
    this.invalidateWork();
    this.previewModel = undefined;
    this.phase = "committed";
    this.error = undefined;
    if (shouldRestore && this.committedModel !== undefined) {
      this.onModelChange(this.committedModel, "committed");
    }
    this.publish();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.client.dispose();
    this.previewModel = undefined;
  }

  private invalidateWork(): void {
    this.generation += 1;
    this.successfulDraftFingerprint = undefined;
    this.client.cancel();
  }

  private publish(): void {
    this.onStateChange?.(this.state);
  }

  private ensureActive(): void {
    if (this.disposed) {
      throw new Error("The metric mapping controller has been disposed.");
    }
  }
}
