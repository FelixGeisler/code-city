import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(/^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context);
  },
});
const { createMainController } = await import("../src/application/main-controller.ts");
const { buildCity } = await import("../src/domain/city-model.ts");

const VALID = "https://github.com/owner/repo";
const SHA = "a".repeat(40);
const MODEL = buildCity([{ canonicalPath: "a.js", S: 1, U: 1, M: 0 }]).model;

function fixture({
  factoryThrows = false,
  factoryThrowsAt = [],
  listenThrows = false,
  sendThrows = false,
  sendThrowsWhen = () => false,
  presentResult = { kind: "committed" },
} = {}) {
  const events = [];
  const transports = [];
  let cancelAction;
  let createCalls = 0;
  let liveWorkers = 0;
  let maximumLiveWorkers = 0;
  const presentation = { clears: 0, calls: [], hooks: undefined };
  const view = {
    clear() {},
    invalid: () => events.push("view:Invalid input"),
    working(cancel) { cancelAction = cancel; events.push("view:working"); },
    success: (revision) => events.push(`view:success:${revision}`),
    failure: (category) => events.push(`view:${category}`),
    cancelled: () => events.push("view:Cancelled"),
  };
  function createWorker() {
    createCalls += 1;
    events.push("worker:create");
    if (factoryThrows || factoryThrowsAt.includes(createCalls)) throw new Error("startup");
    liveWorkers += 1;
    maximumLiveWorkers = Math.max(maximumLiveWorkers, liveWorkers);
    const transport = {
      number: createCalls,
      handlers: undefined,
      closeCalls: 0,
      detachCalls: 0,
      sent: [],
      send(command) {
        this.sent.push(command);
        events.push(`send:${command.type}`);
        if (sendThrows || sendThrowsWhen(this, command)) throw new Error("postMessage failed");
      },
      close() {
        this.closeCalls += 1;
        liveWorkers -= 1;
        events.push("worker:close");
      },
      listen(handlers) {
        events.push("worker:listen");
        if (listenThrows) throw new Error("listener startup");
        this.handlers = handlers;
        return () => { this.detachCalls += 1; events.push("worker:detach"); };
      },
    };
    transports.push(transport);
    return transport;
  }
  const controller = createMainController(createWorker, view, (hooks) => {
    presentation.hooks = hooks;
    return {
      clear() { presentation.clears += 1; },
      present(generation, model) {
        events.push("present");
        presentation.calls.push({ generation, model, eligible: hooks.isEligible(generation) });
        return presentResult;
      },
    };
  });
  return {
    controller,
    events,
    presentation,
    transports,
    cancel: () => cancelAction(),
    maximumLiveWorkers: () => maximumLiveWorkers,
  };
}

test("invalid input creates neither worker nor request-capable processing", () => {
  const f = fixture();
  for (const invalid of ["owner/repo", "https://github.com/owner/repo/"]) {
    assert.equal(f.controller.submit(invalid), false);
  }
  assert.deepEqual(f.events, ["view:Invalid input", "view:Invalid input"]);
  assert.equal(f.transports.length, 0);
});

test("one worker receives accepted unusual segments unchanged", () => {
  const f = fixture();
  const acceptedRawValue = "https://github.com/ow\fner/re po!";
  assert.equal(f.controller.submit(acceptedRawValue), true);
  assert.equal(f.transports.length, 1);
  assert.deepEqual(f.events.slice(0, 4), ["worker:create", "worker:listen", "view:working", "send:START"]);
  assert.deepEqual(f.transports[0].sent, [{
    type: "START",
    generation: 1,
    repository: { owner: "ow\fner", repository: "re po!" },
  }]);
});

test("mapped FAILURE is shown, then matching drain performs normal cleanup exactly once", () => {
  const f = fixture();
  f.controller.submit(VALID);
  const transport = f.transports[0];
  transport.handlers.message({ type: "FAILURE", generation: 1, category: "Revision unavailable" });
  assert.equal(transport.closeCalls, 0);
  transport.handlers.message({ type: "ATTEMPT_DRAINED", generation: 1 });
  assert.equal(transport.detachCalls, 1);
  assert.equal(transport.closeCalls, 1);
  transport.handlers.message({ type: "ATTEMPT_DRAINED", generation: 1 });
  assert.equal(transport.closeCalls, 1);
  assert.equal(f.events.filter((event) => event === "view:Revision unavailable").length, 1);
  assert.equal(f.controller.submit("https://github.com/owner/next"), true);
  assert.equal(f.transports[1].sent[0].generation, 2);
});

