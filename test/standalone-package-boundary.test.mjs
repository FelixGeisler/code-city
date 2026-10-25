import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageManifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const canonical = {
  dev: "vite",
  typecheck: "tsc -p tsconfig.main.json && tsc -p tsconfig.worker.json",
  test: "node --test",
  "test:manifest": "node --test test/package-manifest.test.mjs test/publication-record.test.mjs",
  "collect:production-evidence": "node tools/collect-production-evidence.mjs",
  build: "node tools/build-package.mjs",
  "test:reproducibility": "node tools/check-reproducibility.mjs",
  start: "node tools/serve-package.mjs",
  "test:package": "node tools/audit-package.mjs",
  "docs:build": "antora antora-playbook.yml",
  verify: "npm run typecheck && npm run test && npm run build && npm run test:reproducibility && npm run test:package && npm run docs:build",
  "typecheck:node": "tsc -p tsconfig.node.json",
};

test("legacy root commands remain byte-for-byte unchanged and standalone commands are additive", () => {
  for (const [name, command] of Object.entries(canonical)) assert.equal(packageManifest.scripts[name], command, name);
  assert.deepEqual(Object.fromEntries(Object.entries(packageManifest.scripts).filter(([name]) => name.startsWith("standalone:"))), {
    "standalone:build": "node tools/build-standalone.mjs",
    "standalone:audit": "node tools/audit-standalone.mjs",
    "standalone:reproducibility": "node tools/check-standalone-reproducibility.mjs",
    "standalone:start": "node tools/check-standalone-start.mjs",
    "standalone:package": "node tools/audit-standalone-package.mjs",
    "standalone:signals": "node tools/check-standalone-signals.mjs",
    "standalone:verify": "npm run standalone:build && npm run standalone:audit && npm run standalone:reproducibility && npm run standalone:start && npm run standalone:package && npm run standalone:signals",
  });
});
