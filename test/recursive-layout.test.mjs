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

const utf8 = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const parentPath = (value) => value.slice(0, Math.max(0, value.lastIndexOf("/")));
const fact = (canonicalPath, S = 0, U = 0, M = 0) => ({ canonicalPath, S, U, M });
const box = (minimum, dimensions, canonicalPath, directory = false) => ({ minimum, dimensions, canonicalPath, directory });

function boundsOf(boxes) {
  const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const { minimum, dimensions } of boxes) {
    for (let axis = 0; axis < 3; axis++) {
      bounds[axis] = Math.min(bounds[axis], minimum[axis]);
      bounds[axis + 3] = Math.max(bounds[axis + 3], minimum[axis] + dimensions[axis]);
    }
  }
  return bounds;
}

function assertFloatBox(item, centre) {
  for (let axis = 0; axis < 3; axis++) {
    for (const point of [item.minimum[axis], item.minimum[axis] + item.dimensions[axis]]) {
      assert(Number.isFinite(point));
      assert.equal(Object.is(point, -0), false);
      assert.equal(Number.isInteger(point * (axis === 1 ? 2 : 1)), true);
      assert(Math.abs(point) < 2 ** 24);
      assert.equal(Math.fround(point), point);
      const relative = point - centre[axis];
      assert.equal(Number.isInteger(relative * 4), true);
      assert(Math.abs(relative) < 2 ** 23);
      assert.equal(Math.fround(relative), relative);
    }
  }
}

// Deliberately uses only observable output, paths and the accepted equations,
// never planRecursiveLayout or the production metric/palette helpers.
function assertRecursiveCity(input, city = validateCityPayload(buildCity(input))) {
  const { geometry, inspection, presentation, districts } = city;
  assert.equal(geometry.kind, "CODE_CITY_RECURSIVE_PRESENTATION_1");
  assert.equal(geometry.count, input.length);
  const expectedFacts = [...input].sort((a, b) => utf8(a.canonicalPath, b.canonicalPath));
  assert.deepEqual(inspection, expectedFacts);
  const ancestors = new Set([""]);
  for (const { canonicalPath } of input) {
    for (let slash = canonicalPath.indexOf("/"); slash !== -1; slash = canonicalPath.indexOf("/", slash + 1)) {
      ancestors.add(canonicalPath.slice(0, slash));
    }
  }
  const paths = [...ancestors].sort(utf8);
  assert.deepEqual(districts, paths.map((identity) => ({ root: identity === "", identity: identity || "_root" })));
  assert.equal(presentation.plates.length, paths.length);
  const directories = new Map(paths.map((identity, index) => [identity, {
    ...box(presentation.plates[index].minimum, presentation.plates[index].dimensions, identity, true),
    items: [], depth: 0,
  }]));
  for (const [identity, directory] of directories) {
    if (identity !== "") {
      const parent = directories.get(parentPath(identity));
      assert(parent, "every non-root district has its exact parent");
      parent.items.push(directory);
      directory.depth = parent.depth + 1;
      assert.equal(directory.minimum[1], parent.minimum[1] + 0.5);
    }
    assert.equal(directory.minimum[1] + 0.5, directory.depth / 2);
    assert.equal(directory.dimensions[1], 0.5);
    assertFloatBox(directory, presentation.centre);
  }
  const buildings = inspection.map((record, index) => {
    const offset = index * 3;
    const building = box([...geometry.origins.slice(offset, offset + 3)], [...geometry.sizes.slice(offset, offset + 3)], record.canonicalPath);
    const parent = directories.get(parentPath(record.canonicalPath));
    assert(parent);
    parent.items.push(building);
    assert.equal(building.minimum[1], parent.depth / 2, "exact immediate-parent elevation, not maximum/first-two-segment depth");
    const height = 4 + Math.floor(36 * Math.sqrt(Math.min(record.S, 1000) / 1000) + 0.5);
    const side = 3 + Math.floor(15 * (Math.log1p(Math.min(record.U, 100)) / Math.log(101)) ** 1.5 + 0.5);
    assert.deepEqual(building.dimensions, [side, height, side], "SLOC height and unit footprint are not rescaled by hierarchy");
    assertFloatBox(building, presentation.centre);
    return building;
  });
  assert.deepEqual([...geometry.bounds], boundsOf(buildings), "bounds enclose actual buildings, not plates or unoccupied shelves");
  assert.equal(geometry.bounds[0], 0);
  assert.equal(geometry.bounds[2], 0);
  assert.deepEqual(presentation.sceneBounds, boundsOf([...buildings, ...directories.values()]));
  assert.deepEqual(presentation.centre, [0, 1, 2].map((axis) => (presentation.sceneBounds[axis] + presentation.sceneBounds[axis + 3]) / 2));

  // Immediate containment + disjoint sibling rectangles imply containment in
  // every ancestor and disjointness of all unrelated subtrees, at any depth.
  // Platforms nest in XZ; their half-unit slabs stack in Y, not inside one slab.
  for (const directory of directories.values()) {
    const items = directory.items;
    assert(items.length > 0, "no empty unrelated districts");
    for (const item of items) {
      for (const axis of [0, 2]) {
        assert(item.minimum[axis] >= directory.minimum[axis] + 3, "near padding");
        assert(item.minimum[axis] + item.dimensions[axis] <= directory.minimum[axis] + directory.dimensions[axis] - 3, "far padding");
      }
    }
    for (let i = 0; i < items.length; i++) {
      const a = items[i];
      for (let j = i + 1; j < items.length; j++) {
        const b = items[j];
        const separated = [0, 2].some((axis) => a.minimum[axis] + a.dimensions[axis] + 2 <= b.minimum[axis]
          || b.minimum[axis] + b.dimensions[axis] + 2 <= a.minimum[axis]);
        assert(separated, "no unrelated platform/building overlap; at least gap 2");
      }
    }
    // Check local packing against already independently checked child extents.
    // Sum immediate occupied rectangles only, never descendant areas again.
    const sorted = [...items].sort((a, b) => b.dimensions[0] * b.dimensions[2] - a.dimensions[0] * a.dimensions[2]
      || utf8(a.canonicalPath, b.canonicalPath) || Number(b.directory) - Number(a.directory));
    const target = Math.max(...items.map((item) => item.dimensions[0]), Math.ceil(Math.sqrt(items.reduce((sum, item) => sum + (item.dimensions[0] + 2) * (item.dimensions[2] + 2), 0))));
    let x = 0, z = 0, rowDepth = 0, width = 0, depth = 0;
    for (const item of sorted) {
      const [w, , h] = item.dimensions;
      if (x !== 0 && x + w > target) { x = 0; z += rowDepth + 2; rowDepth = 0; }
      assert.equal(item.minimum[0] - directory.minimum[0], x + 3, "shelf x, one shared world translation");
      assert.equal(item.minimum[2] - directory.minimum[2], z + 3, "shelf z, one shared world translation");
      width = Math.max(width, x + w); depth = Math.max(depth, z + h);
      x += w + 2; rowDepth = Math.max(rowDepth, h);
    }
    assert.deepEqual(directory.dimensions, [width + 6, 0.5, depth + 6], "actual occupied extent, no trailing gap");
  }
  return city;
}

