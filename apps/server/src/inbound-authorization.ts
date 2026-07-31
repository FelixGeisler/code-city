import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  constants,
  promises as fs,
  type BigIntStats,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import type { IncomingMessage } from "node:http";

const AUTH_TOKEN_CHARACTERS = 43;
const AUTH_TOKEN_BYTES = 32;
const MAXIMUM_TOKEN_FILE_BYTES = AUTH_TOKEN_CHARACTERS + 2;
const MAXIMUM_SECRET_PATH_CHARACTERS = 2_048;
const MAXIMUM_PUBLIC_ORIGIN_CHARACTERS = 2_048;
const MAXIMUM_AUTHORIZATION_HEADER_CHARACTERS = 256;
const MAXIMUM_COOKIE_HEADER_CHARACTERS = 8 * 1_024;
const SESSION_COOKIE_NAME = "codecity-session";
const APPROVAL_COOKIE_NAME = "codecity-approval";
const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1_000;
const APPROVAL_SESSION_LIFETIME_MS = 10 * 60 * 1_000;
const MAXIMUM_SESSIONS = 64;
const MAXIMUM_SESSION_TOKEN_ATTEMPTS = 8;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const UNSAFE_TEXT = /[\u0000-\u001F\u007F]/u;

export type InboundAuthorizationMode =
  | "shared-secret"
  | "trusted-network";

export type InboundAuthorizationMethod =
  | "bearer"
  | "session"
  | "trusted-network";

export interface InboundAuthorizationResult {
  readonly authorized: boolean;
  readonly method?: InboundAuthorizationMethod;
}

export interface InboundAuthorizationOptions {
  readonly tokenFile?: string;
  readonly publicOrigin?: string;
  readonly trustWindowsTokenFile?: boolean;
  /** Test seam; production callers should omit it. */
  readonly platform?: NodeJS.Platform;
  /** Test seam; production callers should omit it. */
  readonly now?: () => number;
  /** Test seam; production callers should omit it. */
  readonly randomBytes?: (size: number) => Buffer;
}

export interface InboundAuthorizationStatus {
  readonly mode: InboundAuthorizationMode;
  readonly required: boolean;
  readonly authenticated: boolean;
}

interface Session {
  readonly createdAt: number;
  readonly expiresAt: number;
}

interface LoadedToken {
  readonly bytes: Buffer;
  readonly secureCookie: boolean;
  readonly publicOrigin: string;
  readonly publicHostname: string;
  readonly publicPort: number;
  readonly requireExplicitPublicPort: boolean;
}

