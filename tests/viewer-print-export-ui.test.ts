import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const viewerRoot = path.resolve("apps/viewer");

describe("viewer print export UI", () => {
  it("exposes an accessible local-only export dialog and every v1 option", async () => {
    const html = await fs.readFile(
      path.join(viewerRoot, "index.html"),
      "utf8",
    );

    expect(html).toContain('id="print-export-open"');
    expect(html).toMatch(
      /<dialog[\s\S]*id="print-export-dialog"[\s\S]*aria-labelledby="print-export-title"[\s\S]*aria-describedby="print-export-privacy"/u,
    );
    const privacyStatement = /Nothing is\r?\n\s+uploaded\./u;
    expect("Nothing is\n uploaded.").toMatch(privacyStatement);
    expect("Nothing is\r\n uploaded.").toMatch(privacyStatement);
    expect(html).toMatch(privacyStatement);
    expect(html).toContain('<option value="generic">');
    expect(html).toContain('<option value="prusa-xl">');
    expect(html).toContain('<option value="custom">');
    expect(html).toContain('id="print-prusa-tools"');
    expect(html).toContain('id="print-custom-profile"');
    expect(html).toContain('id="print-format"');
    expect(html).toContain('<option value="3mf">3MF</option>');
    expect(html).toContain('<option value="stl">STL</option>');
    expect(html).toContain('id="print-scale"');
    expect(html).toContain('id="print-labels"');
    expect(html).toContain('id="print-routes"');
    expect(html).toContain('id="print-legend-download-enabled"');
    expect(html).toContain('id="print-export-cancel"');
    expect(html).toContain('id="print-calibration-submit"');
    expect(html).toContain('id="print-export-preflight"');
    expect(html).toContain('id="print-export-triangles"');
    expect(html).toContain('id="print-export-download"');
    expect(html).toContain('id="print-export-legend-download"');
    expect(html).toContain('id="print-calibration-download"');
    expect(html).toContain(
      'id="print-calibration-manifest-download"',
    );
    expect(html).toMatch(
      /Calibration uses only the selected printer profile and never\r?\n\s+includes repository content\./u,
    );
    expect(html).toMatch(
      /id="print-scale"[\s\S]*min="0\.01"[\s\S]*step="0\.01"[\s\S]*value="3"[\s\S]*required/u,
    );
    expect(html).toMatch(
      /id="print-export-progress-meter"[\s\S]*aria-labelledby="print-export-status"/u,
    );
    expect(html).not.toContain("Export 3MF");
  });

  it("bundles a module worker and keeps downloads in local Blob URLs", async () => {
    const source = await fs.readFile(
      path.join(viewerRoot, "src/print-export-dialog.ts"),
      "utf8",
    );

    expect(source).toContain(
      'new Worker(new URL("./print-export-worker.ts", import.meta.url)',
    );
    expect(source).toContain("new PrintDownloadManager()");
    expect(source).toContain("tryPublishPrintDownloads(");
    expect(source).toContain("tryPublishCalibrationDownloads(");
    expect(source).toContain(
      "controller.startCalibration({ profile, format })",
    );
    expect(source).toContain(
      "profile.supportedFormats.includes(format)",
    );
    expect(source).toContain("preflight.manifest.couponCount");
    expect(source).toContain('"printable coupons"');
    expect(source).not.toContain(
      'submitButton.addEventListener("click"',
    );
    expect(source).not.toMatch(/\bfetch\s*\(/u);
    expect(source).not.toMatch(/XMLHttpRequest/u);
  });
});
