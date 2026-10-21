import { randomUUID } from "node:crypto";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const GEOMETRY_KEYS = Object.freeze(["left", "top", "width", "height", "x", "y", "hit"]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

function hasExactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

function validScrollPosition(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validGeometry(value) {
  return hasExactKeys(value, GEOMETRY_KEYS)
    && [value.left, value.top, value.width, value.height, value.x, value.y].every(Number.isFinite)
    && value.width > 0
    && value.height > 0
    && value.x === value.left + value.width / 2
    && value.y === value.top + value.height / 2
    && value.hit === true;
}

function setupExpression({ bindingName, stateName, selector, token }) {
  return `(() => {
    const bindingName=${JSON.stringify(bindingName)};
    const stateName=${JSON.stringify(stateName)};
    const token=${JSON.stringify(token)};
    const deliver=(message)=>globalThis[bindingName](JSON.stringify(message));
    try {
      if (Object.prototype.hasOwnProperty.call(globalThis,stateName)) throw new Error("native scroll operation state already exists");
      const region=document.querySelector(${JSON.stringify(selector)});
      if (!(region instanceof HTMLElement)) throw new Error("native scroll region is unavailable");
      const rectangle=region.getBoundingClientRect();
      const x=rectangle.left+rectangle.width/2;
      const y=rectangle.top+rectangle.height/2;
      const target=document.elementFromPoint(x,y);
      if (!(target===region||region.contains(target))) throw new Error("native scroll region failed its center hit test");
      const geometry=()=>{const current=region.getBoundingClientRect();const currentX=current.left+current.width/2;const currentY=current.top+current.height/2;const currentTarget=document.elementFromPoint(currentX,currentY);return {left:current.left,top:current.top,width:current.width,height:current.height,x:currentX,y:currentY,hit:currentTarget===region||region.contains(currentTarget)};};
      const before=region.scrollTop;
      let phase="registered";
      let terminal=false;
      const fail=(error)=>{if(terminal)return;terminal=true;deliver({token,state:"error",message:error instanceof Error?error.message:"native scroll page listener failed"});};
      const onScroll=()=>{try{if(terminal||phase!=="registered")return;const after=region.scrollTop;if(after===before)return;phase="changed";deliver({token,state:"changed",before,after});}catch(error){fail(error);}};
      const onScrollEnd=()=>{try{if(terminal||phase!=="changed")return;terminal=true;deliver({token,state:"settled",before,after:region.scrollTop,geometry:geometry()});}catch(error){fail(error);}};
      const cleanup=()=>{region.removeEventListener("scroll",onScroll);region.removeEventListener("scrollend",onScrollEnd);};
      globalThis[stateName]={cleanup};
      region.addEventListener("scroll",onScroll);
      region.addEventListener("scrollend",onScrollEnd);
      deliver({token,state:"registered",before,geometry:geometry()});
      return true;
    } catch (error) {
      try { deliver({token,state:"error",message:error instanceof Error?error.message:"native scroll registration failed"}); } catch {}
      return false;
    }
  })()`;
}

function cleanupExpression({ bindingName, stateName }) {
  return `(() => {const state=globalThis[${JSON.stringify(stateName)}];if(state&&typeof state.cleanup==="function")state.cleanup();delete globalThis[${JSON.stringify(stateName)}];delete globalThis[${JSON.stringify(bindingName)}];return true;})()`;
}

/**
 * Register a page-side element-scroll barrier before dispatching one native wheel.
 * The caller supplies the already-established evidence deadline; command completion
 * is deliberately independent from the changed/scrollend protocol.
 */
export async function captureNativeScrollEvidence({
  cdp,
  sessionId,
  selector,
  deltaY,
  deadline,
  signal,
  token = randomUUID().replaceAll("-", ""),
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  invariant(cdp && cdp.listeners instanceof Set && typeof cdp.send === "function", "native scroll CDP client is invalid");
  invariant(typeof sessionId === "string" && sessionId.length > 0, "native scroll session is invalid");
  invariant(typeof selector === "string" && selector.length > 0, "native scroll selector is invalid");
  invariant(typeof deltaY === "number" && Number.isFinite(deltaY) && deltaY !== 0, "native scroll delta is invalid");
  invariant(typeof deadline === "number" && Number.isFinite(deadline), "native scroll deadline is invalid");
  invariant(TOKEN_PATTERN.test(token), "native scroll token is invalid");
  invariant(signal === undefined || (typeof signal.addEventListener === "function" && typeof signal.removeEventListener === "function"), "native scroll cancellation signal is invalid");

  const bindingName = `__codeCityNativeScroll_${token}`;
  const stateName = `${bindingName}State`;
  const registered = deferred();
  const settled = deferred();
  const failed = deferred();
  let phase = "awaiting-registered";
  let failure = null;
  let registration = null;
  let cleanupStarted = false;

  const fail = (error) => {
    if (failure) return;
    failure = error instanceof Error ? error : new Error(String(error));
    failed.reject(failure);
    registered.reject(failure);
    settled.reject(failure);
  };
  const protocolFailure = (detail) => fail(new Error(`Native scroll delivery protocol rejected: ${detail}`));
  const listener = (message) => {
    if (message?.method !== "Runtime.bindingCalled" || message.params?.name !== bindingName) return;
    if (message.sessionId !== sessionId) {
      protocolFailure("session mismatch");
      return;
    }
    let delivery;
    try {
      delivery = JSON.parse(message.params.payload);
    } catch {
      protocolFailure("malformed JSON");
      return;
    }
    if (delivery?.token !== token) {
      protocolFailure("token mismatch");
      return;
    }
    if (delivery.state === "error") {
      if (!hasExactKeys(delivery, ["token", "state", "message"]) || typeof delivery.message !== "string" || delivery.message.length === 0) {
        protocolFailure("malformed error");
      } else {
        fail(new Error(`Native scroll page error: ${delivery.message}`));
      }
      return;
    }
    if (delivery.state === "registered") {
      if (phase !== "awaiting-registered") {
        protocolFailure("duplicate or out-of-order registered state");
        return;
      }
      if (!hasExactKeys(delivery, ["token", "state", "before", "geometry"])
          || !validScrollPosition(delivery.before) || !validGeometry(delivery.geometry)) {
        protocolFailure("malformed registered state");
        return;
      }
      registration = delivery;
      phase = "awaiting-changed";
      registered.resolve(delivery);
      return;
    }
    if (delivery.state === "changed") {
      if (phase !== "awaiting-changed") {
        protocolFailure("duplicate or out-of-order changed state");
        return;
      }
      if (!hasExactKeys(delivery, ["token", "state", "before", "after"])
          || !validScrollPosition(delivery.before) || !validScrollPosition(delivery.after)
          || delivery.before !== registration.before || delivery.after === delivery.before) {
        protocolFailure("malformed changed state");
        return;
      }
      phase = "awaiting-settled";
      return;
    }
    if (delivery.state === "settled") {
      if (phase !== "awaiting-settled") {
        protocolFailure("duplicate or out-of-order settled state");
        return;
      }
      if (!hasExactKeys(delivery, ["token", "state", "before", "after", "geometry"])
          || !validScrollPosition(delivery.before) || !validScrollPosition(delivery.after)
          || delivery.before !== registration.before || delivery.after === delivery.before
          || !validGeometry(delivery.geometry)) {
        protocolFailure("malformed settled state");
        return;
      }
      phase = "settled";
      const result = Object.freeze({
        before: delivery.before,
        after: delivery.after,
        geometry: Object.freeze({ ...delivery.geometry }),
      });
      queueMicrotask(() => {
        if (!failure && phase === "settled") settled.resolve(result);
      });
      return;
    }
    protocolFailure("unknown state or message shape");
  };

  const abort = () => fail(new Error("Native scroll evidence was cancelled"));
  cdp.listeners.add(listener);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimer(() => fail(new Error("Native scroll evidence deadline expired")), Math.max(0, deadline - now()));

  const cleanup = async () => {
    if (cleanupStarted) return null;
    cleanupStarted = true;
    clearTimer(timer);
    signal?.removeEventListener("abort", abort);
    cdp.listeners.delete(listener);
    const errors = [];
    try {
      const response = await cdp.send("Runtime.evaluate", {
        expression: cleanupExpression({ bindingName, stateName }),
        returnByValue: true,
        awaitPromise: true,
      }, sessionId);
      if (response?.exceptionDetails || response?.result?.value !== true) errors.push(new Error("Native scroll page cleanup failed"));
    } catch (error) {
      errors.push(error);
    }
    try {
      await cdp.send("Runtime.removeBinding", { name: bindingName }, sessionId);
    } catch (error) {
      errors.push(error);
    }
    return errors.length === 0 ? null : new AggregateError(errors, "Native scroll cleanup failed");
  };

  const sendBeforeDeadline = (method, params) => Promise.race([
    cdp.send(method, params, sessionId),
    failed.promise,
  ]);
  let primaryError = null;
  try {
    if (failure) throw failure;
    await sendBeforeDeadline("Runtime.addBinding", { name: bindingName });
    const setup = await sendBeforeDeadline("Runtime.evaluate", {
      expression: setupExpression({ bindingName, stateName, selector, token }),
      returnByValue: true,
      awaitPromise: true,
    });
    if (setup?.exceptionDetails) throw new Error("Native scroll page promise failed");
    if (setup?.result?.value !== true) throw failure ?? new Error("Native scroll page registration failed");
    const ready = await registered.promise;
    if (failure) throw failure;
    await sendBeforeDeadline("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: ready.geometry.x,
      y: ready.geometry.y,
      deltaX: 0,
      deltaY,
    });
    return await settled.promise;
  } catch (error) {
    primaryError = error instanceof Error ? error : new Error(String(error));
    throw primaryError;
  } finally {
    const cleanupError = await cleanup();
    if (primaryError && cleanupError) {
      throw new AggregateError([primaryError, cleanupError], `${primaryError.message}; native scroll cleanup also failed`);
    }
    if (cleanupError) throw cleanupError;
  }
}
