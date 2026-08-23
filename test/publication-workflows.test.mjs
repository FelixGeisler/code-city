import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const FULL_ACTION = /uses:\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([0-9a-f]{40})$/gmu;
const VERIFY_COMMANDS = ["npm ci --ignore-scripts", "npm ls --all", "npm audit --audit-level=high", "npm run verify"];

async function workflows() {
  return {
    ci: (await readFile(".github/workflows/ci.yml", "utf8")).replaceAll("\r\n", "\n"),
    publish: (await readFile(".github/workflows/publish.yml", "utf8")).replaceAll("\r\n", "\n"),
  };
}

function section(source, start, end) {
  const from = source.indexOf(start);
  assert(from >= 0, `missing ${start}`);
  const to = end ? source.indexOf(end, from + start.length) : source.length;
  assert(to > from, `missing ${end}`);
  return source.slice(from, to);
}

function assertOrdered(source, values) {
  let prior = -1;
  for (const value of values) {
    const current = source.indexOf(value);
    assert(current > prior, `${value} is absent or reordered`);
    prior = current;
  }
}

function actionPins(source) {
  return [...source.matchAll(FULL_ACTION)].map((match) => ({ action: match[1], sha: match[2] }));
}

test("CI is one pull-request-only least-privilege verify check with no inapplicable jobs", async () => {
  const { ci } = await workflows();
  assert.match(ci, /^on:\n  pull_request:\n\npermissions: \{\}$/mu);
  assert.doesNotMatch(ci, /\bpush:|workflow_dispatch|paths(?:-ignore)?:/u);
  assert.equal((ci.match(/^  [a-z][a-z-]+:\n    runs-on:/gmu) ?? []).length, 1);
  assert.match(ci, /^  verify:\n    runs-on: ubuntu-latest\n    timeout-minutes: 20\n    permissions:\n      contents: read$/mu);
  assert.doesNotMatch(ci, /\bif:|upload-|deploy-|configure-pages|environment:/u);
  assertOrdered(ci, [
    "actions/checkout@", "ref: ${{ github.sha }}", "persist-credentials: false",
    "actions/setup-node@", "node-version: 24", "cache: npm", ...VERIFY_COMMANDS,
  ]);
  assert.equal(actionPins(ci).length, 2);
});

test("publish is the only protected-main push workflow and repeats the exact sole verification build", async () => {
  const { ci, publish } = await workflows();
  assert.match(publish, /^on:\n  push:\n    branches: \[main\]\n\npermissions: \{\}$/mu);
  assert.doesNotMatch(publish, /pull_request|workflow_dispatch|paths(?:-ignore)?:/u);
  assert.doesNotMatch(ci, /\bpush:/u);
  const verify = section(publish, "  verify:\n", "\n  deploy:\n");
  assert.match(verify, /timeout-minutes: 20\n    permissions:\n      contents: read/u);
  assertOrdered(verify, [
    "actions/checkout@", "ref: ${{ github.sha }}", "persist-credentials: false",
    "actions/setup-node@", "node-version: 24", "cache: npm", ...VERIFY_COMMANDS,
    "Create and validate the publication record", "Upload the Pages artifact", "Upload internal publication evidence",
  ]);
  for (const command of VERIFY_COMMANDS) assert.equal((ci.match(new RegExp(command.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "gu")) ?? []).length, 1);
  assert.equal((publish.match(/npm run verify/gu) ?? []).length, 1);
  assert.equal((publish.match(/npm run build/gu) ?? []).length, 0);
  assert.equal((publish.match(/npm ci --ignore-scripts/gu) ?? []).length, 1);
  assert.match(verify, /createPublicationRecord/u);
  assert.match(verify, /build\/evidence\/package-manifest\.json[\s\S]*build\/evidence\/publication-record\.json/u);
  assert.match(verify, /name: code-city-publication-evidence/u);
});

test("every Action is immutable and verification checkout/setup sequences are identical", async () => {
  const { ci, publish } = await workflows();
  for (const source of [ci, publish]) {
    const pins = actionPins(source);
    assert(pins.length > 0);
    assert.equal((source.match(/^\s*(?:- )?uses:/gmu) ?? []).length, pins.length);
  }
  const ciVerify = section(ci, "  verify:\n", undefined);
  const publishVerify = section(publish, "  verify:\n", "\n  deploy:\n");
  const projection = (source) => [
    source.match(/actions\/checkout@[0-9a-f]{40}/u)?.[0],
    source.match(/ref: \$\{\{ github\.sha \}\}/u)?.[0],
    source.match(/persist-credentials: false/u)?.[0],
    source.match(/actions\/setup-node@[0-9a-f]{40}/u)?.[0],
    source.match(/node-version: 24/u)?.[0],
    source.match(/cache: npm/u)?.[0],
    ...VERIFY_COMMANDS.map((command) => source.match(new RegExp(command.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"))?.[0]),
  ];
  assert.deepEqual(projection(publishVerify), projection(ciVerify));
});

test("deployment consumes the built Pages artifact without checkout, configuration, or rebuild", async () => {
  const { publish } = await workflows();
  const deploy = section(publish, "  deploy:\n", "\n  eligibility:\n");
  assert.match(deploy, /needs: verify/u);
  assert.match(deploy, /permissions:\n      pages: write\n      id-token: write/u);
  assert.match(deploy, /environment:\n      name: github-pages/u);
  assert.match(deploy, /actions\/deploy-pages@[0-9a-f]{40}/u);
  assert.doesNotMatch(deploy, /checkout|setup-node|npm |configure-pages|upload-/u);
  assert.doesNotMatch(publish, /configure-pages/u);
});

test("eligibility has the exact open/closed parent gate and no evidence path on closed or query failure", async () => {
  const { publish } = await workflows();
  const eligibility = section(publish, "  eligibility:\n", "\n  production-evidence:\n");
  assert.match(eligibility, /needs: deploy/u);
  assert.match(eligibility, /permissions:\n      issues: read/u);
  assert.match(eligibility, /repos\/FelixGeisler\/code-city\/issues\/460/u);
  assert.match(eligibility, /open\) echo "run-evidence=true"/u);
  assert.match(eligibility, /closed\) echo "run-evidence=false"/u);
  assert.match(eligibility, /\*\) exit 1/u);
  const evidence = section(publish, "  production-evidence:\n", undefined);
  assert.match(evidence, /if: needs\.eligibility\.outputs\.run-evidence == 'true'/u);
});

