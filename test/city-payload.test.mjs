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
const MAX_MODULE_BYTES = 2_097_152;
const MAX_TOTAL_BYTES = 40 * 1_048_576;
const MAX_MODULE_UNITS = 1 + Math.floor(MAX_MODULE_BYTES / 3);
const MAX_TOTAL_UNITS = 4_000 + Math.floor(MAX_TOTAL_BYTES / 3);

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

test("validator enforces exact and one-over per-module source-line and executable-unit bounds with matching geometry", () => {
  for (const [metric, maximum] of [["S", MAX_MODULE_BYTES], ["U", MAX_MODULE_UNITS]]) {
    const exactFact = { canonicalPath: `exact-${metric}.ts`, S: 0, U: 0, M: 0, [metric]: maximum };
    const exact = cloneCity(buildCity([exactFact]));
    const validated = validateCityPayload(exact);
    assert.equal(validated.inspection[0][metric], maximum);
    assert.equal(validated.geometry.sizes[metric === "S" ? 1 : 0], maximum + 1);

    const oneOverFact = { ...exactFact, canonicalPath: `one-over-${metric}.ts`, [metric]: maximum + 1 };
    fails(cloneCity(buildCity([oneOverFact])), `${metric} per-module one over`);
  }
});

test("validator enforces exact and one-over aggregate source-line bounds with matching geometry", () => {
  const exactFacts = Array.from({ length: 20 }, (_, index) => ({
    canonicalPath: `source-total/${String(index).padStart(2, "0")}.ts`, S: MAX_MODULE_BYTES, U: 0, M: 0,
  }));
  const exact = validateCityPayload(cloneCity(buildCity(exactFacts)));
  assert.equal(exact.inspection.reduce((total, fact) => total + fact.S, 0), MAX_TOTAL_BYTES);
  assert.equal(exact.geometry.bounds[4], MAX_MODULE_BYTES + 1);

  const oneOverFacts = [...exactFacts, { canonicalPath: "source-total/20.ts", S: 1, U: 0, M: 0 }];
  fails(cloneCity(buildCity(oneOverFacts)), "S aggregate one over");
});

test("validator enforces exact and one-over aggregate executable-unit bounds with matching geometry", () => {
  let remaining = MAX_TOTAL_UNITS;
  const exactFacts = Array.from({ length: 4_000 }, (_, index) => {
    const U = Math.min(remaining, MAX_MODULE_UNITS);
    remaining -= U;
    return { canonicalPath: `unit-total/${String(index).padStart(4, "0")}.ts`, S: 0, U, M: 0 };
  });
  assert.equal(remaining, 0);
  const exact = validateCityPayload(cloneCity(buildCity(exactFacts)));
  assert.equal(exact.inspection.reduce((total, fact) => total + fact.U, 0), MAX_TOTAL_UNITS);
  assert.equal(exact.geometry.sizes[0], MAX_MODULE_UNITS + 1);

  const oneOverFacts = exactFacts.map((fact) => ({ ...fact }));
  const incrementIndex = oneOverFacts.findIndex((fact) => fact.U < MAX_MODULE_UNITS);
  oneOverFacts[incrementIndex].U += 1;
  fails(cloneCity(buildCity(oneOverFacts)), "U aggregate one over");
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
