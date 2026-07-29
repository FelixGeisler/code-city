import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { DEMO_MODEL } from "../apps/viewer/src/demo-model.js";
import {
  assignSemanticGroups,
  createPrusaXLProfile,
  createSingleChannelProfile,
  type PrinterProfile,
} from "../packages/core/src/index.js";
import {
  buildPrintableCityArtifacts,
  serializeThreeMf,
  validatePrintableCity,
} from "../packages/exporter/src/index.js";

function printDemo(profile: PrinterProfile, routePolicy: "auto" | "off") {
  return buildPrintableCityArtifacts(
    DEMO_MODEL,
    assignSemanticGroups(profile, DEMO_MODEL.semanticGroups),
    {
      profile,
      scale: 3,
      labelPolicy: "off",
      routePolicy,
    },
  );
}

function archiveText(bytes: Uint8Array): string {
  return Object.values(unzipSync(bytes))
    .map((entry) => new TextDecoder().decode(entry))
    .join("\n");
}

function overflowDemo(weight: number) {
  const privateTargets = Array.from(
    { length: 13 },
    (_, index) => `private-package-${String(index).padStart(2, "0")}`,
  );
  const externalDependencies = privateTargets.flatMap(
    (externalTarget, targetIndex) =>
      ["module:viewer", "module:core"].map((sourceId, sourceIndex) => ({
        id: `private-dependency-${targetIndex}-${sourceIndex}`,
        repositoryId: "repository:demo",
        sourceId,
        externalTarget,
        kind: "package-reference" as const,
        weight,
      })),
  );
  return {
    ...DEMO_MODEL,
    dependencies: [
      ...DEMO_MODEL.dependencies.filter(
        ({ externalTarget }) => externalTarget === undefined,
      ),
      ...externalDependencies,
    ],
  };
}

