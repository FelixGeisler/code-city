import { expect, it } from "vitest";

import {
  createPrusaXLProfile,
  createSingleChannelProfile,
  resolvePrinterGeometryLimits,
} from "../packages/core/src/index.js";
import {
  type CalibrationManifest,
  generateCalibrationExport,
  generateCalibrationPrintExport,
  MAXIMUM_CALIBRATION_CHANNELS,
  validateCalibrationPrintable,
} from "../packages/exporter/src/calibration.js";
import { cuboidMesh } from "../packages/exporter/src/geometry.js";
import { STL_INFORMATION_LOSS_WARNING } from "../packages/exporter/src/print-export.js";

const genericMultiChannel = {
  ...createSingleChannelProfile(),
  id: "generic-multi-channel",
  name: "Generic three-channel printer",
  overflowPolicy: "merge" as const,
  printChannels: [1, 2, 3].map((index) => ({
    id: `channel-${index}`,
    label: `Channel ${index}`,
    mechanism: "filament-switcher" as const,
  })),
};

function primitive(
  result: ReturnType<typeof generateCalibrationExport>,
  id: string,
) {
  const found = result.printable.parts
    .flatMap(({ primitives }) => primitives)
    .find((item) => item.id === id);
  expect(found, id).toBeDefined();
  return found!;
}

it.each([
  ["generic single channel", createSingleChannelProfile()],
  ["generic multi channel", genericMultiChannel],
  ["Prusa XL five tool", createPrusaXLProfile([1, 2, 3, 4, 5])],
] as const)(
  "generates deterministic serializer-validated watertight bytes for %s",
  (_label, profile) => {
    const first = generateCalibrationExport(profile);
    const second = generateCalibrationExport(profile);

    expect(first.threeMfBytes).toEqual(second.threeMfBytes);
    expect(first.manifestBytes).toEqual(second.manifestBytes);
    expect(first.threeMfBytes.subarray(0, 2)).toEqual(
      new TextEncoder().encode("PK"),
    );
    expect(first.preflight.channelCount).toBe(
      profile.printChannels.length,
    );
    expect(first.preflight.partCount).toBe(profile.printChannels.length);
    expect(first.preflight.triangleCount).toBeGreaterThan(0);
    expect(
      first.printable.parts.flatMap(({ primitives }) => primitives)
        .filter(({ id }) => id.startsWith("calibration-channel-")),
    ).toHaveLength(profile.printChannels.length);
  },
);

it("keeps the legacy 3MF API byte-identical to the generic artifact", () => {
  const profile = createPrusaXLProfile([1, 2, 3, 4, 5]);
  const legacy = generateCalibrationExport(profile);
  const generic = generateCalibrationPrintExport({
    profile,
    format: "3mf",
  });

  expect(generic.artifact).toMatchObject({
    format: "3mf",
    mimeType: "model/3mf",
    fileExtension: ".3mf",
    bytes: legacy.threeMfBytes,
  });
  expect(generic.manifestBytes).toEqual(legacy.manifestBytes);
  expect(generic.preflight.warnings).toEqual([]);
});

it("generates one deterministic multi-shell STL calibration artifact", () => {
  const profile = createSingleChannelProfile();
  const first = generateCalibrationPrintExport({
    profile,
    format: "stl",
  });
  const second = generateCalibrationPrintExport({
    profile,
    format: "stl",
  });

  expect(second).toEqual(first);
  expect(first.artifact).toMatchObject({
    format: "stl",
    mimeType: "model/stl",
    fileExtension: ".stl",
  });
  expect(first.artifact.bytes.byteLength).toBeGreaterThan(84);
  expect(first.preflight.partCount).toBe(1);
  expect(first.preflight.triangleCount).toBeGreaterThan(0);
  expect(first.preflight.warnings).toEqual([
    STL_INFORMATION_LOSS_WARNING,
  ]);
});

it("maps every physical measurement and channel marker to deterministic bounds", () => {
  const result = generateCalibrationExport(genericMultiChannel);
  const manifest = JSON.parse(
    new TextDecoder().decode(result.manifestBytes),
  ) as CalibrationManifest;
  const primitives = new Map(
    result.printable.parts
      .flatMap(({ primitives: items }) => items)
      .map((item) => [item.id, item]),
  );
  const coupons = new Map(
    manifest.coupons.map((coupon) => [coupon.id, coupon]),
  );

  for (const measurement of manifest.measurements) {
    if (measurement.couponId === undefined) continue;
    const coupon = coupons.get(measurement.couponId);
    expect(coupon, measurement.id).toBeDefined();
    expect(coupon!.measurementIds).toContain(measurement.id);
    for (const primitiveId of coupon!.primitiveIds) {
      const item = primitives.get(primitiveId);
      expect(item, primitiveId).toBeDefined();
      for (const axis of ["x", "y", "z"] as const) {
        expect(item!.bounds.minimum[axis]).toBeGreaterThanOrEqual(
          coupon!.bounds.minimum[axis],
        );
        expect(item!.bounds.maximum[axis]).toBeLessThanOrEqual(
          coupon!.bounds.maximum[axis],
        );
      }
    }
  }
  for (const channel of manifest.channels) {
    expect(coupons.get(channel.markerCouponId)?.markerForChannelId).toBe(
      channel.id,
    );
    expect(channel.markerBounds).toEqual(
      primitives.get(channel.markerId)?.bounds,
    );
  }
  expect(manifest.axes).toEqual({
    coordinateSpace: "print",
    x: { meaning: "width", cityAxis: "x" },
    y: { meaning: "depth", cityAxis: "z" },
    z: { meaning: "height", cityAxis: "y" },
  });
  expect(
    manifest.measurements.find(({ id }) => id === "build-margin-y")
      ?.axis,
  ).toMatchObject({ cityAxis: "y", printAxis: "z", meaning: "height" });
});

