import { describe, expect, it } from "vitest";

import { DEMO_MODEL } from "../apps/viewer/src/demo-model.js";
import {
  assignSemanticGroups,
  createPrusaXLProfile,
  serializePrintLegend,
} from "../packages/core/src/index.js";
import {
  buildPrintableCityArtifacts,
  serializeThreeMf,
} from "../packages/exporter/src/index.js";

function artifacts(
  model = DEMO_MODEL,
  labelPolicy: "auto" | "off" = "auto",
) {
  const profile = createPrusaXLProfile([1, 2, 3, 4, 5]);
  return buildPrintableCityArtifacts(
    model,
    assignSemanticGroups(profile, model.semanticGroups),
    { profile, scale: 3, labelPolicy },
  );
}

describe("private print legend", () => {
  it("contains stable source lookup data and physical print outcomes", () => {
    const result = artifacts();

    expect(result.legend).toMatchObject({
      schemaVersion: "1.0",
      title: "Code City",
      profileId: "prusa-xl-t1-t2-t3-t4-t5",
      labelPolicy: "auto",
    });
    expect(result.legend.buildings).toHaveLength(5);
    expect(result.legend.districts).toHaveLength(2);
    expect(result.legend.buildings[0]).toEqual({
      code: "000",
      repositoryId: "repository:demo",
      repositoryName: "Code City Demo",
      districtId: "district:core",
      districtName: "Core",
      buildingId: "building:schema",
      buildingName: "city-model.schema.json",
      path: "packages/core/schema/city-model.schema.json",
      physicalPrint: {
        status: "printed",
        text: "000",
        mode: "code",
      },
    });
  });

  it("serializes identical LF-terminated bytes for reordered model arrays", () => {
    const forward = artifacts();
    const reversedModel = {
      ...DEMO_MODEL,
      repositories: [...DEMO_MODEL.repositories].reverse(),
      modules: [...DEMO_MODEL.modules].reverse(),
      semanticGroups: [...DEMO_MODEL.semanticGroups].reverse(),
      districts: [...DEMO_MODEL.districts].reverse(),
      buildings: [...DEMO_MODEL.buildings].reverse(),
      dependencies: [...DEMO_MODEL.dependencies].reverse(),
    };
    const reverse = artifacts(reversedModel);
    const forwardBytes = serializePrintLegend(forward.legend);
    const reverseBytes = serializePrintLegend(reverse.legend);

    expect(reverseBytes).toEqual(forwardBytes);
    expect(new TextDecoder().decode(forwardBytes).endsWith("\n")).toBe(true);
  });

  it("keeps legend-only names and paths out of the 3MF archive", () => {
    const sentinelName = "PRIVATE_SENTINEL_FILE.ts";
    const sentinelPath = "private/PRIVATE_SENTINEL_PATH.ts";
    const model = {
      ...DEMO_MODEL,
      buildings: DEMO_MODEL.buildings.map((building, index) =>
        index === 0
          ? { ...building, name: sentinelName, path: sentinelPath }
          : building,
      ),
    };
    const result = artifacts(model);
    const archiveText = new TextDecoder().decode(
      serializeThreeMf(result.city),
    );
    const legendText = new TextDecoder().decode(
      serializePrintLegend(result.legend),
    );

    expect(legendText).toContain(sentinelName);
    expect(legendText).toContain(sentinelPath);
    expect(archiveText).not.toContain(sentinelName);
    expect(archiveText).not.toContain(sentinelPath);
    expect(archiveText).not.toContain('"buildings"');
  });

  it("records policy and fit omissions without failing export", () => {
    const disabled = artifacts(DEMO_MODEL, "off");
    expect(disabled.labels).toEqual({
      printedBuildings: 0,
      skippedBuildings: 5,
      printedDistricts: 0,
      skippedDistricts: 2,
    });
    expect(
      disabled.legend.buildings.every(
        ({ physicalPrint }) =>
          physicalPrint.status === "skipped" &&
          physicalPrint.reason === "policy-off",
      ),
    ).toBe(true);
    expect(
      disabled.city.parts
        .flatMap(({ primitives }) => primitives)
        .some(({ kind }) => kind.endsWith("-label")),
    ).toBe(false);

    const tinyRoofModel = {
      ...DEMO_MODEL,
      buildings: DEMO_MODEL.buildings.map((building, index) =>
        index === 0
          ? {
              ...building,
              size: { ...building.size, x: 0.3, z: 0.3 },
            }
          : building,
      ),
    };
    const tiny = artifacts(tinyRoofModel);
    const status = tiny.legend.buildings.find(
      ({ buildingId }) => buildingId === DEMO_MODEL.buildings[0]!.id,
    )!.physicalPrint;
    expect(status).toEqual({
      status: "skipped",
      reason: "roof-too-small",
    });
  });

  it("falls back from an oversized district name to its deterministic code", () => {
    const model = {
      ...DEMO_MODEL,
      districts: DEMO_MODEL.districts.map((district, index) =>
        index === 0 ? { ...district, name: "A".repeat(200) } : district,
      ),
    };
    const result = artifacts(model);
    const district = result.legend.districts.find(
      ({ districtId }) => districtId === DEMO_MODEL.districts[0]!.id,
    )!;

    expect(district.physicalPrint).toEqual({
      status: "printed",
      text: district.code,
      mode: "code",
    });
  });

});
