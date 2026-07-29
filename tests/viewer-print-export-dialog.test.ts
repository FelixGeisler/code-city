import { describe, expect, it } from "vitest";

import {
  LatestPrintProfileRead,
  printExportSubmitDisabled,
} from "../apps/viewer/src/print-export-dialog.js";

describe("viewer print export dialog state", () => {
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
        busy: true,
        formatSupported: true,
        profileKind: "generic",
        hasCustomProfile: true,
        prusaToolCount: 5,
      }),
    ).toBe(true);
    expect(
      printExportSubmitDisabled({
        busy: false,
        formatSupported: true,
        profileKind: "custom",
        hasCustomProfile: false,
        prusaToolCount: 5,
      }),
    ).toBe(true);
    expect(
      printExportSubmitDisabled({
        busy: false,
        formatSupported: true,
        profileKind: "prusa-xl",
        hasCustomProfile: true,
        prusaToolCount: 0,
      }),
    ).toBe(true);
    expect(
      printExportSubmitDisabled({
        busy: false,
        formatSupported: true,
        profileKind: "generic",
        hasCustomProfile: false,
        prusaToolCount: 0,
      }),
    ).toBe(false);
    expect(
      printExportSubmitDisabled({
        busy: false,
        formatSupported: false,
        profileKind: "generic",
        hasCustomProfile: true,
        prusaToolCount: 5,
      }),
    ).toBe(true);
  });
});
