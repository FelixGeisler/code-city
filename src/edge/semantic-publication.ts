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
  const title = heading(documentTarget, "h2", "");
  const path = documentTarget.createElement("bdi");
  path.dataset.canonicalPath = "";
  path.setAttribute("dir", "auto");
  path.textContent = value.canonicalPath;
  title.append(path);
  const selectedDistrict = documentTarget.createElement("p");
  selectedDistrict.dataset.selectedDistrict = "";
  const label = documentTarget.createElement("span");
  label.textContent = "District: ";
  const districtPath = documentTarget.createElement("bdi");
  districtPath.setAttribute("dir", "auto");
  districtPath.textContent = district;
  selectedDistrict.append(label, districtPath);
  const metrics = documentTarget.createElement("dl");
  metrics.dataset.metricFacts = "";
  definition(documentTarget, metrics, "Source lines", String(value.sourceLines), "data-source-lines");
  definition(documentTarget, metrics, "Executable units", String(value.executableUnits), "data-executable-units");
  definition(
    documentTarget,
    metrics,
    "Maximum unit complexity",
    String(value.maximumComplexity),
    "data-maximum-complexity",
  );

  return [title, selectedDistrict, metrics];
}

export function replaceMetricInspectorContent(
  documentTarget: SemanticDocument,
  inspector: Pick<HTMLElement, "replaceChildren">,
  fact: InspectionFact,
  district: string,
  selectDistrict?: () => void,
): () => void {
  const content = selectedContent(documentTarget, explainMetricFact(fact), district);
  const button = documentTarget.createElement("button");
  button.type = "button";
  const path = documentTarget.createElement("bdi");
  path.setAttribute("dir", "auto");
  path.textContent = district;
  button.append(path);
  if (selectDistrict) {
    button.dataset.selectDistrict = "";
    button.addEventListener("click", selectDistrict);
    const label = documentTarget.createElement("span");
    label.textContent = "District: ";
    content[1]!.replaceChildren(label, button);
  }
  const release = (): void => { if (selectDistrict) button.removeEventListener("click", selectDistrict); };
  try { inspector.replaceChildren(...content); }
  catch (error) { release(); throw error; }
  return release;
}

export function replaceDistrictInspectorContent(
  documentTarget: SemanticDocument,
  inspector: Pick<HTMLElement, "replaceChildren">,
  district: string,
  members: readonly InspectionFact[],
): void {
  if (members.length === 0) throw new Error("District has no analyzed files");
  const title = heading(documentTarget, "h2", "");
  const path = documentTarget.createElement("bdi");
  path.dataset.districtPath = "";
  path.setAttribute("dir", "auto");
  path.textContent = district;
  title.append(path);
  const kind = documentTarget.createElement("p");
  kind.textContent = "District";
  const metrics = documentTarget.createElement("dl");
  metrics.dataset.metricFacts = "";
  let sourceLines = 0n, units = 0n, maximum = 0;
  for (const fact of members) {
    sourceLines += BigInt(fact.S);
    units += BigInt(fact.U);
    maximum = Math.max(maximum, fact.M);
  }
  definition(documentTarget, metrics, "Analyzed files", String(members.length), "data-file-count");
  definition(documentTarget, metrics, "Source lines", String(sourceLines), "data-source-lines");
  definition(documentTarget, metrics, "Executable units", String(units), "data-executable-units");
  definition(documentTarget, metrics, "Maximum unit complexity", String(maximum), "data-maximum-complexity");
  inspector.replaceChildren(title, kind, metrics);
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
          replaceMetricInspectorContent(documentTarget, inspector, fact, district);
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
