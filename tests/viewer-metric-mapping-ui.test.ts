import { promises as fs } from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

const viewerRoot = path.resolve("apps/viewer");
let html = "";
let css = "";
let main = "";
let panel = "";

beforeAll(async () => {
  [html, css, main, panel] = await Promise.all([
    fs.readFile(path.join(viewerRoot, "index.html"), "utf8"),
    fs.readFile(path.join(viewerRoot, "src/styles.css"), "utf8"),
    fs.readFile(path.join(viewerRoot, "src/main.ts"), "utf8"),
    fs.readFile(
      path.join(viewerRoot, "src/metric-mapping-panel.ts"),
      "utf8",
    ),
  ]);
});

describe("viewer metric mapping UI", () => {
  it("provides one accessible dedicated metrics tab and labelled controls", () => {
    expect(html).toMatch(
      /id="viewer-tab-metrics"[\s\S]*role="tab"[\s\S]*aria-controls="viewer-view-metrics"[\s\S]*data-workspace-view="metrics"/u,
    );
    expect(html).toMatch(
      /id="viewer-view-metrics"[\s\S]*role="tabpanel"[\s\S]*aria-labelledby="viewer-tab-metrics"[\s\S]*data-workspace-panel="metrics"/u,
    );
    for (const id of [
      "metric-mapping-preset",
      "metric-footprint-metric",
      "metric-footprint-normalization",
      "metric-footprint-cap",
      "metric-height-metric",
      "metric-height-normalization",
      "metric-height-cap",
      "metric-color-metric",
      "metric-color-normalization",
      "metric-color-cap",
      "metric-color-palette",
      "metric-configuration-name",
      "metric-configuration-select",
    ]) {
      expect(html).toContain(`for="${id}"`);
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('id="metric-mapping-status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('id="metric-mapping-unavailable-reasons"');
    expect(panel).toContain('entry.availability === "unavailable"');
    expect(panel).toContain("unavailableReasons.append(item)");
  });

  it("wires explicit preview/apply/cancel and disables print export while preview is active", () => {
    expect(html).toContain('id="metric-mapping-preview"');
    expect(html).toContain('id="metric-mapping-apply"');
    expect(html).toContain('id="metric-mapping-cancel"');
    expect(html).toContain('id="metric-preview-banner"');
    expect(main).toContain(
      "printExportOpenButton.disabled = active",
    );
    expect(main).toContain(
      "printExportDialog.setEnabled(!active)",
    );
    expect(main).toContain("metricPreviewBanner.hidden = !active");
    expect(main).toContain("metricMappingPanel.setProject(model)");
    expect(main).toMatch(
      /onModelChange: \(model\) => \{\s*applyModel\(model, activeModelSource\);/u,
    );
    expect(panel).toContain("void controller.preview()");
    expect(panel).toContain("controller.apply()");
    expect(panel).toContain("controller.cancel()");
    expect(panel).toContain(
      'state.phase === "projecting" || !controlsValid',
    );
    expect(panel).toContain(
      "saveButton.disabled = project === undefined || !controlsValid",
    );
    expect(panel).toMatch(
      /const onPreview = \(\): void => \{\s*if \(!controlsValid\) return;/u,
    );
    expect(panel).toMatch(
      /const onSave = \(\): void => \{[\s\S]*?current = mappingFromControls\(\);[\s\S]*?controlsValid = false;/u,
    );
    expect(panel).toContain(
      "return unnamedMetricMappingDefinition(mapping)",
    );
    expect(panel).toContain(
      "const mapping = metricMappingWithChannels(current",
    );
    expect(panel).toContain(
      "const named = namedMetricMappingDefinition(current, name)",
    );
    expect(panel).toMatch(
      /if \(result\.ok\) \{[\s\S]*?controller\.edit\(named\);[\s\S]*?renderSavedConfigurations\(name\);[\s\S]*?return;\s*\}\s*renderState\(controller\.state\);/u,
    );
  });

  it("shows exact formulas, ranges, missing behavior, generated palette legend, and provenance", () => {
    expect(html).toContain('id="metric-footprint-formula"');
    expect(html).toContain('id="metric-height-formula"');
    expect(html).toContain('id="metric-color-formula"');
    expect(html).toContain('id="metric-color-legend"');
    expect(html).toContain('id="metric-mapping-provenance"');
    expect(panel).toContain("normalizedFormula(");
    expect(panel).toContain("missing =");
    expect(panel).toContain("footprintGeometry.formula");
    expect(panel).toContain("heightGeometry.formula");
    expect(panel).toContain("describeMetricMapping(mapping)");
    expect(panel).toContain(
      "`${entry.label} (${entry.color.toUpperCase()})`",
    );
    expect(panel).toContain(
      "`Metric color thresholds — ${",
    );
  });

  it("keeps the metrics workspace touch-usable and responsive", () => {
    expect(css).toMatch(
      /\.metric-mapping-channel select,[\s\S]*min-height:\s*38px/u,
    );
    expect(css).toMatch(
      /@media \(max-width: 600px\)[\s\S]*\.metric-mapping-channel\s*\{[\s\S]*grid-template-columns:\s*1fr/u,
    );
    expect(css).toMatch(
      /\.viewer-workspace-tabs\s*\{[\s\S]*grid-template-columns:\s*repeat\(5,/u,
    );
  });
});
