import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(/^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context);
  },
});

const projectRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const literals = JSON.parse(await readFile(path.join(projectRoot, "test/fixtures/presentation/literals.json"), "utf8"));
const { buildCity, deriveView } = await import("../src/domain/city-model.ts");
const { createCityPresenter } = await import("../src/edge/city-presenter.ts");

const GL_CONSTANTS = {
  NO_ERROR: 0, VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
  ARRAY_BUFFER: 5, ELEMENT_ARRAY_BUFFER: 6, STATIC_DRAW: 7, FLOAT: 8, UNSIGNED_BYTE: 9,
  DEPTH_TEST: 10, LESS: 11, CULL_FACE: 12, BACK: 13, CCW: 14, BLEND: 15, DITHER: 16,
  STENCIL_TEST: 17, SCISSOR_TEST: 18, POLYGON_OFFSET_FILL: 19, RASTERIZER_DISCARD: 20,
  SAMPLE_COVERAGE: 21, SAMPLE_ALPHA_TO_COVERAGE: 22, COLOR_BUFFER_BIT: 0x4000,
  DEPTH_BUFFER_BIT: 0x0100, TRIANGLES: 23,
};

class FakeGl {
  constructor(canvas, options = {}) {
    Object.assign(this, GL_CONSTANTS);
    this.canvas = canvas;
    this.options = options;
    this.calls = [];
    this.uploads = [];
    this.nextResource = 0;
    this.lost = false;
  }
  get drawingBufferWidth() { return this.options.drawingBufferMismatch ? this.canvas.width + 1 : this.canvas.width; }
  get drawingBufferHeight() { return this.canvas.height; }
  call(name, args = [], result) {
    this.calls.push([name, ...args]);
    if (this.options.throwMethod === name) throw new Error(`injected ${name}`);
    return result;
  }
  resource(kind) { return this.call(`create${kind}`, [], this.options.nullResource === kind ? null : { kind, id: ++this.nextResource }); }
  getContextAttributes() { return this.call("getContextAttributes", [], Object.hasOwn(this.options, "attributes") ? this.options.attributes : { alpha: false, antialias: false, depth: true, premultipliedAlpha: false, preserveDrawingBuffer: false, stencil: false }); }
  getError() { return this.call("getError", [], this.options.glError ? 0x0502 : this.NO_ERROR); }
  isContextLost() { return this.call("isContextLost", [], this.lost); }
  createShader(type) { return this.call("createShader", [type], this.options.nullResource === "Shader" ? null : { kind: "Shader", type, id: ++this.nextResource }); }
  shaderSource(...args) { this.call("shaderSource", args); }
  compileShader(...args) { this.call("compileShader", args); }
  getShaderParameter(...args) { return this.call("getShaderParameter", args, this.options.compileStatus !== false); }
  deleteShader(...args) { this.call("deleteShader", args); }
  createProgram() { return this.resource("Program"); }
  attachShader(...args) { this.call("attachShader", args); }
  linkProgram(...args) { this.call("linkProgram", args); }
  getProgramParameter(...args) { return this.call("getProgramParameter", args, this.options.linkStatus !== false); }
  getUniformLocation(...args) { return this.call("getUniformLocation", args, this.options.nullUniform ? null : { kind: "Uniform", id: ++this.nextResource }); }
  useProgram(...args) { this.call("useProgram", args); }
  uniformMatrix4fv(...args) { this.call("uniformMatrix4fv", [args[0], args[1], new Float32Array(args[2])]); }
  deleteProgram(...args) { this.call("deleteProgram", args); }
  createVertexArray() { return this.resource("VertexArray"); }
  bindVertexArray(...args) { this.call("bindVertexArray", args); }
  deleteVertexArray(...args) { this.call("deleteVertexArray", args); }
  createBuffer() { return this.resource("Buffer"); }
  bindBuffer(...args) { this.call("bindBuffer", args); }
  bufferData(target, data, usage) { const copy = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice(); this.uploads.push({ target, byteLength: data.byteLength, bytes: copy }); this.call("bufferData", [target, data.byteLength, usage]); }
  deleteBuffer(...args) { this.call("deleteBuffer", args); }
  enableVertexAttribArray(...args) { this.call("enableVertexAttribArray", args); }
  vertexAttribPointer(...args) { this.call("vertexAttribPointer", args); }
  vertexAttribDivisor(...args) { this.call("vertexAttribDivisor", args); }
  enable(...args) { this.call("enable", args); }
  disable(...args) { this.call("disable", args); }
  colorMask(...args) { this.call("colorMask", args); }
  depthMask(...args) { this.call("depthMask", args); }
  depthFunc(...args) { this.call("depthFunc", args); }
  cullFace(...args) { this.call("cullFace", args); }
  frontFace(...args) { this.call("frontFace", args); }
  viewport(...args) { this.call("viewport", args); }
  clearColor(...args) { this.call("clearColor", args); }
  clearDepth(...args) { this.call("clearDepth", args); }
  clear(...args) { this.call("clear", args); }
  drawElementsInstanced(...args) { this.call("drawElementsInstanced", args); }
}

