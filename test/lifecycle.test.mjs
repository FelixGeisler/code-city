import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { createServer as createViteServer } from "vite";

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(/^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context);
  },
});
const { createMainController } = await import("../src/application/main-controller.ts");
const { buildCity } = await import("../src/domain/city-model.ts");
const { stageSemanticPublication } = await import("../src/edge/semantic-publication.ts");

const VALID = "https://github.com/owner/repo";
const SHA = "a".repeat(40);
const CITY = buildCity([{ canonicalPath: "a.js", S: 1, U: 1, M: 0 }]);

function fixture({
  factoryThrows = false,
  factoryThrowsAt = [],
  listenThrows = false,
  sendThrows = false,
  sendThrowsWhen = () => false,
  presentResult = { kind: "committed" },
  commitResult = { kind: "committed" },
  visualResult = { kind: "applied" },
  commitThrows = false,
  visualThrows = false,
  rollbackThrows = false,
  publicationStageThrows = false,
  publicationCommitThrows = false,
  publicationRollbackThrows = false,
  selectionThrows = false,
  successThrows = false,
  publicationFactory,
  onStage,
} = {}) {
  const events = [];
  const transports = [];
  let cancelAction;
  let visibleState = "empty";
  let createCalls = 0;
  let liveWorkers = 0;
  let maximumLiveWorkers = 0;
  const failures = [];
  const presentation = { clears: 0, calls: [], commits: [], disposes: 0, eventSinks: [], hooks: undefined, publications: [], rollbacks: [], visual: [] };
  const view = {
    clear() { visibleState = "empty"; },
    stagePublication(revision, inspection) {
      events.push("semantic:stage");
      if (publicationStageThrows) throw new Error("semantic stage");
      if (publicationFactory) {
        const publication = publicationFactory(revision, inspection);
        presentation.publications.push(publication);
        return publication;
      }
      let active = true;
      const publication = {
        commits: 0,
        commit(canvas) {
          events.push("publication:commit");
          if (publicationCommitThrows) throw new Error("publication commit");
          this.commits += 1;
          this.canvas = canvas;
          this.revision = revision;
          this.inspection = inspection;
        },
        setSelection(index) {
          events.push("semantic:selection");
          if (selectionThrows) throw new Error("semantic selection");
          this.selections ??= [];
          this.selections.push(index);
        },
        rollback() {
          if (!active) return;
          active = false;
          presentation.clears += 1;
          events.push("semantic:rollback");
          if (publicationRollbackThrows) throw new Error("semantic rollback");
        },
      };
      presentation.publications.push(publication);
      return publication;
    },
    invalid() { visibleState = "invalid"; events.push("view:Invalid input"); },
    working(cancel) { visibleState = "working-with-cancel"; cancelAction = cancel; events.push("view:working"); },
    success(revision) { if (successThrows) throw new Error("success"); visibleState = "success"; events.push(`view:success:${revision}`); },
    failure(category, code, revision) {
      visibleState = "failure";
      failures.push({ category, code, revision });
      events.push(`view:${category}`);
    },
    cancelled() { visibleState = "cancelled"; events.push("view:Cancelled"); },
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
      dispose() { presentation.disposes += 1; },
      stage(generation, geometry, eventSink) {
        events.push("stage");
        presentation.calls.push({ generation, geometry, eligible: hooks.isEligible(generation) });
        presentation.eventSinks.push(eventSink);
        onStage?.({ generation, eventSink, hooks });
        if (presentResult.kind !== "committed") return presentResult;
        return { kind: "staged", token: Object.freeze({ generation }), canvas: { remove() {} } };
      },
      commit(token) { events.push("presenter:commit"); presentation.commits.push(token); if (commitThrows) throw new Error("commit"); return commitResult; },
      rollback(token) { events.push("presenter:rollback"); presentation.rollbacks.push(token); if (rollbackThrows) throw new Error("rollback"); },
      setVisualState(generation, hover, selection) {
        events.push("visual");
        presentation.visual.push({ generation, hover, selection });
        if (visualThrows) throw new Error("visual");
        return visualResult;
      },
    };
  });
  return {
    controller,
    events,
    failures,
    presentation,
    transports,
    cancel: () => cancelAction(),
    clickVisibleCancel() {
      assert.equal(visibleState, "working-with-cancel");
      assert.equal(typeof cancelAction, "function");
      cancelAction();
    },
    maximumLiveWorkers: () => maximumLiveWorkers,
    visibleState: () => visibleState,
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

test("success is accepted once after the barrier, staged before one publication commit, and remains eligible after worker drain", () => {
  const f = fixture();
  f.controller.submit(VALID);
  const transport = f.transports[0];
  transport.handlers.message({ type: "REVISION_SELECTED", generation: 1, revision: SHA });
  transport.handlers.message({ type: "PROVIDER_DRAINED_STATIC_ENTERED", generation: 1 });
  transport.handlers.message({ type: "SUCCESS", generation: 1, revision: SHA, city: CITY });
  assert.equal(f.presentation.calls.length, 1);
  assert.equal(f.presentation.calls[0].generation, 1);
  assert.equal(f.presentation.calls[0].eligible, true);
  assert.deepEqual([...f.presentation.calls[0].geometry.origins], [...CITY.geometry.origins]);
  assert.notEqual(f.presentation.calls[0].geometry.origins, CITY.geometry.origins);
  assert.deepEqual(f.events.slice(-6), ["stage", "semantic:stage", "presenter:commit", "visual", "publication:commit", `view:success:${SHA}`]);
  assert.deepEqual(f.presentation.visual, [{ generation: 1, hover: null, selection: null }]);
  transport.handlers.message({ type: "ATTEMPT_DRAINED", generation: 1 });
  assert.equal(transport.closeCalls, 1);
  assert.equal(f.presentation.hooks.isEligible(1), true);

  f.presentation.hooks.failed(1, "Presentation failed", "M1-PRES-1");
  assert.deepEqual(f.events.slice(-3), ["semantic:rollback", "presenter:rollback", "view:Presentation failed"]);
  assert.deepEqual(f.failures.at(-1), { category: "Presentation failed", code: "M1-PRES-1", revision: SHA });
  assert.equal(f.presentation.hooks.isEligible(1), false);
});

test("a new valid submission synchronously revokes a drained publication and can commit an identical second result", () => {
  const f = fixture();
  f.controller.submit(VALID);
  const first = f.transports[0];
  first.handlers.message({ type: "REVISION_SELECTED", generation: 1, revision: SHA });
  first.handlers.message({ type: "PROVIDER_DRAINED_STATIC_ENTERED", generation: 1 });
  first.handlers.message({ type: "SUCCESS", generation: 1, revision: SHA, city: CITY });
  first.handlers.message({ type: "ATTEMPT_DRAINED", generation: 1 });
  assert.equal(f.presentation.clears, 0);

  assert.equal(f.controller.submit(VALID), true);
  assert.equal(f.presentation.clears, 1);
  assert.equal(f.presentation.hooks.isEligible(1), false);
  const second = f.transports[1];
  second.handlers.message({ type: "REVISION_SELECTED", generation: 2, revision: SHA });
  second.handlers.message({ type: "PROVIDER_DRAINED_STATIC_ENTERED", generation: 2 });
  second.handlers.message({ type: "SUCCESS", generation: 2, revision: SHA, city: CITY });
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
    transport.handlers.message({ type: "REVISION_SELECTED", generation: 1, revision: SHA });
    transport.handlers.message({ type: "PROVIDER_DRAINED_STATIC_ENTERED", generation: 1 });
    transport.handlers.message({ type: "SUCCESS", generation: 1, revision: SHA, city: {} });
    assert.deepEqual(f.presentation.calls, []);
    assert.equal(f.events.at(-1), "view:City construction failed");
    transport.handlers.message({ type: "ATTEMPT_DRAINED", generation: 1 });
    assert.equal(transport.closeCalls, 1);
  }
  {
    const f = fixture();
    f.controller.submit(VALID);
    const transport = f.transports[0];
    transport.handlers.message({ type: "REVISION_SELECTED", generation: 1, revision: SHA });
    transport.handlers.message({ type: "PROVIDER_DRAINED_STATIC_ENTERED", generation: 1 });
    const success = { type: "SUCCESS", generation: 1, revision: SHA, city: CITY };
    transport.handlers.message(success);
    transport.handlers.message(success);
    assert.equal(transport.closeCalls, 1);
    assert.equal(f.presentation.clears, 1);
  }
});

