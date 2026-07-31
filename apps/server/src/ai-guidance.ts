import net from "node:net";

export const AI_GUIDANCE_CONFIG_VERSION = 1;
export const AI_GUIDANCE_MAX_SOURCE_BYTES = 128 * 1024;
export const AI_GUIDANCE_MAX_RESPONSE_BYTES = 256 * 1024;
export const AI_GUIDANCE_DEFAULT_TIMEOUT_MS = 20_000;

const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Cs}]/u;

export interface AiGuidanceProviderConfiguration {
  readonly id: string;
  readonly label: string;
  /** Administrator-only HTTP endpoint. This is never included in API output. */
  readonly endpoint: string;
  /** Administrator-only credential. This is never serialized or logged. */
  readonly authorization?: { readonly header: string; readonly value: string };
}

export interface AiGuidanceConfiguration {
  readonly version: typeof AI_GUIDANCE_CONFIG_VERSION;
  readonly enabled: boolean;
  readonly providers: readonly AiGuidanceProviderConfiguration[];
  readonly timeoutMs?: number;
  readonly maximumSourceBytes?: number;
}

export interface AiGuidanceSource {
  readonly jobId: string;
  readonly buildingId: string;
  readonly path: string;
  readonly language: string;
  readonly text: string;
  readonly location: { readonly startLine: number; readonly endLine: number };
}

export interface AiGuidanceMetrics {
  readonly sloc: number;
  readonly maximumComplexity: number;
  readonly decisionLoad: number;
}

export interface AiGuidancePreview {
  readonly enabled: boolean;
  readonly provider?: { readonly id: string; readonly label: string };
  readonly source?: Pick<AiGuidanceSource, "buildingId" | "path" | "language" | "text" | "location">;
  readonly metrics?: AiGuidanceMetrics;
  readonly limits: { readonly timeoutMs: number; readonly maximumSourceBytes: number };
  readonly privacy: "no-prompt-storage";
}

export interface AiGuidanceSuggestion {
  readonly title: string;
  readonly detail: string;
  readonly citation: { readonly path: string; readonly startLine: number; readonly endLine: number };
}

export interface AiGuidanceResult {
  readonly provider: { readonly id: string; readonly label: string };
  readonly suggestions: readonly AiGuidanceSuggestion[];
}

export type AiGuidanceFetch = (input: string | URL, init: RequestInit) => Promise<Response>;

export interface AiGuidanceAdapterOptions {
  readonly fetch?: AiGuidanceFetch;
  /** Audit output contains only metadata; prompt and credentials are deliberately absent. */
  readonly audit?: (event: Readonly<{ providerId: string; buildingId: string; outcome: "completed" | "cancelled" | "failed"; sourceBytes: number; durationMs: number }>) => void;
}

