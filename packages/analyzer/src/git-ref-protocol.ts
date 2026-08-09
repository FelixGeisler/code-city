import { validateGenericGitRef as validateRef, type ParsedGenericGitRemote } from "./git-remote-validation.js";
import { GenericGitSnapshotError } from "./git-snapshot-error.js";

const MEBIBYTE = 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = MEBIBYTE;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const INVALID_INPUT_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}]/u;

interface RefRecord {
  readonly objectSha: string;
  readonly name: string;
}

export interface RefSelection {
  readonly commitSha: string;
  readonly objectSha: string;
  readonly remoteRef?: string;
  readonly requestedRef?: string;
}

type ParsedRemote = ParsedGenericGitRemote;

export function decodeGitOutput(
  output: Uint8Array,
  maximumBytes = MAX_GIT_OUTPUT_BYTES,
): string {
  if (output.byteLength > maximumBytes) {
    throw new GenericGitSnapshotError(
      "GIT_OUTPUT_TOO_LARGE",
      "Installed Git output exceeded its size limit.",
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(output);
  } catch {
    throw new GenericGitSnapshotError(
      "GIT_INVALID_RESPONSE",
      "Installed Git returned invalid reference data.",
    );
  }
}

export function parseLsRemote(output: Uint8Array): {
  readonly symbolicHead?: string;
  readonly records: readonly RefRecord[];
} {
  const text = decodeGitOutput(output);
  const records: RefRecord[] = [];
  let symbolicHead: string | undefined;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r")
      ? rawLine.slice(0, -1)
      : rawLine;
    if (line.length === 0) continue;
    const separator = line.indexOf("\t");
    if (separator <= 0 || separator === line.length - 1) {
      throw new GenericGitSnapshotError(
        "GIT_INVALID_RESPONSE",
        "Installed Git returned invalid reference data.",
      );
    }
    const left = line.slice(0, separator);
    const name = line.slice(separator + 1);
    if (left.startsWith("ref: ")) {
      const target = left.slice(5);
      if (
        name !== "HEAD" ||
        symbolicHead !== undefined ||
        !target.startsWith("refs/heads/")
      ) {
        throw new GenericGitSnapshotError(
          "GIT_INVALID_RESPONSE",
          "Installed Git returned invalid reference data.",
        );
      }
      try {
        validateRef(target);
      } catch {
        throw new GenericGitSnapshotError(
          "GIT_INVALID_RESPONSE",
          "Installed Git returned invalid reference data.",
        );
      }
      symbolicHead = target;
      continue;
    }
    const objectSha = left.toLocaleLowerCase("en-US");
    const peeled = name.endsWith("^{}");
    const baseName = peeled ? name.slice(0, -3) : name;
    if (
      !COMMIT_SHA.test(objectSha) ||
      name.length === 0 ||
      INVALID_INPUT_CHARACTERS.test(name) ||
      (name !== "HEAD" &&
        (!baseName.startsWith("refs/") ||
          (peeled && !baseName.startsWith("refs/tags/"))))
    ) {
      throw new GenericGitSnapshotError(
        "GIT_INVALID_RESPONSE",
        "Installed Git returned invalid reference data.",
      );
    }
    if (name !== "HEAD") {
      try {
        validateRef(baseName);
      } catch {
        throw new GenericGitSnapshotError(
          "GIT_INVALID_RESPONSE",
          "Installed Git returned invalid reference data.",
        );
      }
    }
    records.push(Object.freeze({ objectSha, name }));
  }
  return Object.freeze({
    ...(symbolicHead === undefined ? {} : { symbolicHead }),
    records: Object.freeze(records),
  });
}

export function oneRecord(
  records: readonly RefRecord[],
  name: string,
): RefRecord | undefined {
  const matches = records.filter((record) => record.name === name);
  if (matches.length > 1) {
    throw new GenericGitSnapshotError(
      "GIT_INVALID_RESPONSE",
      "Installed Git returned duplicate reference data.",
    );
  }
  return matches[0];
}