test("synchronous presenter failure is mapped by the controller without using the asynchronous hook", () => {
  const f = fixture({ presentResult: { kind: "failure", category: "Presentation failed", code: "M1-PRES-1" } });
  f.controller.submit(VALID);
  const transport = f.transports[0];
  transport.handlers.message({ type: "REVISION_SELECTED", generation: 1, revision: SHA });
  transport.handlers.message({ type: "PROVIDER_DRAINED_STATIC_ENTERED", generation: 1 });
  transport.handlers.message({ type: "SUCCESS", generation: 1, revision: SHA, city: CITY });
  assert.equal(f.events.at(-1), "view:Presentation failed");
  assert.deepEqual(f.failures.at(-1), { category: "Presentation failed", code: "M1-PRES-1", revision: SHA });
  assert.equal(f.events.some((event) => event.startsWith("view:success:")), false);
  transport.handlers.message({ type: "ATTEMPT_DRAINED", generation: 1 });
  assert.equal(transport.closeCalls, 1);
});

test("every post-validation transaction failure rolls back and maps exactly once to M1-PRES-1", () => {
  const cases = [
    ["stage", { presentResult: { kind: "failure", category: "Presentation failed", code: "M1-PRES-1" } }],
    ["semantic stage", { publicationStageThrows: true }],
    ["presenter commit", { commitThrows: true }],
    ["initial visual result", { visualResult: { kind: "failure", category: "Presentation failed", code: "M1-PRES-1" } }],
    ["initial visual throw", { visualThrows: true }],
    ["publication root", { publicationCommitThrows: true }],
    ["success view", { successThrows: true }],
    ["rollback containment", { publicationCommitThrows: true, publicationRollbackThrows: true, rollbackThrows: true }],
  ];
  for (const [name, options] of cases) {
    const f = fixture(options);
    f.controller.submit(VALID);
    const transport = f.transports[0];
    transport.handlers.message({ type: "REVISION_SELECTED", generation: 1, revision: SHA });
    transport.handlers.message({ type: "PROVIDER_DRAINED_STATIC_ENTERED", generation: 1 });
    transport.handlers.message({ type: "SUCCESS", generation: 1, revision: SHA, city: CITY });
    assert.deepEqual(f.failures, [{ category: "Presentation failed", code: "M1-PRES-1", revision: SHA }], name);
    assert.equal(f.events.filter((event) => event === "publication:commit").length, name === "publication root" || name === "success view" || name === "rollback containment" ? 1 : 0, name);
    assert.equal(f.events.filter((event) => event === "view:Presentation failed").length, 1, name);
    assert.equal(f.presentation.hooks.isEligible(1), false, name);
  }
});

