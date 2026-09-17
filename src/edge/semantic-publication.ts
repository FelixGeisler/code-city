import type { ControllerCanvas, ControllerPublication } from "../application/main-controller";
import type { InspectionFact } from "../application/city-payload";
import {
  explainMetricFact,
  METRIC_PALETTE_LEGEND,
  type MetricExplanation,
} from "../application/metric-explanation";

type SemanticDocument = Pick<Document, "createElement">;

function heading(documentTarget: SemanticDocument, level: "h2" | "h3", text: string): HTMLHeadingElement {
  const element = documentTarget.createElement(level);
  element.textContent = text;
  return element;
}

function definition(
  documentTarget: SemanticDocument,
  list: HTMLDListElement,
  label: string,
  value: string,
  dataAttribute: string,
): void {
  const group = documentTarget.createElement("div");
  const term = documentTarget.createElement("dt");
  term.textContent = label;
  const description = documentTarget.createElement("dd");
  description.setAttribute(dataAttribute, "");
  description.textContent = value;
  group.append(term, description);
  list.append(group);
}

function selectedContent(documentTarget: SemanticDocument, value: MetricExplanation): HTMLElement[] {
  const title = heading(documentTarget, "h2", "Selected building");

  const identity = documentTarget.createElement("div");
  identity.dataset.inspectorIdentity = "";
  const identityLabel = documentTarget.createElement("span");
  identityLabel.textContent = "Canonical path";
  const path = documentTarget.createElement("bdi");
  path.dataset.canonicalPath = "";
  path.textContent = value.canonicalPath;
  identity.append(identityLabel, path);

  const metricTitle = heading(documentTarget, "h3", "Exact metrics");
  const metrics = documentTarget.createElement("dl");
  metrics.dataset.metricFacts = "";
  definition(documentTarget, metrics, "Source lines (S)", String(value.sourceLines), "data-source-lines");
  definition(documentTarget, metrics, "Executable units (U)", String(value.executableUnits), "data-executable-units");
  definition(
    documentTarget,
    metrics,
    "Maximum executable-unit complexity (M)",
    String(value.maximumComplexity),
    "data-maximum-complexity",
  );

  const dimensionTitle = heading(documentTarget, "h3", "Bounded, log-compressed displayed dimensions");
  const dimensionPolicy = documentTarget.createElement("p");
  dimensionPolicy.dataset.dimensionPolicy = "";
  dimensionPolicy.textContent = "S cap 1000; displayed height range 4..40. U cap 100; displayed side range 3..18.";
  const dimensions = documentTarget.createElement("dl");
  dimensions.dataset.metricDimensions = "";
  definition(documentTarget, dimensions, "Displayed height", String(value.height), "data-height");
  definition(documentTarget, dimensions, "Displayed width", String(value.width), "data-width");
  definition(documentTarget, dimensions, "Displayed depth", String(value.depth), "data-depth");

  const colourTitle = heading(documentTarget, "h3", "Selected colour");
  const selectedColour = documentTarget.createElement("p");
  selectedColour.dataset.selectedColour = "";
  const selectedSwatch = documentTarget.createElement("span");
  const selectedBand = METRIC_PALETTE_LEGEND.findIndex((band) => band.range === value.paletteRange);
  selectedSwatch.dataset.paletteSwatch = String(selectedBand);
  selectedSwatch.setAttribute("aria-hidden", "true");
  const selectedRange = documentTarget.createElement("span");
  selectedRange.dataset.selectedRange = "";
  selectedRange.textContent = `M = ${value.paletteRange}`;
  const selectedRgba = documentTarget.createElement("code");
  selectedRgba.dataset.selectedRgba = "";
  selectedRgba.textContent = value.rgba;
  selectedColour.append(selectedSwatch, selectedRange, selectedRgba);

  return [title, identity, metricTitle, metrics, dimensionTitle, dimensionPolicy, dimensions, colourTitle, selectedColour];
}

function complexityLegend(documentTarget: SemanticDocument): HTMLElement {
  const legend = documentTarget.createElement("section");
  legend.dataset.paletteLegend = "";
  legend.setAttribute("aria-label", "Complexity: low → high");
  const title = heading(documentTarget, "h2", "Complexity: low → high");
  const list = documentTarget.createElement("ul");
  for (const [index, band] of METRIC_PALETTE_LEGEND.entries()) {
    const item = documentTarget.createElement("li");
    const swatch = documentTarget.createElement("span");
    swatch.dataset.paletteSwatch = String(index);
    swatch.setAttribute("aria-hidden", "true");
    const text = documentTarget.createElement("span");
    text.textContent = `M = ${band.range}`;
    item.append(swatch, text);
    list.append(item);
  }
  legend.append(title, list);
  return legend;
}

export function stageSemanticPublication(
  documentTarget: SemanticDocument,
  publicationRoot: Pick<HTMLElement, "replaceChildren">,
  revisionOutput: Pick<HTMLElement, "textContent">,
  revision: string,
  inspection: readonly InspectionFact[],
): ControllerPublication {
  const inspector = documentTarget.createElement("section");
  inspector.dataset.inspector = "";
  inspector.setAttribute("role", "status");
  inspector.setAttribute("aria-live", "polite");
  inspector.setAttribute("aria-atomic", "true");
  inspector.setAttribute("aria-label", "Selected building metric explanation");
  inspector.tabIndex = 0;
  inspector.hidden = true;
  const legend = complexityLegend(documentTarget);
  let committedToRoot = false;

  return Object.freeze({
    commit(canvas: ControllerCanvas) {
      publicationRoot.replaceChildren(canvas as unknown as Node, inspector, legend);
      revisionOutput.textContent = revision;
      committedToRoot = true;
    },
    setSelection(index: number | null) {
      if (index === null) {
        inspector.hidden = true;
        inspector.replaceChildren();
        return;
      }
      const fact = inspection[index];
      if (!fact) throw new Error("Invalid semantic selection");
      const content = selectedContent(documentTarget, explainMetricFact(fact));
      inspector.replaceChildren(...content);
      inspector.hidden = false;
    },
    rollback() {
      try { inspector.hidden = true; } catch {}
      try { inspector.replaceChildren(); } catch {}
      try { inspector.remove(); } catch {}
      try { legend.parentNode?.removeChild(legend); } catch {}
      let ownsRevision = committedToRoot;
      if (!ownsRevision) {
        try { ownsRevision = revisionOutput.textContent === revision; } catch {}
      }
      if (ownsRevision) {
        try { revisionOutput.textContent = ""; } catch {}
      }
      committedToRoot = false;
    },
  });
}
