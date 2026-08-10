import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("safe extension viewer flow", () => {
  it("provides labelled import, worker preview, diagnostics, and reviewed-only export controls", async () => {
    const html = await readFile(
      path.resolve("apps/viewer/index.html"),
      "utf8",
    );
    expect(html).toContain('id="safe-extension-panel"');
    expect(html).toContain('id="safe-extension-json"');
    expect(html).toContain('maxlength="131072"');
    expect(html).toContain(
      'aria-describedby="safe-extension-diagnostics"',
    );
    expect(html).toContain('id="safe-extension-preview"');
    expect(html).toContain(
      'id="safe-extension-export" class="button" type="button" disabled',
    );
  });

  it("applies a color-only preview without reloading the model or scrubbing source and AI state", async () => {
    const main = await readFile(
      path.resolve("apps/viewer/src/main.ts"),
      "utf8",
    );
    expect(main).toMatch(
      /activeSafeExtensionEvaluation = review\.evaluation;\s*if \(projected === activeModel\) \{\s*printExportDialog\?\.invalidate\(\);\s*imageExportDialog\?\.invalidate\(\);\s*printPlateToolbar\.setPlan\(undefined\);\s*applyVisualization\(\);\s*return;\s*\}\s*applyModel\(projected,/u,
    );
  });
});
