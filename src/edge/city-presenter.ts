import type { ValidatedGeometry } from "../application/city-payload";
import {
  orbitCameraByKeyboard,
  orbitCameraByPointer,
  panCameraByKeyboard,
  panCameraByPointer,
  pickAtCanvasPoint,
  resetCamera,
  resizeCamera,
  zoomCamera,
  type CameraState,
  type CameraTransitionResult,
  type CameraView,
} from "../domain/camera-picking-policy";

const CUBE_POSITIONS = new Float32Array([
  0, 0, 0,
  1, 0, 0,
  1, 1, 0,
  0, 1, 0,
  0, 0, 1,
  1, 0, 1,
  1, 1, 1,
  0, 1, 1,
]);

const CUBE_INDICES = new Uint8Array([
  0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 4, 7, 0, 7, 3,
  1, 2, 6, 1, 6, 5, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2,
]);

const OUTLINE_INDICES = new Uint8Array([
  0, 1, 1, 2, 2, 3, 3, 0,
  4, 5, 5, 6, 6, 7, 7, 4,
  0, 4, 1, 5, 2, 6, 3, 7,
]);

const HOVER_INDICES = new Uint8Array([
  4, 5, 5, 6, 6, 7, 7, 4,
]);

const VERTEX_SHADER_SOURCE = `#version 300 es
precision highp float;

layout(location = 0) in vec3 a_unitPosition;
layout(location = 1) in vec3 a_targetRelativeMinimum;
layout(location = 2) in vec3 a_dimensions;
layout(location = 3) in vec4 a_color;

uniform mat4 u_clipFromTarget;

flat out vec4 v_color;

void main() {
  vec3 targetRelativePosition = a_targetRelativeMinimum + a_unitPosition * a_dimensions;
  gl_Position = u_clipFromTarget * vec4(targetRelativePosition, 1.0);
  v_color = a_color;
}
`;

const FRAGMENT_SHADER_SOURCE = `#version 300 es
precision highp float;

flat in vec4 v_color;
layout(location = 0) out vec4 o_color;

void main() {
  o_color = v_color;
}
`;

const OUTLINE_VERTEX_SHADER_SOURCE = `#version 300 es
precision highp float;

layout(location = 0) in vec3 a_unitPosition;
layout(location = 1) in vec3 a_targetRelativeMinimum;
layout(location = 2) in vec3 a_dimensions;

uniform mat4 u_clipFromTarget;

void main() {
  vec3 targetRelativePosition = a_targetRelativeMinimum + a_unitPosition * a_dimensions;
  gl_Position = u_clipFromTarget * vec4(targetRelativePosition, 1.0);
}
`;

const OUTLINE_FRAGMENT_SHADER_SOURCE = `#version 300 es
precision highp float;

layout(location = 0) out vec4 o_color;

void main() {
  o_color = vec4(0.0, 0.0, 0.0, 1.0);
}
`;

const HOVER_FRAGMENT_SHADER_SOURCE = `#version 300 es
precision highp float;

layout(location = 0) out vec4 o_color;

void main() {
  o_color = vec4(1.0, 0.0, 1.0, 1.0);
}
`;

const WEBGL2_CONTEXT_ATTRIBUTES = Object.freeze({
  alpha: false,
  antialias: false,
  depth: true,
  desynchronized: false,
  failIfMajorPerformanceCaveat: false,
  powerPreference: "default",
  premultipliedAlpha: false,
  preserveDrawingBuffer: false,
  stencil: false,
  xrCompatible: false,
}) satisfies WebGLContextAttributes;

export type PresentationFailureCategory = "Presentation failed";
export type PresentationFailureCode = "M1-PRES-1";
export type SelectionAction = "next" | "previous" | "first" | "last" | "clear";
export type PresenterEventSink<G> = Readonly<{
  hoverIndex(generation: G, index: number | null): void;
  activationIndex(generation: G, index: number | null): void;
  selectionAction(generation: G, action: SelectionAction): void;
}>;

declare const presenterTokenBrand: unique symbol;
export type PresenterToken = Readonly<{ readonly [presenterTokenBrand]: true }>;
export type PresenterStageResult =
  | Readonly<{ kind: "staged"; token: PresenterToken; canvas: PresenterCanvas }>
  | Readonly<{ kind: "stale" }>
  | Readonly<{ kind: "failure"; category: PresentationFailureCategory; code: PresentationFailureCode }>;
export type PresenterCommitResult = Readonly<{ kind: "committed" }> | Readonly<{ kind: "stale" }>;
export type PresenterVisualResult = Readonly<{ kind: "applied" }> | Readonly<{ kind: "stale" }>
  | Readonly<{ kind: "failure"; category: PresentationFailureCategory; code: PresentationFailureCode }>;
type ControllerFailureResult = Readonly<{ kind: "failure"; category: PresentationFailureCategory; code: PresentationFailureCode }>;

const COMMITTED: PresenterCommitResult = Object.freeze({ kind: "committed" });
const APPLIED: PresenterVisualResult = Object.freeze({ kind: "applied" });
const STALE = Object.freeze({ kind: "stale" }) as Readonly<{ kind: "stale" }>;
const PRESENTATION_FAILURE: ControllerFailureResult = Object.freeze({ kind: "failure", category: "Presentation failed", code: "M1-PRES-1" });

type LossListener = (event: Event) => void;
type KeyboardListener = (event: KeyboardEvent) => void;
type WheelListener = (event: WheelEvent) => void;
type PointerListener = (event: PointerEvent) => void;
type ContextMenuListener = (event: MouseEvent) => void;
type LifecycleListener = (event: Event) => void;
type ResetListener = (event: Event) => void;

type CanvasListenerMap = Readonly<{
  webglcontextlost: LossListener;
  keydown: KeyboardListener;
  wheel: WheelListener;
  pointerdown: PointerListener;
  pointermove: PointerListener;
  pointerup: PointerListener;
  pointercancel: PointerListener;
  pointerleave: PointerListener;
  lostpointercapture: PointerListener;
  contextmenu: ContextMenuListener;
}>;

export type PresenterCanvas = Pick<HTMLCanvasElement,
  "width" | "height" | "getContext" | "getBoundingClientRect" | "focus" | "remove" | "setAttribute"
  | "setPointerCapture" | "releasePointerCapture" | "tabIndex">
  & {
    addEventListener<K extends keyof CanvasListenerMap>(type: K, listener: CanvasListenerMap[K], options?: AddEventListenerOptions): void;
    removeEventListener<K extends keyof CanvasListenerMap>(type: K, listener: CanvasListenerMap[K]): void;
  };

export type PresenterWindow = {
  addEventListener(type: "blur" | "pagehide", listener: LifecycleListener): void;
  removeEventListener(type: "blur" | "pagehide", listener: LifecycleListener): void;
};

export type PresenterDocument = Readonly<{
  visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: LifecycleListener): void;
  removeEventListener(type: "visibilitychange", listener: LifecycleListener): void;
}>;

