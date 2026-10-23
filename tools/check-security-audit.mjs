import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const AUDIT_TIMEOUT_MS = 120_000;
export const REGISTRY_TIMEOUT_MS = 30_000;
export const MAXIMUM_BYTES = 1024 * 1024;
export const REGISTRY_URL = "https://registry.npmjs.org/braces";
export const APPROVED_HIGH_KEYS = Object.freeze([
  "@antora/content-aggregator",
  "@antora/site-generator",
  "@antora/ui-loader",
  "@asciidoctor/core",
  "asciidoctor-opal-runtime",
  "braces",
  "fast-glob",
  "micromatch",
]);

const SEVERITIES = Object.freeze(["info", "low", "moderate", "high", "critical"]);
const SEVERITY_RANK = new Map(SEVERITIES.map((value, index) => [value, index]));
const APPROVED_ADVISORY = Object.freeze({
  source: 1240992,
  name: "braces",
  dependency: "braces",
  url: "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm",
  severity: "high",
  range: "<=3.0.3",
});

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  return isRecord(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

export function decodeJson(bytes, label) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8`, { cause: error });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

function validateFixAvailable(value, label) {
  if (typeof value === "boolean") return;
  invariant(hasExactKeys(value, ["name", "version", "isSemVerMajor"]), `${label} fixAvailable shape changed`);
  invariant(typeof value.name === "string" && value.name.length > 0, `${label} fixAvailable name changed`);
  invariant(typeof value.version === "string" && value.version.length > 0, `${label} fixAvailable version changed`);
  invariant(typeof value.isSemVerMajor === "boolean", `${label} fixAvailable major flag changed`);
}

function validateAdvisory(value, label) {
  invariant(hasExactKeys(value, ["source", "name", "dependency", "title", "url", "severity", "cwe", "cvss", "range"]), `${label} advisory shape changed`);
  invariant(Number.isSafeInteger(value.source) && value.source > 0, `${label} advisory source is invalid`);
  for (const field of ["name", "dependency", "title", "url", "range"]) {
    invariant(typeof value[field] === "string" && value[field].length > 0, `${label} advisory ${field} is invalid`);
  }
  invariant(SEVERITY_RANK.has(value.severity), `${label} advisory severity is invalid`);
  invariant(Array.isArray(value.cwe) && value.cwe.every((entry) => typeof entry === "string" && /^CWE-[1-9][0-9]*$/u.test(entry)), `${label} advisory CWE data is invalid`);
  invariant(hasExactKeys(value.cvss, ["score", "vectorString"]), `${label} advisory CVSS shape changed`);
  invariant(typeof value.cvss.score === "number" && Number.isFinite(value.cvss.score) && value.cvss.score >= 0 && value.cvss.score <= 10, `${label} advisory CVSS score is invalid`);
  invariant(typeof value.cvss.vectorString === "string" && value.cvss.vectorString.length > 0, `${label} advisory CVSS vector is invalid`);
}

function validateVulnerabilityRecord(key, value) {
  invariant(hasExactKeys(value, ["name", "severity", "isDirect", "via", "effects", "range", "nodes", "fixAvailable"]), `${key} vulnerability shape changed`);
  invariant(value.name === key, `${key} vulnerability name changed`);
  invariant(SEVERITY_RANK.has(value.severity), `${key} vulnerability severity is invalid`);
  invariant(typeof value.isDirect === "boolean", `${key} direct flag is invalid`);
  invariant(Array.isArray(value.via), `${key} via graph is invalid`);
  for (const [index, entry] of value.via.entries()) {
    if (typeof entry === "string") invariant(entry.length > 0, `${key} via reference ${index} is empty`);
    else validateAdvisory(entry, `${key} via ${index}`);
  }
  invariant(Array.isArray(value.effects) && value.effects.every((entry) => typeof entry === "string" && entry.length > 0), `${key} effects graph is invalid`);
  invariant(new Set(value.effects).size === value.effects.length, `${key} effects graph has duplicates`);
  invariant(typeof value.range === "string" && value.range.length > 0, `${key} vulnerability range is invalid`);
  invariant(Array.isArray(value.nodes) && value.nodes.length > 0, `${key} node array is invalid`);
  invariant(value.nodes.every((entry) => typeof entry === "string" && entry.startsWith("node_modules/")), `${key} node path is invalid`);
  invariant(new Set(value.nodes).size === value.nodes.length, `${key} node array has duplicates`);
  validateFixAvailable(value.fixAvailable, key);
}

function resolveLockDependency(packages, fromLocation, dependency) {
  const segments = fromLocation ? fromLocation.split("/") : [];
  while (true) {
    const prefix = segments.length === 0 ? "" : `${segments.join("/")}/`;
    const candidate = `${prefix}node_modules/${dependency}`;
    if (Object.hasOwn(packages, candidate)) return candidate;
    const index = segments.lastIndexOf("node_modules");
    if (index < 0) break;
    segments.splice(index);
  }
  return undefined;
}

function productionClosure(lock) {
  const packages = lock.packages;
  const root = packages[""];
  const pending = Object.keys(root.dependencies ?? {}).map((name) => ["", name]);
  const reached = new Set();
  while (pending.length > 0) {
    const [parent, name] = pending.pop();
    const location = resolveLockDependency(packages, parent, name);
    invariant(location, `Production dependency ${name} cannot be resolved from ${parent || "root"}`);
    if (reached.has(location)) continue;
    reached.add(location);
    const record = packages[location];
    for (const child of Object.keys({ ...(record.dependencies ?? {}), ...(record.optionalDependencies ?? {}) })) {
      pending.push([location, child]);
    }
  }
  return reached;
}

export function validateLockExposure(lock, highRecords) {
  invariant(isRecord(lock) && lock.lockfileVersion === 3 && isRecord(lock.packages) && isRecord(lock.packages[""]), "package-lock.json shape changed");
  const packages = lock.packages;
  const root = packages[""];
  invariant(root.devDependencies?.["@antora/site-generator"] === "3.2.1", "Antora root pin changed");
  invariant(root.dependencies?.["@vscode/tree-sitter-wasm"] === "0.3.1" && root.dependencies?.["web-tree-sitter"] === "0.27.0", "Production parser pins changed");
  const production = productionClosure(lock);
  for (const [key, record] of Object.entries(highRecords)) {
    for (const node of record.nodes) {
      const lockRecord = packages[node];
      invariant(isRecord(lockRecord), `${key} audit node is missing from package-lock.json: ${node}`);
      invariant(lockRecord.dev === true, `${key} audit node is not development-only: ${node}`);
      invariant(!production.has(node), `${key} audit node is production-reachable: ${node}`);
    }
  }

  const consumers = [];
  for (const [location, record] of Object.entries(packages)) {
    for (const field of ["dependencies", "optionalDependencies"]) {
      if (isRecord(record[field]) && Object.hasOwn(record[field], "braces")) {
        consumers.push([location, field, record[field].braces]);
      }
    }
  }
  assertSameJson(consumers.sort((left, right) => left[0].localeCompare(right[0])), [
    ["node_modules/@antora/content-aggregator", "dependencies", "~3.0"],
    ["node_modules/@antora/ui-loader", "dependencies", "~3.0"],
    ["node_modules/micromatch", "dependencies", "^3.0.3"],
  ], "braces lock consumers changed");
}

function assertSameJson(actual, expected, message) {
  invariant(JSON.stringify(actual) === JSON.stringify(expected), message);
}

function summarizeAdvisoryGraph(vulnerabilities) {
  const summaries = new Map();
  const remainingChildren = new Map();
  const parentsByChild = new Map(Object.keys(vulnerabilities).map((key) => [key, []]));
  const ready = [];

  for (const [key, record] of Object.entries(vulnerabilities)) {
    const children = record.via.filter((via) => typeof via === "string");
    remainingChildren.set(key, children.length);
    if (children.length === 0) ready.push(key);
    for (const child of children) {
      invariant(Object.hasOwn(vulnerabilities, child), `Dangling vulnerability reference: ${child}`);
      parentsByChild.get(child).push(key);
    }
  }

  for (let index = 0; index < ready.length; index += 1) {
    const key = ready[index];
    const summary = { hasAdvisory: false, maximumSeverity: -1, unapprovedField: undefined };
    for (const via of vulnerabilities[key].via) {
      if (typeof via === "string") {
        const child = summaries.get(via);
        summary.hasAdvisory ||= child.hasAdvisory;
        summary.maximumSeverity = Math.max(summary.maximumSeverity, child.maximumSeverity);
        summary.unapprovedField ??= child.unapprovedField;
        continue;
      }

      summary.hasAdvisory = true;
      const advisorySeverity = via.severity;
      summary.maximumSeverity = Math.max(summary.maximumSeverity, SEVERITY_RANK.get(advisorySeverity));
      for (const [field, expected] of Object.entries(APPROVED_ADVISORY)) {
        const actual = field === "severity" ? advisorySeverity : via[field];
        if (actual !== expected) {
          summary.unapprovedField ??= field;
          break;
        }
      }
    }
    summaries.set(key, summary);

    for (const parent of parentsByChild.get(key)) {
      const remaining = remainingChildren.get(parent) - 1;
      remainingChildren.set(parent, remaining);
      if (remaining === 0) ready.push(parent);
    }
  }

  invariant(summaries.size === Object.keys(vulnerabilities).length, "Cyclic vulnerability graph");
  return summaries;
}

export function validateAuditReport(report, lock) {
  invariant(hasExactKeys(report, ["auditReportVersion", "vulnerabilities", "metadata"]), "npm audit top-level shape changed or contains an error payload");
  invariant(report.auditReportVersion === 2, "npm audit report version is not 2");
  invariant(isRecord(report.vulnerabilities), "npm audit vulnerabilities are invalid");
  invariant(hasExactKeys(report.metadata, ["vulnerabilities", "dependencies"]), "npm audit metadata shape changed");
  invariant(hasExactKeys(report.metadata.vulnerabilities, [...SEVERITIES, "total"]), "npm audit vulnerability counters changed");
  invariant(hasExactKeys(report.metadata.dependencies, ["prod", "dev", "optional", "peer", "peerOptional", "total"]), "npm audit dependency metadata is invalid");
  for (const value of Object.values(report.metadata.dependencies)) {
    invariant(Number.isSafeInteger(value) && value >= 0, "npm audit dependency counter is invalid");
  }

  const entries = Object.entries(report.vulnerabilities);
  for (const [key, value] of entries) validateVulnerabilityRecord(key, value);
  const actualCounts = Object.fromEntries(SEVERITIES.map((severity) => [severity, entries.filter(([, value]) => value.severity === severity).length]));
  for (const severity of SEVERITIES) {
    const declared = report.metadata.vulnerabilities[severity];
    invariant(Number.isSafeInteger(declared) && declared >= 0 && declared === actualCounts[severity], `npm audit ${severity} counter is inconsistent`);
  }
  invariant(report.metadata.vulnerabilities.total === SEVERITIES.reduce((sum, severity) => sum + actualCounts[severity], 0), "npm audit total counter is inconsistent");
  invariant(actualCounts.critical === 0, "npm audit contains a critical vulnerability");

  const advisorySummaries = summarizeAdvisoryGraph(report.vulnerabilities);
  for (const [key, record] of entries) {
    const summary = advisorySummaries.get(key);
    const stringVias = record.via.filter((via) => typeof via === "string");
    if (stringVias.length > 0) {
      invariant(stringVias.some((via) => report.vulnerabilities[via].effects.includes(key)), `${key} has no inverse effects edge`);
    }
    for (const effect of record.effects) {
      invariant(Object.hasOwn(report.vulnerabilities, effect), `Dangling vulnerability effect: ${effect}`);
      invariant(report.vulnerabilities[effect].via.includes(key), `${key}/${effect} effects/via edge is inconsistent`);
    }
    invariant(SEVERITY_RANK.get(record.severity) >= summary.maximumSeverity, `${key} understates a reachable advisory severity`);
  }

  const highKeys = entries.filter(([, value]) => value.severity === "high").map(([key]) => key).sort();
  assertSameJson(highKeys, [...APPROVED_HIGH_KEYS].sort(), "npm audit high-severity set changed");
  const highSet = new Set(APPROVED_HIGH_KEYS);
  const highRecords = Object.fromEntries(APPROVED_HIGH_KEYS.map((key) => [key, report.vulnerabilities[key]]));
  for (const [key, record] of Object.entries(highRecords)) {
    invariant(record.via.length > 0, `${key} has an empty approved via graph`);
    for (const via of record.via) {
      if (typeof via !== "string") continue;
      invariant(highSet.has(via), `${key} references a vulnerability outside the approved high set`);
    }
    for (const effect of record.effects) {
      invariant(highSet.has(effect), `${key} affects a vulnerability outside the approved high set`);
    }
    const summary = advisorySummaries.get(key);
    invariant(summary.hasAdvisory, `${key} does not resolve to an advisory leaf`);
    invariant(summary.unapprovedField === undefined, `${key} reaches an unapproved advisory ${summary.unapprovedField}`);
  }
  validateLockExposure(lock, highRecords);
  return { highKeys };
}

function appendBounded(chunks, state, chunk, label, maximumBytes, fail) {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const retained = bytes.subarray(0, maximumBytes + 1 - state.bytes);
  chunks.push(retained);
  state.bytes += retained.byteLength;
  if (state.bytes > maximumBytes) fail(new Error(`${label} exceeds 1 MiB`));
}

export async function runAuditCommand({
  cwd,
  spawnImpl = spawn,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  timeoutMs = AUDIT_TIMEOUT_MS,
  maximumBytes = MAXIMUM_BYTES,
} = {}) {
  let child;
  try {
    const auditArguments = ["audit", "--json", "--audit-level=high"];
    const npmExecutable = process.platform === "win32" ? process.execPath : "npm";
    if (process.platform === "win32") {
      auditArguments.unshift(path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"));
    }
    child = spawnImpl(npmExecutable, auditArguments, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error("Unable to spawn npm audit", { cause: error });
  }
  invariant(child && child.stdout && child.stderr && typeof child.kill === "function", "npm audit child process is invalid");

  const stdout = [];
  const stderr = [];
  const stdoutState = { bytes: 0 };
  const stderrState = { bytes: 0 };
  let failure;
  let timer;
  return await new Promise((resolve, reject) => {
    const stop = (error) => {
      if (!failure) failure = error;
      try { child.kill("SIGTERM"); } catch (killError) { failure = new AggregateError([failure, killError], "Unable to terminate npm audit"); }
    };
    const onStdout = (chunk) => appendBounded(stdout, stdoutState, chunk, "npm audit stdout", maximumBytes, stop);
    const onStderr = (chunk) => appendBounded(stderr, stderrState, chunk, "npm audit stderr", maximumBytes, stop);
    const onStdoutError = (error) => stop(new Error("npm audit stdout failed", { cause: error }));
    const onStderrError = (error) => stop(new Error("npm audit stderr failed", { cause: error }));
    const onError = (error) => stop(new Error("npm audit process failed", { cause: error }));
    const onClose = (code, signal) => {
      clearTimeoutImpl(timer);
      child.stdout.removeListener("data", onStdout);
      child.stdout.removeListener("error", onStdoutError);
      child.stderr.removeListener("data", onStderr);
      child.stderr.removeListener("error", onStderrError);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      if (failure) reject(failure);
      else if (code !== 1 || signal !== null) reject(new Error(`npm audit closed unexpectedly (code ${code}, signal ${signal})`));
      else resolve({ stdout: Buffer.concat(stdout, stdoutState.bytes), stderr: Buffer.concat(stderr, stderrState.bytes), code, signal });
    };
    child.stdout.on("data", onStdout);
    child.stdout.once("error", onStdoutError);
    child.stderr.on("data", onStderr);
    child.stderr.once("error", onStderrError);
    child.once("error", onError);
    child.once("close", onClose);
    timer = setTimeoutImpl(() => stop(new Error("npm audit exceeded 120 seconds")), timeoutMs);
  });
}

const SEMVER_IDENTIFIER = "(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)";
const PACKAGE_VERSION_PATTERN = new RegExp(`^(?<major>0|[1-9][0-9]*)\\.(?<minor>0|[1-9][0-9]*)\\.(?<patch>0|[1-9][0-9]*)(?:-(?<prerelease>${SEMVER_IDENTIFIER}(?:\\.${SEMVER_IDENTIFIER})*))?(?:\\+(?<build>[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$`, "u");
const APPROVED_BRACES_INTEGRITY = "sha512-yQbXgO/OSZVD2IsiLlro+7Hf6Q18EJrKSEsdoMzKePKXct3gvD8oLcOQdIzGupr5Fj+EDe8gO/lxc1BzfMpxvA==";

function isCanonicalSha512Integrity(value) {
  if (typeof value !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(value)) return false;
  const encoded = value.slice("sha512-".length);
  const digest = Buffer.from(encoded, "base64");
  return digest.byteLength === 64 && digest.toString("base64") === encoded;
}

function validatePackumentVersion(version, record) {
  const parsed = PACKAGE_VERSION_PATTERN.exec(version);
  invariant(parsed, `braces version key is invalid: ${version}`);
  invariant(isRecord(record) && record.name === "braces" && record.version === version, `braces ${version} version metadata is invalid`);
  invariant(!Object.hasOwn(record, "deprecated") || (typeof record.deprecated === "string" && record.deprecated.length > 0), `braces ${version} deprecation metadata is invalid`);
  invariant(isRecord(record.dist), `braces ${version} distribution is invalid`);
  invariant(record.dist.tarball === `https://registry.npmjs.org/braces/-/braces-${version}.tgz`, `braces ${version} tarball is invalid`);
  invariant(isCanonicalSha512Integrity(record.dist.integrity), `braces ${version} integrity is invalid`);
  return parsed.groups;
}

export function validatePackument(packument) {
  invariant(hasExactKeys(packument, ["name", "dist-tags", "versions", "modified"]), "braces packument shape changed");
  invariant(packument.name === "braces", "registry packument is not for braces");
  invariant(isRecord(packument["dist-tags"]) && Object.keys(packument["dist-tags"]).length > 0, "braces dist-tags are empty or invalid");
  invariant(isRecord(packument.versions) && Object.keys(packument.versions).length > 0, "braces versions are empty or invalid");
  invariant(typeof packument.modified === "string" && Number.isFinite(Date.parse(packument.modified)), "braces modified timestamp is invalid");

  const parsedVersions = new Map();
  for (const [version, record] of Object.entries(packument.versions)) {
    parsedVersions.set(version, validatePackumentVersion(version, record));
  }
  for (const [tag, version] of Object.entries(packument["dist-tags"])) {
    invariant(typeof tag === "string" && tag.length > 0 && typeof version === "string", "braces dist-tag is invalid");
    invariant(Object.hasOwn(packument.versions, version), `braces dist-tag ${tag} references a missing version`);
  }

  const approved = packument.versions["3.0.3"];
  invariant(approved?.dist?.integrity === APPROVED_BRACES_INTEGRITY, "braces 3.0.3 approved registry record is missing or changed");

  let removalVersion;
  for (const [version, record] of Object.entries(packument.versions)) {
    const parsed = parsedVersions.get(version);
    if (parsed.major !== "3" || parsed.minor !== "0" || Number(parsed.patch) <= 3 || parsed.prerelease !== undefined || Object.hasOwn(record, "deprecated")) continue;
    removalVersion ??= version;
  }
  invariant(!removalVersion, `Temporary braces exception expired: compatible fixed release ${removalVersion} is available`);
  return true;
}

export async function requestPackumentBytes({
  getImpl = https.get,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  timeoutMs = REGISTRY_TIMEOUT_MS,
  maximumBytes = MAXIMUM_BYTES,
} = {}) {
  const options = Object.freeze({
    method: "GET",
    headers: Object.freeze({
      Accept: "application/vnd.npm.install-v1+json",
      "Accept-Encoding": "identity",
      "Cache-Control": "no-store",
      Pragma: "no-cache",
    }),
    agent: false,
  });
  let request;
  let response;
  let requestClosed = false;
  let responseClosed = false;
  let responseEnded = false;
  let result;
  let failure;
  let timer;
  const chunks = [];
  const state = { bytes: 0 };

  return await new Promise((resolve, reject) => {
    let settled = false;
    let onResponseError;
    let onResponseAborted;
    let onResponseData;
    let onResponseEnd;
    let onResponseClose;
    const onRequestError = (error) => destroyOwned(new Error("braces registry request failed", { cause: error }));
    const onRequestClose = () => { requestClosed = true; cleanupAndSettle(); };
    const removeOwnedListeners = () => {
      request?.removeListener("error", onRequestError);
      request?.removeListener("close", onRequestClose);
      if (response) {
        response.removeListener("error", onResponseError);
        response.removeListener("aborted", onResponseAborted);
        response.removeListener("data", onResponseData);
        response.removeListener("end", onResponseEnd);
        response.removeListener("close", onResponseClose);
      }
    };
    function cleanupAndSettle() {
      if (settled || !requestClosed || (response && !responseClosed)) return;
      settled = true;
      clearTimeoutImpl(timer);
      removeOwnedListeners();
      if (failure) reject(failure);
      else if (result) resolve(result);
      else reject(new Error("braces registry request closed without a complete response"));
    }
    function destroyOwned(error) {
      if (!failure) failure = error;
      try { if (response && !responseClosed) response.destroy(); } catch (destroyError) { failure = new AggregateError([failure, destroyError], "Unable to destroy braces registry response"); }
      try { if (request && !requestClosed) request.destroy(); } catch (destroyError) { failure = new AggregateError([failure, destroyError], "Unable to destroy braces registry request"); }
      cleanupAndSettle();
    }
    const onResponse = (incoming) => {
      if (response) return destroyOwned(new Error("braces registry returned multiple responses"));
      response = incoming;
      if (!response || typeof response.on !== "function" || typeof response.destroy !== "function") {
        response = undefined;
        return destroyOwned(new Error("braces registry response is invalid"));
      }
      onResponseError = (error) => destroyOwned(new Error("braces registry response failed", { cause: error }));
      onResponseAborted = () => destroyOwned(new Error("braces registry response was truncated"));
      onResponseData = (chunk) => appendBounded(chunks, state, chunk, "braces registry response", maximumBytes, destroyOwned);
      onResponseEnd = () => {
        responseEnded = true;
        if (response.statusCode !== 200) return destroyOwned(new Error(`braces registry returned status ${response.statusCode}`));
        const declared = response.headers?.["content-length"];
        if (declared !== undefined && (!/^(?:0|[1-9][0-9]*)$/u.test(String(declared)) || Number(declared) !== state.bytes)) {
          return destroyOwned(new Error("braces registry response length is invalid"));
        }
        result = Buffer.concat(chunks, state.bytes);
        cleanupAndSettle();
      };
      onResponseClose = () => {
        responseClosed = true;
        if (!responseEnded && !failure) failure = new Error("braces registry response was truncated");
        cleanupAndSettle();
      };
      response.once("error", onResponseError);
      response.once("aborted", onResponseAborted);
      response.on("data", onResponseData);
      response.once("end", onResponseEnd);
      response.once("close", onResponseClose);
    };
    try {
      request = getImpl(REGISTRY_URL, options, onResponse);
      if (!request || typeof request.once !== "function" || typeof request.destroy !== "function") {
        request = undefined;
        throw new Error("braces registry request is invalid");
      }
      request.once("error", onRequestError);
      request.once("close", onRequestClose);
      timer = setTimeoutImpl(() => destroyOwned(new Error("braces registry request exceeded 30 seconds")), timeoutMs);
    } catch (error) {
      if (request) destroyOwned(error);
      else reject(new Error("Unable to start braces registry request", { cause: error }));
    }
  });
}

export async function runSecurityAudit({ rootDirectory, audit = {}, registry = {} } = {}) {
  const root = rootDirectory ?? path.resolve(fileURLToPath(new URL("../", import.meta.url)));
  const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  const auditResult = await runAuditCommand({ cwd: root, ...audit });
  const report = decodeJson(auditResult.stdout, "npm audit output");
  validateAuditReport(report, lock);
  const packumentBytes = await requestPackumentBytes(registry);
  validatePackument(decodeJson(packumentBytes, "braces registry response"));
  return { highCount: APPROVED_HIGH_KEYS.length };
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = await runSecurityAudit();
    console.log(`Validated the temporary development-only braces advisory closure (${result.highCount} high entries).`);
  } catch (error) {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  }
}
