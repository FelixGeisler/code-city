import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith("?url")) {
      return { shortCircuit: true, url: "data:text/javascript,export default ''" };
    }
    return nextResolve(/^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context);
  },
});

const projectRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const posted = [];
globalThis.self = {
  addEventListener() {},
  postMessage(message, transfer) { posted.push({ message, transfer }); },
};
const { publishWorkerMessage } = await import("../src/edge/processing-worker.ts");
const { buildCity, validatePresentationModel } = await import("../src/domain/city-model.ts");

function successModel() {
  return buildCity([{ canonicalPath: "src/a.ts", S: 1, U: 1, M: 0 }]).model;
}

test("the processing-worker edge transfers exactly four whole distinct buffers in contract order and detaches them", () => {
  const model = successModel();
  const expected = [model.origins.buffer, model.sizes.buffer, model.rgba.buffer, model.bounds.buffer];
  let clone;
  const scope = {
    postMessage(message, transfer) {
      assert.deepEqual(transfer, expected);
      assert.equal(new Set(transfer).size, 4);
      clone = structuredClone(message, { transfer });
    },
  };
  publishWorkerMessage(scope, { type: "SUCCESS", generation: 3, revision: "a".repeat(40), model });
  assert.deepEqual(expected.map((buffer) => buffer.byteLength), [0, 0, 0, 0]);
  assert.deepEqual(Object.keys(clone), ["type", "generation", "revision", "model"]);
  assert.equal(clone.type, "SUCCESS");
  assert.equal(clone.generation, 3);
  assert.equal(clone.revision, "a".repeat(40));
  assert.doesNotThrow(() => validatePresentationModel(clone.model));
});

test("non-success worker messages are posted without a transfer list", () => {
  let args;
  publishWorkerMessage({ postMessage(...value) { args = value; } }, { type: "ATTEMPT_DRAINED", generation: 4 });
  assert.deepEqual(args, [{ type: "ATTEMPT_DRAINED", generation: 4 }]);
});

test("Transferable APIs remain confined to the processing-worker edge", async () => {
  for (const directory of ["src/application", "src/domain"]) {
    const files = await import("node:fs/promises").then(({ readdir }) => readdir(path.join(projectRoot, directory)));
    for (const file of files.filter((name) => name.endsWith(".ts"))) {
      const source = await readFile(path.join(projectRoot, directory, file), "utf8");
      assert.doesNotMatch(source, /\bTransferable\b|postMessage\s*\([^)]*,\s*\[/u, `${directory}/${file}`);
    }
  }
});
