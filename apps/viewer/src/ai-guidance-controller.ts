import type { CityBuilding } from "../../../packages/core/src/model.js";
import type { AiProviderDiscoveryController } from "./ai-provider-discovery.js";
import type {
  ViewerAiGuidanceContext,
  ViewerImportApiClient,
} from "./import-api.js";

export interface AiGuidanceElements {
  readonly details: HTMLDetailsElement;
  readonly summary: HTMLElement;
  readonly status: HTMLParagraphElement;
  readonly providerLabel: HTMLLabelElement;
  readonly provider: HTMLSelectElement;
  readonly prepare: HTMLButtonElement;
  readonly preview: HTMLPreElement;
  readonly request: HTMLButtonElement;
  readonly suggestions: HTMLUListElement;
}

export interface AiGuidanceControllerOptions {
  readonly elements: AiGuidanceElements;
  readonly api: ViewerImportApiClient;
  readonly providerDiscovery: AiProviderDiscoveryController;
  readonly selectedBuilding: () => CityBuilding | undefined;
  readonly currentJobId: () => string | undefined;
  readonly sourceAvailable: () => boolean;
  readonly sourceBoundToCurrentFrame: () => boolean;
  readonly contextFor: (building: CityBuilding) => ViewerAiGuidanceContext | undefined;
  readonly focusKey: () => string | undefined;
}

/** Owns AI preview/request cancellation and presentation for code inspection. */
export class AiGuidanceController {
  private requestController: AbortController | undefined;
  private generation = 0;

  public constructor(private readonly options: AiGuidanceControllerOptions) {}

  public reset(): void {
    this.cancelRequest();
    const fields = this.options.elements;
    fields.details.open = false;
    fields.details.hidden = true;
    fields.summary.textContent = "";
    fields.status.textContent = "";
    fields.preview.hidden = true;
    fields.preview.textContent = "";
    fields.prepare.hidden = true;
    fields.prepare.disabled = false;
    fields.prepare.onclick = null;
    fields.request.hidden = true;
    fields.request.disabled = false;
    fields.request.onclick = null;
    fields.providerLabel.hidden = true;
    fields.provider.disabled = false;
    fields.provider.onchange = null;
    fields.provider.replaceChildren();
    fields.suggestions.hidden = true;
    fields.suggestions.replaceChildren();
  }

  public clearResult(): void {
    this.cancelRequest();
    const fields = this.options.elements;
    fields.preview.hidden = true;
    fields.preview.textContent = "";
    fields.request.hidden = true;
    fields.request.disabled = false;
    fields.request.onclick = null;
    fields.provider.disabled = false;
    fields.prepare.disabled = false;
    fields.suggestions.hidden = true;
    fields.suggestions.replaceChildren();
  }

  public render(building: CityBuilding): void {
    const { elements: fields, providerDiscovery } = this.options;
    const capability = providerDiscovery.capability;
    const wasOpen = fields.details.open;
    const selectedProvider = fields.provider.value;
    this.clearResult();
    if (
      capability.state !== "configured" ||
      this.options.selectedBuilding()?.id !== building.id
    ) {
      fields.details.hidden = true;
      fields.details.open = false;
      fields.providerLabel.hidden = true;
      fields.prepare.hidden = true;
      return;
    }

    if (!this.options.sourceBoundToCurrentFrame()) {
      fields.details.hidden = true;
      fields.details.open = false;
      fields.summary.textContent = "";
      fields.status.textContent = "";
      fields.providerLabel.hidden = true;
      fields.provider.replaceChildren();
      fields.prepare.hidden = true;
      fields.prepare.onclick = null;
      return;
    }

    fields.details.hidden = false;
    fields.details.open = wasOpen;
    fields.summary.textContent = "Available";
    fields.provider.replaceChildren();
    for (const provider of capability.providers) {
      const option = document.createElement("option");
      option.value = provider.id;
      option.textContent = provider.label;
      fields.provider.append(option);
    }
    if (capability.providers.some(({ id }) => id === selectedProvider)) {
      fields.provider.value = selectedProvider;
    }
    fields.providerLabel.hidden = false;
    const context = this.options.contextFor(building);
    const eligible = this.options.sourceAvailable() && context !== undefined;
    fields.prepare.hidden = !eligible;
    fields.status.textContent = eligible
      ? "Prepare an exact server-verified preview explicitly. No source is sent to the provider until you confirm the one-time send. Code City does not persist prompts; provider retention depends on your configured provider."
      : "AI guidance is available, but this focus has no exact server-resolvable retained-source context. Deterministic findings remain available.";
    fields.provider.onchange = () => {
      this.clearResult();
      fields.summary.textContent = "Available";
      fields.prepare.hidden = !eligible;
      fields.status.textContent = eligible
        ? "Provider changed. Prepare a new exact preview explicitly before sending."
        : "This focus has no exact server-resolvable retained-source context.";
    };
    fields.prepare.onclick = eligible && context !== undefined
      ? () => this.preparePreview(context)
      : null;
  }

  public discover(building: CityBuilding): void {
    if (!this.options.sourceBoundToCurrentFrame()) {
      this.render(building);
      return;
    }
    this.options.elements.details.hidden = true;
    void this.options.providerDiscovery.discover().then(() => {
      if (this.options.selectedBuilding()?.id === building.id) this.render(building);
    });
  }

  private cancelRequest(): void {
    this.generation += 1;
    this.requestController?.abort();
    this.requestController = undefined;
  }

