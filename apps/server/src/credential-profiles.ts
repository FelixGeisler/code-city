import {
  constants,
  promises as fs,
  type BigIntStats,
} from "node:fs";
import { isUtf8 } from "node:buffer";
import type { FileHandle } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import {
  genericGitRepositoryOrigin,
  validateGenericGitRepositoryUrl,
  validatePublicGitHubRepositoryUrl,
} from "../../../packages/analyzer/src/index.js";

import { parseExactImportJsonValue } from "./remote-import.js";

const MANIFEST_VERSION = 1;
const MAXIMUM_MANIFEST_BYTES = 64 * 1024;
const MAXIMUM_SECRET_BYTES = 8 * 1024;
const MAXIMUM_CONFIGURATION_PATH_CHARACTERS = 2_048;
const MAXIMUM_PROFILES = 64;
const MAXIMUM_REPOSITORIES_PER_PROFILE = 64;
const MAXIMUM_REPOSITORIES = 512;
const MAXIMUM_LABEL_CHARACTERS = 80;
const MAXIMUM_USERNAME_CHARACTERS = 256;
const MAXIMUM_REPOSITORY_CHARACTERS = 4_096;
const PROFILE_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const SECRET_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_USERNAME = /^[\u0020-\u007E]+$/u;
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const PROTOTYPE_LIKE_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODES = new Set([0o400, 0o600]);
const EMPTY_CAPABILITIES = Object.freeze(
  [] as readonly CredentialProfileCapability[],
);

export const CREDENTIAL_PROFILE_PROVIDERS = Object.freeze([
  "github",
  "azure-devops",
  "generic-https",
] as const);

export type CredentialProfileProvider =
  (typeof CREDENTIAL_PROFILE_PROVIDERS)[number];

export interface CredentialProfileCapability {
  readonly id: string;
  readonly label: string;
  readonly provider: CredentialProfileProvider;
}

export interface CredentialProfileRegistryOptions {
  readonly profilesFile?: string;
  readonly trustWindowsCredentialFiles?: boolean;
  /** Test seam; production callers should omit it. */
  readonly platform?: NodeJS.Platform;
}

interface BasicAuthentication {
  readonly kind: "basic";
  readonly username: string;
  readonly secretFile: string;
}

interface BearerAuthentication {
  readonly kind: "bearer";
  readonly secretFile: string;
}

type ProfileAuthentication =
  | BasicAuthentication
  | BearerAuthentication;

interface ParsedCredentialProfile {
  readonly id: string;
  readonly label: string;
  readonly provider: CredentialProfileProvider;
  readonly repositories: readonly CanonicalRepository[];
  readonly authentication: ProfileAuthentication;
}

interface RegisteredCredentialProfile {
  readonly id: string;
  readonly label: string;
  readonly provider: CredentialProfileProvider;
  readonly repositories: ReadonlySet<string>;
  readonly authentication: ProfileAuthentication & {
    readonly secretPath: string;
  };
}

interface TrustedDirectory {
  readonly path: string;
  readonly canonicalPath: string;
  readonly status: BigIntStats;
}

interface ProtectedFileContents {
  readonly bytes: Buffer;
  readonly canonicalPath: string;
  readonly status: BigIntStats;
}

interface CanonicalRepository {
  readonly displayUrl: string;
  readonly key: string;
  readonly hostname: string;
  readonly pathSegments: readonly CanonicalPathSegment[];
}

interface CanonicalPathSegment {
  readonly raw: string;
  readonly isAzureGitMarker: boolean;
}

function configurationError(message: string): Error {
  return new Error(`Credential profile configuration is invalid: ${message}`);
}

function manifestError(location: string, message: string): never {
  throw configurationError(`${location} ${message}`);
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function samePath(
  left: string,
  right: string,
  platform: NodeJS.Platform,
): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return platform === "win32"
    ? normalizedLeft.toLocaleLowerCase("en-US") ===
        normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}

function hasPrivateFileMode(status: BigIntStats): boolean {
  return PRIVATE_FILE_MODES.has(Number(status.mode & 0o777n));
}

