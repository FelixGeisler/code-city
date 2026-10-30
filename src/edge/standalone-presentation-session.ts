import type { InspectionFact, ValidatedCity } from "../application/city-payload";
import { compareUnsignedUtf8 } from "../domain/source-admission";
import {
  createCityPresenter,
  type CityPresenter,
  type PresenterCanvas,
  type PresenterVisualResult,
  type SelectionAction,
} from "./city-presenter";
import { replaceMetricInspectorContent } from "./semantic-publication";

export type InventorySort = "S" | "U" | "M";
export type InventoryProjection = Readonly<{
  query: string;
  sort: InventorySort;
  indices: readonly number[];
}>;

export type InventoryPublicationIdentity = Readonly<Record<never, never>>;

type PresentationDocument = Pick<Document, "createElement">;
type PresentationRoot = Pick<HTMLElement, "hidden" | "replaceChildren">;
type VisualResult = PresenterVisualResult;

const SORTS = new Set<InventorySort>(["S", "U", "M"]);

function validIndex(inspection: readonly InspectionFact[], index: number | null): boolean {
  return index === null || (Number.isSafeInteger(index) && index >= 0 && index < inspection.length);
}

function districtFor(canonicalPath: string): string {
  const directories = canonicalPath.split("/").slice(0, -1);
  return directories.length === 0 ? "/" : directories.slice(0, 2).join("/");
}

export function projectAnalyzedFiles(
  inspection: readonly InspectionFact[],
  query: string,
  sort: InventorySort,
): readonly number[] {
  const indices: number[] = [];
  for (let index = 0; index < inspection.length; index += 1) {
    if (inspection[index]!.canonicalPath.includes(query)) indices.push(index);
  }
  indices.sort((leftIndex, rightIndex) => {
    const left = inspection[leftIndex]!;
    const right = inspection[rightIndex]!;
    if (left[sort] !== right[sort]) return left[sort] > right[sort] ? -1 : 1;
    return compareUnsignedUtf8(left.canonicalPath, right.canonicalPath);
  });
  return Object.freeze(indices);
}

export type InventoryState = Readonly<{
  snapshot(): Readonly<InventoryProjection & { hover: number | null; selection: number | null }>;
  queryChanged(
    generation: number,
    identity: InventoryPublicationIdentity,
    expectedQuery: string,
    expectedSort: InventorySort,
    query: string,
  ): void;
  sortChanged(
    generation: number,
    identity: InventoryPublicationIdentity,
    expectedQuery: string,
    expectedSort: InventorySort,
    sort: string,
  ): void;
  rowActivated(
    generation: number,
    identity: InventoryPublicationIdentity,
    query: string,
    sort: InventorySort,
    index: number,
  ): void;
  cityHover(generation: number, identity: InventoryPublicationIdentity, index: number | null): void;
  cityActivated(generation: number, identity: InventoryPublicationIdentity, index: number | null): void;
  selectionAction(generation: number, identity: InventoryPublicationIdentity, action: SelectionAction): void;
  dispose(): void;
}>;

