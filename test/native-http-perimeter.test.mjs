import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(/^\.\.?\//u.test(specifier) && !/(?:\.[a-z]+|\?.*)$/iu.test(specifier) ? `${specifier}.ts` : specifier, context);
  },
});

const { canonicalAuthority, parseStandaloneArguments, validateCanonicalHost } = await import("../src/edge/node/config.ts");
const { parseFixtureManifest, validateFixtureManifest } = await import("../src/edge/node/fixture-manifest.ts");
const { RESPONSE_SECURITY_HEADERS, startInactiveHttpPerimeter } = await import("../src/edge/node/http-perimeter.ts");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const requiredArguments = [
  "--port", "0",
  "--max-live-sessions", "2",
  "--max-active-attempts", "1",
  "--max-command-body-readers", "1",
  "--max-command-body-bytes", "16",
  "--max-retained-source-bytes", "41943040",
];

function args(...prefix) {
  return [...prefix, ...requiredArguments];
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "code-city-native-http-"));
  const publicDirectory = path.join(root, "public");
  await mkdir(publicDirectory, { recursive: true });
  const files = new Map([
    ["public/app.js", Buffer.from("export default 1;\n")],
    ["public/index.html", Buffer.from("<!doctype html><title>fixture</title>\n")],
  ]);
  for (const [relativePath, bytes] of files) await writeFile(path.join(root, ...relativePath.split("/")), bytes);
  const records = [
    { path: "parser/runtime.wasm", role: "private", mediaType: "application/wasm", length: 99, sha256: "1".repeat(64) },
    { path: "public/app.js", role: "public", mediaType: "text/javascript; charset=utf-8", length: files.get("public/app.js").byteLength, sha256: sha256(files.get("public/app.js")) },
    { path: "public/index.html", role: "public", mediaType: "text/html; charset=utf-8", length: files.get("public/index.html").byteLength, sha256: sha256(files.get("public/index.html")) },
    { path: "server/private.js", role: "private", mediaType: "text/javascript; charset=utf-8", length: 100, sha256: "2".repeat(64) },
  ];
  const manifest = { version: 1, files: records };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  return { root, files, manifest, manifestBytes };
}

async function running(t, options = {}) {
  const controlled = await fixture();
  t.after(() => rm(controlled.root, { recursive: true, force: true }));
  const configuration = parseStandaloneArguments(options.arguments ?? requiredArguments);
  const server = await startInactiveHttpPerimeter({
    configuration,
    fixtureManifestBytes: controlled.manifestBytes,
    artifactRoot: controlled.root,
    handlers: options.handlers,
  });
  t.after(() => server.close());
  const url = new URL(server.origin);
  return { ...controlled, ...server, port: Number(url.port), authority: url.host };
}

function rawExchange(port, request, { end = true } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const chunks = [];
    socket.on("connect", () => {
      socket.write(request);
      if (end) socket.end();
    });
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => resolve(Buffer.concat(chunks)));
  });
}

function responseParts(bytes) {
  const marker = bytes.indexOf("\r\n\r\n");
  assert.notEqual(marker, -1, bytes.toString("latin1"));
  const head = bytes.subarray(0, marker).toString("latin1");
  const lines = head.split("\r\n");
  const headers = new Map();
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(":");
    if (separator >= 0) headers.set(line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim());
  }
  return { status: Number(lines[0].split(" ")[1]), headers, body: bytes.subarray(marker + 4) };
}

function assertSecurity(headers) {
  for (const [name, value] of Object.entries(RESPONSE_SECURITY_HEADERS)) assert.equal(headers.get(name.toLowerCase()), value);
  assert.equal(headers.has("access-control-allow-origin"), false);
}

