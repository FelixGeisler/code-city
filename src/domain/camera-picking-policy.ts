export type Vector3 = readonly [number, number, number];
export type Bounds3 = readonly [number, number, number, number, number, number];
export type PositiveDimensions = Readonly<{ width: number; height: number }>;

export type PresentationPolicyFailure = Readonly<{
  kind: "failure";
  category: "Presentation failed";
  code: "M1-PRES-1";
}>;

export type CameraState = Readonly<{
  target: Vector3;
  azimuth: number;
  elevation: number;
  magnification: number;
  D: Vector3;
  R: Vector3;
  V: Vector3;
}>;

export type CameraView = Readonly<{
  state: CameraState;
  centre: Vector3;
  lengths: Vector3;
  aspect: number;
  H0: number;
  verticalHalf: number;
  horizontalHalf: number;
  E: number;
  delta: number;
  distance: number;
  camera: Vector3;
  near: number;
  far: number;
  tx: number;
  ty: number;
  tz: number;
  zLinear: Vector3;
  matrix: readonly number[];
  oracleDepths: readonly number[];
}>;

export type CameraTransitionResult =
  | Readonly<{ kind: "success"; state: CameraState; view: CameraView }>
  | PresentationPolicyFailure;

export type BackingPoint = Readonly<{ x: number; y: number }>;
export type Ray = Readonly<{ origin: Vector3; direction: Vector3 }>;
export type CanvasRectangle = Readonly<{ left: number; top: number; width: number; height: number }>;
export type RayResult = Readonly<{ kind: "success"; point: BackingPoint; ray: Ray | null }> | PresentationPolicyFailure;
export type SlabResult = Readonly<{ kind: "success"; tEnter: number | null }> | PresentationPolicyFailure;
export type PickingGeometry = Readonly<{
  count: number;
  origins: Float32Array;
  sizes: Float32Array;
}>;
export type PickResult = Readonly<{ kind: "success"; index: number | null; tEnter: number | null }> | PresentationPolicyFailure;
export type DepthValueResult = Readonly<{ kind: "success"; depth: number }> | PresentationPolicyFailure;
export type DepthOracleResult = Readonly<{ kind: "success"; depths: readonly number[] }> | PresentationPolicyFailure;

export const OVERVIEW_AZIMUTH = Math.PI / 4;
export const OVERVIEW_ELEVATION = Math.asin(1 / Math.sqrt(3));
export const MINIMUM_ELEVATION = Math.PI / 12;
export const MAXIMUM_ELEVATION = 5 * Math.PI / 12;
export const MINIMUM_MAGNIFICATION = 1 / 64;
export const MAXIMUM_MAGNIFICATION = 64;
export const KEYBOARD_AZIMUTH_STEP = Math.PI / 12;
export const KEYBOARD_ELEVATION_STEP = Math.PI / 24;
export const ZOOM_FACTOR = 1.25;
export const MAX_PICK_INSTANCES = 4_000;

const TAU = 2 * Math.PI;
const SQRT_2 = Math.sqrt(2);
const SQRT_3 = Math.sqrt(3);
const SQRT_6 = Math.sqrt(6);
const OVERVIEW_D = Object.freeze([1 / SQRT_3, 1 / SQRT_3, 1 / SQRT_3]) as Vector3;
const OVERVIEW_R = Object.freeze([1 / SQRT_2, 0, -1 / SQRT_2]) as Vector3;
const OVERVIEW_V = Object.freeze([-1 / SQRT_6, 2 / SQRT_6, -1 / SQRT_6]) as Vector3;
const PRESENTATION_FAILURE: PresentationPolicyFailure = Object.freeze({
  kind: "failure",
  category: "Presentation failed",
  code: "M1-PRES-1",
});

function finite(value: number): number {
  if (!Number.isFinite(value)) throw new Error("non-finite presentation calculation");
  return value;
}