export function createInventoryState(options: Readonly<{
  inspection: readonly InspectionFact[];
  generation: number;
  identity: InventoryPublicationIdentity;
  publishProjection(projection: InventoryProjection): void;
  applyVisual(hover: number | null, selection: number | null): VisualResult;
  publishSelection(selection: number | null): void;
  failed(): void;
}>): InventoryState {
  const { inspection, generation, identity, publishProjection, applyVisual, publishSelection, failed } = options;
  let query = "";
  let sort: InventorySort = "S";
  let indices = projectAnalyzedFiles(inspection, query, sort);
  let hover: number | null = null;
  let selection: number | null = null;
  let active = true;
  let failureReported = false;

  const fail = (): void => {
    if (!active || failureReported) return;
    active = false;
    failureReported = true;
    failed();
  };

  const current = (
    callbackGeneration: number,
    callbackIdentity: InventoryPublicationIdentity,
    expectedQuery?: string,
    expectedSort?: InventorySort,
  ): boolean => active
    && callbackGeneration === generation
    && callbackIdentity === identity
    && (expectedQuery === undefined || expectedQuery === query)
    && (expectedSort === undefined || expectedSort === sort);

  const setProjection = (nextQuery: string, nextSort: InventorySort): void => {
    try {
      const nextIndices = projectAnalyzedFiles(inspection, nextQuery, nextSort);
      publishProjection(Object.freeze({ query: nextQuery, sort: nextSort, indices: nextIndices }));
      if (!active) return;
      query = nextQuery;
      sort = nextSort;
      indices = nextIndices;
    } catch {
      fail();
    }
  };

  const setVisual = (nextHover: number | null, nextSelection: number | null): void => {
    try {
      const result = applyVisual(nextHover, nextSelection);
      if (result.kind === "failure") { fail(); return; }
      if (result.kind !== "applied" || !active) return;
      publishSelection(nextSelection);
      if (!active) return;
      hover = nextHover;
      selection = nextSelection;
    } catch {
      fail();
    }
  };

  return Object.freeze({
    snapshot: () => Object.freeze({ query, sort, indices, hover, selection }),
    queryChanged(callbackGeneration, callbackIdentity, expectedQuery, expectedSort, nextQuery) {
      if (!current(callbackGeneration, callbackIdentity, expectedQuery, expectedSort)) return;
      if (typeof nextQuery !== "string") { fail(); return; }
      setProjection(nextQuery, sort);
    },
    sortChanged(callbackGeneration, callbackIdentity, expectedQuery, expectedSort, nextSort) {
      if (!current(callbackGeneration, callbackIdentity, expectedQuery, expectedSort)) return;
      if (!SORTS.has(nextSort as InventorySort)) { fail(); return; }
      setProjection(query, nextSort as InventorySort);
    },
    rowActivated(callbackGeneration, callbackIdentity, expectedQuery, expectedSort, index) {
      if (!current(callbackGeneration, callbackIdentity, expectedQuery, expectedSort)) return;
      if (!validIndex(inspection, index) || !indices.includes(index)) { fail(); return; }
      setVisual(hover, index);
    },
    cityHover(callbackGeneration, callbackIdentity, index) {
      if (!current(callbackGeneration, callbackIdentity)) return;
      if (!validIndex(inspection, index)) { fail(); return; }
      setVisual(index, selection);
    },
    cityActivated(callbackGeneration, callbackIdentity, index) {
      if (!current(callbackGeneration, callbackIdentity)) return;
      if (!validIndex(inspection, index)) { fail(); return; }
      setVisual(hover, index);
    },
    selectionAction(callbackGeneration, callbackIdentity, action) {
      if (!current(callbackGeneration, callbackIdentity)) return;
      const count = inspection.length;
      let next = selection;
      if (action === "clear") next = null;
      else if (action === "first") next = 0;
      else if (action === "last") next = count - 1;
      else if (action === "next") next = selection === null ? 0 : Math.min(count - 1, selection + 1);
      else if (action === "previous") next = selection === null ? count - 1 : Math.max(0, selection - 1);
      else { fail(); return; }
      setVisual(hover, next);
    },
    dispose() { active = false; },
  });
}

type InventoryPublicationSink = Readonly<{
  queryChanged(
    generation: number,
    identity: InventoryPublicationIdentity,
    expectedQuery: string,
    expectedSort: InventorySort,
    query: string,
  ): void;
  sortChanged(
    generation: number,
    identity: InventoryPublicationIdentity,
    expectedQuery: string,
    expectedSort: InventorySort,
    sort: string,
  ): void;
  rowActivated(
    generation: number,
    identity: InventoryPublicationIdentity,
    query: string,
    sort: InventorySort,
    index: number,
  ): void;
}>;

type RowListener = Readonly<{ button: HTMLButtonElement; listener: () => void; index: number }>;

export type StandaloneInventoryPublication = Readonly<{
  nodes: readonly Node[];
  cityHost: HTMLElement;
  resetControl: HTMLButtonElement;
  identity: InventoryPublicationIdentity;
  setProjection(projection: InventoryProjection, selection: number | null): void;
  setSelection(selection: number | null): void;
  commitCanvas(canvas: PresenterCanvas): void;
  rollback(): void;
}>;

