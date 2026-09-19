import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const vendorRoot = path.join(projectRoot, "vendor", "tree-sitter-typescript");

export const VENDOR_FILES = Object.freeze([
  "LICENSE",
  "LICENSE.javascript",
  "grammar.patch",
  "provenance.json",
  "wasm/tree-sitter-tsx.wasm",
  "wasm/tree-sitter-typescript.wasm",
]);

export const SELECTED_ASSETS = Object.freeze([
  Object.freeze({ role: "runtime-js", relativePath: "node_modules/web-tree-sitter/web-tree-sitter.js", sha256: "7c49e3c1d87e24e0bb4c2def909d17154dfde281f5f8280225450090bb4b8110" }),
  Object.freeze({ role: "runtime-wasm", relativePath: "node_modules/web-tree-sitter/web-tree-sitter.wasm", sha256: "c03bccdc3b448a32848f5ae327e209c982bbb0840d43eec8bc2d5759544a1ed3" }),
  Object.freeze({ role: "grammar-javascript", relativePath: "node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-javascript.wasm", sha256: "5fb488d0cabb4775a594bab85682de5ad6ce83c0d6ac997a9f82dd084d571240", abi: 15 }),
  Object.freeze({ role: "grammar-typescript", relativePath: "vendor/tree-sitter-typescript/wasm/tree-sitter-typescript.wasm", sha256: "e78418bb10620f1eef96f254d3a73e745b33f9b9f263ce09ccb195c39dcf88c9", bytes: 1_362_713, abi: 14 }),
  Object.freeze({ role: "grammar-tsx", relativePath: "vendor/tree-sitter-typescript/wasm/tree-sitter-tsx.wasm", sha256: "23fca4a07147d124a8453981a24825a47eba090dc3da6ce207a1cbb48579b0a7", bytes: 1_446_550, abi: 14 }),
]);

export const NOTICE_LABELS = Object.freeze({
  typescript: "third-party-notice:source-grammar:tree-sitter-typescript@0.23.2",
  javascript: "third-party-notice:source-grammar-dependency:tree-sitter-javascript@0.23.1",
});

const EXPECTED_VENDOR = Object.freeze({
  LICENSE: Object.freeze({ sha256: "49bf33cf78ef5897e4e161ce1517df7de1ae5042a65b6bcfd44401e0fc606559", bytes: 1_080 }),
  "LICENSE.javascript": Object.freeze({ sha256: "2e0110e07abef7c2548b26ec9d6969775617ca539a0dc8dbeeb14d6452c711d1", bytes: 1_080 }),
  "grammar.patch": Object.freeze({ sha256: "470d7029ad57d743704d5c1ab871449a4e817b9bd8c3266912aeb52b4ad4b62d", bytes: 963 }),
  "provenance.json": Object.freeze({ sha256: "885ad8788f6ba6f50c82702ebb61179408f4825ba3ec1cbbee494d43b50f3bc3", bytes: 8_223 }),
  "wasm/tree-sitter-typescript.wasm": Object.freeze({ sha256: "e78418bb10620f1eef96f254d3a73e745b33f9b9f263ce09ccb195c39dcf88c9", bytes: 1_362_713 }),
  "wasm/tree-sitter-tsx.wasm": Object.freeze({ sha256: "23fca4a07147d124a8453981a24825a47eba090dc3da6ce207a1cbb48579b0a7", bytes: 1_446_550 }),
});
const EXPECTED_INVENTORY = Object.freeze({ sha256: "727c583b8823fdaa80204c3f3211c37ed4c6bd8b07a89afbf8bcc90bad28d931", bytes: 10_167, rows: 219 });
const EXPECTED_DYLINK = Object.freeze({
  "grammar-typescript": Object.freeze({ memorySize: 1_330_484, memoryAlign: 4, tableSize: 7, tableAlign: 0, neededLibraries: Object.freeze([]), subsectionTypes: Object.freeze([1]) }),
  "grammar-tsx": Object.freeze({ memorySize: 1_409_560, memoryAlign: 4, tableSize: 7, tableAlign: 0, neededLibraries: Object.freeze([]), subsectionTypes: Object.freeze([1]) }),
});
const EXPECTED_DECLARATIONS = Object.freeze([
  "  <meta charset=\"UTF-8\">",
  "  <meta name=\"referrer\" content=\"no-referrer\">",
  "  <meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; base-uri 'none'; connect-src 'self' https://api.github.com https://raw.githubusercontent.com; form-action 'none'; frame-src 'none'; object-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; worker-src 'self'\">",
]);
const VIEWPORT = "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function digest(bytes) {
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

