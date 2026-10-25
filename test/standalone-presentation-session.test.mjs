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
    queryChanged(...args) { events.push(["query", ...args]); },
    sortChanged(...args) { events.push(["sort", ...args]); },
    rowActivated(...args) { events.push(["row", ...args]); },
  };
  const publication = stageStandaloneInventoryPublication(documentTarget, facts, 11, sink);
  const query = byDataset(publication.nodes, "analyzedQuery");
  const sort = byDataset(publication.nodes, "analyzedSort");
  const rows = byDataset(publication.nodes, "analyzedRows");
  const noMatches = byDataset(publication.nodes, "analyzedNoMatches");
  const panel = byDataset(publication.nodes, "analyzedPanel");

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

  const eventCount = events.length;
  publication.rollback();
  publication.rollback();
  query.value = "stale";
  query.dispatch("input");
  firstButton.dispatch("click");
  assert.equal(events.length, eventCount);
});

test("standalone composition never calls camera reveal or programmatic canvas focus for selection", async () => {
  const source = await readFile(new URL("../src/edge/standalone-presentation-session.ts", import.meta.url), "utf8");
  const main = await readFile(new URL("../src/edge/standalone-browser-main.ts", import.meta.url), "utf8");
  assert.doesNotMatch(`${source}\n${main}`, /revealSelection|focusCanvas/u);
  assert.doesNotMatch(`${source}\n${main}`, /innerHTML|insertAdjacentHTML/u);
});
