import { createHash } from "node:crypto";

export const FIXTURE_REVISION = "a".repeat(40);
export function providerRequestLeaksPrivateHeaders(headers) {
  // CDP Network metadata includes Referer:"" for explicit no-referrer fetches.
  // Empty referrer carries no data; credentials and any nonempty referrer fail.
  return Object.entries(headers).some(([name,value])=>/^(authorization|cookie)$/iu.test(name)||(/^(referer|referrer)$/iu.test(name)&&value!==""));
}
const ROOT = "b".repeat(40);
const blob = bytes => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

function fixture(mode) {
  let rows = [
    ["a.js", "export function choose(v) { return v ? 1 : 0; }\n"],
    ["b.ts", "export const typed: number = 1;\n"],
    ["c.tsx", "export const view = <A/>;\n"],
    ["d.cs", "class C { int M() { return 1; } }\n"],
    ["empty.js", ""],
  ];
  if (mode === "unit-evidence") rows = [
    ["a.js", `const banner = '<img src=x onerror=globalThis.__sourceExecuted=true>😀';\nfunction outer(x) {\n if(x) { const inner = y => y ? 1 : 0; }\n return x && 1;\n}\n`],
    ["b.js", Array.from({ length: 40 }, (_, index) => `const f${index} = x => x;`).join("\n")],
    ["dense.js", "x&&x;".repeat(5000) + "/*" + "x".repeat(2_097_152 - 25_000 - 4) + "*/"],
  ];
  if (mode === "unit-evidence") {
    const lines = Array(1371).fill(""); lines[659] = "function long(x) {";
    for (let i = 0; i < 27; i++) lines[974 + i * 14] = " if(x) x--;";
    lines[1370] = "}"; rows.push(["long.js", lines.join("\n")], ["overlap.js", "function overlap(x) { return x && x && x; }\n"]);
  }
  if (mode === "districts") rows = rows.map(([name, text], index) => [index < 3 ? `src/edge/${index === 1 ? "deep/" : ""}${name}` : index === 3 ? `other/${name}` : name, text]);
  if (mode === "mixed") rows.push(["bad.js", "export const = ;"], ["nul.js", Buffer.from([0])]);
  if (mode === "all-failed") rows = [["invalid.js", Buffer.from([0xc3, 0x28])], ["nul.js", Buffer.from([0])]];
  if (mode === "progress") rows = [["a.js", rows[0][1]], ["b.js", "const b = 1;"], ["nul.js", Buffer.from([0])]];
  if (mode === "busy") rows = Array.from({ length: 8 }, (_, i) => [`busy${i}.js`, ";".repeat(1_000_000)]);
  if (mode === "window") rows = Array.from({ length: 12 }, (_, i) => [`${String(i).padStart(4, "0")}.js`, "export const value = 1;\n"]);
  if (mode === "maximum") {
    const maximum = "//" + "x".repeat(2_097_150);
    rows = Array.from({ length: 4000 }, (_, i) => [`matrix-${String(i).padStart(4, "0")}/src/file.js`, i < 20 ? maximum : ""]);
  }
  if (mode === "too-many") rows = Array.from({ length: 4001 }, (_, i) => [`${i}.js`, ""]);
  if (mode === "file-limit") rows = [["large.js", "//" + "x".repeat(2_097_151)]];
  if (mode === "raw-limit") rows = [["large.js", Buffer.alloc(4_194_308, 32)]];
  if (mode === "total-limit") rows = Array.from({ length: 21 }, (_, i) => [`${String(i).padStart(2, "0")}.js`, "//" + "x".repeat(2_097_150)]);
  const sources = new Map(rows.map(([name, text]) => { const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text); return [name, { bytes, sha: blob(bytes) }]; }));
  const directories = new Set();
  for (const name of sources.keys()) {
    const parts = name.split("/");
    for (let n = 1; n < parts.length; n += 1) directories.add(parts.slice(0, n).join("/"));
  }
  const tree = [
    ...[...directories].map(name => ({ path: name, mode: "040000", type: "tree", sha: ROOT })),
    ...[...sources].map(([name, source]) => ({ path: name, mode: "100644", type: "blob", sha: source.sha })),
  ];
  return { mode, sources, tree };
}

