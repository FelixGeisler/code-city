import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const viewerRoot = path.resolve("apps/viewer");

describe("viewer 3MF export UI", () => {
  it("exposes an accessible local-only export dialog and every v1 option", async () => {
    const html = await fs.readFile(
      path.join(viewerRoot, "index.html"),
      "utf8",
    );

    expect(html).toContain('id="print-export-open"');
    expect(html).toMatch(
      /<dialog[\s\S]*id="print-export-dialog"[\s\S]*aria-labelledby="print-export-title"[\s\S]*aria-describedby="print-export-privacy"/u,
    );
    expect(html).toContain("Nothing is\n            uploaded.");
    expect(html).toContain('<option value="generic">');
    expect(html).toContain('<option value="prusa-xl">');
    expect(html).toContain('<option value="custom">');
    expect(html).toContain('id="print-prusa-tools"');
    expect(html).toContain('id="print-custom-profile"');
    expect(html).toContain('id="print-scale"');
    expect(html).toContain('id="print-labels"');
    expect(html).toContain('id="print-routes"');
    expect(html).toContain('id="print-legend-download-enabled"');
    expect(html).toContain('id="print-export-cancel"');
    expect(html).toContain('id="print-export-preflight"');
    expect(html).toContain('id="print-export-download"');
    expect(html).toContain('id="print-export-legend-download"');
    expect(html).toMatch(
      /id="print-scale"[\s\S]*min="0\.01"[\s\S]*step="0\.01"[\s\S]*value="3"[\s\S]*required/u,
    );
    expect(html).toMatch(
      /id="print-export-progress-meter"[\s\S]*aria-labelledby="print-export-status"/u,
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
    expect(source).not.toContain(
      'submitButton.addEventListener("click"',
    );
    expect(source).not.toMatch(/\bfetch\s*\(/u);
    expect(source).not.toMatch(/XMLHttpRequest/u);
  });
});