test("stale stage, token, and visual outcomes clean up without a displayed failure", () => {
  for (const options of [
    { presentResult: { kind: "stale" } },
    { commitResult: { kind: "stale" } },
    { visualResult: { kind: "stale" } },
  ]) {
    const f = fixture(options);
    f.controller.submit(VALID);
    const transport = f.transports[0];
    transport.handlers.message({ type: "REVISION_SELECTED", generation: 1, revision: SHA });
    transport.handlers.message({ type: "PROVIDER_DRAINED_STATIC_ENTERED", generation: 1 });
    transport.handlers.message({ type: "SUCCESS", generation: 1, revision: SHA, city: CITY });
    assert.equal(f.failures.length, 0);
    assert.equal(f.events.some((event) => event.startsWith("view:success:")), false);
    assert.equal(transport.closeCalls, 1);
  }
});

test("final eligibility recheck rejects a replacement raced through presenter stage", () => {
  let replace = () => { throw new Error("uninitialized"); };
  const f = fixture({ onStage: () => replace() });
  replace = () => { assert.equal(f.controller.submit("https://github.com/owner/raced"), true); };
  f.controller.submit(VALID);
  const old = f.transports[0];
  old.handlers.message({ type: "REVISION_SELECTED", generation: 1, revision: SHA });
  old.handlers.message({ type: "PROVIDER_DRAINED_STATIC_ENTERED", generation: 1 });
  old.handlers.message({ type: "SUCCESS", generation: 1, revision: SHA, city: CITY });
  assert.equal(f.failures.length, 0);
  assert.equal(f.events.includes("semantic:stage"), false);
  assert.equal(f.presentation.rollbacks.length, 1);
  assert.equal(f.transports.length, 2);
  assert.equal(f.transports[1].sent[0].generation, 2);
});

