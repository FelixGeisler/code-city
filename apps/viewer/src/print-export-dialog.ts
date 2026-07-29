import type { CityModel } from "../../../packages/core/src/model.js";
import {
  createPrusaXLProfile,
  createSingleChannelProfile,
  parsePrinterProfileJson,
} from "../../../packages/core/src/printer-profiles.js";
import type {
  PrinterProfile,
  PrintFormat,
} from "../../../packages/core/src/print.js";
import type {
  PrintFitPolicy,
} from "../../../packages/core/src/print-layout.js";
import type {
  CalibrationPrintExportPreflight,
} from "../../../packages/exporter/src/calibration.js";
import type {
  PrintPlateBundlePreflight,
} from "../../../packages/exporter/src/print-plates.js";

import {
  PrintExportController,
  type PrintExportControllerState,
} from "./print-export-controller.js";
import {
  PrintDownloadManager,
  tryPublishCalibrationDownloads,
  tryPublishPrintBundleDownload,
  tryPublishPrintDownloads,
} from "./print-download.js";
import type { ViewerLoadGateway } from "./model-source.js";
import {
  withPrintLayoutPreviewReadiness,
  type PrintLayoutPreviewPlan,
} from "./print-plate-preview.js";

export interface PrintExportDialogOptions {
  readonly getModel: () => CityModel;
  readonly loadGateway: ViewerLoadGateway;
  readonly onPrintLayoutPlan?: (
    plan: PrintLayoutPreviewPlan | undefined,
  ) => void;
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
  readonly formatSupported: boolean;
  readonly profileKind: ProfileKind;
  readonly hasCustomProfile: boolean;
  readonly prusaToolCount: number;
  readonly fitPolicyValid: boolean;
  readonly maximumPlateCountValid: boolean;
}

export function printExportSubmitDisabled(
  availability: PrintExportSubmitAvailability,
): boolean {
  return (
    availability.busy ||
    !availability.formatSupported ||
    !availability.fitPolicyValid ||
    !availability.maximumPlateCountValid ||
    (availability.profileKind === "custom" &&
      !availability.hasCustomProfile) ||
    (availability.profileKind === "prusa-xl" &&
      availability.prusaToolCount === 0)
  );
}

