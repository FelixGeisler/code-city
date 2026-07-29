import type { CityModel } from "../../../packages/core/src/model.js";
import {
  createPrusaXLProfile,
  createSingleChannelProfile,
  parsePrinterProfileJson,
} from "../../../packages/core/src/printer-profiles.js";
import type { PrinterProfile } from "../../../packages/core/src/print.js";
import type { ThreeMfExportPreflight } from "../../../packages/exporter/src/three-mf-export.js";

import {
  PrintExportController,
  type PrintExportControllerState,
} from "./print-export-controller.js";
import {
  PrintDownloadManager,
  tryPublishPrintDownloads,
} from "./print-download.js";

export interface PrintExportDialogOptions {
  readonly getModel: () => CityModel;
}

export interface PrintExportDialogHandle {
  invalidate(): void;
  dispose(): void;
}

export type ProfileKind = "generic" | "prusa-xl" | "custom";

export class LatestPrintProfileRead {
  private generation = 0;

  public begin(): number {
    this.generation += 1;
    return this.generation;
  }

  public invalidate(): void {
    this.generation += 1;
  }

  public isCurrent(readId: number): boolean {
    return readId === this.generation;
  }
}

export interface PrintExportSubmitAvailability {
  readonly busy: boolean;
  readonly profileKind: ProfileKind;
  readonly hasCustomProfile: boolean;
  readonly prusaToolCount: number;
}

