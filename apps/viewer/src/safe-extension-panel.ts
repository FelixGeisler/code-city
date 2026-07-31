import {
  EXTENSION_LIMITS,
  SAFE_EXTENSION_PRESETS,
  type CityModel,
  type ExtensionEvaluation,
} from "../../../packages/core/src/index.js";
import { SafeExtensionWorkerClient } from "./safe-extension-worker-client.js";

export interface SafeExtensionPanelOptions {
  readonly onPreview?: (evaluation: ExtensionEvaluation) => void;
}

/** Accessible import/preview surface. Imported text is interpreted as bounded data and is never executed. */
export function installSafeExtensionPanel(
  root: HTMLElement,
  options: SafeExtensionPanelOptions = {},
): { setProject(model: CityModel): void; dispose(): void } {
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
  const client = new SafeExtensionWorkerClient();
  let model: CityModel | undefined;
  let generation = 0;
  let reviewed: ExtensionEvaluation | undefined;

  const show = (message: string, error = false): void => {
    status.textContent = message;
    diagnostics.textContent = error
      ? "Invalid configuration. Nothing was applied and the loaded city is unchanged."
      : "Evaluation interprets bounded data in a cancellable browser worker; the evaluator performs no network, filesystem, credential, or server I/O.";
  };
  const invalidate = (): void => {
    generation += 1;
    client.cancel();
    reviewed = undefined;
    exportButton.disabled = true;
  };
  const selected = (): unknown => {
    if (new TextEncoder().encode(source.value).byteLength > EXTENSION_LIMITS.bytes) {
      throw new RangeError("Extension configuration exceeds the byte limit.");
    }
    try {
      return JSON.parse(source.value);
    } catch {
      throw new TypeError("Extension configuration must be valid JSON.");
    }
  };
  const loadPreset = (): void => {
    invalidate();
    const configuration =
      SAFE_EXTENSION_PRESETS.find((item) => item.id === preset.value) ??
      SAFE_EXTENSION_PRESETS[0]!;
    source.value = JSON.stringify(configuration, null, 2);
    show("Preset loaded. Preview to validate and evaluate it.");
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
    let configuration: unknown;
    try {
      configuration = selected();
    } catch (error) {
      show(
        error instanceof Error ? error.message : "Extension preview failed.",
        true,
      );
      return;
    }
    invalidate();
    const currentGeneration = generation;
    preview.disabled = true;
    show("Evaluating extension preview…");
    void client
      .evaluate(model, configuration)
      .then((evaluation) => {
        if (generation !== currentGeneration) return;
        options.onPreview?.(evaluation);
        reviewed = evaluation;
        exportButton.disabled = false;
        show(
          `Preview complete: ${Object.keys(evaluation.derivedMetrics).length} buildings evaluated; ${Object.keys(evaluation.matches).length} filters available.`,
        );
      })
      .catch((error: unknown) => {
        if (generation !== currentGeneration) return;
        show(
          error instanceof Error ? error.message : "Extension preview failed.",
          true,
        );
      })
      .finally(() => {
        if (generation === currentGeneration) preview.disabled = false;
      });
  });

  exportButton.addEventListener("click", () => {
    if (!reviewed) return;
    const text = JSON.stringify(reviewed.configuration, null, 2);
    const url = URL.createObjectURL(
      new Blob([text], { type: "application/json" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "code-city-extension.json";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    show("Reviewed configuration exported.");
  });

  return {
    setProject(next: CityModel): void {
      invalidate();
      model = next;
      preview.disabled = false;
      show("Ready to preview a declarative extension for this project.");
    },
    dispose(): void {
      generation += 1;
      client.dispose();
    },
  };
}
