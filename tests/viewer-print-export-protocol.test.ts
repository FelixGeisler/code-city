import { describe, expect, it } from "vitest";

import { DEMO_MODEL } from "../apps/viewer/src/demo-model.js";
import {
  boundedPrintTransferBuffer,
  isPrintCalibrationGenerateRequest,
  isPrintExportGenerateRequest,
  isPrintExportWorkerResponse,
  serializePrintExportError,
  type PrintExportGenerateRequest,
  type PrintExportTransferArtifact,
} from "../apps/viewer/src/print-export-protocol.js";
import {
  createSingleChannelProfile,
  PRINT_FIDELITY_EPSILON,
  PrintLayoutError,
  planPrintLayout,
  type PrintLayoutDistrictInput,
} from "../packages/core/src/index.js";
import {
  generateCalibrationPrintExport,
} from "../packages/exporter/src/calibration.js";
import {
  preparePrintPlateBundle,
  type PrintPlateBundlePreflight,
  type PrintPlatePreviewSource,
} from "../packages/exporter/src/print-plates.js";

function samplePreflight(): PrintPlateBundlePreflight {
  const labels = {
    printedBuildings: 0,
    skippedBuildings: 0,
    printedDistricts: 0,
    skippedDistricts: 0,
  };
  const routes = {
    policy: "off" as const,
    totalCount: 0,
    printedCount: 0,
    omittedCount: 0,
    totalWeight: 0,
    printedWeight: 0,
    omittedWeight: 0,
  };
  return {
    format: "3mf",
    title: "Code City",
    profileId: "printer",
    profileName: "Printer",
    fitPolicy: "error",
    requestedScale: 3,
    appliedScale: 3,
    minimumSafeScale: 3,
    wipeTowerReserveDepth: 0,
    belowProfileScaleAcknowledged: false,
    featureViolations: [],
    plateCount: 1,
    plates: [{
      number: 1,
      id: "plate-01",
      fileName: "plate-01.3mf",
      dimensions: { width: 10, depth: 20, height: 30 },
      utilization: 0.25,
      channelIds: [],
      warnings: [],
      labels,
      routes,
    }],
    warnings: [],
    unplacedObjects: [],
    routeOmissions: [],
    labels,
    routes,
    legendIncluded: true,
  };
}

function sampleArtifact(
  format: "3mf" | "stl" = "3mf",
): PrintExportTransferArtifact {
  return format === "3mf"
    ? {
        format,
        mimeType: "model/3mf",
        fileExtension: ".3mf",
        bytes: new ArrayBuffer(4),
      }
    : {
        format,
        mimeType: "model/stl",
        fileExtension: ".stl",
        bytes: new ArrayBuffer(4),
      };
}

function samplePreview(
  preflight: PrintPlateBundlePreflight,
): PrintPlatePreviewSource {
  const dimensions = preflight.plates[0]!.dimensions;
  const bounds = {
    minimum: { x: 0, y: 0, z: 0 },
    maximum: {
      x: dimensions.width,
      y: dimensions.depth,
      z: dimensions.height,
    },
    size: {
      x: dimensions.width,
      y: dimensions.depth,
      z: dimensions.height,
    },
  };
  return {
    fitPolicy: "error",
    appliedPolicy: "error",
    requestedScale: 3,
    appliedScale: 3,
    minimumSafeScale: 3,
    belowProfileScaleAcknowledged: false,
    featureViolations: [],
    sourceBounds: bounds,
    printableBounds: bounds,
    warnings: preflight.warnings,
    unplacedObjects: [],
    plates: [
      {
        number: 1,
        id: "plate-01",
        fileName: `plate-01.${preflight.format}`,
        utilization: 0.25,
        bounds,
        warnings: preflight.warnings,
        parts: [],
      },
    ],
  };
}

const plannerFeatures = {
  wallThickness: 1,
  gap: 1,
  minimumFeatureSize: 1,
  baseThickness: 1,
  labelStrokeWidth: 1,
  raisedFeatureHeight: 1,
  recessedFeatureDepth: 1,
  routeWidth: 1,
  connectorWidth: 1,
};

