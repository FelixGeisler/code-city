import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(/^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context);
  },
});

const { explainMetricFact, METRIC_PALETTE_LEGEND } = await import("../src/application/metric-explanation.ts");

const boundaries = [
  { M: 0, range: "0", rgba: "#22C55EFF" },
  { M: 1, range: "1", rgba: "#84CC16FF" },
  { M: 2, range: "2–3", rgba: "#FACC15FF" },
  { M: 3, range: "2–3", rgba: "#FACC15FF" },
  { M: 4, range: "4–7", rgba: "#F59E0BFF" },
  { M: 7, range: "4–7", rgba: "#F59E0BFF" },
  { M: 8, range: "8–15", rgba: "#F97316FF" },
  { M: 15, range: "8–15", rgba: "#F97316FF" },
  { M: 16, range: "16+", rgba: "#EF4444FF" },
];

const expectedHeight = (S) => 4 + Math.floor(36 * Math.log1p(Math.min(S, 1000)) / Math.log(1001) + 0.5);
const expectedSide = (U) => 3 + Math.floor(15 * (Math.log1p(Math.min(U, 100)) / Math.log(101)) ** 1.5 + 0.5);

test("metric explanation maps every required palette boundary and exact derived dimension", () => {
  for (const [index, expected] of boundaries.entries()) {
    const fact = { canonicalPath: `fixture/${index}.ts`, S: index, U: index + 2, M: expected.M };
    assert.deepEqual(explainMetricFact(fact), {
      canonicalPath: fact.canonicalPath,
      sourceLines: index,
      executableUnits: index + 2,
      maximumComplexity: expected.M,
      height: expectedHeight(index),
      width: expectedSide(index + 2),
      depth: expectedSide(index + 2),
      paletteRange: expected.range,
      rgba: expected.rgba,
    });
    assert.equal(Object.isFrozen(explainMetricFact(fact)), true);
  }
});

test("the text legend is one immutable complete six-band M1 palette", () => {
  assert.deepEqual(METRIC_PALETTE_LEGEND, [
    { range: "0", rgba: "#22C55EFF" },
    { range: "1", rgba: "#84CC16FF" },
    { range: "2–3", rgba: "#FACC15FF" },
    { range: "4–7", rgba: "#F59E0BFF" },
    { range: "8–15", rgba: "#F97316FF" },
    { range: "16+", rgba: "#EF4444FF" },
  ]);
  assert.equal(Object.isFrozen(METRIC_PALETTE_LEGEND), true);
  assert(METRIC_PALETTE_LEGEND.every(Object.isFrozen));
});
