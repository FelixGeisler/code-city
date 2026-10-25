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
  assert.match(city, /now exposes every successful fact[\s\S]*searchable and three-way sortable inventory[\s\S]*shared canonical-index selection[\s\S]*do not invoke search reveal, move or focus the camera/u);
  assert.match(risks, /Standalone M5 has completed the move to server-owned acquisition and analysis[\s\S]*per-file continuation/u);
  assert.match(risks, /now has the complete successful-file inventory and selection without camera movement/u);
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
    /sortable successful-file inventory, or target camera policy/iu,
    /Path-search activation selects and moves the camera/iu,
  ]) assert.doesNotMatch(currentStateDocumentation, staleClaim);
});

test("active standalone inventory documentation excludes non-mounted legacy semantics", async () => {
  const city = compact(await read("docs/modules/requirements/pages/city-and-failures.adoc"));

  assert.match(city, /active standalone publishes the successful-file inventory, shared selection, canvas, Reset control, and raw file-metric inspector/iu);
  assert.match(city, /active composition mounts no contextual district row and no persistent complexity legend/iu);
  assert.match(city, /Selection, filtering, and sorting do not invoke search reveal, move or focus the camera/iu);
  assert.match(city, /retained legacy semantic row, legend, and search-reveal capabilities are historical implementation references, not current standalone behavior/iu);
  assert.match(city, /Camera action[\s\S]*active coordinator's no-op projection callback[\s\S]*no contextual row is published/iu);
  assert.match(city, /Resize[\s\S]*retain target\/orientation\/magnification[\s\S]*no-op projection callback has no DOM effect/iu);

  for (const staleCurrentClaim of [
    /Every committed city reserves one `20px` normal-flow contextual row/iu,
    /Every committed city has one persistent, noninteractive legend/iu,
    /accepted camera action, wheel, resize, Reset, and search reveal invalidate/iu,
    /search-triggered camera reveal, and the current absence of source viewing are not the approved whole-core target/iu,
  ]) assert.doesNotMatch(city, staleCurrentClaim);
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

test("architecture describes canonical package, standalone publication, completed retirement cleanup, and pending qualification", async () => {
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
  assert.match(runtime, /Successful and all-files-failed results retain their exact normalized source association in process memory[\s\S]*syntax or metric failure[\s\S]*Source text rejected as unsupported is not retained[\s\S]*until Discard, replacement, detected session loss, or graceful shutdown/u);
  assert.doesNotMatch(runtime, /all-files-failed result retains only the accepted current failure association/iu);
  assert.match(runtime, /first complete NDJSON frame makes `res\.write` return false[\s\S]*retains that blocked frame and waits for `drain`[\s\S]*blocked write alone does not cause session loss[\s\S]*session, any retained source, and their admission capacity remain owned[\s\S]*Another event or a mutating command while the frame is blocked initiates joined session loss without another write/u);
  assert.match(runtime, /`npm run dev -- <flags>`[\s\S]*`build\/development\/`[\s\S]*no HMR or WebSocket/u);
  assert.match(deployment, /uploads the exact audited `dist\/`[\s\S]*manifest plus publication record as internal identity evidence/u);
  assert.match(deployment, /No Pages upload or deployment action[\s\S]*hosted analyzer observation job remains/u);
  assert.match(deployment, /retirement-live-verification-v1\.json[\s\S]*all eight URLs/u);
  assert.match(deployment, /last script-free notice may remain reachable[\s\S]*no claim that the GitHub Pages repository setting was disabled/u);
  assert.match(quality, /No Raspberry Pi performance, concurrency, memory, or deployment threshold is claimed/u);
});
