import { normalizeAssetRelativePath } from "../../../packages/core/src/identity.js";
import type { SemanticGroup } from "../../../packages/core/src/model.js";

const MEBIBYTE = 1024 * 1024;

export const VIEWER_MODEL_MAX_BYTES = 128 * MEBIBYTE;
export const VIEWER_PROFILE_MAX_BYTES = MEBIBYTE;
export const VIEWER_LOGO_MAX_BYTES = 2 * MEBIBYTE;
export const VIEWER_LOAD_DEADLINE_MS = 30_000;

export type ViewerLocalJsonKind = "model" | "profile";
export type ViewerLogoFormat = "png" | "svg";

export interface LoadedViewerImage {
  readonly objectUrl: string;
  dispose(): void;
}

export type ViewerFetch = (
  input: string | URL,
  init: RequestInit,
) => Promise<Response>;

export interface ViewerLoadGatewayOptions {
  readonly fetch?: ViewerFetch;
  readonly deadlineMs?: number;
  readonly scheduleDeadline?: (
    callback: () => void,
    milliseconds: number,
  ) => unknown;
  readonly clearDeadline?: (handle: unknown) => void;
  readonly createObjectUrl?: (blob: Blob) => string;
  readonly revokeObjectUrl?: (url: string) => void;
}

export class ViewerLoadError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ViewerLoadError";
  }
}

export interface AutomaticModelLoadAttempt {
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
  readonly finish: () => void;
}

export class AutomaticModelLoadGate {
  private generation = 0;
  private controller: AbortController | undefined;

  public begin(): AutomaticModelLoadAttempt {
    this.invalidate();
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    return {
      signal: controller.signal,
      isCurrent: () =>
        this.generation === generation &&
        this.controller === controller &&
        !controller.signal.aborted,
      finish: () => {
        if (
          this.generation === generation &&
          this.controller === controller
        ) {
          this.controller = undefined;
        }
      },
    };
  }

  public invalidate(): void {
    this.generation += 1;
    this.controller?.abort();
    this.controller = undefined;
  }
}

function maximumBytes(kind: ViewerLocalJsonKind): number {
  return kind === "model"
    ? VIEWER_MODEL_MAX_BYTES
    : VIEWER_PROFILE_MAX_BYTES;
}

function purposeLabel(
  purpose: ViewerLocalJsonKind | "logo",
): string {
  switch (purpose) {
    case "model":
      return "City model";
    case "profile":
      return "Printer profile";
    case "logo":
      return "Logo";
  }
}

function byteLimitMessage(
  purpose: ViewerLocalJsonKind | "logo",
  maxBytes: number,
): string {
  return `${purposeLabel(purpose)} exceeds the ${maxBytes.toLocaleString(
    "en-US",
  )}-byte viewer limit.`;
}

function abortError(): DOMException {
  return new DOMException("The viewer load was cancelled.", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

async function waitForAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  return await new Promise<T>((resolve, reject) => {
    const aborted = (): void => {
      reject(abortError());
    };
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  purpose: ViewerLocalJsonKind | "logo",
  signal: AbortSignal,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let completed = false;
  try {
    for (;;) {
      const item = await waitForAbort(reader.read(), signal);
      if (item.done) {
        completed = true;
        break;
      }
      const chunk = item.value;
      if (chunk.byteLength > maxBytes - byteLength) {
        throw new ViewerLoadError(byteLimitMessage(purpose, maxBytes));
      }
      byteLength += chunk.byteLength;
      chunks.push(chunk);
    }
  } finally {
    if (!completed) {
      void reader
        .cancel()
        .catch(() => {
          // The original boundary failure remains the useful error.
        })
        .finally(() => {
          try {
            reader.releaseLock();
          } catch {
            // A pending read retains the lock only until cancellation settles.
          }
        });
    } else {
      reader.releaseLock();
    }
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function decodeUtf8(
  bytes: Uint8Array,
  purpose: ViewerLocalJsonKind,
): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ViewerLoadError(
      `${purposeLabel(purpose)} must contain valid UTF-8 JSON.`,
    );
  }
}

function parseJson(text: string, purpose: ViewerLocalJsonKind): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ViewerLoadError(
      `${purposeLabel(purpose)} must contain valid JSON.`,
    );
  }
}

function parseContentLength(
  response: Response,
  maxBytes: number,
  purpose: ViewerLocalJsonKind | "logo",
): void {
  const header = response.headers.get("content-length");
  if (header === null) return;
  if (!/^\d+$/u.test(header)) {
    throw new ViewerLoadError(
      `${purposeLabel(purpose)} returned an invalid Content-Length.`,
    );
  }
  const length = Number(header);
  if (!Number.isSafeInteger(length) || length > maxBytes) {
    throw new ViewerLoadError(byteLimitMessage(purpose, maxBytes));
  }
}

function canonicalRemoteUrl(input: URL): string {
  const canonical = new URL(input.href);
  canonical.hash = "";
  return canonical.href;
}

function validateRemoteUrl(input: URL): URL {
  if (input.protocol !== "http:" && input.protocol !== "https:") {
    throw new ViewerLoadError("Remote viewer loads require HTTP or HTTPS.");
  }
  if (input.username !== "" || input.password !== "") {
    throw new ViewerLoadError(
      "Remote viewer URLs must not contain credentials.",
    );
  }
  return input;
}

export function remoteViewerDisplayUrl(input: URL): string {
  const display = new URL(validateRemoteUrl(new URL(input.href)).href);
  display.search = "";
  display.hash = "";
  return display.href;
}

function pngBytes(bytes: Uint8Array): boolean {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10] as const;
  return (
    bytes.byteLength >= signature.length &&
    signature.every((value, index) => bytes[index] === value)
  );
}