function assertSameBytes(a, b) {
  assert.deepEqual(a.inspection, b.inspection);
  assert.deepEqual(a.districts, b.districts);
  assert.deepEqual(a.presentation, b.presentation);
  for (const key of ["origins", "sizes", "rgba", "bounds"]) {
    assert.deepEqual(Buffer.from(a.geometry[key].buffer), Buffer.from(b.geometry[key].buffer), key);
  }
}

function shuffle(input, seed) {
  const output = [...input];
  for (let i = output.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [output[i], output[j]] = [output[j], output[i]];
  }
  return output;
}

const SMALL = [fact("root.ts"), fact("_root/direct.ts", 25, 0, 1), fact("a/b/deep.ts", 100, 1, 16), fact("a/direct.ts", 1, 0, 8)];

test("literal mixed root/_root/nested golden pins recursive shelf bytes, all ancestors and common normalization", () => {
  const city = assertRecursiveCity(SMALL);
  assert.deepEqual([...city.geometry.origins], [0,0.5,20,3,1,0,0,0.5,9,8,0,17]);
  assert.deepEqual([...city.geometry.sizes], [3,10,3,4,15,4,3,5,3,3,4,3]);
  assert.deepEqual([...city.geometry.rgba], [132,204,22,255,239,68,68,255,249,115,22,255,34,197,94,255]);
  assert.deepEqual([...city.geometry.bounds], [0,0,0,11,16,23]);
  // a packs its 10×10 child before its direct 3×3 file: 16×21.
  // Root target is ceil(sqrt(18×23 + 11×11 + 5×5)) = 24.
  assert.deepEqual(city.presentation, {
    plates: [
      { minimum: [-6,-0.5,-9], dimensions: [22,0.5,38] },
      { minimum: [-3,0,17], dimensions: [9,0.5,9] },
      { minimum: [-3,0,-6], dimensions: [16,0.5,21] },
      { minimum: [0,0.5,-3], dimensions: [10,0.5,10] },
    ],
    sceneBounds: [-6,-0.5,-9,16,16,29], centre: [5,7.75,10],
  });
});

