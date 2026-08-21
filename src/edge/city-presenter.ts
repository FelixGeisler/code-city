import { deriveView, validatePresentationModel, type PresentationModel } from "../domain/city-model";

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

export type PresentationResult = "committed" | "stale" | "failed";
export type PresentationFailureCategory = "City construction failed" | "Presentation failed";
export type PresentationFailureCode = "M1-CITY-1" | "M1-PRES-1";

type LossListener = (event: Event) => void;

export type PresenterCanvas = Pick<HTMLCanvasElement, "width" | "height" | "getContext" | "remove">
  & {
    addEventListener(type: "webglcontextlost", listener: LossListener, options: AddEventListenerOptions): void;
    removeEventListener(type: "webglcontextlost", listener: LossListener): void;
  };

export type PresenterHost = Pick<HTMLElement, "clientWidth" | "clientHeight">
  & { replaceChildren(...nodes: (Node | string)[]): void };

export type PresenterResizeObserver = {
  observe(target: Element): void;
  disconnect(): void;
};

export type PresenterPlatform = Readonly<{
  createCanvas(): PresenterCanvas;
  createResizeObserver(callback: () => void): PresenterResizeObserver;
}>;

export type CityPresenterOptions<G> = Readonly<{
  host: PresenterHost;
  isEligible(generation: G): boolean;
  failed(generation: G, category: PresentationFailureCategory, code: PresentationFailureCode): void;
  platform?: PresenterPlatform;
}>;

export type CityPresenter<G> = Readonly<{
  present(generation: G, model: unknown): PresentationResult;
  dispose(): void;
}>;

type Dimensions = Readonly<{ width: number; height: number }>;

type Session<G> = {
  generation?: G;
  canvas?: PresenterCanvas;
  gl?: WebGL2RenderingContext;
  observer?: PresenterResizeObserver;
  lossListener?: LossListener;
  vertexShader?: WebGLShader;
  fragmentShader?: WebGLShader;
  program?: WebGLProgram;
  vao?: WebGLVertexArrayObject;
  positionBuffer?: WebGLBuffer;
  indexBuffer?: WebGLBuffer;
  instanceBuffer?: WebGLBuffer;
  uniform?: WebGLUniformLocation;
  staging?: Uint8Array;
  model?: PresentationModel;
  committed: boolean;
  active: boolean;
  notified: boolean;
};

const INSTANCE_STRIDE = 28;