test("success is accepted once after the barrier, presented before publication, and remains eligible after worker drain", () => {
  const f = fixture();
  f.controller.submit(VALID);
  const transport = f.transports[0];
  transport.handlers.message({ type: "PROVIDER_DRAINED_STATIC_ENTERED", generation: 1 });
  transport.handlers.message({ type: "SUCCESS", generation: 1, revision: SHA, model: MODEL });
  assert.deepEqual(f.presentation.calls, [{ generation: 1, model: MODEL, eligible: true }]);
  assert.deepEqual(f.events.slice(-2), ["present", `view:success:${SHA}`]);
  transport.handlers.message({ type: "ATTEMPT_DRAINED", generation: 1 });
  assert.equal(transport.closeCalls, 1);
  assert.equal(f.presentation.hooks.isEligible(1), true);

  f.presentation.hooks.failed(1, "Presentation failed", "M1-PRES-1");
  assert.equal(f.events.at(-1), "view:Presentation failed");
  assert.equal(f.presentation.hooks.isEligible(1), false);
});

test("a new valid submission synchronously revokes a drained publication and can commit an identical second result", () => {
  const f = fixture();
  f.controller.submit(VALID);
  const first = f.transports[0];
  first.handlers.message({ type: "PROVIDER_DRAINED_STATIC_ENTERED", generation: 1 });
  first.handlers.message({ type: "SUCCESS", generation: 1, revision: SHA, model: MODEL });
  first.handlers.message({ type: "ATTEMPT_DRAINED", generation: 1 });
  assert.equal(f.presentation.clears, 1);

  assert.equal(f.controller.submit(VALID), true);
  assert.equal(f.presentation.clears, 2);
  assert.equal(f.presentation.hooks.isEligible(1), false);
  const second = f.transports[1];
  second.handlers.message({ type: "PROVIDER_DRAINED_STATIC_ENTERED", generation: 2 });
  second.handlers.message({ type: "SUCCESS", generation: 2, revision: SHA, model: MODEL });
  second.handlers.message({ type: "ATTEMPT_DRAINED", generation: 2 });
  assert.deepEqual(f.presentation.calls.map(({ generation, eligible }) => ({ generation, eligible })), [
    { generation: 1, eligible: true }, { generation: 2, eligible: true },
  ]);
  assert.equal(f.events.filter((event) => event === `view:success:${SHA}`).length, 2);
  assert.equal(f.maximumLiveWorkers(), 1);
});

test("invalid success models map to CITY1 before presentation and a duplicate success fails closed", () => {
  {
    const f = fixture();
    f.controller.submit(VALID);
    const transport = f.transports[0];
    transport.handlers.message({ type: "PROVIDER_DRAINED_STATIC_ENTERED", generation: 1 });
    transport.handlers.message({ type: "SUCCESS", generation: 1, revision: SHA, model: {} });
    assert.deepEqual(f.presentation.calls, []);
    assert.equal(f.events.at(-1), "view:City construction failed");
    transport.handlers.message({ type: "ATTEMPT_DRAINED", generation: 1 });
    assert.equal(transport.closeCalls, 1);
  }
  {
    const f = fixture();
    f.controller.submit(VALID);
    const transport = f.transports[0];
    transport.handlers.message({ type: "PROVIDER_DRAINED_STATIC_ENTERED", generation: 1 });
    const success = { type: "SUCCESS", generation: 1, revision: SHA, model: MODEL };
    transport.handlers.message(success);
    transport.handlers.message(success);
    assert.equal(transport.closeCalls, 1);
    assert.equal(f.presentation.clears, 2);
  }
});

test("synchronous presenter failure is mapped by the controller without using the asynchronous hook", () => {
  const f = fixture({ presentResult: { kind: "failure", category: "Presentation failed", code: "M1-PRES-1" } });
  f.controller.submit(VALID);
  const transport = f.transports[0];
  transport.handlers.message({ type: "PROVIDER_DRAINED_STATIC_ENTERED", generation: 1 });
  transport.handlers.message({ type: "SUCCESS", generation: 1, revision: SHA, model: MODEL });
  assert.equal(f.events.at(-1), "view:Presentation failed");
  assert.equal(f.events.some((event) => event.startsWith("view:success:")), false);
  transport.handlers.message({ type: "ATTEMPT_DRAINED", generation: 1 });
  assert.equal(transport.closeCalls, 1);
});