it("rejects open and detached coupon mutations before serialization", () => {
  const profile = createSingleChannelProfile();
  const result = generateCalibrationExport(profile);
  const part = result.printable.parts[0]!;
  const target = part.primitives.find(
    ({ id }) => id === "calibration-wall-01",
  )!;
  const openTarget = {
    ...target,
    mesh: {
      ...target.mesh,
      triangles: target.mesh.triangles.slice(1),
    },
  };
  const openPrintable = {
    ...result.printable,
    parts: [{
      ...part,
      primitives: part.primitives.map((item) =>
        item.id === target.id ? openTarget : item
      ),
    }],
  };
  expect(validateCalibrationPrintable(openPrintable, profile)).toContain(
    `Calibration primitive '${target.id}' must be a closed canonical cuboid.`,
  );

  const detachedBounds = {
    ...target.bounds,
    minimum: {
      ...target.bounds.minimum,
      z: target.bounds.minimum.z + 1,
    },
    maximum: {
      ...target.bounds.maximum,
      z: target.bounds.maximum.z + 1,
    },
  };
  const detachedTarget = {
    ...target,
    bounds: detachedBounds,
    mesh: cuboidMesh(detachedBounds),
  };
  const detachedPrintable = {
    ...result.printable,
    parts: [{
      ...part,
      primitives: part.primitives.map((item) =>
        item.id === target.id ? detachedTarget : item
      ),
    }],
  };
  expect(validateCalibrationPrintable(detachedPrintable, profile)).toContain(
    `Calibration primitive '${target.id}' is not face-supported by the base.`,
  );
});

it("preserves every exact coupon dimension and gap in printable bounds", () => {
  const profile = createSingleChannelProfile();
  const limits = resolvePrinterGeometryLimits(profile);
  const result = generateCalibrationExport(profile);

  expect(primitive(result, "calibration-base").bounds.size.z).toBe(
    limits.minimumBaseThickness,
  );
  expect(primitive(result, "calibration-wall-01").bounds.size.x).toBe(
    limits.minimumWallThickness,
  );
  expect(primitive(result, "calibration-raised-01").bounds.size.z).toBe(
    limits.minimumRaisedFeatureHeight,
  );
  expect(
    primitive(result, "calibration-label-stroke-01").bounds.size.x,
  ).toBe(limits.minimumLabelStrokeWidth);
  expect(
    primitive(result, "calibration-route-width-01").bounds.size.x,
  ).toBe(limits.minimumRouteWidth);
  expect(primitive(result, "calibration-line-width-01").bounds.size.x).toBe(
    limits.lineWidth,
  );
  expect(
    primitive(result, "calibration-nozzle-diameter-01").bounds.size.x,
  ).toBe(limits.nozzleDiameter);

  const gapLeft = primitive(result, "calibration-gap-01");
  const gapRight = primitive(result, "calibration-gap-02");
  expect(
    gapRight.bounds.minimum.x - gapLeft.bounds.maximum.x,
  ).toBeCloseTo(limits.minimumGap, 12);

  const recessRails = [1, 2, 3, 4].map((index) =>
    primitive(
      result,
      `calibration-recessed-${String(index).padStart(2, "0")}`,
    ),
  );
  expect(
    new Set(recessRails.map(({ bounds }) => bounds.size.z)),
  ).toEqual(new Set([limits.minimumRecessedFeatureDepth]));
  expect(
    result.preflight.measurements.find(
      ({ id }) => id === "minimum-recessed-feature-depth",
    )?.reference,
  ).toBe("rail-defined-groove");
});

it("uses margins as reduced spans while keeping portable zero-origin geometry", () => {
  const base = createSingleChannelProfile();
  const profile = {
    ...base,
    buildVolume: { x: 60, y: 30, z: 60 },
    geometryLimits: {
      ...base.geometryLimits,
      buildMargins: { x: 2, y: 3, z: 4 },
      maximumModelHeight: 20,
    },
  };

  const result = generateCalibrationExport(profile);
  expect(result.printable.bounds.minimum).toEqual({ x: 0, y: 0, z: 0 });
  expect(result.printable.bounds.size.x).toBeLessThanOrEqual(56);
  expect(result.printable.bounds.size.y).toBeLessThanOrEqual(52);
  expect(result.printable.bounds.size.z).toBeLessThanOrEqual(20);
});

it("fails actionably before allocating unbounded channel coupons", () => {
  const base = createSingleChannelProfile();
  const profile = {
    ...base,
    printChannels: Array.from(
      { length: MAXIMUM_CALIBRATION_CHANNELS + 1 },
      (_unused, index) => ({
        id: `channel-${index + 1}`,
        label: `Channel ${index + 1}`,
        mechanism: "filament-switcher" as const,
      }),
    ),
  };

  expect(() => generateCalibrationExport(profile)).toThrow(
    `at most ${MAXIMUM_CALIBRATION_CHANNELS} print channels`,
  );
});

it("reports margin-adjusted fit failures with the limiting axis", () => {
  const base = createSingleChannelProfile();
  const profile = {
    ...base,
    buildVolume: { x: 10, y: 10, z: 10 },
    geometryLimits: {
      ...base.geometryLimits,
      buildMargins: { x: 5, y: 0, z: 0 },
    },
  };

  expect(() => generateCalibrationExport(profile)).toThrow(
    /buildMargins\.x.*leaves no usable X/u,
  );
});
