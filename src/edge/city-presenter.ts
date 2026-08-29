import type { ValidatedGeometry } from "../application/city-payload";
import {
  orbitCameraByKeyboard,
  orbitCameraByPointer,
  panCameraByKeyboard,
  panCameraByPointer,
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
type ReleasePosition = Readonly<{ clientX: number; clientY: number }>;
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
  eligibleReleasePosition?: ReleasePosition;
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
  staging?: Uint8Array;
  model?: ValidatedGeometry;
  committed: boolean;
  active: boolean;
  notified: boolean;
};

const INSTANCE_STRIDE = 28;

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
  const { canvas, gl, program, vao, uniform, model } = session;
  if (!canvas || !gl || !program || !vao || !uniform || !model) throw new Error("Incomplete presentation session");
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
  draw(session as Session<unknown>, size, initialCamera.view);
}

function releaseGesture<G>(session: Session<G>): void {
  const gesture = session.gesture;
  session.gesture = undefined;
  session.eligibleReleasePosition = undefined;
  if (!gesture?.captureOwned) return;
  gesture.captureOwned = false;
  session.canvas?.releasePointerCapture(gesture.pointerId);
}

function cleanup<G>(session: Session<G>): boolean {
  if (!session.active) return true;
  session.active = false;
  let complete = true;
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
    ];
    for (const release of releases) {
      try { release?.(); } catch { complete = false; }
    }
  }
  try { canvas?.remove(); } catch { complete = false; }
  session.staging?.fill(0);
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
  session.staging = undefined;
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

  const applyCamera = (session: Session<G>, transition: CameraTransitionResult, size: Dimensions): void => {
    if (transition.kind === "failure") {
      failSession(session);
      return;
    }
    draw(session as Session<unknown>, size, transition.view);
    session.cameraState = transition.state;
    session.cameraView = transition.view;
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
        applyCamera(session, transition, size);
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
        applyCamera(session, zoomCamera(session.cameraState!, session.model!.bounds, size, direction), size);
      } catch {
        failSession(session);
      }
    };
    const pointerDownListener: PointerListener = (event) => {
      try {
        if (!callbackEligible(session) || session.gesture || (event.button !== 0 && event.button !== 2)) return;
        if (!Number.isInteger(event.pointerId) || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) throw new Error("Invalid pointer press");
        event.preventDefault();
        session.eligibleReleasePosition = undefined;
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
        if (!gesture || event.pointerId !== gesture.pointerId) return;
        if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) throw new Error("Invalid pointer movement");
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
        applyCamera(session, transition, size);
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
        if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) throw new Error("Invalid pointer release");
        if (event.clientX !== gesture.pressX || event.clientY !== gesture.pressY) gesture.dragged = true;
        const eligible = gesture.button === 0 && !gesture.dragged
          && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
        const releasePosition = eligible ? Object.freeze({ clientX: event.clientX, clientY: event.clientY }) : undefined;
        releaseGesture(session);
        session.eligibleReleasePosition = releasePosition;
      } catch {
        failSession(session);
      }
    };
    const pointerCancelListener: PointerListener = (event) => {
      try {
        if (!callbackEligible(session)) return;
        if (session.gesture?.pointerId !== event.pointerId) return;
        releaseGesture(session);
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
        session.eligibleReleasePosition = undefined;
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
        applyCamera(session, resetCamera(session.model!.bounds, size), size);
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
        applyCamera(session, transition, next);
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
      const count = session.model!.count;
      const valid = (index: number | null): boolean => index === null || (Number.isSafeInteger(index) && index >= 0 && index < count);
      if (!valid(hover) || !valid(selection)) {
        failSession(session);
        return PRESENTATION_FAILURE;
      }
      session.hover = hover;
      session.selection = selection;
      return APPLIED;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const session of [...sessions.values()]) removeSession(session);
    },
  });
}
