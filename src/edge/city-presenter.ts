import type { NumericPresentation, ValidatedGeometry } from "../application/city-payload";
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

// Face-local vertices keep both fixed display branches in the trusted shader
// while every plate and building remains one instance in its fixed pass. The
// fourth component is the face class: 0 = ±Z/-Y, 1 = ±X, 2 = +Y.
const CUBE_VERTEX_DATA = new Float32Array([
  0, 0, 0, 0,  0, 1, 0, 0,  1, 1, 0, 0,  1, 0, 0, 0,
  0, 0, 1, 0,  1, 0, 1, 0,  1, 1, 1, 0,  0, 1, 1, 0,
  0, 0, 0, 1,  0, 0, 1, 1,  0, 1, 1, 1,  0, 1, 0, 1,
  1, 0, 0, 1,  1, 1, 0, 1,  1, 1, 1, 1,  1, 0, 1, 1,
  0, 0, 0, 0,  1, 0, 0, 0,  1, 0, 1, 0,  0, 0, 1, 0,
  0, 1, 0, 2,  0, 1, 1, 2,  1, 1, 1, 2,  1, 1, 0, 2,
]);

const CUBE_INDICES = new Uint8Array([
  0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11,
  12, 13, 14, 12, 14, 15, 16, 17, 18, 16, 18, 19, 20, 21, 22, 20, 22, 23,
]);