/** CDP-only synthetic provider. No production hook, source override, or server worker. */
export function createBrowserProviderHarness(cdp, origin, onFailure) {
  let selectedMode = "success";
  const workers = new Map();
  const pageWorkers = new Map();
  const networkOwners = new Map();
  const events = [];
  const waits = [];
  const held = new Map();
  const requests = [];
  const detached = new Set();
  const interceptions = new Map();
  const record = event => {
    events.push(event);
    for (const wait of [...waits]) if (wait.predicate(event)) {
      waits.splice(waits.indexOf(wait), 1); wait.resolve(event);
    }
  };
  const waitFor = predicate => {
    const found = events.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise(resolve => waits.push({ predicate, resolve }));
  };
  const send = async (method, params, sessionId) => {
    const owner = interceptions.get(params?.requestId);
    try { return await cdp.send(method, params, sessionId); }
    catch (error) {
      let detail = error;
      while (detail?.cause) detail = detail.cause;
      if ((method === "Fetch.fulfillRequest" || method === "Fetch.continueRequest" || method === "Fetch.failRequest") && owner
        && detail?.code === -32602 && detail.message === "Invalid InterceptionId.") {
        // Aborted provider/asset requests can disappear before CDP replies.
        // Require this actual worker to reach a terminal or detach; do not hide an unrelated RPC failure.
        await owner.ended.promise;
        record({ kind: "interception-cancelled", sessionId: owner.sessionId });
        return {};
      }
      throw error;
    } finally {
      if (method === "Fetch.fulfillRequest" || method === "Fetch.continueRequest" || method === "Fetch.failRequest") interceptions.delete(params?.requestId);
    }
  };
  async function fulfill(sessionId, requestId, bytes, mediaType, method = "GET", cors = true) {
    await send("Fetch.fulfillRequest", {
      requestId, responseCode: 200,
      responseHeaders: [
        { name: "Content-Type", value: mediaType },
        ...(cors ? [{ name: "Access-Control-Allow-Origin", value: "*" }, { name: "Access-Control-Allow-Headers", value: "x-github-api-version" }, { name: "Access-Control-Allow-Methods", value: "GET, OPTIONS" }] : []),
      ],
      body: method === "OPTIONS" ? "" : bytes.toString("base64"),
    }, sessionId);
  }
  async function handle(message) {
    const { method, params, sessionId } = message;
    if (method === "Target.attachedToTarget" && params.targetInfo.type === "worker") {
      const workerSession = params.sessionId;
      const state = { ...fixture(selectedMode), sessionId: workerSession, parentSessionId: sessionId, targetId: params.targetInfo.targetId, networkUrls: new Set(), ended: Promise.withResolvers() };
      workers.set(workerSession, state);
      pageWorkers.set(sessionId, state);
      await send("Runtime.enable", {}, workerSession);
      await send("Network.enable", { maxPostDataSize: 0 }, workerSession);
      await send("Runtime.addBinding", { name: "__codeCityEvidence" }, workerSession);
      await send("Runtime.evaluate", { expression: `(() => { const send = self.postMessage.bind(self); self.postMessage = (value, ...rest) => { self.__codeCityEvidence(JSON.stringify(value)); send(value, ...rest); }; })()` }, workerSession);
      await send("Runtime.runIfWaitingForDebugger", {}, workerSession);
      record({ kind: "worker", sessionId: workerSession, mode: state.mode });
      return;
    }
    if (method === "Target.detachedFromTarget") {
      detached.add(params.sessionId);
      workers.get(params.sessionId)?.ended.resolve();
      for (const [id, owner] of interceptions) if (owner.sessionId === params.sessionId) interceptions.delete(id);
      for (const [id, item] of held) if (item.ownerSessionId === params.sessionId) held.delete(id);
      for (const [page, worker] of pageWorkers) if (worker.sessionId === params.sessionId) pageWorkers.delete(page);
      record({ kind: "detached", sessionId: params.sessionId });
      return;
    }
    if (method === "Runtime.bindingCalled" && params.name === "__codeCityEvidence") {
      const value = JSON.parse(params.payload);
      if (["ANALYSIS_FAILED", "ANALYSIS_CANCELLED", "ANALYSIS_SUCCEEDED", "ANALYSIS_ALL_FILES_FAILED"].includes(value.type)) workers.get(sessionId)?.ended.resolve();
      record({ kind: "event", sessionId, value }); return;
    }
    if (method === "Runtime.bindingCalled" && params.name === "__codeCityDeliveryEvidence") {
      record({ kind: "delivery-held", sessionId, value: JSON.parse(params.payload) }); return;
    }
    if (method === "Network.requestWillBeSent") {
      const url = new URL(params.request.url);
      const state = workers.get(sessionId) ?? pageWorkers.get(sessionId);
      if (workers.has(sessionId)) {
        const owner = workers.get(sessionId);
        owner.networkUrls.add(params.request.url);
        networkOwners.set(params.requestId, owner);
      }
      // Observe EVERY page/worker request, including un-intercepted same-origin
      // routes. Network has maxPostDataSize:0: retain metadata, never binary bodies.
      requests.push({ url: url.href, method: params.request.method, worker: !!state, sessionId: state?.sessionId ?? sessionId, headers: params.request.headers });
      if (![origin, "https://api.github.com", "https://raw.githubusercontent.com"].includes(url.origin)) throw new Error("Unexpected observed network origin");
    }
    if (method !== "Fetch.requestPaused") return;
    const url = new URL(params.request.url);
    const state = networkOwners.get(params.networkId) ?? workers.get(sessionId) ?? pageWorkers.get(sessionId);
    const ownerSessionId = state?.sessionId;
    if (state) interceptions.set(params.requestId, state);
    if (state && detached.has(state.sessionId)) {
      // Fetch notifications use the page channel and can arrive after the
      // owning worker detached. Network.requestId preserves the real owner;
      // abort this cancelled request rather than assigning a replacement.
      await send("Fetch.failRequest", { requestId: params.requestId, errorReason: "Aborted" }, sessionId);
      record({ kind: "late-cancelled-request", sessionId: state.sessionId }); return;
    }
    if (url.origin === origin) {
      if (state?.mode === "parser-held" && url.pathname.startsWith("/parser/") && url.pathname.endsWith(".wasm")) {
        held.set(params.requestId, { sessionId, ownerSessionId, params, local: true }); record({ kind: "parser-held", sessionId: ownerSessionId }); return;
      }
      await send("Fetch.continueRequest", { requestId: params.requestId }, sessionId); return;
    }
    if (!state || !["https://api.github.com", "https://raw.githubusercontent.com"].includes(url.origin)) {
      await send("Fetch.failRequest", { requestId: params.requestId, errorReason: "BlockedByClient" }, sessionId);
      throw new Error(`Unexpected network origin or non-worker provider request: ${url.origin}`);
    }
    if (!["GET", "OPTIONS"].includes(params.request.method)) throw new Error("Unexpected provider request method");
    if (url.origin !== origin && state.mode === "no-provider") throw new Error("Reopen contacted GitHub");
    if (url.origin === "https://api.github.com" && !/^\/repos\/fixture\/(?:standalone|another)\//u.test(url.pathname)) throw new Error("Unexpected provider repository");
    if (params.request.method === "OPTIONS") {
      await fulfill(sessionId, params.requestId, Buffer.alloc(0), "application/json", "OPTIONS"); return;
    }
    let bytes;
    let mediaType = "application/json; charset=utf-8";
    if (url.origin === "https://api.github.com") {
      if (url.pathname.endsWith("/commits") && url.search === "?per_page=1&page=1") {
        if (state.mode === "revision-held") {
          held.set(params.requestId, { sessionId, ownerSessionId, params, bytes: Buffer.from(JSON.stringify([{ sha: FIXTURE_REVISION }])), mediaType });
          record({ kind: "revision-held", sessionId: ownerSessionId }); return;
        }
        bytes = Buffer.from(JSON.stringify([{ sha: FIXTURE_REVISION }]));
      } else if (url.pathname.includes("/branches/")) bytes = Buffer.from(JSON.stringify({ name: decodeURIComponent(url.pathname.split("/branches/")[1]), commit: { sha: FIXTURE_REVISION } }));
      else if (url.pathname.includes("/git/ref/tags/")) bytes = Buffer.from(JSON.stringify({ ref: `refs/tags/${decodeURIComponent(url.pathname.split("/git/ref/tags/")[1])}`, object: { type: "commit", sha: FIXTURE_REVISION } }));
      else if (url.pathname.endsWith(`/git/commits/${FIXTURE_REVISION}`)) bytes = Buffer.from(JSON.stringify({ sha: FIXTURE_REVISION, tree: { sha: ROOT } }));
      else if (url.pathname.endsWith(`/git/trees/${ROOT}`) && url.search === "?recursive=1") bytes = Buffer.from(JSON.stringify({ sha: ROOT, truncated: false, tree: state.tree }));
      else throw new Error(`Unexpected fixed provider route: ${url.pathname}`);
    } else {
      const prefix = /^\/fixture\/(?:standalone|another)\/a{40}\//u.exec(url.pathname)?.[0];
      if (!prefix || !url.pathname.startsWith(prefix)) throw new Error("Unexpected raw revision/path");
      const name = url.pathname.slice(prefix.length).split("/").map(decodeURIComponent).join("/");
      const source = state.sources.get(name);
      if (!source) throw new Error("Unexpected raw source");
      bytes = state.mode === "integrity" ? Buffer.from("corrupted") : source.bytes;
      mediaType = "text/plain; charset=utf-8";
      record({ kind: "raw", sessionId: ownerSessionId, name, mode: state.mode });
      if (state.mode === "window" && name === "0000.js") {
        held.set(params.requestId, { sessionId, ownerSessionId, params, bytes, mediaType }); record({ kind: "raw-held", sessionId: ownerSessionId }); return;
      }
    }
    await fulfill(sessionId, params.requestId, bytes, mediaType, "GET", state.mode !== "cors-failure");
    record({ kind: "fulfilled", sessionId: ownerSessionId, url: url.href });
  }
  const listener = message => {
    void handle(message).catch(error => {
      if (!detached.has(message.sessionId) && !detached.has(message.params?.sessionId)) onFailure(error);
    });
  };
  cdp.listeners.add(listener);
  return {
    events, requests, workers, held,
    setMode(mode) { selectedMode = mode; },
    waitFor,
    async attachPage(sessionId) {
      await send("Network.enable", { maxPostDataSize: 0 }, sessionId);
      await send("Fetch.enable", { patterns: ["https://api.github.com/*", "https://raw.githubusercontent.com/*", `${origin}/`, `${origin}/saved/*`, `${origin}/browser.js`, `${origin}/browser.css`, `${origin}/analysis-worker.js`, `${origin}/parser/*`].map(urlPattern => ({ urlPattern, requestStage: "Request" })) }, sessionId);
      await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
    },
    async release(sessionId) {
      for (const [id, item] of [...held]) {
        if (item.ownerSessionId !== sessionId) continue;
        held.delete(id);
        if (item.local) await send("Fetch.continueRequest", { requestId: id }, item.sessionId);
        else await fulfill(item.sessionId, id, item.bytes, item.mediaType);
      }
    },
    close() { cdp.listeners.delete(listener); },
  };
}
