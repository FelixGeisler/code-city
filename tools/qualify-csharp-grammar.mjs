import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspectWasm } from "./check-parser-assets.mjs";

const projectRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const decoder = new TextDecoder("utf8", { fatal: true });
const WHITE_SPACE = /^\p{White_Space}$/u;
const CSHARP_ASSET = "node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-c-sharp.wasm";
const RUNTIME_JS = "node_modules/web-tree-sitter/web-tree-sitter.js";
const RUNTIME_WASM = "node_modules/web-tree-sitter/web-tree-sitter.wasm";
const EXPECTED_INVENTORY = Object.freeze({ bytes: 874, rows: 19, sha256: "ec51af39771906e32e2bb98c718a9564f30f8eb843be29970add80e74300f3fa" });

export const CSHARP_CANDIDATE = Object.freeze({
  schemaVersion: 1,
  status: "qualified-and-selected",
  package: Object.freeze({
    name: "@vscode/tree-sitter-wasm",
    version: "0.3.1",
    resolved: "https://registry.npmjs.org/@vscode/tree-sitter-wasm/-/tree-sitter-wasm-0.3.1.tgz",
    integrity: "sha512-RJFoomET6FajjG511fmQxeBQfU6M24a0aFZPqpid+ttIxanWf1VGytBG0UmsGjt07qmIPJS8U31D+aecuCucsQ==",
    tagCommit: "78c97c860ddd965b9617f0e30962ad1da08c4c91",
    repository: "https://github.com/microsoft/vscode-tree-sitter-wasm",
    license: Object.freeze({ kind: "MIT", path: "node_modules/@vscode/tree-sitter-wasm/LICENSE", bytes: 1_141, sha256: "c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383" }),
  }),
  sourceGrammar: Object.freeze({
    repository: "https://github.com/tree-sitter/tree-sitter-c-sharp",
    commit: "485f0bae0274ac9114797fc10db6f7034e4086e3",
    pinnedByPackageTagCommit: "78c97c860ddd965b9617f0e30962ad1da08c4c91",
    buildDefinition: "https://github.com/microsoft/vscode-tree-sitter-wasm/blob/78c97c860ddd965b9617f0e30962ad1da08c4c91/build/main.ts#L19-L24",
    license: Object.freeze({ kind: "MIT", path: "test/fixtures/csharp-source-license.txt", bytes: 1_133, sha256: "778fb7d63b8c1844da315648c02f325c4713a6f4a5d19644fd413421422776d3", productionNoticeRequiredOnAdmission: true }),
  }),
  runtime: Object.freeze({ package: "web-tree-sitter", version: "0.27.0", minimumAbi: 13, maximumAbi: 15 }),
  asset: Object.freeze({ path: CSHARP_ASSET, bytes: 5_103_332, sha256: "d12d85996c25957b4c1b71e26db2d7cc8a294997b60642e9c2a3b031b2c66dd3", abi: 15 }),
  dylink: Object.freeze({ memorySize: 5_013_132, memoryAlign: 4, tableSize: 7, tableAlign: 0, neededLibraries: Object.freeze([]), subsectionTypes: Object.freeze([1]) }),
  inventory: Object.freeze({ path: "test/fixtures/csharp-wasm-inventory.tsv", ...EXPECTED_INVENTORY }),
  renewalRule: "Any package, asset, runtime, source commit, inventory, ABI, or licence change requires renewed C# grammar qualification.",
});

const CALLABLE_KINDS = Object.freeze({
  method_declaration: "method",
  local_function_statement: "local-function",
  constructor_declaration: "constructor",
  destructor_declaration: "destructor",
  operator_declaration: "operator",
  conversion_operator_declaration: "conversion",
  lambda_expression: "lambda",
  anonymous_method_expression: "anonymous-method",
});
const LOOPS = new Set(["do_statement", "for_statement", "foreach_statement", "while_statement"]);
const DECLARATION_OWNERS = new Set(["field_declaration", "event_field_declaration"]);

