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
    sha256: "99fa2281fc4c6da713ccdadce72e81571b032ab9901b751be2d5aa127c843aaf",
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

const utf8 = new TextEncoder();
const decoder = new TextDecoder("utf8", { fatal: true });
const valueTypes = new Map([[0x7f, "i32"], [0x7e, "i64"], [0x7d, "f32"], [0x7c, "f64"], [0x70, "funcref"], [0x6f, "externref"]]);
const externalKinds = ["function", "table", "memory", "global", "tag"];

function reader(bytes, start = 0, end = bytes.length) {
  let offset = start;
  return {
    get offset() { return offset; },
    get done() { return offset === end; },
    byte() { invariant(offset < end, "Truncated WASM byte"); return bytes[offset++]; },
    varuint() {
      let value = 0;
      let shift = 0;
      for (;;) {
        const byte = this.byte();
        value += (byte & 0x7f) * 2 ** shift;
        invariant(Number.isSafeInteger(value) && shift <= 49, "Unsupported WASM integer");
        if ((byte & 0x80) === 0) return value;
        shift += 7;
      }
    },
    string() {
      const length = this.varuint();
      invariant(offset + length <= end, "Truncated WASM string");
      const value = decoder.decode(bytes.subarray(offset, offset + length));
      offset += length;
      return value;
    },
    subreader(length) {
      invariant(offset + length <= end, "Truncated WASM section");
      const nested = reader(bytes, offset, offset + length);
      offset += length;
      return nested;
    },
  };
}

function limits(input) {
  const flags = input.varuint();
  invariant((flags & ~7) === 0, "Unsupported WASM limits flags");
  const minimum = input.varuint();
  const maximum = (flags & 1) ? input.varuint() : undefined;
  return { minimum, maximum, shared: Boolean(flags & 2), memory64: Boolean(flags & 4) };
}

function limitDescriptor(value) {
  return `min=${value.minimum};max=${value.maximum ?? "-"};shared=${value.shared};memory64=${value.memory64}`;
}

function parseCanonicalInventoryAsset(bytes) {
  invariant(bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])), "Invalid WASM header");
  const input = reader(bytes, 8);
  const imports = [];
  const exports = [];
  const memories = [];
  while (!input.done) {
    const sectionId = input.byte();
    const section = input.subreader(input.varuint());
    if (sectionId === 2) {
      const count = section.varuint();
      for (let index = 0; index < count; index += 1) {
        const module = section.string();
        const name = section.string();
        const kindCode = section.byte();
        const kind = externalKinds[kindCode];
        invariant(kind, "Unsupported WASM import kind");
        let descriptor;
        if (kind === "function") descriptor = `type[${section.varuint()}]`;
        else if (kind === "table") {
          const type = valueTypes.get(section.byte());
          invariant(type, "Unsupported WASM table type");
          descriptor = `${type};${limitDescriptor(limits(section))}`;
        } else if (kind === "memory") {
          const memoryLimits = limits(section);
          descriptor = limitDescriptor(memoryLimits);
          memories.push({ origin: "import", module, name, ...memoryLimits });
        } else if (kind === "global") {
          const type = valueTypes.get(section.byte());
          const mutable = section.byte();
          invariant(type && (mutable === 0 || mutable === 1), "Unsupported WASM global type");
          descriptor = `${type};mutable=${Boolean(mutable)}`;
        } else {
          descriptor = `type[${section.varuint()}]`;
          section.byte();
        }
        imports.push([module, name, kind, descriptor]);
      }
      invariant(section.done, "Trailing WASM import bytes");
    } else if (sectionId === 5) {
      const count = section.varuint();
      for (let index = 0; index < count; index += 1) memories.push({ origin: "defined", module: "-", name: "-", ...limits(section) });
      invariant(section.done, "Trailing WASM memory bytes");
    } else if (sectionId === 7) {
      const count = section.varuint();
      for (let index = 0; index < count; index += 1) {
        const name = section.string();
        const kind = externalKinds[section.byte()];
        invariant(kind, "Unsupported WASM export kind");
        exports.push([name, kind, String(section.varuint())]);
      }
      invariant(section.done, "Trailing WASM export bytes");
    }
  }
  return { imports, exports, memories };
}

function unsignedTupleCompare(left, right) {
  const leftBytes = utf8.encode(left.join("\0"));
  const rightBytes = utf8.encode(right.join("\0"));
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index] - rightBytes[index];
    if (difference) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

export async function generateCanonicalWasmInventory() {
  const rows = [];
  for (const asset of SELECTED_ASSETS.filter((candidate) => candidate.relativePath.endsWith(".wasm"))) {
    const bytes = await readFile(path.join(projectRoot, ...asset.relativePath.split("/")));
    const parsed = parseCanonicalInventoryAsset(bytes);
    rows.push(`ASSET\t${path.posix.basename(asset.relativePath)}`);
    rows.push("IMPORT\tmodule\tname\tkind\tdescriptor");
    for (const fields of parsed.imports.sort(unsignedTupleCompare)) rows.push(`IMPORT\t${fields.join("\t")}`);
    rows.push("EXPORT\tname\tkind\tindex");
    for (const fields of parsed.exports.sort(unsignedTupleCompare)) rows.push(`EXPORT\t${fields.join("\t")}`);
    rows.push("MEMORY\tindex\torigin\tmodule\tname\tmin-pages\tmax-pages\tshared\tmemory64\tmin-bytes\tmax-bytes");
    for (const [index, memory] of parsed.memories.entries()) {
      rows.push([
        "MEMORY", index, memory.origin, memory.module, memory.name, memory.minimum, memory.maximum ?? "-",
        memory.shared, memory.memory64, memory.minimum * 65_536,
        memory.maximum === undefined ? "-" : memory.maximum * 65_536,
      ].join("\t"));
    }
  }
  const generated = Buffer.from(`${rows.join("\n")}\n`, "utf8");
  invariant(generated.byteLength === 10_103, "Generated canonical WASM inventory byte length changed");
  invariant(rows.length === 217, "Generated canonical WASM inventory row count changed");
  invariant(digest(generated) === "b4b6e4528e5147ef618593b2504f204de6a3aac2ce06d9cfe2a3661f435756bb", "Generated canonical WASM inventory digest changed");
  const fixture = await readFile(path.join(projectRoot, "test", "fixtures", "wasm-inventory.tsv"));
  invariant(generated.equals(fixture), "Tracked canonical WASM inventory differs from generated evidence");
  return generated;
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
