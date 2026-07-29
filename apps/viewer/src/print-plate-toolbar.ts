import {
  PrintPlatePreviewController,
  type PrintLayoutPreviewPlan,
  type PrintPlatePreviewState,
  type PrintPreviewMode,
} from "./print-plate-preview.js";

export interface PrintPlateToolbarElements {
  readonly root: HTMLElement;
  readonly cityModeButton: HTMLButtonElement;
  readonly platesModeButton: HTMLButtonElement;
  readonly plateSelect: HTMLSelectElement;
  readonly status: HTMLElement;
}

export interface PrintPlateToolbarOptions {
  readonly onStateChange?: (state: PrintPlatePreviewState) => void;
}

export interface PrintPlateToolbarController {
  readonly state: PrintPlatePreviewState;
  setPlan(plan: PrintLayoutPreviewPlan | undefined): void;
  show(mode: PrintPreviewMode): void;
  selectPlate(plateId: string): void;
  dispose(): void;
}

function selectedPlateStatus(state: PrintPlatePreviewState): string {
  if (
    state.mode !== "plates" ||
    state.plan === undefined ||
    state.projection === undefined
  ) {
    return state.plan === undefined
      ? "City layout \u00b7 generate a print plan to preview plates"
      : `City layout \u00b7 ${state.plan.plates.length.toLocaleString()} ${
           state.plan.plates.length === 1 ? "print plate" : "print plates"
         } ${state.plan.readiness ?? "ready"}`;
  }
  return (
    `Plate ${state.projection.plateIndex + 1} of ` +
    `${state.plan.plates.length} \u00b7 ` +
    `${Math.round(state.projection.utilization * 100)}% used \u00b7 ` +
    `${state.plan.readiness ?? "ready"}`
  );
}

function render(
  elements: PrintPlateToolbarElements,
  state: PrintPlatePreviewState,
): void {
  const hasPlan = state.plan !== undefined;
  const platesVisible = state.mode === "plates" && hasPlan;
  elements.root.hidden = !hasPlan;
  elements.root.dataset["previewMode"] = state.mode;
  elements.cityModeButton.setAttribute(
    "aria-pressed",
    String(state.mode === "city"),
  );
  elements.platesModeButton.setAttribute(
    "aria-pressed",
    String(platesVisible),
  );
  elements.platesModeButton.disabled = !hasPlan;
  elements.plateSelect.disabled = !platesVisible;
  elements.plateSelect.hidden = !platesVisible;
  elements.plateSelect.replaceChildren(
    ...state.selectorOptions.map((candidate) => {
      const option =
        elements.plateSelect.ownerDocument.createElement("option");
      option.value = candidate.id;
      option.textContent = candidate.label;
      option.selected = candidate.selected;
      return option;
    }),
  );
  if (state.selectedPlateId !== undefined) {
    elements.plateSelect.value = state.selectedPlateId;
  }
  elements.status.textContent = selectedPlateStatus(state);
}

/**
 * Installs only the canvas-toolbar behavior. Markup, styling, and scene
 * switching remain integration responsibilities of the viewer entry point.
 */
export function installPrintPlateToolbar(
  elements: PrintPlateToolbarElements,
  options: PrintPlateToolbarOptions = {},
): PrintPlateToolbarController {
  let disposed = false;
  const preview = new PrintPlatePreviewController({
    onStateChange: (state) => {
      if (disposed) return;
      render(elements, state);
      options.onStateChange?.(state);
    },
  });

  const showCity = (): void => preview.show("city");
  const showPlates = (): void => {
    if (preview.state.plan !== undefined) preview.show("plates");
  };
  const selectPlate = (): void => {
    if (preview.state.plan !== undefined) {
      preview.selectPlate(elements.plateSelect.value);
    }
  };
  elements.cityModeButton.addEventListener("click", showCity);
  elements.platesModeButton.addEventListener("click", showPlates);
  elements.plateSelect.addEventListener("change", selectPlate);
  elements.plateSelect.setAttribute("aria-label", "Print plate");
  elements.status.setAttribute("aria-live", "polite");
  render(elements, preview.state);

  const ensureActive = (): void => {
    if (disposed) {
      throw new Error("The print-plate toolbar has been disposed.");
    }
  };
  return {
    get state() {
      return preview.state;
    },
    setPlan(plan) {
      ensureActive();
      preview.setPlan(plan);
    },
    show(mode) {
      ensureActive();
      preview.show(mode);
    },
    selectPlate(plateId) {
      ensureActive();
      preview.selectPlate(plateId);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      elements.cityModeButton.removeEventListener("click", showCity);
      elements.platesModeButton.removeEventListener("click", showPlates);
      elements.plateSelect.removeEventListener("change", selectPlate);
    },
  };
}