test("production evidence is same-run bound before a tokenless uninstrumented collector invocation", async () => {
  const { publish } = await workflows();
  const evidence = section(publish, "  production-evidence:\n", undefined);
  assert.match(evidence, /needs: \[verify, deploy, eligibility\]/u);
  assert.match(evidence, /permissions:\n      contents: read/u);
  assert.match(evidence, /ref: \$\{\{ github\.sha \}\}[\s\S]*persist-credentials: false/u);
  assert.match(evidence, /actions\/download-artifact@[0-9a-f]{40}[\s\S]*name: code-city-publication-evidence/u);
  assertOrdered(evidence, ["Download current-run publication evidence", "Verify workflow-owned publication bindings", "Collect tokenless production evidence"]);
  for (const binding of [
    'GITHUB_EVENT_NAME !== "push"', 'GITHUB_REF !== "refs/heads/main"', 'rev-parse", "HEAD"',
    "parsePackageManifest", "validatePublicationRecord", "record.repository", "record.eventName", "record.eventSha",
    "record.runId", "record.runAttempt", "record.manifestSha256",
  ]) assert(evidence.includes(binding), binding);
  assert.match(evidence, /env -i HOME="\$HOME" PATH="\$PATH" RUNNER_OS="\$RUNNER_OS" RUNNER_ARCH="\$RUNNER_ARCH"/u);
  assert.match(evidence, /--origin https:\/\/felixgeisler\.github\.io\/code-city\/[\s\S]*--manifest build\/publication\/package-manifest\.json/u);
  assert.doesNotMatch(evidence, /GITHUB_TOKEN|GH_TOKEN|secrets\.|\/deployments\?|collectorCommit/u);
  assert.equal((evidence.match(/npm run (?:build|verify)/gu) ?? []).length, 0);
});

test("the marker gate uploads exactly seven files once, retains them for 90 days, and preserves handled failure", async () => {
  const { publish } = await workflows();
  const evidence = section(publish, "  production-evidence:\n", undefined);
  assert.match(evidence, /continue-on-error: true/u);
  assert.match(evidence, /const expected = \["\.validated", "artifact\.json", "capacity\.json", "index\.json", "lifecycle\.json", "qualification\.json", "requests\.json", "smoke\.json"\]/u);
  assert.match(evidence, /if \(!\/\^\[0-9a-f\]\{64\}\\n\$\/u\.test\(marker\)\)/u);
  assert.match(evidence, /rm\(output, \{ recursive: true, force: true \}\)/u);
  assert.match(evidence, /name: production-evidence-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_attempt \}\}/u);
  const upload = section(evidence, "    - name: Upload the sealed production packet\n", "    - name: Record authenticated finalization metadata\n");
  for (const name of ["artifact", "smoke", "qualification", "capacity", "requests", "lifecycle", "index"]) {
    assert.equal((upload.match(new RegExp(`build/production-evidence/${name}\\.json`, "gu")) ?? []).length, 1);
  }
  assert.doesNotMatch(upload, /\.validated/u);
  assert.match(upload, /retention-days: 90/u);
  assert.match(evidence, /steps\.collector\.outcome != 'success'[\s\S]*run: exit 1/u);
  assert.equal((evidence.match(/name: production-evidence-/gu) ?? []).length, 1);
});

test("authenticated summary exposes the platform digest and exact finalizer source bindings", async () => {
  const { publish } = await workflows();
  const evidence = section(publish, "  production-evidence:\n", undefined);
  assert.match(evidence, /PLATFORM_DIGEST: \$\{\{ steps\.evidence-upload\.outputs\.artifact-digest \}\}/u);
  assert.match(evidence, /PACKET_DIGEST: \$\{\{ steps\.packet\.outputs\.packet-digest \}\}/u);
  assertOrdered(evidence, [
    "schemaVersion: 1", "artifactId:", "artifactUrl:", "platformDigest:", "packetDigest:",
    "eventSha:", "runId:", "runAttempt:", "retentionDays: 90",
  ]);
  assert.match(evidence, /process\.stdout\.write\(canonical\)/u);
  assert.match(evidence, /GITHUB_STEP_SUMMARY/u);
});