class FakeCanvas {
  constructor(host, glOptions) { this.host = host; this.width = 0; this.height = 0; this.listeners = new Set(); this.removeCount = 0; this.gl = new FakeGl(this, glOptions); }
  getContext(kind, attributes) { this.contextRequest = { kind, attributes }; return this.gl.options.noContext ? null : this.gl; }
  addEventListener(type, listener, options) { assert.equal(type, "webglcontextlost"); this.listenerOptions = options; this.listeners.add(listener); }
  removeEventListener(type, listener) { assert.equal(type, "webglcontextlost"); this.listeners.delete(listener); }
  remove() { this.removeCount += 1; if (this.host.child === this) this.host.child = undefined; }
  dispatchLoss(event = new Event("webglcontextlost", { cancelable: true })) { for (const listener of [...this.listeners]) { listener(event); if (this.listenerOptions?.once) this.listeners.delete(listener); } return event; }
}

class FakeHost {
  constructor(width = 200, height = 100) { this.width = width; this.height = height; this.child = undefined; this.replacements = 0; }
  get clientWidth() { return this.width; }
  get clientHeight() { return this.height; }
  replaceChildren(node) { if (this.throwReplace) throw new Error("replace failed"); this.child = node; this.replacements += 1; }
}

function fakeEnvironment({ width = 200, height = 100, gl = {}, platform = {} } = {}) {
  const host = new FakeHost(width, height);
  const canvases = [];
  const observers = [];
  const environment = {
    host, canvases, observers,
    platform: {
      createCanvas() { if (platform.throwCanvas) throw new Error("canvas failed"); const canvas = new FakeCanvas(host, gl); canvases.push(canvas); return canvas; },
      createResizeObserver(callback) {
        if (platform.throwObserver) throw new Error("observer failed");
        const observer = { callback, observed: false, disconnected: 0, observe(target) { if (platform.throwObserve) throw new Error("observe failed"); assert.equal(target, host); this.observed = true; }, disconnect() { this.disconnected += 1; } };
        observers.push(observer); return observer;
      },
    },
  };
  return environment;
}

function oneBuilding() { return buildCity([{ canonicalPath: "a.js", S: 0, U: 0, M: 0 }]).model; }
function failuresCollector(environment, eligibility = () => true) {
  const failures = [];
  const presenter = createCityPresenter({ host: environment.host, platform: environment.platform, isEligible: eligibility, failed(...args) { failures.push(args); } });
  return { presenter, failures };
}
function names(gl) { return gl.calls.map((call) => call[0]); }

function transform(matrix, point) {
  return [
    matrix[0] * point[0] + matrix[4] * point[1] + matrix[8] * point[2],
    matrix[1] * point[0] + matrix[5] * point[1] + matrix[9] * point[2],
    matrix[2] * point[0] + matrix[6] * point[1] + matrix[10] * point[2],
    1,
  ];
}

