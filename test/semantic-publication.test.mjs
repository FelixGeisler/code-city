import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(/^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context);
  },
});

const { layoutDistrictLabels, stageSemanticPublication } = await import("../src/edge/semantic-publication.ts");

class FakeElement {
  constructor(tagName, { throwText = false, rectangle } = {}) {
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
    this.rectangle = rectangle ?? { left: 10, top: 20, width: 600, height: 400 };
    this.measurements = 0;
  }
  get parentNode() { return this.parent; }
  set textContent(value) {
    if (this.throwText) throw new Error("injected text staging failure");
    this.value = String(value);
    for (const child of this.children) child.parent = undefined;
    this.children = [];
  }
  get textContent() {
    return this.children.length ? this.children.map((child) => child.textContent ?? "").join("") : this.value;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
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
  getBoundingClientRect() { this.measurements += 1; return { ...this.rectangle }; }
}

const paletteBoundaries = [
  { M: 0, range: "0", rgba: "#22C55EFF" },
  { M: 1, range: "1", rgba: "#84CC16FF" },
  { M: 2, range: "2–3", rgba: "#FACC15FF" },
  { M: 3, range: "2–3", rgba: "#FACC15FF" },
  { M: 4, range: "4–7", rgba: "#F59E0BFF" },
  { M: 7, range: "4–7", rgba: "#F59E0BFF" },
  { M: 8, range: "8–15", rgba: "#F97316FF" },
  { M: 15, range: "8–15", rgba: "#F97316FF" },
  { M: 16, range: "16+", rgba: "#EF4444FF" },
];
const identities = [
  { root: true, identity: "_root" },
  { root: false, identity: "_root" },
  { root: false, identity: "Repository root" },
  { root: false, identity: "<img src=x>&" },
  { root: false, identity: `very-${"long-".repeat(50)}name` },
  { root: false, identity: "RTL-אבג-\u202E-LTR" },
  { root: false, identity: "a" },
  { root: false, identity: "b" },
  { root: false, identity: "c" },
];
const snapshot = Object.freeze({
  cssWidth: 600,
  cssHeight: 400,
  districts: Object.freeze(identities.map((_, index) => Object.freeze({
    screenX: 80 + (index % 3) * 180,
    screenY: 50 + Math.floor(index / 3) * 80,
    area: identities.length - index,
    lateral: true,
  }))),
});
const displayedHeight = (S) => 4 + Math.floor(36 * Math.log1p(Math.min(S, 1000)) / Math.log(1001) + 0.5);
const displayedSide = (U) => 3 + Math.floor(15 * (Math.log1p(Math.min(U, 100)) / Math.log(101)) ** 1.5 + 0.5);

function fixture(options = {}) {
  const root = new FakeElement("section");
  const revision = new FakeElement("output");
  const created = [];
  const documentTarget = {
    createElement(tagName) {
      if (options.throwCreate === tagName) throw new Error("injected element creation failure");
      const element = new FakeElement(tagName, {
        throwText: options.throwTextTag === tagName,
        rectangle: tagName === "section" ? { left: 400, top: 30, width: 200, height: 360 } : undefined,
      });
      created.push(element);
      return element;
    },
  };
  const facts = paletteBoundaries.map(({ M }, index) => ({
    canonicalPath: index === 0 ? "paths/<img src=x>&.js" : index === 1 ? "paths/bidi-\u202E-token.js" : `paths/${index}.js`,
    S: index,
    U: index + 1,
    M,
  }));
  const canvas = {
    removed: 0,
    remove() { this.removed += 1; },
    getBoundingClientRect() { return { left: 10, top: 20, width: 600, height: 400 }; },
  };
  const publication = stageSemanticPublication(documentTarget, root, revision, "a".repeat(40), facts, identities);
  return { root, revision, created, facts, canvas, publication };
}

function descendants(element) {
  return element.children.flatMap((child) => child instanceof FakeElement ? [child, ...descendants(child)] : []);
}
function byDataset(element, key) { return descendants(element).find((child) => Object.hasOwn(child.dataset, key)); }
function byAttribute(element, name) { return descendants(element).find((child) => child.attributes.has(name)); }

function committedFixture() {
  const f = fixture();
  f.publication.commit(f.canvas, snapshot);
  return f;
}

test("semantic publication commits canvas, safe HTML labels, inspector, and legend in one ordered root replacement", () => {
  const f = fixture();
  const inspector = f.created.find((element) => Object.hasOwn(element.dataset, "inspector"));
  const overlay = f.created.find((element) => Object.hasOwn(element.dataset, "districtLabels"));
  const legend = f.created.find((element) => Object.hasOwn(element.dataset, "paletteLegend"));
  assert.deepEqual(f.root.children, []);
  assert.deepEqual(inspector.dataset, { inspector: "" });
  assert.equal(inspector.attributes.get("role"), "status");
  assert.equal(inspector.attributes.get("aria-live"), "polite");
  assert.equal(inspector.attributes.get("aria-atomic"), "true");
  assert.equal(inspector.attributes.get("aria-label"), "Selected building metric explanation");
  assert.equal(inspector.tabIndex, 0);
  assert.equal(inspector.hidden, true);
  assert.deepEqual(overlay.dataset, { districtLabels: "" });
  assert.equal(overlay.attributes.get("aria-hidden"), "true");
  assert.equal(overlay.children.length, identities.length);
  assert(overlay.children.every((label) => label.tagName === "DIV" && label.children.length === 1 && label.children[0].tagName === "BDI"));
  assert.deepEqual(overlay.children.map((label) => label.children[0].textContent), ["/", ...identities.slice(1).map(({ identity }) => identity)]);
  assert(overlay.children.every((label) => label.children[0].attributes.get("dir") === "auto"));
  assert(overlay.children.every((label) => label.children[0].children.length === 0));
  assert.deepEqual(legend.children[1].children.map((item) => item.textContent), [
    "M = 0", "M = 1", "M = 2–3", "M = 4–7", "M = 8–15", "M = 16+",
  ]);

  f.publication.commit(f.canvas, snapshot);
  assert.deepEqual(f.root.children, [f.canvas, overlay, inspector, legend]);
  assert.equal(f.revision.textContent, "a".repeat(40));
  assert(overlay.children.every((label) => label.style.width === "144px" && /^translate\(-?\d+(?:\.\d+)?px, -?\d+(?:\.\d+)?px\)$/u.test(label.style.transform)));
  const outerDisclosure = JSON.stringify({
    overlayDataset: overlay.dataset,
    overlayAttributes: [...overlay.attributes],
    labels: overlay.children.map((label) => ({ dataset: label.dataset, attributes: [...label.attributes], style: label.style })),
  });
  for (const identity of identities.slice(1, 6).map(({ identity }) => identity)) assert.equal(outerDisclosure.includes(identity), false);
});

test("every M boundary keeps exact selected facts while selection reuses cached projection for inspector exclusion", () => {
  const f = committedFixture();
  const inspector = byDataset(f.root, "inspector");
  const overlay = byDataset(f.root, "districtLabels");
  const initialTransforms = overlay.children.map((label) => label.style.transform);
  for (const [index, expected] of paletteBoundaries.entries()) {
    const fact = f.facts[index];
    f.publication.setSelection(index);
    assert.equal(byDataset(inspector, "canonicalPath").textContent, fact.canonicalPath);
    assert.equal(byAttribute(inspector, "data-source-lines").textContent, String(fact.S));
    assert.equal(byAttribute(inspector, "data-executable-units").textContent, String(fact.U));
    assert.equal(byAttribute(inspector, "data-maximum-complexity").textContent, String(fact.M));
    assert.equal(byDataset(inspector, "dimensionPolicy").textContent, "S cap 1000; displayed height range 4..40. U cap 100; displayed side range 3..18.");
    assert.equal(byAttribute(inspector, "data-height").textContent, String(displayedHeight(fact.S)));
    assert.equal(byAttribute(inspector, "data-width").textContent, String(displayedSide(fact.U)));
    assert.equal(byAttribute(inspector, "data-depth").textContent, String(displayedSide(fact.U)));
    assert.equal(byDataset(inspector, "selectedRange").textContent, `M = ${expected.range}`);
    assert.equal(byDataset(inspector, "selectedRgba").textContent, expected.rgba);
    assert.deepEqual(overlay.children.map((label) => label.style.transform), initialTransforms, "selection reprojected labels");
  }
  assert(overlay.children.slice(2, 3).every((label) => label.hidden), "visible inspector did not exclude an intersecting label");
  f.publication.setSelection(null);
  assert.equal(inspector.hidden, true);
  assert.equal(inspector.textContent, "");
});

test("greedy admission proves area/index order, exact gap, offscreen handling, inspector exclusion, narrow layout, and no K cap", () => {
  const base = (cssWidth, districts) => ({ cssWidth, cssHeight: 200, districts });
  const wide = layoutDistrictLabels(base(500, [
    { screenX: 100, screenY: 50, area: 10, lateral: true },
    { screenX: 120, screenY: 50, area: 20, lateral: true },
    { screenX: 268, screenY: 50, area: 5, lateral: true },
    { screenX: -80, screenY: 90, area: 4, lateral: true },
    { screenX: 250, screenY: 100, area: 100, lateral: false },
    { screenX: -100, screenY: 130, area: 3, lateral: true },
  ]));
  assert.deepEqual(wide.map(({ visible }) => visible), [false, true, true, false, false, false]);
  assert.equal(wide[2].transform, "translate(196px, 40px)", "exact four-pixel gap was rejected");

  const narrow = layoutDistrictLabels(base(479, [
    { screenX: 52, screenY: 30, area: 2, lateral: true },
    { screenX: 160, screenY: 30, area: 1, lateral: true },
    { screenX: 477, screenY: 90, area: 1, lateral: true },
  ]));
  assert.deepEqual(narrow.map(({ visible }) => visible), [true, true, true]);
  assert.equal(narrow[0].transform, "translate(0px, 20px)");
  assert.equal(narrow[1].transform, "translate(108px, 20px)");
  assert.equal(narrow[2].transform, "translate(425px, 80px)", "partial-edge box was not retained");

  const excluded = layoutDistrictLabels(base(500, [
    { screenX: 400, screenY: 50, area: 2, lateral: true },
    { screenX: 100, screenY: 50, area: 1, lateral: true },
  ]), { left: 330, top: 20, width: 170, height: 80 });
  assert.deepEqual(excluded.map(({ visible }) => visible), [false, true]);

  const dense = Array.from({ length: 4000 }, (_, index) => ({
    screenX: index === 3999 ? 250 : 100,
    screenY: 150,
    area: index,
    lateral: index === 3999,
  }));
  const denseLayout = layoutDistrictLabels({ cssWidth: 500, cssHeight: 300, districts: dense });
  assert.equal(denseLayout.length, 4000);
  assert.equal(denseLayout.filter(({ visible }) => visible).length, 1);
  assert.equal(denseLayout[3999].visible, true, "late candidate was hidden by a first-K cap");
});

test("projection updates change numeric layout only; hover has no semantic label path and rollback removes all label ownership", () => {
  const f = committedFixture();
  const overlay = byDataset(f.root, "districtLabels");
  const before = overlay.children.map((label) => label.style.transform);
  const moved = Object.freeze({
    cssWidth: 600,
    cssHeight: 400,
    districts: Object.freeze(snapshot.districts.map((district) => Object.freeze({ ...district, screenX: district.screenX + 1 }))),
  });
  f.publication.districtProjection(moved);
  assert.notDeepEqual(overlay.children.map((label) => label.style.transform), before);
  f.publication.rollback();
  f.publication.rollback();
  assert.deepEqual(f.root.children, [f.canvas]);
  assert.deepEqual(overlay.children, []);
  assert.equal(f.revision.textContent, "");
  assert.equal("hover" in f.publication, false);
});

test("invalid selection and staging, attached-measurement, layout, and DOM update faults escape to M1-PRES-1 boundary", () => {
  const f = fixture();
  assert.throws(() => f.publication.setSelection(-1), /Invalid semantic selection/u);
  assert.throws(() => f.publication.setSelection(f.facts.length), /Invalid semantic selection/u);
  assert.throws(() => fixture({ throwTextTag: "bdi" }), /injected text staging failure/u);
  assert.throws(() => fixture({ throwCreate: "ul" }), /injected element creation failure/u);
  const badCanvas = fixture();
  badCanvas.canvas.getBoundingClientRect = () => ({ left: 10, top: 20, width: 599, height: 400 });
  assert.throws(() => badCanvas.publication.commit(badCanvas.canvas, snapshot), /dimensions differ/u);
  badCanvas.publication.rollback();
  const update = committedFixture();
  const inspector = byDataset(update.root, "inspector");
  inspector.throwReplace = true;
  assert.throws(() => update.publication.setSelection(0), /injected DOM update failure/u);
  update.publication.rollback();
  assert.equal(inspector.hidden, true);
});

test("label and inspector CSS fixes exact inert style, dimensions, clipping, bidi isolation, and layering", async () => {
  const css = await readFile(new URL("../src/edge/shell.css", import.meta.url), "utf8");
  assert.match(css, /\[data-district-labels\]\s*\{[^}]*inset:\s*0;[^}]*overflow:\s*hidden;[^}]*pointer-events:\s*none;[^}]*position:\s*absolute;[^}]*z-index:\s*1;/su);
  assert.match(css, /\[data-district-labels\] > div\s*\{[^}]*background:\s*rgb\(7 17 31 \/ 0\.72\);[^}]*border:\s*0;[^}]*border-radius:\s*3px;[^}]*box-shadow:\s*none;[^}]*color:\s*#CBD5E1;[^}]*font:\s*650 11px\/20px ui-monospace, SFMono-Regular, Consolas, monospace;[^}]*height:\s*20px;[^}]*outline:\s*0;[^}]*padding-inline:\s*6px;[^}]*text-align:\s*center;[^}]*white-space:\s*nowrap;/su);
  assert.match(css, /\[data-district-labels\] bdi\s*\{[^}]*isolation:\s*isolate;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*unicode-bidi:\s*isolate;[^}]*white-space:\s*nowrap;/su);
  assert.match(css, /\[data-inspector\][^{]*\{[^}]*z-index:\s*2;/su);
  assert.match(css, /\[data-canonical-path\][^{]*\{[^}]*overflow-wrap:\s*anywhere;[^}]*unicode-bidi:\s*isolate;/su);
  assert.match(css, /\[data-palette-legend\][^{]*\{[^}]*pointer-events:\s*none;[^}]*position:\s*absolute;/su);
});