function invariant(condition, message) { if (!condition) throw new Error(message); }
export function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function pathParts(relativePath) { return relativePath.split("/"); }
function exactKeys(value, keys, label) { invariant(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`); assert.deepEqual(Object.keys(value), keys, `${label} fields changed`); }
function canonicalShapeDigest(nodes) {
  const rows = nodes.filter((node) => node.named).map((node) => {
    const parent = node.parent < 0 ? "-" : nodes[node.parent].type;
    return `${parent}\t${node.field ?? "-"}\t${node.type}\t${node.missing}\t${node.start}\t${node.end}`;
  });
  return digest(Buffer.from(`${rows.join("\n")}\n`, "utf8"));
}
function tupleCompare(left, right) { return Buffer.from(left.join("\0"), "utf8").compare(Buffer.from(right.join("\0"), "utf8")); }

export function generateCSharpWasmInventory(bytes) {
  const parsed = inspectWasm(bytes);
  const rows = ["ASSET\ttree-sitter-c-sharp.wasm", "IMPORT\tmodule\tname\tkind\tdescriptor"];
  for (const fields of parsed.imports.sort(tupleCompare)) rows.push(`IMPORT\t${fields.join("\t")}`);
  rows.push("EXPORT\tname\tkind\tindex");
  for (const fields of parsed.exports.sort(tupleCompare)) rows.push(`EXPORT\t${fields.join("\t")}`);
  rows.push("MEMORY\tindex\torigin\tmodule\tname\tmin-pages\tmax-pages\tshared\tmemory64\tmin-bytes\tmax-bytes");
  for (const [index, memory] of parsed.memories.entries()) rows.push(["MEMORY", index, memory.origin, memory.module, memory.name, memory.minimum, memory.maximum ?? "-", memory.shared, memory.memory64, memory.minimum * 65_536, memory.maximum === undefined ? "-" : memory.maximum * 65_536].join("\t"));
  return Buffer.from(`${rows.join("\n")}\n`, "utf8");
}

export async function verifyCSharpCandidate(root = projectRoot) {
  const evidenceBytes = await readFile(path.join(root, "test", "fixtures", "csharp-candidate.json"));
  invariant(evidenceBytes.at(-1) === 0x0a && !evidenceBytes.includes(0x0d), "C# evidence must be exact UTF-8/LF with final LF");
  const evidence = JSON.parse(decoder.decode(evidenceBytes));
  assert.deepEqual(evidence, CSHARP_CANDIDATE, "C# qualification evidence changed");
  exactKeys(evidence, ["schemaVersion", "status", "package", "sourceGrammar", "runtime", "asset", "dylink", "inventory", "renewalRule"], "C# evidence");
  invariant(evidence.sourceGrammar.pinnedByPackageTagCommit === evidence.package.tagCommit
    && evidence.sourceGrammar.buildDefinition.includes(evidence.package.tagCommit)
    && evidence.sourceGrammar.buildDefinition.endsWith("/build/main.ts#L19-L24"), "C# package-build provenance mapping changed");

  const packageManifestBytes = await readFile(path.join(root, "node_modules", "@vscode", "tree-sitter-wasm", "package.json"));
  invariant(packageManifestBytes.byteLength === 1_226 && digest(packageManifestBytes) === "3773c325392fbd572180c856039b6c75c31c71b6110f277d6c1ae9ede157c05d", "C# candidate package manifest changed");
  const packageManifest = JSON.parse(decoder.decode(packageManifestBytes));
  invariant(packageManifest.name === evidence.package.name && packageManifest.version === evidence.package.version && packageManifest.license === "MIT", "C# candidate package identity changed");
  const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  const lockRecord = lock.packages?.["node_modules/@vscode/tree-sitter-wasm"];
  assert.deepEqual(lockRecord, { version: evidence.package.version, resolved: evidence.package.resolved, integrity: evidence.package.integrity, license: "MIT" }, "C# candidate lock provenance changed");

  for (const license of [evidence.package.license, evidence.sourceGrammar.license]) {
    const bytes = await readFile(path.join(root, ...pathParts(license.path)));
    invariant(bytes.byteLength === license.bytes && digest(bytes) === license.sha256, `C# licence evidence changed: ${license.path}`);
  }

  const assetBytes = await readFile(path.join(root, ...pathParts(evidence.asset.path)));
  invariant(assetBytes.byteLength === evidence.asset.bytes && digest(assetBytes) === evidence.asset.sha256, "C# candidate WASM changed");
  const inspected = inspectWasm(assetBytes);
  assert.deepEqual(inspected.dylink, evidence.dylink, "C# candidate dylink.0 changed");
  assert.deepEqual(inspected.memories, [{ origin: "import", module: "env", name: "memory", minimum: 77, maximum: undefined, shared: false, memory64: false }], "C# candidate memory inventory changed");
  const generatedInventory = generateCSharpWasmInventory(assetBytes);
  invariant(generatedInventory.byteLength === evidence.inventory.bytes && generatedInventory.toString("utf8").split("\n").length - 1 === evidence.inventory.rows && digest(generatedInventory) === evidence.inventory.sha256, "Generated C# WASM inventory changed");
  assert.deepEqual(generatedInventory, await readFile(path.join(root, ...pathParts(evidence.inventory.path))), "Tracked C# WASM inventory differs from the candidate");

  const runtimePackage = JSON.parse(await readFile(path.join(root, "node_modules", "web-tree-sitter", "package.json"), "utf8"));
  invariant(runtimePackage.name === evidence.runtime.package && runtimePackage.version === evidence.runtime.version, "C# qualification runtime changed");
  const runtime = await import(pathToFileURL(path.join(root, ...pathParts(RUNTIME_JS))).href);
  await runtime.Parser.init({ locateFile(requestedPath) { invariant(requestedPath === "web-tree-sitter.wasm", "Unexpected C# qualification runtime asset request"); return pathToFileURL(path.join(root, ...pathParts(RUNTIME_WASM))).href; }, print() {}, printErr() {} });
  invariant(runtime.MIN_COMPATIBLE_VERSION === evidence.runtime.minimumAbi && runtime.LANGUAGE_VERSION === evidence.runtime.maximumAbi, "C# qualification runtime ABI window changed");
  const language = await runtime.Language.load(new Uint8Array(assetBytes));
  invariant(language.abiVersion === evidence.asset.abi, "C# candidate ABI changed");
  return { runtime, language, evidence };
}

