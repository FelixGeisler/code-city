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
  { M: 0, range: "0", rgba: "#440154FF" },
  { M: 1, range: "1", rgba: "#414487FF" },
  { M: 2, range: "2–3", rgba: "#2A788EFF" },
  { M: 3, range: "2–3", rgba: "#2A788EFF" },
  { M: 4, range: "4–7", rgba: "#22A884FF" },
  { M: 7, range: "4–7", rgba: "#22A884FF" },
  { M: 8, range: "8–15", rgba: "#7AD151FF" },
  { M: 15, range: "8–15", rgba: "#7AD151FF" },
  { M: 16, range: "16+", rgba: "#FDE725FF" },
];

test("metric explanation maps every required palette boundary and exact derived dimension", () => {
  for (const [index, expected] of boundaries.entries()) {
    const fact = { canonicalPath: `fixture/${index}.ts`, S: index, U: index + 2, M: expected.M };
    assert.deepEqual(explainMetricFact(fact), {
      canonicalPath: fact.canonicalPath,
      sourceLines: index,
      executableUnits: index + 2,
      maximumComplexity: expected.M,
      height: index + 1,
      width: index + 3,
      depth: index + 3,
      paletteRange: expected.range,
      rgba: expected.rgba,
    });
    assert.equal(Object.isFrozen(explainMetricFact(fact)), true);
  }
});

test("the text legend is one immutable complete six-band M1 palette", () => {
  assert.deepEqual(METRIC_PALETTE_LEGEND, [
    { range: "0", rgba: "#440154FF" },
    { range: "1", rgba: "#414487FF" },
    { range: "2–3", rgba: "#2A788EFF" },
    { range: "4–7", rgba: "#22A884FF" },
    { range: "8–15", rgba: "#7AD151FF" },
    { range: "16+", rgba: "#FDE725FF" },
  ]);
  assert.equal(Object.isFrozen(METRIC_PALETTE_LEGEND), true);
  assert(METRIC_PALETTE_LEGEND.every(Object.isFrozen));
});
