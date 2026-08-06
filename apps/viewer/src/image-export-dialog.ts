import type { CameraProjection } from "./camera-presets.js";
import {
  IMAGE_EXPORT_LIMITS,
  formatBytes,
  type ImageExportRequest,
  type ValidatedImageExportResolution,
} from "./image-export.js";

export interface ImageExportDialogContext {
  readonly projection: CameraProjection;
  readonly selectedEntityAvailable: boolean;
  readonly evolutionFrame?: {
    readonly label: string;
    readonly sha: string;
  };
}

export interface PreparedImageExport {
  readonly blob: Blob;
  readonly fileName: string;
  readonly resolution: ValidatedImageExportResolution;
}

export interface ImageExportDialogOptions {
  readonly context: () => ImageExportDialogContext;
  readonly exportImage: (
    request: ImageExportRequest,
  ) => Promise<PreparedImageExport>;
}

export interface ImageExportDialog {
  open(): void;
  invalidate(): void;
  dispose(): void;
}

const RESOLUTIONS = Object.freeze({
  "full-hd": [1_920, 1_080],
  "qhd": [2_560, 1_440],
  "4k": [3_840, 2_160],
  square: [2_048, 2_048],
} as const);

export class ImageExportAttemptGate {
  #generation = 0;
  #busy = false;

  public get busy(): boolean {
    return this.#busy;
  }

  public begin(): number {
    this.#generation += 1;
    this.#busy = true;
    return this.#generation;
  }

  public isCurrent(attempt: number): boolean {
    return attempt === this.#generation;
  }

  public invalidate(): void {
    this.#generation += 1;
    this.#busy = false;
  }

  public settle(attempt: number): boolean {
    if (!this.isCurrent(attempt)) return false;
    this.#busy = false;
    return true;
  }
}

