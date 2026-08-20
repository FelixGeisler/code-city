export const EXACT_CSP = "default-src 'none'; base-uri 'none'; connect-src 'self' https://api.github.com https://raw.githubusercontent.com; form-action 'none'; frame-src 'none'; object-src 'none'; script-src 'self'; style-src 'self'; worker-src 'self'";
export const EXACT_REFERRER_POLICY = "no-referrer";

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function parseAttributes(tag) {
  const opening = /^<\s*[^\s>]+/.exec(tag);
  const attributes = new Map();
  if (!opening) {
    return attributes;
  }

  const source = tag.slice(opening[0].length);
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    attributes.set(name, value);
  }
  return attributes;
}

function tagsWithPositions(html, name) {
  const pattern = new RegExp(`<${name}\\b[^>]*>`, "gi");
  return [...html.matchAll(pattern)].map((match) => ({
    tag: match[0],
    index: match.index,
    attributes: parseAttributes(match[0]),
  }));
}

export function inspectEntryPolicy(html) {
  invariant(typeof html === "string" && html.length > 0, "Entry HTML is empty");

  const metaTags = tagsWithPositions(html, "meta");
  const referrerTags = metaTags.filter(({ attributes }) => attributes.get("name")?.toLowerCase() === "referrer");
  invariant(referrerTags.length === 1, "Entry HTML must contain exactly one referrer meta tag");
  invariant(referrerTags[0].attributes.get("content") === EXACT_REFERRER_POLICY, "Entry HTML has the wrong referrer policy");

  const cspTags = metaTags.filter(({ attributes }) => attributes.get("http-equiv")?.toLowerCase() === "content-security-policy");
  invariant(cspTags.length === 1, "Entry HTML must contain exactly one CSP meta tag");
  invariant(cspTags[0].attributes.get("content") === EXACT_CSP, "Entry HTML has the wrong content security policy");

  const scripts = tagsWithPositions(html, "script");
  invariant(scripts.length > 0, "Entry HTML has no executable module resource");
  const executablePositions = scripts.map(({ index }) => index);
  for (const link of tagsWithPositions(html, "link")) {
    const relation = link.attributes.get("rel")?.toLowerCase();
    if (relation === "stylesheet" || relation === "modulepreload" || relation === "preload") {
      executablePositions.push(link.index);
    }
  }
  const firstExecutable = Math.min(...executablePositions);
  invariant(referrerTags[0].index < firstExecutable, "Referrer policy must precede executable resources");
  invariant(cspTags[0].index < firstExecutable, "Content security policy must precede executable resources");

  const completeScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  invariant(completeScripts.length === scripts.length, "Entry HTML contains a malformed script element");
  for (const match of completeScripts) {
    const attributes = parseAttributes(`<script${match[1]}>`);
    invariant(attributes.has("src"), "Inline script is forbidden");
    invariant(match[2].trim() === "", "Inline script content is forbidden");
  }
  invariant(!/<style\b/i.test(html) && !/\sstyle\s*=/i.test(html), "Inline style is forbidden");

  const headings = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/gi)];
  invariant(headings.length === 1 && headings[0][1].trim() === "Code City", "Entry HTML must contain the static Code City heading");

  return {
    cspPosition: cspTags[0].index,
    referrerPosition: referrerTags[0].index,
    firstExecutablePosition: firstExecutable,
  };
}

export function collectRuntimeReferences(html, packageFiles) {
  const references = new Set();

  for (const tag of [...html.matchAll(/<[a-z][^>]*>/gi)]) {
    const attributes = parseAttributes(tag[0]);
    for (const name of ["href", "src"]) {
      const value = attributes.get(name);
      if (value) {
        references.add(value);
      }
    }
  }

  for (const [relativePath, content] of packageFiles) {
    if (relativePath.endsWith(".css")) {
      for (const match of content.matchAll(/url\(\s*([^)]+?)\s*\)/gi)) {
        references.add(match[1].trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2"));
      }
      for (const match of content.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/gi)) {
        references.add(match[1]);
      }
    }

    if (relativePath.endsWith(".js")) {
      for (const match of content.matchAll(/["'`]((?:\/code-city\/|\/\/|data:|blob:)[^"'`\s]*)["'`]/gi)) {
        references.add(match[1]);
      }
    }
  }

  return [...references].sort();
}

export function assertWorkerConstructionPolicy(sources) {
  let workerConstructions = 0;
  for (const [label, source] of sources) {
    invariant(typeof source === "string", `${label} is not text`);
    invariant(!/\bnew\s+(?:(?:globalThis|window|self)\s*\.\s*)?SharedWorker\s*\(/.test(source), `${label} constructs a SharedWorker`);
    invariant(!/\b(?:blob:|data:|URL\s*\.\s*createObjectURL)\b/i.test(source), `${label} contains an inline worker mechanism`);
    const constructions = [...source.matchAll(/\bnew\s+(?:(?:globalThis|window|self)\s*\.\s*)?Worker\s*\(([\s\S]{0,300}?)\)/g)];
    workerConstructions += constructions.length;
    for (const construction of constructions) {
      invariant(/\{\s*type\s*:\s*["'`]module["'`]\s*\}/.test(construction[1]), `${label} worker is not an ES-module worker`);
      invariant(!/^\s*["'`](?:https?:|\/\/|blob:|data:)/i.test(construction[1]), `${label} worker is not statically same-origin`);
    }
  }
  invariant(workerConstructions === 1, `Production must contain exactly one Worker construction; found ${workerConstructions}`);
}
