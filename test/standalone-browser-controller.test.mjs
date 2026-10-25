import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(/^\.\.?\//u.test(specifier) && !/(?:\.[a-z]+|\?.*)$/iu.test(specifier) ? `${specifier}.ts` : specifier, context);
  },
});

const {
  createStandaloneBrowserController,
  nextBrowserGeneration,
  parseBrowserSessionEvent,
} = await import("../src/edge/standalone-browser-controller.ts");
const { buildCity } = await import("../src/domain/city-model.ts");
const { validateCityPayload } = await import("../src/application/city-payload.ts");

const SESSION = "A".repeat(43);
const SECOND_SESSION = "B".repeat(43);
const REVISION = "a".repeat(40);
const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accepted, rejected) => { resolve = accepted; reject = rejected; });
  return { promise, resolve, reject };
}

function plainCity() {
  const city = validateCityPayload(buildCity([{ canonicalPath: "src/example.ts", S: 1, U: 1, M: 1 }]));
  return {
    geometry: {
      kind: city.geometry.kind,
      count: city.geometry.count,
      origins: [...city.geometry.origins],
      sizes: [...city.geometry.sizes],
      rgba: [...city.geometry.rgba],
      bounds: [...city.geometry.bounds],
    },
    inspection: city.inspection.map((value) => ({ ...value })),
    presentation: {
      plates: city.presentation.plates.map(({ minimum, dimensions }) => ({ minimum: [...minimum], dimensions: [...dimensions] })),
      sceneBounds: [...city.presentation.sceneBounds],
      centre: [...city.presentation.centre],
    },
    districts: city.districts.map((value) => ({ ...value })),
  };
}

function fakeTransport() {
  const owners = [];
  return {
    owners,
    open(observer) {
      const ready = deferred();
      const analyzeCalls = [];
      const cancelCalls = [];
      const discardCalls = [];
      const owner = {
        observer,
        ready: ready.promise,
        readyControl: ready,
        analyzeCalls,
        cancelCalls,
        discardCalls,
        closed: false,
        analyze(command) { const result = deferred(); analyzeCalls.push({ command, result }); return result.promise; },
        cancel(command) { const result = deferred(); cancelCalls.push({ command, result }); return result.promise; },
        discard(command) { const result = deferred(); discardCalls.push({ command, result }); return result.promise; },
        close() { owner.closed = true; },
      };
      owners.push(owner);
      return owner;
    },
  };
}

function fakeView() {
  const calls = [];
  let cancel;
  let discard;
  let working = false;
  return {
    calls,
    isWorking: () => working,
    takeCancel: () => cancel,
    takeDiscard: () => discard,
    clear() { working = false; calls.push(["clear"]); },
    working(value) { working = true; cancel = value; calls.push(["working"]); },
    invalid() { working = false; calls.push(["invalid"]); },
    capacity() { working = false; calls.push(["capacity"]); },
    lost() { working = false; calls.push(["lost"]); },
    revision(value) { calls.push(["revision", value]); },
    failed(category, code, revision) { working = false; calls.push(["failed", category, code, revision]); },
    cancelled() { working = false; calls.push(["cancelled"]); },
    succeeded(generation, city, failures, revision, value) { working = false; discard = value; calls.push(["succeeded", generation, city.inspection.length, failures.length, revision]); },
    allFilesFailed(generation, failures, revision, value) { working = false; discard = value; calls.push(["all-failed", generation, failures.length, revision]); },
  };
}

function successEvent(generation, failures = []) {
  return parseBrowserSessionEvent({
    type: "ANALYSIS_SUCCEEDED",
    sessionId: SESSION,
    generation,
    revision: REVISION,
    city: plainCity(),
    notAnalyzedFiles: failures,
  });
}

test("browser event validation accepts only exact source-free schemas", () => {
  const event = successEvent(1);
  assert(event);
  assert.equal(event.type, "ANALYSIS_SUCCEEDED");
  assert.equal(event.city.inspection[0].canonicalPath, "src/example.ts");
  assert.equal(JSON.stringify(event).includes("normalizedSource"), false);
  assert.equal(parseBrowserSessionEvent({ ...event, rawDiagnostic: "secret" }), undefined);
  assert.equal(parseBrowserSessionEvent({ type: "ANALYSIS_FAILED", sessionId: SESSION, generation: 1, category: "raw stack" }), undefined);
  assert.equal(parseBrowserSessionEvent({
    type: "ANALYSIS_ALL_FILES_FAILED", sessionId: SESSION, generation: 1, revision: REVISION, notAnalyzedFiles: [],
  }), undefined);
  assert.equal(parseBrowserSessionEvent({
    type: "ANALYSIS_SUCCEEDED", sessionId: SESSION, generation: 1, revision: REVISION,
    city: { ...plainCity(), source: "secret" }, notAnalyzedFiles: [],
  }), undefined);
});