export function shouldRetainPrintLayoutOnDialogClose(
  status: PrintExportControllerState["status"],
): boolean {
  return status === "ready" || status === "bundle-ready";
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

function printFormat(value: string): PrintFormat {
  if (value === "3mf" || value === "stl") return value;
  throw new Error("Choose either 3MF or STL.");
}

function printFitPolicy(value: string): PrintFitPolicy {
  if (value === "error" || value === "scale" || value === "tile") {
    return value;
  }
  throw new Error("Choose error, scale, or tile as the fit policy.");
}

function maximumPlateCount(value: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1 || count > 99) {
    throw new Error("Maximum plates must be an integer from 1 to 99.");
  }
  return count;
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
  const formatSelect =
    requiredElement<HTMLSelectElement>("print-format");
  const scaleInput = requiredElement<HTMLInputElement>("print-scale");
  const fitSelect = requiredElement<HTMLSelectElement>("print-fit");
  const maximumPlateCountInput =
    requiredElement<HTMLInputElement>("print-max-plates");
  const labelsSelect =
    requiredElement<HTMLSelectElement>("print-labels");
  const routesInput = requiredElement<HTMLInputElement>("print-routes");
  const legendInput = requiredElement<HTMLInputElement>(
    "print-legend-download-enabled",
  );
  const submitButton =
    requiredElement<HTMLButtonElement>("print-export-submit");
  const calibrationButton =
    requiredElement<HTMLButtonElement>("print-calibration-submit");
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
  const trianglesWrap =
    requiredElement<HTMLElement>("print-export-triangles-wrap");
  const trianglesElement =
    requiredElement<HTMLElement>("print-export-triangles");
  const channelsTitle =
    requiredElement<HTMLElement>("print-export-channels-title");
  const channelsList =
    requiredElement<HTMLUListElement>("print-export-channels");
  const warningWrap =
    requiredElement<HTMLDivElement>("print-export-warning-wrap");
  const warningsList =
    requiredElement<HTMLUListElement>("print-export-warnings");
  const downloadsWrap =
    requiredElement<HTMLDivElement>("print-export-downloads");
  const artifactDownload =
    requiredElement<HTMLAnchorElement>("print-export-download");
  const legendDownload = requiredElement<HTMLAnchorElement>(
    "print-export-legend-download",
  );
  const calibrationDownload = requiredElement<HTMLAnchorElement>(
    "print-calibration-download",
  );
  const calibrationManifestDownload =
    requiredElement<HTMLAnchorElement>(
      "print-calibration-manifest-download",
    );

  const downloads = new PrintDownloadManager();
  const customProfileReads = new LatestPrintProfileRead();
  let customProfile: PrinterProfile | undefined;
  let customProfilePending = false;
  let publishedLayout:
    | {
        readonly jobId: number;
        readonly readiness: "planned" | "ready";
      }
    | undefined;

  const controller = new PrintExportController(
    () =>
      new Worker(new URL("./print-export-worker.ts", import.meta.url), {
        type: "module",
        name: "code-city-print-export",
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

  function selectedFormat(): PrintFormat {
    return printFormat(formatSelect.value);
  }

  function selectedFitPolicy(): PrintFitPolicy {
    return printFitPolicy(fitSelect.value);
  }

  function selectedMaximumPlateCount(): number {
    return maximumPlateCount(maximumPlateCountInput.value);
  }

  function publishPrintLayout(
    jobId: number,
    preview: PrintLayoutPreviewPlan,
    readiness: "planned" | "ready",
  ): void {
    if (
      options.onPrintLayoutPlan === undefined ||
      (publishedLayout?.jobId === jobId &&
        (publishedLayout.readiness === readiness ||
          publishedLayout.readiness === "ready"))
    ) {
      return;
    }
    try {
      options.onPrintLayoutPlan(
        withPrintLayoutPreviewReadiness(preview, readiness),
      );
      publishedLayout = { jobId, readiness };
    } catch (error) {
      renderErrors([
        `The printable plate preview could not be shown: ${messageOf(error)}`,
      ]);
    }
  }

  function clearPrintLayout(): void {
    if (publishedLayout === undefined) return;
    publishedLayout = undefined;
    try {
      options.onPrintLayoutPlan?.(undefined);
    } catch {
      // The export dialog remains usable if an optional preview host fails.
    }
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

  function resolveProfileForFormat(): {
    readonly profile: PrinterProfile;
    readonly format: PrintFormat;
  } {
    const profile = resolveProfile();
    const format = selectedFormat();
    if (!profile.supportedFormats.includes(format)) {
      throw new Error(
        `${format.toUpperCase()} is not supported by ${profile.name}.`,
      );
    }
    return { profile, format };
  }

  function clearDownloads(): void {
    downloads.clear();
    downloadsWrap.hidden = true;
    artifactDownload.removeAttribute("href");
    artifactDownload.removeAttribute("download");
    artifactDownload.hidden = true;
    legendDownload.removeAttribute("href");
    legendDownload.removeAttribute("download");
    legendDownload.hidden = true;
    calibrationDownload.removeAttribute("href");
    calibrationDownload.removeAttribute("download");
    calibrationDownload.hidden = true;
    calibrationManifestDownload.removeAttribute("href");
    calibrationManifestDownload.removeAttribute("download");
    calibrationManifestDownload.hidden = true;
  }

  function clearResultPanels(): void {
    clearPrintLayout();
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

  function renderBundlePreflight(
    preflight: PrintPlateBundlePreflight,
  ): void {
    const largest = preflight.plates.reduce(
      (current, plate) => ({
        width: Math.max(current.width, plate.dimensions.width),
        depth: Math.max(current.depth, plate.dimensions.depth),
        height: Math.max(current.height, plate.dimensions.height),
      }),
      { width: 0, depth: 0, height: 0 },
    );
    const printedLabels =
      preflight.labels.printedBuildings +
      preflight.labels.printedDistricts;
    dimensionsElement.textContent =
      `${preflight.plateCount.toLocaleString()} ` +
      `${preflight.plateCount === 1 ? "plate" : "plates"} \u00b7 largest ` +
      `${millimeters(largest.width)} \u00d7 ` +
      `${millimeters(largest.depth)} \u00d7 ` +
      `${millimeters(largest.height)} mm`;
    partsElement.textContent =
      `Scale ${millimeters(preflight.requestedScale)} \u2192 ` +
      `${millimeters(preflight.appliedScale)} \u00b7 ` +
      `${printedLabels.toLocaleString()} labels \u00b7 ` +
      `${preflight.routes.printedCount.toLocaleString()} routes`;
    trianglesWrap.hidden = true;
    channelsTitle.textContent = "Plate summary";
    const visiblePlates = preflight.plates.slice(0, 6);
    const plateItems = visiblePlates.map((plate) => {
      const item = document.createElement("li");
      const utilization = Math.round(plate.utilization * 100);
      item.textContent =
        `Plate ${plate.number.toLocaleString()}: ` +
        `${utilization.toLocaleString()}% used \u00b7 ` +
        `${plate.channelIds.length.toLocaleString()} ` +
        `${plate.channelIds.length === 1 ? "channel" : "channels"} \u00b7 ` +
        `${millimeters(plate.dimensions.width)} \u00d7 ` +
        `${millimeters(plate.dimensions.depth)} \u00d7 ` +
        `${millimeters(plate.dimensions.height)} mm`;
      return item;
    });
    if (preflight.plates.length > visiblePlates.length) {
      const remaining = document.createElement("li");
      remaining.textContent =
        `${(preflight.plates.length - visiblePlates.length).toLocaleString()} ` +
        "more plates are listed in manifest.json.";
      plateItems.push(remaining);
    }
    channelsList.replaceChildren(...plateItems);
    const allWarnings = [
      ...preflight.warnings,
      ...preflight.plates.flatMap((plate) =>
        plate.warnings.map(
          (warning) => `Plate ${plate.number}: ${warning}`,
        ),
      ),
      ...(preflight.unplacedObjects.length === 0
        ? []
        : [
            `${preflight.unplacedObjects.length.toLocaleString()} objects could not be placed.`,
          ]),
      ...(preflight.routeOmissions.length === 0
        ? []
        : [
            `${preflight.routeOmissions.length.toLocaleString()} routes were omitted from the bundle.`,
          ]),
    ];
    const uniqueWarnings = [...new Set(allWarnings)];
    const visibleWarnings = uniqueWarnings.slice(0, 8);
    if (uniqueWarnings.length > visibleWarnings.length) {
      visibleWarnings.push(
        `${(uniqueWarnings.length - visibleWarnings.length).toLocaleString()} more warnings are recorded in manifest.json.`,
      );
    }
    warningsList.replaceChildren(
      ...visibleWarnings.map((warning) => {
        const item = document.createElement("li");
        item.textContent = warning;
        return item;
      }),
    );
    warningWrap.hidden = visibleWarnings.length === 0;
    preflightSection.hidden = false;
  }

  function renderCalibrationPreflight(
    preflight: CalibrationPrintExportPreflight,
  ): void {
    dimensionsElement.textContent =
      `${millimeters(preflight.dimensions.x)} \u00d7 ` +
      `${millimeters(preflight.dimensions.y)} \u00d7 ` +
      `${millimeters(preflight.dimensions.z)} mm`;
    partsElement.textContent =
      `${preflight.partCount.toLocaleString()} ` +
      `${preflight.partCount === 1 ? "part" : "parts"} across ` +
      `${preflight.channelCount.toLocaleString()} ` +
      `${preflight.channelCount === 1 ? "channel" : "channels"}`;
    trianglesElement.textContent =
      preflight.triangleCount.toLocaleString();
    trianglesWrap.hidden = false;
    channelsTitle.textContent = "Calibration manifest";
    const measurements = document.createElement("li");
    measurements.textContent =
      `${preflight.manifest.measurementCount.toLocaleString()} ` +
      `${preflight.manifest.measurementCount === 1
        ? "profile measurement"
        : "profile measurements"}`;
    const coupons = document.createElement("li");
    coupons.textContent =
      `${preflight.manifest.couponCount.toLocaleString()} ` +
      `${preflight.manifest.couponCount === 1
        ? "printable coupon"
        : "printable coupons"}`;
    const markers = document.createElement("li");
    markers.textContent =
      `${preflight.manifest.channelMarkerCount.toLocaleString()} ` +
      `${preflight.manifest.channelMarkerCount === 1
        ? "channel marker"
        : "channel markers"}`;
    channelsList.replaceChildren(measurements, coupons, markers);
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
        artifact: state.artifact,
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
    artifactDownload.href = available.artifact.url;
    artifactDownload.download = available.artifact.fileName;
    artifactDownload.textContent =
      `Download ${state.artifact.format.toUpperCase()}`;
    artifactDownload.hidden = false;
    if (available.legend !== undefined) {
      legendDownload.href = available.legend.url;
      legendDownload.download = available.legend.fileName;
      legendDownload.hidden = false;
    }
    downloadsWrap.hidden = false;
  }

  function renderBundleReady(
    state: Extract<
      PrintExportControllerState,
      { readonly status: "bundle-ready" }
    >,
  ): void {
    const model = options.getModel();
    const publication = tryPublishPrintBundleDownload(
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
      { artifact: state.artifact },
    );
    if (!publication.ok) {
      clearDownloads();
      renderErrors([publication.message]);
      return;
    }
    artifactDownload.href = publication.downloads.artifact.url;
    artifactDownload.download =
      publication.downloads.artifact.fileName;
    artifactDownload.textContent =
      `Download print ZIP (${state.preflight.plateCount.toLocaleString()} ` +
      `${state.preflight.plateCount === 1 ? "plate" : "plates"} + manifest)`;
    artifactDownload.hidden = false;
    legendDownload.hidden = true;
    downloadsWrap.hidden = false;
  }

  function renderCalibrationReady(
    state: Extract<
      PrintExportControllerState,
      { readonly status: "calibration-ready" }
    >,
  ): void {
    const publication = tryPublishCalibrationDownloads(
      downloads,
      state.preflight.profileId,
      {
        artifact: state.artifact,
        manifestBytes: state.manifestBytes,
      },
    );
    if (!publication.ok) {
      clearDownloads();
      renderErrors([publication.message]);
      return;
    }
    calibrationDownload.href = publication.downloads.artifact.url;
    calibrationDownload.download =
      publication.downloads.artifact.fileName;
    calibrationDownload.textContent =
      `Download calibration ${state.artifact.format.toUpperCase()}`;
    calibrationDownload.hidden = false;
    calibrationManifestDownload.href =
      publication.downloads.manifest.url;
    calibrationManifestDownload.download =
      publication.downloads.manifest.fileName;
    calibrationManifestDownload.hidden = false;
    downloadsWrap.hidden = false;
  }

  function updateSubmitAvailability(): void {
    let formatSupported = false;
    let fitPolicyValid = false;
    let maximumPlateCountValid = false;
    try {
      formatSupported = resolveProfile()
        .supportedFormats.includes(selectedFormat());
    } catch {
      formatSupported = false;
    }
    try {
      const fitPolicy = selectedFitPolicy();
      fitPolicyValid = true;
      maximumPlateCountValid =
        fitPolicy !== "tile" ||
        Number.isSafeInteger(selectedMaximumPlateCount());
    } catch {
      fitPolicyValid = false;
      maximumPlateCountValid = false;
    }
    const disabled = printExportSubmitDisabled({
      busy: controller.state.status === "busy",
      formatSupported,
      profileKind: selectedProfileKind(),
      hasCustomProfile: customProfile !== undefined,
      prusaToolCount: selectedPrusaTools().length,
      fitPolicyValid,
      maximumPlateCountValid,
    });
    submitButton.disabled = disabled;
    calibrationButton.disabled = disabled;
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
      if (
        state.bundlePreflight !== undefined &&
        state.bundlePreview !== undefined
      ) {
        renderBundlePreflight(state.bundlePreflight);
        publishPrintLayout(
          state.jobId,
          state.bundlePreview,
          "planned",
        );
      } else if (
        state.preflight !== undefined &&
        state.preview !== undefined
      ) {
        renderBundlePreflight(state.preflight);
        publishPrintLayout(state.jobId, state.preview, "planned");
      }
      return;
    }
    if (state.status === "failed") {
      clearDownloads();
      if (state.preflight !== undefined) {
        renderBundlePreflight(state.preflight);
        if (state.preview !== undefined) {
          publishPrintLayout(state.jobId, state.preview, "planned");
        }
      } else if (state.bundlePreflight !== undefined) {
        renderBundlePreflight(state.bundlePreflight);
        if (state.bundlePreview !== undefined) {
          publishPrintLayout(
            state.jobId,
            state.bundlePreview,
            "planned",
          );
        }
      }
      renderErrors(
        state.error.issues.length > 0
          ? state.error.issues
          : [state.error.message],
      );
      return;
    }
    if (state.status === "calibration-ready") {
      renderCalibrationPreflight(state.preflight);
      renderCalibrationReady(state);
      return;
    }
    if (state.status === "bundle-ready") {
      renderBundlePreflight(state.preflight);
      publishPrintLayout(state.jobId, state.preview, "ready");
      renderBundleReady(state);
      return;
    }
    renderBundlePreflight(state.preflight);
    publishPrintLayout(state.jobId, state.preview, "ready");
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

  function updateFitControls(): void {
    let tiled = false;
    try {
      tiled = selectedFitPolicy() === "tile";
    } catch {
      tiled = false;
    }
    maximumPlateCountInput.disabled = !tiled;
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
      const parsed = parsePrinterProfileJson(
        await options.loadGateway.loadLocalText(file, "profile"),
      );
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
    if (!shouldRetainPrintLayoutOnDialogClose(controller.state.status)) {
      invalidateOutput();
    }
    if (dialog.open) dialog.close();
    openButton.focus({ preventScroll: true });
  }

  openButton.addEventListener("click", () => {
    if (!shouldRetainPrintLayoutOnDialogClose(controller.state.status)) {
      invalidateOutput();
    }
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
  formatSelect.addEventListener("change", invalidateOutput);
  fitSelect.addEventListener("change", () => {
    invalidateOutput();
    updateFitControls();
  });
  customProfileInput.addEventListener("change", () => {
    invalidateOutput();
    void readCustomProfile();
  });
  scaleInput.addEventListener("input", invalidateOutput);
  maximumPlateCountInput.addEventListener("input", invalidateOutput);
  labelsSelect.addEventListener("change", invalidateOutput);
  routesInput.addEventListener("change", invalidateOutput);
  legendInput.addEventListener("change", invalidateOutput);
  function startExport(event: Event): void {
    event.preventDefault();
    clearResultPanels();
    let profile: PrinterProfile;
    let format: PrintFormat;
    let fitPolicy: PrintFitPolicy;
    let maximumPlates: number | undefined;
    try {
      ({ profile, format } = resolveProfileForFormat());
      fitPolicy = selectedFitPolicy();
      maximumPlates =
        fitPolicy === "tile"
          ? selectedMaximumPlateCount()
          : undefined;
    } catch (error) {
      renderErrors(issuesOf(error));
      return;
    }
    invalidateCustomProfileRead();
    controller.start({
      format,
      model: options.getModel(),
      profile,
      options: {
        scale: Number(scaleInput.value),
        labelPolicy: labelsSelect.value === "off" ? "off" : "auto",
        routePolicy: routesInput.checked ? "auto" : "off",
        includeLegend: legendInput.checked,
        fitPolicy,
        ...(maximumPlates === undefined
          ? {}
          : { maximumPlateCount: maximumPlates }),
      },
    });
  }
  function startCalibration(): void {
    clearResultPanels();
    let profile: PrinterProfile;
    let format: PrintFormat;
    try {
      ({ profile, format } = resolveProfileForFormat());
    } catch (error) {
      renderErrors(issuesOf(error));
      return;
    }
    invalidateCustomProfileRead();
    controller.startCalibration({ profile, format });
  }
  form.addEventListener("submit", startExport);
  calibrationButton.addEventListener("click", startCalibration);
  window.addEventListener("beforeunload", () => {
    controller.dispose();
    downloads.dispose();
  });

  updateProfileControls();
  updateFitControls();
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
      clearPrintLayout();
    },
  };
}