function assertDirectoryPolicy(
  status: BigIntStats,
  platform: NodeJS.Platform,
): void {
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    (status.dev === 0n && status.ino === 0n)
  ) {
    throw configurationError(
      "the credential directory must be one private regular directory.",
    );
  }
  if (platform === "win32") return;
  if (
    process.geteuid === undefined ||
    status.uid !== BigInt(process.geteuid()) ||
    Number(status.mode & 0o777n) !== DIRECTORY_MODE
  ) {
    throw configurationError(
      "the credential directory must be owned by the server identity with mode 0700.",
    );
  }
}

function assertFilePolicy(
  status: BigIntStats,
  platform: NodeJS.Platform,
  minimumBytes: number,
  maximumBytes: number,
): void {
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    (status.dev === 0n && status.ino === 0n) ||
    status.nlink !== 1n ||
    status.size < BigInt(minimumBytes) ||
    status.size > BigInt(maximumBytes)
  ) {
    throw configurationError(
      "a credential file did not satisfy the private regular-file policy.",
    );
  }
  if (platform === "win32") return;
  if (
    process.geteuid === undefined ||
    status.uid !== BigInt(process.geteuid()) ||
    !hasPrivateFileMode(status)
  ) {
    throw configurationError(
      "credential files must be owned by the server identity with mode 0400 or 0600.",
    );
  }
}

async function openTrustedDirectory(
  directoryPath: string,
  platform: NodeJS.Platform,
): Promise<TrustedDirectory> {
  let status: BigIntStats;
  let canonicalPath: string;
  try {
    status = await fs.lstat(directoryPath, { bigint: true });
    assertDirectoryPolicy(status, platform);
    canonicalPath = await fs.realpath(directoryPath);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Credential profile configuration")
    ) {
      throw error;
    }
    throw configurationError(
      "the credential directory could not be opened safely.",
    );
  }
  if (!samePath(directoryPath, canonicalPath, platform)) {
    throw configurationError(
      "the credential directory must not use symbolic-link or reparse-point ancestry.",
    );
  }
  return Object.freeze({
    path: directoryPath,
    canonicalPath,
    status,
  });
}

async function assertTrustedDirectory(
  directory: TrustedDirectory,
  platform: NodeJS.Platform,
): Promise<void> {
  try {
    const status = await fs.lstat(directory.path, { bigint: true });
    const canonicalPath = await fs.realpath(directory.path);
    assertDirectoryPolicy(status, platform);
    if (
      !sameIdentity(directory.status, status) ||
      !samePath(directory.canonicalPath, canonicalPath, platform)
    ) {
      throw configurationError(
        "the credential directory changed while it was in use.",
      );
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Credential profile configuration")
    ) {
      throw error;
    }
    throw configurationError(
      "the credential directory could not be verified safely.",
    );
  }
}

function validatedProfilesFile(
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  if (
    value.length === 0 ||
    value.length > MAXIMUM_CONFIGURATION_PATH_CHARACTERS ||
    value !== value.trim() ||
    UNSAFE_TEXT.test(value) ||
    !path.isAbsolute(value)
  ) {
    throw configurationError(
      "CODECITY_CREDENTIAL_PROFILES_FILE must be an absolute private file path.",
    );
  }
  return path.resolve(value);
}