export type PresenterHost = Pick<HTMLElement, "clientWidth" | "clientHeight">;
export type PresenterResetControl = {
  addEventListener(type: "click", listener: ResetListener): void;
  removeEventListener(type: "click", listener: ResetListener): void;
};

export type PresenterResizeObserver = {
  observe(target: Element): void;
  disconnect(): void;
};

export type PresenterPlatform = Readonly<{
  createCanvas(): PresenterCanvas;
  createResizeObserver(callback: () => void): PresenterResizeObserver;
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(handle: number): void;
  windowTarget(): PresenterWindow;
  documentTarget(): PresenterDocument;
}>;

export type CityPresenterOptions<G> = Readonly<{
  host: PresenterHost;
  resetControl?: PresenterResetControl;
  isEligible(generation: G): boolean;
  failed(generation: G, category: PresentationFailureCategory, code: PresentationFailureCode): void;
  platform?: PresenterPlatform;
}>;

export type CityPresenter<G> = Readonly<{
  stage(generation: G, geometry: ValidatedGeometry, eventSink: PresenterEventSink<G>): PresenterStageResult;
  commit(token: PresenterToken): PresenterCommitResult;
  rollback(token: PresenterToken): void;
  setVisualState(generation: G, hover: number | null, selection: number | null): PresenterVisualResult;
  dispose(): void;
}>;

type Dimensions = Readonly<{ width: number; height: number }>;
type HoverPosition = Readonly<{ clientX: number; clientY: number }>;
type Gesture = {
  pointerId: number;
  button: 0 | 2;
  pressX: number;
  pressY: number;
  lastX: number;
  lastY: number;
  dragged: boolean;
  captureOwned: boolean;
};

type Session<G> = {
  generation?: G;
  token: PresenterToken;
  eventSink?: PresenterEventSink<G>;
  hover: number | null;
  selection: number | null;
  canvas?: PresenterCanvas;
  gl?: WebGL2RenderingContext;
  observer?: PresenterResizeObserver;
  lossListener?: LossListener;
  keyboardListener?: KeyboardListener;
  wheelListener?: WheelListener;
  pointerDownListener?: PointerListener;
  pointerMoveListener?: PointerListener;
  pointerUpListener?: PointerListener;
  pointerCancelListener?: PointerListener;
  pointerLeaveListener?: PointerListener;
  lostPointerCaptureListener?: PointerListener;
  contextMenuListener?: ContextMenuListener;
  blurListener?: LifecycleListener;
  visibilityListener?: LifecycleListener;
  pagehideListener?: LifecycleListener;
  windowTarget?: PresenterWindow;
  documentTarget?: PresenterDocument;
  resetListener?: ResetListener;
  resetControl?: PresenterResetControl;
  gesture?: Gesture;
  cameraState?: CameraState;
  cameraView?: CameraView;
  vertexShader?: WebGLShader;
  fragmentShader?: WebGLShader;
  program?: WebGLProgram;
  vao?: WebGLVertexArrayObject;
  positionBuffer?: WebGLBuffer;
  indexBuffer?: WebGLBuffer;
  instanceBuffer?: WebGLBuffer;
  uniform?: WebGLUniformLocation;
  outlineVertexShader?: WebGLShader;
  outlineFragmentShader?: WebGLShader;
  outlineProgram?: WebGLProgram;
  outlineVao?: WebGLVertexArrayObject;
  outlinePositionBuffer?: WebGLBuffer;
  outlineIndexBuffer?: WebGLBuffer;
  outlineInstanceBuffer?: WebGLBuffer;
  outlineUniform?: WebGLUniformLocation;
  hoverVertexShader?: WebGLShader;
  hoverFragmentShader?: WebGLShader;
  hoverProgram?: WebGLProgram;
  hoverVao?: WebGLVertexArrayObject;
  hoverPositionBuffer?: WebGLBuffer;
  hoverIndexBuffer?: WebGLBuffer;
  hoverInstanceBuffer?: WebGLBuffer;
  hoverUniform?: WebGLUniformLocation;
  staging?: Uint8Array;
  outlineStaging?: Uint8Array;
  hoverStaging?: Uint8Array;
  pointer?: HoverPosition;
  requestEpoch: number;
  pendingFrame?: number;
  cancelAnimationFrame: (handle: number) => void;
  model?: ValidatedGeometry;
  committed: boolean;
  active: boolean;
  notified: boolean;
};

const INSTANCE_STRIDE = 28;

// Trusted WebGL 2 values from the Khronos WebGL specification. Keeping these
// local closes the context data-property surface to drawing-buffer dimensions.
const NO_ERROR = 0;
const LINES = 0x0001;
const TRIANGLES = 0x0004;
const DEPTH_BUFFER_BIT = 0x0100;
const LESS = 0x0201;
const BACK = 0x0405;
const CCW = 0x0901;
const DITHER = 0x0bd0;
const BLEND = 0x0be2;
const CULL_FACE = 0x0b44;
const DEPTH_TEST = 0x0b71;
const STENCIL_TEST = 0x0b90;
const SCISSOR_TEST = 0x0c11;
const UNSIGNED_BYTE = 0x1401;
const FLOAT = 0x1406;
const COLOR_BUFFER_BIT = 0x4000;
const POLYGON_OFFSET_FILL = 0x8037;
const SAMPLE_ALPHA_TO_COVERAGE = 0x809e;
const SAMPLE_COVERAGE = 0x80a0;
const ARRAY_BUFFER = 0x8892;
const ELEMENT_ARRAY_BUFFER = 0x8893;
const STATIC_DRAW = 0x88e4;
const DYNAMIC_DRAW = 0x88e8;
const FRAGMENT_SHADER = 0x8b30;
const VERTEX_SHADER = 0x8b31;
const COMPILE_STATUS = 0x8b81;
const LINK_STATUS = 0x8b82;
const RASTERIZER_DISCARD = 0x8c89;

const browserPlatform: PresenterPlatform = Object.freeze({
  createCanvas: () => document.createElement("canvas"),
  createResizeObserver: (callback) => new ResizeObserver(callback),
  requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
  cancelAnimationFrame: (handle) => window.cancelAnimationFrame(handle),
  windowTarget: () => window,
  documentTarget: () => document,
});

function dimensions(host: PresenterHost): Dimensions {
  const width = host.clientWidth;
  const height = host.clientHeight;
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) throw new Error("Invalid presentation dimensions");
  return { width, height };
}

function sameDimensions(left: Dimensions, right: Dimensions): boolean {
  return left.width === right.width && left.height === right.height;
}

function hoverPosition(canvas: PresenterCanvas, clientX: number, clientY: number): HoverPosition | undefined {
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) throw new Error("Invalid pointer position");
  const rectangle = canvas.getBoundingClientRect();
  const right = rectangle.left + rectangle.width;
  const bottom = rectangle.top + rectangle.height;
  if (!Number.isFinite(rectangle.left) || !Number.isFinite(rectangle.top)
    || !Number.isFinite(rectangle.width) || rectangle.width <= 0
    || !Number.isFinite(rectangle.height) || rectangle.height <= 0
    || !Number.isFinite(right) || !Number.isFinite(bottom)) throw new Error("Invalid canvas rectangle");
  return clientX >= rectangle.left && clientX <= right && clientY >= rectangle.top && clientY <= bottom
    ? Object.freeze({ clientX, clientY })
    : undefined;
}

