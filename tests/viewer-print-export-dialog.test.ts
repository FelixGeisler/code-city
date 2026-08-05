import { describe, expect, it } from "vitest";

import {
  LatestPrintProfileRead,
  printExportOptionsFromControls,
  printExportSubmitDisabled,
  shouldRetainPrintLayoutOnDialogClose,
} from "../apps/viewer/src/print-export-dialog.js";

describe("viewer print export dialog state", () => {
  it("maps the unchecked expert control safely and preserves explicit acknowledgement", () => {
    const common = {
      scale: 0.5,
      labelPolicy: "off" as const,
      routePolicy: "off" as const,
      includeLegend: false,
      fitPolicy: "error" as const,
    };

    expect(printExportOptionsFromControls({
      ...common,
      acknowledgeBelowProfileScale: false,
    })).toEqual({
      ...common,
      acknowledgeBelowProfileScale: false,
    });
    expect(printExportOptionsFromControls({
      ...common,
      acknowledgeBelowProfileScale: true,
    })).toEqual({
      ...common,
      acknowledgeBelowProfileScale: true,
    });
    expect(printExportOptionsFromControls({
      ...common,
      fitPolicy: "tile",
      maximumPlateCount: 4,
      acknowledgeBelowProfileScale: true,
    })).toMatchObject({
      fitPolicy: "tile",
      maximumPlateCount: 4,
      acknowledgeBelowProfileScale: true,
    });
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