function rawHeaderValues(
  request: IncomingMessage,
  name: string,
): readonly string[] {
  const normalizedName = name.toLowerCase();
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (
      request.rawHeaders[index]?.toLowerCase() === normalizedName
    ) {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  return values;
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function normalizedHostname(value: string): string {
  return value
    .replace(/^\[|\]$/gu, "")
    .toLocaleLowerCase("en-US");
}

function isLoopbackHostname(value: string): boolean {
  const hostname = normalizedHostname(value);
  if (hostname === "localhost") return true;
  const family = net.isIP(hostname);
  if (family === 4) return hostname.split(".")[0] === "127";
  if (family === 6) return hostname === "::1";
  return false;
}

function effectiveOriginPort(url: URL): number {
  if (url.port !== "") return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

function validatePublicOrigin(
  value: string | undefined,
  bindHost: string,
): {
  readonly origin: string;
  readonly secureCookie: boolean;
  readonly hostname: string;
  readonly port: number;
  readonly requireExplicitPort: boolean;
} {
  if (
    value === undefined ||
    value.length === 0 ||
    value.length > MAXIMUM_PUBLIC_ORIGIN_CHARACTERS ||
    value !== value.trim() ||
    UNSAFE_TEXT.test(value)
  ) {
    throw new Error(
      "CODECITY_PUBLIC_ORIGIN is required when inbound authorization is enabled.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      "CODECITY_PUBLIC_ORIGIN must be one exact HTTPS origin.",
    );
  }
  const secureCookie = parsed.protocol === "https:";
  const loopbackDevelopment =
    parsed.protocol === "http:" &&
    isLoopbackHostname(parsed.hostname) &&
    isLoopbackHostname(bindHost);
  if (
    (!secureCookie && !loopbackDevelopment) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    value.includes("?") ||
    value.includes("#")
  ) {
    throw new Error(
      "CODECITY_PUBLIC_ORIGIN must be one exact HTTPS origin; HTTP is allowed only for a loopback-bound development server.",
    );
  }
  const hostname = normalizedHostname(parsed.hostname);
  if (
    hostname.length === 0 ||
    hostname.length > 253 ||
    (net.isIP(hostname) === 0 &&
      (hostname.includes("..") ||
        !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(hostname)))
  ) {
    throw new Error(
      "CODECITY_PUBLIC_ORIGIN must contain a valid hostname or IP address.",
    );
  }
  const port = effectiveOriginPort(parsed);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      "CODECITY_PUBLIC_ORIGIN must use a valid explicit or default port.",
    );
  }
  return {
    origin: parsed.origin,
    secureCookie,
    hostname,
    port,
    requireExplicitPort:
      port !== (secureCookie ? 443 : 80),
  };
}

function validatedSecretPath(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (
    value.length > MAXIMUM_SECRET_PATH_CHARACTERS ||
    value !== value.trim() ||
    UNSAFE_TEXT.test(value) ||
    !path.isAbsolute(value)
  ) {
    throw new Error(
      "CODECITY_AUTH_TOKEN_FILE must be an absolute private file path.",
    );
  }
  return path.resolve(value);
}

function hasPrivateTokenMode(status: BigIntStats): boolean {
  const mode = Number(status.mode & 0o777n);
  return mode === 0o400 || mode === 0o600;
}

function assertTokenFilePolicy(
  status: BigIntStats,
  platform: NodeJS.Platform,
): void {
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    (status.dev === 0n && status.ino === 0n) ||
    status.nlink !== 1n ||
    status.size < BigInt(AUTH_TOKEN_CHARACTERS) ||
    status.size > BigInt(MAXIMUM_TOKEN_FILE_BYTES)
  ) {
    throw new Error(
      "CODECITY_AUTH_TOKEN_FILE must be one private regular file containing one token.",
    );
  }
  if (platform === "win32") return;
  if (
    process.geteuid === undefined ||
    status.uid !== BigInt(process.geteuid()) ||
    !hasPrivateTokenMode(status)
  ) {
    throw new Error(
      "CODECITY_AUTH_TOKEN_FILE must be owned by the server identity with mode 0400 or 0600.",
    );
  }
}

function decodeTokenFile(bytes: Buffer): Buffer {
  let end = bytes.byteLength;
  if (end > 0 && bytes[end - 1] === 0x0a) {
    end -= 1;
    if (end > 0 && bytes[end - 1] === 0x0d) end -= 1;
  }
  const tokenBytes = bytes.subarray(0, end);
  if (
    tokenBytes.byteLength !== AUTH_TOKEN_CHARACTERS ||
    tokenBytes.some((value) => value > 0x7f)
  ) {
    throw new Error(
      "CODECITY_AUTH_TOKEN_FILE must contain one canonical 32-byte base64url token.",
    );
  }
  const token = tokenBytes.toString("ascii");
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error(
      "CODECITY_AUTH_TOKEN_FILE must contain one canonical 32-byte base64url token.",
    );
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(token, "base64url");
  } catch {
    throw new Error(
      "CODECITY_AUTH_TOKEN_FILE must contain one canonical 32-byte base64url token.",
    );
  }
  if (
    decoded.byteLength !== AUTH_TOKEN_BYTES ||
    decoded.toString("base64url") !== token
  ) {
    decoded.fill(0);
    throw new Error(
      "CODECITY_AUTH_TOKEN_FILE must contain one canonical 32-byte base64url token.",
    );
  }
  return decoded;
}

