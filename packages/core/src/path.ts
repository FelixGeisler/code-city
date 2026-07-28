const FNV_OFFSET_BASIS_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;

/** Normalize a source path lexically without consulting the filesystem. */
export function normalizePath(value: string): string {
  if (value.includes("\0")) {
    throw new TypeError("Paths must not contain NUL characters.");
  }

  const source = value.normalize("NFC").replaceAll("\\", "/");
  if (source === "") {
    return ".";
  }

  const driveMatch = /^([A-Za-z]):(?:\/|$)/u.exec(source);
  const drive = driveMatch?.[1]?.toUpperCase();
  const isUnc = !drive && source.startsWith("//");
  const isAbsolute = !drive && !isUnc && source.startsWith("/");
  const body = drive
    ? source.slice(2).replace(/^\/+/u, "")
    : source.replace(/^\/+/u, "");
  const parts = body.split(/\/+/u);
  const normalized: string[] = [];
  const protectedDepth = isUnc ? 2 : 0;

  for (const part of parts) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      const previous = normalized.at(-1);
      if (
        previous !== undefined &&
        previous !== ".." &&
        normalized.length > protectedDepth
      ) {
        normalized.pop();
      } else if (!drive && !isAbsolute && !isUnc) {
        normalized.push(part);
      }
      continue;
    }
    normalized.push(part);
  }

  const suffix = normalized.join("/");
  if (drive) {
    return suffix === "" ? `${drive}:/` : `${drive}:/${suffix}`;
  }
  if (isUnc) {
    return suffix === "" ? "//" : `//${suffix}`;
  }
  if (isAbsolute) {
    return suffix === "" ? "/" : `/${suffix}`;
  }
  return suffix === "" ? "." : suffix;
}

/** A deterministic, browser-safe 64-bit FNV-1a identifier. */
export function stableId(scope: string, ...components: readonly string[]): string {
  const safeScope =
    scope
      .normalize("NFC")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "") || "id";
  const payload = components
    .map((component) => {
      const normalized = component.normalize("NFC");
      return `${normalized.length}:${normalized}`;
    })
    .join("|");
  const bytes = new TextEncoder().encode(`${safeScope}|${payload}`);
  let hash = FNV_OFFSET_BASIS_64;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME_64) & UINT64_MASK;
  }
  return `${safeScope}:${hash.toString(16).padStart(16, "0")}`;
}

export function stablePathId(
  scope: string,
  repositoryId: string,
  path: string,
): string {
  return stableId(scope, repositoryId, normalizePath(path));
}

export const normalizeSourcePath = normalizePath;
export const createStableId = stableId;
