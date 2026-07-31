import type {
  CityBuilding,
  CityModel,
  RiskBand,
  SourceLanguage,
} from "../../../packages/core/src/model.js";
import {
  ADVANCED_QUERY_METRIC_SCHEMA_VERSION,
  ADVANCED_QUERY_VERSION,
  createAdvancedQueryPreset,
  type AdvancedQueryCondition,
  type AdvancedQueryContext,
  type AdvancedQueryDefinition,
  type AdvancedQueryEvaluation,
  type AdvancedQueryPreset,
} from "./advanced-query.js";
import {
  AdvancedQueryStore,
  type AdvancedQueryStorage,
} from "./advanced-query-storage.js";
import { AdvancedQueryWorkerClient } from "./advanced-query-worker-client.js";
import {
  EMPTY_ADVANCED_SELECTION,
  clearAdvancedSelection,
  createAdvancedSelectionSet,
  replaceAdvancedSelection,
  retainAdvancedSelection,
  selectAdvancedBuilding,
  setAdvancedSelectionOverlay,
  type AdvancedSelectionIntent,
  type AdvancedSelectionState,
} from "./advanced-selection.js";
import { metricMappingProjectIdentity } from "./metric-mapping-storage.js";

export const MAXIMUM_ADVANCED_COMPARISON_ROWS = 100;

export interface AdvancedQueryPanelContext {
  readonly selectedBuildingId?: string;
  readonly selectedDistrictId?: string;
  readonly queryContext?: AdvancedQueryContext;
}

export interface AdvancedQueryExport {
  readonly fileName: string;
  readonly content: string;
}

export interface AdvancedQueryPanelOptions {
  readonly workerClient?: AdvancedQueryWorkerClient;
  readonly storage?: AdvancedQueryStorage;
  readonly context: () => AdvancedQueryPanelContext;
  readonly onSelectionChange: (
    state: AdvancedSelectionState,
  ) => void;
  readonly onFocus: (buildingIds: readonly string[]) => void;
  readonly onIsolate: (buildingIds: readonly string[]) => void;
  readonly onExport?: (artifact: AdvancedQueryExport) => void;
}

export interface AdvancedQueryPanelController {
  readonly selection: AdvancedSelectionState;
  setProject(model: CityModel): void;
  refreshContext(): void;
  selectFromScene(
    buildingId: string,
    intent?: AdvancedSelectionIntent,
  ): void;
  clearSelection(): void;
  dispose(): void;
}

type QueryPresetValue = AdvancedQueryPreset | "custom";

function control<T extends HTMLElement>(root: HTMLElement, id: string): T {
  const candidate = root.querySelector<T>(`#${id}`);
  if (candidate === null) {
    throw new Error(`Missing advanced-query control #${id}.`);
  }
  return candidate;
}

function unavailableStorage(): AdvancedQueryStorage {
  return {
    getItem: () => null,
    setItem: () => {
      throw new Error("Browser storage is unavailable.");
    },
  };
}

function browserStorage(): AdvancedQueryStorage {
  try {
    return window.localStorage;
  } catch {
    return unavailableStorage();
  }
}

