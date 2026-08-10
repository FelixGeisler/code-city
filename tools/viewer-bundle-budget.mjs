import { promises as fs } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

const OUTPUT_ROOT = path.resolve("build/viewer");
const MANIFEST_PATH = path.join(OUTPUT_ROOT, ".vite", "manifest.json");
const ENTRY_MAX_BYTES = 1_080_000;
const ENTRY_GZIP_MAX_BYTES = 282_000;
const REQUIRED_LAZY_WORKFLOWS = Object.freeze([
  "src/advanced-query-panel.ts",
  "src/image-export-dialog.ts",
  "src/metric-mapping-panel.ts",
  "src/print-export-dialog.ts",
  "src/published-cities-api.ts",
  "src/published-cities.ts",
  "src/safe-extension-panel.ts",
]);

const manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, "utf8"));
const entry = manifest["index.html"];
if (
  typeof entry !== "object" ||
  entry === null ||
  entry.isEntry !== true ||
  typeof entry.file !== "string"
) {
  throw new Error("Viewer bundle manifest has no valid index entry.");
}

const dynamicImports = new Set(entry.dynamicImports ?? []);
for (const workflow of REQUIRED_LAZY_WORKFLOWS) {
  const chunk = manifest[workflow];
  if (
    !dynamicImports.has(workflow) ||
    typeof chunk !== "object" ||
    chunk === null ||
    chunk.isDynamicEntry !== true
  ) {
    throw new Error(`${workflow} must remain a lazy viewer workflow.`);
  }
}

const eagerKeys = new Set();
function includeEagerChunk(key) {
  if (eagerKeys.has(key)) return;
  const chunk = manifest[key];
  if (
    typeof chunk !== "object" ||
    chunk === null ||
    typeof chunk.file !== "string"
  ) {
    throw new Error(`Viewer manifest references invalid eager chunk ${key}.`);
  }
  eagerKeys.add(key);
  for (const imported of chunk.imports ?? []) includeEagerChunk(imported);
}
includeEagerChunk("index.html");

let entryBytes = 0;
let gzipBytes = 0;
for (const key of eagerKeys) {
  const bytes = await fs.readFile(path.join(OUTPUT_ROOT, manifest[key].file));
  entryBytes += bytes.byteLength;
  gzipBytes += gzipSync(bytes, { level: 9 }).byteLength;
}
if (entryBytes > ENTRY_MAX_BYTES) {
  throw new Error(
    `Eager viewer JavaScript is ${entryBytes} bytes; budget is ${ENTRY_MAX_BYTES}.`,
  );
}
if (gzipBytes > ENTRY_GZIP_MAX_BYTES) {
  throw new Error(
    `Eager viewer JavaScript gzip size is ${gzipBytes} bytes; budget is ${ENTRY_GZIP_MAX_BYTES}.`,
  );
}

console.log(
  `Viewer startup budget passed: ${entryBytes} bytes (${gzipBytes} gzip).`,
);
