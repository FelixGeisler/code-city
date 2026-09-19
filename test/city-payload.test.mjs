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
const LITERAL_PALETTE_BOUNDARIES = [
  { M: 0, rgba: [0x22, 0xc5, 0x5e, 0xff] },
  { M: 1, rgba: [0x84, 0xcc, 0x16, 0xff] },
  { M: 2, rgba: [0xfa, 0xcc, 0x15, 0xff] },
  { M: 3, rgba: [0xfa, 0xcc, 0x15, 0xff] },
  { M: 4, rgba: [0xf5, 0x9e, 0x0b, 0xff] },
  { M: 7, rgba: [0xf5, 0x9e, 0x0b, 0xff] },
  { M: 8, rgba: [0xf9, 0x73, 0x16, 0xff] },
  { M: 15, rgba: [0xf9, 0x73, 0x16, 0xff] },
  { M: 16, rgba: [0xef, 0x44, 0x44, 0xff] },
  { M: Number.MAX_SAFE_INTEGER, rgba: [0xef, 0x44, 0x44, 0xff] },
];
const LITERAL_PALETTE_COLOURS = [
  [0x22, 0xc5, 0x5e, 0xff],
  [0x84, 0xcc, 0x16, 0xff],
  [0xfa, 0xcc, 0x15, 0xff],
  [0xf5, 0x9e, 0x0b, 0xff],
  [0xf9, 0x73, 0x16, 0xff],
  [0xef, 0x44, 0x44, 0xff],
];
const LITERAL_OLD_PALETTE_CASES = [
  { M: 0, rgba: [0xa7, 0x8b, 0xfa, 0xff] },
  { M: 1, rgba: [0x81, 0x8c, 0xf8, 0xff] },
  { M: 2, rgba: [0x38, 0xbd, 0xf8, 0xff] },
  { M: 4, rgba: [0x2d, 0xd4, 0xbf, 0xff] },
  { M: 8, rgba: [0xa3, 0xe6, 0x35, 0xff] },
  { M: 16, rgba: [0xfa, 0xcc, 0x15, 0xff] },
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

function literalPaletteCity(M, rgba) {
  return {
    geometry: {
      kind: "CODE_CITY_PRESENTATION",
      count: 1,
      origins: new Float32Array([0, 0, 0]),
      sizes: new Float32Array([3, 4, 3]),
      rgba: new Uint8Array(rgba),
      bounds: new Float32Array([0, 0, 0, 3, 4, 3]),
    },
    inspection: [{ canonicalPath: "literal-palette.ts", S: 0, U: 0, M }],
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
  assert.deepEqual(Object.keys(validated), ["geometry", "inspection", "presentation", "districts"]);
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.geometry), true);
  assert.equal(Object.isFrozen(validated.inspection), true);
  assert(validated.inspection.every(Object.isFrozen));
  assert.equal(Object.isFrozen(validated.presentation), true);
  assert.equal(Object.isFrozen(validated.districts), true);
  assert(validated.districts.every(Object.isFrozen));
  assert.deepEqual(validated.districts, [
    { root: true, identity: "_root" },
    { root: false, identity: "src" },
  ]);
  assert.equal(Object.isFrozen(validated.presentation.plates), true);
  assert(validated.presentation.plates.every((plate) => Object.isFrozen(plate)
    && Object.isFrozen(plate.minimum) && Object.isFrozen(plate.dimensions)));
  assert.equal(Object.isFrozen(validated.presentation.sceneBounds), true);
  assert.equal(Object.isFrozen(validated.presentation.centre), true);
  assert.deepEqual(validated.presentation, {
    plates: [
      { minimum: [-3, -0.5, -3], dimensions: [11, 0.5, 11] },
      { minimum: [-3, -0.5, 16], dimensions: [11, 0.5, 11] },
    ],
    sceneBounds: [-3, -0.5, -3, 8, 12, 27],
    centre: [2.5, 5.75, 12],
  });
  assert.deepEqual(Reflect.ownKeys(validated.presentation).sort(), ["centre", "plates", "sceneBounds"]);
  assert.equal(JSON.stringify(validated.presentation).includes("src/"), false);
  for (const key of ["origins", "sizes", "rgba", "bounds"]) {
    assert.notEqual(validated.geometry[key], input.geometry[key], key);
    assert.notEqual(validated.geometry[key].buffer, input.geometry[key].buffer, `${key}.buffer`);
  }
  assert.notEqual(validated.inspection, input.inspection);
  assert.notEqual(validated.inspection[0], input.inspection[0]);
  assert.notEqual(validated.districts, validateCityPayload(before).districts);
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
  assert.deepEqual(validated.presentation, validateCityPayload(before).presentation);
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

test("controller validates literal palette boundaries and rejects independently forged palette payloads", () => {
  for (const { M, rgba } of LITERAL_PALETTE_BOUNDARIES) {
    assert.deepEqual([...validateCityPayload(literalPaletteCity(M, rgba)).geometry.rgba], rgba, `M=${M}`);
    const forged = LITERAL_PALETTE_COLOURS.find((candidate) => candidate[0] !== rgba[0]);
    fails(literalPaletteCity(M, forged), `forged M=${M}`);
  }
});

test("controller rejects every former palette colour for its old band and approved RGB with wrong alpha", () => {
  for (const { M, rgba } of LITERAL_OLD_PALETTE_CASES) {
    fails(literalPaletteCity(M, rgba), `old palette M=${M}`);
  }
  fails(literalPaletteCity(1, [0x84, 0xcc, 0x16, 0xfe]), "wrong alpha M=1");
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
    const city = cloneCity(); city.inspection[0] = { ...city.inspection[0], U: 100 }; cases.push(["size alignment", city]);
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
    assert.equal(validated.geometry.sizes[metric === "S" ? 1 : 0], metric === "S" ? 40 : 18);

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
  assert.equal(exact.geometry.bounds[4], 40);

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
  assert.equal(exact.geometry.sizes[0], 18);

  const oneOverFacts = exactFacts.map((fact) => ({ ...fact }));
  const incrementIndex = oneOverFacts.findIndex((fact) => fact.U < MAX_MODULE_UNITS);
  oneOverFacts[incrementIndex].U += 1;
  fails(cloneCity(buildCity(oneOverFacts)), "U aggregate one over");
});

test("concentrated and N=G=4,000 reconstruction yields exact plate cells, scene bounds, centres, and quarter-integer endpoints", () => {
  const cases = [
    {
      id: "concentrated",
      path: (index) => `all/${String(index).padStart(4, "0")}.ts`,
      plates: 1,
      bounds: [-3, -0.5, -3, 316, 4, 321],
      centre: [156.5, 1.75, 159],
      first: { minimum: [-3, -0.5, -3], dimensions: [319, 0.5, 324] },
      last: { minimum: [-3, -0.5, -3], dimensions: [319, 0.5, 324] },
    },
    {
      id: "many groups",
      path: (index) => `g${String(index).padStart(4, "0")}/m.ts`,
      plates: 4000,
      bounds: [-3, -0.5, -3, 1060, 4, 1077],
      centre: [528.5, 1.75, 537],
      first: { minimum: [-3, -0.5, -3], dimensions: [9, 0.5, 9] },
      last: { minimum: [507, -0.5, 1068], dimensions: [9, 0.5, 9] },
    },
  ];
  for (const entry of cases) {
    const city = validateCityPayload(buildCity(Array.from({ length: 4000 }, (_, index) => ({
      canonicalPath: entry.path(index), S: 0, U: 0, M: 0,
    }))));
    assert.equal(city.presentation.plates.length, entry.plates, entry.id);
    assert.equal(city.districts.length, entry.plates, entry.id);
    assert.equal(city.districts[0].root, false, entry.id);
    assert.equal(city.districts[0].identity, entry.id === "concentrated" ? "all" : "g0000", entry.id);
    assert.equal(city.districts.at(-1).identity, entry.id === "concentrated" ? "all" : "g3999", entry.id);
    assert.deepEqual(city.presentation.sceneBounds, entry.bounds, entry.id);
    assert.deepEqual(city.presentation.centre, entry.centre, entry.id);
    assert.deepEqual(city.presentation.plates[0], entry.first, entry.id);
    assert.deepEqual(city.presentation.plates.at(-1), entry.last, entry.id);
    assert.equal(JSON.stringify(city.presentation).match(/canonicalPath|identity|root|label|anchor|projection|callback/giu), null, entry.id);
    for (const plate of city.presentation.plates) {
      for (let axis = 0; axis < 3; axis += 1) {
        for (const endpoint of [plate.minimum[axis], plate.minimum[axis] + plate.dimensions[axis]]) {
          const relative = endpoint - city.presentation.centre[axis];
          assert.equal(Math.fround(relative), relative, `${entry.id}: axis ${axis}`);
          assert.equal(Number.isInteger(relative * 4), true, `${entry.id}: quarter integer axis ${axis}`);
          assert(Math.abs(relative) < 68003, `${entry.id}: relative envelope axis ${axis}`);
        }
      }
    }
  }
});

test("root and literal directory identities stay structurally distinct and aligned with plate order", () => {
  const facts = [
    { canonicalPath: "Repository root/a.ts", S: 0, U: 0, M: 0 },
    { canonicalPath: "_root/a.ts", S: 0, U: 0, M: 0 },
    { canonicalPath: "a.ts", S: 0, U: 0, M: 0 },
  ];
  const city = validateCityPayload(buildCity(facts));
  assert.deepEqual(city.districts, [
    { root: false, identity: "Repository root" },
    { root: true, identity: "_root" },
    { root: false, identity: "_root" },
  ]);
  assert.equal(city.districts.length, city.presentation.plates.length);
  assert.deepEqual(Reflect.ownKeys(city.districts[0]), ["root", "identity"]);
  assert.equal(JSON.stringify(city.presentation).includes("Repository root"), false);
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