export function installAdvancedQueryPanel(
  root: HTMLElement,
  options: AdvancedQueryPanelOptions,
): AdvancedQueryPanelController {
  const preset = control<HTMLSelectElement>(root, "advanced-query-preset");
  const filters = control<HTMLFieldSetElement>(root, "advanced-query-filters");
  const text = control<HTMLInputElement>(root, "advanced-query-text");
  const language = control<HTMLSelectElement>(root, "advanced-query-language");
  const risk = control<HTMLSelectElement>(root, "advanced-query-risk");
  const complexity = control<HTMLInputElement>(
    root,
    "advanced-query-complexity",
  );
  const dependencies = control<HTMLInputElement>(
    root,
    "advanced-query-dependencies",
  );
  const smell = control<HTMLInputElement>(root, "advanced-query-smell");
  const changed = control<HTMLInputElement>(root, "advanced-query-changed");
  const limit = control<HTMLSelectElement>(root, "advanced-query-limit");
  const run = control<HTMLButtonElement>(root, "advanced-query-run");
  const status = control<HTMLElement>(root, "advanced-query-status");
  const selectAll = control<HTMLButtonElement>(
    root,
    "advanced-query-select-all",
  );
  const clear = control<HTMLButtonElement>(root, "advanced-query-clear");
  const overlay = control<HTMLButtonElement>(root, "advanced-query-overlay");
  const results = control<HTMLUListElement>(root, "advanced-query-results");
  const comparison = control<HTMLElement>(
    root,
    "advanced-query-comparison",
  );
  const comparisonSummary = control<HTMLElement>(
    root,
    "advanced-query-comparison-summary",
  );
  const comparisonBody = control<HTMLTableSectionElement>(
    root,
    "advanced-query-comparison-body",
  );
  const focus = control<HTMLButtonElement>(root, "advanced-query-focus");
  const isolate = control<HTMLButtonElement>(root, "advanced-query-isolate");
  const compare = control<HTMLButtonElement>(root, "advanced-query-compare");
  const exportButton = control<HTMLButtonElement>(
    root,
    "advanced-query-export",
  );
  const saveName = control<HTMLInputElement>(
    root,
    "advanced-query-save-name",
  );
  const saveQuery = control<HTMLButtonElement>(root, "advanced-query-save");
  const saveSelection = control<HTMLButtonElement>(
    root,
    "advanced-selection-save",
  );
  const savedQueries = control<HTMLSelectElement>(
    root,
    "advanced-query-saved",
  );
  const savedSelections = control<HTMLSelectElement>(
    root,
    "advanced-selection-saved",
  );

  const worker = options.workerClient ?? new AdvancedQueryWorkerClient();
  const store = new AdvancedQueryStore(
    options.storage ?? browserStorage(),
  );
  let model: CityModel | undefined;
  let projectIdentity: string | undefined;
  let definition: AdvancedQueryDefinition | undefined;
  let evaluation: AdvancedQueryEvaluation | undefined;
  let selection = EMPTY_ADVANCED_SELECTION;
  let generation = 0;
  let disposed = false;

  const resultIds = (): readonly string[] =>
    evaluation?.results.map(({ buildingId }) => buildingId) ?? [];

  const renderSelection = (notify = true): void => {
    const selected = new Set(selection.buildingIds);
    for (const button of results.querySelectorAll<HTMLButtonElement>(
      ".advanced-query-result",
    )) {
      const id = button.dataset["buildingId"];
      const active = id !== undefined && selected.has(id);
      button.setAttribute("aria-selected", String(active));
      button.classList.toggle("is-selected", active);
      button.classList.toggle(
        "is-primary",
        id === selection.primaryBuildingId,
      );
    }
    const count = selection.buildingIds.length;
    clear.disabled = count === 0;
    overlay.disabled = count === 0;
    overlay.setAttribute(
      "aria-pressed",
      String(selection.overlayVisible),
    );
    overlay.textContent = selection.overlayVisible
      ? "Overlay on"
      : "Overlay off";
    focus.disabled = count === 0;
    isolate.disabled = count === 0;
    compare.disabled = count < 2;
    exportButton.disabled = count === 0;
    saveSelection.disabled =
      count === 0 || saveName.value.trim().length === 0;
    comparison.hidden = true;
    if (notify) options.onSelectionChange(selection);
  };

  const renderEvaluation = (): void => {
    results.replaceChildren();
    const current = evaluation;
    if (current === undefined) {
      selectAll.disabled = true;
      renderSelection(false);
      return;
    }
    selectAll.disabled = current.results.length === 0;
    for (const entry of current.results) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "advanced-query-result";
      button.setAttribute("role", "option");
      button.dataset["buildingId"] = entry.buildingId;
      button.innerHTML =
        `<span class="advanced-query-result-name"></span>` +
        `<span class="advanced-query-result-path"></span>` +
        `<span class="advanced-query-result-reasons"></span>`;
      button.querySelector<HTMLElement>(
        ".advanced-query-result-name",
      )!.textContent = entry.name;
      button.querySelector<HTMLElement>(
        ".advanced-query-result-path",
      )!.textContent = entry.path;
      button.querySelector<HTMLElement>(
        ".advanced-query-result-reasons",
      )!.textContent =
        entry.reasons.length === 0
          ? "Ranked by query sort"
          : entry.reasons.join(" · ");
      button.addEventListener("click", (event) => {
        selection = selectAdvancedBuilding(selection, entry.buildingId, {
          additive: event.ctrlKey || event.metaKey,
          range: event.shiftKey,
          orderedBuildingIds: resultIds(),
        });
        renderSelection();
      });
      item.append(button);
      results.append(item);
    }
    renderSelection(false);
  };

  const renderSaved = (): void => {
    const snapshot = model === undefined
      ? { queries: [], selectionSets: [] }
      : store.load(model);
    replaceSelectOptions(
      savedQueries,
      "None saved",
      snapshot.queries.map(({ name }) => name),
    );
    replaceSelectOptions(
      savedSelections,
      "None saved",
      snapshot.selectionSets.map(({ name }) => name),
    );
  };

  const renderPreset = (): void => {
    filters.disabled = preset.value !== "custom";
  };

  const currentDefinition = (): AdvancedQueryDefinition => {
    const selected = preset.value as QueryPresetValue;
    const queryLimit = Number(limit.value);
    if (selected !== "custom") {
      const contextual = options.context();
      return {
        ...createAdvancedQueryPreset(selected, contextual),
        limit: queryLimit,
      };
    }
    const conditions: AdvancedQueryCondition[] = [];
    if (text.value.trim().length > 0) {
      conditions.push({
        kind: "text",
        field: "name-or-path",
        operator: "contains",
        value: text.value.trim(),
      });
    }
    if (isLanguage(language.value)) {
      conditions.push({ kind: "language", values: [language.value] });
    }
    if (isRisk(risk.value)) {
      conditions.push({ kind: "risk", values: [risk.value] });
    }
    const minimumComplexity = nonNegativeInteger(complexity.value);
    if (minimumComplexity > 0) {
      conditions.push({
        kind: "metric",
        metric: "maximumComplexity",
        operator: "at-least",
        value: minimumComplexity,
      });
    }
    const minimumDependencies = nonNegativeInteger(dependencies.value);
    if (minimumDependencies > 0) {
      conditions.push({
        kind: "dependency-count",
        direction: "either",
        minimum: minimumDependencies,
      });
    }
    if (changed.checked) {
      conditions.push({
        kind: "changed",
        changeKinds: ["added", "changed", "removed"],
      });
    }
    if (smell.value.trim().length > 0) {
      conditions.push({
        kind: "smell",
        ruleId: smell.value.trim(),
      });
    }
    return {
      version: ADVANCED_QUERY_VERSION,
      id: "custom:viewer",
      name: "Custom filters",
      match: "all",
      conditions,
      sort: {
        key:
          minimumComplexity > 0
            ? "maximumComplexity"
            : minimumDependencies > 0
              ? "dependency-count"
              : "path",
        direction:
          minimumComplexity > 0 || minimumDependencies > 0
            ? "descending"
            : "ascending",
      },
      limit: queryLimit,
      capabilities: {
        modelSchemaVersion: "1.0",
        metricSchemaVersion: ADVANCED_QUERY_METRIC_SCHEMA_VERSION,
        ...(smell.value.trim().length === 0
          ? {}
          : { ruleSchemaVersion: "codecity.design-smells/1" }),
      },
    };
  };

  const runDefinition = async (
    nextDefinition: AdvancedQueryDefinition,
  ): Promise<void> => {
    if (model === undefined) return;
    const requestGeneration = ++generation;
    definition = nextDefinition;
    run.disabled = true;
    status.textContent = "Evaluating query…";
    saveQuery.disabled = true;
    try {
      const context = options.context().queryContext ?? {};
      const next = await worker.evaluate(model, nextDefinition, context);
      if (disposed || requestGeneration !== generation) return;
      evaluation = next;
      renderEvaluation();
      const visible = next.results.length;
      status.textContent =
        `${next.totalCount.toLocaleString()} ${next.totalCount === 1 ? "match" : "matches"}` +
        (next.truncated
          ? ` · showing ${visible.toLocaleString()}`
          : "") +
        (next.unavailableReasons.length > 0
          ? ` · ${next.unavailableReasons.join(" ")}`
          : "");
    } catch (error) {
      if (
        disposed ||
        requestGeneration !== generation ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        return;
      }
      evaluation = undefined;
      renderEvaluation();
      status.textContent =
        error instanceof Error
          ? error.message
          : "The query could not be evaluated.";
    } finally {
      if (!disposed && requestGeneration === generation) {
        run.disabled = false;
        saveQuery.disabled =
          definition === undefined || saveName.value.trim().length === 0;
      }
    }
  };

  preset.addEventListener("change", renderPreset);
  run.addEventListener("click", () => {
    try {
      void runDefinition(currentDefinition());
    } catch (error) {
      status.textContent =
        error instanceof Error ? error.message : "The query is invalid.";
    }
  });
  selectAll.addEventListener("click", () => {
    selection = replaceAdvancedSelection(selection, resultIds());
    renderSelection();
  });
  clear.addEventListener("click", () => {
    selection = clearAdvancedSelection(selection);
    renderSelection();
  });
  overlay.addEventListener("click", () => {
    selection = setAdvancedSelectionOverlay(
      selection,
      !selection.overlayVisible,
    );
    renderSelection();
  });
  focus.addEventListener("click", () => {
    if (selection.buildingIds.length > 0) {
      options.onFocus(selection.buildingIds);
    }
  });
  isolate.addEventListener("click", () => {
    if (selection.buildingIds.length > 0) {
      options.onIsolate(selection.buildingIds);
    }
  });
  compare.addEventListener("click", () => {
    if (model === undefined) return;
    const selected = selectedBuildings(model, selection);
    const visibleCount = renderComparisonTable(
      comparisonBody,
      selected,
    );
    comparisonSummary.textContent = comparisonText(
      selected,
      visibleCount,
    );
    comparison.hidden = false;
  });
  exportButton.addEventListener("click", () => {
    if (model === undefined || selection.buildingIds.length === 0) return;
    const artifact = {
      fileName: "code-city-selection.json",
      content: JSON.stringify(
        {
          version: "codecity.query-export/1",
          query: definition,
          selection: createAdvancedSelectionSet(
            saveName.value.trim() || "Exported selection",
            selection.buildingIds,
          ),
          buildings: selectedBuildings(model, selection),
        },
        null,
        2,
      ),
    };
    (options.onExport ?? downloadExport)(artifact);
  });
  saveName.addEventListener("input", () => {
    saveQuery.disabled =
      definition === undefined || saveName.value.trim().length === 0;
    saveSelection.disabled =
      selection.buildingIds.length === 0 ||
      saveName.value.trim().length === 0;
  });
  saveQuery.addEventListener("click", () => {
    if (model === undefined || definition === undefined) return;
    const result = store.saveQuery(model, saveName.value, definition);
    status.textContent = result.message;
    if (result.ok) renderSaved();
  });
  saveSelection.addEventListener("click", () => {
    if (model === undefined) return;
    try {
      const result = store.saveSelectionSet(
        model,
        createAdvancedSelectionSet(
          saveName.value,
          selection.buildingIds,
        ),
      );
      status.textContent = result.message;
      if (result.ok) renderSaved();
    } catch (error) {
      status.textContent =
        error instanceof Error
          ? error.message
          : "The selection could not be saved.";
    }
  });
  savedQueries.addEventListener("change", () => {
    if (model === undefined || savedQueries.value === "") return;
    const saved = store
      .load(model)
      .queries.find(({ name }) => name === savedQueries.value);
    if (saved !== undefined) void runDefinition(saved.definition);
  });
  savedSelections.addEventListener("change", () => {
    if (model === undefined || savedSelections.value === "") return;
    const saved = store
      .load(model)
      .selectionSets.find(({ name }) => name === savedSelections.value);
    if (saved === undefined) return;
    selection = replaceAdvancedSelection(
      selection,
      saved.buildingIds.filter((id) =>
        model!.buildings.some((building) => building.id === id),
      ),
    );
    renderSelection();
    status.textContent =
      `${selection.buildingIds.length.toLocaleString()} saved buildings selected.`;
  });
  results.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = [
      ...results.querySelectorAll<HTMLButtonElement>(
        ".advanced-query-result",
      ),
    ];
    const current = buttons.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    if (current < 0) return;
    event.preventDefault();
    const direction = event.key === "ArrowDown" ? 1 : -1;
    buttons[(current + direction + buttons.length) % buttons.length]?.focus();
  });

  renderPreset();
  renderSelection(false);

  return {
    get selection() {
      return selection;
    },
    setProject(nextModel) {
      const nextProjectIdentity = metricMappingProjectIdentity(nextModel);
      const sameProject = projectIdentity === nextProjectIdentity;
      projectIdentity = nextProjectIdentity;
      model = nextModel;
      generation += 1;
      worker.cancel();
      selection = sameProject
        ? retainAdvancedSelection(selection, nextModel)
        : EMPTY_ADVANCED_SELECTION;
      evaluation = undefined;
      results.replaceChildren();
      if (!sameProject) definition = undefined;
      status.textContent =
        sameProject && definition !== undefined
          ? "Refreshing query for the current frame…"
          : "Choose a query to inspect this city.";
      renderSaved();
      renderSelection();
      if (sameProject && definition !== undefined) {
        void runDefinition(definition);
      }
    },
    refreshContext() {
      generation += 1;
      worker.cancel();
      evaluation = undefined;
      results.replaceChildren();
      if (definition === undefined) return;
      status.textContent = "Refreshing query context...";
      void runDefinition(definition);
    },
    selectFromScene(buildingId, intent = {}) {
      const ordered =
        intent.orderedBuildingIds ??
        evaluation?.results.map((entry) => entry.buildingId) ??
        model?.buildings.map((building) => building.id) ??
        [];
      try {
        selection = selectAdvancedBuilding(selection, buildingId, {
          ...intent,
          ...(intent.range ? { orderedBuildingIds: ordered } : {}),
        });
        renderSelection();
      } catch (error) {
        status.textContent =
          error instanceof Error
            ? error.message
            : "The building selection could not be changed.";
      }
    },
    clearSelection() {
      selection = clearAdvancedSelection(selection);
      renderSelection();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      worker.dispose();
    },
  };
}