test("committed event sink gates generation and token before authoritative visual updates", () => {
  const f = fixture();
  f.controller.submit(VALID);
  const first = f.transports[0];
  first.handlers.message({ type: "REVISION_SELECTED", generation: 1, revision: SHA });
  first.handlers.message({ type: "PROVIDER_DRAINED_STATIC_ENTERED", generation: 1 });
  first.handlers.message({ type: "SUCCESS", generation: 1, revision: SHA, city: CITY });
  const sink = f.presentation.eventSinks[0];
  assert.equal(f.presentation.publications[0].commits, 1);
  assert.deepEqual(f.presentation.publications[0].inspection, CITY.inspection);
  assert.notEqual(f.presentation.publications[0].inspection, CITY.inspection);
  const initial = f.presentation.visual.length;
  sink.hoverIndex(999, 0);
  sink.activationIndex(1, 1);
  sink.selectionAction(999, "first");
  assert.equal(f.presentation.visual.length, initial);
  sink.hoverIndex(1, 0);
  sink.activationIndex(1, 0);
  sink.selectionAction(1, "next");
  sink.selectionAction(1, "previous");
  sink.selectionAction(1, "last");
  sink.selectionAction(1, "clear");
  assert.deepEqual(f.presentation.visual.slice(initial), [
    { generation: 1, hover: 0, selection: null },
    { generation: 1, hover: 0, selection: 0 },
    { generation: 1, hover: 0, selection: 0 },
    { generation: 1, hover: 0, selection: 0 },
    { generation: 1, hover: 0, selection: 0 },
    { generation: 1, hover: 0, selection: null },
  ]);
  assert.deepEqual(f.presentation.publications[0].selections, [0, null]);
  first.handlers.message({ type: "ATTEMPT_DRAINED", generation: 1 });
  f.controller.submit("https://github.com/owner/next");
  sink.hoverIndex(1, null);
  sink.selectionAction(1, "first");
  assert.equal(f.presentation.visual.length, initial + 6);
  assert.deepEqual(f.presentation.publications[0].selections, [0, null]);
});

