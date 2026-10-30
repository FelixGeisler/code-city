import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(/^\.\.?\//u.test(specifier) && !/(?:\.[a-z]+|\?.*)$/iu.test(specifier) ? `${specifier}.ts` : specifier, context);
  },
});

const {
  createInventoryState,
  projectAnalyzedFiles,
  stageStandaloneInventoryPublication,
} = await import("../src/edge/standalone-presentation-session.ts");
const { compareUnsignedUtf8 } = await import("../src/domain/source-admission.ts");

const facts = Object.freeze([
  Object.freeze({ canonicalPath: "src/Zeta.ts", S: 8, U: 1, M: 4 }),
  Object.freeze({ canonicalPath: "src/a space.ts", S: 8, U: 9, M: 0 }),
  Object.freeze({ canonicalPath: "src/é.ts", S: 8, U: 9, M: 4 }),
  Object.freeze({ canonicalPath: "src/é.ts", S: 3, U: 9, M: 16 }),
  Object.freeze({ canonicalPath: "src/literal[1].ts", S: 1, U: 2, M: 16 }),
]);

function paths(indices, source = facts) {
  return indices.map((index) => source[index].canonicalPath);
}

function expected(sort, query = "") {
  return facts
    .map((fact, index) => ({ fact, index }))
    .filter(({ fact }) => fact.canonicalPath.includes(query))
    .sort((left, right) => left.fact[sort] === right.fact[sort]
      ? compareUnsignedUtf8(left.fact.canonicalPath, right.fact.canonicalPath)
      : left.fact[sort] > right.fact[sort] ? -1 : 1)
    .map(({ index }) => index);
}

test("inventory projection keeps every eligible canonical index and applies literal query plus all raw metric orders", () => {
  for (const sort of ["S", "U", "M"]) {
    assert.deepEqual(projectAnalyzedFiles(facts, "", sort), expected(sort));
  }
  assert.deepEqual(paths(projectAnalyzedFiles(facts, " space", "S")), ["src/a space.ts"]);
  assert.deepEqual(projectAnalyzedFiles(facts, "SPACE", "S"), []);
  assert.deepEqual(paths(projectAnalyzedFiles(facts, "[1]", "M")), ["src/literal[1].ts"]);

  const large = Object.freeze(Array.from({ length: 4_000 }, (_, index) => Object.freeze({
    canonicalPath: `src/${String(index).padStart(4, "0")}.ts`,
    S: index % 7,
    U: index % 11,
    M: index % 17,
  })));
  const projected = projectAnalyzedFiles(large, "", "S");
  assert.equal(projected.length, 4_000);
  assert.equal(new Set(projected).size, 4_000);
  assert(projected.every((index) => Number.isSafeInteger(index) && index >= 0 && index < 4_000));
});

test("interaction state preserves canonical selection across filter/sort and makes stale snapshots inert", () => {
  const identity = Object.freeze({});
  const projections = [];
  const visuals = [];
  const selections = [];
  let failures = 0;
  const state = createInventoryState({
    inspection: facts,
    districtCount: 1,
    generation: 7,
    identity,
    publishProjection(value) { projections.push(value); },
    applyVisual(hover, selection) { visuals.push([hover, selection]); return { kind: "applied" }; },
    publishSelection(selection) { selections.push(selection); },
    failed() { failures += 1; },
  });

  state.rowActivated(6, identity, "", "S", 0);
  state.rowActivated(7, Object.freeze({}), "", "S", 0);
  state.rowActivated(7, identity, "stale", "S", 0);
  state.rowActivated(7, identity, "", "U", 0);
  assert.deepEqual(visuals, []);

  const selectedIndex = facts.findIndex(({ canonicalPath }) => canonicalPath === "src/é.ts");
  state.rowActivated(7, identity, "", "S", selectedIndex);
  assert.deepEqual(selections, [selectedIndex]);
  state.queryChanged(7, identity, "", "S", "literal");
  assert.equal(state.snapshot().selection, selectedIndex);
  assert.deepEqual(paths(state.snapshot().indices), ["src/literal[1].ts"]);
  state.sortChanged(7, identity, "literal", "S", "M");
  assert.equal(state.snapshot().selection, selectedIndex);
  state.queryChanged(7, identity, "literal", "M", "");
  assert.equal(state.snapshot().selection, selectedIndex);
  assert.deepEqual(state.snapshot().indices, expected("M"));

  state.cityHover(7, identity, 1);
  state.cityActivated(7, identity, 3);
  state.selectionAction(7, identity, "next");
  state.selectionAction(7, identity, "clear");
  assert.deepEqual(visuals.slice(-4), [[1, selectedIndex], [1, 3], [1, 4], [1, null]]);
  assert.equal(state.snapshot().hover, 1);
  assert.equal(state.snapshot().selection, null);
  assert.equal(failures, 0);
  assert(projections.every(({ indices }) => indices.every((index) => facts[index])));
});