function plannerDistrict(
  id: string,
  width: number,
  depth: number,
): PrintLayoutDistrictInput {
  return {
    id,
    name: `District ${id}`,
    sourceBounds: {
      minimum: { x: 0, y: 0, z: 0 },
      maximum: { x: width, y: 5, z: depth },
    },
    channelIds: ["channel-1"],
  };
}

function actualPlannerFailure(
  requestedScale: number,
  districts: readonly PrintLayoutDistrictInput[],
): PrintLayoutError {
  const profile = createSingleChannelProfile({
    buildVolume: { x: 60, y: 30, z: 45 },
    geometryLimits: {
      minimumWallThickness: 1,
      minimumGap: 1,
      minimumFeatureSize: 1,
      minimumBaseThickness: 1,
      nozzleDiameter: 1,
      lineWidth: 1,
      buildMargins: { x: 0, y: 0, z: 0 },
      minimumRaisedFeatureHeight: 1,
      minimumRecessedFeatureDepth: 1,
      minimumLabelStrokeWidth: 1,
      minimumRouteWidth: 1,
      maximumModelHeight: 30,
    },
  });
  try {
    planPrintLayout(profile, {
      requestedScale,
      features: plannerFeatures,
      districts,
    });
  } catch (error) {
    expect(error).toBeInstanceOf(PrintLayoutError);
    return error as PrintLayoutError;
  }
  throw new Error("Expected the print planner to reject the layout.");
}

function serializedFailureText(
  failure: ReturnType<typeof serializePrintExportError>,
): string {
  return [
    failure.message,
    ...failure.issues.map((issue) =>
      typeof issue === "string" ? issue : issue.message),
  ].join(" ");
}