function requireNoError(gl: WebGL2RenderingContext): void {
  if (gl.isContextLost() || gl.getError() !== NO_ERROR) throw new Error("WebGL2 operation failed");
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string, own: (shader: WebGLShader) => void): WebGLShader {
  const shader = gl.createShader(type);
  if (shader !== null) own(shader);
  requireNoError(gl);
  if (shader === null) throw new Error("WebGL2 shader allocation failed");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  const compiled = gl.getShaderParameter(shader, COMPILE_STATUS);
  requireNoError(gl);
  if (compiled !== true) throw new Error("WebGL2 shader compilation failed");
  return shader;
}

function requireResource<T>(resource: T | null, gl: WebGL2RenderingContext, own: (resource: T) => void): T {
  if (resource !== null) own(resource);
  requireNoError(gl);
  if (resource === null) throw new Error("WebGL2 resource allocation failed");
  return resource;
}

function createInstanceStaging(model: ValidatedGeometry, centre: readonly number[]): Uint8Array {
  const staging = new Uint8Array(model.count * INSTANCE_STRIDE);
  const view = new DataView(staging.buffer);
  for (let index = 0; index < model.count; index += 1) {
    const vectorOffset = index * 3;
    const colourOffset = index * 4;
    const byteOffset = index * INSTANCE_STRIDE;
    for (let axis = 0; axis < 3; axis += 1) {
      const relative = model.origins[vectorOffset + axis]! - centre[axis]!;
      if (Math.fround(relative) !== relative) throw new Error("Inexact target-relative origin");
      view.setFloat32(byteOffset + axis * 4, relative, true);
      view.setFloat32(byteOffset + 12 + axis * 4, model.sizes[vectorOffset + axis]!, true);
    }
    for (let channel = 0; channel < 4; channel += 1) staging[byteOffset + 24 + channel] = model.rgba[colourOffset + channel]!;
  }
  return staging;
}

function draw(session: Session<unknown>, size: Dimensions, view: CameraView): void {
  const {
    canvas, gl, program, vao, uniform, model,
    outlineProgram, outlineVao, outlineUniform,
    hoverProgram, hoverVao, hoverUniform,
  } = session;
  if (!canvas || !gl || !program || !vao || !uniform || !model
    || !outlineProgram || !outlineVao || !outlineUniform
    || !hoverProgram || !hoverVao || !hoverUniform) {
    throw new Error("Incomplete presentation session");
  }
  if (canvas.width !== size.width || canvas.height !== size.height
    || gl.drawingBufferWidth !== size.width || gl.drawingBufferHeight !== size.height) throw new Error("WebGL2 drawing-buffer dimensions differ");
  requireNoError(gl);
  const matrix = new Float32Array(view.matrix);
  try {
    gl.clearColor(1, 1, 1, 1);
    gl.clearDepth(1);
    gl.colorMask(true, true, true, true);
    gl.depthMask(true);
    gl.enable(DEPTH_TEST);
    gl.depthFunc(LESS);
    gl.enable(CULL_FACE);
    gl.cullFace(BACK);
    gl.frontFace(CCW);
    gl.disable(BLEND);
    gl.disable(DITHER);
    gl.disable(STENCIL_TEST);
    gl.disable(SCISSOR_TEST);
    gl.disable(POLYGON_OFFSET_FILL);
    gl.disable(RASTERIZER_DISCARD);
    gl.disable(SAMPLE_COVERAGE);
    gl.disable(SAMPLE_ALPHA_TO_COVERAGE);
    gl.viewport(0, 0, size.width, size.height);
    gl.clear(COLOR_BUFFER_BIT | DEPTH_BUFFER_BIT);
    gl.useProgram(program);
    gl.bindVertexArray(vao);
    gl.uniformMatrix4fv(uniform, false, matrix);
    gl.drawElementsInstanced(TRIANGLES, 36, UNSIGNED_BYTE, 0, model.count);
    requireNoError(gl);
    if (session.selection !== null || session.hover !== null) {
      let cueFailed = false;
      let cueFailure: unknown;
      try {
        gl.disable(DEPTH_TEST);
        if (session.selection !== null) {
          gl.useProgram(outlineProgram);
          gl.bindVertexArray(outlineVao);
          gl.uniformMatrix4fv(outlineUniform, false, matrix);
          gl.drawElementsInstanced(LINES, 24, UNSIGNED_BYTE, 0, 1);
        }
        if (session.hover !== null) {
          gl.useProgram(hoverProgram);
          gl.bindVertexArray(hoverVao);
          gl.uniformMatrix4fv(hoverUniform, false, matrix);
          gl.drawElementsInstanced(LINES, 8, UNSIGNED_BYTE, 0, 1);
        }
      } catch (error) {
        cueFailed = true;
        cueFailure = error;
      }
      gl.enable(DEPTH_TEST);
      requireNoError(gl);
      if (cueFailed) throw cueFailure;
    }
  } finally {
    matrix.fill(0);
  }
}

