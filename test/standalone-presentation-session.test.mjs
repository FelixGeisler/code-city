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
  highestComplexityFile,
  projectAnalyzedFiles,
  stageStandaloneInventoryPublication,
} = await import("../src/edge/standalone-presentation-session.ts");
const { compareUnsignedUtf8 } = await import("../src/domain/source-admission.ts");
const { createDistrictInspectionIndex, immediateDirectory } = await import("../src/edge/district-inspection-view.ts");

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
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  click() { this.dispatch("click"); }
  getClientRects() { return []; }
  addEventListener(type, listener) {
    const entries = this.listeners.get(type) ?? new Set();
    entries.add(listener);
    this.listeners.set(type, entries);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type) { for (const listener of [...(this.listeners.get(type) ?? [])]) listener(new Event(type)); }
  contains(node) { return node === this || this.children.some(child => child instanceof FakeElement && child.contains(node)); }
  focus(options) { if (this.documentTarget) this.documentTarget.activeElement = this; this.focusOptions = options; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatch("close"); }
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
    hierarchyFileActivated(...args) { events.push(["hierarchy-file", ...args]); },
    districtActivated(...args) { events.push(["district", ...args]); },
    queryChanged(...args) { events.push(["query", ...args]); },
    sortChanged(...args) { events.push(["sort", ...args]); },
    rowActivated(...args) { events.push(["row", ...args]); },
  };
  const publication = stageStandaloneInventoryPublication(documentTarget, facts, 11, sink, [{ root: true, identity: "_root" }, { root: false, identity: "src" }]);
  const query = byDataset(publication.nodes, "analyzedQuery");
  const sort = byDataset(publication.nodes, "analyzedSort");
  const rows = byDataset(publication.nodes, "analyzedRows");
  const noMatches = byDataset(publication.nodes, "analyzedNoMatches");
  const panel = byDataset(publication.nodes, "analyzedPanel");

  const disclosure = byDataset(publication.nodes, "analyzed");
  assert.equal(disclosure.tagName, "SECTION");
  assert.equal(disclosure.hidden, false);
  assert.equal(disclosure.children[0].tagName, "H2");
  assert.equal(disclosure.children[0].textContent, "5 files");
  assert.equal(publication.nodes[0].dataset.workspaceNavigation, "");
  assert.equal(publication.nodes[1].dataset.cityWorkspace, "");
  assert.equal(publication.nodes[2].dataset.selectionDetails, "");
  assert.equal(publication.nodes.length, 3);
  assert.equal(publication.nodes[0].hidden, true);
  assert.equal(publication.nodes[2].hidden, true);
  byDataset(publication.nodes, "navigationToggle").click();
  assert.equal(publication.nodes[0].hidden, false);
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
  assert.equal(events.at(-1)[3], 1);
  publication.setDistrict(1);
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
    { queryChanged() {}, sortChanged() {}, rowActivated() {}, districtActivated() {}, hierarchyFileActivated() {} },
    [{ root: true, identity: "_root" }, { root: false, identity: "_root" }, { root: false, identity: "src" }]);
  const inspector = created.find(node => Object.hasOwn(node.dataset, "inspector"));
  const metric = name => descendants(inspector).find(node => node.attributes.has(name)).textContent;
  publication.setDistrict(2);
  assert.equal(metric("data-file-count"), "2");
  assert.equal(metric("data-source-lines"), "9007199254740992");
  assert.equal(metric("data-executable-units"), "9007199254740993");
  assert.equal(metric("data-maximum-complexity"), "7");
  publication.setDistrict(0);
  assert.equal(byDataset([inspector], "districtPath").textContent, "/");
  assert.equal(metric("data-file-count"), "4");
  assert.equal(metric("data-source-lines"), "9007199254741003");
  assert.equal(metric("data-executable-units"), "9007199254741006");
  publication.setDistrict(1);
  assert.equal(byDataset([inspector], "districtPath").textContent, "_root");
  assert.equal(metric("data-source-lines"), "8");
  publication.rollback();
  assert.equal(inspector.hidden, true);
});

function hierarchyDescriptors(values) {
  const paths = new Set();
  for (const fact of values) {
    let path = immediateDirectory(fact.canonicalPath);
    while (path !== null) { paths.add(path); path = immediateDirectory(path); }
  }
  return [{ root: true, identity: "_root" }, ...[...paths].sort(compareUnsignedUtf8).map(identity => ({ root: false, identity }))];
}

