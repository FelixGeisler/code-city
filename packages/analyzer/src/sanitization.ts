import path from "node:path";

import { CITY_MODEL_LIMITS } from "../../core/src/model-validation.js";
import {
  normalizePath,
  normalizeRepositoryRelativePath,
  stableId,
} from "../../core/src/path.js";

const UNSAFE_TEXT_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}]/gu;
const ABSOLUTE_REFERENCE = /^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/u;
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const CREDENTIAL_URL =
  /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/?#\s]*@/gu;

function truncateWithDigest(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) return value;
  const digest = stableId("text", value).slice(-16);
  const prefixLength = Math.max(1, maximumLength - digest.length - 1);
  let prefix = value.slice(0, prefixLength);
  if (/[\uD800-\uDBFF]$/u.test(prefix)) prefix = prefix.slice(0, -1);
  return `${prefix}…${digest}`;
}

function credentialSafeUrl(value: string): string {
  const withoutInlineCredentials = value.replace(CREDENTIAL_URL, "$1");
  if (!URI_SCHEME.test(withoutInlineCredentials)) {
    return withoutInlineCredentials;
  }

  try {
    const parsed = new URL(withoutInlineCredentials);
    if (parsed.protocol === "file:") {
      return path.posix.basename(parsed.pathname.replaceAll("\\", "/")) ||
        "local-file";
    }
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return withoutInlineCredentials;
  }
}

function normalizedText(value: string): string {
  return credentialSafeUrl(value)
    .normalize("NFC")
    .replace(UNSAFE_TEXT_CHARACTERS, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function safeText(
  value: string,
  fallback: string,
  maximumLength: number,
): string {
  const normalized = normalizedText(value);
  return truncateWithDigest(normalized || fallback, maximumLength);
}

export function sanitizeDisplayText(
  value: string,
  fallback = "Unnamed",
): string {
  const normalized = safeText(
    value,
    fallback,
    CITY_MODEL_LIMITS.displayTextCharacters,
  );
  if (!ABSOLUTE_REFERENCE.test(normalized)) return normalized;
  return safeText(
    path.posix.basename(normalized.replaceAll("\\", "/")),
    fallback,
    CITY_MODEL_LIMITS.displayTextCharacters,
  );
}

export function sanitizeExternalReference(
  value: string,
  fallback = "external",
): string {
  const normalized = safeText(
    value,
    fallback,
    CITY_MODEL_LIMITS.externalReferenceCharacters,
  );
  const portable = normalized.replaceAll("\\", "/");
  if (ABSOLUTE_REFERENCE.test(normalized)) {
    return safeText(
      path.posix.basename(portable),
      fallback,
      CITY_MODEL_LIMITS.externalReferenceCharacters,
    );
  }
  if (URI_SCHEME.test(normalized)) return normalized;
  try {
    return normalizeRepositoryRelativePath(portable);
  } catch {
    const leaf = path.posix.basename(normalizePath(portable));
    return safeText(
      leaf === "." || leaf === ".." ? fallback : leaf,
      fallback,
      CITY_MODEL_LIMITS.externalReferenceCharacters,
    );
  }
}

export function sanitizeImportSpecifier(value: string): string {
  const normalized = safeText(
    value,
    "external-module",
    CITY_MODEL_LIMITS.externalReferenceCharacters,
  );
  return normalized.startsWith(".")
    ? normalized.replaceAll("\\", "/")
    : sanitizeExternalReference(normalized, "external-module");
}

export function sanitizeVersionText(value: string): string {
  return safeText(
    value,
    "unspecified",
    CITY_MODEL_LIMITS.versionCharacters,
  );
}

export function sanitizeWarningText(value: string): string {
  return safeText(
    value,
    "Analyzer warning.",
    CITY_MODEL_LIMITS.warningCharacters,
  );
}

export function safeRelativeInputPath(
  value: string,
  fallback = ".",
): string {
  if (
    value.length > CITY_MODEL_LIMITS.pathCharacters ||
    /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value) ||
    ABSOLUTE_REFERENCE.test(value) ||
    URI_SCHEME.test(value)
  ) {
    throw new Error(
      "Analyzer input contains a path that cannot be represented safely.",
    );
  }
  const normalized = value.normalize("NFC").replaceAll("\\", "/");
  return normalized || fallback;
}

export function safeRepositoryRelativePath(value: string): string {
  if (value.length > CITY_MODEL_LIMITS.pathCharacters) {
    throw new Error(
      "Analyzer input contains a path that cannot be represented safely.",
    );
  }
  if (/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) {
    throw new Error(
      "Analyzer input contains a path that cannot be represented safely.",
    );
  }
  let normalized: string;
  try {
    normalized = normalizeRepositoryRelativePath(value);
  } catch {
    throw new Error(
      "Analyzer input contains a path that cannot be represented safely.",
    );
  }
  if (normalized.length > CITY_MODEL_LIMITS.pathCharacters) {
    throw new Error(
      "Analyzer input contains a path that cannot be represented safely.",
    );
  }
  return normalized;
}
