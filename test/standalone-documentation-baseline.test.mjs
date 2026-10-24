import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const architectureRoot = path.join(projectRoot, "docs", "modules", "architecture");
const requirementsRoot = path.join(projectRoot, "docs", "modules", "requirements");

const files = {
  adr: path.join(architectureRoot, "pages", "adr", "0014-standalone-server-owned-analysis-runtime.adoc"),
  architectureNav: path.join(architectureRoot, "nav.adoc"),
  decisions: path.join(architectureRoot, "pages", "09-architecture-decisions.adoc"),
  constraints: path.join(architectureRoot, "pages", "02-architecture-constraints.adoc"),
  buildingBlocks: path.join(architectureRoot, "pages", "05-building-block-view.adoc"),
  runtime: path.join(architectureRoot, "pages", "06-runtime-view.adoc"),
  deployment: path.join(architectureRoot, "pages", "07-deployment-view.adoc"),
  policy: path.join(requirementsRoot, "pages", "standalone-m5-operating-policy.adoc"),
  requirementsNav: path.join(requirementsRoot, "nav.adoc"),
  product: path.join(requirementsRoot, "pages", "index.adoc"),
  city: path.join(requirementsRoot, "pages", "city-and-failures.adoc"),
};

const adrRelativePath = "docs/modules/architecture/pages/adr/0014-standalone-server-owned-analysis-runtime.adoc";
const adrTarget = "adr/0014-standalone-server-owned-analysis-runtime.adoc";
const acceptedAdrSha256 = "8b475a4b9556f15d623101f1e543c43fb1112b38f910a78bc3afd2d290c2e7d3";
const policyTarget = "standalone-m5-operating-policy.adoc";
const compact = (value) => value.replace(/\s+/gu, " ").trim();
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function normalizeCheckoutLineEndings(bytes) {
  const canonical = [];
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0d && bytes[index + 1] === 0x0a) index += 1;
    canonical.push(bytes[index]);
  }
  return Buffer.from(canonical);
}

function count(value, expected) {
  return value.split(expected).length - 1;
}

function assertExactlyOnce(value, expected, description) {
  assert.equal(count(value, expected), 1, description);
}

test("ADR 0014 retains the canonical accepted content and both architecture links", async () => {
  const [checkoutAdrBytes, architectureNav, decisions] = await Promise.all([
    readFile(files.adr),
    readFile(files.architectureNav, "utf8"),
    readFile(files.decisions, "utf8"),
  ]);
  const committedAdrBytes = execFileSync("git", ["show", `HEAD:${adrRelativePath}`], { cwd: projectRoot });
  const canonicalCheckoutAdrBytes = normalizeCheckoutLineEndings(checkoutAdrBytes);
  const adr = canonicalCheckoutAdrBytes.toString("utf8");

  assert.equal(sha256(committedAdrBytes), acceptedAdrSha256, "committed ADR blob");
  assert.equal(sha256(canonicalCheckoutAdrBytes), acceptedAdrSha256, "canonical checkout ADR content");
  assert.deepEqual(canonicalCheckoutAdrBytes, committedAdrBytes, "checkout differs beyond CRLF representation");

  const mutatedAdrBytes = Buffer.from(canonicalCheckoutAdrBytes);
  const decisionOffset = mutatedAdrBytes.indexOf("Use the package-supported Node.js runtime");
  assert.notEqual(decisionOffset, -1, "accepted runtime decision prose");
  mutatedAdrBytes[decisionOffset] = 0x58;
  assert.notEqual(sha256(mutatedAdrBytes), acceptedAdrSha256, "ADR prose mutation must fail the content pin");

  assertExactlyOnce(adr, "Status:: Accepted", "ADR status");
  assert.ok(adr.endsWith("\n"), "ADR must retain its accepted final LF");
  assertExactlyOnce(architectureNav, adrTarget, "architecture navigation link");
  assertExactlyOnce(decisions, adrTarget, "architecture decision index link");
});