function hierarchyPublication(values, inspect, applyVisual = () => ({kind:'applied'})) {
  const created = [], visuals = [];
  const documentTarget = { activeElement: null, createElement(tag) { const node = new FakeElement(tag); node.documentTarget = this; created.push(node); return node; } };
  const districts = hierarchyDescriptors(values);
  let state;
  const sink = Object.fromEntries(["selectionAction", "queryChanged", "sortChanged", "rowActivated", "districtActivated", "hierarchyFileActivated"]
    .map(method => [method, (...args) => state[method](...args)]));
  const publication = stageStandaloneInventoryPublication(documentTarget, values, 13, sink, districts, inspect);
  state = createInventoryState({ inspection: values, districtCount: districts.length, generation: 13, identity: publication.identity,
    publishProjection(projection) { publication.setProjection(projection, state.snapshot().selection); },
    applyVisual(...args) { visuals.push(args); return applyVisual(...args); },
    publishSelection(file, district) { district === null ? publication.setSelection(file) : publication.setDistrict(district); },
    cancelInspectionIntent() { publication.cancelInspectionIntent(); },
    failed() { assert.fail("Hierarchy interaction failed closed"); } });
  const inspector = created.find(node => Object.hasOwn(node.dataset, "inspector"));
  const select = path => state.districtActivated(13, publication.identity,
    path === "/" ? 0 : districts.findIndex(district => !district.root && district.identity === path));
  const navigation = byDataset(publication.nodes, "directoryPanel");
  return { publication, state, inspector, navigation, districts, visuals, select, documentTarget };
}

function directoryRows(navigation, kind) {
  return descendants(navigation).find(node => node.dataset.districtRows === kind);
}
function rowPaths(rows) { return rows.children.map(item => item.children[0].children[0].textContent); }
function paging(inspector, kind) { return descendants(inspector).find(node => node.dataset.districtPaging === kind); }

 test("hierarchy uses exact descendant membership, native root/parent/breadcrumb controls and query-independent shared file selection", () => {
  const values = [
    { canonicalPath: "direct.ts", S: 2, U: 3, M: 1 },
    { canonicalPath: "a/direct.ts", S: 5, U: 4, M: 3 },
    { canonicalPath: "a/deep/nested/<b>é.ts", S: 7, U: 2, M: 9 },
    { canonicalPath: "ab/no.ts", S: 100, U: 100, M: 100 },
    { canonicalPath: "_root/real.ts", S: 11, U: 1, M: 2 },
  ];
  const { publication, state, inspector, navigation, select, visuals } = hierarchyPublication(values);
  const browse = byDataset(publication.nodes, "browseDirectories");
  assert.equal(browse.tagName, "BUTTON");
  assert.equal(browse.type, "button");
  assert.equal(browse.textContent, "Directories");
  byDataset(publication.nodes, "navigationToggle").click();
  browse.dispatch("click");
  assert.equal(state.snapshot().district, null, "opening lookup must not select");
  assert.deepEqual(rowPaths(directoryRows(navigation, "directories")), ["ab", "a", "_root"]);
  assert.equal(directoryRows(navigation, "files").children.length, 5);
  const rootNavigation = byDataset([navigation], "districtNavigation");
  assert.equal(rootNavigation.children[0].disabled, true);
  assert.equal(rootNavigation.children[1].disabled, true);
  select("a");
  assert.deepEqual(rowPaths(directoryRows(navigation, "directories")), ["a/deep"]);
  assert.deepEqual(rowPaths(directoryRows(navigation, "files")), ["a/deep/nested/<b>é.ts", "a/direct.ts"]);
  const metric = name => descendants(inspector).find(node => node.attributes.has(name)).textContent;
  assert.equal(metric("data-file-count"), "2");
  assert.equal(metric("data-source-lines"), "12");
  assert.equal(metric("data-executable-units"), "6");
  assert.equal(metric("data-maximum-complexity"), "9");
  const fileButton = directoryRows(navigation, "files").children[0].children[0];
  const staleFile = [...fileButton.listeners.get("click")][0];
  const query = byDataset(publication.nodes, "analyzedQuery");
  query.value = "ab/no";
  query.dispatch("input");
  assert.deepEqual(state.snapshot().indices, [3]);
  fileButton.dispatch("click");
  assert.equal(state.snapshot().selection, 2, "global query rejected hierarchy file selection");
  assert.equal(state.snapshot().district, null);
  assert.equal(byDataset([inspector], "canonicalPath").textContent, values[2].canonicalPath);
  const districtButton = byDataset([inspector], "selectDistrict");
  assert.equal(districtButton.textContent, "a/deep/nested");
  assert.equal(directoryRows(navigation, "files").children[0].children[0], fileButton, "opening a file must retain directory location and rows");
  districtButton.dispatch("click");
  const breadcrumbs = byDataset([navigation], "districtBreadcrumbs");
  assert.equal(breadcrumbs.tagName, "OL");
  assert.deepEqual(breadcrumbs.children.map(item => item.textContent), ["/", "a", "a/deep", "a/deep/nested"]);
  assert.equal(breadcrumbs.children.at(-1).children[0].attributes.get("aria-current"), "location");
  assert.equal(directoryRows(navigation, "directories").children.length, 0);
  const previousVisuals = visuals.length;
  staleFile();
  fileButton.dispatch("click");
  districtButton.dispatch("click");
  assert.equal(visuals.length, previousVisuals, "disposed callbacks changed selection");
  byDataset([navigation], "districtNavigation").children[1].dispatch("click");
  assert.equal(byDataset([inspector], "districtPath").textContent, "a/deep");
  byDataset([navigation], "districtBreadcrumbs").children[1].children[0].dispatch("click");
  assert.equal(byDataset([inspector], "districtPath").textContent, "a");
  browse.dispatch("click");
  assert.equal(byDataset([inspector], "districtPath").textContent, "a", "lookup retains its location");
  byDataset([navigation], "districtNavigation").children[0].click();
  assert.equal(byDataset([inspector], "districtPath").textContent, "/");
  const afterBrowse = visuals.length;
  publication.rollback();
  state.dispose();
  browse.dispatch("click");
  state.hierarchyFileActivated(13, publication.identity, 0);
  assert.equal(visuals.length, afterBrowse);
});