function ordinary(origin, { method = "GET", path: target = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${origin}${target.slice(1)}`, { method, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

test("CLI parsing enforces the exact token grammar, defaults, numeric bounds, and cross-capacity rules", () => {
  assert.deepEqual(parseStandaloneArguments(requiredArguments), {
    host: "127.0.0.1", canonicalHost: "127.0.0.1", port: 0,
    maxLiveSessions: 2, maxActiveAttempts: 1, maxCommandBodyReaders: 1,
    maxCommandBodyBytes: 16, maxRetainedSourceBytes: 41_943_040,
  });
  assert.equal(parseStandaloneArguments(args("--host", "127.0.0.1")).canonicalHost, "127.0.0.1");
  assert.equal(parseStandaloneArguments(args("--host", "0.0.0.0", "--canonical-host", "city.example")).canonicalHost, "city.example");

  const invalid = [
    [], ["--port=0", ...requiredArguments.slice(2)], ["-p", "0", ...requiredArguments.slice(2)],
    ["value", ...requiredArguments], ["--", "value", ...requiredArguments], ["--unknown", "x", ...requiredArguments],
    ["--port", "0", ...requiredArguments], ["--port", "", ...requiredArguments.slice(2)],
    ["--canonical-host", "localhost", ...requiredArguments],
    args("--host", "localhost"), args("--host", "127.0.0.1", "--canonical-host", "127.0.0.1"),
  ];
  for (const candidate of invalid) assert.throws(() => parseStandaloneArguments(candidate));

  for (const value of ["-1", "+1", "01", " 1", "1 ", "1.0", "1e1", "1_0", "9007199254740992"]) {
    const candidate = [...requiredArguments];
    candidate[candidate.indexOf("--max-live-sessions") + 1] = value;
    assert.throws(() => parseStandaloneArguments(candidate), value);
  }
  for (const [flag, value] of [["--port", "65536"], ["--max-live-sessions", "0"], ["--max-retained-source-bytes", "41943039"]]) {
    const candidate = [...requiredArguments];
    candidate[candidate.indexOf(flag) + 1] = value;
    assert.throws(() => parseStandaloneArguments(candidate), `${flag} ${value}`);
  }
  const crossed = [...requiredArguments];
  crossed[crossed.indexOf("--max-active-attempts") + 1] = "3";
  assert.throws(() => parseStandaloneArguments(crossed));

  let listenCalled = false;
  const parseBeforeListen = (candidate) => { const value = parseStandaloneArguments(candidate); listenCalled = true; return value; };
  assert.throws(() => parseBeforeListen(["--port", "not-a-port"]));
  assert.equal(listenCalled, false);
});

test("canonical authorities accept only exact DNS, IPv4, and RFC 5952 IPv6 forms", () => {
  for (const value of ["localhost", "city.example", "xn--bcher-kva.example", "192.0.2.1", "[2001:db8::1]", "[::1]"]) {
    assert.equal(validateCanonicalHost(value), value);
  }
  assert.equal(canonicalAuthority("city.example", 80), "city.example");
  assert.equal(canonicalAuthority("[::1]", 8080), "[::1]:8080");
  for (const value of [
    "City.example", "city.example.", "-city.example", "city-.example", "city..example", "é.example",
    "192.168.001.1", "256.0.0.1", "1.2.3", "0.0.0.0", "[::]", "[2001:0db8::1]",
    "[2001:DB8::1]", "[fe80::1%25eth0]", "city.example:80", "user@city.example", "city.example/path",
    "city.example?x", "city.example#x", "city%2eexample", "city example", "city\n.example",
  ]) assert.throws(() => validateCanonicalHost(value), value);
});

test("fixture manifest parsing is canonical, exact, ordered, and verifies public bytes before listening", async (t) => {
  const controlled = await fixture();
  t.after(() => rm(controlled.root, { recursive: true, force: true }));
  assert.deepEqual(parseFixtureManifest(controlled.manifestBytes), controlled.manifest);

  const mutations = [
    Buffer.from(JSON.stringify(controlled.manifest)),
    Buffer.from(`\ufeff${JSON.stringify(controlled.manifest)}\n`),
    Buffer.from(`${JSON.stringify({ files: controlled.manifest.files, version: 1 })}\n`),
    Buffer.from(`${JSON.stringify({ ...controlled.manifest, extra: true })}\n`),
    Buffer.from(`${JSON.stringify({ version: 2, files: controlled.manifest.files })}\n`),
    Buffer.from(`${JSON.stringify({ version: 1, files: [...controlled.manifest.files].reverse() })}\n`),
  ];
  for (const bytes of mutations) assert.throws(() => parseFixtureManifest(bytes));

  const changes = [
    (value) => { value.files[0].path = "parser/../x.wasm"; },
    (value) => { value.files[0].role = "public"; },
    (value) => { value.files[1].mediaType = "application/javascript"; },
    (value) => { value.files[1].length = -1; },
    (value) => { value.files[1].sha256 = "A".repeat(64); },
    (value) => { value.files.splice(value.files.findIndex((record) => record.path === "public/index.html"), 1); },
    (value) => { value.files[1].path = "public/file.txt"; },
    (value) => { value.files[1] = { role: value.files[1].role, path: value.files[1].path, mediaType: value.files[1].mediaType, length: value.files[1].length, sha256: value.files[1].sha256 }; },
  ];
  for (const mutate of changes) {
    const value = structuredClone(controlled.manifest);
    mutate(value);
    assert.throws(() => validateFixtureManifest(value));
  }
  const sparse = structuredClone(controlled.manifest);
  delete sparse.files[1];
  assert.throws(() => validateFixtureManifest(sparse));
  const extraArrayProperty = structuredClone(controlled.manifest);
  extraArrayProperty.files.extra = true;
  assert.throws(() => validateFixtureManifest(extraArrayProperty));

  const wrongLength = structuredClone(controlled.manifest);
  wrongLength.files[1].length += 1;
  await assert.rejects(() => startInactiveHttpPerimeter({
    configuration: parseStandaloneArguments(requiredArguments),
    fixtureManifestBytes: Buffer.from(`${JSON.stringify(wrongLength)}\n`), artifactRoot: controlled.root,
  }), /length/u);
  const wrongDigest = structuredClone(controlled.manifest);
  wrongDigest.files[1].sha256 = "0".repeat(64);
  await assert.rejects(() => startInactiveHttpPerimeter({
    configuration: parseStandaloneArguments(requiredArguments),
    fixtureManifestBytes: Buffer.from(`${JSON.stringify(wrongDigest)}\n`), artifactRoot: controlled.root,
  }), /digest/u);
});

test("wildcard binding uses only the explicit canonical authority without reverse lookup", async (t) => {
  const server = await running(t, { arguments: args("--host", "0.0.0.0", "--canonical-host", "city.example") });
  assert.match(server.origin, /^http:\/\/city\.example:[1-9][0-9]*$/u);
  const response = responseParts(await rawExchange(server.port, `GET / HTTP/1.1\r\nHost: ${server.authority}\r\nConnection: close\r\n\r\n`));
  assert.equal(response.status, 200);
});

test("port-zero startup derives one exact origin, serves only exact public records, and closes cleanly", async (t) => {
  const server = await running(t);
  assert.match(server.origin, /^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/u);

  const root = await ordinary(`${server.origin}/`);
  assert.equal(root.status, 200);
  assert.deepEqual(root.body, server.files.get("public/index.html"));
  assert.equal(root.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(root.headers["content-length"], String(root.body.byteLength));
  assertSecurity(new Map(Object.entries(root.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(", ") : value])));

  const head = await ordinary(`${server.origin}/`, { method: "HEAD", path: "/app.js" });
  assert.equal(head.status, 200);
  assert.equal(head.body.byteLength, 0);
  assert.equal(head.headers["content-length"], String(server.files.get("public/app.js").byteLength));
  for (const target of ["/index.html", "/package-manifest.json", "/private.js", "/runtime.wasm", "/missing.js"]) {
    assert.equal((await ordinary(`${server.origin}/`, { path: target })).status, 404, target);
  }
  const negotiated = await ordinary(`${server.origin}/`, { path: "/app.js", headers: { Range: "bytes=0-1", "Accept-Encoding": "gzip" } });
  assert.equal(negotiated.status, 200);
  assert.deepEqual(negotiated.body, server.files.get("public/app.js"));
  assert.equal(negotiated.headers["content-encoding"], undefined);
  assert.equal(negotiated.headers["content-range"], undefined);
  await server.close();
  await assert.rejects(() => ordinary(`${server.origin}/`));
});

test("ordinary and alternate ingress enforce status precedence, exact headers, and empty closing errors", async (t) => {
  const server = await running(t);
  const request = (line, headers = [], body = "") => rawExchange(server.port, `${line}\r\n${headers.join("\r\n")}\r\n\r\n${body}`);
  const validHost = `Host: ${server.authority}`;
  const validOrigin = `Origin: ${server.origin}`;

  const cases = [
    ["GET / HTTP/1.1", [], 400],
    ["GET / HTTP/1.1", [validHost, `Host: ${server.authority}`], 400],
    ["GET / HTTP/1.1", ["Host: wrong.invalid"], 400],
    ["GET / HTTP/1.1", [`Host: ${server.authority} `], 400],
    ["GET /a%2fb HTTP/1.1", [validHost], 400],
    ["GET // HTTP/1.1", [validHost], 400],
    ["GET /missing HTTP/1.1", [validHost], 404],
    ["POST / HTTP/1.1", [validHost], 405],
    ["GET / HTTP/1.1", [validHost, "Origin: http://wrong.invalid"], 403],
    ["GET / HTTP/1.1", [validHost, `Origin: ${server.origin} `], 403],
    ["POST /_code-city/analyze HTTP/1.1", [validHost, "Content-Type: text/plain"], 403],
    ["POST /_code-city/analyze HTTP/1.1", [validHost, validOrigin], 415],
    ["POST /_code-city/analyze HTTP/1.1", [validHost, validOrigin, "Content-Type: application/json; charset=utf-8"], 415],
    ["POST /_code-city/analyze HTTP/1.1", [validHost, validOrigin, "Content-Type: application/json "], 415],
    ["POST /_code-city/analyze HTTP/1.1", [validHost, validOrigin, "Content-Type: application/json", "Expect: something"], 417],
  ];
  for (const [line, headers, status] of cases) {
    const response = responseParts(await request(line, headers));
    assert.equal(response.status, status, line);
    assert.equal(response.body.byteLength, 0, line);
    assert.equal(response.headers.get("connection"), "close", line);
    assertSecurity(response.headers);
  }

  for (const ingress of [
    `GET / HTTP/1.1\r\n${validHost}\r\nConnection: Upgrade\r\nUpgrade: example\r\n\r\n`,
    `CONNECT example.test:80 HTTP/1.1\r\n${validHost}\r\n\r\n`,
    `POST /_code-city/analyze HTTP/1.1\r\n${validHost}\r\n${validOrigin}\r\nContent-Type: application/json\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\n{}`,
  ]) {
    const response = responseParts(await rawExchange(server.port, ingress));
    assert.equal(response.status, 400);
    assert.equal(response.body.byteLength, 0);
    assert.equal(response.headers.get("connection"), "close");
    assertSecurity(response.headers);
  }

  const forwarded = await request("GET / HTTP/1.1", [validHost, "Forwarded: host=wrong.invalid", "X-Forwarded-Host: wrong.invalid"]);
  assert.equal(responseParts(forwarded).status, 200);
});

test("unavailable reserved routes classify expectations without readers or provisional state", async (t) => {
  const server = await running(t);
  const base = `Host: ${server.authority}\r\nOrigin: ${server.origin}\r\nContent-Type: application/json`;
  const unsupported = responseParts(await rawExchange(server.port, `POST /_code-city/analyze HTTP/1.1\r\n${base}\r\nExpect: custom\r\n\r\n`));
  assert.equal(unsupported.status, 417);

  const continued = responseParts(await rawExchange(server.port, `POST /_code-city/analyze HTTP/1.1\r\n${base}\r\nExpect: 100-continue\r\nContent-Length: 999\r\n\r\n`));
  assert.equal(continued.status, 404);
  assert.doesNotMatch(continued.body.toString("latin1"), /100 Continue/u);

  for (const contentLength of ["01", "999999"]) {
    const unavailable = responseParts(await rawExchange(server.port, `POST /_code-city/analyze HTTP/1.1\r\n${base}\r\nContent-Length: ${contentLength}\r\n\r\n`));
    assert.equal(unavailable.status, 404, contentLength);
  }
  for (const target of ["session", "analyze", "cancel", "discard"]) {
    const media = target === "session" ? "" : "Content-Type: application/json\r\n";
    const unavailable = responseParts(await rawExchange(server.port, `POST /_code-city/${target} HTTP/1.1\r\nHost: ${server.authority}\r\nOrigin: ${server.origin}\r\n${media}Content-Length: 999999\r\n\r\n`));
    assert.equal(unavailable.status, 404, target);
  }
});

test("installed handlers receive only complete bounded bodies and 100 Continue follows admission", async (t) => {
  const calls = [];
  const server = await running(t, { handlers: {
    "/_code-city/session": (value) => calls.push(["session", value]),
    "/_code-city/analyze": (value) => calls.push(["analyze", value]),
  } });
  const common = `Host: ${server.authority}\r\nOrigin: ${server.origin}`;

  const emptySession = responseParts(await rawExchange(server.port, `POST /_code-city/session HTTP/1.1\r\n${common}\r\nContent-Length: 0\r\n\r\n`));
  assert.equal(emptySession.status, 204);
  assert.deepEqual(calls, [["session", undefined]]);
  const nonemptySession = responseParts(await rawExchange(server.port, `POST /_code-city/session HTTP/1.1\r\n${common}\r\nContent-Length: 1\r\n\r\nx`));
  assert.equal(nonemptySession.status, 400);
  assert.equal(calls.length, 1);

  const split = await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: server.port });
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => resolve(Buffer.concat(chunks)));
    socket.on("connect", () => {
      const body = Buffer.from('{"x":"é"}', "utf8");
      socket.write(`POST /_code-city/analyze HTTP/1.1\r\n${common}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n`);
      socket.write(Buffer.concat([Buffer.from("7\r\n"), body.subarray(0, 7), Buffer.from("\r\n")]));
      socket.write(Buffer.concat([Buffer.from("3\r\n"), body.subarray(7), Buffer.from("\r\n0\r\n\r\n")]));
    });
  });
  assert.equal(responseParts(split).status, 204);
  assert.deepEqual(calls.at(-1), ["analyze", { x: "é" }]);

  const beforeFailures = calls.length;
  for (const [body, expected] of [[Buffer.from([0xff]), 400], [Buffer.from("{"), 400], [Buffer.from("0123456789abcdefx"), 413]]) {
    const response = responseParts(await rawExchange(server.port, Buffer.concat([
      Buffer.from(`POST /_code-city/analyze HTTP/1.1\r\n${common}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n${body.length.toString(16)}\r\n`),
      body, Buffer.from("\r\n0\r\n\r\n"),
    ])));
    assert.equal(response.status, expected);
  }
  assert.equal(calls.length, beforeFailures);

  const expectResponse = await new Promise((resolve, reject) => {
    const request = http.request(`${server.origin}/_code-city/analyze`, {
      method: "POST",
      headers: { Origin: server.origin, "Content-Type": "application/json", "Content-Length": "2", Expect: "100-continue" },
    });
    let continued = false;
    request.on("continue", () => { continued = true; request.end("{}"); });
    request.on("response", (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, continued, body: Buffer.concat(chunks) }));
    });
    request.on("error", reject);
    request.flushHeaders();
  });
  assert.equal(expectResponse.status, 204);
  assert.equal(expectResponse.continued, true);
  assert.deepEqual(expectResponse.body, Buffer.alloc(0));
  assertSecurity(new Map(Object.entries(expectResponse.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(", ") : value])));
  assert.deepEqual(calls.at(-1), ["analyze", {}]);
});

test("reader exhaustion, abort release, application framing, and pipelined rejection fail closed", async (t) => {
  let calls = 0;
  const server = await running(t, { handlers: { "/_code-city/analyze": () => { calls += 1; } } });
  const headers = `POST /_code-city/analyze HTTP/1.1\r\nHost: ${server.authority}\r\nOrigin: ${server.origin}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n`;
  const held = net.createConnection({ host: "127.0.0.1", port: server.port });
  await new Promise((resolve, reject) => { held.once("connect", resolve); held.once("error", reject); });
  held.write(`${headers}1\r\n{\r\n`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const common = `Host: ${server.authority}\r\nOrigin: ${server.origin}\r\nContent-Type: application/json`;
  const malformedBeforeExhaustionBytes = await rawExchange(server.port, `POST /_code-city/analyze HTTP/1.1\r\n${common}\r\nExpect: 100-continue\r\nContent-Length: 02\r\n\r\n`);
  assert.equal(responseParts(malformedBeforeExhaustionBytes).status, 400);
  assert.doesNotMatch(malformedBeforeExhaustionBytes.toString("latin1"), /100 Continue/u);
  const exhaustedBytes = await rawExchange(server.port, `POST /_code-city/analyze HTTP/1.1\r\n${common}\r\nExpect: 100-continue\r\nContent-Length: 2\r\n\r\n{}`);
  assert.equal(responseParts(exhaustedBytes).status, 503);
  assert.doesNotMatch(exhaustedBytes.toString("latin1"), /100 Continue/u);
  const unavailableDuringExhaustion = responseParts(await rawExchange(server.port, `POST /_code-city/cancel HTTP/1.1\r\n${common}\r\nContent-Length: 999\r\n\r\n`));
  assert.equal(unavailableDuringExhaustion.status, 404);
  held.destroy();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const afterAbort = responseParts(await rawExchange(server.port, `${headers}2\r\n{}\r\n0\r\n\r\n`));
  assert.equal(afterAbort.status, 204);
  assert.equal(calls, 1);

  const noncanonical = responseParts(await rawExchange(server.port, `POST /_code-city/analyze HTTP/1.1\r\nHost: ${server.authority}\r\nOrigin: ${server.origin}\r\nContent-Type: application/json\r\nContent-Length: 02\r\n\r\n{}`));
  assert.equal(noncanonical.status, 400);
  const oversizedBytes = await rawExchange(server.port, `POST /_code-city/analyze HTTP/1.1\r\nHost: ${server.authority}\r\nOrigin: ${server.origin}\r\nContent-Type: application/json\r\nExpect: 100-continue\r\nContent-Length: 17\r\n\r\n`);
  assert.equal(responseParts(oversizedBytes).status, 413);
  assert.doesNotMatch(oversizedBytes.toString("latin1"), /100 Continue/u);

  const beforeDeception = calls;
  const shortDeclared = responseParts(await rawExchange(server.port, `POST /_code-city/analyze HTTP/1.1\r\nHost: ${server.authority}\r\nOrigin: ${server.origin}\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}x`));
  assert.equal(shortDeclared.status, 400);
  const longDeclared = responseParts(await rawExchange(server.port, `POST /_code-city/analyze HTTP/1.1\r\nHost: ${server.authority}\r\nOrigin: ${server.origin}\r\nContent-Type: application/json\r\nContent-Length: 3\r\n\r\n{}`));
  assert.equal(longDeclared.status, 400);
  assert.equal(calls, beforeDeception);

  const beforePipeline = calls;
  const pipeline = [
    `POST /_code-city/analyze HTTP/1.1\r\nHost: ${server.authority}\r\nOrigin: http://wrong.invalid\r\nContent-Type: application/json\r\nContent-Length: 0\r\n\r\n`,
    `POST /_code-city/analyze HTTP/1.1\r\nHost: ${server.authority}\r\nOrigin: ${server.origin}\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}`,
  ].join("");
  const rejected = responseParts(await rawExchange(server.port, pipeline));
  assert.equal(rejected.status, 403);
  assert.equal(calls, beforePipeline);
});