const browserPlatform: PresenterPlatform = Object.freeze({
  createCanvas: () => document.createElement("canvas"),
  createResizeObserver: (callback) => new ResizeObserver(callback),
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
  if (gl.isContextLost() || gl.getError() !== gl.NO_ERROR) throw new Error("WebGL2 operation failed");
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string, own: (shader: WebGLShader) => void): WebGLShader {
  const shader = gl.createShader(type);
  if (shader !== null) own(shader);
  requireNoError(gl);
  if (shader === null) throw new Error("WebGL2 shader allocation failed");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  const compiled = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
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

function createMatrix(model: PresentationModel, width: number, height: number): Float32Array {
  const view = deriveView(model.bounds, width / height);
  const aH = view.horizontalHalf;
  const H = view.H;
  const twiceDepth = 2 * view.E_d;
  return new Float32Array([
    view.R[0] / aH, view.V[0] / H, -view.D[0] / twiceDepth, 0,
    view.R[1] / aH, view.V[1] / H, -view.D[1] / twiceDepth, 0,
    view.R[2] / aH, view.V[2] / H, -view.D[2] / twiceDepth, 0,
    0, 0, 0, 1,
  ]);
}

function createInstanceStaging(model: PresentationModel, width: number, height: number): Uint8Array {
  const target = deriveView(model.bounds, width / height).target;
  const staging = new Uint8Array(model.count * INSTANCE_STRIDE);
  const view = new DataView(staging.buffer);
  for (let index = 0; index < model.count; index += 1) {
    const vectorOffset = index * 3;
    const colourOffset = index * 4;
    const byteOffset = index * INSTANCE_STRIDE;
    for (let axis = 0; axis < 3; axis += 1) {
      const relative = model.origins[vectorOffset + axis]! - target[axis]!;
      if (Math.fround(relative) !== relative) throw new Error("Inexact target-relative origin");
      view.setFloat32(byteOffset + axis * 4, relative, true);
      view.setFloat32(byteOffset + 12 + axis * 4, model.sizes[vectorOffset + axis]!, true);
    }
    for (let channel = 0; channel < 4; channel += 1) staging[byteOffset + 24 + channel] = model.rgba[colourOffset + channel]!;
  }
  return staging;
}

function draw(session: Session<unknown>, size: Dimensions): void {
  const { canvas, gl, program, vao, uniform, model } = session;
  if (!canvas || !gl || !program || !vao || !uniform || !model) throw new Error("Incomplete presentation session");
  if (canvas.width !== size.width || canvas.height !== size.height
    || gl.drawingBufferWidth !== size.width || gl.drawingBufferHeight !== size.height) throw new Error("WebGL2 drawing-buffer dimensions differ");
  requireNoError(gl);
  const matrix = createMatrix(model, size.width, size.height);
  try {
    gl.clearColor(1, 1, 1, 1);
    gl.clearDepth(1);
    gl.colorMask(true, true, true, true);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);
    gl.disable(gl.BLEND);
    gl.disable(gl.DITHER);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.disable(gl.RASTERIZER_DISCARD);
    gl.disable(gl.SAMPLE_COVERAGE);
    gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
    gl.viewport(0, 0, size.width, size.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(program);
    gl.bindVertexArray(vao);
    gl.uniformMatrix4fv(uniform, false, matrix);
    gl.drawElementsInstanced(gl.TRIANGLES, 36, gl.UNSIGNED_BYTE, 0, model.count);
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

  session.vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE, (shader) => { session.vertexShader = shader; });
  session.fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SOURCE, (shader) => { session.fragmentShader = shader; });
  session.program = requireResource(gl.createProgram(), gl, (program) => { session.program = program; });
  gl.attachShader(session.program, session.vertexShader);
  gl.attachShader(session.program, session.fragmentShader);
  gl.linkProgram(session.program);
  const linked = gl.getProgramParameter(session.program, gl.LINK_STATUS);
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
  gl.bindBuffer(gl.ARRAY_BUFFER, session.positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, CUBE_POSITIONS, gl.STATIC_DRAW);
  requireNoError(gl);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, session.indexBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, CUBE_INDICES, gl.STATIC_DRAW);
  requireNoError(gl);

  session.staging = createInstanceStaging(session.model!, size.width, size.height);
  gl.bindBuffer(gl.ARRAY_BUFFER, session.instanceBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, session.staging, gl.STATIC_DRAW);
  requireNoError(gl);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, INSTANCE_STRIDE, 0);
  gl.vertexAttribDivisor(1, 1);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 3, gl.FLOAT, false, INSTANCE_STRIDE, 12);
  gl.vertexAttribDivisor(2, 1);
  gl.enableVertexAttribArray(3);
  gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, true, INSTANCE_STRIDE, 24);
  gl.vertexAttribDivisor(3, 1);
  requireNoError(gl);
  draw(session as Session<unknown>, size);
}

function releaseAttempt(action: (() => void) | undefined): void {
  try { action?.(); } catch {}
}

function cleanup<G>(session: Session<G>): void {
  if (!session.active) return;
  session.active = false;
  const observer = session.observer;
  session.observer = undefined;
  releaseAttempt(observer && (() => observer.disconnect()));
  const canvas = session.canvas;
  const listener = session.lossListener;
  session.lossListener = undefined;
  releaseAttempt(canvas && listener && (() => canvas.removeEventListener("webglcontextlost", listener)));

  const gl = session.gl;
  let actuallyLost = false;
  if (gl) releaseAttempt(() => { actuallyLost = gl.isContextLost(); });
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
    for (const release of releases) releaseAttempt(release);
  }
  releaseAttempt(canvas && (() => canvas.remove()));
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
  session.generation = undefined;
  session.committed = false;
}

