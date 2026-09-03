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
  }
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
      child.parent = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children) {
    if (this.throwReplace) throw new Error("injected DOM update failure");
    for (const child of this.children) if (child instanceof FakeElement) child.parent = undefined;
    this.children = children;
    for (const child of children) if (child instanceof FakeElement) child.parent = this;
  }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = undefined;
  }
}

const paletteBoundaries = [
  { M: 0, range: "0", rgba: "#440154FF" },
  { M: 1, range: "1", rgba: "#414487FF" },
  { M: 2, range: "2–3", rgba: "#2A788EFF" },
  { M: 3, range: "2–3", rgba: "#2A788EFF" },
  { M: 4, range: "4–7", rgba: "#22A884FF" },
  { M: 7, range: "4–7", rgba: "#22A884FF" },
  { M: 8, range: "8–15", rgba: "#7AD151FF" },
  { M: 15, range: "8–15", rgba: "#7AD151FF" },
  { M: 16, range: "16+", rgba: "#FDE725FF" },
];

function fixture(options = {}) {
  const root = new FakeElement("section");
  const revision = new FakeElement("output");
  const created = [];
  const documentTarget = {
    createElement(tagName) {
      if (options.throwCreate === tagName) throw new Error("injected element creation failure");
      const element = new FakeElement(tagName, { throwText: options.throwPathText && tagName === "bdi" });
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
  return { root, revision, created, facts, publication: stageSemanticPublication(documentTarget, root, revision, "a".repeat(40), facts) };
}

function descendants(element) {
  return element.children.flatMap((child) => child instanceof FakeElement ? [child, ...descendants(child)] : []);
}

function byDataset(element, key) {
  return descendants(element).find((child) => Object.hasOwn(child.dataset, key));
}

function byAttribute(element, name) {
  return descendants(element).find((child) => child.attributes.has(name));
}

test("semantic publication stages one empty, focusable polite region and commits it atomically with the canvas", () => {
  const f = fixture();
  const [inspector] = f.created;
  assert.deepEqual(f.root.children, []);
  assert.equal(inspector.tagName, "SECTION");
  assert.deepEqual(inspector.dataset, { inspector: "" });
  assert.equal(inspector.attributes.get("role"), "status");
  assert.equal(inspector.attributes.get("aria-live"), "polite");
  assert.equal(inspector.attributes.get("aria-atomic"), "true");
  assert.equal(inspector.attributes.get("aria-label"), "Selected building metric explanation");
  assert.equal(inspector.tabIndex, 0);
  assert.equal(inspector.hidden, true);
  assert.equal(inspector.textContent, "");

  const canvas = { remove() {} };
  f.publication.commit(canvas);
  assert.deepEqual(f.root.children, [canvas, inspector]);
  assert.equal(f.revision.textContent, "a".repeat(40));
});

test("every required M boundary publishes exact facts, formulas, selected band, and the complete text legend", () => {
  const f = fixture();
  const inspector = f.created[0];
  f.publication.commit({ remove() {} });

  for (const [index, expected] of paletteBoundaries.entries()) {
    const fact = f.facts[index];
    f.publication.setSelection(index);
    assert.equal(inspector.hidden, false);
    assert.equal(byDataset(inspector, "canonicalPath").tagName, "BDI");
    assert.equal(byDataset(inspector, "canonicalPath").textContent, fact.canonicalPath);
    assert.equal(byAttribute(inspector, "data-source-lines").textContent, String(fact.S));
    assert.equal(byAttribute(inspector, "data-executable-units").textContent, String(fact.U));
    assert.equal(byAttribute(inspector, "data-maximum-complexity").textContent, String(fact.M));
    assert.equal(byAttribute(inspector, "data-height").textContent, `S + 1 = ${fact.S + 1}`);
    assert.equal(byAttribute(inspector, "data-width").textContent, `U + 1 = ${fact.U + 1}`);
    assert.equal(byAttribute(inspector, "data-depth").textContent, `U + 1 = ${fact.U + 1}`);
    assert.equal(byDataset(inspector, "selectedRange").textContent, `M = ${expected.range}`);
    assert.equal(byDataset(inspector, "selectedRgba").textContent, expected.rgba);
    const legend = byDataset(inspector, "paletteLegend");
    assert.deepEqual(legend.children.map((item) => item.textContent), [
      "M = 0 — #440154FF",
      "M = 1 — #414487FF",
      "M = 2–3 — #2A788EFF",
      "M = 4–7 — #22A884FF",
      "M = 8–15 — #7AD151FF",
      "M = 16+ — #FDE725FF",
    ]);
    assert.equal(descendants(inspector).some(({ tagName }) => tagName === "A"), false);
  }
});

test("adversarial paths stay complete inert bdi text and every clear removes all inspector content", () => {
  const f = fixture();
  const inspector = f.created[0];
  const canvas = { remove() {} };
  f.publication.commit(canvas);
  for (const [index, fact] of f.facts.entries()) {
    f.publication.setSelection(index);
    const path = byDataset(inspector, "canonicalPath");
    assert.equal(path.textContent, fact.canonicalPath);
    assert.deepEqual(path.children, [], fact.canonicalPath);
  }
  f.publication.setSelection(null);
  assert.equal(inspector.hidden, true);
  assert.equal(inspector.textContent, "");
  assert.deepEqual(inspector.children, []);
  f.publication.rollback();
  f.publication.rollback();
  assert.deepEqual(f.root.children, [canvas], "rollback removes only the semantic region");
  assert.equal(f.revision.textContent, "");
});

test("invalid selection and formatting or DOM update faults escape to the controller presentation boundary", () => {
  const f = fixture();
  assert.throws(() => f.publication.setSelection(-1), /Invalid semantic selection/u);
  assert.throws(() => f.publication.setSelection(f.facts.length), /Invalid semantic selection/u);
  const formatting = fixture({ throwPathText: true });
  assert.throws(() => formatting.publication.setSelection(0), /injected text staging failure/u);
  assert.equal(formatting.created[0].textContent, "");
  const creation = fixture({ throwCreate: "dl" });
  assert.throws(() => creation.publication.setSelection(0), /injected element creation failure/u);
  const update = fixture();
  const inspector = update.created[0];
  update.publication.setSelection(0);
  inspector.throwReplace = true;
  assert.throws(() => update.publication.setSelection(null), /injected DOM update failure/u);
  update.publication.rollback();
  assert.equal(inspector.hidden, true);
});

test("inspector styling keeps exact paths wrapped and isolated in a responsive, scrollable non-colour-only panel", async () => {
  const css = await readFile(new URL("../src/edge/shell.css", import.meta.url), "utf8");
  assert.match(css, /\[data-canonical-path\][^{]*\{[^}]*overflow-wrap:\s*anywhere;[^}]*unicode-bidi:\s*isolate;/su);
  assert.match(css, /\[data-inspector\][^{]*\{[^}]*overflow:\s*auto;/su);
  assert.match(css, /@media\s*\(max-width:\s*42rem\)[\s\S]*\[data-inspector\][^{]*\{[^}]*max-height:\s*58%;/u);
  assert.match(css, /\[data-inspector\]:focus-visible/u);
  assert.doesNotMatch(css, /\[data-(?:inspector|canonical-path)\][^{]*\{[^}]*outline:\s*none/su);
});