function selectedBuildings(
  model: CityModel,
  selection: AdvancedSelectionState,
): readonly CityBuilding[] {
  const buildings = new Map(
    model.buildings.map((building) => [building.id, building]),
  );
  return selection.buildingIds
    .map((id) => buildings.get(id))
    .filter((building): building is CityBuilding => building !== undefined);
}

function comparisonText(
  buildings: readonly CityBuilding[],
  visibleCount: number,
): string {
  if (buildings.length < 2) return "Select at least two buildings.";
  const values = (
    key: keyof CityBuilding["metrics"],
  ): readonly number[] => buildings.map(({ metrics }) => metrics[key]);
  const range = (source: readonly number[]): string =>
    `${Math.min(...source).toLocaleString()}–${Math.max(...source).toLocaleString()}`;
  const languages = new Set(buildings.map(({ language }) => language));
  const risks = new Set(buildings.map(({ risk }) => risk));
  const tableScope =
    visibleCount < buildings.length
      ? ` Table shows the first ${visibleCount.toLocaleString()} of ${buildings.length.toLocaleString()} selected buildings.`
      : ` Table shows all ${visibleCount.toLocaleString()} selected buildings.`;
  return (
    `${buildings.length.toLocaleString()} buildings · ` +
    `SLOC ${range(values("sloc"))} · ` +
    `complexity ${range(values("maximumComplexity"))} · ` +
    `${languages.size.toLocaleString()} languages · ` +
    `${risks.size.toLocaleString()} risk bands.` +
    tableScope
  );
}