describe("viewer print export protocol", () => {
  it("accepts only complete generate requests with positive job ids", () => {
    const request: PrintExportGenerateRequest = {
      type: "generate",
      jobId: 7,
      format: "3mf",
      model: { schemaVersion: "1.0" },
      profile: { id: "printer" },
      options: {
        scale: 3,
        labelPolicy: "auto",
        routePolicy: "off",
        includeLegend: true,
      },
    };

    expect(isPrintExportGenerateRequest(request)).toBe(true);
    expect(
      isPrintExportGenerateRequest({ ...request, jobId: 0 }),
    ).toBe(false);
    expect(
      isPrintExportGenerateRequest({
        ...request,
        format: "obj",
      }),
    ).toBe(false);
    for (const wipeTowerReserveDepth of [0, 72, 359.999]) {
      expect(
        isPrintExportGenerateRequest({
          ...request,
          options: {
            ...request.options,
            wipeTowerReserveDepth,
          },
        }),
      ).toBe(true);
    }
    for (const wipeTowerReserveDepth of [
      -1,
      360,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "72",
    ]) {
      expect(
        isPrintExportGenerateRequest({
          ...request,
          options: {
            ...request.options,
            wipeTowerReserveDepth,
          },
        }),
      ).toBe(false);
    }
    expect(
      isPrintExportGenerateRequest({
        ...request,
        options: { ...request.options, routePolicy: "always" },
      }),
    ).toBe(false);
    expect(
      isPrintExportGenerateRequest({
        ...request,
        options: {
          ...request.options,
          fitPolicy: "tile",
          maximumPlateCount: 99,
        },
      }),
    ).toBe(true);
    expect(
      isPrintExportGenerateRequest({
        ...request,
        options: {
          ...request.options,
          confirmCompactFit: true,
        },
      }),
    ).toBe(true);
    expect(
      isPrintExportGenerateRequest({
        ...request,
        options: {
          ...request.options,
          fitPolicy: "auto",
          confirmCompactFit: true,
        },
      }),
    ).toBe(true);
    expect(
      isPrintExportGenerateRequest({
        ...request,
        options: {
          ...request.options,
          fitPolicy: "scale",
          confirmCompactFit: true,
        },
      }),
    ).toBe(false);
    expect(
      isPrintExportGenerateRequest({
        ...request,
        options: {
          ...request.options,
          fitPolicy: "tile",
          maximumPlateCount: 100,
        },
      }),
    ).toBe(false);
    expect(
      isPrintExportGenerateRequest({
        type: "generate",
        jobId: 1,
        format: "3mf",
        profile: {},
        options: request.options,
      }),
    ).toBe(false);
  });

  it("accepts only profile-only calibration requests", () => {
    const request = {
      type: "calibrate",
      jobId: 8,
      format: "stl",
      profile: createSingleChannelProfile(),
    } as const;

    expect(isPrintCalibrationGenerateRequest(request)).toBe(true);
    expect(
      isPrintCalibrationGenerateRequest({ ...request, jobId: 0 }),
    ).toBe(false);
    expect(
      isPrintCalibrationGenerateRequest({
        type: "calibrate",
        jobId: 8,
      }),
    ).toBe(false);
    expect(
      isPrintCalibrationGenerateRequest({
        ...request,
        format: "obj",
      }),
    ).toBe(false);
    expect(
      isPrintCalibrationGenerateRequest({
        ...request,
        type: "generate",
      }),
    ).toBe(false);
  });

  it("validates every worker response variant and transferable result", () => {
    const preflight = samplePreflight();
    const preview = samplePreview(preflight);
    const archive = new ArrayBuffer(4);

    expect(
      isPrintExportWorkerResponse({
        type: "progress",
        jobId: 1,
        phase: "geometry",
        completed: 0.35,
        message: "Building printable geometry",
      }),
    ).toBe(true);
    expect(
      isPrintExportWorkerResponse({
        type: "preflight",
        jobId: 1,
        preflight,
        preview,
      }),
    ).toBe(true);
    expect(
      isPrintExportWorkerResponse({
        type: "result",
        jobId: 1,
        artifact: { ...sampleArtifact(), bytes: archive },
        manifestBytes: new ArrayBuffer(8),
      }),
    ).toBe(true);
    expect(
      isPrintExportWorkerResponse({
        type: "result",
        jobId: 1,
        artifact: {
          ...sampleArtifact(),
          bytes: new Uint8Array(4),
        },
      }),
    ).toBe(false);
    expect(
      isPrintExportWorkerResponse({
        type: "result",
        jobId: 1,
        artifact: {
          ...sampleArtifact(),
          mimeType: "model/stl",
        },
      }),
    ).toBe(false);
    expect(
      isPrintExportWorkerResponse({
        type: "result",
        jobId: 1,
        artifact: sampleArtifact("stl"),
        manifestBytes: new ArrayBuffer(8),
      }),
    ).toBe(true);
    expect(
      isPrintExportWorkerResponse({
        type: "progress",
        jobId: 1,
        phase: "geometry",
        completed: 2,
        message: "Impossible progress",
      }),
    ).toBe(false);
    const {
      wipeTowerReserveDepth: _omittedWipeTowerReserveDepth,
      ...legacyPreflight
    } = preflight;
    expect(
      isPrintExportWorkerResponse({
        type: "preflight",
        jobId: 1,
        preflight: legacyPreflight,
        preview,
      }),
    ).toBe(false);
    for (const wipeTowerReserveDepth of [
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(
        isPrintExportWorkerResponse({
          type: "preflight",
          jobId: 1,
          preflight: { ...preflight, wipeTowerReserveDepth },
          preview,
        }),
      ).toBe(false);
    }
    expect(
      isPrintExportWorkerResponse({
        type: "preflight",
        jobId: 1,
        preflight: {
          ...preflight,
          plates: preflight.plates.map((plate) => ({
            ...plate,
            dimensions: {
              ...plate.dimensions,
              width: Number.NaN,
            },
          })),
        },
        preview,
      }),
    ).toBe(false);
    expect(
      isPrintExportWorkerResponse({
        type: "preflight",
        jobId: 1,
        preflight: {
          ...preflight,
          plates: preflight.plates.map((plate) => ({
            ...plate,
            channelIds: [""],
          })),
        },
        preview,
      }),
    ).toBe(false);
    expect(
      isPrintExportWorkerResponse({
        type: "preflight",
        jobId: 1,
        preflight,
      }),
    ).toBe(false);
    expect(
      isPrintExportWorkerResponse({
        type: "preflight",
        jobId: 1,
        preflight,
        preview: {
          ...preview,
          printableBounds: {
            ...preview.printableBounds,
            minimum: { x: 1, y: 0, z: 0 },
            maximum: {
              ...preview.printableBounds.maximum,
              x: preview.printableBounds.maximum.x + 1,
            },
          },
        },
      }),
    ).toBe(false);
  });

  it("accepts fractional and saturated finite route weights", () => {
    const base = samplePreflight();
    const preview = samplePreview(base);
    const fractionalRoutes = {
      policy: "auto" as const,
      totalCount: 1,
      printedCount: 0,
      omittedCount: 1,
      totalWeight: 0.25,
      printedWeight: 0,
      omittedWeight: 0.25,
    };
    const fractional = {
      ...base,
      routes: fractionalRoutes,
      plates: base.plates.map((plate) => ({
        ...plate,
        routes: fractionalRoutes,
      })),
      routeOmissions: [{
        routeId: "route:fractional",
        weight: 0.25,
        reason: "policy" as const,
        consumer: {
          kind: "district" as const,
          id: "district:a",
          label: "A",
          plateNumber: 1,
        },
        provider: {
          kind: "external" as const,
          id: "package:b",
          label: "B",
          plateNumber: 1,
        },
      }],
    };
    expect(isPrintExportWorkerResponse({
      type: "preflight",
      jobId: 8,
      preflight: fractional,
      preview,
    })).toBe(true);

    const saturatedRoutes = {
      policy: "auto" as const,
      totalCount: 2,
      printedCount: 2,
      omittedCount: 0,
      totalWeight: Number.MAX_VALUE,
      printedWeight: Number.MAX_VALUE,
      omittedWeight: 0,
    };
    const saturated = {
      ...base,
      routes: saturatedRoutes,
      plates: base.plates.map((plate) => ({
        ...plate,
        routes: saturatedRoutes,
      })),
    };
    expect(isPrintExportWorkerResponse({
      type: "preflight",
      jobId: 9,
      preflight: saturated,
      preview,
    })).toBe(true);
  });

  it("enforces fit semantics and bounded transfer buffers", () => {
    const base = samplePreflight();
    const preview = samplePreview(base);
    expect(isPrintExportWorkerResponse({
      type: "preflight",
      jobId: 10,
      preflight: { ...base, appliedScale: 2 },
      preview: { ...preview, appliedScale: 2 },
    })).toBe(false);
    expect(isPrintExportWorkerResponse({
      type: "preflight",
      jobId: 10,
      preflight: {
        ...base,
        appliedScale: base.requestedScale + PRINT_FIDELITY_EPSILON / 2,
      },
      preview: {
        ...preview,
        appliedScale: base.requestedScale + PRINT_FIDELITY_EPSILON / 2,
      },
    })).toBe(true);
    expect(isPrintExportWorkerResponse({
      type: "preflight",
      jobId: 10,
      preflight: {
        ...base,
        appliedScale: base.requestedScale + PRINT_FIDELITY_EPSILON * 2,
      },
      preview: {
        ...preview,
        appliedScale: base.requestedScale + PRINT_FIDELITY_EPSILON * 2,
      },
    })).toBe(false);
    expect(boundedPrintTransferBuffer(new ArrayBuffer(4), 4)).toBe(true);
    expect(boundedPrintTransferBuffer(new ArrayBuffer(5), 4)).toBe(false);
    expect(() =>
      boundedPrintTransferBuffer(new ArrayBuffer(1), 0),
    ).toThrow(TypeError);
  });

  it("accepts only acknowledged, canonical, matching below-profile metadata", () => {
    const base = samplePreflight();
    const featureViolations = [
      {
        category: "wall-thickness" as const,
        resultingValue: 0.4,
        minimum: 0.8,
      },
      {
        category: "gap" as const,
        resultingValue: 0.2,
        minimum: 0.5,
      },
    ];
    const preflight: PrintPlateBundlePreflight = {
      ...base,
      requestedScale: 0.5,
      appliedScale: 0.5,
      minimumSafeScale: 1.6,
      belowProfileScaleAcknowledged: true,
      featureViolations,
    };
    const preview: PrintPlatePreviewSource = {
      ...samplePreview(preflight),
      requestedScale: 0.5,
      appliedScale: 0.5,
      minimumSafeScale: 1.6,
      belowProfileScaleAcknowledged: true,
      featureViolations,
    };
    const response = {
      type: "preflight",
      jobId: 11,
      preflight,
      preview,
    } as const;

    expect(isPrintExportWorkerResponse(response)).toBe(true);
    expect(isPrintExportWorkerResponse({
      ...response,
      preflight: {
        ...preflight,
        belowProfileScaleAcknowledged: false,
      },
    })).toBe(false);
    expect(isPrintExportWorkerResponse({
      ...response,
      preflight: {
        ...preflight,
        featureViolations: [...featureViolations].reverse(),
      },
    })).toBe(false);
    expect(isPrintExportWorkerResponse({
      ...response,
      preflight: {
        ...preflight,
        featureViolations: [{
          category: "wall-thickness",
          resultingValue: 0.8,
          minimum: 0.8,
        }],
      },
    })).toBe(false);
    expect(isPrintExportWorkerResponse({
      ...response,
      preview: {
        ...preview,
        minimumSafeScale: 1.7,
      },
    })).toBe(false);

    const request: PrintExportGenerateRequest = {
      type: "generate",
      jobId: 12,
      format: "3mf",
      model: {},
      profile: {},
      options: {
        scale: 0.5,
        fitPolicy: "error",
        labelPolicy: "off",
        routePolicy: "off",
        includeLegend: false,
      },
    };
    expect(isPrintExportGenerateRequest(request)).toBe(true);
    expect(isPrintExportGenerateRequest({
      ...request,
      options: {
        ...request.options,
        acknowledgeBelowProfileScale: true,
      },
    })).toBe(false);
  });

  it("validates an exact Auto compact-fit proposal without artifact bytes", () => {
    const featureViolations = [{
      category: "wall-thickness" as const,
      resultingValue: 0.4,
      minimum: 0.8,
    }];
    const preflight: PrintPlateBundlePreflight = {
      ...samplePreflight(),
      fitPolicy: "scale",
      requestedScale: 3,
      appliedScale: 0.5,
      minimumSafeScale: 1.6,
      belowProfileScaleAcknowledged: true,
      featureViolations,
    };
    const preview = {
      ...samplePreview(preflight),
      fitPolicy: "auto" as const,
      appliedPolicy: "scale" as const,
      requestedScale: 3,
      appliedScale: 0.5,
      minimumSafeScale: 1.6,
      belowProfileScaleAcknowledged: true,
      featureViolations,
    };

    expect(isPrintExportWorkerResponse({
      type: "confirmation-required",
      jobId: 13,
      preflight,
      preview,
    })).toBe(true);
    expect(isPrintExportWorkerResponse({
      type: "confirmation-required",
      jobId: 13,
      preflight: {
        ...preflight,
        minimumSafeScale: preflight.appliedScale,
        belowProfileScaleAcknowledged: false,
        featureViolations: [],
      },
      preview: {
        ...preview,
        minimumSafeScale: preview.appliedScale,
        belowProfileScaleAcknowledged: false,
        featureViolations: [],
      },
    })).toBe(false);
  });

  it("preserves structured validation issues and normalizes unknown errors", () => {
    const validation = Object.assign(new Error("Invalid print plan."), {
      name: "PrintPlanValidationError",
      issues: ["City bound X exceeds build volume."],
    });

    expect(serializePrintExportError(validation)).toEqual({
      kind: "validation",
      name: "PrintPlanValidationError",
      message: "Invalid print plan.",
      issues: ["City bound X exceeds build volume."],
    });
    expect(serializePrintExportError("worker vanished")).toEqual({
      kind: "unexpected",
      name: "Error",
      message: "worker vanished",
      issues: [],
    });
  });

  it("adds code-aware viewer recovery to actual planner layout errors", () => {
    const unsafe = serializePrintExportError(actualPlannerFailure(
      0.5,
      [plannerDistrict("small", 5, 5)],
    ));
    expect(unsafe).toMatchObject({
      kind: "validation",
      issues: [{
        code: "unsafe-scale",
      }],
    });
    expect(serializedFailureText(unsafe)).toContain(
      'Raise the Target scale to the profile-safe value',
    );
    expect(serializedFailureText(unsafe)).toContain(
      '"Auto fit (recommended)"',
    );

    const city = serializePrintExportError(actualPlannerFailure(
      1,
      [
        plannerDistrict("a", 45, 30),
        plannerDistrict("b", 45, 30),
      ],
    ));
    expect(city).toMatchObject({
      kind: "validation",
      issues: [{ code: "city-does-not-fit" }],
    });
    expect(serializedFailureText(city)).toContain(
      '"Auto fit (recommended)"',
    );
    expect(serializedFailureText(city)).toContain('"Scale to one plate"');
    expect(serializedFailureText(city)).toContain(
      '"Tile complete districts (multi-plate)"',
    );
    expect(serializedFailureText(city)).not.toContain(
      "Split complete districts",
    );

    const district = serializePrintExportError(actualPlannerFailure(
      1,
      [plannerDistrict("oversized", 80, 50)],
    ));
    expect(district).toMatchObject({
      kind: "validation",
      issues: [{
        code: "district-does-not-fit",
        objectId: "oversized",
        required: {
          x: expect.any(Number),
          y: expect.any(Number),
          z: expect.any(Number),
        },
        available: {
          x: expect.any(Number),
          y: expect.any(Number),
          z: expect.any(Number),
        },
      }],
    });
    expect(serializedFailureText(district)).toContain(
      '"Auto fit (recommended)"',
    );
    expect(serializedFailureText(district)).toContain(
      "lower the Target scale",
    );
    expect(serializedFailureText(district)).toContain(
      "Whole-district Tile cannot split this oversized district.",
    );
    expect(serializedFailureText(district)).not.toMatch(
      /(?:choose|select|use|set).*Tile complete districts/iu,
    );
  });

  it("uses the visible Fit policy labels in recovery guidance", () => {
    const failedPlan = new Error(
      "Complete districts do not fit together on one plate at the minimum profile-safe scale 0.4; use fitPolicy 'tile'.",
    );

    const failure = serializePrintExportError(failedPlan);

    expect(failure.message).toContain('"Auto fit (recommended)"');
    expect(failure.message).toContain(
      '"Tile complete districts (multi-plate)"',
    );
    expect(failure.message).not.toContain("fitPolicy");
    expect(failure.message).not.toContain("'tile'");

    const legacyLabelFailure = serializePrintExportError(new Error(
      'Choose "Split complete districts (tiled multi-plate export)".',
    ));
    expect(legacyLabelFailure.message).toContain(
      '"Tile complete districts (multi-plate)"',
    );
    expect(legacyLabelFailure.message).not.toContain(
      "Split complete districts",
    );
  });

  it("validates fitted bundle preflight, preview, and ZIP responses", () => {
    const prepared = preparePrintPlateBundle({
      format: "3mf",
      model: DEMO_MODEL,
      profile: createSingleChannelProfile(),
      options: {
        scale: 3,
        fitPolicy: "scale",
        labelPolicy: "off",
        routePolicy: "off",
        includeLegend: false,
      },
    });
    const preflightResponse = {
      type: "preflight",
      jobId: 3,
      preflight: prepared.preflight,
      preview: prepared.preview,
    } as const;
    const resultResponse = {
      type: "bundle-result",
      jobId: 3,
      preflight: prepared.preflight,
      preview: prepared.preview,
      artifact: {
        format: "zip",
        mimeType: "application/zip",
        fileExtension: ".zip",
        bytes: new ArrayBuffer(8),
      },
      manifestBytes: new ArrayBuffer(8),
    } as const;

    expect(isPrintExportWorkerResponse(preflightResponse)).toBe(true);
    expect(isPrintExportWorkerResponse(resultResponse)).toBe(true);
    expect(
      isPrintExportWorkerResponse({
        ...resultResponse,
        artifact: {
          ...resultResponse.artifact,
          mimeType: "application/octet-stream",
        },
      }),
    ).toBe(false);
    expect(
      isPrintExportWorkerResponse({
        ...preflightResponse,
        preflight: {
          ...prepared.preflight,
          unplacedObjects: [{
            kind: "district",
            id: "district:missing",
            label: "Missing",
            reason: "no-space",
          }],
        },
        preview: {
          ...prepared.preview,
          unplacedObjects: [{ id: "district:missing" }],
        },
      }),
    ).toBe(false);
    expect(
      isPrintExportWorkerResponse({
        ...preflightResponse,
        preflight: {
          ...prepared.preflight,
          plateCount: prepared.preflight.plateCount + 1,
        },
      }),
    ).toBe(false);
    expect(
      isPrintExportWorkerResponse({
        ...preflightResponse,
        preflight: {
          ...prepared.preflight,
          labels: {
            ...prepared.preflight.labels,
            printedBuildings:
              prepared.preflight.labels.printedBuildings + 1,
          },
        },
      }),
    ).toBe(false);
    expect(
      isPrintExportWorkerResponse({
        ...preflightResponse,
        preview: {
          ...prepared.preview,
          plates: [],
        },
      }),
    ).toBe(false);
    expect(
      isPrintExportWorkerResponse({
        ...preflightResponse,
        preview: {
          ...prepared.preview,
          requestedScale: prepared.preview.requestedScale + 1,
        },
      }),
    ).toBe(false);
    expect(
      isPrintExportWorkerResponse({
        ...preflightResponse,
        preview: {
          ...prepared.preview,
          appliedPolicy:
            prepared.preview.appliedPolicy === "tile" ? "scale" : "tile",
        },
      }),
    ).toBe(false);
    expect(
      isPrintExportWorkerResponse({
        ...preflightResponse,
        preview: {
          ...prepared.preview,
          printableBounds: {
            ...prepared.preview.printableBounds,
            maximum: {
              ...prepared.preview.printableBounds.maximum,
              x: prepared.preview.printableBounds.maximum.x + 1,
            },
            size: {
              ...prepared.preview.printableBounds.size,
              x: prepared.preview.printableBounds.size.x + 1,
            },
          },
        },
      }),
    ).toBe(false);
    expect(
      isPrintExportWorkerResponse({
        ...preflightResponse,
        preview: {
          ...prepared.preview,
          plates: prepared.preview.plates.map((plate, index) =>
            index === 0
              ? {
                  ...plate,
                  bounds: {
                    ...plate.bounds,
                    minimum: {
                      ...plate.bounds.minimum,
                      x: plate.bounds.minimum.x + 1,
                    },
                    maximum: {
                      ...plate.bounds.maximum,
                      x: plate.bounds.maximum.x + 1,
                    },
                  },
                }
              : plate,
          ),
        },
      }),
    ).toBe(false);
    expect(
      isPrintExportWorkerResponse({
        ...preflightResponse,
        preview: {
          ...prepared.preview,
          plates: prepared.preview.plates.map((plate, index) =>
            index === 0
              ? { ...plate, id: `${plate.id}-different` }
              : plate,
          ),
        },
      }),
    ).toBe(false);
    expect(
      isPrintExportWorkerResponse({
        ...preflightResponse,
        preflight: {
          ...prepared.preflight,
          plates: prepared.preflight.plates.map((plate, index) =>
            index === 0
              ? {
                  ...plate,
                  dimensions: {
                    ...plate.dimensions,
                    width: plate.dimensions.width + 1,
                  },
                }
              : plate,
          ),
        },
      }),
    ).toBe(false);
    expect(
      isPrintExportWorkerResponse({
        ...preflightResponse,
        preflight: {
          ...prepared.preflight,
          plates: prepared.preflight.plates.map((plate, index) =>
            index === 0
              ? { ...plate, channelIds: ["unexpected-channel"] }
              : plate,
          ),
        },
      }),
    ).toBe(false);
    expect(
      isPrintExportWorkerResponse({
        ...preflightResponse,
        preflight: {
          ...prepared.preflight,
          routeOmissions: [{}],
        },
      }),
    ).toBe(false);
    expect(
      isPrintExportWorkerResponse({
        ...preflightResponse,
        preflight: {
          ...prepared.preflight,
          unplacedObjects: [
            {
              kind: "district",
              id: "district:missing",
              label: "Missing",
              reason: "not-a-reason",
            },
          ],
        },
      }),
    ).toBe(false);
    expect(
      isPrintExportWorkerResponse({
        ...preflightResponse,
        preflight: {
          ...prepared.preflight,
          warnings: Array.from(
            { length: 1_001 },
            (_, index) => `Warning ${index}`,
          ),
        },
      }),
    ).toBe(false);
  });

  it("validates complete, internally consistent calibration results", () => {
    const generated = generateCalibrationPrintExport({
      profile: createSingleChannelProfile(),
      format: "3mf",
    });
    const preflight = generated.preflight;
    const response = {
      type: "calibration-result",
      jobId: 2,
      preflight,
      artifact: {
        format: "3mf",
        mimeType: "model/3mf",
        fileExtension: ".3mf",
        bytes: new ArrayBuffer(8),
      },
      manifestBytes: new ArrayBuffer(8),
    } as const;

    expect(isPrintExportWorkerResponse(response)).toBe(true);
    expect(
      preflight.measurements.some(
        ({ reference }) => reference === "rail-defined-groove",
      ),
    ).toBe(true);
    expect(preflight.manifest.couponCount).toBeGreaterThan(0);
    expect(
      preflight.measurements.find(
        ({ id }) => id === "build-margin-y",
      )?.axis,
    ).toEqual({
      coordinateSpace: "city",
      cityAxis: "y",
      printAxis: "z",
      meaning: "height",
    });
    expect(
      isPrintExportWorkerResponse({
        ...response,
        preflight: {
          ...preflight,
          measurements: preflight.measurements.map((measurement) => {
            if (measurement.id !== "build-margin-x") return measurement;
            const { axis: _axis, ...withoutOptionalAxis } = measurement;
            return withoutOptionalAxis;
          }),
        },
      }),
    ).toBe(true);
    expect(
      isPrintExportWorkerResponse({
        ...response,
        preflight: {
          ...preflight,
          triangleCount: 0,
        },
      }),
    ).toBe(false);
    expect(
      isPrintExportWorkerResponse({
        ...response,
        preflight: {
          ...preflight,
          measurements: preflight.measurements.map((measurement, index) =>
            index === 1
              ? { ...measurement, id: preflight.measurements[0]!.id }
              : measurement,
          ),
        },
      }),
    ).toBe(false);
    expect(
      isPrintExportWorkerResponse({
        ...response,
        preflight: {
          ...preflight,
          manifest: {
            ...preflight.manifest,
            measurementCount:
              preflight.manifest.measurementCount - 1,
          },
        },
      }),
    ).toBe(false);
    expect(
      isPrintExportWorkerResponse({
        ...response,
        preflight: {
          ...preflight,
          manifest: {
            ...preflight.manifest,
            channelMarkerCount: preflight.channelCount + 1,
          },
        },
      }),
    ).toBe(false);
    expect(
      isPrintExportWorkerResponse({
        ...response,
        preflight: {
          ...preflight,
          manifest: {
            ...preflight.manifest,
            couponCount: 0,
          },
        },
      }),
    ).toBe(false);
    expect(
      isPrintExportWorkerResponse({
        ...response,
        preflight: {
          ...preflight,
          manifest: {
            ...preflight.manifest,
            couponCount: preflight.manifest.couponCount + 1,
          },
        },
      }),
    ).toBe(false);
    expect(
      isPrintExportWorkerResponse({
        ...response,
        preflight: {
          ...preflight,
          measurements: preflight.measurements.map((measurement) =>
            measurement.id === "nozzle-diameter"
              ? { ...measurement, couponId: 42 }
              : measurement,
          ),
        },
      }),
    ).toBe(false);
    expect(
      isPrintExportWorkerResponse({
        ...response,
        preflight: {
          ...preflight,
          measurements: preflight.measurements.map((measurement) =>
            measurement.id === "build-margin-y"
              ? {
                  ...measurement,
                  axis: {
                    coordinateSpace: "city",
                    cityAxis: "y",
                    printAxis: "y",
                    meaning: "height",
                  },
                }
              : measurement,
          ),
        },
      }),
    ).toBe(false);
    expect(
      isPrintExportWorkerResponse({
        ...response,
        preflight: {
          ...preflight,
          measurements: preflight.measurements.map((measurement) =>
            measurement.id === "minimum-gap"
              ? {
                  ...measurement,
                  axis: {
                    coordinateSpace: "city",
                    cityAxis: "x",
                    printAxis: "x",
                    meaning: "width",
                  },
                }
              : measurement,
          ),
        },
      }),
    ).toBe(false);
  });
});
