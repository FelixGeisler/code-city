export type RepositoryReference = Readonly<{
  owner: string;
  repository: string;
  branch: string | null;
}>;

const SURROUNDING_ASCII_WHITESPACE = /^[ \t\r\n]*|[ \t\r\n]*$/g;
const LITERAL_PREFIX = "https://github.com/";

export function parseRepositoryReference(input: string): RepositoryReference | undefined {
  if (typeof input !== "string" || !input.isWellFormed()) {
    return undefined;
  }
  const value = input.replace(SURROUNDING_ASCII_WHITESPACE, "");
  if (!value.startsWith(LITERAL_PREFIX) || /[\\?#]/.test(value)) {
    return undefined;
  }

  const path = value.slice(LITERAL_PREFIX.length);
  const segments = path.split("/");
  if (segments.length !== 2 && (segments.length < 4 || segments[2] !== "tree")) {
    return undefined;
  }

  const [owner, repository] = segments;
  if ([owner, repository].some((segment) => (
    segment.length === 0
    || segment === "."
    || segment === ".."
    || /%/.test(segment)
  ))) {
    return undefined;
  }

  if (segments.length === 2) {
    return { owner, repository, branch: null };
  }

  const rawBranch = segments.slice(3).join("/");
  if (rawBranch.length === 0 || rawBranch.split("/").some((component) => component.length === 0)) {
    return undefined;
  }
  let branch: string;
  try {
    branch = decodeURIComponent(rawBranch);
  } catch {
    return undefined;
  }
  if (!branch.isWellFormed()
    || branch.split("/").some((component) => component.length === 0 || component === "." || component === "..")) {
    return undefined;
  }

  return { owner, repository, branch };
}