function add(left: number, right: number): number { return finite(left + right); }
function subtract(left: number, right: number): number { return finite(left - right); }
function multiply(left: number, right: number): number { return finite(left * right); }
function divide(left: number, right: number): number { return finite(left / right); }
function absolute(value: number): number { return finite(Math.abs(value)); }
function fround(value: number): number { return finite(Math.fround(value)); }

function vector(x: number, y: number, z: number): Vector3 {
  return Object.freeze([finite(x), finite(y), finite(z)]) as Vector3;
}

function scale(value: Vector3, factor: number): Vector3 {
  return vector(multiply(value[0], factor), multiply(value[1], factor), multiply(value[2], factor));
}

function addVectors(left: Vector3, right: Vector3): Vector3 {
  return vector(add(left[0], right[0]), add(left[1], right[1]), add(left[2], right[2]));
}

function subtractVectors(left: Vector3, right: Vector3): Vector3 {
  return vector(subtract(left[0], right[0]), subtract(left[1], right[1]), subtract(left[2], right[2]));
}

function dot(left: Vector3, right: Vector3): number {
  const p0 = multiply(left[0], right[0]);
  const p1 = multiply(left[1], right[1]);
  const p2 = multiply(left[2], right[2]);
  return add(add(p0, p1), p2);
}

function cross(left: Vector3, right: Vector3): Vector3 {
  return vector(
    subtract(multiply(left[1], right[2]), multiply(left[2], right[1])),
    subtract(multiply(left[2], right[0]), multiply(left[0], right[2])),
    subtract(multiply(left[0], right[1]), multiply(left[1], right[0])),
  );
}

function snapshotBounds(value: readonly number[] | Float32Array): Bounds3 {
  if (value.length !== 6) throw new Error("invalid bounds");
  const bounds = [...value].map(finite) as number[];
  if (!(bounds[3]! > bounds[0]!) || !(bounds[4]! > bounds[1]!) || !(bounds[5]! > bounds[2]!)) {
    throw new Error("degenerate bounds");
  }
  return Object.freeze(bounds) as unknown as Bounds3;
}

function boundsValues(boundsValue: readonly number[] | Float32Array): Readonly<{
  bounds: Bounds3;
  centre: Vector3;
  lengths: Vector3;
}> {
  const bounds = snapshotBounds(boundsValue);
  const centre = vector(
    divide(add(bounds[0], bounds[3]), 2),
    divide(add(bounds[1], bounds[4]), 2),
    divide(add(bounds[2], bounds[5]), 2),
  );
  const lengths = vector(
    subtract(bounds[3], bounds[0]),
    subtract(bounds[4], bounds[1]),
    subtract(bounds[5], bounds[2]),
  );
  return Object.freeze({ bounds, centre, lengths });
}

function aspectOf(dimensions: PositiveDimensions): number {
  const width = finite(dimensions.width);
  const height = finite(dimensions.height);
  if (!(width > 0) || !(height > 0)) throw new Error("non-positive dimensions");
  return divide(width, height);
}

function state(target: Vector3, azimuth: number, elevation: number, magnification: number, D: Vector3, R: Vector3, V: Vector3): CameraState {
  finite(azimuth);
  finite(elevation);
  finite(magnification);
  if (azimuth < 0 || azimuth >= TAU
    || elevation < MINIMUM_ELEVATION || elevation > MAXIMUM_ELEVATION
    || magnification < MINIMUM_MAGNIFICATION || magnification > MAXIMUM_MAGNIFICATION) {
    throw new Error("camera state outside accepted limits");
  }
  return Object.freeze({ target, azimuth, elevation, magnification, D, R, V });
}

function normaliseAzimuth(value: number): number {
  const remainder = finite(value % TAU);
  const normalised = remainder < 0 ? add(remainder, TAU) : remainder;
  return Object.is(normalised, -0) ? 0 : normalised;
}