test("a malformed otherwise-current callback or publication fault fails once and cleanup is idempotent", () => {
  const identity = Object.freeze({});
  let failures = 0;
  const malformed = createInventoryState({
    inspection: facts,
    districtCount: 1,
    generation: 1,
    identity,
    publishProjection() {},
    applyVisual() { return { kind: "applied" }; },
    publishSelection() {},
    failed() { failures += 1; },
  });
  malformed.rowActivated(1, identity, "", "S", 99);
  malformed.rowActivated(1, identity, "", "S", 0);
  malformed.dispose();
  malformed.dispose();
  assert.equal(failures, 1);

  let faultFailures = 0;
  const fault = createInventoryState({
    inspection: facts,
    districtCount: 1,
    generation: 2,
    identity,
    publishProjection() { throw new Error("deferred DOM fault"); },
    applyVisual() { return { kind: "applied" }; },
    publishSelection() {},
    failed() { faultFailures += 1; },
  });
  fault.queryChanged(2, identity, "", "S", "src");
  fault.queryChanged(2, identity, "", "S", "later");
  fault.dispose();
  assert.equal(faultFailures, 1);
});

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.dataset = {};
    this.attributes = new Map();
    this.children = [];
    this.hidden = false;
    this.value = "";
    this.ownText = "";
    this.listeners = new Map();
    this.type = "";
    this.autocomplete = "";
    this.spellcheck = true;
    this.tabIndex = -1;
    this.id = "";
    this.parent = undefined;
  }
  set textContent(value) { this.ownText = String(value); this.replaceChildren(); }
  get textContent() { return this.ownText + this.children.map((child) => child.textContent ?? "").join(""); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  addEventListener(type, listener) {
    const entries = this.listeners.get(type) ?? new Set();
    entries.add(listener);
    this.listeners.set(type, entries);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type) { for (const listener of [...(this.listeners.get(type) ?? [])]) listener(new Event(type)); }
  append(...children) {
    for (const child of children) {
      if (child instanceof FakeElement) child.parent = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children) {
    for (const child of this.children) if (child instanceof FakeElement) child.parent = undefined;
    this.children = children;
    for (const child of children) if (child instanceof FakeElement) child.parent = this;
  }
}

function descendants(element) {
  return element.children.flatMap((child) => child instanceof FakeElement ? [child, ...descendants(child)] : []);
}
function byDataset(nodes, key) {
  return nodes.flatMap((node) => node instanceof FakeElement ? [node, ...descendants(node)] : [])
    .find((node) => Object.hasOwn(node.dataset, key));
}

test("browser-edge publication uses native bounded semantics, safe bdi text, pressed state, and exact callback snapshots", () => {
  const created = [];
  const documentTarget = {
    createElement(tagName) { const element = new FakeElement(tagName); created.push(element); return element; },
  };
  const events = [];
  const sink = {
    districtActivated(...args) { events.push(["district", ...args]); },
    queryChanged(...args) { events.push(["query", ...args]); },
    sortChanged(...args) { events.push(["sort", ...args]); },
    rowActivated(...args) { events.push(["row", ...args]); },
  };
  const publication = stageStandaloneInventoryPublication(documentTarget, facts, 11, sink, [{ root: false, identity: "src" }]);
  const query = byDataset(publication.nodes, "analyzedQuery");
  const sort = byDataset(publication.nodes, "analyzedSort");
  const rows = byDataset(publication.nodes, "analyzedRows");
  const noMatches = byDataset(publication.nodes, "analyzedNoMatches");
  const panel = byDataset(publication.nodes, "analyzedPanel");

  const disclosure = byDataset(publication.nodes, "analyzed");
  assert.equal(disclosure.tagName, "DETAILS");
  assert.equal(disclosure.open, false);
  assert.equal(disclosure.children[0].tagName, "SUMMARY");
  assert.equal(disclosure.children[0].textContent, "Find file (5 files)");
  assert.equal(publication.nodes[0].dataset.cityTools, "");
  assert.equal(publication.nodes[1], publication.cityHost);
  assert.equal(publication.nodes.length, 2);
  assert.equal(query.tagName, "INPUT");
  assert.equal(query.type, "search");
  assert.equal(sort.tagName, "SELECT");
  assert.equal(sort.children.map((option) => option.textContent).join("|"), "Source lines (S)|Executable units (U)|Maximum complexity (M)");
  assert.equal(panel.tagName, "DIV");
  assert.equal(rows.tagName, "UL");
  assert.equal(rows.children.length, facts.length);
  assert(rows.children.every((item) => item.tagName === "LI" && item.children[0].tagName === "BUTTON"));
  assert(rows.children.every((item) => item.children[0].children[0].tagName === "BDI"
    && item.children[0].children[0].attributes.get("dir") === "auto"
    && item.children[0].children[0].attributes.size === 1));

  query.value = "no match";
  query.dispatch("input");
  assert.deepEqual(events.at(-1).slice(0, 2), ["query", 11]);
  assert.equal(events.at(-1)[4], "S");
  assert.equal(events.at(-1)[5], "no match");
  publication.setProjection({ query: "no match", sort: "S", indices: [] }, null);
  assert.equal(rows.children.length, 0);
  assert.equal(noMatches.textContent, "No matching analyzed files.");
  assert.equal(noMatches.hidden, false);

  query.value = "";
  query.dispatch("input");
  publication.setProjection({ query: "", sort: "S", indices: projectAnalyzedFiles(facts, "", "S") }, null);
  const firstButton = rows.children[0].children[0];
  firstButton.dispatch("click");
  assert.equal(events.at(-1)[0], "row");
  const selectedIndex = events.at(-1)[5];
  publication.setSelection(selectedIndex);
  assert.equal(firstButton.attributes.get("aria-pressed"), "true");
  assert(rows.children.slice(1).every((item) => item.children[0].attributes.get("aria-pressed") === "false"));
  const inspector = byDataset(publication.nodes, "inspector") ?? created.find((element) => Object.hasOwn(element.dataset, "inspector"));
  assert.equal(inspector.hidden, false);
  assert.equal(byDataset([inspector], "canonicalPath").textContent, facts[selectedIndex].canonicalPath);
  assert.equal(byDataset([inspector], "canonicalPath").children.length, 0);
  assert.equal(byDataset([inspector], "canonicalPath").parent.tagName, "H2");
  const districtButton = byDataset([inspector], "selectDistrict");
  districtButton.dispatch("click");
  assert.equal(events.at(-1)[0], "district");
  assert.equal(events.at(-1)[3], 0);
  publication.setDistrict(0);
  assert.equal(byDataset([inspector], "districtPath").textContent, "src");
  assert.equal(inspector.hidden, false);
  const afterDistrict = events.length;
  districtButton.dispatch("click");
  assert.equal(events.length, afterDistrict, "removed inspector callback remained active");

  const eventCount = events.length;
  publication.rollback();
  publication.rollback();
  query.value = "stale";
  query.dispatch("input");
  firstButton.dispatch("click");
  assert.equal(events.length, eventCount);
});

test("district selection survives hover/filter/sort, is exclusive with files, and rejects stale or invalid callbacks", () => {
  const identity = Object.freeze({}), visuals = [], publications = [];
  let failures = 0;
  const state = createInventoryState({ inspection: facts, districtCount: 1, generation: 4, identity,
    publishProjection() {}, applyVisual(...args) { visuals.push(args); return { kind: "applied" }; },
    publishSelection(...args) { publications.push(args); }, failed() { failures++; } });
  state.districtActivated(3, identity, 0);
  state.districtActivated(4, {}, 0);
  assert.equal(visuals.length, 0);
  state.districtActivated(4, identity, 0);
  assert.deepEqual(publications.at(-1), [null, 0]);
  state.cityHover(4, identity, 1);
  assert.deepEqual(visuals.at(-1), [1, null, 0]);
  assert.equal(publications.length, 1, "hover rebuilt unchanged district metrics");
  state.queryChanged(4, identity, "", "S", "literal");
  state.sortChanged(4, identity, "literal", "S", "M");
  assert.equal(state.snapshot().district, 0);
  state.rowActivated(4, identity, "literal", "M", 4);
  assert.deepEqual(publications.at(-1), [4, null]);
  state.districtActivated(4, identity, 0);
  state.selectionAction(4, identity, "clear");
  assert.deepEqual(publications.at(-1), [null, null]);
  state.districtActivated(4, identity, 1);
  state.districtActivated(4, identity, 0);
  assert.equal(failures, 1);
  state.dispose();
});

test("district summaries keep exact integer totals and distinguish repository root from a real _root folder", () => {
  const created = [];
  const documentTarget = { createElement(tag) { const node = new FakeElement(tag); created.push(node); return node; } };
  const values = [
    { canonicalPath: "src/a.ts", S: Number.MAX_SAFE_INTEGER, U: Number.MAX_SAFE_INTEGER, M: 2 },
    { canonicalPath: "src/b.ts", S: 1, U: 2, M: 7 },
    { canonicalPath: "root.ts", S: 3, U: 4, M: 1 },
    { canonicalPath: "_root/a.ts", S: 8, U: 9, M: 5 },
  ];
  const publication = stageStandaloneInventoryPublication(documentTarget, values, 1,
    { queryChanged() {}, sortChanged() {}, rowActivated() {}, districtActivated() {} },
    [{ root: false, identity: "src" }, { root: true, identity: "" }, { root: false, identity: "_root" }]);
  const inspector = created.find(node => Object.hasOwn(node.dataset, "inspector"));
  const metric = name => descendants(inspector).find(node => node.attributes.has(name)).textContent;
  publication.setDistrict(0);
  assert.equal(metric("data-file-count"), "2");
  assert.equal(metric("data-source-lines"), "9007199254740992");
  assert.equal(metric("data-executable-units"), "9007199254740993");
  assert.equal(metric("data-maximum-complexity"), "7");
  publication.setDistrict(1);
  assert.equal(byDataset([inspector], "districtPath").textContent, "/");
  assert.equal(metric("data-source-lines"), "3");
  publication.setDistrict(2);
  assert.equal(byDataset([inspector], "districtPath").textContent, "_root");
  assert.equal(metric("data-source-lines"), "8");
  publication.rollback();
  assert.equal(inspector.hidden, true);
});

test("standalone composition never calls camera reveal or programmatic canvas focus for selection", async () => {
  const source = await readFile(new URL("../src/edge/standalone-presentation-session.ts", import.meta.url), "utf8");
  const main = await readFile(new URL("../src/edge/standalone-browser-main.ts", import.meta.url), "utf8");
  assert.doesNotMatch(`${source}\n${main}`, /revealSelection|focusCanvas/u);
  assert.doesNotMatch(`${source}\n${main}`, /innerHTML|insertAdjacentHTML/u);
});