describe("print dependency integration", () => {
  it("prints the Demo on one extended base with fixed external boxes and grounded aggregate routes", () => {
    const profile = createPrusaXLProfile([1, 2, 3, 4, 5]);
    const modelBefore = structuredClone(DEMO_MODEL);
    const artifacts = printDemo(profile, "auto");
    const primitives = artifacts.city.parts.flatMap(
      ({ primitives: items }) => items,
    );
    const base = primitives.find(({ kind }) => kind === "base")!;
    const external = primitives.filter(
      ({ kind }) => kind === "dependency-endpoint",
    );
    const routes = primitives.filter(
      ({ semanticGroupId }) => semanticGroupId === "routes",
    );

    expect(artifacts.city.bounds).toMatchObject({
      minimum: { x: 0, y: 0, z: 0 },
      size: { x: 93, y: 60, z: 33 },
    });
    expect(artifacts.city.parts).toHaveLength(5);
    expect(external).toHaveLength(2);
    expect(
      external.map(({ id, semanticGroupId, bounds }) => ({
        id,
        semanticGroupId,
        size: bounds.size,
        bottom: bounds.minimum.z,
      })),
    ).toEqual([
      {
        id: "external-node:001",
        semanticGroupId: "external",
        size: { x: 12, y: 6, z: 9 },
        bottom: base.bounds.maximum.z,
      },
      {
        id: "external-node:002",
        semanticGroupId: "external",
        size: { x: 12, y: 6, z: 9 },
        bottom: base.bounds.maximum.z,
      },
    ]);
    expect(routes.length).toBeGreaterThan(0);
    expect(
      routes.every(
        ({ kind, bounds }) =>
          kind === "dependency-trace" &&
          bounds.minimum.z === base.bounds.maximum.z,
      ),
    ).toBe(true);
    expect(artifacts.routes).toMatchObject({
      policy: "auto",
      totalCount: 3,
      printedCount: 3,
      omittedCount: 0,
      totalWeight: 5,
      printedWeight: 5,
      omittedWeight: 0,
    });
    expect(artifacts.routes.printedCount).toBeGreaterThan(0);
    expect(
      artifacts.routes.printedCount + artifacts.routes.omittedCount,
    ).toBe(artifacts.routes.totalCount);
    expect(
      artifacts.routes.printedWeight + artifacts.routes.omittedWeight,
    ).toBe(artifacts.routes.totalWeight);
    expect(validatePrintableCity(artifacts.city, profile)).toEqual([]);
    expect(DEMO_MODEL).toEqual(modelBefore);
  });

  it.each([
    ["generic one channel", createSingleChannelProfile(), 1],
    ["Prusa XL one tool", createPrusaXLProfile([1]), 1],
    ["Prusa XL two tools", createPrusaXLProfile([1, 2]), 2],
    ["Prusa XL five tools", createPrusaXLProfile([1, 2, 3, 4, 5]), 5],
  ] as const)("supports %s without printer-specific route logic", (
    _name,
    profile,
    expectedParts,
  ) => {
    const artifacts = printDemo(profile, "auto");

    expect(artifacts.city.parts).toHaveLength(expectedParts);
    expect(artifacts.routes.printedCount).toBeGreaterThan(0);
    expect(validatePrintableCity(artifacts.city, profile)).toEqual([]);
  });

  it("turns routes and external endpoints off without changing the old Demo footprint", () => {
    const profile = createPrusaXLProfile([1, 2, 3, 4, 5]);
    const artifacts = printDemo(profile, "off");
    const primitives = artifacts.city.parts.flatMap(
      ({ primitives: items }) => items,
    );

    expect(artifacts.city.bounds.size).toEqual({ x: 93, y: 48, z: 33 });
    expect(
      primitives.some(
        ({ kind, semanticGroupId }) =>
          kind === "dependency-endpoint" ||
          semanticGroupId === "routes",
      ),
    ).toBe(false);
    expect(artifacts.routes).toMatchObject({
      policy: "off",
      totalCount: 0,
      printedCount: 0,
      printedWeight: 0,
    });
  });

  it("does not run route-only aggregation when routes are off", () => {
    const profile = createPrusaXLProfile([1, 2, 3, 4, 5]);
    const model = {
      ...DEMO_MODEL,
      modules: [
        ...DEMO_MODEL.modules,
        {
          id: "module:without-district",
          repositoryId: "repository:demo",
          kind: "npm-package" as const,
          name: "Unmapped package",
          path: "packages/unmapped",
          solutionIds: ["solution:demo"],
          packageId: "@code-city/unmapped",
        },
      ],
      dependencies: [
        ...DEMO_MODEL.dependencies,
        {
          id: "dependency:unmapped",
          repositoryId: "repository:demo",
          sourceId: "module:without-district",
          targetId: "module:core",
          kind: "project-reference" as const,
          weight: 1,
        },
      ],
    };
    const before = structuredClone(model);

    const artifacts = buildPrintableCityArtifacts(
      model,
      assignSemanticGroups(profile, model.semanticGroups),
      {
        profile,
        scale: 3,
        labelPolicy: "off",
        routePolicy: "off",
      },
    );

    expect(artifacts.routes).toEqual({
      policy: "off",
      totalCount: 0,
      printedCount: 0,
      omittedCount: 0,
      totalWeight: 0,
      printedWeight: 0,
      omittedWeight: 0,
    });
    expect(model).toEqual(before);
  });

  it("keeps district and external endpoint lookup namespaces separate", () => {
    const profile = createPrusaXLProfile([1, 2, 3, 4, 5]);
    const collidingId = "external\0three";
    const model = {
      ...DEMO_MODEL,
      districts: DEMO_MODEL.districts.map((district) =>
        district.id === "district:core"
          ? { ...district, id: collidingId }
          : district,
      ),
      buildings: DEMO_MODEL.buildings.map((building) =>
        building.districtId === "district:core"
          ? { ...building, districtId: collidingId }
          : building,
      ),
    };

    const artifacts = buildPrintableCityArtifacts(
      model,
      assignSemanticGroups(profile, model.semanticGroups),
      {
        profile,
        scale: 3,
        labelPolicy: "off",
        routePolicy: "auto",
      },
    );

    expect(artifacts.routes.printedCount).toBeGreaterThan(0);
    expect(
      archiveText(serializeThreeMf(artifacts.city)),
    ).not.toContain("external\u0000external\u0000three");
  });

  it("composes saturated hidden and unroutable weights without subtraction", () => {
    const profile = createPrusaXLProfile([1, 2, 3, 4, 5]);
    const model = overflowDemo(Number.MAX_VALUE);
    const artifacts = buildPrintableCityArtifacts(
      model,
      assignSemanticGroups(profile, model.semanticGroups),
      {
        profile,
        scale: 3,
        labelPolicy: "off",
        routePolicy: "auto",
      },
    );

    expect(artifacts.routes.totalWeight).toBe(Number.MAX_VALUE);
    expect(artifacts.routes.printedWeight).toBe(Number.MAX_VALUE);
    expect(artifacts.routes.omittedCount).toBeGreaterThan(0);
    expect(artifacts.routes.omittedWeight).toBe(Number.MAX_VALUE);
  });

  it("routes capped external overflow end to end with exact totals and private 3MF", () => {
    const profile = createPrusaXLProfile([1, 2, 3, 4, 5]);
    const model = overflowDemo(1);
    const artifacts = buildPrintableCityArtifacts(
      model,
      assignSemanticGroups(profile, model.semanticGroups),
      {
        profile,
        scale: 3,
        labelPolicy: "off",
        routePolicy: "auto",
      },
    );
    const primitives = artifacts.city.parts.flatMap(
      ({ primitives: items }) => items,
    );
    const text = archiveText(serializeThreeMf(artifacts.city));

    expect(
      primitives.filter(({ kind }) => kind === "dependency-endpoint"),
    ).toHaveLength(12);
    expect(artifacts.routes).toMatchObject({
      totalCount: 25,
      totalWeight: 29,
    });
    expect(
      artifacts.routes.printedCount + artifacts.routes.omittedCount,
    ).toBe(25);
    expect(
      artifacts.routes.printedWeight + artifacts.routes.omittedWeight,
    ).toBe(29);
    for (const privateValue of [
      "private-package-00",
      "private-package-12",
      "private-dependency-0-0",
    ]) {
      expect(text).not.toContain(privateValue);
    }
  });

  it("is byte-deterministic and keeps dependency identities out of 3MF", () => {
    const profile = createPrusaXLProfile([1, 2, 3, 4, 5]);
    const forward = printDemo(profile, "auto");
    const reversedModel = {
      ...DEMO_MODEL,
      repositories: [...DEMO_MODEL.repositories].reverse(),
      modules: [...DEMO_MODEL.modules].reverse(),
      semanticGroups: [...DEMO_MODEL.semanticGroups].reverse(),
      districts: [...DEMO_MODEL.districts].reverse(),
      buildings: [...DEMO_MODEL.buildings].reverse(),
      dependencies: [...DEMO_MODEL.dependencies].reverse(),
    };
    const reverse = buildPrintableCityArtifacts(
      reversedModel,
      assignSemanticGroups(profile, reversedModel.semanticGroups),
      {
        profile,
        scale: 3,
        labelPolicy: "off",
        routePolicy: "auto",
      },
    );
    const forwardBytes = serializeThreeMf(forward.city);
    const reverseBytes = serializeThreeMf(reverse.city);
    const text = archiveText(forwardBytes);

    expect(reverse.routes).toEqual(forward.routes);
    expect(reverseBytes).toEqual(forwardBytes);
    for (const privateValue of [
      "dependency:viewer-three-package",
      "dependency:core-typescript-package",
      "apps/viewer",
      "packages/core",
      "three",
      "typescript",
    ]) {
      expect(text).not.toContain(privateValue);
    }
  });
});