test("inspector-owned navigation restores focus without scrolling; browsing and external selection do not steal focus", () => {
  const values = [{ canonicalPath: "a/deep/file.ts", S: 1, U: 1, M: 1 }];
  const { publication, inspector, navigation, select, state, documentTarget } = hierarchyPublication(values);
  const browse = byDataset(publication.nodes, "browseDirectories");
  byDataset(publication.nodes, "navigationToggle").click();
  browse.focus(); browse.dispatch("click");
  assert.equal(documentTarget.activeElement, browse);
  const directory = directoryRows(navigation, "directories").children[0].children[0];
  directory.focus(); directory.dispatch("click");
  assert.equal(documentTarget.activeElement, navigation);
  assert.deepEqual(navigation.focusOptions, { preventScroll: true });
  const file = directoryRows(navigation, "files").children[0].children[0];
  file.focus(); file.dispatch("click");
  assert.equal(documentTarget.activeElement, inspector, "closing lookup must not retain focus in a hidden row");
  const containingDirectory = byDataset([inspector], "selectDistrict");
  containingDirectory.focus(); containingDirectory.dispatch("click");
  assert.equal(documentTarget.activeElement, inspector);
  const breadcrumb = byDataset([navigation], "districtBreadcrumbs").children[1].children[0];
  breadcrumb.focus(); breadcrumb.dispatch("click");
  assert.equal(documentTarget.activeElement, navigation);
  const parent = byDataset([navigation], "districtNavigation").children[1];
  parent.focus(); parent.dispatch("click");
  assert.equal(documentTarget.activeElement, navigation);
  browse.focus(); select("a");
  assert.equal(documentTarget.activeElement, browse, "external selection stole focus");
  inspector.focus(); publication.setSelection(null);
  const find = byDataset(publication.nodes, 'navigationToggle');
  assert.equal(documentTarget.activeElement, find);
  assert.deepEqual(find.focusOptions, { preventScroll: true });
  publication.rollback(); state.dispose();
});