function walkTree(root, observe, collect) {
  const cursor = root.walk();
  observe("cursor-created");
  let parent = -1;
  const parents = [];
  let invalid = root.hasError;
  let errorNodes = 0;
  let missingNodes = 0;
  let visitedNodes = 0;
  const nodes = collect ? [] : undefined;
  try {
    for (;;) {
      const index = nodes?.length ?? visitedNodes;
      const type = cursor.nodeType;
      const missing = cursor.nodeIsMissing;
      invalid ||= type === "ERROR" || missing;
      if (type === "ERROR") errorNodes += 1;
      if (missing) missingNodes += 1;
      if (nodes) nodes.push({ type, field: cursor.currentFieldName, named: cursor.nodeIsNamed, missing, start: cursor.startIndex, end: cursor.endIndex, parent });
      visitedNodes += 1;
      if (cursor.gotoFirstChild()) { parents.push(parent); parent = index; continue; }
      for (;;) {
        if (cursor.gotoNextSibling()) break;
        if (!cursor.gotoParent()) return { valid: !invalid, signals: { rootHasError: root.hasError, errorNodes, missingNodes }, visitedNodes, nodes };
        parent = parents.pop();
      }
    }
  } finally {
    cursor.delete();
    observe("cursor-deleted");
  }
}