function orientation(azimuth: number, elevation: number): Readonly<{ D: Vector3; R: Vector3; V: Vector3 }> {
  const cosineElevation = finite(Math.cos(elevation));
  const sineElevation = finite(Math.sin(elevation));
  const cosineAzimuth = finite(Math.cos(azimuth));
  const sineAzimuth = finite(Math.sin(azimuth));
  const D = vector(multiply(cosineElevation, cosineAzimuth), sineElevation, multiply(cosineElevation, sineAzimuth));
  const R = vector(sineAzimuth, 0, -cosineAzimuth);
  const V = cross(D, R);
  return Object.freeze({ D, R, V });
}

function snapshotState(value: CameraState): CameraState {
  return state(
    vector(value.target[0], value.target[1], value.target[2]),
    value.azimuth,
    value.elevation,
    value.magnification,
    vector(value.D[0], value.D[1], value.D[2]),
    vector(value.R[0], value.R[1], value.R[2]),
    vector(value.V[0], value.V[1], value.V[2]),
  );
}

function corners(bounds: Bounds3, centre: Vector3, rounded: boolean): readonly Vector3[] {
  const endpoint = (value: number, centreValue: number): number => {
    const relative = subtract(value, centreValue);
    return rounded ? fround(relative) : relative;
  };
  const x0 = endpoint(bounds[0], centre[0]);
  const y0 = endpoint(bounds[1], centre[1]);
  const z0 = endpoint(bounds[2], centre[2]);
  const x1 = endpoint(bounds[3], centre[0]);
  const y1 = endpoint(bounds[4], centre[1]);
  const z1 = endpoint(bounds[5], centre[2]);
  return Object.freeze([
    vector(x0, y0, z0), vector(x1, y0, z0), vector(x0, y1, z0), vector(x1, y1, z0),
    vector(x0, y0, z1), vector(x1, y0, z1), vector(x0, y1, z1), vector(x1, y1, z1),
  ]);
}

export function calculateOracleDepth(
  matrixValue: readonly number[] | Float32Array,
  cornerValue: Vector3,
): DepthValueResult {
  try {
    if (matrixValue.length !== 16) throw new Error("invalid matrix length");
    const matrix = Array.from(matrixValue, (component) => {
      const accepted = finite(component);
      if (Math.fround(accepted) !== accepted) throw new Error("matrix component is not float32");
      return accepted;
    });
    const [x, y, z] = vector(fround(cornerValue[0]), fround(cornerValue[1]), fround(cornerValue[2]));
    const p0 = fround(multiply(matrix[2]!, x));
    const p1 = fround(multiply(matrix[6]!, y));
    const p2 = fround(multiply(matrix[10]!, z));
    const p3 = fround(multiply(matrix[14]!, fround(1)));
    const s0 = fround(add(p0, p1));
    const s1 = fround(add(s0, p2));
    const depth = fround(add(s1, p3));
    return Object.freeze({ kind: "success", depth });
  } catch {
    return PRESENTATION_FAILURE;
  }
}

export function evaluateStrictDepthOracle(
  boundsValue: readonly number[] | Float32Array,
  centreValue: Vector3,
  matrixValue: readonly number[] | Float32Array,
): DepthOracleResult {
  try {
    const bounds = snapshotBounds(boundsValue);
    const centre = vector(centreValue[0], centreValue[1], centreValue[2]);
    const depths: number[] = [];
    for (const corner of corners(bounds, centre, true)) {
      const evaluated = calculateOracleDepth(matrixValue, corner);
      if (evaluated.kind === "failure" || !(-1 < evaluated.depth && evaluated.depth < 1)) {
        throw new Error("strict depth oracle rejected camera");
      }
      depths.push(evaluated.depth);
    }
    return Object.freeze({ kind: "success", depths: Object.freeze(depths) });
  } catch {
    return PRESENTATION_FAILURE;
  }
}