export function installImageExportDialog(
  options: ImageExportDialogOptions,
): ImageExportDialog {
  const dialog = requiredElement<HTMLDialogElement>("image-export-dialog");
  const form = requiredElement<HTMLFormElement>("image-export-form");
  const closeButton =
    requiredElement<HTMLButtonElement>("image-export-close");
  const resolution =
    requiredElement<HTMLSelectElement>("image-export-resolution");
  const width = requiredElement<HTMLInputElement>("image-export-width");
  const height = requiredElement<HTMLInputElement>("image-export-height");
  const view = requiredElement<HTMLSelectElement>("image-export-view");
  const currentViewText = requiredElement<HTMLElement>(
    "image-export-current-view",
  );
  const customCamera = requiredElement<HTMLElement>(
    "image-export-custom-camera",
  );
  const angle = requiredElement<HTMLSelectElement>("image-export-angle");
  const fit = requiredElement<HTMLSelectElement>("image-export-fit");
  const selectedFit = requiredOption(fit, "selected-entity");
  const projection =
    requiredElement<HTMLSelectElement>("image-export-projection");
  const currentProjectionOption = requiredOption(
    projection,
    "current-view",
  );
  const background =
    requiredElement<HTMLSelectElement>("image-export-background");
  const labels = requiredElement<HTMLInputElement>("image-export-labels");
  const legend = requiredElement<HTMLInputElement>("image-export-legend");
  const evolution =
    requiredElement<HTMLInputElement>("image-export-evolution");
  const evolutionText =
    requiredElement<HTMLElement>("image-export-evolution-text");
  const submit =
    requiredElement<HTMLButtonElement>("image-export-submit");
  const status = requiredElement<HTMLElement>("image-export-status");
  const errors = requiredElement<HTMLElement>("image-export-errors");
  const errorList = requiredElement<HTMLUListElement>(
    "image-export-error-list",
  );
  const download = requiredElement<HTMLAnchorElement>(
    "image-export-download",
  );
  const limits = requiredElement<HTMLElement>("image-export-limits");
  const attempts = new ImageExportAttemptGate();
  let objectUrl: string | undefined;
  let disposed = false;

  limits.textContent =
    `Minimum ${IMAGE_EXPORT_LIMITS.minimumDimension}px per side; ` +
    `up to ${IMAGE_EXPORT_LIMITS.maximumDimension.toLocaleString()}px per side and ` +
    `${formatBytes(IMAGE_EXPORT_LIMITS.maximumWorkingBytes)} estimated working memory. ` +
    "The active GPU may impose a lower limit.";

  const revoke = (): void => {
    if (objectUrl !== undefined) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = undefined;
    }
    download.hidden = true;
    download.removeAttribute("href");
    download.removeAttribute("download");
  };

  const clearErrors = (): void => {
    errors.hidden = true;
    errorList.replaceChildren();
  };

  const showError = (error: unknown): void => {
    clearErrors();
    const item = document.createElement("li");
    item.textContent =
      error instanceof Error
        ? error.message
        : "The image could not be exported.";
    errorList.append(item);
    errors.hidden = false;
    status.textContent = "Image export failed.";
  };

  const setBusy = (busy: boolean): void => {
    form.setAttribute("aria-busy", String(busy));
    submit.disabled = busy;
    closeButton.disabled = busy;
    for (const control of form.querySelectorAll<
      HTMLInputElement | HTMLSelectElement
    >("input, select")) {
      control.disabled =
        busy ||
        (control === evolution &&
          evolution.dataset["available"] !== "true");
    }
    selectedFit.disabled =
      busy || selectedFit.dataset["available"] !== "true";
  };

  const synchronizeResolution = (): void => {
    const value = resolution.value as keyof typeof RESOLUTIONS;
    const dimensions = RESOLUTIONS[value];
    if (dimensions === undefined) return;
    width.value = String(dimensions[0]);
    height.value = String(dimensions[1]);
  };

  const synchronizeCustomResolution = (): void => {
    const dimensions = RESOLUTIONS[
      resolution.value as keyof typeof RESOLUTIONS
    ];
    if (
      dimensions === undefined ||
      width.value !== String(dimensions[0]) ||
      height.value !== String(dimensions[1])
    ) {
      resolution.value = "custom";
    }
  };

  const synchronizeCameraChoice = (): void => {
    customCamera.hidden = view.value !== "custom";
    currentViewText.textContent =
      view.value === "current-view"
        ? "Current view is inherited exactly, including lens, angle, pan, and zoom."
        : "Custom camera settings fit a target independently from the visible view.";
  };

  const updateContext = (resetCamera: boolean): void => {
    const current = options.context();
    currentProjectionOption.textContent =
      `Current lens (${current.projection === "orthographic" ? "Orthographic" : "Perspective"})`;
    selectedFit.dataset["available"] = String(
      current.selectedEntityAvailable,
    );
    selectedFit.disabled = !current.selectedEntityAvailable;
    if (
      !current.selectedEntityAvailable &&
      fit.value === "selected-entity"
    ) {
      fit.value = "whole-city";
    }
    if (resetCamera) {
      view.value = "current-view";
      angle.value = "current-view";
      fit.value = "whole-city";
      projection.value = "current-view";
    }
    synchronizeCameraChoice();
    evolution.dataset["available"] = String(
      current.evolutionFrame !== undefined,
    );
    evolution.disabled = current.evolutionFrame === undefined;
    evolution.checked = current.evolutionFrame !== undefined;
    evolutionText.textContent =
      current.evolutionFrame === undefined
        ? "No repository evolution frame is active"
        : `Include ${current.evolutionFrame.label}`;
  };

  const open = (): void => {
    if (disposed) throw new Error("Image export dialog is disposed.");
    attempts.invalidate();
    setBusy(false);
    revoke();
    clearErrors();
    updateContext(true);
    status.textContent =
      "Current view is selected. The scene is rendered directly; viewer controls and panels are never captured.";
    if (!dialog.open) dialog.showModal();
  };

  const invalidate = (): void => {
    if (disposed) return;
    attempts.invalidate();
    setBusy(false);
    revoke();
    if (dialog.open) {
      updateContext(false);
      status.textContent =
        "The scene changed. Prepare a new PNG for the current state.";
    }
  };

  const close = (): void => dialog.close();
  const onClose = (): void => {
    attempts.invalidate();
    setBusy(false);
    revoke();
  };
  const onSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    const request: ImageExportRequest = {
      width: Number(width.value),
      height: Number(height.value),
      camera:
        view.value === "custom"
          ? {
              mode: "custom",
              angle:
                angle.value === "isometric" ||
                angle.value === "top-down"
                  ? angle.value
                  : "current-view",
              fit:
                fit.value === "selected-entity" ||
                fit.value === "whole-city"
                  ? fit.value
                  : "whole-city",
              lens:
                projection.value === "orthographic" ||
                projection.value === "perspective"
                  ? projection.value
                  : "current-view",
            }
          : { mode: "current-view" },
      background:
        background.value === "transparent" ? "transparent" : "scene",
      includeLabels: labels.checked,
      includeLegend: legend.checked,
      includeEvolutionFrame: evolution.checked && !evolution.disabled,
    };
    const attempt = attempts.begin();
    revoke();
    clearErrors();
    setBusy(true);
    status.textContent = "Rendering the independent image buffer\u2026";
    void options
      .exportImage(request)
      .then((prepared) => {
        if (!attempts.isCurrent(attempt)) return;
        objectUrl = URL.createObjectURL(prepared.blob);
        download.href = objectUrl;
        download.download = prepared.fileName;
        download.hidden = false;
        status.textContent =
          `${prepared.resolution.width.toLocaleString()}\u00d7` +
          `${prepared.resolution.height.toLocaleString()} PNG ready \u00b7 ` +
          `${formatBytes(prepared.resolution.estimatedWorkingBytes)} estimated peak working memory.`;
      })
      .catch((error: unknown) => {
        if (attempts.isCurrent(attempt)) showError(error);
      })
      .finally(() => {
        if (attempts.settle(attempt)) setBusy(false);
      });
  };

  resolution.addEventListener("change", synchronizeResolution);
  width.addEventListener("input", synchronizeCustomResolution);
  height.addEventListener("input", synchronizeCustomResolution);
  view.addEventListener("change", synchronizeCameraChoice);
  closeButton.addEventListener("click", close);
  dialog.addEventListener("close", onClose);
  form.addEventListener("submit", onSubmit);

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    attempts.invalidate();
    setBusy(false);
    revoke();
    resolution.removeEventListener("change", synchronizeResolution);
    width.removeEventListener("input", synchronizeCustomResolution);
    height.removeEventListener("input", synchronizeCustomResolution);
    view.removeEventListener("change", synchronizeCameraChoice);
    closeButton.removeEventListener("click", close);
    dialog.removeEventListener("close", onClose);
    form.removeEventListener("submit", onSubmit);
    if (dialog.open) dialog.close();
  };

  synchronizeResolution();
  synchronizeCameraChoice();
  return { open, invalidate, dispose };
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (value === null) {
    throw new Error(`Missing required image export element #${id}.`);
  }
  return value as T;
}

function requiredOption(
  select: HTMLSelectElement,
  value: string,
): HTMLOptionElement {
  const option = [...select.options].find(
    (candidate) => candidate.value === value,
  );
  if (option === undefined) {
    throw new Error(`Missing required image export option ${value}.`);
  }
  return option;
}