test("invalid replacement reports Invalid input and leaves the active attempt unchanged", () => {
  const f = fixture();
  f.controller.submit(VALID);
  assert.equal(f.controller.submit("owner/repo"), false);
  assert.equal(f.transports.length, 1);
  assert.deepEqual(f.transports[0].sent.map((message) => message.type), ["START"]);
  assert.equal(f.transports[0].closeCalls, 0);
  assert.equal(f.events.at(-1), "view:Invalid input");
});

test("provider-active replacement sends STOP, suppresses old failure, and starts only after drain", () => {
  const f = fixture();
  f.controller.submit(VALID);
  const old = f.transports[0];

  assert.equal(f.controller.submit("https://github.com/owner/replacement"), true);
  assert.deepEqual(old.sent.map((message) => message.type), ["START", "STOP"]);
  assert.equal(f.transports.length, 1);
  assert.equal(old.closeCalls, 0);

  old.handlers.message({ type: "FAILURE", generation: 1, category: "Revision unavailable" });
  assert.equal(f.events.includes("view:Revision unavailable"), false);
  old.handlers.message({ type: "ATTEMPT_DRAINED", generation: 1 });

  assert.equal(old.detachCalls, 1);
  assert.equal(old.closeCalls, 1);
  assert.equal(f.transports.length, 2);
  assert.deepEqual(f.events.slice(-6), [
    "worker:detach",
    "worker:close",
    "worker:create",
    "worker:listen",
    "view:working",
    "send:START",
  ]);
  assert.deepEqual(f.transports[1].sent[0], {
    type: "START",
    generation: 2,
    repository: { owner: "owner", repository: "replacement" },
  });
  assert.equal(f.maximumLiveWorkers(), 1);
});

test("validated static-phase replacement closes immediately without STOP and starts the latest", () => {
  const f = fixture();
  f.controller.submit(VALID);
  const old = f.transports[0];
  old.handlers.message({ type: "PROVIDER_DRAINED_STATIC_ENTERED", generation: 1 });

  assert.equal(f.controller.submit("https://github.com/owner/static-replacement"), true);
  assert.deepEqual(old.sent.map((message) => message.type), ["START"]);
  assert.equal(old.detachCalls, 1);
  assert.equal(old.closeCalls, 1);
  assert.equal(f.transports.length, 2);
  assert.equal(f.transports[1].sent[0].generation, 2);
  assert.equal(f.maximumLiveWorkers(), 1);
});

test("provider replacements coalesce to only the latest repository and send STOP once", () => {
  const f = fixture();
  f.controller.submit(VALID);
  const old = f.transports[0];
  f.controller.submit("https://github.com/owner/discarded");
  f.controller.submit("https://github.com/owner/latest");

  assert.deepEqual(old.sent.map((message) => message.type), ["START", "STOP"]);
  assert.equal(f.transports.length, 1);
  old.handlers.message({ type: "ATTEMPT_DRAINED", generation: 1 });
  assert.equal(f.transports.length, 2);
  assert.deepEqual(f.transports[1].sent[0].repository, { owner: "owner", repository: "latest" });
});

test("a raced static barrier after provider STOP clears the old worker before replacement", () => {
  const f = fixture();
  f.controller.submit(VALID);
  const old = f.transports[0];
  f.controller.submit("https://github.com/owner/latest");
  old.handlers.message({ type: "PROVIDER_DRAINED_STATIC_ENTERED", generation: 1 });

  assert.deepEqual(old.sent.map((message) => message.type), ["START", "STOP"]);
  assert.equal(old.closeCalls, 1);
  assert.equal(f.transports.length, 2);
  assert.equal(f.maximumLiveWorkers(), 1);
});

test("validated static barrier keeps the worker internal and cancellation terminates it without STOP", () => {
  const f = fixture();
  f.controller.submit(VALID);
  const transport = f.transports[0];
  transport.handlers.message({ type: "PROVIDER_DRAINED_STATIC_ENTERED", generation: 1 });
  assert.equal(transport.closeCalls, 0);
  assert.deepEqual(transport.sent.map((message) => message.type), ["START"]);
  f.cancel();
  assert.equal(transport.closeCalls, 1);
  assert.equal(transport.detachCalls, 1);
  assert.deepEqual(transport.sent.map((message) => message.type), ["START"]);
  assert.equal(f.events.at(-2), "worker:detach");
  assert.equal(f.events.at(-1), "worker:close");
});