function allocate<G>(session: Session<G>, size: Dimensions): void {
  const canvas = session.canvas!;
  canvas.width = size.width;
  canvas.height = size.height;
  const gl = canvas.getContext("webgl2", WEBGL2_CONTEXT_ATTRIBUTES) as WebGL2RenderingContext | null;
  if (gl === null) throw new Error("WebGL2 is unavailable");
  session.gl = gl;
  const attributes = gl.getContextAttributes();
  requireNoError(gl);
  if (attributes === null
    || attributes.alpha !== false
    || attributes.antialias !== false
    || attributes.depth !== true
    || attributes.premultipliedAlpha !== false
    || attributes.preserveDrawingBuffer !== false
    || attributes.stencil !== false) throw new Error("WebGL2 context attributes differ");

  session.vertexShader = compileShader(gl, VERTEX_SHADER, VERTEX_SHADER_SOURCE, (shader) => { session.vertexShader = shader; });
  session.fragmentShader = compileShader(gl, FRAGMENT_SHADER, FRAGMENT_SHADER_SOURCE, (shader) => { session.fragmentShader = shader; });
  session.program = requireResource(gl.createProgram(), gl, (program) => { session.program = program; });
  gl.attachShader(session.program, session.vertexShader);
  gl.attachShader(session.program, session.fragmentShader);
  gl.linkProgram(session.program);
  const linked = gl.getProgramParameter(session.program, LINK_STATUS);
  requireNoError(gl);
  if (linked !== true) throw new Error("WebGL2 program link failed");
  session.uniform = gl.getUniformLocation(session.program, "u_clipFromTarget") ?? undefined;
  requireNoError(gl);
  if (!session.uniform) throw new Error("WebGL2 uniform is unavailable");

  const vertexShader = session.vertexShader;
  session.vertexShader = undefined;
  gl.deleteShader(vertexShader);
  const fragmentShader = session.fragmentShader;
  session.fragmentShader = undefined;
  gl.deleteShader(fragmentShader);
  requireNoError(gl);

  session.vao = requireResource(gl.createVertexArray(), gl, (vao) => { session.vao = vao; });
  session.positionBuffer = requireResource(gl.createBuffer(), gl, (buffer) => { session.positionBuffer = buffer; });
  session.indexBuffer = requireResource(gl.createBuffer(), gl, (buffer) => { session.indexBuffer = buffer; });
  session.instanceBuffer = requireResource(gl.createBuffer(), gl, (buffer) => { session.instanceBuffer = buffer; });

  gl.bindVertexArray(session.vao);
  gl.bindBuffer(ARRAY_BUFFER, session.positionBuffer);
  gl.bufferData(ARRAY_BUFFER, CUBE_POSITIONS, STATIC_DRAW);
  requireNoError(gl);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, FLOAT, false, 0, 0);

  gl.bindBuffer(ELEMENT_ARRAY_BUFFER, session.indexBuffer);
  gl.bufferData(ELEMENT_ARRAY_BUFFER, CUBE_INDICES, STATIC_DRAW);
  requireNoError(gl);

  const initialCamera = resetCamera(session.model!.bounds, size);
  if (initialCamera.kind === "failure") throw new Error("Initial camera failed");
  session.cameraState = initialCamera.state;
  session.cameraView = initialCamera.view;
  session.staging = createInstanceStaging(session.model!, initialCamera.view.centre);
  gl.bindBuffer(ARRAY_BUFFER, session.instanceBuffer);
  gl.bufferData(ARRAY_BUFFER, session.staging, STATIC_DRAW);
  requireNoError(gl);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, FLOAT, false, INSTANCE_STRIDE, 0);
  gl.vertexAttribDivisor(1, 1);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 3, FLOAT, false, INSTANCE_STRIDE, 12);
  gl.vertexAttribDivisor(2, 1);
  gl.enableVertexAttribArray(3);
  gl.vertexAttribPointer(3, 4, UNSIGNED_BYTE, true, INSTANCE_STRIDE, 24);
  gl.vertexAttribDivisor(3, 1);
  requireNoError(gl);

  session.outlineVertexShader = compileShader(gl, VERTEX_SHADER, OUTLINE_VERTEX_SHADER_SOURCE, (shader) => { session.outlineVertexShader = shader; });
  session.outlineFragmentShader = compileShader(gl, FRAGMENT_SHADER, OUTLINE_FRAGMENT_SHADER_SOURCE, (shader) => { session.outlineFragmentShader = shader; });
  session.outlineProgram = requireResource(gl.createProgram(), gl, (program) => { session.outlineProgram = program; });
  gl.attachShader(session.outlineProgram, session.outlineVertexShader);
  gl.attachShader(session.outlineProgram, session.outlineFragmentShader);
  gl.linkProgram(session.outlineProgram);
  const outlineLinked = gl.getProgramParameter(session.outlineProgram, LINK_STATUS);
  requireNoError(gl);
  if (outlineLinked !== true) throw new Error("WebGL2 outline program link failed");
  session.outlineUniform = gl.getUniformLocation(session.outlineProgram, "u_clipFromTarget") ?? undefined;
  requireNoError(gl);
  if (!session.outlineUniform) throw new Error("WebGL2 outline uniform is unavailable");

  const outlineVertexShader = session.outlineVertexShader;
  session.outlineVertexShader = undefined;
  gl.deleteShader(outlineVertexShader);
  const outlineFragmentShader = session.outlineFragmentShader;
  session.outlineFragmentShader = undefined;
  gl.deleteShader(outlineFragmentShader);
  requireNoError(gl);

  session.outlineVao = requireResource(gl.createVertexArray(), gl, (vao) => { session.outlineVao = vao; });
  session.outlinePositionBuffer = requireResource(gl.createBuffer(), gl, (buffer) => { session.outlinePositionBuffer = buffer; });
  session.outlineIndexBuffer = requireResource(gl.createBuffer(), gl, (buffer) => { session.outlineIndexBuffer = buffer; });
  session.outlineInstanceBuffer = requireResource(gl.createBuffer(), gl, (buffer) => { session.outlineInstanceBuffer = buffer; });
  session.outlineStaging = new Uint8Array(24);

  gl.bindVertexArray(session.outlineVao);
  gl.bindBuffer(ARRAY_BUFFER, session.outlinePositionBuffer);
  gl.bufferData(ARRAY_BUFFER, CUBE_POSITIONS, STATIC_DRAW);
  requireNoError(gl);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, FLOAT, false, 0, 0);
  gl.bindBuffer(ELEMENT_ARRAY_BUFFER, session.outlineIndexBuffer);
  gl.bufferData(ELEMENT_ARRAY_BUFFER, OUTLINE_INDICES, STATIC_DRAW);
  requireNoError(gl);
  gl.bindBuffer(ARRAY_BUFFER, session.outlineInstanceBuffer);
  gl.bufferData(ARRAY_BUFFER, session.outlineStaging, DYNAMIC_DRAW);
  requireNoError(gl);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, FLOAT, false, 24, 0);
  gl.vertexAttribDivisor(1, 1);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 3, FLOAT, false, 24, 12);
  gl.vertexAttribDivisor(2, 1);
  requireNoError(gl);

  session.hoverVertexShader = compileShader(gl, VERTEX_SHADER, OUTLINE_VERTEX_SHADER_SOURCE, (shader) => { session.hoverVertexShader = shader; });
  session.hoverFragmentShader = compileShader(gl, FRAGMENT_SHADER, HOVER_FRAGMENT_SHADER_SOURCE, (shader) => { session.hoverFragmentShader = shader; });
  session.hoverProgram = requireResource(gl.createProgram(), gl, (program) => { session.hoverProgram = program; });
  gl.attachShader(session.hoverProgram, session.hoverVertexShader);
  gl.attachShader(session.hoverProgram, session.hoverFragmentShader);
  gl.linkProgram(session.hoverProgram);
  const hoverLinked = gl.getProgramParameter(session.hoverProgram, LINK_STATUS);
  requireNoError(gl);
  if (hoverLinked !== true) throw new Error("WebGL2 hover program link failed");
  session.hoverUniform = gl.getUniformLocation(session.hoverProgram, "u_clipFromTarget") ?? undefined;
  requireNoError(gl);
  if (!session.hoverUniform) throw new Error("WebGL2 hover uniform is unavailable");

  const hoverVertexShader = session.hoverVertexShader;
  session.hoverVertexShader = undefined;
  gl.deleteShader(hoverVertexShader);
  const hoverFragmentShader = session.hoverFragmentShader;
  session.hoverFragmentShader = undefined;
  gl.deleteShader(hoverFragmentShader);
  requireNoError(gl);

  session.hoverVao = requireResource(gl.createVertexArray(), gl, (vao) => { session.hoverVao = vao; });
  session.hoverPositionBuffer = requireResource(gl.createBuffer(), gl, (buffer) => { session.hoverPositionBuffer = buffer; });
  session.hoverIndexBuffer = requireResource(gl.createBuffer(), gl, (buffer) => { session.hoverIndexBuffer = buffer; });
  session.hoverInstanceBuffer = requireResource(gl.createBuffer(), gl, (buffer) => { session.hoverInstanceBuffer = buffer; });
  session.hoverStaging = new Uint8Array(24);

  gl.bindVertexArray(session.hoverVao);
  gl.bindBuffer(ARRAY_BUFFER, session.hoverPositionBuffer);
  gl.bufferData(ARRAY_BUFFER, CUBE_POSITIONS, STATIC_DRAW);
  requireNoError(gl);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, FLOAT, false, 0, 0);
  gl.bindBuffer(ELEMENT_ARRAY_BUFFER, session.hoverIndexBuffer);
  gl.bufferData(ELEMENT_ARRAY_BUFFER, HOVER_INDICES, STATIC_DRAW);
  requireNoError(gl);
  gl.bindBuffer(ARRAY_BUFFER, session.hoverInstanceBuffer);
  gl.bufferData(ARRAY_BUFFER, session.hoverStaging, DYNAMIC_DRAW);
  requireNoError(gl);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, FLOAT, false, 24, 0);
  gl.vertexAttribDivisor(1, 1);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 3, FLOAT, false, 24, 12);
  gl.vertexAttribDivisor(2, 1);
  requireNoError(gl);
  draw(session as Session<unknown>, size, initialCamera.view);
}

