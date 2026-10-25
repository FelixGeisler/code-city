import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
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

test("current-state requirements and architecture distinguish implemented M5 from later whole-core outcomes", async () => {
  const [source, city, risks] = await Promise.all([
    read("docs/modules/requirements/pages/source-and-metrics.adoc"),
    read("docs/modules/requirements/pages/city-and-failures.adoc"),
    read("docs/modules/architecture/pages/11-risks-and-technical-debt.adoc"),
  ]).then((values) => values.map(compact));

  assert.match(source, /Standalone M5 implements server-owned source acquisition and analysis[\s\S]*supported per-file continuation[\s\S]*temporary source-result association/u);
  assert.match(city, /current standalone M5 implementation has server-owned acquisition and analysis in a dedicated Node\.js worker/u);
  assert.match(city, /successful current result retains its exact analyzed-source association in process memory[\s\S]*browser receives only the source-free city and sanitized failed-file rows/u);
  assert.match(risks, /Standalone M5 has completed the move to server-owned acquisition and analysis[\s\S]*per-file continuation/u);
  for (const category of [
    "Source text is not supported",
    "Syntax could not be analyzed",
    "Metrics could not be computed",
  ]) {
    assert(source.includes(category), category);
    assert(city.includes(category), category);
  }

  const currentStateDocumentation = [source, city, risks].join("\n");
  for (const staleClaim of [
    /Current browser acquisition and whole-attempt parser behavior remain transitional/iu,
    /without implying that server acquisition[\s\S]{0,120}exists/iu,
    /Browser and anonymous-provider coupling/iu,
    /Whole-attempt file failure/iu,
    /move from browser-owned acquisition and analysis to server authority/iu,
    /without claiming that a server is implemented or deployed/iu,
    /At `9bcf7c8`[\s\S]{0,200}per-file failure continuation/iu,
  ]) assert.doesNotMatch(currentStateDocumentation, staleClaim);
});

test("obsolete browser-only architecture diagrams remain removed", async () => {
  const obsoleteDiagrams = [
    "building-blocks.svg",
    "context.svg",
    "deployment.svg",
    "runtime.svg",
  ];
  for (const diagram of obsoleteDiagrams) {
    const diagramPath = path.join(root, "docs/modules/architecture/assets/images", diagram);
    await assert.rejects(stat(diagramPath), { code: "ENOENT" }, diagram);
  }

  const architecturePages = await Promise.all([
    "03-context-and-scope.adoc",
    "05-building-block-view.adoc",
    "06-runtime-view.adoc",
    "07-deployment-view.adoc",
  ].map((page) => read(`docs/modules/architecture/pages/${page}`)));
  for (const diagram of obsoleteDiagrams) {
    assert.doesNotMatch(architecturePages.join("\n"), new RegExp(diagram.replace(".", "\\."), "u"));
  }
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
