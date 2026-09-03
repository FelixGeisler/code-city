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

  const dimensionTitle = heading(documentTarget, "h3", "Building dimensions");
  const dimensions = documentTarget.createElement("dl");
  dimensions.dataset.metricDimensions = "";
  definition(documentTarget, dimensions, "Height", `S + 1 = ${value.height}`, "data-height");
  definition(documentTarget, dimensions, "Width", `U + 1 = ${value.width}`, "data-width");
  definition(documentTarget, dimensions, "Depth", `U + 1 = ${value.depth}`, "data-depth");

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

  const legendTitle = heading(documentTarget, "h3", "Complexity colour legend");
  const legend = documentTarget.createElement("ul");
  legend.dataset.paletteLegend = "";
  for (const [index, band] of METRIC_PALETTE_LEGEND.entries()) {
    const item = documentTarget.createElement("li");
    const swatch = documentTarget.createElement("span");
    swatch.dataset.paletteSwatch = String(index);
    swatch.setAttribute("aria-hidden", "true");
    const text = documentTarget.createElement("span");
    text.textContent = `M = ${band.range} — ${band.rgba}`;
    item.append(swatch, text);
    legend.append(item);
  }

  return [title, identity, metricTitle, metrics, dimensionTitle, dimensions, colourTitle, selectedColour, legendTitle, legend];
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
  let committedToRoot = false;

  return Object.freeze({
    commit(canvas: ControllerCanvas) {
      publicationRoot.replaceChildren(canvas as unknown as Node, inspector);
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
