import { describe, expect, it } from "vitest";

import {
  LatestPrintProfileRead,
  printCalibrationSubmitDisabled,
  printExportOptionsFromControls,
  printExportSubmitDisabled,
  shouldRetainPrintLayoutOnDialogClose,
} from "../apps/viewer/src/print-export-dialog.js";

describe("viewer print export dialog state", () => {
  it("maps Auto as the normal fit policy and preserves its tile plate cap", () => {
    const common = {
      scale: 3,
      labelPolicy: "off" as const,
      routePolicy: "off" as const,
      includeLegend: false,
      fitPolicy: "auto" as const,
      maximumPlateCount: 4,
      profileKind: "prusa-xl" as const,
      format: "3mf" as const,
      prusaToolCount: 5,
      wipeTowerReserveDepth: 72,
    };

    expect(printExportOptionsFromControls(common)).toEqual({
      scale: 3,
      labelPolicy: "off",
      routePolicy: "off",
      includeLegend: false,
      fitPolicy: "auto",
      maximumPlateCount: 4,
      wipeTowerReserveDepth: 72,
    });
    expect(printExportOptionsFromControls({
      ...common,
      fitPolicy: "tile",
    })).toMatchObject({
      fitPolicy: "tile",
      maximumPlateCount: 4,
    });
    expect(printExportOptionsFromControls({
      ...common,
      fitPolicy: "error",
    })).not.toHaveProperty("maximumPlateCount");
    expect(printExportOptionsFromControls(common)).not.toHaveProperty(
      "acknowledgeBelowProfileScale",
    );
  });

  it("reserves a wipe-tower strip only for multi-tool Prusa XL 3MF exports", () => {
    const common = {
      scale: 3,
      labelPolicy: "off" as const,
      routePolicy: "off" as const,
      includeLegend: false,
      fitPolicy: "auto" as const,
      maximumPlateCount: 4,
      profileKind: "prusa-xl" as const,
      format: "3mf" as const,
      prusaToolCount: 2,
      wipeTowerReserveDepth: 72,
    };

    expect(printExportOptionsFromControls(common)).toMatchObject({
      wipeTowerReserveDepth: 72,
    });
    expect(printExportOptionsFromControls({
      ...common,
      wipeTowerReserveDepth: 0,
    })).toMatchObject({ wipeTowerReserveDepth: 0 });
    expect(printExportOptionsFromControls({
      ...common,
      profileKind: "generic",
    })).toMatchObject({ wipeTowerReserveDepth: 0 });
    expect(printExportOptionsFromControls({
      ...common,
      format: "stl",
    })).toMatchObject({ wipeTowerReserveDepth: 0 });
    expect(printExportOptionsFromControls({
      ...common,
      prusaToolCount: 1,
    })).toMatchObject({ wipeTowerReserveDepth: 0 });
    expect(() => printExportOptionsFromControls({
      ...common,
      wipeTowerReserveDepth: -1,
    })).toThrow(/wipe tower strip/iu);
    expect(() => printExportOptionsFromControls({
      ...common,
      wipeTowerReserveDepth: 360,
    })).toThrow(/wipe tower strip/iu);
    expect(() => printExportOptionsFromControls({
      ...common,
      wipeTowerReserveDepth: Number.NaN,
    })).toThrow(/wipe tower strip/iu);
    expect(() => printExportOptionsFromControls({
      ...common,
      wipeTowerReserveDepth: Number.POSITIVE_INFINITY,
    })).toThrow(/wipe tower strip/iu);
  });

  it("keeps calibration available when only wipe-tower input is invalid", () => {
    const common = {
      busy: false,
      formatSupported: true,
      profileKind: "prusa-xl" as const,
      hasCustomProfile: true,
      prusaToolCount: 2,
    };

    expect(printCalibrationSubmitDisabled(common)).toBe(false);
    expect(printExportSubmitDisabled({
      ...common,
      fitPolicyValid: true,
      maximumPlateCountValid: true,
      wipeTowerReserveDepthValid: false,
    })).toBe(true);
  });

  it("invalidates stale asynchronous custom-profile reads", () => {
    const reads = new LatestPrintProfileRead();
    const first = reads.begin();
    expect(reads.isCurrent(first)).toBe(true);

    reads.invalidate();
    expect(reads.isCurrent(first)).toBe(false);

    const second = reads.begin();
    expect(reads.isCurrent(second)).toBe(true);
    expect(reads.isCurrent(first)).toBe(false);
  });

  it("never enables export while busy or required profile data is absent", () => {
    expect(
      printExportSubmitDisabled({
        enabled: false,
        busy: false,
        formatSupported: true,
        profileKind: "generic",
        hasCustomProfile: true,
        prusaToolCount: 5,
        fitPolicyValid: true,
        maximumPlateCountValid: true,
      }),
    ).toBe(true);
    expect(
      printExportSubmitDisabled({
        busy: true,
        formatSupported: true,
        profileKind: "generic",
        hasCustomProfile: true,
        prusaToolCount: 5,
        fitPolicyValid: true,
        maximumPlateCountValid: true,
      }),
    ).toBe(true);
    expect(
      printExportSubmitDisabled({
        busy: false,
        formatSupported: true,
        profileKind: "custom",
        hasCustomProfile: false,
        prusaToolCount: 5,
        fitPolicyValid: true,
        maximumPlateCountValid: true,
      }),
    ).toBe(true);
    expect(
      printExportSubmitDisabled({
        busy: false,
        formatSupported: true,
        profileKind: "prusa-xl",
        hasCustomProfile: true,
        prusaToolCount: 0,
        fitPolicyValid: true,
        maximumPlateCountValid: true,
      }),
    ).toBe(true);
    expect(
      printExportSubmitDisabled({
        busy: false,
        formatSupported: true,
        profileKind: "generic",
        hasCustomProfile: false,
        prusaToolCount: 0,
        fitPolicyValid: true,
        maximumPlateCountValid: true,
      }),
    ).toBe(false);
    expect(
      printExportSubmitDisabled({
        busy: false,
        formatSupported: false,
        profileKind: "generic",
        hasCustomProfile: true,
        prusaToolCount: 5,
        fitPolicyValid: true,
        maximumPlateCountValid: true,
      }),
    ).toBe(true);
    expect(
      printExportSubmitDisabled({
        busy: false,
        formatSupported: true,
        profileKind: "generic",
        hasCustomProfile: true,
        prusaToolCount: 1,
        fitPolicyValid: false,
        maximumPlateCountValid: true,
      }),
    ).toBe(true);
    expect(
      printExportSubmitDisabled({
        busy: false,
        formatSupported: true,
        profileKind: "generic",
        hasCustomProfile: true,
        prusaToolCount: 1,
        fitPolicyValid: true,
        maximumPlateCountValid: false,
      }),
    ).toBe(true);
    expect(
      printExportSubmitDisabled({
        busy: false,
        formatSupported: true,
        profileKind: "prusa-xl",
        hasCustomProfile: true,
        prusaToolCount: 2,
        fitPolicyValid: true,
        maximumPlateCountValid: true,
        wipeTowerReserveDepthValid: false,
      }),
    ).toBe(true);
  });

  it("retains every completed printable preview when the dialog closes", () => {
    expect(
      shouldRetainPrintLayoutOnDialogClose("bundle-ready"),
    ).toBe(true);
    expect(shouldRetainPrintLayoutOnDialogClose("busy")).toBe(false);
    expect(shouldRetainPrintLayoutOnDialogClose("failed")).toBe(false);
    expect(shouldRetainPrintLayoutOnDialogClose("ready")).toBe(true);
    expect(shouldRetainPrintLayoutOnDialogClose("idle")).toBe(false);
  });
});
