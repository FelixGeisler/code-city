import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(/^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context);
  },
});

const { buildCity } = await import("../src/domain/city-model.ts");
const { validateCityPayload } = await import("../src/application/city-payload.ts");

const FACTS = [
  { canonicalPath: "a.ts", S: 1, U: 2, M: 0 },
  { canonicalPath: "src/markup-<secret>-\u202Etoken.ts", S: 4, U: 3, M: 16 },
];

function cloneGeometry(geometry) {
  return {
    kind: geometry.kind,
    count: geometry.count,
    origins: new Float32Array(geometry.origins),
    sizes: new Float32Array(geometry.sizes),
    rgba: new Uint8Array(geometry.rgba),
    bounds: new Float32Array(geometry.bounds),
  };
}

function cloneCity(city = buildCity(FACTS)) {
  return {
    geometry: cloneGeometry(city.geometry),
    inspection: city.inspection.map((fact) => ({ ...fact })),
  };
}

function fails(value, id) {
  assert.throws(() => validateCityPayload(value), (error) => error instanceof Error && error.message === "M1-CITY-1", id);
}

function accessor(record, key) {
  const copy = { ...record };
  Object.defineProperty(copy, key, { enumerable: true, get: () => record[key] });
  return copy;
}

function inherited(record) {
  return Object.assign(Object.create(record), record);
}

test("validateCityPayload creates immutable controller-owned non-aliasing city snapshots and centre", () => {
  const input = cloneCity();
  const before = cloneCity(input);
  const validated = validateCityPayload(input);
  assert.deepEqual(Object.keys(validated), ["geometry", "inspection", "centre"]);
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.geometry), true);
  assert.equal(Object.isFrozen(validated.inspection), true);
  assert(validated.inspection.every(Object.isFrozen));
  assert.equal(Object.isFrozen(validated.centre), true);
  assert.deepEqual(validated.centre, [4, 2.5, 2]);
  for (const key of ["origins", "sizes", "rgba", "bounds"]) {
    assert.notEqual(validated.geometry[key], input.geometry[key], key);
    assert.notEqual(validated.geometry[key].buffer, input.geometry[key].buffer, `${key}.buffer`);
  }
  assert.notEqual(validated.inspection, input.inspection);
  assert.notEqual(validated.inspection[0], input.inspection[0]);
  input.geometry.origins.fill(99);
  input.geometry.sizes.fill(99);
  input.geometry.rgba.fill(99);
  input.geometry.bounds.fill(99);
  input.inspection[0].canonicalPath = "mutated.ts";
  input.inspection[0].S = 99;
  assert.deepEqual([...validated.geometry.origins], [...before.geometry.origins]);
  assert.deepEqual([...validated.geometry.sizes], [...before.geometry.sizes]);
  assert.deepEqual([...validated.geometry.rgba], [...before.geometry.rgba]);
  assert.deepEqual([...validated.geometry.bounds], [...before.geometry.bounds]);
  assert.deepEqual(validated.inspection, before.inspection);
});

test("city and inspection containers require exact own enumerable data without inherited, symbol, accessor, sparse, or extra input", () => {
  const valid = cloneCity();
  const symbolCity = cloneCity(); symbolCity[Symbol("extra")] = true;
  const extraCity = { ...cloneCity(), extra: true };
  const sparse = cloneCity(); sparse.inspection = new Array(valid.inspection.length);
  const extraArray = cloneCity(); extraArray.inspection.extra = true;
  for (const city of [
    null, [], {}, inherited(valid), accessor(valid, "geometry"), accessor(valid, "inspection"), symbolCity, extraCity,
    { geometry: valid.geometry }, { inspection: valid.inspection },
    { ...cloneCity(), inspection: inherited(valid.inspection) }, sparse, extraArray,
  ]) fails(city);

  for (const key of ["canonicalPath", "S", "U", "M"]) {
    const city = cloneCity();
    city.inspection[0] = accessor(city.inspection[0], key);
    fails(city, `inspection accessor ${key}`);
  }
  for (const fact of [
    { ...valid.inspection[0], extra: true },
    inherited(valid.inspection[0]),
    { ...valid.inspection[0], canonicalPath: "../escape.ts" },
    { ...valid.inspection[0], S: -1 },
    { ...valid.inspection[0], U: 1.5 },
    { ...valid.inspection[0], M: Number.MAX_VALUE },
  ]) {
    const city = cloneCity(); city.inspection[0] = fact; fails(city);
  }
});

test("validator rejects count, canonical order, duplicate identity, dimensions, palette, index alignment, layout, and bounds disagreement", () => {
  const cases = [];
  {
    const city = cloneCity(); city.inspection.pop(); cases.push(["count", city]);
  }
  {
    const city = cloneCity(); city.inspection.reverse(); cases.push(["order", city]);
  }
  {
    const city = cloneCity(); city.inspection[1] = { ...city.inspection[1], canonicalPath: city.inspection[0].canonicalPath }; cases.push(["duplicate", city]);
  }
  {
    const city = cloneCity(); city.inspection[0] = { ...city.inspection[0], U: city.inspection[0].U + 1 }; cases.push(["size alignment", city]);
  }
  {
    const city = cloneCity(); city.inspection[0] = { ...city.inspection[0], M: 16 }; cases.push(["palette alignment", city]);
  }
  {
    const city = cloneCity(); [city.inspection[0], city.inspection[1]] = [city.inspection[1], city.inspection[0]]; cases.push(["index alignment", city]);
  }
  {
    const city = cloneCity(); city.geometry.origins[3] += 1; cases.push(["layout", city]);
  }
  {
    const city = cloneCity(); city.geometry.bounds[3] += 1; cases.push(["bounds", city]);
  }
  {
    const city = cloneCity(); city.geometry.rgba[0] = 0; cases.push(["non-palette", city]);
  }
  for (const [id, city] of cases) fails(city, id);
});

test("validated geometry preserves exact bytes while inspection contributes no geometry bytes", () => {
  const first = cloneCity();
  const second = cloneCity();
  second.inspection = second.inspection.map((fact) => ({ ...fact }));
  const a = validateCityPayload(first);
  const b = validateCityPayload(second);
  for (const key of ["origins", "sizes", "rgba", "bounds"]) {
    assert.deepEqual(Buffer.from(a.geometry[key].buffer), Buffer.from(first.geometry[key].buffer), key);
    assert.deepEqual(Buffer.from(a.geometry[key].buffer), Buffer.from(b.geometry[key].buffer), key);
  }
});
