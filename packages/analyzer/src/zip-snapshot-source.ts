import { Inflate } from "fflate";

import {
  DEFAULT_SNAPSHOT_LIMITS,
  normalizeSnapshotPath,
  SnapshotDeadlineError,
  SnapshotPolicyError,
  type SnapshotFileSourceEntry,
  type SnapshotSource,
  type SnapshotSourceEntry,
} from "./snapshot.js";

const MEBIBYTE = 1024 * 1024;
export const DEFAULT_ZIP_SNAPSHOT_LIMITS = Object.freeze({
  maxArchiveBytes: 64 * MEBIBYTE,
  maxEntryBytes: 256 * MEBIBYTE,
  maxExpandedBytes: 1024 * MEBIBYTE,
});
const OUTPUT_CHUNK_BYTES = 64 * 1024;
const DEFLATE_INPUT_CHUNK_BYTES = 4 * 1024;

const LOCAL_FILE_SIGNATURE = 0x04034b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EXTRA_FIELD = 0x0001;

const FLAG_ENCRYPTED = 1 << 0;
const FLAG_DEFLATE_OPTIONS = (1 << 1) | (1 << 2);
const FLAG_DATA_DESCRIPTOR = 1 << 3;
const FLAG_UTF8 = 1 << 11;
const UNIX_CREATOR = 3;
const UNIX_TYPE_MASK = 0o170000;
const UNIX_DIRECTORY = 0o040000;
const UNIX_REGULAR_FILE = 0o100000;
const UNIX_SYMBOLIC_LINK = 0o120000;
const DOS_DIRECTORY = 0x10;

type ZipEntryKind = "directory" | "file" | "symlink";

export interface ZipSnapshotSourceOptions {
  readonly maxArchiveBytes?: number;
  readonly maxEntries?: number;
  readonly maxEntryBytes?: number;
  readonly maxExpandedBytes?: number;
  /**
   * `single-directory` strips one required common archive directory.
   * `archive-root` treats every entry as repository-relative.
   */
  readonly rootMode?: "single-directory" | "archive-root";
  readonly signal?: AbortSignal;
}

export interface DisposableSnapshotSource extends SnapshotSource {
  dispose(): void;
}

/**
 * Extending SnapshotPolicyError keeps lazy integrity failures fatal at the
 * existing snapshot boundary instead of degrading them to unreadable-file
 * diagnostics. The inherited path is deliberately non-sensitive.
 */
export class ZipSnapshotValidationError extends SnapshotPolicyError {
  public constructor(message = "ZIP snapshot validation failed.") {
    super(".", "ZIP archive integrity validation failed");
    this.name = "ZipSnapshotValidationError";
    this.message = message;
  }
}

interface ResolvedZipSnapshotSourceOptions {
  readonly maxArchiveBytes: number;
  readonly maxEntries: number;
  readonly maxEntryBytes: number;
  readonly maxExpandedBytes: number;
  readonly rootMode: "single-directory" | "archive-root";
  readonly signal?: AbortSignal;
}

interface CentralEntry {
  readonly archivePath: string;
  readonly rawName: Uint8Array;
  readonly kind: ZipEntryKind;
  readonly flags: number;
  readonly compression: 0 | 8;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
  readonly dataOffset: number;
  readonly dataEnd: number;
  readonly recordEnd: number;
  readonly path?: string;
}

interface EndOfCentralDirectory {
  readonly offset: number;
  readonly entryCount: number;
  readonly centralOffset: number;
  readonly centralSize: number;
}

function validationError(message: string): ZipSnapshotValidationError {
  return new ZipSnapshotValidationError(message);
}

