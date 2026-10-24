export interface WireHeader {
  readonly name: string;
  readonly value: Buffer;
}

export interface WireRequestHead {
  readonly headers: readonly WireHeader[];
}

const MAX_OBSERVED_LINE_OR_HEAD_BYTES = 65_536;

type Phase = "headers" | "fixed" | "chunk-size" | "chunk-data" | "chunk-crlf" | "trailers";

function trimmedAscii(value: Buffer): string {
  return value.toString("latin1").trim();
}

export class RequestWireObserver {
  readonly #queue: WireRequestHead[] = [];
  #phase: Phase = "headers";
  #pending: number[] = [];
  #remaining = 0;
  #chunkCrlfBytes = 0;
  #disabled = false;

  public shift(): WireRequestHead | undefined {
    return this.#queue.shift();
  }

  public feed(chunk: Buffer): void {
    if (this.#disabled) return;
    let offset = 0;
    try {
      while (offset < chunk.byteLength) {
        if (this.#phase === "fixed" || this.#phase === "chunk-data") {
          const skipped = Math.min(this.#remaining, chunk.byteLength - offset);
          this.#remaining -= skipped;
          offset += skipped;
          if (this.#remaining === 0) this.#phase = this.#phase === "fixed" ? "headers" : "chunk-crlf";
          continue;
        }
        if (this.#phase === "chunk-crlf") {
          const expected = this.#chunkCrlfBytes === 0 ? 0x0d : 0x0a;
          if (chunk[offset] !== expected) throw new Error("Invalid chunk delimiter");
          this.#chunkCrlfBytes += 1;
          offset += 1;
          if (this.#chunkCrlfBytes === 2) {
            this.#chunkCrlfBytes = 0;
            this.#phase = "chunk-size";
          }
          continue;
        }

        this.#pending.push(chunk[offset] ?? 0);
        offset += 1;
        if (this.#pending.length > MAX_OBSERVED_LINE_OR_HEAD_BYTES) throw new Error("Observed head is too large");

        if (this.#phase === "headers") {
          const length = this.#pending.length;
          if (length >= 4
              && this.#pending[length - 4] === 0x0d
              && this.#pending[length - 3] === 0x0a
              && this.#pending[length - 2] === 0x0d
              && this.#pending[length - 1] === 0x0a) {
            const head = Buffer.from(this.#pending.slice(0, -4));
            this.#pending = [];
            this.#acceptHead(head);
          }
          continue;
        }

        const length = this.#pending.length;
        if (length >= 2 && this.#pending[length - 2] === 0x0d && this.#pending[length - 1] === 0x0a) {
          const line = Buffer.from(this.#pending.slice(0, -2));
          this.#pending = [];
          if (this.#phase === "chunk-size") {
            const token = line.toString("latin1").split(";", 1)[0] ?? "";
            if (!/^[0-9A-Fa-f]+$/u.test(token)) throw new Error("Invalid chunk size");
            const size = Number.parseInt(token, 16);
            if (!Number.isSafeInteger(size)) throw new Error("Invalid chunk size");
            if (size === 0) {
              this.#phase = "trailers";
            } else {
              this.#remaining = size;
              this.#phase = "chunk-data";
            }
          } else if (line.byteLength === 0) {
            this.#phase = "headers";
          }
        }
      }
    } catch {
      this.#disabled = true;
      this.#pending = [];
      this.#queue.length = 0;
    }
  }

  #acceptHead(head: Buffer): void {
    const lines = head.toString("latin1").split("\r\n");
    if (lines.length === 0 || !lines[0]) throw new Error("Missing request line");
    const headers: WireHeader[] = [];
    for (const line of lines.slice(1)) {
      const separator = line.indexOf(":");
      if (separator <= 0) throw new Error("Invalid header line");
      headers.push(Object.freeze({
        name: line.slice(0, separator),
        value: Buffer.from(line.slice(separator + 1), "latin1"),
      }));
    }
    this.#queue.push(Object.freeze({ headers: Object.freeze(headers) }));

    const transferEncodings = headers.filter((header) => header.name.toLowerCase() === "transfer-encoding");
    if (transferEncodings.length > 0) {
      const tokens = transferEncodings.flatMap((header) => trimmedAscii(header.value).toLowerCase().split(",").map((token) => token.trim()));
      if (tokens.at(-1) === "chunked") {
        this.#phase = "chunk-size";
        return;
      }
    }
    const contentLengths = headers.filter((header) => header.name.toLowerCase() === "content-length");
    if (contentLengths.length === 1 && /^[0-9]+$/u.test(trimmedAscii(contentLengths[0]?.value ?? Buffer.alloc(0)))) {
      const length = Number(trimmedAscii(contentLengths[0]?.value ?? Buffer.alloc(0)));
      if (Number.isSafeInteger(length) && length > 0) {
        this.#remaining = length;
        this.#phase = "fixed";
        return;
      }
    }
    this.#phase = "headers";
  }
}

export function exactWireHeaderValues(head: WireRequestHead, name: string): readonly Buffer[] {
  return head.headers.filter((header) => header.name.toLowerCase() === name).map((header) => header.value);
}

export function canonicalWireValue(value: Buffer): string | undefined {
  if (value.byteLength === 0) return "";
  const canonical = value[0] === 0x20 ? value.subarray(1) : value;
  if (canonical.byteLength === 0 || canonical[0] === 0x20 || canonical[0] === 0x09
      || canonical.at(-1) === 0x20 || canonical.at(-1) === 0x09) return undefined;
  return canonical.toString("latin1");
}

export function wireValueEquals(value: Buffer, expected: string): boolean {
  return canonicalWireValue(value) === expected;
}