test("both hierarchy lists page by 32 with M/unsigned-UTF8 ties; file S/U sorting resets only its page and disposes detached rows", () => {
  const values = Array.from({ length: 70 }, (_, index) => ({ canonicalPath: `d${String(index).padStart(2, "0")}/file.ts`, S: index, U: 70 - index, M: index % 3 }));
  values.push(...["é", "é", "Z"].map(name => ({ canonicalPath: `${name}/file.ts`, S: 2, U: 2, M: 2 })));
  const { publication, inspector, navigation, select, state, visuals } = hierarchyPublication(values);
  select("/");
  const expectedFiles = sort => values.map((_, index) => index).sort((a, b) => values[b][sort] - values[a][sort]
    || compareUnsignedUtf8(values[a].canonicalPath, values[b].canonicalPath)).map(index => values[index].canonicalPath);
  const allFiles = [], allDirectories = [];
  const firstFile = directoryRows(navigation, "files").children[0].children[0];
  const detachedCallback = [...firstFile.listeners.get("click")][0];
  for (let page = 0; page < 3; page++) {
    allFiles.push(...rowPaths(directoryRows(navigation, "files")));
    allDirectories.push(...rowPaths(directoryRows(navigation, "directories")));
    assert.equal(directoryRows(navigation, "files").children.length, page === 2 ? 9 : 32);
    assert.equal(directoryRows(navigation, "directories").children.length, page === 2 ? 9 : 32);
    if (page < 2) { paging(navigation, "files").children[2].dispatch("click"); paging(navigation, "directories").children[2].dispatch("click"); }
  }
  assert.deepEqual(allFiles, expectedFiles("M"));
  assert.deepEqual(allDirectories, expectedFiles("M").map(immediateDirectory));
  assert.equal(paging(navigation, "files").children[2].disabled, true);
  assert.equal(paging(navigation, "directories").children[2].disabled, true);
  const before = visuals.length;
  firstFile.dispatch("click"); detachedCallback();
  assert.equal(visuals.length, before);
  const sort = byDataset([navigation], "districtFileSort");
  assert.equal(sort.tagName, "SELECT");
  assert.equal(sort.value, "M");
  for (const metric of ["S", "U", "M"]) {
    sort.value = metric; sort.dispatch("change");
    assert.deepEqual(rowPaths(directoryRows(navigation, "files")), expectedFiles(metric).slice(0, 32));
    assert.equal(paging(navigation, "files").children[0].disabled, true);
    assert.equal(paging(navigation, "directories").children[1].textContent, "65–73 of 73");
  }
  const oldSort = [...sort.listeners.get("change")][0];
  select("d00");
  const after = visuals.length;
  oldSort();
  assert.equal(visuals.length, after);
  assert.equal(directoryRows(navigation, "files").children.length, 1);
  publication.rollback(); state.dispose();
});

 test("hierarchy indexing handles deep ancestors iteratively and keeps 4,000 contained files paged without truncation", () => {
  const deepPath = `${Array.from({ length: 2_000 }, () => "d").join("/")}/leaf.ts`;
  const deepFacts = [{ canonicalPath: deepPath, S: 1, U: 1, M: 17 }];
  const descriptors = hierarchyDescriptors(deepFacts);
  const hierarchy = createDistrictInspectionIndex(deepFacts, descriptors);
  assert.equal(hierarchy.directoryOf(deepPath), 2_000);
  assert.equal(hierarchy.maxima[0], 17);
  assert.deepEqual(hierarchy.members(0), [0]);
  assert.deepEqual(hierarchy.members(1_999), [0]);
  const values = Array.from({ length: 4_000 }, (_, index) => ({ canonicalPath: `a/deep/${index}.ts`, S: 1, U: 1, M: index % 10 }));
  const { publication, navigation, select, state } = hierarchyPublication(values);
  select("a");
  assert.equal(directoryRows(navigation, "files").children.length, 32);
  assert.equal(paging(navigation, "files").children[1].textContent, "1–32 of 4000");
  publication.rollback(); state.dispose();
});

 test("switching file inspection to a directory closes source and invalidates pending unit/source results", async () => {
  const pending = [];
  const values = [{ canonicalPath: "a/deep/file.ts", S: 1, U: 1, M: 1 }];
  const { publication, state, inspector, select } = hierarchyPublication(values, query => new Promise(resolve => pending.push({ query, resolve })));
  state.hierarchyFileActivated(13, publication.identity, 0);
  assert.equal(pending[0].query.path, "a/deep/file.ts");
  const unit = { id: 0, kind: "function", complexity: 1, start: { line: 1, column: 1 }, end: { line: 2, column: 1 } };
  pending.shift().resolve({ type: "units", path: values[0].canonicalPath, offset: 0, total: 1, rows: [unit] });
  await Promise.resolve();
  byDataset([inspector], "unit").dispatch("click");
  const dialog = byDataset([inspector], "unitSource");
  assert.equal(dialog.open, true);
  const code = byDataset([inspector], "sourceCode");
  select("a");
  assert.equal(dialog.open, false);
  for (const request of pending) request.resolve({ type: request.query.type, total: 0, rows: [], text: "stale", highlights: [], syntax: [], start: { line: 1, column: 1 }, end: { line: 1, column: 6 }, cursor: 0, next: null });
  await Promise.resolve();
  assert.equal(code.children.length, 0);
  assert.equal(byDataset([inspector], "districtPath").textContent, "a");
  publication.rollback(); state.dispose();
});