test("cube, indices, shaders, context request, matrix handedness, transpose, and depth are literal", () => {
  const environment = fakeEnvironment();
  const { presenter } = failuresCollector(environment);
  assert.equal(presenter.present(1, oneBuilding()), "committed");
  const canvas = environment.canvases[0];
  assert.deepEqual([...new Float32Array(canvas.gl.uploads[0].bytes.buffer)], literals.cubePositions);
  assert.equal(canvas.gl.uploads[0].byteLength, 96);
  assert.deepEqual([...canvas.gl.uploads[1].bytes], literals.cubeIndices);
  assert.equal(canvas.gl.uploads[1].byteLength, 36);
  const shaderSources = canvas.gl.calls.filter((call) => call[0] === "shaderSource").map((call) => call[2]);
  assert.deepEqual(shaderSources, [literals.vertexShader, literals.fragmentShader]);
  assert(shaderSources.every((source) => source.charCodeAt(source.length - 1) === 10));
  assert.equal(canvas.contextRequest.kind, "webgl2");
  assert.deepEqual(canvas.contextRequest.attributes, { alpha: false, antialias: false, depth: true, desynchronized: false, failIfMajorPerformanceCaveat: false, powerPreference: "default", premultipliedAlpha: false, preserveDrawingBuffer: false, stencil: false, xrCompatible: false });
  assert.deepEqual([...canvas.gl.calls.find((call) => call[0] === "uniformMatrix4fv")[3]], literals.unitAspectTwoMatrix);
  const matrix = literals.unitAspectTwoMatrix;
  assert.deepEqual(transform(matrix, [0, 0, 0]).map((value) => value === 0 ? 0 : value), [0, 0, 0, 1]);
  const rightCorner = transform(matrix, [0.5, -0.5, -0.5]);
  const leftCorner = transform(matrix, [-0.5, -0.5, 0.5]);
  assert(rightCorner[0] > 0 && leftCorner[0] < 0, "literal column-major right vector lost handedness");
  const corners = [];
  for (const z of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) for (const x of [-0.5, 0.5]) corners.push(transform(matrix, [x, y, z]).map((value) => value === 0 ? 0 : value));
  assert.deepEqual(corners, literals.unitTargetRelativeCorners);
  assert.equal(corners[0][2], 0.5000000149011612);
  assert.equal(corners[7][2], -0.5000000149011612);
  const view = deriveView(oneBuilding().bounds, 2);
  const expectedScalars = { target: [0.5, 0.5, 0.5], D: [0.5773502691896258, 0.5773502691896258, 0.5773502691896258], R: [0.7071067811865475, 0, -0.7071067811865475], V: [-0.4082482904638631, 0.8164965809277261, -0.4082482904638631], H: 0.8981462390204988, E_d: 0.8660254037844387, near: 0.8660254037844387, far: 4.330127018922194 };
  for (const key of ["H", "E_d", "near", "far"]) assert(Math.abs(view[key] - expectedScalars[key]) <= 1e-9 * Math.max(1, Math.abs(expectedScalars[key])));
  for (const key of ["target", "D", "R", "V"]) for (let index = 0; index < 3; index += 1) assert(Math.abs(view[key][index] - expectedScalars[key][index]) <= 1e-9 * Math.max(1, Math.abs(expectedScalars[key][index])));
});

