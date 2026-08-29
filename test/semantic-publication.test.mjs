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
  }
  set textContent(value) {
    if (this.throwText) throw new Error("injected text staging failure");
    this.value = String(value);
    this.children = [];
  }
  get textContent() {
    return this.children.length ? this.children.map((child) => child.textContent ?? "").join("") : this.value;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  append(child) { child.parent = this; this.children.push(child); }
  replaceChildren(...children) {
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

function fixture(options = {}) {
  const root = new FakeElement("section");
  const revision = new FakeElement("output");
  const created = [];
  const documentTarget = {
    createElement(tagName) {
      const element = new FakeElement(tagName, { throwText: options.throwPathText && tagName === "bdi" });
      created.push(element);
      return element;
    },
  };
  const facts = [
    { canonicalPath: "paths/<img src=x>&.js", S: 0, U: 0, M: 0 },
    { canonicalPath: "paths/A.js", S: 0, U: 0, M: 0 },
    { canonicalPath: "paths/a.js", S: 0, U: 0, M: 0 },
    { canonicalPath: "paths/bidi-\u202E-token.js", S: 0, U: 0, M: 0 },
    { canonicalPath: "paths/café-東京.js", S: 0, U: 0, M: 0 },
  ];
  return { root, revision, created, facts, publication: stageSemanticPublication(documentTarget, root, revision, "a".repeat(40), facts) };
}

test("semantic publication stages one hidden polite path region and commits it atomically with the canvas", () => {
  const f = fixture();
  const [inspector, path] = f.created;
  assert.deepEqual(f.root.children, []);
  assert.equal(inspector.tagName, "SECTION");
  assert.deepEqual(inspector.dataset, { inspector: "" });
  assert.equal(inspector.attributes.get("role"), "status");
  assert.equal(inspector.attributes.get("aria-live"), "polite");
  assert.equal(inspector.attributes.get("aria-atomic"), "true");
  assert.equal(inspector.hidden, true);
  assert.equal(path.tagName, "BDI");
  assert.deepEqual(path.dataset, { canonicalPath: "" });
  assert.equal(path.textContent, "");

  const canvas = { remove() {} };
  f.publication.commit(canvas);
  assert.deepEqual(f.root.children, [canvas, inspector]);
  assert.equal(f.revision.textContent, "a".repeat(40));
});

test("all selected adversarial canonical paths are inert complete text and clear without residual content", () => {
  const f = fixture();
  const inspector = f.created[0];
  const path = f.created[1];
  const canvas = { remove() {} };
  f.publication.commit(canvas);
  for (const [index, fact] of f.facts.entries()) {
    f.publication.setSelection(index);
    assert.equal(inspector.hidden, false);
    assert.equal(path.textContent, fact.canonicalPath);
    assert.equal(inspector.textContent, fact.canonicalPath);
    assert.deepEqual(path.children, [], fact.canonicalPath);
  }
  f.publication.setSelection(null);
  assert.equal(inspector.hidden, true);
  assert.equal(path.textContent, "");
  f.publication.rollback();
  f.publication.rollback();
  assert.deepEqual(f.root.children, [canvas]);
  assert.equal(f.revision.textContent, "");
});

test("selection rejects out-of-range indices and exposes text staging failure to the controller boundary", () => {
  const f = fixture();
  assert.throws(() => f.publication.setSelection(-1), /Invalid semantic selection/u);
  assert.throws(() => f.publication.setSelection(f.facts.length), /Invalid semantic selection/u);
  const failing = fixture({ throwPathText: true });
  assert.throws(() => failing.publication.setSelection(0), /injected text staging failure/u);
});

test("path styling requires wrapping and bidi isolation without selection outlines", async () => {
  const css = await readFile(new URL("../src/edge/shell.css", import.meta.url), "utf8");
  assert.match(css, /\[data-inspector\][^{]*\{[^}]*overflow-wrap:\s*anywhere;/su);
  assert.match(css, /\[data-canonical-path\][^{]*\{[^}]*unicode-bidi:\s*isolate;/su);
  assert.doesNotMatch(css, /\[data-(?:inspector|canonical-path)\][^{]*\{[^}]*outline:/su);
});
