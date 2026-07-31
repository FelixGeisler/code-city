import { describe, expect, it } from "vitest";

import { DEMO_MODEL } from "../apps/viewer/src/demo-model.js";
import {
  DESIGN_SMELL_SUPPRESSION_STORAGE_PREFIX,
  DesignSmellSuppressionStore,
} from "../apps/viewer/src/design-smell-storage.js";
import { metricMappingProjectIdentity } from "../apps/viewer/src/metric-mapping-storage.js";
import { DESIGN_SMELL_PROTOCOL_VERSION } from "../packages/core/src/index.js";

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe("design smell suppression storage", () => {
  it("persists a project-local decision without changing the model", () => {
    const storage = new MemoryStorage();
    const store = new DesignSmellSuppressionStore(storage);
    const building = DEMO_MODEL.buildings[0]!;
    const before = structuredClone(DEMO_MODEL);

    expect(
      store.save(DEMO_MODEL, {
        protocolVersion: DESIGN_SMELL_PROTOCOL_VERSION,
        buildingId: building.id,
        ruleId: "oversized-file",
        reason: "Generated source.",
      }),
    ).toBe(true);

    expect(store.list(DEMO_MODEL)).toEqual([
      {
        protocolVersion: DESIGN_SMELL_PROTOCOL_VERSION,
        buildingId: building.id,
        ruleId: "oversized-file",
        reason: "Generated source.",
      },
    ]);
    expect(DEMO_MODEL).toEqual(before);
  });

  it("ignores the entire document when schema, order, or entries are forged", () => {
    const storage = new MemoryStorage();
    const key =
      DESIGN_SMELL_SUPPRESSION_STORAGE_PREFIX +
      metricMappingProjectIdentity(DEMO_MODEL);
    storage.values.set(
      key,
      JSON.stringify({
        protocolVersion: DESIGN_SMELL_PROTOCOL_VERSION,
        projectIdentity: metricMappingProjectIdentity(DEMO_MODEL),
        suppressions: [
          {
            protocolVersion: DESIGN_SMELL_PROTOCOL_VERSION,
            buildingId: DEMO_MODEL.buildings[0]!.id,
            ruleId: "oversized-file",
            reason: "Valid",
            future: true,
          },
        ],
      }),
    );

    expect(
      new DesignSmellSuppressionStore(storage).list(DEMO_MODEL),
    ).toEqual([]);
  });
});