function checkedText(value: string, label: string, maximum: number): void {
  if (value.length === 0 || value.length > maximum || UNSAFE_TEXT.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
}

function localAddress(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  const address =
    normalized.startsWith("[") && normalized.endsWith("]")
      ? normalized.slice(1, -1)
      : normalized;
  const family = net.isIP(address);
  if (family === 4) return address.startsWith("127.");
  return family === 6 && address === "::1";
}

function safeEndpoint(value: string): URL {
  let endpoint: URL;
  try { endpoint = new URL(value); } catch { throw new Error("AI provider endpoint must be an absolute URL."); }
  if (endpoint.username !== "" || endpoint.password !== "" || endpoint.search !== "" || endpoint.hash !== "" || !["http:", "https:"].includes(endpoint.protocol)) {
    throw new Error("AI provider endpoint must be a credential-free HTTP(S) URL without query or fragment.");
  }
  const local = localAddress(endpoint.hostname);
  if (endpoint.protocol === "http:" && !local) throw new Error("Remote AI provider endpoints must use HTTPS.");
  if (local && endpoint.protocol !== "http:" && endpoint.protocol !== "https:") throw new Error("Local AI provider endpoint is invalid.");
  return endpoint;
}

function normalized(config: AiGuidanceConfiguration | undefined): Required<Pick<AiGuidanceConfiguration, "enabled">> & { readonly providers: readonly (AiGuidanceProviderConfiguration & { readonly url: URL })[]; readonly timeoutMs: number; readonly maximumSourceBytes: number } {
  if (config === undefined) return Object.freeze({ enabled: false, providers: Object.freeze([]), timeoutMs: AI_GUIDANCE_DEFAULT_TIMEOUT_MS, maximumSourceBytes: AI_GUIDANCE_MAX_SOURCE_BYTES });
  if (config.version !== AI_GUIDANCE_CONFIG_VERSION || typeof config.enabled !== "boolean" || !Array.isArray(config.providers)) throw new Error("AI guidance configuration must use version 1.");
  const timeoutMs = config.timeoutMs ?? AI_GUIDANCE_DEFAULT_TIMEOUT_MS;
  const maximumSourceBytes = config.maximumSourceBytes ?? AI_GUIDANCE_MAX_SOURCE_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000 || !Number.isSafeInteger(maximumSourceBytes) || maximumSourceBytes < 1 || maximumSourceBytes > AI_GUIDANCE_MAX_SOURCE_BYTES) throw new Error("AI guidance limits are invalid.");
  const ids = new Set<string>();
  const providers = config.providers.map((provider) => {
    if (!PROVIDER_ID.test(provider.id) || ids.has(provider.id)) throw new Error("AI provider ID is invalid or duplicated.");
    ids.add(provider.id); checkedText(provider.label, "AI provider label", 120);
    const url = safeEndpoint(provider.endpoint);
    if (provider.authorization !== undefined) {
      if (!/^[A-Za-z0-9-]{1,64}$/u.test(provider.authorization.header) || provider.authorization.header.toLowerCase() === "host" || provider.authorization.value.length === 0 || provider.authorization.value.length > 8_192 || /[\r\n]/u.test(provider.authorization.value)) throw new Error("AI provider authorization is invalid.");
    }
    return Object.freeze({ ...provider, url });
  });
  if (config.enabled && providers.length === 0) throw new Error("Enabled AI guidance requires at least one provider.");
  return Object.freeze({ enabled: config.enabled, providers: Object.freeze(providers), timeoutMs, maximumSourceBytes });
}

function publicProvider(provider: AiGuidanceProviderConfiguration | undefined): { readonly id: string; readonly label: string } | undefined {
  return provider === undefined ? undefined : Object.freeze({ id: provider.id, label: provider.label });
}

function validSource(source: AiGuidanceSource, limit: number): void {
  if (!PROVIDER_ID.test(source.buildingId.split(":")[0] ?? "") || source.path.length === 0 || source.path.length > 4_096 || UNSAFE_TEXT.test(source.path) || !Number.isSafeInteger(source.location.startLine) || !Number.isSafeInteger(source.location.endLine) || source.location.startLine < 1 || source.location.endLine < source.location.startLine || new TextEncoder().encode(source.text).byteLength > limit) throw new Error("Selected source is outside the AI guidance limits.");
}

function validMetrics(metrics: AiGuidanceMetrics): void {
  for (const value of [
    metrics.sloc,
    metrics.maximumComplexity,
    metrics.decisionLoad,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("AI guidance metrics are invalid.");
    }
  }
}

function responseSuggestions(value: unknown, source: AiGuidanceSource): readonly AiGuidanceSuggestion[] {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !Array.isArray((value as Record<string, unknown>)["suggestions"])) throw new Error("AI provider returned an invalid response.");
  const suggestions = (value as Record<string, unknown>)["suggestions"] as unknown[];
  if (suggestions.length > 20) throw new Error("AI provider returned too many suggestions.");
  return Object.freeze(suggestions.map((suggestion) => {
    if (typeof suggestion !== "object" || suggestion === null || Array.isArray(suggestion)) throw new Error("AI provider returned an invalid suggestion.");
    const item = suggestion as Record<string, unknown>;
    if (typeof item["title"] !== "string" || typeof item["detail"] !== "string") throw new Error("AI provider returned an invalid suggestion.");
    checkedText(item["title"], "AI suggestion title", 500); checkedText(item["detail"], "AI suggestion detail", 8_000);
    return Object.freeze({ title: item["title"], detail: item["detail"], citation: Object.freeze({ path: source.path, startLine: source.location.startLine, endLine: source.location.endLine }) });
  }));
}