test("one instance uses exact target-relative float staging, state, and one instanced draw", () => {
  const environment = fakeEnvironment();
  const { presenter } = failuresCollector(environment);
  assert.equal(presenter.present("g", oneBuilding()), "committed");
  const gl = environment.canvases[0].gl;
  assert.deepEqual(gl.uploads.map(({ byteLength }) => byteLength), [96, 36, 28]);
  const instance = gl.uploads[2].bytes;
  const view = new DataView(instance.buffer, instance.byteOffset, instance.byteLength);
  assert.deepEqual(Array.from({ length: 6 }, (_, index) => view.getFloat32(index * 4, true)), [-0.5, -0.5, -0.5, 1, 1, 1]);
  assert.deepEqual([...instance.slice(24)], [0x44, 0x01, 0x54, 0xff]);
  const pointers = gl.calls.filter((call) => call[0] === "vertexAttribPointer").map((call) => call.slice(1));
  assert.deepEqual(pointers, [[0, 3, gl.FLOAT, false, 0, 0], [1, 3, gl.FLOAT, false, 28, 0], [2, 3, gl.FLOAT, false, 28, 12], [3, 4, gl.UNSIGNED_BYTE, true, 28, 24]]);
  assert.deepEqual(gl.calls.filter((call) => call[0] === "vertexAttribDivisor").map((call) => call.slice(1)), [[1, 1], [2, 1], [3, 1]]);
  assert.deepEqual(gl.calls.filter((call) => call[0] === "drawElementsInstanced").map((call) => call.slice(1)), [[gl.TRIANGLES, 36, gl.UNSIGNED_BYTE, 0, 1]]);
  assert.deepEqual(gl.calls.find((call) => call[0] === "clear").slice(1), [gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT]);
  for (const disabled of [gl.BLEND, gl.DITHER, gl.STENCIL_TEST, gl.SCISSOR_TEST, gl.POLYGON_OFFSET_FILL, gl.RASTERIZER_DISCARD, gl.SAMPLE_COVERAGE, gl.SAMPLE_ALPHA_TO_COVERAGE]) assert(gl.calls.some((call) => call[0] === "disable" && call[1] === disabled));
  assert.deepEqual(environment.canvases[0].listenerOptions, { passive: true, once: true });
  assert.equal(environment.observers[0].observed, true);
});

test("generation is opaque, stale work is inert, replacement is atomic, and dispose is idempotent", () => {
  const environment = fakeEnvironment();
  const raw = {};
  const generation = new Proxy(raw, { get() { throw new Error("generation was read"); }, ownKeys() { throw new Error("generation was inspected"); } });
  let eligible = true;
  const seen = [];
  const { presenter, failures } = failuresCollector(environment, (value) => { seen.push(value); return eligible; });
  assert.equal(presenter.present(generation, oneBuilding()), "committed");
  const first = environment.canvases[0];
  eligible = false;
  assert.equal(presenter.present(generation, oneBuilding()), "stale");
  assert.equal(environment.canvases.length, 1);
  assert.equal(environment.host.child, first);
  eligible = true;
  assert.equal(presenter.present(generation, oneBuilding()), "committed");
  assert.equal(first.removeCount, 1);
  assert.equal(environment.host.child, environment.canvases[1]);
  presenter.dispose(); presenter.dispose();
  assert.equal(environment.canvases[1].removeCount, 1);
  assert.deepEqual(failures, []);
  assert(seen.every((value) => value === generation));
});

test("source-free presentation data has only the model contract and is structured-clone compatible", () => {
  const model = oneBuilding();
  assert.deepEqual(Object.keys(model), ["kind", "count", "origins", "sizes", "rgba", "bounds"]);
  assert.equal(JSON.stringify(model).includes("a.js"), false);
  const cloned = structuredClone(model);
  assert.deepEqual([...cloned.origins], [...model.origins]);
  assert.deepEqual([...cloned.sizes], [...model.sizes]);
  assert.deepEqual([...cloned.rgba], [...model.rgba]);
  assert.deepEqual([...cloned.bounds], [...model.bounds]);
});