function evaluate(candidate: CameraState, boundsValue: readonly number[] | Float32Array, dimensions: PositiveDimensions): CameraTransitionResult {
  try {
    const acceptedState = snapshotState(candidate);
    const { bounds, centre, lengths } = boundsValues(boundsValue);
    const aspect = aspectOf(dimensions);

    const Er = divide(add(lengths[0], lengths[2]), multiply(2, SQRT_2));
    const Ev = divide(add(add(lengths[0], multiply(2, lengths[1])), lengths[2]), multiply(2, SQRT_6));
    const horizontalFit = divide(Er, aspect);
    const H0 = multiply(1.1, Math.max(Ev, horizontalFit));
    const verticalHalf = divide(H0, acceptedState.magnification);
    const horizontalHalf = divide(multiply(aspect, H0), acceptedState.magnification);
    if (!(verticalHalf > 0) || !(horizontalHalf > 0)) throw new Error("invalid camera fit");

    const weightedX = multiply(lengths[0], absolute(acceptedState.D[0]));
    const weightedY = multiply(lengths[1], absolute(acceptedState.D[1]));
    const weightedZ = multiply(lengths[2], absolute(acceptedState.D[2]));
    const E = divide(add(add(weightedX, weightedY), weightedZ), 2);
    if (!(E > 0)) throw new Error("invalid camera extent");

    const Delta = subtractVectors(centre, acceptedState.target);
    const delta = dot(Delta, acceptedState.D);
    const distance = add(absolute(delta), multiply(3, E));
    const camera = addVectors(acceptedState.target, scale(acceptedState.D, distance));
    const near = E;
    const negativeDelta = finite(-delta);
    const far = add(multiply(2, Math.max(0, negativeDelta)), multiply(5, E));
    const depthRange = subtract(far, near);
    if (!(near > 0) || !(far > near)) throw new Error("invalid clipping range");

    const tx = divide(dot(Delta, acceptedState.R), horizontalHalf);
    const ty = divide(dot(Delta, acceptedState.V), verticalHalf);
    const distanceMinusDelta = subtract(distance, delta);
    const twiceDistanceMinusDelta = multiply(2, distanceMinusDelta);
    const farPlusNear = add(far, near);
    const computedTz = divide(subtract(twiceDistanceMinusDelta, farPlusNear), depthRange);
    const tz = delta === 0 ? 0 : computedTz;
    const zLinear = vector(
      divide(multiply(-2, acceptedState.D[0]), depthRange),
      divide(multiply(-2, acceptedState.D[1]), depthRange),
      divide(multiply(-2, acceptedState.D[2]), depthRange),
    );

    const matrix = Object.freeze([
      fround(divide(acceptedState.R[0], horizontalHalf)), fround(divide(acceptedState.V[0], verticalHalf)), fround(zLinear[0]), fround(0),
      fround(divide(acceptedState.R[1], horizontalHalf)), fround(divide(acceptedState.V[1], verticalHalf)), fround(zLinear[1]), fround(0),
      fround(divide(acceptedState.R[2], horizontalHalf)), fround(divide(acceptedState.V[2], verticalHalf)), fround(zLinear[2]), fround(0),
      fround(tx), fround(ty), fround(tz), fround(1),
    ]);

    for (const relative of corners(bounds, centre, false)) {
      const pointDepth = subtract(distanceMinusDelta, dot(relative, acceptedState.D));
      if (!(near < pointDepth && pointDepth < far)) throw new Error("camera-space depth rejected camera");
    }
    const oracle = evaluateStrictDepthOracle(bounds, centre, matrix);
    if (oracle.kind === "failure") return oracle;

    const view: CameraView = Object.freeze({
      state: acceptedState,
      centre,
      lengths,
      aspect,
      H0,
      verticalHalf,
      horizontalHalf,
      E,
      delta,
      distance,
      camera,
      near,
      far,
      tx,
      ty,
      tz,
      zLinear,
      matrix,
      oracleDepths: oracle.depths,
    });
    return Object.freeze({ kind: "success", state: acceptedState, view });
  } catch {
    return PRESENTATION_FAILURE;
  }
}

function transition(
  current: CameraState,
  bounds: readonly number[] | Float32Array,
  dimensions: PositiveDimensions,
  change: (accepted: CameraState) => CameraState,
): CameraTransitionResult {
  try {
    return evaluate(change(snapshotState(current)), bounds, dimensions);
  } catch {
    return PRESENTATION_FAILURE;
  }
}

