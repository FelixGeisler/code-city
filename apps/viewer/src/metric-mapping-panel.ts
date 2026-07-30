import {
  describeMetricMapping,
  MAPPABLE_BUILDING_METRICS,
  METRIC_MAPPING_PRESET_CATALOG,
  validateMetricMappingDefinition,
  type CityModel,
  type MetricColorPaletteEntryV1,
  type MetricMappingDefinitionV1,
  type MetricNormalizationFormula,
  type MetricSourceKey,
} from "../../../packages/core/src/index.js";
import {
  MetricMappingController,
  type MetricMappingControllerState,
  type MetricMappingProjectionClient,
} from "./metric-mapping-controller.js";
import {
  MetricMappingConfigurationStore,
  type MetricMappingStorage,
} from "./metric-mapping-storage.js";

const METRIC_LABELS: Readonly<Record<MetricSourceKey, string>> = {
  sloc: "Source lines of code (SLOC)",
  decisionLoad: "Decision load",
  maximumComplexity: "Maximum complexity",
  executableUnitCount: "Executable-unit count",
};

interface MetricChannelElements {
  readonly metric: HTMLSelectElement;
  readonly normalization: HTMLSelectElement;
  readonly cap: HTMLInputElement;
  readonly formula: HTMLParagraphElement;
}

export interface MetricMappingPanelOptions {
  readonly client?: MetricMappingProjectionClient;
  readonly storage?: MetricMappingStorage;
  readonly onModelChange: (
    model: CityModel,
    phase: "committed" | "preview",
  ) => void;
  readonly onPreviewStateChange?: (active: boolean) => void;
}

export interface MetricMappingPanelController {
  readonly state: MetricMappingControllerState;
  setProject(model: CityModel): void;
  cancelPreview(): void;
  dispose(): void;
}

function required<T extends HTMLElement>(
  root: HTMLElement,
  id: string,
): T {
  const candidate = root.querySelector<T>(`#${id}`);
  if (!candidate) {
    throw new Error(`Missing metric mapping control #${id}.`);
  }
  return candidate;
}

function mappingCopy(
  mapping: MetricMappingDefinitionV1,
): MetricMappingDefinitionV1 {
  return structuredClone(mapping);
}

export function unnamedMetricMappingDefinition(
  mapping: MetricMappingDefinitionV1,
): MetricMappingDefinitionV1 {
  return validateMetricMappingDefinition({
    ...mapping,
    id: "custom-mapping",
    name: "Custom",
    provenance: {
      ...mapping.provenance,
      kind: "custom",
      description:
        "Project-scoped viewer mapping derived from an explicit user configuration.",
    },
  });
}

export function metricMappingWithChannels(
  mapping: MetricMappingDefinitionV1,
  channels: MetricMappingDefinitionV1["channels"],
): MetricMappingDefinitionV1 {
  return {
    ...mapping,
    channels: {
      ...mapping.channels,
      ...channels,
    },
  };
}

export function namedMetricMappingDefinition(
  mapping: MetricMappingDefinitionV1,
  name: string,
): MetricMappingDefinitionV1 {
  return {
    ...mapping,
    id: safeCustomId(name),
    name,
    provenance: {
      ...mapping.provenance,
      kind: "custom",
      description: `Project-scoped viewer configuration “${name}”.`,
    },
  };
}

