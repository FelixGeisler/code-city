import type {
  CityIdentity,
  IdentityLogo,
  RepositoryIdentity,
} from "./model.js";
import { normalizePath } from "./path.js";

function text(value: string, field: string, maximumLength: number): string {
  const normalized = value.normalize("NFC").trim();
  if (normalized.length === 0) {
    throw new TypeError(`${field} must not be empty.`);
  }
  if (normalized.length > maximumLength) {
    throw new RangeError(`${field} must not exceed ${maximumLength} characters.`);
  }
  return normalized;
}

function rejectEncodedTraversal(value: string): void {
  for (const segment of value.split(/[\\/]/u)) {
    let decoded = segment;
    for (let depth = 0; depth < 8; depth += 1) {
      let next: string;
      try {
        next = decodeURIComponent(decoded);
      } catch {
        throw new TypeError(
          "Logo paths must not contain malformed percent encoding.",
        );
      }
      if (next === decoded) {
        break;
      }
      if (next === "." || next === ".." || /[\\/]/u.test(next)) {
        throw new TypeError(
          "Logo paths must not contain encoded traversal or separators.",
        );
      }
      decoded = next;
    }
    if (/%(?:2e|2f|5c|25)/iu.test(decoded)) {
      throw new TypeError("Logo paths use too many encoding layers.");
    }
  }
}

export function normalizeAssetRelativePath(original: string): string {
  if (
    original.startsWith("/") ||
    original.startsWith("\\") ||
    /^[A-Za-z]:/u.test(original) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(original) ||
    original.includes("?") ||
    original.includes("#")
  ) {
    throw new TypeError("Logo paths must be relative asset references.");
  }
  rejectEncodedTraversal(original);
  const relativePath = normalizePath(original);
  if (
    relativePath === "." ||
    relativePath === ".." ||
    relativePath.startsWith("../")
  ) {
    throw new TypeError("Logo paths must stay inside the asset root.");
  }
  return relativePath;
}

export function normalizeIdentityLogo(logo: IdentityLogo): IdentityLogo {
  const relativePath = normalizeAssetRelativePath(logo.relativePath);
  const expectedExtension = `.${logo.format}`;
  if (!relativePath.toLowerCase().endsWith(expectedExtension)) {
    throw new TypeError(`A ${logo.format} logo must use a ${expectedExtension} path.`);
  }
  return {
    relativePath,
    format: logo.format,
    ...(logo.alt === undefined ? {} : { alt: text(logo.alt, "logo.alt", 160) }),
  };
}

function normalizeRepositoryIdentity(
  identity: RepositoryIdentity,
): RepositoryIdentity {
  return {
    repositoryId: text(identity.repositoryId, "repositoryId", 160),
    ...(identity.title === undefined
      ? {}
      : { title: text(identity.title, "repository title", 160) }),
    ...(identity.version === undefined
      ? {}
      : { version: text(identity.version, "repository version", 80) }),
    ...(identity.logo === undefined
      ? {}
      : { logo: normalizeIdentityLogo(identity.logo) }),
  };
}

export function normalizeCityIdentity(identity: CityIdentity): CityIdentity {
  const repositories = identity.repositories
    ?.map(normalizeRepositoryIdentity)
    .sort((left, right) =>
      left.repositoryId.localeCompare(right.repositoryId, "en"),
    );
  if (repositories) {
    const ids = new Set<string>();
    for (const repository of repositories) {
      if (ids.has(repository.repositoryId)) {
        throw new TypeError(
          `Duplicate repository identity '${repository.repositoryId}'.`,
        );
      }
      ids.add(repository.repositoryId);
    }
  }
  return {
    title: text(identity.title, "identity.title", 160),
    ...(identity.version === undefined
      ? {}
      : { version: text(identity.version, "identity.version", 80) }),
    ...(identity.logo === undefined
      ? {}
      : { logo: normalizeIdentityLogo(identity.logo) }),
    ...(repositories === undefined ? {} : { repositories }),
  };
}
