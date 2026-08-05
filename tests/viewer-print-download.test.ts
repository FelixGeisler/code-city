import { describe, expect, it } from "vitest";

import {
  PrintDownloadManager,
  printBundleFileNames,
  printCalibrationFileNames,
  printExportFileNames,
  sanitizePrintFileStem,
  tryPublishPrintBundleDownload,
  tryPublishPrintDownloads,
  type ObjectUrlApi,
} from "../apps/viewer/src/print-download.js";
import type {
  PrintExportTransferArtifact,
} from "../apps/viewer/src/print-export-protocol.js";

function artifact(
  format: "3mf" | "stl",
  bytes: ArrayBuffer = new ArrayBuffer(1),
): PrintExportTransferArtifact {
  return format === "3mf"
    ? {
        format,
        mimeType: "model/3mf",
        fileExtension: ".3mf",
        bytes,
      }
    : {
        format,
        mimeType: "model/stl",
        fileExtension: ".stl",
        bytes,
      };
}

class FakeObjectUrls implements ObjectUrlApi {
  public readonly blobs: Blob[] = [];
  public readonly revoked: string[] = [];
  public failAt: number | undefined;

  public readonly createObjectURL = (blob: Blob): string => {
    if (this.failAt === this.blobs.length) {
      throw new Error("Object URL creation failed.");
    }
    this.blobs.push(blob);
    return `blob:test-${this.blobs.length}`;
  };

  public readonly revokeObjectURL = (url: string): void => {
    this.revoked.push(url);
  };
}

