import type { IncomingMessage } from "node:http";
import net from "node:net";

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 3_000;
const MAXIMUM_REQUEST_TARGET_CHARACTERS = 2_048;

export interface ParsedTarget {
  readonly path: string;
}

export function validPort(port: number | undefined): number {
  const value = port ?? DEFAULT_PORT;
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) {
    throw new Error("Server port must be 0 or an integer from 1 to 65535.");
  }
  return value;
}

export function validHost(host: string | undefined): string {
  const value = host ?? DEFAULT_HOST;
  if (value.length === 0 || value.length > 255 || /[\u0000-\u0020\u007F/%\\]/u.test(value)) {
    throw new Error("Server host is invalid.");
  }
  return value;
}

function normalizeHostname(hostname: string): string {
  const unwrapped = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  const normalized = unwrapped.toLowerCase();
  if (net.isIP(normalized) !== 0) return normalized;
  if (
    normalized.length === 0 ||
    normalized.length > 253 ||
    normalized.includes("..") ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(normalized)
  ) throw new Error("Allowed server hostname is invalid.");
  return normalized;
}

export function allowedHostnames(
  bindHost: string,
  configured: readonly string[] | undefined,
): ReadonlySet<string> {
  const result = new Set<string>(["localhost"]);
  if (bindHost !== "0.0.0.0" && bindHost !== "::") result.add(normalizeHostname(bindHost));
  for (const hostname of configured ?? []) result.add(normalizeHostname(hostname));
  return result;
}

export function hostHeaderIsAllowed(
  request: IncomingMessage,
  allowed: ReadonlySet<string>,
): boolean {
  let count = 0;
  let value: string | undefined;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "host") {
      count += 1;
      value = request.rawHeaders[index + 1];
    }
  }
  if (
    count !== 1 || value === undefined || value.length === 0 || value.length > 255 ||
    /[\u0000-\u0020\u007F/@%?#\\]/u.test(value)
  ) return false;
  try {
    const parsed = new URL(`http://${value}`);
    if (
      parsed.username === "" && parsed.password === "" && parsed.pathname === "/" &&
      parsed.search === "" && parsed.hash === ""
    ) {
      const hostname = normalizeHostname(parsed.hostname);
      return net.isIP(hostname) !== 0 || allowed.has(hostname);
    }
    return false;
  } catch {
    return false;
  }
}

export function parseTarget(rawTarget: string | undefined): ParsedTarget | undefined {
  if (
    rawTarget === undefined || rawTarget.length === 0 ||
    rawTarget.length > MAXIMUM_REQUEST_TARGET_CHARACTERS ||
    !rawTarget.startsWith("/") || rawTarget.startsWith("//") ||
    rawTarget.includes("%") || /[\u0000-\u001F\u007F\\]/u.test(rawTarget)
  ) return undefined;
  const queryIndex = rawTarget.indexOf("?");
  if (queryIndex >= 0 && queryIndex !== rawTarget.length - 1) return undefined;
  const rawPath = queryIndex < 0 ? rawTarget : rawTarget.slice(0, queryIndex);
  const segments = rawPath.split("/").slice(1);
  if (segments.some((segment, index) =>
    segment === "." || segment === ".." || (segment === "" && index !== segments.length - 1)
  )) return undefined;
  return { path: rawPath };
}