test("the accepted standalone policy is authoritative, complete, and linked", async () => {
  const [policySource, requirementsNav, product] = await Promise.all([
    readFile(files.policy, "utf8"),
    readFile(files.requirementsNav, "utf8"),
    readFile(files.product, "utf8"),
  ]);
  const policy = compact(policySource);

  assertExactlyOnce(requirementsNav, policyTarget, "requirements navigation link");
  assertExactlyOnce(product, policyTarget, "product-page link");
  assertExactlyOnce(policy, "Status:: Accepted", "accepted policy status");
  assertExactlyOnce(
    policy,
    "Human acceptance:: `SGTM`, receipt SHA-256 `bdf36f348863d90df01bf6795381e1e3a02daf217dd19a827f8f60292ef065bc`",
    "human acceptance provenance",
  );
  assertExactlyOnce(
    policy,
    "Accepted policy:: SHA-256 `a40e6c97c4dab3ef65e79a97ae4d2acef6863b1dcdfafd7e60e0ced980ac2565`",
    "accepted policy digest",
  );
  assert.doesNotMatch(policySource, /policy proposal|plan SHA-256|Human decision|Authority:/u);

  const acceptedClauses = [
    "* *Temporary custody:* Keep acquired and normalized source, its analysis facts, and their association only in application process memory. Create no application-managed source file, cache, snapshot, or database copy. This does not promise protection from OS swap, core dumps, host inspection, or unexpected process failure.",
    "* *Unsaved lifetime:* A successful current result retains its exact analyzed source association until explicit discard, replacement, or loss of its browser-owned temporary session. Starting a replacement analysis discards the previous temporary investigation, matching the current interaction. Success does not release source while its result remains current.",
    "* *Terminal and orphan cleanup policy:* Failure or cancellation publishes no partial replacement and releases attempt-only source/results after its worker has terminated and exited. Session loss permits no detached continuation or reconnect. Stop and join active workers, then discard that session's temporary source/results. Graceful server shutdown stops admission, terminates and joins active workers, and discards all temporary state. Stale worker messages never restore discarded state. The accepted implementation issue must define observable session-loss detection and every terminal transition. The Developer must not invent them. No transport protocol is selected here.",
    "* *Network exposure:* Listen on loopback by default. An operator may deliberately enable unauthenticated trusted-LAN exposure for public GitHub source only. This is not approval for Internet exposure, company authentication, private repositories, FLOW, or ADO.",
    "* *Capacity:* Require a finite operator-set admission capacity. Do not encode an uncalibrated default or resource promise. When capacity is unavailable, visibly reject a new analysis before source acquisition or worker creation. Do not silently lower the accepted per-source envelope, evict another session, or hide work in an unapproved queue.",
    "* *No Save:* Standalone M5 provides no Save, reopen, persistence, or recovery of a temporary investigation. The accepted whole-core Save target is deferred rather than revoked.",
  ];
  for (const clause of acceptedClauses) {
    assertExactlyOnce(policy, clause, clause.slice(4, clause.indexOf(":")));
  }

  const rationale = "This policy keeps the first standalone slice within public-source, temporary-session scope and bounds unattended memory ownership without inventing a persistence or identity system. It favors predictable cancellation and cleanup over reconnect recovery. Page/session loss discards work. Loopback-first operation reduces accidental exposure, while deliberate trusted-LAN mode remains usable without pretending that same-origin HTTP is authentication. Explicit admission rejection is less convenient than silent queuing or eviction but is observable and does not alter accepted analysis limits.";
  const rejected = "Rejected for M5: application disk custody, Save/reopen, anonymous Internet service, company/private-source authentication, silent eviction, hidden lower limits, unbounded admission, and detached orphan continuation. Child-process isolation remains a future architecture escalation if evidence requires it. It is not implied by these policies.";
  assertExactlyOnce(policy, rationale, "complete rationale and trade-off");
  assertExactlyOnce(policy, rejected, "complete rejected-M5 alternatives");
});