async function loadTokenFile(
  filePath: string,
  platform: NodeJS.Platform,
): Promise<Buffer> {
  let before: BigIntStats;
  try {
    before = await fs.lstat(filePath, { bigint: true });
  } catch {
    throw new Error("CODECITY_AUTH_TOKEN_FILE could not be opened safely.");
  }
  assertTokenFilePolicy(before, platform);
  let canonicalBefore: string;
  try {
    canonicalBefore = await fs.realpath(filePath);
  } catch {
    throw new Error("CODECITY_AUTH_TOKEN_FILE could not be opened safely.");
  }
  let handle;
  try {
    handle = await fs.open(
      filePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch {
    throw new Error("CODECITY_AUTH_TOKEN_FILE could not be opened safely.");
  }
  let source: Buffer | undefined;
  try {
    const opened = await handle.stat({ bigint: true });
    assertTokenFilePolicy(opened, platform);
    if (!sameIdentity(before, opened)) {
      throw new Error(
        "CODECITY_AUTH_TOKEN_FILE changed while it was being opened.",
      );
    }
    source = Buffer.alloc(MAXIMUM_TOKEN_FILE_BYTES + 1);
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
    if (received > MAXIMUM_TOKEN_FILE_BYTES) {
      throw new Error(
        "CODECITY_AUTH_TOKEN_FILE must contain one canonical 32-byte base64url token.",
      );
    }
    const after = await fs.lstat(filePath, { bigint: true });
    const canonicalAfter = await fs.realpath(filePath);
    assertTokenFilePolicy(after, platform);
    if (
      !sameIdentity(opened, after) ||
      canonicalAfter !== canonicalBefore
    ) {
      throw new Error(
        "CODECITY_AUTH_TOKEN_FILE changed while it was being read.",
      );
    }
    return decodeTokenFile(source.subarray(0, received));
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("CODECITY_AUTH_TOKEN_FILE")
    ) {
      throw error;
    }
    throw new Error(
      "CODECITY_AUTH_TOKEN_FILE could not be read safely.",
    );
  } finally {
    source?.fill(0);
    await handle.close().catch(() => undefined);
  }
}

function sessionDigest(token: Buffer | string): string {
  return createHash("sha256").update(token).digest("hex");
}

function bearerCandidate(request: IncomingMessage): {
  readonly bytes: Buffer;
  readonly validFormat: boolean;
  readonly present: boolean;
} {
  const values = rawHeaderValues(request, "authorization");
  const fallback = Buffer.alloc(AUTH_TOKEN_BYTES);
  if (
    values.length !== 1 ||
    values[0]!.length > MAXIMUM_AUTHORIZATION_HEADER_CHARACTERS
  ) {
    return {
      bytes: fallback,
      validFormat: false,
      present: values.length > 0,
    };
  }
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(values[0]!);
  if (match === null) {
    return { bytes: fallback, validFormat: false, present: true };
  }
  const decoded = Buffer.from(match[1]!, "base64url");
  if (
    decoded.byteLength !== AUTH_TOKEN_BYTES ||
    decoded.toString("base64url") !== match[1]
  ) {
    decoded.fill(0);
    return { bytes: fallback, validFormat: false, present: true };
  }
  fallback.fill(0);
  return { bytes: decoded, validFormat: true, present: true };
}

function cookieToken(
  request: IncomingMessage,
  expectedName: string,
): string | undefined {
  const values = rawHeaderValues(request, "cookie");
  if (
    values.length !== 1 ||
    values[0]!.length > MAXIMUM_COOKIE_HEADER_CHARACTERS
  ) {
    return undefined;
  }
  let result: string | undefined;
  for (const part of values[0]!.split(";")) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const name = trimmed.slice(0, separator);
    if (name !== expectedName) continue;
    if (result !== undefined) return undefined;
    const value = trimmed.slice(separator + 1);
    if (!TOKEN_PATTERN.test(value)) return undefined;
    result = value;
  }
  return result;
}

function sessionCookieToken(request: IncomingMessage): string | undefined {
  return cookieToken(request, SESSION_COOKIE_NAME);
}

