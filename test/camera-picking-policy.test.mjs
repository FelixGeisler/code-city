import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const fixture = JSON.parse(await readFile(path.join(root, "test/fixtures/camera-picking-cases.json"), "utf8"));
const cityFixture = JSON.parse(await readFile(path.join(root, "test/fixtures/city-cases.json"), "utf8"));
const policy = await import("../src/domain/camera-picking-policy.ts");
const { buildCity } = await import("../src/domain/city-model.ts");
const { validateCityPayload } = await import("../src/application/city-payload.ts");
const overviewFixture = fixture.fitCases[0];

const {
  calculateOracleProjection,
  canvasToBackingPoint,
  createPerspectiveRay,
  evaluateStrictDepthOracle,
  intersectRayAabb,
  orbitCamera,
  orbitCameraByKeyboard,
  orbitCameraByPointer,
  panCameraByKeyboard,
  panCameraByPointer,
  pickAtCanvasPoint,
  pickNearest,
  projectDistricts,
  resetCamera,
  resizeCamera,
  zoomCamera,
} = policy;

function success(result, id = "result") {
  assert.equal(result.kind, "success", `${id}: ${JSON.stringify(result)}`);
  return result;
}

function failure(result, id = "result") {
  assert.deepEqual(result, { kind: "failure", category: "Presentation failed", code: "M1-PRES-1" }, id);
}