export function resetCamera(bounds: readonly number[] | Float32Array, dimensions: PositiveDimensions): CameraTransitionResult {
  try {
    const { centre } = boundsValues(bounds);
    return evaluate(state(centre, OVERVIEW_AZIMUTH, OVERVIEW_ELEVATION, 1, OVERVIEW_D, OVERVIEW_R, OVERVIEW_V), bounds, dimensions);
  } catch {
    return PRESENTATION_FAILURE;
  }
}

export function resizeCamera(current: CameraState, bounds: readonly number[] | Float32Array, dimensions: PositiveDimensions): CameraTransitionResult {
  return transition(current, bounds, dimensions, (accepted) => accepted);
}

export function orbitCamera(
  current: CameraState,
  bounds: readonly number[] | Float32Array,
  dimensions: PositiveDimensions,
  azimuthDelta: number,
  elevationDelta: number,
): CameraTransitionResult {
  return transition(current, bounds, dimensions, (accepted) => {
    const azimuth = normaliseAzimuth(add(accepted.azimuth, finite(azimuthDelta)));
    const proposedElevation = add(accepted.elevation, finite(elevationDelta));
    const elevation = Math.min(MAXIMUM_ELEVATION, Math.max(MINIMUM_ELEVATION, proposedElevation));
    const basis = orientation(azimuth, elevation);
    return state(accepted.target, azimuth, elevation, accepted.magnification, basis.D, basis.R, basis.V);
  });
}

export function orbitCameraByKeyboard(
  current: CameraState,
  bounds: readonly number[] | Float32Array,
  dimensions: PositiveDimensions,
  key: "a" | "d" | "w" | "s",
): CameraTransitionResult {
  const azimuthDelta = key === "a" ? -KEYBOARD_AZIMUTH_STEP : key === "d" ? KEYBOARD_AZIMUTH_STEP : 0;
  const elevationDelta = key === "w" ? KEYBOARD_ELEVATION_STEP : key === "s" ? -KEYBOARD_ELEVATION_STEP : 0;
  return orbitCamera(current, bounds, dimensions, azimuthDelta, elevationDelta);
}

export function orbitCameraByPointer(
  current: CameraState,
  bounds: readonly number[] | Float32Array,
  dimensions: PositiveDimensions,
  dx: number,
  dy: number,
  cssWidth: number,
  cssHeight: number,
): CameraTransitionResult {
  try {
    if (!(finite(cssWidth) > 0) || !(finite(cssHeight) > 0)) throw new Error("invalid pointer dimensions");
    const azimuthDelta = divide(multiply(TAU, finite(dx)), cssWidth);
    const elevationDelta = -divide(multiply(Math.PI, finite(dy)), cssHeight);
    return orbitCamera(current, bounds, dimensions, azimuthDelta, finite(elevationDelta));
  } catch {
    return PRESENTATION_FAILURE;
  }
}

function panCamera(
  current: CameraState,
  bounds: readonly number[] | Float32Array,
  dimensions: PositiveDimensions,
  horizontalDistance: number,
  verticalDistance: number,
): CameraTransitionResult {
  return transition(current, bounds, dimensions, (accepted) => {
    const horizontal = scale(accepted.R, finite(horizontalDistance));
    const vertical = scale(accepted.V, finite(verticalDistance));
    return state(addVectors(addVectors(accepted.target, horizontal), vertical), accepted.azimuth, accepted.elevation,
      accepted.magnification, accepted.D, accepted.R, accepted.V);
  });
}