function createInspector(documentTarget: PresentationDocument): HTMLElement {
  const inspector = documentTarget.createElement("section");
  inspector.dataset.inspector = "";
  inspector.setAttribute("role", "status");
  inspector.setAttribute("aria-live", "polite");
  inspector.setAttribute("aria-atomic", "true");
  inspector.setAttribute("aria-label", "Selected building metric explanation");
  inspector.tabIndex = 0;
  inspector.hidden = true;
  return inspector;
}

export function stageStandaloneInventoryPublication(
  documentTarget: PresentationDocument,
  inspection: readonly InspectionFact[],
  generation: number,
  sink: InventoryPublicationSink,
): StandaloneInventoryPublication {
  const identity: InventoryPublicationIdentity = Object.freeze({});
  const analyzed = documentTarget.createElement("details");
  analyzed.dataset.analyzed = "";
  analyzed.open = false;
  const heading = documentTarget.createElement("summary");
  heading.textContent = `Find file (${inspection.length} ${inspection.length === 1 ? "file" : "files"})`;
  const controls = documentTarget.createElement("div");
  controls.dataset.analyzedControls = "";
  const queryLabel = documentTarget.createElement("label");
  queryLabel.textContent = "Filter by canonical path";
  const queryInput = documentTarget.createElement("input");
  queryInput.type = "search";
  queryInput.autocomplete = "off";
  queryInput.spellcheck = false;
  queryInput.dataset.analyzedQuery = "";
  queryLabel.append(queryInput);
  const sortLabel = documentTarget.createElement("label");
  sortLabel.textContent = "Sort by";
  const sortSelect = documentTarget.createElement("select");
  sortSelect.dataset.analyzedSort = "";
  for (const [value, text] of [
    ["S", "Source lines (S)"],
    ["U", "Executable units (U)"],
    ["M", "Maximum complexity (M)"],
  ] as const) {
    const option = documentTarget.createElement("option");
    option.value = value;
    option.textContent = text;
    sortSelect.append(option);
  }
  sortSelect.value = "S";
  sortLabel.append(sortSelect);
  controls.append(queryLabel, sortLabel);

  const panel = documentTarget.createElement("div");
  panel.dataset.analyzedPanel = "";
  const rows = documentTarget.createElement("ul");
  rows.dataset.analyzedRows = "";
  const noMatches = documentTarget.createElement("p");
  noMatches.dataset.analyzedNoMatches = "";
  noMatches.textContent = "No matching analyzed files.";
  noMatches.hidden = true;
  panel.append(rows, noMatches);
  analyzed.append(heading, controls, panel);

  const instructions = documentTarget.createElement("p");
  instructions.id = "city-navigation-instructions";
  instructions.textContent = "Keyboard navigation: use Arrow keys and Home/End to select buildings; Escape clears selection. Use W, A, S, and D to orbit; hold Shift with W, A, S, or D to pan; use + and − to zoom; use 0 or Reset view to return to the overview.";
  const navigation = documentTarget.createElement("details");
  navigation.dataset.cityNavigation = "";
  const navigationSummary = documentTarget.createElement("summary");
  navigationSummary.textContent = "Navigation controls";
  navigation.append(navigationSummary, instructions);
  const cityHost = documentTarget.createElement("section");
  cityHost.dataset.city = "";
  cityHost.setAttribute("aria-label", "Code city");
  const resetControl = documentTarget.createElement("button");
  resetControl.dataset.cityReset = "";
  resetControl.type = "button";
  resetControl.textContent = "Reset view";
  const tools = documentTarget.createElement("div");
  tools.dataset.cityTools = "";
  tools.append(analyzed, resetControl);
  const inspector = createInspector(documentTarget);

  let query = "";
  let sort: InventorySort = "S";
  let selected: number | null = null;
  let rowListeners: RowListener[] = [];
  let rolledBack = false;

  const clearRowListeners = (): void => {
    for (const entry of rowListeners) entry.button.removeEventListener("click", entry.listener);
    rowListeners = [];
  };

  const updatePressed = (): void => {
    for (const entry of rowListeners) entry.button.setAttribute("aria-pressed", String(entry.index === selected));
  };

  const setSelection = (selection: number | null): void => {
    if (!validIndex(inspection, selection)) throw new Error("Invalid inventory selection");
    selected = selection;
    updatePressed();
    if (selection === null) {
      inspector.replaceChildren();
      inspector.hidden = true;
      return;
    }
    const fact = inspection[selection]!;
    replaceMetricInspectorContent(documentTarget, inspector, fact, districtFor(fact.canonicalPath));
    inspector.hidden = false;
  };

  const setProjection = (projection: InventoryProjection, selection: number | null): void => {
    if (queryInput.value !== projection.query || sortSelect.value !== projection.sort) throw new Error("Inventory control snapshot differs");
    const seen = new Set<number>();
    for (const index of projection.indices) {
      if (!validIndex(inspection, index) || index === null || seen.has(index)) throw new Error("Invalid inventory projection");
      seen.add(index);
    }
    clearRowListeners();
    rows.replaceChildren();
    const items: HTMLLIElement[] = [];
    for (const index of projection.indices) {
      const fact = inspection[index]!;
      const item = documentTarget.createElement("li");
      const button = documentTarget.createElement("button");
      button.type = "button";
      button.setAttribute("aria-pressed", String(index === selection));
      const path = documentTarget.createElement("bdi");
      path.setAttribute("dir", "auto");
      path.textContent = fact.canonicalPath;
      const metrics = documentTarget.createElement("span");
      metrics.dataset.analyzedMetrics = "";
      for (const text of [`S: ${fact.S}`, `U: ${fact.U}`, `M: ${fact.M}`]) {
        const value = documentTarget.createElement("span");
        value.textContent = text;
        metrics.append(value);
      }
      button.append(path, metrics);
      const callbackQuery = projection.query;
      const callbackSort = projection.sort;
      const listener = (): void => sink.rowActivated(generation, identity, callbackQuery, callbackSort, index);
      button.addEventListener("click", listener);
      rowListeners.push(Object.freeze({ button, listener, index }));
      item.append(button);
      items.push(item);
    }
    rows.replaceChildren(...items);
    noMatches.hidden = projection.indices.length !== 0;
    query = projection.query;
    sort = projection.sort;
    selected = selection;
  };

  const queryListener = (): void => sink.queryChanged(generation, identity, query, sort, queryInput.value);
  const sortListener = (): void => sink.sortChanged(generation, identity, query, sort, sortSelect.value);
  queryInput.addEventListener("input", queryListener);
  sortSelect.addEventListener("change", sortListener);

  const initial = Object.freeze({ query: "", sort: "S" as const, indices: projectAnalyzedFiles(inspection, "", "S") });
  setProjection(initial, null);

  return Object.freeze({
    nodes: Object.freeze([tools, cityHost, navigation]),
    cityHost,
    resetControl,
    identity,
    setProjection,
    setSelection,
    commitCanvas(canvas) { cityHost.replaceChildren(canvas as unknown as Node, inspector); },
    rollback() {
      if (rolledBack) return;
      rolledBack = true;
      try { queryInput.removeEventListener("input", queryListener); } catch {}
      try { sortSelect.removeEventListener("change", sortListener); } catch {}
      try { clearRowListeners(); } catch {}
      try { queryInput.value = ""; } catch {}
      try { sortSelect.value = "S"; } catch {}
      try { rows.replaceChildren(); } catch {}
      try { noMatches.hidden = true; } catch {}
      try { inspector.hidden = true; } catch {}
      try { inspector.replaceChildren(); } catch {}
      try { cityHost.replaceChildren(); } catch {}
    },
  });
}

