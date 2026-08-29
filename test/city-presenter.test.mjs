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
const {
  orbitCameraByKeyboard,
  orbitCameraByPointer,
  panCameraByKeyboard,
  panCameraByPointer,
  resetCamera,
  resizeCamera,
  zoomCamera,
} = await import("../src/domain/camera-picking-policy.ts");
const { createCityPresenter } = await import("../src/edge/city-presenter.ts");

const COMMITTED = { kind: "committed" };
const APPLIED = { kind: "applied" };
const STALE = { kind: "stale" };
const PRESENTATION_FAILURE = { kind: "failure", category: "Presentation failed", code: "M1-PRES-1" };

const GL = Object.freeze({
  NO_ERROR: 0,
  TRIANGLES: 0x0004,
  DEPTH_BUFFER_BIT: 0x0100,
  LESS: 0x0201,
  BACK: 0x0405,
  CCW: 0x0901,
  DITHER: 0x0bd0,
  BLEND: 0x0be2,
  CULL_FACE: 0x0b44,
  DEPTH_TEST: 0x0b71,
  STENCIL_TEST: 0x0b90,
  SCISSOR_TEST: 0x0c11,
  UNSIGNED_BYTE: 0x1401,
  FLOAT: 0x1406,
  COLOR_BUFFER_BIT: 0x4000,
  POLYGON_OFFSET_FILL: 0x8037,
  SAMPLE_ALPHA_TO_COVERAGE: 0x809e,
  SAMPLE_COVERAGE: 0x80a0,
  ARRAY_BUFFER: 0x8892,
  ELEMENT_ARRAY_BUFFER: 0x8893,
  STATIC_DRAW: 0x88e4,
  FRAGMENT_SHADER: 0x8b30,
  VERTEX_SHADER: 0x8b31,
  COMPILE_STATUS: 0x8b81,
  LINK_STATUS: 0x8b82,
  RASTERIZER_DISCARD: 0x8c89,
});

const CLOSED_GL_METHODS = new Set([
  "attachShader", "bindBuffer", "bindVertexArray", "bufferData", "clear", "clearColor", "clearDepth", "colorMask",
  "compileShader", "createBuffer", "createProgram", "createShader", "createVertexArray", "cullFace", "deleteBuffer",
  "deleteProgram", "deleteShader", "deleteVertexArray", "depthFunc", "depthMask", "disable", "drawElementsInstanced",
  "enable", "enableVertexAttribArray", "frontFace", "getContextAttributes", "getError", "getProgramParameter",
  "getShaderParameter", "getUniformLocation", "isContextLost", "linkProgram", "shaderSource", "uniformMatrix4fv",
  "useProgram", "vertexAttribDivisor", "vertexAttribPointer", "viewport",
]);

