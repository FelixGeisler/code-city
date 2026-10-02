import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(/^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context);
  },
});

const { stageSemanticPublication } = await import("../src/edge/semantic-publication.ts");

class FakeElement {
  constructor(tagName, { throwText = false } = {}) {
    this.tagName = tagName.toUpperCase();
    this.dataset = {};
    this.attributes = new Map();
    this.children = [];
    this.hidden = false;
    this.parent = undefined;
    this.value = "";
    this.throwText = throwText;
    this.throwReplace = false;
    this.tabIndex = -1;
    this.style = {};
    this.listeners = new Map();
    this.type = "";
    this.autocomplete = "";
    this.spellcheck = true;
  }
  get parentNode() { return this.parent; }
  set textContent(value) {
    if (this.throwText) throw new Error("injected text failure");
    this.value = String(value);
    for (const child of this.children) child.parent = undefined;
    this.children = [];
  }
  get textContent() {
    return this.children.length ? this.children.map((child) => child.textContent ?? "").join("") : this.value;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  addEventListener(type, listener) { const entries = this.listeners.get(type) ?? new Set(); entries.add(listener); this.listeners.set(type, entries); }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type) { for (const listener of [...(this.listeners.get(type) ?? [])]) listener(new Event(type)); }
  append(...children) {
    for (const child of children) {
      if (child instanceof FakeElement) child.parent = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children) {
    if (this.throwReplace) throw new Error("injected DOM update failure");
    for (const child of this.children) if (child instanceof FakeElement) child.parent = undefined;
    this.children = children;
    for (const child of children) if (child instanceof FakeElement) child.parent = this;
  }
  removeChild(child) {
    this.children = this.children.filter((candidate) => candidate !== child);
    child.parent = undefined;
    return child;
  }
  remove() { if (this.parent) this.parent.removeChild(this); }
}

const facts = [
  { canonicalPath: "root.js", S: 0, U: 1, M: 0 },
  { canonicalPath: "_root/file.js", S: 1, U: 2, M: 1 },
  { canonicalPath: "one/file.js", S: 2, U: 3, M: 2 },
  { canonicalPath: "one/two/deeper/file.js", S: 4, U: 5, M: 4 },
  { canonicalPath: "unsafe/<img src=x>&.js", S: 8, U: 9, M: 8 },
  { canonicalPath: "bidi/RTL-אבג-\u202E-LTR.js", S: 16, U: 17, M: 16 },
];
const projection = Object.freeze({
  cssWidth: 600,
  cssHeight: 400,
  districts: Object.freeze([{ screenX: 1, screenY: 2, area: 3, lateral: true }]),
});
const displayedHeight = (S) => 4 + Math.floor(36 * Math.log1p(Math.min(S, 1000)) / Math.log(1001) + 0.5);
const displayedSide = (U) => 3 + Math.floor(15 * (Math.log1p(Math.min(U, 100)) / Math.log(101)) ** 1.5 + 0.5);

function fixture(options = {}) {
  const root = new FakeElement("section");
  const viewport = options.separateViewport ? new FakeElement("div") : root;
  const revision = new FakeElement("output");
  const created = [];
  const documentTarget = {
    createElement(tagName) {
      if (options.throwCreate === tagName) throw new Error("injected element creation failure");
      const element = new FakeElement(tagName, { throwText: options.throwTextTag === tagName });
      created.push(element);
      return element;
    },
  };
  const canvas = {
    width: options.width ?? 600,
    removed: 0,
    remove() { this.removed += 1; },
    getBoundingClientRect() { return { left: 10, top: 20, width: this.width, height: 400 }; },
  };
  const searchEvents = [];
  const searchSink = {
    queryChanged(generation, identity, query) { searchEvents.push({ kind: "query", generation, identity, query }); },
    resultActivated(generation, identity, query, index) { searchEvents.push({ kind: "activation", generation, identity, query, index }); },
  };
  const publication = stageSemanticPublication(
    documentTarget,
    root,
    revision,
    "a".repeat(40),
    facts,
    7,
    searchSink,
    viewport,
  );
  return { root, viewport, revision, created, canvas, publication, searchEvents };
}

function descendants(element) {
  return element.children.flatMap((child) => child instanceof FakeElement ? [child, ...descendants(child)] : []);
}
function byDataset(element, key) { return descendants(element).find((child) => Object.hasOwn(child.dataset, key)); }
function byAttribute(element, name) { return descendants(element).find((child) => child.attributes.has(name)); }
function committedFixture(options) {
  const value = fixture(options);
  value.publication.commit(value.canvas, projection);
  return value;
}

test("one contextual row commits after search and before the viewport with an inert safe empty label", () => {
  const f = fixture({ separateViewport: true });
  const row = f.created.find((element) => Object.hasOwn(element.dataset, "districtContext"));
  const label = f.created.find((element) => Object.hasOwn(element.dataset, "districtContextLabel"));
  const inspector = f.created.find((element) => Object.hasOwn(element.dataset, "inspector"));
  const legend = f.created.find((element) => Object.hasOwn(element.dataset, "paletteLegend"));
  const search = f.created.find((element) => Object.hasOwn(element.dataset, "pathSearch"));
  assert.deepEqual(f.root.children, []);
  assert.equal(row.attributes.get("aria-hidden"), "true");
  assert.equal(row.tabIndex, -1);
  assert.equal(label.hidden, true);
  assert.equal(label.textContent, "");
  assert.equal(label.children.length, 1);
  assert.equal(label.children[0].tagName, "BDI");
  assert.equal(label.children[0].attributes.get("dir"), "auto");
  assert.equal(inspector.attributes.get("role"), "status");
  assert.equal(inspector.attributes.get("aria-live"), "polite");
  assert.equal(inspector.attributes.get("aria-atomic"), "true");
  assert.equal(inspector.tabIndex, 0);

  f.publication.commit(f.canvas, projection);
  assert.deepEqual(f.root.children, [search, row, f.viewport]);
  assert.deepEqual(f.viewport.children, [f.canvas, inspector, legend]);
  assert.equal(label.style.width, "144px");
  assert.equal(f.revision.textContent, "a".repeat(40));
  assert.equal(byDataset(f.root, "districtLabels"), undefined);
  assert.equal(descendants(f.root).filter((element) => Object.hasOwn(element.dataset, "districtContextLabel")).length, 1);
});

test("context publication is safe, selected context wins by supplied controller value, and inspector is full text", () => {
  const f = committedFixture();
  const label = byDataset(f.root, "districtContextLabel");
  const text = label.children[0];
  const inspector = byDataset(f.root, "inspector");

  for (const district of ["/", "_root", "one", "one/two", "<img src=x>&", "RTL-אבג-\u202E-LTR"]) {
    f.publication.setContext(null, district);
    assert.equal(label.hidden, false);
    assert.equal(text.textContent, district);
    assert.equal(text.children.length, 0);
  }

  const selected = facts[3];
  f.publication.setContext(3, "one/two");
  assert.equal(text.textContent, "one/two");
  assert.equal(inspector.hidden, false);
  assert.equal(byDataset(inspector, "canonicalPath").textContent, selected.canonicalPath);
  const selectedDistrict = byDataset(inspector, "selectedDistrict");
  assert.equal(selectedDistrict.tagName, "BDI");
  assert.equal(selectedDistrict.attributes.get("dir"), "auto");
  assert.equal(selectedDistrict.textContent, "District: one/two");
  assert.equal(selectedDistrict.children.length, 0);
  assert.equal(byAttribute(inspector, "data-height").textContent, String(displayedHeight(selected.S)));
  assert.equal(byAttribute(inspector, "data-width").textContent, String(displayedSide(selected.U)));
  assert.equal(byAttribute(inspector, "data-depth").textContent, String(displayedSide(selected.U)));

  f.publication.setContext(3, "one/two");
  assert.equal(inspector.hidden, false);
  f.publication.setContext(null, "unsafe");
  assert.equal(inspector.hidden, true);
  assert.equal(inspector.textContent, "");
  assert.equal(text.textContent, "unsafe");
  f.publication.setContext(null, null);
  assert.equal(label.hidden, true);
  assert.equal(text.textContent, "");
});

test("native search keeps literal safe results and bounded listener cleanup", () => {
  const f = committedFixture();
  const input = byDataset(f.root, "pathSearchInput");
  const results = byDataset(f.root, "pathSearchResults");
  const summary = byDataset(f.root, "pathSearchSummary");
  const buttons = byDataset(f.root, "pathSearchButtons");
  assert.equal(input.type, "search");
  assert.equal(input.autocomplete, "off");
  assert.equal(input.spellcheck, false);
  assert.equal(results.hidden, true);

  input.value = "one";
  input.dispatch("input");
  assert.deepEqual(f.searchEvents.at(-1), { kind: "query", generation: 7, identity: f.publication.searchIdentity, query: "one" });
  f.publication.setSearchResults("one", [2, 3]);
  assert.equal(summary.textContent, "2 matching modules.");
  assert.equal(results.hidden, false);
  assert.deepEqual(buttons.children.map((button) => button.children[0].textContent), [facts[2].canonicalPath, facts[3].canonicalPath]);
  assert(buttons.children.every((button) => button.children[0].tagName === "BDI"
    && button.children[0].attributes.get("dir") === "auto" && button.children[0].children.length === 0));
  buttons.children[1].dispatch("click");
  assert.deepEqual(f.searchEvents.at(-1), {
    kind: "activation", generation: 7, identity: f.publication.searchIdentity, query: "one", index: 3,
  });

  input.value = "none";
  f.publication.setSearchResults("none", []);
  assert.equal(summary.textContent, "No matching modules.");
  input.value = "x";
  f.publication.setSearchResults("x", [0]);
  assert.equal(summary.textContent, "1 matching module.");
  f.publication.clearSearch();
  assert.equal(input.value, "");
  assert.equal(results.hidden, true);
  assert.throws(() => f.publication.setSearchResults("stale", []), /snapshot differs/u);

  f.publication.rollback();
  input.value = "retained";
  input.dispatch("input");
  assert.equal(f.searchEvents.at(-1).kind, "activation");
});

test("actual canvas width alone controls 144/104 breakpoint while numeric projection remains compatible and label-free", () => {
  const f = committedFixture({ width: 480 });
  const label = byDataset(f.root, "districtContextLabel");
  assert.equal(label.style.width, "144px");
  f.canvas.width = 479;
  const unrelatedProjection = Object.freeze({
    cssWidth: 9_999,
    cssHeight: 1,
    districts: Object.freeze(Array.from({ length: 20 }, (_, index) => Object.freeze({
      screenX: index, screenY: index, area: index, lateral: index % 2 === 0,
    }))),
  });
  f.publication.districtProjection(unrelatedProjection);
  assert.equal(label.style.width, "104px");
  assert.equal(byDataset(f.root, "districtLabels"), undefined);
  f.canvas.width = 600;
  f.publication.districtProjection(projection);
  assert.equal(label.style.width, "144px");
});

test("invalid semantic state and DOM faults escape to the complete presentation boundary", () => {
  const f = committedFixture();
  assert.throws(() => f.publication.setContext(-1, "/"), /Invalid semantic selection/u);
  assert.throws(() => f.publication.setContext(facts.length, "/"), /Invalid semantic selection/u);
  assert.throws(() => f.publication.setContext(0, null), /Selected district is absent/u);
  const badCanvas = fixture();
  badCanvas.canvas.width = 0;
  assert.throws(() => badCanvas.publication.commit(badCanvas.canvas, projection), /Invalid attached canvas width/u);
  badCanvas.publication.rollback();
  const update = committedFixture();
  const inspector = byDataset(update.root, "inspector");
  inspector.throwReplace = true;
  assert.throws(() => update.publication.setContext(0, "/"), /injected DOM update failure/u);
  update.publication.rollback();
  assert.equal(inspector.hidden, true);
  assert.throws(() => fixture({ throwCreate: "ul" }), /injected element creation failure/u);
});

test("rollback removes contextual text, row, inspector, search, legend, and revision ownership idempotently", () => {
  const f = committedFixture();
  const row = byDataset(f.root, "districtContext");
  const label = byDataset(f.root, "districtContextLabel");
  f.publication.setContext(0, "/");
  f.publication.rollback();
  f.publication.rollback();
  assert.deepEqual(f.root.children, [f.canvas]);
  assert.equal(label.textContent, "");
  assert.equal(label.hidden, true);
  assert.deepEqual(row.children, []);
  assert.equal(f.revision.textContent, "");
});

test("contextual row CSS fixes exact flow, dimensions, clipping, bidi, input, and inspector behavior", async () => {
  const css = await readFile(new URL("../src/edge/shell.css", import.meta.url), "utf8");
  assert.match(css, /\[data-district-context\]\s*\{[^}]*align-items:\s*start;[^}]*block-size:\s*20px;[^}]*display:\s*flex;[^}]*justify-content:\s*flex-start;[^}]*pointer-events:\s*none;/su);
  assert.match(css, /\[data-district-context-label\]\s*\{[^}]*background:\s*rgb\(7 17 31 \/ 0\.72\);[^}]*color:\s*#CBD5E1;[^}]*font:\s*650 11px\/20px ui-monospace, SFMono-Regular, Consolas, monospace;[^}]*height:\s*20px;[^}]*overflow:\s*hidden;[^}]*padding-inline:\s*6px;[^}]*text-align:\s*start;[^}]*text-overflow:\s*ellipsis;[^}]*width:\s*144px;/su);
  assert.match(css, /\[data-district-context-label\]\[hidden\]\s*\{[^}]*display:\s*none;/su);
  assert.match(css, /\[data-district-context-label\] bdi\s*\{[^}]*isolation:\s*isolate;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*unicode-bidi:\s*isolate;/su);
  assert.match(css, /\[data-inspector\][^{]*\{[^}]*z-index:\s*2;/su);
  assert.match(css, /\[data-canonical-path\],\s*\[data-selected-district\]\s*\{[^}]*overflow-wrap:\s*anywhere;[^}]*unicode-bidi:\s*isolate;/su);
  assert.match(css, /\[data-palette-legend\][^{]*\{[^}]*pointer-events:\s*none;[^}]*position:\s*absolute;/su);
});
