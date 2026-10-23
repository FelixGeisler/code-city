import assert from "node:assert/strict";
import test from "node:test";
import { captureNativeScrollEvidence } from "../tools/native-scroll-evidence.mjs";

const SESSION = "page-session";
const SELECTOR = "[data-path-search-results]";
const GEOMETRY = Object.freeze({ left: 10, top: 20, width: 300, height: 120, x: 160, y: 80, hit: true });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class CountingSet extends Set {
  deleteCalls = 0;
  delete(value) {
    this.deleteCalls += 1;
    return super.delete(value);
  }
}

function fakeTimer() {
  const scheduled = [];
  return {
    scheduled,
    setTimer(callback, delay) {
      const timer = { callback, delay, cleared: false };
      scheduled.push(timer);
      return timer;
    },
    clearTimer(timer) { timer.cleared = true; },
    expire() {
      const timer = scheduled.find((candidate) => !candidate.cleared);
      assert(timer, "no active deadline timer");
      timer.callback();
    },
  };
}

function createHarness({ onSetup, onInput, setupResult } = {}) {
  const listeners = new CountingSet();
  const calls = [];
  const inputWaiters = [];
  let inputCount = 0;
  let bindingName;
  let cleanupEvaluations = 0;
  let bindingRemovals = 0;
  const cdp = {
    listeners,
    async send(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === "Runtime.addBinding") {
        bindingName = params.name;
        return {};
      }
      if (method === "Runtime.evaluate") {
        if (params.expression.includes("const bindingName=")) {
          if (onSetup) await onSetup(harness);
          return setupResult ?? { result: { value: true } };
        }
        cleanupEvaluations += 1;
        return { result: { value: true } };
      }
      if (method === "Input.dispatchMouseEvent") {
        inputCount += 1;
        for (const waiter of inputWaiters.splice(0)) {
          if (inputCount >= waiter.count) waiter.resolve();
          else inputWaiters.push(waiter);
        }
        if (onInput) return await onInput(harness);
        return {};
      }
      if (method === "Runtime.removeBinding") {
        bindingRemovals += 1;
        return {};
      }
      throw new Error(`unexpected CDP method ${method}`);
    },
  };
  const harness = {
    cdp,
    calls,
    waitForInput(count = 1) {
      if (inputCount >= count) return Promise.resolve();
      const waiter = deferred();
      inputWaiters.push({ count, resolve: waiter.resolve });
      return waiter.promise;
    },
    get bindingName() { return bindingName; },
    get cleanupEvaluations() { return cleanupEvaluations; },
    get bindingRemovals() { return bindingRemovals; },
    emit(payload, { name = bindingName, sessionId = SESSION, method = "Runtime.bindingCalled", raw = false } = {}) {
      const message = {
        method,
        sessionId,
        params: { name, payload: raw ? payload : JSON.stringify(payload) },
      };
      for (const listener of [...listeners]) listener(message);
    },
  };
  return harness;
}

function registered(token, before = 0) {
  return { token, state: "registered", before, geometry: { ...GEOMETRY } };
}

function changed(token, before = 0, after = 80) {
  return { token, state: "changed", before, after };
}

function settled(token, before = 0, after = 80) {
  return { token, state: "settled", before, after, geometry: { ...GEOMETRY, top: 18, y: 78 } };
}

function operation(harness, timer, token, options = {}) {
  return captureNativeScrollEvidence({
    cdp: harness.cdp,
    sessionId: SESSION,
    selector: SELECTOR,
    deltaY: 500,
    deadline: 1_000,
    token,
    now: () => 0,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
    ...options,
  });
}

function assertCleaned(harness, timer) {
  assert.equal(harness.cleanupEvaluations, 1, "page listeners/state were not cleaned exactly once");
  assert.equal(harness.bindingRemovals, 1, "page binding was not removed exactly once");
  assert.equal(harness.cdp.listeners.size, 0, "host delivery handler leaked");
  assert.equal(harness.cdp.listeners.deleteCalls, 1, "host delivery handler was not removed exactly once");
  assert.equal(timer.scheduled.length, 1);
  assert.equal(timer.scheduled[0].cleared, true, "deadline timer leaked");
}