function childIndexes(nodes) {
  const children = Array.from({ length: nodes.length }, () => []);
  for (let index = 1; index < nodes.length; index += 1) children[nodes[index].parent].push(index);
  return children;
}
function directChild(nodes, children, index, predicate) { return children[index].find((child) => predicate(nodes[child], child)); }
function inRange(node, range) { return node.start >= range.start && node.end <= range.end; }

function sourceLines(source, nodes) {
  const exclusions = nodes
    .filter((node) => node.type === "comment")
    .map((node) => ({ start: node.start, end: node.end }));
  let sourceOffset = 0;
  let exclusionIndex = 0;
  let lineHasSource = false;
  let count = 0;
  for (const scalar of source) {
    while (exclusionIndex < exclusions.length && exclusions[exclusionIndex].end <= sourceOffset) exclusionIndex += 1;
    const exclusion = exclusions[exclusionIndex];
    const excluded = exclusion !== undefined && exclusion.start <= sourceOffset && sourceOffset + scalar.length <= exclusion.end;
    if (scalar === "\n") {
      if (lineHasSource) count += 1;
      lineHasSource = false;
    } else if (!excluded && !WHITE_SPACE.test(scalar)) {
      lineHasSource = true;
    }
    sourceOffset += scalar.length;
  }
  return count + (lineHasSource ? 1 : 0);
}

