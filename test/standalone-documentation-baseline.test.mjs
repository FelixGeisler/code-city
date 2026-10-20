import assert from "node:assert/strict";
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
  runtime: path.join(architectureRoot, "pages", "06-runtime-view.adoc"),
  policy: path.join(requirementsRoot, "pages", "standalone-m5-operating-policy.adoc"),
  requirementsNav: path.join(requirementsRoot, "nav.adoc"),
  product: path.join(requirementsRoot, "pages", "index.adoc"),
  city: path.join(requirementsRoot, "pages", "city-and-failures.adoc"),
};

const adrTarget = "adr/0014-standalone-server-owned-analysis-runtime.adoc";
const policyTarget = "standalone-m5-operating-policy.adoc";
const compact = (value) => value.replace(/\s+/gu, " ").trim();

function count(value, expected) {
  return value.split(expected).length - 1;
}

function assertExactlyOnce(value, expected, description) {
  assert.equal(count(value, expected), 1, description);
}

test("ADR 0014 retains the exact accepted bytes and both architecture links", async () => {
  const [adrBytes, architectureNav, decisions] = await Promise.all([
    readFile(files.adr),
    readFile(files.architectureNav, "utf8"),
    readFile(files.decisions, "utf8"),
  ]);
  const adr = adrBytes.toString("utf8");

  assert.equal(
    createHash("sha256").update(adrBytes).digest("hex"),
    "8b475a4b9556f15d623101f1e543c43fb1112b38f910a78bc3afd2d290c2e7d3",
  );
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
  const [constraints, runtime] = await Promise.all([
    readFile(files.constraints, "utf8"),
    readFile(files.runtime, "utf8"),
  ]);
  const architecture = compact(`${constraints}\n${runtime}`);

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
  assert.match(architecture, /not implemented or deployed[\s\S]*no\s+Raspberry Pi performance, concurrency, memory, or deployment qualification/u);
  assert.match(runtime, /Detailed request and event shapes, lifecycle states, session-loss detection,/u);
  assert.doesNotMatch(architecture, /\*Temporary custody:|\*Unsaved lifetime:|Rejected for M5:/u);
});

test("requirements distinguish current browser, standalone M5, and whole-core Save", async () => {
  const [product, city] = await Promise.all([
    readFile(files.product, "utf8"),
    readFile(files.city, "utf8"),
  ]);
  const compactProduct = compact(product);
  const compactCity = compact(city);

  assert.match(compactProduct, /standalone M5 slice is accepted but not implemented/u);
  assert.match(compactProduct, /currently implemented product is a static browser application with no server runtime or persistence/u);
  assert.match(compactProduct, /Neither source claims deployment or Raspberry Pi qualification/u);
  assert.match(compactCity, /Save and reopen remain approved whole-core outcomes/u);
  assert.match(compactCity, /Standalone M5 retains temporary source and results only in process memory and discards them on explicit discard, replacement, detected session loss, or graceful shutdown/u);
  assert.match(compactCity, /Save and reopen are deferred from M5, not revoked/u);
  assert.match(compactCity, /storage technology remains unresolved/u);
  assert.match(compactCity, /representation, format, and I\/O contract remain unresolved/u);
});
