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

const {
  calculateOracleDepth,
  canvasToBackingPoint,
  createOrthographicRay,
  evaluateStrictDepthOracle,
  intersectRayAabb,
  orbitCamera,
  orbitCameraByKeyboard,
  orbitCameraByPointer,
  panCameraByKeyboard,
  panCameraByPointer,
  pickAtCanvasPoint,
  pickNearest,
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

test("the deterministic fixture is closed and names the exact overview, canvas edges, and slab boundaries", () => {
  assert.deepEqual(Object.keys(fixture), ["schemaVersion", "overview", "canvas", "slabs"]);
  assert.equal(fixture.schemaVersion, 1);
  assert.deepEqual(fixture.canvas.closedClientEdges.length, 4);
  assert.deepEqual(fixture.slabs.map(({ id }) => id), ["front-face", "edge", "origin-on-face", "parallel-outside", "behind"]);
});

test("Reset produces the exact M1 basis, fit, clipping formula, column-major matrix, and strict CPU depths", () => {
  const result = success(resetCamera(fixture.overview.bounds, fixture.overview.dimensions));
  const { state, view } = result;
  const sqrt2 = Math.sqrt(2), sqrt3 = Math.sqrt(3), sqrt6 = Math.sqrt(6);
  assert.deepEqual(state.target, [4, 3, 5]);
  assert.deepEqual(state.D, [1 / sqrt3, 1 / sqrt3, 1 / sqrt3]);
  assert.deepEqual(state.R, [1 / sqrt2, 0, -1 / sqrt2]);
  assert.deepEqual(state.V, [-1 / sqrt6, 2 / sqrt6, -1 / sqrt6]);
  assert.equal(state.azimuth, Math.PI / 4);
  assert.equal(state.elevation, Math.asin(1 / sqrt3));
  assert.equal(state.magnification, 1);
  const expectedE = (8 + 6 + 10) / (2 * sqrt3);
  near(view.E, expectedE, "E");
  near(view.distance, 3 * expectedE, "distance");
  near(view.near, expectedE, "near");
  near(view.far, 5 * expectedE, "far");
  assert.equal(view.delta, 0);
  assert.equal(view.tx, 0);
  assert.equal(view.ty, 0);
  assert.equal(view.tz, 0);
  assert.deepEqual([view.matrix[3], view.matrix[7], view.matrix[11], view.matrix[15]], [0, 0, 0, 1]);
  assert.deepEqual([view.matrix[2], view.matrix[6], view.matrix[10], view.matrix[14]], [
    Math.fround(-state.D[0] / (2 * expectedE)), Math.fround(-state.D[1] / (2 * expectedE)),
    Math.fround(-state.D[2] / (2 * expectedE)), 0,
  ]);
  assert.equal(view.matrix.length, 16);
  assert.equal(view.oracleDepths.length, 8);
  assert(view.oracleDepths.every((depth) => -1 < depth && depth < 1));
  assert(Object.isFrozen(state) && Object.isFrozen(view) && Object.isFrozen(view.matrix) && Object.isFrozen(view.oracleDepths));
});

test("keyboard and pointer orbit use exact directions, normalization, clamps, and regenerated orthonormal basis", () => {
  const reset = success(resetCamera(fixture.overview.bounds, fixture.overview.dimensions));
  const a = success(orbitCameraByKeyboard(reset.state, fixture.overview.bounds, fixture.overview.dimensions, "a"));
  near(a.state.azimuth, reset.state.azimuth - Math.PI / 12, "A azimuth");
  const d = success(orbitCameraByKeyboard(reset.state, fixture.overview.bounds, fixture.overview.dimensions, "d"));
  near(d.state.azimuth, reset.state.azimuth + Math.PI / 12, "D azimuth");
  const w = success(orbitCameraByKeyboard(reset.state, fixture.overview.bounds, fixture.overview.dimensions, "w"));
  near(w.state.elevation, reset.state.elevation + Math.PI / 24, "W elevation");
  const s = success(orbitCameraByKeyboard(reset.state, fixture.overview.bounds, fixture.overview.dimensions, "s"));
  near(s.state.elevation, reset.state.elevation - Math.PI / 24, "S elevation");
  const pointer = success(orbitCameraByPointer(reset.state, fixture.overview.bounds, fixture.overview.dimensions, 100, 50, 400, 200));
  near(pointer.state.azimuth, reset.state.azimuth + Math.PI / 2, "pointer azimuth");
  near(pointer.state.elevation, policy.MINIMUM_ELEVATION, "pointer downward clamp");
  const clamped = success(orbitCamera(reset.state, fixture.overview.bounds, fixture.overview.dimensions, -100 * Math.PI, 100 * Math.PI));
  assert(clamped.state.azimuth >= 0 && clamped.state.azimuth < 2 * Math.PI);
  assert.equal(clamped.state.elevation, policy.MAXIMUM_ELEVATION);
  near(clamped.state.D[0] ** 2 + clamped.state.D[1] ** 2 + clamped.state.D[2] ** 2, 1, "D length");
  near(clamped.state.R[0] * clamped.state.V[1] - clamped.state.R[1] * clamped.state.V[0], clamped.state.D[2], "R cross V z");
});

test("pointer and keyboard pan, zoom, resize, and Reset retain or restore exactly the contracted components", () => {
  const original = success(resetCamera(fixture.overview.bounds, fixture.overview.dimensions));
  const pointer = success(panCameraByPointer(original.state, fixture.overview.bounds, fixture.overview.dimensions, 20, 10, 200, 100));
  const expectedHorizontal = -(2 * original.view.horizontalHalf * 20 / 200);
  const expectedVertical = 2 * original.view.verticalHalf * 10 / 100;
  for (let axis = 0; axis < 3; axis += 1) {
    near(pointer.state.target[axis], original.state.target[axis] + original.state.R[axis] * expectedHorizontal
      + original.state.V[axis] * expectedVertical, `pointer target ${axis}`);
  }
  const A = success(panCameraByKeyboard(original.state, fixture.overview.bounds, fixture.overview.dimensions, "A"));
  const D = success(panCameraByKeyboard(original.state, fixture.overview.bounds, fixture.overview.dimensions, "D"));
  const S = success(panCameraByKeyboard(original.state, fixture.overview.bounds, fixture.overview.dimensions, "S"));
  const W = success(panCameraByKeyboard(original.state, fixture.overview.bounds, fixture.overview.dimensions, "W"));
  for (let axis = 0; axis < 3; axis += 1) {
    near(A.state.target[axis] + D.state.target[axis], 2 * original.state.target[axis], `A/D symmetry ${axis}`);
    near(S.state.target[axis] + W.state.target[axis], 2 * original.state.target[axis], `S/W symmetry ${axis}`);
  }
  let zoomed = original;
  for (let index = 0; index < 100; index += 1) zoomed = success(zoomCamera(zoomed.state, fixture.overview.bounds, fixture.overview.dimensions, "in"));
  assert.equal(zoomed.state.magnification, 64);
  for (let index = 0; index < 200; index += 1) zoomed = success(zoomCamera(zoomed.state, fixture.overview.bounds, fixture.overview.dimensions, "out"));
  assert.equal(zoomed.state.magnification, 1 / 64);
  const resized = success(resizeCamera(pointer.state, fixture.overview.bounds, { width: 300, height: 900 }));
  assert.deepEqual(resized.state, pointer.state);
  assert.notEqual(resized.view.H0, pointer.view.H0);
  const restored = success(resetCamera(fixture.overview.bounds, { width: 300, height: 900 }));
  assert.deepEqual(restored.state.target, original.state.target);
  assert.deepEqual(restored.state.D, original.state.D);
  assert.equal(restored.state.magnification, 1);
});

test("pan retains lateral displacement in tx/ty while every committable state remains strictly depth-contained", () => {
  let current = success(resetCamera(fixture.overview.bounds, fixture.overview.dimensions));
  for (let index = 0; index < 40; index += 1) {
    current = success(panCameraByKeyboard(current.state, fixture.overview.bounds, fixture.overview.dimensions, index % 2 ? "D" : "W"));
    assert(current.view.oracleDepths.every((depth) => -1 < depth && depth < 1));
  }
  assert(Math.abs(current.view.tx) > 1 || Math.abs(current.view.ty) > 1, "pan is not laterally clipped");
});

test("the exact float32 oracle fixes matrix layout, corner order, product rounding, and left association", () => {
  const interior = new Array(16).fill(0); interior[15] = 1;
  const zero = success(evaluateStrictDepthOracle([0, 0, 0, 2, 2, 2], [1, 1, 1], interior));
  assert.deepEqual(zero.depths, [0, 0, 0, 0, 0, 0, 0, 0]);

  const layout = [...interior]; layout[2] = 0.25; layout[6] = 0.125; layout[10] = 0.0625;
  const ordered = success(evaluateStrictDepthOracle([0, 0, 0, 2, 2, 2], [1, 1, 1], layout));
  assert.deepEqual(ordered.depths, [-0.4375, 0.0625, -0.1875, 0.3125, -0.3125, 0.1875, -0.0625, 0.4375]);

  const rounded = [...interior]; rounded[2] = Math.fround(0.1);
  const roundedDepth = success(calculateOracleDepth(rounded, [Math.fround(0.1), 0, 0])).depth;
  assert.equal(roundedDepth, Math.fround(Math.fround(0.1) * Math.fround(0.1)));
  assert.notEqual(roundedDepth, Math.fround(0.1) * Math.fround(0.1));

  const halfUlp = 2 ** -24;
  const associated = [...interior]; associated[2] = 1; associated[6] = halfUlp; associated[10] = -halfUlp;
  assert.equal(success(calculateOracleDepth(associated, [1, 1, 1])).depth, Math.fround(Math.fround(Math.fround(1 + halfUlp) - halfUlp)));
  assert.equal(success(calculateOracleDepth(associated, [1, 1, 1])).depth, 1 - 2 ** -24);
  assert.equal(Math.fround(1 + Math.fround(halfUlp - halfUlp)), 1, "a different association reaches the rejected boundary");
});

test("oracle boundaries, malformed float32 matrices, and finite-target overflow fail atomically as M1-PRES-1", () => {
  const matrix = new Array(16).fill(0); matrix[15] = 1;
  for (const boundary of [-1, 1]) {
    const candidate = [...matrix]; candidate[14] = boundary;
    failure(evaluateStrictDepthOracle([0, 0, 0, 2, 2, 2], [1, 1, 1], candidate), `boundary ${boundary}`);
  }
  for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, 0.1]) {
    const candidate = [...matrix]; candidate[2] = invalid;
    failure(evaluateStrictDepthOracle([0, 0, 0, 2, 2, 2], [1, 1, 1], candidate), `matrix ${invalid}`);
  }
  const committed = success(resetCamera(fixture.overview.bounds, fixture.overview.dimensions));
  const before = structuredClone(committed.state);
  const finiteTarget = { ...committed.state, target: [Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE] };
  failure(resizeCamera(finiteTarget, fixture.overview.bounds, fixture.overview.dimensions));
  assert.deepEqual(committed.state, before, "the prior state was not partially mutated");
  failure(panCameraByPointer(committed.state, fixture.overview.bounds, fixture.overview.dimensions,
    Number.MAX_VALUE, Number.MAX_VALUE, 1, 1));
  assert.deepEqual(committed.state, before, "overflow did not partially commit");
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

test("orthographic rays use camera + sxR + syV and -D at overview and a moved camera", () => {
  const overview = success(resetCamera(fixture.overview.bounds, fixture.overview.dimensions));
  const centre = success(createOrthographicRay(overview.view, 60, 45, fixture.canvas.rectangle, fixture.canvas.backing));
  assert.deepEqual(centre.ray.origin, overview.view.camera);
  assert.deepEqual(centre.ray.direction, overview.state.D.map((component) => -component));
  const corner = success(createOrthographicRay(overview.view, 10, 20, fixture.canvas.rectangle, fixture.canvas.backing));
  for (let axis = 0; axis < 3; axis += 1) {
    near(corner.ray.origin[axis], overview.view.camera[axis] - overview.view.horizontalHalf * overview.state.R[axis]
      + overview.view.verticalHalf * overview.state.V[axis], `corner ray ${axis}`);
  }
  const moved = success(panCameraByKeyboard(overview.state, fixture.overview.bounds, fixture.overview.dimensions, "D"));
  const movedRay = success(createOrthographicRay(moved.view, 60, 45, fixture.canvas.rectangle, fixture.canvas.backing));
  assert.deepEqual(movedRay.ray.origin, moved.view.camera);
  assert.notDeepEqual(movedRay.ray.origin, centre.ray.origin);
  assert.equal(success(createOrthographicRay(moved.view, 110.00000000000001, 45, fixture.canvas.rectangle, fixture.canvas.backing)).ray, null);
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
  const overview = success(resetCamera(fixture.overview.bounds, fixture.overview.dimensions));
  const geometry = geometryFromBoxes([fixture.overview.bounds]);
  assert.equal(success(pickAtCanvasPoint(overview.view, 60, 45, fixture.canvas.rectangle, fixture.canvas.backing, geometry)).index, 0);
  const moved = success(panCameraByKeyboard(overview.state, fixture.overview.bounds, fixture.overview.dimensions, "D"));
  assert.equal(success(pickAtCanvasPoint(moved.view, 60, 45, fixture.canvas.rectangle, fixture.canvas.backing, geometry)).index, 0);
});

test("the full 4,000-city envelope keeps immutable dimensions and origin-C endpoints exact through deterministic pans", () => {
  const envelope = cityFixture.fullEnvelope;
  const facts = Array.from({ length: envelope.count }, (_, index) => ({
    canonicalPath: `camera/${String(index).padStart(4, "0")}.ts`,
    ...(index < envelope.largeFactCount ? envelope.largeFact : envelope.smallFact),
  }));
  const city = buildCity(facts);
  assert.deepEqual([...city.geometry.bounds], envelope.expectedBounds);
  const originalOrigins = Buffer.from(bytes(city.geometry.origins));
  const originalSizes = Buffer.from(bytes(city.geometry.sizes));
  const centre = [city.geometry.bounds[3] / 2, city.geometry.bounds[4] / 2, city.geometry.bounds[5] / 2];
  for (let index = 0; index < city.geometry.count; index += 1) {
    const offset = index * 3;
    for (let axis = 0; axis < 3; axis += 1) {
      const origin = city.geometry.origins[offset + axis];
      const endpoint = origin + city.geometry.sizes[offset + axis];
      assert.equal(Math.fround(origin - centre[axis]), origin - centre[axis]);
      assert.equal(Math.fround(endpoint - centre[axis]), endpoint - centre[axis]);
    }
  }
  let camera = success(resetCamera(city.geometry.bounds, { width: 4096, height: 2160 }));
  for (let index = 0; index < 128; index += 1) {
    camera = success(index % 3 === 0
      ? panCameraByPointer(camera.state, city.geometry.bounds, { width: 4096, height: 2160 }, index - 64, 64 - index, 4096, 2160)
      : panCameraByKeyboard(camera.state, city.geometry.bounds, { width: 4096, height: 2160 }, index % 2 ? "A" : "W"));
    assert(camera.view.oracleDepths.every((depth) => -1 < depth && depth < 1));
  }
  assert.deepEqual(bytes(city.geometry.origins), originalOrigins);
  assert.deepEqual(bytes(city.geometry.sizes), originalSizes);
});

test("the amended ADR bytes and requirements are synchronized to the exact numeric contract", async () => {
  const adr = await readFile(path.join(root, "docs/modules/architecture/pages/adr/0011-interactive-webgl2-navigation-and-inspection.adoc"));
  assert.equal(adr.byteLength, 17_914);
  assert.equal(createHash("sha256").update(adr).digest("hex"), "41bfe1ad66a0cb308681e4a360d0e93fbe129bf4b5ad731faef0caab1281868d");
  assert.equal(adr.at(-1), 10);
  const requirements = await readFile(path.join(root, "docs/modules/requirements/pages/city-and-failures.adoc"), "utf8");
  const normalizedRequirements = requirements.replace(/\s+/g, " ");
  for (const statement of [
    "`m[2]`, `m[6]`, `m[10]`, and `m[14]`",
    "`-1 < depth && depth < 1`",
    "not a claim of bit-identical WebGL/GLSL operation ordering or GPU depth",
    "rejects the whole transition atomically as *Presentation failed* / `M1-PRES-1`",
  ]) assert(normalizedRequirements.includes(statement), statement);
  const source = await readFile(path.join(root, "src/domain/camera-picking-policy.ts"), "utf8");
  for (const forbidden of ["document.", "window.", "WebGL", "addEventListener", "requestAnimationFrame", "Worker("]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});
