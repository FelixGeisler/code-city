import { describe, expect, it } from "vitest";

import type {
  EvolutionBundle,
  EvolutionChanges,
} from "../packages/core/src/index.js";
import { DEMO_MODEL } from "../apps/viewer/src/demo-model.js";
import {
  analyzeEvolutionBuildingHistory,
  analyzeEvolutionFrame,
  compareEvolutionFrames,
  EvolutionSeekGate,
  summarizeEvolutionFrames,
} from "../apps/viewer/src/evolution-timeline.js";

function commit(index: number) {
  return {
    index,
    sha: String(index).repeat(40),
    committedAt: `2026-01-0${index + 1}T00:00:00.000Z`,
    parentShas: [],
    analyzerVersion: "1.0.0",
    analysisFingerprint: `sha256:${String(index).repeat(64)}` as const,
  };
}

function emptyChanges(): EvolutionChanges {
  const empty = () => ({ added: [], removed: [], changed: [] });
  return {
    model: {},
    repositories: empty(),
    solutions: empty(),
    modules: empty(),
    semanticGroups: empty(),
    districts: empty(),
    buildings: empty(),
    dependencies: empty(),
  };
}

function fixture(): EvolutionBundle {
  const original = DEMO_MODEL.buildings[0]!;
  const added = {
    ...original,
    id: "building:timeline-added",
    name: "Added",
    path: "src/added.ts",
  };
  const renamed = {
    ...original,
    name: `${original.name} renamed`,
    path: `${original.path}.renamed`,
    size: { ...original.size, y: original.size.y + 1 },
  };
  return {
    baseline: { commit: commit(0), model: DEMO_MODEL },
    deltas: [
      {
        commit: commit(1),
        changes: {
          ...emptyChanges(),
          buildings: {
            added: [added],
            removed: [],
            changed: [
              {
                id: original.id,
                changeKinds: ["renamed", "geometry"],
                entity: renamed,
              },
            ],
          },
        },
      },
      {
        commit: commit(2),
        changes: {
          ...emptyChanges(),
          buildings: {
            added: [],
            removed: [original.id],
            changed: [],
          },
        },
      },
    ],
  } as unknown as EvolutionBundle;
}

describe("viewer evolution timeline analysis", () => {
  it("returns to idle after cancelling a seek and accepts the next navigation", () => {
    const gate = new EvolutionSeekGate();
    const cancelled = gate.begin();
    expect(gate.busy).toBe(true);

    expect(gate.cancel()).toBe(true);
    expect(gate.busy).toBe(false);
    expect(gate.isCurrent(cancelled)).toBe(false);

    const next = gate.begin();
    expect(gate.settle(cancelled)).toBe(false);
    expect(gate.busy).toBe(true);
    expect(gate.settle(next)).toBe(true);
    expect(gate.busy).toBe(false);
  });

  it("summarizes frames and stable-lineage history deterministically", () => {
    const bundle = fixture();
    const frames = summarizeEvolutionFrames(bundle);
    const histories = analyzeEvolutionBuildingHistory(bundle);
    const original = histories.find(
      ({ id }) => id === DEMO_MODEL.buildings[0]!.id,
    )!;
    const added = histories.find(
      ({ id }) => id === "building:timeline-added",
    )!;

    expect(frames.map(({ index }) => index)).toEqual([0, 1, 2]);
    expect(original).toMatchObject({
      firstFrame: 0,
      lastFrame: 1,
      removedAtFrame: 2,
      changeCount: 2,
      changeKinds: ["geometry", "renamed"],
    });
    expect(added).toMatchObject({ firstFrame: 1, lastFrame: 2 });
  });

  it("computes age and churn only for buildings present at the target", () => {
    const analysis = analyzeEvolutionFrame(fixture(), 2);
    const ages = new Map(analysis.ageByBuildingId);
    const churn = new Map(analysis.churnByBuildingId);

    expect(ages.has(DEMO_MODEL.buildings[0]!.id)).toBe(false);
    expect(ages.get("building:timeline-added")).toBe(1);
    expect(churn.get("building:timeline-added")).toBe(1);
  });

  it("distinguishes additions, removals, renames, and resizing", () => {
    const original = DEMO_MODEL.buildings[0]!;
    const target = {
      ...DEMO_MODEL,
      buildings: [
        {
          ...original,
          name: "Renamed",
          size: { ...original.size, y: original.size.y + 1 },
        },
        {
          ...DEMO_MODEL.buildings[1]!,
          id: "building:new",
        },
      ],
    };
    const transition = compareEvolutionFrames(DEMO_MODEL, target, 0, 7);

    expect(transition.fromIndex).toBe(0);
    expect(transition.toIndex).toBe(7);
    expect(transition.addedBuildingIds).toContain("building:new");
    expect(transition.renamedBuildingIds).toContain(original.id);
    expect(transition.resizedBuildingIds).toContain(original.id);
    expect(transition.interpolatedBuildings).toContainEqual({
      id: original.id,
      position: original.position,
      size: original.size,
    });
    expect(transition.removedBuildings.length).toBe(
      DEMO_MODEL.buildings.length - 1,
    );
  });
});