test("browser city validation rejects numeric wire values that typed arrays would wrap or round", () => {
  const rgba = plainCity();
  rgba.geometry.rgba[0] += 256;
  assert.equal(parseBrowserSessionEvent({
    type: "ANALYSIS_SUCCEEDED", sessionId: SESSION, generation: 1, revision: REVISION, city: rgba, notAnalyzedFiles: [],
  }), undefined);

  for (const mutate of [
    (city) => { city.geometry.origins[0] += 1e-8; },
    (city) => { city.geometry.sizes[0] += 1e-8; },
    (city) => { city.geometry.bounds[3] += 1e-8; },
    (city) => { city.presentation.plates[0].minimum[0] += 1e-8; },
    (city) => { city.presentation.plates[0].dimensions[0] += 1e-8; },
    (city) => { city.presentation.sceneBounds[3] += 1e-8; },
    (city) => { city.presentation.centre[0] += 1e-8; },
  ]) {
    const city = plainCity();
    mutate(city);
    assert.equal(parseBrowserSessionEvent({
      type: "ANALYSIS_SUCCEEDED", sessionId: SESSION, generation: 1, revision: REVISION, city, notAnalyzedFiles: [],
    }), undefined);
  }
});

test("active progress ownership spans opening, acknowledgement, revision, replacement, and terminal events", async () => {
  const transport = fakeTransport();
  const view = fakeView();
  const controller = createStandaloneBrowserController(transport, view);
  controller.start();
  const owner = transport.owners[0];

  controller.submit("https://github.com/owner/repository", "");
  assert.equal(view.isWorking(), true, "opening wait must remain active");
  owner.readyControl.resolve({ kind: "opened", sessionId: SESSION });
  await flush();
  assert.equal(view.isWorking(), true, "Analyze acknowledgement wait must remain active");
  owner.analyzeCalls[0].result.resolve(202);
  await flush();
  assert.equal(view.isWorking(), true, "202 must not complete progress");
  owner.observer.event({ type: "REVISION_SELECTED", sessionId: SESSION, generation: 1, revision: REVISION });
  assert.equal(view.isWorking(), true, "revision selection must not complete progress");

  controller.submit("https://github.com/owner/repository", "");
  await flush();
  assert.equal(view.isWorking(), true, "replacement must install current progress");
  owner.observer.event({ type: "ANALYSIS_CANCELLED", sessionId: SESSION, generation: 1 });
  assert.equal(view.isWorking(), true, "stale terminal events must not clear current progress");
  owner.analyzeCalls[1].result.resolve(202);
  await flush();
  owner.observer.event({ type: "ANALYSIS_FAILED", sessionId: SESSION, generation: 2, category: "Provider/resolution failure" });
  assert.equal(view.isWorking(), false, "current failure must clear progress");

  controller.submit("https://github.com/owner/repository", "");
  await flush();
  owner.analyzeCalls[2].result.resolve(202);
  await flush();
  owner.observer.event({
    type: "ANALYSIS_ALL_FILES_FAILED",
    sessionId: SESSION,
    generation: 3,
    revision: REVISION,
    notAnalyzedFiles: [{ canonicalPath: "bad.js", category: "Syntax could not be analyzed" }],
  });
  assert.equal(view.isWorking(), false, "all-files-failed must clear progress");

  controller.submit("https://github.com/owner/repository", "");
  await flush();
  owner.analyzeCalls[3].result.resolve(422);
  await flush();
  assert.equal(view.isWorking(), false, "invalid submission must clear progress");

  controller.submit("https://github.com/owner/repository", "");
  await flush();
  owner.analyzeCalls[4].result.resolve(202);
  await flush();
  owner.observer.event(successEvent(5));
  assert.equal(view.isWorking(), false, "success must clear progress");
  view.takeDiscard()();
  owner.discardCalls[0].result.resolve(204);
  await flush();
  owner.observer.event({ type: "CURRENT_DISCARDED", sessionId: SESSION, generation: 5 });
  assert.equal(view.isWorking(), false, "discard must leave progress absent");

  controller.submit("https://github.com/owner/repository", "");
  await flush();
  view.takeCancel()();
  owner.cancelCalls[0].result.resolve(204);
  await flush();
  assert.equal(view.isWorking(), true, "cancel acknowledgement alone must retain progress");
  owner.observer.event({ type: "ANALYSIS_CANCELLED", sessionId: SESSION, generation: 6 });
  assert.equal(view.isWorking(), false, "cancellation event must clear progress");

  controller.submit("https://github.com/owner/repository", "");
  await flush();
  owner.observer.lost();
  assert.equal(view.isWorking(), false, "session loss must clear progress");

  controller.submit("https://github.com/owner/repository", "");
  assert.equal(view.isWorking(), true);
  controller.dispose();
  assert.equal(view.isWorking(), false, "disposal must clear progress");
});

