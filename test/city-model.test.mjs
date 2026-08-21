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
const fixture = JSON.parse(await readFile(path.join(projectRoot, "test", "fixtures", "city-cases.json"), "utf8"));
const { buildCity, deriveView, validatePresentationModel } = await import("../src/domain/city-model.ts");

function exactKeys(value, keys) {
  assert(value && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
}

function modelData(city) {
  return {
    identities: [...city.identities],
    count: city.model.count,
    origins: [...city.model.origins],
    sizes: [...city.model.sizes],
    rgba: [...city.model.rgba],
    bounds: [...city.model.bounds],
  };
}

function cloneModel(model) {
  return {
    kind: model.kind,
    count: model.count,
    origins: new Float32Array(model.origins),
    sizes: new Float32Array(model.sizes),
    rgba: new Uint8Array(model.rgba),
    bounds: new Float32Array(model.bounds),
  };
}

function assertCityFailure(action, id) {
  assert.throws(action, (error) => error instanceof Error && error.message === "M1-CITY-1", id);
}

function assertNear(actual, expected, id) {
  const tolerance = 1e-9 * Math.max(1, Math.abs(expected));
  assert(Math.abs(actual - expected) <= tolerance, `${id}: ${actual} != ${expected} within ${tolerance}`);
}

function assertView(actual, expected, id) {
  exactKeys(actual, ["target", "D", "R", "V", "E_r", "E_v", "H", "verticalHalf", "horizontalHalf", "E_d", "camera", "near", "far"]);
  for (const key of ["target", "D", "R", "V", "camera"]) {
    assert.equal(actual[key].length, 3, `${id}:${key}`);
    for (let index = 0; index < 3; index += 1) assertNear(actual[key][index], expected[key][index], `${id}:${key}[${index}]`);
  }
  for (const key of ["E_r", "E_v", "H", "verticalHalf", "horizontalHalf", "E_d", "near", "far"]) {
    assertNear(actual[key], expected[key], `${id}:${key}`);
  }
}

const REQUIRED_MALFORMED_IDS = [
  "wrong-kind", "count-zero", "short-origins", "non-palette", "zero-width", "depth-mismatch",
  "origin-layout", "bounds-mismatch", "fractional-size", "float-limit", "equal-x", "bad-aspect",
];

test("the literal city fixture is closed and covers mapping, layout, permutations, malformed data, view, and the full envelope", () => {
  exactKeys(fixture, ["schemaVersion", "paletteBoundaries", "cityCases", "permutations", "viewCases", "malformedCases", "fullEnvelope"]);
  assert.equal(fixture.schemaVersion, 1);
  assert.deepEqual(fixture.cityCases.map(({ id }) => id), ["n1-zero", "n2-unsorted", "n4-varying-rows", "n5-varying-depths"]);
  assert.deepEqual(fixture.paletteBoundaries.map(({ M }) => M), [0, 1, 2, 3, 4, 7, 8, 15, 16, Number.MAX_SAFE_INTEGER]);
  assert.deepEqual(fixture.malformedCases.map(({ id }) => id), REQUIRED_MALFORMED_IDS);
  for (const entry of fixture.malformedCases) {
    exactKeys(entry, ["id", "target", "mutation", "literal", "expected"]);
    assert.equal(entry.expected, "M1-CITY-1");
  }
  assert.deepEqual(fixture.fullEnvelope.expectedBounds, [0, 0, 0, 13981147, 2097153, 699176]);
  for (const entry of fixture.cityCases) {
    exactKeys(entry, ["id", "facts", "expected"]);
    exactKeys(entry.expected, ["identities", "count", "origins", "sizes", "rgba", "bounds"]);
  }
});

test("literal N=1,2,4,5 mapping, palette, layout, and bounds match exact owned typed output", () => {
  for (const entry of fixture.cityCases) {
    const immutableFacts = entry.facts.map((fact) => Object.freeze({ ...fact }));
    Object.freeze(immutableFacts);
    const before = JSON.stringify(immutableFacts);
    const city = buildCity(immutableFacts);
    assert.deepEqual(modelData(city), entry.expected, entry.id);
    assert.equal(JSON.stringify(immutableFacts), before, `${entry.id}: input changed`);
    assert.deepEqual(Object.keys(city).sort(), ["identities", "model"]);
    assert.deepEqual(Object.keys(city.model).sort(), ["bounds", "count", "kind", "origins", "rgba", "sizes"]);
    assert.equal(city.model.kind, "CODE_CITY_PRESENTATION");
    assert.equal(Object.isFrozen(city), true);
    assert.equal(Object.isFrozen(city.identities), true);
    assert.equal(Object.isFrozen(city.model), true);
    assert.equal(validatePresentationModel(city.model).count, entry.expected.count);
  }
});

test("every palette boundary maps to its literal bytes independently", () => {
  for (const entry of fixture.paletteBoundaries) {
    const city = buildCity([{ canonicalPath: "palette.ts", S: 0, U: 0, M: entry.M }]);
    assert.deepEqual([...city.model.rgba], entry.rgba, `M=${entry.M}`);
  }
});

test("input order is irrelevant byte-for-byte and successful builds own fresh arrays", () => {
  const entry = fixture.cityCases.find(({ id }) => id === fixture.permutations.cityCase);
  const outputs = fixture.permutations.orders.map((order) => buildCity(order.map((index) => entry.facts[index])));
  const bytes = (model) => Buffer.concat([
    Buffer.from(model.origins.buffer, model.origins.byteOffset, model.origins.byteLength),
    Buffer.from(model.sizes.buffer, model.sizes.byteOffset, model.sizes.byteLength),
    Buffer.from(model.rgba.buffer, model.rgba.byteOffset, model.rgba.byteLength),
    Buffer.from(model.bounds.buffer, model.bounds.byteOffset, model.bounds.byteLength),
  ]);
  for (const city of outputs) {
    assert.deepEqual(modelData(city), entry.expected);
    assert.deepEqual(bytes(city.model), bytes(outputs[0].model));
  }
  for (const key of ["origins", "sizes", "rgba", "bounds"]) {
    assert.notEqual(outputs[0].model[key], outputs[1].model[key], key);
    assert.notEqual(outputs[0].model[key].buffer, outputs[1].model[key].buffer, `${key}.buffer`);
  }
  outputs[0].model.origins[0] = 99;
  assert.equal(outputs[1].model.origins[0], 0);
});

test("construction rejects non-arrays, non-dense arrays, accessor elements, extras, duplicates, and malformed exact facts", () => {
  const valid = { canonicalPath: "a.ts", S: 0, U: 0, M: 0 };
  const sparse = new Array(1);
  const inheritedElement = new Array(1);
  Object.defineProperty(Array.prototype, "0", { configurable: true, value: valid, writable: true });
  try {
    for (const value of [
      undefined, null, {}, { 0: valid, length: 1 }, new Set([valid]), "facts", [], sparse, inheritedElement,
      Object.assign([valid], { extra: true }), Object.setPrototypeOf([valid], Object.create(Array.prototype)),
    ]) assertCityFailure(() => buildCity(value), String(value));
  } finally {
    delete Array.prototype[0];
  }

  const accessorElement = [];
  Object.defineProperty(accessorElement, "0", { enumerable: true, get: () => valid });
  accessorElement.length = 1;
  assertCityFailure(() => buildCity(accessorElement), "accessor element");
  assertCityFailure(() => buildCity(new Proxy([valid], { ownKeys() { throw new Error("trap"); } })), "array proxy");

  const accessorFact = {};
  for (const [key, value] of Object.entries(valid)) Object.defineProperty(accessorFact, key, { enumerable: true, get: () => value });
  const symbolFact = { ...valid }; symbolFact[Symbol("extra")] = true;
  const customPrototype = Object.assign(Object.create({ inherited: true }), valid);
  for (const fact of [
    accessorFact, Object.assign(Object.create(null), valid), customPrototype, { ...valid, extra: true }, symbolFact,
    { ...valid, canonicalPath: "a.txt" }, { ...valid, canonicalPath: "A/../a.ts" },
    { ...valid, S: -1 }, { ...valid, U: 1.5 }, { ...valid, M: Number.POSITIVE_INFINITY },
  ]) assertCityFailure(() => buildCity([fact]));
  assertCityFailure(() => buildCity([valid, { ...valid }]));
});

test("checked metric, count, coordinate, and allocation guards reject instead of clamping or partially accepting", () => {
  const base = { canonicalPath: "guard.ts", S: 0, U: 0, M: 0 };
  for (const fact of [
    { ...base, S: Number.MAX_SAFE_INTEGER },
    { ...base, U: Number.MAX_SAFE_INTEGER },
    { ...base, S: 2 ** 24 - 1 },
    { ...base, U: 2 ** 24 - 1 },
  ]) assertCityFailure(() => buildCity([fact]));
  const tooMany = Array.from({ length: 4001 }, (_, index) => ({ ...base, canonicalPath: `g/${String(index).padStart(4, "0")}.ts` }));
  assertCityFailure(() => buildCity(tooMany));
});

test("defensive model validation rejects shape, classes, lengths, colours, extents, layout, bounds, float values, and prototypes", () => {
  const source = buildCity(fixture.cityCases.find(({ id }) => id === "n5-varying-depths").facts).model;
  const mutations = {
    "wrong-kind": (model, literal) => { model.kind = literal; },
    "count-zero": (model, literal) => { model.count = literal; },
    "short-origins": (model, literal) => { model.origins = new Float32Array(literal); },
    "non-palette": (model, literal) => { model.rgba.set(literal, 0); },
    "zero-width": (model, literal) => { model.sizes[0] = literal; },
    "depth-mismatch": (model, literal) => { model.sizes[2] = literal; },
    "origin-layout": (model, literal) => { model.origins[3] = literal; },
    "bounds-mismatch": (model, literal) => { model.bounds.set(literal); },
    "fractional-size": (model, literal) => { model.sizes[0] = literal; },
    "float-limit": (model, literal) => { model.bounds[3] = literal; },
  };
  for (const entry of fixture.malformedCases.filter(({ target }) => target === "model")) {
    const model = cloneModel(source);
    mutations[entry.id](model, entry.literal);
    assertCityFailure(() => validatePresentationModel(model), entry.id);
  }

  for (const model of [
    { ...cloneModel(source), origins: new Float64Array(source.origins) },
    { ...cloneModel(source), rgba: new Uint8ClampedArray(source.rgba) },
    Object.assign(Object.create(null), cloneModel(source)),
    { ...cloneModel(source), extra: true },
  ]) assertCityFailure(() => validatePresentationModel(model));

  const accessor = cloneModel(source);
  Object.defineProperty(accessor, "kind", { enumerable: true, get: () => source.kind });
  assertCityFailure(() => validatePresentationModel(accessor));
  const inherited = Object.assign(Object.create(cloneModel(source)), cloneModel(source));
  assertCityFailure(() => validatePresentationModel(inherited));

  for (const [index, id] of [[0, "x"], [1, "y"], [2, "z"]]) {
    const model = cloneModel(source);
    model.sizes[index] = 0;
    assertCityFailure(() => validatePresentationModel(model), `zero ${id} extent`);
  }
  const nan = cloneModel(source); nan.origins[0] = Number.NaN;
  assertCityFailure(() => validatePresentationModel(nan), "NaN");
  const negativeZero = cloneModel(source); negativeZero.origins[0] = -0;
  assertCityFailure(() => validatePresentationModel(negativeZero), "negative zero");
});

test("view derivation matches every literal double-precision component and exercises both fit branches", () => {
  for (const entry of fixture.viewCases) {
    const actual = deriveView(entry.bounds, entry.aspect);
    assertView(actual, entry.expected, entry.id);
    assert.equal(Object.isFrozen(actual), true);
    for (const key of ["target", "D", "R", "V", "camera"]) assert.equal(Object.isFrozen(actual[key]), true);
  }
  const landscape = fixture.viewCases.find(({ id }) => id === "landscape-vertical-branch");
  const portrait = fixture.viewCases.find(({ id }) => id === "portrait-horizontal-branch");
  assert(landscape.expected.E_v > landscape.expected.E_r / landscape.aspect);
  assert(portrait.expected.E_r / portrait.aspect > portrait.expected.E_v);
  const precise = fixture.viewCases.find(({ id }) => id === "offset-double-precision");
  assert.notEqual(deriveView(precise.bounds, precise.aspect).H, Math.fround(precise.expected.H));
  assertView(deriveView(new Float32Array([0, 0, 0, 7, 5, 8]), 2), landscape.expected, "Float32 bounds");
});

test("view derivation rejects degenerate, non-finite, malformed bounds and non-positive aspects", () => {
  const equalX = fixture.malformedCases.find(({ id }) => id === "equal-x");
  const badAspect = fixture.malformedCases.find(({ id }) => id === "bad-aspect");
  assertCityFailure(() => deriveView(equalX.literal, 1), equalX.id);
  assertCityFailure(() => deriveView([0, 0, 0, 1, 1, 1], badAspect.literal), badAspect.id);
  for (const bounds of [
    [0, 0, 0, 0, 1, 1], [0, 0, 0, 1, 0, 1], [0, 0, 0, 1, 1, 0],
    [0, 0, 0, -1, 1, 1], [0, 0, 0, 1, Number.NaN, 1], [0, 0, 0, 1, 1],
    Object.assign([0, 0, 0, 1, 1, 1], { extra: true }), new Float64Array([0, 0, 0, 1, 1, 1]),
  ]) assertCityFailure(() => deriveView(bounds, 1));
  const accessorBounds = [0, 0, 0, 1, 1, 1];
  Object.defineProperty(accessorBounds, "0", { enumerable: true, get: () => 0 });
  assertCityFailure(() => deriveView(accessorBounds, 1));
  for (const aspect of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assertCityFailure(() => deriveView([0, 0, 0, 1, 1, 1], aspect));
  }
});

test("the 4,000-fact full envelope has the literal bounds and renewed exact float proof", () => {
  const envelope = fixture.fullEnvelope;
  const facts = Array.from({ length: envelope.count }, (_, index) => ({
    canonicalPath: `envelope/${String(index).padStart(4, "0")}.ts`,
    ...(index < envelope.largeFactCount ? envelope.largeFact : envelope.smallFact),
  }));
  const city = buildCity(facts);
  assert.equal(city.model.count, 4000);
  assert.equal(Math.ceil(Math.sqrt(city.model.count)), envelope.columns);
  assert.deepEqual([...city.model.bounds], envelope.expectedBounds);
  assert(city.model.bounds.every((coordinate) => coordinate < envelope.coordinateLimitExclusive));
  const target = [city.model.bounds[3] / 2, city.model.bounds[4] / 2, city.model.bounds[5] / 2];
  for (let index = 0; index < city.model.count; index += 1) {
    const offset = index * 3;
    for (let axis = 0; axis < 3; axis += 1) {
      const origin = city.model.origins[offset + axis];
      const endpoint = origin + city.model.sizes[offset + axis];
      assert.equal(Math.fround(origin), origin);
      assert.equal(Math.fround(endpoint), endpoint);
      assert(Math.abs(origin - target[axis]) < envelope.targetRelativeLimitExclusive);
      assert(Math.abs(endpoint - target[axis]) < envelope.targetRelativeLimitExclusive);
      assert.equal(Math.fround(origin - target[axis]), origin - target[axis]);
      assert.equal(Math.fround(endpoint - target[axis]), endpoint - target[axis]);
    }
  }
  assertView(deriveView(city.model.bounds, fixture.viewCases.at(-1).aspect), fixture.viewCases.at(-1).expected, "full envelope view");
});
