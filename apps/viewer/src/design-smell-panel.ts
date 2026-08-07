import {
  DEFAULT_DESIGN_SMELL_CONFIGURATION,
  DESIGN_SMELL_PROTOCOL_VERSION,
  DESIGN_SMELL_RULE_CATALOG,
  type CityBuilding,
  type CityModel,
  type DesignSmellConfiguration,
  type DesignSmellEvaluation,
  type DesignSmellFinding,
  type DesignSmellId,
  type DesignSmellRuleResult,
  type DesignSmellSuppression,
  type SourceLanguage,
} from "../../../packages/core/src/index.js";
import {
  DesignSmellSuppressionStore,
  type DesignSmellSuppressionStore as Store,
} from "./design-smell-storage.js";
import { DESIGN_SMELL_BUILDING_LEGEND } from "./design-smell-visualization.js";
import { DesignSmellWorkerClient } from "./design-smell-worker-client.js";
import type { MetricMappingStorage } from "./metric-mapping-storage.js";

export const DESIGN_SMELL_PAGE_SIZE = 100;

export interface DesignSmellEvaluationClient {
  evaluate(
    model: CityModel,
    configuration: DesignSmellConfiguration,
    suppressions: readonly DesignSmellSuppression[],
  ): Promise<DesignSmellEvaluation>;
  cancel(): void;
  dispose(): void;
}

export interface DesignSmellPanelOptions {
  readonly onNavigate: (finding: DesignSmellFinding) => void;
  readonly onVisibleFindingsChange?: (
    findings: readonly DesignSmellFinding[],
  ) => void;
  readonly onQueryFactsChange?: (
    evaluation: DesignSmellEvaluation | undefined,
  ) => void;
  readonly storage?: MetricMappingStorage;
  readonly client?: DesignSmellEvaluationClient;
}

export interface DesignSmellPanel {
  setProject(model: CityModel): void;
  dispose(): void;
}

interface RuleControl {
  readonly input: HTMLInputElement;
  readonly details: HTMLElement;
}

function defaultStorage(window: Window | null): MetricMappingStorage {
  return (
    window?.localStorage ?? {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    }
  );
}

function element<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  name: K,
  text?: string,
): HTMLElementTagNameMap[K] {
  const result = document.createElement(name);
  if (text !== undefined) result.textContent = text;
  return result;
}