function renderComparisonTable(
  body: HTMLTableSectionElement,
  buildings: readonly CityBuilding[],
): number {
  body.replaceChildren();
  const visible = boundedAdvancedComparisonBuildings(buildings);
  for (const building of visible) {
    const row = document.createElement("tr");
    row.dataset["buildingId"] = building.id;
    const identity = document.createElement("th");
    identity.scope = "row";
    identity.className = "advanced-query-comparison-building";
    const name = document.createElement("span");
    name.textContent = building.name;
    const path = document.createElement("span");
    path.className = "advanced-query-comparison-path";
    path.textContent = building.path;
    identity.append(name, path);
    row.append(
      identity,
      comparisonCell(languageLabel(building.language)),
      comparisonCell(riskLabel(building.risk)),
      comparisonCell(building.metrics.sloc.toLocaleString()),
      comparisonCell(building.metrics.decisionLoad.toLocaleString()),
      comparisonCell(
        building.metrics.maximumComplexity.toLocaleString(),
      ),
      comparisonCell(
        building.metrics.executableUnitCount.toLocaleString(),
      ),
    );
    body.append(row);
  }
  return visible.length;
}

export function boundedAdvancedComparisonBuildings(
  buildings: readonly CityBuilding[],
): readonly CityBuilding[] {
  return Object.freeze(
    buildings.slice(0, MAXIMUM_ADVANCED_COMPARISON_ROWS),
  );
}

function comparisonCell(value: string): HTMLTableCellElement {
  const cell = document.createElement("td");
  cell.textContent = value;
  return cell;
}

function languageLabel(language: SourceLanguage): string {
  switch (language) {
    case "csharp":
      return "C#";
    case "typescript":
      return "TypeScript";
    case "javascript":
      return "JavaScript";
  }
}

function riskLabel(risk: RiskBand): string {
  return risk
    .split("-")
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

function replaceSelectOptions(
  select: HTMLSelectElement,
  emptyLabel: string,
  names: readonly string[],
): void {
  const previous = select.value;
  select.replaceChildren();
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = emptyLabel;
  select.append(empty);
  for (const name of names) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    select.append(option);
  }
  select.value = names.includes(previous) ? previous : "";
}

function nonNegativeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RangeError("Query thresholds must be non-negative integers.");
  }
  return parsed;
}

function isLanguage(value: string): value is SourceLanguage {
  return ["csharp", "typescript", "javascript"].includes(value);
}

function isRisk(value: string): value is RiskBand {
  return ["low", "moderate", "high", "very-high"].includes(value);
}

function downloadExport(artifact: AdvancedQueryExport): void {
  const url = URL.createObjectURL(
    new Blob([artifact.content], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = artifact.fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
