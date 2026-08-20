import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(/^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context);
  },
});
const { createMainController } = await import("../src/application/main-controller.ts");

const VALID = "https://github.com/owner/repo";

function fixture({ factoryThrows = false, listenThrows = false, sendThrows = false } = {}) {
  const events = [];
  const transports = [];
  let cancelAction;
  const view = {
    invalid: () => events.push("view:Invalid input"),
    working(cancel) { cancelAction = cancel; events.push("view:working"); },
    failure: (category) => events.push(`view:${category}`),
    cancelled: () => events.push("view:Cancelled"),
  };
  function createWorker() {
    events.push("worker:create");
    if (factoryThrows) throw new Error("startup");
    const transport = {
      handlers: undefined,
      closeCalls: 0,
      detachCalls: 0,
      sent: [],
      send(command) {
        this.sent.push(command);
        events.push(`send:${command.type}`);
        if (sendThrows) throw new Error("postMessage failed");
      },
      close() { this.closeCalls += 1; events.push("worker:close"); },
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
  const controller = createMainController(createWorker, view);
  return { controller, events, transports, cancel: () => cancelAction() };
}

test("invalid input creates neither worker nor request-capable processing", () => {
  const f = fixture();
  for (const invalid of ["owner/repo", "https://github.com/owner/repo/"]) {
    assert.equal(f.controller.submit(invalid), false);
  }
  assert.deepEqual(f.events, ["view:Invalid input", "view:Invalid input"]);
  assert.equal(f.transports.length, 0);
});

test("one worker receives accepted unusual segments unchanged and active submission is disabled", () => {
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
  assert.equal(f.controller.submit(VALID), false);
  assert.equal(f.transports.length, 1);
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

test("startup construction and post failures expose only mapped failure", () => {
  const construction = fixture({ factoryThrows: true });
  assert.equal(construction.controller.submit(VALID), false);
  assert.deepEqual(construction.events, ["worker:create", "view:Provider/resolution failure"]);

  const listening = fixture({ listenThrows: true });
  assert.equal(listening.controller.submit(VALID), false);
  assert.equal(listening.transports[0].closeCalls, 1);
  assert.equal(listening.events.filter((event) => event === "view:Provider/resolution failure").length, 1);

  const posting = fixture({ sendThrows: true });
  assert.equal(posting.controller.submit(VALID), false);
  assert.equal(posting.transports[0].closeCalls, 1);
  assert.equal(posting.transports[0].detachCalls, 1);
  assert.equal(posting.events.filter((event) => event === "view:Provider/resolution failure").length, 1);
});