export function inspectWasm(bytes) {
  invariant(bytes instanceof Uint8Array, "WASM input must be bytes");
  invariant(bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])), "Invalid WASM header");
  const input = reader(bytes, 8);
  const imports = [];
  const exports = [];
  const memories = [];
  const dylinkSections = [];
  const ordinarySections = new Set();
  while (!input.done) {
    const sectionId = input.byte();
    const section = input.subreader(input.varuint());
    invariant(sectionId <= 13, "Unknown WASM section");
    if (sectionId !== 0) {
      invariant(!ordinarySections.has(sectionId), "Duplicate WASM section");
      ordinarySections.add(sectionId);
    }
    if (sectionId === 0) {
      const name = section.string();
      if (name === "dylink.0") {
        const subsectionTypes = [];
        let memory;
        let neededLibraries;
        while (!section.done) {
          const type = section.varuint();
          const subsection = section.subreader(section.varuint());
          invariant(!subsectionTypes.includes(type), "Duplicate dylink.0 subsection");
          subsectionTypes.push(type);
          if (type === 1) {
            memory = {
              memorySize: subsection.varuint(),
              memoryAlign: subsection.varuint(),
              tableSize: subsection.varuint(),
              tableAlign: subsection.varuint(),
            };
          } else if (type === 2) {
            neededLibraries = Array.from({ length: subsection.varuint() }, () => subsection.string());
          } else {
            throw new Error(`Unknown dylink.0 subsection ${type}`);
          }
          invariant(subsection.done, "Trailing dylink.0 subsection metadata");
        }
        invariant(memory, "Missing dylink.0 memory subsection");
        dylinkSections.push({ ...memory, neededLibraries: neededLibraries ?? [], subsectionTypes });
      }
    } else if (sectionId === 2) {
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
  invariant(dylinkSections.length === 1, "WASM must contain exactly one dylink.0 section");
  return { imports, exports, memories, dylink: dylinkSections[0] };
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

export async function generateCanonicalWasmInventory(root = projectRoot) {
  const rows = [];
  for (const asset of SELECTED_ASSETS.filter((candidate) => candidate.relativePath.endsWith(".wasm"))) {
    const bytes = await readFile(path.join(root, ...asset.relativePath.split("/")));
    const parsed = inspectWasm(bytes);
    rows.push(`ASSET\t${path.posix.basename(asset.relativePath)}`);
    rows.push("IMPORT\tmodule\tname\tkind\tdescriptor");
    for (const fields of parsed.imports.sort(unsignedTupleCompare)) rows.push(`IMPORT\t${fields.join("\t")}`);
    rows.push("EXPORT\tname\tkind\tindex");
    for (const fields of parsed.exports.sort(unsignedTupleCompare)) rows.push(`EXPORT\t${fields.join("\t")}`);
    rows.push("MEMORY\tindex\torigin\tmodule\tname\tmin-pages\tmax-pages\tshared\tmemory64\tmin-bytes\tmax-bytes");
    for (const [index, memory] of parsed.memories.entries()) {
      rows.push(["MEMORY", index, memory.origin, memory.module, memory.name, memory.minimum, memory.maximum ?? "-", memory.shared, memory.memory64, memory.minimum * 65_536, memory.maximum === undefined ? "-" : memory.maximum * 65_536].join("\t"));
    }
  }
  const generated = Buffer.from(`${rows.join("\n")}\n`, "utf8");
  invariant(generated.byteLength === EXPECTED_INVENTORY.bytes, "Generated canonical WASM inventory byte length changed");
  invariant(rows.length === EXPECTED_INVENTORY.rows, "Generated canonical WASM inventory row count changed");
  invariant(digest(generated) === EXPECTED_INVENTORY.sha256, "Generated canonical WASM inventory digest changed");
  const fixture = await readFile(path.join(root, "test", "fixtures", "wasm-inventory.tsv"));
  invariant(generated.equals(fixture), "Tracked canonical WASM inventory differs from generated evidence");
  return generated;
}

async function listVendorFiles(directory = vendorRoot, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    const metadata = await lstat(absolute);
    invariant(!metadata.isSymbolicLink(), `Parser vendor payload is a symbolic link: ${relative}`);
    if (metadata.isDirectory()) files.push(...await listVendorFiles(absolute, relative));
    else {
      invariant(metadata.isFile(), `Parser vendor payload is not a file: ${relative}`);
      files.push(relative);
    }
  }
  return files;
}

export async function verifyVendorFiles(root = projectRoot) {
  const rootPath = path.join(root, "vendor", "tree-sitter-typescript");
  assert.deepEqual(await listVendorFiles(rootPath), [...VENDOR_FILES], "Parser vendor allowlist changed");
  const contents = new Map();
  for (const relativePath of VENDOR_FILES) {
    const bytes = await readFile(path.join(rootPath, ...relativePath.split("/")));
    const expected = EXPECTED_VENDOR[relativePath];
    invariant(bytes.byteLength === expected.bytes, `Vendored parser byte length changed: ${relativePath}`);
    invariant(digest(bytes) === expected.sha256, `Vendored parser digest changed: ${relativePath}`);
    contents.set(relativePath, bytes);
  }
  const provenanceBytes = contents.get("provenance.json");
  invariant(provenanceBytes.at(-1) === 0x0a && !provenanceBytes.includes(0x0d), "Parser provenance must be exact UTF-8/LF with final LF");
  const provenance = JSON.parse(decoder.decode(provenanceBytes));
  invariant(provenance.schemaVersion === 2, "Parser provenance schema changed");
  assert.deepEqual(Object.keys(provenance), ["schemaVersion", "source", "patch", "toolchain", "build", "reproduction", "closedAssetContract"]);
  assert.deepEqual(provenance.build, {
    generate: { executable: "tree-sitter-cli@0.24.4 release binary", arguments: ["generate", "--abi", "14"], dialects: ["typescript", "tsx"] },
    compile: { executable: "tree-sitter-cli@0.25.10 release binary", arguments: ["build", "--wasm"], emscripten: "3.1.64" },
    controls: 2, patched: 2, independentFreshSourceTrees: true,
  });
  assert.deepEqual(provenance.closedAssetContract.dylink, {
    typescript: EXPECTED_DYLINK["grammar-typescript"],
    tsx: EXPECTED_DYLINK["grammar-tsx"],
  });
  assert.deepEqual(provenance.closedAssetContract.canonicalInventory, {
    sha256: EXPECTED_INVENTORY.sha256,
    bytes: EXPECTED_INVENTORY.bytes,
    rows: EXPECTED_INVENTORY.rows,
    onlyDeltaFromBaseline: "TypeScript env.memory minimum 22 to exact 21 in IMPORT and normalized MEMORY projection; all other 217 rows byte-identical",
  });
  assert.deepEqual(provenance.reproduction.nodeTypes, {
    typescript: { sha256: "c790a733fc756b54d4e54dceeb7d2d51e40d8b57136e70277753a75804cce3e3", bytes: 108_583 },
    tsx: { sha256: "78b5789145286799a27a0a7ecc36cc1bcb151f94ec7fa631b248459867010c8c", bytes: 113_345 },
    byteIdenticalAcrossControlPatchedAndUpstream: true,
  });
  invariant(provenance.source.javascriptDependency.license.path === "vendor/tree-sitter-typescript/LICENSE.javascript", "JavaScript dependency notice mapping changed");
  invariant(provenance.source.javascriptDependency.license.sha256 === EXPECTED_VENDOR["LICENSE.javascript"].sha256, "JavaScript dependency notice digest mapping changed");
  invariant(provenance.source.license.sha256 === EXPECTED_VENDOR.LICENSE.sha256, "TypeScript notice digest mapping changed");
  return { contents, provenance };
}

export async function expectedNoticeBlock(root = projectRoot) {
  const typescript = await readFile(path.join(root, "vendor", "tree-sitter-typescript", "LICENSE"), "utf8");
  const javascript = await readFile(path.join(root, "vendor", "tree-sitter-typescript", "LICENSE.javascript"), "utf8");
  invariant(typescript.endsWith("\n") && javascript.endsWith("\n"), "Notice payloads must retain final LF");
  return `<!-- ${NOTICE_LABELS.typescript}\n${typescript}-->\n  <!-- ${NOTICE_LABELS.javascript}\n${javascript}-->`;
}

export async function assertEntryNotices(bytes, label, root = projectRoot) {
  invariant(bytes instanceof Uint8Array, `${label} index must be exact bytes`);
  invariant(!bytes.includes(0x0d), `${label} index contains CR bytes`);
  const html = decoder.decode(bytes);
  for (const declaration of EXPECTED_DECLARATIONS) invariant((html.split(declaration).length - 1) === 1, `${label} index declaration changed or duplicated`);
  const charsetEnd = Buffer.byteLength(html.slice(0, html.indexOf(EXPECTED_DECLARATIONS[0]) + EXPECTED_DECLARATIONS[0].length), "utf8");
  invariant(charsetEnd <= 1_024, `${label} charset declaration is outside the first 1,024 UTF-8 bytes`);
  const expected = `${EXPECTED_DECLARATIONS.join("\n")}\n  ${await expectedNoticeBlock(root)}\n${VIEWPORT}`;
  invariant(html.includes(expected), `${label} notices are missing, modified, merged, swapped, relabelled, or misplaced`);
  for (const noticeLabel of Object.values(NOTICE_LABELS)) invariant((html.split(noticeLabel).length - 1) === 1, `${label} notice label must occur exactly once: ${noticeLabel}`);
  return true;
}

export async function checkParserAssets(root = projectRoot) {
  const { provenance } = await verifyVendorFiles(root);
  for (const asset of SELECTED_ASSETS) {
    const bytes = await readFile(path.join(root, ...asset.relativePath.split("/")));
    invariant(digest(bytes) === asset.sha256, `Selected parser asset drift: ${asset.role}`);
    if (asset.bytes !== undefined) invariant(bytes.byteLength === asset.bytes, `Selected parser asset length drift: ${asset.role}`);
    if (EXPECTED_DYLINK[asset.role]) assert.deepEqual(inspectWasm(bytes).dylink, EXPECTED_DYLINK[asset.role], `dylink.0 drift: ${asset.role}`);
  }

  const runtimeLicense = await readFile(path.join(root, "node_modules", "web-tree-sitter", "LICENSE"));
  invariant(digest(runtimeLicense) === "c5cfb43042b6b72045f4ba997834d0a7786d2793d91680868b5815b39f14fc78", "web-tree-sitter license drift");
  const grammarLicense = await readFile(path.join(root, "node_modules", "@vscode", "tree-sitter-wasm", "LICENSE"));
  invariant(digest(grammarLicense) === "c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383", "@vscode/tree-sitter-wasm license drift");

  const runtimeAsset = SELECTED_ASSETS[0];
  const runtimeWasm = SELECTED_ASSETS[1];
  const runtime = await import(pathToFileURL(path.join(root, ...runtimeAsset.relativePath.split("/"))).href);
  await runtime.Parser.init({
    locateFile(requestedPath) {
      if (requestedPath === "web-tree-sitter.wasm") return pathToFileURL(path.join(root, ...runtimeWasm.relativePath.split("/"))).href;
      throw new Error("Unexpected parser runtime asset request");
    },
    print() {}, printErr() {},
  });
  invariant(runtime.MIN_COMPATIBLE_VERSION === 13 && runtime.LANGUAGE_VERSION === 15, "Runtime ABI acceptance must remain 13 through 15");
  for (const asset of SELECTED_ASSETS.filter((candidate) => candidate.abi !== undefined)) {
    const language = await runtime.Language.load(new Uint8Array(await readFile(path.join(root, ...asset.relativePath.split("/")))));
    invariant(language.abiVersion === asset.abi, `Grammar ABI drift: ${asset.role}`);
  }

  invariant(provenance.closedAssetContract.abi.typescript === 14 && provenance.closedAssetContract.abi.tsx === 14, "Provenance ABI pins changed");
  await generateCanonicalWasmInventory(root);
  await assertEntryNotices(await readFile(path.join(root, "index.html")), "Source", root);
  console.log("Verified the six-file parser vendor closure, provenance, notices, hashes, ABIs, dylink.0, and canonical inventory.");
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) await checkParserAssets();