function analyzeTree(source, nodes) {
  const children = childIndexes(nodes);
  const units = [];
  const initializationRanges = [];
  const initializationKeys = new Set();
  const bodyFor = (index) => directChild(nodes, children, index, (child) => child.field === "body")
    ?? (nodes[index].type === "anonymous_method_expression" ? directChild(nodes, children, index, (child) => child.type === "block") : undefined);
  const hasDirectConst = (index) => children[index].some((child) => nodes[child].type === "modifier"
    && directChild(nodes, children, child, (candidate) => candidate.type === "const") !== undefined);
  const excluded = new Uint8Array(nodes.length);
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    const parent = node.parent < 0 ? undefined : nodes[node.parent];
    const excludedRoot = node.type === "attribute"
      || node.type === "attribute_list"
      || node.type === "global_attribute"
      || node.type === "parameter_list"
      || node.type === "bracketed_parameter_list"
      || node.type === "parameter"
      || node.type === "implicit_parameter"
      || node.type === "enum_member_declaration"
      || ((node.type === "field_declaration" || node.type === "local_declaration_statement") && hasDirectConst(index))
      || (node.field === "condition" && (parent?.type === "preproc_if" || parent?.type === "preproc_elif"));
    excluded[index] = Number(excludedRoot || (node.parent >= 0 && excluded[node.parent] === 1));
  }
  const addInitializationRange = (index) => {
    if (index === undefined || excluded[index] === 1) return;
    const range = { start: nodes[index].start, end: nodes[index].end };
    const key = `${range.start}:${range.end}`;
    if (!initializationKeys.has(key)) { initializationKeys.add(key); initializationRanges.push(range); }
  };
  const directTopLevelStatement = (index) => {
    let parent = nodes[index].parent;
    if (parent < 0 || !nodes[parent].type.startsWith("preproc_")) return false;
    while (parent >= 0 && nodes[parent].type.startsWith("preproc_")) parent = nodes[parent].parent;
    return parent >= 0 && nodes[parent].type === "compilation_unit";
  };

  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (excluded[index] === 1) continue;
    let kind = CALLABLE_KINDS[node.type];
    let body = kind ? bodyFor(index) : undefined;
    if (node.type === "accessor_declaration") {
      body = bodyFor(index);
      if (body !== undefined) {
        const name = directChild(nodes, children, index, (child) => child.field === "name");
        kind = name === undefined ? undefined : nodes[name].type;
      }
    } else if (node.type === "property_declaration" || node.type === "indexer_declaration") {
      body = directChild(nodes, children, index, (child) => child.type === "arrow_expression_clause" && child.field === "value");
      if (body !== undefined) kind = node.type === "property_declaration" ? "property-getter" : "indexer-getter";
    }
    if (!kind || body === undefined) continue;
    const ranges = [{ start: nodes[body].start, end: nodes[body].end }];
    if (node.type === "constructor_declaration") {
      const initializer = directChild(nodes, children, index, (child) => child.type === "constructor_initializer");
      if (initializer !== undefined) ranges.unshift({ start: nodes[initializer].start, end: nodes[initializer].end });
    }
    units.push({ nodeIndex: index, kind, form: nodes[body].type === "block" ? "block" : "expression", start: node.start, end: node.end, ranges });
  }

  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node.type === "global_statement") {
      const statement = directChild(nodes, children, index, (child) => child.named);
      if (statement === undefined || nodes[statement].type !== "local_declaration_statement" || !hasDirectConst(statement)) addInitializationRange(index);
      continue;
    }
    if ((node.type.endsWith("_statement") || node.type === "block") && directTopLevelStatement(index)) {
      if (node.type !== "local_declaration_statement" || !hasDirectConst(index)) addInitializationRange(index);
      continue;
    }
    if (node.type === "variable_declarator" && directChild(nodes, children, index, (child) => child.type === "=") !== undefined) {
      const variableDeclaration = node.parent >= 0 && nodes[node.parent].type === "variable_declaration" ? node.parent : -1;
      const declaration = variableDeclaration >= 0 ? nodes[variableDeclaration].parent : -1;
      if (declaration >= 0 && DECLARATION_OWNERS.has(nodes[declaration].type) && !hasDirectConst(declaration)) addInitializationRange(index);
      continue;
    }
    if (node.type === "property_declaration") {
      const initializer = directChild(nodes, children, index, (child) => child.field === "value" && child.type !== "arrow_expression_clause");
      if (initializer !== undefined) addInitializationRange(initializer);
      continue;
    }
    if (node.type === "base_list") {
      const declaration = node.parent;
      const primaryParameters = directChild(nodes, children, declaration, (candidate) => candidate.type === "parameter_list");
      if (primaryParameters !== undefined) for (const child of children[index]) if (nodes[child].type === "argument_list") addInitializationRange(child);
    }
  }

  const initialization = initializationRanges.length > 0 ? { kind: "initialization/top-level", form: "file", start: 0, end: source.length, ranges: initializationRanges } : undefined;
  const allUnits = initialization ? [initialization, ...units] : [...units];
  allUnits.forEach((unit, index) => { unit.id = unit.kind === "initialization/top-level" ? unit.kind : `${unit.kind}#${index + (initialization ? 0 : 1)}`; });
  const ownerFor = (node, exclude) => {
    const candidates = allUnits
      .filter((unit) => unit !== exclude)
      .map((unit) => ({ unit, score: Math.min(...unit.ranges.filter((range) => inRange(node, range)).map((range) => range.end - range.start)) }))
      .filter((candidate) => Number.isFinite(candidate.score));
    candidates.sort((left, right) => left.score - right.score);
    return candidates[0]?.unit;
  };
  for (const unit of units) unit.parent = ownerFor(nodes[unit.nodeIndex], unit)?.id ?? "file";

  const points = [];
  let sequence = 0;
  const add = (index, kind, offset = 0) => points.push({ node: nodes[index], kind, sequence: sequence++, at: nodes[index].start + offset });
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (excluded[index] === 1) continue;
    if (node.type === "if_statement") add(index, "if");
    else if (LOOPS.has(node.type)) add(index, "loop");
    else if (node.type === "switch_section") {
      if (directChild(nodes, children, index, (child) => child.type === "case") !== undefined) add(index, "case");
    } else if (node.type === "catch_clause") add(index, "catch");
    else if (node.type === "conditional_expression") add(index, "conditional");
    else if (node.type === "catch_filter_clause") add(index, "catch-filter");
    else if (node.type === "when_clause") add(index, "switch-guard");
    else if (node.type === "switch_expression_arm") {
      const discard = directChild(nodes, children, index, (child) => child.type === "discard") !== undefined;
      const guarded = directChild(nodes, children, index, (child) => child.type === "when_clause") !== undefined;
      if (!discard || guarded) add(index, "switch-expression-arm");
    } else if (node.type === "binary_expression" || node.type === "assignment_expression") {
      const operator = directChild(nodes, children, index, (child) => child.field === "operator" || ["&&", "||", "??", "??="].includes(child.type));
      if (operator !== undefined && ["&&", "||", "??", "??="].includes(nodes[operator].type)) add(index, nodes[operator].type);
    }
  }
  points.sort((left, right) => left.at - right.at || left.sequence - right.sequence);
  const decisions = [];
  for (const point of points) {
    const owner = ownerFor(point.node);
    if (owner) decisions.push({ kind: point.kind, owner: owner.id });
  }
  const complexity = new Map(allUnits.map((unit) => [unit.id, 1]));
  for (const decision of decisions) complexity.set(decision.owner, complexity.get(decision.owner) + 1);
  const inventory = allUnits.map((unit) => ({ id: unit.id, kind: unit.kind, form: unit.form, parent: unit.kind === "initialization/top-level" ? "file" : unit.parent, complexity: complexity.get(unit.id) }));
  return { S: sourceLines(source, nodes), U: inventory.length, M: inventory.length === 0 ? 0 : Math.max(...inventory.map((unit) => unit.complexity)), units: inventory, decisions, shapeDigest: canonicalShapeDigest(nodes) };
}