async function openProtectedFile(
  filePath: string,
): Promise<FileHandle> {
  try {
    return await fs.open(
      filePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch {
    throw configurationError(
      "a credential file could not be opened safely.",
    );
  }
}

async function readProtectedFile(
  filePath: string,
  directory: TrustedDirectory,
  platform: NodeJS.Platform,
  minimumBytes: number,
  maximumBytes: number,
): Promise<ProtectedFileContents> {
  let before: BigIntStats;
  let canonicalBefore: string;
  try {
    before = await fs.lstat(filePath, { bigint: true });
    assertFilePolicy(
      before,
      platform,
      minimumBytes,
      maximumBytes,
    );
    canonicalBefore = await fs.realpath(filePath);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Credential profile configuration")
    ) {
      throw error;
    }
    throw configurationError(
      "a credential file could not be inspected safely.",
    );
  }
  if (
    !samePath(filePath, canonicalBefore, platform) ||
    !samePath(
      path.dirname(canonicalBefore),
      directory.canonicalPath,
      platform,
    )
  ) {
    throw configurationError(
      "credential files must be direct children of the credential directory.",
    );
  }
  const handle = await openProtectedFile(filePath);
  let source: Buffer | undefined;
  try {
    const opened = await handle.stat({ bigint: true });
    assertFilePolicy(
      opened,
      platform,
      minimumBytes,
      maximumBytes,
    );
    if (!sameIdentity(before, opened)) {
      throw configurationError(
        "a credential file changed while it was being opened.",
      );
    }
    source = Buffer.alloc(maximumBytes + 1);
    let received = 0;
    while (received < source.byteLength) {
      const result = await handle.read(
        source,
        received,
        source.byteLength - received,
        received,
      );
      if (result.bytesRead === 0) break;
      received += result.bytesRead;
    }
    if (received < minimumBytes || received > maximumBytes) {
      throw configurationError(
        "a credential file exceeded its size limit.",
      );
    }
    const after = await fs.lstat(filePath, { bigint: true });
    const canonicalAfter = await fs.realpath(filePath);
    assertFilePolicy(
      after,
      platform,
      minimumBytes,
      maximumBytes,
    );
    if (
      !sameIdentity(opened, after) ||
      !samePath(canonicalBefore, canonicalAfter, platform)
    ) {
      throw configurationError(
        "a credential file changed while it was being read.",
      );
    }
    await assertTrustedDirectory(directory, platform);
    const bytes = Buffer.from(source.subarray(0, received));
    source.fill(0);
    return Object.freeze({
      bytes,
      canonicalPath: canonicalAfter,
      status: after,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Credential profile configuration")
    ) {
      throw error;
    }
    throw configurationError(
      "a credential file could not be read safely.",
    );
  } finally {
    source?.fill(0);
    await handle.close().catch(() => undefined);
  }
}

function exactObject(
  value: unknown,
  location: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    manifestError(location, "must be a JSON object.");
  }
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      manifestError(location, "must be a plain JSON object.");
    }
    const object = value as Record<string, unknown>;
    for (const key of Object.keys(object).sort()) {
      if (
        PROTOTYPE_LIKE_KEYS.has(key) ||
        !allowedKeys.includes(key)
      ) {
        manifestError(location, "contains an unknown field.");
      }
    }
    return object;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Credential profile configuration")
    ) {
      throw error;
    }
    manifestError(location, "must be a readable JSON object.");
  }
}

function required(
  object: Record<string, unknown>,
  key: string,
  location: string,
): unknown {
  if (!Object.hasOwn(object, key)) {
    manifestError(location, "is required.");
  }
  return object[key];
}

function exactText(
  value: unknown,
  location: string,
  maximumCharacters: number,
): string {
  if (typeof value !== "string") {
    manifestError(location, "must be a string.");
  }
  if (
    value.length === 0 ||
    value.length > maximumCharacters ||
    value !== value.normalize("NFC") ||
    value !== value.trim() ||
    UNSAFE_TEXT.test(value)
  ) {
    manifestError(
      location,
      `must contain 1 to ${maximumCharacters} canonical safe characters.`,
    );
  }
  return value;
}

function parseProvider(
  value: unknown,
  location: string,
): CredentialProfileProvider {
  if (
    value !== "github" &&
    value !== "azure-devops" &&
    value !== "generic-https"
  ) {
    manifestError(
      location,
      'must be "github", "azure-devops", or "generic-https".',
    );
  }
  return value;
}

