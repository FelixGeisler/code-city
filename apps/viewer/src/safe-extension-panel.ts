import {
  EXTENSION_LIMITS,
  SAFE_EXTENSION_PRESETS,
  migrateSafeExtensionConfiguration,
  safeExtensionConfigurationDigest,
  safeExtensionModelDigest,
  validateSafeExtensionEvaluation,
  type CityModel,
  type ExtensionEvaluation,
} from "../../../packages/core/src/index.js";
import { SafeExtensionWorkerClient } from "./safe-extension-worker-client.js";

export interface SafeExtensionPanelOptions {
  readonly workerClient?: SafeExtensionWorkerClient;
  readonly onPreview?: (evaluation: ExtensionEvaluation) => void;
  readonly onInvalidate?: () => void;
}

export interface SafeExtensionPanelController {
  setProject(model: CityModel): void;
  dispose(): void;
}

/** Accessible data import/preview surface. Imported text is never executed. */
export function installSafeExtensionPanel(
  root: HTMLElement,
  options: SafeExtensionPanelOptions = {},
): SafeExtensionPanelController {
  const preset = root.querySelector<HTMLSelectElement>(
    "#safe-extension-preset",
  )!;
  const source = root.querySelector<HTMLTextAreaElement>(
    "#safe-extension-json",
  )!;
  const preview = root.querySelector<HTMLButtonElement>(
    "#safe-extension-preview",
  )!;
  const exportButton = root.querySelector<HTMLButtonElement>(
    "#safe-extension-export",
  )!;
  const status = root.querySelector<HTMLElement>(
    "#safe-extension-status",
  )!;
  const diagnostics = root.querySelector<HTMLElement>(
    "#safe-extension-diagnostics",
  )!;
  const client = options.workerClient ?? new SafeExtensionWorkerClient();
  let model: CityModel | undefined;
  let generation = 0;
  let reviewed: ExtensionEvaluation | undefined;
  let previewApplied = false;

  const show = (
    message: string,
    detail =
      "Evaluation interprets bounded data in an interruptible browser worker; no extension-provided code, network, filesystem, credential, or server I/O is available.",
  ): void => {
    status.textContent = message;
    diagnostics.textContent = detail;
  };
  const invalidate = (notify = true): void => {
    generation += 1;
    client.cancel();
    reviewed = undefined;
    exportButton.disabled = true;
    if (previewApplied) {
      previewApplied = false;
      if (notify) options.onInvalidate?.();
    }
  };
  const selected = () => {
    if (
      new TextEncoder().encode(source.value).byteLength >
      EXTENSION_LIMITS.bytes
    ) {
      throw new RangeError("Extension configuration exceeds the byte limit.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(source.value);
    } catch {
      throw new TypeError("Extension configuration must be valid JSON.");
    }
    return migrateSafeExtensionConfiguration(parsed);
  };
  const loadPreset = (): void => {
    invalidate();
    const configuration =
      SAFE_EXTENSION_PRESETS.find((item) => item.id === preset.value) ??
      SAFE_EXTENSION_PRESETS[0]!;
    source.value = JSON.stringify(configuration, null, 2);
    show("Preset loaded. Preview to validate and apply it.");
  };

  for (const configuration of SAFE_EXTENSION_PRESETS) {
    const option = document.createElement("option");
    option.value = configuration.id;
    option.textContent = configuration.name;
    preset.append(option);
  }
  preset.addEventListener("change", loadPreset);
  source.addEventListener("input", () => {
    invalidate();
    show("Configuration changed. Preview it again before export.");
  });
  loadPreset();

  preview.addEventListener("click", () => {
    if (!model) return;
    let configuration;
    try {
      configuration = selected();
    } catch (error) {
      invalidate();
      show(
        error instanceof Error ? error.message : "Extension preview failed.",
        "Invalid configuration. Nothing was applied and the loaded city is unchanged.",
      );
      return;
    }
    invalidate();
    const currentGeneration = generation;
    const previewModel = model;
    preview.disabled = true;
    show("Evaluating extension preview…");
    void client
      .evaluate(previewModel, configuration)
      .then((evaluation) => {
        if (generation !== currentGeneration) return;
        const validated = validateSafeExtensionEvaluation(evaluation, {
          model: previewModel,
          configuration,
        });
        try {
          options.onPreview?.(validated);
          previewApplied = true;
        } catch (error) {
          options.onInvalidate?.();
          throw error;
        }
        reviewed = validated;
        exportButton.disabled = false;
        const application = validated.application;
        const detail = [
          `${application.mappings.length} mapping(s)`,
          `${application.layouts.length} layout(s)`,
          `${application.legends.length} legend(s)`,
          `${application.queries.length} query result(s)`,
          `${application.overlays.length} overlay(s)`,
          ...validated.diagnostics.map(
            (item) => `${item.path}: ${item.message}`,
          ),
        ].join(" · ");
        show(
          `Preview applied to ${application.buildings.length.toLocaleString("en-US")} buildings.`,
          detail,
        );
      })
      .catch((error: unknown) => {
        if (generation !== currentGeneration) return;
        reviewed = undefined;
        exportButton.disabled = true;
        show(
          error instanceof Error ? error.message : "Extension preview failed.",
          "Nothing from this configuration remains eligible for export.",
        );
      })
      .finally(() => {
        if (generation === currentGeneration) preview.disabled = false;
      });
  });

  exportButton.addEventListener("click", () => {
    if (!reviewed || !model) return;
    try {
      const current = selected();
      if (
        safeExtensionConfigurationDigest(current) !==
          reviewed.binding.configurationSha256 ||
        safeExtensionModelDigest(model) !== reviewed.binding.modelSha256
      ) {
        throw new TypeError(
          "The configuration or project changed after preview. Preview it again before export.",
        );
      }
      validateSafeExtensionEvaluation(reviewed, {
        model,
        configuration: current,
      });
      const text = JSON.stringify(current, null, 2);
      const url = URL.createObjectURL(
        new Blob([text], { type: "application/json" }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "code-city-extension.json";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      show(
        "Reviewed configuration exported once. Preview again before another export.",
      );
    } catch (error) {
      show(
        error instanceof Error ? error.message : "Extension export failed.",
        "The raw configuration is revalidated and digest-bound to the current project before every export.",
      );
    } finally {
      reviewed = undefined;
      exportButton.disabled = true;
    }
  });

  return {
    setProject(next: CityModel): void {
      invalidate();
      model = next;
      preview.disabled = false;
      show("Ready to preview a declarative extension for this project.");
    },
    dispose(): void {
      invalidate();
      client.dispose();
    },
  };
}