test("controller traversal is no-wrap over canonical first, last, single, adversarial, and 4,000-entry snapshots", () => {
  const publish = (f, city) => {
    f.controller.submit(VALID);
    const transport = f.transports[0];
    transport.handlers.message({ type: "REVISION_SELECTED", generation: 1, revision: SHA });
    transport.handlers.message({ type: "PROVIDER_DRAINED_STATIC_ENTERED", generation: 1 });
    transport.handlers.message({ type: "SUCCESS", generation: 1, revision: SHA, city });
    return f.presentation.eventSinks[0];
  };

  const single = fixture();
  const singleSink = publish(single, CITY);
  singleSink.selectionAction(1, "previous");
  singleSink.selectionAction(1, "previous");
  singleSink.selectionAction(1, "next");
  singleSink.selectionAction(1, "clear");
  assert.deepEqual(single.presentation.publications[0].selections, [0, null]);

  const adversarialCity = buildCity([
    { canonicalPath: "paths/<script>&.js", S: 0, U: 0, M: 0 },
    { canonicalPath: "paths/A.js", S: 0, U: 0, M: 0 },
    { canonicalPath: "paths/a.js", S: 0, U: 0, M: 0 },
    { canonicalPath: "paths/bidi-\u202E-token.js", S: 0, U: 0, M: 0 },
    { canonicalPath: "paths/café.js", S: 0, U: 0, M: 0 },
    { canonicalPath: "paths/東京.js", S: 0, U: 0, M: 0 },
  ]);
  const adversarial = fixture();
  const sink = publish(adversarial, adversarialCity);
  for (const action of ["next", "previous", "first", "previous", "next", "last", "next", "clear", "previous"]) {
    sink.selectionAction(1, action);
  }
  const last = adversarialCity.inspection.length - 1;
  assert.deepEqual(adversarial.presentation.publications[0].selections, [0, 1, last, null, last]);
  assert.deepEqual(adversarial.presentation.publications[0].selections.map((index) => index === null ? null : adversarialCity.inspection[index].canonicalPath), [
    adversarialCity.inspection[0].canonicalPath,
    adversarialCity.inspection[1].canonicalPath,
    adversarialCity.inspection[last].canonicalPath,
    null,
    adversarialCity.inspection[last].canonicalPath,
  ]);

  const maximumCity = buildCity(Array.from({ length: 4_000 }, (_, index) => ({
    canonicalPath: `maximum/${String(index).padStart(4, "0")}.js`, S: 0, U: 0, M: 0,
  })));
  const maximum = fixture();
  const maximumSink = publish(maximum, maximumCity);
  maximumSink.selectionAction(1, "last");
  maximumSink.selectionAction(1, "next");
  maximumSink.selectionAction(1, "first");
  maximumSink.selectionAction(1, "previous");
  assert.deepEqual(maximum.presentation.publications[0].selections, [3_999, 0]);
});

test("semantic selection failure after a valid city revokes the session exactly once as M1-PRES-1", () => {
  const f = fixture({ selectionThrows: true });
  f.controller.submit(VALID);
  const transport = f.transports[0];
  transport.handlers.message({ type: "REVISION_SELECTED", generation: 1, revision: SHA });
  transport.handlers.message({ type: "PROVIDER_DRAINED_STATIC_ENTERED", generation: 1 });
  transport.handlers.message({ type: "SUCCESS", generation: 1, revision: SHA, city: CITY });
  const sink = f.presentation.eventSinks[0];
  sink.selectionAction(1, "first");
  sink.selectionAction(1, "clear");
  assert.deepEqual(f.failures, [{ category: "Presentation failed", code: "M1-PRES-1", revision: SHA }]);
  assert.equal(f.presentation.clears, 1);
  assert.equal(f.presentation.hooks.isEligible(1), false);
  assert.equal(f.events.filter((event) => event === "semantic:selection").length, 1);
});

test("persistent semantic clear failure revokes M1-PRES-1 without leaving an attached inspector or stale path", () => {
  const operations = [];
  class FaultingElement {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      this.dataset = {};
      this.attributes = new Map();
      this.children = [];
      this.parent = undefined;
      this.value = "";
      this.failText = false;
      this.hiddenValue = false;
    }
    set hidden(value) {
      operations.push(`${this.tagName}:hidden:${String(value)}`);
      this.hiddenValue = Boolean(value);
    }
    get hidden() { return this.hiddenValue; }
    set textContent(value) {
      operations.push(`${this.tagName}:text:${String(value)}`);
      if (this.failText) throw new Error("persistent textContent failure");
      this.value = String(value);
      this.children = [];
    }
    get textContent() {
      return this.children.length ? this.children.map((child) => child.textContent ?? "").join("") : this.value;
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    append(child) { child.parent = this; this.children.push(child); }
    replaceChildren(...children) {
      for (const child of this.children) if (child && typeof child === "object") child.parent = undefined;
      this.children = children;
      for (const child of children) if (child && typeof child === "object") child.parent = this;
    }
    remove() {
      operations.push(`${this.tagName}:remove`);
      if (!this.parent) return;
      this.parent.children = this.parent.children.filter((child) => child !== this);
      this.parent = undefined;
    }
  }

  const root = new FaultingElement("main");
  const revision = new FaultingElement("output");
  const created = [];
  const documentTarget = {
    createElement(tagName) {
      const element = new FaultingElement(tagName);
      created.push(element);
      return element;
    },
  };
  const f = fixture({
    publicationFactory: (selectedRevision, inspection) => stageSemanticPublication(
      documentTarget,
      root,
      revision,
      selectedRevision,
      inspection,
    ),
  });
  f.controller.submit(VALID);
  const transport = f.transports[0];
  transport.handlers.message({ type: "REVISION_SELECTED", generation: 1, revision: SHA });
  transport.handlers.message({ type: "PROVIDER_DRAINED_STATIC_ENTERED", generation: 1 });
  transport.handlers.message({ type: "SUCCESS", generation: 1, revision: SHA, city: CITY });

  const [inspector, path] = created;
  const sink = f.presentation.eventSinks[0];
  sink.selectionAction(1, "first");
  assert.equal(inspector.hidden, false);
  assert.equal(path.textContent, CITY.inspection[0].canonicalPath);
  assert.equal(inspector.parent, root);

  path.failText = true;
  operations.length = 0;
  sink.selectionAction(1, "clear");

  assert.deepEqual(f.failures, [{ category: "Presentation failed", code: "M1-PRES-1", revision: SHA }]);
  assert.equal(f.presentation.hooks.isEligible(1), false);
  assert.equal(inspector.hidden, true);
  assert.equal(inspector.parent, undefined);
  assert.equal(root.children.includes(inspector), false);
  assert.equal(path.textContent, CITY.inspection[0].canonicalPath);
  assert.equal(revision.textContent, "");
  assert.deepEqual(operations, [
    "BDI:text:",
    "SECTION:hidden:true",
    "SECTION:remove",
    "BDI:text:",
    "OUTPUT:text:",
  ]);
});