function isFormatCodePoint(value: number): boolean {
  return (
    value === 0x00ad ||
    (value >= 0x0600 && value <= 0x0605) ||
    value === 0x061c ||
    value === 0x06dd ||
    value === 0x070f ||
    (value >= 0x0890 && value <= 0x0891) ||
    value === 0x08e2 ||
    (value >= 0x17b4 && value <= 0x17b5) ||
    value === 0x180e ||
    (value >= 0x200b && value <= 0x200f) ||
    (value >= 0x202a && value <= 0x202e) ||
    (value >= 0x2060 && value <= 0x2064) ||
    (value >= 0x2066 && value <= 0x206f) ||
    value === 0xfeff ||
    (value >= 0xfff9 && value <= 0xfffb) ||
    value === 0x110bd ||
    value === 0x110cd ||
    (value >= 0x13430 && value <= 0x13455) ||
    (value >= 0x1bca0 && value <= 0x1bca3) ||
    (value >= 0x1d173 && value <= 0x1d17a) ||
    value === 0xe0001 ||
    (value >= 0xe0020 && value <= 0xe007f)
  );
}

function isUnsafeCodePoint(value: number): boolean {
  return (
    value <= 0x001f ||
    (value >= 0x007f && value <= 0x009f) ||
    (value >= 0xd800 && value <= 0xdfff) ||
    isFormatCodePoint(value)
  );
}

function forEachUtf8CodePoint(
  bytes: Uint8Array,
  visit: (value: number) => void,
): void {
  for (let index = 0; index < bytes.byteLength;) {
    const first = bytes[index]!;
    let value: number;
    let width: number;
    if (first < 0x80) {
      value = first;
      width = 1;
    } else if (first < 0xe0) {
      value =
        ((first & 0x1f) << 6) |
        (bytes[index + 1]! & 0x3f);
      width = 2;
    } else if (first < 0xf0) {
      value =
        ((first & 0x0f) << 12) |
        ((bytes[index + 1]! & 0x3f) << 6) |
        (bytes[index + 2]! & 0x3f);
      width = 3;
    } else {
      value =
        ((first & 0x07) << 18) |
        ((bytes[index + 1]! & 0x3f) << 12) |
        ((bytes[index + 2]! & 0x3f) << 6) |
        (bytes[index + 3]! & 0x3f);
      width = 4;
    }
    visit(value);
    index += width;
  }
}

function canonicalRawPathSegment(
  raw: string,
): CanonicalPathSegment {
  const decodedBytes: number[] = [];
  for (let index = 0; index < raw.length;) {
    const value = raw.charCodeAt(index);
    if (value < 0x21 || value > 0x7e) {
      throw configurationError(
        "credential repository paths must use visible ASCII and uppercase percent-encoded UTF-8.",
      );
    }
    if (value !== 0x25) {
      decodedBytes.push(value);
      index += 1;
      continue;
    }
    const pair = raw.slice(index + 1, index + 3);
    if (!/^[0-9A-F]{2}$/u.test(pair)) {
      throw configurationError(
        "credential repository paths must use uppercase percent encoding.",
      );
    }
    decodedBytes.push(Number.parseInt(pair, 16));
    index += 3;
  }
  const bytes = Buffer.from(decodedBytes);
  if (!isUtf8(bytes)) {
    throw configurationError(
      "credential repository paths must use valid UTF-8 percent encoding.",
    );
  }
  let unsafe = false;
  forEachUtf8CodePoint(bytes, (value) => {
    if (
      value === 0x2f ||
      value === 0x5c ||
      isUnsafeCodePoint(value)
    ) {
      unsafe = true;
    }
  });
  if (
    unsafe ||
    (bytes.byteLength === 1 && bytes[0] === 0x2e) ||
    (
      bytes.byteLength === 2 &&
      bytes[0] === 0x2e &&
      bytes[1] === 0x2e
    )
  ) {
    throw configurationError(
      "credential repository paths must not contain dot, separator, or control segments.",
    );
  }
  const isAzureGitMarker =
    bytes.byteLength === 4 &&
    bytes[0] === 0x5f &&
    (bytes[1]! | 0x20) === 0x67 &&
    (bytes[2]! | 0x20) === 0x69 &&
    (bytes[3]! | 0x20) === 0x74;
  return Object.freeze({ raw, isAzureGitMarker });
}