export function panCameraByPointer(
  current: CameraState,
  bounds: readonly number[] | Float32Array,
  dimensions: PositiveDimensions,
  dx: number,
  dy: number,
  cssWidth: number,
  cssHeight: number,
): CameraTransitionResult {
  const currentView = resizeCamera(current, bounds, dimensions);
  if (currentView.kind === "failure") return currentView;
  try {
    if (!(finite(cssWidth) > 0) || !(finite(cssHeight) > 0)) throw new Error("invalid pointer dimensions");
    const horizontalDistance = -divide(multiply(multiply(2, currentView.view.horizontalHalf), finite(dx)), cssWidth);
    const verticalDistance = divide(multiply(multiply(2, currentView.view.verticalHalf), finite(dy)), cssHeight);
    return panCamera(currentView.state, bounds, dimensions, horizontalDistance, verticalDistance);
  } catch {
    return PRESENTATION_FAILURE;
  }
}

export function panCameraByKeyboard(
  current: CameraState,
  bounds: readonly number[] | Float32Array,
  dimensions: PositiveDimensions,
  key: "A" | "D" | "W" | "S",
): CameraTransitionResult {
  const currentView = resizeCamera(current, bounds, dimensions);
  if (currentView.kind === "failure") return currentView;
  try {
    const horizontalStep = divide(multiply(2, currentView.view.horizontalHalf), 10);
    const verticalStep = divide(multiply(2, currentView.view.verticalHalf), 10);
    const horizontalDistance = key === "A" ? -horizontalStep : key === "D" ? horizontalStep : 0;
    const verticalDistance = key === "S" ? -verticalStep : key === "W" ? verticalStep : 0;
    return panCamera(currentView.state, bounds, dimensions, horizontalDistance, verticalDistance);
  } catch {
    return PRESENTATION_FAILURE;
  }
}

export function zoomCamera(
  current: CameraState,
  bounds: readonly number[] | Float32Array,
  dimensions: PositiveDimensions,
  direction: "in" | "out",
): CameraTransitionResult {
  return transition(current, bounds, dimensions, (accepted) => {
    const proposed = direction === "in"
      ? multiply(accepted.magnification, ZOOM_FACTOR)
      : divide(accepted.magnification, ZOOM_FACTOR);
    const magnification = Math.min(MAXIMUM_MAGNIFICATION, Math.max(MINIMUM_MAGNIFICATION, proposed));
    return state(accepted.target, accepted.azimuth, accepted.elevation, magnification, accepted.D, accepted.R, accepted.V);
  });
}

export function canvasToBackingPoint(
  clientX: number,
  clientY: number,
  rectangle: CanvasRectangle,
  backing: PositiveDimensions,
): Readonly<{ kind: "success"; point: BackingPoint; inside: boolean }> | PresentationPolicyFailure {
  try {
    const left = finite(rectangle.left);
    const top = finite(rectangle.top);
    const rectangleWidth = finite(rectangle.width);
    const rectangleHeight = finite(rectangle.height);
    const width = finite(backing.width);
    const height = finite(backing.height);
    if (!(rectangleWidth > 0) || !(rectangleHeight > 0) || !(width > 0) || !(height > 0)) throw new Error("invalid canvas dimensions");
    const xCss = subtract(finite(clientX), left);
    const yCss = subtract(finite(clientY), top);
    const x = divide(multiply(xCss, width), rectangleWidth);
    const y = divide(multiply(yCss, height), rectangleHeight);
    const point = Object.freeze({ x, y });
    return Object.freeze({ kind: "success", point, inside: 0 <= x && x <= width && 0 <= y && y <= height });
  } catch {
    return PRESENTATION_FAILURE;
  }
}

export function createOrthographicRay(
  view: CameraView,
  clientX: number,
  clientY: number,
  rectangle: CanvasRectangle,
  backing: PositiveDimensions,
): RayResult {
  const conversion = canvasToBackingPoint(clientX, clientY, rectangle, backing);
  if (conversion.kind === "failure") return conversion;
  if (!conversion.inside) return Object.freeze({ kind: "success", point: conversion.point, ray: null });
  try {
    const width = finite(backing.width);
    const height = finite(backing.height);
    const sx = multiply(subtract(divide(multiply(2, conversion.point.x), width), 1), finite(view.horizontalHalf));
    const sy = multiply(subtract(1, divide(multiply(2, conversion.point.y), height)), finite(view.verticalHalf));
    const origin = addVectors(addVectors(vector(view.camera[0], view.camera[1], view.camera[2]), scale(view.state.R, sx)), scale(view.state.V, sy));
    const direction = vector(-view.state.D[0], -view.state.D[1], -view.state.D[2]);
    return Object.freeze({ kind: "success", point: conversion.point, ray: Object.freeze({ origin, direction }) });
  } catch {
    return PRESENTATION_FAILURE;
  }
}

