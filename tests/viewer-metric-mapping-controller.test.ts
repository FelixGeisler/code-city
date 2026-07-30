import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_VERSIONED_METRIC_MAPPING,
  METRIC_MAPPING_PRESET_CATALOG,
  type CityModel,
  type MetricMappingDefinitionV1,
} from "../packages/core/src/index.js";
import {
  MetricMappingController,
  metricMappingDraftForModel,
  type MetricMappingProjectionClient,
} from "../apps/viewer/src/metric-mapping-controller.js";
import { DEMO_MODEL } from "../apps/viewer/src/demo-model.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

class FakeProjectionClient implements MetricMappingProjectionClient {
  readonly calls: {
    readonly model: CityModel;
    readonly mapping: MetricMappingDefinitionV1;
    readonly result: Deferred<CityModel>;
  }[] = [];
  cancelCount = 0;
  disposeCount = 0;

  project(
    model: CityModel,
    mapping: MetricMappingDefinitionV1,
  ): Promise<CityModel> {
    const result = deferred<CityModel>();
    this.calls.push({ model, mapping, result });
    return result.promise;
  }

  cancel(): void {
    this.cancelCount += 1;
  }

  dispose(): void {
    this.disposeCount += 1;
  }
}

function availablePreset(id: string): MetricMappingDefinitionV1 {
  const preset = METRIC_MAPPING_PRESET_CATALOG.find(
    (candidate) =>
      candidate.id === id && candidate.availability === "available",
  );
  if (preset?.availability !== "available") {
    throw new Error(`Missing preset ${id}.`);
  }
  return preset.definition;
}

function projectedModel(
  mapping: MetricMappingDefinitionV1,
): CityModel {
  return {
    ...DEMO_MODEL,
    metricMapping: structuredClone(mapping),
  };
}

describe("viewer metric mapping controller", () => {
  it("seeds the draft from a persisted versioned mapping and falls back for legacy models", () => {
    const maintenance = availablePreset("maintenance");
    expect(
      metricMappingDraftForModel({
        ...DEMO_MODEL,
        metricMapping: maintenance,
      }),
    ).toEqual(maintenance);
    expect(metricMappingDraftForModel(DEMO_MODEL)).toEqual(
      DEFAULT_VERSIONED_METRIC_MAPPING,
    );
  });

  it("commits only the exact latest successful preview", async () => {
    const client = new FakeProjectionClient();
    const models = vi.fn();
    const states = vi.fn();
    const controller = new MetricMappingController({
      client,
      onModelChange: models,
      onStateChange: states,
    });
    const maintenance = availablePreset("maintenance");
    controller.setProject(DEMO_MODEL);
    controller.edit(maintenance);

    const preview = controller.preview();
    expect(controller.state).toMatchObject({
      phase: "projecting",
      canApply: false,
    });
    expect(client.calls[0]?.model).toBe(DEMO_MODEL);
    client.calls[0]?.result.resolve(projectedModel(maintenance));
    await expect(preview).resolves.toBe(true);
    expect(controller.state).toMatchObject({
      phase: "preview",
      canApply: true,
    });
    expect(models).toHaveBeenLastCalledWith(
      expect.objectContaining({ metricMapping: maintenance }),
      "preview",
    );

    expect(controller.apply()).toBe(true);
    expect(controller.state).toMatchObject({
      phase: "committed",
      canApply: false,
    });
    expect(models).toHaveBeenLastCalledWith(
      expect.objectContaining({ metricMapping: maintenance }),
      "committed",
    );
    expect(controller.apply()).toBe(false);
  });

  it("terminates in-flight work and ignores a stale response after an edit", async () => {
    const client = new FakeProjectionClient();
    const models = vi.fn();
    const controller = new MetricMappingController({
      client,
      onModelChange: models,
    });
    controller.setProject(DEMO_MODEL);
    const preview = controller.preview();
    const call = client.calls[0]!;

    controller.edit(availablePreset("print"));
    expect(client.cancelCount).toBeGreaterThan(0);
    expect(controller.state).toMatchObject({
      phase: "committed",
      canApply: false,
    });
    call.result.resolve(projectedModel(DEFAULT_VERSIONED_METRIC_MAPPING));
    await expect(preview).resolves.toBe(false);
    expect(controller.state.canApply).toBe(false);
    expect(models).toHaveBeenCalledTimes(1);
    expect(models).toHaveBeenLastCalledWith(DEMO_MODEL, "committed");
  });

  it("restores the committed model on cancel and replaces the source on a new project", async () => {
    const client = new FakeProjectionClient();
    const models = vi.fn();
    const controller = new MetricMappingController({
      client,
      onModelChange: models,
    });
    controller.setProject(DEMO_MODEL);
    const first = controller.preview();
    client.calls[0]?.result.resolve(
      projectedModel(DEFAULT_VERSIONED_METRIC_MAPPING),
    );
    await first;
    controller.cancel();
    expect(models).toHaveBeenLastCalledWith(DEMO_MODEL, "committed");

    const nextProject = {
      ...DEMO_MODEL,
      repositories: [{ id: "repo-next", name: "Next" }],
    } satisfies CityModel;
    controller.setProject(nextProject);
    const second = controller.preview();
    expect(client.calls[1]?.model).toBe(nextProject);
    client.calls[1]?.result.resolve(
      projectedModel(DEFAULT_VERSIONED_METRIC_MAPPING),
    );
    await second;
    controller.dispose();
    expect(client.disposeCount).toBe(1);
  });
});