function canonicalGenericHttpsRepository(
  value: string,
): CanonicalRepository {
  const validated = validateGenericGitRepositoryUrl(value);
  const origin = genericGitRepositoryOrigin(validated);
  if (origin.scheme !== "https") {
    throw configurationError(
      "credential profiles support only canonical HTTPS repositories.",
    );
  }
  const parsed = new URL(validated);
  const hostname = parsed.hostname
    .replace(/^\[|\]$/gu, "")
    .toLocaleLowerCase("en-US");
  if (
    hostname.length === 0 ||
    hostname.length > 253 ||
    (
      net.isIP(hostname) === 0 &&
      (
        hostname.includes("..") ||
        !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(hostname) ||
        hostname.split(".").some((label) => label.length > 63)
      )
    )
  ) {
    throw configurationError(
      "credential repository URLs must contain a valid hostname or IP address.",
    );
  }
  const authorityEnd = validated.indexOf("://");
  const pathStart = validated.indexOf("/", authorityEnd + 3);
  if (pathStart < 0) {
    throw configurationError(
      "credential profiles require one exact repository URL.",
    );
  }
  const rawSegments = validated.slice(pathStart + 1).split("/");
  if (
    rawSegments.length === 0 ||
    rawSegments.some((segment) => segment.length === 0)
  ) {
    throw configurationError(
      "credential profiles require one exact repository URL.",
    );
  }
  if (validated.slice(0, pathStart) !== parsed.origin) {
    throw configurationError(
      "credential repository URLs must use a canonical HTTPS authority.",
    );
  }
  const pathSegments = rawSegments.map(canonicalRawPathSegment);
  const displayUrl = `${parsed.origin}/${rawSegments.join("/")}`;
  return Object.freeze({
    displayUrl,
    key: displayUrl,
    hostname,
    pathSegments: Object.freeze(pathSegments),
  });
}

function canonicalAzureDevOpsRepository(
  value: CanonicalRepository,
): CanonicalRepository | undefined {
  const segments = value.pathSegments;
  const gitIndexes = segments
    .map((segment, index) =>
      segment.isAzureGitMarker ? index : -1,
    )
    .filter((index) => index >= 0);
  const gitIndex = gitIndexes[0];
  if (
    gitIndexes.length !== 1 ||
    gitIndex === undefined ||
    gitIndex !== segments.length - 2 ||
    gitIndex < 1
  ) {
    return undefined;
  }
  const isAzureCloud = value.hostname === "dev.azure.com";
  const isLegacyAzureCloud =
    value.hostname.endsWith(".visualstudio.com") &&
    value.hostname !== "visualstudio.com";
  if (
    (isAzureCloud || isLegacyAzureCloud) &&
    !(
      (segments.length === 3 && gitIndex === 1) ||
      (segments.length === 4 && gitIndex === 2)
    )
  ) {
    return undefined;
  }
  if (
    segments[gitIndex]!.raw.toLocaleLowerCase("en-US") !== "_git"
  ) {
    return undefined;
  }
  return value;
}

function canonicalRepository(
  value: unknown,
  provider: CredentialProfileProvider,
  location: string,
  requireCanonicalInput: boolean,
): CanonicalRepository {
  const repository = exactText(
    value,
    location,
    MAXIMUM_REPOSITORY_CHARACTERS,
  );
  let canonical: CanonicalRepository;
  try {
    if (provider === "github") {
      const displayUrl =
        validatePublicGitHubRepositoryUrl(repository);
      const generic = canonicalGenericHttpsRepository(displayUrl);
      canonical = Object.freeze({
        displayUrl: generic.displayUrl,
        key: generic.displayUrl.toLocaleLowerCase("en-US"),
        hostname: generic.hostname,
        pathSegments: generic.pathSegments,
      });
    } else {
      canonical = canonicalGenericHttpsRepository(repository);
    }
  } catch {
    manifestError(
      location,
      "must be one canonical credential-free HTTPS repository URL.",
    );
  }
  if (
    provider === "github" &&
    new URL(canonical.displayUrl).hostname !== "github.com"
  ) {
    manifestError(location, "must be a canonical GitHub repository URL.");
  }
  if (provider === "azure-devops") {
    const azureRepository =
      canonicalAzureDevOpsRepository(canonical);
    if (azureRepository === undefined) {
      manifestError(
        location,
        "must be a canonical Azure DevOps HTTPS _git repository URL.",
      );
    }
    canonical = azureRepository;
  }
  if (
    requireCanonicalInput &&
    repository !== canonical.displayUrl
  ) {
    manifestError(location, "must already use its canonical URL form.");
  }
  return canonical;
}

