import { SAFE_EXTENSION_PRESETS, type CityModel } from "../../../packages/core/src/index.js";
import { SafeExtensionWorkerClient } from "./safe-extension-worker-client.js";

/** Accessible import/preview surface. Imported text is never executed and remains project-local until a user exports it. */
export function installSafeExtensionPanel(root: HTMLElement): { setProject(model: CityModel): void; dispose(): void } {
  const preset = root.querySelector<HTMLSelectElement>("#safe-extension-preset")!;
  const source = root.querySelector<HTMLTextAreaElement>("#safe-extension-json")!;
  const preview = root.querySelector<HTMLButtonElement>("#safe-extension-preview")!;
  const exportButton = root.querySelector<HTMLButtonElement>("#safe-extension-export")!;
  const status = root.querySelector<HTMLElement>("#safe-extension-status")!;
  const diagnostics = root.querySelector<HTMLElement>("#safe-extension-diagnostics")!;
  const client = new SafeExtensionWorkerClient();
  let model: CityModel | undefined;
  const show = (message: string, error = false): void => { status.textContent = message; diagnostics.textContent = error ? "Invalid configuration. Nothing was applied and the loaded city is unchanged." : "Evaluation runs in a cancellable browser worker with no server, network, filesystem, or credential access."; };
  for (const configuration of SAFE_EXTENSION_PRESETS) { const option = document.createElement("option"); option.value = configuration.id; option.textContent = configuration.name; preset.append(option); }
  const selected = (): unknown => { try { return JSON.parse(source.value); } catch { throw new TypeError("Extension configuration must be valid JSON."); } };
  const loadPreset = (): void => { const configuration = SAFE_EXTENSION_PRESETS.find((item) => item.id === preset.value) ?? SAFE_EXTENSION_PRESETS[0]!; source.value = JSON.stringify(configuration, null, 2); show("Preset loaded. Preview to validate and evaluate it."); };
  preset.addEventListener("change", loadPreset); loadPreset();
  preview.addEventListener("click", () => { if (!model) return; preview.disabled = true; show("Evaluating extension preview…"); void client.evaluate(model, selected()).then((evaluation) => { show(`Preview complete: ${Object.keys(evaluation.derivedMetrics).length} buildings evaluated; ${Object.keys(evaluation.matches).length} filters available.`); }).catch((error: unknown) => show(error instanceof Error ? error.message : "Extension preview failed.", true)).finally(() => { preview.disabled = false; }); });
  exportButton.addEventListener("click", () => { try { const text = JSON.stringify(selected(), null, 2); const anchor = document.createElement("a"); anchor.href = URL.createObjectURL(new Blob([text], { type: "application/json" })); anchor.download = "code-city-extension.json"; anchor.click(); URL.revokeObjectURL(anchor.href); show("Configuration exported."); } catch (error) { show(error instanceof Error ? error.message : "Export failed.", true); } });
  return { setProject(next: CityModel): void { model = next; preview.disabled = false; show("Ready to preview a declarative extension for this project."); }, dispose(): void { client.dispose(); } };
}
