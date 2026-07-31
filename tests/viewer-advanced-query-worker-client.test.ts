import { describe, expect, it } from "vitest";
import {
  AdvancedQueryWorkerClient,
} from "../apps/viewer/src/advanced-query-worker-client.js";
import type {
  AdvancedQueryEvaluateRequest,
} from "../apps/viewer/src/advanced-query-protocol.js";
import {
  ADVANCED_QUERY_METRIC_SCHEMA_VERSION,
  ADVANCED_QUERY_VERSION,
  evaluateAdvancedQuery,
  type AdvancedQueryChangeKind,
  type AdvancedQueryDefinition,
} from "../apps/viewer/src/advanced-query.js";
import { DEMO_MODEL } from "../apps/viewer/src/demo-model.js";

class FakeAdvancedQueryWorker extends EventTarget {
  request: AdvancedQueryEvaluateRequest | undefined;
  terminated = false;

  postMessage(value: unknown): void {
    this.request = value as AdvancedQueryEvaluateRequest;
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(value: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: value }));
  }
}

describe("advanced query worker client", () => {
  it("serializes dynamic context deterministically and validates results", async () => {
    const worker = new FakeAdvancedQueryWorker();
    const client = new AdvancedQueryWorkerClient({
      createWorker: () => worker as unknown as Worker,
    });
    const definition = query();
    const pending = client.evaluate(DEMO_MODEL, definition, {
      changesByBuildingId: new Map<
        string,
        ReadonlySet<AdvancedQueryChangeKind>
      >([
        ["building:z", new Set(["changed", "added"])],
        ["building:a", new Set(["removed"])],
      ]),
    });
    expect(worker.request?.context).toEqual({
      changes: [
        ["building:a", ["removed"]],
        ["building:z", ["added", "changed"]],
      ],
      smellRules: null,
      availableSmellRules: null,
      ruleSchemaVersion: null,
    });
    const evaluation = evaluateAdvancedQuery(DEMO_MODEL, definition);
    worker.respond({
      type: "result",
      jobId: 1,
      evaluation,
    });
    await expect(pending).resolves.toEqual(evaluation);
    expect(worker.terminated).toBe(true);
  });

  it("distinguishes unavailable context from available empty context", async () => {
    const worker = new FakeAdvancedQueryWorker();
    const client = new AdvancedQueryWorkerClient({
      createWorker: () => worker as unknown as Worker,
    });
    const pending = client.evaluate(DEMO_MODEL, query(), {
      changesByBuildingId: new Map(),
      smellRuleIdsByBuildingId: new Map(),
      availableSmellRuleIdsByBuildingId: new Map(),
    });
    expect(worker.request?.context).toEqual({
      changes: [],
      smellRules: [],
      availableSmellRules: [],
      ruleSchemaVersion: null,
    });
    client.cancel();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("accepts bounded duplicate explanations from distinct conditions", async () => {
    const worker = new FakeAdvancedQueryWorker();
    const client = new AdvancedQueryWorkerClient({
      createWorker: () => worker as unknown as Worker,
    });
    const definition: AdvancedQueryDefinition = {
      ...query(),
      conditions: [
        {
          kind: "metric",
          metric: "maximumComplexity",
          operator: "at-least",
          value: 0,
        },
        {
          kind: "metric",
          metric: "maximumComplexity",
          operator: "at-most",
          value: 1_000,
        },
      ],
    };
    const evaluation = evaluateAdvancedQuery(DEMO_MODEL, definition);
    expect(evaluation.results[0]?.reasons[0]).toBe(
      evaluation.results[0]?.reasons[1],
    );
    const pending = client.evaluate(DEMO_MODEL, definition);
    worker.respond({ type: "result", jobId: 1, evaluation });

    await expect(pending).resolves.toEqual(evaluation);
  });

  it("hard-cancels an obsolete worker when a newer query starts", async () => {
    const workers = [
      new FakeAdvancedQueryWorker(),
      new FakeAdvancedQueryWorker(),
    ];
    const client = new AdvancedQueryWorkerClient({
      createWorker: () => workers.shift()! as unknown as Worker,
    });
    const firstWorker = workers[0]!;
    const first = client.evaluate(DEMO_MODEL, query());
    const secondWorker = workers[0]!;
    const second = client.evaluate(DEMO_MODEL, query());

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(firstWorker.terminated).toBe(true);
    secondWorker.respond({
      type: "result",
      jobId: 2,
      evaluation: evaluateAdvancedQuery(DEMO_MODEL, query()),
    });
    await expect(second).resolves.toMatchObject({
      queryId: "query:test",
    });
  });

  it("fails closed on malformed or stale responses", async () => {
    const worker = new FakeAdvancedQueryWorker();
    const client = new AdvancedQueryWorkerClient({
      createWorker: () => worker as unknown as Worker,
    });
    const pending = client.evaluate(DEMO_MODEL, query());
    worker.respond({
      type: "result",
      jobId: 99,
      evaluation: evaluateAdvancedQuery(DEMO_MODEL, query()),
    });
    await expect(pending).rejects.toThrow(/invalid response/iu);
    expect(worker.terminated).toBe(true);
  });

  it("rejects a structurally valid result that does not match its request", async () => {
    for (const mutate of [
      (evaluation: ReturnType<typeof evaluateAdvancedQuery>) => ({
        ...evaluation,
        queryId: "query:forged",
      }),
      (evaluation: ReturnType<typeof evaluateAdvancedQuery>) => ({
        ...evaluation,
        results: [
          {
            ...evaluation.results[0]!,
            name: "forged.ts",
          },
          ...evaluation.results.slice(1),
        ],
      }),
    ]) {
      const worker = new FakeAdvancedQueryWorker();
      const client = new AdvancedQueryWorkerClient({
        createWorker: () => worker as unknown as Worker,
      });
      const pending = client.evaluate(DEMO_MODEL, query());
      worker.respond({
        type: "result",
        jobId: 1,
        evaluation: mutate(evaluateAdvancedQuery(DEMO_MODEL, query())),
      });
      await expect(pending).rejects.toThrow(/invalid response/iu);
      expect(worker.terminated).toBe(true);
    }
  });

  it("rejects internally inconsistent and oversized evaluations", async () => {
    const worker = new FakeAdvancedQueryWorker();
    const client = new AdvancedQueryWorkerClient({
      createWorker: () => worker as unknown as Worker,
    });
    const pending = client.evaluate(DEMO_MODEL, query());
    const evaluation = evaluateAdvancedQuery(DEMO_MODEL, query());
    worker.respond({
      type: "result",
      jobId: 1,
      evaluation: {
        ...evaluation,
        results: Array.from(
          { length: 501 },
          () => evaluation.results[0]!,
        ),
        totalCount: 501,
        evaluatedBuildingCount: 501,
      },
    });
    await expect(pending).rejects.toThrow(/invalid response/iu);
    expect(worker.terminated).toBe(true);
  });
});

function query(): AdvancedQueryDefinition {
  return {
    version: ADVANCED_QUERY_VERSION,
    id: "query:test",
    name: "Test",
    match: "all",
    conditions: [],
    sort: { key: "path", direction: "ascending" },
    limit: 50,
    capabilities: {
      modelSchemaVersion: "1.0",
      metricSchemaVersion: ADVANCED_QUERY_METRIC_SCHEMA_VERSION,
    },
  };
}