export function printExportSubmitDisabled(
  availability: PrintExportSubmitAvailability,
): boolean {
  return (
    availability.busy ||
    (availability.profileKind === "custom" &&
      !availability.hasCustomProfile) ||
    (availability.profileKind === "prusa-xl" &&
      availability.prusaToolCount === 0)
  );
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const item = document.getElementById(id);
  if (!item) throw new Error(`Missing required viewer element '#${id}'.`);
  return item as T;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function issuesOf(error: unknown): readonly string[] {
  if (typeof error === "object" && error !== null) {
    const issues = (error as { readonly issues?: unknown }).issues;
    if (
      Array.isArray(issues) &&
      issues.every((issue) => typeof issue === "string")
    ) {
      return issues;
    }
  }
  return [messageOf(error)];
}

function millimeters(value: number): string {
  return String(Number(value.toFixed(3)));
}

function profileKind(value: string): ProfileKind {
  if (value === "generic" || value === "prusa-xl" || value === "custom") {
    return value;
  }
  throw new Error("Choose a supported printer profile.");
}

export function installPrintExportDialog(
  options: PrintExportDialogOptions,
): PrintExportDialogHandle {
  const openButton =
    requiredElement<HTMLButtonElement>("print-export-open");
  const dialog =
    requiredElement<HTMLDialogElement>("print-export-dialog");
  const closeButton =
    requiredElement<HTMLButtonElement>("print-export-close");
  const form = requiredElement<HTMLFormElement>("print-export-form");
  const optionsFieldset =
    requiredElement<HTMLFieldSetElement>("print-export-options");
  const profileSelect =
    requiredElement<HTMLSelectElement>("print-profile-kind");
  const prusaTools =
    requiredElement<HTMLFieldSetElement>("print-prusa-tools");
  const customProfileWrap =
    requiredElement<HTMLDivElement>("print-custom-profile-wrap");
  const customProfileInput =
    requiredElement<HTMLInputElement>("print-custom-profile");
  const customProfileStatus = requiredElement<HTMLParagraphElement>(
    "print-custom-profile-status",
  );
  const scaleInput = requiredElement<HTMLInputElement>("print-scale");
  const labelsSelect =
    requiredElement<HTMLSelectElement>("print-labels");
  const routesInput = requiredElement<HTMLInputElement>("print-routes");
  const legendInput = requiredElement<HTMLInputElement>(
    "print-legend-download-enabled",
  );
  const submitButton =
    requiredElement<HTMLButtonElement>("print-export-submit");
  const cancelButton =
    requiredElement<HTMLButtonElement>("print-export-cancel");
  const progressWrap =
    requiredElement<HTMLDivElement>("print-export-progress");
  const progressElement = requiredElement<HTMLProgressElement>(
    "print-export-progress-meter",
  );
  const progressStatus =
    requiredElement<HTMLSpanElement>("print-export-status");
  const errorSection =
    requiredElement<HTMLElement>("print-export-errors");
  const errorList =
    requiredElement<HTMLUListElement>("print-export-error-list");
  const preflightSection =
    requiredElement<HTMLElement>("print-export-preflight");
  const dimensionsElement =
    requiredElement<HTMLElement>("print-export-dimensions");
  const partsElement =
    requiredElement<HTMLElement>("print-export-parts");
  const channelsList =
    requiredElement<HTMLUListElement>("print-export-channels");
  const warningWrap =
    requiredElement<HTMLDivElement>("print-export-warning-wrap");
  const warningsList =
    requiredElement<HTMLUListElement>("print-export-warnings");
  const downloadsWrap =
    requiredElement<HTMLDivElement>("print-export-downloads");
  const threeMfDownload =
    requiredElement<HTMLAnchorElement>("print-export-download");
  const legendDownload = requiredElement<HTMLAnchorElement>(
    "print-export-legend-download",
  );

  const downloads = new PrintDownloadManager();
  const customProfileReads = new LatestPrintProfileRead();
  let customProfile: PrinterProfile | undefined;
  let customProfilePending = false;

  const controller = new PrintExportController(
    () =>
      new Worker(new URL("./print-export-worker.ts", import.meta.url), {
        type: "module",
        name: "code-city-3mf-export",
      }),
    {
      onStateChange: (state) => {
        renderState(state);
      },
    },
  );

  function selectedProfileKind(): ProfileKind {
    return profileKind(profileSelect.value);
  }

  function selectedPrusaTools(): readonly number[] {
    return [
      ...prusaTools.querySelectorAll<HTMLInputElement>(
        'input[type="checkbox"]:checked',
      ),
    ].map(({ value }) => Number(value));
  }

  function resolveProfile(): PrinterProfile {
    switch (selectedProfileKind()) {
      case "generic":
        return createSingleChannelProfile();
      case "prusa-xl":
        return createPrusaXLProfile(selectedPrusaTools());
      case "custom":
        if (customProfile === undefined) {
          throw new Error("Choose a valid custom printer-profile JSON file.");
        }
        return customProfile;
    }
  }

  function clearDownloads(): void {
    downloads.clear();
    downloadsWrap.hidden = true;
    threeMfDownload.removeAttribute("href");
    threeMfDownload.removeAttribute("download");
    legendDownload.removeAttribute("href");
    legendDownload.removeAttribute("download");
    legendDownload.hidden = true;
  }

  function clearResultPanels(): void {
    clearDownloads();
    preflightSection.hidden = true;
    errorSection.hidden = true;
    errorList.replaceChildren();
  }

  function renderErrors(issues: readonly string[]): void {
    errorList.replaceChildren(
      ...issues.map((issue) => {
        const item = document.createElement("li");
        item.textContent = issue;
        return item;
      }),
    );
    errorSection.hidden = false;
  }

  function renderPreflight(preflight: ThreeMfExportPreflight): void {
    dimensionsElement.textContent =
      `${millimeters(preflight.dimensions.x)} × ` +
      `${millimeters(preflight.dimensions.y)} × ` +
      `${millimeters(preflight.dimensions.z)} mm`;
    partsElement.textContent =
      `${preflight.partCount.toLocaleString()} ` +
      `${preflight.partCount === 1 ? "part" : "parts"} across ` +
      `${preflight.channels.length.toLocaleString()} ` +
      `${preflight.channels.length === 1 ? "channel" : "channels"}`;
    channelsList.replaceChildren(
      ...preflight.channels.map((channel) => {
        const item = document.createElement("li");
        item.textContent =
          `${channel.label}: ${channel.semanticGroupIds.length.toLocaleString()} ` +
          `${channel.semanticGroupIds.length === 1 ? "group" : "groups"}, ` +
          `${channel.primitiveCount.toLocaleString()} primitives`;
        return item;
      }),
    );
    warningsList.replaceChildren(
      ...preflight.warnings.map((warning) => {
        const item = document.createElement("li");
        item.textContent = warning;
        return item;
      }),
    );
    warningWrap.hidden = preflight.warnings.length === 0;
    preflightSection.hidden = false;
  }

  function renderReady(state: Extract<PrintExportControllerState, {
    readonly status: "ready";
  }>): void {
    const model = options.getModel();
    const publication = tryPublishPrintDownloads(
      downloads,
      {
        title:
          model.identity?.title ??
          model.repositories[0]?.name ??
          state.preflight.title,
        ...(model.identity?.version === undefined
          ? {}
          : { version: model.identity.version }),
      },
      {
        threeMfBytes: state.threeMfBytes,
        ...(state.legendBytes === undefined
          ? {}
          : { legendBytes: state.legendBytes }),
      },
    );
    if (!publication.ok) {
      clearDownloads();
      renderErrors([publication.message]);
      return;
    }
    const available = publication.downloads;
    threeMfDownload.href = available.threeMf.url;
    threeMfDownload.download = available.threeMf.fileName;
    if (available.legend !== undefined) {
      legendDownload.href = available.legend.url;
      legendDownload.download = available.legend.fileName;
      legendDownload.hidden = false;
    }
    downloadsWrap.hidden = false;
  }

  function updateSubmitAvailability(): void {
    submitButton.disabled = printExportSubmitDisabled({
      busy: controller.state.status === "busy",
      profileKind: selectedProfileKind(),
      hasCustomProfile: customProfile !== undefined,
      prusaToolCount: selectedPrusaTools().length,
    });
  }

  function renderState(state: PrintExportControllerState): void {
    const busy = state.status === "busy";
    optionsFieldset.disabled = busy;
    cancelButton.hidden = !busy;
    progressWrap.hidden = !busy;
    updateSubmitAvailability();

    if (state.status === "idle") {
      progressElement.value = 0;
      progressStatus.textContent = "Preparing export…";
      return;
    }
    if (state.status === "busy") {
      clearDownloads();
      errorSection.hidden = true;
      const completed = state.progress?.completed ?? 0;
      progressElement.value = completed;
      progressStatus.textContent =
        state.progress?.message ?? "Starting export worker…";
      if (state.preflight !== undefined) {
        renderPreflight(state.preflight);
      }
      return;
    }
    if (state.status === "failed") {
      clearDownloads();
      if (state.preflight !== undefined) {
        renderPreflight(state.preflight);
      }
      renderErrors(
        state.error.issues.length > 0
          ? state.error.issues
          : [state.error.message],
      );
      return;
    }
    renderPreflight(state.preflight);
    renderReady(state);
  }

  function invalidateOutput(): void {
    controller.reset();
    clearResultPanels();
    updateSubmitAvailability();
  }

  function invalidateCustomProfileRead(): void {
    customProfileReads.invalidate();
    if (!customProfilePending) return;
    customProfilePending = false;
    customProfile = undefined;
    customProfileInput.value = "";
    customProfileInput.removeAttribute("aria-invalid");
    customProfileStatus.textContent =
      "Choose a Code City printer-profile JSON file.";
  }

  function updateProfileControls(): void {
    const kind = selectedProfileKind();
    prusaTools.hidden = kind !== "prusa-xl";
    customProfileWrap.hidden = kind !== "custom";
    updateSubmitAvailability();
  }

  async function readCustomProfile(): Promise<void> {
    const readId = customProfileReads.begin();
    customProfilePending = true;
    customProfile = undefined;
    customProfileInput.removeAttribute("aria-invalid");
    const file = customProfileInput.files?.[0];
    if (!file) {
      customProfilePending = false;
      customProfileStatus.textContent =
        "Choose a Code City printer-profile JSON file.";
      updateSubmitAvailability();
      return;
    }
    customProfileStatus.textContent = `Checking ${file.name}…`;
    updateSubmitAvailability();
    try {
      const parsed = parsePrinterProfileJson(await file.text());
      if (
        !customProfileReads.isCurrent(readId) ||
        selectedProfileKind() !== "custom"
      ) {
        return;
      }
      customProfile = parsed;
      customProfileStatus.textContent =
        `${parsed.name} · ${parsed.printChannels.length.toLocaleString()} ` +
        `${parsed.printChannels.length === 1 ? "channel" : "channels"}`;
      errorSection.hidden = true;
    } catch (error) {
      if (
        !customProfileReads.isCurrent(readId) ||
        selectedProfileKind() !== "custom"
      ) {
        return;
      }
      customProfileInput.setAttribute("aria-invalid", "true");
      customProfileStatus.textContent = "Profile validation failed.";
      renderErrors(issuesOf(error));
    } finally {
      if (customProfileReads.isCurrent(readId)) {
        customProfilePending = false;
      }
      updateSubmitAvailability();
    }
  }

  function closeDialog(): void {
    invalidateCustomProfileRead();
    invalidateOutput();
    if (dialog.open) dialog.close();
    openButton.focus({ preventScroll: true });
  }

  openButton.addEventListener("click", () => {
    invalidateOutput();
    updateProfileControls();
    dialog.showModal();
  });
  closeButton.addEventListener("click", closeDialog);
  cancelButton.addEventListener("click", () => {
    invalidateOutput();
    progressStatus.textContent = "Export cancelled.";
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDialog();
  });
  profileSelect.addEventListener("change", () => {
    invalidateCustomProfileRead();
    invalidateOutput();
    updateProfileControls();
  });
  prusaTools.addEventListener("change", invalidateOutput);
  customProfileInput.addEventListener("change", () => {
    invalidateOutput();
    void readCustomProfile();
  });
  scaleInput.addEventListener("input", invalidateOutput);
  labelsSelect.addEventListener("change", invalidateOutput);
  routesInput.addEventListener("change", invalidateOutput);
  legendInput.addEventListener("change", invalidateOutput);
  function startExport(event: Event): void {
    event.preventDefault();
    clearResultPanels();
    let profile: PrinterProfile;
    try {
      profile = resolveProfile();
    } catch (error) {
      renderErrors(issuesOf(error));
      return;
    }
    invalidateCustomProfileRead();
    controller.start({
      model: options.getModel(),
      profile,
      options: {
        scale: Number(scaleInput.value),
        labelPolicy: labelsSelect.value === "off" ? "off" : "auto",
        routePolicy: routesInput.checked ? "auto" : "off",
        includeLegend: legendInput.checked,
      },
    });
  }
  form.addEventListener("submit", startExport);
  window.addEventListener("beforeunload", () => {
    controller.dispose();
    downloads.dispose();
  });

  updateProfileControls();
  renderState(controller.state);

  return {
    invalidate(): void {
      invalidateCustomProfileRead();
      invalidateOutput();
    },
    dispose(): void {
      invalidateCustomProfileRead();
      controller.dispose();
      downloads.dispose();
    },
  };
}
