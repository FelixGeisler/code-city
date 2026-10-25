import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const read = (relative) => readFile(path.join(root, ...relative.split("/")), "utf8");
const compact = (value) => value.replace(/\s+/gu, " ");

test("accepted ADR and operating policy remain authoritative", async () => {
  const [adr, policy] = await Promise.all([
    read("docs/modules/architecture/pages/adr/0014-standalone-server-owned-analysis-runtime.adoc"),
    read("docs/modules/requirements/pages/standalone-m5-operating-policy.adoc"),
  ]);
  assert.match(adr, /^Status:: Accepted$/m);
  assert.match(policy, /^Status:: Accepted$/m);
  assert.match(compact(policy), /process memory[\s\S]*loopback[\s\S]*trusted-LAN[\s\S]*No Save/iu);
});

test("requirements describe the active standalone cutover without deployment defaults", async () => {
  const product = compact(await read("docs/modules/requirements/pages/index.adoc"));
  for (const expected of [
    "canonical built artifact is `dist/`",
    "`public/`",
    "`server/`",
    "`parser/`",
    "Only `--host` has a default",
    "`--max-live-sessions`",
    "`--max-active-attempts`",
    "`--max-command-body-readers`",
    "`--max-command-body-bytes`",
    "`--max-retained-source-bytes`",
    "Raspberry Pi",
  ]) assert(product.includes(expected), expected);
  assert.match(product, /No capacity value is a product default or deployment recommendation/u);
  assert.match(product, /no automatic retry, reconnect, recovery, source view, Save, reopen/iu);
});

test("architecture describes canonical package, publication separation, and pending qualification", async () => {
  const [constraints, runtime, deployment, quality] = await Promise.all([
    read("docs/modules/architecture/pages/02-architecture-constraints.adoc"),
    read("docs/modules/architecture/pages/06-runtime-view.adoc"),
    read("docs/modules/architecture/pages/07-deployment-view.adoc"),
    read("docs/modules/architecture/pages/10-quality-requirements.adoc"),
  ]).then((values) => values.map(compact));
  assert.match(constraints, /canonical `dist\/` artifact[\s\S]*version-1 `package-manifest\.json`/u);
  assert.match(constraints, /no GitHub provider[\s\S]*browser analysis worker[\s\S]*fallback analysis path/u);
  assert.match(runtime, /validates the exact version-1 package manifest[\s\S]*verifies the length and SHA-256 digest of every public record before listening/u);
  assert.match(runtime, /Startup does not read or hash private server or parser records;[\s\S]*offline package audit verifies complete public\/private manifest closure and every recorded byte before publication/u);
  assert.doesNotMatch(runtime, /runtime validates[\s\S]{0,120}every recorded file/iu);
  assert.match(runtime, /`npm run dev -- <flags>`[\s\S]*`build\/development\/`[\s\S]*no HMR or WebSocket/u);
  assert.match(deployment, /uploads the exact audited `dist\/`[\s\S]*separately uploads `build\/pages\/`/u);
  assert.match(deployment, /former in-browser analyzer JavaScript, browser-worker, and parser\/grammar WASM URLs/u);
  assert.match(quality, /No Raspberry Pi performance, concurrency, memory, or deployment threshold is claimed/u);
});
