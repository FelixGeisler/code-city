import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  let factsSeen;
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
      publications.push({ message, ownership: pipeline.ownership(), capturedFactCount: factsSeen?.length ?? 0 });
    },
    undefined,
    parser,
    (event) => order.push(`metric:${event}`),
    (facts) => {
      factsSeen = facts;
      order.push("city:construct");
      return constructCity(facts);
    },
  );
  return { pipeline, messages, publications, order, releases: () => releases };
}

test("success releases source identities and facts, publishes only revision plus model, then drains", async () => {
  let calls = 0;
  let receivedFacts;
  const f = fixture((facts) => {
    calls += 1;
    receivedFacts = facts;
    assert.deepEqual(facts, [{ canonicalPath: "src/a.ts", S: 1, U: 0, M: 0 }]);
    return buildCity(facts);
  });
  f.pipeline.start(REPOSITORY, 31);
  await tick(); await tick();

  assert.equal(calls, 1);
  assert.deepEqual(receivedFacts, [], "the actual processing-result fact container is released before publication");
  assert(f.order.indexOf("metric:fact-retained") < f.order.indexOf("city:construct"));
  assert.equal(f.releases(), 1);
  assert.deepEqual(f.messages.map(({ type }) => type), ["REVISION_SELECTED", "PROVIDER_DRAINED_STATIC_ENTERED", "SUCCESS", "ATTEMPT_DRAINED"]);
  const success = f.messages[2];
  assert.deepEqual(Object.keys(success), ["type", "generation", "revision", "model"]);
  assert.equal(success.generation, 31);
  assert.equal(success.revision, SHA);
  assert.deepEqual(Object.keys(success.model), ["kind", "count", "origins", "sizes", "rgba", "bounds"]);
  assert.doesNotMatch(JSON.stringify(success), /canonicalPath|normalizedSource|identities|facts/i);
  assert.deepEqual(f.publications.map(({ message, ownership }) => [message.type, ownership.selectedRevisionRetained, ownership.admittedModuleCount, ownership.presentationModelRetained, ownership.finalFactCount]), [
    ["REVISION_SELECTED", true, 0, false, 0],
    ["PROVIDER_DRAINED_STATIC_ENTERED", true, 0, false, 0],
    ["SUCCESS", true, 0, true, 0],
    ["ATTEMPT_DRAINED", false, 0, false, 0],
  ]);
  assert.equal(f.publications.find(({ message }) => message.type === "SUCCESS").capturedFactCount, 0);
  assert.deepEqual(f.pipeline.ownership(), {
    phase: "idle",
    selectedRevisionRetained: false,
    admittedModuleCount: 0,
    presentationModelRetained: false,
    finalFactCount: 0,
    providerResource: false,
  });
  f.pipeline.stop(31);
  await tick();
  assert.equal(calls, 1);
  assert.equal(f.messages.filter(({ type }) => type === "SUCCESS").length, 1);
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
      { type: "REVISION_SELECTED", generation: 32, revision: SHA },
      { type: "PROVIDER_DRAINED_STATIC_ENTERED", generation: 32 },
      { type: "FAILURE", generation: 32, revision: SHA, category: "City construction failed", code: "M1-CITY-1" },
      { type: "ATTEMPT_DRAINED", generation: 32 },
    ]);
    assert.doesNotMatch(JSON.stringify(f.messages), /injected internal detail|canonicalPath|origins|rgba|bounds/);
    const failure = f.publications.find(({ message }) => message.type === "FAILURE");
    assert.deepEqual(failure.ownership, {
      phase: "static",
      generation: 32,
      selectedRevisionRetained: true,
      admittedModuleCount: 0,
      presentationModelRetained: false,
      finalFactCount: 0,
      providerResource: false,
    });
    assert.deepEqual(f.pipeline.ownership(), {
      phase: "idle",
      selectedRevisionRetained: false,
      admittedModuleCount: 0,
      presentationModelRetained: false,
      finalFactCount: 0,
      providerResource: false,
    });
    f.pipeline.stop(32);
    await tick();
    assert.equal(f.messages.filter(({ type }) => type === "ATTEMPT_DRAINED").length, 1);
  });
}

test("SUCCESS publication is outside provider/static/City lifetimes and preparation returns only revision plus model", async () => {
  const source = await readFile(new URL("../src/application/worker-attempt.ts", import.meta.url), "utf8");
  const activeStart = source.indexOf("type ActiveAttempt = {");
  const activeEnd = source.indexOf("\n};", activeStart);
  const staticStart = source.indexOf("async function prepareStaticSuccess");
  const providerStart = source.indexOf("async function prepareProviderSuccess");
  const helperEnd = source.indexOf("\n  function drain", providerStart);
  const successPublish = source.indexOf('publish({ type: "SUCCESS"');

  assert(activeStart >= 0 && activeEnd > activeStart && staticStart > activeEnd && providerStart > staticStart && helperEnd > providerStart);
  assert(successPublish > helperEnd, "SUCCESS must be published only after both preparation helpers complete");
  assert.doesNotMatch(source.slice(staticStart, helperEnd), /type:\s*"SUCCESS"/u);
  assert.match(source.slice(staticStart, providerStart), /processing\.release\(\);\s*return \{ revision, model \};/u);
  assert.match(source.slice(providerStart, helperEnd), /return prepareStaticSuccess\(attempt, revision, retrieval\.modules\);/u);
  assert.doesNotMatch(source.slice(activeStart, activeEnd), /admitted|source|facts|city|identit/iu);
  assert.match(source.slice(helperEnd), /let prepared = await prepareProviderSuccess[\s\S]*publish\(\{ type: "SUCCESS"[\s\S]*prepared = undefined;\s*drain\(attempt\);/u);
});
