import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  APPROVED_HIGH_KEYS,
  decodeJson,
  MAXIMUM_BYTES,
  REGISTRY_URL,
  requestPackumentBytes,
  runAuditCommand,
  validateAuditReport,
  validatePackument,
} from "../tools/check-security-audit.mjs";

const projectRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const lock = JSON.parse(await readFile(path.join(projectRoot, "package-lock.json"), "utf8"));

function advisory(overrides = {}) {
  return {
    source: 1240992,
    name: "braces",
    dependency: "braces",
    title: "braces vulnerable to stack-exhaustion denial of service through deeply nested patterns",
    url: "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm",
    severity: "high",
    cwe: ["CWE-674"],
    cvss: { score: 7.5, vectorString: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H" },
    range: "<=3.0.3",
    ...overrides,
  };
}

const via = {
  "@antora/content-aggregator": ["braces", "fast-glob"],
  "@antora/site-generator": ["@antora/content-aggregator", "@antora/ui-loader"],
  "@antora/ui-loader": ["braces", "fast-glob"],
  "@asciidoctor/core": ["asciidoctor-opal-runtime"],
  "asciidoctor-opal-runtime": ["fast-glob"],
  braces: [advisory()],
  "fast-glob": ["micromatch"],
  micromatch: ["braces"],
};
const effects = {
  "@antora/content-aggregator": ["@antora/site-generator"],
  "@antora/site-generator": [],
  "@antora/ui-loader": [],
  "@asciidoctor/core": [],
  "asciidoctor-opal-runtime": ["@asciidoctor/core"],
  braces: ["@antora/content-aggregator", "@antora/ui-loader", "micromatch"],
  "fast-glob": ["@antora/content-aggregator", "@antora/ui-loader", "asciidoctor-opal-runtime"],
  micromatch: ["fast-glob"],
};

function vulnerability(name, severity = "high", overrides = {}) {
  return {
    name,
    severity,
    isDirect: name === "@antora/site-generator",
    via: structuredClone(via[name] ?? [advisory({ severity })]),
    effects: structuredClone(effects[name] ?? []),
    range: "*",
    nodes: [`node_modules/${name}`],
    fixAvailable: false,
    ...overrides,
  };
}

function reportWithLow() {
  const vulnerabilities = Object.fromEntries(APPROVED_HIGH_KEYS.map((name) => [name, vulnerability(name)]));
  vulnerabilities.example = vulnerability("example", "low", {
    via: [advisory({ source: 1, name: "example", dependency: "example", url: "https://example.invalid/advisory", severity: "low", range: "<1.0.0" })],
    nodes: ["node_modules/braces"],
  });
  return {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: {
      vulnerabilities: { info: 0, low: 1, moderate: 0, high: 8, critical: 0, total: 9 },
      dependencies: { prod: 3, dev: 204, optional: 48, peer: 0, peerOptional: 0, total: 206 },
    },
  };
}

function recount(report) {
  for (const severity of ["info", "low", "moderate", "high", "critical"]) {
    report.metadata.vulnerabilities[severity] = Object.values(report.vulnerabilities).filter((entry) => entry.severity === severity).length;
  }
  report.metadata.vulnerabilities.total = Object.keys(report.vulnerabilities).length;
}

function expectAuditMutation(mutator, pattern = /changed|invalid|inconsistent|unapproved|missing|Dangling|Cyclic|understates|development|production|consumer|high-severity|critical|empty|resolve/u) {
  const report = reportWithLow();
  const changedLock = structuredClone(lock);
  mutator(report, changedLock);
  assert.throws(() => validateAuditReport(report, changedLock), pattern);
}

test("controlled audit closure and internally consistent below-high changes pass", () => {
  assert.deepEqual(validateAuditReport(reportWithLow(), lock).highKeys.sort(), [...APPROVED_HIGH_KEYS].sort());
  const changed = reportWithLow();
  changed.vulnerabilities.example.severity = "moderate";
  changed.vulnerabilities.example.via[0].severity = "moderate";
  recount(changed);
  assert.doesNotThrow(() => validateAuditReport(changed, lock));
});

test("every approved-set and advisory identity mutation fails closed", async (t) => {
  await t.test("missing high", () => expectAuditMutation((report) => { delete report.vulnerabilities.micromatch; recount(report); }));
  await t.test("additional high", () => expectAuditMutation((report) => { report.vulnerabilities.extra = vulnerability("extra", "high", { nodes: ["node_modules/braces"] }); recount(report); }));
  await t.test("critical", () => expectAuditMutation((report) => { report.vulnerabilities.example.severity = "critical"; report.vulnerabilities.example.via[0].severity = "critical"; recount(report); }));
  for (const [field, value] of [["source", 1240993], ["name", "other"], ["dependency", "other"], ["url", "https://example.invalid"], ["severity", "moderate"], ["range", "<3.0.3"]]) {
    await t.test(`advisory ${field}`, () => expectAuditMutation((report) => { report.vulnerabilities.braces.via[0][field] = value; }));
  }
  await t.test("empty accepted via", () => expectAuditMutation((report) => { report.vulnerabilities.braces.via = []; }));
});

test("severity, graph, report schema, and counters fail closed", async (t) => {
  const cases = [
    ["direct severity understatement", (report) => { report.vulnerabilities.braces.severity = "moderate"; recount(report); }],
    ["transitive severity understatement", (report) => { report.vulnerabilities["fast-glob"].severity = "moderate"; recount(report); }],
    ["below-high severity understatement", (report) => { report.vulnerabilities.example.via[0].severity = "moderate"; }],
    ["dangling via", (report) => { report.vulnerabilities.micromatch.via = ["absent"]; }],
    ["cyclic via", (report) => { report.vulnerabilities.braces.via = ["micromatch"]; }],
    ["inconsistent effects", (report) => { report.vulnerabilities.braces.effects.push("@asciidoctor/core"); }],
    ["malformed record", (report) => { delete report.vulnerabilities.braces.nodes; }],
    ["malformed top level", (report) => { report.error = { message: "registry unavailable" }; }],
    ["counter mismatch", (report) => { report.metadata.vulnerabilities.high += 1; }],
    ["invalid counter", (report) => { report.metadata.vulnerabilities.low = -1; }],
    ["invalid node array", (report) => { report.vulnerabilities.braces.nodes = []; }],
    ["invalid fixAvailable", (report) => { report.vulnerabilities.braces.fixAvailable = { name: "braces" }; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, () => expectAuditMutation(mutate));
});

test("lock exposure and exact consumer assumptions fail closed", async (t) => {
  await t.test("missing lock node", () => expectAuditMutation((_report, value) => { delete value.packages["node_modules/braces"]; }));
  await t.test("non-development node", () => expectAuditMutation((_report, value) => { value.packages["node_modules/braces"].dev = false; }));
  await t.test("production reachable node", () => expectAuditMutation((_report, value) => { value.packages[""].dependencies.braces = "3.0.3"; }));
  await t.test("consumer range", () => expectAuditMutation((_report, value) => { value.packages["node_modules/micromatch"].dependencies.braces = "^3.0.2"; }));
  await t.test("additional consumer", () => expectAuditMutation((_report, value) => { value.packages["node_modules/fast-glob"].dependencies.braces = "3.0.3"; }));
});

function fakeChild({ stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), code = 1, signal = null, closeOnKill = true } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    if (closeOnKill) queueMicrotask(() => child.emit("close", 143, "SIGTERM"));
    return true;
  };
  child.complete = () => {
    child.stdout.end(stdout);
    child.stderr.end(stderr);
    queueMicrotask(() => child.emit("close", code, signal));
  };
  return child;
}

async function runChild(child, options = {}) {
  const calls = [];
  const promise = runAuditCommand({ cwd: projectRoot, spawnImpl(command, args, spawnOptions) { calls.push({ command, args, spawnOptions }); return child; }, ...options });
  return { calls, promise };
}

test("audit command is exact and accepts each exact 1 MiB stream boundary", async () => {
  const child = fakeChild({ stdout: Buffer.alloc(MAXIMUM_BYTES), stderr: Buffer.alloc(MAXIMUM_BYTES) });
  const { calls, promise } = await runChild(child);
  child.complete();
  const result = await promise;
  assert.equal(result.stdout.length, MAXIMUM_BYTES);
  assert.equal(result.stderr.length, MAXIMUM_BYTES);
  assert.deepEqual(calls[0].args.slice(-3), ["audit", "--json", "--audit-level=high"]);
  assert.equal(calls[0].command, process.platform === "win32" ? process.execPath : "npm");
  if (process.platform === "win32") assert.match(calls[0].args[0], /node_modules[\\/]npm[\\/]bin[\\/]npm-cli\.js$/u);
  assert.equal(calls[0].spawnOptions.shell, false);
});

test("audit spawn, exit, signal, timeout, stdout, and stderr failures terminate and await close", async (t) => {
  await t.test("spawn throws", async () => {
    await assert.rejects(() => runAuditCommand({ cwd: projectRoot, spawnImpl() { throw new Error("spawn denied"); } }), /spawn/u);
  });
  for (const fixture of [
    { name: "exit zero", child: fakeChild({ code: 0 }) },
    { name: "signal", child: fakeChild({ signal: "SIGKILL" }) },
    { name: "stdout overflow", child: fakeChild({ stdout: Buffer.alloc(MAXIMUM_BYTES + 1) }) },
    { name: "stderr overflow", child: fakeChild({ stderr: Buffer.alloc(MAXIMUM_BYTES + 1) }) },
  ]) {
    await t.test(fixture.name, async () => {
      const { promise } = await runChild(fixture.child);
      fixture.child.complete();
      await assert.rejects(promise, /unexpectedly|exceeds/u);
      if (fixture.name.includes("overflow")) assert.equal(fixture.child.killed, true);
    });
  }
  await t.test("timeout does not settle before owned child closes and clears its timer", async () => {
    const child = fakeChild({ closeOnKill: false });
    let fire;
    let cleared = false;
    const { promise } = await runChild(child, { setTimeoutImpl(callback) { fire = callback; return 17; }, clearTimeoutImpl(value) { assert.equal(value, 17); cleared = true; } });
    fire();
    let settled = false;
    void promise.finally(() => { settled = true; }).catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(child.killed, true);
    assert.equal(settled, false);
    child.emit("close", 143, "SIGTERM");
    await assert.rejects(promise, /120 seconds/u);
    assert.equal(cleared, true);
  });
});

function packument(versions = {}) {
  return {
    name: "braces",
    "dist-tags": { latest: "3.0.3" },
    versions: {
      "3.0.3": { name: "braces", version: "3.0.3", dist: { tarball: "https://registry.npmjs.org/braces/-/braces-3.0.3.tgz", integrity: "sha512-YQ==" } },
      ...versions,
    },
    modified: "2026-01-01T00:00:00.000Z",
  };
}

function release(version, overrides = {}) {
  return {
    name: "braces",
    version,
    dist: { tarball: `https://registry.npmjs.org/braces/-/braces-${version}.tgz`, integrity: "sha512-YQ==" },
    ...overrides,
  };
}

test("packument removal trigger distinguishes fixed, deprecated, prerelease, and incompatible releases", () => {
  assert.doesNotThrow(() => validatePackument(packument()));
  assert.throws(() => validatePackument(packument({ "3.0.4": release("3.0.4") })), /expired/u);
  assert.doesNotThrow(() => validatePackument(packument({ "3.0.4": release("3.0.4", { deprecated: "withdrawn" }) })));
  assert.doesNotThrow(() => validatePackument(packument({ "3.0.4-beta.1": release("3.0.4-beta.1"), "3.1.0": release("3.1.0"), "4.0.0": release("4.0.0") })));
  assert.throws(() => validatePackument(packument({ "3.0.4": release("3.0.4", { dist: { tarball: "https://example.invalid/braces.tgz", integrity: "sha512-YQ==" } }) })), /tarball/u);
  assert.throws(() => validatePackument(packument({ "3.0.4": release("3.0.4", { dist: { tarball: "https://registry.npmjs.org/braces/-/braces-3.0.4.tgz", integrity: "sha256-YQ==" } }) })), /integrity/u);
});

function fakeGet(body, { statusCode = 200, headers, responseFailure, requestFailure, holdClose = false, holdBody = false } = {}) {
  const observation = { calls: 0, destroyedRequest: false, destroyedResponse: false };
  let release;
  const get = (url, options, callback) => {
    observation.calls += 1;
    observation.url = url;
    observation.options = options;
    const request = new EventEmitter();
    observation.request = request;
    request.destroy = (error) => {
      observation.destroyedRequest = true;
      queueMicrotask(() => { if (error) request.emit("error", error); if (!holdClose) request.emit("close"); });
    };
    const response = new PassThrough();
    observation.response = response;
    response.statusCode = statusCode;
    response.headers = headers ?? { "content-length": String(body.length) };
    const nativeDestroy = response.destroy.bind(response);
    response.destroy = (error) => { observation.destroyedResponse = true; return nativeDestroy(error); };
    release = () => request.emit("close");
    queueMicrotask(() => {
      if (requestFailure) return request.destroy(requestFailure);
      callback(response);
      if (responseFailure) response.destroy(responseFailure);
      else if (!holdBody) response.end(body);
      if (!holdClose) request.emit("close");
    });
    return request;
  };
  return { get, observation, release: () => release?.() };
}

test("registry request is one fixed unauthenticated noncached GET and accepts exact 1 MiB", async () => {
  const fixture = fakeGet(Buffer.alloc(MAXIMUM_BYTES));
  const bytes = await requestPackumentBytes({ getImpl: fixture.get });
  assert.equal(bytes.length, MAXIMUM_BYTES);
  assert.equal(fixture.observation.calls, 1);
  assert.equal(fixture.observation.url, REGISTRY_URL);
  assert.deepEqual(fixture.observation.options, {
    method: "GET",
    headers: { Accept: "application/vnd.npm.install-v1+json", "Accept-Encoding": "identity", "Cache-Control": "no-store", Pragma: "no-cache" },
    agent: false,
  });
  assert.equal(JSON.stringify(fixture.observation.options).match(/authorization|cookie|credential/iu), null);
  assert.equal(fixture.observation.request.listenerCount("error"), 0);
  for (const event of ["error", "aborted", "data", "end", "close"]) assert.equal(fixture.observation.response.listenerCount(event), 0);
});

test("registry status, transport, timeout, malformed data, truncation, and overflow fail closed", async (t) => {
  const networkCases = [
    ["status", fakeGet(Buffer.from("{}"), { statusCode: 302 }), /status/u],
    ["transport", fakeGet(Buffer.alloc(0), { requestFailure: new Error("offline") }), /request failed/u],
    ["response", fakeGet(Buffer.alloc(0), { responseFailure: new Error("reset") }), /response failed|truncated/u],
    ["truncated length", fakeGet(Buffer.from("{}"), { headers: { "content-length": "3" } }), /length/u],
    ["overflow", fakeGet(Buffer.alloc(MAXIMUM_BYTES + 1)), /exceeds/u],
  ];
  for (const [name, fixture, pattern] of networkCases) {
    await t.test(name, async () => {
      await assert.rejects(() => requestPackumentBytes({ getImpl: fixture.get }), pattern);
      if (["status", "response", "overflow"].includes(name)) assert.equal(fixture.observation.destroyedResponse, true);
    });
  }
  await t.test("timeout aborts owned resources, awaits request close, and clears timer", async () => {
    const fixture = fakeGet(Buffer.from("{}"), { holdClose: true, holdBody: true });
    let fire;
    let cleared = false;
    const promise = requestPackumentBytes({ getImpl: fixture.get, setTimeoutImpl(callback) { fire = callback; return 23; }, clearTimeoutImpl(value) { assert.equal(value, 23); cleared = true; } });
    await new Promise((resolve) => setImmediate(resolve));
    fire();
    let settled = false;
    void promise.finally(() => { settled = true; }).catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fixture.observation.destroyedRequest, true);
    assert.equal(fixture.observation.destroyedResponse, true);
    assert.equal(settled, false);
    fixture.release();
    await assert.rejects(promise, /30 seconds/u);
    assert.equal(cleared, true);
    assert.equal(fixture.observation.request.listenerCount("error"), 0);
    for (const event of ["error", "aborted", "data", "end", "close"]) assert.equal(fixture.observation.response.listenerCount(event), 0);
  });
  assert.throws(() => validatePackument({ error: "not found" }), /shape/u);
  assert.throws(() => validatePackument(packument({ "3.0.4": { name: "braces", version: "wrong" } })), /metadata/u);
  assert.throws(() => decodeJson(Uint8Array.of(0xff), "fixture"), /UTF-8/u);
  assert.throws(() => decodeJson(Buffer.from("{"), "fixture"), /JSON/u);
});