function updateCue(session: Session<unknown>, index: number, kind: "selection" | "hover"): void {
  const { gl, staging } = session;
  const instanceBuffer = kind === "selection" ? session.outlineInstanceBuffer : session.hoverInstanceBuffer;
  const cueStaging = kind === "selection" ? session.outlineStaging : session.hoverStaging;
  if (!gl || !instanceBuffer || !cueStaging || !staging) throw new Error(`Incomplete ${kind} cue`);
  const byteOffset = index * INSTANCE_STRIDE;
  cueStaging.set(staging.subarray(byteOffset, byteOffset + 24));
  try {
    gl.bindBuffer(ARRAY_BUFFER, instanceBuffer);
    gl.bufferSubData(ARRAY_BUFFER, 0, cueStaging);
    requireNoError(gl);
  } catch (error) {
    cueStaging.fill(0);
    throw error;
  }
}

function releaseGesture<G>(session: Session<G>): void {
  const gesture = session.gesture;
  session.gesture = undefined;
  if (!gesture?.captureOwned) return;
  gesture.captureOwned = false;
  session.canvas?.releasePointerCapture(gesture.pointerId);
}

function cleanup<G>(session: Session<G>): boolean {
  if (!session.active) return true;
  session.active = false;
  session.requestEpoch += 1;
  let complete = true;
  const pendingFrame = session.pendingFrame;
  session.pendingFrame = undefined;
  try { if (pendingFrame !== undefined) session.cancelAnimationFrame(pendingFrame); } catch { complete = false; }
  try { releaseGesture(session); } catch { complete = false; }
  const observer = session.observer;
  session.observer = undefined;
  try { observer?.disconnect(); } catch { complete = false; }
  const canvas = session.canvas;
  const lossListener = session.lossListener;
  const keyboardListener = session.keyboardListener;
  const wheelListener = session.wheelListener;
  const pointerDownListener = session.pointerDownListener;
  const pointerMoveListener = session.pointerMoveListener;
  const pointerUpListener = session.pointerUpListener;
  const pointerCancelListener = session.pointerCancelListener;
  const pointerLeaveListener = session.pointerLeaveListener;
  const lostPointerCaptureListener = session.lostPointerCaptureListener;
  const contextMenuListener = session.contextMenuListener;
  const blurListener = session.blurListener;
  const visibilityListener = session.visibilityListener;
  const pagehideListener = session.pagehideListener;
  const windowTarget = session.windowTarget;
  const documentTarget = session.documentTarget;
  const resetListener = session.resetListener;
  const resetControl = session.resetControl;
  session.lossListener = undefined;
  session.keyboardListener = undefined;
  session.wheelListener = undefined;
  session.pointerDownListener = undefined;
  session.pointerMoveListener = undefined;
  session.pointerUpListener = undefined;
  session.pointerCancelListener = undefined;
  session.pointerLeaveListener = undefined;
  session.lostPointerCaptureListener = undefined;
  session.contextMenuListener = undefined;
  session.blurListener = undefined;
  session.visibilityListener = undefined;
  session.pagehideListener = undefined;
  session.windowTarget = undefined;
  session.documentTarget = undefined;
  session.resetListener = undefined;
  session.resetControl = undefined;
  try { if (canvas && lossListener) canvas.removeEventListener("webglcontextlost", lossListener); } catch { complete = false; }
  try { if (canvas && keyboardListener) canvas.removeEventListener("keydown", keyboardListener); } catch { complete = false; }
  try { if (canvas && wheelListener) canvas.removeEventListener("wheel", wheelListener); } catch { complete = false; }
  try { if (canvas && pointerDownListener) canvas.removeEventListener("pointerdown", pointerDownListener); } catch { complete = false; }
  try { if (canvas && pointerMoveListener) canvas.removeEventListener("pointermove", pointerMoveListener); } catch { complete = false; }
  try { if (canvas && pointerUpListener) canvas.removeEventListener("pointerup", pointerUpListener); } catch { complete = false; }
  try { if (canvas && pointerCancelListener) canvas.removeEventListener("pointercancel", pointerCancelListener); } catch { complete = false; }
  try { if (canvas && pointerLeaveListener) canvas.removeEventListener("pointerleave", pointerLeaveListener); } catch { complete = false; }
  try { if (canvas && lostPointerCaptureListener) canvas.removeEventListener("lostpointercapture", lostPointerCaptureListener); } catch { complete = false; }
  try { if (canvas && contextMenuListener) canvas.removeEventListener("contextmenu", contextMenuListener); } catch { complete = false; }
  try { if (windowTarget && blurListener) windowTarget.removeEventListener("blur", blurListener); } catch { complete = false; }
  try { if (documentTarget && visibilityListener) documentTarget.removeEventListener("visibilitychange", visibilityListener); } catch { complete = false; }
  try { if (windowTarget && pagehideListener) windowTarget.removeEventListener("pagehide", pagehideListener); } catch { complete = false; }
  try { if (resetControl && resetListener) resetControl.removeEventListener("click", resetListener); } catch { complete = false; }

  const gl = session.gl;
  let actuallyLost = false;
  if (gl) {
    try { actuallyLost = gl.isContextLost(); } catch { complete = false; }
  }
  if (gl && !actuallyLost) {
    const releases: Array<(() => void) | undefined> = [
      session.vertexShader && (() => gl.deleteShader(session.vertexShader!)),
      session.fragmentShader && (() => gl.deleteShader(session.fragmentShader!)),
      session.program && (() => gl.deleteProgram(session.program!)),
      session.positionBuffer && (() => gl.deleteBuffer(session.positionBuffer!)),
      session.indexBuffer && (() => gl.deleteBuffer(session.indexBuffer!)),
      session.instanceBuffer && (() => gl.deleteBuffer(session.instanceBuffer!)),
      session.vao && (() => gl.deleteVertexArray(session.vao!)),
      session.outlineVertexShader && (() => gl.deleteShader(session.outlineVertexShader!)),
      session.outlineFragmentShader && (() => gl.deleteShader(session.outlineFragmentShader!)),
      session.outlineProgram && (() => gl.deleteProgram(session.outlineProgram!)),
      session.outlinePositionBuffer && (() => gl.deleteBuffer(session.outlinePositionBuffer!)),
      session.outlineIndexBuffer && (() => gl.deleteBuffer(session.outlineIndexBuffer!)),
      session.outlineInstanceBuffer && (() => gl.deleteBuffer(session.outlineInstanceBuffer!)),
      session.outlineVao && (() => gl.deleteVertexArray(session.outlineVao!)),
      session.hoverVertexShader && (() => gl.deleteShader(session.hoverVertexShader!)),
      session.hoverFragmentShader && (() => gl.deleteShader(session.hoverFragmentShader!)),
      session.hoverProgram && (() => gl.deleteProgram(session.hoverProgram!)),
      session.hoverPositionBuffer && (() => gl.deleteBuffer(session.hoverPositionBuffer!)),
      session.hoverIndexBuffer && (() => gl.deleteBuffer(session.hoverIndexBuffer!)),
      session.hoverInstanceBuffer && (() => gl.deleteBuffer(session.hoverInstanceBuffer!)),
      session.hoverVao && (() => gl.deleteVertexArray(session.hoverVao!)),
    ];
    for (const release of releases) {
      try { release?.(); } catch { complete = false; }
    }
  }
  try { canvas?.remove(); } catch { complete = false; }
  session.staging?.fill(0);
  session.outlineStaging?.fill(0);
  session.canvas = undefined;
  session.gl = undefined;
  session.vertexShader = undefined;
  session.fragmentShader = undefined;
  session.program = undefined;
  session.vao = undefined;
  session.positionBuffer = undefined;
  session.indexBuffer = undefined;
  session.instanceBuffer = undefined;
  session.uniform = undefined;
  session.outlineVertexShader = undefined;
  session.outlineFragmentShader = undefined;
  session.outlineProgram = undefined;
  session.outlineVao = undefined;
  session.outlinePositionBuffer = undefined;
  session.outlineIndexBuffer = undefined;
  session.outlineInstanceBuffer = undefined;
  session.outlineUniform = undefined;
  session.hoverVertexShader = undefined;
  session.hoverFragmentShader = undefined;
  session.hoverProgram = undefined;
  session.hoverVao = undefined;
  session.hoverPositionBuffer = undefined;
  session.hoverIndexBuffer = undefined;
  session.hoverInstanceBuffer = undefined;
  session.hoverUniform = undefined;
  session.staging = undefined;
  session.outlineStaging = undefined;
  session.hoverStaging = undefined;
  session.pointer = undefined;
  session.model = undefined;
  session.eventSink = undefined;
  session.cameraState = undefined;
  session.cameraView = undefined;
  session.generation = undefined;
  session.hover = null;
  session.selection = null;
  session.committed = false;
  return complete;
}

