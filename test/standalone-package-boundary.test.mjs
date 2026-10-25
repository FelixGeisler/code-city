import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageManifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

test("root commands atomically activate the canonical standalone artifact", () => {
  assert.equal(packageManifest.scripts.dev, "node tools/develop-standalone.mjs");
  assert.equal(packageManifest.scripts.build, "node tools/build-standalone.mjs && node tools/build-retirement-notice.mjs");
  assert.equal(packageManifest.scripts.start, "node dist/server/standalone.mjs");
  assert.equal(packageManifest.scripts["test:reproducibility"], "node tools/check-standalone-reproducibility.mjs && node tools/audit-cutover.mjs");
  assert.equal(packageManifest.scripts["test:package"], "node tools/audit-standalone-package.mjs && node tools/check-standalone-signals.mjs && node tools/check-standalone-browser.mjs");
  assert.equal(packageManifest.scripts.verify, "npm run typecheck && npm run test && npm run build && npm run test:reproducibility && npm run test:package && npm run docs:build");
  assert.match(packageManifest.scripts.typecheck, /tsconfig\.main\.json[\s\S]*tsconfig\.worker\.json[\s\S]*tsconfig\.node\.json/u);
});

test("prepared standalone checks remain available without owning canonical root behavior", () => {
  assert.deepEqual(Object.fromEntries(Object.entries(packageManifest.scripts).filter(([name]) => name.startsWith("standalone:"))), {
    "standalone:build": "node tools/build-standalone.mjs",
    "standalone:audit": "node tools/audit-standalone.mjs",
    "standalone:reproducibility": "node tools/check-standalone-reproducibility.mjs",
    "standalone:start": "node tools/check-standalone-start.mjs",
    "standalone:package": "node tools/audit-standalone-package.mjs",
    "standalone:signals": "node tools/check-standalone-signals.mjs",
    "standalone:browser": "node tools/check-standalone-browser.mjs",
    "standalone:verify": "npm run standalone:build && npm run standalone:audit && npm run standalone:reproducibility && npm run standalone:start && npm run standalone:package && npm run standalone:signals && npm run standalone:browser",
  });
});