test("navigation tabs do not select; explicit Close uses the guarded shared clear action", () => {
  const { publication, state, documentTarget } = hierarchyPublication([{ canonicalPath: "a/file.ts", S: 1, U: 2, M: 3 }]);
  const browse = byDataset(publication.nodes, "browseDirectories");
  const files = descendants(publication.nodes[0]).find(node => node.id === "workspace-files-tab");
  const panel = byDataset(publication.nodes, "directoryPanel");
  byDataset(publication.nodes, "navigationToggle").click();
  browse.click();
  assert.equal(state.snapshot().district, null);
  files.click(); assert.equal(panel.hidden, true);
  browse.click(); assert.equal(panel.hidden, false, "same root selection must still switch the active tab");
  state.hierarchyFileActivated(13, publication.identity, 0);
  const close = byDataset(publication.nodes, "closeDetails");
  close.focus(); close.click();
  assert.equal(state.snapshot().district, null);
  assert.equal(byDataset(publication.nodes, "selectionDetails").hidden, true);
  assert.equal(close.hidden, true);
  assert.equal(documentTarget.activeElement, byDataset(publication.nodes, "navigationToggle"));
  const before = state.snapshot();
  publication.rollback(); close.click(); browse.click();
  assert.deepEqual(state.snapshot(), before);
  state.dispose();
});

test("highest complexity uses recorded M, positive U and unsigned UTF8 paths, not S or navigation", () => {
  assert.equal(highestComplexityFile(facts), 3);
  assert.equal(highestComplexityFile([{ canonicalPath: 'x', S: 999, U: 0, M: 100 }, { canonicalPath: 'a', S: 1, U: 0, M: 0 }]), null);
  const tied = ['😀.js', '\ue000.js', 'é.js', 'é.js'].map(canonicalPath => ({ canonicalPath, S: 0, U: 1, M: Number.MAX_SAFE_INTEGER }));
  assert.equal(highestComplexityFile(tied), 3);
});

const flushInspection = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const retainedUnit = id => ({ id, kind: 'function', complexity: 80 - id, start: {line: id + 1, column: 1}, end: {line: id + 2, column: 1} });
function metadata(query) { return { ...query, total: 40, rows: Array.from({length: Math.min(32,40-query.offset)}, (_,i)=>retainedUnit(query.offset+i)) }; }

test("one primary action bypasses query, reuses pending first page, and reactivates first unit from a later page", async () => {
  const pending = [], calls = [];
  const f = hierarchyPublication(facts, query => { calls.push(query); return new Promise(resolve=>pending.push({query,resolve})); });
  const primary = byDataset(f.publication.nodes, 'inspectHighest');
  assert.equal(f.state.snapshot().selection, null); assert.equal(calls.length, 0);
  byDataset(f.publication.nodes,'navigationToggle').click();
  const query = byDataset(f.publication.nodes,'analyzedQuery'); query.value='Zeta'; query.dispatch('input');
  primary.click(); primary.click();
  assert.equal(f.state.snapshot().selection, 3); assert.deepEqual(calls, [{type:'units',path:facts[3].canonicalPath,offset:0}]);
  pending.shift().resolve(metadata(calls[0])); await flushInspection();
  assert.equal(byDataset(f.publication.nodes,'unitSource').open,true);
  assert.deepEqual(calls[1],{type:'source',path:facts[3].canonicalPath,unit:0,cursor:null});
  byDataset(f.publication.nodes,'unitSource').close();
  assert.equal(f.documentTarget.activeElement,primary);
  const paging = byDataset(f.publication.nodes,'unitPaging'); paging.children[2].click();
  pending.at(-1).resolve(metadata(calls.at(-1))); await flushInspection();
  primary.click(); assert.deepEqual(calls.at(-1),{type:'units',path:facts[3].canonicalPath,offset:0});
  pending.at(-1).resolve(metadata(calls.at(-1))); await flushInspection();
  assert.equal(calls.at(-1).type,'source'); assert.equal(calls.at(-1).unit,0);
  f.publication.rollback(); f.state.dispose();
});

