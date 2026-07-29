import { describe, expect, it } from "vitest";

import {
  PrintDownloadManager,
  printExportFileNames,
  sanitizePrintFileStem,
  tryPublishPrintDownloads,
  type ObjectUrlApi,
} from "../apps/viewer/src/print-download.js";

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

  it("builds stable 3MF and companion legend names", () => {
    expect(
      printExportFileNames({
        title: "FLOW / Hub",
        version: "test:1",
      }),
    ).toEqual({
      threeMf: "FLOW-Hub-test-1.3mf",
      legend: "FLOW-Hub-test-1.legend.json",
    });
    expect(printExportFileNames({})).toEqual({
      threeMf: "code-city.3mf",
      legend: "code-city.legend.json",
    });
  });

  it("replaces and revokes every active object URL", async () => {
    const urls = new FakeObjectUrls();
    const manager = new PrintDownloadManager(urls);
    const first = manager.replace(
      { title: "Code City", version: "Demo" },
      {
        threeMfBytes: Uint8Array.from([1, 2, 3]).buffer,
        legendBytes: Uint8Array.from([4, 5]).buffer,
      },
    );

    expect(first).toMatchObject({
      threeMf: {
        fileName: "Code-City-Demo.3mf",
        url: "blob:test-1",
      },
      legend: {
        fileName: "Code-City-Demo.legend.json",
        url: "blob:test-2",
      },
    });
    expect(first.threeMf.blob.type).toBe(
      "application/vnd.ms-package.3dmanufacturing-3dmodel+xml",
    );
    expect(first.legend?.blob.type).toBe("application/json");
    expect(
      new Uint8Array(await first.threeMf.blob.arrayBuffer()),
    ).toEqual(Uint8Array.from([1, 2, 3]));

    const second = manager.replace(
      { title: "Next" },
      { threeMfBytes: new ArrayBuffer(0) },
    );
    expect(urls.revoked).toEqual(["blob:test-1", "blob:test-2"]);
    expect(second.legend).toBeUndefined();

    manager.clear();
    manager.dispose();
    expect(urls.revoked).toEqual([
      "blob:test-1",
      "blob:test-2",
      "blob:test-3",
    ]);
  });

  it("revokes partially-created URLs when replacement fails", () => {
    const urls = new FakeObjectUrls();
    urls.failAt = 1;
    const manager = new PrintDownloadManager(urls);

    expect(() =>
      manager.replace(
        { title: "Code City" },
        {
          threeMfBytes: new ArrayBuffer(1),
          legendBytes: new ArrayBuffer(1),
        },
      ),
    ).toThrow("Object URL creation failed.");
    expect(urls.revoked).toEqual(["blob:test-1"]);
  });

  it("turns local publication failures into recoverable UI data", () => {
    const urls = new FakeObjectUrls();
    urls.failAt = 0;
    const manager = new PrintDownloadManager(urls);

    expect(
      tryPublishPrintDownloads(
        manager,
        { title: "Code City" },
        { threeMfBytes: new ArrayBuffer(1) },
      ),
    ).toEqual({
      ok: false,
      message:
        "Local downloads could not be prepared: Object URL creation failed.",
    });
    expect(urls.revoked).toEqual([]);
  });
});
