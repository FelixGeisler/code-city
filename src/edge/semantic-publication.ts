import type { ControllerCanvas, ControllerPublication } from "../application/main-controller";
import type { DistrictDescriptor, InspectionFact } from "../application/city-payload";
import type { DistrictProjectionSnapshot } from "../domain/camera-picking-policy";
import {
  explainMetricFact,
  METRIC_PALETTE_LEGEND,
  type MetricExplanation,
} from "../application/metric-explanation";

type SemanticDocument = Pick<Document, "createElement">;
type Rectangle = Readonly<{ left: number; top: number; width: number; height: number }>;
type Box = Readonly<{
  index: number;
  area: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}>;
type CachedLayout = Readonly<{
  snapshot: DistrictProjectionSnapshot;
  boxes: readonly Box[];
}>;

export type DistrictLabelLayout = Readonly<{
  visible: boolean;
  transform: string;
}>;

const LABEL_HEIGHT = 20;
const LABEL_WIDE_WIDTH = 144;
const LABEL_NARROW_WIDTH = 104;
const LABEL_BREAKPOINT = 480;
const EXCLUSION_GAP = 4;
const COLLISION_INSET = EXCLUSION_GAP / 2;

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

function finiteRectangle(rectangle: Rectangle): Rectangle {
  const right = rectangle.left + rectangle.width;
  const bottom = rectangle.top + rectangle.height;
  if (![rectangle.left, rectangle.top, rectangle.width, rectangle.height, right, bottom].every(Number.isFinite)
    || !(rectangle.width > 0) || !(rectangle.height > 0)) throw new Error("Invalid attached rectangle");
  return rectangle;
}

function overlaps(left: Box, right: Box): boolean {
  return left.left < right.right && right.left < left.right
    && left.top < right.bottom && right.top < left.bottom;
}

function inflated(box: Box, amount: number): Box {
  return {
    ...box,
    left: box.left - amount,
    top: box.top - amount,
    right: box.right + amount,
    bottom: box.bottom + amount,
  };
}

function cacheProjection(snapshot: DistrictProjectionSnapshot): CachedLayout {
  if (!Number.isInteger(snapshot.cssWidth) || snapshot.cssWidth <= 0
    || !Number.isInteger(snapshot.cssHeight) || snapshot.cssHeight <= 0
    || !Array.isArray(snapshot.districts)) throw new Error("Invalid district projection snapshot");
  const width = snapshot.cssWidth >= LABEL_BREAKPOINT ? LABEL_WIDE_WIDTH : LABEL_NARROW_WIDTH;
  const boxes: Box[] = [];
  for (const [index, district] of snapshot.districts.entries()) {
    if (!district || ![district.screenX, district.screenY, district.area].every(Number.isFinite)
      || typeof district.lateral !== "boolean") throw new Error("Invalid projected district");
    const left = district.screenX - width / 2;
    const top = district.screenY - LABEL_HEIGHT / 2;
    const right = left + width;
    const bottom = top + LABEL_HEIGHT;
    if (![left, top, right, bottom].every(Number.isFinite)) throw new Error("Invalid district label rectangle");
    if (!district.lateral || !(left < snapshot.cssWidth && right > 0 && top < snapshot.cssHeight && bottom > 0)) continue;
    boxes.push(Object.freeze({ index, area: district.area, left, top, right, bottom }));
  }
  boxes.sort((left, right) => right.area - left.area || left.index - right.index);
  return Object.freeze({ snapshot, boxes: Object.freeze(boxes) });
}

function gridCells(box: Box, cellWidth: number): readonly string[] {
  const firstX = Math.floor(box.left / cellWidth);
  const lastX = Math.ceil(box.right / cellWidth) - 1;
  const firstY = Math.floor(box.top / (LABEL_HEIGHT + EXCLUSION_GAP));
  const lastY = Math.ceil(box.bottom / (LABEL_HEIGHT + EXCLUSION_GAP)) - 1;
  const cells: string[] = [];
  for (let y = firstY; y <= lastY; y += 1) {
    for (let x = firstX; x <= lastX; x += 1) cells.push(`${x}:${y}`);
  }
  return cells;
}

function layoutFromCache(cache: CachedLayout, inspector?: Rectangle): readonly DistrictLabelLayout[] {
  const { snapshot } = cache;
  const width = snapshot.cssWidth >= LABEL_BREAKPOINT ? LABEL_WIDE_WIDTH : LABEL_NARROW_WIDTH;
  const layouts: DistrictLabelLayout[] = snapshot.districts.map((district) => Object.freeze({
    visible: false,
    transform: `translate(${district.screenX - width / 2}px, ${district.screenY - LABEL_HEIGHT / 2}px)`,
  }));
  const inspectorExclusion = inspector ? {
    index: -1,
    area: 0,
    left: inspector.left - EXCLUSION_GAP,
    top: inspector.top - EXCLUSION_GAP,
    right: inspector.left + inspector.width + EXCLUSION_GAP,
    bottom: inspector.top + inspector.height + EXCLUSION_GAP,
  } : undefined;
  const buckets = new Map<string, number[]>();
  const accepted = new Map<number, Box>();
  for (const box of cache.boxes) {
    if (inspectorExclusion && overlaps(box, inspectorExclusion)) continue;
    const collisionBox = inflated(box, COLLISION_INSET);
    const cells = gridCells(collisionBox, width + EXCLUSION_GAP);
    const compared = new Set<number>();
    let collision = false;
    for (const cell of cells) {
      for (const acceptedIndex of buckets.get(cell) ?? []) {
        if (compared.has(acceptedIndex)) continue;
        compared.add(acceptedIndex);
        if (overlaps(collisionBox, accepted.get(acceptedIndex)!)) {
          collision = true;
          break;
        }
      }
      if (collision) break;
    }
    if (collision) continue;
    accepted.set(box.index, collisionBox);
    for (const cell of cells) {
      const entries = buckets.get(cell) ?? [];
      entries.push(box.index);
      buckets.set(cell, entries);
    }
    layouts[box.index] = Object.freeze({ visible: true, transform: layouts[box.index]!.transform });
  }
  return Object.freeze(layouts);
}