function logoMimeType(
  bytes: Uint8Array,
  format: ViewerLogoFormat,
): string {
  if (format === "png") {
    if (!pngBytes(bytes)) {
      throw new ViewerLoadError("Logo bytes do not contain a PNG image.");
    }
    return "image/png";
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ViewerLoadError("SVG logos must contain valid UTF-8.");
  }
  const start = text.replace(/^\uFEFF/u, "").trimStart();
  if (!/^(?:<\?xml[\s\S]*?\?>\s*)?<svg(?:\s|>)/iu.test(start)) {
    throw new ViewerLoadError("Logo bytes do not contain an SVG image.");
  }
  if (
    /<(?:script|foreignObject|iframe|object|embed|image|audio|video|style)\b/iu.test(
      start,
    ) ||
    /<!DOCTYPE\b|<\?xml-stylesheet\b/iu.test(start) ||
    /\son[a-z][a-z0-9_-]*\s*=/iu.test(start) ||
    /\b(?:href|xlink:href|src)\s*=\s*(?:"(?!#)|'(?!#)|[^\s"'#>])/iu.test(
      start,
    ) ||
    /@import\b|url\(\s*["']?(?!#)/iu.test(start)
  ) {
    throw new ViewerLoadError(
      "SVG logos must not contain executable or external content.",
    );
  }
  return "image/svg+xml";
}

export class ViewerLoadGateway {
  private readonly fetchImplementation: ViewerFetch;
  private readonly deadlineMs: number;
  private readonly scheduleDeadline: (
    callback: () => void,
    milliseconds: number,
  ) => unknown;
  private readonly clearDeadline: (handle: unknown) => void;
  private readonly createObjectUrl: (blob: Blob) => string;
  private readonly revokeObjectUrl: (url: string) => void;

  public constructor(options: ViewerLoadGatewayOptions = {}) {
    this.fetchImplementation =
      options.fetch ??
      ((input, init) => globalThis.fetch(input, init));
    this.deadlineMs = options.deadlineMs ?? VIEWER_LOAD_DEADLINE_MS;
    if (!Number.isSafeInteger(this.deadlineMs) || this.deadlineMs <= 0) {
      throw new TypeError("The viewer load deadline must be a positive integer.");
    }
    this.scheduleDeadline =
      options.scheduleDeadline ??
      ((callback, milliseconds) =>
        globalThis.setTimeout(callback, milliseconds));
    this.clearDeadline =
      options.clearDeadline ??
      ((handle) => globalThis.clearTimeout(handle as number));
    this.createObjectUrl =
      options.createObjectUrl ??
      ((blob) => URL.createObjectURL(blob));
    this.revokeObjectUrl =
      options.revokeObjectUrl ??
      ((url) => URL.revokeObjectURL(url));
  }

  public async loadLocalJson(
    file: Blob,
    kind: ViewerLocalJsonKind,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return parseJson(
      await this.loadLocalText(file, kind, signal),
      kind,
    );
  }

  public async loadLocalText(
    file: Blob,
    kind: ViewerLocalJsonKind,
    signal?: AbortSignal,
  ): Promise<string> {
    const maxBytes = maximumBytes(kind);
    if (
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > maxBytes
    ) {
      throw new ViewerLoadError(byteLimitMessage(kind, maxBytes));
    }
    const bytes = await this.withDeadline(kind, signal, async (loadSignal) =>
      readBoundedStream(file.stream(), maxBytes, kind, loadSignal),
    );
    return decodeUtf8(bytes, kind);
  }

  public async loadRemoteModel(
    input: URL,
    signal?: AbortSignal,
  ): Promise<{
    readonly model: unknown;
    readonly responseUrl: URL;
  }> {
    const loaded = await this.loadRemoteBytes(
      input,
      "model",
      VIEWER_MODEL_MAX_BYTES,
      signal,
    );
    return {
      model: parseJson(decodeUtf8(loaded.bytes, "model"), "model"),
      responseUrl: loaded.responseUrl,
    };
  }

  public async loadRemoteLogo(
    input: URL,
    format: ViewerLogoFormat,
    signal?: AbortSignal,
  ): Promise<LoadedViewerImage> {
    const loaded = await this.loadRemoteBytes(
      input,
      "logo",
      VIEWER_LOGO_MAX_BYTES,
      signal,
    );
    const blob = new Blob([loaded.bytes.buffer as ArrayBuffer], {
      type: logoMimeType(loaded.bytes, format),
    });
    const objectUrl = this.createObjectUrl(blob);
    if (!objectUrl.startsWith("blob:")) {
      this.revokeObjectUrl(objectUrl);
      throw new ViewerLoadError("The viewer image URL must use a Blob URL.");
    }
    let active = true;
    return {
      objectUrl,
      dispose: () => {
        if (!active) return;
        active = false;
        this.revokeObjectUrl(objectUrl);
      },
    };
  }

  private async loadRemoteBytes(
    input: URL,
    purpose: "model" | "logo",
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<{
    readonly bytes: Uint8Array;
    readonly responseUrl: URL;
  }> {
    const requestedUrl = validateRemoteUrl(new URL(input.href));
    return await this.withDeadline(
      purpose,
      signal,
      async (loadSignal) => {
        let response: Response;
        try {
          response = await waitForAbort(
            this.fetchImplementation(requestedUrl, {
              method: "GET",
              cache: "no-store",
              credentials: "omit",
              redirect: "error",
              referrerPolicy: "no-referrer",
              mode: "cors",
              signal: loadSignal,
            }),
            loadSignal,
          );
        } catch (error) {
          if (loadSignal.aborted) throw error;
          throw new ViewerLoadError(
            `Remote ${purposeLabel(purpose).toLowerCase()} request failed.`,
          );
        }

        if (
          response.redirected ||
          response.type === "opaqueredirect"
        ) {
          throw new ViewerLoadError(
            `Remote ${purposeLabel(purpose).toLowerCase()} redirects are not allowed.`,
          );
        }
        const responseUrl =
          response.url === ""
            ? requestedUrl
            : validateRemoteUrl(new URL(response.url));
        if (
          canonicalRemoteUrl(responseUrl) !==
          canonicalRemoteUrl(requestedUrl)
        ) {
          throw new ViewerLoadError(
            `Remote ${purposeLabel(purpose).toLowerCase()} redirects are not allowed.`,
          );
        }
        if (!response.ok) {
          throw new ViewerLoadError(
            `Remote ${purposeLabel(purpose).toLowerCase()} request failed with HTTP ${response.status}.`,
          );
        }
        parseContentLength(response, maxBytes, purpose);
        if (response.body === null) {
          return { bytes: new Uint8Array(), responseUrl };
        }
        return {
          bytes: await readBoundedStream(
            response.body,
            maxBytes,
            purpose,
            loadSignal,
          ),
          responseUrl,
        };
      },
    );
  }

  private async withDeadline<T>(
    purpose: ViewerLocalJsonKind | "logo",
    externalSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let deadlineExceeded = false;
    const abortFromCaller = (): void => {
      controller.abort();
    };
    if (externalSignal?.aborted) {
      controller.abort();
    } else {
      externalSignal?.addEventListener("abort", abortFromCaller, {
        once: true,
      });
    }
    const deadline = this.scheduleDeadline(() => {
      deadlineExceeded = true;
      controller.abort();
    }, this.deadlineMs);
    try {
      throwIfAborted(controller.signal);
      const pending = operation(controller.signal);
      return await waitForAbort(
        pending,
        controller.signal,
      );
    } catch (error) {
      if (deadlineExceeded) {
        throw new ViewerLoadError(
          `${purposeLabel(purpose)} load exceeded the ${this.deadlineMs.toLocaleString(
            "en-US",
          )} ms viewer deadline.`,
        );
      }
      throw error;
    } finally {
      this.clearDeadline(deadline);
      externalSignal?.removeEventListener("abort", abortFromCaller);
    }
  }
}

export function assetRootFromResponseUrl(responseUrl: string): URL {
  const response = validateRemoteUrl(new URL(responseUrl));
  return new URL(".", response);
}

export function resolveAssetUrl(
  relativePath: string,
  assetRoot: URL,
): URL {
  const normalized = normalizeAssetRelativePath(relativePath);
  if (normalized !== relativePath) {
    throw new TypeError(
      "Logo paths in a city model must already be normalized.",
    );
  }
  if (
    (assetRoot.protocol !== "http:" && assetRoot.protocol !== "https:") ||
    !assetRoot.pathname.endsWith("/") ||
    assetRoot.username !== "" ||
    assetRoot.password !== ""
  ) {
    throw new TypeError(
      "The asset root must be a credential-free HTTP(S) directory URL.",
    );
  }

  const resolved = new URL(normalized, assetRoot);
  if (
    resolved.origin !== assetRoot.origin ||
    resolved.protocol !== assetRoot.protocol ||
    !resolved.pathname.startsWith(assetRoot.pathname)
  ) {
    throw new TypeError("Resolved logo URL escapes the model asset root.");
  }
  return resolved;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sortLegendGroups(
  groups: readonly SemanticGroup[],
): readonly SemanticGroup[] {
  return [...groups].sort(
    (left, right) =>
      right.priority - left.priority ||
      compareText(left.label, right.label) ||
      compareText(left.id, right.id),
  );
}