test("the complete 4,000-building model uploads exactly 112,000 bytes and draws once", () => {
  const facts = Array.from({ length: 4000 }, (_, index) => ({ canonicalPath: `m/${String(index).padStart(4, "0")}.js`, S: index % 7, U: index % 5, M: index % 17 }));
  const model = buildCity(facts).model;
  const environment = fakeEnvironment({ width: 640, height: 480 });
  const { presenter } = failuresCollector(environment);
  assert.equal(presenter.present(4000, model), "committed");
  const gl = environment.canvases[0].gl;
  assert.deepEqual(gl.uploads.map(({ byteLength }) => byteLength), [96, 36, 112000]);
  assert.deepEqual(gl.calls.filter((call) => call[0] === "drawElementsInstanced").at(-1).slice(1), [gl.TRIANGLES, 36, gl.UNSIGNED_BYTE, 0, 4000]);
});

test("invalid model clears the prior session before one swallowed City failure and creates nothing new", () => {
  const environment = fakeEnvironment();
  const events = [];
  const presenter = createCityPresenter({ host: environment.host, platform: environment.platform, isEligible: () => true, failed(generation, category, code) { events.push([generation, category, code, environment.host.child]); throw new Error("contained"); } });
  assert.equal(presenter.present(1, oneBuilding()), "committed");
  const first = environment.canvases[0];
  assert.equal(presenter.present(2, {}), "failed");
  assert.equal(environment.canvases.length, 1);
  assert.equal(first.removeCount, 1);
  assert.deepEqual(events, [[2, "City construction failed", "M1-CITY-1", undefined]]);
});

test("final dimension reread redraws detached before commit and a changed resize redraws without upload", () => {
  const environment = fakeEnvironment({ width: 100, height: 100 });
  let widthReads = 0;
  Object.defineProperty(environment.host, "clientWidth", { configurable: true, get() { widthReads += 1; return widthReads === 1 ? 100 : 200; } });
  const { presenter } = failuresCollector(environment);
  assert.equal(presenter.present(1, oneBuilding()), "committed");
  const canvas = environment.canvases[0];
  assert.equal(canvas.gl.uploads.length, 3);
  assert.deepEqual(canvas.gl.calls.filter((call) => call[0] === "drawElementsInstanced").length, 2);
  assert.equal(canvas.width, 200);
  environment.host.width = 300;
  Object.defineProperty(environment.host, "clientWidth", { get() { return this.width; } });
  environment.observers[0].callback();
  assert.equal(canvas.gl.uploads.length, 3);
  assert.equal(canvas.gl.calls.filter((call) => call[0] === "drawElementsInstanced").length, 3);
  environment.observers[0].callback();
  assert.equal(canvas.gl.calls.filter((call) => call[0] === "drawElementsInstanced").length, 3);
});

test("context loss and resize failures clean exactly once before one contained presentation callback", () => {
  for (const stimulus of ["loss", "resize"]) {
    const environment = fakeEnvironment();
    const callbacks = [];
    const presenter = createCityPresenter({ host: environment.host, platform: environment.platform, isEligible: () => true, failed(...args) { callbacks.push([args, environment.host.child]); throw new Error("contained"); } });
    assert.equal(presenter.present(stimulus, oneBuilding()), "committed");
    const canvas = environment.canvases[0];
    const retained = stimulus === "loss" ? () => canvas.dispatchLoss() : environment.observers[0].callback;
    if (stimulus === "loss") {
      const event = retained();
      assert.equal(event.defaultPrevented, false);
    } else {
      environment.host.width = 0;
      retained();
    }
    assert.equal(environment.host.child, undefined);
    assert.equal(canvas.removeCount, 1);
    assert.equal(environment.observers[0].disconnected, 1);
    assert.equal(names(canvas.gl).filter((name) => name === "deleteProgram").length, 1);
    assert.equal(names(canvas.gl).filter((name) => name === "deleteBuffer").length, 3);
    assert.equal(names(canvas.gl).filter((name) => name === "deleteVertexArray").length, 1);
    assert.deepEqual(callbacks, [[[stimulus, "Presentation failed", "M1-PRES-1"], undefined]]);
    retained();
    assert.equal(callbacks.length, 1);
    assert.equal(canvas.removeCount, 1);
  }
});