test("invalid replacement revokes output, closes active work, and starts no replacement", () => {
  const f = fixture();
  f.controller.submit(VALID);
  assert.equal(f.controller.submit("owner/repo"), false);
  assert.equal(f.transports.length, 1);
  assert.deepEqual(f.transports[0].sent.map((message) => message.type), ["START", "STOP"]);
  assert.equal(f.transports[0].closeCalls, 0);
  assert.equal(f.events.at(-1), "view:Invalid input");
  f.transports[0].handlers.message({ type: "ATTEMPT_DRAINED", generation: 1 });
  assert.equal(f.transports[0].closeCalls, 1);
  assert.equal(f.transports.length, 1);
  assert.equal(f.events.at(-1), "worker:close");
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
  old.handlers.message({ type: "REVISION_SELECTED", generation: 1, revision: SHA });
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
  old.handlers.message({ type: "REVISION_SELECTED", generation: 1, revision: SHA });
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
  transport.handlers.message({ type: "REVISION_SELECTED", generation: 1, revision: SHA });
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
  transport.handlers.message({ type: "REVISION_SELECTED", generation: 1, revision: SHA });
  const barrier = { type: "PROVIDER_DRAINED_STATIC_ENTERED", generation: 1 };
  transport.handlers.message(barrier);
  transport.handlers.message(barrier);
  assert.equal(transport.closeCalls, 1);
  assert.equal(f.events.filter((event) => event === "view:Provider/resolution failure").length, 1);
});