test("Unicode area ties and shuffled inputs are byte deterministic for buildings, all ancestor plates and bounds", () => {
  const facts = ["A/f.ts", "a/f.ts", "z/f.ts", "é/f.ts", "\uE000/f.ts", "😀/f.ts", "same.ts/leaf.ts"].map((p) => fact(p));
  // A synthetic full-path AND area tie: directory 9×9 vs direct file 9×9.
  facts.push(fact("same.ts", 25, 10, 2));
  const reference = assertRecursiveCity(facts);
  assert.deepEqual(reference.inspection.map((f) => f.canonicalPath), ["A/f.ts", "a/f.ts", "same.ts", "same.ts/leaf.ts", "z/f.ts", "é/f.ts", "\uE000/f.ts", "😀/f.ts"]);
  assert.deepEqual(reference.districts.map((d) => d.identity), ["_root", "A", "a", "same.ts", "z", "é", "\uE000", "😀"]);
  assertSameBytes(reference, assertRecursiveCity([...facts].reverse()));
  for (let seed = 1; seed <= 12; seed++) assertSameBytes(reference, assertRecursiveCity(shuffle(facts, seed)));
  const tie = assertRecursiveCity([fact("same.ts", 25, 10), fact("same.ts/leaf.ts")]);
  assert.deepEqual([...tie.geometry.origins], [0,0,8,3,0.5,0], "directory wins the synthetic tie before file");
});

test("mixed metric sizes and multiple direct files at each ancestor retain containment and exact parent elevations", () => {
  const facts = [];
  for (let branch = 0; branch < 12; branch++) {
    let prefix = "";
    for (let depth = 0; depth < 9; depth++) {
      for (let sibling = 0; sibling < 3; sibling++) {
        facts.push(fact(`${prefix}f-${branch}-${sibling}.ts`, (branch * 79 + depth * 23) % 1001, (depth * 17 + sibling * 43) % 101, branch + sibling));
      }
      prefix += `d${branch}-${depth}/`;
    }
  }
  const city = assertRecursiveCity(facts);
  assertSameBytes(city, assertRecursiveCity(shuffle(facts, 0x12345678)));
});

test("12,000-directory chain is processed without recursive stack limits or hierarchy truncation", () => {
  const depth = 12_000;
  const canonicalPath = `${"d/".repeat(depth)}leaf.ts`;
  const city = assertRecursiveCity([fact(canonicalPath, 600, 100, 16)]);
  assert.equal(city.districts.length, depth + 1);
  assert.deepEqual([...city.geometry.origins], [0, depth / 2, 0]);
  assert.deepEqual([...city.geometry.sizes], [18, 32, 18]);
  assert.deepEqual(city.presentation.plates[0], { minimum: [-3 * (depth + 1), -0.5, -3 * (depth + 1)], dimensions: [18 + 6 * (depth + 1), 0.5, 18 + 6 * (depth + 1)] });
});

test("4,000-file / 40 MiB metric envelope supports wide and representative mixed-depth trees without remapping", () => {
  for (const mode of ["wide", "mixed-depth"]) {
    const facts = Array.from({ length: 4_000 }, (_, index) => {
      const prefix = mode === "wide" ? `g${String(index).padStart(4, "0")}/` : `branch${index % 32}/${"nested/".repeat(index % 25)}`;
      // Leave unit budget for varied small footprints; 20 maximum-unit files
      // plus those files would exceed the independent 40 MiB unit guard.
      return fact(`${prefix}f${String(index).padStart(4, "0")}.ts`, index < 20 ? 2_097_152 : 0, index < 19 ? 699_051 : index % 101, index % 17);
    });
    assert.equal(facts.reduce((sum, f) => sum + f.S, 0), 40 * 1_048_576);
    assert(facts.reduce((sum, f) => sum + f.U, 0) <= 4_000 + Math.floor(40 * 1_048_576 / 3));
    const city = assertRecursiveCity(facts);
    assert.equal(city.geometry.count, 4_000);
    if (mode === "wide") assert.equal(city.districts.length, 4_001);
    assertSameBytes(city, validateCityPayload(buildCity(shuffle(facts, 0xabcdef))));
  }
});