export function layoutDistrictLabels(
  snapshot: DistrictProjectionSnapshot,
  inspector?: Rectangle,
): readonly DistrictLabelLayout[] {
  const acceptedInspector = inspector ? finiteRectangle(inspector) : undefined;
  return layoutFromCache(cacheProjection(snapshot), acceptedInspector);
}

export function stageSemanticPublication(
  documentTarget: SemanticDocument,
  publicationRoot: Pick<HTMLElement, "replaceChildren">,
  revisionOutput: Pick<HTMLElement, "textContent">,
  revision: string,
  inspection: readonly InspectionFact[],
  districts: readonly DistrictDescriptor[],
): ControllerPublication {
  let semanticDistricts = districts.map((district) => Object.freeze({ root: district.root, identity: district.identity }));
  const inspector = documentTarget.createElement("section");
  inspector.dataset.inspector = "";
  inspector.setAttribute("role", "status");
  inspector.setAttribute("aria-live", "polite");
  inspector.setAttribute("aria-atomic", "true");
  inspector.setAttribute("aria-label", "Selected building metric explanation");
  inspector.tabIndex = 0;
  inspector.hidden = true;
  const labelsOverlay = documentTarget.createElement("div");
  labelsOverlay.dataset.districtLabels = "";
  labelsOverlay.setAttribute("aria-hidden", "true");
  const labels = semanticDistricts.map((district) => {
    const label = documentTarget.createElement("div");
    const text = documentTarget.createElement("bdi");
    text.setAttribute("dir", "auto");
    text.textContent = district.root ? "/" : district.identity;
    label.append(text);
    labelsOverlay.append(label);
    return label;
  });
  const legend = complexityLegend(documentTarget);
  let committedToRoot = false;
  let canvas: ControllerCanvas | undefined;
  let cache: CachedLayout | undefined;

  const inspectorRectangle = (overlayRectangle: Rectangle): Rectangle | undefined => {
    if (inspector.hidden) return undefined;
    const measured = finiteRectangle(inspector.getBoundingClientRect());
    return finiteRectangle({
      left: measured.left - overlayRectangle.left,
      top: measured.top - overlayRectangle.top,
      width: measured.width,
      height: measured.height,
    });
  };

  const publishLayout = (): void => {
    if (!canvas || !cache || labels.length !== semanticDistricts.length
      || cache.snapshot.districts.length !== labels.length) throw new Error("Incomplete district label publication");
    const overlayRectangle = finiteRectangle(labelsOverlay.getBoundingClientRect());
    const canvasRectangle = finiteRectangle(canvas.getBoundingClientRect());
    if (overlayRectangle.left !== canvasRectangle.left || overlayRectangle.top !== canvasRectangle.top
      || overlayRectangle.width !== canvasRectangle.width || overlayRectangle.height !== canvasRectangle.height) {
      throw new Error("Attached presentation dimensions differ");
    }
    const layout = layoutFromCache(cache, inspectorRectangle(overlayRectangle));
    for (let index = 0; index < labels.length; index += 1) {
      const label = labels[index]!;
      const item = layout[index]!;
      label.style.width = `${cache.snapshot.cssWidth >= LABEL_BREAKPOINT ? LABEL_WIDE_WIDTH : LABEL_NARROW_WIDTH}px`;
      label.style.transform = item.transform;
      label.hidden = !item.visible;
    }
  };

  return Object.freeze({
    commit(nextCanvas: ControllerCanvas, snapshot: DistrictProjectionSnapshot) {
      cache = cacheProjection(snapshot);
      canvas = nextCanvas;
      publicationRoot.replaceChildren(nextCanvas as unknown as Node, labelsOverlay, inspector, legend);
      committedToRoot = true;
      publishLayout();
      revisionOutput.textContent = revision;
    },
    districtProjection(snapshot: DistrictProjectionSnapshot) {
      cache = cacheProjection(snapshot);
      publishLayout();
    },
    setSelection(index: number | null) {
      if (index === null) {
        inspector.hidden = true;
        inspector.replaceChildren();
      } else {
        const fact = inspection[index];
        if (!fact) throw new Error("Invalid semantic selection");
        const content = selectedContent(documentTarget, explainMetricFact(fact));
        inspector.replaceChildren(...content);
        inspector.hidden = false;
      }
      if (committedToRoot) publishLayout();
    },
    rollback() {
      try { inspector.hidden = true; } catch {}
      try { inspector.replaceChildren(); } catch {}
      try { labelsOverlay.replaceChildren(); } catch {}
      try { labelsOverlay.remove(); } catch {}
      try { inspector.remove(); } catch {}
      try { legend.parentNode?.removeChild(legend); } catch {}
      let ownsRevision = committedToRoot;
      if (!ownsRevision) {
        try { ownsRevision = revisionOutput.textContent === revision; } catch {}
      }
      if (ownsRevision) {
        try { revisionOutput.textContent = ""; } catch {}
      }
      labels.length = 0;
      semanticDistricts = [];
      canvas = undefined;
      cache = undefined;
      committedToRoot = false;
    },
  });
}