export function selectRef(
  requestedRef: string | undefined,
  output: Uint8Array,
): RefSelection {
  const parsed = parseLsRemote(output);
  if (requestedRef === undefined) {
    if (parsed.symbolicHead === undefined) {
      throw new GenericGitSnapshotError(
        "GIT_REF_UNAVAILABLE",
        "Generic Git default branch is unavailable.",
      );
    }
    const head = oneRecord(parsed.records, "HEAD");
    const branch = oneRecord(parsed.records, parsed.symbolicHead);
    const expectedNames = new Set(["HEAD", parsed.symbolicHead]);
    if (
      head === undefined ||
      parsed.records.some(
        (record) => !expectedNames.has(record.name),
      ) ||
      (branch !== undefined && head.objectSha !== branch.objectSha)
    ) {
      throw new GenericGitSnapshotError(
        "GIT_INVALID_RESPONSE",
        "Generic Git default branch could not be verified.",
      );
    }
    return Object.freeze({
      commitSha: head.objectSha,
      objectSha: head.objectSha,
      remoteRef: parsed.symbolicHead,
    });
  }

  if (COMMIT_SHA.test(requestedRef.toLocaleLowerCase("en-US"))) {
    const commitSha = requestedRef.toLocaleLowerCase("en-US");
    if (!parsed.records.some((record) => record.objectSha === commitSha)) {
      throw new GenericGitSnapshotError(
        "GIT_REF_UNAVAILABLE",
        "Requested Generic Git commit is not advertised.",
      );
    }
    return Object.freeze({
      commitSha,
      objectSha: commitSha,
      requestedRef,
    });
  }

  const qualifiedBranch = requestedRef.startsWith("refs/heads/");
  const qualifiedTag = requestedRef.startsWith("refs/tags/");
  const branchRef = qualifiedTag
    ? undefined
    : qualifiedBranch
      ? requestedRef
      : `refs/heads/${requestedRef}`;
  const tagRef = qualifiedBranch
    ? undefined
    : qualifiedTag
      ? requestedRef
      : `refs/tags/${requestedRef}`;
  const branch =
    branchRef === undefined
      ? undefined
      : oneRecord(parsed.records, branchRef);
  const tag =
    tagRef === undefined ? undefined : oneRecord(parsed.records, tagRef);
  const peeled =
    tagRef === undefined
      ? undefined
      : oneRecord(parsed.records, `${tagRef}^{}`);
  const expectedNames = new Set([
    ...(branchRef === undefined ? [] : [branchRef]),
    ...(tagRef === undefined ? [] : [tagRef, `${tagRef}^{}`]),
  ]);
  if (
    parsed.symbolicHead !== undefined ||
    parsed.records.some(
      (record) => !expectedNames.has(record.name),
    ) ||
    (peeled !== undefined && tag === undefined)
  ) {
    throw new GenericGitSnapshotError(
      "GIT_INVALID_RESPONSE",
      "Installed Git returned unexpected reference data.",
    );
  }
  if (
    !requestedRef.startsWith("refs/") &&
    branch !== undefined &&
    tag !== undefined
  ) {
    throw new GenericGitSnapshotError(
      "GIT_REF_AMBIGUOUS",
      "Requested Generic Git ref is ambiguous.",
    );
  }
  if (branch !== undefined) {
    return Object.freeze({
      commitSha: branch.objectSha,
      objectSha: branch.objectSha,
      remoteRef: branchRef!,
      requestedRef,
    });
  }
  if (tag !== undefined) {
    return Object.freeze({
      commitSha: peeled?.objectSha ?? tag.objectSha,
      objectSha: tag.objectSha,
      remoteRef: tagRef!,
      requestedRef,
    });
  }
  throw new GenericGitSnapshotError(
    "GIT_REF_UNAVAILABLE",
    "Requested Generic Git ref is unavailable.",
  );
}

export function sameSelection(
  first: RefSelection,
  second: RefSelection,
): boolean {
  return (
    first.commitSha === second.commitSha &&
    first.objectSha === second.objectSha &&
    first.remoteRef === second.remoteRef
  );
}

export function lsRemoteOperation(
  remote: ParsedRemote,
  requestedRef: string | undefined,
): readonly string[] {
  if (requestedRef === undefined) {
    return ["ls-remote", "--symref", remote.value, "HEAD"];
  }
  if (COMMIT_SHA.test(requestedRef.toLocaleLowerCase("en-US"))) {
    return ["ls-remote", remote.value];
  }
  const qualifiedBranch = requestedRef.startsWith("refs/heads/");
  const qualifiedTag = requestedRef.startsWith("refs/tags/");
  const branchRef = qualifiedTag
    ? undefined
    : qualifiedBranch
      ? requestedRef
      : `refs/heads/${requestedRef}`;
  const tagRef = qualifiedBranch
    ? undefined
    : qualifiedTag
      ? requestedRef
      : `refs/tags/${requestedRef}`;
  return [
    "ls-remote",
    remote.value,
    ...(branchRef === undefined ? [] : [branchRef]),
    ...(tagRef === undefined ? [] : [tagRef, `${tagRef}^{}`]),
  ];
}