function secretFileName(
  value: unknown,
  location: string,
): string {
  if (
    typeof value !== "string" ||
    !SECRET_FILE_NAME.test(value) ||
    value === "." ||
    value === ".." ||
    path.posix.basename(value) !== value ||
    path.win32.basename(value) !== value
  ) {
    manifestError(
      location,
      "must be one portable basename in the credential directory.",
    );
  }
  return value;
}

function parseAuthentication(
  value: unknown,
  location: string,
): ProfileAuthentication {
  const preliminary = exactObject(
    value,
    location,
    ["kind", "secretFile", "username"],
  );
  const kind = required(preliminary, "kind", `${location}.kind`);
  if (kind === "bearer") {
    const object = exactObject(
      value,
      location,
      ["kind", "secretFile"],
    );
    return Object.freeze({
      kind,
      secretFile: secretFileName(
        required(object, "secretFile", `${location}.secretFile`),
        `${location}.secretFile`,
      ),
    });
  }
  if (kind !== "basic") {
    manifestError(
      `${location}.kind`,
      'must be "basic" or "bearer".',
    );
  }
  const object = exactObject(
    value,
    location,
    ["kind", "secretFile", "username"],
  );
  const username = exactText(
    required(object, "username", `${location}.username`),
    `${location}.username`,
    MAXIMUM_USERNAME_CHARACTERS,
  );
  if (!SAFE_USERNAME.test(username) || username.includes(":")) {
    manifestError(
      `${location}.username`,
      "must contain visible ASCII characters other than colon.",
    );
  }
  return Object.freeze({
    kind,
    username,
    secretFile: secretFileName(
      required(object, "secretFile", `${location}.secretFile`),
      `${location}.secretFile`,
    ),
  });
}

function parseProfile(
  value: unknown,
  index: number,
): ParsedCredentialProfile {
  const location = `$.profiles[${index}]`;
  const object = exactObject(
    value,
    location,
    [
      "authentication",
      "id",
      "label",
      "provider",
      "repositories",
    ],
  );
  const id = exactText(
    required(object, "id", `${location}.id`),
    `${location}.id`,
    64,
  );
  if (!PROFILE_ID.test(id)) {
    manifestError(
      `${location}.id`,
      "must start with a lowercase letter and contain at most 64 lowercase letters, digits, or hyphens.",
    );
  }
  const label = exactText(
    required(object, "label", `${location}.label`),
    `${location}.label`,
    MAXIMUM_LABEL_CHARACTERS,
  );
  const provider = parseProvider(
    required(object, "provider", `${location}.provider`),
    `${location}.provider`,
  );
  const repositoryValues = required(
    object,
    "repositories",
    `${location}.repositories`,
  );
  if (
    !Array.isArray(repositoryValues) ||
    repositoryValues.length === 0 ||
    repositoryValues.length > MAXIMUM_REPOSITORIES_PER_PROFILE
  ) {
    manifestError(
      `${location}.repositories`,
      `must contain 1 to ${MAXIMUM_REPOSITORIES_PER_PROFILE} exact repository URLs.`,
    );
  }
  const repositories: CanonicalRepository[] = [];
  const seen = new Set<string>();
  for (const [repositoryIndex, repositoryValue] of repositoryValues.entries()) {
    const repository = canonicalRepository(
      repositoryValue,
      provider,
      `${location}.repositories[${repositoryIndex}]`,
      true,
    );
    if (seen.has(repository.key)) {
      manifestError(
        `${location}.repositories`,
        "must not contain duplicate canonical repositories.",
      );
    }
    seen.add(repository.key);
    repositories.push(repository);
  }
  const authentication = parseAuthentication(
    required(
      object,
      "authentication",
      `${location}.authentication`,
    ),
    `${location}.authentication`,
  );
  return Object.freeze({
    id,
    label,
    provider,
    repositories: Object.freeze(repositories),
    authentication,
  });
}