type ActiveSession = {
  generation: number;
  publication: StandaloneInventoryPublication;
  presenter: CityPresenter<number>;
  state?: InventoryState;
  presenterDisposed: boolean;
  active: boolean;
};

export type StandalonePresentationCoordinator = Readonly<{
  publish(generation: number, city: ValidatedCity): boolean;
  clear(): void;
  failCurrent(): void;
  dispose(): void;
}>;

export function createStandalonePresentationCoordinator(options: Readonly<{
  documentTarget: PresentationDocument;
  root: PresentationRoot;
  failed(): void;
}>): StandalonePresentationCoordinator {
  const { documentTarget, root, failed } = options;
  let current: ActiveSession | undefined;
  let staging: ActiveSession | undefined;
  let disposed = false;

  const disposePresenter = (session: ActiveSession): void => {
    if (session.presenterDisposed) return;
    session.presenterDisposed = true;
    session.presenter.dispose();
  };

  const remove = (session: ActiveSession): void => {
    if (!session.active) return;
    session.active = false;
    session.state?.dispose();
    if (current === session) current = undefined;
    if (staging === session) staging = undefined;
    try { session.publication.rollback(); } catch {}
    try { disposePresenter(session); } catch {}
    try { root.replaceChildren(); } catch {}
    try { root.hidden = true; } catch {}
  };

  const failClosed = (session: ActiveSession): void => {
    if (!session.active || (current !== session && staging !== session)) return;
    remove(session);
    failed();
  };

  const clear = (): void => {
    const session = current ?? staging;
    if (session) remove(session);
    else {
      try { root.replaceChildren(); } catch {}
      try { root.hidden = true; } catch {}
    }
  };

  const publish = (generation: number, city: ValidatedCity): boolean => {
    if (disposed) return false;
    clear();
    let session: ActiveSession | undefined;
    let state: InventoryState | undefined;
    try {
      const sink: InventoryPublicationSink = Object.freeze({
        queryChanged: (...args) => state?.queryChanged(...args),
        sortChanged: (...args) => state?.sortChanged(...args),
        rowActivated: (...args) => state?.rowActivated(...args),
      });
      const publication = stageStandaloneInventoryPublication(documentTarget, city.inspection, generation, sink);
      const presenter = createCityPresenter<number>({
        host: publication.cityHost,
        resetControl: publication.resetControl,
        isEligible: (candidateGeneration) => !disposed
          && candidateGeneration === generation
          && session?.active === true
          && (current === session || staging === session),
        failed: () => { if (session) failClosed(session); },
      });
      session = { generation, publication, presenter, presenterDisposed: false, active: true };
      staging = session;
      root.replaceChildren(...publication.nodes);
      root.hidden = false;
      state = createInventoryState({
        inspection: city.inspection,
        generation,
        identity: publication.identity,
        publishProjection: (projection) => publication.setProjection(projection, state?.snapshot().selection ?? null),
        applyVisual: (hover, selection) => presenter.setVisualState(generation, hover, selection),
        publishSelection: (selection) => publication.setSelection(selection),
        failed: () => { if (session) failClosed(session); },
      });
      session.state = state;
      const staged = presenter.stage(generation, city.geometry, city.presentation, {
        hoverIndex(callbackGeneration, index) { state?.cityHover(callbackGeneration, publication.identity, index); },
        activationIndex(callbackGeneration, index) { state?.cityActivated(callbackGeneration, publication.identity, index); },
        selectionAction(callbackGeneration, action) { state?.selectionAction(callbackGeneration, publication.identity, action); },
        districtProjection() {},
      });
      if (staged.kind !== "staged") throw new Error("Standalone city staging failed");
      const committed = presenter.commit(staged.token);
      if (committed.kind !== "committed") throw new Error("Standalone city commit became stale");
      const visual = presenter.setVisualState(generation, null, null);
      if (visual.kind !== "applied") throw new Error("Standalone initial visual state failed");
      publication.commitCanvas(staged.canvas);
      if (!session.active || staging !== session || disposed) throw new Error("Standalone publication became stale");
      current = session;
      staging = undefined;
      return true;
    } catch {
      if (session) failClosed(session);
      else {
        try { root.replaceChildren(); } catch {}
        try { root.hidden = true; } catch {}
        failed();
      }
      return false;
    }
  };

  return Object.freeze({
    publish,
    clear,
    failCurrent() { if (current) failClosed(current); },
    dispose() {
      if (disposed) return;
      disposed = true;
      clear();
    },
  });
}
