export type RepositoryReference = Readonly<{
  owner: string;
  repository: string;
}>;

const SURROUNDING_ASCII_WHITESPACE = /^[ \t\r\n]*|[ \t\r\n]*$/g;
const LITERAL_PREFIX = "https://github.com/";

export function parseRepositoryReference(input: string): RepositoryReference | undefined {
  const value = input.replace(SURROUNDING_ASCII_WHITESPACE, "");
  if (!value.startsWith(LITERAL_PREFIX)) {
    return undefined;
  }

  const path = value.slice(LITERAL_PREFIX.length);
  const separator = path.indexOf("/");
  if (separator <= 0 || separator !== path.lastIndexOf("/") || separator === path.length - 1) {
    return undefined;
  }

  const owner = path.slice(0, separator);
  const repository = path.slice(separator + 1);
  if ([owner, repository].some((segment) => (
    segment === "."
    || segment === ".."
    || /[%\\?#]/.test(segment)
  ))) {
    return undefined;
  }

  return { owner, repository };
}

export function isProviderRevision(value: string): boolean {
  return /^[0-9a-f]{40,64}$/.test(value);
}