function configuration(
  enabled: ReadonlySet<DesignSmellId>,
): DesignSmellConfiguration {
  return {
    ...DEFAULT_DESIGN_SMELL_CONFIGURATION,
    rules: DESIGN_SMELL_RULE_CATALOG.map((rule) => ({
      id: rule.id,
      enabled:
        rule.availability === "available" && enabled.has(rule.id),
    })),
  };
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

export function formatDesignSmellThresholds(
  threshold: Readonly<Record<SourceLanguage, number>> | undefined,
): string {
  if (threshold === undefined) return "No threshold";
  return (
    `C# ${threshold.csharp.toLocaleString("en-US")}; ` +
    `TypeScript ${threshold.typescript.toLocaleString("en-US")}; ` +
    `JavaScript ${threshold.javascript.toLocaleString("en-US")}`
  );
}

export function designSmellFindingButtonText(
  finding: DesignSmellFinding,
  building?: Pick<CityBuilding, "name" | "path">,
): string {
  const subject =
    finding.evidence.subject === undefined
      ? ""
      : ` for ${finding.evidence.subject}`;
  const affectedBuilding =
    building === undefined
      ? `building ${finding.buildingId}`
      : `${building.name} (${building.path})`;
  return (
    `⚠ ${finding.ruleName} in ${affectedBuilding}: ` +
    `${finding.evidence.label}${subject} ` +
    `${finding.evidence.value.toLocaleString("en-US")} ` +
    `(threshold ${finding.evidence.threshold.toLocaleString("en-US")})`
  );
}

export function installDesignSmellPanel(
  root: HTMLElement,
  options: DesignSmellPanelOptions,
): DesignSmellPanel {
  const document = root.ownerDocument;
  const store: Store = new DesignSmellSuppressionStore(
    options.storage ?? defaultStorage(document.defaultView),
  );
  const client =
    options.client ?? new DesignSmellWorkerClient();
  const requestedEnabled = new Set<DesignSmellId>(
    DESIGN_SMELL_RULE_CATALOG.filter(
      (rule) => rule.availability === "available",
    ).map((rule) => rule.id),
  );
  const visibleRules = new Set<DesignSmellId>(requestedEnabled);
  const controls = new Map<DesignSmellId, RuleControl>();
  let buildingsById: ReadonlyMap<string, CityBuilding> = new Map();
  let project: CityModel | undefined;
  let evaluation: DesignSmellEvaluation | undefined;
  let page = 0;
  let generation = 0;
  let disposed = false;

  const heading = element(document, "div");
  heading.className = "panel-heading";
  const titleBox = element(document, "div");
  const eyebrow = element(document, "p", "Explainable findings");
  eyebrow.className = "eyebrow";
  const title = element(document, "h2", "Design smells");
  title.id = "design-smell-title";
  titleBox.append(eyebrow, title);
  const count = element(document, "strong", "0 findings");
  count.className = "design-smell-count";
  heading.append(titleBox, count);

  const help = element(
    document,
    "p",
    "Heuristic findings are evidence to inspect, not AI advice or a quality verdict. " +
      "Suppressing a finding suppresses that rule for the entire building in this browser.",
  );
  help.className = "design-smell-help";

  const filters = element(document, "fieldset");
  filters.className = "design-smell-filters";
  filters.append(element(document, "legend", "Visible smell rules"));

  const unavailable = element(document, "ul");
  unavailable.className = "design-smell-unavailable";
  unavailable.setAttribute(
    "aria-label",
    "Unavailable design-smell facts",
  );

  const status = element(
    document,
    "p",
    "Load a city to evaluate its recorded facts.",
  );
  status.className = "design-smell-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.setAttribute("aria-atomic", "true");

  const colorLegend = element(document, "ul");
  colorLegend.className = "design-smell-color-legend";
  colorLegend.setAttribute("aria-label", "Building color legend");
  for (const { label, color } of DESIGN_SMELL_BUILDING_LEGEND) {
    const item = element(document, "li");
    const swatch = element(document, "span");
    swatch.className = "design-smell-color-swatch";
    swatch.style.backgroundColor = color;
    swatch.setAttribute("aria-hidden", "true");
    item.append(swatch, element(document, "span", label));
    colorLegend.append(item);
  }

  const results = element(document, "ol");
  results.className = "design-smell-results";
  results.setAttribute("aria-label", "Design smell findings");

  const pagination = element(document, "nav");
  pagination.className = "design-smell-pagination";
  pagination.setAttribute("aria-label", "Design smell result pages");
  const previous = element(document, "button", "Previous");
  previous.type = "button";
  const pageStatus = element(document, "span", "No results");
  const next = element(document, "button", "Next");
  next.type = "button";
  pagination.append(previous, pageStatus, next);

  const optionsDisclosure = element(document, "details");
  optionsDisclosure.className = "design-smell-options";
  const optionsSummary = element(document, "summary", "Rules and filters");
  optionsDisclosure.append(optionsSummary, help, filters, unavailable);

  root.replaceChildren(
    heading,
    status,
    colorLegend,
    results,
    pagination,
    optionsDisclosure,
  );

  const filteredFindings = (): readonly DesignSmellFinding[] =>
    (evaluation?.findings ?? []).filter(
      (finding) =>
        !finding.suppressed && visibleRules.has(finding.ruleId),
    );

  const renderResults = (notifyVisibleFindings = true): void => {
    const shown = filteredFindings();
    if (notifyVisibleFindings) {
      options.onVisibleFindingsChange?.(shown);
    }
    const affected = new Set(
      shown.map(({ buildingId }) => buildingId),
    ).size;
    count.textContent =
      `${shown.length.toLocaleString("en-US")} visible ` +
      `${shown.length === 1 ? "finding" : "findings"} · ` +
      `${affected.toLocaleString("en-US")} affected ` +
      `${affected === 1 ? "building" : "buildings"}`;

    const pageCount = Math.max(
      1,
      Math.ceil(shown.length / DESIGN_SMELL_PAGE_SIZE),
    );
    page = Math.min(page, pageCount - 1);
    const start = page * DESIGN_SMELL_PAGE_SIZE;
    const end = Math.min(start + DESIGN_SMELL_PAGE_SIZE, shown.length);
    const window = shown.slice(start, end);
    results.start = start + 1;
    results.replaceChildren(
      ...window.map((finding) => {
        const item = element(document, "li");
        item.className =
          `design-smell-finding severity-${finding.severity}`;
        const navigate = element(
          document,
          "button",
          designSmellFindingButtonText(
            finding,
            buildingsById.get(finding.buildingId),
          ),
        );
        navigate.type = "button";
        navigate.addEventListener("click", () =>
          options.onNavigate(finding),
        );
        const evidence = element(
          document,
          "p",
          `Rule ${finding.ruleId} v${finding.ruleVersion} · ` +
            `${languageLabel(finding.language)} · ` +
            `${finding.severity}. ` +
            (finding.evidence.line === undefined
              ? ""
              : `Line ${finding.evidence.line.toLocaleString("en-US")}.`),
        );
        const suppress = element(
          document,
          "button",
          "Suppress rule for building",
        );
        suppress.type = "button";
        suppress.className = "design-smell-suppress";
        suppress.addEventListener("click", () => {
          if (
            project !== undefined &&
            store.save(project, {
              protocolVersion: DESIGN_SMELL_PROTOCOL_VERSION,
              buildingId: finding.buildingId,
              ruleId: finding.ruleId,
              reason: "False positive dismissed in this browser.",
            })
          ) {
            void evaluate();
          }
        });
        item.append(navigate, evidence, suppress);
        return item;
      }),
    );
    pagination.hidden = shown.length <= DESIGN_SMELL_PAGE_SIZE;
    previous.disabled = page === 0;
    next.disabled = page >= pageCount - 1;
    pageStatus.textContent =
      shown.length === 0
        ? "No results"
        : `Showing ${(start + 1).toLocaleString("en-US")}–` +
          `${end.toLocaleString("en-US")} of ` +
          `${shown.length.toLocaleString("en-US")}`;
  };

  const renderRuleAvailability = (
    current: DesignSmellEvaluation,
  ): void => {
    unavailable.replaceChildren();
    for (const result of current.results) {
      const control = controls.get(result.rule.id)!;
      const unavailableRule = result.availability === "unavailable";
      control.input.disabled = unavailableRule;
      control.input.checked =
        !unavailableRule && requestedEnabled.has(result.rule.id);
      if (unavailableRule) {
        visibleRules.delete(result.rule.id);
      } else if (requestedEnabled.has(result.rule.id)) {
        visibleRules.add(result.rule.id);
      }
      control.details.textContent =
        `Rule v${result.rule.version}. ` +
        `${formatDesignSmellThresholds(result.threshold)}.`;

      if (unavailableRule) {
        unavailable.append(
          element(
            document,
            "li",
            `${result.rule.name}: unavailable — ${result.reason}`,
          ),
        );
      }
      for (const language of [
        "csharp",
        "typescript",
        "javascript",
      ] as const) {
        const languageState = result.languageAvailability[language];
        if (
          languageState.availability === "unavailable" ||
          languageState.reason !== undefined
        ) {
          unavailable.append(
            element(
              document,
              "li",
              `${result.rule.name} — ${languageLabel(language)}: ` +
                `${languageState.availability}` +
                (languageState.reason === undefined
                  ? ""
                  : ` — ${languageState.reason}`),
            ),
          );
        }
      }
    }
  };

  const evaluate = async (): Promise<void> => {
    if (project === undefined || disposed) return;
    const currentGeneration = ++generation;
    const snapshot = project;
    status.textContent =
      "Evaluating bounded design-smell rules in a worker…";
    root.setAttribute("aria-busy", "true");
    try {
      const result = await client.evaluate(
        snapshot,
        configuration(requestedEnabled),
        store.list(snapshot),
      );
      if (
        disposed ||
        currentGeneration !== generation ||
        project !== snapshot
      ) {
        return;
      }
      evaluation = result;
      options.onQueryFactsChange?.(result);
      page = 0;
      renderRuleAvailability(result);
      renderResults();
      status.textContent =
        `${result.visibleFindings.length.toLocaleString("en-US")} ` +
        `unsuppressed findings. Rule catalog ` +
        `${result.ruleCatalogVersion}; exact active thresholds and ` +
        "measured evidence are shown. Buildings use their highest visible " +
        "severity; gray means no visible finding, not verified clean.";
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      if (currentGeneration === generation) {
        evaluation = undefined;
        options.onQueryFactsChange?.(undefined);
        visibleRules.clear();
        renderResults();
        status.textContent =
          error instanceof Error
            ? error.message
            : "Design-smell evaluation failed.";
      }
    } finally {
      if (currentGeneration === generation) {
        root.setAttribute("aria-busy", "false");
      }
    }
  };

  for (const rule of DESIGN_SMELL_RULE_CATALOG) {
    const label = element(document, "label");
    const input = element(document, "input");
    input.type = "checkbox";
    input.checked = rule.availability === "available";
    input.disabled = rule.availability === "unavailable";
    input.setAttribute(
      "aria-label",
      `Show ${rule.name} findings`,
    );
    const name = element(
      document,
      "span",
      ` ${rule.name}`,
    );
    const details = element(
      document,
      "small",
      `Rule v${rule.version}. ` +
        `${formatDesignSmellThresholds(
          "threshold" in rule ? rule.threshold : undefined,
        )}.`,
    );
    label.append(input, name, details);
    filters.append(label);
    controls.set(rule.id, { input, details });
    input.addEventListener("change", () => {
      if (input.checked) {
        requestedEnabled.add(rule.id);
        visibleRules.add(rule.id);
      } else {
        requestedEnabled.delete(rule.id);
        visibleRules.delete(rule.id);
      }
      page = 0;
      renderResults();
      void evaluate();
    });
  }

  previous.addEventListener("click", () => {
    if (page > 0) {
      page -= 1;
      renderResults(false);
      results.querySelector<HTMLButtonElement>("button")?.focus();
    }
  });
  next.addEventListener("click", () => {
    const pageCount = Math.ceil(
      filteredFindings().length / DESIGN_SMELL_PAGE_SIZE,
    );
    if (page + 1 < pageCount) {
      page += 1;
      renderResults(false);
      results.querySelector<HTMLButtonElement>("button")?.focus();
    }
  });

  return {
    setProject: (model): void => {
      generation += 1;
      client.cancel();
      project = model;
      buildingsById = new Map(
        model.buildings.map((building) => [building.id, building]),
      );
      evaluation = undefined;
      options.onQueryFactsChange?.(undefined);
      page = 0;
      visibleRules.clear();
      for (const rule of DESIGN_SMELL_RULE_CATALOG) {
        const control = controls.get(rule.id)!;
        control.input.disabled = rule.availability === "unavailable";
        control.input.checked =
          rule.availability === "available" &&
          requestedEnabled.has(rule.id);
        if (control.input.checked) visibleRules.add(rule.id);
      }
      renderResults();
      void evaluate();
    },
    dispose: (): void => {
      disposed = true;
      generation += 1;
      client.dispose();
      buildingsById = new Map();
      options.onVisibleFindingsChange?.([]);
      options.onQueryFactsChange?.(undefined);
      root.replaceChildren();
    },
  };
}