export function createCSharpQualifier(initialized, { observeResource = () => {} } = {}) {
  invariant(initialized?.runtime?.Parser && initialized?.language, "C# qualifier requires verified runtime and language");
  return Object.freeze({
    async qualify(source, { analyze = true } = {}) {
      invariant(typeof source === "string" && source.isWellFormed(), "C# qualification source must be a well-formed string");
      observeResource("source-acquired");
      let parser;
      let tree;
      try {
        parser = new initialized.runtime.Parser();
        observeResource("parser-created");
        parser.setLanguage(initialized.language);
        tree = parser.parse(source) ?? undefined;
        invariant(tree, "C# candidate returned no tree");
        observeResource("tree-created");
        const validation = walkTree(tree.rootNode, observeResource, false);
        if (!validation.valid || !analyze) return { valid: validation.valid, signals: validation.signals, visitedNodes: validation.visitedNodes };
        const projection = walkTree(tree.rootNode, observeResource, true);
        invariant(projection.valid, "C# candidate tree changed between qualification walks");
        observeResource("observation-created");
        try { return { valid: true, signals: validation.signals, visitedNodes: validation.visitedNodes, ...analyzeTree(source, projection.nodes) }; }
        finally { observeResource("observation-released"); }
      } finally {
        if (tree) { tree.delete(); observeResource("tree-deleted"); }
        if (parser) { parser.delete(); observeResource("parser-deleted"); }
        observeResource("source-released");
      }
    },
  });
}

export function createExactStressModule(kind) {
  const target = 2_097_152;
  let core;
  if (kind === "dense") core = `class Dense { void M() {${";".repeat(1_000_000)}} }`;
  else if (kind === "deep") core = `class Deep { int M() => ${"(".repeat(100_000)}1${")".repeat(100_000)}; }`;
  else throw new Error(`Unknown C# stress module: ${kind}`);
  const marker = "//";
  const padding = target - Buffer.byteLength(core, "utf8") - marker.length;
  invariant(padding >= 0, "C# stress core exceeds the module boundary");
  const source = `${core}${marker}${"p".repeat(padding)}`;
  invariant(Buffer.byteLength(source, "utf8") === target, "C# stress module byte length changed");
  return source;
}