function rawHostMatches(
  request: IncomingMessage,
  hostname: string,
  port: number,
  requireExplicitPort: boolean,
): boolean {
  const values = rawHeaderValues(request, "host");
  if (values.length !== 1) return false;
  const authority = values[0]!;
  if (
    authority.length === 0 ||
    authority.length > 255 ||
    /[\u0000-\u0020\u007F/@%?#\\]/u.test(authority)
  ) {
    return false;
  }
  let rawHostname: string;
  let rawPort: string | undefined;
  if (authority.startsWith("[")) {
    const closingBracket = authority.indexOf("]");
    if (closingBracket < 2) return false;
    rawHostname = authority.slice(1, closingBracket);
    const remainder = authority.slice(closingBracket + 1);
    if (remainder !== "") {
      if (!remainder.startsWith(":")) return false;
      rawPort = remainder.slice(1);
    }
    if (net.isIP(rawHostname) !== 6) return false;
  } else {
    const separator = authority.lastIndexOf(":");
    if (separator >= 0) {
      if (authority.indexOf(":") !== separator) return false;
      rawHostname = authority.slice(0, separator);
      rawPort = authority.slice(separator + 1);
    } else {
      rawHostname = authority;
    }
  }
  if (normalizedHostname(rawHostname) !== hostname) return false;
  if (rawPort === undefined) return !requireExplicitPort;
  if (!/^[1-9][0-9]{0,4}$/u.test(rawPort)) return false;
  const requestPort = Number(rawPort);
  return requestPort <= 65_535 && requestPort === port;
}

export class InboundAuthorization {
  readonly #mode: InboundAuthorizationMode;
  readonly #token: Buffer | undefined;
  readonly #publicOrigin: string | undefined;
  readonly #publicHostname: string | undefined;
  readonly #publicPort: number | undefined;
  readonly #requireExplicitPublicPort: boolean;
  readonly #secureCookie: boolean;
  readonly #now: () => number;
  readonly #randomBytes: (size: number) => Buffer;
  readonly #sessions = new Map<string, Session>();
  readonly #approvalSessions = new Map<string, Session>();
  #closed = false;

  private constructor(
    loaded: LoadedToken | undefined,
    options: InboundAuthorizationOptions,
  ) {
    this.#mode =
      loaded === undefined ? "trusted-network" : "shared-secret";
    this.#token = loaded?.bytes;
    this.#publicOrigin = loaded?.publicOrigin;
    this.#publicHostname = loaded?.publicHostname;
    this.#publicPort = loaded?.publicPort;
    this.#requireExplicitPublicPort =
      loaded?.requireExplicitPublicPort ?? false;
    this.#secureCookie = loaded?.secureCookie ?? false;
    this.#now = options.now ?? Date.now;
    this.#randomBytes = options.randomBytes ?? randomBytes;
  }

  public static async open(
    options: InboundAuthorizationOptions,
    bindHost: string,
  ): Promise<InboundAuthorization> {
    const tokenFile = validatedSecretPath(options.tokenFile);
    const platform = options.platform ?? process.platform;
    const trustWindowsTokenFile =
      options.trustWindowsTokenFile ?? false;
    if (typeof trustWindowsTokenFile !== "boolean") {
      throw new Error(
        "CODECITY_TRUST_WINDOWS_AUTH_TOKEN_FILE must be an explicit boolean.",
      );
    }
    if (tokenFile === undefined) {
      if (
        options.publicOrigin !== undefined &&
        options.publicOrigin !== ""
      ) {
        throw new Error(
          "CODECITY_PUBLIC_ORIGIN for inbound authorization requires CODECITY_AUTH_TOKEN_FILE.",
        );
      }
      if (trustWindowsTokenFile) {
        throw new Error(
          "CODECITY_TRUST_WINDOWS_AUTH_TOKEN_FILE requires CODECITY_AUTH_TOKEN_FILE.",
        );
      }
      return new InboundAuthorization(undefined, options);
    }
    if (platform === "win32" && !trustWindowsTokenFile) {
      throw new Error(
        "CODECITY_AUTH_TOKEN_FILE on Windows requires explicit private token-file ACL and ancestry trust.",
      );
    }
    const publicOrigin = validatePublicOrigin(
      options.publicOrigin,
      bindHost,
    );
    const token = await loadTokenFile(tokenFile, platform);
    return new InboundAuthorization(
      {
        bytes: token,
        secureCookie: publicOrigin.secureCookie,
        publicOrigin: publicOrigin.origin,
        publicHostname: publicOrigin.hostname,
        publicPort: publicOrigin.port,
        requireExplicitPublicPort:
          publicOrigin.requireExplicitPort,
      },
      options,
    );
  }

  public get mode(): InboundAuthorizationMode {
    return this.#mode;
  }

  public get publicHostname(): string | undefined {
    return this.#publicHostname;
  }

  public authorize(
    request: IncomingMessage,
  ): InboundAuthorizationResult {
    if (this.#closed) return { authorized: false };
    if (this.#mode === "trusted-network") {
      return { authorized: true, method: "trusted-network" };
    }
    if (!this.requestUsesPublicAuthority(request)) {
      return { authorized: false };
    }
    const candidate = bearerCandidate(request);
    if (candidate.present) {
      const matches = timingSafeEqual(this.#token!, candidate.bytes);
      candidate.bytes.fill(0);
      return candidate.validFormat && matches
        ? { authorized: true, method: "bearer" }
        : { authorized: false };
    }
    const token = sessionCookieToken(request);
    if (token === undefined) return { authorized: false };
    const digest = sessionDigest(token);
    const session = this.#sessions.get(digest);
    if (session === undefined) return { authorized: false };
    if (session.expiresAt <= this.#now()) {
      this.#sessions.delete(digest);
      return { authorized: false };
    }
    return { authorized: true, method: "session" };
  }

  public authenticateBearer(request: IncomingMessage): boolean {
    if (
      this.#closed ||
      this.#mode !== "shared-secret" ||
      !this.requestUsesPublicAuthority(request)
    ) {
      return false;
    }
    const candidate = bearerCandidate(request);
    const matches = timingSafeEqual(this.#token!, candidate.bytes);
    candidate.bytes.fill(0);
    return candidate.present && candidate.validFormat && matches;
  }

  public status(
    request: IncomingMessage,
  ): InboundAuthorizationStatus {
    const result = this.authorize(request);
    return {
      mode: this.#mode,
      required: this.#mode === "shared-secret",
      authenticated:
        this.#mode === "shared-secret" && result.authorized,
    };
  }

  /** A non-secret, stable binding for short-lived, server-issued action grants. */
  public approvalBinding(request: IncomingMessage): string | undefined {
    if (this.#closed) return undefined;
    if (this.#mode === "trusted-network") {
      const token = cookieToken(request, APPROVAL_COOKIE_NAME);
      if (token === undefined) return undefined;
      const digest = sessionDigest(token);
      const session = this.#approvalSessions.get(digest);
      if (session === undefined) return undefined;
      if (session.expiresAt <= this.#now()) {
        this.#approvalSessions.delete(digest);
        return undefined;
      }
      return `trusted-network-session:${digest}`;
    }
    const bearer = bearerCandidate(request);
    if (bearer.present) {
      const matches = timingSafeEqual(this.#token!, bearer.bytes);
      const binding = bearer.validFormat && matches
        ? createHash("sha256").update("bearer:").update(bearer.bytes).digest("base64url")
        : undefined;
      bearer.bytes.fill(0);
      return binding;
    }
    const token = sessionCookieToken(request);
    if (token === undefined) return undefined;
    const digest = sessionDigest(token);
    const session = this.#sessions.get(digest);
    return session !== undefined && session.expiresAt > this.#now() ? `session:${digest}` : undefined;
  }

  /**
   * Returns a browser-specific approval binding. Trusted-network mode still
   * uses an HttpOnly cookie so reverse proxies cannot collapse every user onto
   * one IP-derived grant identity.
   */
  public ensureApprovalBinding(
    request: IncomingMessage,
  ): { readonly binding: string; readonly setCookie?: string } | undefined {
    const existing = this.approvalBinding(request);
    if (existing !== undefined) return { binding: existing };
    if (this.#closed || this.#mode !== "trusted-network") return undefined;
    this.removeExpiredApprovalSessions();
    for (let attempt = 0; attempt < MAXIMUM_SESSION_TOKEN_ATTEMPTS; attempt += 1) {
      const bytes = this.#randomBytes(AUTH_TOKEN_BYTES);
      const token = bytes.toString("base64url");
      bytes.fill(0);
      const digest = sessionDigest(token);
      if (this.#approvalSessions.has(digest)) continue;
      while (this.#approvalSessions.size >= MAXIMUM_SESSIONS) {
        const oldest = this.#approvalSessions.keys().next().value as
          | string
          | undefined;
        if (oldest === undefined) break;
        this.#approvalSessions.delete(oldest);
      }
      const createdAt = this.#now();
      this.#approvalSessions.set(digest, {
        createdAt,
        expiresAt: createdAt + APPROVAL_SESSION_LIFETIME_MS,
      });
      return {
        binding: `trusted-network-session:${digest}`,
        setCookie: `${APPROVAL_COOKIE_NAME}=${token}; Path=/api/v1/ai; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(APPROVAL_SESSION_LIFETIME_MS / 1_000)}${this.#secureCookie ? "; Secure" : ""}`,
      };
    }
    throw new Error("A secure AI approval session could not be created.");
  }

  public requestUsesPublicAuthority(
    request: IncomingMessage,
  ): boolean {
    if (this.#mode === "trusted-network") return true;
    return rawHostMatches(
      request,
      this.#publicHostname!,
      this.#publicPort!,
      this.#requireExplicitPublicPort,
    );
  }

  public mutationOriginAllowed(
    request: IncomingMessage,
    method: InboundAuthorizationMethod,
  ): boolean {
    if (this.#mode === "trusted-network") return true;
    const values = rawHeaderValues(request, "origin");
    if (method === "session") {
      return values.length === 1 && values[0] === this.#publicOrigin;
    }
    return (
      values.length === 0 ||
      (values.length === 1 && values[0] === this.#publicOrigin)
    );
  }

  public createSession(): string {
    if (this.#closed || this.#mode !== "shared-secret") {
      throw new Error("Inbound authorization is not available.");
    }
    this.removeExpiredSessions();
    for (
      let attempt = 0;
      attempt < MAXIMUM_SESSION_TOKEN_ATTEMPTS;
      attempt += 1
    ) {
      const bytes = this.#randomBytes(AUTH_TOKEN_BYTES);
      if (bytes.byteLength !== AUTH_TOKEN_BYTES) {
        bytes.fill(0);
        throw new Error("A secure authorization session could not be created.");
      }
      const token = bytes.toString("base64url");
      const digest = sessionDigest(token);
      bytes.fill(0);
      if (this.#sessions.has(digest)) continue;
      while (this.#sessions.size >= MAXIMUM_SESSIONS) {
        const oldest = this.#sessions.keys().next().value as
          | string
          | undefined;
        if (oldest === undefined) break;
        this.#sessions.delete(oldest);
      }
      const createdAt = this.#now();
      this.#sessions.set(digest, {
        createdAt,
        expiresAt: createdAt + SESSION_LIFETIME_MS,
      });
      return `${SESSION_COOKIE_NAME}=${token}; Path=/api/v1; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(
        SESSION_LIFETIME_MS / 1_000,
      )}${this.#secureCookie ? "; Secure" : ""}`;
    }
    throw new Error("A secure authorization session could not be created.");
  }

  public revokeSession(request: IncomingMessage): void {
    const token = sessionCookieToken(request);
    if (token !== undefined) this.#sessions.delete(sessionDigest(token));
  }

  public clearSessionCookie(): string {
    return `${SESSION_COOKIE_NAME}=; Path=/api/v1; HttpOnly; SameSite=Strict; Max-Age=0${
      this.#secureCookie ? "; Secure" : ""
    }`;
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#sessions.clear();
    this.#approvalSessions.clear();
    this.#token?.fill(0);
  }

  private removeExpiredSessions(): void {
    const now = this.#now();
    for (const [digest, session] of this.#sessions) {
      if (session.expiresAt <= now) this.#sessions.delete(digest);
    }
  }

  private removeExpiredApprovalSessions(): void {
    const now = this.#now();
    for (const [digest, session] of this.#approvalSessions) {
      if (session.expiresAt <= now) this.#approvalSessions.delete(digest);
    }
  }
}
