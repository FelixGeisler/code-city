import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import yaml from "js-yaml";
import { serializePackageManifest } from "../tools/package-manifest.mjs";
import { EXACT_CSP, EXACT_REFERRER_POLICY } from "../tools/package-policy.mjs";
import { createPublicationRecord } from "../tools/publication-record.mjs";
import {
  evaluateCondition,
  inlineModule,
  preparePacket,
  runEligibility,
  runModule,
} from "./fixtures/publication-workflow-seams.mjs";

const WORKFLOW_DIRECTORY = ".github/workflows";
const VERIFY_COMMANDS = ["npm ci --ignore-scripts", "npm ls --all", "npm audit --audit-level=high", "npm run verify"];
const PACKET_FILES = ["artifact.json", "smoke.json", "qualification.json", "capacity.json", "requests.json", "lifecycle.json", "index.json"];
const ACTIONS = {
  checkout: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  node: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
  pagesUpload: "actions/upload-pages-artifact@7b1f4a764d45c48632c6b24a0339c27f5614fb0b",
  artifactUpload: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  deploy: "actions/deploy-pages@d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e",
  download: "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
};

function exactKeys(value, expected, label) {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} has unexpected or missing keys`);
}

function checkoutStep(step) {
  exactKeys(step, ["uses", "with"], "checkout step");
  assert.equal(step.uses, ACTIONS.checkout);
  assert.deepEqual(step.with, { ref: "${{ github.sha }}", "persist-credentials": false });
}

function setupStep(step) {
  exactKeys(step, ["uses", "with"], "setup-node step");
  assert.equal(step.uses, ACTIONS.node);
  assert.deepEqual(step.with, { "node-version": 24, cache: "npm" });
}

function verifyPrefix(steps) {
  checkoutStep(steps[0]);
  setupStep(steps[1]);
  assert.deepEqual(steps.slice(2, 6), VERIFY_COMMANDS.map((run) => ({ run })));
}

async function parsedWorkflows() {
  const files = (await readdir(WORKFLOW_DIRECTORY)).filter((name) => /\.ya?ml$/u.test(name)).sort();
  assert.deepEqual(files, ["ci.yml", "publish.yml"], "the repository must have exactly the accepted workflows");
  const entries = await Promise.all(files.map(async (name) => {
    const source = await readFile(path.join(WORKFLOW_DIRECTORY, name), "utf8");
    return [name, { document: yaml.load(source) }];
  }));
  return Object.fromEntries(entries);
}

function jobSteps(document, job) {
  return document.jobs[job].steps;
}

function controlledManifestBytes(fileSha256 = "0".repeat(64)) {
  return serializePackageManifest({
    schemaVersion: 3,
    basePath: "/code-city/",
    policy: {
      contentSecurityPolicy: EXACT_CSP,
      referrerPolicy: EXACT_REFERRER_POLICY,
      connectOrigins: ["'self'", "https://api.github.com", "https://raw.githubusercontent.com"],
    },
    files: [{ path: "index.html", mediaType: "text/html", byteLength: 0, sha256: fileSha256 }],
  });
}

async function prepareBindingFixture(directory) {
  const tools = path.join(directory, "tools");
  const publication = path.join(directory, "build", "publication");
  await mkdir(tools, { recursive: true });
  await mkdir(publication, { recursive: true });
  await Promise.all(["package-manifest.mjs", "package-policy.mjs", "publication-record.mjs"].map(
    (name) => copyFile(path.join("tools", name), path.join(tools, name)),
  ));
  execFileSync("git", ["init", "--quiet", directory]);
  execFileSync("git", ["-C", directory, "config", "user.name", "Code City test"]);
  execFileSync("git", ["-C", directory, "config", "user.email", "test@code-city.invalid"]);
  execFileSync("git", ["-C", directory, "add", "tools"]);
  execFileSync("git", ["-C", directory, "commit", "--quiet", "-m", "binding fixture"]);
  const head = execFileSync("git", ["-C", directory, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const manifestBytes = controlledManifestBytes();
  const input = { repository: "FelixGeisler/code-city", eventName: "push", eventSha: head, runId: 123456, runAttempt: 2 };
  const recordBytes = createPublicationRecord(input, manifestBytes);
  const manifestPath = path.join(publication, "package-manifest.json");
  const recordPath = path.join(publication, "publication-record.json");
  await writeFile(manifestPath, manifestBytes);
  await writeFile(recordPath, recordBytes);
  return { head, input, manifestBytes, manifestPath, recordPath };
}

test("every workflow is parsed and CI has the exact pull-request-only topology", async () => {
  const workflows = await parsedWorkflows();
  const ci = workflows["ci.yml"].document;
  exactKeys(ci, ["name", "on", "permissions", "jobs"], "CI workflow");
  assert.equal(ci.name, "CI");
  assert.deepEqual(ci.on, { pull_request: null });
  assert.deepEqual(ci.permissions, {});
  exactKeys(ci.jobs, ["verify"], "CI jobs");

  const verify = ci.jobs.verify;
  exactKeys(verify, ["runs-on", "timeout-minutes", "permissions", "steps"], "CI verify job");
  assert.equal(verify["runs-on"], "ubuntu-latest");
  assert.equal(verify["timeout-minutes"], 20);
  assert.deepEqual(verify.permissions, { contents: "read" });
  assert.equal(verify.steps.length, 6);
  verifyPrefix(verify.steps);
});

test("parsed publish workflow has exact triggers, jobs, permissions, steps, pins, conditions, and topology", async () => {
  const workflows = await parsedWorkflows();
  const publish = workflows["publish.yml"].document;
  exactKeys(publish, ["name", "on", "permissions", "jobs"], "publish workflow");
  assert.equal(publish.name, "Publish");
  assert.deepEqual(publish.on, { push: { branches: ["main"] } });
  assert.deepEqual(publish.permissions, {});
  exactKeys(publish.jobs, ["verify", "deploy", "eligibility", "production-evidence"], "publish jobs");

  const verify = publish.jobs.verify;
  exactKeys(verify, ["runs-on", "timeout-minutes", "permissions", "steps"], "publish verify job");
  assert.deepEqual({ runner: verify["runs-on"], timeout: verify["timeout-minutes"], permissions: verify.permissions }, {
    runner: "ubuntu-latest", timeout: 20, permissions: { contents: "read" },
  });
  assert.equal(verify.steps.length, 9);
  verifyPrefix(verify.steps);
  exactKeys(verify.steps[6], ["name", "run"], "publication record step");
  assert.equal(verify.steps[6].name, "Create and validate the publication record");
  assert.match(verify.steps[6].run, /createPublicationRecord[\s\S]*validatePublicationRecord/u);
  assert.deepEqual(verify.steps[7], { name: "Upload the Pages artifact", uses: ACTIONS.pagesUpload, with: { path: "dist" } });
  assert.deepEqual(verify.steps[8], {
    name: "Upload internal publication evidence",
    uses: ACTIONS.artifactUpload,
    with: {
      name: "code-city-publication-evidence",
      path: "build/evidence/package-manifest.json\nbuild/evidence/publication-record.json\n",
      "if-no-files-found": "error",
      "retention-days": 90,
    },
  });

  const deploy = publish.jobs.deploy;
  exactKeys(deploy, ["needs", "runs-on", "timeout-minutes", "permissions", "environment", "steps"], "deploy job");
  assert.deepEqual(deploy, {
    needs: "verify",
    "runs-on": "ubuntu-latest",
    "timeout-minutes": 10,
    permissions: { pages: "write", "id-token": "write" },
    environment: { name: "github-pages", url: "${{ steps.deployment.outputs.page_url }}" },
    steps: [{ name: "Deploy the reviewed Pages artifact", id: "deployment", uses: ACTIONS.deploy }],
  });

  const eligibility = publish.jobs.eligibility;
  exactKeys(eligibility, ["needs", "runs-on", "timeout-minutes", "permissions", "outputs", "steps"], "eligibility job");
  assert.equal(eligibility.needs, "deploy");
  assert.equal(eligibility["runs-on"], "ubuntu-latest");
  assert.equal(eligibility["timeout-minutes"], 5);
  assert.deepEqual(eligibility.permissions, { issues: "read" });
  assert.deepEqual(eligibility.outputs, { "run-evidence": "${{ steps.issue.outputs.run-evidence }}" });
  assert.equal(eligibility.steps.length, 1);
  exactKeys(eligibility.steps[0], ["name", "id", "env", "run"], "eligibility step");
  assert.deepEqual({ name: eligibility.steps[0].name, id: eligibility.steps[0].id, env: eligibility.steps[0].env }, {
    name: "Read the production-acceptance parent state", id: "issue", env: { GH_TOKEN: "${{ github.token }}" },
  });

  const evidence = publish.jobs["production-evidence"];
  exactKeys(evidence, ["needs", "if", "runs-on", "permissions", "steps"], "production-evidence job");
  assert.deepEqual(evidence.needs, ["verify", "deploy", "eligibility"]);
  assert.equal(evidence.if, "needs.eligibility.outputs.run-evidence == 'true'");
  assert.equal(evidence["runs-on"], "ubuntu-latest");
  assert.deepEqual(evidence.permissions, { contents: "read" });
  assert.equal(Object.hasOwn(evidence, "timeout-minutes"), false, "the product collector has no configured product timeout");
  assert.equal(evidence.steps.length, 9);
  checkoutStep(evidence.steps[0]);
  setupStep(evidence.steps[1]);
  const expectedStepKeys = [
    ["name", "uses", "with"],
    ["name", "run"],
    ["name", "id", "continue-on-error", "run"],
    ["name", "id", "if", "run"],
    ["name", "id", "if", "uses", "with"],
    ["name", "if", "env", "run"],
    ["name", "if", "run"],
  ];
  evidence.steps.slice(2).forEach((step, index) => exactKeys(step, expectedStepKeys[index], `production step ${index + 2}`));
  assert.deepEqual(evidence.steps.map((step) => step.name ?? step.uses), [
    ACTIONS.checkout,
    ACTIONS.node,
    "Download current-run publication evidence",
    "Verify workflow-owned publication bindings",
    "Collect tokenless production evidence",
    "Seal the upload gate",
    "Upload the sealed production packet",
    "Record authenticated finalization metadata",
    "Preserve handled-failure status",
  ]);
  assert.deepEqual(evidence.steps[2], {
    name: "Download current-run publication evidence", uses: ACTIONS.download,
    with: { name: "code-city-publication-evidence", path: "build/publication" },
  });
  assert.deepEqual({ id: evidence.steps[4].id, continued: evidence.steps[4]["continue-on-error"] }, { id: "collector", continued: true });
  assert.equal(evidence.steps.indexOf(evidence.steps[3]) < evidence.steps.indexOf(evidence.steps[4]), true, "publication binding precedes collection");
  assert.equal(evidence.steps[4].run, `env -i HOME="$HOME" PATH="$PATH" RUNNER_OS="$RUNNER_OS" RUNNER_ARCH="$RUNNER_ARCH" \\
  node tools/collect-production-evidence.mjs \\
  --origin https://felixgeisler.github.io/code-city/ \\
  --manifest build/publication/package-manifest.json \\
  --output build/production-evidence
