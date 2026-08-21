import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(/^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context);
  },
});

const { createWorkerAttemptPipeline } = await import("../src/application/worker-attempt.ts");
const { createSyntaxObservationWriter } = await import("../src/domain/base-metrics.ts");
const { buildCity } = await import("../src/domain/city-model.ts");

const REPOSITORY = { owner: "owner", repository: "repo" };
const SHA = "c".repeat(40);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function fixture(constructCity) {
  const messages = [];
  const publications = [];
  const order = [];
  let pipeline;
  let releases = 0;
  const parser = {
    async initialize() { order.push("parser:initialize"); },
    async project() {
      order.push("parser:project");
      return {
        observations: createSyntaxObservationWriter().finish(),
        release() { releases += 1; order.push("parser:release"); },
      };
    },
  };
  pipeline = createWorkerAttemptPipeline(
    async () => ({ kind: "revision", revision: SHA }),
    {
      async loadInventory() {
        return { kind: "inventory", entries: [{ path: "src/a.ts", mode: "100644", type: "blob", sha: SHA }] };
      },
      async readSource() { return { kind: "source", decodedSource: "x" }; },
    },
    (message) => {
      messages.push(message);
      order.push(`publish:${message.type}`);
      publications.push({ message, ownership: pipeline.ownership() });
    },
    undefined,
    parser,
    (event) => order.push(`metric:${event}`),
    (facts) => {
      order.push("city:construct");
      return constructCity(facts);
    },
  );
  return { pipeline, messages, publications, order, releases: () => releases };
}

test("the City capability runs exactly once after complete facts and success retains only revision plus City", async () => {
  let calls = 0;
  let received;
  const f = fixture((facts) => {
    calls += 1;
    received = facts;
    return buildCity(facts);
  });
  f.pipeline.start(REPOSITORY, 31);
  await tick(); await tick();

  assert.equal(calls, 1);
  assert.deepEqual(received, [{ canonicalPath: "src/a.ts", S: 1, U: 0, M: 0 }]);
  assert(f.order.indexOf("metric:fact-retained") < f.order.indexOf("city:construct"));
  assert.equal(f.releases(), 1);
  assert.deepEqual(f.messages, [{ type: "PROVIDER_DRAINED_STATIC_ENTERED", generation: 31 }]);
  assert.doesNotMatch(JSON.stringify(f.messages), /MODEL|SUCCESS|CITY|UI|origin|rgba|bounds/i);
  assert.deepEqual(f.pipeline.ownership(), {
    phase: "static",
    generation: 31,
    selectedRevisionRetained: true,
    admittedModuleCount: 0,
    cityRetained: true,
    finalFactCount: 0,
    providerResource: false,
  });
  f.pipeline.stop(31);
  await tick();
  assert.equal(calls, 1, "static STOP remains hard realm termination owned by main");
  assert.equal(f.messages.length, 1);
});

for (const [id, construct] of [
  ["defensive validation", (facts) => {
    const city = buildCity(facts);
    city.model.rgba[0] = 0;
    return city;
  }],
  ["later capability throw", () => { throw new Error("injected internal detail"); }],
]) {
  test(`${id} clears facts/City, maps to one CITY1 failure, retains revision for failure, and drains once`, async () => {
    let calls = 0;
    const f = fixture((facts) => { calls += 1; return construct(facts); });
    f.pipeline.start(REPOSITORY, 32);
    await tick(); await tick();

    assert.equal(calls, 1);
    assert.deepEqual(f.messages, [
      { type: "PROVIDER_DRAINED_STATIC_ENTERED", generation: 32 },
      { type: "FAILURE", generation: 32, category: "City construction failed", code: "M1-CITY-1" },
      { type: "ATTEMPT_DRAINED", generation: 32 },
    ]);
    assert.doesNotMatch(JSON.stringify(f.messages), /injected internal detail|canonicalPath|origins|rgba|bounds/);
    const failure = f.publications.find(({ message }) => message.type === "FAILURE");
    assert.deepEqual(failure.ownership, {
      phase: "static",
      generation: 32,
      selectedRevisionRetained: true,
      admittedModuleCount: 0,
      cityRetained: false,
      finalFactCount: 0,
      providerResource: false,
    });
    assert.deepEqual(f.pipeline.ownership(), {
      phase: "idle",
      selectedRevisionRetained: false,
      admittedModuleCount: 0,
      cityRetained: false,
      finalFactCount: 0,
      providerResource: false,
    });
    f.pipeline.stop(32);
    await tick();
    assert.equal(f.messages.filter(({ type }) => type === "ATTEMPT_DRAINED").length, 1);
  });
}
