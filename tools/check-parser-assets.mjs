import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

export const SELECTED_ASSETS = [
  {
    role: "runtime-js",
    relativePath: "node_modules/web-tree-sitter/web-tree-sitter.js",
    sha256: "0c868236a47296b4ff3c1570f20e0899e4a784ff6e5cd7bfc9c3a55225463e4a",
  },
  {
    role: "runtime-wasm",
    relativePath: "node_modules/web-tree-sitter/web-tree-sitter.wasm",
    sha256: "ba5c7a539603f251f380e4d6ce26ee954ffca7bda8b2e13744dc4c87d6ce6041",
  },
  {
    role: "grammar-javascript",
    relativePath: "node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-javascript.wasm",
    sha256: "5fb488d0cabb4775a594bab85682de5ad6ce83c0d6ac997a9f82dd084d571240",
    abi: 15,
  },
  {
    role: "grammar-typescript",
    relativePath: "node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-typescript.wasm",
    sha256: "778025db5a8be0e70f8ccc3671e486dfeddd048c25d9e8a70c26de2e1bf6f97d",
    abi: 14,
  },
  {
    role: "grammar-tsx",
    relativePath: "node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-tsx.wasm",
    sha256: "79e5da75ea62855a0cd67177685f0164eac87d5f630b3cbe1e0a099751ad30f8",
    abi: 14,
  },
];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function generateCanonicalWasmInventory() {
  const fixture = await readFile(path.join(projectRoot, "test", "fixtures", "wasm-inventory.tsv"));
  invariant(fixture.byteLength === 10_103, "Canonical WASM inventory byte length changed");
  invariant(digest(fixture) === "b4b6e4528e5147ef618593b2504f204de6a3aac2ce06d9cfe2a3661f435756bb", "Canonical WASM inventory digest changed");
  const text = fixture.toString("utf8");
  invariant(!text.startsWith("\uFEFF") && text.endsWith("\n") && !text.includes("\r"), "Canonical WASM inventory encoding changed");
  invariant(text.split("\n").length - 1 === 217, "Canonical WASM inventory row count changed");

  const wasmAssets = SELECTED_ASSETS.filter((asset) => asset.relativePath.endsWith(".wasm"));
  for (const asset of wasmAssets) {
    const bytes = await readFile(path.join(projectRoot, ...asset.relativePath.split("/")));
    const module = new WebAssembly.Module(bytes);
    const imports = WebAssembly.Module.imports(module);
    const exports = WebAssembly.Module.exports(module);
    const sectionName = path.posix.basename(asset.relativePath);
    const sectionStart = text.indexOf(`ASSET\t${sectionName}\n`);
    invariant(sectionStart >= 0, `Inventory has no ${sectionName} section`);
    const nextSection = text.indexOf("ASSET\t", sectionStart + 1);
    const section = text.slice(sectionStart, nextSection < 0 ? text.length : nextSection);
    for (const entry of imports) invariant(section.includes(`IMPORT\t${entry.module}\t${entry.name}\t${entry.kind}\t`), `Inventory import drift: ${sectionName}/${entry.module}/${entry.name}`);
    for (const entry of exports) invariant(section.includes(`EXPORT\t${entry.name}\t${entry.kind}\t`), `Inventory export drift: ${sectionName}/${entry.name}`);
  }
  return fixture;
}

export async function checkParserAssets() {
  for (const asset of SELECTED_ASSETS) {
    const bytes = await readFile(path.join(projectRoot, ...asset.relativePath.split("/")));
    invariant(digest(bytes) === asset.sha256, `Selected parser asset drift: ${asset.role}`);
  }

  const runtimeLicense = await readFile(path.join(projectRoot, "node_modules", "web-tree-sitter", "LICENSE"));
  invariant(digest(runtimeLicense) === "c5cfb43042b6b72045f4ba997834d0a7786d2793d91680868b5815b39f14fc78", "web-tree-sitter license drift");
  const grammarLicense = await readFile(path.join(projectRoot, "node_modules", "@vscode", "tree-sitter-wasm", "LICENSE"));
  invariant(digest(grammarLicense) === "c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383", "@vscode/tree-sitter-wasm license drift");

  const runtimeAsset = SELECTED_ASSETS[0];
  const runtimeWasm = SELECTED_ASSETS[1];
  const runtime = await import(pathToFileURL(path.join(projectRoot, ...runtimeAsset.relativePath.split("/"))).href);
  await runtime.Parser.init({
    locateFile(requestedPath, _scriptDirectory) {
      if (requestedPath === "web-tree-sitter.wasm") {
        return pathToFileURL(path.join(projectRoot, ...runtimeWasm.relativePath.split("/"))).href;
      }
      throw new Error("Unexpected parser runtime asset request");
    },
    print() {},
    printErr() {},
  });
  invariant(runtime.MIN_COMPATIBLE_VERSION === 13 && runtime.LANGUAGE_VERSION === 15, "Runtime ABI acceptance must remain 13 through 15");
  for (const asset of SELECTED_ASSETS.filter((candidate) => candidate.abi !== undefined)) {
    const language = await runtime.Language.load(new Uint8Array(await readFile(path.join(projectRoot, ...asset.relativePath.split("/")))));
    invariant(language.abiVersion === asset.abi, `Grammar ABI drift: ${asset.role}`);
  }

  await generateCanonicalWasmInventory();
  console.log("Verified selected parser hashes, licenses, runtime/grammar ABIs, and canonical WASM inventory.");
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) await checkParserAssets();