test("repeated cancellation is idempotent while provider cleanup drains", () => {
  const f = fixture();
  f.controller.submit(VALID);
  f.cancel();
  f.cancel();
  assert.deepEqual(f.transports[0].sent.map(({ type }) => type), ["START", "STOP"]);
  assert.equal(f.events.filter((event) => event === "view:Cancelled").length, 1);
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
  transport.handlers.message(Object.assign(Object.create({ hostile: true }), { type: "FAILURE", generation: 999, category: "Revision unavailable" }));
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

test("crash after revision selection fails immediately and retains the selected revision", () => {
  const f = fixture();
  f.controller.submit(VALID);
  const transport = f.transports[0];
  transport.handlers.message({ type: "REVISION_SELECTED", generation: 1, revision: SHA });
  transport.handlers.crash();
  assert.deepEqual(f.failures, [{ category: "Provider/resolution failure", code: undefined, revision: SHA }]);
  assert.equal(transport.closeCalls, 1);
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

test("a failed cancellation STOP send cleans immediately without replacing cancellation", () => {
  const f = fixture({ sendThrowsWhen: (_transport, command) => command.type === "STOP" });
  f.controller.submit(VALID);
  f.cancel();
  assert.equal(f.transports[0].detachCalls, 1);
  assert.equal(f.transports[0].closeCalls, 1);
  assert.equal(f.events.filter((event) => event === "view:Cancelled").length, 1);
  assert.equal(f.failures.length, 0);
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
  old.handlers.message({ type: "REVISION_SELECTED", generation: 1, revision: SHA });
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

test("replacement remains visibly working while provider drain waits and its displayed Cancel clears pending work", () => {
  const f = fixture();
  f.controller.submit(VALID);
  const old = f.transports[0];
  f.controller.submit("https://github.com/owner/pending");

  assert.equal(f.visibleState(), "working-with-cancel");
  assert.deepEqual(old.sent.map((message) => message.type), ["START", "STOP"]);
  assert.equal(old.closeCalls, 0, "the replacement remains cancellable while provider drain is pending");
  f.clickVisibleCancel();
  assert.equal(f.visibleState(), "cancelled");

  old.handlers.message({ type: "FAILURE", generation: 1, category: "Revision unavailable" });
  old.handlers.message({ type: "ATTEMPT_DRAINED", generation: 1 });

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
  assert.equal(f.events.filter((event) => event === "view:Cancelled").length, 2);
});

test("every post-selection failure row retains the selected full revision", () => {
  const rows = [
    ["Provider/resolution failure"],
    ["Repository exceeds Code City limits"],
    ["No supported modules", "ADM-06"],
    ["No supported modules", "ADM-07"],
    ["Source admission failed", "M1-ADM-1"],
    ["Source admission failed", "M1-ADM-3"],
    ["Source admission failed", "M1-ADM-4"],
    ["Metric processing failed", "M1-MET-1"],
    ["City construction failed", "M1-CITY-1"],
  ];
  for (const [category, code] of rows) {
    const f = fixture();
    f.controller.submit(VALID);
    const transport = f.transports[0];
    transport.handlers.message({ type: "REVISION_SELECTED", generation: 1, revision: SHA });
    transport.handlers.message({ type: "FAILURE", generation: 1, revision: SHA, category, ...(code ? { code } : {}) });
    assert.deepEqual(f.failures, [{ category, code, revision: SHA }], category);
    assert.equal(transport.closeCalls, 0, category);
    transport.handlers.message({ type: "ATTEMPT_DRAINED", generation: 1 });
    assert.equal(transport.closeCalls, 1, category);
  }
});

test("pre-selection failures show no revision and exact selected revision mismatches fail closed with the retained selection", () => {
  for (const category of ["Repository unavailable for anonymous access", "Revision unavailable", "Provider/resolution failure"]) {
    const f = fixture();
    f.controller.submit(VALID);
    const transport = f.transports[0];
    transport.handlers.message({ type: "FAILURE", generation: 1, category });
    assert.deepEqual(f.failures, [{ category, code: undefined, revision: undefined }]);
    transport.handlers.message({ type: "ATTEMPT_DRAINED", generation: 1 });
  }

  const f = fixture();
  f.controller.submit(VALID);
  const transport = f.transports[0];
  transport.handlers.message({ type: "REVISION_SELECTED", generation: 1, revision: SHA });
  transport.handlers.message({ type: "FAILURE", generation: 1, revision: "b".repeat(40), category: "Provider/resolution failure" });
  assert.deepEqual(f.failures, [{ category: "Provider/resolution failure", code: undefined, revision: SHA }]);
  assert.equal(transport.closeCalls, 1);
});

test("out-of-order and early-drain messages fail immediately with revision only after validated selection", () => {
  const cases = [
    { messages: [{ type: "ATTEMPT_DRAINED", generation: 1 }], revision: undefined },
    { messages: [{ type: "PROVIDER_DRAINED_STATIC_ENTERED", generation: 1 }], revision: undefined },
    { messages: [{ type: "SUCCESS", generation: 1, revision: SHA, city: CITY }], revision: undefined },
    { messages: [
      { type: "REVISION_SELECTED", generation: 1, revision: SHA },
      { type: "ATTEMPT_DRAINED", generation: 1 },
    ], revision: SHA },
    { messages: [
      { type: "REVISION_SELECTED", generation: 1, revision: SHA },
      { type: "REVISION_SELECTED", generation: 1, revision: SHA },
    ], revision: SHA },
  ];
  for (const item of cases) {
    const f = fixture();
    f.controller.submit(VALID);
    for (const message of item.messages) f.transports[0].handlers.message(message);
    assert.deepEqual(f.failures, [{ category: "Provider/resolution failure", code: undefined, revision: item.revision }]);
    assert.equal(f.transports[0].detachCalls, 1);
    assert.equal(f.transports[0].closeCalls, 1);
  }
});

test("a latched failure is immutable and any intervening current message forces cleanup", () => {
  const f = fixture();
  f.controller.submit(VALID);
  const transport = f.transports[0];
  transport.handlers.message({ type: "REVISION_SELECTED", generation: 1, revision: SHA });
  transport.handlers.message({ type: "FAILURE", generation: 1, revision: SHA, category: "Source admission failed", code: "M1-ADM-4" });
  transport.handlers.message({ type: "FAILURE", generation: 1, revision: SHA, category: "Provider/resolution failure" });
  assert.deepEqual(f.failures, [{ category: "Source admission failed", code: "M1-ADM-4", revision: SHA }]);
  assert.equal(transport.closeCalls, 1);
  transport.handlers.message({ type: "ATTEMPT_DRAINED", generation: 1 });
  assert.equal(transport.closeCalls, 1);
});

test("controller disposal is terminal, idempotent, clears pending work, and makes retained callbacks inert", () => {
  const f = fixture();
  f.controller.submit(VALID);
  const transport = f.transports[0];
  f.controller.submit("https://github.com/owner/pending");
  f.controller.dispose();
  f.controller.dispose();
  assert.equal(f.presentation.disposes, 1);
  assert.equal(transport.detachCalls, 1);
  assert.equal(transport.closeCalls, 1);
  assert.equal(f.transports.length, 1);
  assert.equal(f.events.includes("view:Cancelled"), false);
  transport.handlers.crash();
  transport.handlers.message({ type: "ATTEMPT_DRAINED", generation: 1 });
  f.presentation.hooks.failed(1, "Presentation failed", "M1-PRES-1");
  assert.equal(f.failures.length, 0);
  assert.equal(f.controller.submit(VALID), false);
  assert.equal(f.transports.length, 1);
});

test("partial browser-worker listener setup rolls back attached listeners before terminating once", async () => {
  const shellElement = {
    addEventListener() {},
    replaceChildren() {},
    textContent: "",
  };
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.document = {
    querySelector: () => shellElement,
    createElement: () => ({ addEventListener() {}, setAttribute() {}, textContent: "", type: "" }),
  };
  globalThis.window = { addEventListener() {} };

  const server = await createViteServer({
    configFile: "vite.config.mjs",
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  });
  try {
    const { createWorkerTransport } = await server.ssrLoadModule("/src/edge/main.ts");
    const additions = [];
    const removals = [];
    const attached = new Map();
    let terminations = 0;
    const worker = {
      addEventListener(type, listener) {
        additions.push(type);
        if (type === "messageerror") throw new Error("partial listener setup");
        attached.set(type, listener);
      },
      removeEventListener(type, listener) {
        assert.equal(attached.get(type), listener);
        attached.delete(type);
        removals.push(type);
      },
      postMessage() {},
      terminate() { terminations += 1; },
    };
    const transport = createWorkerTransport(worker);
    const controller = createMainController(
      () => transport,
      { clear() {}, invalid() {}, working() {}, success() {}, failure() {}, cancelled() {} },
      () => ({ clear() {}, dispose() {}, present: () => ({ kind: "committed" }) }),
    );

    assert.equal(controller.submit(VALID), false);
    assert.deepEqual(additions, ["message", "error", "messageerror"]);
    assert.deepEqual(removals, ["message", "error"]);
    assert.equal(attached.size, 0);
    assert.equal(terminations, 1);
    controller.dispose();
    assert.equal(terminations, 1);
  } finally {
    await server.close();
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
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
