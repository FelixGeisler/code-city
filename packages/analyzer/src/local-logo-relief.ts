import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";

import {
  normalizeAssetRelativePath,
  normalizeIdentityLogoPrintRelief,
  type IdentityLogoFormat,
  type IdentityLogoPrintRelief,
} from "../../core/src/index.js";
import { LOGO_RELIEF_INPUT_MAX_BYTES } from "./logo-relief-converter.js";

export const LOCAL_LOGO_RELIEF_DEADLINE_MS = 5_000;
export const LOCAL_LOGO_RELIEF_WARNING =
  "Printable logo relief is unavailable; the fixed Code City icon will be used.";

export interface LocalLogoReliefResult {
  readonly relief?: IdentityLogoPrintRelief;
  readonly warning?: typeof LOCAL_LOGO_RELIEF_WARNING;
}

export interface LocalLogoReliefDependencies {
  readonly convert?: (
    bytes: Uint8Array,
    format: IdentityLogoFormat,
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<IdentityLogoPrintRelief>;
  readonly createWorker?: (url: URL) => LogoReliefWorker;
}

export interface LogoReliefWorker {
  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "message",
    listener: (message: {
      readonly ok?: boolean;
      readonly relief?: unknown;
    }) => void,
  ): this;
  postMessage(
    value: {
      readonly bytes: Uint8Array;
      readonly format: IdentityLogoFormat;
    },
    transferList: readonly ArrayBuffer[],
  ): void;
  terminate(): Promise<number>;
}

function pathKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32"
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

async function matchingLogoFiles(
  roots: readonly string[],
  relativePath: string,
): Promise<readonly string[]> {
  const matches: string[] = [];
  const seen = new Set<string>();
  const segments = relativePath.split("/");
  for (const requestedRoot of roots) {
    let canonicalRoot: string;
    try {
      canonicalRoot = await fs.realpath(path.resolve(requestedRoot));
    } catch {
      continue;
    }
    const candidate = path.join(canonicalRoot, ...segments);
    let status;
    try {
      status = await fs.lstat(candidate);
    } catch {
      continue;
    }
    if (
      status.isSymbolicLink() ||
      !status.isFile() ||
      status.size < 1 ||
      status.size > LOGO_RELIEF_INPUT_MAX_BYTES
    ) {
      continue;
    }
    let canonicalCandidate: string;
    try {
      canonicalCandidate = await fs.realpath(candidate);
    } catch {
      continue;
    }
    if (!within(canonicalRoot, canonicalCandidate)) continue;
    const key = pathKey(canonicalCandidate);
    if (!seen.has(key)) {
      seen.add(key);
      matches.push(canonicalCandidate);
    }
  }
  return matches;
}

async function readPrivateLogo(file: string): Promise<Uint8Array> {
  const before = await fs.lstat(file);
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.size < 1 ||
    before.size > LOGO_RELIEF_INPUT_MAX_BYTES
  ) {
    throw new Error("Logo file is not an allowed regular file.");
  }
  const handle = await fs.open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.size !== before.size ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new Error("Logo file changed while opening.");
    }
    const bytes = await handle.readFile();
    if (
      bytes.byteLength < 1 ||
      bytes.byteLength > LOGO_RELIEF_INPUT_MAX_BYTES
    ) {
      throw new Error("Logo file exceeds its byte limit.");
    }
    const after = await handle.stat();
    if (
      after.size !== opened.size ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino
    ) {
      throw new Error("Logo file changed while reading.");
    }
    return new Uint8Array(bytes);
  } finally {
    await handle.close();
  }
}

function workerConversion(
  bytes: Uint8Array,
  format: IdentityLogoFormat,
  timeoutMs: number,
  signal?: AbortSignal,
  createWorker: (url: URL) => LogoReliefWorker = (url) =>
    new Worker(url),
): Promise<IdentityLogoPrintRelief> {
  return new Promise((resolve, reject) => {
    const worker = createWorker(
      new URL("./logo-relief-worker.js", import.meta.url),
    );
    let settled = false;
    const finish = (
      outcome:
        | { readonly ok: true; readonly value: IdentityLogoPrintRelief }
        | { readonly ok: false; readonly error: Error },
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener("abort", abort);
      void worker.terminate();
      if (outcome.ok) resolve(outcome.value);
      else reject(outcome.error);
    };
    const abort = (): void =>
      finish({
        ok: false,
        error: new Error("Logo relief conversion was aborted."),
      });
    const deadline = setTimeout(
      () =>
        finish({
          ok: false,
          error: new Error("Logo relief conversion timed out."),
        }),
      timeoutMs,
    );
    worker.once("error", () =>
      finish({
        ok: false,
        error: new Error("Logo relief conversion failed."),
      }),
    );
    worker.once(
      "message",
      (message: {
        readonly ok?: boolean;
        readonly relief?: unknown;
      }) => {
        if (message.ok !== true) {
          finish({
            ok: false,
            error: new Error("Logo relief conversion was rejected."),
          });
          return;
        }
        try {
          finish({
            ok: true,
            value: normalizeIdentityLogoPrintRelief(message.relief),
          });
        } catch {
          finish({
            ok: false,
            error: new Error("Logo relief worker returned invalid data."),
          });
        }
      },
    );
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    worker.postMessage(
      { bytes, format },
      [bytes.buffer as ArrayBuffer],
    );
  });
}

export async function acquireLocalLogoPrintRelief(
  roots: readonly string[],
  logoPath: string,
  options: {
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
    readonly dependencies?: LocalLogoReliefDependencies;
  } = {},
): Promise<LocalLogoReliefResult> {
  let relativePath: string;
  try {
    relativePath = normalizeAssetRelativePath(logoPath);
  } catch {
    return { warning: LOCAL_LOGO_RELIEF_WARNING };
  }
  const extension = path.posix
    .extname(relativePath)
    .toLocaleLowerCase("en-US");
  if (extension !== ".svg" && extension !== ".png") {
    return { warning: LOCAL_LOGO_RELIEF_WARNING };
  }
  const matches = await matchingLogoFiles(roots, relativePath);
  if (matches.length !== 1) {
    return { warning: LOCAL_LOGO_RELIEF_WARNING };
  }
  try {
    const bytes = await readPrivateLogo(matches[0]!);
    const timeoutMs = Math.max(
      1,
      Math.min(
        LOCAL_LOGO_RELIEF_DEADLINE_MS,
        options.timeoutMs ?? LOCAL_LOGO_RELIEF_DEADLINE_MS,
      ),
    );
    const convert =
      options.dependencies?.convert ??
      ((workerBytes, workerFormat, workerTimeout, workerSignal) =>
        workerConversion(
          workerBytes,
          workerFormat,
          workerTimeout,
          workerSignal,
          options.dependencies?.createWorker,
        ));
    const relief = normalizeIdentityLogoPrintRelief(
      await convert(
        bytes,
        extension === ".svg" ? "svg" : "png",
        timeoutMs,
        options.signal,
      ),
    );
    return { relief };
  } catch {
    return { warning: LOCAL_LOGO_RELIEF_WARNING };
  }
}
