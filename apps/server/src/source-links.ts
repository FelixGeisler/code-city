const MAXIMUM_EDITOR_URL_CHARACTERS = 4_096;
const EDITOR_URL_PROTOCOLS = Object.freeze(["https:", "vscode:", "vscode-insiders:"]);

export function immutableSourceUrl(
  provider: string,
  repositoryUrl: string | undefined,
  revision: string,
  sourcePath: string,
  line: number,
): string | undefined {
  if (repositoryUrl === undefined) return undefined;
  const encodedPath = sourcePath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  if (provider === "github") {
    return `${repositoryUrl.replace(/\.git\/?$/u, "").replace(/\/$/u, "")}/blob/${revision}/${encodedPath}#L${line}`;
  }
  if (provider === "azure-devops") {
    const result = new URL(repositoryUrl);
    result.search = "";
    result.hash = "";
    result.searchParams.set("path", `/${sourcePath}`);
    result.searchParams.set("version", `GC${revision}`);
    result.searchParams.set("line", String(line));
    result.searchParams.set("_a", "contents");
    return result.toString();
  }
  return undefined;
}

interface EditorUrlAuthority {
  readonly protocol: string;
  readonly host: string;
}

function renderedEditorUrl(template: string, pathSample: string, lineSample: string): URL {
  return new URL(template.replaceAll("{path}", pathSample).replaceAll("{line}", lineSample));
}

function editorUrlAuthority(template: string): EditorUrlAuthority {
  const parsed = renderedEditorUrl(template, "src/example.ts", "1");
  return Object.freeze({ protocol: parsed.protocol, host: parsed.host });
}

function editorTemplateAuthorityContainsPlaceholder(template: string): boolean {
  const schemeEnd = template.indexOf(":");
  if (schemeEnd < 0 || template.slice(schemeEnd + 1, schemeEnd + 3) !== "//") return false;
  const suffix = template.slice(schemeEnd + 3);
  const delimiter = suffix.search(/[/?#]/u);
  const authority = delimiter < 0 ? suffix : suffix.slice(0, delimiter);
  return authority.includes("{path}") || authority.includes("{line}");
}

function editorTemplateSchemeContainsPlaceholder(template: string): boolean {
  const schemeEnd = template.indexOf(":");
  const scheme = schemeEnd < 0 ? template : template.slice(0, schemeEnd);
  return scheme.includes("{path}") || scheme.includes("{line}");
}

export function configuredEditorUrl(
  template: string | undefined,
  sourcePath: string,
  line: number,
): string | undefined {
  if (template === undefined) return undefined;
  const encodedPath = sourcePath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  const rendered = template.replaceAll("{path}", encodedPath).replaceAll("{line}", String(line));
  if (rendered.length > MAXIMUM_EDITOR_URL_CHARACTERS) return undefined;
  try {
    const configured = editorUrlAuthority(template);
    const parsed = new URL(rendered);
    if (
      !EDITOR_URL_PROTOCOLS.includes(parsed.protocol) ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.protocol !== configured.protocol ||
      parsed.host !== configured.host
    ) return undefined;
    return rendered;
  } catch {
    return undefined;
  }
}

export function validateEditorUrlTemplate(template: string | undefined): void {
  if (template === undefined) return;
  if (
    template !== template.trim() ||
    template.length > MAXIMUM_EDITOR_URL_CHARACTERS ||
    !template.includes("{path}") ||
    /[\p{Cc}\p{Cf}\p{Cs}]/u.test(template) ||
    template.replaceAll("{path}", "").replaceAll("{line}", "").match(/[{}]/u) !== null ||
    editorTemplateSchemeContainsPlaceholder(template) ||
    editorTemplateAuthorityContainsPlaceholder(template)
  ) {
    throw new Error("The editor URL template must be at most 4096 characters, be trimmed, contain {path}, and keep placeholders outside the URL scheme and authority.");
  }
  let parsed: URL;
  let alternate: URL;
  try {
    parsed = renderedEditorUrl(template, "src/example.ts", "1");
    alternate = renderedEditorUrl(template, "nested/%E2%98%83.test.ts", "987654321");
  } catch {
    throw new Error("The editor URL template must be an absolute URL.");
  }
  if (
    !EDITOR_URL_PROTOCOLS.includes(parsed.protocol) ||
    parsed.username !== "" || parsed.password !== "" ||
    alternate.username !== "" || alternate.password !== "" ||
    parsed.protocol !== alternate.protocol || parsed.host !== alternate.host
  ) {
    throw new Error("The editor URL template must use HTTPS, vscode, or vscode-insiders, must not contain credentials, and must keep a fixed protocol and authority.");
  }
}