test("a duplicate or raced static barrier fails closed and terminates exactly once", () => {
  const f = fixture();
  f.controller.submit(VALID);
  const transport = f.transports[0];
  const barrier = { type: "PROVIDER_DRAINED_STATIC_ENTERED", generation: 1 };
  transport.handlers.message(barrier);
  transport.handlers.message(barrier);
  assert.equal(transport.closeCalls, 1);
  assert.equal(f.events.filter((event) => event === "view:Provider/resolution failure").length, 1);
});

test("queued current FAILURE cannot replace synchronously selected cancellation", () => {
  const f = fixture();
  f.controller.submit(VALID);
  const transport = f.transports[0];
  const queuedFailure = () => transport.handlers.message({ type: "FAILURE", generation: 1, category: "Provider/resolution failure" });
  f.cancel();
  assert.deepEqual(f.events.slice(-2), ["view:Cancelled", "send:STOP"]);
  queuedFailure();
  assert.equal(transport.closeCalls, 0, "valid failure still permits matching normal drain");
  transport.handlers.message({ type: "ATTEMPT_DRAINED", generation: 1 });
  assert.equal(transport.closeCalls, 1);
  assert.equal(transport.detachCalls, 1);
  assert.equal(f.events.filter((event) => event.startsWith("view:")).at(-1), "view:Cancelled");
});

for (const [name, deliver] of [
  ["crash", (handlers) => handlers.crash()],
  ["error", (handlers) => handlers.crash()],
  ["messageerror", (handlers) => handlers.messageError()],
]) {
  test(`queued ${name} after cancellation uses immediate drain-impossible cleanup without replacing cancellation`, () => {
    const f = fixture();
    f.controller.submit(VALID);
    const transport = f.transports[0];
    f.cancel();
    deliver(transport.handlers);
    assert.equal(transport.closeCalls, 1);
    assert.equal(transport.detachCalls, 1);
    deliver(transport.handlers);
    transport.handlers.message({ type: "FAILURE", generation: 1, category: "Revision unavailable" });
    assert.equal(transport.closeCalls, 1);
    assert.equal(f.events.filter((event) => event === "view:Cancelled").length, 1);
    assert.equal(f.events.some((event) => event === "view:Revision unavailable"), false);
  });
}

test("stale generations are ignored before and after cancellation", () => {
  const f = fixture();
  f.controller.submit(VALID);
  const transport = f.transports[0];
  transport.handlers.message({ type: "FAILURE", generation: 999, category: "Revision unavailable" });
  assert.equal(transport.closeCalls, 0);
  f.cancel();
  transport.handlers.message({ type: "ATTEMPT_DRAINED", generation: 999 });
  assert.equal(transport.closeCalls, 0);
  transport.handlers.message({ type: "ATTEMPT_DRAINED", generation: 1 });
  assert.equal(transport.closeCalls, 1);
});

test("malformed current messages and un-cancelled crash/messageerror fail and clean up", () => {
  for (const deliver of [
    (handlers) => handlers.message({ type: "SUCCESS", generation: 1, revision: "a".repeat(40) }),
    (handlers) => handlers.crash(),
    (handlers) => handlers.messageError(),
  ]) {
    const f = fixture();
    f.controller.submit(VALID);
    const transport = f.transports[0];
    deliver(transport.handlers);
    assert.equal(transport.closeCalls, 1);
    assert.equal(transport.detachCalls, 1);
    assert.equal(f.events.filter((event) => event === "view:Provider/resolution failure").length, 1);
  }
});

test("replacement crash or messageerror makes drain impossible and starts the pending attempt", () => {
  for (const deliver of [(handlers) => handlers.crash(), (handlers) => handlers.messageError()]) {
    const f = fixture();
    f.controller.submit(VALID);
    const old = f.transports[0];
    f.controller.submit("https://github.com/owner/after-crash");
    deliver(old.handlers);

    assert.equal(old.detachCalls, 1);
    assert.equal(old.closeCalls, 1);
    assert.equal(f.transports.length, 2);
    assert.equal(f.events.some((event) => event === "view:Provider/resolution failure"), false);
    assert.equal(f.transports[1].sent[0].generation, 2);
    assert.equal(f.maximumLiveWorkers(), 1);
  }
});

