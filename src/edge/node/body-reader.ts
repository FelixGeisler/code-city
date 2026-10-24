import type { IncomingMessage } from "node:http";

export type BodyMode = "session" | "command";

export type BodyReadResult =
  | { readonly kind: "ok"; readonly value: undefined | unknown }
  | { readonly kind: "bad-request" }
  | { readonly kind: "too-large" }
  | { readonly kind: "aborted" };

export class BodyReaderPool {
  readonly #maximum: number;
  #active = 0;

  public constructor(maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum <= 0) throw new Error("Invalid reader capacity");
    this.#maximum = maximum;
  }

  public get active(): number {
    return this.#active;
  }

  public reserve(): (() => void) | undefined {
    if (this.#active >= this.#maximum) return undefined;
    this.#active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
    };
  }
}

export function validateApplicationContentLength(values: readonly (string | undefined)[], maximumBytes: number): "ok" | "bad-request" | "too-large" {
  if (values.length === 0) return "ok";
  if (values.length !== 1 || !/^(?:0|[1-9][0-9]*)$/u.test(values[0] ?? "")) return "bad-request";
  const length = Number(values[0]);
  if (!Number.isSafeInteger(length)) return "bad-request";
  return length > maximumBytes ? "too-large" : "ok";
}

export function readBoundedBody(
  request: IncomingMessage,
  maximumBytes: number,
  mode: BodyMode,
  release: () => void,
): Promise<BodyReadResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let retainedBytes = 0;
    let settled = false;

    const cleanup = (): void => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      request.off("error", onError);
    };
    const finish = (result: BodyReadResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      release();
      resolve(result);
    };
    const onData = (chunk: Buffer): void => {
      if (settled) return;
      if (chunk.byteLength > maximumBytes - retainedBytes) {
        request.pause();
        finish({ kind: "too-large" });
        return;
      }
      chunks.push(chunk);
      retainedBytes += chunk.byteLength;
    };
    const onEnd = (): void => {
      if (settled) return;
      const bytes = Buffer.concat(chunks, retainedBytes);
      chunks.length = 0;
      if (mode === "session") {
        finish(bytes.byteLength === 0 ? { kind: "ok", value: undefined } : { kind: "bad-request" });
        return;
      }
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        finish({ kind: "ok", value: JSON.parse(text) as unknown });
      } catch {
        finish({ kind: "bad-request" });
      }
    };
    const onAborted = (): void => finish({ kind: "aborted" });
    const onError = (): void => finish({ kind: "aborted" });

    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
    request.once("error", onError);
  });
}