function near(actual, expected, id, tolerance = 1e-12) {
  assert(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${id}: ${actual} != ${expected}`);
}

function bytes(view) {
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
}

function referenceSlab(ray, bounds) {
  let enter = 0;
  let exit = Number.MAX_VALUE;
  for (let axis = 0; axis < 3; axis += 1) {
    if (ray.direction[axis] === 0) {
      if (ray.origin[axis] < bounds[axis] || ray.origin[axis] > bounds[axis + 3]) return null;
      continue;
    }
    let first = (bounds[axis] - ray.origin[axis]) / ray.direction[axis];
    let second = (bounds[axis + 3] - ray.origin[axis]) / ray.direction[axis];
    if (!Number.isFinite(first) || !Number.isFinite(second)) return "failure";
    if (first > second) [first, second] = [second, first];
    enter = Math.max(enter, first);
    exit = Math.min(exit, second);
    if (enter > exit) return null;
  }
  return Number.isFinite(enter) && enter >= 0 && enter <= exit ? enter : null;
}

function adjacent(value, direction) {
  if (Number.isNaN(value) || value === (direction > 0 ? Infinity : -Infinity)) return value;
  if (Object.is(value, -0)) value = 0;
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value, false);
  let bits = view.getBigUint64(0, false);
  if (value === 0) bits = direction > 0 ? 1n : (1n << 63n) | 1n;
  else bits += (value > 0) === (direction > 0) ? 1n : -1n;
  view.setBigUint64(0, bits, false);
  return view.getFloat64(0, false);
}

function geometryFromBoxes(boxes) {
  const origins = new Float32Array(boxes.length * 3);
  const sizes = new Float32Array(boxes.length * 3);
  boxes.forEach((box, index) => {
    const offset = index * 3;
    origins.set(box.slice(0, 3), offset);
    sizes.set([box[3] - box[0], box[4] - box[1], box[5] - box[2]], offset);
  });
  return { count: boxes.length, origins, sizes };
}

function project(view, world) {
  const q = world.map((component, axis) => component - view.centre[axis]);
  const m = view.matrix;
  const clipX = m[0] * q[0] + m[4] * q[1] + m[8] * q[2] + m[12];
  const clipY = m[1] * q[0] + m[5] * q[1] + m[9] * q[2] + m[13];
  const clipZ = m[2] * q[0] + m[6] * q[1] + m[10] * q[2] + m[14];
  const clipW = m[3] * q[0] + m[7] * q[1] + m[11] * q[2] + m[15];
  return { x: clipX / clipW, y: clipY / clipW, depth: clipZ / clipW, clipW };
}

function exactDistrictPoint(matrix, centre, point, dimensions) {
  const q = point.map((component, axis) => {
    const relative = component - centre[axis];
    assert.equal(Math.fround(relative), relative);
    return Math.fround(relative);
  });
  const clip = Array.from({ length: 4 }, (_, row) => {
    const p0 = Math.fround(matrix[row] * q[0]);
    const p1 = Math.fround(matrix[row + 4] * q[1]);
    const p2 = Math.fround(matrix[row + 8] * q[2]);
    const p3 = Math.fround(matrix[row + 12] * Math.fround(1));
    const s0 = Math.fround(p0 + p1);
    const s1 = Math.fround(s0 + p2);
    return Math.fround(s1 + p3);
  });
  assert(clip[3] > 0);
  const ndcX = Math.fround(clip[0] / clip[3]);
  const ndcY = Math.fround(clip[1] / clip[3]);
  const depth = Math.fround(clip[2] / clip[3]);
  assert(-1 < depth && depth < 1);
  return {
    screenX: (ndcX * 0.5 + 0.5) * dimensions.width,
    screenY: (-ndcY * 0.5 + 0.5) * dimensions.height,
    ndcX,
    ndcY,
  };
}

function adversarialBounds(source) {
  const Expected = Float32Array;
  const noReads = [];
  const guardedGetter = (id, value) => {
    let reads = 0;
    noReads.push(() => assert.equal(reads, 0, `${id}: invoked attacker getter/trap`));
    return { get: () => { reads += 1; return value; } };
  };
  const guardedProxy = (id, target, transparentGet = false) => {
    let traps = 0;
    noReads.push(() => assert.equal(traps, 0, `${id}: invoked attacker proxy trap`));
    return new Proxy(target, {
      get(inner, key) { traps += 1; return transparentGet ? Reflect.get(inner, key, inner) : undefined; },
      getOwnPropertyDescriptor(inner, key) { traps += 1; return Reflect.getOwnPropertyDescriptor(inner, key); },
      getPrototypeOf(inner) { traps += 1; return Reflect.getPrototypeOf(inner); },
      ownKeys(inner) { traps += 1; return Reflect.ownKeys(inner); },
    });
  };
  const prototypeFake = Object.create(Expected.prototype);
  for (let index = 0; index < source.length; index += 1) Object.defineProperty(prototypeFake, String(index), { configurable: true, enumerable: true, value: source[index], writable: true });
  Object.defineProperty(prototypeFake, "length", { configurable: true, ...guardedGetter("prototype fake length", source.length) });
  const tagFake = Object.create(Expected.prototype);
  Object.defineProperty(tagFake, Symbol.toStringTag, { configurable: true, ...guardedGetter("tag fake", Expected.name) });
  const extra = new Expected(source); Object.defineProperty(extra, "extra", { configurable: true, ...guardedGetter("typed extra", true) });
  const ownLength = new Expected(source); Object.defineProperty(ownLength, "length", { configurable: true, ...guardedGetter("own length", source.length) });
  const ownTag = new Expected(source); Object.defineProperty(ownTag, Symbol.toStringTag, { configurable: true, ...guardedGetter("own tag", Expected.name) });
  const bufferExtra = new Expected(source); Object.defineProperty(bufferExtra.buffer, "extra", { configurable: true, ...guardedGetter("buffer extra", true) });
  const wrongBrand = new Uint32Array(source.length); Object.setPrototypeOf(wrongBrand, Expected.prototype);
  const wrongView = new DataView(new ArrayBuffer(source.byteLength)); Object.setPrototypeOf(wrongView, Expected.prototype);
  class TypedArraySubclass extends Expected {}
  class ArrayBufferSubclass extends ArrayBuffer {}
  const detached = new Expected(source); structuredClone(detached.buffer, { transfer: [detached.buffer] });
  const revokedFake = Proxy.revocable(prototypeFake, {}); revokedFake.revoke();
  const revokedTyped = Proxy.revocable(new Expected(source), {}); revokedTyped.revoke();
  return {
    attacks: [
      ["prototype fake", prototypeFake], ["tag fake", tagFake],
      ["ordinary proxy", guardedProxy("ordinary proxy", prototypeFake)], ["revoked ordinary proxy", revokedFake.proxy],
      ["typed proxy", guardedProxy("typed proxy", new Expected(source), true)], ["revoked typed proxy", revokedTyped.proxy],
      ["wrong brand", wrongBrand], ["wrong view", wrongView], ["subclass", new TypedArraySubclass(source)],
      ["extra", extra], ["own length", ownLength], ["own tag", ownTag], ["buffer extra", bufferExtra],
      ["wrong length", new Expected(source.length - 1)],
      ["offset", new Expected(new ArrayBuffer(source.byteLength + 4), 4, source.length)],
      ["oversized buffer", new Expected(new ArrayBuffer(source.byteLength + 4), 0, source.length)],
      ["buffer subclass", new Expected(new ArrayBufferSubclass(source.byteLength))],
      ["shared buffer", new Expected(new SharedArrayBuffer(source.byteLength))], ["detached", detached],
    ],
    assertNoReads() { for (const assertion of noReads) assertion(); },
  };
}

test("the deterministic fixture is closed and fixes perspective fit, float32 columns, canvas edges, and slab boundaries", () => {
  assert.deepEqual(Object.keys(fixture), ["schemaVersion", "fitCases", "canvas", "slabs"]);
  assert.equal(fixture.schemaVersion, 2);
  assert.deepEqual(fixture.fitCases.map(({ id }) => id), ["landscape", "portrait", "offset"]);
  assert.deepEqual(fixture.canvas.closedClientEdges.length, 4);
  assert.deepEqual(fixture.slabs.map(({ id }) => id), ["front-face", "edge", "origin-on-face", "parallel-outside", "behind"]);
});

test("Reset produces the exact overview basis, 45-degree sphere fit, perspective columns, and strict Z/W oracle", () => {
  for (const entry of fixture.fitCases) {
    const { state, view } = success(resetCamera(entry.bounds, entry.dimensions), entry.id);
    const expected = entry.expected;
    for (const key of ["target", "D", "R", "V"]) assert.deepEqual(state[key], expected[key], `${entry.id}:${key}`);
    for (const key of ["azimuth", "elevation", "magnification"]) assert.equal(state[key], expected[key], `${entry.id}:${key}`);
    for (const key of ["aspect", "verticalFov", "radius", "limitingHalfFov", "baseDistance", "E", "distance", "s0", "near", "far", "verticalSlope", "horizontalSlope"]) {
      assert.equal(view[key], expected[key], `${entry.id}:${key}`);
    }
    assert.deepEqual(view.matrix, expected.matrix, `${entry.id}:matrix`);
    assert.deepEqual(view.oracleClipZ, expected.clipZ, `${entry.id}:clipZ`);
    assert.deepEqual(view.oracleClipW, expected.clipW, `${entry.id}:clipW`);
    assert.deepEqual(view.oracleDepths, expected.depths, `${entry.id}:depths`);
    assert(view.oracleClipW.every((clipW) => clipW > 0));
    assert(view.oracleDepths.every((depth) => -1 < depth && depth < 1));
    assert(Object.isFrozen(state) && Object.isFrozen(view) && Object.isFrozen(view.matrix));
  }
  const { state, view } = success(resetCamera(overviewFixture.bounds, overviewFixture.dimensions));
  const theta = Math.PI / 8;
  const lengths = [8, 6, 10];
  const expectedRadius = Math.hypot(...lengths) / 2;
  const expectedDistance = 1.18 * expectedRadius / Math.sin(Math.min(theta, Math.atan(view.aspect * Math.tan(theta))));
  const expectedE = lengths.reduce((sum, length, axis) => sum + length * Math.abs(state.D[axis]), 0) / 2;
  assert.equal(view.verticalFov, Math.PI / 4);
  near(view.baseDistance, expectedDistance, "baseDistance");
  near(view.distance, expectedDistance, "distance");
  near(view.near, (expectedDistance - expectedE) / 2, "near");
  near(view.far, expectedDistance + expectedE + (expectedDistance - expectedE) / 2, "far");
  assert.deepEqual([view.matrix[3], view.matrix[7], view.matrix[11]], state.D.map((component) => Math.fround(-component)));
  assert.equal(view.matrix[15], Math.fround(view.s0));
});

test("keyboard and pointer orbit use exact directions, normalization, clamps, and regenerated orthonormal basis", () => {
  const reset = success(resetCamera(overviewFixture.bounds, overviewFixture.dimensions));
  const a = success(orbitCameraByKeyboard(reset.state, overviewFixture.bounds, overviewFixture.dimensions, "a"));
  near(a.state.azimuth, reset.state.azimuth - Math.PI / 12, "A azimuth");
  const d = success(orbitCameraByKeyboard(reset.state, overviewFixture.bounds, overviewFixture.dimensions, "d"));
  near(d.state.azimuth, reset.state.azimuth + Math.PI / 12, "D azimuth");
  const w = success(orbitCameraByKeyboard(reset.state, overviewFixture.bounds, overviewFixture.dimensions, "w"));
  near(w.state.elevation, reset.state.elevation + Math.PI / 24, "W elevation");
  const s = success(orbitCameraByKeyboard(reset.state, overviewFixture.bounds, overviewFixture.dimensions, "s"));
  near(s.state.elevation, reset.state.elevation - Math.PI / 24, "S elevation");
  const pointer = success(orbitCameraByPointer(reset.state, overviewFixture.bounds, overviewFixture.dimensions, 100, 0, 400, 200));
  near(pointer.state.azimuth, reset.state.azimuth + Math.PI / 2, "pointer azimuth");
  near(pointer.state.elevation, reset.state.elevation, "horizontal pointer elevation");
  const clamped = success(orbitCamera(reset.state, overviewFixture.bounds, overviewFixture.dimensions, -100 * Math.PI, 100 * Math.PI));
  assert(clamped.state.azimuth >= 0 && clamped.state.azimuth < 2 * Math.PI);
  assert.equal(clamped.state.elevation, policy.MAXIMUM_ELEVATION);
  near(clamped.state.D[0] ** 2 + clamped.state.D[1] ** 2 + clamped.state.D[2] ** 2, 1, "D length");
  near(clamped.state.R[0] * clamped.state.V[1] - clamped.state.R[1] * clamped.state.V[0], clamped.state.D[2], "R cross V z");
});

test("primary pointer vertical orbit independently follows both non-clamping signs", () => {
  const reset = success(resetCamera(overviewFixture.bounds, overviewFixture.dimensions));
  const upward = success(orbitCameraByPointer(reset.state, overviewFixture.bounds, overviewFixture.dimensions, 0, -10, 400, 200));
  const downward = success(orbitCameraByPointer(reset.state, overviewFixture.bounds, overviewFixture.dimensions, 0, 10, 400, 200));

  near(upward.state.elevation, reset.state.elevation - Math.PI / 20, "upward pointer elevation");
  near(downward.state.elevation, reset.state.elevation + Math.PI / 20, "downward pointer elevation");
  assert(upward.state.elevation < reset.state.elevation, "upward drag did not lower elevation");
  assert(downward.state.elevation > reset.state.elevation, "downward drag did not raise elevation");
  assert.equal(upward.state.azimuth, reset.state.azimuth);
  assert.equal(downward.state.azimuth, reset.state.azimuth);
});

test("primary pointer upward orbit clamps at the inclusive minimum elevation", () => {
  const reset = success(resetCamera(overviewFixture.bounds, overviewFixture.dimensions));
  const upward = success(orbitCameraByPointer(reset.state, overviewFixture.bounds, overviewFixture.dimensions, 0, -200, 400, 200));
  assert.equal(upward.state.elevation, policy.MINIMUM_ELEVATION);
});

test("primary pointer downward orbit clamps at the inclusive maximum elevation", () => {
  const reset = success(resetCamera(overviewFixture.bounds, overviewFixture.dimensions));
  const downward = success(orbitCameraByPointer(reset.state, overviewFixture.bounds, overviewFixture.dimensions, 0, 200, 400, 200));
  assert.equal(downward.state.elevation, policy.MAXIMUM_ELEVATION);
});

test("pointer and keyboard pan, zoom, resize, and Reset retain or restore exactly the contracted components", () => {
  const original = success(resetCamera(overviewFixture.bounds, overviewFixture.dimensions));
  const pointer = success(panCameraByPointer(original.state, overviewFixture.bounds, overviewFixture.dimensions, 20, 10, 200, 100));
  const expectedHorizontal = -(2 * original.view.horizontalHalf * 20 / 200);
  const expectedVertical = 2 * original.view.verticalHalf * 10 / 100;
  for (let axis = 0; axis < 3; axis += 1) {
    near(pointer.state.target[axis], original.state.target[axis] + original.state.R[axis] * expectedHorizontal
      + original.state.V[axis] * expectedVertical, `pointer target ${axis}`);
  }
  const A = success(panCameraByKeyboard(original.state, overviewFixture.bounds, overviewFixture.dimensions, "A"));
  const D = success(panCameraByKeyboard(original.state, overviewFixture.bounds, overviewFixture.dimensions, "D"));
  const S = success(panCameraByKeyboard(original.state, overviewFixture.bounds, overviewFixture.dimensions, "S"));
  const W = success(panCameraByKeyboard(original.state, overviewFixture.bounds, overviewFixture.dimensions, "W"));
  for (let axis = 0; axis < 3; axis += 1) {
    near(A.state.target[axis] + D.state.target[axis], 2 * original.state.target[axis], `A/D symmetry ${axis}`);
    near(S.state.target[axis] + W.state.target[axis], 2 * original.state.target[axis], `S/W symmetry ${axis}`);
  }
  let zoomed = original;
  for (let index = 0; index < 100; index += 1) zoomed = success(zoomCamera(zoomed.state, overviewFixture.bounds, overviewFixture.dimensions, "in"));
  assert.equal(zoomed.state.magnification, 64);
  for (const key of ["target", "D", "R", "V"]) assert.deepEqual(zoomed.state[key], original.state[key], `zoom ${key}`);
  for (const key of ["distance", "s0", "camera", "near", "far"]) assert.deepEqual(zoomed.view[key], original.view[key], `zoom ${key}`);
  assert.equal(zoomed.view.verticalSlope, Math.tan(Math.PI / 8) / 64);
  for (let index = 0; index < 200; index += 1) zoomed = success(zoomCamera(zoomed.state, overviewFixture.bounds, overviewFixture.dimensions, "out"));
  assert.equal(zoomed.state.magnification, 1 / 64);
  for (const key of ["distance", "s0", "camera", "near", "far"]) assert.deepEqual(zoomed.view[key], original.view[key], `zoom-out ${key}`);
  const resized = success(resizeCamera(pointer.state, overviewFixture.bounds, { width: 300, height: 900 }));
  assert.deepEqual(resized.state, pointer.state);
  assert.notEqual(resized.view.baseDistance, pointer.view.baseDistance);
  const restored = success(resetCamera(overviewFixture.bounds, { width: 300, height: 900 }));
  assert.deepEqual(restored.state.target, original.state.target);
  assert.deepEqual(restored.state.D, original.state.D);
  assert.equal(restored.state.magnification, 1);
});

test("pan retains lateral compensation while every committable state remains strictly depth-contained", () => {
  let current = success(resetCamera(overviewFixture.bounds, overviewFixture.dimensions));
  for (let index = 0; index < 40; index += 1) {
    current = success(panCameraByKeyboard(current.state, overviewFixture.bounds, overviewFixture.dimensions, index % 2 ? "D" : "W"));
    assert(current.view.oracleDepths.every((depth) => -1 < depth && depth < 1));
  }
  assert(Math.abs(current.view.dr) > 1 || Math.abs(current.view.dv) > 1, "pan is not laterally clipped");
  assert.equal(current.view.matrix[12], Math.fround(current.view.fx * current.view.dr));
  assert.equal(current.view.matrix[13], Math.fround(current.view.fy * current.view.dv));
});

test("the exact float32 oracle fixes separate Z/W rows, corner order, product/division rounding, and left association", () => {
  const interior = new Array(16).fill(0); interior[15] = 1;
  const zero = success(evaluateStrictDepthOracle([0, 0, 0, 2, 2, 2], [1, 1, 1], interior));
  assert.deepEqual(zero.clipZ, new Array(8).fill(0));
  assert.deepEqual(zero.clipW, new Array(8).fill(1));
  assert.deepEqual(zero.depths, new Array(8).fill(0));

  const layout = [...interior];
  layout[2] = 0.25; layout[6] = 0.125; layout[10] = 0.0625;
  layout[3] = 0.125; layout[7] = -0.0625; layout[11] = 0.03125; layout[15] = 2;
  const ordered = success(evaluateStrictDepthOracle([0, 0, 0, 2, 2, 2], [1, 1, 1], layout));
  assert.deepEqual(ordered.clipZ, [-0.4375, 0.0625, -0.1875, 0.3125, -0.3125, 0.1875, -0.0625, 0.4375]);
  assert.deepEqual(ordered.clipW, [1.90625, 2.15625, 1.78125, 2.03125, 1.96875, 2.21875, 1.84375, 2.09375]);
  assert.deepEqual(ordered.depths, ordered.clipZ.map((value, index) => Math.fround(value / ordered.clipW[index])));

  const rounded = [...interior]; rounded[2] = Math.fround(0.1); rounded[15] = Math.fround(0.3);
  const projection = success(calculateOracleProjection(rounded, [Math.fround(0.1), 0, 0]));
  assert.equal(projection.clipZ, Math.fround(Math.fround(0.1) * Math.fround(0.1)));
  assert.equal(projection.quotient, projection.clipZ / Math.fround(0.3));
  assert.equal(projection.depth, Math.fround(projection.quotient));
  assert.notEqual(projection.depth, projection.quotient, "division must receive its own final float32 rounding");

  const halfUlp = 2 ** -24;
  const associated = [...interior]; associated[2] = 1; associated[6] = halfUlp; associated[10] = -halfUlp;
  assert.equal(success(calculateOracleProjection(associated, [1, 1, 1])).depth, Math.fround(Math.fround(Math.fround(1 + halfUlp) - halfUlp)));
  assert.equal(success(calculateOracleProjection(associated, [1, 1, 1])).depth, 1 - 2 ** -24);
  assert.equal(Math.fround(1 + Math.fround(halfUlp - halfUlp)), 1, "a different association reaches the rejected boundary");
});

test("strict depth and positive-W boundaries, adjacent interiors, malformed columns, and overflow fail closed", () => {
  const matrix = new Array(16).fill(0); matrix[15] = 1;
  for (const boundary of [-1, 1]) {
    const candidate = [...matrix]; candidate[14] = boundary;
    failure(evaluateStrictDepthOracle([0, 0, 0, 2, 2, 2], [1, 1, 1], candidate), `depth boundary ${boundary}`);
    const adjacentInside = [...matrix]; adjacentInside[14] = boundary < 0 ? -1 + 2 ** -24 : 1 - 2 ** -24;
    assert(success(evaluateStrictDepthOracle([0, 0, 0, 2, 2, 2], [1, 1, 1], adjacentInside)).depths.every((depth) => -1 < depth && depth < 1));
  }
  const zeroW = [...matrix]; zeroW[15] = 0;
  failure(calculateOracleProjection(zeroW, [0, 0, 0]), "clipW=0 division");
  failure(evaluateStrictDepthOracle([0, 0, 0, 2, 2, 2], [1, 1, 1], zeroW), "clipW=0 oracle");
  const negativeW = [...matrix]; negativeW[15] = -1;
  assert.equal(success(calculateOracleProjection(negativeW, [0, 0, 0])).clipW, -1);
  failure(evaluateStrictDepthOracle([0, 0, 0, 2, 2, 2], [1, 1, 1], negativeW), "negative clipW");
  for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, 0.1]) {
    const candidate = [...matrix]; candidate[2] = invalid;
    failure(evaluateStrictDepthOracle([0, 0, 0, 2, 2, 2], [1, 1, 1], candidate), `matrix ${invalid}`);
  }
  const overflow = [...matrix]; overflow[2] = Math.fround(3.4028234663852886e38);
  failure(calculateOracleProjection(overflow, [Math.fround(3.4028234663852886e38), 0, 0]), "product overflow");
});

test("rejected camera transitions preserve the prior state atomically", () => {
  const committed = success(resetCamera(overviewFixture.bounds, overviewFixture.dimensions));
  const before = structuredClone(committed.state);
  const finiteTarget = { ...committed.state, target: [Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE] };
  failure(resizeCamera(finiteTarget, overviewFixture.bounds, overviewFixture.dimensions));
  assert.deepEqual(committed.state, before, "the prior state was not partially mutated");
  failure(panCameraByPointer(committed.state, overviewFixture.bounds, overviewFixture.dimensions,
    Number.MAX_VALUE, Number.MAX_VALUE, 1, 1));
  assert.deepEqual(committed.state, before, "overflow did not partially commit");
});

test("camera bounds and aspect admission rejects malformed arrays, accessors, branded fakes, proxies, and unsafe buffers without reads", () => {
  const dimensions = { width: 100, height: 100 };
  for (const bounds of [
    [0, 0, 0, 0, 1, 1], [0, 0, 0, 1, 0, 1], [0, 0, 0, 1, 1, 0],
    [0, 0, 0, -1, 1, 1], [0, 0, 0, 1, Number.NaN, 1], [0, 0, 0, 1, 1],
    Object.assign([0, 0, 0, 1, 1, 1], { extra: true }), new Float64Array([0, 0, 0, 1, 1, 1]),
  ]) failure(resetCamera(bounds, dimensions));
  const accessorBounds = [0, 0, 0, 1, 1, 1];
  let reads = 0;
  Object.defineProperty(accessorBounds, "0", { enumerable: true, get: () => { reads += 1; return 0; } });
  failure(resetCamera(accessorBounds, dimensions), "accessor bounds");
  assert.equal(reads, 0);
  for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    failure(resetCamera([0, 0, 0, 1, 1, 1], { width: invalid, height: 1 }), `width ${invalid}`);
    failure(resetCamera([0, 0, 0, 1, 1, 1], { width: 1, height: invalid }), `height ${invalid}`);
  }
  const adversarial = adversarialBounds(new Float32Array([0, 0, 0, 1, 1, 1]));
  for (const [id, value] of adversarial.attacks) failure(resetCamera(value, dimensions), id);
  adversarial.assertNoReads();
  success(resetCamera(new Float32Array([0, 0, 0, 7, 5, 8]), { width: 200, height: 100 }), "exact Float32 bounds");
});

test("CSS conversion accepts all closed edges exactly and misses each outside-by-one representable coordinate", () => {
  fixture.canvas.closedClientEdges.forEach(([x, y], index) => {
    const converted = success(canvasToBackingPoint(x, y, fixture.canvas.rectangle, fixture.canvas.backing));
    assert.equal(converted.inside, true);
    assert.deepEqual(converted.point, { x: fixture.canvas.backingEdges[index][0], y: fixture.canvas.backingEdges[index][1] });
  });
  const outside = [
    [10 - Number.MIN_VALUE, 20], [110.00000000000001, 20], [10, 20 - Number.MIN_VALUE], [10, 70.00000000000001],
  ];
  // At nonzero edges, use the adjacent representable value because MIN_VALUE rounds away.
  outside[0][0] = 9.999999999999998;
  outside[2][1] = 19.999999999999996;
  for (const [x, y] of outside) assert.equal(success(canvasToBackingPoint(x, y, fixture.canvas.rectangle, fixture.canvas.backing)).inside, false);
  for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    failure(canvasToBackingPoint(10, 20, { ...fixture.canvas.rectangle, width: invalid }, fixture.canvas.backing));
  }
});

test("perspective rays share the camera origin and diverge unnormalised at the closed centre and edges", () => {
  const overview = success(resetCamera(overviewFixture.bounds, overviewFixture.dimensions));
  const centre = success(createPerspectiveRay(overview.view, 60, 45, fixture.canvas.rectangle, fixture.canvas.backing));
  assert.deepEqual(centre.ray.origin, overview.view.camera);
  assert.deepEqual(centre.ray.direction, overview.state.D.map((component) => -component));
  const corner = success(createPerspectiveRay(overview.view, 10, 20, fixture.canvas.rectangle, fixture.canvas.backing));
  assert.deepEqual(corner.ray.origin, overview.view.camera);
  for (let axis = 0; axis < 3; axis += 1) {
    near(corner.ray.direction[axis], -overview.state.D[axis] - overview.view.horizontalSlope * overview.state.R[axis]
      + overview.view.verticalSlope * overview.state.V[axis], `corner direction ${axis}`);
  }
  assert.notDeepEqual(corner.ray.direction, centre.ray.direction);
  assert.notEqual(Math.hypot(...corner.ray.direction), 1, "edge direction was unexpectedly normalised");
  const moved = success(panCameraByKeyboard(overview.state, overviewFixture.bounds, overviewFixture.dimensions, "D"));
  const movedRay = success(createPerspectiveRay(moved.view, 60, 45, fixture.canvas.rectangle, fixture.canvas.backing));
  assert.deepEqual(movedRay.ray.origin, moved.view.camera);
  assert.notDeepEqual(movedRay.ray.origin, centre.ray.origin);
  assert.equal(success(createPerspectiveRay(moved.view, 110.00000000000001, 45, fixture.canvas.rectangle, fixture.canvas.backing)).ray, null);
});

test("equal-sized nearer geometry appears larger and depth-parallel edges converge", () => {
  const overview = success(resetCamera(overviewFixture.bounds, overviewFixture.dimensions));
  const { D, R } = overview.state;
  const C = overview.view.centre;
  const point = (depth, side) => C.map((component, axis) => component + depth * D[axis] + side * R[axis]);
  const nearLeft = project(overview.view, point(2, -1));
  const nearRight = project(overview.view, point(2, 1));
  const farLeft = project(overview.view, point(-2, -1));
  const farRight = project(overview.view, point(-2, 1));
  assert(nearLeft.clipW > 0 && nearRight.clipW > 0 && farLeft.clipW > 0 && farRight.clipW > 0);
  assert(nearRight.x - nearLeft.x > farRight.x - farLeft.x, "equal-sized nearer box was not larger");
  assert(Math.abs(nearLeft.x - farLeft.x) > 0 && Math.abs(nearRight.x - farRight.x) > 0,
    "depth-parallel edge endpoints did not converge projectively");
});

test("native projection and perspective picking stay aligned after overview, orbit, pan, zoom, resize, and Reset", () => {
  const bounds = overviewFixture.bounds;
  const geometry = geometryFromBoxes([bounds]);
  let dimensions = overviewFixture.dimensions;
  let current = success(resetCamera(bounds, dimensions));
  const states = [["overview", current]];
  current = success(orbitCameraByKeyboard(current.state, bounds, dimensions, "d")); states.push(["orbit", current]);
  current = success(panCameraByKeyboard(current.state, bounds, dimensions, "D")); states.push(["pan", current]);
  current = success(zoomCamera(current.state, bounds, dimensions, "in")); states.push(["zoom", current]);
  dimensions = { width: 900, height: 600 };
  current = success(resizeCamera(current.state, bounds, dimensions)); states.push(["resize", current]);
  current = success(resetCamera(bounds, dimensions)); states.push(["Reset", current]);
  for (const [label, camera] of states) {
    const size = label === "resize" || label === "Reset" ? dimensions : overviewFixture.dimensions;
    const ndc = project(camera.view, camera.view.centre);
    const x = (ndc.x + 1) * size.width / 2;
    const y = (1 - ndc.y) * size.height / 2;
    assert(x >= 0 && x <= size.width && y >= 0 && y <= size.height, `${label}: projected centre outside canvas`);
    assert.equal(success(pickAtCanvasPoint(camera.view, x, y, { left: 0, top: 0, width: size.width, height: size.height }, size, geometry), label).index, 0);
  }
});

test("inclusive slabs cover faces, edges, origins, exact-zero parallel axes, behind-camera boxes, and overflow", () => {
  for (const entry of fixture.slabs) {
    const hit = success(intersectRayAabb(entry.ray, entry.bounds), entry.id);
    assert.equal(hit.tEnter, entry.tEnter, entry.id);
  }
  assert.equal(success(intersectRayAabb({ origin: [0, 0, 0], direction: [1, 0, 0] }, [0, 0, 0, 1, 1, 1])).tEnter, 0);
  failure(intersectRayAabb({ origin: [Number.MAX_VALUE, 0.5, 0.5], direction: [Number.MIN_VALUE, 0, 0] }, [0, 0, 0, 1, 1, 1]));
});

test("all AABB faces and twelve edges are inclusive, with adjacent outside values rejected on parallel slabs", () => {
  const bounds = [0, 0, 0, 1, 1, 1];
  for (let travelAxis = 0; travelAxis < 3; travelAxis += 1) {
    const otherAxes = [0, 1, 2].filter((axis) => axis !== travelAxis);
    for (const firstEdge of [0, 1]) {
      for (const secondEdge of [0, 1]) {
        const origin = [0.5, 0.5, 0.5];
        const direction = [0, 0, 0];
        origin[travelAxis] = -1;
        origin[otherAxes[0]] = firstEdge;
        origin[otherAxes[1]] = secondEdge;
        direction[travelAxis] = 1;
        assert.equal(success(intersectRayAabb({ origin, direction }, bounds)).tEnter, 1,
          `axis ${travelAxis}, edge ${firstEdge}/${secondEdge}`);
      }
    }
    for (const outside of [adjacent(0, -1), adjacent(1, 1)]) {
      const origin = [0.5, 0.5, -1];
      const direction = [0, 0, 1];
      origin[travelAxis] = outside;
      direction[travelAxis] = 0;
      const activeAxis = (travelAxis + 1) % 3;
      origin[activeAxis] = -1;
      direction[activeAxis] = 1;
      assert.equal(success(intersectRayAabb({ origin, direction }, bounds)).tEnter, null,
        `axis ${travelAxis}, adjacent outside ${outside}`);
    }
  }
  for (let faceAxis = 0; faceAxis < 3; faceAxis += 1) {
    for (const face of [0, 1]) {
      const origin = [0.5, 0.5, 0.5];
      const direction = [0, 0, 0];
      origin[faceAxis] = face;
      direction[faceAxis] = face === 0 ? 1 : -1;
      assert.equal(success(intersectRayAabb({ origin, direction }, bounds)).tEnter, 0, `origin on face ${faceAxis}/${face}`);
    }
  }
});

test("nearest picking uses exact distance, lower canonical-index ties, and has no capacity below 4,000", () => {
  const ray = { origin: [0.5, 0.5, -1], direction: [0, 0, 1] };
  const tied = geometryFromBoxes([[0, 0, 0, 1, 1, 1], [0, 0, 0, 1, 1, 1], [0, 0, 3, 1, 1, 4]]);
  assert.deepEqual(success(pickNearest(ray, tied)), { kind: "success", index: 0, tEnter: 1 });
  const boxes = Array.from({ length: 4_000 }, (_, index) => [0, 0, index * 2, 1, 1, index * 2 + 1]);
  const full = geometryFromBoxes(boxes);
  assert.deepEqual(success(pickNearest(ray, full)), { kind: "success", index: 0, tEnter: 1 });
  assert.equal(full.count, 4_000);
  failure(pickNearest(ray, { count: 4_001, origins: new Float32Array(12_003), sizes: new Float32Array(12_003) }));
});

test("deterministic slab properties agree with an independent inclusive reference over boundaries", () => {
  let seed = 0x529cafe;
  const random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 2 ** 32);
  for (let index = 0; index < 1_000; index += 1) {
    const minimum = [random() * 20 - 10, random() * 20 - 10, random() * 20 - 10];
    const size = [random() * 4 + 0.01, random() * 4 + 0.01, random() * 4 + 0.01];
    const bounds = [...minimum, ...minimum.map((value, axis) => value + size[axis])];
    const ray = {
      origin: [random() * 30 - 15, random() * 30 - 15, random() * 30 - 15],
      direction: [index % 7 === 0 ? 0 : random() * 2 - 1, index % 11 === 0 ? 0 : random() * 2 - 1, index % 13 === 0 ? 0 : random() * 2 - 1],
    };
    const expected = referenceSlab(ray, bounds);
    const actual = intersectRayAabb(ray, bounds);
    if (expected === "failure") failure(actual); else assert.equal(success(actual).tEnter, expected, `case ${index}`);
  }
});

test("overview and moved-camera center rays pick validated world AABBs", () => {
  const overview = success(resetCamera(overviewFixture.bounds, overviewFixture.dimensions));
  const geometry = geometryFromBoxes([overviewFixture.bounds]);
  assert.equal(success(pickAtCanvasPoint(overview.view, 60, 45, fixture.canvas.rectangle, fixture.canvas.backing, geometry)).index, 0);
  const moved = success(panCameraByKeyboard(overview.state, overviewFixture.bounds, overviewFixture.dimensions, "D"));
  assert.equal(success(pickAtCanvasPoint(moved.view, 60, 45, fixture.canvas.rectangle, fixture.canvas.backing, geometry)).index, 0);
});

test("native picking misses both intra-group and inter-group whitespace in grouped geometry", () => {
  const city = validateCityPayload(buildCity([
    { canonicalPath: "a/x/one.ts", S: 1, U: 0, M: 0 },
    { canonicalPath: "a/x/two.ts", S: 1, U: 0, M: 0 },
    { canonicalPath: "b/x/one.ts", S: 1, U: 0, M: 0 },
  ]));
  assert.deepEqual([...city.geometry.origins], [0, 0, 0, 5, 0, 0, 0, 0, 17]);
  assert.deepEqual(city.presentation.sceneBounds, [-3, -0.5, -3, 11, 8, 23]);
  const dimensions = { width: 1000, height: 800 };
  const view = success(resetCamera(city.presentation.sceneBounds, dimensions)).view;
  const projectGround = (x, z) => {
    const relative = [x - view.centre[0], -view.centre[1], z - view.centre[2]];
    const matrix = view.matrix;
    const clipX = matrix[0] * relative[0] + matrix[4] * relative[1] + matrix[8] * relative[2] + matrix[12];
    const clipY = matrix[1] * relative[0] + matrix[5] * relative[1] + matrix[9] * relative[2] + matrix[13];
    const clipW = matrix[3] * relative[0] + matrix[7] * relative[1] + matrix[11] * relative[2] + matrix[15];
    const ndcX = clipX / clipW;
    const ndcY = clipY / clipW;
    return { x: (ndcX + 1) * dimensions.width / 2, y: (1 - ndcY) * dimensions.height / 2 };
  };
  const rectangle = { left: 0, top: 0, width: dimensions.width, height: dimensions.height };
  for (const [id, point] of [["plate-padding", [-2, 1]], ["intra-group", [3.5, 2.5]], ["inter-group", [4, 10]]]) {
    const canvas = projectGround(...point);
    assert.deepEqual(success(pickAtCanvasPoint(view, canvas.x, canvas.y, rectangle, dimensions, city.geometry), id), { kind: "success", index: null, tEnter: null });
  }
});

test("surface focus stays display-only and preserves real-AABB picking", async () => {
  const presenter = await readFile(path.join(root, "src/edge/city-presenter.ts"), "utf8");
  for (const statement of [
    "uniform int u_hoverIndex;",
    "uniform int u_selectionIndex;",
    "displayed = 0.70 * ordinary;",
    "mix(displayed, ordinary, 0.15)",
    "mix(ordinary, vec3(1.0), 0.15)",
    "gl.uniform1i(hoverUniform, session.hover ?? -1)",
    "gl.uniform1i(selectionUniform, session.selection ?? -1)",
  ]) assert(presenter.includes(statement), statement);
  for (const removed of ["SELECTION_BOX_POSITIONS", "HOVER_BOX_POSITIONS", "BOX_EDGE_INDICES", "bufferSubData", "DYNAMIC_DRAW", "gl.LINES"]) {
    assert.equal(presenter.includes(removed), false, removed);
  }
  const realBuildingBounds = [135_982, 0, 135_982, 136_000, 40, 136_000];
  const outsideRay = { origin: [135_982 - 0.1, 20, 135_981], direction: [0, 0, 1] };
  assert.equal(success(intersectRayAabb(outsideRay, realBuildingBounds), "real AABB picking").tEnter, null);
});

test("both full 4,000-city envelopes keep immutable origin-C endpoints and strict perspective depth through all camera transitions", () => {
  const envelope = cityFixture.fullEnvelope;
  const cases = [
    ["concentrated", (index) => `camera/${String(index).padStart(4, "0")}.ts`],
    ["manyGroups", (index) => `g${String(index).padStart(4, "0")}/src/file.ts`],
  ];
  for (const [id, canonicalPath] of cases) {
    const facts = Array.from({ length: envelope.count }, (_, index) => ({
      canonicalPath: canonicalPath(index),
      ...(index < envelope.largeFactCount ? envelope.largeFact : envelope.smallFact),
    }));
    const city = validateCityPayload(buildCity(facts));
    assert.deepEqual([...city.geometry.bounds], envelope[id].expectedBounds, id);
    const expectedScene = id === "concentrated"
      ? [-3, -0.5, -3, 331, 40, 341]
      : [-3, -0.5, -3, 1077, 40, 1075];
    assert.deepEqual(city.presentation.sceneBounds, expectedScene, `${id}: scene bounds`);
    assert.deepEqual(city.presentation.centre, id === "concentrated" ? [164, 19.75, 169] : [537, 19.75, 536]);
    assert.equal(city.presentation.plates.length, id === "concentrated" ? 1 : 4000);
    const originalOrigins = Buffer.from(bytes(city.geometry.origins));
    const originalSizes = Buffer.from(bytes(city.geometry.sizes));
    const centre = city.presentation.centre;
    for (let index = 0; index < city.geometry.count; index += 1) {
      const offset = index * 3;
      for (let axis = 0; axis < 3; axis += 1) {
        const origin = city.geometry.origins[offset + axis];
        const endpoint = origin + city.geometry.sizes[offset + axis];
        assert.equal(Math.fround(origin - centre[axis]), origin - centre[axis]);
        assert.equal(Math.fround(endpoint - centre[axis]), endpoint - centre[axis]);
      }
    }
    for (const plate of city.presentation.plates) {
      for (let axis = 0; axis < 3; axis += 1) {
        const origin = plate.minimum[axis];
        const endpoint = origin + plate.dimensions[axis];
        assert.equal(Math.fround(origin - centre[axis]), origin - centre[axis], `${id}: plate origin axis ${axis}`);
        assert.equal(Math.fround(endpoint - centre[axis]), endpoint - centre[axis], `${id}: plate endpoint axis ${axis}`);
      }
    }
    const sceneBounds = city.presentation.sceneBounds;
    let camera = success(resetCamera(sceneBounds, { width: 4096, height: 2160 }));
    for (let index = 0; index < 32; index += 1) {
      const action = index % 4;
      camera = success(action === 0
        ? panCameraByPointer(camera.state, sceneBounds, { width: 4096, height: 2160 }, index - 16, 16 - index, 4096, 2160)
        : action === 1
          ? orbitCameraByKeyboard(camera.state, sceneBounds, { width: 4096, height: 2160 }, index % 2 ? "a" : "w")
          : action === 2
            ? zoomCamera(camera.state, sceneBounds, { width: 4096, height: 2160 }, index % 2 ? "out" : "in")
            : resizeCamera(camera.state, sceneBounds, { width: 2160, height: 4096 }));
      assert(camera.view.oracleClipW.every((clipW) => clipW > 0), `${id}: positive W`);
      assert(camera.view.oracleDepths.every((depth) => -1 < depth && depth < 1), `${id}: strict depth`);
    }
    for (const elevationDelta of [-100 * Math.PI, 100 * Math.PI]) {
      camera = success(orbitCamera(camera.state, sceneBounds, { width: 2160, height: 4096 }, 2 * Math.PI, elevationDelta));
      assert(camera.view.oracleClipW.every((clipW) => clipW > 0), `${id}: elevation-extreme positive W`);
      assert(camera.view.oracleDepths.every((depth) => -1 < depth && depth < 1), `${id}: elevation-extreme strict depth`);
    }
    camera = success(resetCamera(sceneBounds, { width: 4096, height: 2160 }));
    assert.deepEqual(camera.view.centre, city.presentation.centre);
    assert.equal(camera.state.magnification, 1);
    assert.deepEqual(bytes(city.geometry.origins), originalOrigins);
    assert.deepEqual(bytes(city.geometry.sizes), originalSizes);
  }
});


test("district projection independently proves exact float32 row order, quotients, unrounded CSS placement, and closed snapshots", () => {
  const city = validateCityPayload(buildCity([
    { canonicalPath: "a/one.ts", S: 0, U: 0, M: 0 },
    { canonicalPath: "b/two.ts", S: 0, U: 0, M: 0 },
  ]));
  const dimensions = { width: 997, height: 613 };
  const camera = success(resetCamera(city.presentation.sceneBounds, dimensions));
  const projected = success(projectDistricts(city.presentation.plates, city.presentation.centre, camera.view.matrix, dimensions));
  const expected = city.presentation.plates.map((plate) => {
    const [minimumX, , minimumZ] = plate.minimum;
    const [width, , depth] = plate.dimensions;
    const anchor = exactDistrictPoint(camera.view.matrix, city.presentation.centre, [minimumX + width / 2, 0, minimumZ + depth / 2], dimensions);
    const corners = [
      [minimumX, 0, minimumZ], [minimumX + width, 0, minimumZ],
      [minimumX, 0, minimumZ + depth], [minimumX + width, 0, minimumZ + depth],
    ].map((point) => exactDistrictPoint(camera.view.matrix, city.presentation.centre, point, dimensions));
    const xs = corners.map(({ screenX }) => screenX);
    const ys = corners.map(({ screenY }) => screenY);
    return {
      screenX: anchor.screenX,
      screenY: anchor.screenY,
      area: (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys)),
      lateral: -1 < anchor.ndcX && anchor.ndcX < 1 && -1 < anchor.ndcY && anchor.ndcY < 1,
    };
  });
  assert.deepEqual(projected.snapshot, { cssWidth: 997, cssHeight: 613, districts: expected });
  assert.deepEqual(Reflect.ownKeys(projected.snapshot), ["cssWidth", "cssHeight", "districts"]);
  assert(projected.snapshot.districts.every((district) => Reflect.ownKeys(district).join(",") === "screenX,screenY,area,lateral"));
  assert(Object.isFrozen(projected.snapshot) && Object.isFrozen(projected.snapshot.districts));
  assert(projected.snapshot.districts.every(Object.isFrozen));
  assert(projected.snapshot.districts.some(({ screenX, screenY }) => !Number.isInteger(screenX) || !Number.isInteger(screenY)));
});

test("district projection fails complete W, depth, finite, dimension, and exact-coordinate boundaries but retains lateral offscreen values", () => {
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const cell = Object.freeze({ minimum: Object.freeze([-0.5, -0.5, 0]), dimensions: Object.freeze([1, 0.5, 0.5]) });
  const accepted = success(projectDistricts([cell], [0, 0, 0], identity, { width: 101, height: 99 }));
  assert.deepEqual(accepted.snapshot.districts[0], { screenX: 50.5, screenY: 49.5, area: 0, lateral: true });

  const lateralCell = Object.freeze({ minimum: Object.freeze([2, -0.5, 0]), dimensions: Object.freeze([1, 0.5, 0.5]) });
  const lateral = success(projectDistricts([lateralCell], [0, 0, 0], identity, { width: 101, height: 99 }));
  assert.equal(lateral.snapshot.districts[0].lateral, false);
  assert(lateral.snapshot.districts[0].screenX > 101);

  const noW = new Float32Array(identity); noW[15] = 0;
  const depthBoundary = new Float32Array(identity);
  const depthCell = Object.freeze({ minimum: Object.freeze([-0.5, -0.5, 1]), dimensions: Object.freeze([1, 0.5, 0.5]) });
  const nonfinite = new Float32Array(identity); nonfinite[0] = Infinity;
  const inexactCell = Object.freeze({ minimum: Object.freeze([0.1, -0.5, 0]), dimensions: Object.freeze([1, 0.5, 0.5]) });
  for (const [id, result] of [
    ["W=0", projectDistricts([cell], [0, 0, 0], noW, { width: 101, height: 99 })],
    ["depth=1", projectDistricts([depthCell], [0, 0, 0], depthBoundary, { width: 101, height: 99 })],
    ["nonfinite matrix", projectDistricts([cell], [0, 0, 0], nonfinite, { width: 101, height: 99 })],
    ["inexact relative", projectDistricts([inexactCell], [0, 0, 0], identity, { width: 101, height: 99 })],
    ["fractional width", projectDistricts([cell], [0, 0, 0], identity, { width: 101.5, height: 99 })],
    ["zero height", projectDistricts([cell], [0, 0, 0], identity, { width: 101, height: 0 })],
  ]) failure(result, id);
});

test("accepted ADR history and current perspective requirements stay synchronized without ADR 0013", async () => {
  const adrFiles = [
    ["0008-browser-native-webgl2-instanced-city-presentation.adoc", 4_954, "4e5440b950fe24299b91508fe32bbf5b032afff0fe7d7691fa8335ba35f63374"],
    ["0011-interactive-webgl2-navigation-and-inspection.adoc", 21_131, "47e62d6bda9cb1561de95f1eb6835013ff90974b5129074ea8866b7ac6d4fc06"],
    ["0012-bounded-grouped-shaded-direct-webgl-city-presentation.adoc", 14_785, "c9ae8519714f2aef3a4efe3fbec99927d98bccf715d340e26af89b96af786fc3"],
  ];
  const adrs = [];
  for (const [file, expectedLength, expectedHash] of adrFiles) {
    const text = await readFile(path.join(root, "docs/modules/architecture/pages/adr", file), "utf8");
    const bytes = Buffer.from(text.replaceAll("\r\n", "\n"));
    assert.equal(bytes.byteLength, expectedLength, file);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expectedHash, file);
    assert.equal(bytes.at(-1), 10, file);
    assert.match(text, /^Status:: Accepted$/mu, file);
    adrs.push(text);
  }
  assert(adrs[0].includes("issues/569"));
  assert(adrs[1].includes("Subsequent refinement (issue 569)"));
  assert(adrs[2].includes("Subsequent refinement (issue 569)"));
  assert(adrs[1].includes("Subsequent refinement (issue 571)"));
  assert(adrs[2].includes("Subsequent refinement (issue 571)"));
  assert(adrs.every((adr) => adr.includes("issues/573") && adr.includes("issues/575")));
  assert.equal(await readFile(path.join(root, "docs/modules/architecture/nav.adoc"), "utf8").then((text) => text.includes("0013")), false);
  const requirements = await readFile(path.join(root, "docs/modules/requirements/pages/city-and-failures.adoc"), "utf8");
  const normalized = requirements.replace(/\s+/g, " ");
  for (const statement of [
    "At overview, the vertical field of view is `45°`", "sphere padding `p=1.18`",
    "immutable bounds-centre-relative point `q`", "clipW = s0-dot(q,D)",
    "`near>0`, `far>near`", "every float32 `clipW>0`", "`-1 < depth && depth < 1`",
    "not a claim of bit-identical WebGL/GLSL operation ordering or GPU depth",
    "Any violation rejects the complete transition atomically as *Presentation failed* / `M1-PRES-1`",
    "#22C55EFF", "#84CC16FF", "#FACC15FF", "#F59E0BFF", "#F97316FF", "#EF4444FF",
    "D = 0.70", "H = 0.15", "u_passKind", "u_hoverIndex", "u_selectionIndex", "208420",
    "Complexity: low → high", "M = 16+", "one program, two VAOs, and four immutable buffers", "#182A43FF",
  ]) assert(normalized.includes(statement), statement);
  for (const superseded of ["#F8FAFCFF", "#94A3B8FF", "-1/64", "65/64", "Selection draws first and hover second", "visible group plate"]) {
    assert.equal(normalized.includes(superseded), false, superseded);
  }
  const source = await readFile(path.join(root, "src/domain/camera-picking-policy.ts"), "utf8");
  for (const forbidden of ["document.", "window.", "WebGL", "addEventListener", "requestAnimationFrame", "Worker("]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});