test("ineligible retained callbacks perform only local idempotent cleanup", () => {
  const environment = fakeEnvironment();
  let eligible = true;
  const { presenter, failures } = failuresCollector(environment, () => eligible);
  assert.equal(presenter.present(1, oneBuilding()), "committed");
  eligible = false;
  const retained = environment.observers[0].callback;
  retained(); retained();
  assert.deepEqual(failures, []);
  assert.equal(environment.canvases[0].removeCount, 1);
});

test("closed failure stimuli fail synchronously after cleanup with no publication", () => {
  const cases = [
    ["context", { gl: { noContext: true } }],
    ["attributes", { gl: { attributes: null } }],
    ["compile", { gl: { compileStatus: false } }],
    ["link", { gl: { linkStatus: false } }],
    ["uniform", { gl: { nullUniform: true } }],
    ["shader allocation", { gl: { nullResource: "Shader" } }],
    ["program allocation", { gl: { nullResource: "Program" } }],
    ["vao allocation", { gl: { nullResource: "VertexArray" } }],
    ["buffer allocation", { gl: { nullResource: "Buffer" } }],
    ["upload throw", { gl: { throwMethod: "bufferData" } }],
    ["draw throw", { gl: { throwMethod: "drawElementsInstanced" } }],
    ["GL error", { gl: { glError: true } }],
    ["drawing buffer", { gl: { drawingBufferMismatch: true } }],
    ["canvas platform", { platform: { throwCanvas: true } }],
    ["observer platform", { platform: { throwObserver: true } }],
    ["observe platform", { platform: { throwObserve: true } }],
  ];
  for (const [id, setup] of cases) {
    const environment = fakeEnvironment(setup);
    const callbacks = [];
    const presenter = createCityPresenter({ host: environment.host, platform: environment.platform, isEligible: () => true, failed(...args) { callbacks.push([args, environment.host.child]); } });
    assert.equal(presenter.present(id, oneBuilding()), "failed", id);
    assert.equal(environment.host.child, undefined, id);
    assert.deepEqual(callbacks, [[[id, "Presentation failed", "M1-PRES-1"], undefined]], id);
    if (environment.canvases[0]) {
      const expectedDraws = ["draw throw", "observer platform", "observe platform"].includes(id) ? 1 : 0;
      assert.equal(environment.canvases[0].gl.calls.filter((call) => call[0] === "drawElementsInstanced").length, expectedDraws, id);
    }
  }
});

test("presentation failure clears both detached candidate and prior session before notification", () => {
  const environment = fakeEnvironment();
  const callbacks = [];
  const presenter = createCityPresenter({ host: environment.host, platform: environment.platform, isEligible: () => true, failed(...args) { callbacks.push([args, environment.host.child]); } });
  assert.equal(presenter.present(1, oneBuilding()), "committed");
  const first = environment.canvases[0];
  environment.canvases.length = 0;
  environment.platform.createCanvas = () => { const canvas = new FakeCanvas(environment.host, { compileStatus: false }); environment.canvases.push(canvas); return canvas; };
  assert.equal(presenter.present(2, oneBuilding()), "failed");
  assert.equal(first.removeCount, 1);
  assert.equal(environment.canvases[0].removeCount, 1);
  assert.deepEqual(callbacks, [[[2, "Presentation failed", "M1-PRES-1"], undefined]]);
});

