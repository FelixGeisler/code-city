import { GenericGitSnapshotError } from "./git-snapshot-error.js";

const INVALID_INPUT_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const INVALID_REF_CHARACTERS = /[\s\\~^:?*]|\[|\]|\p{Cc}|\p{Cf}|\p{Cs}/u;
const SCP_REMOTE = /^(?:([A-Za-z0-9][A-Za-z0-9._-]*)@)?(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?):(.+)$/u;
const MAX_REMOTE_CODE_UNITS = 4_096;
const MAX_REMOTE_BYTES = 8_192;
const MAX_REF_CODE_UNITS = 1_024;
const MAX_REF_BYTES = 256;
const MAX_REPOSITORY_NAME_BYTES = 256;

export type GenericGitTransport = "https" | "ssh";

export interface GenericGitRemoteOrigin {
  readonly scheme: GenericGitTransport;
  readonly hostname: string;
  readonly port: number;
}

export interface ParsedGenericGitRemote {
  readonly value: string;
  readonly repository: string;
  readonly transport: GenericGitTransport;
  readonly origin: GenericGitRemoteOrigin;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function invalidRemote(): GenericGitSnapshotError {
  return new GenericGitSnapshotError(
    "GIT_INVALID_REMOTE",
    "Generic Git remote must be a credential-free HTTPS, SSH, or scp-style repository.",
  );
}

function repositoryName(rawPath: string): string {
  const candidate = rawPath.replaceAll("\\", "/").replace(/\/+$/u, "").split("/").at(-1);
  if (!candidate) throw invalidRemote();
  let decoded: string;
  try { decoded = decodeURIComponent(candidate); } catch { throw invalidRemote(); }
  decoded = decoded.replace(/\.git$/iu, "").normalize("NFC");
  if (
    decoded.length === 0 || decoded === "." || decoded === ".." ||
    decoded.includes("/") || decoded.includes("\\") ||
    INVALID_INPUT_CHARACTERS.test(decoded) || utf8Length(decoded) > MAX_REPOSITORY_NAME_BYTES
  ) throw invalidRemote();
  return decoded;
}

function parseUrlRemote(value: string): ParsedGenericGitRemote | undefined {
  let parsed: URL;
  try { parsed = new URL(value); } catch { return undefined; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") throw invalidRemote();
  if (
    parsed.hostname.length === 0 ||
    !/^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])$/u.test(parsed.hostname) ||
    parsed.password.length > 0 || parsed.search.length > 0 || parsed.hash.length > 0 ||
    value.includes("?") || value.includes("#") || value.includes("\\")
  ) throw invalidRemote();
  let decodedPath: string;
  try { decodedPath = decodeURIComponent(parsed.pathname); } catch { throw invalidRemote(); }
  if (decodedPath.includes("\\") || INVALID_INPUT_CHARACTERS.test(decodedPath)) throw invalidRemote();
  if (parsed.protocol === "https:" && parsed.username.length > 0) throw invalidRemote();
  if (parsed.protocol === "ssh:" && parsed.username.length > 0 && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(parsed.username)) throw invalidRemote();
  if (parsed.pathname === "" || parsed.pathname === "/") throw invalidRemote();
  if (parsed.protocol === "ssh:" && !/^\/[A-Za-z0-9._/-]+$/u.test(parsed.pathname)) throw invalidRemote();
  const port = Number(parsed.port || (parsed.protocol === "https:" ? "443" : "22"));
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw invalidRemote();
  return Object.freeze({
    value,
    repository: repositoryName(parsed.pathname),
    transport: parsed.protocol === "https:" ? "https" : "ssh",
    origin: Object.freeze({
      scheme: parsed.protocol === "https:" ? "https" : "ssh",
      hostname: parsed.hostname.replace(/^\[|\]$/gu, "").toLocaleLowerCase("en-US"),
      port,
    }),
  });
}

export function parseGenericGitRemote(value: string): ParsedGenericGitRemote {
  if (
    typeof value !== "string" || value.length === 0 || value.length > MAX_REMOTE_CODE_UNITS ||
    utf8Length(value) > MAX_REMOTE_BYTES || value !== value.trim() ||
    value.startsWith("-") || INVALID_INPUT_CHARACTERS.test(value)
  ) throw invalidRemote();
  const normalized = value.normalize("NFC");
  const url = parseUrlRemote(normalized);
  if (url !== undefined) return url;
  const scp = SCP_REMOTE.exec(normalized);
  if (scp === null || scp[0] !== normalized) throw invalidRemote();
  const remotePath = scp[3] ?? "";
  if (
    remotePath.length === 0 || remotePath.startsWith("-") || remotePath.includes("\\") ||
    remotePath.includes("?") || remotePath.includes("#") || /\s/u.test(remotePath) ||
    !/^[A-Za-z0-9._/-]+$/u.test(remotePath) || INVALID_INPUT_CHARACTERS.test(remotePath)
  ) throw invalidRemote();
  return Object.freeze({
    value: normalized,
    repository: repositoryName(remotePath),
    transport: "ssh",
    origin: Object.freeze({
      scheme: "ssh",
      hostname: (scp[2] ?? "").replace(/^\[|\]$/gu, "").toLocaleLowerCase("en-US"),
      port: 22,
    }),
  });
}

export function validateGenericGitRef(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_REF_CODE_UNITS) {
    throw new GenericGitSnapshotError("GIT_INVALID_REF", `Generic Git ref must be valid and no larger than ${MAX_REF_BYTES} UTF-8 bytes.`);
  }
  const normalized = value.normalize("NFC");
  const components = normalized.split("/");
  if (
    normalized.length === 0 || utf8Length(normalized) > MAX_REF_BYTES ||
    INVALID_REF_CHARACTERS.test(normalized) || normalized === "@" || normalized.startsWith("-") ||
    normalized.includes("..") || normalized.includes("@{") ||
    (normalized.startsWith("refs/") && !normalized.startsWith("refs/heads/") && !normalized.startsWith("refs/tags/")) ||
    components.some((component) => component.length === 0 || component.startsWith(".") || component.endsWith(".") || component.toLocaleLowerCase("en-US").endsWith(".lock"))
  ) {
    throw new GenericGitSnapshotError("GIT_INVALID_REF", `Generic Git ref must be valid and no larger than ${MAX_REF_BYTES} UTF-8 bytes.`);
  }
  return normalized;
}

export function validateGenericGitRepositoryUrl(value: string): string {
  return parseGenericGitRemote(value).value;
}

export function genericGitRepositoryOrigin(value: string): GenericGitRemoteOrigin {
  return parseGenericGitRemote(value).origin;
}
