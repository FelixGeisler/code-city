import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { load as loadYaml } from "js-yaml";

const WORKFLOW_DIRECTORY = ".github/workflows";
const VERIFY_COMMANDS = [
  "npm ci --ignore-scripts",
  "npm ls --all",
  "npm audit --audit-level=high",
  "npm run typecheck:node",
  "npm run verify",
];
const ACTIONS = {
  checkout: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  node: "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1",
  artifactUpload: "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9",
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
  assert.deepEqual(steps.slice(2, 2 + VERIFY_COMMANDS.length), VERIFY_COMMANDS.map((run) => ({ run })));
}

async function parsedWorkflows() {
  const files = (await readdir(WORKFLOW_DIRECTORY)).filter((name) => /\.ya?ml$/u.test(name)).sort();
  assert.deepEqual(files, ["ci.yml", "publish.yml"], "the repository must have exactly the accepted workflows");
  const entries = await Promise.all(files.map(async (name) => {
    const source = await readFile(path.join(WORKFLOW_DIRECTORY, name), "utf8");
    return [name, { source, document: loadYaml(source) }];
  }));
  return Object.fromEntries(entries);
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
  assert.equal(verify.steps.length, 2 + VERIFY_COMMANDS.length);
  verifyPrefix(verify.steps);
});

test("publish retains verification and manifest-bound standalone uploads only", async () => {
  const { source, document: publish } = (await parsedWorkflows())["publish.yml"];
  exactKeys(publish, ["name", "on", "permissions", "jobs"], "publish workflow");
  assert.equal(publish.name, "Publish");
  assert.deepEqual(publish.on, { push: { branches: ["main"] } });
  assert.deepEqual(publish.permissions, {});
  exactKeys(publish.jobs, ["verify"], "publish jobs");

  const verify = publish.jobs.verify;
  exactKeys(verify, ["runs-on", "timeout-minutes", "permissions", "steps"], "publish verify job");
  assert.deepEqual({ runner: verify["runs-on"], timeout: verify["timeout-minutes"], permissions: verify.permissions }, {
    runner: "ubuntu-latest", timeout: 20, permissions: { contents: "read" },
  });
  assert.equal(verify.steps.length, 5 + VERIFY_COMMANDS.length);
  verifyPrefix(verify.steps);

  const publicationIndex = 2 + VERIFY_COMMANDS.length;
  const publication = verify.steps[publicationIndex];
  exactKeys(publication, ["name", "run"], "publication record step");
  assert.equal(publication.name, "Create and validate the standalone publication record");
  assert.match(publication.run, /dist\/package-manifest\.json[\s\S]*createStandalonePublicationRecord[\s\S]*validateStandalonePublicationRecord/u);
  assert.match(publication.run, /eventSha: process\.env\.GITHUB_SHA[\s\S]*runId: Number\(process\.env\.GITHUB_RUN_ID\)[\s\S]*runAttempt: Number\(process\.env\.GITHUB_RUN_ATTEMPT\)/u);

  assert.deepEqual(verify.steps[publicationIndex + 1], {
    name: "Upload the audited standalone artifact",
    uses: ACTIONS.artifactUpload,
    with: {
      name: "code-city-standalone-${{ github.sha }}",
      path: "dist",
      "if-no-files-found": "error",
      "retention-days": 90,
    },
  });
  assert.deepEqual(verify.steps[publicationIndex + 2], {
    name: "Upload internal publication evidence",
    uses: ACTIONS.artifactUpload,
    with: {
      name: "code-city-publication-evidence",
      path: "build/evidence/package-manifest.json\nbuild/evidence/publication-record.json\n",
      "if-no-files-found": "error",
      "retention-days": 90,
    },
  });

  const uses = verify.steps.filter((step) => step.uses).map((step) => step.uses);
  assert(uses.every((value) => /@[0-9a-f]{40}$/u.test(value)), "every Action is pinned to a full commit");
  assert.equal(verify.steps.filter((step) => step.run === "npm run verify").length, 1);
  assert.doesNotMatch(source, /upload-pages-artifact|deploy-pages|configure-pages|github-pages|pages:\s*write|id-token:\s*write|environment:|eligibility|production-evidence|collect-production-evidence/iu);
  assert.doesNotMatch(source, /issues:\s*(?:read|write)|GH_TOKEN|github\.token/iu);
});