function parseManifest(bytes: Buffer): readonly ParsedCredentialProfile[] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw configurationError(
      "the manifest must contain valid UTF-8 JSON.",
    );
  }
  let value: unknown;
  try {
    value = parseExactImportJsonValue(text);
  } catch {
    throw configurationError(
      "the manifest must contain valid exact-shape JSON.",
    );
  }
  const root = exactObject(value, "$", ["profiles", "version"]);
  if (required(root, "version", "$.version") !== MANIFEST_VERSION) {
    manifestError("$.version", `must be exactly ${MANIFEST_VERSION}.`);
  }
  const profileValues = required(root, "profiles", "$.profiles");
  if (
    !Array.isArray(profileValues) ||
    profileValues.length === 0 ||
    profileValues.length > MAXIMUM_PROFILES
  ) {
    manifestError(
      "$.profiles",
      `must contain 1 to ${MAXIMUM_PROFILES} profiles.`,
    );
  }
  const profiles = profileValues.map(parseProfile);
  const ids = new Set<string>();
  let repositoryCount = 0;
  for (const profile of profiles) {
    if (ids.has(profile.id)) {
      manifestError("$.profiles", "must not contain duplicate profile ids.");
    }
    ids.add(profile.id);
    repositoryCount += profile.repositories.length;
    if (repositoryCount > MAXIMUM_REPOSITORIES) {
      manifestError(
        "$.profiles",
        `must contain at most ${MAXIMUM_REPOSITORIES} repository scopes.`,
      );
    }
  }
  return Object.freeze(profiles);
}