test("pending primary intent is cancelled by same-generation selection, clear, lookup, setup cancellation or disposal; errors retry only explicitly", async () => {
  for (const action of ['selection','clear','lookup','cancel','dispose']) {
    const pending=[];
    const f=hierarchyPublication(facts,query=>new Promise(resolve=>pending.push({query,resolve})));
    const primary=byDataset(f.publication.nodes,'inspectHighest');
    const detached=[...primary.listeners.get('click')][0]; primary.click();
    if(action==='selection') f.state.cityActivated(13,f.publication.identity,0);
    if(action==='clear') f.state.selectionAction(13,f.publication.identity,'clear');
    if(action==='lookup') byDataset(f.publication.nodes,'navigationToggle').click();
    if(action==='cancel') f.publication.cancelInspectionIntent();
    if(action==='dispose') { f.publication.rollback(); f.state.dispose(); detached(); }
    for(const request of [...pending]) request.resolve(metadata(request.query));
    await flushInspection();
    assert.equal(pending.length,action==='selection'?2:1,action+' opened unexpected source');
    assert.notEqual(byDataset(f.publication.nodes,'unitSource')?.open,true,action);
    f.publication.rollback(); f.state.dispose();
  }
  const pending=[]; const f=hierarchyPublication(facts,query=>new Promise(resolve=>pending.push({query,resolve})));
  const primary=byDataset(f.publication.nodes,'inspectHighest'); primary.click();
  pending[0].resolve({type:'units',path:'wrong',offset:0,total:1,rows:[]}); await flushInspection();
  assert.match(byDataset(f.publication.nodes,'primaryInspectionStatus').textContent,/unavailable/u); assert.equal(pending.length,1);
  assert.equal(byDataset(f.publication.nodes,'city').hidden,false);
  primary.click(); assert.equal(pending.length,2); pending[1].resolve(metadata(pending[1].query)); await flushInspection();
  assert.equal(pending[2].query.type,'source'); f.publication.rollback(); f.state.dispose();
});

test("renderer refusal never authorizes primary source, even when its winner is already selected", async () => {
  let applied=true; const calls=[];
  const f=hierarchyPublication(facts,async query=>{calls.push(query);return metadata(query);},()=>({kind:applied?'applied':'stale'}));
  f.state.hierarchyFileActivated(13,f.publication.identity,3);await flushInspection();assert.equal(calls.length,1);
  applied=false;byDataset(f.publication.nodes,'inspectHighest').click();await flushInspection();
  assert.equal(calls.length,1);assert.notEqual(byDataset(f.publication.nodes,'unitSource').open,true);
  f.publication.rollback();f.state.dispose();
});

test("no-unit publications keep lookup available but disable primary with an honest reason", () => {
  const f=hierarchyPublication([{canonicalPath:'empty.js',S:0,U:0,M:0}],()=>{assert.fail('unexpected inspection');});
  assert.equal(byDataset(f.publication.nodes,'inspectHighest').disabled,true);
  assert.equal(byDataset(f.publication.nodes,'primaryInspectionStatus').textContent,'No executable units to inspect.');
  byDataset(f.publication.nodes,'navigationToggle').click(); assert.equal(f.publication.nodes[0].hidden,false);
  f.publication.rollback(); f.state.dispose();
});

test("standalone composition never calls camera reveal or programmatic canvas focus for selection", async () => {
  const source = await readFile(new URL("../src/edge/standalone-presentation-session.ts", import.meta.url), "utf8");
  const main = await readFile(new URL("../src/edge/standalone-browser-main.ts", import.meta.url), "utf8");
  assert.doesNotMatch(`${source}\n${main}`, /revealSelection|focusCanvas/u);
  assert.doesNotMatch(`${source}\n${main}`, /innerHTML|insertAdjacentHTML/u);
});
