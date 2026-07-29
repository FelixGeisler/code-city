import { constants, promises as fs, type Stats } from "node:fs";

import {
  publishArtifactsAtomically,
  type ArtifactPublicationOptions,
} from "./artifact-publication.js";

const READ_CHUNK_BYTES = 64 * 1024;

export const CLI_JSON_LIMITS = Object.freeze({
  cityModelBytes: 128 * 1024 * 1024,
  printerProfileBytes: 1 * 1024 * 1024,
});

class CliJsonInputError extends Error {}

function errorCode(error: unknown): string | undefined {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

/**
 * Reads JSON without trusting a preliminary file size. The extra byte probe
 * also catches a regular file that grows after it was opened.
 */
export async function readBoundedJsonFile(
  filePath: string,
  description: string,
  maximumBytes: number,
): Promise<unknown> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new TypeError("The JSON byte limit must be a positive safe integer.");
  }

  let handle;
  let beforeOpen: Stats;
  try {
    beforeOpen = await fs.lstat(filePath);
    if (beforeOpen.isSymbolicLink() || !beforeOpen.isFile()) {
      throw new CliJsonInputError(
        `${description} input must be a regular file.`,
      );
    }
    handle = await fs.open(
      filePath,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if (error instanceof CliJsonInputError) throw error;
    const code = errorCode(error);
    throw new CliJsonInputError(
      `Cannot read ${description} input${code === undefined ? "" : ` (${code})`}.`,
    );
  }

  let bytes: Buffer;
  try {
    const status = await handle.stat();
    if (!status.isFile()) {
      throw new CliJsonInputError(
        `${description} input must be a regular file.`,
      );
    }
    if (status.dev !== beforeOpen.dev || status.ino !== beforeOpen.ino) {
      throw new CliJsonInputError(
        `${description} input changed while it was being opened.`,
      );
    }
    if (status.size > maximumBytes) {
      throw new CliJsonInputError(
        `${description} input exceeds the ${maximumBytes}-byte limit.`,
      );
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (true) {
      const remaining = maximumBytes - totalBytes;
      const buffer = Buffer.allocUnsafe(
        Math.min(READ_CHUNK_BYTES, remaining + 1),
      );
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.byteLength,
        null,
      );
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > maximumBytes) {
        throw new CliJsonInputError(
          `${description} input exceeds the ${maximumBytes}-byte limit.`,
        );
      }
      chunks.push(buffer.subarray(0, bytesRead));
    }
    bytes = Buffer.concat(chunks, totalBytes);
  } catch (error) {
    if (error instanceof CliJsonInputError) throw error;
    const code = errorCode(error);
    throw new CliJsonInputError(
      `Cannot read ${description} input${code === undefined ? "" : ` (${code})`}.`,
    );
  } finally {
    await handle.close().catch(() => undefined);
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new CliJsonInputError(`Invalid JSON in ${description} input.`);
  }
}

/**
 * Serializes and atomically replaces derived JSON with owner-only permissions
 * on platforms that enforce POSIX modes.
 */
export async function publishPrivateJson(
  filePath: string,
  value: unknown,
  description: string,
  options: ArtifactPublicationOptions = {},
): Promise<string> {
  let bytes: Uint8Array;
  try {
    const serialized = JSON.stringify(value, null, 2);
    if (serialized === undefined) throw new TypeError("Not JSON serializable.");
    bytes = new TextEncoder().encode(`${serialized}\n`);
  } catch {
    throw new Error(`Cannot serialize ${description}.`);
  }

  try {
    const [publishedPath] = await publishArtifactsAtomically(
      [{ destination: filePath, bytes, mode: 0o600 }],
      options,
    );
    return publishedPath!;
  } catch {
    throw new Error(`Cannot publish ${description} atomically.`);
  }
}