export function createCityPresenter<G>(options: CityPresenterOptions<G>): CityPresenter<G> {
  const { host, resetControl, isEligible, failed } = options;
  const platform = options.platform ?? browserPlatform;
  const sessions = new Map<PresenterToken, Session<G>>();
  let current: Session<G> | undefined;
  let disposed = false;

  const notify = (session: Session<G>, generation: G): void => {
    if (session.notified) return;
    session.notified = true;
    try { failed(generation, "Presentation failed", "M1-PRES-1"); } catch {}
  };

  const removeSession = (session: Session<G>): boolean => {
    sessions.delete(session.token);
    if (current === session) current = undefined;
    return cleanup(session);
  };

  const failSession = (session: Session<G>): void => {
    if (!session.active) return;
    const generation = session.generation!;
    if (session.committed) {
      notify(session, generation);
      if (session.active) removeSession(session);
      return;
    }
    removeSession(session);
    notify(session, generation);
  };

  const eligible = (session: Session<G>): boolean => {
    try { return isEligible(session.generation!); } catch { failSession(session); return false; }
  };

  const callbackEligible = (session: Session<G>): boolean => {
    if (!session.active) return false;
    if (!eligible(session)) {
      if (session.active) removeSession(session);
      return false;
    }
    return session.committed && current === session;
  };

  const invalidateHover = (session: Session<G>): void => {
    session.requestEpoch += 1;
    const pendingFrame = session.pendingFrame;
    session.pendingFrame = undefined;
    if (pendingFrame !== undefined) session.cancelAnimationFrame(pendingFrame);
  };

  const clearHover = (session: Session<G>, forgetPointer = false): void => {
    invalidateHover(session);
    if (forgetPointer) session.pointer = undefined;
    if (session.hover !== null && callbackEligible(session)) session.eventSink!.hoverIndex(session.generation!, null);
  };

  const queueHover = (session: Session<G>): void => {
    if (!callbackEligible(session) || session.gesture || !session.pointer || session.pendingFrame !== undefined) return;
    const epoch = session.requestEpoch;
    const generation = session.generation!;
    const token = session.token;
    let frame = -1;
    frame = platform.requestAnimationFrame(() => {
      if (!session.active || current !== session || !session.committed
        || session.generation !== generation || session.token !== token
        || session.requestEpoch !== epoch || session.pendingFrame !== frame) return;
      session.pendingFrame = undefined;
      try {
        if (!callbackEligible(session) || session.requestEpoch !== epoch || session.gesture || !session.pointer) return;
        const position = session.pointer;
        const picked = pickAtCanvasPoint(
          session.cameraView!,
          position.clientX,
          position.clientY,
          session.canvas!.getBoundingClientRect(),
          { width: session.canvas!.width, height: session.canvas!.height },
          session.model!,
        );
        if (picked.kind === "failure") {
          if (session.active && current === session && session.requestEpoch === epoch) failSession(session);
          return;
        }
        if (callbackEligible(session) && session.requestEpoch === epoch && !session.gesture && session.pointer === position) {
          session.eventSink!.hoverIndex(generation, picked.index);
        }
      } catch {
        if (session.active && current === session && session.requestEpoch === epoch) failSession(session);
      }
    });
    if (!Number.isInteger(frame) || frame < 0) throw new Error("Invalid animation-frame handle");
    session.pendingFrame = frame;
  };

  const applyCamera = (session: Session<G>, transition: CameraTransitionResult, size: Dimensions): void => {
    if (transition.kind === "failure") {
      failSession(session);
      return;
    }
    draw(session as Session<unknown>, size, transition.view);
    session.cameraState = transition.state;
    session.cameraView = transition.view;
  };

  const applyCameraAndRenewHover = (session: Session<G>, transition: CameraTransitionResult, size: Dimensions): void => {
    clearHover(session);
    if (!session.active) return;
    applyCamera(session, transition, size);
    if (session.active) queueHover(session);
  };

  const installCallbacks = (session: Session<G>): void => {
    const canvas = session.canvas!;
    const lossListener: LossListener = () => {
      try {
        if (!session.active) return;
        if (!eligible(session)) { removeSession(session); return; }
        failSession(session);
      } catch {}
    };
    const keyboardListener: KeyboardListener = (event) => {
      try {
        if (!callbackEligible(session) || event.ctrlKey || event.altKey || event.metaKey) return;
        const selectionAction: SelectionAction | undefined = event.key === "ArrowRight" || event.key === "ArrowDown"
          ? "next"
          : event.key === "ArrowLeft" || event.key === "ArrowUp"
            ? "previous"
            : event.key === "Home"
              ? "first"
              : event.key === "End"
                ? "last"
                : event.key === "Escape"
                  ? "clear"
                  : undefined;
        if (selectionAction) {
          if (event.shiftKey) return;
          event.preventDefault();
          session.eventSink!.selectionAction(session.generation!, selectionAction);
          return;
        }
        const size = dimensions(host);
        let transition: CameraTransitionResult | undefined;
        if (!event.shiftKey && (event.key === "w" || event.key === "a" || event.key === "s" || event.key === "d")) {
          transition = orbitCameraByKeyboard(session.cameraState!, session.model!.bounds, size, event.key);
        } else if (event.shiftKey && (event.key === "W" || event.key === "A" || event.key === "S" || event.key === "D")) {
          transition = panCameraByKeyboard(session.cameraState!, session.model!.bounds, size, event.key);
        } else if (event.key === "+") {
          transition = zoomCamera(session.cameraState!, session.model!.bounds, size, "in");
        } else if (event.key === "-") {
          transition = zoomCamera(session.cameraState!, session.model!.bounds, size, "out");
        } else if (event.key === "0") {
          transition = resetCamera(session.model!.bounds, size);
        }
        if (!transition) return;
        event.preventDefault();
        applyCameraAndRenewHover(session, transition, size);
      } catch {
        failSession(session);
      }
    };
    const wheelListener: WheelListener = (event) => {
      try {
        if (!callbackEligible(session) || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.deltaY === 0) return;
        const direction = event.deltaY < 0 ? "in" : event.deltaY > 0 ? "out" : undefined;
        if (!direction) return;
        event.preventDefault();
        const size = dimensions(host);
        applyCameraAndRenewHover(session, zoomCamera(session.cameraState!, session.model!.bounds, size, direction), size);
      } catch {
        failSession(session);
      }
    };
    const pointerDownListener: PointerListener = (event) => {
      try {
        if (!callbackEligible(session) || session.gesture || (event.button !== 0 && event.button !== 2)) return;
        if (!Number.isInteger(event.pointerId)) throw new Error("Invalid pointer press");
        session.pointer = hoverPosition(canvas, event.clientX, event.clientY);
        clearHover(session);
        if (!session.active) return;
        event.preventDefault();
        canvas.focus();
        const gesture: Gesture = {
          pointerId: event.pointerId,
          button: event.button,
          pressX: event.clientX,
          pressY: event.clientY,
          lastX: event.clientX,
          lastY: event.clientY,
          dragged: false,
          captureOwned: false,
        };
        session.gesture = gesture;
        canvas.setPointerCapture(event.pointerId);
        gesture.captureOwned = true;
      } catch {
        failSession(session);
      }
    };
    const pointerMoveListener: PointerListener = (event) => {
      try {
        if (!callbackEligible(session)) return;
        const gesture = session.gesture;
        if (gesture && event.pointerId !== gesture.pointerId) return;
        session.pointer = hoverPosition(canvas, event.clientX, event.clientY);
        if (!gesture) {
          queueHover(session);
          return;
        }
        if (event.clientX !== gesture.pressX || event.clientY !== gesture.pressY) gesture.dragged = true;
        const dx = event.clientX - gesture.lastX;
        const dy = event.clientY - gesture.lastY;
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new Error("Invalid pointer delta");
        if (dx === 0 && dy === 0) return;
        const rectangle = canvas.getBoundingClientRect();
        const size = dimensions(host);
        const transition = gesture.button === 0
          ? orbitCameraByPointer(session.cameraState!, session.model!.bounds, size, dx, dy, rectangle.width, rectangle.height)
          : panCameraByPointer(session.cameraState!, session.model!.bounds, size, dx, dy, rectangle.width, rectangle.height);
        applyCameraAndRenewHover(session, transition, size);
        if (!session.active) return;
        gesture.lastX = event.clientX;
        gesture.lastY = event.clientY;
      } catch {
        failSession(session);
      }
    };
    const pointerUpListener: PointerListener = (event) => {
      try {
        if (!callbackEligible(session)) return;
        const gesture = session.gesture;
        if (!gesture || event.pointerId !== gesture.pointerId || event.button !== gesture.button) return;
        session.pointer = hoverPosition(canvas, event.clientX, event.clientY);
        if (event.clientX !== gesture.pressX || event.clientY !== gesture.pressY) gesture.dragged = true;
        const activates = gesture.button === 0 && !gesture.dragged
          && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
        releaseGesture(session);
        if (activates && callbackEligible(session)) {
          const picked = pickAtCanvasPoint(
            session.cameraView!,
            event.clientX,
            event.clientY,
            canvas.getBoundingClientRect(),
            { width: canvas.width, height: canvas.height },
            session.model!,
          );
          if (picked.kind === "failure") {
            failSession(session);
            return;
          }
          if (callbackEligible(session)) session.eventSink!.activationIndex(session.generation!, picked.index);
        }
        if (session.active) queueHover(session);
      } catch {
        failSession(session);
      }
    };
    const pointerCancelListener: PointerListener = (event) => {
      try {
        if (!callbackEligible(session)) return;
        if (session.gesture?.pointerId !== event.pointerId) return;
        releaseGesture(session);
        if (session.active) queueHover(session);
      } catch {
        failSession(session);
      }
    };
    const lostPointerCaptureListener: PointerListener = (event) => {
      try {
        if (!callbackEligible(session)) return;
        const gesture = session.gesture;
        if (!gesture || gesture.pointerId !== event.pointerId || !gesture.captureOwned) return;
        gesture.captureOwned = false;
        session.gesture = undefined;
        queueHover(session);
      } catch {
        failSession(session);
      }
    };
    const pointerLeaveListener: PointerListener = () => {
      try {
        if (!callbackEligible(session)) return;
        clearHover(session, true);
      } catch {
        failSession(session);
      }
    };
    const contextMenuListener: ContextMenuListener = (event) => {
      try {
        if (callbackEligible(session)) event.preventDefault();
      } catch {
        failSession(session);
      }
    };
    const interrupt = (): void => {
      try {
        if (!session.active) return;
        if (!eligible(session)) { if (session.active) removeSession(session); return; }
        releaseGesture(session);
        if (session.active) queueHover(session);
      } catch {
        failSession(session);
      }
    };
    const blurListener: LifecycleListener = () => interrupt();
    const visibilityListener: LifecycleListener = () => {
      try {
        if (session.documentTarget?.visibilityState === "hidden") interrupt();
      } catch {
        failSession(session);
      }
    };
    const pagehideListener: LifecycleListener = () => interrupt();
    const resetListener: ResetListener = () => {
      try {
        if (!callbackEligible(session)) return;
        releaseGesture(session);
        const size = dimensions(host);
        applyCameraAndRenewHover(session, resetCamera(session.model!.bounds, size), size);
      } catch {
        failSession(session);
      }
    };
    session.windowTarget = platform.windowTarget();
    session.documentTarget = platform.documentTarget();
    session.lossListener = lossListener;
    session.keyboardListener = keyboardListener;
    session.wheelListener = wheelListener;
    session.pointerDownListener = pointerDownListener;
    session.pointerMoveListener = pointerMoveListener;
    session.pointerUpListener = pointerUpListener;
    session.pointerCancelListener = pointerCancelListener;
    session.pointerLeaveListener = pointerLeaveListener;
    session.lostPointerCaptureListener = lostPointerCaptureListener;
    session.contextMenuListener = contextMenuListener;
    session.blurListener = blurListener;
    session.visibilityListener = visibilityListener;
    session.pagehideListener = pagehideListener;
    session.resetListener = resetListener;
    canvas.addEventListener("webglcontextlost", lossListener, { passive: true, once: true });
    canvas.addEventListener("keydown", keyboardListener);
    canvas.addEventListener("wheel", wheelListener, { passive: false });
    canvas.addEventListener("pointerdown", pointerDownListener);
    canvas.addEventListener("pointermove", pointerMoveListener);
    canvas.addEventListener("pointerup", pointerUpListener);
    canvas.addEventListener("pointercancel", pointerCancelListener);
    canvas.addEventListener("pointerleave", pointerLeaveListener);
    canvas.addEventListener("lostpointercapture", lostPointerCaptureListener);
    canvas.addEventListener("contextmenu", contextMenuListener);
    session.windowTarget.addEventListener("blur", blurListener);
    session.documentTarget.addEventListener("visibilitychange", visibilityListener);
    session.windowTarget.addEventListener("pagehide", pagehideListener);
    resetControl?.addEventListener("click", resetListener);
  };

  const observe = (session: Session<G>): void => {
    session.observer = platform.createResizeObserver(() => {
      try {
        if (!session.active) return;
        if (!eligible(session)) { removeSession(session); return; }
        releaseGesture(session);
        const next = dimensions(host);
        const canvas = session.canvas!;
        if (canvas.width === next.width && canvas.height === next.height) return;
        const transition = resizeCamera(session.cameraState!, session.model!.bounds, next);
        if (transition.kind === "failure") { failSession(session); return; }
        canvas.width = next.width;
        canvas.height = next.height;
        clearHover(session);
        if (!session.active) return;
        applyCamera(session, transition, next);
        if (session.active) queueHover(session);
      } catch {
        failSession(session);
      }
    });
    session.observer.observe(host as Element);
  };

  return Object.freeze({
    stage(generation: G, model: ValidatedGeometry, eventSink: PresenterEventSink<G>): PresenterStageResult {
      if (disposed) return PRESENTATION_FAILURE;
      const affected = current;
      let candidate: Session<G> | undefined;
      try {
        if (!isEligible(generation)) return STALE;
        const initial = dimensions(host);
        const canvas = platform.createCanvas();
        const token = Object.freeze({}) as PresenterToken;
        candidate = {
          generation,
          token,
          hover: null,
          selection: null,
          canvas,
          model,
          resetControl,
          requestEpoch: 0,
          cancelAnimationFrame: (handle) => platform.cancelAnimationFrame(handle),
          committed: false,
          active: true,
          notified: false,
        };
        const callbackEligible = (callbackGeneration: G): boolean => candidate!.active
          && candidate!.committed
          && current === candidate
          && candidate!.token === token
          && candidate!.generation === callbackGeneration;
        candidate.eventSink = Object.freeze({
          hoverIndex(callbackGeneration, index) {
            if (callbackEligible(callbackGeneration)) eventSink.hoverIndex(generation, index);
          },
          activationIndex(callbackGeneration, index) {
            if (callbackEligible(callbackGeneration)) eventSink.activationIndex(generation, index);
          },
          selectionAction(callbackGeneration, action) {
            if (callbackEligible(callbackGeneration)) eventSink.selectionAction(generation, action);
          },
        });
        canvas.tabIndex = 0;
        canvas.setAttribute("aria-label", "Interactive code city");
        canvas.setAttribute("aria-describedby", "city-navigation-instructions");
        sessions.set(token, candidate);
        installCallbacks(candidate);
        allocate(candidate, initial);
        observe(candidate);
        const finalSize = dimensions(host);
        if (!sameDimensions(initial, finalSize)) {
          const transition = resizeCamera(candidate.cameraState!, model.bounds, finalSize);
          if (transition.kind === "failure") throw new Error("Final camera resize failed");
          canvas.width = finalSize.width;
          canvas.height = finalSize.height;
          applyCamera(candidate, transition, finalSize);
          if (!candidate.active) return STALE;
        }
        if (!candidate.active) return STALE;
        return Object.freeze({ kind: "staged", token, canvas });
      } catch {
        if (candidate) removeSession(candidate);
        if (affected && current === affected) removeSession(affected);
        return PRESENTATION_FAILURE;
      }
    },
    commit(token: PresenterToken): PresenterCommitResult {
      const candidate = sessions.get(token);
      if (disposed || !candidate?.active || candidate.committed) return STALE;
      const affected = current;
      candidate.committed = true;
      current = candidate;
      if (affected && affected !== candidate && !removeSession(affected)) {
        removeSession(candidate);
        throw new Error("Presentation teardown failed");
      }
      return COMMITTED;
    },
    rollback(token: PresenterToken): void {
      const candidate = sessions.get(token);
      if (candidate) removeSession(candidate);
    },
    setVisualState(generation: G, hover: number | null, selection: number | null): PresenterVisualResult {
      const session = current;
      if (!session?.active || !session.committed || session.generation !== generation) return STALE;
      if (!eligible(session)) {
        if (session.active) removeSession(session);
        return STALE;
      }
      const count = session.model!.count;
      const valid = (index: number | null): boolean => index === null || (Number.isSafeInteger(index) && index >= 0 && index < count);
      if (!valid(hover) || !valid(selection)) {
        failSession(session);
        return PRESENTATION_FAILURE;
      }
      try {
        const selectionChanged = selection !== session.selection;
        const hoverChanged = hover !== session.hover;
        if (selectionChanged && selection !== null) updateCue(session as Session<unknown>, selection, "selection");
        if (hoverChanged && hover !== null) updateCue(session as Session<unknown>, hover, "hover");
        session.selection = selection;
        session.hover = hover;
        if (selectionChanged || hoverChanged) {
          const size = dimensions(host);
          draw(session as Session<unknown>, size, session.cameraView!);
        }
        return APPLIED;
      } catch {
        failSession(session);
        return PRESENTATION_FAILURE;
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const session of [...sessions.values()]) removeSession(session);
    },
  });
}