test("arc42 records structure without duplicating the authoritative policy", async () => {
  const [constraints, buildingBlocks, runtime, deployment] = await Promise.all([
    readFile(files.constraints, "utf8"),
    readFile(files.buildingBlocks, "utf8"),
    readFile(files.runtime, "utf8"),
    readFile(files.deployment, "utf8"),
  ]);
  const architecture = compact(`${constraints}\n${buildingBlocks}\n${runtime}\n${deployment}`);

  for (const fact of [
    "package-supported Node.js runtime",
    "native same-origin `node:http` service",
    "dedicated `worker_threads` worker",
    "same-process execution boundary",
    "process-memory-only temporary custody",
    "finite operator-set admission capacity",
    "awaits worker exit",
  ]) {
    assert.match(architecture, new RegExp(fact.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"), fact);
  }
  assert.match(architecture, /loopback-first[\s\S]*trusted-LAN/u);
  assert.match(architecture, /implemented as inactive[\s\S]*not implemented[\s\S]*no\s+Raspberry Pi performance, concurrency, memory, or deployment qualification/u);
  assert.match(compact(runtime), /inactive perimeter validates all operator values and supplied manifest bytes before listening/u);
  assert.match(runtime, /Session and event payloads, lifecycle states, session-loss detection,/u);
  assert.match(compact(buildingBlocks), /isolated `src\/edge\/node\/` graph contains four repository-internal building blocks/u);
  assert.match(compact(deployment), /inactive native-HTTP modules[\s\S]*neither included in the Pages artifact nor selected by `npm start`/u);
  assert.match(compact(deployment), /type-checks the isolated Node graph[\s\S]*unchanged `npm run verify`/u);
  assert.doesNotMatch(architecture, /\*Temporary custody:|\*Unsaved lifetime:|Rejected for M5:/u);
});

test("requirements distinguish current browser, standalone M5, and whole-core Save", async () => {
  const [product, city] = await Promise.all([
    readFile(files.product, "utf8"),
    readFile(files.city, "utf8"),
  ]);
  const compactProduct = compact(product);
  const compactCity = compact(city);

  assert.match(compactProduct, /standalone M5 slice is accepted and implementation has begun/u);
  assert.match(compactProduct, /inactive native-HTTP perimeter/u);
  assert.match(compactProduct, /active product remains a static browser application with no active server runtime or persistence/u);
  assert.match(compactProduct, /not wired to `npm start`, packaged, deployed, or used by the browser product/u);
  assert.match(compactCity, /Save and reopen remain approved whole-core outcomes/u);
  assert.match(compactCity, /Standalone M5 retains temporary source and results only in process memory and discards them on explicit discard, replacement, detected session loss, or graceful shutdown/u);
  assert.match(compactCity, /Save and reopen are deferred from M5, not revoked/u);
  assert.match(compactCity, /whole-core target beyond standalone M5[\s\S]*any runtime selection for that later target remain unselected/u);
  assert.match(city, /xref:architecture:adr\/0014-standalone-server-owned-analysis-runtime\.adoc\[accepted\s+ADR 0014\]/u);
  assert.match(city, /xref:standalone-m5-operating-policy\.adoc\[accepted standalone M5 operating policy\]/u);
  assert.match(compactCity, /ADR 0014\] selects package-supported Node\.js, native same-origin `node:http`, and dedicated `worker_threads`[\s\S]*operating policy\] governs custody, exposure, capacity, and cleanup/u);
  assert.doesNotMatch(compactCity, /Server runtime, API, storage, access, deletion, backup, ingress,[\s\S]*remain unselected/u);
  assert.match(compactCity, /storage technology remains unresolved/u);
  assert.match(compactCity, /representation, format, and I\/O contract remain unresolved/u);
});