describe("viewer print downloads", () => {
  it("sanitizes traversal, platform-reserved, control, and empty names", () => {
    expect(sanitizePrintFileStem("../FLOW\\Hub:*?")).toBe("FLOW-Hub");
    expect(sanitizePrintFileStem("CON")).toBe("code-city-CON");
    expect(sanitizePrintFileStem(" \u0000 .. ")).toBe("code-city");
    expect(sanitizePrintFileStem("Köln 城市")).toBe("Köln-城市");
    expect(sanitizePrintFileStem("x".repeat(120))).toHaveLength(96);
  });

  it("builds stable format-neutral artifact and companion names", () => {
    expect(
      printExportFileNames({
        title: "FLOW / Hub",
        version: "test:1",
      }),
    ).toEqual({
      artifact: "FLOW-Hub-test-1.3mf",
      manifest: "FLOW-Hub-test-1.print-manifest.json",
      legend: "FLOW-Hub-test-1.legend.json",
    });
    expect(printExportFileNames({}, ".stl")).toEqual({
      artifact: "code-city.stl",
      manifest: "code-city.print-manifest.json",
      legend: "code-city.legend.json",
    });
    expect(printCalibrationFileNames("prusa-xl-t1-t2")).toEqual({
      artifact: "prusa-xl-t1-t2.calibration.3mf",
      manifest: "prusa-xl-t1-t2.calibration.json",
    });
    expect(
      printCalibrationFileNames("prusa-xl-t1-t2", ".stl"),
    ).toEqual({
      artifact: "prusa-xl-t1-t2.calibration.stl",
      manifest: "prusa-xl-t1-t2.calibration.json",
    });
    expect(
      printBundleFileNames({
        title: "FLOW / Hub",
        version: "test:1",
      }),
    ).toEqual({
      artifact: "FLOW-Hub-test-1-print-bundle.zip",
    });
  });

  it("publishes one ZIP because its manifest and legend are bundled", async () => {
    const urls = new FakeObjectUrls();
    const manager = new PrintDownloadManager(urls);
    const bytes = Uint8Array.from([80, 75, 3, 4]).buffer;

    const bundle = manager.replaceBundle(
      { title: "Code City", version: "Demo" },
      {
        artifact: {
          format: "zip",
          mimeType: "application/zip",
          fileExtension: ".zip",
          bytes,
        },
      },
    );

    expect(bundle).toMatchObject({
      artifact: {
        fileName: "Code-City-Demo-print-bundle.zip",
        url: "blob:test-1",
      },
    });
    expect(urls.blobs).toHaveLength(1);
    expect(bundle.artifact.blob.type).toBe("application/zip");
    expect(
      new Uint8Array(await bundle.artifact.blob.arrayBuffer()),
    ).toEqual(Uint8Array.from([80, 75, 3, 4]));

    manager.clear();
    expect(urls.revoked).toEqual(["blob:test-1"]);
  });

  it("publishes deterministic calibration files with precise MIME types", () => {
    const urls = new FakeObjectUrls();
    const manager = new PrintDownloadManager(urls);
    const calibration = manager.replaceCalibration(
      "Custom / Profile",
      {
        artifact: artifact(
          "stl",
          Uint8Array.from([1, 2]).buffer,
        ),
        manifestBytes: Uint8Array.from([3, 4]).buffer,
      },
    );

    expect(calibration).toMatchObject({
      artifact: {
        fileName: "Custom-Profile.calibration.stl",
        url: "blob:test-1",
      },
      manifest: {
        fileName: "Custom-Profile.calibration.json",
        url: "blob:test-2",
      },
    });
    expect(calibration.artifact.blob.type).toBe("model/stl");
    expect(calibration.manifest.blob.type).toBe("application/json");
    manager.clear();
    expect(urls.revoked).toEqual(["blob:test-1", "blob:test-2"]);
  });

  it("replaces and revokes every active object URL", async () => {
    const urls = new FakeObjectUrls();
    const manager = new PrintDownloadManager(urls);
    const first = manager.replace(
      { title: "Code City", version: "Demo" },
      {
        artifact: artifact(
          "3mf",
          Uint8Array.from([1, 2, 3]).buffer,
        ),
        manifestBytes: Uint8Array.from([123, 125]).buffer,
        legendBytes: Uint8Array.from([4, 5]).buffer,
      },
    );

    expect(first).toMatchObject({
      artifact: {
        fileName: "Code-City-Demo.3mf",
        url: "blob:test-1",
      },
      manifest: {
        fileName: "Code-City-Demo.print-manifest.json",
        url: "blob:test-2",
      },
      legend: {
        fileName: "Code-City-Demo.legend.json",
        url: "blob:test-3",
      },
    });
    expect(first.artifact.blob.type).toBe("model/3mf");
    expect(first.manifest?.blob.type).toBe("application/json");
    expect(first.legend?.blob.type).toBe("application/json");
    expect(
      new Uint8Array(await first.artifact.blob.arrayBuffer()),
    ).toEqual(Uint8Array.from([1, 2, 3]));

    const second = manager.replace(
      { title: "Next" },
      { artifact: artifact("stl", new ArrayBuffer(0)) },
    );
    expect(urls.revoked).toEqual([
      "blob:test-1",
      "blob:test-2",
      "blob:test-3",
    ]);
    expect(second.legend).toBeUndefined();

    manager.clear();
    manager.dispose();
    expect(urls.revoked).toEqual([
      "blob:test-1",
      "blob:test-2",
      "blob:test-3",
      "blob:test-4",
    ]);
  });

  it("revokes partially-created URLs when replacement fails", () => {
    const urls = new FakeObjectUrls();
    urls.failAt = 2;
    const manager = new PrintDownloadManager(urls);

    expect(() =>
      manager.replace(
        { title: "Code City" },
        {
          artifact: artifact("3mf"),
          manifestBytes: new ArrayBuffer(1),
          legendBytes: new ArrayBuffer(1),
        },
      ),
    ).toThrow("Object URL creation failed.");
    expect(urls.revoked).toEqual(["blob:test-1", "blob:test-2"]);
  });

  it("turns local publication failures into recoverable UI data", () => {
    const urls = new FakeObjectUrls();
    urls.failAt = 0;
    const manager = new PrintDownloadManager(urls);

    expect(
      tryPublishPrintDownloads(
        manager,
        { title: "Code City" },
        { artifact: artifact("3mf") },
      ),
    ).toEqual({
      ok: false,
      message:
        "Local downloads could not be prepared: Object URL creation failed.",
    });
    expect(urls.revoked).toEqual([]);

    expect(
      tryPublishPrintBundleDownload(
        manager,
        { title: "Code City" },
        {
          artifact: {
            format: "zip",
            mimeType: "application/zip",
            fileExtension: ".zip",
            bytes: new ArrayBuffer(1),
          },
        },
      ),
    ).toEqual({
      ok: false,
      message:
        "Local downloads could not be prepared: Object URL creation failed.",
    });
  });
});