test("a failed STOP send closes exactly once and starts the pending replacement", () => {
  const f = fixture({
    sendThrowsWhen: (transport, command) => transport.number === 1 && command.type === "STOP",
  });
  f.controller.submit(VALID);
  const old = f.transports[0];
  assert.equal(f.controller.submit("https://github.com/owner/after-stop-error"), true);

  assert.equal(old.detachCalls, 1);
  assert.equal(old.closeCalls, 1);
  assert.equal(f.transports.length, 2);
  assert.equal(f.transports[1].sent[0].generation, 2);
  assert.equal(f.events.some((event) => event === "view:Provider/resolution failure"), false);
  old.handlers.message({ type: "ATTEMPT_DRAINED", generation: 1 });
  assert.equal(old.closeCalls, 1);
});

test("replacement factory failure does not consume a generation or retain the old worker", () => {
  const f = fixture({ factoryThrowsAt: [2] });
  f.controller.submit(VALID);
  const old = f.transports[0];
  old.handlers.message({ type: "PROVIDER_DRAINED_STATIC_ENTERED", generation: 1 });
  assert.equal(f.controller.submit("https://github.com/owner/factory-fails"), true);

  assert.equal(old.detachCalls, 1);
  assert.equal(old.closeCalls, 1);
  assert.equal(f.transports.length, 1);
  assert.equal(f.events.filter((event) => event === "view:Provider/resolution failure").length, 1);

  assert.equal(f.controller.submit("https://github.com/owner/recovered"), true);
  assert.equal(f.transports.length, 2);
  assert.equal(f.transports[1].sent[0].generation, 2);
  assert.equal(f.maximumLiveWorkers(), 1);
});

test("stale old callbacks and stale generations cannot affect the replacement", () => {
  const f = fixture();
  f.controller.submit(VALID);
  const old = f.transports[0];
  f.controller.submit("https://github.com/owner/current");
  old.handlers.message({ type: "ATTEMPT_DRAINED", generation: 1 });
  const current = f.transports[1];

  old.handlers.message({ type: "FAILURE", generation: 1, category: "Revision unavailable" });
  old.handlers.crash();
  current.handlers.message({ type: "FAILURE", generation: 1, category: "Revision unavailable" });
  assert.equal(old.closeCalls, 1);
  assert.equal(current.closeCalls, 0);
  assert.equal(f.events.some((event) => event === "view:Revision unavailable"), false);
});

test("cancellation clears a pending replacement and keeps cancellation precedence", () => {
  const f = fixture();
  f.controller.submit(VALID);
  const old = f.transports[0];
  f.controller.submit("https://github.com/owner/pending");
  f.cancel();
  old.handlers.message({ type: "FAILURE", generation: 1, category: "Revision unavailable" });
  old.handlers.message({ type: "ATTEMPT_DRAINED", generation: 1 });

  assert.deepEqual(old.sent.map((message) => message.type), ["START", "STOP"]);
  assert.equal(old.detachCalls, 1);
  assert.equal(old.closeCalls, 1);
  assert.equal(f.transports.length, 1);
  assert.equal(f.events.filter((event) => event === "view:Cancelled").length, 1);
  assert.equal(f.events.some((event) => event === "view:Revision unavailable"), false);
});

test("a later submission can queue while cancellation drains, and cancel can clear it again", () => {
  const f = fixture();
  f.controller.submit(VALID);
  const old = f.transports[0];
  f.cancel();
  f.controller.submit("https://github.com/owner/new-pending");
  f.cancel();
  old.handlers.message({ type: "ATTEMPT_DRAINED", generation: 1 });
  assert.equal(f.transports.length, 1);
  assert.equal(f.events.filter((event) => event === "view:Cancelled").length, 1);
});

test("startup construction and post failures expose only mapped failure without consuming generations", () => {
  const construction = fixture({ factoryThrowsAt: [1] });
  assert.equal(construction.controller.submit(VALID), false);
  assert.deepEqual(construction.events, ["worker:create", "view:Provider/resolution failure"]);
  assert.equal(construction.controller.submit("https://github.com/owner/retry"), true);
  assert.equal(construction.transports[0].sent[0].generation, 1);

  const listening = fixture({ listenThrows: true });
  assert.equal(listening.controller.submit(VALID), false);
  assert.equal(listening.transports[0].closeCalls, 1);
  assert.equal(listening.events.filter((event) => event === "view:Provider/resolution failure").length, 1);

  const posting = fixture({ sendThrowsWhen: (_transport, command) => command.type === "START" });
  assert.equal(posting.controller.submit(VALID), false);
  assert.equal(posting.transports[0].closeCalls, 1);
  assert.equal(posting.transports[0].detachCalls, 1);
  assert.equal(posting.events.filter((event) => event === "view:Provider/resolution failure").length, 1);
});
