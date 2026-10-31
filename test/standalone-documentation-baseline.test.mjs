import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const read = relative => readFile(path.join(root, relative), "utf8");
const compact = value => value.replace(/\s+/gu, " ");

test("accepted browser ownership decision and current custody policy supersede only the historical server-analysis boundary", async () => {
  const adr = await read("docs/modules/architecture/pages/adr/0015-browser-analysis-and-server-saved-investigations.adoc");
  const policy = compact(await read("docs/modules/requirements/pages/browser-analysis-operating-policy.adoc"));
  assert.match(adr, /^Status:: Accepted$/mu);
  assert.match(adr, /Human acceptance::/u);
  assert.match(adr, /Do not introduce login or accounts/u);
  assert.match(policy, /Unsaved source and results stay in browser memory/u);
  assert.match(policy, /idle tab holds no server analysis session/u);
  assert.match(policy, /no login, Save, reopen/u);
  for (const name of ["0013-ownership-of-source-acquisition-analysis-and-saved-investigations", "0014-standalone-server-owned-analysis-runtime"]) {
    const historical = await read(`docs/modules/architecture/pages/adr/${name}.adoc`);
    assert.match(historical, /^Status:: Accepted$/mu);
    const decisions = await read("docs/modules/architecture/pages/09-architecture-decisions.adoc");
    assert.ok(decisions.includes(name));
    assert.match(decisions, /ADR 0015 replaces the server-analysis portions/u);
  }
});

test("requirements describe real browser analysis, static hosting, progress, and the still-unimplemented Save boundary", async () => {
  const product = compact(await read("docs/modules/requirements/pages/index.adoc"));
  for (const expected of ["browser Web Worker", "asset", "version-1", "package-manifest.json", "public/parser/", "Only `--host` has a default", "`--port` is required", "HTTPS", "secure localhost", "real counts beginning at `0/N` or `0/T`", "bar remains indeterminate until the candidate total is known", "Multiple completed tabs do not reserve shared analysis capacity", "Shared immutable Save, inventory, and reopen remain unimplemented"])
    assert.ok(product.includes(expected), expected);
  assert.doesNotMatch(product, /all five capacit(?:y|ies) (?:flags )?are required|service owns revision selection/u);
});

test("requirements preserve per-file continuation and local inventory semantics without claiming deeper investigation features", async () => {
  const source = compact(await read("docs/modules/requirements/pages/source-and-metrics.adoc"));
  const city = compact(await read("docs/modules/requirements/pages/city-and-failures.adoc"));
  assert.match(source, /Browser-owned acquisition and analysis/u);
  assert.match(source, /dedicated worker[\s\S]*supported per-file continuation/u);
  for (const category of ["Source text is not supported", "Syntax could not be analyzed", "Metrics could not be computed"]) {
    assert.ok(source.includes(category)); assert.ok(city.includes(category));
  }
  assert.match(city, /browser-owned acquisition and analysis in a dedicated Web Worker/u);
  assert.match(city, /asset host owns no analysis session, source\/result dataset, or analysis capacity/u);
  assert.match(city, /shared canonical-index selection/u);
  assert.match(city, /Selection, filtering, and sorting do not invoke search reveal, move or focus the camera/u);
  assert.match(city, /active composition mounts no contextual district row and no persistent complexity legend/u);
  assert.match(city, /browser worker message boundary/u);
  assert.match(city, /inert `<bdi dir="auto">` nodes assigned through `textContent`/u);
  assert.match(city, /current milestone has no browser source view, unit or contribution detail, server persistence, Save\/reopen/u);
  assert.doesNotMatch(city, /current standalone M5 implementation has server-owned/u);
});

test("architecture documents the current worker/package/stop boundaries and does not revive removed diagrams", async () => {
  const names = ["02-architecture-constraints", "03-context-and-scope", "04-solution-strategy", "05-building-block-view", "06-runtime-view", "07-deployment-view", "08-crosscutting-concepts", "10-quality-requirements", "11-risks-and-technical-debt"];
  const pages = await Promise.all(names.map(n => read(`docs/modules/architecture/pages/${n}.adoc`).then(compact)));
  assert.match(pages[0], /version-1 `package-manifest.json`/u);
  assert.match(pages[0], /Legacy analysis routes are not mounted/u);
  assert.match(pages[4], /verifies the length and SHA-256 digest of every public record before listening/u);
  assert.match(pages[4], /offline package audit verifies complete public\/private manifest closure/u);
  assert.match(pages[4], /No browser worker-exit event is assumed/u);
  assert.match(pages[4], /4,000-file \/ 40 MiB/u);
  assert.match(pages[5], /uploads the exact audited `dist\/`/u);
  assert.match(pages[5], /No Pages upload or deployment action/u);
  assert.match(pages[5], /all eight URLs/u);
  assert.match(pages[7], /No Raspberry Pi performance, concurrency, memory, or deployment threshold/u);
  for (const diagram of ["building-blocks.svg", "context.svg", "deployment.svg", "runtime.svg"]) {
    await assert.rejects(stat(path.join(root, "docs/modules/architecture/assets/images", diagram)), { code: "ENOENT" });
    assert.equal(pages.join("\n").includes(diagram), false);
  }
});
