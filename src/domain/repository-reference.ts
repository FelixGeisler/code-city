export type RepositoryReference = Readonly<{
  owner: string;
  repository: string;
  branch: string | null;
  tag?: string;
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
  const release = segments[2] === "releases" && segments[3] === "tag";
  if (segments.length !== 2 && (release ? segments.length < 5 : segments.length < 4 || segments[2] !== "tree")) {
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

  const rawBranch = segments.slice(release ? 4 : 3).join("/");
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

  return release ? { owner, repository, branch: null, tag: branch } : { owner, repository, branch };
}
