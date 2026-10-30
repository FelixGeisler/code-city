export const CLI_FLAGS = Object.freeze([
  "--host",
  "--canonical-host",
  "--port",
  "--max-live-sessions",
  "--max-active-attempts",
  "--max-command-body-readers",
  "--max-command-body-bytes",
  "--max-retained-source-bytes",
] as const);

export interface AssetHostConfiguration {
  readonly host: string;
  readonly canonicalHost: string;
  readonly port: number;
}

export interface StandaloneConfiguration extends AssetHostConfiguration {
  readonly maxLiveSessions: number;
  readonly maxActiveAttempts: number;
  readonly maxCommandBodyReaders: number;
  readonly maxCommandBodyBytes: number;
  readonly maxRetainedSourceBytes: number;
}

const CAPACITY_MINIMUM_RETAINED_SOURCE_BYTES = 41_943_040;
const FLAG_SET = new Set<string>(CLI_FLAGS);

function invalid(): never {
  throw new Error("Invalid standalone operator configuration");
}

function canonicalUnsignedDecimal(value: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) invalid();
  const number = Number(value);
  if (!Number.isSafeInteger(number)) invalid();
  return number;
}

function parsePort(value: string): number {
  const port = canonicalUnsignedDecimal(value);
  if (port > 65_535) invalid();
  return port;
}

function parseCapacity(value: string): number {
  const capacity = canonicalUnsignedDecimal(value);
  if (capacity === 0) invalid();
  return capacity;
}

function isCanonicalIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^(?:0|[1-9][0-9]{0,2})$/u.test(part) && Number(part) <= 255);
}

function isCanonicalDns(value: string): boolean {
  if (value.length > 253 || !/^[a-z0-9.-]+$/u.test(value)) return false;
  const labels = value.split(".");
  return labels.every((label) => label.length >= 1
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label));
}

function isCanonicalIpv6(value: string): boolean {
  if (!/^\[[0-9a-f:]+\]$/u.test(value) || value === "[::]") return false;
  try {
    const parsed = new URL(`http://${value}/`);
    return parsed.host === value && parsed.hostname === value;
  } catch {
    return false;
  }
}

export function validateCanonicalHost(value: string): string {
  if (value.length === 0
      || value !== value.toLowerCase()
      || /[\u0000-\u0020\u007f]/u.test(value)
      || /[\/@?#%]/u.test(value)
      || value.endsWith(".")) invalid();

  let valid = false;
  if (value.startsWith("[") || value.endsWith("]") || value.includes(":")) {
    valid = isCanonicalIpv6(value);
  } else if (/^[0-9.]+$/u.test(value)) {
    valid = isCanonicalIpv4(value) && value !== "0.0.0.0";
  } else {
    valid = isCanonicalDns(value);
  }
  if (!valid) invalid();

  try {
    const parsed = new URL(`http://${value}/`);
    if (parsed.protocol !== "http:" || parsed.username || parsed.password || parsed.port || parsed.pathname !== "/"
        || parsed.search || parsed.hash || parsed.host !== value) invalid();
  } catch {
    invalid();
  }
  return value;
}

export function parseStandaloneArguments(argv: readonly string[]): StandaloneConfiguration {
  const supplied = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined || !FLAG_SET.has(flag) || value.length === 0 || value.startsWith("--") || supplied.has(flag)) invalid();
    supplied.set(flag, value);
  }

  const host = supplied.get("--host") ?? "127.0.0.1";
  if (host.length === 0 || /[\u0000-\u001f\u007f]/u.test(host)) invalid();
  const requestedCanonicalHost = supplied.get("--canonical-host");
  let canonicalHost: string;
  if (host === "127.0.0.1") {
    if (requestedCanonicalHost !== undefined) invalid();
    canonicalHost = "127.0.0.1";
  } else {
    if (requestedCanonicalHost === undefined) invalid();
    canonicalHost = validateCanonicalHost(requestedCanonicalHost);
  }

  const required = (flag: string): string => supplied.get(flag) ?? invalid();
  const port = parsePort(required("--port"));
  const maxLiveSessions = parseCapacity(required("--max-live-sessions"));
  const maxActiveAttempts = parseCapacity(required("--max-active-attempts"));
  const maxCommandBodyReaders = parseCapacity(required("--max-command-body-readers"));
  const maxCommandBodyBytes = parseCapacity(required("--max-command-body-bytes"));
  const maxRetainedSourceBytes = parseCapacity(required("--max-retained-source-bytes"));
  if (maxActiveAttempts > maxLiveSessions || maxRetainedSourceBytes < CAPACITY_MINIMUM_RETAINED_SOURCE_BYTES) invalid();

  return Object.freeze({
    host,
    canonicalHost,
    port,
    maxLiveSessions,
    maxActiveAttempts,
    maxCommandBodyReaders,
    maxCommandBodyBytes,
    maxRetainedSourceBytes,
  });
}

export function parseAssetHostArguments(argv: readonly string[]): AssetHostConfiguration {
  const supplied = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !["--host", "--canonical-host", "--port"].includes(flag) || !value || value.startsWith("--") || supplied.has(flag)) invalid();
    supplied.set(flag, value);
  }
  const host = supplied.get("--host") ?? "127.0.0.1";
  if (!host || /[\u0000-\u001f\u007f]/u.test(host)) invalid();
  const requested = supplied.get("--canonical-host");
  if (host === "127.0.0.1" && requested !== undefined) invalid();
  const canonicalHost = host === "127.0.0.1" ? host : validateCanonicalHost(requested ?? invalid());
  return Object.freeze({ host, canonicalHost, port: parsePort(supplied.get("--port") ?? invalid()) });
}

export function canonicalAuthority(canonicalHost: string, actualPort: number): string {
  validateCanonicalHost(canonicalHost);
  if (!Number.isInteger(actualPort) || actualPort < 0 || actualPort > 65_535) invalid();
  return actualPort === 80 ? canonicalHost : `${canonicalHost}:${actualPort}`;
}