async function boundedResponseText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const bytes = Number(declared);
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > maximumBytes
    ) {
      throw new Error("AI provider response exceeded the size limit.");
    }
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      received += result.value.byteLength;
      if (received > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("AI provider response exceeded the size limit.");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("AI provider returned invalid UTF-8.");
  }
}

export class AiGuidanceAdapter {
  readonly #config: ReturnType<typeof normalized>;
  readonly #fetch: AiGuidanceFetch;
  readonly #audit: AiGuidanceAdapterOptions["audit"];

  public constructor(config: AiGuidanceConfiguration | undefined, options: AiGuidanceAdapterOptions = {}) {
    this.#config = normalized(config); this.#fetch = options.fetch ?? fetch; this.#audit = options.audit;
  }

  public get enabled(): boolean { return this.#config.enabled; }

  public disabledPreview(): AiGuidancePreview {
    return Object.freeze({ enabled: false, limits: Object.freeze({ timeoutMs: this.#config.timeoutMs, maximumSourceBytes: this.#config.maximumSourceBytes }), privacy: "no-prompt-storage" });
  }

  public preview(
    source: AiGuidanceSource,
    metrics: AiGuidanceMetrics,
  ): AiGuidancePreview {
    const provider = this.#config.providers[0];
    if (!this.#config.enabled || provider === undefined) return this.disabledPreview();
    validSource(source, this.#config.maximumSourceBytes);
    validMetrics(metrics);
    return Object.freeze({ enabled: true, provider: Object.freeze({ id: provider.id, label: provider.label }), source: Object.freeze({ buildingId: source.buildingId, path: source.path, language: source.language, text: source.text, location: source.location }), metrics: Object.freeze({ ...metrics }), limits: Object.freeze({ timeoutMs: this.#config.timeoutMs, maximumSourceBytes: this.#config.maximumSourceBytes }), privacy: "no-prompt-storage" });
  }

  public async request(source: AiGuidanceSource, metrics: AiGuidanceMetrics, signal?: AbortSignal): Promise<AiGuidanceResult> {
    const preview = this.preview(source, metrics); const provider = this.#config.providers[0];
    if (!preview.enabled || provider === undefined) throw new Error("AI guidance is disabled by the administrator.");
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(new Error("AI guidance request timed out.")), this.#config.timeoutMs);
    const forwardAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) controller.abort(signal.reason);
    else signal?.addEventListener("abort", forwardAbort, { once: true });
    const started = Date.now(); const bytes = new TextEncoder().encode(source.text).byteLength;
    try {
      controller.signal.throwIfAborted();
      const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
      if (provider.authorization !== undefined) headers[provider.authorization.header] = provider.authorization.value;
      const response = await this.#fetch(provider.url, { method: "POST", headers, redirect: "error", signal: controller.signal, body: JSON.stringify({ version: 1, task: "source-guidance", source: { path: source.path, language: source.language, text: source.text, lines: source.location }, findings: metrics }) });
      if (!response.ok) throw new Error("Configured AI provider did not complete the request.");
      const text = await boundedResponseText(response, AI_GUIDANCE_MAX_RESPONSE_BYTES);
      const suggestions = responseSuggestions(JSON.parse(text), source); this.#audit?.({ providerId: provider.id, buildingId: source.buildingId, outcome: "completed", sourceBytes: bytes, durationMs: Date.now() - started });
      return Object.freeze({ provider: publicProvider(provider)!, suggestions });
    } catch (error) {
      this.#audit?.({ providerId: provider.id, buildingId: source.buildingId, outcome: controller.signal.aborted ? "cancelled" : "failed", sourceBytes: bytes, durationMs: Date.now() - started });
      if (controller.signal.aborted) throw new Error("AI guidance request was cancelled or timed out.");
      throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", forwardAbort); }
  }
}