function resolveLimit(
  value: number | undefined,
  fallback: number,
  field: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer.`);
  }
  return resolved;
}

function resolveOptions(
  options: ZipSnapshotSourceOptions,
): ResolvedZipSnapshotSourceOptions {
  if (
    options.rootMode !== undefined &&
    options.rootMode !== "single-directory" &&
    options.rootMode !== "archive-root"
  ) {
    throw new TypeError(
      'rootMode must be "single-directory" or "archive-root".',
    );
  }
  return {
    maxArchiveBytes: resolveLimit(
      options.maxArchiveBytes,
      DEFAULT_ZIP_SNAPSHOT_LIMITS.maxArchiveBytes,
      "maxArchiveBytes",
    ),
    maxEntries: resolveLimit(
      options.maxEntries,
      DEFAULT_SNAPSHOT_LIMITS.maxEntries,
      "maxEntries",
    ),
    maxEntryBytes: resolveLimit(
      options.maxEntryBytes,
      DEFAULT_ZIP_SNAPSHOT_LIMITS.maxEntryBytes,
      "maxEntryBytes",
    ),
    maxExpandedBytes: resolveLimit(
      options.maxExpandedBytes,
      DEFAULT_ZIP_SNAPSHOT_LIMITS.maxExpandedBytes,
      "maxExpandedBytes",
    ),
    rootMode: options.rootMode ?? "single-directory",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

function throwIfAborted(...signals: readonly (AbortSignal | undefined)[]): void {
  if (signals.some((signal) => signal?.aborted)) {
    throw new SnapshotDeadlineError("ZIP snapshot read was aborted.");
  }
}

function ensureRange(
  bytes: Uint8Array,
  offset: number,
  length: number,
  message: string,
): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > bytes.byteLength - length
  ) {
    throw validationError(message);
  }
}

function unsigned16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function unsigned32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}

function decodeName(raw: Uint8Array, flags: number): string {
  if (
    (flags & FLAG_UTF8) === 0 &&
    raw.some((value) => value > 0x7f)
  ) {
    throw validationError(
      "ZIP entry names must be ASCII or explicitly UTF-8.",
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw validationError("ZIP entry name is not valid UTF-8.");
  }
}

function inspectExtraFields(
  view: DataView,
  bytes: Uint8Array,
  offset: number,
  length: number,
): void {
  ensureRange(bytes, offset, length, "ZIP extra field is truncated.");
  const end = offset + length;
  let cursor = offset;
  while (cursor < end) {
    if (cursor > end - 4) {
      throw validationError("ZIP extra field is malformed.");
    }
    const identifier = unsigned16(view, cursor);
    const fieldLength = unsigned16(view, cursor + 2);
    cursor += 4;
    if (cursor > end - fieldLength) {
      throw validationError("ZIP extra field is malformed.");
    }
    if (identifier === ZIP64_EXTRA_FIELD) {
      throw validationError("ZIP64 archives are not supported.");
    }
    cursor += fieldLength;
  }
}

function findEndOfCentralDirectory(
  bytes: Uint8Array,
  view: DataView,
): EndOfCentralDirectory {
  if (bytes.byteLength < 22) {
    throw validationError("ZIP end-of-central-directory record is missing.");
  }
  const earliest = Math.max(0, bytes.byteLength - 22 - 0xffff);
  const matches: number[] = [];
  for (let offset = bytes.byteLength - 22; offset >= earliest; offset -= 1) {
    if (unsigned32(view, offset) !== EOCD_SIGNATURE) continue;
    const commentLength = unsigned16(view, offset + 20);
    if (offset + 22 + commentLength === bytes.byteLength) {
      matches.push(offset);
    }
  }
  if (matches.length !== 1) {
    throw validationError(
      "ZIP end-of-central-directory record is missing or ambiguous.",
    );
  }
  const offset = matches[0]!;
  if (
    (offset >= 20 &&
      unsigned32(view, offset - 20) === ZIP64_LOCATOR_SIGNATURE) ||
    (offset >= 56 &&
      unsigned32(view, offset - 56) === ZIP64_EOCD_SIGNATURE)
  ) {
    throw validationError("ZIP64 archives are not supported.");
  }
  const disk = unsigned16(view, offset + 4);
  const centralDisk = unsigned16(view, offset + 6);
  const diskEntries = unsigned16(view, offset + 8);
  const entryCount = unsigned16(view, offset + 10);
  const centralSize = unsigned32(view, offset + 12);
  const centralOffset = unsigned32(view, offset + 16);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount) {
    throw validationError("Multi-disk ZIP archives are not supported.");
  }
  if (
    diskEntries === 0xffff ||
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw validationError("ZIP64 archives are not supported.");
  }
  if (
    centralOffset > offset ||
    centralSize !== offset - centralOffset
  ) {
    throw validationError("ZIP central directory bounds are invalid.");
  }
  return { offset, entryCount, centralOffset, centralSize };
}

function allowedFlags(flags: number, compression: number): boolean {
  const allowed =
    FLAG_DATA_DESCRIPTOR |
    FLAG_UTF8 |
    (compression === 8 ? FLAG_DEFLATE_OPTIONS : 0);
  return (flags & ~allowed) === 0 && (flags & FLAG_ENCRYPTED) === 0;
}

function entryKind(
  archivePath: string,
  versionMadeBy: number,
  externalAttributes: number,
): ZipEntryKind {
  const trailingSlash = archivePath.endsWith("/");
  const dosDirectory = (externalAttributes & DOS_DIRECTORY) !== 0;
  const creator = versionMadeBy >>> 8;
  if (creator === UNIX_CREATOR) {
    const mode = (externalAttributes >>> 16) & 0xffff;
    const type = mode & UNIX_TYPE_MASK;
    if (type === UNIX_SYMBOLIC_LINK) {
      if (trailingSlash) {
        throw validationError("ZIP symbolic-link entry is malformed.");
      }
      return "symlink";
    }
    if (type === UNIX_DIRECTORY) {
      if (!trailingSlash) {
        throw validationError("ZIP directory entry is malformed.");
      }
      return "directory";
    }
    if (type !== 0 && type !== UNIX_REGULAR_FILE) {
      throw validationError("ZIP archive contains an unsupported file type.");
    }
    if (type === UNIX_REGULAR_FILE && (trailingSlash || dosDirectory)) {
      throw validationError("ZIP regular-file entry is malformed.");
    }
    if (type === UNIX_REGULAR_FILE) return "file";
  }
  if (trailingSlash !== dosDirectory && dosDirectory) {
    throw validationError("ZIP directory entry is malformed.");
  }
  return trailingSlash || dosDirectory ? "directory" : "file";
}

function portableArchivePath(value: string): void {
  if (
    value === "" ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\u0000") ||
    value.includes("//")
  ) {
    throw validationError("ZIP entry path is not portable.");
  }
  const withoutTrailingSlash = value.endsWith("/")
    ? value.slice(0, -1)
    : value;
  if (
    withoutTrailingSlash === "" ||
    withoutTrailingSlash
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw validationError("ZIP entry path is not portable.");
  }
}

function parseCentralEntries(
  bytes: Uint8Array,
  view: DataView,
  eocd: EndOfCentralDirectory,
  options: ResolvedZipSnapshotSourceOptions,
): CentralEntry[] {
  if (eocd.entryCount === 0) {
    throw validationError("ZIP archive must contain a repository root.");
  }
  if (eocd.entryCount > options.maxEntries) {
    throw validationError("ZIP archive exceeds the entry limit.");
  }
  const entries: CentralEntry[] = [];
  let cursor = eocd.centralOffset;
  let expandedBytes = 0;
  for (let index = 0; index < eocd.entryCount; index += 1) {
    ensureRange(bytes, cursor, 46, "ZIP central directory is truncated.");
    if (unsigned32(view, cursor) !== CENTRAL_FILE_SIGNATURE) {
      throw validationError("ZIP central-directory entry is malformed.");
    }
    const versionMadeBy = unsigned16(view, cursor + 4);
    const flags = unsigned16(view, cursor + 8);
    const compression = unsigned16(view, cursor + 10);
    const crc32 = unsigned32(view, cursor + 16);
    const compressedSize = unsigned32(view, cursor + 20);
    const uncompressedSize = unsigned32(view, cursor + 24);
    const nameLength = unsigned16(view, cursor + 28);
    const extraLength = unsigned16(view, cursor + 30);
    const commentLength = unsigned16(view, cursor + 32);
    const startDisk = unsigned16(view, cursor + 34);
    const externalAttributes = unsigned32(view, cursor + 38);
    const localHeaderOffset = unsigned32(view, cursor + 42);
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff ||
      startDisk === 0xffff
    ) {
      throw validationError("ZIP64 archives are not supported.");
    }
    if (startDisk !== 0) {
      throw validationError("Multi-disk ZIP archives are not supported.");
    }
    if (
      (compression !== 0 && compression !== 8) ||
      !allowedFlags(flags, compression)
    ) {
      throw validationError(
        "ZIP entry uses unsupported compression or flags.",
      );
    }
    const variableLength = nameLength + extraLength + commentLength;
    ensureRange(
      bytes,
      cursor + 46,
      variableLength,
      "ZIP central-directory entry is truncated.",
    );
    const rawName = bytes.slice(cursor + 46, cursor + 46 + nameLength);
    const archivePath = decodeName(rawName, flags);
    portableArchivePath(archivePath);
    inspectExtraFields(
      view,
      bytes,
      cursor + 46 + nameLength,
      extraLength,
    );
    if (uncompressedSize > options.maxEntryBytes) {
      throw validationError("ZIP archive exceeds the per-entry size limit.");
    }
    if (expandedBytes > options.maxExpandedBytes - uncompressedSize) {
      throw validationError("ZIP archive exceeds the expanded-size limit.");
    }
    expandedBytes += uncompressedSize;
    entries.push({
      archivePath,
      rawName,
      kind: entryKind(archivePath, versionMadeBy, externalAttributes),
      flags,
      compression,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      dataOffset: 0,
      dataEnd: 0,
      recordEnd: 0,
    });
    cursor += 46 + variableLength;
  }
  if (cursor !== eocd.offset) {
    throw validationError("ZIP central-directory size is inconsistent.");
  }
  return entries;
}

function localFieldMatches(
  local: number,
  central: number,
  usesDescriptor: boolean,
): boolean {
  return usesDescriptor ? local === 0 || local === central : local === central;
}

function descriptorLength(
  bytes: Uint8Array,
  view: DataView,
  offset: number,
  entry: CentralEntry,
): number {
  ensureRange(bytes, offset, 12, "ZIP data descriptor is truncated.");
  if (
    unsigned32(view, offset) === entry.crc32 &&
    unsigned32(view, offset + 4) === entry.compressedSize &&
    unsigned32(view, offset + 8) === entry.uncompressedSize
  ) {
    return 12;
  }
  ensureRange(bytes, offset, 16, "ZIP data descriptor is truncated.");
  if (
    unsigned32(view, offset) === DATA_DESCRIPTOR_SIGNATURE &&
    unsigned32(view, offset + 4) === entry.crc32 &&
    unsigned32(view, offset + 8) === entry.compressedSize &&
    unsigned32(view, offset + 12) === entry.uncompressedSize
  ) {
    return 16;
  }
  throw validationError(
    "ZIP data descriptor does not match its central entry.",
  );
}

function validateLocalEntries(
  bytes: Uint8Array,
  view: DataView,
  centralOffset: number,
  entries: readonly CentralEntry[],
): CentralEntry[] {
  const validated = entries.map((entry): CentralEntry => {
    ensureRange(
      bytes,
      entry.localHeaderOffset,
      30,
      "ZIP local file header is truncated.",
    );
    const offset = entry.localHeaderOffset;
    if (unsigned32(view, offset) !== LOCAL_FILE_SIGNATURE) {
      throw validationError("ZIP local file header is malformed.");
    }
    const flags = unsigned16(view, offset + 6);
    const compression = unsigned16(view, offset + 8);
    const localCrc = unsigned32(view, offset + 14);
    const localCompressedSize = unsigned32(view, offset + 18);
    const localUncompressedSize = unsigned32(view, offset + 22);
    const nameLength = unsigned16(view, offset + 26);
    const extraLength = unsigned16(view, offset + 28);
    const usesDescriptor = (entry.flags & FLAG_DATA_DESCRIPTOR) !== 0;
    if (
      flags !== entry.flags ||
      compression !== entry.compression ||
      !localFieldMatches(localCrc, entry.crc32, usesDescriptor) ||
      !localFieldMatches(
        localCompressedSize,
        entry.compressedSize,
        usesDescriptor,
      ) ||
      !localFieldMatches(
        localUncompressedSize,
        entry.uncompressedSize,
        usesDescriptor,
      )
    ) {
      throw validationError(
        "ZIP local and central file headers are inconsistent.",
      );
    }
    ensureRange(
      bytes,
      offset + 30,
      nameLength + extraLength,
      "ZIP local file header is truncated.",
    );
    const localName = bytes.subarray(offset + 30, offset + 30 + nameLength);
    if (!equalBytes(localName, entry.rawName)) {
      throw validationError(
        "ZIP local and central entry names are inconsistent.",
      );
    }
    inspectExtraFields(
      view,
      bytes,
      offset + 30 + nameLength,
      extraLength,
    );
    if (
      entry.compression === 0 &&
      entry.compressedSize !== entry.uncompressedSize
    ) {
      throw validationError("Stored ZIP entry has inconsistent sizes.");
    }
    if (
      entry.kind === "directory" &&
      (entry.uncompressedSize !== 0 || entry.crc32 !== 0)
    ) {
      throw validationError("ZIP directory entry must be empty.");
    }
    const dataOffset = offset + 30 + nameLength + extraLength;
    ensureRange(
      bytes,
      dataOffset,
      entry.compressedSize,
      "ZIP entry data is truncated.",
    );
    const dataEnd = dataOffset + entry.compressedSize;
    const descriptorBytes = usesDescriptor
      ? descriptorLength(bytes, view, dataEnd, entry)
      : 0;
    const recordEnd = dataEnd + descriptorBytes;
    if (recordEnd > centralOffset) {
      throw validationError(
        "ZIP local entry overlaps the central directory.",
      );
    }
    return { ...entry, dataOffset, dataEnd, recordEnd };
  });

  const localOrder = [...validated].sort(
    (left, right) => left.localHeaderOffset - right.localHeaderOffset,
  );
  if (localOrder[0]?.localHeaderOffset !== 0) {
    throw validationError("Self-extracting ZIP prefixes are not supported.");
  }
  for (let index = 1; index < localOrder.length; index += 1) {
    const previous = localOrder[index - 1]!;
    const current = localOrder[index]!;
    if (current.localHeaderOffset !== previous.recordEnd) {
      throw validationError(
        "ZIP local entries overlap or contain unrecognized gap data.",
      );
    }
  }
  if (localOrder.at(-1)?.recordEnd !== centralOffset) {
    throw validationError(
      "ZIP local entries do not end at the central directory.",
    );
  }
  return validated;
}

function comparePath(left: string, right: string): number {
  const foldedLeft = left.toLocaleLowerCase("en-US");
  const foldedRight = right.toLocaleLowerCase("en-US");
  if (foldedLeft < foldedRight) return -1;
  if (foldedLeft > foldedRight) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedEntries(
  entries: readonly CentralEntry[],
  relativePath: (entry: CentralEntry) => string | undefined,
): CentralEntry[] {
  const normalized: CentralEntry[] = [];
  const portablePaths = new Map<string, string>();
  for (const entry of entries) {
    const relativeArchivePath = relativePath(entry);
    if (relativeArchivePath === undefined) continue;
    const withoutDirectorySlash =
      entry.kind === "directory" && relativeArchivePath.endsWith("/")
        ? relativeArchivePath.slice(0, -1)
        : relativeArchivePath;
    let path: string;
    try {
      path = normalizeSnapshotPath(withoutDirectorySlash);
    } catch {
      throw validationError("ZIP entry path is not portable.");
    }
    const key = path.toLocaleLowerCase("en-US");
    if (portablePaths.has(key)) {
      throw validationError(
        "ZIP entry paths collide after portable normalization.",
      );
    }
    portablePaths.set(key, path);
    normalized.push({ ...entry, path });
  }
  const byPath = new Map(
    normalized.map((entry) => [
      entry.path!.toLocaleLowerCase("en-US"),
      entry,
    ]),
  );
  for (const entry of normalized) {
    let separator = entry.path!.lastIndexOf("/");
    while (separator !== -1) {
      const ancestor = byPath.get(
        entry.path!
          .slice(0, separator)
          .toLocaleLowerCase("en-US"),
      );
      if (ancestor !== undefined && ancestor.kind !== "directory") {
        throw validationError(
          "ZIP file or symbolic-link entry has descendant entries.",
        );
      }
      separator = entry.path!.lastIndexOf("/", separator - 1);
    }
  }
  return normalized.sort((left, right) =>
    comparePath(left.path!, right.path!),
  );
}

function stripCommonRoot(entries: readonly CentralEntry[]): CentralEntry[] {
  let commonRoot: string | undefined;
  let rootEntrySeen = false;
  for (const entry of entries) {
    const separator = entry.archivePath.indexOf("/");
    if (separator <= 0) {
      throw validationError(
        "ZIP entries must share one repository root directory.",
      );
    }
    const root = entry.archivePath.slice(0, separator);
    try {
      normalizeSnapshotPath(root);
    } catch {
      throw validationError("ZIP repository root path is not portable.");
    }
    if (commonRoot === undefined) commonRoot = root;
    if (root !== commonRoot) {
      throw validationError(
        "ZIP entries must share one repository root directory.",
      );
    }
    const relativeArchivePath = entry.archivePath.slice(separator + 1);
    if (relativeArchivePath === "") {
      if (entry.kind !== "directory") {
        throw validationError("ZIP repository root entry is malformed.");
      }
      if (rootEntrySeen) {
        throw validationError(
          "ZIP repository root directory is duplicated.",
        );
      }
      rootEntrySeen = true;
    }
  }
  if (commonRoot === undefined) {
    throw validationError("ZIP archive must contain a repository root.");
  }
  return normalizedEntries(entries, (entry) => {
    const separator = entry.archivePath.indexOf("/");
    const relativeArchivePath = entry.archivePath.slice(separator + 1);
    return relativeArchivePath === "" ? undefined : relativeArchivePath;
  });
}

function useArchiveRoot(entries: readonly CentralEntry[]): CentralEntry[] {
  return normalizedEntries(
    entries,
    (entry) => entry.archivePath,
  );
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value =
        (value & 1) === 0
          ? value >>> 1
          : 0xedb88320 ^ (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function updateCrc32(crc: number, bytes: Uint8Array): number {
  let value = crc;
  for (const byte of bytes) {
    value = CRC32_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  }
  return value >>> 0;
}

function completeCrc32(crc: number): number {
  return (crc ^ 0xffffffff) >>> 0;
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

class OpenZipSnapshotSource implements DisposableSnapshotSource {
  public readonly repositoryName: string;

  private archive: Uint8Array | undefined;
  private entriesByPath: Map<string, CentralEntry> | undefined;
  private readonly orderedPaths: readonly string[];
  private readonly options: ResolvedZipSnapshotSourceOptions;

  public constructor(
    archive: Uint8Array,
    repositoryName: string,
    entries: readonly CentralEntry[],
    options: ResolvedZipSnapshotSourceOptions,
  ) {
    this.archive = archive;
    this.repositoryName = repositoryName;
    this.entriesByPath = new Map(
      entries.map((entry) => [entry.path!, entry]),
    );
    this.orderedPaths = entries.map(({ path }) => path!);
    this.options = options;
  }

  public async *entries(
    signal?: AbortSignal,
  ): AsyncGenerator<SnapshotSourceEntry> {
    throwIfAborted(this.options.signal, signal);
    const entries = this.requireEntries();
    for (const path of this.orderedPaths) {
      throwIfAborted(this.options.signal, signal);
      const entry = entries.get(path);
      if (entry === undefined) {
        throw validationError("ZIP snapshot source has been disposed.");
      }
      if (entry.kind === "directory") {
        yield { kind: "directory", path };
      } else if (entry.kind === "symlink") {
        yield { kind: "symlink", path };
      } else {
        const file: SnapshotFileSourceEntry = {
          kind: "file",
          path,
          declaredSize: entry.uncompressedSize,
          chunks: (readSignal) => this.fileChunks(path, readSignal),
        };
        yield file;
      }
    }
  }

  public dispose(): void {
    this.entriesByPath?.clear();
    this.entriesByPath = undefined;
    this.archive = undefined;
  }

  private requireEntries(): Map<string, CentralEntry> {
    if (this.entriesByPath === undefined || this.archive === undefined) {
      throw validationError("ZIP snapshot source has been disposed.");
    }
    return this.entriesByPath;
  }

  private async *fileChunks(
    path: string,
    signal?: AbortSignal,
  ): AsyncGenerator<Uint8Array> {
    throwIfAborted(this.options.signal, signal);
    const entries = this.requireEntries();
    const archive = this.archive!;
    const entry = entries.get(path);
    if (entry === undefined || entry.kind !== "file") {
      throw validationError("ZIP snapshot file is unavailable.");
    }
    if (entry.compression === 0) {
      yield* this.storedChunks(archive, entry, signal);
      return;
    }
    yield* this.deflatedChunks(archive, entry, signal);
  }

  private async *storedChunks(
    archive: Uint8Array,
    entry: CentralEntry,
    signal?: AbortSignal,
  ): AsyncGenerator<Uint8Array> {
    let crc = 0xffffffff;
    let actualSize = 0;
    for (
      let offset = entry.dataOffset;
      offset < entry.dataEnd;
      offset += OUTPUT_CHUNK_BYTES
    ) {
      throwIfAborted(this.options.signal, signal);
      this.requireEntries();
      const end = Math.min(entry.dataEnd, offset + OUTPUT_CHUNK_BYTES);
      const chunk = archive.slice(offset, end);
      actualSize += chunk.byteLength;
      crc = updateCrc32(crc, chunk);
      yield chunk;
    }
    this.validateExtractedEntry(entry, actualSize, crc);
  }

  private async *deflatedChunks(
    archive: Uint8Array,
    entry: CentralEntry,
    signal?: AbortSignal,
  ): AsyncGenerator<Uint8Array> {
    const pending: Uint8Array[] = [];
    let actualSize = 0;
    let crc = 0xffffffff;
    let finished = false;
    const inflate = new Inflate((output, final) => {
      actualSize += output.byteLength;
      if (
        !Number.isSafeInteger(actualSize) ||
        actualSize > entry.uncompressedSize ||
        actualSize > this.options.maxEntryBytes
      ) {
        throw validationError(
          "Inflated ZIP entry exceeds its declared size.",
        );
      }
      crc = updateCrc32(crc, output);
      for (
        let offset = 0;
        offset < output.byteLength;
        offset += OUTPUT_CHUNK_BYTES
      ) {
        pending.push(
          output.slice(
            offset,
            Math.min(output.byteLength, offset + OUTPUT_CHUNK_BYTES),
          ),
        );
      }
      if (final) finished = true;
    });

    try {
      let pushes = 0;
      if (entry.compressedSize === 0) {
        inflate.push(new Uint8Array(), true);
      } else {
        for (
          let offset = entry.dataOffset;
          offset < entry.dataEnd;
          offset += DEFLATE_INPUT_CHUNK_BYTES
        ) {
          throwIfAborted(this.options.signal, signal);
          this.requireEntries();
          const end = Math.min(
            entry.dataEnd,
            offset + DEFLATE_INPUT_CHUNK_BYTES,
          );
          inflate.push(
            archive.subarray(offset, end),
            end === entry.dataEnd,
          );
          while (pending.length > 0) {
            yield pending.shift()!;
          }
          pushes += 1;
          if (pushes % 64 === 0) {
            await yieldToEventLoop();
            throwIfAborted(this.options.signal, signal);
          }
        }
      }
      while (pending.length > 0) yield pending.shift()!;
    } catch (error) {
      if (
        error instanceof ZipSnapshotValidationError ||
        error instanceof SnapshotDeadlineError
      ) {
        throw error;
      }
      throw validationError("ZIP entry contains invalid DEFLATE data.");
    }
    if (!finished) {
      throw validationError("ZIP entry DEFLATE stream is incomplete.");
    }
    this.validateExtractedEntry(entry, actualSize, crc);
  }

  private validateExtractedEntry(
    entry: CentralEntry,
    actualSize: number,
    crc: number,
  ): void {
    if (actualSize !== entry.uncompressedSize) {
      throw validationError(
        "ZIP entry size does not match its central record.",
      );
    }
    if (completeCrc32(crc) !== entry.crc32) {
      throw validationError(
        "ZIP entry CRC does not match its central record.",
      );
    }
  }
}

export function openZipSnapshotSource(
  archive: Uint8Array,
  repositoryName: string,
  options: ZipSnapshotSourceOptions = {},
): DisposableSnapshotSource {
  if (!(archive instanceof Uint8Array)) {
    throw new TypeError("archive must be a Uint8Array.");
  }
  const resolved = resolveOptions(options);
  throwIfAborted(resolved.signal);
  if (archive.byteLength > resolved.maxArchiveBytes) {
    throw validationError("ZIP archive exceeds the compressed-size limit.");
  }
  // Buffer.slice() is a view, so use Uint8Array.from to guarantee ownership
  // for every Uint8Array subclass accepted at this trust boundary.
  const ownedArchive = Uint8Array.from(archive);
  const view = new DataView(
    ownedArchive.buffer,
    ownedArchive.byteOffset,
    ownedArchive.byteLength,
  );
  const eocd = findEndOfCentralDirectory(ownedArchive, view);
  const centralEntries = parseCentralEntries(
    ownedArchive,
    view,
    eocd,
    resolved,
  );
  const localEntries = validateLocalEntries(
    ownedArchive,
    view,
    eocd.centralOffset,
    centralEntries,
  );
  const entries =
    resolved.rootMode === "single-directory"
      ? stripCommonRoot(localEntries)
      : useArchiveRoot(localEntries);
  throwIfAborted(resolved.signal);
  return new OpenZipSnapshotSource(
    ownedArchive,
    repositoryName,
    entries,
    resolved,
  );
}