function mappingSignature(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(mappingSignature).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, child]) =>
          `${JSON.stringify(key)}:${mappingSignature(child)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isMetric(value: string): value is MetricSourceKey {
  return MAPPABLE_BUILDING_METRICS.some((metric) => metric === value);
}

function isNormalization(
  value: string,
): value is MetricNormalizationFormula {
  return value === "linear-cap-v1" || value === "log1p-cap-v1";
}

export function formatMetricMappingNumber(value: number): string {
  return Number.isInteger(value)
    ? value.toLocaleString("en-US")
    : value.toString();
}

function normalizedFormula(
  formula: MetricNormalizationFormula,
  cap: number,
): string {
  return formula === "linear-cap-v1"
    ? `n = min(1, raw / ${formatMetricMappingNumber(cap)})`
    : `n = min(1, log1p(raw) / log1p(${formatMetricMappingNumber(cap)}))`;
}

function rawMaximumForNormalized(
  normalized: number,
  formula: MetricNormalizationFormula,
  cap: number,
): number {
  return formula === "linear-cap-v1"
    ? normalized * cap
    : Math.expm1(normalized * Math.log1p(cap));
}

export function metricColorLegendRangeText(
  index: number,
  previousMaximum: number,
  maximum: number,
  formula: MetricNormalizationFormula,
  cap: number,
): string {
  if (index === 0) {
    return `raw ≤ ${formatMetricMappingNumber(
      rawMaximumForNormalized(maximum, formula, cap),
    )}`;
  }
  return (
    `n > ${formatMetricMappingNumber(previousMaximum)} and ` +
    `≤ ${formatMetricMappingNumber(maximum)}`
  );
}

function safeCustomId(name: string): string {
  const suffix = name
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 56);
  return `custom-${suffix || "mapping"}`;
}

function unavailableStorage(): MetricMappingStorage {
  return {
    getItem: () => null,
    setItem: () => {
      throw new DOMException("Browser storage is unavailable.", "QuotaExceededError");
    },
  };
}

function defaultStorage(
  hostWindow: Window | null,
): MetricMappingStorage {
  try {
    return hostWindow?.localStorage ?? unavailableStorage();
  } catch {
    return unavailableStorage();
  }
}

export function installMetricMappingPanel(
  root: HTMLElement,
  options: MetricMappingPanelOptions,
): MetricMappingPanelController {
  const preset = required<HTMLSelectElement>(
    root,
    "metric-mapping-preset",
  );
  const presetHelp = required<HTMLParagraphElement>(
    root,
    "metric-mapping-preset-help",
  );
  const unavailableReasons = required<HTMLUListElement>(
    root,
    "metric-mapping-unavailable-reasons",
  );
  const footprint: MetricChannelElements = {
    metric: required(root, "metric-footprint-metric"),
    normalization: required(root, "metric-footprint-normalization"),
    cap: required(root, "metric-footprint-cap"),
    formula: required(root, "metric-footprint-formula"),
  };
  const height: MetricChannelElements = {
    metric: required(root, "metric-height-metric"),
    normalization: required(root, "metric-height-normalization"),
    cap: required(root, "metric-height-cap"),
    formula: required(root, "metric-height-formula"),
  };
  const color: MetricChannelElements = {
    metric: required(root, "metric-color-metric"),
    normalization: required(root, "metric-color-normalization"),
    cap: required(root, "metric-color-cap"),
    formula: required(root, "metric-color-formula"),
  };
  const palette = required<HTMLSelectElement>(
    root,
    "metric-color-palette",
  );
  const colorLegend = required<HTMLUListElement>(
    root,
    "metric-color-legend",
  );
  const provenance = required<HTMLParagraphElement>(
    root,
    "metric-mapping-provenance",
  );
  const previewBadge = required<HTMLElement>(
    root,
    "metric-mapping-preview-badge",
  );
  const status = required<HTMLParagraphElement>(
    root,
    "metric-mapping-status",
  );
  const previewButton = required<HTMLButtonElement>(
    root,
    "metric-mapping-preview",
  );
  const applyButton = required<HTMLButtonElement>(
    root,
    "metric-mapping-apply",
  );
  const cancelButton = required<HTMLButtonElement>(
    root,
    "metric-mapping-cancel",
  );
  const configurationName = required<HTMLInputElement>(
    root,
    "metric-configuration-name",
  );
  const configurationSelect = required<HTMLSelectElement>(
    root,
    "metric-configuration-select",
  );
  const saveButton = required<HTMLButtonElement>(
    root,
    "metric-configuration-save",
  );
  const loadButton = required<HTMLButtonElement>(
    root,
    "metric-configuration-load",
  );
  const deleteButton = required<HTMLButtonElement>(
    root,
    "metric-configuration-delete",
  );
  const store = new MetricMappingConfigurationStore(
    options.storage ??
      defaultStorage(root.ownerDocument.defaultView),
  );
  const cleanups: (() => void)[] = [];
  let project: CityModel | undefined;
  let storageMessage: string | undefined;
  let controlsValid = true;

  const availablePresets = METRIC_MAPPING_PRESET_CATALOG.filter(
    (entry) => entry.availability === "available",
  );
  const palettes = new Map<
    string,
    {
      readonly name: string;
      readonly entries: readonly MetricColorPaletteEntryV1[];
    }
  >(
    availablePresets.map((entry) => [
      entry.id,
      {
        name: `${entry.name} palette`,
        entries: entry.definition.channels.color.palette,
      },
    ]),
  );

  const populateMetricSelect = (select: HTMLSelectElement): void => {
    select.replaceChildren(
      ...MAPPABLE_BUILDING_METRICS.map((metric) => {
        const option = root.ownerDocument.createElement("option");
        option.value = metric;
        option.textContent = METRIC_LABELS[metric];
        return option;
      }),
    );
  };
  populateMetricSelect(footprint.metric);
  populateMetricSelect(height.metric);
  populateMetricSelect(color.metric);

  const customOption = root.ownerDocument.createElement("option");
  customOption.value = "custom";
  customOption.textContent = "Custom";
  preset.append(customOption);
  for (const entry of METRIC_MAPPING_PRESET_CATALOG) {
    const option = root.ownerDocument.createElement("option");
    option.value = entry.id;
    option.textContent =
      entry.availability === "available"
        ? entry.name
        : `${entry.name} — unavailable`;
    if (entry.availability === "unavailable") {
      option.disabled = true;
      option.title = entry.reason;
    }
    preset.append(option);
    if (entry.availability === "unavailable") {
      const item = root.ownerDocument.createElement("li");
      const name = root.ownerDocument.createElement("strong");
      name.textContent = `${entry.name}: `;
      item.append(name, entry.reason);
      unavailableReasons.append(item);
    }
  }
  for (const [id, choice] of palettes) {
    const option = root.ownerDocument.createElement("option");
    option.value = id;
    option.textContent = choice.name;
    palette.append(option);
  }

  const selectedPaletteId = (
    entries: readonly MetricColorPaletteEntryV1[],
  ): string => {
    const signature = mappingSignature(entries);
    for (const [id, choice] of palettes) {
      if (mappingSignature(choice.entries) === signature) return id;
    }
    const customId = "current-custom";
    palettes.set(customId, {
      name: "Current custom palette",
      entries: mappingCopy({
        ...controller.state.draft,
        channels: {
          ...controller.state.draft.channels,
          color: {
            ...controller.state.draft.channels.color,
            palette: entries,
          },
        },
      }).channels.color.palette,
    });
    let option = [...palette.options].find(
      (candidate) => candidate.value === customId,
    );
    if (!option) {
      option = root.ownerDocument.createElement("option");
      option.value = customId;
      palette.append(option);
    }
    option.textContent = "Current custom palette";
    return customId;
  };

  const renderFormulaDetails = (
    mapping: MetricMappingDefinitionV1,
  ): void => {
    const footprintChannel = mapping.channels.footprint;
    const footprintGeometry = mapping.geometry.footprint;
    footprint.formula.textContent =
      `${footprintChannel.formula} → ${footprintChannel.normalization.formula}: ` +
      `${normalizedFormula(
        footprintChannel.normalization.formula,
        footprintChannel.normalization.cap,
      )}; missing = ${footprintChannel.normalization.missing} → ` +
      `${footprintGeometry.formula}: side = ${formatMetricMappingNumber(
        footprintGeometry.minimumSide,
      )} + (${formatMetricMappingNumber(footprintGeometry.maximumSide)} − ` +
      `${formatMetricMappingNumber(footprintGeometry.minimumSide)}) × n^${formatMetricMappingNumber(
        footprintGeometry.exponent,
      )}. Range ${formatMetricMappingNumber(footprintGeometry.minimumSide)}–` +
      `${formatMetricMappingNumber(footprintGeometry.maximumSide)} scene units.`;

    const heightChannel = mapping.channels.height;
    const heightGeometry = mapping.geometry.height;
    height.formula.textContent =
      `${heightChannel.formula} → ${heightChannel.normalization.formula}: ` +
      `${normalizedFormula(
        heightChannel.normalization.formula,
        heightChannel.normalization.cap,
      )}; missing = ${heightChannel.normalization.missing} → ` +
      `${heightGeometry.formula}: height = ${formatMetricMappingNumber(
        heightGeometry.minimumHeight,
      )} + (${formatMetricMappingNumber(heightGeometry.maximumHeight)} − ` +
      `${formatMetricMappingNumber(heightGeometry.minimumHeight)}) × n^${formatMetricMappingNumber(
        heightGeometry.exponent,
      )}. Range ${formatMetricMappingNumber(heightGeometry.minimumHeight)}–` +
      `${formatMetricMappingNumber(heightGeometry.maximumHeight)} scene units.`;

    const colorChannel = mapping.channels.color;
    color.formula.textContent =
      `${colorChannel.formula} → ${colorChannel.normalization.formula}: ` +
      `${normalizedFormula(
        colorChannel.normalization.formula,
        colorChannel.normalization.cap,
      )}; missing = ${colorChannel.normalization.missing} → ` +
      `${colorChannel.scale}.`;
    colorLegend.setAttribute(
      "aria-label",
      `Metric color thresholds — ${
        palettes.get(palette.value)?.name ?? "custom palette"
      }`,
    );
    colorLegend.replaceChildren();
    let previousMaximum = 0;
    for (const [index, entry] of colorChannel.palette.entries()) {
      const item = root.ownerDocument.createElement("li");
      const swatch = root.ownerDocument.createElement("span");
      swatch.className = "metric-color-swatch";
      swatch.style.backgroundColor = entry.color;
      swatch.setAttribute("aria-hidden", "true");
      const label = root.ownerDocument.createElement("span");
      label.textContent = `${entry.label} (${entry.color.toUpperCase()})`;
      const range = root.ownerDocument.createElement("span");
      range.className = "metric-color-range";
      range.textContent = metricColorLegendRangeText(
        index,
        previousMaximum,
        entry.maximum,
        colorChannel.normalization.formula,
        colorChannel.normalization.cap,
      );
      previousMaximum = entry.maximum;
      item.append(swatch, label, range);
      colorLegend.append(item);
    }
    provenance.textContent = describeMetricMapping(mapping);
  };

  const renderControls = (mapping: MetricMappingDefinitionV1): void => {
    const matchedPreset = availablePresets.find(
      (entry) =>
        mappingSignature(entry.definition) === mappingSignature(mapping),
    );
    preset.value = matchedPreset?.id ?? "custom";
    presetHelp.textContent =
      matchedPreset === undefined
        ? "Custom project mapping. Unavailable presets stay visible with their reason."
        : matchedPreset.definition.provenance.description;
    footprint.metric.value = mapping.channels.footprint.metric;
    footprint.normalization.value =
      mapping.channels.footprint.normalization.formula;
    footprint.cap.value = String(
      mapping.channels.footprint.normalization.cap,
    );
    height.metric.value = mapping.channels.height.metric;
    height.normalization.value =
      mapping.channels.height.normalization.formula;
    height.cap.value = String(mapping.channels.height.normalization.cap);
    color.metric.value = mapping.channels.color.metric;
    color.normalization.value =
      mapping.channels.color.normalization.formula;
    color.cap.value = String(mapping.channels.color.normalization.cap);
    palette.value = selectedPaletteId(mapping.channels.color.palette);
    renderFormulaDetails(mapping);
  };

  const renderSavedConfigurations = (
    selectedName?: string,
  ): void => {
    const configurations = project === undefined ? [] : store.list(project);
    configurationSelect.replaceChildren();
    const empty = root.ownerDocument.createElement("option");
    empty.value = "";
    empty.textContent =
      configurations.length === 0 ? "None saved" : "Choose configuration";
    configurationSelect.append(empty);
    for (const entry of configurations) {
      const option = root.ownerDocument.createElement("option");
      option.value = entry.name;
      option.textContent = entry.name;
      configurationSelect.append(option);
    }
    configurationSelect.value =
      selectedName !== undefined &&
      configurations.some(({ name }) => name === selectedName)
        ? selectedName
        : "";
    const selected = configurationSelect.value.length > 0;
    loadButton.disabled = !selected;
    deleteButton.disabled = !selected;
  };

  const renderState = (state: MetricMappingControllerState): void => {
    const previewActive =
      state.phase === "projecting" || state.phase === "preview";
    root.dataset["projectionState"] = state.phase;
    root.setAttribute(
      "aria-busy",
      String(state.phase === "projecting"),
    );
    previewBadge.hidden = !previewActive;
    previewBadge.textContent =
      state.phase === "projecting" ? "Building preview…" : "Preview";
    previewButton.disabled =
      state.phase === "projecting" || !controlsValid;
    applyButton.disabled = !state.canApply;
    cancelButton.disabled = !previewActive;
    saveButton.disabled = project === undefined || !controlsValid;
    options.onPreviewStateChange?.(previewActive);
    status.textContent =
      state.error ??
      storageMessage ??
      (state.phase === "projecting"
        ? "Building a disposable preview in this browser…"
        : state.phase === "preview"
          ? "Preview active. Apply this exact preview or cancel to restore the committed city."
          : "Changes are not applied until a successful preview is committed.");
    storageMessage = undefined;
  };

  const controller = new MetricMappingController({
    ...(options.client === undefined ? {} : { client: options.client }),
    onModelChange: options.onModelChange,
    onStateChange: renderState,
  });

  const readChannel = (
    elements: MetricChannelElements,
    current: MetricMappingDefinitionV1["channels"]["footprint"],
  ): MetricMappingDefinitionV1["channels"]["footprint"] => {
    if (!isMetric(elements.metric.value)) {
      throw new TypeError("Choose a supported raw metric.");
    }
    if (!isNormalization(elements.normalization.value)) {
      throw new TypeError("Choose a supported normalization formula.");
    }
    const cap = Number(elements.cap.value);
    if (!Number.isFinite(cap) || cap <= 0 || cap > 1_000_000_000) {
      throw new RangeError(
        "Metric caps must be greater than zero and at most 1,000,000,000.",
      );
    }
    return {
      ...current,
      metric: elements.metric.value,
      normalization: {
        ...current.normalization,
        formula: elements.normalization.value,
        cap,
      },
    };
  };

  const mappingFromControls = (): MetricMappingDefinitionV1 => {
    const current = controller.state.draft;
    const paletteChoice = palettes.get(palette.value);
    if (paletteChoice === undefined) {
      throw new TypeError("Choose a supported bounded color palette.");
    }
    const footprintChannel = readChannel(
      footprint,
      current.channels.footprint,
    );
    const heightChannel = readChannel(height, current.channels.height);
    const colorChannel = readChannel(
      color,
      current.channels.color,
    );
    const mapping = metricMappingWithChannels(current, {
      footprint: footprintChannel,
      height: heightChannel,
      color: {
        ...current.channels.color,
        ...colorChannel,
        palette: mappingCopy({
          ...current,
          channels: {
            ...current.channels,
            color: {
              ...current.channels.color,
              palette: paletteChoice.entries,
            },
          },
        }).channels.color.palette,
      },
    });
    return unnamedMetricMappingDefinition(mapping);
  };

  const onControlEdit = (): void => {
    controller.cancel();
    storageMessage = undefined;
    try {
      const mapping = mappingFromControls();
      controlsValid = true;
      controller.edit(mapping);
      preset.value = "custom";
      presetHelp.textContent =
        "Custom project mapping. Choose Preview to project it from the imported source model.";
      renderFormulaDetails(mapping);
    } catch (error) {
      controlsValid = false;
      renderState(controller.state);
      status.textContent =
        error instanceof Error
          ? error.message
          : "The metric mapping is invalid.";
    }
  };

  const onPresetChange = (): void => {
    const entry = METRIC_MAPPING_PRESET_CATALOG.find(
      (candidate) =>
        candidate.id === preset.value &&
        candidate.availability === "available",
    );
    if (entry?.availability !== "available") {
      preset.value = "custom";
      return;
    }
    controlsValid = true;
    controller.edit(entry.definition);
    renderControls(entry.definition);
  };
  preset.addEventListener("change", onPresetChange);
  cleanups.push(() => preset.removeEventListener("change", onPresetChange));

  const editControls: readonly (HTMLSelectElement | HTMLInputElement)[] = [
    footprint.metric,
    footprint.normalization,
    footprint.cap,
    height.metric,
    height.normalization,
    height.cap,
    color.metric,
    color.normalization,
    color.cap,
    palette,
  ];
  for (const control of editControls) {
    const eventName = control instanceof HTMLInputElement ? "input" : "change";
    control.addEventListener(eventName, onControlEdit);
    cleanups.push(() =>
      control.removeEventListener(eventName, onControlEdit),
    );
  }

  const onPreview = (): void => {
    if (!controlsValid) return;
    void controller.preview();
  };
  const onApply = (): void => {
    if (controller.apply()) {
      status.textContent =
        "Metric mapping applied. This projected model is now the committed city.";
    }
  };
  const onCancel = (): void => {
    controller.cancel();
    status.textContent = "Preview cancelled. Committed city restored.";
  };
  previewButton.addEventListener("click", onPreview);
  applyButton.addEventListener("click", onApply);
  cancelButton.addEventListener("click", onCancel);
  cleanups.push(() => {
    previewButton.removeEventListener("click", onPreview);
    applyButton.removeEventListener("click", onApply);
    cancelButton.removeEventListener("click", onCancel);
  });

  const onConfigurationSelection = (): void => {
    const selected = configurationSelect.value.length > 0;
    loadButton.disabled = !selected;
    deleteButton.disabled = !selected;
    if (selected) configurationName.value = configurationSelect.value;
  };
  configurationSelect.addEventListener(
    "change",
    onConfigurationSelection,
  );
  cleanups.push(() =>
    configurationSelect.removeEventListener(
      "change",
      onConfigurationSelection,
    ),
  );

  const onSave = (): void => {
    if (project === undefined) return;
    const name = configurationName.value.trim();
    let current: MetricMappingDefinitionV1;
    try {
      current = mappingFromControls();
      controlsValid = true;
    } catch (error) {
      controlsValid = false;
      renderState(controller.state);
      status.textContent =
        error instanceof Error
          ? error.message
          : "The metric mapping is invalid.";
      return;
    }
    const named = namedMetricMappingDefinition(current, name);
    const result = store.save(project, name, named);
    storageMessage = result.message;
    if (result.ok) {
      controller.edit(named);
      renderControls(named);
      renderSavedConfigurations(name);
      return;
    }
    renderState(controller.state);
  };
  const onLoad = (): void => {
    if (project === undefined) return;
    const selected = store
      .list(project)
      .find(({ name }) => name === configurationSelect.value);
    if (!selected) return;
    controlsValid = true;
    controller.edit(selected.mapping);
    renderControls(selected.mapping);
    configurationName.value = selected.name;
    status.textContent = `Loaded “${selected.name}”. Choose Preview to inspect it.`;
  };
  const onDelete = (): void => {
    if (project === undefined || configurationSelect.value.length === 0) {
      return;
    }
    const deletedName = configurationSelect.value;
    const result = store.delete(project, deletedName);
    storageMessage = result.message;
    if (result.ok) {
      renderSavedConfigurations();
      configurationName.value = "";
    }
    renderState(controller.state);
  };
  saveButton.addEventListener("click", onSave);
  loadButton.addEventListener("click", onLoad);
  deleteButton.addEventListener("click", onDelete);
  cleanups.push(() => {
    saveButton.removeEventListener("click", onSave);
    loadButton.removeEventListener("click", onLoad);
    deleteButton.removeEventListener("click", onDelete);
  });

  return {
    get state() {
      return controller.state;
    },
    setProject: (model: CityModel): void => {
      project = model;
      storageMessage = undefined;
      controlsValid = true;
      controller.setProject(model);
      renderControls(controller.state.draft);
      renderSavedConfigurations();
      configurationName.value = "";
    },
    cancelPreview: (): void => controller.cancel(),
    dispose: (): void => {
      for (const cleanup of cleanups.splice(0)) cleanup();
      controller.dispose();
    },
  };
}
