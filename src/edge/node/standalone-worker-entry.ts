import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parentPort } from "node:worker_threads";
import { createTreeSitterAdapter } from "../tree-sitter-adapter";
import { createGithubRevisionGateway } from "../github-revision-gateway";
import { createGithubRawSourceGateway } from "../github-source-gateway";
import { runNodeAnalysisWorker } from "./analysis-worker";

if (!parentPort) throw new Error("Node analysis worker requires a parent port");

const parserAssets = Object.freeze({
  runtimeJavaScript: new URL("../../../../parser/web-tree-sitter.js", import.meta.url).href,
  runtimeWasm: new URL("../../../../parser/web-tree-sitter.wasm", import.meta.url).href,
  grammarJavaScript: new URL("../../../../parser/tree-sitter-javascript.wasm", import.meta.url).href,
  grammarTypeScript: new URL("../../../../parser/tree-sitter-typescript.wasm", import.meta.url).href,
  grammarTsx: new URL("../../../../parser/tree-sitter-tsx.wasm", import.meta.url).href,
  grammarCSharp: new URL("../../../../parser/tree-sitter-c-sharp.wasm", import.meta.url).href,
});

runNodeAnalysisWorker(parentPort, {
  revisionGateway: createGithubRevisionGateway(fetch),
  sourceGateway: createGithubRawSourceGateway(fetch),
  parser: createTreeSitterAdapter(parserAssets, {
    loadBytes: async (url) => new Uint8Array(await readFile(fileURLToPath(url))),
  }),
});