`);
  assert.doesNotMatch(evidence.steps[4].run, /token|secret|github[._-]?token|gh_token/iu);
  const bindingSource = inlineModule(evidence.steps[3]);
  assert.doesNotMatch(bindingSource, /api\.github\.com|collectorCommit|deriveCollectorCommit|deployments?\?/u);
  const collectorSource = await readFile("tools/collect-production-evidence.mjs", "utf8");
  assert.match(collectorSource, /deriveCollectorCommit/u);
  assert.match(collectorSource, /repos\/FelixGeisler\/code-city\/deployments\?/u);
  assert.deepEqual({ id: evidence.steps[5].id, if: evidence.steps[5].if }, { id: "packet", if: "always()" });
  assert.equal(evidence.steps[6].uses, ACTIONS.artifactUpload);
  assert.deepEqual({ id: evidence.steps[6].id, if: evidence.steps[6].if }, {
    id: "evidence-upload", if: "always() && steps.packet.outputs.ready == 'true'",
  });
  assert.equal(evidence.steps[7].if, "always() && steps.evidence-upload.outcome == 'success'");
  assert.equal(evidence.steps[8].if, "always() && steps.evidence-upload.outcome == 'success' && steps.collector.outcome != 'success'");
  assert.equal(evidence.steps[8].run, "exit 1");

  const uploadPaths = evidence.steps[6].with.path.trim().split("\n").map((entry) => entry.replace("build/production-evidence/", ""));
  assert.deepEqual(uploadPaths, PACKET_FILES);
  assert.equal(uploadPaths.includes(".validated"), false);
  assert.deepEqual({
    name: evidence.steps[6].with.name,
    missing: evidence.steps[6].with["if-no-files-found"],
    retention: evidence.steps[6].with["retention-days"],
  }, {
    name: "production-evidence-${{ github.sha }}-${{ github.run_attempt }}", missing: "error", retention: 90,
  });

  const allUses = Object.values(publish.jobs).flatMap((job) => job.steps).filter((step) => step.uses).map((step) => step.uses);
  assert(allUses.every((uses) => /@[0-9a-f]{40}$/u.test(uses)), "every Action is pinned to a full commit");
  const nonEligibility = JSON.stringify({ verify, deploy, evidence });
  assert.equal(nonEligibility.includes("GH_TOKEN"), false, "workflow authentication is confined to eligibility");
  assert.equal((publish.jobs.verify.steps.filter((step) => step.run === "npm run verify")).length, 1);
  assert.equal(JSON.stringify(evidence).includes("npm run build"), false);
  assert.equal(JSON.stringify(evidence).includes("npm run verify"), false);
});

test("eligibility executes fixed authenticated bounded retrieval for open, closed, 1 MiB, and every failure class", async (t) => {
  const { document } = (await parsedWorkflows())["publish.yml"];
  const source = inlineModule(jobSteps(document, "eligibility")[0]);
  const cases = [
    { name: "open", scenario: { kind: "state", state: "open" }, code: 0, output: "run-evidence=true\n", cancelled: false },
    { name: "closed", scenario: { kind: "state", state: "closed" }, code: 0, output: "run-evidence=false\n", cancelled: false },
    { name: "exact 1 MiB", scenario: { kind: "boundary" }, code: 0, output: "run-evidence=true\n", cancelled: false },
    { name: "+1 overflow", scenario: { kind: "overflow" }, code: 1, output: "", cancelled: true },
    { name: "final URL mismatch", scenario: { kind: "url-error" }, code: 1, output: "", cancelled: true },
    { name: "non-200 status", scenario: { kind: "status-error" }, code: 1, output: "", cancelled: true },
    { name: "parse failure", scenario: { kind: "parse-error" }, code: 1, output: "", cancelled: false },
    { name: "missing own state", scenario: { kind: "missing-state" }, code: 1, output: "", cancelled: false },
    { name: "invalid state", scenario: { kind: "state", state: "locked" }, code: 1, output: "", cancelled: false },
    { name: "query failure", scenario: { kind: "query-error" }, code: 1, output: "", cancelled: false, released: false },
  ];
  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "code-city-eligibility-"));
      const result = await runEligibility(source, directory, fixture.scenario);
      assert.equal(result.code, fixture.code, result.stderr);
      assert.equal(result.output, fixture.output);
      assert.equal(result.observer.url, "https://api.github.com/repos/FelixGeisler/code-city/issues/460");
      assert.deepEqual(result.observer.options, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: "Bearer controlled-token",
          "x-github-api-version": "2022-11-28",
        },
        credentials: "omit",
        referrer: "",
        referrerPolicy: "no-referrer",
        cache: "no-store",
        redirect: "error",
      });
      assert.equal(result.observer.responseUrl, fixture.scenario.kind === "query-error"
        ? undefined
        : fixture.scenario.kind === "url-error"
          ? "https://api.github.com/repos/FelixGeisler/code-city/issues/460/redirected"
          : "https://api.github.com/repos/FelixGeisler/code-city/issues/460");
      assert.equal(result.observer.responseStatus, fixture.scenario.kind === "query-error"
        ? undefined
        : fixture.scenario.kind === "status-error" ? 404 : 200);
      assert.equal(result.observer.cancelled, fixture.cancelled);
      assert.equal(result.observer.released, fixture.released ?? true);
    });
  }
});

test("pre-collector binding executes every current-run identity check before collection", async (t) => {
  const { document } = (await parsedWorkflows())["publish.yml"];
  const steps = jobSteps(document, "production-evidence");
  const bindingStep = steps.find((step) => step.name === "Verify workflow-owned publication bindings");
  const collectorStep = steps.find((step) => step.id === "collector");
  assert(steps.indexOf(bindingStep) < steps.indexOf(collectorStep));
  const source = inlineModule(bindingStep);

  async function executeFixture(name, mutate) {
    const directory = await mkdtemp(path.join(os.tmpdir(), `code-city-binding-${name}-`));
    const fixture = await prepareBindingFixture(directory);
    const env = {
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: fixture.head,
      GITHUB_REPOSITORY: fixture.input.repository,
      GITHUB_RUN_ID: String(fixture.input.runId),
      GITHUB_RUN_ATTEMPT: String(fixture.input.runAttempt),
    };
    try {
      await mutate?.(fixture, env);
      return await runModule(source, { cwd: directory, env });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  const valid = await executeFixture("valid");
  assert.equal(valid.code, 0, valid.stderr);

  const mismatches = [
    { name: "event", mutate: async (_fixture, env) => { env.GITHUB_EVENT_NAME = "pull_request"; } },
    { name: "ref", mutate: async (_fixture, env) => { env.GITHUB_REF = "refs/heads/release"; } },
    { name: "SHA", mutate: async (_fixture, env) => { env.GITHUB_SHA = "not-a-sha"; } },
    { name: "HEAD", mutate: async (fixture, env) => { env.GITHUB_SHA = fixture.head === "f".repeat(40) ? "e".repeat(40) : "f".repeat(40); } },
    { name: "record", mutate: async (fixture) => {
      const otherSha = fixture.head === "d".repeat(40) ? "c".repeat(40) : "d".repeat(40);
      await writeFile(fixture.recordPath, createPublicationRecord({ ...fixture.input, eventSha: otherSha }, fixture.manifestBytes));
    } },
    { name: "manifest", mutate: async (fixture) => { await writeFile(fixture.manifestPath, controlledManifestBytes("1".repeat(64))); } },
    { name: "repo", mutate: async (_fixture, env) => { env.GITHUB_REPOSITORY = "FelixGeisler/other"; } },
    { name: "run", mutate: async (_fixture, env) => { env.GITHUB_RUN_ID = "123457"; } },
    { name: "attempt", mutate: async (_fixture, env) => { env.GITHUB_RUN_ATTEMPT = "3"; } },
  ];
  for (const mismatch of mismatches) {
    await t.test(mismatch.name, async () => {
      const result = await executeFixture(mismatch.name.toLowerCase(), mismatch.mutate);
      assert.notEqual(result.code, 0, `${mismatch.name} mismatch unexpectedly reached collection`);
      assert.match(result.stderr, /publication binding mismatch|Package manifest|Publication record/u);
    });
  }
});

test("seal gate executes exact inventory and marker controls before the seven-file upload", async (t) => {
  const { document } = (await parsedWorkflows())["publish.yml"];
  const steps = jobSteps(document, "production-evidence");
  const source = inlineModule(steps.find((step) => step.id === "packet"));
  const digest = "a".repeat(64);

  await t.test("valid marker seals exact packet", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "code-city-packet-"));
    await preparePacket(directory, PACKET_FILES, `${digest}\n`);
    const output = path.join(directory, "output.txt");
    const summary = path.join(directory, "summary.txt");
    const result = await runModule(source, { cwd: directory, env: { GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary } });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await readFile(output, "utf8"), `ready=true\npacket-digest=${digest}\n`);
    assert.deepEqual((await readdir(path.join(directory, "build", "production-evidence"))).sort(), [".validated", ...PACKET_FILES].sort());
  });

  for (const fixture of [
    { name: "privacy or schema failure has no marker", marker: undefined, files: PACKET_FILES },
    { name: "invalid marker is rejected", marker: `${"g".repeat(64)}\n`, files: PACKET_FILES },
    { name: "extra output is rejected", marker: `${digest}\n`, files: [...PACKET_FILES, "private.json"] },
  ]) {
    await t.test(fixture.name, async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "code-city-packet-"));
      const outputDirectory = await preparePacket(directory, fixture.files, fixture.marker);
      const output = path.join(directory, "output.txt");
      const summary = path.join(directory, "summary.txt");
      const result = await runModule(source, { cwd: directory, env: { GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary } });
      assert.notEqual(result.code, 0);
      await assert.rejects(stat(outputDirectory));
      assert.equal(await readFile(output, "utf8").catch(() => ""), "");
      assert.match(await readFile(summary, "utf8"), /was not retained because validation did not complete safely/u);
      assert.equal(evaluateCondition(steps.find((step) => step.id === "evidence-upload").if, { ready: "" }), false);
    });
  }
});

test("workflow conditions execute the open/closed and every collector/upload outcome truth table", async () => {
  const { document } = (await parsedWorkflows())["publish.yml"];
  const job = document.jobs["production-evidence"];
  const packet = job.steps.find((step) => step.id === "packet");
  const upload = job.steps.find((step) => step.id === "evidence-upload");
  const metadata = job.steps.find((step) => step.name === "Record authenticated finalization metadata");
  const handled = job.steps.find((step) => step.name === "Preserve handled-failure status");
  const fixtures = [
    { name: "closed eligibility", values: { eligibility: "false" }, expected: [false, true, false, false, false] },
    { name: "collector pass", values: { eligibility: "true", ready: "true", upload: "success", collector: "success" }, expected: [true, true, true, true, false] },
    { name: "handled collector failure with valid marker", values: { eligibility: "true", ready: "true", upload: "success", collector: "failure" }, expected: [true, true, true, true, true] },
    { name: "privacy or schema failure without marker", values: { eligibility: "true", ready: "", upload: "", collector: "failure" }, expected: [true, true, false, false, false] },
    { name: "upload failure", values: { eligibility: "true", ready: "true", upload: "failure", collector: "success" }, expected: [true, true, true, false, false] },
  ];
  for (const fixture of fixtures) {
    assert.deepEqual([
      evaluateCondition(job.if, fixture.values),
      evaluateCondition(packet.if, fixture.values),
      evaluateCondition(upload.if, fixture.values),
      evaluateCondition(metadata.if, fixture.values),
      evaluateCondition(handled.if, fixture.values),
    ], fixture.expected, fixture.name);
  }
});

test("authenticated metadata inline step executes only bound source values", async () => {
  const { document } = (await parsedWorkflows())["publish.yml"];
  const step = jobSteps(document, "production-evidence").find((candidate) => candidate.name === "Record authenticated finalization metadata");
  const source = inlineModule(step);
  const directory = await mkdtemp(path.join(os.tmpdir(), "code-city-metadata-"));
  const summary = path.join(directory, "summary.txt");
  const env = {
    ARTIFACT_ID: "12345",
    ARTIFACT_URL: "https://github.com/FelixGeisler/code-city/actions/runs/67890/artifacts/12345",
    PLATFORM_DIGEST: "a".repeat(64),
    PACKET_DIGEST: "b".repeat(64),
    GITHUB_SHA: "c".repeat(40),
    GITHUB_RUN_ID: "67890",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_STEP_SUMMARY: summary,
  };
  const result = await runModule(source, { cwd: directory, env });
  assert.equal(result.code, 0, result.stderr);
  const expected = `${JSON.stringify({
    schemaVersion: 1,
    artifactId: "12345",
    artifactUrl: env.ARTIFACT_URL,
    platformDigest: env.PLATFORM_DIGEST,
    packetDigest: env.PACKET_DIGEST,
    eventSha: env.GITHUB_SHA,
    runId: 67890,
    runAttempt: 2,
    retentionDays: 90,
  })}\n`;
  assert.equal(result.stdout, expected);
  assert.match(await readFile(summary, "utf8"), new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));

  const invalid = await runModule(source, { cwd: directory, env: { ...env, PLATFORM_DIGEST: "invalid" } });
  assert.notEqual(invalid.code, 0);
});