async function assertStillPending(promise) {
  let terminal = false;
  void promise.then(() => { terminal = true; }, () => { terminal = true; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(terminal, false);
}

test("registration precedes native input and command acknowledgement cannot complete the operation", async () => {
  const token = "ordered-operation";
  const inputAck = deferred();
  const harness = createHarness({
    onSetup(current) { current.emit(registered(token)); },
    onInput() { return inputAck.promise; },
  });
  const timer = fakeTimer();
  const pending = operation(harness, timer, token);

  await harness.waitForInput();
  assert.deepEqual(harness.calls.slice(0, 3).map(({ method }) => method), [
    "Runtime.addBinding", "Runtime.evaluate", "Input.dispatchMouseEvent",
  ]);
  assert.deepEqual(harness.calls[2].params, {
    type: "mouseWheel", x: GEOMETRY.x, y: GEOMETRY.y, deltaX: 0, deltaY: 500,
  });
  inputAck.resolve({});
  await assertStillPending(pending);

  harness.emit(changed(token));
  await assertStillPending(pending);
  harness.emit(settled(token));
  assert.deepEqual(await pending, {
    before: 0,
    after: 80,
    geometry: { ...GEOMETRY, top: 18, y: 78 },
  });
  assertCleaned(harness, timer);
});

test("unrelated delivery is ignored while exact token/session delivery settles", async () => {
  const token = "correlated-operation";
  const harness = createHarness({ onSetup(current) { current.emit(registered(token)); } });
  const timer = fakeTimer();
  const pending = operation(harness, timer, token);
  await harness.waitForInput();

  harness.emit(changed(token), { name: "__unrelatedBinding" });
  harness.emit(changed(token), { method: "Network.requestWillBeSent" });
  await assertStillPending(pending);
  harness.emit(changed(token));
  harness.emit(settled(token));
  assert.equal((await pending).after, 80);
  assertCleaned(harness, timer);
});

const protocolFailures = [
  {
    name: "malformed JSON",
    setup(current, token) { current.emit("{", { raw: true }); },
    expected: /malformed JSON/u,
  },
  {
    name: "mismatched token",
    setup(current) { current.emit(registered("another-token")); },
    expected: /token mismatch/u,
  },
  {
    name: "mismatched session",
    setup(current, token) { current.emit(registered(token), { sessionId: "worker-session" }); },
    expected: /session mismatch/u,
  },
  {
    name: "extra registered field",
    setup(current, token) { current.emit({ ...registered(token), extra: true }); },
    expected: /malformed registered state/u,
  },
  {
    name: "malformed error",
    setup(current, token) { current.emit({ token, state: "error", message: "failed", extra: true }); },
    expected: /malformed error/u,
  },
  {
    name: "malformed changed state",
    setup(current, token) { current.emit(registered(token)); },
    afterInput(current, token) { current.emit(changed(token, 0, 0)); },
    expected: /malformed changed state/u,
  },
  {
    name: "malformed settled state",
    setup(current, token) { current.emit(registered(token)); },
    afterInput(current, token) {
      current.emit(changed(token));
      current.emit({ ...settled(token), geometry: { ...GEOMETRY, hit: false } });
    },
    expected: /malformed settled state/u,
  },
  {
    name: "changed before registration",
    setup(current, token) { current.emit(changed(token)); },
    expected: /out-of-order changed/u,
  },
  {
    name: "settled before changed",
    setup(current, token) { current.emit(registered(token)); current.emit(settled(token)); },
    expected: /out-of-order settled/u,
  },
  {
    name: "duplicate registration",
    setup(current, token) { current.emit(registered(token)); current.emit(registered(token)); },
    expected: /duplicate or out-of-order registered/u,
  },
  {
    name: "duplicate changed",
    setup(current, token) { current.emit(registered(token)); },
    afterInput(current, token) { current.emit(changed(token)); current.emit(changed(token, 0, 90)); },
    expected: /duplicate or out-of-order changed/u,
  },
  {
    name: "duplicate settled",
    setup(current, token) { current.emit(registered(token)); },
    afterInput(current, token) { current.emit(changed(token)); current.emit(settled(token)); current.emit(settled(token, 0, 90)); },
    expected: /duplicate or out-of-order settled/u,
  },
  {
    name: "unknown state",
    setup(current, token) { current.emit({ token, state: "complete" }); },
    expected: /unknown state/u,
  },
];

for (const scenario of protocolFailures) {
  test(`closed native-scroll protocol rejects ${scenario.name}`, async () => {
    const token = `rejection-${protocolFailures.indexOf(scenario)}`;
    const harness = createHarness({ onSetup(current) { scenario.setup(current, token); } });
    const timer = fakeTimer();
    const pending = operation(harness, timer, token);
    if (scenario.afterInput) {
      await harness.waitForInput();
      scenario.afterInput(harness, token);
    }
    await assert.rejects(pending, scenario.expected);
    assertCleaned(harness, timer);
  });
}

test("failed page registration result cleans all delivery state", async () => {
  const token = "registration-result-error";
  const harness = createHarness({ setupResult: { result: { value: false } } });
  const timer = fakeTimer();
  await assert.rejects(operation(harness, timer, token), /registration failed/u);
  assert.equal(harness.calls.some(({ method }) => method === "Input.dispatchMouseEvent"), false);
  assertCleaned(harness, timer);
});

test("page terminal error rejects registration and cleans all delivery state", async () => {
  const token = "registration-error";
  const harness = createHarness({
    onSetup(current) { current.emit({ token, state: "error", message: "region unavailable" }); },
  });
  const timer = fakeTimer();
  await assert.rejects(operation(harness, timer, token), /region unavailable/u);
  assert.equal(harness.calls.some(({ method }) => method === "Input.dispatchMouseEvent"), false);
  assertCleaned(harness, timer);
});

test("native wheel command failure cleans all delivery state", async () => {
  const token = "command-error";
  const harness = createHarness({
    onSetup(current) { current.emit(registered(token)); },
    onInput() { throw new Error("wheel command rejected"); },
  });
  const timer = fakeTimer();
  await assert.rejects(operation(harness, timer, token), /wheel command rejected/u);
  assertCleaned(harness, timer);
});

test("page promise failure cleans all delivery state", async () => {
  const token = "page-promise-error";
  const harness = createHarness({ setupResult: { exceptionDetails: { text: "evaluation failed" } } });
  const timer = fakeTimer();
  await assert.rejects(operation(harness, timer, token), /page promise failed/u);
  assertCleaned(harness, timer);
});

test("existing deadline expiry interrupts a pending command and cleans all delivery state", async () => {
  const token = "deadline-error";
  const wheelCommand = deferred();
  const harness = createHarness({
    onSetup(current) { current.emit(registered(token)); },
    onInput() { return wheelCommand.promise; },
  });
  const timer = fakeTimer();
  const pending = operation(harness, timer, token);
  await harness.waitForInput();
  timer.expire();
  await assert.rejects(pending, /deadline expired/u);
  assertCleaned(harness, timer);
});

test("explicit cancellation interrupts a pending command and cleans all delivery state", async () => {
  const token = "cancelled-operation";
  const controller = new AbortController();
  const wheelCommand = deferred();
  const harness = createHarness({
    onSetup(current) { current.emit(registered(token)); },
    onInput() { return wheelCommand.promise; },
  });
  const timer = fakeTimer();
  const pending = operation(harness, timer, token, { signal: controller.signal });
  await harness.waitForInput();
  controller.abort();
  await assert.rejects(pending, /cancelled/u);
  assertCleaned(harness, timer);
});

test("late delivery from a cleaned operation cannot contaminate the next token", async () => {
  const firstToken = "first-operation";
  const secondToken = "second-operation";
  let activeToken = firstToken;
  const harness = createHarness({ onSetup(current) { current.emit(registered(activeToken)); } });

  const firstTimer = fakeTimer();
  const first = operation(harness, firstTimer, firstToken);
  await harness.waitForInput();
  const firstBinding = harness.bindingName;
  harness.emit(changed(firstToken));
  harness.emit(settled(firstToken));
  await first;
  assertCleaned(harness, firstTimer);

  activeToken = secondToken;
  const secondTimer = fakeTimer();
  const second = operation(harness, secondTimer, secondToken);
  await harness.waitForInput(2);
  harness.emit(changed(firstToken), { name: firstBinding });
  await assertStillPending(second);
  harness.emit(changed(secondToken));
  harness.emit(settled(secondToken));
  assert.equal((await second).after, 80);
  assert.equal(harness.cleanupEvaluations, 2);
  assert.equal(harness.bindingRemovals, 2);
  assert.equal(harness.cdp.listeners.size, 0);
  assert.equal(harness.cdp.listeners.deleteCalls, 2);
  assert.equal(secondTimer.scheduled[0].cleared, true);
});
