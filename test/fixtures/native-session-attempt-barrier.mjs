import { randomBytes } from "node:crypto";

const controls = [];
let plans = [];

function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}

export function resetNativeSessionAttemptBarrier(nextPlans = []) {
  controls.length = 0;
  plans = [...nextPlans];
}

export function nativeSessionAttempts() {
  return controls;
}

export function startNodeWorkerAttempt(options) {
  const plan = plans.shift() ?? {};
  if (plan.throwStart === true) throw new Error("test-only start failure");
  const attemptId = randomBytes(16).toString("base64url");
  const terminal = deferred();
  const joined = deferred();
  let released = false;
  let completed = false;
  let cancelled = false;
  const release = () => {
    if (released) return;
    released = true;
    options.release?.();
  };
  const complete = (value) => {
    if (completed) return;
    completed = true;
    release();
    terminal.resolve(value);
    joined.resolve();
  };
  const control = {
    attemptId,
    generation: options.generation,
    options,
    select(revision = "a".repeat(40)) { options.onRevisionSelected?.(revision); },
    progress({ revision = "a".repeat(40), stage, completed, total }) {
      options.onProgress?.({
        type: "PROGRESS",
        attemptId,
        generation: options.generation,
        revision,
        stage,
        ...(completed === undefined ? {} : { completed, total }),
      });
    },
    complete,
    failure(value = {}) {
      complete({ type: "FAILURE", attemptId, generation: options.generation, category: "Provider/resolution failure", ...value });
    },
    success({ revision = "a".repeat(40), city = null, notAnalyzedFiles = [{ canonicalPath: "a.ts", category: "Syntax could not be analyzed" }], sources = [{ canonicalPath: "a.ts", normalizedUtf8: new Uint8Array([120]) }] } = {}) {
      complete({
        type: "SUCCESS", attemptId, generation: options.generation, revision,
        result: { city, notAnalyzedFiles }, sources,
      });
    },
    allowCancelJoin() { if (cancelled) complete({ type: "CANCELLED" }); },
    get cancelled() { return cancelled; },
    get completed() { return completed; },
  };
  if (plan.progressOnStart) options.onProgress?.({
    type: "PROGRESS",
    attemptId,
    generation: options.generation,
    revision: "a".repeat(40),
    stage: "acquisition",
    completed: 0,
    total: 1,
  });
  controls.push(control);
  if (typeof plan.onStart === "function") queueMicrotask(() => plan.onStart(control));
  return {
    attemptId,
    generation: options.generation,
    result: terminal.promise,
    async cancel() {
      cancelled = true;
      if (plan.holdCancel !== true) complete({ type: "CANCELLED" });
      await joined.promise;
    },
  };
}