const VERTEX_SHADER_SOURCE = `#version 300 es
precision highp float;

layout(location = 0) in vec3 a_unitPosition;
layout(location = 1) in vec3 a_targetRelativeMinimum;
layout(location = 2) in vec3 a_dimensions;
layout(location = 3) in vec4 a_color;
layout(location = 4) in float a_faceClass;

uniform mat4 u_clipFromTarget;
uniform int u_passKind;
uniform int u_hoverIndex;
uniform int u_selectionIndex;

flat out vec4 v_color;

void main() {
  vec3 targetRelativePosition = a_targetRelativeMinimum + a_unitPosition * a_dimensions;
  gl_Position = u_clipFromTarget * vec4(targetRelativePosition, 1.0);
  if (u_passKind == 0) {
    vec3 plate = a_faceClass > 1.5
      ? vec3(24.0, 42.0, 67.0) / 255.0
      : a_faceClass > 0.5
        ? vec3(20.0, 34.0, 55.0) / 255.0
        : vec3(15.0, 26.0, 42.0) / 255.0;
    v_color = vec4(plate, 1.0);
  } else {
    vec3 base = a_color.rgb;
    vec3 ordinary = a_faceClass > 1.5
      ? base + 0.12 * (vec3(1.0) - base)
      : a_faceClass > 0.5 ? 0.82 * base : 0.62 * base;
    vec3 displayed = ordinary;
    if (u_selectionIndex >= 0) {
      if (gl_InstanceID != u_selectionIndex) {
        displayed = 0.70 * ordinary;
        if (gl_InstanceID == u_hoverIndex) displayed = mix(displayed, ordinary, 0.15);
      }
    } else if (gl_InstanceID == u_hoverIndex) {
      displayed = mix(ordinary, vec3(1.0), 0.15);
    }
    v_color = vec4(displayed, 1.0);
  }
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
  stage(
    generation: G,
    geometry: ValidatedGeometry,
    presentation: NumericPresentation,
    eventSink: PresenterEventSink<G>,
  ): PresenterStageResult;
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
  buildingVao?: WebGLVertexArrayObject;
  plateVao?: WebGLVertexArrayObject;
  positionBuffer?: WebGLBuffer;
  indexBuffer?: WebGLBuffer;
  buildingInstanceBuffer?: WebGLBuffer;
  plateInstanceBuffer?: WebGLBuffer;
  matrixUniform?: WebGLUniformLocation;
  passUniform?: WebGLUniformLocation;
  hoverUniform?: WebGLUniformLocation;
  selectionUniform?: WebGLUniformLocation;
  buildingStaging?: Uint8Array;
  plateStaging?: Uint8Array;
  pointer?: HoverPosition;
  requestEpoch: number;
  pendingFrame?: number;
  cancelAnimationFrame: (handle: number) => void;
  model?: ValidatedGeometry;
  presentation?: NumericPresentation;
  committed: boolean;
  active: boolean;
  notified: boolean;
};

const BUILDING_INSTANCE_STRIDE = 28;
const PLATE_INSTANCE_STRIDE = 24;

// Trusted WebGL 2 values from the Khronos WebGL specification. Keeping these
// local closes the context data-property surface to drawing-buffer dimensions.
const NO_ERROR = 0;
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

function exactRelative(value: number, centre: number): number {
  const relative = value - centre;
  if (Math.fround(relative) !== relative) throw new Error("Inexact target-relative origin");
  return relative;
}

function createBuildingStaging(model: ValidatedGeometry, centre: readonly number[]): Uint8Array {
  const staging = new Uint8Array(model.count * BUILDING_INSTANCE_STRIDE);
  const view = new DataView(staging.buffer);
  for (let index = 0; index < model.count; index += 1) {
    const vectorOffset = index * 3;
    const colourOffset = index * 4;
    const byteOffset = index * BUILDING_INSTANCE_STRIDE;
    for (let axis = 0; axis < 3; axis += 1) {
      view.setFloat32(byteOffset + axis * 4, exactRelative(model.origins[vectorOffset + axis]!, centre[axis]!), true);
      view.setFloat32(byteOffset + 12 + axis * 4, model.sizes[vectorOffset + axis]!, true);
    }
    for (let channel = 0; channel < 4; channel += 1) staging[byteOffset + 24 + channel] = model.rgba[colourOffset + channel]!;
  }
  return staging;
}

function createPlateStaging(presentation: NumericPresentation): Uint8Array {
  const staging = new Uint8Array(presentation.plates.length * PLATE_INSTANCE_STRIDE);
  const view = new DataView(staging.buffer);
  for (let index = 0; index < presentation.plates.length; index += 1) {
    const plate = presentation.plates[index]!;
    const byteOffset = index * PLATE_INSTANCE_STRIDE;
    for (let axis = 0; axis < 3; axis += 1) {
      view.setFloat32(byteOffset + axis * 4, exactRelative(plate.minimum[axis], presentation.centre[axis]), true);
      view.setFloat32(byteOffset + 12 + axis * 4, plate.dimensions[axis], true);
    }
  }
  return staging;
}

function draw(session: Session<unknown>, size: Dimensions, view: CameraView): void {
  const {
    canvas, gl, program, buildingVao, plateVao, matrixUniform, passUniform,
    hoverUniform, selectionUniform, model, presentation,
  } = session;
  if (!canvas || !gl || !program || !buildingVao || !plateVao || !matrixUniform || !passUniform
    || !hoverUniform || !selectionUniform || !model || !presentation) {
    throw new Error("Incomplete presentation session");
  }
  if (canvas.width !== size.width || canvas.height !== size.height
    || gl.drawingBufferWidth !== size.width || gl.drawingBufferHeight !== size.height) throw new Error("WebGL2 drawing-buffer dimensions differ");
  requireNoError(gl);
  const matrix = new Float32Array(view.matrix);
  try {
    gl.clearColor(0x07 / 0xff, 0x11 / 0xff, 0x1f / 0xff, 1);
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
    gl.uniformMatrix4fv(matrixUniform, false, matrix);
    gl.uniform1i(hoverUniform, session.hover ?? -1);
    gl.uniform1i(selectionUniform, session.selection ?? -1);
    gl.bindVertexArray(plateVao);
    gl.uniform1i(passUniform, 0);
    gl.drawElementsInstanced(TRIANGLES, 36, UNSIGNED_BYTE, 0, presentation.plates.length);
    gl.bindVertexArray(buildingVao);
    gl.uniform1i(passUniform, 1);
    gl.drawElementsInstanced(TRIANGLES, 36, UNSIGNED_BYTE, 0, model.count);
    requireNoError(gl);
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
  session.matrixUniform = gl.getUniformLocation(session.program, "u_clipFromTarget") ?? undefined;
  requireNoError(gl);
  session.passUniform = gl.getUniformLocation(session.program, "u_passKind") ?? undefined;
  requireNoError(gl);
  session.hoverUniform = gl.getUniformLocation(session.program, "u_hoverIndex") ?? undefined;
  requireNoError(gl);
  session.selectionUniform = gl.getUniformLocation(session.program, "u_selectionIndex") ?? undefined;
  requireNoError(gl);
  if (!session.matrixUniform || !session.passUniform || !session.hoverUniform || !session.selectionUniform) {
    throw new Error("WebGL2 uniform is unavailable");
  }

  const vertexShader = session.vertexShader;
  session.vertexShader = undefined;
  gl.deleteShader(vertexShader);
  const fragmentShader = session.fragmentShader;
  session.fragmentShader = undefined;
  gl.deleteShader(fragmentShader);
  requireNoError(gl);

  session.buildingVao = requireResource(gl.createVertexArray(), gl, (vao) => { session.buildingVao = vao; });
  session.plateVao = requireResource(gl.createVertexArray(), gl, (vao) => { session.plateVao = vao; });
  session.positionBuffer = requireResource(gl.createBuffer(), gl, (buffer) => { session.positionBuffer = buffer; });
  session.indexBuffer = requireResource(gl.createBuffer(), gl, (buffer) => { session.indexBuffer = buffer; });
  session.buildingInstanceBuffer = requireResource(gl.createBuffer(), gl, (buffer) => { session.buildingInstanceBuffer = buffer; });
  session.plateInstanceBuffer = requireResource(gl.createBuffer(), gl, (buffer) => { session.plateInstanceBuffer = buffer; });

  gl.bindVertexArray(session.buildingVao);
  gl.bindBuffer(ARRAY_BUFFER, session.positionBuffer);
  gl.bufferData(ARRAY_BUFFER, CUBE_VERTEX_DATA, STATIC_DRAW);
  requireNoError(gl);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(4);
  gl.vertexAttribPointer(4, 1, FLOAT, false, 16, 12);
  gl.bindBuffer(ELEMENT_ARRAY_BUFFER, session.indexBuffer);
  gl.bufferData(ELEMENT_ARRAY_BUFFER, CUBE_INDICES, STATIC_DRAW);
  requireNoError(gl);

  const initialCamera = resetCamera(session.presentation!.sceneBounds, size);
  if (initialCamera.kind === "failure") throw new Error("Initial camera failed");
  for (let axis = 0; axis < 3; axis += 1) {
    if (initialCamera.view.centre[axis] !== session.presentation!.centre[axis]) throw new Error("Presentation centre differs");
  }
  session.cameraState = initialCamera.state;
  session.cameraView = initialCamera.view;
  session.buildingStaging = createBuildingStaging(session.model!, session.presentation!.centre);
  gl.bindBuffer(ARRAY_BUFFER, session.buildingInstanceBuffer);
  gl.bufferData(ARRAY_BUFFER, session.buildingStaging, STATIC_DRAW);
  requireNoError(gl);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, FLOAT, false, BUILDING_INSTANCE_STRIDE, 0);
  gl.vertexAttribDivisor(1, 1);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 3, FLOAT, false, BUILDING_INSTANCE_STRIDE, 12);
  gl.vertexAttribDivisor(2, 1);
  gl.enableVertexAttribArray(3);
  gl.vertexAttribPointer(3, 4, UNSIGNED_BYTE, true, BUILDING_INSTANCE_STRIDE, 24);
  gl.vertexAttribDivisor(3, 1);

  gl.bindVertexArray(session.plateVao);
  gl.bindBuffer(ARRAY_BUFFER, session.positionBuffer);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(4);
  gl.vertexAttribPointer(4, 1, FLOAT, false, 16, 12);
  gl.bindBuffer(ELEMENT_ARRAY_BUFFER, session.indexBuffer);
  session.plateStaging = createPlateStaging(session.presentation!);
  gl.bindBuffer(ARRAY_BUFFER, session.plateInstanceBuffer);
  gl.bufferData(ARRAY_BUFFER, session.plateStaging, STATIC_DRAW);
  requireNoError(gl);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, FLOAT, false, PLATE_INSTANCE_STRIDE, 0);
  gl.vertexAttribDivisor(1, 1);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 3, FLOAT, false, PLATE_INSTANCE_STRIDE, 12);
  gl.vertexAttribDivisor(2, 1);
  requireNoError(gl);

  draw(session as Session<unknown>, size, initialCamera.view);
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
      session.buildingInstanceBuffer && (() => gl.deleteBuffer(session.buildingInstanceBuffer!)),
      session.plateInstanceBuffer && (() => gl.deleteBuffer(session.plateInstanceBuffer!)),
      session.buildingVao && (() => gl.deleteVertexArray(session.buildingVao!)),
      session.plateVao && (() => gl.deleteVertexArray(session.plateVao!)),
    ];
    for (const release of releases) {
      try { release?.(); } catch { complete = false; }
    }
  }
  try { canvas?.remove(); } catch { complete = false; }
  session.buildingStaging?.fill(0);
  session.plateStaging?.fill(0);
  session.canvas = undefined;
  session.gl = undefined;
  session.vertexShader = undefined;
  session.fragmentShader = undefined;
  session.program = undefined;
  session.buildingVao = undefined;
  session.plateVao = undefined;
  session.positionBuffer = undefined;
  session.indexBuffer = undefined;
  session.buildingInstanceBuffer = undefined;
  session.plateInstanceBuffer = undefined;
  session.matrixUniform = undefined;
  session.passUniform = undefined;
  session.hoverUniform = undefined;
  session.selectionUniform = undefined;
  session.buildingStaging = undefined;
  session.plateStaging = undefined;
  session.pointer = undefined;
  session.model = undefined;
  session.presentation = undefined;
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
          transition = orbitCameraByKeyboard(session.cameraState!, session.presentation!.sceneBounds, size, event.key);
        } else if (event.shiftKey && (event.key === "W" || event.key === "A" || event.key === "S" || event.key === "D")) {
          transition = panCameraByKeyboard(session.cameraState!, session.presentation!.sceneBounds, size, event.key);
        } else if (event.key === "+") {
          transition = zoomCamera(session.cameraState!, session.presentation!.sceneBounds, size, "in");
        } else if (event.key === "-") {
          transition = zoomCamera(session.cameraState!, session.presentation!.sceneBounds, size, "out");
        } else if (event.key === "0") {
          transition = resetCamera(session.presentation!.sceneBounds, size);
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
        applyCameraAndRenewHover(session, zoomCamera(session.cameraState!, session.presentation!.sceneBounds, size, direction), size);
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
          ? orbitCameraByPointer(session.cameraState!, session.presentation!.sceneBounds, size, dx, dy, rectangle.width, rectangle.height)
          : panCameraByPointer(session.cameraState!, session.presentation!.sceneBounds, size, dx, dy, rectangle.width, rectangle.height);
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
        applyCameraAndRenewHover(session, resetCamera(session.presentation!.sceneBounds, size), size);
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
        const transition = resizeCamera(session.cameraState!, session.presentation!.sceneBounds, next);
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
    stage(
      generation: G,
      model: ValidatedGeometry,
      presentation: NumericPresentation,
      eventSink: PresenterEventSink<G>,
    ): PresenterStageResult {
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
          presentation,
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
          const transition = resizeCamera(candidate.cameraState!, presentation.sceneBounds, finalSize);
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
