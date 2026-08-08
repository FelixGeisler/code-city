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
    expect(html).toContain('id="print-wipe-tower-wrap"');
    expect(html).toContain('id="print-wipe-tower-strip"');
    expect(html).toContain("Wipe tower strip (mm)");
    expect(html).toMatch(
      /id="print-wipe-tower-strip"[\s\S]*min="0"[\s\S]*max="359\.9"[\s\S]*step="0\.1"[\s\S]*value="72"[\s\S]*aria-describedby="print-wipe-tower-help"[\s\S]*required/u,
    );
    expect(html).toMatch(
      /id="print-wipe-tower-help"[\s\S]*Reserves city depth for an empty strip along the rear of the[\s\S]*PrusaSlicer centers imported geometry[\s\S]*flush to the front edge[\s\S]*do not run Arrange[\s\S]*72 mm default[\s\S]*Use 0 if[\s\S]*sliced preview is wider/u,
    );
    expect(html).toContain('id="print-custom-profile"');
    expect(html).toContain('id="print-format"');
    expect(html).toContain('<option value="3mf">3MF</option>');
    expect(html).toContain('<option value="stl">STL</option>');
    expect(html).toContain('id="print-scale"');
    expect(html).toContain('id="print-labels"');
    expect(html).toContain('id="print-routes"');
    expect(html).toMatch(
      /<select id="print-fit">\s*<option value="auto">Auto fit \(recommended\)<\/option>/u,
    );
    expect(html).toMatch(
      /<option value="tile">\s+Tile complete districts \(multi-plate\)\s+<\/option>/u,
    );
    expect(html).toContain('id="print-legend-download-enabled"');
    expect(html).not.toContain(
      'id="print-below-profile-scale-acknowledgement"',
    );
    expect(html).not.toContain("Expert: allow scaling below");
    expect(html).toContain("Target scale (maximum)");
    expect(html).toContain("print-fidelity");
    expect(html).toContain('id="print-export-compact-confirmation"');
    expect(html).toContain('id="print-export-compact-confirm"');
    expect(html).toContain("before a file is created");
    expect(html).toContain('id="visualization-mode"');
    expect(html).toContain(
      '<option value="complexity">Complexity risk</option>',
    );
    expect(html).not.toContain('<option value="print">');
    expect(html).toContain('id="building-metric-explanation"');
    expect(html).toContain('id="print-export-cancel"');
    expect(html).toContain('id="print-calibration-submit"');
    expect(html).toContain('id="print-export-preflight"');
    expect(html).toContain('id="print-export-triangles"');
    expect(html).toContain('id="print-export-download"');
    expect(html).toContain('id="print-export-manifest-download"');
    expect(html).toContain('id="print-export-legend-download"');
    expect(html).toContain('id="print-export-fidelity-wrap"');
    expect(html).toContain('id="print-export-fidelity-summary"');
    expect(html).toContain('id="print-export-fidelity-violations"');
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
    expect(html).toMatch(
      /id="print-plate-toolbar"[\s\S]*aria-label="Canvas layout"[\s\S]*hidden/u,
    );
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
    expect(source).toContain("artifactDownload.hidden = true");
    expect(source).toContain("printManifestDownload.hidden = true");
    expect(source).not.toContain("belowProfileScaleAcknowledgement");
    expect(source).toContain("controller.confirmCompactFit()");
    expect(source).toContain(
      'wipeTowerReserveDepthInput.addEventListener("input", invalidateOutput)',
    );
    expect(source).toContain(
      "wipeTowerReserveDepthInput.valueAsNumber",
    );
    expect(source).toContain(
      "`${millimeters(violation.resultingValue)} mm resulting",
    );
    expect(source).toContain(
      "printManifestDownload.download = available.manifest.fileName",
    );
    expect(
      source.match(/artifactDownload\.hidden = false/gu)?.length,
    ).toBe(2);
    expect(source).toContain(
      "withPrintLayoutPreviewReadiness(preview, readiness)",
    );
    expect(source).not.toContain(
      'submitButton.addEventListener("click"',
    );
    expect(source).not.toMatch(/\bfetch\s*\(/u);
    expect(source).not.toMatch(/XMLHttpRequest/u);
  });

  it("keeps the print-plate toolbar compact and touch accessible", async () => {
    const css = await fs.readFile(
      path.join(viewerRoot, "src/styles.css"),
      "utf8",
    );

    expect(css).toMatch(
      /\.print-plate-mode button,\s*\.print-plate-toolbar select\s*\{[\s\S]*min-height:\s*36px/u,
    );
    expect(css).toMatch(
      /@media \(max-width: 720px\)[\s\S]*\.print-plate-toolbar\s*\{[\s\S]*width:\s*calc\(100% - 24px\)[\s\S]*max-width:\s*none[\s\S]*flex-wrap:\s*wrap/u,
    );
    expect(css).toMatch(
      /\.print-plate-toolbar select\s*\{[\s\S]*min-width:\s*0;[\s\S]*max-width:\s*100%;/u,
    );
    expect(css).toMatch(
      /#print-preview-status\s*\{[\s\S]*flex:\s*1 1 100%;[\s\S]*max-width:\s*100%;/u,
    );
    const cityScene = await fs.readFile(
      path.join(viewerRoot, "src/city-scene.ts"),
      "utf8",
    );
    expect(cityScene).toContain(
      "this.prePrintOverlayVisibility.dependencies = routes.length > 0",
    );
    expect(cityScene).toContain(
      "this.prePrintOverlayVisibility.districtDependencies =",
    );
    expect(cityScene).toContain("viewerPrintMeshBatches(plate.entities");
  });
});