test("Analyze records positive generations and exact raw command values before independently ordered events and 202", async () => {
  const transport = fakeTransport();
  const view = fakeView();
  const controller = createStandaloneBrowserController(transport, view);
  controller.start();
  const owner = transport.owners[0];
  owner.readyControl.resolve({ kind: "opened", sessionId: SESSION });
  controller.submit("  https://github.com/owner/repository  ", "raw\r\n value ");
  await flush();
  assert.deepEqual(owner.analyzeCalls[0].command, {
    sessionId: SESSION,
    generation: 1,
    repositoryUrl: "  https://github.com/owner/repository  ",
    additionalExclusions: "raw\r\n value ",
  });
  owner.observer.event(successEvent(1));
  assert.deepEqual(view.calls.at(-1), ["succeeded", 1, 1, 0, REVISION]);
  owner.analyzeCalls[0].result.resolve(202);
  await flush();
  assert.deepEqual(view.calls.at(-1), ["succeeded", 1, 1, 0, REVISION]);

  controller.submit("invalid", "still raw");
  await flush();
  assert.equal(owner.analyzeCalls[1].command.generation, 2);
  owner.analyzeCalls[1].result.resolve(422);
  await flush();
  assert.deepEqual(view.calls.slice(-2), [["clear"], ["invalid"]]);
  assert.equal(transport.owners.length, 1, "422 must not reconnect");
});

test("an unrepresentable Analyze consumes its generation, loses the owner, and resumes at the following generation", async () => {
  const transport = fakeTransport();
  const view = fakeView();
  const controller = createStandaloneBrowserController(transport, view);
  controller.start();
  const first = transport.owners[0];
  first.readyControl.resolve({ kind: "opened", sessionId: SESSION });
  controller.submit("https://github.com/owner/repository", "");
  await flush();
  assert.equal(first.analyzeCalls[0].command.generation, 1);
  first.analyzeCalls[0].result.resolve(202);
  await flush();
  first.observer.event(successEvent(1));

  controller.submit(Symbol("unrepresentable"), "");
  assert.equal(first.closed, true);
  assert.equal(first.analyzeCalls.length, 1, "unrepresentable input must not reach Analyze");
  assert.deepEqual(view.calls.slice(-2), [["clear"], ["lost"]]);
  assert.equal(transport.owners.length, 1, "loss must not reconnect automatically");

  controller.submit("https://github.com/owner/repository", "");
  assert.equal(transport.owners.length, 2);
  const second = transport.owners[1];
  second.readyControl.resolve({ kind: "opened", sessionId: SECOND_SESSION });
  await flush();
  assert.deepEqual(second.analyzeCalls[0].command, {
    sessionId: SECOND_SESSION,
    generation: 3,
    repositoryUrl: "https://github.com/owner/repository",
    additionalExclusions: "",
  });
});

test("session-create capacity is exact, clears state, and does not reconnect before explicit Analyze", async () => {
  const transport = fakeTransport();
  const view = fakeView();
  const controller = createStandaloneBrowserController(transport, view);
  controller.start();
  transport.owners[0].readyControl.resolve({ kind: "capacity" });
  await flush();
  assert.deepEqual(view.calls.slice(-2), [["clear"], ["capacity"]]);
  assert.equal(transport.owners.length, 1);
  controller.submit("https://github.com/owner/repository", "");
  assert.equal(transport.owners.length, 2);
  assert.equal(view.isWorking(), true);
  transport.owners[1].readyControl.resolve({ kind: "capacity" });
  await flush();
  assert.equal(view.isWorking(), false, "capacity rejection must clear progress");
});

test("every advanced-Analyze protocol/loss status closes the owner, clears state, and reconnects only on later explicit Analyze", async (t) => {
  for (const status of [400, 404, 409, 413, 415, 503]) {
    await t.test(String(status), async () => {
      const transport = fakeTransport();
      const view = fakeView();
      const controller = createStandaloneBrowserController(transport, view);
      controller.start();
      const first = transport.owners[0];
      first.readyControl.resolve({ kind: "opened", sessionId: SESSION });
      controller.submit("https://github.com/owner/repository", "");
      await flush();
      first.analyzeCalls[0].result.resolve(status);
      await flush();
      assert.equal(first.closed, true);
      assert.deepEqual(view.calls.at(-1), [status === 503 ? "capacity" : "lost"]);
      assert.equal(transport.owners.length, 1);
      controller.submit("https://github.com/owner/repository", "");
      assert.equal(transport.owners.length, 2);
    });
  }
});

