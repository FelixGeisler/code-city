import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

const { parseStandaloneArguments } = await import("../src/edge/node/config.ts");
const { startInactiveHttpPerimeter } = await import("../src/edge/node/http-perimeter.ts");

function exchange(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const chunks = [];
    socket.on("connect", () => socket.end(request));
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => resolve(Buffer.concat(chunks)));
  });
}

function status(bytes) {
  return Number(/^HTTP\/1\.1 ([0-9]{3})/u.exec(bytes.toString("latin1"))?.[1]);
}

test("handler failure releases the reader and emits no prohibited diagnostics", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "code-city-native-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "public"), { recursive: true });
  const index = Buffer.from("fixture\n");
  await writeFile(path.join(root, "public", "index.html"), index);
  const manifest = Buffer.from(`${JSON.stringify({ version: 1, files: [{
    path: "public/index.html", role: "public", mediaType: "text/html; charset=utf-8",
    length: index.byteLength, sha256: createHash("sha256").update(index).digest("hex"),
  }] })}\n`);
  const configuration = parseStandaloneArguments([
    "--port", "0", "--max-live-sessions", "1", "--max-active-attempts", "1",
    "--max-command-body-readers", "1", "--max-command-body-bytes", "256",
    "--max-retained-source-bytes", "41943040",
  ]);
  const sentinel = "SESSION-123 ATTEMPT-456 owner/repository secret-source secret-result raw-internal-error";
  const server = await startInactiveHttpPerimeter({
    configuration, fixtureManifestBytes: manifest, artifactRoot: root,
    handlers: { "/_code-city/analyze": () => { throw new Error(sentinel); } },
  });
  t.after(() => server.close());
  const url = new URL(server.origin);
  const request = `POST /_code-city/analyze HTTP/1.1\r\nHost: ${url.host}\r\nOrigin: ${server.origin}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(JSON.stringify(sentinel))}\r\n\r\n${JSON.stringify(sentinel)}`;
  const first = await exchange(Number(url.port), request);
  const second = await exchange(Number(url.port), request);
  assert.equal(status(first), 500);
  assert.equal(status(second), 500);
  for (const bytes of [first, second]) {
    const text = bytes.toString("utf8");
    for (const prohibited of sentinel.split(" ")) assert.doesNotMatch(text, new RegExp(prohibited.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    assert.match(text, /Content-Length: 0/iu);
    assert.match(text, /Connection: close/iu);
  }
});