export function createCityPresenter<G>(options: CityPresenterOptions<G>): CityPresenter<G> {
  const { host, isEligible, failed } = options;
  const platform = options.platform ?? browserPlatform;
  let current: Session<G> | undefined;
  let disposed = false;

  const notify = (session: Session<G> | undefined, generation: G, category: PresentationFailureCategory, code: PresentationFailureCode): void => {
    if (session?.notified) return;
    if (session) session.notified = true;
    try { failed(generation, category, code); } catch {}
  };

  const removeSession = (session: Session<G>): void => {
    if (current === session) current = undefined;
    cleanup(session);
  };

  const failSession = (session: Session<G>): void => {
    if (!session.active) return;
    const generation = session.generation!;
    removeSession(session);
    notify(session, generation, "Presentation failed", "M1-PRES-1");
  };

  const installCallbacks = (session: Session<G>): void => {
    const canvas = session.canvas!;
    const lossListener: LossListener = () => {
      try {
        if (!session.active) return;
        let eligible = false;
        try { eligible = isEligible(session.generation!); } catch { failSession(session); return; }
        if (!eligible || current !== session) { removeSession(session); return; }
        failSession(session);
      } catch {}
    };
    session.lossListener = lossListener;
    canvas.addEventListener("webglcontextlost", lossListener, { passive: true, once: true });
  };

  const observe = (session: Session<G>): void => {
    session.observer = platform.createResizeObserver(() => {
      try {
        if (!session.active) return;
        let eligible = false;
        try { eligible = isEligible(session.generation!); } catch { failSession(session); return; }
        if (!eligible || current !== session) { removeSession(session); return; }
        const next = dimensions(host);
        const canvas = session.canvas!;
        if (canvas.width === next.width && canvas.height === next.height) return;
        canvas.width = next.width;
        canvas.height = next.height;
        draw(session as Session<unknown>, next);
      } catch {
        failSession(session);
      }
    });
    session.observer.observe(host as Element);
  };

  return Object.freeze({
    present(generation: G, value: unknown): PresentationResult {
      let model: PresentationModel;
      try {
        model = validatePresentationModel(value);
      } catch {
        const affected = current;
        if (affected && current === affected) removeSession(affected);
        notify(undefined, generation, "City construction failed", "M1-CITY-1");
        return "failed";
      }
      if (disposed) {
        notify(undefined, generation, "Presentation failed", "M1-PRES-1");
        return "failed";
      }

      const affected = current;
      let candidate: Session<G> | undefined;
      try {
        if (!isEligible(generation)) return "stale";
        const initial = dimensions(host);
        const canvas = platform.createCanvas();
        candidate = {
          generation,
          canvas,
          model,
          committed: false,
          active: true,
          notified: false,
        };
        installCallbacks(candidate);
        allocate(candidate, initial);
        observe(candidate);
        const finalSize = dimensions(host);
        if (!sameDimensions(initial, finalSize)) {
          canvas.width = finalSize.width;
          canvas.height = finalSize.height;
          draw(candidate as Session<unknown>, finalSize);
        }
        if (!isEligible(generation)) {
          cleanup(candidate);
          return "stale";
        }
        host.replaceChildren(canvas as unknown as Node);
        candidate.committed = true;
        current = candidate;
        if (affected && affected !== candidate) cleanup(affected);
        return "committed";
      } catch {
        if (candidate) cleanup(candidate);
        if (affected && current === affected) removeSession(affected);
        notify(candidate, generation, "Presentation failed", "M1-PRES-1");
        return "failed";
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (current) removeSession(current);
    },
  });
}