test("stale events are ignored; cancel and discard target only the current generation and tolerate event-first ordering", async () => {
  const transport = fakeTransport();
  const view = fakeView();
  const controller = createStandaloneBrowserController(transport, view);
  controller.start();
  const owner = transport.owners[0];
  owner.readyControl.resolve({ kind: "opened", sessionId: SESSION });
  controller.submit("https://github.com/owner/repository", "");
  await flush();
  owner.analyzeCalls[0].result.resolve(202);
  controller.submit("https://github.com/owner/repository", "");
  await flush();
  owner.observer.event(successEvent(1));
  assert.equal(view.calls.some(([name]) => name === "succeeded"), false);
  owner.analyzeCalls[1].result.resolve(202);
  await flush();
  owner.observer.event(successEvent(2));
  view.takeDiscard()();
  assert.deepEqual(owner.discardCalls[0].command, { sessionId: SESSION, generation: 2 });
  owner.discardCalls[0].result.resolve(204);
  await flush();
  assert.deepEqual(view.calls.at(-1), ["succeeded", 2, 1, 0, REVISION], "204 without an event must retain current state");
  owner.observer.event({ type: "CURRENT_DISCARDED", sessionId: SESSION, generation: 2 });
  assert.deepEqual(view.calls.at(-1), ["clear"]);

  controller.submit("https://github.com/owner/repository", "");
  await flush();
  view.takeCancel()();
  assert.deepEqual(owner.cancelCalls[0].command, { sessionId: SESSION, generation: 3 });
  owner.cancelCalls[0].result.resolve(204);
  await flush();
  assert.deepEqual(view.calls.at(-1), ["working"], "204 may precede the cancellation event");
  owner.observer.event({ type: "ANALYSIS_CANCELLED", sessionId: SESSION, generation: 3 });
  assert.deepEqual(view.calls.at(-1), ["cancelled"]);
});

test("stream loss and page disposal clear associations without retry, reconnect token, or retained result", async () => {
  const transport = fakeTransport();
  const view = fakeView();
  const controller = createStandaloneBrowserController(transport, view);
  controller.start();
  const owner = transport.owners[0];
  owner.readyControl.resolve({ kind: "opened", sessionId: SESSION });
  controller.submit("https://github.com/owner/repository", "");
  await flush();
  owner.observer.event(successEvent(1));
  owner.observer.lost();
  assert.deepEqual(view.calls.slice(-2), [["clear"], ["lost"]]);
  assert.equal(transport.owners.length, 1);
  controller.dispose();
  assert.equal(owner.closed, true);
  assert.deepEqual(view.calls.at(-1), ["clear"]);
});

test("generation advancement fails closed at the positive safe-integer boundary", () => {
  assert.equal(nextBrowserGeneration(0), 1);
  assert.equal(nextBrowserGeneration(Number.MAX_SAFE_INTEGER - 1), Number.MAX_SAFE_INTEGER);
  assert.equal(nextBrowserGeneration(Number.MAX_SAFE_INTEGER), undefined);
});

test("browser implementation contains no storage, retry, reconnect, provider, parser, numeric progress, or browser analysis process", async () => {
  const source = await readFile(new URL("../src/edge/standalone-browser-controller.ts", import.meta.url), "utf8");
  const main = await readFile(new URL("../src/edge/standalone-browser-main.ts", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/edge/standalone-browser-shell.css", import.meta.url), "utf8");
  assert.match(main, /document\.createElement\("progress"\)/u);
  assert.match(main, /progressLabel\.append\("Analysis progress", document\.createElement\("progress"\)\)/u);
  assert.doesNotMatch(main, /aria-valuenow|\.value\s*=\s*[^;]*progress|progress[^;\n]*\.value|setAttribute\(["']value["']/iu);
  assert.doesNotMatch(css, /@keyframes|\banimation(?:-name)?\s*:/iu);
  assert.doesNotMatch(`${source}\n${main}`, /localStorage|sessionStorage|indexedDB|serviceWorker|document\.cookie|setTimeout|setInterval|SharedWorker|new Worker|github-revision-gateway|github-source-gateway|tree-sitter|fallback analyzer|retry|reconnect token/iu);
});