function validateSecretBytes(bytes: Buffer): void {
  let end = bytes.byteLength;
  if (end > 0 && bytes[end - 1] === 0x0a) {
    end -= 1;
    if (end > 0 && bytes[end - 1] === 0x0d) end -= 1;
  }
  if (end === 0) {
    throw configurationError(
      "credential secret files must contain one nonempty UTF-8 line.",
    );
  }
  const content = bytes.subarray(0, end);
  const validUtf8 = isUtf8(content);
  let unsafe = false;
  if (validUtf8) {
    forEachUtf8CodePoint(content, (value) => {
      if (isUnsafeCodePoint(value)) unsafe = true;
    });
  }
  if (!validUtf8 || unsafe) {
    throw configurationError(
      "credential secret files must contain one nonempty UTF-8 line.",
    );
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export class CredentialProfileRegistry {
  readonly #profiles: ReadonlyMap<string, RegisteredCredentialProfile>;
  readonly #capabilities: readonly CredentialProfileCapability[];
  readonly #configured: boolean;
  #closed = false;

  private constructor(
    profiles: ReadonlyMap<string, RegisteredCredentialProfile>,
    configured: boolean,
  ) {
    this.#profiles = profiles;
    this.#configured = configured;
    this.#capabilities = Object.freeze(
      [...profiles.values()]
        .map((profile) =>
          Object.freeze({
            id: profile.id,
            label: profile.label,
            provider: profile.provider,
          }),
        )
        .sort((left, right) => compareText(left.id, right.id)),
    );
  }

  public static async open(
    options: CredentialProfileRegistryOptions = {},
  ): Promise<CredentialProfileRegistry> {
    const profilesFile = validatedProfilesFile(options.profilesFile);
    const platform = options.platform ?? process.platform;
    const trustWindowsCredentialFiles =
      options.trustWindowsCredentialFiles ?? false;
    if (typeof trustWindowsCredentialFiles !== "boolean") {
      throw configurationError(
        "CODECITY_TRUST_WINDOWS_CREDENTIAL_FILES must be an explicit boolean.",
      );
    }
    if (profilesFile === undefined) {
      if (trustWindowsCredentialFiles) {
        throw configurationError(
          "CODECITY_TRUST_WINDOWS_CREDENTIAL_FILES requires CODECITY_CREDENTIAL_PROFILES_FILE.",
        );
      }
      return new CredentialProfileRegistry(new Map(), false);
    }
    if (platform === "win32" && !trustWindowsCredentialFiles) {
      throw configurationError(
        "credential files on Windows require explicit private ACL and ancestry trust.",
      );
    }
    const directory = await openTrustedDirectory(
      path.dirname(profilesFile),
      platform,
    );
    const manifestFile = await readProtectedFile(
      profilesFile,
      directory,
      platform,
      2,
      MAXIMUM_MANIFEST_BYTES,
    );
    let parsedProfiles: readonly ParsedCredentialProfile[];
    try {
      parsedProfiles = parseManifest(manifestFile.bytes);
    } finally {
      manifestFile.bytes.fill(0);
    }
    const manifestName = path.basename(profilesFile);
    const validatedSecrets = new Set<string>();
    for (const profile of parsedProfiles) {
      const secretFile = profile.authentication.secretFile;
      if (
        (platform === "win32"
          ? secretFile.toLocaleLowerCase("en-US") ===
            manifestName.toLocaleLowerCase("en-US")
          : secretFile === manifestName)
      ) {
        throw configurationError(
          "a credential secret file must not be the manifest file.",
        );
      }
      const secretPath = path.join(directory.canonicalPath, secretFile);
      const secretKey =
        platform === "win32"
          ? secretPath.toLocaleLowerCase("en-US")
          : secretPath;
      if (validatedSecrets.has(secretKey)) continue;
      const secretFileContents = await readProtectedFile(
        secretPath,
        directory,
        platform,
        1,
        MAXIMUM_SECRET_BYTES,
      );
      try {
        if (
          sameIdentity(
            manifestFile.status,
            secretFileContents.status,
          ) ||
          samePath(
            manifestFile.canonicalPath,
            secretFileContents.canonicalPath,
            platform,
          )
        ) {
          throw configurationError(
            "a credential secret file must not be the manifest file.",
          );
        }
        validateSecretBytes(secretFileContents.bytes);
      } finally {
        secretFileContents.bytes.fill(0);
      }
      validatedSecrets.add(secretKey);
    }
    const registered = new Map<string, RegisteredCredentialProfile>();
    for (const profile of parsedProfiles) {
      const secretPath = path.join(
        directory.canonicalPath,
        profile.authentication.secretFile,
      );
      registered.set(
        profile.id,
        Object.freeze({
          id: profile.id,
          label: profile.label,
          provider: profile.provider,
          repositories: new Set(
            profile.repositories.map((repository) => repository.key),
          ),
          authentication: Object.freeze({
            ...profile.authentication,
            secretPath,
          }),
        }),
      );
    }
    return new CredentialProfileRegistry(registered, true);
  }

  public get configured(): boolean {
    return this.#configured;
  }

  public get size(): number {
    return this.#closed ? 0 : this.#profiles.size;
  }

  public capabilities(): readonly CredentialProfileCapability[] {
    return this.#closed ? EMPTY_CAPABILITIES : this.#capabilities;
  }

  public permits(
    profileId: string,
    provider: CredentialProfileProvider,
    repositoryUrl: string,
  ): boolean {
    if (this.#closed) return false;
    const profile = this.#profiles.get(profileId);
    if (profile === undefined || profile.provider !== provider) {
      return false;
    }
    try {
      return profile.repositories.has(
        canonicalRepository(
          repositoryUrl,
          provider,
          "$.repositoryUrl",
          true,
        ).key,
      );
    } catch {
      return false;
    }
  }

  public close(): void {
    this.#closed = true;
  }
}