class FakeGl {
  constructor(canvas, options = {}) {
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
  getError() { return this.call("getError", [], this.options.glError ? 0x0502 : GL.NO_ERROR); }
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
  bufferData(target, data, usage) { const copy = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice(); this.uploads.push({ target, byteLength: data.byteLength, bytes: copy }); this.call("bufferData", [target, copy, usage]); }
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

class FakeLifecycleTarget {
  constructor() { this.eventListeners = new Map(); this.adds = []; this.removes = []; }
  addEventListener(type, listener) { this.adds.push(type); const listeners = this.eventListeners.get(type) ?? new Set(); listeners.add(listener); this.eventListeners.set(type, listeners); }
  removeEventListener(type, listener) { this.removes.push(type); this.eventListeners.get(type)?.delete(listener); }
  dispatch(type, event = new Event(type)) { for (const listener of [...(this.eventListeners.get(type) ?? [])]) listener(event); return event; }
}

class FakeDocumentTarget extends FakeLifecycleTarget {
  constructor() { super(); this.visibilityState = "visible"; }
}

class FakeCanvas {
  constructor(host, glOptions) {
    this.host = host;
    this.width = 0;
    this.height = 0;
    this.listeners = new Set();
    this.eventListeners = new Map();
    this.attributes = new Map();
    this.tabIndex = -1;
    this.removeCount = 0;
    this.focusCount = 0;
    this.pointerCaptures = new Set();
    this.captureCalls = [];
    this.releaseCalls = [];
    this.contextDataReads = [];
    this.forbiddenContextReads = [];
    this.gl = new FakeGl(this, glOptions);
    this.context = new Proxy(this.gl, {
      get: (target, property) => {
        if (property === "drawingBufferWidth" || property === "drawingBufferHeight") {
          this.contextDataReads.push(property);
          return Reflect.get(target, property, target);
        }
        if (typeof property === "string" && CLOSED_GL_METHODS.has(property)) {
          const method = Reflect.get(target, property, target);
          assert.equal(typeof method, "function", `allowed WebGL method ${property} is absent`);
          return method.bind(target);
        }
        this.forbiddenContextReads.push(String(property));
        throw new Error(`forbidden WebGL context property read: ${String(property)}`);
      },
    });
  }
  getContext(kind, attributes) { this.contextRequest = { kind, attributes }; return this.gl.options.noContext ? null : this.context; }
  getBoundingClientRect() { return { left: 10, top: 20, width: this.host.width, height: this.host.height }; }
  focus() { if (this.gl.options.throwFocus) throw new Error("injected focus"); this.focusCount += 1; }
  setPointerCapture(pointerId) { if (this.gl.options.throwCapture) throw new Error("injected capture"); this.captureCalls.push(pointerId); this.pointerCaptures.add(pointerId); }
  releasePointerCapture(pointerId) { if (this.gl.options.throwRelease || !this.pointerCaptures.has(pointerId)) throw new Error("injected release"); this.releaseCalls.push(pointerId); this.pointerCaptures.delete(pointerId); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  addEventListener(type, listener, options) {
    if (this.gl.options.throwListener === type) throw new Error(`injected ${type} listener`);
    if (type === "webglcontextlost") { this.listenerOptions = options; this.listeners.add(listener); return; }
    const listeners = this.eventListeners.get(type) ?? new Set();
    listeners.add(listener);
    this.eventListeners.set(type, listeners);
    this.eventOptions ??= new Map();
    this.eventOptions.set(type, options);
  }
  removeEventListener(type, listener) {
    if (type === "webglcontextlost") { this.listeners.delete(listener); return; }
    this.eventListeners.get(type)?.delete(listener);
  }
  remove() { this.removeCount += 1; if (this.host.child === this) this.host.child = undefined; }
  dispatch(type, event) { for (const listener of [...(this.eventListeners.get(type) ?? [])]) listener(event); return event; }
  dispatchLoss(event = new Event("webglcontextlost", { cancelable: true })) { for (const listener of [...this.listeners]) { listener(event); if (this.listenerOptions?.once) this.listeners.delete(listener); } return event; }
}

class FakeResetControl {
  constructor() { this.listeners = new Set(); this.adds = 0; this.removes = 0; }
  addEventListener(type, listener) { assert.equal(type, "click"); this.adds += 1; this.listeners.add(listener); }
  removeEventListener(type, listener) { assert.equal(type, "click"); this.removes += 1; this.listeners.delete(listener); }
  dispatch(event = new Event("click")) { for (const listener of [...this.listeners]) listener(event); return event; }
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
  const resetControl = new FakeResetControl();
  const windowTarget = new FakeLifecycleTarget();
  const documentTarget = new FakeDocumentTarget();
  const environment = {
    host, canvases, observers, resetControl, windowTarget, documentTarget,
    platform: {
      createCanvas() { if (platform.throwCanvas) throw new Error("canvas failed"); const canvas = new FakeCanvas(host, gl); canvases.push(canvas); return canvas; },
      createResizeObserver(callback) {
        if (platform.throwObserver) throw new Error("observer failed");
        const observer = { callback, observed: false, disconnected: 0, observe(target) { if (platform.throwObserve) throw new Error("observe failed"); assert.equal(target, host); this.observed = true; }, disconnect() { this.disconnected += 1; } };
        observers.push(observer); return observer;
      },
      windowTarget() { if (platform.throwWindowTarget) throw new Error("window target failed"); return windowTarget; },
      documentTarget() { if (platform.throwDocumentTarget) throw new Error("document target failed"); return documentTarget; },
    },
  };
  return environment;
}

function oneBuilding() { return buildCity([{ canonicalPath: "a.js", S: 0, U: 0, M: 0 }]).geometry; }
const EMPTY_EVENT_SINK = Object.freeze({ hoverIndex() {}, activationIndex() {}, selectionAction() {} });
function failuresCollector(environment, eligibility = () => true) {
  const failures = [];
  const presenter = createCityPresenter({ host: environment.host, resetControl: environment.resetControl, platform: environment.platform, isEligible: eligibility, failed(...args) { failures.push(args); } });
  return { presenter, failures };
}
function present(environment, presenter, generation, geometry, eventSink = EMPTY_EVENT_SINK) {
  const staged = presenter.stage(generation, geometry, eventSink);
  if (staged.kind !== "staged") return staged;
  environment.lastToken = staged.token;
  const committed = presenter.commit(staged.token);
  if (committed.kind !== "committed") return committed;
  try {
    environment.host.replaceChildren(staged.canvas);
    return committed;
  } catch {
    presenter.rollback(staged.token);
    return PRESENTATION_FAILURE;
  }
}
function names(gl) { return gl.calls.map((call) => call[0]); }
function inputEvent(values = {}) {
  return {
    key: "",
    repeat: false,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    deltaY: 0,
    pointerId: 1,
    button: 0,
    clientX: 50,
    clientY: 50,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    ...values,
  };
}
function matrices(gl) {
  return gl.calls.filter((call) => call[0] === "uniformMatrix4fv").map((call) => [...call[3]]);
}

function expectedInstanceBytes() {
  const bytes = new Uint8Array(28);
  const view = new DataView(bytes.buffer);
  for (const [index, value] of [-0.5, -0.5, -0.5, 1, 1, 1].entries()) view.setFloat32(index * 4, value, true);
  bytes.set([0x44, 0x01, 0x54, 0xff], 24);
  return bytes;
}

function expectedDrawCalls({ width, height, matrix, count, program, vao, uniform }) {
  return [
    ["isContextLost"],
    ["getError"],
    ["clearColor", 1, 1, 1, 1],
    ["clearDepth", 1],
    ["colorMask", true, true, true, true],
    ["depthMask", true],
    ["enable", GL.DEPTH_TEST],
    ["depthFunc", GL.LESS],
    ["enable", GL.CULL_FACE],
    ["cullFace", GL.BACK],
    ["frontFace", GL.CCW],
    ["disable", GL.BLEND],
    ["disable", GL.DITHER],
    ["disable", GL.STENCIL_TEST],
    ["disable", GL.SCISSOR_TEST],
    ["disable", GL.POLYGON_OFFSET_FILL],
    ["disable", GL.RASTERIZER_DISCARD],
    ["disable", GL.SAMPLE_COVERAGE],
    ["disable", GL.SAMPLE_ALPHA_TO_COVERAGE],
    ["viewport", 0, 0, width, height],
    ["clear", GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT],
    ["useProgram", program],
    ["bindVertexArray", vao],
    ["uniformMatrix4fv", uniform, false, new Float32Array(matrix)],
    ["drawElementsInstanced", GL.TRIANGLES, 36, GL.UNSIGNED_BYTE, 0, count],
    ["isContextLost"],
    ["getError"],
  ];
}

function expectedInitialCalls() {
  const vertexShader = { kind: "Shader", type: GL.VERTEX_SHADER, id: 1 };
  const fragmentShader = { kind: "Shader", type: GL.FRAGMENT_SHADER, id: 2 };
  const program = { kind: "Program", id: 3 };
  const uniform = { kind: "Uniform", id: 4 };
  const vao = { kind: "VertexArray", id: 5 };
  const positionBuffer = { kind: "Buffer", id: 6 };
  const indexBuffer = { kind: "Buffer", id: 7 };
  const instanceBuffer = { kind: "Buffer", id: 8 };
  const positionBytes = new Uint8Array(new Float32Array(literals.cubePositions).buffer);
  return [
    ["getContextAttributes"],
    ["isContextLost"], ["getError"],
    ["createShader", GL.VERTEX_SHADER],
    ["isContextLost"], ["getError"],
    ["shaderSource", vertexShader, literals.vertexShader],
    ["compileShader", vertexShader],
    ["getShaderParameter", vertexShader, GL.COMPILE_STATUS],
    ["isContextLost"], ["getError"],
    ["createShader", GL.FRAGMENT_SHADER],
    ["isContextLost"], ["getError"],
    ["shaderSource", fragmentShader, literals.fragmentShader],
    ["compileShader", fragmentShader],
    ["getShaderParameter", fragmentShader, GL.COMPILE_STATUS],
    ["isContextLost"], ["getError"],
    ["createProgram"],
    ["isContextLost"], ["getError"],
    ["attachShader", program, vertexShader],
    ["attachShader", program, fragmentShader],
    ["linkProgram", program],
    ["getProgramParameter", program, GL.LINK_STATUS],
    ["isContextLost"], ["getError"],
    ["getUniformLocation", program, "u_clipFromTarget"],
    ["isContextLost"], ["getError"],
    ["deleteShader", vertexShader],
    ["deleteShader", fragmentShader],
    ["isContextLost"], ["getError"],
    ["createVertexArray"],
    ["isContextLost"], ["getError"],
    ["createBuffer"],
    ["isContextLost"], ["getError"],
    ["createBuffer"],
    ["isContextLost"], ["getError"],
    ["createBuffer"],
    ["isContextLost"], ["getError"],
    ["bindVertexArray", vao],
    ["bindBuffer", GL.ARRAY_BUFFER, positionBuffer],
    ["bufferData", GL.ARRAY_BUFFER, positionBytes, GL.STATIC_DRAW],
    ["isContextLost"], ["getError"],
    ["enableVertexAttribArray", 0],
    ["vertexAttribPointer", 0, 3, GL.FLOAT, false, 0, 0],
    ["bindBuffer", GL.ELEMENT_ARRAY_BUFFER, indexBuffer],
    ["bufferData", GL.ELEMENT_ARRAY_BUFFER, new Uint8Array(literals.cubeIndices), GL.STATIC_DRAW],
    ["isContextLost"], ["getError"],
    ["bindBuffer", GL.ARRAY_BUFFER, instanceBuffer],
    ["bufferData", GL.ARRAY_BUFFER, expectedInstanceBytes(), GL.STATIC_DRAW],
    ["isContextLost"], ["getError"],
    ["enableVertexAttribArray", 1],
    ["vertexAttribPointer", 1, 3, GL.FLOAT, false, 28, 0],
    ["vertexAttribDivisor", 1, 1],
    ["enableVertexAttribArray", 2],
    ["vertexAttribPointer", 2, 3, GL.FLOAT, false, 28, 12],
    ["vertexAttribDivisor", 2, 1],
    ["enableVertexAttribArray", 3],
    ["vertexAttribPointer", 3, 4, GL.UNSIGNED_BYTE, true, 28, 24],
    ["vertexAttribDivisor", 3, 1],
    ["isContextLost"], ["getError"],
    ...expectedDrawCalls({ width: 200, height: 100, matrix: literals.unitAspectTwoMatrix, count: 1, program, vao, uniform }),
  ];
}

function transform(matrix, point) {
  return [
    matrix[0] * point[0] + matrix[4] * point[1] + matrix[8] * point[2],
    matrix[1] * point[0] + matrix[5] * point[1] + matrix[9] * point[2],
    matrix[2] * point[0] + matrix[6] * point[1] + matrix[10] * point[2],
    1,
  ];
}

test("cube, indices, shaders, context request, complete setup/draw calls, matrix handedness, transpose, and depth are literal", () => {
  const environment = fakeEnvironment();
  const { presenter } = failuresCollector(environment);
  assert.deepEqual(present(environment, presenter, 1, oneBuilding()), COMMITTED);
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
  assert.deepEqual(canvas.gl.calls, expectedInitialCalls());
  assert.deepEqual(canvas.contextDataReads, ["drawingBufferWidth", "drawingBufferHeight"]);
  assert.deepEqual(canvas.forbiddenContextReads, []);
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

test("production WebGL access is closed to exact methods and two dynamic data properties", async () => {
  const source = await readFile(path.join(projectRoot, "src/edge/city-presenter.ts"), "utf8");
  assert.doesNotMatch(source, /\bgl\.[A-Z][A-Z0-9_]*\b/u);
  const usedMethods = [...new Set([...source.matchAll(/\bgl\.([a-z]\w*)\s*\(/gu)].map((match) => match[1]))].sort();
  assert.deepEqual(usedMethods, [...CLOSED_GL_METHODS].sort());

  const environment = fakeEnvironment();
  const { presenter } = failuresCollector(environment);
  assert.deepEqual(present(environment, presenter, 1, oneBuilding()), COMMITTED);
  const canvas = environment.canvases[0];
  assert.deepEqual(canvas.contextDataReads, ["drawingBufferWidth", "drawingBufferHeight"]);
  assert.deepEqual(canvas.forbiddenContextReads, []);
  assert.throws(() => canvas.context.DEPTH_TEST, /forbidden WebGL context property read: DEPTH_TEST/u);
  assert.deepEqual(canvas.forbiddenContextReads, ["DEPTH_TEST"]);
});

test("one instance uses exact target-relative float staging, state, and one instanced draw", () => {
  const environment = fakeEnvironment();
  const { presenter } = failuresCollector(environment);
  assert.deepEqual(present(environment, presenter, "g", oneBuilding()), COMMITTED);
  const gl = environment.canvases[0].gl;
  assert.deepEqual(gl.uploads.map(({ byteLength }) => byteLength), [96, 36, 28]);
  const instance = gl.uploads[2].bytes;
  const view = new DataView(instance.buffer, instance.byteOffset, instance.byteLength);
  assert.deepEqual(Array.from({ length: 6 }, (_, index) => view.getFloat32(index * 4, true)), [-0.5, -0.5, -0.5, 1, 1, 1]);
  assert.deepEqual([...instance.slice(24)], [0x44, 0x01, 0x54, 0xff]);
  const pointers = gl.calls.filter((call) => call[0] === "vertexAttribPointer").map((call) => call.slice(1));
  assert.deepEqual(pointers, [[0, 3, GL.FLOAT, false, 0, 0], [1, 3, GL.FLOAT, false, 28, 0], [2, 3, GL.FLOAT, false, 28, 12], [3, 4, GL.UNSIGNED_BYTE, true, 28, 24]]);
  assert.deepEqual(gl.calls.filter((call) => call[0] === "vertexAttribDivisor").map((call) => call.slice(1)), [[1, 1], [2, 1], [3, 1]]);
  assert.deepEqual(gl.calls.filter((call) => call[0] === "drawElementsInstanced").map((call) => call.slice(1)), [[GL.TRIANGLES, 36, GL.UNSIGNED_BYTE, 0, 1]]);
  assert.deepEqual(gl.calls.find((call) => call[0] === "clear").slice(1), [GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT]);
  for (const disabled of [GL.BLEND, GL.DITHER, GL.STENCIL_TEST, GL.SCISSOR_TEST, GL.POLYGON_OFFSET_FILL, GL.RASTERIZER_DISCARD, GL.SAMPLE_COVERAGE, GL.SAMPLE_ALPHA_TO_COVERAGE]) assert(gl.calls.some((call) => call[0] === "disable" && call[1] === disabled));
  assert.deepEqual(environment.canvases[0].listenerOptions, { passive: true, once: true });
  assert.equal(environment.observers[0].observed, true);
});

test("canvas accessibility and exact camera and selection key mappings suppress only recognised unmodified input", () => {
  const environment = fakeEnvironment();
  const events = [];
  const sink = { hoverIndex(...args) { events.push(["hover", ...args]); }, activationIndex(...args) { events.push(["activation", ...args]); }, selectionAction(...args) { events.push(["selection", ...args]); } };
  const { presenter, failures } = failuresCollector(environment);
  const geometry = oneBuilding();
  assert.deepEqual(present(environment, presenter, 1, geometry, sink), COMMITTED);
  const canvas = environment.canvases[0];
  const size = { width: 200, height: 100 };
  let expected = resetCamera(geometry.bounds, size);
  assert.equal(expected.kind, "success");
  assert.equal(canvas.tabIndex, 0);
  assert.equal(canvas.attributes.get("aria-label"), "Interactive code city");
  assert.equal(canvas.attributes.get("aria-describedby"), "city-navigation-instructions");
  assert.deepEqual(canvas.eventOptions.get("wheel"), { passive: false });
  assert.equal(canvas.eventListeners.get("keydown").size, 1);
  assert.equal(canvas.eventListeners.get("wheel").size, 1);
  assert.equal(environment.resetControl.listeners.size, 1);

  const accepted = [
    ...["w", "a", "s", "d"].map((key, index) => [inputEvent({ key, repeat: index === 1 }), () => orbitCameraByKeyboard(expected.state, geometry.bounds, size, key)]),
    ...["W", "A", "S", "D"].map((key) => [inputEvent({ key, shiftKey: true }), () => panCameraByKeyboard(expected.state, geometry.bounds, size, key)]),
    [inputEvent({ key: "+", shiftKey: true }), () => zoomCamera(expected.state, geometry.bounds, size, "in")],
    [inputEvent({ key: "-" }), () => zoomCamera(expected.state, geometry.bounds, size, "out")],
    [inputEvent({ key: "0" }), () => resetCamera(geometry.bounds, size)],
  ];
  for (const [event, transition] of accepted) {
    expected = transition();
    assert.equal(expected.kind, "success");
    canvas.dispatch("keydown", event);
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(matrices(canvas.gl).at(-1), expected.view.matrix);
  }

  const draws = names(canvas.gl).filter((name) => name === "drawElementsInstanced").length;
  const selectionKeys = [
    ["ArrowRight", "next"], ["ArrowDown", "next"],
    ["ArrowLeft", "previous"], ["ArrowUp", "previous"],
    ["Home", "first"], ["End", "last"], ["Escape", "clear"],
  ];
  for (const [index, [key]] of selectionKeys.entries()) {
    const event = inputEvent({ key, repeat: index % 2 === 1 });
    canvas.dispatch("keydown", event);
    assert.equal(event.defaultPrevented, true, key);
  }
  assert.deepEqual(events, selectionKeys.map(([, action]) => ["selection", 1, action]));

  for (const event of [
    inputEvent({ key: "w", shiftKey: true }),
    inputEvent({ key: "W" }),
    inputEvent({ key: "d", ctrlKey: true }),
    ...selectionKeys.flatMap(([key]) => [
      inputEvent({ key, shiftKey: true }),
      inputEvent({ key, ctrlKey: true }),
      inputEvent({ key, altKey: true }),
      inputEvent({ key, metaKey: true }),
    ]),
    inputEvent({ key: "x" }),
  ]) {
    canvas.dispatch("keydown", event);
    assert.equal(event.defaultPrevented, false, event.key);
  }
  assert.equal(names(canvas.gl).filter((name) => name === "drawElementsInstanced").length, draws);
  assert.deepEqual(events, selectionKeys.map(([, action]) => ["selection", 1, action]));
  assert.deepEqual(failures, []);
});

test("primary orbit and secondary pan use exact pointer deltas, focus, capture, and no activation", () => {
  const environment = fakeEnvironment();
  const events = [];
  const sink = { hoverIndex(...args) { events.push(["hover", ...args]); }, activationIndex(...args) { events.push(["activation", ...args]); }, selectionAction(...args) { events.push(["selection", ...args]); } };
  const { presenter, failures } = failuresCollector(environment);
  const geometry = oneBuilding();
  assert.deepEqual(present(environment, presenter, 1, geometry, sink), COMMITTED);
  const canvas = environment.canvases[0];
  let expected = resetCamera(geometry.bounds, { width: 200, height: 100 });

  const primaryDown = inputEvent({ pointerId: 7, button: 0, clientX: 50, clientY: 40 });
  canvas.dispatch("pointerdown", primaryDown);
  assert.equal(primaryDown.defaultPrevented, true);
  assert.equal(canvas.focusCount, 1);
  assert.deepEqual(canvas.captureCalls, [7]);
  assert.deepEqual([...canvas.pointerCaptures], [7]);

  const inertPointer = inputEvent({ pointerId: 8, button: 2, clientX: 90, clientY: 90 });
  canvas.dispatch("pointerdown", inertPointer);
  canvas.dispatch("pointermove", inertPointer);
  assert.equal(inertPointer.defaultPrevented, false);
  assert.deepEqual(canvas.captureCalls, [7]);

  const firstMove = inputEvent({ pointerId: 7, button: -1, clientX: 51, clientY: 40 });
  expected = orbitCameraByPointer(expected.state, geometry.bounds, { width: 200, height: 100 }, 1, 0, 200, 100);
  canvas.dispatch("pointermove", firstMove);
  assert.equal(expected.kind, "success");
  assert.deepEqual(matrices(canvas.gl).at(-1), expected.view.matrix);

  const primaryUp = inputEvent({ pointerId: 7, button: 0, clientX: 51, clientY: 40 });
  canvas.dispatch("pointerup", primaryUp);
  assert.deepEqual(canvas.releaseCalls, [7]);
  assert.deepEqual([...canvas.pointerCaptures], []);

  const secondaryDown = inputEvent({ pointerId: 9, button: 2, clientX: 80, clientY: 60, shiftKey: true });
  canvas.dispatch("pointerdown", secondaryDown);
  const secondaryMove = inputEvent({ pointerId: 9, button: -1, clientX: 78, clientY: 63, ctrlKey: true });
  expected = panCameraByPointer(expected.state, geometry.bounds, { width: 200, height: 100 }, -2, 3, 200, 100);
  canvas.dispatch("pointermove", secondaryMove);
  assert.equal(expected.kind, "success");
  assert.deepEqual(matrices(canvas.gl).at(-1), expected.view.matrix);
  canvas.dispatch("pointerup", inputEvent({ pointerId: 9, button: 2, clientX: 78, clientY: 63 }));
  assert.deepEqual(canvas.releaseCalls, [7, 9]);
  assert.deepEqual(events, []);
  assert.deepEqual(failures, []);
});

test("pointer release classification has no threshold and never emits issue 9 activation early", () => {
  const environment = fakeEnvironment();
  const events = [];
  const { presenter, failures } = failuresCollector(environment);
  assert.deepEqual(present(environment, presenter, 1, oneBuilding(), {
    hoverIndex(...args) { events.push(["hover", ...args]); },
    activationIndex(...args) { events.push(["activation", ...args]); },
    selectionAction(...args) { events.push(["selection", ...args]); },
  }), COMMITTED);
  const canvas = environment.canvases[0];
  const draws = names(canvas.gl).filter((name) => name === "drawElementsInstanced").length;

  canvas.dispatch("pointerdown", inputEvent({ pointerId: 1, button: 0, clientX: 40, clientY: 40 }));
  canvas.dispatch("pointerup", inputEvent({ pointerId: 1, button: 0, clientX: 40, clientY: 40 }));
  canvas.dispatch("pointerdown", inputEvent({ pointerId: 2, button: 0, clientX: 40, clientY: 40 }));
  canvas.dispatch("pointerup", inputEvent({ pointerId: 2, button: 0, clientX: 40, clientY: 40, shiftKey: true }));
  canvas.dispatch("pointerdown", inputEvent({ pointerId: 3, button: 2, clientX: 40, clientY: 40 }));
  canvas.dispatch("pointerup", inputEvent({ pointerId: 3, button: 2, clientX: 40, clientY: 40 }));
  canvas.dispatch("pointerdown", inputEvent({ pointerId: 4, button: 0, clientX: 40, clientY: 40 }));
  canvas.dispatch("pointermove", inputEvent({ pointerId: 4, button: -1, clientX: 40.00000000000001, clientY: 40 }));
  canvas.dispatch("pointermove", inputEvent({ pointerId: 4, button: -1, clientX: 40, clientY: 40 }));
  canvas.dispatch("pointerup", inputEvent({ pointerId: 4, button: 0, clientX: 40, clientY: 40 }));

  assert.deepEqual(canvas.captureCalls, [1, 2, 3, 4]);
  assert.deepEqual(canvas.releaseCalls, [1, 2, 3, 4]);
  assert.equal(names(canvas.gl).filter((name) => name === "drawElementsInstanced").length, draws + 2);
  assert.deepEqual(events, []);
  assert.deepEqual(failures, []);
});

test("wheel sign, native Reset, resize retention, and browser-owned modifiers use immutable uploads", () => {
  const environment = fakeEnvironment();
  const { presenter, failures } = failuresCollector(environment);
  const geometry = oneBuilding();
  assert.deepEqual(present(environment, presenter, 1, geometry), COMMITTED);
  const canvas = environment.canvases[0];
  const uploads = canvas.gl.uploads.map(({ bytes }) => [...bytes]);
  let expected = resetCamera(geometry.bounds, { width: 200, height: 100 });

  const wheelIn = inputEvent({ deltaY: -0.001 });
  expected = zoomCamera(expected.state, geometry.bounds, { width: 200, height: 100 }, "in");
  canvas.dispatch("wheel", wheelIn);
  assert.equal(wheelIn.defaultPrevented, true);
  assert.deepEqual(matrices(canvas.gl).at(-1), expected.view.matrix);

  const wheelOut = inputEvent({ deltaY: Number.POSITIVE_INFINITY });
  expected = zoomCamera(expected.state, geometry.bounds, { width: 200, height: 100 }, "out");
  canvas.dispatch("wheel", wheelOut);
  assert.equal(wheelOut.defaultPrevented, true);
  assert.deepEqual(matrices(canvas.gl).at(-1), expected.view.matrix);

  const draws = names(canvas.gl).filter((name) => name === "drawElementsInstanced").length;
  for (const event of [inputEvent({ deltaY: 0 }), inputEvent({ deltaY: -1, shiftKey: true }), inputEvent({ deltaY: 1, ctrlKey: true })]) {
    canvas.dispatch("wheel", event);
    assert.equal(event.defaultPrevented, false);
  }
  assert.equal(names(canvas.gl).filter((name) => name === "drawElementsInstanced").length, draws);

  const panned = inputEvent({ key: "D", shiftKey: true });
  canvas.dispatch("keydown", panned);
  expected = panCameraByKeyboard(expected.state, geometry.bounds, { width: 200, height: 100 }, "D");
  environment.host.width = 300;
  environment.observers[0].callback();
  const resized = expected.kind === "success" ? resizeCamera(expected.state, geometry.bounds, { width: 300, height: 100 }) : expected;
  assert.equal(resized.kind, "success");
  assert.deepEqual(matrices(canvas.gl).at(-1), resized.view.matrix);

  environment.resetControl.dispatch();
  const reset = resetCamera(geometry.bounds, { width: 300, height: 100 });
  assert.equal(reset.kind, "success");
  assert.deepEqual(matrices(canvas.gl).at(-1), reset.view.matrix);
  assert.deepEqual(canvas.gl.uploads.map(({ bytes }) => [...bytes]), uploads);
  assert.deepEqual(failures, []);
});

test("pointer interruptions cancel capture without deltas and lifecycle cleanup removes every owner exactly once", () => {
  const cases = ["pointercancel", "lostpointercapture", "blur", "hidden", "pagehide", "resize", "reset"];
  for (const stimulus of cases) {
    const environment = fakeEnvironment();
    const { presenter, failures } = failuresCollector(environment);
    assert.deepEqual(present(environment, presenter, stimulus, oneBuilding()), COMMITTED);
    const canvas = environment.canvases[0];
    canvas.dispatch("pointerdown", inputEvent({ pointerId: 12, button: 0, clientX: 50, clientY: 50 }));
    const draws = names(canvas.gl).filter((name) => name === "drawElementsInstanced").length;
    if (stimulus === "pointercancel") canvas.dispatch("pointercancel", inputEvent({ pointerId: 12 }));
    if (stimulus === "lostpointercapture") { canvas.pointerCaptures.delete(12); canvas.dispatch("lostpointercapture", inputEvent({ pointerId: 12 })); }
    if (stimulus === "blur") environment.windowTarget.dispatch("blur");
    if (stimulus === "hidden") { environment.documentTarget.visibilityState = "hidden"; environment.documentTarget.dispatch("visibilitychange"); }
    if (stimulus === "pagehide") environment.windowTarget.dispatch("pagehide");
    if (stimulus === "resize") environment.observers[0].callback();
    if (stimulus === "reset") environment.resetControl.dispatch();
    const expectedDraws = stimulus === "reset" ? draws + 1 : draws;
    assert.equal(names(canvas.gl).filter((name) => name === "drawElementsInstanced").length, expectedDraws, stimulus);
    assert.deepEqual(canvas.releaseCalls, stimulus === "lostpointercapture" ? [] : [12], stimulus);
    canvas.dispatch("pointermove", inputEvent({ pointerId: 12, button: -1, clientX: 70, clientY: 70 }));
    canvas.dispatch("pointerup", inputEvent({ pointerId: 12, button: 0, clientX: 70, clientY: 70 }));
    assert.equal(names(canvas.gl).filter((name) => name === "drawElementsInstanced").length, expectedDraws, stimulus);
    presenter.dispose(); presenter.dispose();
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture", "contextmenu", "keydown", "wheel"]) assert.equal(canvas.eventListeners.get(type)?.size ?? 0, 0, `${stimulus}:${type}`);
    assert.deepEqual(environment.windowTarget.removes, ["blur", "pagehide"], stimulus);
    assert.deepEqual(environment.documentTarget.removes, ["visibilitychange"], stimulus);
    assert.deepEqual(failures, [], stimulus);
  }
});

test("canvas context menu is suppressed while other buttons and stale callbacks remain browser-owned", () => {
  const environment = fakeEnvironment();
  let eligible = true;
  const { presenter, failures } = failuresCollector(environment, () => eligible);
  assert.deepEqual(present(environment, presenter, 1, oneBuilding()), COMMITTED);
  const canvas = environment.canvases[0];
  const contextMenu = inputEvent();
  canvas.dispatch("contextmenu", contextMenu);
  assert.equal(contextMenu.defaultPrevented, true);
  for (const button of [1, 3, 4]) {
    const event = inputEvent({ pointerId: button + 20, button });
    canvas.dispatch("pointerdown", event);
    assert.equal(event.defaultPrevented, false);
  }
  assert.deepEqual(canvas.captureCalls, []);
  eligible = false;
  const staleMenu = inputEvent();
  canvas.dispatch("contextmenu", staleMenu);
  assert.equal(staleMenu.defaultPrevented, false);
  assert.equal(canvas.removeCount, 1);
  assert.deepEqual(failures, []);
});

test("pointer capture and finite-coordinate failures revoke the session once and release owned capture", () => {
  for (const [id, gl, event] of [
    ["focus", { throwFocus: true }, inputEvent({ pointerId: 3, button: 0 })],
    ["capture", { throwCapture: true }, inputEvent({ pointerId: 3, button: 0 })],
    ["coordinate", {}, inputEvent({ pointerId: 3, button: 0, clientX: Number.NaN })],
  ]) {
    const environment = fakeEnvironment({ gl });
    const { presenter, failures } = failuresCollector(environment);
    assert.deepEqual(present(environment, presenter, id, oneBuilding()), COMMITTED);
    const canvas = environment.canvases[0];
    canvas.dispatch("pointerdown", event);
    assert.deepEqual(failures, [[id, "Presentation failed", "M1-PRES-1"]], id);
    assert.equal(canvas.removeCount, 1, id);
    assert.deepEqual(canvas.releaseCalls, [], id);
  }
  {
    const environment = fakeEnvironment();
    const { presenter, failures } = failuresCollector(environment);
    assert.deepEqual(present(environment, presenter, "move", oneBuilding()), COMMITTED);
    const canvas = environment.canvases[0];
    canvas.dispatch("pointerdown", inputEvent({ pointerId: 4, button: 0 }));
    canvas.dispatch("pointermove", inputEvent({ pointerId: 4, button: -1, clientY: Number.POSITIVE_INFINITY }));
    assert.deepEqual(failures, [["move", "Presentation failed", "M1-PRES-1"]]);
    assert.deepEqual(canvas.releaseCalls, [4]);
    assert.equal(canvas.removeCount, 1);
  }
  {
    const environment = fakeEnvironment({ gl: { throwRelease: true } });
    const { presenter, failures } = failuresCollector(environment);
    assert.deepEqual(present(environment, presenter, "release", oneBuilding()), COMMITTED);
    const canvas = environment.canvases[0];
    canvas.dispatch("pointerdown", inputEvent({ pointerId: 5, button: 0 }));
    canvas.dispatch("pointerup", inputEvent({ pointerId: 5, button: 0 }));
    assert.deepEqual(failures, [["release", "Presentation failed", "M1-PRES-1"]]);
    assert.deepEqual(canvas.releaseCalls, []);
    assert.equal(canvas.removeCount, 1);
  }
});

test("generation is opaque, stale work is inert, replacement is atomic, and dispose is idempotent", () => {
  const environment = fakeEnvironment();
  const raw = {};
  const generation = new Proxy(raw, { get() { throw new Error("generation was read"); }, ownKeys() { throw new Error("generation was inspected"); } });
  let eligible = true;
  const seen = [];
  const { presenter, failures } = failuresCollector(environment, (value) => { seen.push(value); return eligible; });
  assert.deepEqual(present(environment, presenter, generation, oneBuilding()), COMMITTED);
  const first = environment.canvases[0];
  eligible = false;
  assert.deepEqual(present(environment, presenter, generation, oneBuilding()), STALE);
  assert.equal(environment.canvases.length, 1);
  assert.equal(environment.host.child, first);
  eligible = true;
  assert.deepEqual(present(environment, presenter, generation, oneBuilding()), COMMITTED);
  assert.equal(first.removeCount, 1);
  assert.equal(environment.host.child, environment.canvases[1]);
  presenter.dispose(); presenter.dispose();
  assert.equal(environment.canvases[1].removeCount, 1);
  assert.deepEqual(failures, []);
  assert(seen.every((value) => value === generation));
});

test("rollback releases a token idempotently and the presenter remains reusable", () => {
  const environment = fakeEnvironment();
  const { presenter, failures } = failuresCollector(environment);
  assert.deepEqual(present(environment, presenter, 1, oneBuilding()), COMMITTED);
  const first = environment.canvases[0];
  presenter.rollback(environment.lastToken);
  presenter.rollback(environment.lastToken);
  assert.equal(first.removeCount, 1);
  assert.equal(environment.host.child, undefined);
  assert.deepEqual(present(environment, presenter, 2, oneBuilding()), COMMITTED);
  assert.equal(environment.host.child, environment.canvases[1]);
  assert.deepEqual(failures, []);
});

test("stage is detached, commit and visual state are token/generation gated, and rollback is idempotent", () => {
  const environment = fakeEnvironment();
  const { presenter, failures } = failuresCollector(environment);
  const staged = presenter.stage(7, oneBuilding(), EMPTY_EVENT_SINK);
  assert.equal(staged.kind, "staged");
  assert.equal(environment.host.replacements, 0);
  assert.equal(environment.host.child, undefined);
  assert.deepEqual(presenter.setVisualState(7, null, null), STALE);
  assert.deepEqual(presenter.commit(Object.freeze({})), STALE);
  assert.deepEqual(presenter.commit(staged.token), COMMITTED);
  assert.deepEqual(presenter.commit(staged.token), STALE);
  assert.deepEqual(presenter.setVisualState(8, null, null), STALE);
  assert.deepEqual(presenter.setVisualState(7, null, null), APPLIED);
  presenter.rollback(Object.freeze({}));
  presenter.rollback(staged.token);
  presenter.rollback(staged.token);
  assert.equal(staged.canvas.removeCount, 1);
  assert.deepEqual(presenter.setVisualState(7, null, null), STALE);
  assert.deepEqual(failures, []);
});

test("invalid visual indices fail the committed session once and retained lifecycle callbacks become inert", () => {
  const environment = fakeEnvironment();
  const { presenter, failures } = failuresCollector(environment);
  assert.deepEqual(present(environment, presenter, 1, oneBuilding()), COMMITTED);
  const canvas = environment.canvases[0];
  const retainedLoss = [...canvas.listeners][0];
  const retainedResize = environment.observers[0].callback;
  assert.deepEqual(presenter.setVisualState(1, 1, null), PRESENTATION_FAILURE);
  assert.deepEqual(failures, [[1, "Presentation failed", "M1-PRES-1"]]);
  assert.equal(canvas.removeCount, 1);
  assert.equal(canvas.eventListeners.get("keydown").size, 0);
  assert.equal(canvas.eventListeners.get("wheel").size, 0);
  assert.equal(environment.resetControl.listeners.size, 0);
  retainedLoss(new Event("webglcontextlost", { cancelable: true }));
  retainedResize();
  assert.equal(canvas.removeCount, 1);
  assert.equal(failures.length, 1);
});

test("camera redraw failure revokes once and retained input callbacks are inert", () => {
  const environment = fakeEnvironment();
  const { presenter, failures } = failuresCollector(environment);
  assert.deepEqual(present(environment, presenter, 1, oneBuilding()), COMMITTED);
  const canvas = environment.canvases[0];
  const retainedKeyboard = [...canvas.eventListeners.get("keydown")][0];
  const retainedWheel = [...canvas.eventListeners.get("wheel")][0];
  const retainedReset = [...environment.resetControl.listeners][0];
  canvas.gl.options.throwMethod = "drawElementsInstanced";
  const event = inputEvent({ key: "d" });
  retainedKeyboard(event);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(failures, [[1, "Presentation failed", "M1-PRES-1"]]);
  assert.equal(canvas.removeCount, 1);
  assert.equal(canvas.eventListeners.get("keydown").size, 0);
  assert.equal(canvas.eventListeners.get("wheel").size, 0);
  assert.equal(environment.resetControl.listeners.size, 0);
  retainedKeyboard(inputEvent({ key: "a" }));
  retainedWheel(inputEvent({ deltaY: -1 }));
  retainedReset(new Event("click"));
  assert.equal(failures.length, 1);
  assert.equal(canvas.removeCount, 1);
});

test("listener setup failure rolls back all attached session listeners", () => {
  for (const type of ["webglcontextlost", "keydown", "wheel", "pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture", "contextmenu"]) {
    const environment = fakeEnvironment({ gl: { throwListener: type } });
    const { presenter, failures } = failuresCollector(environment);
    assert.deepEqual(present(environment, presenter, type, oneBuilding()), PRESENTATION_FAILURE);
    const canvas = environment.canvases[0];
    assert.equal(canvas.removeCount, 1);
    assert.equal(canvas.listeners.size, 0);
    assert.equal(canvas.eventListeners.get("keydown")?.size ?? 0, 0);
    assert.equal(canvas.eventListeners.get("wheel")?.size ?? 0, 0);
    assert.equal(environment.resetControl.listeners.size, 0);
    assert.deepEqual(failures, []);
  }
});

test("context loss while detached fails and disposes the staged token without publication", () => {
  const environment = fakeEnvironment();
  const { presenter, failures } = failuresCollector(environment);
  const staged = presenter.stage(3, oneBuilding(), EMPTY_EVENT_SINK);
  assert.equal(staged.kind, "staged");
  staged.canvas.dispatchLoss();
  assert.deepEqual(failures, [[3, "Presentation failed", "M1-PRES-1"]]);
  assert.deepEqual(presenter.commit(staged.token), STALE);
  presenter.rollback(staged.token);
  assert.equal(staged.canvas.removeCount, 1);
  assert.equal(environment.host.replacements, 0);
});

test("committing a second staged token disposes the prior committed session exactly once", () => {
  const environment = fakeEnvironment();
  const { presenter } = failuresCollector(environment);
  const first = presenter.stage(1, oneBuilding(), EMPTY_EVENT_SINK);
  const second = presenter.stage(2, oneBuilding(), EMPTY_EVENT_SINK);
  assert.equal(first.kind, "staged");
  assert.equal(second.kind, "staged");
  assert.deepEqual(presenter.commit(first.token), COMMITTED);
  assert.deepEqual(presenter.commit(second.token), COMMITTED);
  assert.equal(first.canvas.removeCount, 1);
  assert.equal(second.canvas.removeCount, 0);
  presenter.dispose();
  presenter.dispose();
  assert.equal(second.canvas.removeCount, 1);
});

test("source-free presentation data has only the geometry contract and is structured-clone compatible", () => {
  const geometry = oneBuilding();
  assert.deepEqual(Object.keys(geometry), ["kind", "count", "origins", "sizes", "rgba", "bounds"]);
  assert.equal(JSON.stringify(geometry).includes("a.js"), false);
  const cloned = structuredClone(geometry);
  assert.deepEqual([...cloned.origins], [...geometry.origins]);
  assert.deepEqual([...cloned.sizes], [...geometry.sizes]);
  assert.deepEqual([...cloned.rgba], [...geometry.rgba]);
  assert.deepEqual([...cloned.bounds], [...geometry.bounds]);
});

test("the complete 4,000-building model uploads exactly 112,000 bytes and draws once", () => {
  const facts = Array.from({ length: 4000 }, (_, index) => ({ canonicalPath: `m/${String(index).padStart(4, "0")}.js`, S: index % 7, U: index % 5, M: index % 17 }));
  const model = buildCity(facts).geometry;
  const environment = fakeEnvironment({ width: 640, height: 480 });
  const { presenter } = failuresCollector(environment);
  assert.deepEqual(present(environment, presenter, 4000, model), COMMITTED);
  const gl = environment.canvases[0].gl;
  assert.deepEqual(gl.uploads.map(({ byteLength }) => byteLength), [96, 36, 112000]);
  assert.deepEqual(gl.calls.filter((call) => call[0] === "drawElementsInstanced").at(-1).slice(1), [GL.TRIANGLES, 36, GL.UNSIGNED_BYTE, 0, 4000]);
});

test("presenter accepts validated geometry only and owns no city, inspection, alignment, palette, or limit validator", async () => {
  const source = await readFile(path.join(projectRoot, "src/edge/city-presenter.ts"), "utf8");
  assert.match(source, /stage\(generation: G, model: ValidatedGeometry, eventSink: PresenterEventSink<G>\)/u);
  assert.doesNotMatch(source, /\bpresent\(/u);
  assert.doesNotMatch(source, /validateCityPayload|validatePresentationModel|canonicalPath|inspection|paletteForComplexity|MAX_ADMITTED_MODULES/u);
});

test("final dimension reread redraws the detached candidate before commit", () => {
  const environment = fakeEnvironment({ width: 100, height: 100 });
  let widthReads = 0;
  Object.defineProperty(environment.host, "clientWidth", { configurable: true, get() { widthReads += 1; return widthReads === 1 ? 100 : 200; } });
  const { presenter } = failuresCollector(environment);
  assert.deepEqual(present(environment, presenter, 1, oneBuilding()), COMMITTED);
  const canvas = environment.canvases[0];
  assert.equal(canvas.gl.uploads.length, 3);
  assert.equal(canvas.gl.calls.filter((call) => call[0] === "drawElementsInstanced").length, 2);
  assert.equal(canvas.width, 200);
});

test("changed resize repeats the exact draw state with a literal matrix and unchanged resize makes no calls", () => {
  const environment = fakeEnvironment();
  const { presenter } = failuresCollector(environment);
  assert.deepEqual(present(environment, presenter, 1, oneBuilding()), COMMITTED);
  const canvas = environment.canvases[0];
  const gl = canvas.gl;
  const program = gl.calls.find((call) => call[0] === "useProgram")[1];
  const vao = gl.calls.find((call) => call[0] === "bindVertexArray" && call.length === 2)[1];
  const uniform = gl.calls.find((call) => call[0] === "uniformMatrix4fv")[1];
  const callCount = gl.calls.length;
  const dataReadCount = canvas.contextDataReads.length;

  environment.host.width = 300;
  environment.observers[0].callback();
  assert.equal(gl.uploads.length, 3);
  assert.deepEqual(gl.calls.slice(callCount), expectedDrawCalls({
    width: 300,
    height: 100,
    matrix: literals.unitAspectThreeMatrix,
    count: 1,
    program,
    vao,
    uniform,
  }));
  assert.deepEqual(canvas.contextDataReads.slice(dataReadCount), ["drawingBufferWidth", "drawingBufferHeight"]);
  assert.deepEqual(canvas.forbiddenContextReads, []);

  const unchangedCallCount = gl.calls.length;
  const unchangedDataReadCount = canvas.contextDataReads.length;
  environment.observers[0].callback();
  assert.equal(gl.calls.length, unchangedCallCount);
  assert.equal(canvas.contextDataReads.length, unchangedDataReadCount);
  assert.equal(gl.uploads.length, 3);
});

test("committed context loss and resize failures notify controller before idempotent token cleanup", () => {
  for (const stimulus of ["loss", "resize"]) {
    const environment = fakeEnvironment();
    const callbacks = [];
    const events = [];
    let semanticCurrent = true;
    let presenter;
    presenter = createCityPresenter({
      host: environment.host,
      platform: environment.platform,
      isEligible: () => true,
      failed(...args) {
        const canvas = environment.canvases[0];
        events.push("controller:failure");
        assert.equal(semanticCurrent, true);
        assert.equal(environment.host.child, canvas);
        assert.equal(canvas.removeCount, 0);
        assert.equal(names(canvas.gl).filter((name) => name === "deleteProgram").length, 0);
        semanticCurrent = false;
        events.push("semantic:rollback");
        presenter.rollback(environment.lastToken);
        events.push("presenter:rollback");
        callbacks.push(args);
        throw new Error("contained");
      },
    });
    assert.deepEqual(present(environment, presenter, stimulus, oneBuilding()), COMMITTED);
    const canvas = environment.canvases[0];
    const retained = stimulus === "loss" ? () => canvas.dispatchLoss() : environment.observers[0].callback;
    if (stimulus === "loss") {
      const event = retained();
      assert.equal(event.defaultPrevented, false);
    } else {
      environment.host.width = 0;
      retained();
    }
    assert.deepEqual(events, ["controller:failure", "semantic:rollback", "presenter:rollback"]);
    assert.equal(semanticCurrent, false);
    assert.equal(environment.host.child, undefined);
    assert.equal(canvas.removeCount, 1);
    assert.equal(environment.observers[0].disconnected, 1);
    assert.equal(names(canvas.gl).filter((name) => name === "deleteProgram").length, 1);
    assert.equal(names(canvas.gl).filter((name) => name === "deleteBuffer").length, 3);
    assert.equal(names(canvas.gl).filter((name) => name === "deleteVertexArray").length, 1);
    assert.deepEqual(callbacks, [[stimulus, "Presentation failed", "M1-PRES-1"]]);
    presenter.rollback(environment.lastToken);
    retained();
    assert.equal(callbacks.length, 1);
    assert.equal(canvas.removeCount, 1);
  }
});

test("ineligible retained callbacks perform only local idempotent cleanup", () => {
  const environment = fakeEnvironment();
  let eligible = true;
  const { presenter, failures } = failuresCollector(environment, () => eligible);
  assert.deepEqual(present(environment, presenter, 1, oneBuilding()), COMMITTED);
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
    ["window target", { platform: { throwWindowTarget: true } }],
    ["document target", { platform: { throwDocumentTarget: true } }],
  ];
  for (const [id, setup] of cases) {
    const environment = fakeEnvironment(setup);
    const callbacks = [];
    const presenter = createCityPresenter({ host: environment.host, platform: environment.platform, isEligible: () => true, failed(...args) { callbacks.push([args, environment.host.child]); } });
    assert.deepEqual(present(environment, presenter, id, oneBuilding()), PRESENTATION_FAILURE, id);
    assert.equal(environment.host.child, undefined, id);
    assert.deepEqual(callbacks, [], id);
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
  assert.deepEqual(present(environment, presenter, 1, oneBuilding()), COMMITTED);
  const first = environment.canvases[0];
  environment.canvases.length = 0;
  environment.platform.createCanvas = () => { const canvas = new FakeCanvas(environment.host, { compileStatus: false }); environment.canvases.push(canvas); return canvas; };
  assert.deepEqual(present(environment, presenter, 2, oneBuilding()), PRESENTATION_FAILURE);
  assert.equal(first.removeCount, 1);
  assert.equal(environment.canvases[0].removeCount, 1);
  assert.deepEqual(callbacks, []);
});

test("cleanup contains release throws, attempts every resource, and skips driver deletes when actually lost", () => {
  {
    const environment = fakeEnvironment();
    const { presenter, failures } = failuresCollector(environment);
    assert.deepEqual(present(environment, presenter, 1, oneBuilding()), COMMITTED);
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
    assert.deepEqual(present(environment, presenter, 1, oneBuilding()), COMMITTED);
    const canvas = environment.canvases[0];
    const deletesBefore = names(canvas.gl).filter((name) => name.startsWith("delete")).length;
    canvas.gl.lost = true;
    presenter.dispose();
    assert.equal(names(canvas.gl).filter((name) => name.startsWith("delete")).length, deletesBefore);
    assert.equal(canvas.removeCount, 1);
  }
});

test("dispose remains terminal and every later validated-geometry call is a presentation failure", () => {
  const environment = fakeEnvironment();
  const { presenter, failures } = failuresCollector(environment);
  presenter.dispose(); presenter.dispose();
  assert.deepEqual(present(environment, presenter, 2, oneBuilding()), PRESENTATION_FAILURE);
  assert.deepEqual(failures, []);
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
    assert.deepEqual(present(environment, presenter, method, oneBuilding()), PRESENTATION_FAILURE, method);
    assert.equal(environment.host.child, undefined, method);
    assert.deepEqual(failures, [], method);
  }
});

test("eligibility, dimensions, and publication throws are fail-closed while false eligibility is stale", () => {
  const model = oneBuilding();
  {
    const environment = fakeEnvironment();
    const { presenter, failures } = failuresCollector(environment, () => { throw new Error("gate"); });
    assert.deepEqual(present(environment, presenter, 1, model), PRESENTATION_FAILURE);
    assert.deepEqual(failures, []);
    assert.equal(environment.canvases.length, 0);
  }
  {
    const environment = fakeEnvironment({ width: 0 });
    const { presenter } = failuresCollector(environment);
    assert.deepEqual(present(environment, presenter, 1, model), PRESENTATION_FAILURE);
    assert.equal(environment.canvases.length, 0);
  }
  {
    const environment = fakeEnvironment();
    environment.host.throwReplace = true;
    const { presenter } = failuresCollector(environment);
    assert.deepEqual(present(environment, presenter, 1, model), PRESENTATION_FAILURE);
    assert.equal(environment.canvases[0].removeCount, 1);
  }
  {
    const environment = fakeEnvironment();
    const { presenter, failures } = failuresCollector(environment, () => false);
    assert.deepEqual(present(environment, presenter, 1, model), STALE);
    assert.equal(environment.host.child, undefined);
    assert.equal(environment.canvases.length, 0);
    assert.deepEqual(failures, []);
  }
});