test("cleanup contains release throws, attempts every resource, and skips driver deletes when actually lost", () => {
  {
    const environment = fakeEnvironment();
    const { presenter, failures } = failuresCollector(environment);
    assert.equal(presenter.present(1, oneBuilding()), "committed");
    const canvas = environment.canvases[0];
    canvas.gl.options.throwMethod = "deleteProgram";
    environment.observers[0].disconnect = function () { this.disconnected += 1; throw new Error("disconnect"); };
    canvas.removeEventListener = () => { throw new Error("listener removal"); };
    const remove = canvas.remove.bind(canvas);
    canvas.remove = () => { remove(); throw new Error("canvas removal"); };
    assert.doesNotThrow(() => presenter.dispose());
    assert.equal(names(canvas.gl).filter((name) => name === "deleteProgram").length, 1);
    assert.equal(names(canvas.gl).filter((name) => name === "deleteBuffer").length, 3);
    assert.equal(names(canvas.gl).filter((name) => name === "deleteVertexArray").length, 1);
    assert.equal(canvas.removeCount, 1);
    assert.deepEqual(failures, []);
  }
  {
    const environment = fakeEnvironment();
    const { presenter } = failuresCollector(environment);
    assert.equal(presenter.present(1, oneBuilding()), "committed");
    const canvas = environment.canvases[0];
    const deletesBefore = names(canvas.gl).filter((name) => name.startsWith("delete")).length;
    canvas.gl.lost = true;
    presenter.dispose();
    assert.equal(names(canvas.gl).filter((name) => name.startsWith("delete")).length, deletesBefore);
    assert.equal(canvas.removeCount, 1);
  }
});

test("dispose remains terminal but every later call still validates before presentation failure", () => {
  const environment = fakeEnvironment();
  const { presenter, failures } = failuresCollector(environment);
  presenter.dispose(); presenter.dispose();
  assert.equal(presenter.present(1, {}), "failed");
  assert.equal(presenter.present(2, oneBuilding()), "failed");
  assert.deepEqual(failures, [[1, "City construction failed", "M1-CITY-1"], [2, "Presentation failed", "M1-PRES-1"]]);
  assert.equal(environment.canvases.length, 0);
});

test("every used WebGL setup, state, upload, and draw method throw fails closed", () => {
  const methods = [
    "getContextAttributes", "getError", "isContextLost", "createShader", "shaderSource", "compileShader", "getShaderParameter",
    "createProgram", "attachShader", "linkProgram", "getProgramParameter", "getUniformLocation", "createVertexArray", "createBuffer",
    "bindVertexArray", "bindBuffer", "bufferData", "enableVertexAttribArray", "vertexAttribPointer", "vertexAttribDivisor",
    "clearColor", "clearDepth", "colorMask", "depthMask", "enable", "depthFunc", "cullFace", "frontFace", "disable", "viewport",
    "clear", "useProgram", "uniformMatrix4fv", "drawElementsInstanced",
  ];
  for (const method of methods) {
    const environment = fakeEnvironment({ gl: { throwMethod: method } });
    const { presenter, failures } = failuresCollector(environment);
    assert.equal(presenter.present(method, oneBuilding()), "failed", method);
    assert.equal(environment.host.child, undefined, method);
    assert.deepEqual(failures, [[method, "Presentation failed", "M1-PRES-1"]], method);
  }
});

test("eligibility and host/commit throws are fail-closed while final false is stale", () => {
  const model = oneBuilding();
  {
    const environment = fakeEnvironment();
    const { presenter, failures } = failuresCollector(environment, () => { throw new Error("gate"); });
    assert.equal(presenter.present(1, model), "failed");
    assert.deepEqual(failures, [[1, "Presentation failed", "M1-PRES-1"]]);
    assert.equal(environment.canvases.length, 0);
  }
  {
    const environment = fakeEnvironment({ width: 0 });
    const { presenter } = failuresCollector(environment);
    assert.equal(presenter.present(1, model), "failed");
    assert.equal(environment.canvases.length, 0);
  }
  {
    const environment = fakeEnvironment();
    environment.host.throwReplace = true;
    const { presenter } = failuresCollector(environment);
    assert.equal(presenter.present(1, model), "failed");
    assert.equal(environment.canvases[0].removeCount, 1);
  }
  {
    const environment = fakeEnvironment();
    let calls = 0;
    const { presenter, failures } = failuresCollector(environment, () => ++calls === 1);
    assert.equal(presenter.present(1, model), "stale");
    assert.equal(environment.host.child, undefined);
    assert.equal(environment.canvases[0].removeCount, 1);
    assert.deepEqual(failures, []);
  }
});