export function intersectRayAabb(rayValue: Ray, boundsValue: Bounds3): SlabResult {
  try {
    const origin = vector(rayValue.origin[0], rayValue.origin[1], rayValue.origin[2]);
    const direction = vector(rayValue.direction[0], rayValue.direction[1], rayValue.direction[2]);
    const bounds = snapshotBounds(boundsValue);
    let tEnter = 0;
    let tExit = Number.MAX_VALUE;
    for (let axis = 0; axis < 3; axis += 1) {
      const minimum = bounds[axis]!;
      const maximum = bounds[axis + 3]!;
      if (direction[axis] === 0) {
        if (origin[axis]! < minimum || origin[axis]! > maximum) return Object.freeze({ kind: "success", tEnter: null });
        continue;
      }
      let first = divide(subtract(minimum, origin[axis]!), direction[axis]!);
      let second = divide(subtract(maximum, origin[axis]!), direction[axis]!);
      if (first > second) [first, second] = [second, first];
      tEnter = Math.max(tEnter, first);
      tExit = Math.min(tExit, second);
      if (tEnter > tExit) return Object.freeze({ kind: "success", tEnter: null });
    }
    if (!Number.isFinite(tEnter) || tEnter < 0 || tEnter > tExit) return Object.freeze({ kind: "success", tEnter: null });
    return Object.freeze({ kind: "success", tEnter });
  } catch {
    return PRESENTATION_FAILURE;
  }
}

export function pickNearest(ray: Ray, geometry: PickingGeometry): PickResult {
  try {
    if (!Number.isSafeInteger(geometry.count) || geometry.count < 1 || geometry.count > MAX_PICK_INSTANCES
      || geometry.origins.length !== geometry.count * 3 || geometry.sizes.length !== geometry.count * 3) {
      throw new Error("invalid picking geometry");
    }
    let nearestIndex: number | null = null;
    let nearestDistance: number | null = null;
    for (let index = 0; index < geometry.count; index += 1) {
      const offset = index * 3;
      const minimumX = finite(geometry.origins[offset]!);
      const minimumY = finite(geometry.origins[offset + 1]!);
      const minimumZ = finite(geometry.origins[offset + 2]!);
      const maximumX = add(minimumX, finite(geometry.sizes[offset]!));
      const maximumY = add(minimumY, finite(geometry.sizes[offset + 1]!));
      const maximumZ = add(minimumZ, finite(geometry.sizes[offset + 2]!));
      const hit = intersectRayAabb(ray, [minimumX, minimumY, minimumZ, maximumX, maximumY, maximumZ]);
      if (hit.kind === "failure") return hit;
      if (hit.tEnter === null) continue;
      if (nearestDistance === null || hit.tEnter < nearestDistance
        || (hit.tEnter === nearestDistance && index < nearestIndex!)) {
        nearestIndex = index;
        nearestDistance = hit.tEnter;
      }
    }
    return Object.freeze({ kind: "success", index: nearestIndex, tEnter: nearestDistance });
  } catch {
    return PRESENTATION_FAILURE;
  }
}

export function pickAtCanvasPoint(
  view: CameraView,
  clientX: number,
  clientY: number,
  rectangle: CanvasRectangle,
  backing: PositiveDimensions,
  geometry: PickingGeometry,
): PickResult {
  const ray = createOrthographicRay(view, clientX, clientY, rectangle, backing);
  if (ray.kind === "failure") return ray;
  if (ray.ray === null) return Object.freeze({ kind: "success", index: null, tEnter: null });
  return pickNearest(ray.ray, geometry);
}
