import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test from "node:test";

class Element extends EventTarget {
  hidden = false; disabled = false; value = ""; textContent = ""; children = []; attributes = new Map(); open = false;
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this.textContent = ""; }
  setAttribute(key, value) { this.attributes.set(key, value); }
  removeAttribute(key) { this.attributes.delete(key); }
  contains(child) { return this.children.includes(child); }
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatchEvent(new Event("close")); }
}
const flush = () => new Promise(resolve => setImmediate(resolve));
let epoch = 0;
async function fixture(picker) {
  const elements = new Map();
  const node = selector => { if (!elements.has(selector)) elements.set(selector, new Element()); return elements.get(selector); };
  node("select[name=input-kind]").value = "working-tree";
  const state = { calls: [], view: undefined, restore: undefined, clears: 0, records: [] };
  const controller = {
    start() { state.calls.push(["start"]); },
    submit(...args) { state.calls.push(["submit", ...args]); },
    submitWorkingTree(...args) { state.calls.push(["local", ...args]); },
    openSaved(...args) { state.calls.push(["open", ...args]); },
    save() { state.calls.push(["save"]); return Promise.resolve(state.records[0]); },
    inspect() { throw new Error("Not used"); },
    fileSource(query) { state.calls.push(["fileSource", query]); return state.sourceReader?.(query) ?? Promise.reject(new Error("Source unavailable")); },
    dispose() {},
  };
  state.controller = controller;
  const originals = new Map();
  const set = (key, value) => { originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); };
  set("__shellFixture", state);
  set("document", { querySelector: node, createElement: () => new Element() });
  const window = new EventTarget(); window.isSecureContext = true; window.showDirectoryPicker = picker;
  set("window", window);
  set("history", { replaceState() {} });
  set("location", { pathname: "/", origin: "http://localhost" });
  set("fetch", () => { throw new Error("Shell must not upload source"); });
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (context.parentURL?.includes("standalone-browser-main.ts")) {
      const mocks = {
        "./standalone-browser-controller": "export function createStandaloneBrowserController(transport,view) { globalThis.__shellFixture.view = view; return globalThis.__shellFixture.controller; }",
        "./browser-worker-transport": "export function createBrowserWorkerTransport(factory,restore) { globalThis.__shellFixture.restore = restore; return {}; }",
        "./standalone-presentation-session": "export function createStandalonePresentationCoordinator() { const state=globalThis.__shellFixture; return {clear(){state.clears++;},publish(){return true;},dispose(){},failCurrent(){}}; }",
        "./browser-saved-investigations": "export async function listSavedInvestigations(){return globalThis.__shellFixture.records;} export function savedUrl(id){return 'http://localhost/saved/'+id;}",
      };
      if (mocks[specifier]) return { url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}`, shortCircuit: true };
    }
    return next(/^\.\.?\//u.test(specifier) && !/(?:\.[a-z]+|\?.*)$/iu.test(specifier) ? `${specifier}.ts` : specifier, context);
  } });
  try { await import(`../src/edge/standalone-browser-main.ts?shell=${++epoch}`); }
  catch (error) { hooks.deregister(); for (const [key, value] of originals) { if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key]; } throw error; }
  hooks.deregister();
  const click = selector => node(selector).dispatchEvent(new Event("click"));
  const submit = () => node("form").dispatchEvent(new Event("submit", { cancelable: true }));
  return { state, node, click, submit, close() { window.dispatchEvent(new Event("pagehide")); for (const [key, value] of originals) { if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key]; } } };
}

test("shell defaults to local-first setup with separate choose/Analyze and explicit shared-source Save notice", async () => {
  const html = await readFile(new URL("../standalone.html", import.meta.url), "utf8");
  assert.match(html, /value="working-tree" selected/u);
  assert.match(html, /type="button" data-choose-folder/u);
  assert.match(html, /type="submit">Analyze/u);
  assert.match(html, /data-github-setup hidden/u);
  assert.match(html, /Only Save uploads all admitted normalized source and results/u);
  assert.match(html, /No login: everyone reaching this instance can read/u);
});

test("read-only selection does not Analyze, read sources, upload or clear an existing completed view", async () => {
  let options;
  const root = { name: "Synthetic", values() { throw new Error("No UI traversal"); }, toJSON() { throw new Error("No JSON"); } };
  const f = await fixture(async value => { options = value; return root; });
  try {
    f.state.view.succeeded(1, {}, [], "a".repeat(40));
    const clears = f.state.clears;
    f.click("[data-choose-folder]"); await flush();
    assert.deepEqual(options, { mode: "read" });
    assert.equal(f.node("[data-folder-name]").textContent, "Synthetic");
    assert.deepEqual(f.state.calls, [["start"]]); assert.equal(f.state.clears, clears);
    f.submit();
    assert.deepEqual(f.state.calls.at(-1), ["local", root, "Synthetic", ""]);
    assert.equal(f.node("[data-origin-label]").textContent, "Working-tree capture");
    assert.equal(f.state.calls.some(([name]) => name === "save"), false);
  } finally { f.close(); }
});

test("unsupported, denied and cancelled selection leave completed output unchanged and GitHub usable", async () => {
  for (const picker of [undefined, async () => { throw new DOMException("private diagnostic", "NotAllowedError"); }, async () => { throw new DOMException("private diagnostic", "AbortError"); }]) {
    const f = await fixture(picker);
    try {
      f.state.view.succeeded(1, {}, [], "a".repeat(40));
      const clears = f.state.clears;
      f.click("[data-choose-folder]"); await flush();
      assert.equal(f.state.clears, clears); assert.deepEqual(f.state.calls, [["start"]]);
      assert.doesNotMatch(f.node("[data-folder-status]").textContent, /private diagnostic/u);
      f.submit(); assert.deepEqual(f.state.calls, [["start"]]);
      f.node("select[name=input-kind]").value = "github";
      f.node("select[name=input-kind]").dispatchEvent(new Event("change"));
      f.node("input[name=repository]").value = "https://github.com/fixture/repo"; f.submit();
      assert.deepEqual(f.state.calls.at(-1), ["submit", "https://github.com/fixture/repo", ""]);
    } finally { f.close(); }
  }
});

test("late picker completion cannot overwrite changed input or start work", async () => {
  let resolve;
  const f = await fixture(() => new Promise(accepted => { resolve = accepted; }));
  try {
    f.click("[data-choose-folder]");
    f.node("select[name=input-kind]").value = "github"; f.node("select[name=input-kind]").dispatchEvent(new Event("change"));
    resolve({ name: "Stale" }); await flush();
    assert.notEqual(f.node("[data-folder-name]").textContent, "Stale");
    assert.deepEqual(f.state.calls, [["start"]]);
  } finally { f.close(); }
});

test("valid-text failures expose bounded source without fabricated units; unsupported text has no source action", async () => {
  const f = await fixture(undefined);
  try {
    const failures = [{ canonicalPath: "broken.ts", category: "Syntax could not be analyzed" }, { canonicalPath: "metric.ts", category: "Metrics could not be computed" }, { canonicalPath: "unsupported.ts", category: "Source text is not supported" }];
    const text = "<script>not executed</script>😀";
    const next = new TextEncoder().encode(text).length;
    f.state.sourceReader = async query => ({ ...query, next: query.cursor === 0 ? next : null, text });
    f.state.view.allFilesFailed(1, failures, "c".repeat(64));
    const rows = f.node("[data-failed-rows]").children;
    assert.equal(rows[0].children[2].textContent, "View source");
    assert.equal(rows[1].children[2].textContent, "View source"); assert.equal(rows[2].children.length, 2);
    rows[0].children[2].dispatchEvent(new Event("click")); await flush();
    assert.deepEqual(f.state.calls.at(-1), ["fileSource", { path: "broken.ts", cursor: 0 }]);
    assert.equal(f.node("[data-failed-source-code]").textContent, text);
    f.click("[data-failed-source-next]"); await flush();
    assert.deepEqual(f.state.calls.at(-1), ["fileSource", { path: "broken.ts", cursor: next }]);
    assert.equal(f.node("[data-failed-source-next]").disabled, true);
    f.click("[data-failed-source-previous]"); await flush();
    assert.deepEqual(f.state.calls.at(-1), ["fileSource", { path: "broken.ts", cursor: 0 }]);
    assert.equal(f.state.calls.some(([name]) => name === "save"), false);
    f.state.view.clear();
    const before = f.state.calls.length;
    rows[0].children[2].dispatchEvent(new Event("click"));
    assert.equal(f.state.calls.length, before, "detached failure action is stale");
  } finally { f.close(); }
});

test("late failed-source replies cannot repaint a closed or replaced investigation", async () => {
  const f = await fixture(undefined);
  try {
    let resolve;
    f.state.sourceReader = () => new Promise(accepted => { resolve = accepted; });
    f.state.view.allFilesFailed(1, [{ canonicalPath: "broken.ts", category: "Syntax could not be analyzed" }], "c".repeat(64));
    f.node("[data-failed-rows]").children[0].children[2].dispatchEvent(new Event("click"));
    f.state.view.clear(); resolve({ path: "broken.ts", cursor: 0, next: null, text: "stale private text" }); await flush();
    assert.equal(f.node("[data-failed-source-code]").textContent, "");
    assert.equal(f.node("[data-failed-source]").open, false);
  } finally { f.close(); }
});

test("restoring local origin never reopens the folder and groups saved local/GitHub names separately", async () => {
  let picked = 0;
  const f = await fixture(async () => { picked++; return { name: "Original" }; });
  try {
    f.click("[data-choose-folder]"); await flush();
    const record = { id: "S".repeat(43), kind: "working-tree", repository: "same", ref: "working tree", revision: "c".repeat(64), savedAt: "now" };
    f.state.restore({ kind: "working-tree", name: "same", captureId: record.revision }, record, []);
    assert.equal(picked, 1); assert.equal(f.node("input[name=repository]").value, "");
    assert.equal(f.node("[data-origin-label]").textContent, "Working-tree capture");
    f.submit(); assert.deepEqual(f.state.calls, [["start"]]);
    assert.match(f.node("[data-folder-status]").textContent, /Choose a folder/u);
    f.state.records = [record, { ...record, kind: "github", ref: "main" }];
    f.click("[data-open-saved]"); await flush();
    assert.equal(f.node("[data-saved-projects]").children.length, 2);
  } finally { f.close(); }
});
