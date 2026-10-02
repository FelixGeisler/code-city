import type {
  ControllerCanvas,
  ControllerPublication,
  ControllerSearchEventSink,
  SemanticPublicationIdentity,
} from "../application/main-controller";
import type { InspectionFact } from "../application/city-payload";
import type { DistrictProjectionSnapshot } from "../domain/camera-picking-policy";
import {
  explainMetricFact,
  METRIC_PALETTE_LEGEND,
  type MetricExplanation,
} from "../application/metric-explanation";

type SemanticDocument = Pick<Document, "createElement">;

const LABEL_BREAKPOINT = 480;
const LABEL_WIDE_WIDTH = 144;
const LABEL_NARROW_WIDTH = 104;

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

function selectedContent(
  documentTarget: SemanticDocument,
  value: MetricExplanation,
  district: string,
): HTMLElement[] {
  const title = heading(documentTarget, "h2", "Selected building");

  const identity = documentTarget.createElement("div");
  identity.dataset.inspectorIdentity = "";
  const identityLabel = documentTarget.createElement("span");
  identityLabel.textContent = "Canonical path";
  const path = documentTarget.createElement("bdi");
  path.dataset.canonicalPath = "";
  path.textContent = value.canonicalPath;
  identity.append(identityLabel, path);

  const selectedDistrict = documentTarget.createElement("bdi");
  selectedDistrict.dataset.selectedDistrict = "";
  selectedDistrict.setAttribute("dir", "auto");
  selectedDistrict.textContent = `District: ${district}`;

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

  const dimensionTitle = heading(documentTarget, "h3", "Bounded displayed dimensions");
  const dimensionPolicy = documentTarget.createElement("p");
  dimensionPolicy.dataset.dimensionPolicy = "";
  dimensionPolicy.textContent = "Height: square-root scale; S cap 1000; displayed height range 4..40. Footprint: log-compressed scale; U cap 100; displayed side range 3..18.";
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

  return [
    title,
    identity,
    selectedDistrict,
    metricTitle,
    metrics,
    dimensionTitle,
    dimensionPolicy,
    dimensions,
    colourTitle,
    selectedColour,
  ];
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
  generation: number,
  searchSink: ControllerSearchEventSink,
  viewportRoot: Pick<HTMLElement, "replaceChildren"> = publicationRoot,
): ControllerPublication {
  const searchIdentity: SemanticPublicationIdentity = Object.freeze({});
  const search = documentTarget.createElement("section");
  search.dataset.pathSearch = "";
  const searchLabel = documentTarget.createElement("label");
  searchLabel.textContent = "Find module by path";
  const searchInput = documentTarget.createElement("input");
  searchInput.type = "search";
  searchInput.autocomplete = "off";
  searchInput.spellcheck = false;
  searchInput.dataset.pathSearchInput = "";
  searchLabel.append(searchInput);
  const searchResults = documentTarget.createElement("div");
  searchResults.dataset.pathSearchResults = "";
  searchResults.hidden = true;
  const searchSummary = documentTarget.createElement("p");
  searchSummary.dataset.pathSearchSummary = "";
  const searchButtons = documentTarget.createElement("div");
  searchButtons.dataset.pathSearchButtons = "";
  searchResults.append(searchSummary, searchButtons);
  search.append(searchLabel, searchResults);
  const inputListener = (): void => searchSink.queryChanged(generation, searchIdentity, searchInput.value);
  searchInput.addEventListener("input", inputListener);
  let resultListeners: Array<Readonly<{ button: HTMLButtonElement; listener: () => void }>> = [];

  const contextRow = documentTarget.createElement("div");
  contextRow.dataset.districtContext = "";
  contextRow.setAttribute("aria-hidden", "true");
  const contextLabel = documentTarget.createElement("div");
  contextLabel.dataset.districtContextLabel = "";
  contextLabel.hidden = true;
  const contextText = documentTarget.createElement("bdi");
  contextText.setAttribute("dir", "auto");
  contextLabel.append(contextText);
  contextRow.append(contextLabel);

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
  let canvas: ControllerCanvas | undefined;
  let selectedIndex: number | null = null;

  const publishWidth = (): void => {
    if (!canvas) throw new Error("Contextual district row is not attached");
    const width = canvas.getBoundingClientRect().width;
    if (!Number.isFinite(width) || !(width > 0)) throw new Error("Invalid attached canvas width");
    contextLabel.style.width = `${width >= LABEL_BREAKPOINT ? LABEL_WIDE_WIDTH : LABEL_NARROW_WIDTH}px`;
  };

  const clearResultListeners = (): void => {
    for (const entry of resultListeners) entry.button.removeEventListener("click", entry.listener);
    resultListeners = [];
  };

  const publishSearchResults = (query: string, indices: readonly number[]): void => {
    if (searchInput.value !== query) throw new Error("Search query snapshot differs");
    clearResultListeners();
    searchButtons.replaceChildren();
    if (query === "") {
      searchSummary.textContent = "";
      searchResults.hidden = true;
      return;
    }
    searchSummary.textContent = indices.length === 0
      ? "No matching modules."
      : `${indices.length} matching ${indices.length === 1 ? "module" : "modules"}.`;
    for (const index of indices) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= inspection.length) throw new Error("Invalid search result");
      const button = documentTarget.createElement("button");
      button.type = "button";
      const path = documentTarget.createElement("bdi");
      path.setAttribute("dir", "auto");
      path.textContent = inspection[index]!.canonicalPath;
      button.append(path);
      const listener = (): void => searchSink.resultActivated(generation, searchIdentity, searchInput.value, index);
      button.addEventListener("click", listener);
      resultListeners.push(Object.freeze({ button, listener }));
      searchButtons.append(button);
    }
    searchResults.hidden = false;
  };

  return Object.freeze({
    searchIdentity,
    commit(nextCanvas: ControllerCanvas, _snapshot: DistrictProjectionSnapshot) {
      canvas = nextCanvas;
      viewportRoot.replaceChildren(nextCanvas as unknown as Node, inspector, legend);
      if (viewportRoot === publicationRoot) {
        publicationRoot.replaceChildren(search, contextRow, nextCanvas as unknown as Node, inspector, legend);
      } else {
        publicationRoot.replaceChildren(search, contextRow, viewportRoot as unknown as Node);
      }
      committedToRoot = true;
      publishWidth();
      revisionOutput.textContent = revision;
    },
    districtProjection(_snapshot: DistrictProjectionSnapshot) {
      publishWidth();
    },
    setSearchResults(query: string, indices: readonly number[]) {
      publishSearchResults(query, indices);
    },
    clearSearch() {
      searchInput.value = "";
      publishSearchResults("", []);
    },
    setContext(selection: number | null, district: string | null) {
      if (selection !== null && (!Number.isSafeInteger(selection) || selection < 0 || selection >= inspection.length)) {
        throw new Error("Invalid semantic selection");
      }
      if (district !== null && typeof district !== "string") throw new Error("Invalid semantic district");
      contextText.textContent = district ?? "";
      contextLabel.hidden = district === null;
      if (selection !== selectedIndex) {
        if (selection === null) {
          inspector.hidden = true;
          inspector.replaceChildren();
        } else {
          const fact = inspection[selection]!;
          if (district === null) throw new Error("Selected district is absent");
          const content = selectedContent(documentTarget, explainMetricFact(fact), district);
          inspector.replaceChildren(...content);
          inspector.hidden = false;
        }
        selectedIndex = selection;
      }
    },
    rollback() {
      try { searchInput.removeEventListener("input", inputListener); } catch {}
      try { clearResultListeners(); } catch {}
      try { searchInput.value = ""; } catch {}
      try { searchSummary.textContent = ""; } catch {}
      try { searchButtons.replaceChildren(); } catch {}
      try { searchResults.hidden = true; } catch {}
      try { search.remove(); } catch {}
      try { contextText.textContent = ""; } catch {}
      try { contextLabel.hidden = true; } catch {}
      try { contextRow.replaceChildren(); } catch {}
      try { contextRow.remove(); } catch {}
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
      selectedIndex = null;
      canvas = undefined;
      committedToRoot = false;
    },
  });
}
