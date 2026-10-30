import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(/^\.\.?\//u.test(specifier) && !/\.[a-z]+$/iu.test(specifier) ? `${specifier}.ts` : specifier, context);
} });
const { parseAssetHostArguments } = await import("../src/edge/node/config.ts");

test("static host requires only a port and has no analysis-capacity options", () => {
  assert.deepEqual(parseAssetHostArguments(["--port", "0"]), { host: "127.0.0.1", canonicalHost: "127.0.0.1", port: 0 });
  assert.deepEqual(parseAssetHostArguments(["--host", "0.0.0.0", "--canonical-host", "code-city.example", "--port", "8080"]), { host: "0.0.0.0", canonicalHost: "code-city.example", port: 8080 });
  for (const flag of ["--max-live-sessions", "--max-active-attempts", "--max-command-body-readers", "--max-command-body-bytes", "--max-retained-source-bytes"])
    assert.throws(() => parseAssetHostArguments(["--port", "0", flag, "1"]), /Invalid standalone/);
});

test("static host retains strict port, canonical-host, duplicate and malformed-argument rejection", () => {
  for (const args of [[], ["--port"], ["--port", "-1"], ["--port", "65536"], ["--port", "01"], ["--port", "0", "--port", "1"], ["--port", "0", "--host", "0.0.0.0"], ["--port", "0", "--canonical-host", "localhost"], ["--host", "0.0.0.0", "--canonical-host", "evil.example/path", "--port", "0"]])
    assert.throws(() => parseAssetHostArguments(args), /Invalid standalone/);
});