  private preparePreview(context: ViewerAiGuidanceContext): void {
    const jobId = this.options.currentJobId();
    const focusKey = this.options.focusKey();
    if (jobId === undefined || !this.options.sourceAvailable() || focusKey === undefined) return;
    this.clearResult();
    const fields = this.options.elements;
    const controller = new AbortController();
    this.requestController = controller;
    fields.prepare.disabled = true;
    const focusGeneration = ++this.generation;
    const stillCurrent = (): boolean =>
      !controller.signal.aborted &&
      this.requestController === controller &&
      this.generation === focusGeneration &&
      this.options.focusKey() === focusKey;
    let previewRequest: AbortController | undefined;
    let previewGeneration = 0;
    controller.signal.addEventListener("abort", () => previewRequest?.abort(), { once: true });
    fields.summary.textContent = "Preparing preview";
    fields.details.open = true;
    fields.status.textContent = "No source has been sent to an AI provider.";
    const loadPreview = (providerId: string): void => {
      previewRequest?.abort();
      const generation = ++previewGeneration;
      const previewController = new AbortController();
      previewRequest = previewController;
      if (controller.signal.aborted) previewController.abort();
      fields.request.hidden = true;
      fields.request.onclick = null;
      fields.preview.hidden = true;
      fields.status.textContent = "Preparing exact server-verified preview…";
      void this.options.api.aiGuidancePreview(jobId, context, providerId, previewController.signal)
        .then((value) => {
          if (!stillCurrent() || previewController.signal.aborted || generation !== previewGeneration || fields.provider.value !== providerId) return;
          const preview = value.preview;
          if (!preview.enabled) {
            this.reset();
            return;
          }
          if (preview.provider.id !== providerId) throw new Error("AI guidance preview was invalid.");
          if (preview.availability === "unavailable") {
            fields.summary.textContent = "Context unavailable";
            fields.status.textContent = `${preview.reason} No source was sent to an AI provider.`;
            fields.preview.textContent = JSON.stringify({ context: preview.context, availability: preview.availability, reason: preview.reason }, null, 2);
            fields.preview.hidden = false;
            return;
          }
          const grant = preview.grant;
          if (preview.transmission.providerId !== providerId) throw new Error("AI guidance transmission did not match its provider.");
          fields.summary.textContent = "Preview ready";
          fields.prepare.disabled = false;
          fields.status.textContent = `This exact server-verified source and findings will be sent once to ${preview.provider.label} after you confirm.`;
          fields.preview.textContent = JSON.stringify(preview.transmission, null, 2);
          fields.preview.hidden = false;
          fields.request.hidden = false;
          fields.request.disabled = false;
          fields.request.onclick = () => {
            if (!stillCurrent() || generation !== previewGeneration || fields.provider.value !== providerId) return;
            fields.request.onclick = null;
            fields.request.disabled = true;
            fields.provider.disabled = true;
            fields.status.textContent = "Requesting optional suggestions…";
            const expectedTransmission = preview.transmission;
            void this.options.api.aiGuidanceRequest(grant, preview.limits.timeoutMs, controller.signal)
              .then((result) => {
                if (!stillCurrent() || generation !== previewGeneration) return;
                if (
                  result.result.provider.id !== providerId ||
                  result.result.contextDigest !== expectedTransmission.contextDigest ||
                  result.result.findingDigest !== expectedTransmission.findingDigest ||
                  JSON.stringify(result.result.context) !== JSON.stringify(expectedTransmission.context) ||
                  result.result.suggestions.some(({ citation }) => citation.path !== expectedTransmission.source.path || citation.startLine !== expectedTransmission.context.range.startLine || citation.endLine !== expectedTransmission.context.range.endLine)
                ) throw new Error("AI provider response did not match the selected context.");
                fields.suggestions.replaceChildren();
                for (const suggestion of result.result.suggestions) {
                  if (typeof suggestion.title !== "string" || typeof suggestion.detail !== "string") continue;
                  const item = document.createElement("li");
                  const citation = suggestion.citation;
                  item.textContent = `${suggestion.title}: ${suggestion.detail}` + (citation?.path === undefined ? "" : ` (${citation.path}:${citation.startLine}–${citation.endLine})`);
                  fields.suggestions.append(item);
                }
                fields.suggestions.hidden = false;
                fields.request.hidden = true;
                fields.summary.textContent = "Suggestions";
                fields.status.textContent = "Suggestions are optional; deterministic findings above are unchanged.";
              })
              .catch(() => {
                if (stillCurrent()) {
                  this.clearResult();
                  fields.details.hidden = false;
                  fields.details.open = true;
                  fields.prepare.hidden = false;
                  fields.prepare.disabled = false;
                  fields.summary.textContent = "Preview required";
                  fields.status.textContent = "AI suggestions are unavailable; deterministic analysis and source navigation remain available.";
                }
              });
          };
        })
        .catch(() => {
          if (stillCurrent() && !previewController.signal.aborted && generation === previewGeneration) {
            this.clearResult();
            fields.details.hidden = false;
            fields.details.open = true;
            fields.prepare.hidden = false;
            fields.prepare.disabled = false;
            fields.summary.textContent = "Preview required";
            fields.status.textContent = "AI guidance preview is unavailable; retry requires another explicit preview.";
          }
        });
    };
    loadPreview(fields.provider.value);
  }
}
